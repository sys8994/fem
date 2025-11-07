/* ===========================================================
   ColumnGrid
   - 전역 SoA 구조 기반 (Global Struct of Arrays)
   - z0/z1 interleaved (zpair) 구조
   - Float16 quantization (nm-scale)
   - len: Uint8 (최대 255층)
   - mat: Uint8 (0=empty, 1=air, 2=cavity, 3~ material)
   - mat=255 → ALL 처리용 예약값
   - colsCache 지원 (deep copy)
   =========================================================== */

class ColumnGrid {
    /**
     * @param {number} LXnm - 전체 X 길이 (nm)
     * @param {number} LYNm - 전체 Y 길이 (nm)
     * @param {number} dx   - X 방향 cell pitch (nm)
     * @param {number} dy   - Y 방향 cell pitch (nm)
     * @param {number} LmaxInit - 초기 column 최대 layer 수 (default=32, 2^n)
     * @param {number} zScale - z quantization 스케일 (nm/step), default=0.1
     */
    constructor(LXnm, LYNm, dx, dy, LmaxInit = 32, zScale = 0.1) {
        // ===== 도메인 설정 =====
        this.setDomain(LXnm, LYNm, dx, dy);

        // ===== Layer 구조 파라미터 =====
        this.Lmax = this._nextPowerOf2(LmaxInit); // 항상 2^n
        this.expandStep = 16;              // 확장 시 +16
        this.zScale = zScale;                     // nm per quantized step

        // ===== grid 데이터 구조 =====
        this.cols = {};      // { mat, zpair, len }
        this.colsCache = {}; // { id: { mat,zpair,len } }
        this.sliderCache = {};

        // ===== 초기화 =====
        this.createNewGrid();
    }

    createNewGrid(LmaxInit = this.Lmax) {
        this.Lmax = this._nextPowerOf2(LmaxInit);
        this._allocBuffers();  // 전체 SoA 버퍼 새로 생성
    }


    /* ===========================================================
       도메인 및 해상도
       =========================================================== */
    setDomain(LXnm, LYNm, dx, dy) {
        this.dx = Number(dx);
        this.dy = Number(dy);
        this.NX = Math.max(1, Math.round(Number(LXnm) / this.dx));
        this.NY = Math.max(1, Math.round(Number(LYNm) / this.dy));
        this.Ncols = this.NX * this.NY;

        this.offsetX = -(this.NX - 1) * this.dx / 2;
        this.offsetY = -(this.NY - 1) * this.dy / 2;
        this.LXeff = this.NX * this.dx;
        this.LYeff = this.NY * this.dy;
    }

    /* ===========================================================
       버퍼 할당 (64B 정렬 + interleaved 구조)
       =========================================================== */
    _allocBuffers() {
        const N = this.Ncols;
        const L = this.Lmax;
        const numSeg = N * L;

        // z0/z1 interleaved → Float16Array (2 bytes per value ×2)
        const bytesMat = numSeg;                // 1B × N×L
        const bytesZpair = numSeg * 4;          // Float16 ×2 → 4B
        const bytesLen = N;                     // Uint8 × N

        const totalBytes = bytesMat + bytesZpair + bytesLen;
        const [buf, offset] = this._allocAlignedBuffer(totalBytes, 64);

        // 내부 오프셋 계산
        const offMat = offset;
        const offZpair = offMat + bytesMat;
        const offLen = offZpair + bytesZpair;

        // TypedArray 생성
        const mat = new Uint8Array(buf, offMat, numSeg);
        const zpair = new Uint16Array(buf, offZpair, numSeg * 2); // z0,z1 interleaved
        const len = new Uint8Array(buf, offLen, N);

        // 기본 초기화
        mat.fill(0);
        zpair.fill(0);
        len.fill(0);

        this.cols = { mat, zpair, len };
        this.buffer = buf;
    }

    /* ===========================================================
       64B 정렬 ArrayBuffer 생성 유틸
       =========================================================== */
    _allocAlignedBuffer(byteLength, align = 64) {
        const buf = new ArrayBuffer(byteLength + align);
        const base = buf.byteOffset || 0;
        const misalign = base % align;
        const offset = misalign === 0 ? 0 : align - misalign;
        return [buf, offset];
    }

    /* ===========================================================
       헬퍼: index 계산
       =========================================================== */
    _colIndex(i, j) { return i * this.NY + j; }
    _segIndex(i, j, k) { return (i * this.NY + j) * this.Lmax + k; }

    /* ===========================================================
       z quantization / dequantization
       =========================================================== */
    _quantizeZ(zReal) {
        return Math.round(zReal / this.zScale);
    }
    _dequantizeZ(zInt) {
        return zInt * this.zScale;
    }

