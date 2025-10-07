
// ===========================================================================================
// Mask Editor Class=========================================================================
// ===========================================================================================
class MaskEditor {
  constructor(canvasOrId) {
    const el = (typeof canvasOrId === 'string')
      ? document.getElementById(canvasOrId)
      : canvasOrId;

    this.canvas = new fabric.Canvas(el, {
      selection: true,
      preserveObjectStacking: true,
      uniformScaling: false,
      uniScaleKey: 'shiftKey',
    });

    this.maskmanager = null;
    this.maskName = '';
    this.id = null;
    this.initialized = false;

    this.historyMax = 100;

    // 이벤트 리스너 바인딩
    this._bindCanvasEvents();
    this._bindKeyEvents();
    this._bindUIEvents();

    this.canvas.on('selection:created', () => this._refreshSelectionUI());
    this.canvas.on('selection:updated', () => this._refreshSelectionUI());
    this.canvas.on('selection:cleared', () => this._refreshSelectionUI());
  }

  /* ================== Start / Save / Exit ================== */
  _resetSessionState() {
    this.maskWidth = null;
    this.maskHeight = null;
    this.gridSize = null;
    this.scale = null;
    this._gridGroup = null;

    this.undoStack = [];
    this.redoStack = [];
    this.suppressHistory = false;
    this.clipboard = null;
    this.pasteNudge = this._quantize(10);
    this._pasteCount = 0;

    this._ctrlDragActive = false;
    this._ctrlDragSources = [];
    this._ctrlDragOrigPos = new Map();
    this.ghostObjects = null;
    this.ghostDeltas = null;
    this._ctrlRef = null;
    this._dragStartPointer = null;
    this._ctrlPointerOffset = { dx: 0, dy: 0 };
    this._isMouseMoving = false;

    this._dragStartSources = [];
    this._dragStartPos = new Map();
    this._dragStartPosition = null;

    this.canvas.clear();
  }

  startByNew(opts = {}) {
    this._resetSessionState();

    this.maskName = opts.name || "Untitled Mask";
    document.getElementById("inpMaskName").value = this.maskName;
    this.id = null;
    this.maskWidth = opts.maskWidth || 200;
    this.maskHeight = opts.maskHeight || 200;
    this.gridSize = opts.gridSize || 10;
    this.scale = this._calcScale(this.maskWidth, this.maskHeight);
    this.buildGrid();

    // 초기 step 동기화
    inpStep.value = this.gridSize;
    this._syncInputSteps(this.gridSize);    
    this.saveHistory();
    this.initialized = false;
    this._initializeCanvas()

    this.isEdited = false;
    this._refreshEditStarStatus();
  }

  startBySelected(data, opts = {}) {
    this._resetSessionState();

    this.maskName = data.name;
    document.getElementById("inpMaskName").value = this.maskName;
    this.id = data.id;
    this.maskWidth = opts.maskWidth || 200;
    this.maskHeight = opts.maskHeight || 200;
    this.gridSize = opts.gridSize || 10;
    this.scale = this._calcScale(this.maskWidth, this.maskHeight);

    if (data.data) {
      this.canvas.loadFromJSON(data.data, () => {
        this.canvas.renderAll();
      });
    }
    this.undoStack = [];
    this.redoStack = [];
    this.buildGrid();

    // 초기 step 동기화
    inpStep.value = this.gridSize;
    this._syncInputSteps(this.gridSize);
    this.saveHistory();
    this.initialized = false;
    this._initializeCanvas()
    
    this.isEdited = false;
    this._refreshEditStarStatus();
  }

  async backToList() {
    let isBackToList = false;
    if (this.isEdited) {
      const result = await window.SIMULOBJET.confirmModal.open("Unsaved mask data will be lost. Continue?");
      if (result) {
        isBackToList = true;
      } else {
        return
      }
    } else {
      isBackToList = true;
    }
    if (isBackToList) {
      const masklistpanel = document.getElementById("maskeditor-main-maskmanager");
      const maskeditorpanel = document.getElementById("maskeditor-main-maskeditor");
      masklistpanel.classList.add('active');
      maskeditorpanel.classList.remove('active');
    }
  }

