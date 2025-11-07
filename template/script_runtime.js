// ===== 3D 렌더러 (VRAM 누수 방지, 인스턴스 용량 관리, 요청형 렌더) =====
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

  _ensureInstanced(materialColor, countsNeeded) {
    this._ensureBoxGeometry();

    // 허용 matId 집합 (표시할 재질만)
    const allowedIds = new Set();
    for (const [, v] of Object.entries(materialColor || {})) {
      allowedIds.add(v.id);
    }

    // 사라진 재질 제거
    for (const k of Object.keys(this.inst)) {
      const id = Number(k);
      if (!allowedIds.has(id)) this._disposeMesh(id);
    }

    // 각 재질별 용량 보장 / 생성 또는 증설
    for (const [, v] of Object.entries(materialColor || {})) {
      const matId = v.id;
      const hex = v.color;
      const need = Math.max(0, countsNeeded[matId] || 0);

      // 현재 용량
      const curCap = this._instCapacity[matId] || 0;
      const has = !!this.inst[matId];

      // 색상만 바뀐 경우
      if (has && hex && this._matColors[matId] !== hex) {
        this.inst[matId].material.color.set(hex);
        this._matColors[matId] = hex;
      }

      // 용량 충분 → 재사용
      if (has && curCap >= need) continue;

      // 새 용량 계산 (여유분 포함, 2의 거듭제곱)
      const target = this._nextPow2(need + this._headroom);

      // 기존 메시 제거 후 재생성 (geometry는 공유)
      if (has) this._disposeMesh(matId);
      const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 1 });
      const imesh = new THREE.InstancedMesh(this.boxGeo, material, Math.max(1, target));
      this.inst[matId] = imesh;
      this._instCapacity[matId] = target;
      this._matColors[matId] = hex;
      this.scene.add(imesh);
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
    if (step.mask === 'deleted') return;

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
      let opts = { isCache: useProcCache }
      grid.etch_wet(mat, thk, opts);
    } else if (kind === 'STRIP') {
      grid.strip_connected(mat);
    } else if (kind === 'CMP') {
      grid.cmp(thk, mat);
    }
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
      } else if ((step.mask === 'deleted') || step.material === 'deleted') {
        cardDiv.classList.add('card-invalid')
      } else {
        cardDiv.classList.remove('card-invalid')
      }
    }



    // this.grid.colsCache = this.grid.colsCache || {};
    const isInitialize = opts.typ === 'process' || opts.typ === 'maskchange';
    const changedProcIndex = this._arrowGapIndex(processes, opts.procId);
    const lastCacheIndex = isInitialize ? null :
      opts.typ === 'explorer' ? Math.max(0, Math.max(...Object.keys(this.grid.colsCache).map(Number).filter(k => k <= nowIndex))) :
        Math.max(0, Math.max(...Object.keys(this.grid.colsCache).map(Number).filter(k => k < changedProcIndex)));


    if (isInitialize) { // 공정 추가/이동/제거 변화: cache 초기화      
      if (opts.typ === 'process' && this._deepEqual(this.oldUpto, upto)) return;
      this.grid.initializeCache();
      this.grid.createNewGrid();
    } else { // 나머지: cache 로드            
      this.grid.loadCache(lastCacheIndex);
    }


    // let ntlqkf = 0
    // console.log('-----------------------')
    // for (let p of processes) {
    //   ntlqkf += 1;
    //   console.log(`step ${ntlqkf}: ${p.kind}`)
    // }



    if (isInitialize) {


      let nStepSav = 0;
      for (let nstep = 0; nstep < nowIndex; nstep += 1) {
        let step = processes[nstep];
        nStepSav += 1;
        this._applyStep(this.grid, step, false);
        if ((nStepSav === nSaveInterval) || (['ALD', 'WETETCH'].includes(step.kind))) {
          nStepSav = 0;
          this.grid.saveCache(nstep);
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
        if ((nstep === (changedProcIndex - 2)) || (nStepSav === nSaveInterval) || (['ALD', 'WETETCH'].includes(step.kind))) {
          nStepSav = 0;
          this.grid.saveCache(nstep);
        }
      }
      if (this._deepEqual(this.oldUpto, upto)) return;
      this.grid.colsCache[lastCacheIndex][1] += 1;

    } else if (opts.typ === 'sliderdown') {
      if (!this.grid.sliderCache.changedProcIndex || this.grid.sliderCache.changedProcIndex !== changedProcIndex) this.grid.sliderCache = { changedProcIndex: changedProcIndex };


      for (const k in this.grid.colsCache) if (Number(k) > lastCacheIndex) delete this.grid.colsCache[k];

      for (let nstep = lastCacheIndex; nstep < nowIndex; nstep += 1) {
        let step = processes[nstep];
        this._applyStep(this.grid, step, false);
        if (nstep === (changedProcIndex - 2)) {
          this.grid.saveCache(nstep);
        }
      }

      if (this._deepEqual(this.oldUpto, upto)) return;

    } else if (opts.typ === 'slidermove') {

      for (let nstep = lastCacheIndex; nstep < nowIndex; nstep += 1) {
        let step = processes[nstep];
        let t0 = performance.now();
        let useCache = changedProcIndex === nstep + 1;
        this._applyStep(this.grid, step, useCache);
      }

    }

    this.oldUpto = upto;
    this.renderer3D.updateFromGrid(this.grid, snapshot?.materialColor || {});





    // // this.grid.identify_cavity()
    // console.log('---------------')        
    // let iy=51;
    // let ix=0;
    // for (let k=0; k<10; k++) {
    //   let idx = this.grid._segIndex(iy,ix,k)
    //   let idxlen = this.grid._colIndex(iy,ix)
    //   let mat = this.grid.cols.mat[idx];
    //   let z0=this.grid.cols.zpair[idx*2];
    //   let z1=this.grid.cols.zpair[idx*2+1];
    //   let len = this.grid.cols.len[idxlen];
    //   if (len==k) break;
    //   console.log(`mat: ${mat}, ${z0}~${z1}nm  |  len ${len}`)
    // }




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