    /* ===========================================================
       버퍼 확장 (단순 크기 증가 + 기존 값 유지)
       기존 cols.mat / cols.zpair / cols.len 은 그대로 두고,
       새로운 길이의 배열을 만들어 값 복사 후 교체.
       =========================================================== */
    _expandBuffers() {
        const oldLmax = this.Lmax;
        const newLmax = oldLmax + this.expandStep; // 일정 step만큼 확장 (ex: +32)
        console.log(`[ColumnGrid] Expanding array length: ${oldLmax} → ${newLmax}`);

        const N = this.Ncols;
        const oldCols = this.cols;
        const Lratio = newLmax / oldLmax;

        // --- mat ---
        const oldMat = oldCols.mat;
        const newMat = new Uint8Array(N * newLmax);
        for (let c = 0; c < N; c++) {
            const oldBase = c * oldLmax;
            const newBase = c * newLmax;
            const len = oldCols.len[c];
            newMat.set(oldMat.subarray(oldBase, oldBase + len), newBase);
        }

        // --- zpair ---
        const oldZ = oldCols.zpair;
        const newZ = new Uint16Array(N * newLmax * 2);
        for (let c = 0; c < N; c++) {
            const oldBase = c * oldLmax * 2;
            const newBase = c * newLmax * 2;
            const len = oldCols.len[c];
            newZ.set(oldZ.subarray(oldBase, oldBase + len * 2), newBase);
        }

        // --- len (그대로 유지) ---
        const newLen = new Uint8Array(oldCols.len);

        // --- 0으로 초기화된 확장 영역은 자동 0-fill 상태임 ---
        // JS TypedArray는 생성 시 0으로 초기화됨.

        // --- 교체 ---
        this.cols.mat = newMat;
        this.cols.zpair = newZ;
        this.cols.len = newLen;
        this.Lmax = newLmax;
    }


    /* ===========================================================
       기본 접근 함수
       =========================================================== */
    getLen(i, j) {
        return this.cols.len[this._colIndex(i, j)];
    }

    topMat(i, j) {
        const cidx = this._colIndex(i, j);
        const l = this.cols.len[cidx];
        if (l === 0) return 0;
        return this.cols.mat[cidx * this.Lmax + (l - 1)];
    }

    topZ(i, j) {
        const cidx = this._colIndex(i, j);
        const l = this.cols.len[cidx];
        if (l === 0) return 0;
        const base = (cidx * this.Lmax + (l - 1)) * 2;
        return this._dequantizeZ(this.cols.zpair[base + 1]); // z1
    }

    /* ===========================================================
       컬럼 추가 / 삭제 (depo, etch의 기반)
       =========================================================== */
    addLayer(i, j, matId, z0_real, z1_real) {
        const cidx = this._colIndex(i, j);
        let l = this.cols.len[cidx];
        if (l >= this.Lmax) this._expandBuffers();

        const base = (cidx * this.Lmax + l);
        this.cols.mat[base] = matId;

        const qz0 = this._quantizeZ(z0_real);
        const qz1 = this._quantizeZ(z1_real);
        const zBase = base * 2;
        this.cols.zpair[zBase] = qz0;
        this.cols.zpair[zBase + 1] = qz1;

        this.cols.len[cidx] = l + 1;
    }

    removeTopLayer(i, j) {
        const cidx = this._colIndex(i, j);
        const l = this.cols.len[cidx];
        if (l === 0) return;
        this.cols.len[cidx] = l - 1;
    }

    /* ===========================================================
       Grid 초기화 / 복제
       =========================================================== */
    clearAll() {
        this.cols.mat.fill(0);
        this.cols.zpair.fill(0);
        this.cols.len.fill(0);
    }

    cloneCols() {
        // 깊은 복사 (ArrayBuffer 새로)
        const matCopy = new Uint8Array(this.cols.mat);
        const zpairCopy = new Uint16Array(this.cols.zpair);
        const lenCopy = new Uint8Array(this.cols.len);
        return { mat: matCopy, zpair: zpairCopy, len: lenCopy };
    }

    /* ===========================================================
       캐시 저장 / 불러오기
       =========================================================== */

    initializeCache() {
        this.colsCache = {};
        this.colsCache[0] = [null, 0];
        this.sliderCache = {};
    }

    saveCache(id) {
        const nMaxCache = 10;
        while (Object.keys(this.colsCache).length >= nMaxCache) {
            // 제거 대상 후보 key 목록 (keepKey 제외)
            const candidates = Object.entries(this.colsCache)
                .filter(([key]) => key !== keepKey)
                .map(([key, [obj, num]]) => ({ key, num }));
            if (candidates.length === 0) break; // 제거할 게 없음        
            // num이 가장 작은 항목 찾기
            const minItem = candidates.reduce((a, b) => (a.num < b.num ? a : b));
            // 해당 항목 삭제
            delete this.colsCache[minItem.key];
        }


        this.colsCache[id + 1] = [this.cloneCols(), 0];
    }