  saveData() {
    // 1. 전체 canvas 데이터 (그리드 제외)
    const maskname = this.maskName || `New Mask`;
    const jsonData = this.canvas.toJSON(['excludeFromExport', 'name', 'data']);

    // 2. 썸네일 생성 (옵션)
    function createThumbnailFromLogicalRect(canvas, logicalRect, gridGroup, config = {}) {
      const options = {
        format: config.format || 'png',
        quality: config.quality || 0.8,
        multiplier: config.multiplier || 2,
      };

      const vpt = canvas.viewportTransform;
      const zoom = vpt[0];
      const panX = vpt[4];
      const panY = vpt[5];

      options.left = logicalRect.x_start * zoom + panX;
      options.top = logicalRect.y_start * zoom + panY;
      options.width = (logicalRect.x_end - logicalRect.x_start) * zoom;
      options.height = (logicalRect.y_end - logicalRect.y_start) * zoom;

      // ✅ gridGroup 숨기기
      const wasVisible = gridGroup.visible;
      gridGroup.visible = false;

      const dataURL = canvas.toDataURL(options);

      // ✅ 원복
      gridGroup.visible = wasVisible;
      return dataURL;
    }
    const thumbnail = createThumbnailFromLogicalRect(this.canvas, { x_start: 0, x_end: this.maskWidth, y_start: 0, y_end: this.maskHeight }, this._gridGroup);
    let newMaskData;
    if (!this.id) { // new mask mode
      const maskId = 'mask' + Date.now().toString().slice(-10);
      newMaskData = {
        id: maskId,
        name: maskname,
        data: jsonData,
        thumbnail: thumbnail,
      }
      this.maskmanager.maskList.push(newMaskData);
    } else { // edit mask mode
      newMaskData = {
        id: this.id,
        name: maskname,
        data: jsonData,
        thumbnail: thumbnail,
      }
      const index = this.maskmanager.maskList.findIndex(obj => obj.id === this.id);
      if (index !== -1) {
        this.maskmanager.maskList.splice(index, 1, newMaskData);
      }
    }

    this.maskmanager.renderMaskList();
    this.isEdited = false;
    this._refreshEditStarStatus();
    window.SIMULOBJET.processFlow.render();
  }

  
  /* ================== Utils ================== */


  _refreshEditStarStatus() {
    const star = document.getElementById("maskeditor-star-edited");
    if (this.isEdited) star.style.visibility = 'visible';
    else star.style.visibility = 'hidden';
  }

  _calcScale(w, h) {
    const panelWidth = window.innerWidth - 650;
    const panelHeight = window.innerHeight - 60;
    return Math.round(Math.min(panelWidth / w, panelHeight / h) * 0.7 * 10) / 10;
  }

  _renameMask() {
    this.maskName = document.getElementById("inpMaskName").value;
  }

  _quantize(v) {
    const g = this.gridSize || 1;
    return Math.round(v / g) * g;
  }

  _quantizeToStep(v, step) {
    const s = Math.max(1, step || this.gridSize || 1);
    return Math.round(v / s) * s;
  }

  _quantizeSize(len) {
    const g = this.gridSize || 1;
    return Math.max(g, Math.round(len / g) * g);
  }

  _setDefaultProps(obj) {
    obj.set({
      strokeUniform: true,
      objectCaching: false,
      transparentCorners: false,
      cornerColor: '#00c2ff',
      cornerStrokeColor: '#003b57',
      borderColor: '#00c2ff',
      hoverCursor: 'grab',
      moveCursor: 'grabbing',
    });
  }

  _getEffectiveSize(obj) {
    if (obj.type === 'circle') {
      return { w: 2 * obj.radius * (obj.scaleX || 1), h: 2 * obj.radius * (obj.scaleY || 1) };
    } else if (obj.type === 'ellipse') {
      return { w: 2 * obj.rx * (obj.scaleX || 1), h: 2 * obj.ry * (obj.scaleY || 1) };
    }
    return { w: obj.width * (obj.scaleX || 1), h: obj.height * (obj.scaleY || 1) };
  }

