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
            if (window.prj.projectManager.currentTab !== 'maskeditor-panel') return;
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

            this._ctrlDragActive = false;
            this._ctrlPointerOffset = { dx: 0, dy: 0 };
            this._dragStartPointer = null;
        });

        this.canvas.on('mouse:wheel', (opt) => {
            if (window.prj.projectManager.currentTab !== 'maskeditor-panel') return;
            if (!document.getElementById("maskeditor-main-maskeditor").classList.contains('active')) return;
            const delta = opt.e.deltaY;
            let zoom = this.canvas.getZoom();

            zoom *= 0.999 ** delta; // 스무스한 줌 비율
            zoom = Math.min(Math.max(zoom, 0.2 * this.scale), 5 * this.scale); // 0.1~10배 사이 제한

            this.canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
            opt.e.preventDefault();
            opt.e.stopPropagation();
        });


        window.addEventListener('resize', () => {
            this._resizeCanvas();
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
            this._ctrlDragOrigPos.set(o, { left: this._quantize(o.left), top: this._quantize(o.top) });
            o.lockMovementX = true; o.lockMovementY = true;
        });
        this.canvas.discardActiveObject();

        const deltas = srcList.map(o => {
            const st = this._dragStartPos.get(o) || { left: o.left, top: o.top };
            return { dx: st.left - refL, dy: st.top - refT };
        });

        const pNow = this.canvas.getPointer(domEvent);
        const baseL = this._quantize(pNow.x - this._ctrlPointerOffset.dx);
        const baseT = this._quantize(pNow.y - this._ctrlPointerOffset.dy);

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

                const absX = this._quantize(baseL + d.dx);
                const absY = this._quantize(baseT + d.dy);
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

    /* ===================== Copy / Paste / Cut / Delete ===================== */
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
            const baseX = this._quantize(this.clipboard.absLT[i].x + step);
            const baseY = this._quantize(this.clipboard.absLT[i].y + step);

            const { w, h } = this._getEffectiveSize(c);
            const W = this._quantizeSize(w);
            const H = this._quantizeSize(h);
            this._setDefaultProps(c);
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
        this._refreshSelectionUI();
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
        this._refreshSelectionUI();
    }

    _deleteSelection() {
        const objs = this.canvas.getActiveObjects();
        if (!objs || !objs.length) return;
        this.suppressHistory = true;
        objs.forEach(o => this.canvas.remove(o));
        this.suppressHistory = false;
        this.canvas.discardActiveObject();
        this.canvas.requestRenderAll();
        this.saveHistory();
        this._refreshSelectionUI();
    }

    _buildCopyBundle(objs) {
        function _getAbsLT(o) {
            if (o.group) {
                return {
                    x: o.group.left + o.left + o.group.width / 2,
                    y: o.group.top + o.top + o.group.height / 2
                };
            }
            return { x: o.left, y: o.top };
        }
        const bundle = { jsons: [], absLT: [] };

        objs.forEach(o => {
            bundle.jsons.push(o.toObject(['data', 'name']));
            const abs = _getAbsLT(o);
            bundle.absLT.push({ x: abs.x, y: abs.y });
        });
        return bundle;
    }


    /* ===================== binding Button Event ===================== */
    _bindUIEvents() {

        // === UI 바인딩 ===
        const btnMaskList = document.getElementById('maskeditor-list');
        const btnSave = document.getElementById('maskeditor-save');
        const btnSaveAs = document.getElementById('maskeditor-saveas');
        const inpName = document.getElementById('inpMaskName');
        const btnAddRect = document.getElementById('btnAddRect');
        const btnAddCircle = document.getElementById('btnAddCircle');
        const btnAddFreeform = document.getElementById('btnAddFreeform');
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
        const editShapeBox = document.getElementById('maskeditor-editShapeBox');
        const alignBox = document.getElementById('maskeditor-alignBox');


        const btnAlignLeft = document.getElementById('btnAlignLeft');
        const btnAlignHCenter = document.getElementById('btnAlignHCenter');
        const btnAlignRight = document.getElementById('btnAlignRight');
        const btnAlignTop = document.getElementById('btnAlignTop');
        const btnAlignVCenter = document.getElementById('btnAlignVCenter');
        const btnAlignBottom = document.getElementById('btnAlignBottom');
        const btnDistH = document.getElementById('btnDistH');
        const btnDistV = document.getElementById('btnDistV');

        btnMaskList.onclick = () => this.backToList();
        btnSave.onclick = () => this.saveData('save');
        btnSaveAs.onclick = () => this.saveData('saveas');
        inpName.onchange = () => this._renameMask();

        // 도형 추가 (처음은 양각)
        btnAddRect.onclick = () => this.addRect({ polarity: 'positive' });
        btnAddCircle.onclick = () => this.addCircle({ polarity: 'positive' });
        btnAddFreeform.onclick = () => this.addPolygon({ polarity: 'positive' });


        // Step 변경 + (2) input step 동기화
        inpStep.addEventListener('change', () => {
            const g = Math.max(1, Math.round(Number(inpStep.value) || 10));
            inpStep.value = g;
            this.gridSize = Math.max(1, Math.round(g || 1));
            this.buildGrid();
            this._syncInputSteps(g); // 입력 step 동기화
        });

        // 입력 즉시 적용 (change+input → 기존 동작 유지)
        const applyFromInputs = () => {
            this._applyInputsToSelection({
                left: Number(inpLeft.value),
                top: Number(inpTop.value),
                width: Number(inpWidth.value),
                height: Number(inpHeight.value),
                step: Math.max(1, Number(inpStep.value) || this.gridSize)
            });
        };
        ['change'].forEach(ev => {
            inpLeft.addEventListener(ev, applyFromInputs);
            inpTop.addEventListener(ev, applyFromInputs);
            inpWidth.addEventListener(ev, applyFromInputs);
            inpHeight.addEventListener(ev, applyFromInputs);
        });

        // 양각/음각 토글 (단일/다중)
        btnTogglePolarity.onclick = () => this.toggleSelectedPolarity();

        // 레이어 이동 (단일/다중)
        btnToFront.onclick = () => this.layerToFront();
        btnForward.onclick = () => this.layerForward();
        btnBackward.onclick = () => this.layerBackward();
        btnToBack.onclick = () => this.layerToBack();

        // (1) 정렬/분배 버튼: 다중 선택에서만 사용
        btnAlignLeft.onclick = () => this.alignSelection('left');
        btnAlignHCenter.onclick = () => this.alignSelection('hcenter');
        btnAlignRight.onclick = () => this.alignSelection('right');
        btnAlignTop.onclick = () => this.alignSelection('top');
        btnAlignVCenter.onclick = () => this.alignSelection('vcenter');
        btnAlignBottom.onclick = () => this.alignSelection('bottom');
        btnDistH.onclick = () => this.distributeSelection('h');
        btnDistV.onclick = () => this.distributeSelection('v');

    }

    /* ===================== Add Shape ===================== */
    _initPolarityOnCreate(obj, polarity) {
        obj.data = obj.data || {};
        obj.data.polarity = polarity || obj.data.polarity || 'positive';
        this._applyPolarityStyle(obj);
    }

    addRect(opts = {}) {
        const L = this._quantize(opts.left ?? 40);
        const T = this._quantize(opts.top ?? 40);
        const W = this._quantizeSize(opts.width ?? 20);
        const H = this._quantizeSize(opts.height ?? 30);
        const rect = new fabric.Rect({
            left: L, top: T, width: W, height: H,
            fill: opts.fill ?? 'rgb(70,70,70)',
            stroke: opts.stroke ?? '#333',
            strokeWidth: opts.strokeWidth ?? 0.5 / this.scale,
            data: { polarity: opts.polarity || 'positive' }
        });
        this._setDefaultProps(rect);
        this._applyPolarityStyle(rect);
        this.canvas.add(rect);
        this.canvas.setActiveObject(rect);
        rect.setCoords();
        this.canvas.requestRenderAll();

        this.saveHistory();

    }

    addCircle(opts = {}) {
        const L = this._quantize(opts.left ?? 100);
        const T = this._quantize(opts.top ?? 100);
        const D = this._quantizeSize((opts.radius ?? 20) * 2);
        const c = new fabric.Circle({
            left: L, top: T, radius: D / 2,
            fill: opts.fill ?? 'rgb(70,70,70)',
            stroke: opts.stroke ?? '#333',
            strokeWidth: opts.strokeWidth ?? 0.5 / this.scale,
            data: { polarity: opts.polarity || 'positive' }
        });
        this._setDefaultProps(c);
        this._applyPolarityStyle(c);
        this.canvas.add(c);
        this.canvas.setActiveObject(c);
        c.setCoords();
        this.canvas.requestRenderAll();

        this.saveHistory();
    }

    addPolygon(opts = {}) {
        const canvas = this.canvas;
        let points = [];
        let tempLine = null;
        let tempPoly = null;
        let isDrawing = true;

        const lineColor = opts.stroke ?? '#00aaff';
        const fillColor = opts.fill ?? 'rgba(0,150,255,0.1)';
        const strokeWidth = opts.strokeWidth ?? 1 / this.scale;
        const closeThreshold = 10 / this.scale;

        const mouseMove = (opt) => {
            if (!isDrawing || points.length === 0) return;
            const pointer = canvas.getPointer(opt.e);

            // --- 미리보기 라인 ---
            if (tempLine) canvas.remove(tempLine);
            const last = points[points.length - 1];
            tempLine = new fabric.Line([last.x, last.y, pointer.x, pointer.y], {
                stroke: lineColor,
                strokeWidth,
                selectable: false,
                evented: false,
            });
            canvas.add(tempLine);

            // --- 미리보기 폴리곤 ---
            const previewPoints = [...points, { x: pointer.x, y: pointer.y }];
            if (tempPoly) canvas.remove(tempPoly);
            tempPoly = new fabric.Polygon(previewPoints, {
                fill: fillColor,
                stroke: lineColor,
                strokeWidth,
                selectable: false,
                evented: false,
            });
            canvas.add(tempPoly);
            canvas.requestRenderAll();
        };

        const mouseDown = (opt) => {
            if (!isDrawing) return;
            const pointer = canvas.getPointer(opt.e);
            const newPoint = { x: pointer.x, y: pointer.y };

            // --- 첫 점 근처 클릭 시 자동 닫기 ---
            if (points.length > 2) {
                const dx = newPoint.x - points[0].x;
                const dy = newPoint.y - points[0].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < closeThreshold) {
                    finishPolygon();
                    return;
                }
            }

            points.push(newPoint);
            canvas.requestRenderAll();
        };

        const keyDown = (e) => {
            if (window.prj.projectManager.currentTab !== 'maskeditor-panel') return;
            if (!document.getElementById("maskeditor-main-maskeditor").classList.contains('active')) return;

            if (e.key === 'Escape') {
                if (points.length >= 3) finishPolygon();
                else cancelPolygon();
            }
        };

        // --- 캔버스 외부 클릭 시 자동 종료 ---
        const docClick = (e) => {
            if (!isDrawing) return;
            const canvasEl = canvas.upperCanvasEl;
            if (!canvasEl.contains(e.target)) {
                cancelPolygon();
                // if (points.length >= 3) finishPolygon();
                // else cancelPolygon();
            }
        };

        const finishPolygon = () => {
            if (points.length < 3) return cancelPolygon();
            isDrawing = false;
            cleanupEvents();

            const polygon = new fabric.Polygon(points, {
                fill: opts.fill ?? 'rgb(70,70,70)',
                stroke: opts.stroke ?? '#333',
                strokeWidth: opts.strokeWidth ?? 0.5 / this.scale,
                data: { polarity: opts.polarity || 'positive' },
            });

            this._setDefaultProps(polygon);
            this._applyPolarityStyle(polygon);
            canvas.add(polygon);
            canvas.setActiveObject(polygon);
            polygon.setCoords();

            if (tempLine) canvas.remove(tempLine);
            if (tempPoly) canvas.remove(tempPoly);

            this.saveHistory();
            canvas.requestRenderAll();
        };

        const cancelPolygon = () => {
            isDrawing = false;
            cleanupEvents();
            if (tempLine) canvas.remove(tempLine);
            if (tempPoly) canvas.remove(tempPoly);
            canvas.requestRenderAll();
        };

        const cleanupEvents = () => {
            canvas.off('mouse:down', mouseDown);
            canvas.off('mouse:move', mouseMove);
            window.removeEventListener('keydown', keyDown);
            document.removeEventListener('mousedown', docClick);
        };

        // --- 이벤트 등록 ---
        canvas.on('mouse:down', mouseDown);
        canvas.on('mouse:move', mouseMove);
        window.addEventListener('keydown', keyDown);
        document.addEventListener('mousedown', docClick);
    }

    addTriangle(opts = {}) {
        const L = this._quantize(opts.left ?? 160);
        const T = this._quantize(opts.top ?? 60);
        const W = this._quantizeSize(opts.width ?? 70);
        const H = this._quantizeSize(opts.height ?? 70);
        const t = new fabric.Triangle({
            left: L, top: T, width: W, height: H,
            fill: opts.fill ?? 'rgb(70,70,70)',
            stroke: opts.stroke ?? '#333',
            strokeWidth: opts.strokeWidth ?? 1.2,
            data: { polarity: opts.polarity || 'positive' }
        });
        this._setDefaultProps(t);
        this._applyPolarityStyle(t);
        this.canvas.add(t);
        this.canvas.setActiveObject(t);
        t.setCoords();
        this.canvas.requestRenderAll();
    }

    /* ===================== Layer ordering / Distribution ===================== */
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
        this.canvas.requestRenderAll();
        this.saveHistory();
        this._refreshSelectionUI();
    }

    layerToBack() {
        const objs = this._selectionObjects();
        if (!objs.length) return;
        const byIdx = objs.map(o => ({ o, i: this.canvas.getObjects().indexOf(o) })).sort((a, b) => b.i - a.i);
        byIdx.forEach(({ o }) => this.canvas.sendToBack(o));
        this._ensureGrid();
        this.canvas.requestRenderAll();
        this.saveHistory();
        this._refreshSelectionUI();
    }

    layerForward() {
        const objs = this._selectionObjects();
        if (!objs.length) return;
        const byIdxDesc = objs.map(o => ({ o, i: this.canvas.getObjects().indexOf(o) })).sort((a, b) => b.i - a.i);
        byIdxDesc.forEach(({ o }) => this.canvas.bringForward(o));
        this._ensureGrid();
        this.canvas.requestRenderAll();
        this.saveHistory();
        this._refreshSelectionUI();
    }

    layerBackward() {
        const objs = this._selectionObjects();
        if (!objs.length) return;
        const byIdxAsc = objs.map(o => ({ o, i: this.canvas.getObjects().indexOf(o) })).sort((a, b) => a.i - b.i);
        byIdxAsc.forEach(({ o }) => this.canvas.sendBackwards(o));
        this._ensureGrid();
        this.canvas.requestRenderAll();
        this.saveHistory();
        this._refreshSelectionUI();
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
        this._refreshSelectionUI();

        // bounding box 갱신
        const sel = this.canvas.getActiveObject();
        if (sel && sel.type === 'activeSelection') {
            sel.addWithUpdate();
            sel.setCoords();
        }

        this._refreshSelectionUI();
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
                const newL = this._quantize(cursor);
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
                const newT = this._quantize(cursor);
                o.set({ top: newT });
                o.setCoords();
                cursor += h + gap;
            });
        }

        this.canvas.requestRenderAll();
        this.saveHistory();
        this._refreshSelectionUI();

        // bounding box 갱신
        const sel = this.canvas.getActiveObject();
        if (sel && sel.type === 'activeSelection') {
            sel.addWithUpdate();
            sel.setCoords();
        }

        this._refreshSelectionUI();

    }

    _getSelectionObjects() {
        const a = this.canvas.getActiveObject();
        if (!a || a.type !== 'activeSelection') return [];
        return (a._objects || []).filter(o => o.name !== '__grid__');
    }
}







