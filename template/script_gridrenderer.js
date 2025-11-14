class GridRenderer {
    constructor(containerId) {
        this.wrap = document.getElementById(containerId);

        // --- Scene / Camera / Renderer ---
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x12161c);

        const w = this.wrap.clientWidth || 800;
        const h = this.wrap.clientHeight || 600;

        this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 50000);
        this.camera.up.set(0, 0, 1);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.wrap.innerHTML = '';
        this.wrap.appendChild(this.renderer.domElement);

        // --- Controls ---
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.addEventListener('change', () => this.requestRender()); // 사용자가 움직이면 한 프레임 렌더

        // --- Lights (가벼운 조명) ---
        const ambient = new THREE.AmbientLight(0x404040, 0.7);
        this.scene.add(ambient);
        const hemi = new THREE.HemisphereLight(0xddddff, 0x222233, 0.5);
        hemi.position.set(0, 0, 1000);
        this.scene.add(hemi);
        const dir1 = new THREE.DirectionalLight(0xffffff, 0.65);
        dir1.position.set(800, -600, 1200);
        this.scene.add(dir1);
        const dir2 = new THREE.DirectionalLight(0xffffff, 0.15);
        dir2.position.set(-600, 800, 800);
        this.scene.add(dir2);

        // --- Helpers & instancing state ---
        this.ground = null;
        this.xyGrid = null;
        this._domainKey = '';               // 도메인(크기/분할) 변경 감지용
        this.boxGeo = null;                 // 공유 box geometry (1회 생성)
        this.inst = {};                     // { matId: InstancedMesh }
        this._matColors = {};               // { matId: '#rrggbb' }
        this._instCapacity = {};            // { matId: capacity }
        this._headroom = 32;                // 여유 인스턴스


        // ▼ 추가: 물질 투명 상태 관리
        this._dimmed = new Set(); // matId 집합
        this._legendEl = null;    // 범례 컨테이너(옵션)


        // --- Render scheduling ---
        this._needsRender = true;

        window.addEventListener('resize', () => this._onResize());
        this._animate();
        this.setDefaultCamera();
    }

    // ========== 공용 유틸 ==========
    requestRender() { this._needsRender = true; }

    _onResize() {
        const w = this.wrap.clientWidth || 800;
        const h = this.wrap.clientHeight || 600;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.requestRender();
    }

    setDefaultCamera(grid = null) {
        let cx = 0, cy = 0, cz = 100;
        if (grid) {
            cx = (grid.offsetX + grid.LXeff / 2) || 0;
            cy = (grid.offsetY + grid.LYeff / 2) || 0;
            cz = grid.maxHeight ? grid.maxHeight() * 0.5 : 100;
        }
        this.camera.position.set(400, -400, 500);
        this.controls.target.set(cx, cy, cz);
        this.camera.lookAt(cx, cy, cz);
        this.requestRender();
    }

    _nextPow2(n) {
        n = Math.max(1, Math.ceil(n));
        return 1 << (32 - Math.clz32(n - 1));
    }

    // ========== 도메인 Helper (ground / grid) ==========
    _setupDomainHelpers(grid) {
        const key = `${grid.LXeff}|${grid.LYeff}|${grid.NX}|${grid.NY}`;
        if (this._domainKey === key) return; // 변경 없음 → 재생성 불필요
        this._domainKey = key;

        // 기존 제거 + GPU 리소스 해제
        if (this.ground) {
            this.scene.remove(this.ground);
            this.ground.geometry.dispose();
            this.ground.material.dispose();
            this.ground = null;
        }
        if (this.xyGrid) {
            this.scene.remove(this.xyGrid);
            if (Array.isArray(this.xyGrid.material)) {
                this.xyGrid.material.forEach(m => m && m.dispose());
            } else {
                this.xyGrid.material.dispose();
            }
            this.xyGrid.geometry.dispose();
            this.xyGrid = null;
        }

        // 새로 생성 (가능하면 이후에는 스케일만 조정하는 구조로 유지)
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

        this.requestRender();
    }

    // ========== InstancedMesh 관리 ==========
    _ensureBoxGeometry() {
        if (!this.boxGeo) this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    }

    _disposeMesh(matId) {
        const m = this.inst[matId];
        if (!m) return;
        this.scene.remove(m);
        // InstancedMesh 내부 버퍼 해제
        if (m.dispose) m.dispose();
        if (m.material) m.material.dispose();
        delete this.inst[matId];
        delete this._instCapacity[matId];
        delete this._matColors[matId];
    }

    // ▼ 변경: instanced mesh 생성 직후 dim 상태 반영
    _ensureInstanced(materialColor, countsNeeded) {
        this._ensureBoxGeometry();

        const allowedIds = new Set();
        for (const [, v] of Object.entries(materialColor || {})) allowedIds.add(v.id);

        // 사라진 재질 제거
        for (const k of Object.keys(this.inst)) {
            const id = Number(k);
            if (!allowedIds.has(id)) this._disposeMesh(id);
        }

        for (const [, v] of Object.entries(materialColor || {})) {
            const matId = v.id;
            const hex = v.color;
            const need = Math.max(0, countsNeeded[matId] || 0);

            const curCap = this._instCapacity[matId] || 0;
            const has = !!this.inst[matId];

            if (has && hex && this._matColors[matId] !== hex) {
                this.inst[matId].material.color.set(hex);
                this._matColors[matId] = hex;
            }

            if (has && curCap >= need) continue;

            const target = this._nextPow2(need + this._headroom);

            if (has) this._disposeMesh(matId);

            // ▼ 생성 시점부터 투명 가능 세팅
            const material = new THREE.MeshLambertMaterial({
                color: new THREE.Color(hex),
                transparent: true,
                opacity: 1,        // 기본 불투명
            });

            const imesh = new THREE.InstancedMesh(this.boxGeo, material, Math.max(1, target));
            this.inst[matId] = imesh;
            this._instCapacity[matId] = target;
            this._matColors[matId] = hex;
            this.scene.add(imesh);

            // ▼ 생성 직후 현재 dim 상태 반영
            this._applyMaterialDimState_(matId);
        }
    }

    // ========== Grid → Scene 반영 ==========
    /**
     * materialColor: { [name]: { id: number, color: '#rrggbb' } }
     */
    updateFromGrid(grid, materialColor) {
        if (!grid) return;

        // 1) 도메인 helper (필요시에만 재생성)
        this._setupDomainHelpers(grid);

        // 2) 필요 인스턴스 수 1차 카운트 (재질별)
        const countsNeeded = {};
        const allowedIds = new Set();
        for (const [, v] of Object.entries(materialColor || {})) allowedIds.add(v.id);

        const { NX, NY, dx, dy, offsetX, offsetY } = grid;
        const { mat, zpair, len } = grid.cols;
        const Lmax = grid.Lmax;

        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const layers = len[cidx];
                if (layers === 0) continue;

                const base = cidx * Lmax;
                for (let k = 0; k < layers; k++) {
                    const mid = mat[base + k];
                    if (mid <= 2) continue; // 0=empty, 1=air, 2=cavity는 스킵
                    if (!allowedIds.has(mid)) continue;

                    const zBase = (base + k) * 2;
                    const z0 = grid._dequantizeZ(zpair[zBase]);
                    const z1 = grid._dequantizeZ(zpair[zBase + 1]);
                    if (z1 - z0 <= 0) continue;
                    countsNeeded[mid] = (countsNeeded[mid] || 0) + 1;
                }
            }
        }

        // 3) 재질별 InstancedMesh 용량 확보/증설
        this._ensureInstanced(materialColor, countsNeeded);

        // 4) 매트릭스 채우기
        const dummy = new THREE.Object3D();
        const counts = {};
        for (const k of Object.keys(this.inst)) counts[k] = 0;

        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const layers = len[cidx];
                if (layers === 0) continue;

                const base = cidx * Lmax;
                for (let k = 0; k < layers; k++) {
                    const mid = mat[base + k];
                    if (mid <= 2) continue;
                    if (!this.inst[mid]) continue;

                    const zBase = (base + k) * 2;
                    const z0 = grid._dequantizeZ(zpair[zBase]);
                    const z1 = grid._dequantizeZ(zpair[zBase + 1]);
                    const h = z1 - z0;
                    if (h <= 0) continue;

                    dummy.position.set(offsetX + i * dx, offsetY + j * dy, z0 + h / 2);
                    dummy.scale.set(dx, dy, h);
                    dummy.updateMatrix();

                    const idx = counts[mid]++;
                    // 용량 체크(이론상 _ensureInstanced가 보장하므로 안전) — 그래도 가드
                    if (idx < this._instCapacity[mid]) {
                        this.inst[mid].setMatrixAt(idx, dummy.matrix);
                    }
                }
            }
        }

        // 5) count/업데이트 반영
        for (const k of Object.keys(this.inst)) {
            const id = Number(k);
            const mesh = this.inst[id];
            mesh.count = Math.min(this._instCapacity[id], counts[id] || 0);
            mesh.instanceMatrix.needsUpdate = true;
        }

        this.requestRender();
    }

    // ========== 렌더 루프 (요청형) ==========
    _animate() {
        const loop = () => {
            requestAnimationFrame(loop);
            this.controls.update(); // orbit inertia 등 반영
            if (!this._needsRender) return;
            this._needsRender = false;
            this.renderer.render(this.scene, this.camera);
        };
        loop();
    }

    // ========== 전체 해제 ==========
    dispose() {
        // instanced meshes
        for (const k of Object.keys(this.inst)) this._disposeMesh(Number(k));
        this.inst = {};
        this._instCapacity = {};
        this._matColors = {};

        // ground / grid
        if (this.ground) {
            this.scene.remove(this.ground);
            this.ground.geometry.dispose();
            this.ground.material.dispose();
            this.ground = null;
        }
        if (this.xyGrid) {
            this.scene.remove(this.xyGrid);
            if (Array.isArray(this.xyGrid.material)) {
                this.xyGrid.material.forEach(m => m && m.dispose());
            } else {
                this.xyGrid.material.dispose();
            }
            this.xyGrid.geometry.dispose();
            this.xyGrid = null;
        }

        // box geometry (공유)
        if (this.boxGeo) {
            this.boxGeo.dispose();
            this.boxGeo = null;
        }

        // lights & scene는 보통 renderer.dispose()시 자동 정리되지만, 필요시 개별 처리 가능
        this.renderer.dispose();
        this.renderer.forceContextLoss && this.renderer.forceContextLoss();
        this.renderer.domElement && this.renderer.domElement.remove();
    }







    // ========== 물질 투명도 토글 ==========



    // ▼ 추가: 특정 재질의 투명 처리 적용(공통 루틴)
    _applyMaterialDimState_(matId) {
        const mesh = this.inst[matId];
        if (!mesh) return;
        const dim = this._dimmed.has(matId);

        const mtl = mesh.material;
        // 투명 재질 세팅
        mtl.transparent = true;
        mtl.opacity = dim ? 0.03 : 1.0;
        // 완전 투명은 아니므로 depthTest는 유지, z-fighting 줄이려고 dim 시엔 depthWrite 끔
        mtl.depthWrite = !dim;
        mtl.needsUpdate = true;

        this.requestRender();
    }

    // ▼ 추가: 외부에서 부르는 토글 API
    toggleMaterial(matId) {
        if (this._dimmed.has(matId)) this._dimmed.delete(matId);
        else this._dimmed.add(matId);
        this._applyMaterialDimState_(matId);
        this._syncLegendItem_(matId);
    }

    // ▼ 추가: 명시적 설정 API
    setMaterialDimmed(matId, dimmed) {
        if (dimmed) this._dimmed.add(matId);
        else this._dimmed.delete(matId);
        this._applyMaterialDimState_(matId);
        this._syncLegendItem_(matId);
    }


    // ▼ (옵션) 범례 UI 빌더: 네가 만든 컨테이너 엘리먼트에 항목을 넣고 클릭 연동
    initLegend(legendContainerEl, materialColor) {
        this._legendEl = legendContainerEl;
        if (!this._legendEl) return;
        this._legendEl.innerHTML = '';

        // materialColor: { name: {id, color} } 형태
        Object.entries(materialColor || {}).forEach(([name, info]) => {
            const { id: matId, color } = info;
            const row = document.createElement('div');
            row.className = 'viz-legend-row'; // 스타일은 네가 CSS로
            row.dataset.matId = String(matId);

            // const swatch = document.createElement('span');
            // swatch.className = 'viz-legend-swatch';
            // swatch.style.background = color;
            
            const dot = document.createElement('span');
            dot.className = 'color-dot';
            dot.style.background = color;

            const label = document.createElement('span');
            label.className = 'viz-legend-label';
            label.textContent = name;

            row.appendChild(dot);
            row.appendChild(label);
            this._legendEl.appendChild(row);

            // 클릭 시 토글
            row.addEventListener('click', () => this.toggleMaterial(matId));

            // 초기 상태 반영
            if (this._dimmed.has(matId)) row.classList.add('dimmed');
        });
    }

    // ▼ (옵션) materialColor가 바뀌면 범례 재구성
    rebuildLegend(materialColor) {
        if (!this._legendEl) return;
        this.initLegend(this._legendEl, materialColor);
    }

    // ▼ (옵션) 토글 시 범례 항목 UI 동기화
    _syncLegendItem_(matId) {
        if (!this._legendEl) return;
        const row = this._legendEl.querySelector(`.viz-legend-row[data-mat-id="${matId}"]`);
        if (!row) return;
        if (this._dimmed.has(matId)) row.classList.add('dimmed');
        else row.classList.remove('dimmed');
    }



}


// 부팅
window.addEventListener('DOMContentLoaded', () => {
    const gridRenderer = new GridRenderer('viewer-container-process');

    const legendEl = document.getElementById('viewer-legend'); // 네가 만든 패널 컨테이너
    gridRenderer.initLegend(legendEl, window.prj.processFlow.materialColor);
    
    // // 이후 grid가 갱신되어 materialColor가 바뀌면:
    // gridRenderer.rebuildLegend(materialColor);
    
    // // 코드로 제어하고 싶으면:
    // gridRenderer.setMaterialDimmed(7, true);   // matId=7 투명화
    // gridRenderer.toggleMaterial(7);            // 다시 토글






    window.prj.gridRenderer = gridRenderer;   // 👈 전역 포인터
});