  _bakeSize(obj, w, h) {

    if (obj.type === 'circle') {
      if (Math.abs(w - h) < 1e-6) {
        obj.set({ radius: w / 2, scaleX: 1, scaleY: 1 });
      } else {
        const base = obj.radius * 2;
        obj.set({ scaleX: w / base, scaleY: h / base });
      }
    }

    else if (obj.type === 'ellipse') {
      obj.set({ rx: w / 2, ry: h / 2, scaleX: 1, scaleY: 1 });
    }

    else if (obj.type === 'polygon') {
      const pts = obj.points;
      if (!pts || pts.length < 3) return;

      // --- 로컬(points)에서의 기존 bbox ---
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const oldW = maxX - minX;
      const oldH = maxY - minY;
      if (oldW <= 0 || oldH <= 0) return;

      // --- 원하는 w,h로의 스케일 비율 (좌상단 앵커 고정) ---
      const sx = w / oldW;
      const sy = h / oldH;

      const scaled = pts.map(p => ({
        x: (p.x - minX) * sx + minX,
        y: (p.y - minY) * sy + minY
      }));

      // --- 스케일 후 bbox 재계산하여 width/height/pathOffset 갱신 ---
      let nMinX = Infinity, nMinY = Infinity, nMaxX = -Infinity, nMaxY = -Infinity;
      for (const p of scaled) {
        if (p.x < nMinX) nMinX = p.x;
        if (p.x > nMaxX) nMaxX = p.x;
        if (p.y < nMinY) nMinY = p.y;
        if (p.y > nMaxY) nMaxY = p.y;
      }
      const nW = nMaxX - nMinX;
      const nH = nMaxY - nMinY;

      // Fabric 5에서도 동작: pathOffset은 fabric.Point 또는 {x,y} 가능
      obj.set({
        points: scaled,
        width: nW,
        height: nH,
        scaleX: 1,
        scaleY: 1
      });
      obj.pathOffset = new fabric.Point(nMinX + nW / 2, nMinY + nH / 2);

      // 캐시/좌표 갱신
      obj.dirty = true;
      obj.setCoords();
      obj.canvas && obj.canvas.requestRenderAll();
    } else {
      // rect 등 기본 도형
      obj.set({ width: w, height: h, scaleX: 1, scaleY: 1 });
    }
  }

  _syncInputSteps(g) {
    const step = Math.max(1, Math.round(Number(g) || this.gridSize));
    [inpLeft, inpTop, inpWidth, inpHeight].forEach(el => el.step = String(step));
  }

  _initializeCanvas() {

    if (this.initialized) return
    this.initialized = true;

    this._resizeCanvas();
    // 2) (cx, cy) 가 화면 중앙으로 오도록 viewport 이동
    const cx = this.maskWidth / 2;
    const cy = this.maskHeight / 2;                 // 월드 좌표 기준, 원하는 기준점
    const zoom = this.canvas.getZoom();   // 현재 줌 유지
    const w = this.canvas.getWidth();
    const h = this.canvas.getHeight();

    const vpt = this.canvas.viewportTransform.slice();
    vpt[4] = -cx * zoom + w / 2;  // translateX
    vpt[5] = -cy * zoom + h / 2;  // translateY
    this.canvas.setViewportTransform(vpt);
    this.canvas.zoomToPoint({ x: w / 2, y: h / 2 }, this.scale);

  }

  _resizeCanvas() {
    const container = document.getElementById("viewer-container-mask");
    const rect = container.getBoundingClientRect();

    const vpt = this.canvas.viewportTransform.slice();
    const zoom = this.canvas.getZoom();

    // 1️⃣ 리사이즈 전, 현재 화면 중심의 world 좌표 계산
    const oldWidth = this.canvas.getWidth();
    const oldHeight = this.canvas.getHeight();
    const centerWorldX = (oldWidth / 2 - vpt[4]) / zoom;
    const centerWorldY = (oldHeight / 2 - vpt[5]) / zoom;

    // 2️⃣ 실제 캔버스 크기 갱신
    this.canvas.setWidth(rect.width);
    this.canvas.setHeight(rect.height);

    // 3️⃣ 새 크기에서 같은 world 중심을 화면 중앙으로 재배치
    const newVpt = vpt.slice();
    newVpt[4] = -centerWorldX * zoom + rect.width / 2;
    newVpt[5] = -centerWorldY * zoom + rect.height / 2;

    this.canvas.setViewportTransform(newVpt);
    this.canvas.requestRenderAll();
  }

