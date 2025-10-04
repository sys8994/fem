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
                    if (!maskFn(i, j)) continue;
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
            for (let i = 0; i < this.NX; i++) for (let j = 0; j < this.NY; j++) {
                const dz = vert[i][j] + lat[i][j];
                if (dz > 0) this._applyEtchAt(i, j, mat, dz);
            }
        }
        deposit(maskFn, mat, depth, anisotropy = 1.0, opts = {}) {
            const eta = clamp(Number(anisotropy) || 0, 0, 1);
            const R = Number(opts.radius ?? 2) | 0;
            const kern = buildGaussianKernel(R, opts.sigma ?? (R / 2));
            const vert = zero2D(this.NX, this.NY);
            const lat = zero2D(this.NX, this.NY);

            for (let i = 0; i < this.NX; i++) {
                for (let j = 0; j < this.NY; j++) {
                    if (!maskFn(i, j)) continue;
                    vert[i][j] += depth * eta;
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
            for (let i = 0; i < this.NX; i++) for (let j = 0; j < this.NY; j++) {
                const dz = vert[i][j] + lat[i][j];
                if (dz > 0) this._applyDepositAt(i, j, mat, dz);
            }
        }

        cmp(depth, stopmat='-'){
            // 1) 전체 ztop 계산
            let ztop = 0;
            for(let i=0;i<this.NX;i++){
              for(let j=0;j<this.NY;j++){
                const col=this.cols[i][j];
                if(col.length){
                  ztop = Math.max(ztop, col[col.length-1][1]);
                }
              }
            }
            const targetZ = ztop - depth;
          
            // 2) 각 칼럼 평탄화
            for(let i=0;i<this.NX;i++){
              for(let j=0;j<this.NY;j++){
                const col=this.cols[i][j];
                if(!col.length) continue;
          
                // stopper 옵션이 있는 경우
                let stopZ = -Infinity;
                if(stopmat != '-'){
                  for(const [m,zEnd] of col){
                    if(m===stopmat){ stopZ = zEnd; break; }
                  }
                }
                const limitZ = Math.max(targetZ, stopZ);
          
                // 3) 최상단에서 내려가며 잘라내기
                while(col.length){
                  const topIdx = col.length-1;
                  const top = col[topIdx];
                  const z0 = (topIdx>=1? col[topIdx-1][1] : 0);
          
                  if(top[1] <= limitZ+1e-9) break; // 이미 낮음 → 종료
          
                  // plane까지 잘라냄
                  top[1] = Math.max(limitZ, z0);
                  if(top[1] <= z0+1e-9) col.pop(); // 완전 제거됐으면 pop
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
