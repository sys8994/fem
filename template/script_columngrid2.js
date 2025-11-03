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






/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    window.prj.ColumnGrid = ColumnGrid;
});
