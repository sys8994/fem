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
