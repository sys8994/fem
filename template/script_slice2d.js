    
const hex = c => '#' + c.toString(16).padStart(6, '0');
function zero2D(nx, ny) { const a = new Array(nx); for (let i = 0; i < nx; i++) { a[i] = new Float32Array(ny); } return a; }
    
    
    
    /* ===================== Slice2D ===================== */
    class Slice2D {
        constructor(grid, canvas) {
            this.grid = grid; this.canvas = canvas; this.ctx = canvas.getContext('2d');
        }
        clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }

        
    indexFromX(xnm) { return this._clamp(Math.round((xnm - this.offsetX) / this.dx), 0, this.NX - 1); }
    indexFromY(ynm) { return this._clamp(Math.round((ynm - this.offsetY) / this.dy), 0, this.NY - 1); }

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



    


/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    window.prj.Slice2D = Slice2D;  
  });