// ===========================================================================================
// Mask Manager Class=========================================================================
// ===========================================================================================

class MaskManager {
    constructor() {
        // --- HTML element references ---
        this.container = document.getElementById("maskeditor-main-maskmanager");
        this.maskListContainer = document.getElementById("maskListContainer");

        // --- Control panel buttons ---
        this.btnCreateNewMask = document.getElementById('btnCreateNewMask');
        this.btnEdit = document.getElementById("btnEditMask");
        this.btnCopy = document.getElementById("btnCopyMask");
        this.btnDelete = document.getElementById("btnDeleteMask");

        // --- Mask data list ---
        this.maskeditor = null;
        this.maskList = []; // list of {id,name,data,thumbnail}
        this.selectedMask = null;
        this.btnCreateNewMask.onclick = () => this.createNewMask();

        this.renderMaskList();
    }

    /* --------------------------------------------------
     * UI Rendering
     * -------------------------------------------------- */
    renderMaskList() {
        this.maskListContainer.innerHTML = "";

        let ids = this.maskList.map(x => x['id']);
        if (ids.length === 0) {
            const emptyMsg = document.createElement("div");
            emptyMsg.style.padding = "20px";
            emptyMsg.style.color = "#888";
            emptyMsg.textContent = "No masks available.";
            this.maskListContainer.appendChild(emptyMsg);
            return;
        }


        for (let i = 0; i < this.maskList.length; i++) {
            let maskData = this.maskList[i];
            const maskDiv = document.createElement("div");
            maskDiv.className = "masklist-item";
            maskDiv.id = `maskitem-${maskData.id}`
            maskDiv.innerHTML = `
        <button class="mask-upperbtn mask-upperbtn-copy" title="Copy"><i class="fa-solid fa-copy"></i></button>
        <button class="mask-upperbtn mask-upperbtn-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
        <div class="masklist-thumbnail">
          <img src="${maskData.thumbnail}" alt="${maskData.name}" style="max-width:100%;max-height:100%;">
        </div>
        <div class="masklist-infotext">#${i + 1}. ${maskData.name}</div>
      `;


            // 삭제 버튼
            const deleteBtn = maskDiv.querySelector('.mask-upperbtn-delete');
            deleteBtn.onclick = (e) => {
                e.stopPropagation(); // 카드 클릭 이벤트 차단
                window.prj.customModal.confirm(`Are you sure to delete "${maskData.name}"?`).then(ok => {
                    if (ok) this.deleteMask(maskData.id);
                });
            };

            // copy 버튼
            const copyBtn = maskDiv.querySelector('.mask-upperbtn-copy');
            copyBtn.onclick = (e) => {
                e.stopPropagation(); // 카드 클릭 이벤트 차단
                const oldName = maskData.name + '_copied';
                window.prj.customModal.prompt(`Enter copied mask name:`, oldName).then(newName => {
                    if (newName) this.copyMask(maskData.id, newName);
                });
            };



            // 카드 클릭 시 mask 로드
            maskDiv.onclick = () => this.editMask(maskData.id);
            this.maskListContainer.appendChild(maskDiv);
        }




    }



