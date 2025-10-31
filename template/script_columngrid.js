(function (window) {
    'use strict';
    window.prj = window.prj || {};

    /* ===================== Utilities ===================== */
    const matColors = { 'A': 0x00bfb3, 'B': 0xd45555, 'C': 0xffcc00 };
    const hex = c => '#' + c.toString(16).padStart(6, '0');
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function zero2D(nx, ny) { const a = new Array(nx); for (let i = 0; i < nx; i++) { a[i] = new Float32Array(ny); } return a; }
    function buildGaussianKernel(radius, sigma) {
        if (radius <= 0) return { ofs: [], wsum: 1 };
        const ofs = []; let wsum = 0;
        const s = sigma > 0 ? sigma : Math.max(0.5, radius / 2);
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                if (dx === 0 && dy === 0) continue;
                const r = Math.hypot(dx, dy); if (r > radius + 1e-9) continue;
                const w = Math.exp(-(r * r) / (2 * s * s)); ofs.push([dx, dy, w]); wsum += w;
            }
        }
        return { ofs, wsum: wsum > 0 ? wsum : 1 };
    }

    /* ===================== ColumnGrid ===================== */
    class ColumnGrid {
        constructor(LXnm, LYnm, dx, dy) {
            this.setDomain(LXnm, LYnm, dx, dy);
            this.cols = [];
            this.createNewGrid();
        }

        createNewGrid() {
            this.cols = new Array(this.NX);
            for (let i = 0; i < this.NX; i++) {
                this.cols[i] = new Array(this.NY);
                for (let j = 0; j < this.NY; j++) {
                    this.cols[i][j] = []; // 초기 스택
                }
            }
        }

        setDomain(LXnm, LYNm, dx, dy) {
            this.dx = Number(dx); this.dy = Number(dy);
            this.NX = Math.max(1, Math.round(Number(LXnm) / this.dx));
            this.NY = Math.max(1, Math.round(Number(LYNm) / this.dy));
            this.offsetX = - (this.NX - 1) * this.dx / 2;
            this.offsetY = - (this.NY - 1) * this.dy / 2;
            this.LXeff = this.NX * this.dx;
            this.LYeff = this.NY * this.dy;
        }
        worldX(i) { return this.offsetX + i * this.dx; }
        worldY(j) { return this.offsetY + j * this.dy; }
        indexFromX(xnm) { return clamp(Math.round((xnm - this.offsetX) / this.dx), 0, this.NX - 1); }
        indexFromY(ynm) { return clamp(Math.round((ynm - this.offsetY) / this.dy), 0, this.NY - 1); }

        getColumn(i, j) { return this.cols[i][j] }
        _applyDepositAt(i, j, mat, dz) {
            if (dz <= 0) return;
            const col = this.cols[i][j];
            const topZ = col.length ? col[col.length - 1][2] : 0;

            // top material이 같으면 상단 확장
            if (col.length && col[col.length - 1][0] === mat) {
                col[col.length - 1][2] = topZ + dz;
            } else {
                col.push([mat, topZ, topZ + dz]);
            }
        }

        _applyEtchAt(i, j, mat, dz) {
            if (dz <= 0) return;
            const col = this.cols[i][j];
            if (!col.length) return;

            let remaining = dz;
            while (remaining > 1e-9 && col.length > 0) {
                const top = col[col.length - 1];
                if ((mat !== 'ALL') && (top[0] !== mat)) return;
                const thick = top[2] - top[1];
                if (remaining < thick - 1e-9) {
                    // 부분만 깎음
                    top[2] -= remaining;
                    remaining = 0;
                    break;
                } else {
                    // 전층 제거
                    remaining -= thick;
                    col.pop();
                }
            }

        }


        // ColumnGrid 클래스 내부에 추가
        etch_general(maskFn, mat, thickness, conformality) {
            const t = Math.max(0, Number(thickness) || 0);
            if (t <= 0) return;

            const NX = this.NX, NY = this.NY, dx = this.dx, dy = this.dy;
            const S = clamp(Number(conformality ?? 1.0), 0, 1);
            const latRange = t * S;
            const isAll = (mat === 'ALL');
            const eps = 1e-9;

            // ---------- 빠른 경로: 사실상 수직식각 ----------
            if (latRange < Math.min(dx, dy)) {
                for (let i = 0; i < NX; i++) {
                    for (let j = 0; j < NY; j++) {
                        const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                        if (!maskFn || maskFn(x, y)) {
                            const col = this.cols[i][j];
                            if (!col.length) continue;
                            this._applyEtchAt(i, j, mat, thickness);
                        }
                    }
                }
                return;
            }

            // ---------- 높이맵 H, 대상맵 E, 그리고 floor(연속 상단 식각가능층 하한) ----------
            const H = this._ensureBuf('_bufH', NX * NY);
            const E = this._ensureBuf('_bufE', NX * NY);
            const F = this._ensureBuf('_bufF', NX * NY); // ← 추가: floorZ(per column)

            for (let i = 0; i < NX; i++) {
                const ii = i * NY;
                for (let j = 0; j < NY; j++) {
                    const col = this.cols[i][j];
                    const topZ = col.length ? col[col.length - 1][2] : 0;
                    H[ii + j] = topZ;

                    const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                    const inMask = (!maskFn || maskFn(x, y));

                    let etchTopOK = false;
                    if (col.length) {
                        const topSeg = col[col.length - 1];
                        etchTopOK = isAll || (topSeg[0] === mat);
                    }
                    E[ii + j] = (inMask && etchTopOK) ? 1 : 0;

                    // floor F 계산: 해당 칼럼에서 "윗면부터 연속으로 etch 가능한 구간"의 바닥 z
                    // - ALL: floor=0
                    // - mat: top에서 아래로 mat가 연속되는 동안만 내려감. 중간에 다른 재료가 나오면 그 경계가 floor.
                    if (!col.length) {
                        F[ii + j] = 0; // 아무것도 없으면 바닥
                    } else if (isAll) {
                        F[ii + j] = 0;
                    } else if (etchTopOK) {
                        // top부터 아래로 같은 mat 연속 구간의 바닥 찾기
                        let floorZ = col[col.length - 1][1]; // 일단 top segment의 바닥
                        for (let s = col.length - 2; s >= 0; s--) {
                            if (col[s][0] !== mat) break;
                            floorZ = col[s][1];
                        }
                        F[ii + j] = Math.max(0, floorZ);
                    } else {
                        // top이 대상이 아니면 이번 라운드에 식각 대상 아님 → floor는 의미 없지만 0으로 둠
                        F[ii + j] = 0;
                    }
                }
            }

            // ---------- 커널/패딩 ----------
            const { Rx, rows } = this._getConformalKernelArray(t, S, dx, dy);
            const { pad: HPad, W: PW, Hh: PH } = this._buildPaddedH(H, NX, NY, Rx, Rx);

            // 대상맵 패딩 (비대상 0)
            const EPadLen = (NX + 2 * Rx) * (NY + 2 * Rx);
            const EPad = this._ensureBuf('_bufEPad', EPadLen);
            EPad.fill(0);
            for (let i = 0; i < NX; i++) {
                const srcBase = i * NY;
                const dstBase = (i + Rx) * PH + Rx;
                for (let j = 0; j < NY; j++) EPad[dstBase + j] = E[srcBase + j];
            }

            // ---------- 활성 BBox ----------
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

            // ---------- 침식 표면 계산 (√ 라운딩 + floor/바닥 클램프) ----------
            const Hp = this._ensureBuf('_bufHp', NX * NY);

            // 기본: 대상칸이면 H - t, 비대상은 H
            for (let i = 0; i < NX; i++) {
                const ii = i * NY;
                for (let j = 0; j < NY; j++) {
                    Hp[ii + j] = (E[ii + j] === 1) ? (H[ii + j] - t) : H[ii + j];
                }
            }

            // 이웃 고려 (대상칸만 업데이트; 이웃도 대상칸만 측면 기여 허용)
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
                            if (EPad[center + dv] !== 1) continue; // 이웃 칼럼도 대상이어야 측면 식각 인정
                            const cand = HPad[center + dv] - add;
                            if (cand < m) m = cand;
                        }
                    }

                    // ★ 핵심: 침식 결과를 바닥으로 클램프 (z>=0, 그리고 해당 칼럼의 etchable 연속층 하한)
                    const floorZ = F[ii + j];           // 연속 상단 etchable층의 바닥
                    Hp[ii + j] = Math.max(0, Math.max(floorZ, m));
                }
            }

            // ---------- Δz 적용 (명시형 구조 기반) ----------
            for (let i = iMin; i <= iMax; i++) {
                const ii = i * NY;
                for (let j = jMin; j <= jMax; j++) {
                    if (E[ii + j] !== 1) continue;
                    const newTop = Hp[ii + j];
                    const oldTop = H[ii + j];
                    const dz = oldTop - newTop;
                    if (dz <= eps) continue;

                    const col = this.cols[i][j];
                    if (!col.length) continue;

                    // 대상 물질만 위에서부터 제거 (floor 클램프 덕분에 과도식각/역전 방지)
                    let remaining = dz;
                    while (remaining > eps && col.length > 0) {
                        const top = col[col.length - 1];
                        if (!isAll && top[0] !== mat) break;

                        const thick = top[2] - top[1];
                        if (remaining < thick - eps) { top[2] -= remaining; remaining = 0; }
                        else { remaining -= thick; col.pop(); }
                    }
                }
            }
        }




        // ColumnGrid 내부 메서드로 추가
        // === ColumnGrid 내부 메서드 ===
        // Wet etch (voxel-free, surface-based isotropic, iterative)
        // ColumnGrid 메서드로 추가
        etch_wet(maskFn, mat, thickness, opts = {}) {
            const tTot = Math.max(0, Number(thickness) || 0);
            if (tTot <= 0) return;

            const NX = this.NX, NY = this.NY, dx = this.dx, dy = this.dy;
            const Lmin = Math.min(dx, dy);
            const dt = Math.max(1e-9, Number(opts.dt) || Lmin);      // 한 step 두께(수직 기준)
            const isAll = (mat === 'ALL');
            const eps = 1e-9;

            // --- 내부 버퍼 (재사용) ---
            const H = (this._ensureBuf ? this._ensureBuf('_wetH', NX * NY) : new Float32Array(NX * NY));
            const Hm = (this._ensureBuf ? this._ensureBuf('_wetHm', NX * NY) : new Float32Array(NX * NY)); // 이웃(min) 높이
            const E = (this._ensureBuf ? this._ensureBuf('_wetE', NX * NY) : new Uint8Array(NX * NY));   // 마스크 on/off

            // --- 캐시 준비: thk → 스냅샷 ---
            //  - 외부에서 opts.isCache=true일 때만 활용
            //  - 이 함수는 "현재 geometry가 캐시 기준과 일치"한다고 신뢰 (사용자가 보장)
            this._wetetchCache = this._wetetchCache || new Map(); // key: thkQ (정규 step 누적), val: snapshot(cols)
            const useCache = !!opts.isCache;

            // 정규 step 개수/잔여
            const nFull = Math.floor(tTot / dt);
            const remThk = tTot - nFull * dt;

            // -------------------------------
            // 0) 캐시에서 재시작점 로드 (가장 가까운 ≤ tTot 정규 step 키)
            // -------------------------------
            if (useCache && this._wetetchCache.size) {
                let bestKey = -Infinity;
                for (const k of this._wetetchCache.keys()) {
                    if (k <= nFull * dt && k > bestKey) bestKey = k;
                }
                if (Number.isFinite(bestKey) && bestKey >= 0) {
                    const snap = this._wetetchCache.get(bestKey);
                    if (snap) _restoreSnapshot.call(this, snap);
                }
            }

            // -------------------------------
            // 헬퍼: 현재 top height(H), 마스크(E) 생성
            // -------------------------------
            const _buildH = () => {
                for (let i = 0; i < NX; i++) {
                    const ii = i * NY;
                    for (let j = 0; j < NY; j++) {
                        const col = this.cols[i][j];
                        H[ii + j] = col.length ? col[col.length - 1][2] : 0;
                        if (maskFn) {
                            const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                            E[ii + j] = maskFn(x, y) ? 1 : 0;
                        } else {
                            E[ii + j] = 1;
                        }
                    }
                }
            };

            // 헬퍼: Hm = 4이웃의 top 높이 중 "최솟값"
            //  - 어떤 높이 z에서라도 한 방향 이웃이 z보다 낮으면 그 z에서 옆면 노출
            const _buildHm = () => {
                for (let i = 0; i < NX; i++) {
                    const ii = i * NY;
                    for (let j = 0; j < NY; j++) {
                        let m = Infinity;
                        // 경계 밖은 공기 → 높이 0
                        const up = (j + 1 < NY) ? H[ii + (j + 1)] : 0;
                        const down = (j - 1 >= 0) ? H[ii + (j - 1)] : 0;
                        const left = (i - 1 >= 0) ? H[(i - 1) * NY + j] : 0;
                        const right = (i + 1 < NX) ? H[(i + 1) * NY + j] : 0;
                        // side 노출은 "한 방향이라도 낮으면" 발생 → 모든 이웃 높이 중 최솟값이 경계선
                        m = Math.min(up, down, left, right);
                        Hm[ii + j] = m;
                    }
                }
            };

            // 헬퍼: 상단 연속 etchable 층의 "바닥 z" (floorZ)
            //  - ALL: 0
            //  - 특정 mat: top에서 아래로 같은 mat가 연속되는 구간의 하한
            const _floorZ = (col) => {
                if (!col.length) return 0;
                if (isAll) return 0;
                const top = col[col.length - 1];
                if (top[0] !== mat) return top[2]; // 이번 step에서 etch 불가(연속 없음)
                let floor = top[1];
                for (let s = col.length - 2; s >= 0; s--) {
                    if (col[s][0] !== mat) break;
                    floor = col[s][1];
                }
                return Math.max(0, floor);
            };

            // 헬퍼: 아주 얇은 세그 제거 + 인접 동일물질 merge
            const _compact = (col) => {
                if (col.length === 0) return col;
                const out = [];
                for (let s = 0; s < col.length; s++) {
                    const seg = col[s];
                    if (seg[2] <= seg[1] + 1e-9) continue;
                    if (out.length && out[out.length - 1][0] === seg[0] && Math.abs(out[out.length - 1][2] - seg[1]) < 1e-9) {
                        out[out.length - 1][2] = seg[2];
                    } else {
                        out.push([seg[0], seg[1], seg[2]]);
                    }
                }
                return out;
            };

            // -------------------------------
            // 1) 정규 step 반복 (nFull회)
            //    각 step: (a) H/Hm 구성 → (b) 측면 nibble → (c) 수직 식각 → (d) 조기종료 검사
            // -------------------------------
            let anyChangeGlobal = false;
            for (let step = 0; step < nFull; step++) {
                _buildH();
                _buildHm();

                let changed = false;

                // (a) 측면 nibble: top 세그먼트가 대상(또는 ALL)이고, topZ > Hm이면 topZ를 Hm으로 clamp
                for (let i = 0; i < NX; i++) {
                    const ii = i * NY;
                    for (let j = 0; j < NY; j++) {
                        if (E[ii + j] !== 1) continue;
                        const col = this.cols[i][j];
                        if (!col.length) continue;

                        // top이 대상이 아니면 옆면으로 해당 물질 노출 안 됨(상층이 가림)
                        let top = col[col.length - 1];
                        if (!(isAll || top[0] === mat)) continue;

                        const cutZ = Math.max(0, Hm[ii + j]); // 이 높이보다 위는 최소 한 방향에서 공기 접촉
                        if (top[2] > cutZ + eps) {
                            // top을 Hm으로 잘라내기
                            if (cutZ <= top[1] + eps) {
                                // segment 전체가 잘려나감
                                col.pop();
                            } else {
                                top[2] = cutZ;
                            }
                            changed = true;
                        }
                    }
                }

                // (b) 수직 식각 dt: top 연속 etchable 구간 바닥으로 클램프
                for (let i = 0; i < NX; i++) {
                    for (let j = 0; j < NY; j++) {
                        const ii = i * NY + j;
                        if (E[ii] !== 1) continue;
                        const col = this.cols[i][j];
                        if (!col.length) continue;

                        const top = col[col.length - 1];
                        if (!(isAll || top[0] === mat)) continue;

                        const floor = _floorZ(col);
                        const oldTopZ = top[2];
                        const newTopZ = Math.max(0, Math.max(floor, oldTopZ - dt));
                        if (newTopZ < oldTopZ - eps) {
                            if (newTopZ <= top[1] + eps) col.pop();
                            else top[2] = newTopZ;
                            changed = true;
                        }
                    }
                }

                // (c) 컴팩트
                if (changed) {
                    for (let i = 0; i < NX; i++) {
                        for (let j = 0; j < NY; j++) {
                            const col = this.cols[i][j];
                            if (col.length) this.cols[i][j] = _compact(col);
                        }
                    }
                }

                anyChangeGlobal = anyChangeGlobal || changed;
                // (d) 조기종료: 더 이상 변화 없으면 이후 step에도 변화 없음
                if (!changed) break;
            }

            // -------------------------------
            // 2) 정규 step 종료 시점 캐시 저장 (잔여 step은 저장 X)
            // -------------------------------
            if (useCache && nFull > 0) {
                const thkKey = nFull * dt; // 정규 step 누적 두께
                this._wetetchCache.set(thkKey, _makeSnapshot.call(this));
            }

            // -------------------------------
            // 3) 잔여 step 처리
            //     - 수직: remThk 만큼
            //     - 측면: remThk가 Lmin/2 이상이면 1회 nibble(반올림)
            // -------------------------------
            if (remThk > eps) {
                // 수직 먼저
                for (let i = 0; i < NX; i++) {
                    for (let j = 0; j < NY; j++) {
                        const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                        if (maskFn && !maskFn(x, y)) continue;

                        const col = this.cols[i][j];
                        if (!col.length) continue;

                        const top = col[col.length - 1];
                        if (!(isAll || top[0] === mat)) continue;

                        const floor = _floorZ(col);
                        const oldTopZ = top[2];
                        const newTopZ = Math.max(0, Math.max(floor, oldTopZ - remThk));
                        if (newTopZ < oldTopZ - eps) {
                            if (newTopZ <= top[1] + eps) col.pop();
                            else top[2] = newTopZ;
                        }
                    }
                }

                // 측면(반올림): remThk >= Lmin/2 이면 1회 nibble
                if (remThk >= 0.5 * Lmin) {
                    _buildH();
                    _buildHm();
                    for (let i = 0; i < NX; i++) {
                        const ii = i * NY;
                        for (let j = 0; j < NY; j++) {
                            if (E[ii + j] !== 1) continue;
                            const col = this.cols[i][j];
                            if (!col.length) continue;
                            const top = col[col.length - 1];
                            if (!(isAll || top[0] === mat)) continue;

                            const cutZ = Math.max(0, Hm[ii + j]);
                            if (top[2] > cutZ + eps) {
                                if (cutZ <= top[1] + eps) col.pop();
                                else top[2] = cutZ;
                            }
                        }
                    }
                    // 컴팩트
                    for (let i = 0; i < NX; i++) {
                        for (let j = 0; j < NY; j++) {
                            const col = this.cols[i][j];
                            if (col.length) this.cols[i][j] = _compact(col);
                        }
                    }
                }
            }

            // -------------------------------
            // 4) 최종 조기종료 보정: 남은 etch 대상이 더는 없으면 캐시 무관
            // -------------------------------
            // (옵션) 빠른 스킵: 상단이 대상인 칼럼이 하나라도 남아있는지 확인
            // 필요 시 이 블록에서 플래그를 돌려 이후 호출에서 사용자 로직이 참조 가능

            // ===== 내부 스냅샷 유틸 (함수 내에 정의) =====
            function _makeSnapshot() {
                const snap = new Array(NX);
                for (let i = 0; i < NX; i++) {
                    snap[i] = new Array(NY);
                    for (let j = 0; j < NY; j++) {
                        const col = this.cols[i][j];
                        if (!col.length) { snap[i][j] = []; continue; }
                        const tmp = new Array(col.length);
                        for (let s = 0; s < col.length; s++) {
                            const seg = col[s];
                            tmp[s] = [seg[0], seg[1], seg[2]]; // 깊은복사
                        }
                        snap[i][j] = tmp;
                    }
                }
                return snap;
            }
            function _restoreSnapshot(snap) {
                for (let i = 0; i < NX; i++) {
                    for (let j = 0; j < NY; j++) {
                        const src = snap[i][j];
                        if (!src || src.length === 0) { this.cols[i][j] = []; continue; }
                        const dst = new Array(src.length);
                        for (let s = 0; s < src.length; s++) {
                            const seg = src[s];
                            dst[s] = [seg[0], seg[1], seg[2]];
                        }
                        this.cols[i][j] = dst;
                    }
                }
            }
        }




        // ColumnGrid 클래스 내부에 추가
        strip_connected(mat) {
            const NX = this.NX, NY = this.NY;
            const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            const eps = 1e-9;

            // --- visited & mark arrays ---
            const visited = new Array(NX);
            const mark = new Array(NX);
            for (let i = 0; i < NX; i++) {
                visited[i] = new Array(NY);
                mark[i] = new Array(NY);
                for (let j = 0; j < NY; j++) {
                    const L = this.cols[i][j].length;
                    visited[i][j] = new Uint8Array(L);
                    mark[i][j] = new Uint8Array(L);
                }
            }

            const q = [];

            // --- helper: overlap check ---
            const overlap = (a0, a1, b0, b1) => (a0 < b1 - eps) && (b0 < a1 - eps);

            // --- helper: check side exposure (lateral, top, bottom) ---
            const isExposed = (i, j, z0, z1) => {
                // ① 바닥 접촉 (아래 경계)
                if (z0 <= eps) return true;

                // ② 위쪽 노출 (최상단)
                const col = this.cols[i][j];
                if (col.length && Math.abs(z1 - col[col.length - 1][2]) < eps) return true;

                // ③ 옆면 노출
                for (const [di, dj] of dirs) {
                    const ni = i + di, nj = j + dj;
                    if (ni < 0 || ni >= NX || nj < 0 || nj >= NY) return true; // 경계 = 외기
                    const ncol = this.cols[ni][nj];
                    if (!ncol.length) return true; // 옆이 비어 있음
                    const nTop = ncol[ncol.length - 1][2];
                    if (nTop < z1 - eps) return true; // 옆의 높이가 더 낮음 → 공기 접촉
                }
                return false;
            };

            // --- ① seed 탐색 ---
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const arr = this.cols[i][j];
                    for (let k = 0; k < arr.length; k++) {
                        const [m, z0, z1] = arr[k];
                        if (m !== mat) continue;
                        if (isExposed(i, j, z0, z1)) {
                            q.push([i, j, k]);
                            visited[i][j][k] = 1;
                            mark[i][j][k] = 1;
                        }
                    }
                }
            }

            // --- ② flood-fill (BFS) ---
            while (q.length) {
                const [i, j, k] = q.pop();
                const seg = this.cols[i][j][k];
                if (!seg) continue;
                const [m, z0, z1] = seg;

                for (const [di, dj] of dirs) {
                    const ni = i + di, nj = j + dj;
                    if (ni < 0 || ni >= NX || nj < 0 || nj >= NY) continue;

                    const ncol = this.cols[ni][nj];
                    for (let kk = 0; kk < ncol.length; kk++) {
                        if (visited[ni][nj][kk]) continue;
                        const [m2, z0b, z1b] = ncol[kk];
                        if (m2 !== mat) continue;
                        if (!overlap(z0, z1, z0b, z1b)) continue;

                        visited[ni][nj][kk] = 1;
                        mark[ni][nj][kk] = 1;
                        q.push([ni, nj, kk]);
                    }
                }
            }

            // --- ③ 제거 적용 ---
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const arr = this.cols[i][j];
                    if (!arr.length) continue;
                    const kept = [];
                    for (let k = 0; k < arr.length; k++) {
                        if (mark[i][j][k]) continue; // 제거된 segment skip
                        kept.push(arr[k]);
                    }
                    this.cols[i][j] = kept;
                }
            }
        }

        identify_cavity() {
            const NX = this.NX, NY = this.NY;
            const eps = 1e-9;

            // ① gap(틈)을 cavity 후보로 채움
            for (let i = 0; i < NX; i++) {
                for (let j = 0; j < NY; j++) {
                    const col = this.cols[i][j];
                    if (!col.length) continue;

                    const newCol = [];
                    let lastZ = 0;

                    for (const [m, z0, z1] of col) {
                        // 이전 레이어와 현재 레이어 사이에 gap이 있으면 cavity 삽입
                        if (z0 > lastZ + eps) {
                            newCol.push(['cavity', lastZ, z0]);
                        }
                        newCol.push([m, z0, z1]);
                        lastZ = z1;
                    }

                    // 최상단 위로도 빈공간(cavity) 확장 (선택사항)
                    const top = col[col.length - 1][2];
                    const Hmax = this.maxHeight();
                    if (Hmax > top + eps) {
                        newCol.push(['cavity', top, Hmax]);
                    }

                    this.cols[i][j] = newCol;
                }
            }

            // ② 외기와 연결된 cavity 제거
            this.strip_connected('cavity');

            // ③ cavity가 아닌 material layer들은 그대로 유지, cavity 남은 것만 진짜 cavity
            // 이 단계에서 cavity는 외부와 완전히 단절된 내부 cavity
            // 필요 시 cavity layer를 mark하거나 통계 계산 가능.
        }


























        // ===== 내부 유틸: 버퍼 확보/재사용 =====
        _ensureBuf(name, length, kind = 'u8') {
            const C = kind === 'f32' ? Float32Array : Uint8Array;
            if (!this[name] || this[name].length < length) this[name] = new C(length);
            return this[name];
        }

        // ===== 커널 캐시: 배열 기반 (Map 제거) + LRU 제한(옵션) =====
        _getConformalKernelArray(t, S, dx, dy) {
            this._confKernelCacheArr = this._confKernelCacheArr || new Map();
            const key = `${(t * 1000 | 0)}|${(S * 1000 | 0)}|${(dx * 1000 | 0)}|${(dy * 1000 | 0)}`;
            const hit = this._confKernelCacheArr.get(key);
            if (hit) return hit;

            const Rx = Math.ceil(t / dx), Ry = Math.ceil(t / dy);
            const t2 = t * t, Sinv = 1 / Math.max(S, 1e-6);
            const rows = new Array(Rx * 2 + 1); // rows[du+Rx] = Float32Array[dv0, add0, dv1, add1, ...]
            const dx2 = dx * dx, dy2 = dy * dy;

            for (let du = -Rx; du <= Rx; du++) {
                const row = [];
                const du2dx2 = du * du * dx2;
                for (let dv = -Ry; dv <= Ry; dv++) {
                    // r_lat = sqrt(du^2*dx^2 + dv^2*dy^2) * Sinv
                    const r2 = du2dx2 + dv * dv * dy2;
                    const r_lat = Math.sqrt(r2) * Sinv;
                    if (r_lat <= t + 1e-9) {
                        const add = Math.sqrt(Math.max(0, t2 - r_lat * r_lat));
                        row.push(dv | 0, add);
                    }
                }
                rows[du + Rx] = row.length ? Float32Array.from(row) : new Float32Array(0);
            }

            const kernel = { Rx, Ry, rows, baseAdd: t };
            // LRU 제한을 원하면 최근 32개만 유지
            this._confKernelCacheArr.set(key, kernel);
            if (this._confKernelCacheArr.size > 32) {
                const firstKey = this._confKernelCacheArr.keys().next().value;
                this._confKernelCacheArr.delete(firstKey);
            }
            return kernel;
        }

        // ===== 패딩된 높이맵 만들기 (경계 체크 제거) =====
        _buildPaddedH(H, NX, NY, Rx, Ry) {
            const W = NX + 2 * Rx, Hh = NY + 2 * Ry; // padded width/height
            const pad = this._ensureBuf('_bufPad', W * Hh);

            // 중앙 복사
            for (let i = 0; i < NX; i++) {
                const srcBase = i * NY;
                const dstBase = (i + Rx) * Hh + Ry;
                pad.set(H.subarray(srcBase, srcBase + NY), dstBase);
            }

            // 위/아래 패드: 가장자리 값을 복제(클램프 패드)
            for (let i = Rx; i < Rx + NX; i++) {
                // 위쪽 Ry칸을 첫행값으로 채움
                const base = i * Hh;
                const first = pad[base + Ry];
                for (let j = 0; j < Ry; j++) pad[base + j] = first;
                // 아래쪽 Ry칸을 마지막행값으로 채움
                const last = pad[base + Ry + NY - 1];
                for (let j = Ry + NY; j < Ry + NY + Ry; j++) pad[base + j] = last;
            }

            // 좌/우 패드
            for (let j = 0; j < Hh; j++) {
                const leftVal = pad[Rx * Hh + j];
                const rightVal = pad[(Rx + NX - 1) * Hh + j];
                for (let i = 0; i < Rx; i++) pad[i * Hh + j] = leftVal;                   // 왼쪽
                for (let i = Rx + NX; i < Rx + NX + Rx; i++) pad[i * Hh + j] = rightVal;        // 오른쪽
            }

            return { pad, W, Hh };
        }

        // ===== 최적화된 정확 컨포멀 증착 =====
        deposit_general(maskFn, mat, thickness, conformality) {
            const t = Math.max(0, Number(thickness) || 0);
            if (t <= 0) return;

            const NX = this.NX, NY = this.NY, dx = this.dx, dy = this.dy;
            const S = clamp(Number(conformality ?? 1.0), 0, 1);
            const latRange = t * S;

            // ---- 빠른 경로: 사실상 수직 ---
            if (latRange < Math.min(dx, dy)) {
                for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
                    const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                    if (maskFn && !maskFn(x, y)) continue;
                    this._applyDepositAt(i, j, mat, t);
                }
                return;
            }

            // ---- 높이맵 H 준비 (재사용 버퍼) ---
            const H = this._ensureBuf('_bufH', NX * NY);
            for (let i = 0; i < NX; i++) {
                const ii = i * NY;
                for (let j = 0; j < NY; j++) {
                    const col = this.cols[i][j];
                    H[ii + j] = col.length ? col[col.length - 1][2] : 0; // topZ
                }
            }

            // ---- 커널 / 패딩 ----
            const { Rx, rows, baseAdd } = this._getConformalKernelArray(t, S, dx, dy);
            const { pad: HPad, W: PW, Hh: PH } = this._buildPaddedH(H, NX, NY, Rx, Rx); // Ry≈Rx로 패딩(간단화)

            // ---- 활성 bbox 계산 (mask sparse 최적화) ----
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

            // ---- 팽창 표면 계산 (경계체크 제거된 버전) ----
            const Hp = this._ensureBuf('_bufHp', NX * NY);
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
                const ii = i * NY;
                const ip = i + Rx;
                for (let j = jMin; j <= jMax; j++) {
                    const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
                    if (maskFn && !maskFn(x, y)) continue;

                    let m = Hp[ii + j]; // H + t 기본 기여
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

            // ---- Δz 적용 (명시형 구조용) ----
            for (let i = iMin; i <= iMax; i++) {
                const ii = i * NY;
                for (let j = jMin; j <= jMax; j++) {
                    const newTop = Hp[ii + j];
                    const oldTop = H[ii + j];
                    const dz = newTop - oldTop;
                    if (dz <= 1e-9) continue;

                    // --- 완전 명시형 반영 ---
                    const col = this.cols[i][j];
                    if (!col.length) {
                        col.push([mat, 0, newTop]);
                        continue;
                    }

                    const top = col[col.length - 1];
                    const topZ = top[2];

                    // ① air가 위에 있다면 덮기
                    if (top[0] === 'air') {
                        // air layer 부분 덮기
                        if (topZ < newTop - 1e-9) {
                            // air 위에 deposit mat layer 추가
                            col.push([mat, topZ, newTop]);
                        }
                    }
                    // ② 같은 재료면 연장
                    else if (top[0] === mat) {
                        top[2] = newTop;
                    }
                    // ③ 다른 재료면 위에 새 layer 추가
                    else {
                        col.push([mat, topZ, newTop]);
                    }
                }
            }
        }




        // ===== 공용 버퍼 헬퍼 (재사용) =====
        _ensureBuf(name, length, kind = 'u8') {
            const ctor = kind === 'f32' ? Float32Array : Uint8Array;
            if (!this[name] || this[name].length < length) this[name] = new ctor(length);
            return this[name];
        }

        // ===== SE(구형 구조요소) 캐시 =====
        _getALDStructElem(t, dx, dy, dz) {
            this._aldSECache = this._aldSECache || new Map();
            const key = `${(t * 1000 | 0)}|${(dx * 1000 | 0)}|${(dy * 1000 | 0)}|${(dz * 1000 | 0)}`;
            const hit = this._aldSECache.get(key);
            if (hit) return hit;

            const Rx = Math.ceil(t / dx), Ry = Math.ceil(t / dy), Rz = Math.ceil(t / dz);
            const t2 = t * t;
            const se = [];
            for (let du = -Rx; du <= Rx; du++) {
                const x2 = (du * dx) * (du * dx);
                for (let dv = -Ry; dv <= Ry; dv++) {
                    const xy2 = x2 + (dv * dy) * (dv * dy);
                    for (let dw = -Rz; dw <= Rz; dw++) {
                        const r2 = xy2 + (dw * dz) * (dw * dz);
                        if (r2 <= t2 + 1e-9) se.push([du, dv, dw]);
                    }
                }
            }
            const out = { se, Rx, Ry, Rz };
            this._aldSECache.set(key, out);
            if (this._aldSECache.size > 32) this._aldSECache.delete(this._aldSECache.keys().next().value);
            return out;
        }

        // ===== 활성 XY BBox 계산 (마스크/실제 스택 기반) =====
        _getActiveXYBBox(maskFn, margin) {
            const NX = this.NX, NY = this.NY, dx = this.dx, dy = this.dy;
            let imin = NX, imax = -1, jmin = NY, jmax = -1, found = false;

            for (let i = 0; i < NX; i++) {
                const ii = i * NY;
                for (let j = 0; j < NY; j++) {
                    const hasStack = this.cols[i][j].length > 0;
                    const inMask = !maskFn || maskFn((i + 0.5) * dx, (j + 0.5) * dy);
                    if ((hasStack || inMask)) {
                        found = true;
                        if (i < imin) imin = i; if (i > imax) imax = i;
                        if (j < jmin) jmin = j; if (j > jmax) jmax = j;
                    }
                }
            }
            if (!found) return null;
            imin = Math.max(0, imin - margin);
            imax = Math.min(NX - 1, imax + margin);
            jmin = Math.max(0, jmin - margin);
            jmax = Math.min(NY - 1, jmax + margin);
            return { imin, imax, jmin, jmax };
        }
        
        // ==== 고속 ALD : 캐시 + pow2 큐 + SE 양자화 ====
        deposit_ALD(maskFn, mat, thickness, opts = {}) {

            function _nextPow2(n) { return 1 << (32 - Math.clz32(Math.max(2, n - 1))); }
            const OFFS4_2D = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1]);
            const OFFS8_2D = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]);
            const OFFS6_3D = new Int8Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
            const t = Math.max(0, Number(thickness) || 0); if (t <= 0) return;

            const NX = this.NX, NY = this.NY, dx = this.dx, dy = this.dy, eps = 1e-9;
            const useCache = !!opts.isCache;
            const use8 = !!opts.use8;            // XY 8-연결(플러드필)
            const frontier26 = !!opts.frontier26;    // 프런티어 26-연결
            const dz = Math.max(1e-6, Number(opts.dz) || Math.min(dx, dy, Math.max(t / 3, 1e-6)));
            const seQuant = (opts.seQuant != null) ? Number(opts.seQuant) : dz;  // 커널 양자화 그리드
            const bridgeTol = (opts.bridgeTol != null) ? Number(opts.bridgeTol) : (0.6 * dz);
            const mergeEps = (opts.mergeEps != null) ? Number(opts.mergeEps) : (0.6 * dz);

            // 1) 활성 bbox (동일)
            const margin = Math.max(1, Math.ceil(t / Math.min(dx, dy)));
            const bbox = this._getActiveXYBBox(maskFn, margin);
            if (!bbox) return;
            const { imin, imax, jmin, jmax } = bbox;
            const BX = imax - imin + 1, BY = jmax - jmin + 1;

            // 2) Z 범위 (동일)
            let zTopMax = 0;
            for (let i = imin; i <= imax; i++) {
                for (let j = jmin; j <= jmax; j++) {
                    const col = this.cols[i][j];
                    if (col.length) zTopMax = Math.max(zTopMax, col[col.length - 1][2]);
                }
            }
            const ZMAX = zTopMax + t + 1e-6;
            const NZ = Math.max(1, Math.ceil(ZMAX / dz));
            const strideY = NZ, strideX = BY * NZ, voxCount = BX * BY * NZ;

            // 3) 캐시 슬롯
            this._aldCache = this._aldCache || {};
            const slot = this._aldCache || (this._aldCache = {});
            slot.meta = { BX, BY, NZ, dz, imin, imax, jmin, jmax, strideX, strideY, voxCount }; // 메타 동기화

            // 4) solidOld (Zero-copy 재사용; 비캐시 시 계산)
            let solidOld;
            if (useCache && slot.solidOld && slot.solidOld.length === voxCount) {
                solidOld = slot.solidOld;                  // ✅ zero-copy 참조
            } else {
                solidOld = new Uint8Array(voxCount);
                for (let i = imin; i <= imax; i++) {
                    const ii = i - imin;
                    for (let j = jmin; j <= jmax; j++) {
                        const jj = j - jmin, col = this.cols[i][j];
                        const base = ii * strideX + jj * strideY;
                        for (let s = 0; s < col.length; s++) {
                            const [m, z0, z1] = col[s];
                            if (z1 <= z0 + eps) continue;
                            let k0 = (z0 + eps) / dz | 0; if (k0 < 0) k0 = 0;
                            let k1 = Math.ceil((z1 - eps) / dz); if (k1 > NZ) k1 = NZ;
                            for (let k = k0; k < k1; k++) solidOld[base + k] = 1;
                        }
                    }
                }
                if (useCache) slot.solidOld = solidOld;    // ✅ 참조 저장(복사 금지)
            }

            // 5) 접근 공기 airVis (Zero-copy 재사용; 비캐시 시 BFS)
            let airVis;
            if (useCache && slot.airVis && slot.airVis.length === voxCount) {
                airVis = slot.airVis;                      // ✅ zero-copy 참조
            } else {
                airVis = new Uint8Array(voxCount);

                // --- pow2 링버퍼(Int32) ---
                const Qcap = _nextPow2(voxCount + 8), qMask = Qcap - 1;
                const qi = (useCache && slot.qi && slot.qi.length === Qcap) ? slot.qi : new Int32Array(Qcap);
                const qj = (useCache && slot.qj && slot.qj.length === Qcap) ? slot.qj : new Int32Array(Qcap);
                const qk = (useCache && slot.qk && slot.qk.length === Qcap) ? slot.qk : new Int32Array(Qcap);
                if (useCache) { slot.qi = qi; slot.qj = qj; slot.qk = qk; }

                let head = 0, tail = 0;
                const pushQ = (ii, jj, kk) => {
                    const id = ii * strideX + jj * strideY + kk;
                    if (id < 0 || id >= voxCount) return;
                    if (airVis[id] || solidOld[id]) return;
                    airVis[id] = 1; qi[tail] = ii; qj[tail] = jj; qk[tail] = kk; tail = (tail + 1) & qMask;
                };
                const popQ = () => { const ii = qi[head], jj = qj[head], kk = qk[head]; head = (head + 1) & qMask; return [ii, jj, kk]; };
                const qNotEmpty = () => head !== tail;

                // 상부 seed: 각 (ii,jj) 첫 공기
                for (let ii = 0; ii < BX; ii++) {
                    for (let jj = 0; jj < BY; jj++) {
                        const base = ii * strideX + jj * strideY;
                        let kStart = 0; for (let k = NZ - 1; k >= 0; k--) { if (solidOld[base + k]) { kStart = k + 1; break; } }
                        if (kStart < NZ) pushQ(ii, jj, kStart);
                    }
                }
                // 측면 seed
                for (let jj = 0; jj < BY; jj++) for (let k = 0; k < NZ; k++) { pushQ(0, jj, k); pushQ(BX - 1, jj, k); }
                for (let ii = 0; ii < BX; ii++) for (let k = 0; k < NZ; k++) { pushQ(ii, 0, k); pushQ(ii, BY - 1, k); }

                const OFF = use8 ? OFFS8_2D : OFFS4_2D; // XY 이웃
                while (qNotEmpty()) {
                    const [ii, jj, kk] = popQ();
                    // XY
                    for (let u = 0; u < OFF.length; u += 2) {
                        const ni = ii + OFF[u], nj = jj + OFF[u + 1], nk = kk;
                        if (ni < 0 || ni >= BX || nj < 0 || nj >= BY || nk < 0 || nk >= NZ) continue;
                        const id2 = ni * strideX + nj * strideY + nk;
                        if (!solidOld[id2] && !airVis[id2]) { airVis[id2] = 1; qi[tail] = ni; qj[tail] = nj; qk[tail] = nk; tail = (tail + 1) & qMask; }
                    }
                    // Z
                    if (kk + 1 < NZ) {
                        const ni = ii, nj = jj, nk = kk + 1, id2 = ni * strideX + nj * strideY + nk;
                        if (!solidOld[id2] && !airVis[id2]) { airVis[id2] = 1; qi[tail] = ni; qj[tail] = nj; qk[tail] = nk; tail = (tail + 1) & qMask; }
                    }
                    if (kk - 1 >= 0) {
                        const ni = ii, nj = jj, nk = kk - 1, id2 = ni * strideX + nj * strideY + nk;
                        if (!solidOld[id2] && !airVis[id2]) { airVis[id2] = 1; qi[tail] = ni; qj[tail] = nj; qk[tail] = nk; tail = (tail + 1) & qMask; }
                    }
                }
                if (useCache) slot.airVis = airVis;        // ✅ 참조 저장
            }

            // 6) 프런티어 (Zero-copy 재사용; 비캐시 시 추출)
            let frontierMask, fi, fj, fk, fsz = 0;
            if (useCache && slot.frontierMask && slot.frontierMask.length === voxCount && slot.fi && slot.fj && slot.fk && Number.isFinite(slot.fsz)) {
                frontierMask = slot.frontierMask; fi = slot.fi; fj = slot.fj; fk = slot.fk; fsz = slot.fsz | 0;   // ✅ zero-copy
            } else {
                frontierMask = new Uint8Array(voxCount);
                const Fcap = voxCount;  // 상한
                fi = new Int32Array(Fcap); fj = new Int32Array(Fcap); fk = new Int32Array(Fcap);

                // 표면 이웃 집합
                const nSurf = [];
                if (frontier26) {
                    for (let di = -1; di <= 1; di++)
                        for (let dj = -1; dj <= 1; dj++)
                            for (let dk = -1; dk <= 1; dk++)
                                if (di || dj || dk) { nSurf.push(di, dj, dk); }
                } else {
                    nSurf.push(...OFFS6_3D);
                }

                for (let ii = 0; ii < BX; ii++) {
                    for (let jj = 0; jj < BY; jj++) {
                        const base = ii * strideX + jj * strideY;
                        for (let k = 0; k < NZ; k++) {
                            const id = base + k; if (!airVis[id]) continue;
                            for (let u = 0; u < nSurf.length; u += 3) {
                                const ni = ii + nSurf[u], nj = jj + nSurf[u + 1], nk = k + nSurf[u + 2];
                                if (ni < 0 || ni >= BX || nj < 0 || nj >= BY || nk < 0 || nk >= NZ) continue;
                                const nid = ni * strideX + nj * strideY + nk;
                                if (solidOld[nid] && !frontierMask[nid]) {
                                    frontierMask[nid] = 1; fi[fsz] = ni; fj[fsz] = nj; fk[fsz] = nk; fsz++;
                                    if (fsz >= Fcap) break;
                                }
                            }
                        }
                    }
                }
                if (useCache) {
                    slot.frontierMask = frontierMask;  // ✅ 참조 저장
                    // 좌표 배열은 fsz 유효분만 슬라이스하여 새로 저장
                    slot.fi = fi.subarray(0, fsz);
                    slot.fj = fj.subarray(0, fsz);
                    slot.fk = fk.subarray(0, fsz);
                    slot.fsz = fsz;
                    // 재사용 시에는 slot.fi 등 참조를 그대로 쓴다
                    fi = slot.fi; fj = slot.fj; fk = slot.fk;
                }
            }

            // 7) 증착: 접촉띠 + SE scatter (동일)
            const solidNew = this._ensureBuf('_aldSolidNew', voxCount, 'u8');
            solidNew.set(solidOld);

            // (a) 접촉띠 보장(빈틈 방지)
            const n6 = OFFS6_3D;
            for (let p = 0; p < fsz; p++) {
                const ii = fi[p], jj = fj[p], kk = fk[p];
                for (let u = 0; u < n6.length; u += 3) {
                    const ni = ii + n6[u], nj = jj + n6[u + 1], nk = kk + n6[u + 2];
                    if (ni < 0 || ni >= BX || nj < 0 || nj >= BY || nk < 0 || nk >= NZ) continue;
                    const id2 = ni * strideX + nj * strideY + nk;
                    if (airVis[id2]) solidNew[id2] = 1;
                }
            }

            // (b) 커널: tEff 양자화(정확도↓시 속도↑; 기본 dz 단위)
            const voxDiag = Math.max(dx, dy, dz);
            const tEff = t + 0.5 * voxDiag;
            const tEffQ = Math.max(seQuant, Math.round(tEff / seQuant) * seQuant);
            const { se } = this._getALDStructElem(tEffQ, dx, dy, dz);

            // stride 델타
            const seDu = new Int32Array(se.length), seDv = new Int32Array(se.length), seDw = new Int32Array(se.length);
            for (let n = 0; n < se.length; n++) { seDu[n] = se[n][0] * strideX; seDv[n] = se[n][1] * strideY; seDw[n] = se[n][2]; }

            // (c) 프런티어에서만 accessible air로 scatter
            for (let p = 0; p < fsz; p++) {
                const ii = fi[p], jj = fj[p], kk = fk[p];
                const base = ii * strideX + jj * strideY + kk;
                for (let n = 0; n < se.length; n++) {
                    const ni = ii + se[n][0], nj = jj + se[n][1], nk = kk + se[n][2];
                    if (ni < 0 || ni >= BX || nj < 0 || nj >= BY || nk < 0 || nk >= NZ) continue;
                    const id2 = base + seDu[n] + seDv[n] + seDw[n];
                    if (airVis[id2]) solidNew[id2] = 1;
                }
            }

            // 8) 보셀 → 세그 복구(브릿지 포함; 동일)
            const pushWithBridge = (arr, seg) => {
                if (!arr.length) { arr.push(seg); return; }
                const last = arr[arr.length - 1];
                if (seg[1] - last[2] > 1e-12 && seg[1] - last[2] <= bridgeTol) {
                    arr.push([mat, last[2], seg[1]]); // 얇은 필름으로 메움
                }
                arr.push(seg);
            };

            for (let i = imin; i <= imax; i++) {
                const ii = i - imin;
                for (let j = jmin; j <= jmax; j++) {
                    const jj = j - jmin, base = ii * strideX + jj * strideY;
                    const outSegs = [];
                    let runVal = 0, k0 = -1; // 0 none, 1 old, 2 added

                    const flush = (k1, val) => {
                        if (k0 < 0) return;
                        const z0 = k0 * dz, z1 = k1 * dz;
                        if (val === 1) {
                            const col = this.cols[i][j];
                            for (let s = 0; s < col.length; s++) {
                                const [m, a0, a1] = col[s];
                                const lo = Math.max(a0, z0), hi = Math.min(a1, z1);
                                if (hi > lo + eps) pushWithBridge(outSegs, [m, lo, hi]);
                            }
                        } else if (val === 2) {
                            pushWithBridge(outSegs, [mat, z0, z1]);
                        }
                        k0 = -1;
                    };

                    for (let k = 0; k < NZ; k++) {
                        const sN = solidNew[base + k];
                        if (!sN) { if (runVal !== 0) { flush(k, runVal); runVal = 0; } continue; }
                        const sO = solidOld[base + k];
                        const val = sO ? 1 : 2;
                        if (val !== runVal) { if (runVal !== 0) flush(k, runVal); runVal = val; k0 = k; }
                    }
                    if (runVal !== 0) flush(NZ, runVal);

                    if (outSegs.length) {
                        const merged = [outSegs[0].slice()];
                        for (let s = 1; s < outSegs.length; s++) {
                            const [m, z0, z1] = outSegs[s];
                            const last = merged[merged.length - 1];
                            if (last[0] === m && Math.abs(last[2] - z0) < mergeEps) last[2] = z1;
                            else merged.push([m, z0, z1]);
                        }
                        this.cols[i][j] = merged;
                    } else {
                        this.cols[i][j] = [];
                    }
                }
            }
        }



        cmp(depth, stopmat = '-') {
            if (depth <= 0) return;

            let ztop = 0;           // 전체 최상단
            let stopper_top = -Infinity; // stopper의 최상단

            // 1️⃣ 전체 ztop 및 stopper_top 계산
            for (let i = 0; i < this.NX; i++) {
                for (let j = 0; j < this.NY; j++) {
                    const col = this.cols[i][j];
                    if (!col.length) continue;
                    const topSeg = col[col.length - 1];
                    ztop = Math.max(ztop, topSeg[2]); // z1

                    if (stopmat !== '-') {
                        for (const [m, z0, z1] of col) {
                            if (m === stopmat) stopper_top = Math.max(stopper_top, z1);
                        }
                    }
                }
            }

            // 2️⃣ targetZ 결정
            let targetZ;
            if (stopmat === '-' || stopper_top === -Infinity) {
                targetZ = ztop - depth;
            } else {
                targetZ = Math.max(ztop - depth, stopper_top);
            }

            // 3️⃣ CMP 수행
            for (let i = 0; i < this.NX; i++) {
                for (let j = 0; j < this.NY; j++) {
                    const col = this.cols[i][j];
                    if (!col.length) continue;

                    // stopper 존재 여부 및 높이 확인
                    let stopZ = -Infinity;
                    if (stopmat !== '-') {
                        for (const [m, z0, z1] of col) {
                            if (m === stopmat) {
                                stopZ = z1;
                                break;
                            }
                        }
                    }

                    // 실제 CMP 한계면
                    const limitZ = Math.max(targetZ, stopZ);

                    // 4️⃣ 위에서부터 잘라내기
                    while (col.length) {
                        const topIdx = col.length - 1;
                        const seg = col[topIdx];
                        const [m, z0, z1] = seg;

                        if (z1 <= limitZ + 1e-9) break; // 이미 낮음 → stop

                        if (z0 < limitZ - 1e-9) {
                            // 일부만 깎임
                            seg[2] = limitZ;
                            break;
                        } else {
                            // 전층 제거
                            col.pop();
                        }
                    }

                    // 5️⃣ 정리 (비정상 세그먼트 제거)
                    if (col.length && col[col.length - 1][2] <= col[col.length - 1][1] + 1e-9) {
                        col.pop();
                    }
                }
            }
        }



        maxHeight() {
            let m = 0;
            for (let i = 0; i < this.NX; i++) for (let j = 0; j < this.NY; j++) {
                const col = this.cols[i][j]; if (col.length) m = Math.max(m, col[col.length - 1][1]);
            }
            return m || 1;
        }
    }

    /* ===================== Slice2D ===================== */
    class Slice2D {
        constructor(grid, canvas) {
            this.grid = grid; this.canvas = canvas; this.ctx = canvas.getContext('2d');
        }
        clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }

        draw(axis, nmPos) {
            const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
            ctx.clearRect(0, 0, W, H);
            const zMax = Math.max(220, this.grid.maxHeight() * 1.1);

            if (axis === 'YZ') {
                const i = this.grid.indexFromX(nmPos);
                const scaleY = W / this.grid.LYeff;
                for (let j = 0; j < this.grid.NY; j++) {
                    const col = this.grid[i][j]; let prev = 0;
                    for (const [m, zEnd] of col) {
                        const h = zEnd - prev; if (h <= 0) { prev = zEnd; continue; }
                        ctx.fillStyle = hex(matColors[m] || 0x000000);
                        const x0 = (this.grid.worldY(j) + this.grid.LYeff / 2) * scaleY;
                        const y0 = H - (zEnd / zMax) * H;
                        const hh = (h / zMax) * H;
                        ctx.fillRect(x0, y0, Math.max(1, this.grid.dy * scaleY), hh);
                        prev = zEnd;
                    }
                }
            }
            // (XZ, XY plane도 필요시 확장)
        }
    }

    window.prj.ColumnGrid = ColumnGrid;
    window.prj.Slice2D = Slice2D;
})(window);