  _refreshSelectionUI() {
    const info = this._readSelectionGeom();
    // 다중 선택 여부에 따라 정렬/분배 UI 표시
    const a = this.canvas.getActiveObject && this.canvas.getActiveObject();
    const editShapeBox = document.getElementById('maskeditor-editShapeBox');
    const alignBox = document.getElementById('maskeditor-alignBox');

    const multi = !!(a && a.type === 'activeSelection' && (a._objects?.length || 0) >= 2);
    editShapeBox.style.display = a ? 'block' : 'none';
    alignBox.style.display = multi ? 'block' : 'none';

    if (!info) {
      // selInfo.textContent = '선택된 도형이 없습니다.';
      inpLeft.value = ''; inpTop.value = ''; inpWidth.value = ''; inpHeight.value = '';
      return;
    }
    inpLeft.value = info.left;
    inpTop.value = info.top;
    inpWidth.value = info.width;
    inpHeight.value = info.height;
    // selInfo.textContent = info.label;
  }

  _getActiveSingle() {
    const a = this.canvas.getActiveObject();
    if (!a) return null;
    if (a.type === 'activeSelection') return null;
    if (a.name === '__grid__') return null;
    return a;
  }

  _readGeom(obj) {
    const { w, h } = this._getEffectiveSize(obj);
    return {
      left: Math.round(obj.left),
      top: Math.round(obj.top),
      width: Math.round(w),
      height: Math.round(h),
    };
  }

  _readSelectionGeom() {
    const a = this.canvas.getActiveObject();
    if (!a) return null;
    if (a.type === 'activeSelection') {
      const W = Math.round((a.width || 0) * (a.scaleX || 1));
      const H = Math.round((a.height || 0) * (a.scaleY || 1));
      return {
        left: Math.round(a.left),
        top: Math.round(a.top),
        width: Math.max(this.gridSize, W),
        height: Math.max(this.gridSize, H),
        label: `다중 선택 (${a._objects?.length || 0}개)`
      };
    }
    const g = this._readGeom(a);
    return { ...g, label: `선택: ${a.type}  |  폴라리티: ${(a.data?.polarity) || 'positive'}` };
  }

  _applyInputsToSelection({ left, top, width, height, step }) {
    const a = this.canvas.getActiveObject();
    if (!a) return false;

    const s = Math.max(1, step || this.gridSize);

    if (a.type === 'activeSelection') {
      const curW = Math.max(1, (a.width || 0) * (a.scaleX || 1));
      const curH = Math.max(1, (a.height || 0) * (a.scaleY || 1));
      let L = Number.isFinite(left) ? this._quantizeToStep(left, s) : a.left;
      let T = Number.isFinite(top) ? this._quantizeToStep(top, s) : a.top;
      let W = Number.isFinite(width) ? Math.max(s, this._quantizeToStep(width, s)) : curW;
      let H = Number.isFinite(height) ? Math.max(s, this._quantizeToStep(height, s)) : curH;

      const sx = curW ? (W / curW) : 1;
      const sy = curH ? (H / curH) : 1;

      a.set({
        left: L,
        top: T,
        scaleX: (a.scaleX || 1) * sx,
        scaleY: (a.scaleY || 1) * sy
      });
      
      this._finalizeAfterModify(a);
      this.canvas.requestRenderAll();
      this.saveHistory();
      this._refreshSelectionUI();
      return true;
    }

    // 단일
    const o = a;
    const L = Number.isFinite(left) ? this._quantizeToStep(left, s) : o.left;
    const T = Number.isFinite(top) ? this._quantizeToStep(top, s) : o.top;
    const cur = this._getEffectiveSize(o);
    const W = Number.isFinite(width) ? Math.max(s, this._quantizeToStep(width, s)) : cur.w;
    const H = Number.isFinite(height) ? Math.max(s, this._quantizeToStep(height, s)) : cur.h;

    this._bakeSize(o, W, H);
    o.set({ left: L, top: T });
    o.setCoords();

    this.canvas.requestRenderAll();
    this.saveHistory();
    this._refreshSelectionUI();
    return true;
  }


  /* ===================== Polarity (양각/음각) ===================== */
  toggleSelectedPolarity() {
    const o = this._getActiveSingle();
    if (o) { // 단일
      const cur = (o.data && o.data.polarity) || 'positive';
      const next = cur === 'positive' ? 'negative' : 'positive';
      this._setPolarity(o, next);
      this.saveHistory();
      return;
    }
    // 다중
    const sel = this.canvas.getActiveObject();
    if (sel && sel.type === 'activeSelection') {
      const objs = sel._objects || [];
      objs.forEach(ch => {
        const cur = (ch.data && ch.data.polarity) || 'positive';
        const next = cur === 'positive' ? 'negative' : 'positive';
        ch.data = ch.data || {};
        ch.data.polarity = next;
        this._applyPolarityStyle(ch);
      });
      this.canvas.requestRenderAll();

      this.saveHistory();
      this._refreshSelectionUI();
    }
  }