    /* --------------------------------------------------
     * Button Handlers
     * -------------------------------------------------- */


    createNewMask() {
        const masklistpanel = document.getElementById("maskeditor-main-maskmanager");
        const maskeditorpanel = document.getElementById("maskeditor-main-maskeditor");
        masklistpanel.classList.remove('active');
        maskeditorpanel.classList.add('active');

        let domain = window.prj.processRuntime.domain;
        let opts = { maskWidth: domain.LX, maskHeight: domain.LY, gridSize: domain.dx };
        this.maskeditor.startByNew(opts);

    }

    editMask(selMask) {
        let selectedMask = this.maskList.filter(obj => obj.id === selMask)[0];

        const masklistpanel = document.getElementById("maskeditor-main-maskmanager");
        const maskeditorpanel = document.getElementById("maskeditor-main-maskeditor");
        masklistpanel.classList.remove('active');
        maskeditorpanel.classList.add('active');

        let domain = window.prj.processRuntime.domain;
        let opts = { maskWidth: domain.LX, maskHeight: domain.LY, gridSize: domain.dx };
        this.maskeditor.startBySelected(selectedMask, opts);

    }

    deleteMask(selMask) {
        this.maskList = this.maskList.filter(obj => obj.id !== selMask);
        this.selectedMask = null;
        this.renderMaskList();
        
        const procId = window.prj.processFlow.processes.find(p => p.mask === selMask)?.id
        console.log('de',selMask, procId,window.prj.processFlow.processes)
        window.prj.customModal.alert('Mask Deleted!').then(() => {
            if (procId) {                    
                window.prj.processFlow.checkProcesses();
                window.prj.processFlow.render({ typ: 'maskchange', procId: procId });
            }                
        });
    }

