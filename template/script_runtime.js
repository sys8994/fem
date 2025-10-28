// ===== 3D 렌더러 =====
class GridRenderer {
    constructor(containerId) {
        this.wrap = document.getElementById(containerId);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x12161c);
    
        const w = this.wrap.clientWidth || 800;
        const h = this.wrap.clientHeight || 600;
    
        // --- 카메라 초기 생성만 (위치 설정은 따로) ---
        this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 50000);
        this.camera.up.set(0, 0, 1);
    
        // --- 렌더러 ---
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.wrap.innerHTML = '';
        this.wrap.appendChild(this.renderer.domElement);
    
        // --- 컨트롤러 ---
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    
        // --- 라이트 ---
        this.scene.add(new THREE.AmbientLight(0x7f7f7f));
        const dir = new THREE.DirectionalLight(0xffffff, 0.9);
        dir.position.set(800, 900, 1400);
        this.scene.add(dir);
    
        // --- 그리드 및 기타 ---
        this.xyGrid = null;
        this.ground = null;
        this.inst = {};
        this.boxGeo = null;
        this.maxInstances = 0;
    
        window.addEventListener('resize', () => this._onResize());
        this._animate();
    
        // 🔹 카메라를 기본 위치로 세팅 (초기화)
        this.setDefaultCamera();
      }

      setDefaultCamera(grid = null) {
        // grid 정보가 있으면 중심을 계산해서 target 조정
        let cx = 0, cy = 0, cz = 100;
        if (grid) {
          cx = (grid.xmin + grid.xmax) / 2 || 0;
          cy = (grid.ymin + grid.ymax) / 2 || 0;
          cz = grid.maxHeight ? grid.maxHeight() * 0.5 : 100;
        }
    
        this.camera.position.set(400, -400, 500);
        this.controls.target.set(cx, cy, cz);
        this.camera.lookAt(cx, cy, cz);
      }

    _onResize() {
        const w = this.wrap.clientWidth || 800;
        const h = this.wrap.clientHeight || 600;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    _setupDomainHelpers(grid) {
        if (this.ground) this.scene.remove(this.ground);
        if (this.xyGrid) this.scene.remove(this.xyGrid);
    
        // 도메인 중심 계산
        const cx = grid.LXeff / 2;
        const cy = grid.LYeff / 2;
    
        // 평면 및 격자 중심을 (0,0)에 정렬
        const planeGeo = new THREE.PlaneGeometry(grid.LXeff * 1.2, grid.LYeff * 1.2);
        this.ground = new THREE.Mesh(
          planeGeo,
          new THREE.MeshBasicMaterial({ color: 0x171b21, side: THREE.DoubleSide })
        );
        this.ground.position.set(0, 0, 0);
        this.scene.add(this.ground);
    
        const size = Math.max(grid.LXeff, grid.LYeff) * 1.2;
        const div = Math.max(grid.NX, grid.NY);
        this.xyGrid = new THREE.GridHelper(size, div, 0x3a3f45, 0x2a2f35);
        this.xyGrid.rotation.x = Math.PI / 2;
        this.xyGrid.position.set(0, 0, 0.05);
        this.scene.add(this.xyGrid);
      }

    _ensureInstanced(grid, materialColor) {
        // 단위 큐브로 생성
        this.boxGeo = new THREE.BoxGeometry(1, 1, 1);

        Object.values(this.inst).forEach(m => this.scene.remove(m));
        this.inst = {};
        this.maxInstances = grid.NX * grid.NY * 16;

        for (const [matKey, colorStr] of Object.entries(materialColor || {})) {
            const color = new THREE.Color(colorStr);
            const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 1 });
            const im = new THREE.InstancedMesh(this.boxGeo, mat, this.maxInstances);
            this.inst[matKey] = im;
            this.scene.add(im);
        }
    }


    updateFromGrid(grid, materialColor) {
        if (!grid) return;
        this._setupDomainHelpers(grid);
        this._ensureInstanced(grid, materialColor);
    
        // 인스턴스 배치 시에도 offset 적용 (구조 중심을 0,0으로 이동)
    
        const dummy = new THREE.Object3D();
        const counts = {};
        for (const k of Object.keys(this.inst)) counts[k] = 0;
    
        for (let i = 0; i < grid.NX; i++) {
          for (let j = 0; j < grid.NY; j++) {
            const col = grid.getColumn(i, j);
            let prev = 0;
            for (const [m, zEnd] of col) {
              const h = zEnd - prev;
              if (h <= 0) { prev = zEnd; continue; }
    
              // 중심 보정 적용
              dummy.position.set(grid.worldX(i), grid.worldY(j), prev + h / 2);
              dummy.scale.set(grid.dx, grid.dy, h);
              dummy.updateMatrix();
    
              if (this.inst[m]) {
                this.inst[m].setMatrixAt(counts[m]++, dummy.matrix);
              }
              prev = zEnd;
            }
          }
        }
    
        for (const k of Object.keys(this.inst)) {
          this.inst[k].count = counts[k] || 0;
          this.inst[k].instanceMatrix.needsUpdate = true;
        }
      }

      _animate() {
        const loop = () => {
          requestAnimationFrame(loop);
          this.controls.update();
          this.renderer.render(this.scene, this.camera);
        };
        loop();
      }
}

