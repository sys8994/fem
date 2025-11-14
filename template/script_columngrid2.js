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