    loadCache(id) {
        const c = this.colsCache[id];
        if (!c[0]) {
            this.clearAll();
            return;
        }
        // deep copy 복원
        this.cols.mat = new Uint8Array(c[0].mat);
        this.cols.zpair = new Uint16Array(c[0].zpair);
        this.cols.len = new Uint8Array(c[0].len);
        this.colsCache[id][1] += 1;

        return;
    }

    /* ===========================================================
       유틸
       =========================================================== */
    _nextPowerOf2(n) {
        return 1 << (32 - Math.clz32(Math.max(1, n - 1)));
    }

    /* ============================
     * 기본 유틸
     * ============================ */
    _clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    _ensureBuf(name, length, kind = 'f32') {
        const C = (kind === 'f32') ? Float32Array : (kind === 'u8' ? Uint8Array : Uint16Array);
        if (!this[name] || this[name].length < length) this[name] = new C(length);
        return this[name];
    }

    /* ===========================================================
       컨포멀 커널 (수평 반경 S·t, 수직 팽창량 t)
       rows[du+Rx] = Float32Array [ dv0, add0, dv1, add1, ... ]
       add = sqrt( t^2 - (sqrt((du*dx)^2+(dv*dy)^2) / S)^2 )
       =========================================================== */
    _getConformalKernelArray(t, S, dx, dy) {
        this._confKernelCacheArr = this._confKernelCacheArr || new Map();
        const key = `${(t * 1000 | 0)}|${(S * 1000 | 0)}|${(dx * 1000 | 0)}|${(dy * 1000 | 0)}`;
        const hit = this._confKernelCacheArr.get(key);
        if (hit) return hit;

        const Rx = Math.ceil(t / dx);
        const Ry = Math.ceil(t / dy);
        const t2 = t * t;
        const Sinv = 1 / Math.max(S, 1e-6);
        const rows = new Array(Rx * 2 + 1);
        const dx2 = dx * dx, dy2 = dy * dy;

        for (let du = -Rx; du <= Rx; du++) {
            const row = [];
            const du2dx2 = du * du * dx2;
            for (let dv = -Ry; dv <= Ry; dv++) {
                const r2 = du2dx2 + dv * dv * dy2;
                const r_lat = Math.sqrt(r2) * Sinv;
                if (r_lat <= t + 1e-9) {
                    const add = Math.sqrt(Math.max(0, t2 - r_lat * r_lat));
                    row.push(dv | 0, add);
                }
            }
            rows[du + Rx] = row.length ? Float32Array.from(row) : new Float32Array(0);
        }
        const out = { Rx, Ry, rows, baseAdd: t };
        this._confKernelCacheArr.set(key, out);
        if (this._confKernelCacheArr.size > 32) {
            const k0 = this._confKernelCacheArr.keys().next().value;
            this._confKernelCacheArr.delete(k0);
        }
        return out;
    }

    /* ===========================================================
       패딩된 높이맵 (경계 조건 = 클램프 복제)
       pad: Float32Array, 크기 = (NX+2Rx) × (NY+2Ry)
       =========================================================== */
    _buildPaddedH(H, NX, NY, Rx, Ry) {
        const W = NX + 2 * Rx, Hh = NY + 2 * Ry;
        const pad = this._ensureBuf('_bufPad', W * Hh, 'f32');

        // 중앙 복사
        for (let i = 0; i < NX; i++) {
            const src = i * NY;
            const dst = (i + Rx) * Hh + Ry;
            pad.set(H.subarray(src, src + NY), dst);
        }
        // 상/하 패드
        for (let i = Rx; i < Rx + NX; i++) {
            const base = i * Hh;
            const first = pad[base + Ry];
            for (let j = 0; j < Ry; j++) pad[base + j] = first;
            const last = pad[base + Ry + NY - 1];
            for (let j = Ry + NY; j < Ry + NY + Ry; j++) pad[base + j] = last;
        }
        // 좌/우 패드
        for (let j = 0; j < Hh; j++) {
            const L = pad[Rx * Hh + j];
            const R = pad[(Rx + NX - 1) * Hh + j];
            for (let i = 0; i < Rx; i++) pad[i * Hh + j] = L;
            for (let i = Rx + NX; i < Rx + NX + Rx; i++) pad[i * Hh + j] = R;
        }
        return { pad, W, Hh };
    }

