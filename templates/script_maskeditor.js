/* ========= 메인 클래스 ========= */
class MaskEditor {
  constructor(canvasOrId, opts = {}) {
    const el = (typeof canvasOrId === 'string') ? document.getElementById(canvasOrId) : canvasOrId;
    this.canvas = new fabric.Canvas(el, {
      selection: true,
      preserveObjectStacking: true,
      uniformScaling: false,
      uniScaleKey: 'shiftKey',
    });

    



    this.initialized = false;
    let lateralSize = Number.isFinite(opts.maskWidth) ? opts.maskWidth : 500; 
    let panelWidth = window.innerWidth-650;
    let verticalSize = Number.isFinite(opts.maskHeight) ? opts.maskHeight : 500; 
    let panelHeight = window.innerHeight-60;
    let scale = Math.round(Math.min(panelWidth / lateralSize,panelHeight/verticalSize) * 0.7 * 10)/10;
    this.scale = scale;
    console.log(panelWidth,panelHeight,lateralSize,verticalSize,scale)
    this.maskWidth = Number.isFinite(opts.maskWidth) ? opts.maskWidth : 500; 
    this.maskHeight = Number.isFinite(opts.maskHeight) ? opts.maskHeight : 500;
    this.gridSize = Number.isFinite(opts.gridSize) ? opts.gridSize : 10;
    this.historyMax = Number.isFinite(opts.historyMax) ? opts.historyMax : 100;

    // this.maskWidth = this.maskWidth * this.scale;
    // this.maskHeight = this.maskHeight * this.scale;
    // this.gridSize = this.gridSize * this.scale;



    this.undoStack = [];
    this.redoStack = [];
    this.suppressHistory = false;

    this.clipboard = null;
    this.pasteNudge = this.quantize(10);
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

    this._gridGroup = null;
    this._buildGrid();

    this._bindCanvasEvents();
    this._bindKeyEvents();

    this._selectionChangedListeners = [];
    this._objectModifiedListeners = [];

    this.saveHistory();

    this.canvas.on('selection:created', () => this._emitSelectionChanged());
    this.canvas.on('selection:updated', () => this._emitSelectionChanged());
    this.canvas.on('selection:cleared', () => this._emitSelectionChanged());

  }

  onSelectionChanged(fn) { this._selectionChangedListeners.push(fn); }
  onObjectModified(fn) { this._objectModifiedListeners.push(fn); }
  _emitSelectionChanged() { this._selectionChangedListeners.forEach(fn => fn()); }
  _emitObjectModified() { this._objectModifiedListeners.forEach(fn => fn()); }

