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
                // .filter(([key]) => key !== keepKey)
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
        const newZ = new Uint16Array(cols.zpair.length);
        const newLen = new Uint8Array(cols.len.length);

        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const len = cols.len[cidx];
                if (len === 0) continue;

                let lastZ = 0;
                let writePtr = 0;

                for (let k = 0; k < len; k++) {
                    const base = cidx * Lmax + k;
                    const zBase = base * 2;
                    const z0 = this._dequantizeZ(cols.zpair[zBase]);
                    const z1 = this._dequantizeZ(cols.zpair[zBase + 1]);
                    const mat = cols.mat[base];

                    // gap이 있으면 cavity 삽입
                    if (z0 > lastZ + eps) {
                        const wbase = cidx * Lmax + writePtr;
                        const wzBase = wbase * 2;
                        newMat[wbase] = CAVITY_ID;
                        newZ[wzBase] = this._quantizeZ(lastZ);
                        newZ[wzBase + 1] = this._quantizeZ(z0);
                        writePtr++;
                    }

                    // 기존 레이어 복사
                    const wbase2 = cidx * Lmax + writePtr;
                    const wzBase2 = wbase2 * 2;
                    newMat[wbase2] = mat;
                    newZ[wzBase2] = cols.zpair[zBase];
                    newZ[wzBase2 + 1] = cols.zpair[zBase + 1];
                    writePtr++;
                    lastZ = z1;
                }

                // 상단 위로 cavity 확장
                if (Hmax > lastZ + eps) {
                    const wbase3 = cidx * Lmax + writePtr;
                    const wzBase3 = wbase3 * 2;
                    newMat[wbase3] = CAVITY_ID;
                    newZ[wzBase3] = this._quantizeZ(lastZ);
                    newZ[wzBase3 + 1] = this._quantizeZ(Hmax);
                    writePtr++;
                }

                newLen[cidx] = writePtr;
            }
        }

        // --- 새 데이터로 교체 ---
        cols.mat = newMat;
        cols.zpair = newZ;
        cols.len = newLen;

        // ===== ② 외기와 연결된 cavity 제거 =====
        this.strip_connected(CAVITY_ID);

        // ===== ③ cavity layer만 남음 (완전히 내부에 갇힌 영역)
        // 여기서 cavity를 통계내거나 후속 공정으로 넘길 수 있음.
    }

    maxHeight() {
        const NX = this.NX, NY = this.NY;
        const cols = this.cols;
        const Lmax = this.Lmax;
        let maxZ = 0;

        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const L = cols.len[cidx];
                if (L === 0) continue;
                const topIdx = cidx * Lmax + (L - 1);
                const zTop = this._dequantizeZ(cols.zpair[topIdx * 2 + 1]);
                if (zTop > maxZ) maxZ = zTop;
            }
        }

        // 최소 높이 보정 (빈 도메인에서도 1을 반환)
        return maxZ > 0 ? maxZ : 1;
    }





    // =============== ALD (비트셋 기반, 고성능) ===============
    deposit_ALD(matId, totalThk, opts = {}) {
        const T = Math.max(0, Number(totalThk) || 0);
        if (T <= 0) return;

        // ---------- 공통 상수 ----------
        const NX = this.NX, NY = this.NY, Lmax = this.Lmax;
        const dx = this.dx, dy = this.dy;
        const cols = this.cols;
        const CAVITY_ID = 2;          // cavity id
        const SOLID_MIN = 3;          // 실제 물질 id 시작
        const eps = 1e-9;

        // z 정량화 스텝(기본: dx/dy와 유사)
        const zStepNm = this._zStepNm || Math.min(dx, dy);

        // 증분 두께 dt
        const dt = Math.max(opts.dt ?? Math.max(dx, dy, zStepNm), 1e-3);
        const isCache = !!opts.isCache;

        // 캐시 준비
        this.sliderCache.aldCache = this.sliderCache.aldCache || {
            exposedSegments: null,        // [{i,j,zA,zB,isTop}]
            gridWithCavity: new Map(),    // t -> snapshot
            BitsCache: {},
        };
        this.sliderCache.aldCache.BitsCache = this.sliderCache.aldCache.BitsCache || {};  // 비트셋 메모리 풀

        // =========================================================
        // 내부 유틸 (이 함수 전용)
        // =========================================================

        // 정량화/역정량화 (숫자→정수, 정수→숫자)
        const zScale = this.zScale;
        const invZ = 1 / zScale;
        const qZ = (z) => Math.round(z * invZ);
        const dZ = (q) => (q * zScale);

        // 비트셋 풀에서 요구 길이로 확보 (zero-fill 필요 시 fillZero=true)
        const ensureBits = (key, length, fillZero = true) => {
            let buf = this.sliderCache.aldCache.BitsCache[key];
            if (!buf || buf.length < length) {
                buf = new Uint32Array(length);
                this.sliderCache.aldCache.BitsCache[key] = buf;
            } else if (fillZero) {
                buf.fill(0);
            }
            return buf;
        };

        // 비트셋 레이아웃 생성기: Zmax/wordsPerCol 계산, lastWordMask 제공
        const makeBitLayout = (HmaxPlus) => {
            const Hcap = Math.max(1, Math.ceil(HmaxPlus / this.zScale)); // Zmax: bin 개수
            const wordsPerCol = (Hcap + 31) >>> 5;
            const lastBits = Hcap & 31;
            const lastMask = lastBits === 0 ? 0xFFFFFFFF : ((1 << lastBits) - 1) >>> 0;
            return { Zmax: Hcap, wordsPerCol, lastMask };
        };

        // range [z0,z1) → [q0,q1)로 변환 후, 단일 칼럼 비트셋 마킹
        const markRangeQ = (bits, base, q0, q1) => {
            if (q1 <= q0) return;
            let w0 = q0 >>> 5;
            let w1 = (q1 - 1) >>> 5;
            const s0 = q0 & 31;
            const s1 = (q1 - 1) & 31;
            if (w0 === w1) {
                const mask = ((~((1 << s0) - 1)) & ((1 << (s1 + 1)) - 1)) >>> 0;
                bits[base + w0] |= mask;
            } else {
                bits[base + w0] |= (~((1 << s0) - 1)) >>> 0;
                for (let w = w0 + 1; w < w1; w++) bits[base + w] = 0xFFFFFFFF;
                bits[base + w1] |= ((1 << (s1 + 1)) - 1) >>> 0;
            }
        };
        const markRange = (bits, base, z0, z1) => {
            // 반열림 구간 보장
            let q0 = qZ(z0); if (q0 < 0) q0 = 0;
            let q1 = qZ(z1); if (q1 <= q0) q1 = q0 + 1;
            markRangeQ(bits, base, q0, q1);
        };

        // 비트셋 → [z0,z1] 인터벌로 변환 (정렬/병합 이미 끝난 상태)
        // bits: Uint32Array (모든 칼럼의 비트셋)
        // cidx: 컬럼 인덱스
        // wordsPerCol: 컬럼당 32비트 워드 수
        // Zmax: 사용되는 유효 비트 개수(= 정량화된 z bin 수)
        const emitIntervals = (bits, cidx, wordsPerCol, Zmax) => {
            const out = [];
            const base = cidx * wordsPerCol;

            // ctz32: x의 LSB부터 첫 1까지의 0 개수( x=0 이면 32 반환 )
            const ctz32 = (x) => (x ? (31 - Math.clz32(x & -x)) : 32);

            let inRun = false;     // 이전 워드에서 시작된 1-런이 이어지는 중인지
            let runStartQ = 0;     // 열린 런의 시작 q(정량화 z)

            for (let w = 0, qBase = 0; w < wordsPerCol; w++, qBase += 32) {
                let word = bits[base + w] >>> 0;

                if (!inRun) {
                    if (word === 0) continue;

                    // 이 워드 안에서 1-런들을 모두 처리
                    while (word !== 0) {
                        const tz = ctz32(word);           // 첫 1 이전의 0개수
                        let v = word >>> tz;              // 첫 1까지 건너뛰기
                        const ones = ctz32((~v) >>> 0);   // LSB부터 연속 1의 길이
                        const room = 32 - tz;

                        if (ones < room) {
                            // 런이 워드 내부에서 끝남
                            const sQ = qBase + tz;
                            const eQ = sQ + ones;

                            // Zmax 클램프
                            const s = sQ < Zmax ? sQ : Zmax;
                            const e = eQ < Zmax ? eQ : Zmax;
                            if (e > s) out.push([(e => e * this.zScale)(s), (e => e * this.zScale)(e)]);

                            word = v >>> ones;  // 소비한 구간 제거 후 다음 런 탐색
                        } else {
                            // 런이 워드 끝까지 이어짐 → 다음 워드로 연장
                            runStartQ = qBase + tz;
                            inRun = true;
                            break;
                        }
                    }
                } else {
                    // 이전 워드에서 열린 런을 이어서 처리
                    if (word === 0xFFFFFFFF) {
                        // 이 워드 전체가 1 → 런 유지, 다음 워드로
                        continue;
                    }

                    if (word === 0) {
                        // 이 워드가 전부 0 → 직전에서 런 종료
                        const s = runStartQ < Zmax ? runStartQ : Zmax;
                        const e = qBase < Zmax ? qBase : Zmax;
                        if (e > s) out.push([(e => e * this.zScale)(s), (e => e * this.zScale)(e)]);
                        inRun = false;
                        continue;
                    }

                    // 일부 1이 앞에서 이어짐: LSB부터 연속 1(=prefix ones) 길이
                    const prefixOnes = ctz32((~word) >>> 0);
                    if (prefixOnes > 0) {
                        // 여기서 런 종료
                        const endQ = qBase + prefixOnes;
                        const s = runStartQ < Zmax ? runStartQ : Zmax;
                        const e = endQ < Zmax ? endQ : Zmax;
                        if (e > s) out.push([(e => e * this.zScale)(s), (e => e * this.zScale)(e)]);
                        inRun = false;

                        // 남은 비트들에서 새 런들 스캔
                        let v = word >>> prefixOnes;
                        while (v !== 0) {
                            const tz = ctz32(v);
                            v >>>= tz;
                            const sQ = qBase + prefixOnes + tz;
                            const ones = ctz32((~v) >>> 0);

                            if (ones < 32) {
                                const eQ = sQ + ones;
                                const s2 = sQ < Zmax ? sQ : Zmax;
                                const e2 = eQ < Zmax ? eQ : Zmax;
                                if (e2 > s2) out.push([(e => e * this.zScale)(s2), (e => e * this.zScale)(e2)]);
                                v >>>= ones;
                            } else {
                                // 다시 워드 끝까지 1 → 다음 워드로 연장
                                runStartQ = sQ;
                                inRun = true;
                                break;
                            }
                        }
                    } else {
                        // prefixOnes == 0 → 런이 정확히 워드 경계에서 끝남
                        const s = runStartQ < Zmax ? runStartQ : Zmax;
                        const e = qBase < Zmax ? qBase : Zmax;
                        if (e > s) out.push([(e => e * this.zScale)(s), (e => e * this.zScale)(e)]);
                        inRun = false;

                        // 이 워드 전체를 일반 스캔
                        let v = word;
                        while (v !== 0) {
                            const tz = ctz32(v);
                            v >>>= tz;
                            const sQ = qBase + tz;
                            const ones = ctz32((~v) >>> 0);

                            if (ones < 32) {
                                const eQ = sQ + ones;
                                const s2 = sQ < Zmax ? sQ : Zmax;
                                const e2 = eQ < Zmax ? eQ : Zmax;
                                if (e2 > s2) out.push([(e => e * this.zScale)(s2), (e => e * this.zScale)(e2)]);
                                v >>>= ones;
                            } else {
                                runStartQ = sQ;
                                inRun = true;
                                break;
                            }
                        }
                    }
                }
            }

            // 마지막 워드에서 열린 런이 끝나지 않았다면 Zmax에서 종료
            if (inRun) {
                const s = runStartQ < Zmax ? runStartQ : Zmax;
                const e = Zmax;
                if (e > s) out.push([(e => e * this.zScale)(s), (e => e * this.zScale)(e)]);
            }

            return out;
        };


        // 단일 칼럼에 대해 비트셋 반전 (Occ → Air)
        const invertColumnBits = (src, dst, base, wordsPerCol, lastMask) => {
            const last = base + wordsPerCol - 1;
            for (let w = 0; w < wordsPerCol - 1; w++) {
                dst[base + w] = ~src[base + w];
            }
            // 마지막 워드는 Zmax 경계 밖 비트 무시
            dst[last] = (~src[last]) & lastMask;
        };

        // 전체 컬럼의 점유(Occ) 비트셋 구성 (solid>=3, cavity=2 포함)
        const buildOccBits = (HmaxPlus, outKey) => {
            const nCols = NX * NY;
            const layout = makeBitLayout(HmaxPlus);
            const wordsPerCol = layout.wordsPerCol;
            const Zmax = layout.Zmax;

            const bits = ensureBits(outKey, nCols * wordsPerCol, true);

            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    const L = cols.len[cidx];
                    if (L === 0) continue;
                    const base0 = cidx * Lmax;
                    const bbase = cidx * wordsPerCol;
                    for (let k = 0; k < L; k++) {
                        const mb = base0 + k;
                        const m = cols.mat[mb];
                        if (m < CAVITY_ID) continue; // 빈 공간(0,1)은 제외
                        const z0 = this._dequantizeZ(cols.zpair[(mb << 1)]);
                        const z1 = this._dequantizeZ(cols.zpair[(mb << 1) + 1]);
                        if (z1 > z0 + eps) markRange(bits, bbase, z0, z1);
                    }
                }
            }
            return { bits, layout, Zmax, wordsPerCol };
        };

        // Air intervals (옆면 노출 판정용) 한 번에 전부 만들기
        const buildAirIntervalsAll = (occBits, layout) => {
            const nCols = NX * NY;
            const wordsPerCol = layout.wordsPerCol;
            const Zmax = layout.Zmax;
            const lastMask = layout.lastMask;

            const airBits = ensureBits('airBits0', nCols * wordsPerCol, true);

            for (let cidx = 0; cidx < nCols; cidx++) {
                const base = cidx * wordsPerCol;
                invertColumnBits(occBits, airBits, base, wordsPerCol, lastMask);
            }
            // emit 한 번으로 모든 칼럼의 Air 배열 생성
            const Air = new Array(nCols);
            for (let cidx = 0; cidx < nCols; cidx++) {
                Air[cidx] = emitIntervals(airBits, cidx, wordsPerCol, Zmax);
            }
            return Air;
        };

        // [u,v] 구간과 A(정렬된 인터벌 배열) 교집합 (상수 계산/분기 최소화)
        const intersectWith = (A, u, v) => {
            const out = [];
            if (!A || A.length === 0 || v <= u + eps) return out;
            for (let p = 0, n = A.length; p < n; p++) {
                const a0 = A[p][0];
                const a1 = A[p][1];
                if (a1 <= u + eps) continue;
                if (a0 >= v - eps) break;
                const s = a0 > u ? a0 : u;
                const e = a1 < v ? a1 : v;
                if (e > s + eps) out.push([s, e]);
                else if (Math.abs(e - s) <= eps) out.push([s, e]);
            }
            return out;
        };

        // Seeds 수집: 외부 공기 노출(top/bottom/lateral). "도메인 바닥/옆면은 외기 아님" 반영
        const collectALDSeeds = () => {
            const H0 = this.maxHeight();                   // 현재 최상단
            // seed 확장 시 반구 여유가 필요하므로 +T
            const occ0 = buildOccBits(H0 + T + this.zScale, 'occ0');
            const Air0 = buildAirIntervalsAll(occ0.bits, occ0.layout);

            const seeds = [];
            const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    const L = cols.len[cidx];
                    if (L === 0) continue;

                    const base0 = cidx * Lmax;
                    const airHere = Air0[cidx];

                    // 공기(z 포함?) 체크(이진 탐색 없이 선형; Air 길이가 보통 짧음)
                    const airHasZ = (arr, z) => {
                        for (let a = 0, n = arr.length; a < n; a++) {
                            const s = arr[a][0], e = arr[a][1];
                            if (z > s - eps && z < e + eps) return true;
                        }
                        return false;
                    };

                    for (let k = 0; k < L; k++) {
                        const mb = base0 + k;
                        const m = cols.mat[mb];
                        if (m < SOLID_MIN) continue;

                        const z0 = this._dequantizeZ(cols.zpair[(mb << 1)]);
                        const z1 = this._dequantizeZ(cols.zpair[(mb << 1) + 1]);

                        // (1) 윗면 노출: 이 칼럼 Air 포함 or 전역 탑에 거의 접함
                        if (airHasZ(airHere, z1) || Math.abs(z1 - H0) < eps) {
                            seeds.push({ i, j, zA: z1, zB: z1, isTop: true });
                        }
                        // (2) 아랫면 노출: 도메인 바닥은 외기 아님 (z0>eps) + Air 포함
                        if (z0 > eps && airHasZ(airHere, z0)) {
                            seeds.push({ i, j, zA: z0, zB: z0, isTop: false });
                        }

                        // (3) 옆면 노출: 이웃이 도메인 밖이면 외기 아님! 도메인 내 이웃의 Air ∩ [z0,z1]
                        for (let d = 0; d < 4; d++) {
                            const ni = i + dirs[d][0], nj = j + dirs[d][1];
                            if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue; // 옆면 경계 = 외기 아님
                            const nidx = ni * NY + nj;
                            const inter = intersectWith(Air0[nidx], z0, z1);
                            for (let u = 0, nn = inter.length; u < nn; u++) {
                                const s = inter[u][0], e = inter[u][1];
                                seeds.push({ i, j, zA: s, zB: e, isTop: false });
                            }
                        }
                    }
                }
            }
            return { seeds, Hmax: H0 };
        };

        // XY 커널(사전계산): 각 du에 대해 (dv, addZ) 리스트
        const buildKernelRows = (t) => {
            const Rx = Math.ceil(t / dx) | 0;
            const Ry = Math.ceil(t / dy) | 0;
            const t2 = t * t;
            const rows = new Array(Rx * 2 + 1);
            for (let du = -Rx; du <= Rx; du++) {
                const x = du * dx;
                const x2 = x * x;
                const rem = t2 - x2;
                if (rem < 0) {
                    rows[du + Rx] = null;
                    continue;
                }
                const maxDv = Math.floor(Math.sqrt(rem) / dy) | 0;
                if (maxDv > Ry) {
                    // 안전 가드
                }
                const row = [];
                for (let dv = -maxDv; dv <= maxDv; dv++) {
                    const y = dv * dy;
                    const r2 = x2 + y * y;
                    // 부동 오차 가드
                    let add = rem - (y * y);
                    if (add < 0) add = 0;
                    add = Math.sqrt(add);
                    row.push(dv, add);
                }
                rows[du + Rx] = row;
            }
            return { Rx, Ry, rows };
        };

        // Seeds → (반경 t) spherocylinder 확장 → Fill 비트셋(수직 투영)
        const expandSeedsToFillBits = (seeds, t, baseHmax) => {
            // Fill 높이는 반구 여유 포함
            const Hcap = baseHmax + t + this.zScale;
            const layout = makeBitLayout(Hcap);
            const Zmax = layout.Zmax;
            const wordsPerCol = layout.wordsPerCol;

            const nCols = NX * NY;
            const fillBits = ensureBits('fillBits', nCols * wordsPerCol, true);

            // 활성 bbox
            let imin = NX, imax = -1, jmin = NY, jmax = -1;
            for (let s = 0, ns = seeds.length; s < ns; s++) {
                const si = seeds[s].i;
                const sj = seeds[s].j;
                if (si < imin) imin = si; if (si > imax) imax = si;
                if (sj < jmin) jmin = sj; if (sj > jmax) jmax = sj;
            }
            if (imin === NX) return { bits: fillBits, layout };
            // 커널 여유
            const kr = buildKernelRows(t);
            const Rx = kr.Rx, rows = kr.rows;
            imin = Math.max(0, imin - Rx);
            imax = Math.min(NX - 1, imax + Rx);
            jmin = Math.max(0, jmin - Rx);
            jmax = Math.min(NY - 1, jmax + Rx);

            // 각 seed에 대해 XY 디스크 확장 → z 구간 마킹
            for (let s = 0, ns = seeds.length; s < ns; s++) {
                const si = seeds[s].i, sj = seeds[s].j;
                const zA = seeds[s].zA, zB = seeds[s].zB;
                const isTop = seeds[s].isTop;

                for (let du = -Rx; du <= Rx; du++) {
                    const ii = si + du; if (ii < imin || ii > imax) continue;
                    const row = rows[du + Rx];
                    if (!row) continue;

                    for (let rr = 0, rn = row.length; rr < rn; rr += 2) {
                        const dv = row[rr] | 0;
                        const add = row[rr + 1];
                        const jj = sj + dv; if (jj < jmin || jj > jmax) continue;

                        // 수직 투영: [lo, hi)
                        const lo = isTop ? (zA - add) : (zA - add);
                        const hi = isTop ? (zA + add) : (zB + add);
                        if (hi <= lo + eps) continue;

                        const cidx = ii * NY + jj;
                        const base = cidx * wordsPerCol;
                        // 도메인 하한 0, 상한 Hcap 클램프
                        let z0 = lo > 0 ? lo : 0;
                        let z1 = hi < Hcap ? hi : Hcap;
                        if (z1 <= z0 + eps) continue;

                        // 반열림 q 범위로 마킹
                        let q0 = qZ(z0); if (q0 < 0) q0 = 0; //(61ms) 
                        let q1 = qZ(z1); if (q1 <= q0) q1 = q0 + 1; //(56ms)
                        markRangeQ(fillBits, base, q0, q1);
                    }
                }
            }

            return { bits: fillBits, layout };
        };

        // coatBits = fillBits & (~occBits)
        const buildCoatBits = (fillBits, occBits, layout) => {
            const nCols = NX * NY;
            const wordsPerCol = layout.wordsPerCol;
            const lastMask = layout.lastMask;

            const coatBits = ensureBits('coatBits', nCols * wordsPerCol, true);
            // ~occBits with masking (마지막 워드 마스크)
            for (let cidx = 0; cidx < nCols; cidx++) {
                const base = cidx * wordsPerCol;
                const last = base + wordsPerCol - 1;
                for (let w = 0; w < wordsPerCol - 1; w++) {
                    coatBits[base + w] = fillBits[base + w] & (~occBits[base + w]);
                }
                coatBits[last] = fillBits[last] & ((~occBits[last]) & lastMask);
            }
            return coatBits;
        };

        // coat 비트셋을 SoA에 삽입 (정렬유지/병합 포함)
        const applyCoatFromBits = (coatBits, layout, targMatId) => {
            const wordsPerCol = layout.wordsPerCol;
            const Zmax = layout.Zmax;

            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    const L = cols.len[cidx];

                    // 현재 세그먼트(cur) → AoS 추출 + 정렬
                    const cur = [];
                    if (L > 0) {
                        const base0 = cidx * Lmax;
                        for (let k = 0; k < L; k++) {
                            const mb = base0 + k;
                            const z0 = this._dequantizeZ(cols.zpair[(mb << 1)]);
                            const z1 = this._dequantizeZ(cols.zpair[(mb << 1) + 1]);
                            const m = cols.mat[mb];
                            if (z1 > z0 + eps) cur.push([z0, z1, m]);
                        }
                        if (cur.length > 1) {
                            cur.sort((A, B) => (A[0] === B[0] ? A[1] - B[1] : A[0] - B[0]));
                        }
                    }

                    // coat 비트셋 → 인터벌
                    const insRaw = emitIntervals(coatBits, cidx, wordsPerCol, Zmax);
                    if (!insRaw || insRaw.length === 0) continue;

                    // 삽입 세그먼트(ins) = 모두 targMatId, 정렬 유지
                    const ins = new Array(insRaw.length);
                    for (let t = 0, n = insRaw.length; t < n; t++) {
                        const s0 = insRaw[t][0], s1 = insRaw[t][1];
                        ins[t] = [s0, s1, targMatId];
                    }

                    // k-way merge (cur, ins)
                    const merged = [];
                    let p = 0, q = 0;
                    const nC = cur.length, nI = ins.length;
                    while (p < nC && q < nI) {
                        const A = cur[p], B = ins[q];
                        if (A[0] < B[0] || (A[0] === B[0] && A[1] <= B[1])) { merged.push(A); p++; }
                        else { merged.push(B); q++; }
                    }
                    while (p < nC) merged.push(cur[p++]);
                    while (q < nI) merged.push(ins[q++]);

                    // 인접 병합(같은 물질만): 경계 보존
                    const out = [];
                    for (let u = 0, n = merged.length; u < n; u++) {
                        const seg = merged[u];
                        let z0 = seg[0], z1 = seg[1], m = seg[2];
                        if (!out.length) { out.push([z0, z1, m]); continue; }

                        const Lz = out.length - 1;
                        const pz0 = out[Lz][0], pz1 = out[Lz][1], pm = out[Lz][2];

                        if (z0 <= pz1 + eps) {
                            if (pm === m) {
                                // 같은 재료 → 연장 병합
                                if (z1 > pz1) out[Lz][1] = z1;
                            } else {
                                // 다른 재료 → 경계 보존
                                const nz0 = z0 > pz1 ? z0 : pz1;
                                if (z1 > nz0 + eps) out.push([nz0, z1, m]);
                            }
                        } else {
                            out.push([z0, z1, m]);
                        }
                    }

                    // SoA 반영 (필요 시 확장)
                    if (out.length > Lmax) this._expandBuffers();
                    cols.len[cidx] = out.length;

                    const base0 = cidx * Lmax;
                    for (let k = 0; k < out.length; k++) {
                        const mb = base0 + k;
                        let z0 = out[k][0], z1 = out[k][1], m = out[k][2];
                        let q0 = qZ(z0), q1 = qZ(z1);
                        if (q1 <= q0) q1 = q0 + 1; // 최소 1bin 보장
                        cols.mat[mb] = m;
                        cols.zpair[(mb << 1)] = q0;
                        cols.zpair[(mb << 1) + 1] = q1;
                    }

                    // trailing clear
                    for (let k = out.length; k < L; k++) {
                        const mb = base0 + k;
                        const zb = (mb << 1);
                        cols.mat[mb] = 0;
                        cols.zpair[zb] = 0;
                        cols.zpair[zb + 1] = 0;
                    }
                }
            }
        };

        // SoA 스냅샷/복구
        const snapshotCols = () => ({
            Lmax: this.Lmax,
            mat: cols.mat.slice(),
            zpair: cols.zpair.slice(),
            len: cols.len.slice(),
        });
        const loadSnapshot = (snap) => {
            if (snap.Lmax !== this.Lmax) this._expandBuffers();
            cols.mat.set(snap.mat);
            cols.zpair.set(snap.zpair);
            cols.len.set(snap.len);
        };

        // 단일 t에서 Coat 비트셋 계산 (Seeds 고정, base=현재 cols)
        const computeCoatBitsSingleT = (seedsPack, t) => {
            // base 기준 점유 재계산 (neck 폐색/새 cavity 반영)
            const Hnow = this.maxHeight();                 // 현재 높이
            const occNow = buildOccBits(Hnow + t + this.zScale, 'occNow');
            const fill = expandSeedsToFillBits(seedsPack.seeds, t, Hnow);
            // coat = fill & ~occ
            const coatBits = buildCoatBits(fill.bits, occNow.bits, fill.layout);
            return { coatBits, layout: fill.layout };
        };

        // cavity만 base에 누적 (grid_tmp에서 detect 후 diff)
        const collectMatIntervals = (mat) => {
            const out = new Array(NX * NY);
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    const L = cols.len[cidx];
                    if (L === 0) { out[cidx] = []; continue; }
                    const base0 = cidx * Lmax;
                    const acc = [];
                    for (let k = 0; k < L; k++) {
                        const mb = base0 + k;
                        if (cols.mat[mb] !== mat) continue;
                        const z0 = this._dequantizeZ(cols.zpair[(mb << 1)]);
                        const z1 = this._dequantizeZ(cols.zpair[(mb << 1) + 1]);
                        if (z1 > z0 + eps) acc.push([z0, z1]);
                    }
                    // 이미 emitIntervals 결과와 유사하게 정렬 필요 최소화
                    if (acc.length > 1) acc.sort((A, B) => (A[0] === B[0] ? A[1] - B[1] : A[0] - B[0]));
                    // 인접 병합
                    const merged = [];
                    for (let u = 0; u < acc.length; u++) {
                        const a0 = acc[u][0], a1 = acc[u][1];
                        if (!merged.length) { merged.push([a0, a1]); continue; }
                        const Lz = merged.length - 1;
                        if (a0 <= merged[Lz][1] + eps) {
                            if (a1 > merged[Lz][1]) merged[Lz][1] = a1;
                        } else merged.push([a0, a1]);
                    }
                    out[cidx] = merged;
                }
            }
            return out;
        };

        const diffIntervals = (A, B) => {
            if (!A.length) return [];
            if (!B.length) return A.slice();
            const out = [];
            let j = 0;
            for (let i = 0; i < A.length; i++) {
                const s = A[i][0], e = A[i][1];
                while (j < B.length && B[j][1] <= s + eps) j++;
                let k = j, cur = s;
                while (k < B.length && B[k][0] < e - eps) {
                    const bs = B[k][0], be = B[k][1];
                    if (bs > cur + eps) out.push([cur, Math.min(bs, e)]);
                    if (be > cur) cur = be;
                    if (cur >= e - eps) break;
                    k++;
                }
                if (cur < e - eps) out.push([cur, e]);
            }
            // out은 이미 정렬/비중첩
            return out;
        };

        const mergeNewCavityFromTmp = (snapBefore) => {
            // 현재(cols)는 grid_tmp.identify_cavity()까지 수행된 상태
            const cavAfter = collectMatIntervals(CAVITY_ID);

            // 이전 스냅샷으로 복구 → 이전 cavity
            loadSnapshot(snapBefore);
            const cavBefore = collectMatIntervals(CAVITY_ID);

            // new = after \ before
            const nCols = NX * NY;
            const newCav = new Array(nCols);
            for (let c = 0; c < nCols; c++) {
                newCav[c] = diffIntervals(cavAfter[c], cavBefore[c]);
            }

            // base에 cavity만 반영
            // 비트셋 경유 없이 바로 삽입 경로 재사용
            // → coatBits 없이도, 삽입용 인터벌을 coat처럼 사용
            // 재료 id는 CAVITY_ID
            // out-of-band 삽입기: applyCoatIntervals와 동일한 로직
            // (중복 코드를 피하기 위해 coatBits 경로를 간접 호출)
            // 여기서는 간단히 coatBits 없이 직접 out 배열을 만들어 넣자:
            // => 편의상 coatBits 경로를 재사용하려면 비트셋으로 변환해야 하므로,
            //    여기서는 기존 배열 삽입 로직을 재사용.
            //    (성능 영향 미미: cavity 수는 적음)
            const layout = makeBitLayout(this.maxHeight() + this.zScale);
            const wordsPerCol = layout.wordsPerCol;
            const Zmax = layout.Zmax;
            const tmpBits = ensureBits('tmpCavBits', (NX * NY) * wordsPerCol, true);

            // newCav → 비트로 마킹
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    const base = cidx * wordsPerCol;
                    const arr = newCav[cidx];
                    for (let u = 0, n = arr.length; u < n; u++) {
                        let z0 = arr[u][0], z1 = arr[u][1];
                        if (z1 <= z0 + eps) continue;
                        let q0 = qZ(z0); if (q0 < 0) q0 = 0;
                        let q1 = qZ(z1); if (q1 <= q0) q1 = q0 + 1;
                        if (q1 > Zmax) q1 = Zmax;
                        markRangeQ(tmpBits, base, q0, q1);
                    }
                }
            }
            // 비트 → 삽입
            applyCoatFromBits(tmpBits, layout, CAVITY_ID);
        };

        // =========================================================
        // 메인 절차
        // =========================================================

        // 1) Seeds 준비 (캐시 가능)
        let seedsPack;
        if (isCache && this.sliderCache.aldCache.exposedSegments) {
            seedsPack = { seeds: this.sliderCache.aldCache.exposedSegments, Hmax: this.maxHeight() };
        } else {
            seedsPack = collectALDSeeds();
        }
        this.sliderCache.aldCache.exposedSegments = seedsPack.seeds;

        // 2) 앵커 스냅샷 (캐시 tAnchor ≤ T 중 최대)
        let tAnchor = 0;
        if (isCache && this.sliderCache.aldCache.gridWithCavity.size > 0) {
            let best = -1;
            for (const tk of this.sliderCache.aldCache.gridWithCavity.keys()) {
                if (tk <= T + eps && tk > best) best = tk;
            }
            if (best >= 0) {
                loadSnapshot(this.sliderCache.aldCache.gridWithCavity.get(best));
                tAnchor = best;
            }
        }

        // 3) 증분 루프 (cavity만 누적)
        for (let t = tAnchor + dt; t < T - eps; t += dt) {
            const coatPack = computeCoatBitsSingleT(seedsPack, t);

            // grid_tmp: base + coat(t)
            const snapBefore = snapshotCols();
            applyCoatFromBits(coatPack.coatBits, coatPack.layout, matId);

            // cavity 검출
            this.identify_cavity();

            // new cavity만 base로 누적(coat는 롤백)
            mergeNewCavityFromTmp(snapBefore);

            // 캐시 저장
            this.sliderCache.aldCache.gridWithCavity.set(t, snapshotCols());
        }

        // 4) 최종 t=T coat 적용
        const coatFinal = computeCoatBitsSingleT(seedsPack, T);
        applyCoatFromBits(coatFinal.coatBits, coatFinal.layout, matId);

        // 캐시 저장
        this.sliderCache.aldCache.gridWithCavity.set(T, snapshotCols());
        
        this.identify_cavity();
    }




















    // 등방성 웻 에치 (누적식)
    // - matId: 식각 대상 물질 id (255 => ALL solids(>=3))
    // - totalThk: 총 식각 두께
    // - opts: { dt?: number, isCache?: boolean }
    etch_wet(matId, totalThk, opts = {}) {
        const T = Math.max(0, Number(totalThk) || 0);
        if (T <= 0) return;

        const NX = this.NX, NY = this.NY, Lmax = this.Lmax;
        const dx = this.dx, dy = this.dy;
        const cols = this.cols;
        const CAVITY_ID = 2;
        const SOLID_MIN = 3;
        const eps = 1e-9;

        // 증분 두께 (기본: min(dx,dy))
        const baseDt = Math.max(opts.dt ?? Math.min(dx, dy), 1e-6);
        const isCache = !!opts.isCache;

        // 슬라이더 캐시 준비
        const INV_SQRT2 = 0.7071067811865476;
        this.sliderCache = this.sliderCache || {};
        this.sliderCache.wetetchCache = this.sliderCache.wetetchCache || { grid: new Map(), R: 0 };
        let R = 0;

        // =============== 내부 헬퍼들 (이 함수 전용) ===============

        // 정량화(이미 클래스에 구현됨) 재사용용 래퍼
        const qZ = (z) => this._quantizeZ(z);    // real -> int step
        const dZ = (q) => this._dequantizeZ(q);  // int step -> real

        // 정규화: [q0,q1] (정수) 배열 정렬·머지
        const normalizeQ = (arr) => {
            if (!arr || arr.length === 0) return [];
            arr.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
            const out = [];
            let s = arr[0][0], e = arr[0][1];
            for (let i = 1; i < arr.length; i++) {
                const a = arr[i][0], b = arr[i][1];
                if (a <= e) { e = Math.max(e, b); }
                else { if (e > s) out.push([s, e]); s = a; e = b; }
            }
            if (e > s) out.push([s, e]);
            return out;
        };

        // 차집합 A\B (모두 정규화 가정, 정수 간격)
        const diffIntervalsQ = (A, B) => {
            if (!A.length) return [];
            if (!B.length) return A.slice();
            const out = [];
            let j = 0;
            for (let i = 0; i < A.length; i++) {
                let s = A[i][0], e = A[i][1];
                while (j < B.length && B[j][1] <= s) j++;
                let k = j, cur = s;
                while (k < B.length && B[k][0] < e) {
                    const bs = B[k][0], be = B[k][1];
                    if (bs > cur) out.push([cur, Math.min(bs, e)]);
                    cur = Math.max(cur, be);
                    if (cur >= e) break;
                    k++;
                }
                if (cur < e) out.push([cur, e]);
            }
            return out;
        };

        // 교집합 A ∩ [u,v] (A 정규화 가정)
        const intersectWithQ = (A, seg) => {
            const u = seg[0], v = seg[1];
            if (!A.length || v <= u) return [];
            const out = [];
            for (let i = 0; i < A.length; i++) {
                const a = A[i][0], b = A[i][1];
                if (b <= u) continue;
                if (a >= v) break;
                const s = Math.max(a, u), e = Math.min(b, v);
                if (e > s) out.push([s, e]);
            }
            return out;
        };

        // 한 컬럼의 현재 세그먼트(정수) 정렬 추출 [q0,q1,mat]
        const getSegmentsQ = (cidx) => {
            const L = cols.len[cidx];
            if (!L) return [];
            const base = cidx * Lmax;
            const segs = new Array(L);
            for (let k = 0; k < L; k++) {
                const b = base + k;
                const q0 = cols.zpair[b * 2] | 0;
                const q1 = cols.zpair[b * 2 + 1] | 0;
                const m = cols.mat[b] | 0;
                if (q1 > q0) segs[k] = [q0, q1, m];
                else segs[k] = null; // 얇거나 역전된 값은 무시
            }
            // null 제거 + 정렬
            const compact = [];
            for (let s of segs) if (s) compact.push(s);
            if (compact.length > 1) {
                compact.sort((A, B) => (A[0] === B[0] ? A[1] - B[1] : A[0] - B[0]));
            }
            return compact;
        };

        // 전체 Hmax (정수) 계산
        const maxHeightQ = () => {
            let qmax = 0;
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    const L = cols.len[cidx];
                    if (!L) continue;
                    const bTop = cidx * Lmax + (L - 1);
                    const qTop = cols.zpair[bTop * 2 + 1] | 0;
                    if (qTop > qmax) qmax = qTop;
                }
            }
            return Math.max(qmax, 1);
        };

        // 점유집합 Occ: mat >=2 (cavity 포함) → [q0,q1] 정규화
        const buildOccAllQ = () => {
            const H = new Array(NX * NY);
            for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const segs = getSegmentsQ(cidx);
                if (!segs.length) { H[cidx] = []; continue; }
                const acc = [];
                for (let s of segs) {
                    if (s[2] >= CAVITY_ID) acc.push([s[0], s[1]]);
                }
                H[cidx] = normalizeQ(acc);
            }
            return H;
        };

        // 외기 Air = [0,Hmax) \ Occ  (cavity는 Occ로 막음 → 내부공기 제외)
        const buildAirAllQ = (Occ, HmaxQ) => {
            const Air = new Array(NX * NY);
            const full = [[0, HmaxQ]];
            for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                Air[cidx] = diffIntervalsQ(full, Occ[cidx]);
            }
            return Air;
        };

        // 제거 인터벌 누산기: R[cidx] = [[q0,q1], ...]
        const initRemoveMap = () => {
            const R = new Array(NX * NY);
            for (let c = 0; c < NX * NY; c++) R[c] = [];
            return R;
        };

        // 대상 판단
        const isTarget = (m) => {
            if (matId === 255) return m >= SOLID_MIN;    // ALL solids
            return m === matId;
        };

        // 수직(top/bottom) 제거 인터벌 추가
        const addVertRemovals = (R, HmaxQ, dtQ) => {
            for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const segs = getSegmentsQ(cidx);
                if (!segs.length) continue;

                // (a) 최상층(top): 항상 외기 노출로 간주 → 타겟이면 dt만큼 깎기
                const topSeg = segs[segs.length - 1];
                const topQ0 = topSeg[0], topQ1 = topSeg[1], topMat = topSeg[2];
                if (isTarget(topMat)) {
                    const q0 = Math.max(topQ0, topQ1 - dtQ); // 아래층까지 넘치지 않도록 클램프
                    const q1 = topQ1;
                    if (q1 > q0) R[cidx].push([q0, q1]);
                }

                // (b) 내부 gap: 인접 두 세그 사이에 공기 → 위/아래 둘 다 식각
                for (let s = 0; s < segs.length - 1; s++) {
                    const A = segs[s], B = segs[s + 1];
                    const gap0 = A[1], gap1 = B[0];
                    if (gap1 <= gap0) continue; // no gap

                    // 아래 세그먼트(A)의 top 깎기
                    if (isTarget(A[2])) {
                        const q0 = Math.max(A[0], A[1] - dtQ);
                        const q1 = A[1];
                        if (q1 > q0) R[cidx].push([q0, q1]);
                    }
                    // 위 세그먼트(B)의 bottom 깎기
                    if (isTarget(B[2])) {
                        const q0 = B[0];
                        const q1 = Math.min(B[1], B[0] + dtQ);
                        if (q1 > q0) R[cidx].push([q0, q1]);
                    }
                }
            }
        };

        // 측면 제거 인터벌 추가 (4-이웃, 구형 라운딩 보정 ±dtDiag)
        // 기존 addLateralRemovals(Air, HmaxQ, dtQ) → 인자 하나 추가: useDiagonal
        const addLateralRemovals = (R, Air, HmaxQ, dtQ, useDiagonal) => {
            const dtQDiag = Math.max(1, Math.floor(dtQ * INV_SQRT2));

            // 4방향(상하좌우) + (옵션) 8방향(대각) 이웃 세트
            const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            const dirs8 = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

            // 중심 컬럼의 air 인터벌을 이웃 컬럼의 제거 인터벌로 투영
            for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const centerAir = Air[cidx];
                if (!centerAir || centerAir.length === 0) continue;

                // ----------------------------
                // 1) 4방향(옆면) 처리: 상/하를 dt/√2만큼 확장
                //    → [a - dtDiag, b + dtDiag]
                // ----------------------------
                for (const [di, dj] of dirs4) {
                    const ni = i + di, nj = j + dj;
                    if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue; // 도메인 옆 경계는 외기 아님
                    const nidx = ni * NY + nj;
                    const list = R[nidx];

                    // 중심 air를 기준으로 이웃 타겟 물질을 제거할 수직 구간 추가
                    for (let k = 0; k < centerAir.length; k++) {
                        const a = centerAir[k][0], b = centerAir[k][1];     // [q] 단위(정수)
                        if (b <= a) continue;
                        const q0 = Math.max(0, a - dtQDiag);
                        const q1 = Math.min(HmaxQ, b + dtQDiag);
                        if (q1 > q0) list.push([q0, q1]);
                    }
                }

                // ----------------------------
                // 2) (옵션) 8방향(대각) 처리: 상/하를 dt/√2만큼 "축소"
                //    → [a + dtDiag, b - dtDiag]
                // ----------------------------
                if (useDiagonal) {
                    for (const [di, dj] of dirs8) {
                        const ni = i + di, nj = j + dj;
                        if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue;
                        const nidx = ni * NY + nj;
                        const list = R[nidx];

                        for (let k = 0; k < centerAir.length; k++) {
                            const a = centerAir[k][0], b = centerAir[k][1];
                            if (b <= a) continue;

                            // 대각선은 '축소 윈도우' (구형 근사)
                            let q0 = a + dtQDiag;
                            let q1 = b - dtQDiag;

                            // 너무 얇아지면 스킵
                            if (q1 <= q0) continue;

                            // 도메인 클램프
                            q0 = Math.max(0, q0);
                            q1 = Math.min(HmaxQ, q1);

                            if (q1 > q0) list.push([q0, q1]);
                        }
                    }
                }
            }
        };


        // 제거 인터벌 적용: 타겟 물질만 A\B 수행, 비타겟 유지
        const applyRemovalIntervals = (R) => {
            for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const segs = getSegmentsQ(cidx);
                const Lold = cols.len[cidx];

                // 이 칼럼에 제거가 없으면 skip
                const cuts = normalizeQ(R[cidx]);
                if (!cuts.length) continue;

                // 타겟/비타겟 분리 후 타겟만 차집합
                const out = [];
                for (let s of segs) {
                    const q0 = s[0], q1 = s[1], m = s[2];
                    if (!isTarget(m)) { out.push([q0, q1, m]); continue; }

                    // [q0,q1] \ cuts
                    const remain = diffIntervalsQ([[q0, q1]], cuts);
                    for (let r of remain) {
                        if (r[1] > r[0]) out.push([r[0], r[1], m]);
                    }
                }

                // 인접 동일 물질 병합
                if (out.length > 1) {
                    out.sort((A, B) => (A[0] === B[0] ? A[1] - B[1] : A[0] - B[0]));
                    const merged = [];
                    for (let s of out) {
                        if (!merged.length) { merged.push(s); continue; }
                        const last = merged[merged.length - 1];
                        if (s[0] <= last[1] && s[2] === last[2]) {
                            // 겹치거나 맞닿는 동일 물질 → 확장
                            last[1] = Math.max(last[1], s[1]);
                        } else merged.push(s);
                    }
                    // 기록
                    if (merged.length > Lmax) this.expandBuffers(merged.length);
                    cols.len[cidx] = merged.length;
                    const base = cidx * Lmax;
                    for (let k = 0; k < merged.length; k++) {
                        const b = base + k;
                        cols.mat[b] = merged[k][2];
                        cols.zpair[b * 2] = merged[k][0];
                        cols.zpair[b * 2 + 1] = merged[k][1];
                    }
                    // trailing clear
                    for (let k = merged.length; k < Lold; k++) {
                        const b = base + k; const zb = b * 2;
                        cols.mat[b] = 0; cols.zpair[zb] = 0; cols.zpair[zb + 1] = 0;
                    }
                } else {
                    // out ≤ 1
                    if (out.length > 0) {
                        if (1 > Lmax) this.expandBuffers(1);
                        cols.len[cidx] = 1;
                        const b = cidx * Lmax;
                        cols.mat[b] = out[0][2];
                        cols.zpair[b * 2] = out[0][0];
                        cols.zpair[b * 2 + 1] = out[0][1];
                        for (let k = 1; k < Lold; k++) {
                            const bb = cidx * Lmax + k; const zb = bb * 2;
                            cols.mat[bb] = 0; cols.zpair[zb] = 0; cols.zpair[zb + 1] = 0;
                        }
                    } else {
                        // 전부 제거됨
                        cols.len[cidx] = 0;
                        for (let k = 0; k < Lold; k++) {
                            const b = cidx * Lmax + k; const zb = b * 2;
                            cols.mat[b] = 0; cols.zpair[zb] = 0; cols.zpair[zb + 1] = 0;
                        }
                    }
                }
            }
        };

        // 스냅샷/복구
        const snapshotCols = () => ({
            Lmax: this.Lmax,
            mat: cols.mat.slice(),
            zpair: cols.zpair.slice(),
            len: cols.len.slice(),
        });
        const loadSnapshot = (snap) => {
            if (!snap) return;
            if (snap.Lmax !== this.Lmax) this.expandBuffers(snap.Lmax);
            cols.mat.set(snap.mat);
            cols.zpair.set(snap.zpair);
            cols.len.set(snap.len);
        };

        // 한 스텝(dtQ 정수) 수행
        const stepOnce = (dtQ, useDiagonal) => {
            const Hq = maxHeightQ();
            const Occ = buildOccAllQ();
            const Air = buildAirAllQ(Occ, Hq);

            const R = initRemoveMap();

            // 1) 수직(top/bottom) 한 스텝
            addVertRemovals(R, Hq, dtQ);

            // 2) 측면(±dt/√2) 한 스텝
            addLateralRemovals(R, Air, Hq, dtQ, useDiagonal);

            // 3) 제거 적용 (타겟만)
            applyRemovalIntervals(R);

            // 4) cavity 재마킹 (새로운 void 중 외부와 단절된 것만 cavity로)
            this.identify_cavity();
        };

        // =============== 메인 루프 (캐시 활용) ===============
        // 앵커 찾기
        let tAnchor = 0;
        if (isCache && this.sliderCache.wetetchCache.grid.size > 0) {
            let best = -1;
            for (const t of this.sliderCache.wetetchCache.grid.keys()) {
                if (t <= T + eps && t > best) best = t;
            }
            if (best >= 0) {
                loadSnapshot(this.sliderCache.wetetchCache.grid.get(best));
                R = Number(this.sliderCache.wetetchCache.R) || 0;     // 잔여지수 복구
                tAnchor = best;
            }
        }

        // 증분 루프: (남은 구간은 마지막 스텝에서 dt를 줄여서 처리)
        let t = tAnchor;
        while (t < T - eps) {


            R += INV_SQRT2;
            let useDiagonal = false;
            if (R > 1) {
                R -= 1;
                useDiagonal = true;     // 이번 step은 8방향 확장 적용
            }


            const remain = T - t;
            const dtReal = Math.min(baseDt, remain);
            const dtQ = Math.max(1, qZ(dtReal) | 0); // 최소 1 스텝 보장
            stepOnce(dtQ, useDiagonal);
            t += dZ(dtQ); // 실제 반영된 양(정량화)을 누적
            // 캐시 저장
            this.sliderCache.wetetchCache.grid.set(t, snapshotCols());
            this.sliderCache.wetetchCache.R = R;
        }
        this.identify_cavity();
    }






}




/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    window.prj.ColumnGrid = ColumnGrid;
});
