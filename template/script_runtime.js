// ===== 3D 렌더러 =====
class GridRenderer {
    constructor(containerId) {
        this.wrap = document.getElementById(containerId);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x12161c);

        const w = this.wrap.clientWidth || 800;
        const h = this.wrap.clientHeight || 600;

        // --- 카메라 ---
        this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 50000);
        this.camera.up.set(0, 0, 1);

        // --- 렌더러 ---
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.wrap.innerHTML = '';
        this.wrap.appendChild(this.renderer.domElement);

        // --- 컨트롤러 ---
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);

        // ============================================================
        // 🔹 조명 세팅 (그림자 없이 깊이감 확보)
        // ============================================================

        // 약한 전역광 (기본 톤)
        const ambient = new THREE.AmbientLight(0x404040, 0.7);
        // (회색톤, intensity=0.4)
        this.scene.add(ambient);

        // 위-아래 자연광 (하늘빛 약하게)
        const hemi = new THREE.HemisphereLight(0xddddff, 0x222233, 0.5);
        hemi.position.set(0, 0, 1000);
        this.scene.add(hemi);

        // 메인 방향광 (부드러운 빛)
        const dir1 = new THREE.DirectionalLight(0xffffff, 0.65);
        dir1.position.set(800, -600, 1200);
        this.scene.add(dir1);

        // 보조 방향광 (살짝만)
        const dir2 = new THREE.DirectionalLight(0xffffff, 0.15);
        dir2.position.set(-600, 800, 800);
        this.scene.add(dir2);
        // ============================================================

        // --- 기타 초기화 ---
        this.xyGrid = null;
        this.ground = null;
        this.inst = {};
        this.boxGeo = null;
        this.maxInstances = 0;

        window.addEventListener('resize', () => this._onResize());
        this._animate();

        // 카메라 초기 위치
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
            const color = new THREE.Color(colorStr.color);
            const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 1 });
            const im = new THREE.InstancedMesh(this.boxGeo, mat, this.maxInstances);
            this.inst[colorStr.id] = im;
            this.scene.add(im);
        }
    }


    updateFromGrid(grid, materialColor) {
        if (!grid) return;

        this._setupDomainHelpers(grid);
        this._ensureInstanced(grid, materialColor);

        const dummy = new THREE.Object3D();
        const counts = {};
        for (const k of Object.keys(this.inst)) counts[k] = 0;

        const { NX, NY, dx, dy, offsetX, offsetY } = grid;
        const { mat, zpair, len } = grid.cols;
        const Lmax = grid.Lmax;

        // === grid iteration ===
        for (let i = 0; i < NX; i++) {
            for (let j = 0; j < NY; j++) {
                const cidx = i * NY + j;
                const layers = len[cidx];
                if (layers === 0) continue;

                const base = cidx * Lmax;
                for (let k = 0; k < layers; k++) {
                    const midx = mat[base + k];
                    if (midx <= 2) continue; // 0=empty, 1=air, 2 = air cavity

                    const zBase = (base + k) * 2;
                    const z0 = grid._dequantizeZ(zpair[zBase]);
                    const z1 = grid._dequantizeZ(zpair[zBase + 1]);
                    const h = z1 - z0;
                    if (h <= 0) continue;

                    // 중심 좌표 계산 (offset 보정)
                    dummy.position.set(offsetX + i * dx, offsetY + j * dy, z0 + h / 2);
                    dummy.scale.set(dx, dy, h);
                    dummy.updateMatrix();

                    const key = midx;
                    if (this.inst[key]) {
                        this.inst[key].setMatrixAt(counts[key]++, dummy.matrix);
                    }
                }
            }
        }

        // === instance 업데이트 ===
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
        const { LX, LY, dx, dy } = this.domain;
        this.grid = new window.prj.ColumnGrid(LX, LY, dx, dy);
        this._gridCache = {};
        this._aldCache = {};

        this.oldUpto = null;
        this.oldGrid = null;


        // 이벤트 수신
        window.addEventListener('simflow:changed', (ev) => {
            const snap = ev.detail;           // { processes, selectBarBoundId, arrowBoundId, ... }
            const opts = snap?.opts ? snap.opts : { typ: 'process', procId: null };
            this._build(snap, opts);
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
        const maskdata = window.prj.maskmanager.maskList.find(mask => mask.id === maskid);
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

    _applyStep(grid, step, useProcCache = false) {

        if ((step.kind === 'NEW') || (['DEPO', 'ALD', 'ETCH', 'WETETCH', 'STRIP'].includes(step.kind) && ((step.material === '-') || (step.material === '')))) return;

        let kind = (step.kind || '').toUpperCase();

        const mat = step.material == 'ALL' ? 255 :
            step.material == '' ? 0 : window.prj.processFlow.materialColor[step.material].id || null;

        const thk = Number(step.thickness || 0);
        const conformality = (typeof step.conformality === 'number') ? step.conformality : 0;
        const maskfun = this._getMaskFun(step.mask)

        if (thk <= 0) return;


        if (kind === 'SUBSTR') {
            grid.deposit_general(maskfun, mat, thk, 0);
        } else if (kind === 'DEPO') {
            grid.deposit_general(maskfun, mat, thk, conformality);
        } else if (kind === 'ALD') {
            let opts = { isCache: useProcCache }
            grid.deposit_ALD(mat, thk, opts);

        } else if (kind === 'ETCH') {
            grid.etch_general(maskfun, mat, thk, conformality);

        } else if (kind === 'WETETCH') {
            let opts = { isCache: false }
            grid.etch_wet(maskfun, mat, thk, opts);

        } else if (kind === 'STRIP') {
            grid.strip_connected(mat);
        } else if (kind === 'CMP') {
            grid.cmp(thk, mat);
        }
    }

    _createGridStepCache(nstep) {
        const nMaxCache = 10;
        while (Object.keys(this.grid.colsCache).length >= nMaxCache) {
            // 제거 대상 후보 key 목록 (keepKey 제외)
            const candidates = Object.entries(this.grid.colsCache)
                .filter(([key]) => key !== keepKey)
                .map(([key, [obj, num]]) => ({ key, num }));
            if (candidates.length === 0) break; // 제거할 게 없음        
            // num이 가장 작은 항목 찾기
            const minItem = candidates.reduce((a, b) => (a.num < b.num ? a : b));
            // 해당 항목 삭제
            delete this.grid.colsCache[minItem.key];
        }

        // cache 생성
        this.grid.colsCache[nstep + 1] = [structuredClone(this.grid.cols), 0];
    }

    _build(snapshot, opts) {

        const processes = snapshot?.processes || [];
        const nSaveInterval = Math.max(3, Math.floor(processes.length / 10)); // sparse cache 조건: 3step 간격 이상, 최대 10개 까지
        const nowIndex = this._arrowGapIndex(processes, snapshot?.arrowBoundId);
        const upto = processes.slice(0, nowIndex);

        for (let step of upto) {
            const cardDiv = window.prj.processFlow.listEl.querySelector(`.processflow-card[data-id="${step.id}"]`);
            if ((step.kind === 'NEW') || (['DEPO', 'ALD', 'ETCH', 'WETETCH', 'STRIP'].includes(step.kind) && ((step.material === '-') || (step.material === '')))) {
                cardDiv.classList.add('card-invalid')
            } else {
                cardDiv.classList.remove('card-invalid')
            }
        }



        this.grid.colsCache = this.grid.colsCache || {};
        const changedProcIndex = this._arrowGapIndex(processes, opts.procId);
        const lastCacheIndex = opts.typ === 'process' ? null :
            opts.typ === 'explorer' ? Math.max(0, Math.max(...Object.keys(this.grid.colsCache).map(Number).filter(k => k <= nowIndex))) :
                Math.max(0, Math.max(...Object.keys(this.grid.colsCache).map(Number).filter(k => k < changedProcIndex)));

        if (opts.typ === 'process') { // 공정 추가/이동/제거 변화: cache 초기화            
            this.grid.initializeCache();
            this.grid.createNewGrid();
        } else { // 나머지: cache 로드            
            this.grid.loadCache(lastCacheIndex);

            // this.grid.cols = structuredClone(this.grid.colsCache[lastCacheIndex][0]);
        }

        // if (this.grid.cols === null) this.grid.clearAll();


        if (opts.typ === 'process') {

            if (this._deepEqual(this.oldUpto, upto)) return;

            let nStepSav = 0;
            for (let nstep = 0; nstep < nowIndex; nstep += 1) {
                let step = processes[nstep];
                nStepSav += 1;
                this._applyStep(this.grid, step, false);
                if (nStepSav === nSaveInterval) {
                    nStepSav = 0;
                    this._createGridStepCache(nstep);
                }
            }

        } else if (opts.typ === 'explorer') {

            if (this._deepEqual(this.oldUpto, upto)) return;

            for (let nstep = lastCacheIndex; nstep < nowIndex; nstep += 1) {
                let step = processes[nstep];
                this._applyStep(this.grid, step, false);
            }

            this.grid.colsCache[lastCacheIndex][1] += 1;

        } else if ((opts.typ === 'inspector') || (opts.typ == 'sliderup')) {

            for (const k in this.grid.colsCache) if (Number(k) > lastCacheIndex) delete this.grid.colsCache[k];

            let nStepSav = 0;
            for (let nstep = lastCacheIndex; nstep < nowIndex; nstep += 1) {
                let step = processes[nstep];
                nStepSav += 1;
                this._applyStep(this.grid, step, false);
                if ((nstep === (changedProcIndex - 2)) || (nStepSav === nSaveInterval)) {
                    nStepSav = 0;
                    this._createGridStepCache(nstep);
                }
            }
            if (this._deepEqual(this.oldUpto, upto)) return;
            this.grid.colsCache[lastCacheIndex][1] += 1;

        } else if (opts.typ === 'sliderdown') {

            for (const k in this.grid.colsCache) if (Number(k) > lastCacheIndex) delete this.grid.colsCache[k];

            for (let nstep = lastCacheIndex; nstep < nowIndex; nstep += 1) {
                let step = processes[nstep];
                this._applyStep(this.grid, step, false);
                if (nstep === (changedProcIndex - 2)) {
                    this._createGridStepCache(nstep);
                }
            }

            if (this._deepEqual(this.oldUpto, upto)) return;

        } else if (opts.typ === 'slidermove') {

            for (let nstep = lastCacheIndex; nstep < nowIndex; nstep += 1) {
                let step = processes[nstep];
                this._applyStep(this.grid, step, true);
            }

        }

        this.oldUpto = upto;
        this.renderer3D.updateFromGrid(this.grid, snapshot?.materialColor || {});

        // let k = [];
        // let k2 = [];
        // let k3 = [];
        // for (let a = 0; a < 10; a++) {
        //     let idxx = this.grid._segIndex(50,50,a)
        //     let idxx2 = this.grid._colIndex(50,50)
        //     // k.push(`mat:${this.grid.cols.mat[idxx]}, z:${this.grid.cols.zpair[idxx*2]}~${this.grid.cols.zpair[idxx*2+1]}`)
        //     if (this.grid.cols.mat[idxx]===0) continue
        //     console.log(`mat:${this.grid.cols.mat[idxx]}, z:${this.grid.cols.zpair[idxx*2]}~${this.grid.cols.zpair[idxx*2+1]}, len:${this.grid.cols.len[idxx2]}`)
        // }

        // console.log(`-----------------------:`)       

    }


    _deepEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
            return false;

        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;

        for (const key of keysA) {
            if (!keysB.includes(key)) return false;
            if (!this._deepEqual(a[key], b[key])) return false;
        }
        return true;
    }
}

// 부팅
window.addEventListener('DOMContentLoaded', () => {
    const runtime = new ProcessRuntime();
    window.prj.processRuntime = runtime;   // 👈 전역 포인터
    const f = window.prj?.processFlow;
    f && window.dispatchEvent(new CustomEvent('simflow:changed', { detail: f._snapshot() }));
});