    copyMask(selMask, newName) {
        let copiedMask = structuredClone(this.maskList.filter(obj => obj.id === selMask)[0]);
        copiedMask.id = 'mask' + Date.now().toString().slice(-10);
        copiedMask.name = newName;
        this.maskList.push(copiedMask);
        this.selectedMask = copiedMask.id;
        this.renderMaskList();
    }

    /* --------------------------------------------------
     * Utility
     * -------------------------------------------------- */
    _getUniqueName(baseName) {
        let name = baseName;
        let idx = 1;
        while (this.maskList[name]) {
            name = baseName + "_" + idx++;
        }
        return name;
    }

    /* --------------------------------------------------
     * External Interface (MaskEditor <-> MaskManager)
     * -------------------------------------------------- */
    addNewMask(name, data, thumbnail) {
        this.maskList[name] = {
            data: data,
            thumbnail:
                thumbnail ||
                "https://via.placeholder.com/80x80.png?text=" + encodeURIComponent(name),
        };
        this.renderMaskList();
    }

    updateMask(name, data, thumbnail) {
        if (!this.maskList[name]) return;
        this.maskList[name].data = data;
        if (thumbnail) this.maskList[name].thumbnail = thumbnail;
        this.renderMaskList();
    }

    returnToManager() {
        this.onCloseEditor();
        this.renderMaskList();
    }
}



/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {


    const maskmanager = new MaskManager();



    // 에디터 생성
    const maskeditor = new MaskEditor('canvas-mask');
    maskeditor.maskmanager = maskmanager;
    maskmanager.maskeditor = maskeditor;


    window.prj.maskeditor = maskeditor;   // 👈 전역 포인터
    window.prj.maskmanager = maskmanager;   // 👈 전역 포인터
});