  _applyPolarityStyle(obj) {
    // positive=rgb(70,70,70), negative=rgb(220,220,220)
    const pol = (obj.data && obj.data.polarity) || 'positive';
    if (pol === 'negative') {
      obj.set({ fill: 'rgb(220,220,220)' });
    } else {
      obj.set({ fill: 'rgb(70,70,70)' });
    }
  }

  _setPolarity(obj, polarity = 'positive') {
    if (!obj) return;
    obj.data = obj.data || {};
    obj.data.polarity = polarity;
    this._applyPolarityStyle(obj);
    obj.setCoords();
    this.canvas.requestRenderAll();
  }


  /* ===================== Modify finalize ===================== */
  _finalizeAfterModify(obj,typ) {
    if (!obj) return;

    if (obj.type === 'activeSelection') {

      if (typ == 'scale') {
        const sel = obj;
  
        // 1) ActiveSelection → Group (사용자 변형이 그룹에 반영됨)
        const grp = sel.toGroup();
  
        // 2) 그룹 변환을 각 객체로 bake하면서 언그룹
        //    Fabric v5에서 동작: 내부 상태 복원 → 객체들이 캔버스 좌표로 풀림
        const items = grp._objects.slice();       // 레퍼런스 보관
        grp._restoreObjectsState();               // 좌표/스케일/각도 복원(bake)
        this.canvas.remove(grp);
        items.forEach(o => this.canvas.add(o));
  
        // 3) 선택 상태 유지(선택 재구성)
        const newSel = new fabric.ActiveSelection(items, { canvas: this.canvas });
        this.canvas.setActiveObject(newSel);
  
        this.canvas.requestRenderAll();
        return;

      } else {
        const sel = obj; 
        const sX = sel.scaleX || 1, sY = sel.scaleY || 1; 
        sel.forEachObject((ch) => { 
          const { w: ew, h: eh } = this._getEffectiveSize(ch); 
          const newL = ch.left * sX; 
          const newT = ch.top * sY; 
          const newW = Math.max(this.gridSize, ew * sX); 
          const newH = Math.max(this.gridSize, eh * sY); 
          this._bakeSize(ch, newW, newH); 
          ch.set({ left: newL, top: newT }); 
          ch.setCoords(); 
        }); 
        sel.set({ scaleX: 1, scaleY: 1 }); 
        // sel.addWithUpdate(); 
        sel.setCoords(); 
        this.canvas.requestRenderAll(); 
        return;
      }
    }

    // 원을 비등방 스케일한 경우 타원으로 치환
    if (obj.type === 'circle' && Math.abs(obj.scaleX - obj.scaleY) > 1e-6) {
      const L = obj.left, T = obj.top;
      const W = 2 * obj.radius * obj.scaleX;
      const H = 2 * obj.radius * obj.scaleY;
      const idx = this.canvas.getObjects().indexOf(obj);

      const common = {
        fill: obj.fill, stroke: obj.stroke, strokeWidth: obj.strokeWidth,
        opacity: obj.opacity, angle: obj.angle, flipX: obj.flipX, flipY: obj.flipY,
        skewX: obj.skewX, skewY: obj.skewY, globalCompositeOperation: obj.globalCompositeOperation,
        data: obj.data || {}
      };

      const ell = new fabric.Ellipse({
        left: L, top: T, rx: W / 2, ry: H / 2,
        ...common,
        strokeUniform: true, objectCaching: false,
      });

      this.suppressHistory = true;
      this.canvas.remove(obj);
      this.canvas.insertAt(ell, Math.max(0, idx), false);
      this.suppressHistory = false;

      this.canvas.setActiveObject(ell);
      obj = ell;
    }

    // 단일 도형 스냅
    const L0 = this._quantize(obj.left);
    const T0 = this._quantize(obj.top);
    const { w: W0, h: H0 } = this._getEffectiveSize(obj);
    let W = this._quantizeSize(W0);
    let H = this._quantizeSize(H0);

    const R = this._quantize(L0 + W);
    const B = this._quantize(T0 + H);
    W = Math.max(this.gridSize, R - L0);
    H = Math.max(this.gridSize, B - T0);

    this._bakeSize(obj, W, H);
    obj.set({ left: L0, top: T0 });
    obj.setCoords();
  }


