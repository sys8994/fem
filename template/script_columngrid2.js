
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





    // ColumnGrid 메서드로 추가
    deposit_ALD(matId, totalThk, opts = {}) {
        const T = Math.max(0, Number(totalThk) || 0);
        if (T <= 0) return;

        // ---------- 공통 상수/참조 ----------
        const NX = this.NX, NY = this.NY, Lmax = this.Lmax;
        const dx = this.dx, dy = this.dy;
        const cols = this.cols;
        const CAVITY_ID = 2;
        const SOLID_MIN = 3;
        const eps = 1e-9;

        // z 스텝 기본값: dx,dy 스케일과 유사한 값 권장 (필요 시 클래스 필드 사용)
        const zStepNm = this._zStepNm || Math.min(dx, dy);

        // 증분 두께 dt
        const dt = Math.max(opts.dt ?? Math.max(dx, dy, zStepNm), 1e-3);
        const isCache = !!opts.isCache;

        // 캐시 초기화
        this._aldCache = this._aldCache || {
            exposedSegments: null,        // [{i,j,zA,zB,isTop}]
            gridWithCavity: new Map(),    // t -> snapshot
        };

        // =========================================================
        // 내부 헬퍼들 (이 함수에서만 사용)
        // =========================================================

        // --- 인터벌 정규화: 정렬 + 인접/겹침 머지 ---
        const normalize = (arr) => {
            if (!arr || arr.length === 0) return [];
            arr.sort((a, b) => a[0] - b[0]);
            const out = [];
            let [s, e] = arr[0];
            for (let i = 1; i < arr.length; i++) {
                const [a, b] = arr[i];
                if (a <= e + eps) {
                    if (b > e) e = b;
                } else {
                    if (e > s + eps) out.push([s, e]);
                    else if (Math.abs(e - s) <= eps) out.push([s, e]); // 점 구간 허용
                    [s, e] = [a, b];
                }
            }
            if (e > s + eps) out.push([s, e]);
            else if (Math.abs(e - s) <= eps) out.push([s, e]);
            return out;
        };

        // --- 인터벌 차집합 A\B (A,B 정규화 가정) ---
        const diffIntervals = (A, B) => {
            if (!A.length) return [];
            if (!B.length) return A.slice();
            const out = [];
            let j = 0;
            for (let i = 0; i < A.length; i++) {
                let [s, e] = A[i];
                while (j < B.length && B[j][1] <= s + eps) j++;
                let k = j;
                let curS = s;
                while (k < B.length && B[k][0] < e - eps) {
                    const [bs, be] = B[k];
                    if (bs > curS + eps) out.push([curS, Math.min(be, e, be > curS ? bs : curS)]);
                    if (be > curS) curS = Math.max(curS, be);
                    if (curS >= e - eps) break;
                    k++;
                }
                if (curS < e - eps) out.push([curS, e]);
            }
            return normalize(out);
        };

        // --- 인터벌 교집합 A∩[u,v] (A 정규화 가정) ---
        const intersectWith = (A, seg) => {
            if (!A.length) return [];
            const [u, v] = seg;
            if (v < u + eps) return [];
            const out = [];
            // A가 정렬되어 있다는 가정
            for (let i = 0; i < A.length; i++) {
                const [a, b] = A[i];
                if (b <= u + eps) continue;
                if (a >= v - eps) break;
                const s = Math.max(a, u);
                const e = Math.min(b, v);
                if (e > s + eps) out.push([s, e]);
                else if (Math.abs(e - s) <= eps) out.push([s, e]);
            }
            return out;
        };

        // --- 컬럼별 점유집합 Occ: solid(>=3) ∪ cavity(=2) ---
        const buildOccAll = () => {
            const H = new Array(NX * NY);
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    const L = cols.len[cidx];
                    if (L === 0) { H[cidx] = []; continue; }
                    const acc = [];
                    for (let k = 0; k < L; k++) {
                        const base = cidx * this.Lmax + k;
                        const m = cols.mat[base];
                        if (m >= CAVITY_ID) {
                            const z0 = this._dequantizeZ(cols.zpair[base * 2]);
                            const z1 = this._dequantizeZ(cols.zpair[base * 2 + 1]);
                            acc.push([z0, z1]);
                        }
                    }
                    H[cidx] = normalize(acc);
                }
            }
            return H;
        };

        // --- 외부공기 Air = [0,Hmax] \ Occ (경계 취급은 seed에서 반영) ---
        const buildAirAll = (Occ, Hmax) => {
            const Air = new Array(NX * NY);
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    Air[cidx] = diffIntervals([[0, Hmax]], Occ[cidx]);
                }
            }
            return Air;
        };

        // --- top 노출 판단 ---
        // const isExposedTop = (i, j, z1, zTop) => (Math.abs(z1 - zTop) < eps);

        // --- lateral 노출 수집: 이웃 Air ∩ [z0,z1] (도메인 밖은 외기 아님!) ---
        const collectLateralExposedIntervals = (i, j, z0, z1, Air) => {
            const out = [];
            const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (const [di, dj] of dirs) {
                const ni = i + di, nj = j + dj;
                if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue; // 옆면 경계는 외기 아님
                const a = Air[ni * NY + nj];
                if (!a.length) continue;
                const inter = intersectWith(a, [z0, z1]);
                if (inter.length) out.push(...inter);
            }
            return normalize(out);
        };

        // --- Seeds 수집 (Air 직접 기반: top/bottom/lateral 노출 모두 포함) ---
        const collectALDSeeds = () => {
            const seeds = [];
            const Hmax = this.maxHeight();
            const Occ0 = buildOccAll();
            const Air0 = buildAirAll(Occ0, Hmax);

            // Air 인터벌에 z가 포함되는지 검사
            const airHasZ = (airIntervals, z) => {
                for (let k = 0; k < airIntervals.length; k++) {
                    const [a, b] = airIntervals[k];
                    if (z > a - eps && z < b + eps) return true;
                }
                return false;
            };

            for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const L = cols.len[cidx];
                if (L === 0) continue;

                for (let k = 0; k < L; k++) {
                    const base = cidx * this.Lmax + k;
                    const m = cols.mat[base];
                    if (m < SOLID_MIN) continue; // solid만 ALD 대상 표면
                    const z0 = this._dequantizeZ(cols.zpair[base * 2]);
                    const z1 = this._dequantizeZ(cols.zpair[base * 2 + 1]);

                    // (1) 윗면 노출: z1이 이 컬럼 Air에 포함되면 or 전역 탑이면 top seed
                    if (airHasZ(Air0[cidx], z1) || Math.abs(z1 - Hmax) < eps) {
                        seeds.push({ i, j, zA: z1, zB: z1, isTop: true });
                    }
                    // (2) 아랫면 노출: z0>eps && z0이 Air에 포함되면 bottom seed
                    if (z0 > eps && airHasZ(Air0[cidx], z0)) {
                        seeds.push({ i, j, zA: z0, zB: z0, isTop: false });
                    }

                    // (3) 옆면 노출: 도메인 안의 이웃 Air와 [z0,z1] 교집합
                    const lateral = collectLateralExposedIntervals(i, j, z0, z1, Air0);
                    for (const [a, b] of lateral) {
                        seeds.push({ i, j, zA: a, zB: b, isTop: false });
                    }
                }
            }
            return { seeds, Hmax };
        };


        // --- spherocylinder 팽창의 수직 투영 Fill 생성 (t 고정) ---
        const expandSeedsToFill = (seeds, t, Hmax) => {
            const Fill = new Array(NX * NY);
            for (let c = 0; c < NX * NY; c++) Fill[c] = [];

            const Rx = Math.ceil(t / dx), Ry = Math.ceil(t / dy);

            // 활성 bbox로 XY 범위 일부만 순회 (성능)
            let imin = NX, imax = -1, jmin = NY, jmax = -1;
            for (const s of seeds) {
                if (s.i < imin) imin = s.i; if (s.i > imax) imax = s.i;
                if (s.j < jmin) jmin = s.j; if (s.j > jmax) jmax = s.j;
            }
            if (imin === NX) return Fill; // no seeds
            imin = Math.max(0, imin - Rx); imax = Math.min(NX - 1, imax + Rx);
            jmin = Math.max(0, jmin - Ry); jmax = Math.min(NY - 1, jmax + Ry);

            // 각 seed에 대해 XY 원판 반경 내 컬럼에 인터벌 추가
            for (const { i, j, zA, zB, isTop } of seeds) {
                for (let du = -Rx; du <= Rx; du++) {
                    const ii = i + du; if (ii < imin || ii > imax) continue;
                    const dxu = du * dx, dxu2 = dxu * dxu;
                    for (let dv = -Ry; dv <= Ry; dv++) {
                        const jj = j + dv; if (jj < jmin || jj > jmax) continue;
                        const r2 = dxu2 + (dv * dy) * (dv * dy);
                        if (r2 > t * t + eps) continue; // 원판 밖
                        const add = Math.sqrt(Math.max(0, t * t - r2));
                        const lo = Math.max(0, (isTop ? (zA - add) : (zA - add)));
                        const hi = Math.min(Hmax + t, (isTop ? (zA + add) : (zB + add)));
                        if (hi < lo + eps) continue;
                        Fill[ii * NY + jj].push([lo, hi]);
                    }
                }
            }

            // 정규화
            for (let c = 0; c < NX * NY; c++) {
                if (Fill[c].length) Fill[c] = normalize(Fill[c]);
            }
            return Fill;
        };

        // --- Coat = Fill \ Occ (현재 base 기준 Occ) ---
        const computeCoat = (Fill, Occ) => {
            const Coat = new Array(NX * NY);
            for (let c = 0; c < NX * NY; c++) {
                if (!Fill[c].length) { Coat[c] = []; continue; }
                Coat[c] = diffIntervals(Fill[c], Occ[c]); // air에만 증착
            }
            return Coat;
        };

        // --- Coat 인터벌을 실제 레이어로 병합 삽입 (SoA) ---
        const applyCoatIntervals = (Coat, targMatId) => {
            const NX = this.NX, NY = this.NY, Lmax = this.Lmax;
            const cols = this.cols;
            const eps = 1e-9;

            // quantize 후 경계 역전 방지(희박한 rounding 이슈)
            const qZ = (z) => this._quantizeZ(z);
            const dZ = (q) => this._dequantizeZ(q);

            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const cidx = i * NY + j;
                    const L = cols.len[cidx];
                    const coat = Coat[cidx];
                    if (!coat || coat.length === 0) continue;

                    // 1) 기존 세그먼트(cur) AoS로 추출 (항상 정렬 가정X → 안전하게 정렬)
                    const cur = [];
                    for (let k = 0; k < L; k++) {
                        const base = cidx * Lmax + k;
                        const z0 = dZ(cols.zpair[base * 2]);
                        const z1 = dZ(cols.zpair[base * 2 + 1]);
                        const m = cols.mat[base];
                        if (z1 > z0 + eps) cur.push([z0, z1, m]);
                    }
                    if (cur.length > 1) {
                        cur.sort((A, B) => (A[0] === B[0] ? A[1] - B[1] : A[0] - B[0]));
                    }

                    // 2) 이번 코팅(ins) 세그먼트 구성(모두 targMatId), 정렬
                    const ins = [];
                    for (let t of coat) {
                        const a0 = t[0], a1 = t[1];
                        if (a1 > a0 + eps) ins.push([a0, a1, targMatId]);
                    }
                    if (ins.length === 0) continue;
                    if (ins.length > 1) {
                        ins.sort((A, B) => (A[0] === B[0] ? A[1] - B[1] : A[0] - B[0]));
                    }

                    // 3) cur와 ins를 z0기준 k-way merge (겹침은 없다는 전제: ins ⟂ cur)
                    const merged = [];
                    let p = 0, q = 0;
                    while (p < cur.length && q < ins.length) {
                        const A = cur[p], B = ins[q];
                        if (A[0] < B[0] || (A[0] === B[0] && A[1] <= B[1])) {
                            merged.push(A); p++;
                        } else {
                            merged.push(B); q++;
                        }
                    }
                    while (p < cur.length) merged.push(cur[p++]);
                    while (q < ins.length) merged.push(ins[q++]);

                    // 4) 인접 병합 스캔: 같은 재료가 맞닿으면 병합, 서로 다른 재료는 경계 보존
                    const out = [];
                    for (let u = 0; u < merged.length; u++) {
                        let [z0, z1, m] = merged[u];

                        if (!out.length) { out.push([z0, z1, m]); continue; }

                        let Lz = out.length - 1;
                        let [pz0, pz1, pm] = out[Lz];

                        if (z0 <= pz1 + eps) {
                            // 맞닿거나(=연속) 아주 미세하게 겹치는 경우
                            if (pm === m) {
                                // 같은 재료 → 확장 병합
                                out[Lz][1] = Math.max(pz1, z1);
                            } else {
                                // 다른 재료 → 경계 보존: z0를 pz1로 당겨 겹침 해소
                                const nz0 = Math.max(z0, pz1); // eps 고려
                                if (z1 > nz0 + eps) out.push([nz0, z1, m]);
                                // (만약 수치 오차로 z1<=nz0이면 skip)
                            }
                        } else {
                            // 떨어져 있으면 그대로 추가
                            out.push([z0, z1, m]);
                        }
                    }

                    // 5) SoA에 기록 (필요시 버퍼 확장)
                    if (out.length > Lmax) this.expandBuffers(out.length);
                    cols.len[cidx] = out.length;

                    for (let k = 0; k < out.length; k++) {
                        const base = cidx * Lmax + k;
                        let z0 = out[k][0], z1 = out[k][1], m = out[k][2];

                        // 양자화 역전 방지 스냅(아주 얇은 층에서 발생 가능)
                        let q0 = qZ(z0), q1 = qZ(z1);
                        if (q1 <= q0) {
                            // 최소 1 step 폭 보장
                            q1 = q0 + 1;
                        }

                        cols.mat[base] = m;
                        cols.zpair[base * 2] = q0;
                        cols.zpair[base * 2 + 1] = q1;
                    }

                    // 6) trailing 슬롯 zero-clear (잔상 제거)
                    for (let k = out.length; k < L; k++) {
                        const base = cidx * Lmax + k;
                        const zb = base * 2;
                        cols.mat[base] = 0;
                        cols.zpair[zb] = 0;
                        cols.zpair[zb + 1] = 0;
                    }
                }
            }
        };



        // --- 특정 matId(=CAVITY) 인터벌만 수집 ---
        const collectMatIntervals = (mat) => {
            const out = new Array(NX * NY);
            for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const L = cols.len[cidx];
                if (L === 0) { out[cidx] = []; continue; }
                const acc = [];
                for (let k = 0; k < L; k++) {
                    const base = cidx * this.Lmax + k;
                    if (cols.mat[base] !== mat) continue;
                    const z0 = this._dequantizeZ(cols.zpair[base * 2]);
                    const z1 = this._dequantizeZ(cols.zpair[base * 2 + 1]);
                    acc.push([z0, z1]);
                }
                out[cidx] = normalize(acc);
            }
            return out;
        };

        // --- 스냅샷/복구 (전체 SoA) ---
        const snapshotCols = () => ({
            Lmax: this.Lmax,
            mat: cols.mat.slice(),
            zpair: cols.zpair.slice(),
            len: cols.len.slice(),
        });
        const loadSnapshot = (snap) => {
            if (snap.Lmax !== this.Lmax) this.expandBuffers(snap.Lmax);
            cols.mat.set(snap.mat);
            cols.zpair.set(snap.zpair);
            cols.len.set(snap.len);
        };

        // --- (핵심) 단일 t에 대한 Coat 계산: Seeds → Fill → Coat(=Fill\Occ(base)) ---
        const computeCoatSingleT = (seedsPack, t) => {
            // base 기준 Occ 재계산(neck 폐색 등 반영)
            const Occ = buildOccAll();
            const Fill = expandSeedsToFill(seedsPack.seeds, t, seedsPack.Hmax);
            const Coat = computeCoat(Fill, Occ);
            return Coat;
        };

        // --- cavity diff 추출 후 base에 cavity만 누적 ---
        const mergeNewCavityFromTmp = (snapBefore) => {
            // 현재(cols)는 grid_tmp.identify_cavity() 까지 수행된 상태
            const cavAfter = collectMatIntervals(CAVITY_ID);

            // 이전 스냅샷 상태로 복구해서 '이전 cavity' 추출
            loadSnapshot(snapBefore);
            const cavBefore = collectMatIntervals(CAVITY_ID);

            // new = after \ before
            const newCav = new Array(NX * NY);
            for (let c = 0; c < NX * NY; c++) {
                newCav[c] = diffIntervals(cavAfter[c], cavBefore[c]);
            }

            // base에 cavity만 병합
            applyCoatIntervals(newCav, CAVITY_ID);
        };

        // =========================================================
        // 메인 로직
        // =========================================================

        // 1) Seeds 준비 (캐시 재사용)
        let seedsPack;
        if (isCache && this._aldCache.exposedSegments) {
            seedsPack = { seeds: this._aldCache.exposedSegments, Hmax: this.maxHeight() };
        } else {
            seedsPack = collectALDSeeds();
        }
        // 항상 저장 (isCache와 무관)
        this._aldCache.exposedSegments = seedsPack.seeds;

        // 2) 앵커 스냅샷 불러오기 (선택)
        let tAnchor = 0;
        if (isCache && this._aldCache.gridWithCavity.size > 0) {
            let best = -1;
            for (const t of this._aldCache.gridWithCavity.keys()) {
                if (t <= T + eps && t > best) best = t;
            }
            if (best >= 0) {
                loadSnapshot(this._aldCache.gridWithCavity.get(best));
                tAnchor = best;
            }
        }

        // 3) 증분 루프: cavity만 누적
        for (let t = tAnchor + dt; t < T - eps; t += dt) {
            // Coat(t) 계산 (base 기준)
            const Coat = computeCoatSingleT(seedsPack, t);

            // grid_tmp = base + Coat
            const snapBefore = snapshotCols();
            applyCoatIntervals(Coat, matId);

            // cavity 검출
            this.identify_cavity();

            // new cavity만 base에 누적 (coat는 롤백)
            mergeNewCavityFromTmp(snapBefore);

            // 캐시 저장 (선택)
            this._aldCache.gridWithCavity.set(t, snapshotCols());
        }

        // 4) 최종: Coat(T) 계산 후 실제 증착 반영
        const CoatFinal = computeCoatSingleT(seedsPack, T);
        applyCoatIntervals(CoatFinal, matId);

        // 최종 상태를 캐시에 저장
        this._aldCache.gridWithCavity.set(T, snapshotCols());
    }






}








/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    window.prj.ColumnGrid = ColumnGrid;
});