// ===== 프로세스 실행기 =====
class ProcessRuntime {
    constructor(domain) {
        // 렌더러 준비
        this.renderer3D = new GridRenderer('viewer-container-process');

        // 기본 도메인(간단 버전): 필요시 ColumnGrid UI와 연결 예정
        this.domain = domain || { LX: 200, LY: 200, dx: 2, dy: 2 };

        // 이벤트 수신
        window.addEventListener('simflow:changed', (ev) => {
            const snap = ev.detail;           // { processes, selectBarBoundId, arrowBoundId, ... }
            this._rebuild(snap);
        });

    }


    _emptySnapshot() {
        return { processes: [], selectedIds: [], selectBarBoundId: null, arrowBoundId: null, lastFocusIndex: null };
    }

    _arrowGapIndex(processes, arrowBoundId) {
        if (!arrowBoundId) return 0;
        const idx = processes.findIndex(p => p.id === arrowBoundId);
        return (idx < 0) ? 0 : (idx + 1);  // gap = 이전 카드 아래
    }

    _getMaskFun(maskid) {
        if (!maskid) return (x, y) => true;
        if (maskid == '-') return (x, y) => true;
        const maskdata = window.SIMULOBJET.maskmanager.maskList.find(mask => mask.id === maskid);
        return (x, y) => this._isPointBlocked(x, y, maskdata.data);
        // if (!maskid) return (x, y) => true;
        // return (x, y) => this._isPointBlocked(x, y, maskid);
    }

    _isPointBlocked(x, y, maskData) {
        // open: true, close: false
        if (!maskData?.objects) return true;
        const objects = maskData.objects;

        // bottom → top 순서로 판단
        for (let i = objects.length - 1; i >= 0; i--) {
            const obj = objects[i];
            if (!obj.visible) continue;

            if (this._pointInsideShape(x, y, obj)) {
                const polarity = obj.data?.polarity || 'positive';
                return !(polarity === 'positive');
            }
        }
        // 어떤 도형에도 포함되지 않으면 open
        return true;
    }

    _pointInsideShape(x, y, obj) { // 도형 내부 판정 함수
        const ox = obj.left || 0;
        const oy = obj.top || 0;
        const w = obj.width || 0;
        const h = obj.height || 0;
        const angle = obj.angle || 0;
        const scaleX = obj.scaleX || 1;
        const scaleY = obj.scaleY || 1;

        // 회전 각도가 있는 경우만 보정
        const dx = x - ox;
        const dy = y - oy;

        let lx = dx, ly = dy;
        if (angle !== 0) {
            const rad = (-angle * Math.PI) / 180;
            lx = dx * Math.cos(rad) - dy * Math.sin(rad);
            ly = dx * Math.sin(rad) + dy * Math.cos(rad);
        }

        // 스케일 적용
        lx /= scaleX;
        ly /= scaleY;

        switch (obj.type) {
            case 'rect':
                return lx >= 0 && lx <= w && ly >= 0 && ly <= h;

            case 'circle': {
                const r = obj.radius || w / 2;
                const cx = w / 2;
                const cy = h / 2;
                return (lx - cx) ** 2 + (ly - cy) ** 2 <= r ** 2;
            }

            case 'ellipse': {
                const rx = obj.rx || w / 2;
                const ry = obj.ry || h / 2;
                const ex = lx - w / 2;
                const ey = ly - h / 2;
                return (ex * ex) / (rx * rx) + (ey * ey) / (ry * ry) <= 1;
            }

            case 'polygon':
                return this._pointInPolygon(lx, ly, obj.points);

            case 'path':
                if (!obj.path) return false;
                const pts = obj.path
                    .filter(p => p[0] === 'L' || p[0] === 'M')
                    .map(p => ({ x: p[1], y: p[2] }));
                return this._pointInPolygon(lx, ly, pts);

            default:
                return false;
        }
    }

    _pointInPolygon(x, y, points) { // 폴리곤 내부 점 판정 (ray casting)
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const xi = points[i].x, yi = points[i].y;
            const xj = points[j].x, yj = points[j].y;
            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    _applyStep(grid, step) {
        let kind = (step.kind || '').toUpperCase();
        if (kind == 'SUBSTR') kind = 'DEPO';
        const mat = step.material || 'A';
        const thk = Number(step.thickness || 0);
        const eta = (typeof step.anisotropy === 'number') ? step.anisotropy : 0;
        const rad = (typeof step.radius === 'number') ? step.radius : 0;
        const maskfun = this._getMaskFun(step.mask)



        if (thk <= 0) return;

        if (kind === 'DEPO') {
            grid.deposit_partial(maskfun, mat, thk, eta);
            // grid.deposit(maskfun, mat, thk, eta);
        } else if (kind === 'ETCH') {
            grid.etch(maskfun, mat, thk, eta, { radius: rad });
        } else if (kind === 'CMP') {
            grid.cmp(thk, step.material);
        }
    }

    _rebuild(snapshot) {
        const { LX, LY, dx, dy } = this.domain;
        const grid = new window.SIMULOBJET.ColumnGrid(LX, LY, dx, dy);

        // arrow 이전까지만 적용
        const processes = snapshot?.processes || [];
        const gap = this._arrowGapIndex(processes, snapshot?.arrowBoundId);
        const upto = processes.slice(0, gap);

        for (const step of upto) {
            this._applyStep(grid, step);
        }


        // 3D 갱신
        this.renderer3D.updateFromGrid(grid, snapshot?.materialColor || {});

    }
}

// 부팅
window.addEventListener('DOMContentLoaded', () => {
    const runtime = new ProcessRuntime();
    window.SIMULOBJET.processRuntime = runtime;   // 👈 전역 포인터
    const f = window.SIMULOBJET?.processFlow;
    f && window.dispatchEvent(new CustomEvent('simflow:changed', { detail: f._snapshot() }));
});