  /* ===================== Grid ===================== */
  buildGrid() {
    if (this._gridGroup) {
      this.suppressHistory = true;
      this.canvas.remove(this._gridGroup);
      this.suppressHistory = false;
      this._gridGroup = null;
    }
    const grp = this._buildGridGroupObj();
    this.suppressHistory = true;
    this.canvas.add(grp);
    this.canvas.sendToBack(grp);
    this.suppressHistory = false;
    this._gridGroup = grp;
  }

  _buildGridGroupObj() {
    // const w = this.canvas.getWidth();
    // const h = this.canvas.getHeight();
    const w = this.maskWidth;
    const h = this.maskHeight;
    const g = this.gridSize;

    let strokeWidth = [0.5 / this.scale, 0.1 / this.scale];

    const lines = [];
    let Nstroke = 0

    for (let x = 0; x <= w; x += g) {
      lines.push(new fabric.Line([x, 0, x, h], {
        stroke: '#e0e0e0',
        strokeWidth: (Nstroke === 0) ? strokeWidth[0] : strokeWidth[1],
        selectable: false, evented: false, hoverCursor: 'default',
      }));
      Nstroke += 1;
      if (Nstroke === 5) Nstroke = 0;
    }
    Nstroke = 0
    for (let y = 0; y <= h; y += g) {
      lines.push(new fabric.Line([0, y, w, y], {
        stroke: '#e0e0e0',
        strokeWidth: (Nstroke === 0) ? strokeWidth[0] : strokeWidth[1],
        selectable: false, evented: false, hoverCursor: 'default',
      }));
      Nstroke += 1;
      if (Nstroke === 5) Nstroke = 0;
    }
    return new fabric.Group(lines, {
      selectable: false, evented: false, hoverCursor: 'default',
      excludeFromExport: true, name: '__grid__'
    });
  }

  _ensureGrid() {
    const exists = this.canvas.getObjects().some(o => o === this._gridGroup && o.name === '__grid__');
    if (!exists || !this._gridGroup) this.buildGrid();
    else this.canvas.sendToBack(this._gridGroup);
  }


  /* ===================== History ===================== */
  undo() {
    if (this.undoStack.length <= 1) return;
    const state = this.undoStack.pop();
    this.redoStack.push(state);
    const prev = this.undoStack[this.undoStack.length - 1];
    this._loadFromJSONString(prev);
    if (this.undoStack.length <= 1) {
      this.isEdited = false;
      this._refreshEditStarStatus();
    }
  }

  redo() {
    if (!this.redoStack.length) return;
    const state = this.redoStack.pop();
    this.undoStack.push(state);
    this._loadFromJSONString(state);
  }

  saveHistory() {
    
    if (this.suppressHistory) return;
    const jsonStr = JSON.stringify(this.canvas.toJSON(['excludeFromExport', 'name', 'data']));
    const last = this.undoStack[this.undoStack.length - 1];
    if (last === jsonStr) return;
    this.undoStack.push(jsonStr);
    if (this.undoStack.length > this.historyMax) this.undoStack.shift();
    this.redoStack.length = 0;

    this.isEdited = true;
    this._refreshEditStarStatus();
    
  }

  _loadFromJSONString(jsonStr) {
    this.suppressHistory = true;
    this.canvas.loadFromJSON(jsonStr, () => {
      this.canvas.getObjects().forEach(o => { if (!o.excludeFromExport) this._setDefaultProps(o); });
      this._ensureGrid();
      this.canvas.renderAll();
      this.suppressHistory = false;
    });
  }

