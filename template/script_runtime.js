// ===== 3D 렌더러 =====
class GridRenderer {
    constructor(containerId) {
        this.wrap = document.getElementById(containerId);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x12161c);

        const w = this.wrap.clientWidth || 800;
        const h = this.wrap.clientHeight || 600;

        this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 50000);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(500, -500, 600);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.wrap.innerHTML = '';
        this.wrap.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 0, 100);

        // light
        this.scene.add(new THREE.AmbientLight(0x7f7f7f));
        const dir = new THREE.DirectionalLight(0xffffff, 0.9);
        dir.position.set(800, 900, 1400);
        this.scene.add(dir);

        // helpers
        this.xyGrid = null;
        this.ground = null;

        // instanced meshes by material
        this.inst = {};
        this.boxGeo = null;
        this.maxInstances = 0;

        window.addEventListener('resize', () => this._onResize());
        this._animate();
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

        const planeGeo = new THREE.PlaneGeometry(grid.LXeff * 1.2, grid.LYeff * 1.2);
        this.ground = new THREE.Mesh(
            planeGeo,
            new THREE.MeshBasicMaterial({ color: 0x171b21, side: THREE.DoubleSide })
        );
        this.scene.add(this.ground);

        const size = Math.max(grid.LXeff, grid.LYeff) * 1.2;
        const div = Math.max(grid.NX, grid.NY);
        this.xyGrid = new THREE.GridHelper(size, div, 0x3a3f45, 0x2a2f35);
        this.xyGrid.rotation.x = Math.PI / 2; // XZ→XY
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

        // 카메라 위치 업데이트(도메인에 맞춤)
        //   this.camera.position.set(grid.LXeff*0.9, -grid.LYeff*0.9, Math.max(300, grid.maxHeight()*1.6));
        //   this.controls.target.set(0,0,Math.max(40, grid.maxHeight()*0.5));

        // 인스턴스 배치
        const dummy = new THREE.Object3D();
        const counts = {}; for (const k of Object.keys(this.inst)) counts[k] = 0;

        for (let i = 0; i < grid.NX; i++) {
            for (let j = 0; j < grid.NY; j++) {
                const col = grid.getColumn(i, j);
                let prev = 0;
                for (const [m, zEnd] of col) {
                    const h = zEnd - prev; if (h <= 0) { prev = zEnd; continue; }
                    dummy.position.set(grid.worldX(i), grid.worldY(j), prev + h / 2);
                    // 실제 단위 스케일 적용
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

    _maskFnFor(step, grid) {
        // 간단 버전: 전체 적용(Blanket). 필요하면 step.centerX/centerY/radius/eta 등 확장
        return () => true;
    }

    _applyStep(grid, step) {
        let kind = (step.kind || '').toUpperCase();
        if (kind == 'SUBSTR') kind = 'DEPO';
        const mat = step.material || 'A';
        const thk = Number(step.thickness || 0);
        const eta = (typeof step.anisotropy === 'number') ? step.anisotropy : 1.0;
        const rad = (typeof step.radius === 'number') ? step.radius : 0;
        const mask = this._maskFnFor(step, grid);

        if (thk <= 0) return;

        if (kind === 'DEPO') {
            grid.deposit(mask, mat, thk, eta, { radius: rad });
        } else if (kind === 'ETCH') {
            grid.etch(mask, mat, thk, eta, { radius: rad });
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