  quantize(v) {
    const g = this.gridSize || 1;
    return Math.round(v / g) * g;
  }
  quantizeToStep(v, step) {
    const s = Math.max(1, step || this.gridSize || 1);
    return Math.round(v / s) * s;
  }
  quantizeSize(len) {
    const g = this.gridSize || 1;
    return Math.max(g, Math.round(len / g) * g);
  }
  setDefaultProps(obj) {
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
    } else if (obj.type === 'ellipse') {
      obj.set({ rx: w / 2, ry: h / 2, scaleX: 1, scaleY: 1 });
    } else {
      obj.set({ width: w, height: h, scaleX: 1, scaleY: 1 });
    }
  }
  normalizePosition(obj) {
    obj.set({ left: this.quantize(obj.left), top: this.quantize(obj.top) });
    obj.setCoords();
  }

  initializeCanvas() {

    if (this.initialized) return
    this.initialized = true;
    
    this.resizeCanvas();
    // 2) (cx, cy) 가 화면 중앙으로 오도록 viewport 이동
    const cx = this.maskWidth/2; 
    const cy = this.maskHeight/2;                 // 월드 좌표 기준, 원하는 기준점
    const zoom = this.canvas.getZoom();   // 현재 줌 유지
    const w = this.canvas.getWidth();
    const h = this.canvas.getHeight();    
  
    const vpt = this.canvas.viewportTransform.slice();
    vpt[4] = -cx * zoom + w / 2;  // translateX
    vpt[5] = -cy * zoom + h / 2;  // translateY
    this.canvas.setViewportTransform(vpt);
    this.canvas.zoomToPoint({x:w/2,y:h/2},this.scale);

  }

  resizeCanvas() {
    const container = document.getElementById("viewer-container-mask");
    const rect = container.getBoundingClientRect();
  
    const vpt = this.canvas.viewportTransform.slice();
    const zoom = this.canvas.getZoom();
  
    // 1️⃣ 리사이즈 전, 현재 화면 중심의 world 좌표 계산
    const oldWidth  = this.canvas.getWidth();
    const oldHeight = this.canvas.getHeight();
    const centerWorldX = (oldWidth  / 2 - vpt[4]) / zoom;
    const centerWorldY = (oldHeight / 2 - vpt[5]) / zoom;
  
    // 2️⃣ 실제 캔버스 크기 갱신
    this.canvas.setWidth(rect.width);
    this.canvas.setHeight(rect.height);
  
    // 3️⃣ 새 크기에서 같은 world 중심을 화면 중앙으로 재배치
    const newVpt = vpt.slice();
    newVpt[4] = -centerWorldX * zoom + rect.width  / 2;
    newVpt[5] = -centerWorldY * zoom + rect.height / 2;
  
    this.canvas.setViewportTransform(newVpt);
    this.canvas.requestRenderAll();
  }
  
  
  
  
  

  /* ===================== Polarity (양각/음각) ===================== */
  _applyPolarityStyle(obj) {
    // positive=rgb(70,70,70), negative=rgb(220,220,220)
    const pol = (obj.data && obj.data.polarity) || 'positive';
    if (pol === 'negative') {
      obj.set({ fill: 'rgb(220,220,220)' });
    } else {
      obj.set({ fill: 'rgb(70,70,70)' });
    }
  }
  setPolarity(obj, polarity = 'positive') {
    if (!obj) return;
    obj.data = obj.data || {};
    obj.data.polarity = polarity;
    this._applyPolarityStyle(obj);
    obj.setCoords();
    this.canvas.requestRenderAll();
    this.saveHistory();
  }
  toggleSelectedPolarity() {
    const o = this.getActiveSingle();
    if (o) { // 단일
      const cur = (o.data && o.data.polarity) || 'positive';
      const next = cur === 'positive' ? 'negative' : 'positive';
      this.setPolarity(o, next);
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
    }
  }
  // alias (이전 HTML에서 호출)
  toggleSelectionPolarity() { this.toggleSelectedPolarity(); }

  /* ===================== Selection helpers ===================== */
  getActiveSingle() {
    const a = this.canvas.getActiveObject();
    if (!a) return null;
    if (a.type === 'activeSelection') return null;
    if (a.name === '__grid__') return null;
    return a;
  }
  readGeom(obj) {
    const { w, h } = this._getEffectiveSize(obj);
    return {
      left: Math.round(obj.left),
      top: Math.round(obj.top),
      width: Math.round(w),
      height: Math.round(h),
    };
  }
  readSelectionGeom() {
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
    const g = this.readGeom(a);
    return { ...g, label: `선택: ${a.type}  |  폴라리티: ${(a.data?.polarity) || 'positive'}` };
  }

  applyInputsToSelection({ left, top, width, height, step }) {
    const a = this.canvas.getActiveObject();
    if (!a) return false;

    const s = Math.max(1, step || this.gridSize);

    if (a.type === 'activeSelection') {
      const curW = Math.max(1, (a.width || 0) * (a.scaleX || 1));
      const curH = Math.max(1, (a.height || 0) * (a.scaleY || 1));
      let L = Number.isFinite(left) ? this.quantizeToStep(left, s) : a.left;
      let T = Number.isFinite(top) ? this.quantizeToStep(top, s) : a.top;
      let W = Number.isFinite(width) ? Math.max(s, this.quantizeToStep(width, s)) : curW;
      let H = Number.isFinite(height) ? Math.max(s, this.quantizeToStep(height, s)) : curH;

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
      this._emitObjectModified();
      return true;
    }

    // 단일
    const o = a;
    const L = Number.isFinite(left) ? this.quantizeToStep(left, s) : o.left;
    const T = Number.isFinite(top) ? this.quantizeToStep(top, s) : o.top;
    const cur = this._getEffectiveSize(o);
    const W = Number.isFinite(width) ? Math.max(s, this.quantizeToStep(width, s)) : cur.w;
    const H = Number.isFinite(height) ? Math.max(s, this.quantizeToStep(height, s)) : cur.h;

    this._bakeSize(o, W, H);
    o.set({ left: L, top: T });
    o.setCoords();

    this.canvas.requestRenderAll();
    this.saveHistory();
    this._emitObjectModified();
    return true;
  }

  /* ===================== 정렬/분배 (다중 선택) ===================== */
  _getSelectionObjects() {
    const a = this.canvas.getActiveObject();
    if (!a || a.type !== 'activeSelection') return [];
    return (a._objects || []).filter(o => o.name !== '__grid__');
  }
  alignSelection(mode) {
    const objs = this._getSelectionObjects();
    if (objs.length < 2) return;

    // 전체 경계
    const lefts = objs.map(o => o.left);
    const tops = objs.map(o => o.top);
    const rights = objs.map(o => o.left + this._getEffectiveSize(o).w);
    const bottoms = objs.map(o => o.top + this._getEffectiveSize(o).h);

    const minL = Math.min(...lefts);
    const maxR = Math.max(...rights);
    const minT = Math.min(...tops);
    const maxB = Math.max(...bottoms);
    const cx = (minL + maxR) / 2;
    const cy = (minT + maxB) / 2;

    objs.forEach(o => {
      const { w, h } = this._getEffectiveSize(o);
      let L = o.left, T = o.top;
      if (mode === 'left') L = minL;
      if (mode === 'hcenter') L = cx - w / 2;
      if (mode === 'right') L = maxR - w;
      if (mode === 'top') T = minT;
      if (mode === 'vcenter') T = cy - h / 2;
      if (mode === 'bottom') T = maxB - h;

      o.set({ left: L, top: T });
      o.setCoords();
    });

    this.canvas.requestRenderAll();
    this.saveHistory();
    this._emitObjectModified();

    // bounding box 갱신
    const sel = this.canvas.getActiveObject();
    if (sel && sel.type === 'activeSelection') {
      sel.addWithUpdate();
      sel.setCoords();
    }
  }
  distributeSelection(axis /* 'h' | 'v' */) {
    const objs = this._getSelectionObjects();
    if (objs.length < 3) return;

    if (axis === 'h') {
      // 좌->우 정렬
      const sorted = objs.slice().sort((a, b) => a.left - b.left);
      const first = sorted[0], last = sorted[sorted.length - 1];
      const firstL = first.left;
      const lastR = last.left + this._getEffectiveSize(last).w;

      // 전체 폭 합
      const widths = sorted.map(o => this._getEffectiveSize(o).w);
      const totalW = widths.reduce((s, v) => s + v, 0);
      const span = lastR - firstL;
      const gap = (span - totalW) / (sorted.length - 1);

      let cursor = firstL;
      sorted.forEach((o, idx) => {
        const w = this._getEffectiveSize(o).w;
        if (idx === 0) {
          cursor += w + gap;
          return; // 첫 번째는 그대로
        }
        if (idx === sorted.length - 1) return; // 마지막은 그대로
        const newL = this.quantize(cursor);
        o.set({ left: newL });
        o.setCoords();
        cursor += w + gap;
      });
    } else if (axis === 'v') {
      // 상->하 정렬
      const sorted = objs.slice().sort((a, b) => a.top - b.top);
      const first = sorted[0], last = sorted[sorted.length - 1];
      const firstT = first.top;
      const lastB = last.top + this._getEffectiveSize(last).h;

      // 전체 높이 합
      const heights = sorted.map(o => this._getEffectiveSize(o).h);
      const totalH = heights.reduce((s, v) => s + v, 0);
      const span = lastB - firstT;
      const gap = (span - totalH) / (sorted.length - 1);

      let cursor = firstT;
      sorted.forEach((o, idx) => {
        const h = this._getEffectiveSize(o).h;
        if (idx === 0) {
          cursor += h + gap;
          return; // 첫 번째는 그대로
        }
        if (idx === sorted.length - 1) return; // 마지막은 그대로
        const newT = this.quantize(cursor);
        o.set({ top: newT });
        o.setCoords();
        cursor += h + gap;
      });
    }

    this.canvas.requestRenderAll();
    this.saveHistory();
    this._emitObjectModified();

    // bounding box 갱신
    const sel = this.canvas.getActiveObject();
    if (sel && sel.type === 'activeSelection') {
      sel.addWithUpdate();
      sel.setCoords();
    }
  }


  /* ===================== Modify finalize ===================== */
  _finalizeAfterModify(obj) {
    if (!obj) return;

    if (obj.type === 'activeSelection') {
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
      sel.setCoords();
      this.canvas.requestRenderAll();
      return;
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
    const L0 = this.quantize(obj.left);
    const T0 = this.quantize(obj.top);
    const { w: W0, h: H0 } = this._getEffectiveSize(obj);
    let W = this.quantizeSize(W0);
    let H = this.quantizeSize(H0);

    const R = this.quantize(L0 + W);
    const B = this.quantize(T0 + H);
    W = Math.max(this.gridSize, R - L0);
    H = Math.max(this.gridSize, B - T0);

    this._bakeSize(obj, W, H);
    obj.set({ left: L0, top: T0 });
    obj.setCoords();
  }

  /* ===================== Grid ===================== */
  _buildGridGroupObj() {
    // const w = this.canvas.getWidth();
    // const h = this.canvas.getHeight();
    const w = this.maskWidth;
    const h = this.maskHeight;
    
    const g = this.gridSize;

    let strokeWidth = [0.5/this.scale, 0.1/this.scale];

    const lines = [];
    let Nstroke = 0
    for (let x = 0; x <= w; x += g) {
      lines.push(new fabric.Line([x, 0, x, h], {
        stroke: '#e0e0e0',
        strokeWidth: (Nstroke === 0) ? strokeWidth[0] : strokeWidth[1],
        selectable: false, evented: false, hoverCursor: 'default'
      }));
      Nstroke += 1;
      if (Nstroke === 5) Nstroke = 0;
    }
    Nstroke = 0
    for (let y = 0; y <= h; y += g) {
      lines.push(new fabric.Line([0, y, w, y], {
        stroke: '#e0e0e0',
        strokeWidth: (Nstroke === 0) ? strokeWidth[0] : strokeWidth[1],
        selectable: false, evented: false, hoverCursor: 'default'
      }));
      Nstroke += 1;
      if (Nstroke === 5) Nstroke = 0;
    }
    return new fabric.Group(lines, {
      selectable: false, evented: false, hoverCursor: 'default',
      excludeFromExport: true, name: '__grid__'
    });
  }
  _buildGrid() {
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
  _ensureGrid() {
    const exists = this.canvas.getObjects().some(o => o === this._gridGroup && o.name === '__grid__');
    if (!exists || !this._gridGroup) this._buildGrid();
    else this.canvas.sendToBack(this._gridGroup);
  }
  setGridSize(g) {
    this.gridSize = Math.max(1, Math.round(g || 1));
    this._buildGrid();
  }

  /* ===================== History ===================== */
  _userJSON() { return this.canvas.toJSON(['excludeFromExport', 'name', 'data']); }
  saveHistory() {
    if (this.suppressHistory) return;
    const jsonStr = JSON.stringify(this._userJSON());
    const last = this.undoStack[this.undoStack.length - 1];
    if (last === jsonStr) return;
    this.undoStack.push(jsonStr);
    if (this.undoStack.length > this.historyMax) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  _loadFromJSONString(jsonStr) {
    this.suppressHistory = true;
    this.canvas.loadFromJSON(jsonStr, () => {
      this.canvas.getObjects().forEach(o => { if (!o.excludeFromExport) this.setDefaultProps(o); });
      this._ensureGrid();
      this.canvas.renderAll();
      this.suppressHistory = false;
    });
  }
  undo() {
    if (this.undoStack.length <= 1) return;
    const state = this.undoStack.pop();
    this.redoStack.push(state);
    const prev = this.undoStack[this.undoStack.length - 1];
    this._loadFromJSONString(prev);
  }
  redo() {
    if (!this.redoStack.length) return;
    const state = this.redoStack.pop();
    this.undoStack.push(state);
    this._loadFromJSONString(state);
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

  /* ===================== Keyboard ===================== */
  _bindKeyEvents() {
    document.addEventListener('keydown', (e) => {
      if (window.SIMULOBJET.activePanel !== 'mask-panel') return;
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
          this.deleteSelection();
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
          obj.set({ left: this.quantize(obj.left + dx), top: this.quantize(obj.top + dy) });
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
      if (window.SIMULOBJET.activePanel !== 'mask-panel') return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        this.saveHistory();
        this._emitObjectModified();
      }
    });
  }

  deleteSelection() {
    const objs = this.canvas.getActiveObjects();
    if (!objs || !objs.length) return;
    this.suppressHistory = true;
    objs.forEach(o => this.canvas.remove(o));
    this.suppressHistory = false;
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    this.saveHistory();
    this._emitSelectionChanged();
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
      this._finalizeAfterModify(e.target);
      this.saveHistory();
      this._emitObjectModified();
    });

    this.canvas.on('object:added', (e) => {
      if (!this.suppressHistory && !e.target?.excludeFromExport) this.saveHistory();
    });
    this.canvas.on('object:removed', (e) => {
      if (!this.suppressHistory && !e.target?.excludeFromExport) this.saveHistory();
    });

    this.canvas.on('mouse:move', (e) => {
      if (window.SIMULOBJET.activePanel !== 'mask-panel') return;

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

      if (!this._ctrlDragActive && t) this.normalizePosition(t);

      if (!this._ctrlDragActive || !this.ghostObjects) return;
      const p = this.canvas.getPointer(e.e);
      const off = this._ctrlPointerOffset || { dx: 0, dy: 0 };
      const baseL = this.quantize(p.x - off.dx);
      const baseT = this.quantize(p.y - off.dy);

      for (let i = 0; i < this.ghostObjects.length; i++) {
        const g = this.ghostObjects[i];
        const d = this.ghostDeltas[i];
        const absX = this.quantize(baseL + d.dx);
        const absY = this.quantize(baseT + d.dy);
        g.setPositionByOrigin(new fabric.Point(absX, absY), 'left', 'top');
        g.setCoords();
      }
      this.canvas.requestRenderAll();
    });

    this.canvas.on('mouse:up', () => {
      if (window.SIMULOBJET.activePanel !== 'mask-panel') return;
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
          this.setDefaultProps(g);
          this._finalizeAfterModify(g);
          return g;
        });
        this.suppressHistory = false;

        this.ghostObjects = null;
        this.ghostDeltas = null;

        if (committed.length > 1) {
          const sel = new fabric.ActiveSelection(committed, { canvas: this.canvas });
          this.canvas.setActiveObject(sel);
        } else if (committed.length === 1) {
          this.canvas.setActiveObject(committed[0]);
        }
        this.canvas.requestRenderAll();
        this.saveHistory();
        this._emitSelectionChanged();
      }

      this._ctrlDragActive = false;
      this._ctrlPointerOffset = { dx: 0, dy: 0 };
      this._dragStartPointer = null;
    });

    this.canvas.on('mouse:wheel', (opt) => {
      if (window.SIMULOBJET.activePanel !== 'mask-panel') return;
      const delta = opt.e.deltaY;
      let zoom = this.canvas.getZoom();

      zoom *= 0.999 ** delta; // 스무스한 줌 비율
      zoom = Math.min(Math.max(zoom, 0.2*this.scale), 5*this.scale); // 0.1~10배 사이 제한

      this.canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
      opt.e.preventDefault();
      opt.e.stopPropagation();

    });



    window.addEventListener('resize', () => {
      this.resizeCanvas();
    });


  }

  _startCtrlDrag(srcList, domEvent) {
    const startLs = srcList.map(o => (this._dragStartPos.get(o)?.left ?? o.left));
    const startTs = srcList.map(o => (this._dragStartPos.get(o)?.top ?? o.top));
    const refL = Math.min(...startLs);
    const refT = Math.min(...startTs);
    this._ctrlRef = { refL, refT };

    const pStart = this._dragStartPointer || this.canvas.getPointer(domEvent);
    this._ctrlPointerOffset = { dx: pStart.x - refL, dy: pStart.y - refT };

    this._ctrlDragActive = true;
    this._ctrlDragSources = srcList.slice();
    this._ctrlDragOrigPos.clear();
    this._ctrlDragSources.forEach(o => {
      this._ctrlDragOrigPos.set(o, { left: this.quantize(o.left), top: this.quantize(o.top) });
      o.lockMovementX = true; o.lockMovementY = true;
    });
    this.canvas.discardActiveObject();

    const deltas = srcList.map(o => {
      const st = this._dragStartPos.get(o) || { left: o.left, top: o.top };
      return { dx: st.left - refL, dy: st.top - refT };
    });

    const pNow = this.canvas.getPointer(domEvent);
    const baseL = this.quantize(pNow.x - this._ctrlPointerOffset.dx);
    const baseT = this.quantize(pNow.y - this._ctrlPointerOffset.dy);

    const clones = [];
    (async () => {
      for (let i = 0; i < srcList.length; i++) {
        const obj = srcList[i];
        const clone = await new Promise(resolve => obj.clone(c => resolve(c), ['excludeFromExport', 'name', 'data']));
        const d = deltas[i];

        clone.set({
          opacity: 0.45, selectable: false, evented: false, hoverCursor: 'default',
          excludeFromExport: true
        });

        const absX = this.quantize(baseL + d.dx);
        const absY = this.quantize(baseT + d.dy);
        clone.setPositionByOrigin(new fabric.Point(absX, absY), 'left', 'top');
        clone.setCoords();

        this._applyPolarityStyle(clone);

        this.suppressHistory = true;
        this.canvas.add(clone);
        this.suppressHistory = false;
        clones.push(clone);
      }
      this.ghostObjects = clones;
      this.ghostDeltas = deltas;
      this.ghostObjects.forEach(g => this.canvas.bringToFront(g));
      this.canvas.requestRenderAll();
    })();
  }

  /* ===================== Copy / Paste / Cut ===================== */
  _getAbsLT(o) {
    if (o.group) {
      return {
        x: o.group.left + o.left + o.group.width / 2,
        y: o.group.top + o.top + o.group.height / 2
      };
    }
    return { x: o.left, y: o.top };
  }
  _buildCopyBundle(objs) {
    const bundle = { jsons: [], absLT: [] };
    objs.forEach(o => {
      bundle.jsons.push(o.toObject(['data', 'name']));
      const abs = this._getAbsLT(o);
      bundle.absLT.push({ x: abs.x, y: abs.y });
    });
    return bundle;
  }
  copy() {
    const objs = this.canvas.getActiveObjects();
    if (!objs || !objs.length) return;
    this.clipboard = this._buildCopyBundle(objs);
    this._pasteCount = 0;
  }
  async paste() {
    if (!this.clipboard) return;
    const step = this.pasteNudge * (this._pasteCount + 1);
    const clones = await new Promise(resolve =>
      fabric.util.enlivenObjects(this.clipboard.jsons, resolve)
    );

    this.canvas.discardActiveObject();
    this.suppressHistory = true;

    const added = [];
    clones.forEach((c, i) => {
      const baseX = this.quantize(this.clipboard.absLT[i].x + step);
      const baseY = this.quantize(this.clipboard.absLT[i].y + step);

      const { w, h } = this._getEffectiveSize(c);
      const W = this.quantizeSize(w);
      const H = this.quantizeSize(h);
      this.setDefaultProps(c);
      this._bakeSize(c, W, H);

      this._applyPolarityStyle(c);

      c.setPositionByOrigin(new fabric.Point(baseX, baseY), 'left', 'top');
      c.setCoords();

      this.canvas.add(c);
      added.push(c);
    });

    this.suppressHistory = false;

    if (added.length > 1) {
      this.canvas.setActiveObject(new fabric.ActiveSelection(added, { canvas: this.canvas }));
    } else if (added.length === 1) {
      this.canvas.setActiveObject(added[0]);
    }

    this.canvas.requestRenderAll();
    this._pasteCount++;
    this.saveHistory();
    this._emitSelectionChanged();
  }
  cut() {
    const objs = this.canvas.getActiveObjects();
    if (!objs || !objs.length) return;
    this.copy();
    this.suppressHistory = true;
    objs.forEach(o => this.canvas.remove(o));
    this.suppressHistory = false;
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    this.saveHistory();
    this._emitSelectionChanged();
  }

  /* ===================== Shape API ===================== */
  _initPolarityOnCreate(obj, polarity) {
    obj.data = obj.data || {};
    obj.data.polarity = polarity || obj.data.polarity || 'positive';
    this._applyPolarityStyle(obj);
  }

  addRect(opts = {}) {
    const L = this.quantize(opts.left ?? 40);
    const T = this.quantize(opts.top ?? 40);
    const W = this.quantizeSize(opts.width ?? 80);
    const H = this.quantizeSize(opts.height ?? 60);
    const rect = new fabric.Rect({
      left: L, top: T, width: W, height: H,
      fill: opts.fill ?? 'rgb(70,70,70)',
      stroke: opts.stroke ?? '#333',
      strokeWidth: opts.strokeWidth ?? 0.5/this.scale,
      data: { polarity: opts.polarity || 'positive' }
    });
    this.setDefaultProps(rect);
    this._applyPolarityStyle(rect);
    this.canvas.add(rect);
    this.canvas.setActiveObject(rect);
    rect.setCoords();
    this.canvas.requestRenderAll();
  }

  addCircle(opts = {}) {
    const L = this.quantize(opts.left ?? 100);
    const T = this.quantize(opts.top ?? 100);
    const D = this.quantizeSize((opts.radius ?? 30) * 2);
    const c = new fabric.Circle({
      left: L, top: T, radius: D / 2,
      fill: opts.fill ?? 'rgb(70,70,70)',
      stroke: opts.stroke ?? '#333',
      strokeWidth: opts.strokeWidth ?? 0.5/this.scale,
      data: { polarity: opts.polarity || 'positive' }
    });
    this.setDefaultProps(c);
    this._applyPolarityStyle(c);
    this.canvas.add(c);
    this.canvas.setActiveObject(c);
    c.setCoords();
    this.canvas.requestRenderAll();
  }

  addTriangle(opts = {}) {
    const L = this.quantize(opts.left ?? 160);
    const T = this.quantize(opts.top ?? 60);
    const W = this.quantizeSize(opts.width ?? 70);
    const H = this.quantizeSize(opts.height ?? 70);
    const t = new fabric.Triangle({
      left: L, top: T, width: W, height: H,
      fill: opts.fill ?? 'rgb(70,70,70)',
      stroke: opts.stroke ?? '#333',
      strokeWidth: opts.strokeWidth ?? 1.2,
      data: { polarity: opts.polarity || 'positive' }
    });
    this.setDefaultProps(t);
    this._applyPolarityStyle(t);
    this.canvas.add(t);
    this.canvas.setActiveObject(t);
    t.setCoords();
    this.canvas.requestRenderAll();
  }

  /* ===================== Layer ordering ===================== */
  _selectionObjects() {
    const a = this.canvas.getActiveObject();
    if (!a) return [];
    if (a.type === 'activeSelection') return (a._objects || []).filter(o => o.name !== '__grid__');
    if (a.name === '__grid__') return [];
    return [a];
  }
  layerToFront() {
    const objs = this._selectionObjects();
    if (!objs.length) return;
    const byIdx = objs.map(o => ({ o, i: this.canvas.getObjects().indexOf(o) })).sort((a, b) => a.i - b.i);
    byIdx.forEach(({ o }) => this.canvas.bringToFront(o));
    this._ensureGrid();
    this.canvas.requestRenderAll(); this.saveHistory();
  }
  layerToBack() {
    const objs = this._selectionObjects();
    if (!objs.length) return;
    const byIdx = objs.map(o => ({ o, i: this.canvas.getObjects().indexOf(o) })).sort((a, b) => b.i - a.i);
    byIdx.forEach(({ o }) => this.canvas.sendToBack(o));
    this._ensureGrid();
    this.canvas.requestRenderAll(); this.saveHistory();
  }
  layerForward() {
    const objs = this._selectionObjects();
    if (!objs.length) return;
    const byIdxDesc = objs.map(o => ({ o, i: this.canvas.getObjects().indexOf(o) })).sort((a, b) => b.i - a.i);
    byIdxDesc.forEach(({ o }) => this.canvas.bringForward(o));
    this._ensureGrid();
    this.canvas.requestRenderAll(); this.saveHistory();
  }
  layerBackward() {
    const objs = this._selectionObjects();
    if (!objs.length) return;
    const byIdxAsc = objs.map(o => ({ o, i: this.canvas.getObjects().indexOf(o) })).sort((a, b) => a.i - b.i);
    byIdxAsc.forEach(({ o }) => this.canvas.sendBackwards(o));
    this._ensureGrid();
    this.canvas.requestRenderAll(); this.saveHistory();
  }
}