  /* ===================== Keyboard ===================== */
  _bindKeyEvents() {
    document.addEventListener('keydown', (e) => {
      if (window.SIMULOBJET.activePanel !== 'maskeditor-panel') return;
      if (!document.getElementById("maskeditor-main-maskeditor").classList.contains('active')) return;

      const meta = e.ctrlKey || e.metaKey;

      if (meta && e.key.toLowerCase() === 'z') { this.undo(); e.preventDefault(); return; }
      if (meta && e.key.toLowerCase() === 'y') { this.redo(); e.preventDefault(); return; }

      if (meta && e.key.toLowerCase() === 'c') { this.copy(); e.preventDefault(); return; }
      if (meta && e.key.toLowerCase() === 'v') { this.paste(); e.preventDefault(); return; }
      if (meta && e.key.toLowerCase() === 'x') { this.cut(); e.preventDefault(); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ae = document.activeElement;
        const tag = ae && ae.tagName ? ae.tagName.toLowerCase() : '';
        if (!['input', 'textarea'].includes(tag) && !ae?.isContentEditable) {
          this._deleteSelection();
          e.preventDefault();
          return;
        }
      }

      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        const active = this.canvas.getActiveObject();
        if (!active) { // 선택된 도형이 없는 경우, canvas shift
          this._shiftCanvasByArrowKeys(e.key);
          return
        };

        const g = this.gridSize || 1;
        const step = (e.shiftKey ? g * 5 : (e.altKey ? Math.max(1, Math.floor(g / 2)) : g));
        let dx = 0, dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        if (e.key === 'ArrowRight') dx = step;
        if (e.key === 'ArrowUp') dy = -step;
        if (e.key === 'ArrowDown') dy = step;

        const moveAbs = (obj) => {
          obj.set({ left: this._quantize(obj.left + dx), top: this._quantize(obj.top + dy) });
          obj.setCoords();
        };

        if (active.type === 'activeSelection') {
          active.forEachObject(o => moveAbs(o));
          active.setCoords();
        } else {
          moveAbs(active);
        }
        this.canvas.requestRenderAll();
        e.preventDefault();
      }
    });