    /* ===========================================================
       상단 증착/연장 (SoA 전용)
       - matId: Uint8 (0=empty, 255=ALL 예약)
       - dz_real > 0 인 경우만 호출
       - top 재료가 같으면 z1만 올려 연장, 아니면 새 레이어 추가
       =========================================================== */
    _depoAtTop_(i, j, matId, dz_real) {
        if (dz_real <= 0) return;
        const cidx = this._colIndex(i, j);
        let l = this.cols.len[cidx];

        // 현재 top 높이/재료
        let topZ = 0, topMat = 0;
        if (l > 0) {
            const baseTop = cidx * this.Lmax + (l - 1);
            const zBase = baseTop * 2;
            topZ = this._dequantizeZ(this.cols.zpair[zBase + 1]);
            topMat = this.cols.mat[baseTop];
        }

        const newTop = topZ + dz_real;
        if (l > 0 && topMat === matId) {
            // 연장
            const baseTop = cidx * this.Lmax + (l - 1);
            this.cols.zpair[baseTop * 2 + 1] = this._quantizeZ(newTop);
        } else {
            // 새 레이어
            if (l >= this.Lmax) this._expandBuffers(); // 필요 시 확장(+expandStep)
            const base = cidx * this.Lmax + l;
            const zBase = base * 2;
            this.cols.mat[base] = matId;
            this.cols.zpair[zBase] = this._quantizeZ(topZ);
            this.cols.zpair[zBase + 1] = this._quantizeZ(newTop);
            this.cols.len[cidx] = l + 1;
        }
    }