/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
  // 에디터 생성
  let domain = window.SIMULOBJET.processRuntime.domain;
  let opt = {maskWidth:domain.LX, maskHeight:domain.LY, gridSize:domain.dx, historyMax: 100};
  const maskeditor = new MaskEditor('canvas-mask', opt);


  // === UI 바인딩 ===
  const btnAddRect = document.getElementById('btnAddRect');
  const btnAddCircle = document.getElementById('btnAddCircle');
  const inpStep = document.getElementById('inpStep');
  const inpLeft = document.getElementById('inpLeft');
  const inpTop = document.getElementById('inpTop');
  const inpWidth = document.getElementById('inpWidth');
  const inpHeight = document.getElementById('inpHeight');
  const btnTogglePolarity = document.getElementById('btnTogglePolarity');
  const btnToFront = document.getElementById('btnToFront');
  const btnForward = document.getElementById('btnForward');
  const btnBackward = document.getElementById('btnBackward');
  const btnToBack = document.getElementById('btnToBack');
  const selInfo = document.getElementById('selInfo');
  const alignBox = document.getElementById('alignBox');

  const btnAlignLeft = document.getElementById('btnAlignLeft');
  const btnAlignHCenter = document.getElementById('btnAlignHCenter');
  const btnAlignRight = document.getElementById('btnAlignRight');
  const btnAlignTop = document.getElementById('btnAlignTop');
  const btnAlignVCenter = document.getElementById('btnAlignVCenter');
  const btnAlignBottom = document.getElementById('btnAlignBottom');
  const btnDistH = document.getElementById('btnDistH');
  const btnDistV = document.getElementById('btnDistV');


  // 도형 추가 (처음은 양각)
  btnAddRect.onclick = () => maskeditor.addRect({ polarity: 'positive' });
  btnAddCircle.onclick = () => maskeditor.addCircle({ polarity: 'positive' });




  // Step 변경 + (2) input step 동기화
  function syncInputSteps(g) {
    const step = Math.max(1, Math.round(Number(g) || maskeditor.gridSize));
    [inpLeft, inpTop, inpWidth, inpHeight].forEach(el => el.step = String(step));
  }
  inpStep.addEventListener('change', () => {
    const g = Math.max(1, Math.round(Number(inpStep.value) || 10));
    inpStep.value = g;
    maskeditor.setGridSize(g);
    syncInputSteps(g); // 입력 step 동기화
  });

  // 입력 즉시 적용 (change+input → 기존 동작 유지)
  const applyFromInputs = () => {
    maskeditor.applyInputsToSelection({
      left: Number(inpLeft.value),
      top: Number(inpTop.value),
      width: Number(inpWidth.value),
      height: Number(inpHeight.value),
      step: Math.max(1, Number(inpStep.value) || maskeditor.gridSize)
    });
  };
  ['change'].forEach(ev => {
    inpLeft.addEventListener(ev, applyFromInputs);
    inpTop.addEventListener(ev, applyFromInputs);
    inpWidth.addEventListener(ev, applyFromInputs);
    inpHeight.addEventListener(ev, applyFromInputs);
  });

  // 양각/음각 토글 (단일/다중)
  btnTogglePolarity.onclick = () => {
    // (스크립트 내부에 toggleSelectedPolarity + alias 존재)
    maskeditor.toggleSelectionPolarity();
    refreshSelectionUI();
  };

  // 레이어 이동 (단일/다중)
  btnToFront.onclick = () => { maskeditor.layerToFront(); refreshSelectionUI(); };
  btnForward.onclick = () => { maskeditor.layerForward(); refreshSelectionUI(); };
  btnBackward.onclick = () => { maskeditor.layerBackward(); refreshSelectionUI(); };
  btnToBack.onclick = () => { maskeditor.layerToBack(); refreshSelectionUI(); };

  // (1) 정렬/분배 버튼: 다중 선택에서만 사용
  btnAlignLeft.onclick = () => { maskeditor.alignSelection('left'); refreshSelectionUI(); };
  btnAlignHCenter.onclick = () => { maskeditor.alignSelection('hcenter'); refreshSelectionUI(); };
  btnAlignRight.onclick = () => { maskeditor.alignSelection('right'); refreshSelectionUI(); };
  btnAlignTop.onclick = () => { maskeditor.alignSelection('top'); refreshSelectionUI(); };
  btnAlignVCenter.onclick = () => { maskeditor.alignSelection('vcenter'); refreshSelectionUI(); };
  btnAlignBottom.onclick = () => { maskeditor.alignSelection('bottom'); refreshSelectionUI(); };
  btnDistH.onclick = () => { maskeditor.distributeSelection('h'); refreshSelectionUI(); };
  btnDistV.onclick = () => { maskeditor.distributeSelection('v'); refreshSelectionUI(); };

  // 선택 상태 변동 시 UI 갱신
  function refreshSelectionUI() {
    const info = maskeditor.readSelectionGeom();
    // 다중 선택 여부에 따라 정렬/분배 UI 표시
    const a = maskeditor.canvas.getActiveObject && maskeditor.canvas.getActiveObject();
    const multi = !!(a && a.type === 'activeSelection' && (a._objects?.length || 0) >= 2);
    alignBox.style.display = multi ? 'flex' : 'none';

    if (!info) {
      selInfo.textContent = '선택된 도형이 없습니다.';
      inpLeft.value = ''; inpTop.value = ''; inpWidth.value = ''; inpHeight.value = '';
      return;
    }
    inpLeft.value = info.left;
    inpTop.value = info.top;
    inpWidth.value = info.width;
    inpHeight.value = info.height;
    selInfo.textContent = info.label;
  }

  // 에디터 콜백
  maskeditor.onSelectionChanged(refreshSelectionUI);
  maskeditor.onObjectModified(refreshSelectionUI);

  // 초기 step 동기화
  inpStep.value = maskeditor.gridSize;
  syncInputSteps(maskeditor.gridSize);

  window.SIMULOBJET.maskeditor = maskeditor;   // 👈 전역 포인터
  
});
