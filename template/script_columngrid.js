(function (window) {
    'use strict';
    window.SIMULOBJET = window.SIMULOBJET || {};

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
            this.cols = new Array(this.NX);
            for (let i = 0; i < this.NX; i++) {
                this.cols[i] = new Array(this.NY);
                for (let j = 0; j < this.NY; j++) {
                    //   this.cols[i][j] = [ ['B',20], ['A',100] ]; // 초기 스택
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
        getColumn(i, j) { return this.cols[i][j]; }

        _applyEtchAt(i, j, mat, dz) {
            if (dz <= 0) return;
            const col = this.cols[i][j]; if (!col.length) return;
            const top = col[col.length - 1]; if (top[0] !== mat) return;
            const prevEnd = (col.length >= 2 ? col[col.length - 2][1] : 0);
            const rem = top[1] - prevEnd;
            const cut = Math.min(rem, dz);
            top[1] -= cut;
            if (top[1] <= prevEnd + 1e-9) col.pop();
        }
        _applyDepositAt(i, j, mat, dz) {
            if (dz <= 0) return;
            const col = this.cols[i][j];
            const topZ = col.length ? col[col.length - 1][1] : 0;
            if (col.length && col[col.length - 1][0] === mat) col[col.length - 1][1] = topZ + dz;
            else col.push([mat, topZ + dz]);
        }

        etch(maskFn, mat, depth, anisotropy = 1.0, opts = {}) {
            const eta = clamp(Number(anisotropy) || 0, 0, 1);
            const R = Number(opts.radius ?? 2) | 0;
            const kern = buildGaussianKernel(R, opts.sigma ?? (R / 2));
            const vert = zero2D(this.NX, this.NY);
            const lat = zero2D(this.NX, this.NY);

            for (let i = 0; i < this.NX; i++) {
                for (let j = 0; j < this.NY; j++) {
                    if (!maskFn((i + 0.5) * this.dx, (j + 0.5) * this.dy)) continue;
                    const col = this.cols[i][j];
                    if (col.length && col[col.length - 1][0] === mat) vert[i][j] += depth * eta;
                    const L = depth * (1 - eta);
                    if (L > 0 && kern.ofs.length) {
                        for (const [dx, dy, w] of kern.ofs) {
                            const x = i + dx, y = j + dy;
                            if (x < 0 || x >= this.NX || y < 0 || y >= this.NY) continue;
                            lat[x][y] += L * (w / kern.wsum);
                        }
                    }
                }
            }
            for (let i = 0; i < this.NX; i++) {
                for (let j = 0; j < this.NY; j++) {
                    const dz = vert[i][j] + lat[i][j];
                    if (dz > 0) this._applyEtchAt(i, j, mat, dz);
                }
            }
        }

        // deposit(maskFn, mat, depth, anisotropy = 1.0, opts = {}) {
        //     const eta = clamp(Number(anisotropy) || 0, 0, 1);
        //     const R = Number(opts.radius ?? 2) | 0;
        //     const kern = buildGaussianKernel(R, opts.sigma ?? (R / 2));
        //     const vert = zero2D(this.NX, this.NY);
        //     const lat = zero2D(this.NX, this.NY);

        //     for (let i = 0; i < this.NX; i++) {
        //         for (let j = 0; j < this.NY; j++) {
        //             if (!maskFn((i + 0.5) * this.dx, (j + 0.5) * this.dy)) continue;
        //             vert[i][j] += depth * eta;
        //             const L = depth * (1 - eta);
        //             if (L > 0 && kern.ofs.length) {
        //                 for (const [dx, dy, w] of kern.ofs) {
        //                     const x = i + dx, y = j + dy;
        //                     if (x < 0 || x >= this.NX || y < 0 || y >= this.NY) continue;
        //                     lat[x][y] += L * (w / kern.wsum);
        //                 }
        //             }
        //         }
        //     }
        //     for (let i = 0; i < this.NX; i++) {
        //         for (let j = 0; j < this.NY; j++) {
        //             const dz = vert[i][j] + lat[i][j];
        //             if (dz > 0) this._applyDepositAt(i, j, mat, dz);
        //         }
        //     }
        // }


        // deposit_partial(maskFn, mat, thickness, conformality) {
        //     const t = Math.max(0, Number(thickness) || 0);
        //     if (t <= 0) return;

        //     const NX = this.NX, NY = this.NY, dx = this.dx, dy = this.dy;
        //     const S = clamp(Number(conformality ?? 1.0), 0, 1); // 0~1
        //     const lateral_range = t * S;
        //     const lateral_effective = (lateral_range >= Math.min(dx, dy) * 0.9); // 분기 기준        

        //     // ===================== 수직만 성장 (빠른 경로) =====================
        //     if (!lateral_effective) {
        //       for (let i = 0; i < NX; i++) {
        //         for (let j = 0; j < NY; j++) {
        //           const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
        //           if (maskFn && !maskFn(x, y)) continue;
        //           this._applyDepositAt(i, j, mat, t);
        //         }
        //       }
        //       return;
        //     }

        //     // ===================== 컨포멀 성장 (라운딩 포함) =====================
        //     const H = new Float32Array(NX * NY);
        //     for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
        //       const col = this.cols[i][j];
        //       H[i * NY + j] = col.length ? col[col.length - 1][1] : 0;
        //     };

        //     // 커널 사전 계산
        //     const offs = [];
        //     const Rx = Math.ceil(t / dx), Ry = Math.ceil(t / dy);
        //     const t2 = t * t, S_inv = 1 / Math.max(S, 1e-6);
        //     for (let du = -Rx; du <= Rx; du++) {
        //       for (let dv = -Ry; dv <= Ry; dv++) {
        //         const r_lat = Math.hypot(du * dx, dv * dy) * S_inv;
        //         if (r_lat <= t + 1e-9) {
        //           const add = Math.sqrt(Math.max(0, t2 - r_lat * r_lat));
        //           offs.push([du, dv, add]);
        //         }
        //       }
        //     }

        //     const Hp = new Float32Array(NX * NY);
        //     for (let i = 0; i < NX; i++) {
        //       for (let j = 0; j < NY; j++) {
        //         const x = (i + 0.5) * dx, y = (j + 0.5) * dy;
        //         if (maskFn && !maskFn(x, y)) { Hp[i * NY + j] = H[i * NY + j]; continue; }

        //         let m = H[i * NY + j] + t;
        //         for (const [du, dv, add] of offs) {
        //           const x2 = i + du, y2 = j + dv;
        //           if (x2 < 0 || x2 >= NX || y2 < 0 || y2 >= NY) continue;
        //           const cand = H[x2 * NY + y2] + add;
        //           if (cand > m) m = cand;
        //         }
        //         Hp[i * NY + j] = m;
        //       }
        //     }

        //     // 실제 deposition 반영
        //     for (let i = 0; i < NX; i++) {
        //       for (let j = 0; j < NY; j++) {
        //         const dz = Hp[i * NY + j] - H[i * NY + j];
        //         if (dz > 1e-9) this._applyDepositAt(i, j, mat, dz);
        //       }
        //     }
        //   }


        // ===== 내부 유틸: 버퍼 확보/재사용 =====
        _ensureBuf(name, length) {
            if (!this[name] || this[name].length < length) this[name] = new Float32Array(length);
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
        deposit_partial(maskFn, mat, thickness, conformality) {
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
                    H[ii + j] = col.length ? col[col.length - 1][1] : 0;
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
            // 기본값 채우기: mask true면 H+t, false면 H
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

            // 이웃 탐색 (패딩 인덱스 사용: (i+Rx, j+Rx) 기준)
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
                        const base = (ip + du) * PH;       // 패딩행 베이스
                        const center = base + jp;
                        // row: [dv0, add0, dv1, add1, ...] (Float32Array)
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

            // ---- Δz 적용 ----
            for (let i = iMin; i <= iMax; i++) {
                const ii = i * NY;
                for (let j = jMin; j <= jMax; j++) {
                    const dz = Hp[ii + j] - H[ii + j];
                    if (dz > 1e-9) this._applyDepositAt(i, j, mat, dz);
                }
            }
        }



        cmp(depth, stopmat = '-') {
            // 1) 전체 ztop 계산
            let ztop = 0;
            for (let i = 0; i < this.NX; i++) {
                for (let j = 0; j < this.NY; j++) {
                    const col = this.cols[i][j];
                    if (col.length) {
                        ztop = Math.max(ztop, col[col.length - 1][1]);
                    }
                }
            }
            const targetZ = ztop - depth;

            // 2) 각 칼럼 평탄화
            for (let i = 0; i < this.NX; i++) {
                for (let j = 0; j < this.NY; j++) {
                    const col = this.cols[i][j];
                    if (!col.length) continue;

                    // stopper 옵션이 있는 경우
                    let stopZ = -Infinity;
                    if (stopmat != '-') {
                        for (const [m, zEnd] of col) {
                            if (m === stopmat) { stopZ = zEnd; break; }
                        }
                    }
                    const limitZ = Math.max(targetZ, stopZ);

                    // 3) 최상단에서 내려가며 잘라내기
                    while (col.length) {
                        const topIdx = col.length - 1;
                        const top = col[topIdx];
                        const z0 = (topIdx >= 1 ? col[topIdx - 1][1] : 0);

                        if (top[1] <= limitZ + 1e-9) break; // 이미 낮음 → 종료

                        // plane까지 잘라냄
                        top[1] = Math.max(limitZ, z0);
                        if (top[1] <= z0 + 1e-9) col.pop(); // 완전 제거됐으면 pop
                        else break; // 한 레벨만 줄이면 끝
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
                    const col = this.grid.getColumn(i, j); let prev = 0;
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

    window.SIMULOBJET.ColumnGrid = ColumnGrid;
    window.SIMULOBJET.Slice2D = Slice2D;
})(window);