    /* ===========================================================
       컨포멀 증착 (정확 표면 팽창)
       - maskFn(x,y): true면 적용, 없으면 전체
       - matId: 증착 재료 (Uint8). 255는 'ALL' 예약이지만, 증착에선 보통 실제 재료 ID 사용.
       - thickness: t (nm)
       - conformality: S (0~1), 수평 도달 = t*S
       =========================================================== */
    deposit_general(maskFn, matId, thickness, conformality) {
        const t = Math.max(0, Number(thickness) || 0);
        if (t <= 0) return;

        const NX = this.NX, NY = this.NY, dx = this.dx, dy = this.dy;
        const S = this._clamp(Number(conformality ?? 1.0), 0, 1);
        const latRange = t * S;
        const eps = 1e-9;

        // 1) 빠른 경로: 사실상 수직 증착 (latRange < 그리드 해상도)
        if (latRange < Math.min(dx, dy)) {
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                    if (maskFn && !maskFn(x, y)) continue;
                    this._depoAtTop_(i, j, matId, t);
                }
            }
            return;
        }


        // 2) 현재 top 높이맵 H 구축
        const H = this._ensureBuf('_bufH', NX * NY, 'f32');
        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const idx = i * NY + j;
                const l = this.cols.len[idx];
                if (l === 0) { H[idx] = 0; continue; }
                const baseTop = idx * this.Lmax + (l - 1);
                H[idx] = this._dequantizeZ(this.cols.zpair[baseTop * 2 + 1]); // z1
            }
        }

        // 3) 커널/패딩
        const { Rx, rows, baseAdd } = this._getConformalKernelArray(t, S, dx, dy);
        const { pad: HPad, W: PW, Hh: PH } = this._buildPaddedH(H, NX, NY, Rx, Rx);

        // 4) 활성 bbox (mask sparse 최적화)
        let iMin = 0, iMax = NX - 1, jMin = 0, jMax = NY - 1;
        if (maskFn) {
            let found = false, _iMin = NX, _iMax = -1, _jMin = NY, _jMax = -1;
            for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                if (maskFn(x, y)) {
                    found = true;
                    if (i < _iMin) _iMin = i; if (i > _iMax) _iMax = i;
                    if (j < _jMin) _jMin = j; if (j > _jMax) _jMax = j;
                }
            }
            if (!found) return;
            iMin = Math.max(0, _iMin - Rx);
            iMax = Math.min(NX - 1, _iMax + Rx);
            jMin = Math.max(0, _jMin - Rx);
            jMax = Math.min(NY - 1, _jMax + Rx);
        }

        // 5) 팽창 표면 Hp 계산
        const Hp = this._ensureBuf('_bufHp', NX * NY, 'f32');
        if (maskFn) {
            for (let i = 0; i < NX; i++) {
                const ii = i * NY;
                for (let j = 0; j < NY; j++) {
                    const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                    Hp[ii + j] = maskFn(x, y) ? (H[ii + j] + baseAdd) : H[ii + j];
                }
            }
        } else {
            for (let idx = 0; idx < NX * NY; idx++) Hp[idx] = H[idx] + baseAdd;
        }

        for (let i = iMin; i <= iMax; i++) {
            const ii = i * NY, ip = i + Rx;
            for (let j = jMin; j <= jMax; j++) {
                const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                if (maskFn && !maskFn(x, y)) continue;

                let m = Hp[ii + j];           // 기본: H + t
                const jp = j + Rx;
                for (let du = -Rx; du <= Rx; du++) {
                    const row = rows[du + Rx];
                    if (!row.length) continue;
                    const base = (ip + du) * PH;
                    const center = base + jp;
                    for (let k = 0; k < row.length; k += 2) {
                        const dv = row[k] | 0;
                        const add = row[k + 1];
                        const cand = HPad[center + dv] + add;
                        if (cand > m) m = cand;
                    }
                }
                Hp[ii + j] = m;
            }
        }

        // 6) Δz 적용 (SoA 명시형 반영)
        for (let i = iMin; i <= iMax; i++) {
            const ii = i * NY;
            for (let j = jMin; j <= jMax; j++) {
                const newTop = Hp[ii + j];
                const oldTop = H[ii + j];
                const dz = newTop - oldTop;
                if (dz <= eps) continue;
                this._depoAtTop_(i, j, matId, dz);
            }
        }


        this.identify_cavity();
    }

    /* ===========================================================
       SoA 기반 단일 column 식각 유틸
       - i, j: grid 좌표
       - matId: 식각할 재료 ID (Uint8)
       - dz: 제거할 두께 (nm)
       - isAll: true면 모든 재료를 식각
       =========================================================== */
    _applyEtchAt(i, j, matId, dz, isAll = false) {
        if (dz <= 0) return;

        const NY = this.NY, Lmax = this.Lmax;
        const cidx = i * NY + j;
        const cols = this.cols;

        let remaining = dz;
        const eps = 1e-9;

        while (remaining > eps && cols.len[cidx] > 0) {
            const topIdx = cols.len[cidx] - 1;
            const base = cidx * Lmax + topIdx;
            const curMat = cols.mat[base];
            if (!isAll && curMat !== matId) break;

            const zBase = base * 2;
            const z0 = this._dequantizeZ(cols.zpair[zBase]);
            const z1 = this._dequantizeZ(cols.zpair[zBase + 1]);
            const thick = z1 - z0;

            if (remaining < thick - eps) {
                // --- 부분 식각 ---
                cols.zpair[zBase + 1] = this._quantizeZ(z1 - remaining);
                remaining = 0;
            } else {
                // --- 전체 레이어 제거 ---
                remaining -= thick;
                cols.len[cidx] = topIdx;

                // 삭제된 위치 초기화 (데이터 클리어)
                cols.mat[base] = 0;
                cols.zpair[zBase] = 0;
                cols.zpair[zBase + 1] = 0;
            }
        }
    }

    /* ===========================================================
       등방성 식각 (conformal etch)
       - maskFn(x,y): true면 적용, 없으면 전체
       - matId: 식각 대상 (Uint8, 255=ALL)
       - thickness: t (nm)
       - conformality: S (0~1)
       =========================================================== */
    etch_general(maskFn, matId, thickness, conformality) {
        const t = Math.max(0, Number(thickness) || 0);
        if (t <= 0) return;

        const NX = this.NX, NY = this.NY, dx = this.dx, dy = this.dy;
        const S = this._clamp(Number(conformality ?? 1.0), 0, 1);
        const latRange = t * S;
        const isAll = (matId === 255);
        const eps = 1e-9;

        // ===== 1️⃣ 빠른 경로: 사실상 수직 식각 =====
        if (latRange < Math.min(dx, dy)) {
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                    if (maskFn && !maskFn(x, y)) continue;
                    this._applyEtchAt(i, j, matId, t, isAll);
                }
            }
            return;
        }

        // ===== 2️⃣ 높이맵 H, 대상맵 E, floor맵 F 계산 =====
        const H = this._ensureBuf('_bufH', NX * NY, 'f32');
        const E = this._ensureBuf('_bufE', NX * NY, 'u8');
        const F = this._ensureBuf('_bufF', NX * NY, 'f32');

        for (let i = 0; i < NX; i++) {
            const ii = i * NY;
            for (let j = 0; j < NY; j++) {
                const cidx = ii + j;
                const L = this.cols.len[cidx];
                let topZ = 0, etchTopOK = false;

                if (L > 0) {
                    const topBase = cidx * this.Lmax + (L - 1);
                    const topMat = this.cols.mat[topBase];
                    const z1 = this.cols.zpair[topBase * 2 + 1];
                    topZ = this._dequantizeZ(z1);
                    etchTopOK = isAll || (topMat === matId);
                }

                const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                const inMask = !maskFn || maskFn(x, y);
                H[ii + j] = topZ;
                E[ii + j] = (inMask && etchTopOK) ? 1 : 0;

                // floor 계산 (연속 동일 재료 구간 하한)
                if (L === 0) {
                    F[ii + j] = 0;
                } else if (isAll) {
                    F[ii + j] = 0;
                } else if (etchTopOK) {
                    let floorZ = this._dequantizeZ(this.cols.zpair[(cidx * this.Lmax + (L - 1)) * 2]);
                    for (let s = L - 2; s >= 0; s--) {
                        const baseS = cidx * this.Lmax + s;
                        if (this.cols.mat[baseS] !== matId) break;
                        floorZ = this._dequantizeZ(this.cols.zpair[baseS * 2]);
                    }
                    F[ii + j] = Math.max(0, floorZ);
                } else {
                    F[ii + j] = 0;
                }
            }
        }

        // ===== 3️⃣ 커널/패딩 준비 =====
        const { Rx, rows } = this._getConformalKernelArray(t, S, dx, dy);
        const { pad: HPad, W: PW, Hh: PH } = this._buildPaddedH(H, NX, NY, Rx, Rx);

        // EPad 구성 (이웃 여부 판단용)
        const EPadLen = (NX + 2 * Rx) * (NY + 2 * Rx);
        const EPad = this._ensureBuf('_bufEPad', EPadLen, 'u8');
        EPad.fill(0);
        for (let i = 0; i < NX; i++) {
            const srcBase = i * NY;
            const dstBase = (i + Rx) * PH + Rx;
            for (let j = 0; j < NY; j++) EPad[dstBase + j] = E[srcBase + j];
        }

        // ===== 4️⃣ 활성 bbox 계산 =====
        let iMin = 0, iMax = NX - 1, jMin = 0, jMax = NY - 1;
        {
            let found = false, _iMin = NX, _iMax = -1, _jMin = NY, _jMax = -1;
            for (let i = 0; i < NX; i++) {
                const ii = i * NY;
                for (let j = 0; j < NY; j++) {
                    if (E[ii + j] === 1) {
                        found = true;
                        if (i < _iMin) _iMin = i; if (i > _iMax) _iMax = i;
                        if (j < _jMin) _jMin = j; if (j > _jMax) _jMax = j;
                    }
                }
            }
            if (!found) return;
            iMin = Math.max(0, _iMin - Rx);
            iMax = Math.min(NX - 1, _iMax + Rx);
            jMin = Math.max(0, _jMin - Rx);
            jMax = Math.min(NY - 1, _jMax + Rx);
        }

        // ===== 5️⃣ 침식 표면 계산 =====
        const Hp = this._ensureBuf('_bufHp', NX * NY, 'f32');
        for (let idx = 0; idx < NX * NY; idx++)
            Hp[idx] = (E[idx] === 1) ? (H[idx] - t) : H[idx];

        for (let i = iMin; i <= iMax; i++) {
            const ii = i * NY, ip = i + Rx;
            for (let j = jMin; j <= jMax; j++) {
                if (E[ii + j] !== 1) continue;
                let m = Hp[ii + j];
                const jp = j + Rx;
                for (let du = -Rx; du <= Rx; du++) {
                    const row = rows[du + Rx];
                    if (!row.length) continue;
                    const base = (ip + du) * PH;
                    const center = base + jp;
                    for (let k = 0; k < row.length; k += 2) {
                        const dv = row[k] | 0;
                        const add = row[k + 1];
                        if (EPad[center + dv] !== 1) continue; // 인접한 위치도 식각 가능해야 측면 기여 인정
                        const cand = HPad[center + dv] - add;
                        if (cand < m) m = cand;
                    }
                }
                // 바닥(floorZ) 이하로 내려가지 않게 클램프
                const floorZ = F[ii + j];
                Hp[ii + j] = Math.max(0, Math.max(floorZ, m));
            }
        }

        // ===== 6️⃣ Δz 적용 (실제 식각 수행) =====
        for (let i = iMin; i <= iMax; i++) {
            const ii = i * NY;
            for (let j = jMin; j <= jMax; j++) {
                if (E[ii + j] !== 1) continue;
                const newTop = Hp[ii + j];
                const oldTop = H[ii + j];
                const dz = oldTop - newTop;
                if (dz > eps) this._applyEtchAt(i, j, matId, dz, isAll);
            }
        }
    }

    /* ===========================================================
       CMP (Chemical Mechanical Planarization)
       - depth: 연마 깊이 (nm)
       - stopMatId: 스토퍼 재료 ID (Uint8, 0이면 없음)
       =========================================================== */
    cmp(depth, stopMatId = 0) {
        if (depth <= 0) return;

        const NX = this.NX, NY = this.NY;
        const eps = 1e-9;
        const Lmax = this.Lmax;
        const cols = this.cols;

        let zTop = 0;
        let stopperTop = -Infinity;

        // ===== ① 전체 zTop 및 stopperTop 계산 =====
        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const len = cols.len[cidx];
                if (len === 0) continue;

                // top segment의 z1
                const baseTop = cidx * Lmax + (len - 1);
                const z1 = this._dequantizeZ(cols.zpair[baseTop * 2 + 1]);
                zTop = Math.max(zTop, z1);

                // stopper 탐색
                if (stopMatId !== 0) {
                    for (let k = 0; k < len; k++) {
                        const base = cidx * Lmax + k;
                        if (cols.mat[base] === stopMatId) {
                            const z1s = this._dequantizeZ(cols.zpair[base * 2 + 1]);
                            stopperTop = Math.max(stopperTop, z1s);
                        }
                    }
                }
            }
        }

        // ===== ② targetZ 결정 =====
        let targetZ;
        if (stopMatId === 0 || stopperTop === -Infinity) {
            targetZ = zTop - depth;
        } else {
            targetZ = Math.max(zTop - depth, stopperTop);
        }

        // ===== ③ CMP 수행 =====
        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                let len = cols.len[cidx];
                if (len === 0) continue;

                // ④ stopper 존재 여부 및 높이 확인
                let stopZ = -Infinity;
                if (stopMatId !== 0) {
                    for (let k = 0; k < len; k++) {
                        const base = cidx * Lmax + k;
                        if (cols.mat[base] === stopMatId) {
                            stopZ = this._dequantizeZ(cols.zpair[base * 2 + 1]);
                            break;
                        }
                    }
                }

                const limitZ = Math.max(targetZ, stopZ);

                // ===== ⑤ 위에서부터 잘라내기 =====
                while (len > 0) {
                    const topIdx = len - 1;
                    const base = cidx * Lmax + topIdx;
                    const zBase = base * 2;
                    const z0 = this._dequantizeZ(cols.zpair[zBase]);
                    const z1 = this._dequantizeZ(cols.zpair[zBase + 1]);

                    if (z1 <= limitZ + eps) break; // 이미 충분히 낮음

                    if (z0 < limitZ - eps) {
                        // --- 일부만 깎임 → z1을 limitZ로 절단 ---
                        cols.zpair[zBase + 1] = this._quantizeZ(limitZ);
                        break;
                    } else {
                        // --- 전층 제거 ---
                        len -= 1;
                        // 제거된 세그먼트 클리어
                        cols.mat[base] = 0;
                        cols.zpair[zBase] = 0;
                        cols.zpair[zBase + 1] = 0;
                    }
                }

                // ===== ⑥ 업데이트 및 정리 =====
                cols.len[cidx] = len;

                // 두께 0 이하 세그먼트 정리
                if (len > 0) {
                    const topIdx = len - 1;
                    const base = cidx * Lmax + topIdx;
                    const zBase = base * 2;
                    const z0q = cols.zpair[zBase];
                    const z1q = cols.zpair[zBase + 1];
                    if (z1q <= z0q) {
                        // 두께 0 → 삭제
                        cols.len[cidx] = len - 1;
                        cols.mat[base] = 0;
                        cols.zpair[zBase] = 0;
                        cols.zpair[zBase + 1] = 0;
                    }
                }
            }
        }


        this.identify_cavity();
    }



    /* ===========================================================
       연결된 동일 물질(matId)의 노출 영역(공기와 접촉된 부분)을 flood-fill로 제거
       - matId: 제거할 재료 ID (Uint8)
       =========================================================== */
    strip_connected(matId) {
        const NX = this.NX, NY = this.NY, Lmax = this.Lmax;
        const cols = this.cols;
        const eps = 1e-9;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

        const Ncols = NX * NY;
        const visited = new Uint8Array(Ncols * Lmax);
        const mark = new Uint8Array(Ncols * Lmax);
        const q = [];

        // --- overlap check ---
        const overlap = (a0, a1, b0, b1) => (a0 < b1 - eps) && (b0 < a1 - eps);

        // --- side/top exposure check ---
        const isExposed = (i, j, z0, z1) => {
            // ① 바닥: 공기 노출 아님!
            if (z0 <= eps) return false;

            const cidx = i * NY + j;
            const L = cols.len[cidx];
            const baseTop = cidx * Lmax + (L - 1);
            const zTop = this._dequantizeZ(cols.zpair[baseTop * 2 + 1]);
            // ② 최상단 노출
            if (Math.abs(z1 - zTop) < eps) return true;

            // ③ 측면 노출
            for (const [di, dj] of dirs) {
                const ni = i + di, nj = j + dj;
                if (ni < 0 || ni >= NX || nj < 0 || nj >= NY) return false; // 옆면 경계: 공기 노출 아님!
                const nidx = ni * NY + nj;
                const nL = cols.len[nidx];
                if (nL === 0) return true; // 이웃이 비었으면 공기 노출
                const nTopBase = nidx * Lmax + (nL - 1);
                const nTop = this._dequantizeZ(cols.zpair[nTopBase * 2 + 1]);
                if (nTop < z1 - eps) return true;
            }
            return false;
        };

        // ==========================================================
        // ① Seed 탐색: 공기 접촉된 동일 물질 segment를 큐에 push
        // ==========================================================
        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const L = cols.len[cidx];
                for (let k = 0; k < L; k++) {
                    const base = cidx * Lmax + k;
                    if (cols.mat[base] !== matId) continue;

                    const zBase = base * 2;
                    const z0 = this._dequantizeZ(cols.zpair[zBase]);
                    const z1 = this._dequantizeZ(cols.zpair[zBase + 1]);
                    if (!isExposed(i, j, z0, z1)) continue;

                    const flatIdx = base;
                    visited[flatIdx] = 1;
                    mark[flatIdx] = 1;
                    q.push([i, j, k]);
                }
            }
        }

        // ==========================================================
        // ② Flood-fill (BFS)
        // ==========================================================
        while (q.length) {
            const [i, j, k] = q.pop();
            const cidx = i * NY + j;
            const base = cidx * Lmax + k;
            const zBase = base * 2;

            const z0 = this._dequantizeZ(cols.zpair[zBase]);
            const z1 = this._dequantizeZ(cols.zpair[zBase + 1]);

            for (const [di, dj] of dirs) {
                const ni = i + di, nj = j + dj;
                if (ni < 0 || ni >= NX || nj < 0 || nj >= NY) continue;

                const nidx = ni * NY + nj;
                const nL = cols.len[nidx];
                for (let kk = 0; kk < nL; kk++) {
                    const nbase = nidx * Lmax + kk;
                    const flatIdx = nbase;
                    if (visited[flatIdx]) continue;
                    if (cols.mat[nbase] !== matId) continue;

                    const nzBase = nbase * 2;
                    const z0b = this._dequantizeZ(cols.zpair[nzBase]);
                    const z1b = this._dequantizeZ(cols.zpair[nzBase + 1]);
                    if (!overlap(z0, z1, z0b, z1b)) continue;

                    visited[flatIdx] = 1;
                    mark[flatIdx] = 1;
                    q.push([ni, nj, kk]);
                }
            }
        }

        // ==========================================================
        // ③ 제거 적용
        // ==========================================================
        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const L = cols.len[cidx];
                if (L === 0) continue;

                let writePtr = 0;
                for (let k = 0; k < L; k++) {
                    const base = cidx * Lmax + k;
                    if (mark[base]) continue; // 제거 대상 skip
                    if (writePtr !== k) {
                        // 압축 (남은 세그먼트를 앞으로 이동)
                        const src = base * 2, dst = (cidx * Lmax + writePtr) * 2;
                        cols.mat[cidx * Lmax + writePtr] = cols.mat[base];
                        cols.zpair[dst] = cols.zpair[src];
                        cols.zpair[dst + 1] = cols.zpair[src + 1];
                    }
                    writePtr++;
                }
                cols.len[cidx] = writePtr;

                // --- 남은 구간 클리어
                for (let k = writePtr; k < L; k++) {
                    const base = cidx * Lmax + k;
                    const zBase = base * 2;
                    cols.mat[base] = 0;
                    cols.zpair[zBase] = 0;
                    cols.zpair[zBase + 1] = 0;
                }
            }
        }
    }

    /* ===========================================================
       Identify and fill enclosed air gaps with dummy "cavity" layers.
       - Step1: fill vertical gaps with cavity segments
       - Step2: remove exposed cavities (connected to air)
       - Step3: keep enclosed cavities
       =========================================================== */
    identify_cavity() {
        const NX = this.NX, NY = this.NY, Lmax = this.Lmax;
        const cols = this.cols;
        const eps = 1e-9;
        const CAVITY_ID = 2; // cavity = 2 (air=1, real mats≥3)

        // ===== ① 틈(gap) 부분 cavity로 채우기 =====
        const Hmax = this.maxHeight(); // 전체 도메인 내 최대 높이

        // 새로운 버퍼 생성 (일단 기존 크기와 동일)
        const newMat = new Uint8Array(cols.mat.length);