    document.addEventListener('keyup', (e) => {
      if (window.SIMULOBJET.activePanel !== 'maskeditor-panel') return;
      if (!document.getElementById("maskeditor-main-maskeditor").classList.contains('active')) return;

      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        this.saveHistory();
        this._refreshSelectionUI();
      }
    });
  }

  _shiftCanvasByArrowKeys(arrowKey) {
    const vp = this.canvas.viewportTransform.slice();  // 복사
    const zoom = this.canvas.getZoom();
    const step = 20; // zoom 고려 없이 pixel 기준 이동

    switch (arrowKey) {
      case 'ArrowUp':
        vp[5] += step;  // y축 이동 (아래로 증가)
        break;
      case 'ArrowDown':
        vp[5] -= step;
        break;
      case 'ArrowLeft':
        vp[4] += step;
        break;
      case 'ArrowRight':
        vp[4] -= step;
        break;
      default:
        return; // 다른 키는 무시
    }

    // --- boundary 제한 ---
    const rect = this.canvas.calcViewportBoundaries();
    const canvasW = this.canvas.getWidth();
    const canvasH = this.canvas.getHeight();

    // 예: 콘텐츠의 바운딩 범위 계산
    const objs = this.canvas.getObjects();
    if (objs.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      objs.forEach(o => {
        const b = o.getBoundingRect(true, true);
        minX = Math.min(minX, b.left);
        minY = Math.min(minY, b.top);
        maxX = Math.max(maxX, b.left + b.width);
        maxY = Math.max(maxY, b.top + b.height);
      });
      // 현재 zoom 적용된 content 경계
      const contentWidth = (maxX - minX) * zoom;
      const contentHeight = (maxY - minY) * zoom;

      // 허용 이동 범위 계산
      const minTx = -(maxX * zoom) + 0.5 * canvasW;
      const maxTx = -(minX * zoom) + 0.5 * canvasW;
      const minTy = -(maxY * zoom) + 0.5 * canvasH;
      const maxTy = -(minY * zoom) + 0.5 * canvasH;

      vp[4] = Math.min(Math.max(vp[4], minTx), maxTx);
      vp[5] = Math.min(Math.max(vp[5], minTy), maxTy);
    }

    // 적용
    this.canvas.setViewportTransform(vp);
    this.canvas.requestRenderAll();
  }

  /* ===================== Mouse / Ctrl-Drag Copy ===================== */
  _bindCanvasEvents() {
    this.canvas.on('mouse:down', (opt) => {
      const target = opt.target;
      if (!target) return;
      this._dragStartPointer = this.canvas.getPointer(opt.e);
      const actives = this.canvas.getActiveObjects();
      this._dragStartSources = actives.slice();
      this._dragStartPosition = { left: target.left, top: target.top };
    });

    this.canvas.on('object:moving', () => {
      if (this._isMouseMoving) return;
      this._isMouseMoving = true;
    });

    this.canvas.on('object:modified', (e) => {
      this._finalizeAfterModify(e.target,e.action);
      this.saveHistory();
      this._refreshSelectionUI();
    });


    this.canvas.on('mouse:move', (e) => {
      if (window.SIMULOBJET.activePanel !== 'maskeditor-panel') return;
      if (!document.getElementById("maskeditor-main-maskeditor").classList.contains('active')) return;

      const pointer = this.canvas.getPointer(e.e);
      const x = pointer.x;
      const y = pointer.y;
      const coordText = document.getElementById("text-coordi-xy");
      if ((x < 0) | (x > this.maskWidth) | (y < 0) | (y > this.maskHeight)) {
        coordText.innerHTML = ``;
      } else {
        coordText.innerHTML = `X : ${(x).toFixed(0)},  Y : ${(y).toFixed(0)}`;
      }

      if (!this._isMouseMoving) return;
      const t = e.target;

      if (e.e.ctrlKey) {
        if (!this._ctrlDragActive) {
          const p_ori = this._dragStartPosition;
          if (t && p_ori) {
            t.set({ left: p_ori.left, top: p_ori.top });
            t.setCoords();
          }
          const list = this._dragStartSources;
          this._startCtrlDrag(list, e.e);
        }
      } else {
        if (this._ctrlDragActive) {
          if (this.ghostObjects && this.ghostObjects.length) {
            this.suppressHistory = true;
            this.ghostObjects.forEach(g => this.canvas.remove(g));
            this.suppressHistory = false;
          }
          this.ghostObjects = null;
          this.ghostDeltas = null;

          this._ctrlDragSources.forEach(o => { o.lockMovementX = false; o.lockMovementY = false; });
          if (this._ctrlDragSources.length > 1) {
            const sel = new fabric.ActiveSelection(this._ctrlDragSources, { canvas: this.canvas });
            this.canvas.setActiveObject(sel);
          } else if (this._ctrlDragSources.length === 1) {
            this.canvas.setActiveObject(this._ctrlDragSources[0]);
          }

          this._ctrlDragActive = false;
          this._ctrlDragSources = [];
          this._ctrlDragOrigPos.clear();
          this._ctrlPointerOffset = { dx: 0, dy: 0 };

          this.canvas.requestRenderAll();
        }
      }

      if (!this._ctrlDragActive && t) {
        t.set({ left: this._quantize(t.left), top: this._quantize(t.top) });
        t.setCoords();
      }      

      if (!this._ctrlDragActive || !this.ghostObjects) return;
      const p = this.canvas.getPointer(e.e);
      const off = this._ctrlPointerOffset || { dx: 0, dy: 0 };
      const baseL = this._quantize(p.x - off.dx);
      const baseT = this._quantize(p.y - off.dy);

      for (let i = 0; i < this.ghostObjects.length; i++) {
        const g = this.ghostObjects[i];
        const d = this.ghostDeltas[i];
        const absX = this._quantize(baseL + d.dx);
        const absY = this._quantize(baseT + d.dy);
        g.setPositionByOrigin(new fabric.Point(absX, absY), 'left', 'top');
        g.setCoords();
      }
      this.canvas.requestRenderAll();
    });

    this.canvas.on('mouse:up', (opt) => {
      if (window.SIMULOBJET.activePanel !== 'maskeditor-panel') return;
      if (!document.getElementById("maskeditor-main-maskeditor").classList.contains('active')) return;
      this._isMouseMoving = false;
      if (!this._ctrlDragActive) return;

      this._ctrlDragSources.forEach(o => { o.lockMovementX = false; o.lockMovementY = false; });
      this._ctrlDragSources = [];
      this._ctrlDragOrigPos.clear();

      let committed = [];
      if (this.ghostObjects && this.ghostObjects.length) {
        this.suppressHistory = true;
  
        committed = this.ghostObjects.map(g => {
          g.set({ opacity: 1, selectable: true, evented: true, excludeFromExport: false });
          this._setDefaultProps(g);
          this._finalizeAfterModify(g);
          return g;
        });

        this.ghostObjects = null;
        this.ghostDeltas = null;

        if (committed.length > 1) {
          const sel = new fabric.ActiveSelection(committed, { canvas: this.canvas });
          this.canvas.setActiveObject(sel);

        } else if (committed.length === 1) {
          this.canvas.setActiveObject(committed[0]);
        }
        this.canvas.requestRenderAll();
        this.suppressHistory = false;
        this.saveHistory();
        this._refreshSelectionUI();
      }

