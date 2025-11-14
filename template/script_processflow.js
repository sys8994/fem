/* ========= utils ========= */
/* ========= 메인 클래스 ========= */
class ProcessFlow {
    constructor() {
        this.listEl = document.getElementById('processflow-component-list'),
            this.addProcBtn = document.getElementById('processflow-addprocess-btn')
        this.addGrpBtn = document.getElementById('processflow-addgroup-btn')
        this.prj = window.prj.projectManager;

        // 상태
        this.processes = [];
        this.selectedIds = new Set();
        this.lastFocusIndex = null;
        this.clipboard = [];
        this.undoStack = [];
        this.redoStack = [];
        this.pastZoneEl = null;

        // 재질 팔레트(요청 사항)
        this.kindIcon = { SUBSTR: '⬜', DEPO: '🧱', ALD: '🧩', ETCH: '⛏️', WETETCH: '⛏️', CMP: '🧽', STRIP: '🧹' };
        this.materialColor = { // Default : 0, Air : 1, air cavity : 2, ALL : 255
            Si: { color: 'rgb(220, 220, 216)', id: 3 },
            Ox: { color: 'rgb(160, 230, 196)', id: 4 },
            Nit: { color: 'rgb(240, 240, 110)', id: 5 }
        };

        // select bar / arrow 바인딩
        // - selectBarBoundId: “직전 카드 id” 개념(카드 사이의 gap 위치를 id로 표현)
        // - arrowBoundId:     “해당 카드까지 적용(포함)” → 카드 id 자체
        this.selectBarBoundId = null;
        this.arrowBoundId = null;   // null이면 아무 것도 적용 안 된 상태

        // 드래그
        this.dragging = false;
        this.dragStartY = 0;
        this.dropGapIndex = null;
        this.dropIndicator = null;
        this.ghostContainer = null;

        // 레일 세로 라인 엘리먼트
        this.railLinePast = null;
        this.railLineFuture = null;

        this._wireGlobalKeys();
        this._wireUI();

    }

    deepClone(o) {
        return JSON.parse(JSON.stringify(o))
    };

    checkProcesses() {
        const maskList = window.prj.maskmanager.maskList.map(obj => obj.id);

        for (let proc of this.processes) {
            if (proc.mask === '' || proc.mask === '-') {
                proc.mask = '';
            } else {
                if (!maskList.includes(proc.mask))
                    proc.mask = 'deleted';
            }
        }
    }

    initiate(snapshot) {

        // 상태 초기화
        this.processes = [];
        this.selectedIds = new Set();
        this.lastFocusIndex = null;
        this.clipboard = [];
        this.undoStack = [];
        this.redoStack = [];
        this.pastZoneEl = null;

        // 초기값
        if (snapshot) this._restore(snapshot);
        else {
            let initialProcess = [{ id: 'p_init0', kind: 'SUBSTR', mask: '-', material: 'Si', thickness: 30, name: 'Substrate' }];
            this._insertAtGap(initialProcess, 0);
        }
        this._commitHistory();

        this.undoStack = [];
        this.redoStack = [];

        // 현재 시점: 두 번째 카드까지 적용 예시
        this.arrowBoundId = this.processes[this.processes.length - 1]?.id || null;

    }


    /* --- 기본 프로세스 생성 --- */
    createDefaultProcess() {
        return {
            id: 'p_' + Math.random().toString(36).slice(2, 9),
            kind: 'NEW',       // SUBSTR | DEPO | ETCH | CMP ...
            mask: '',
            material: '',     // Si | Ox | Nit
            thickness: 10,
            name: '',
        };
    }

    createDefaultGroup(typ) {
        return {
            id: 'g_' + Math.random().toString(36).slice(2, 9),
            kind: typ == 'start' ? 'GROUPSTART' : 'GROUPEND',       // SUBSTR | DEPO | ETCH | CMP ...
            unfolded: false,
            name: 'New Group',
        };
    }

    /* --- 인덱스/바인딩 보조 --- */
    getGapIndexByBoundId(boundId) {
        if (boundId == null) return 0;
        const idx = this.processes.findIndex(p => p.id === boundId);
        return idx < 0 ? 0 : idx + 1;
    }
    getBoundIdByGapIndex(gapIdx) {
        if (gapIdx <= 0) return null;
        const prevIdx = gapIdx - 1;
        return (this.processes[prevIdx] ? this.processes[prevIdx].id : null);
    }

    get selectBarIndex() { return this.getGapIndexByBoundId(this.selectBarBoundId); }

    // ▪ 현재 시점(arrow)은 “카드 기준”으로 본다
    get arrowCardIndex() {
        if (!this.arrowBoundId) return -1;
        return this.processes.findIndex(p => p.id === this.arrowBoundId); // -1 ~ n-1
    }

    /* --- 히스토리 --- */
    _snapshot() {
        this.prj._setEditStarStatus(true);
        const projectName = document.getElementById('project-name');
        return {
            processes: this.deepClone(this.processes),
            selectedIds: Array.from(this.selectedIds),
            selectBarBoundId: this.selectBarBoundId,
            arrowBoundId: this.arrowBoundId,
            lastFocusIndex: this.lastFocusIndex,
            materialColor: this.deepClone(this.materialColor),
            prjname: projectName.innerText,
        };
    }

    _restore(snap) {
        const projectName = document.getElementById('project-name');
        this.processes = this.deepClone(snap.processes);
        this.selectedIds = new Set(snap.selectedIds || []);
        this.selectBarBoundId = snap.selectBarBoundId ?? null;
        this.arrowBoundId = snap.arrowBoundId ?? null;
        this.lastFocusIndex = snap.lastFocusIndex ?? null;
        projectName.innerText = snap.prjname;
        if (snap.materialColor) this.materialColor = this.deepClone(snap.materialColor);

        this.render();
        window.prj.inspector._updateAnyCardMeta()
    }

    _commitHistory() {
        this.undoStack.push(this._snapshot());
        this.redoStack.length = 0;
    }

    undo() {
        if (!this.undoStack.length) return;
        const cur = this._snapshot();
        const prev = this.undoStack.pop();
        this.redoStack.push(cur);
        this._restore(prev);
        if (this.undoStack.length == 0) this.prj._setEditStarStatus(false);
    }

    redo() {
        if (!this.redoStack.length) return;
        const cur = this._snapshot();
        const next = this.redoStack.pop();
        this.undoStack.push(cur);
        this._restore(next);
    }

    _checkIngroup(target = null) {
        const at = target === null ? this.selectBarIndex : target;
        for (let idx = at; idx < this.processes.length; idx++) {
            if (this.processes[idx].kind === 'GROUPSTART') return false;
            else if (this.processes[idx].kind === 'GROUPEND') return true;
        }
        return false;
    }


    /* --- UI 바인딩 --- */
    _wireUI() {


        this.addProcBtn.addEventListener('click', () => {
            this._commitHistory();
            const proc = this.createDefaultProcess();
            const at = this.selectBarIndex;
            this._insertAtGap([proc], at);
            this.selectBarBoundId = proc.id;
            this.render('renderOnly');
        });


        this.addGrpBtn.addEventListener('click', () => {
            if (this._checkIngroup()) return;

            this._commitHistory();
            const at = this.selectBarIndex;
            const proc = this.createDefaultGroup('start');
            const proc2 = this.createDefaultGroup('end');

            this._insertAtGap([proc, proc2], at);
            this.selectBarBoundId = proc.id;

        });





    }
    _wireGlobalKeys() {
        document.addEventListener('keydown', (e) => {
            if (window.prj.projectManager.currentTab !== 'processflow-panel') return;
            const ctrl = e.ctrlKey || e.metaKey;

            // ↑↓ 로 현재시점 arrow 이동 (arrowCardIndex 기준)
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                const isUp = e.key === 'ArrowUp';
                e.preventDefault();
                if (this.processes.length === 0) return;
                let prevIdx = this.arrowCardIndex;   // -1 ~ n-1
                let cardIdx = prevIdx;

                while (true) {
                    if (isUp && (cardIdx <= 0)) {
                        this.arrowBoundId = null;
                        this.render({ typ: 'explorer', procId: '' });
                        break;
                    }
                    if (!isUp && (cardIdx + 1 === this.processes.length)) break;
                    let prevProc = this.processes[cardIdx];

                    // check if in folded group
                    let nextIdx;
                    let isInFoldedGroup = false;
                    if (!prevProc?.kind.startsWith('GROUP')) {
                        for (let idx = cardIdx; idx >= 0; idx--) {
                            if ((this.processes[idx].kind === 'GROUPSTART') && !this.processes[idx].unfolded) { isInFoldedGroup = true; break } // proc in folded group : invalid
                            else if (this.processes[idx].kind === 'GROUPEND') break;
                        }
                        if (isInFoldedGroup && isUp) {
                            for (let idx = cardIdx; idx >= 0; idx--) {
                                if ((this.processes[idx].kind === 'GROUPSTART') && !this.processes[idx].unfolded) { nextIdx = idx - 1; break } // proc in folded group : invalid
                            }
                        } else if (isInFoldedGroup && !isUp) {
                            for (let idx = cardIdx; idx < this.processes.length; idx++) {
                                if ((this.processes[idx].kind === 'GROUPEND') && !this.processes[idx].unfolded) { nextIdx = idx + 1; break } // proc in folded group : invalid
                            }
                        }
                    }
                    if (!isInFoldedGroup) nextIdx = cardIdx + (isUp ? -1 : +1);


                    let newProc = this.processes[nextIdx];

                    // check group shell 
                    if (!newProc.kind.startsWith('GROUP')) {
                        this.arrowBoundId = newProc.id;
                        this.render({ typ: 'explorer', procId: '' });
                        return;
                    } else if (!isUp && (newProc.kind === 'GROUPSTART') && (!newProc.unfolded)) {
                        for (let idx = nextIdx; idx < this.processes.length; idx++) {
                            if (this.processes[idx].kind === 'GROUPEND' && ((idx - 1) > nextIdx)) {
                                newProc = this.processes[idx - 1];
                                this.arrowBoundId = newProc.id;
                                this.render({ typ: 'explorer', procId: '' });
                                return
                            }
                        }
                    }
                    cardIdx = nextIdx;

                }

            }



            // Delete, Ctrl+C/X/V/Z/Y 기존 로직은 그대로...
            if (e.key === 'Delete' && this.selectedIds.size) {
                e.preventDefault();
                this._commitHistory();
                this._deleteSelected();
            }
            if (ctrl && (e.key === 'c' || e.key === 'x' || e.key === 'v')) {
                e.preventDefault();
                if (e.key === 'c') this._copy(false);
                if (e.key === 'x') this._copy(true);
                if (e.key === 'v') this._paste();
            }
            if (ctrl && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
                e.preventDefault();
                if (e.key.toLowerCase() === 'z') this.undo();
                if (e.key.toLowerCase() === 'y') this.redo();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this.selectedIds.clear();
                this.render('renderOnly');
            }


        });
    }


    /* --- 렌더 --- */
    render(opts) {


        const list = this.listEl;
        const prevScroll = list.scrollTop;
        list.innerHTML = '';
        const n = this.processes.length;

        // 세로 레일 라인(배경)
        this.railLinePast = document.createElement('div');
        this.railLinePast.className = 'rail-line past-rail';
        list.appendChild(this.railLinePast);
        this.railLineFuture = document.createElement('div');
        this.railLineFuture.className = 'rail-line future-rail';
        list.appendChild(this.railLineFuture);

        // gap0 - card0 - gap1 ... card n-1 - gap n
        let cardIdxNo = 1;
        let isGroupStart = false;
        let isunfolded = true;
        for (let procIdx = 0; procIdx <= n; procIdx++) {
            const proc = this.processes[procIdx];
            if (procIdx === n) {
                const gapRow = this._makeGapRow(procIdx);   // select bar row
                list.appendChild(gapRow);
            } else if (proc.kind === 'GROUPSTART') {
                isunfolded = proc.unfolded;
                const gapRow = this._makeGapRow(procIdx);   // select bar row
                list.appendChild(gapRow);
                isGroupStart = true;
                const groupRow = this._makeGroupRow(procIdx, cardIdxNo, isunfolded); // card row with rail-dot
                list.appendChild(groupRow);
            } else if (proc.kind === 'GROUPEND') {
                if (isunfolded) {
                    const gapRow = this._makeGapRow(procIdx, true);   // select bar row
                    list.appendChild(gapRow);
                    const groupEndRow = this._makeGroupEndRow(procIdx);   // select bar row
                    list.appendChild(groupEndRow);
                }
                isGroupStart = false;
            } else {
                if (isGroupStart) { //inside group
                    if (!isunfolded) continue;
                    const gapRow = this._makeGapRow(procIdx, true);   // select bar row
                    list.appendChild(gapRow);
                    const cardRow = this._makeCardRow(procIdx, cardIdxNo, true); // card row with rail-dot
                    list.appendChild(cardRow);
                } else { // outside group
                    const gapRow = this._makeGapRow(procIdx);   // select bar row
                    list.appendChild(gapRow);
                    const cardRow = this._makeCardRow(procIdx, cardIdxNo); // card row with rail-dot
                    list.appendChild(cardRow);
                }
                cardIdxNo += 1;
            }
        }

        // past/future + past-zone + rail 라인 길이/위치 보정
        this._updatePastFutureStyles();
        this._updateRailAndPastZone();
        window.prj.inspector.rehydrateAll();

        list.scrollTop = prevScroll;

        // 런타임 갱신 이벤트(색 정보 포함)
        let detail = this._snapshot();
        if (opts === 'renderOnly') return;
        if (opts) {
            detail.opts = opts;
        }
        window.dispatchEvent(new CustomEvent('simflow:changed', { detail: detail }));

    }

    _makeGapRow(gapIdx, isInGroup = false) {
        const gapRow = document.createElement('div');
        gapRow.className = 'gap-row';
        gapRow.dataset.gapIndex = String(gapIdx);

        // rail cell (빈자리 맞춤)
        const railCell = document.createElement('div');
        railCell.className = 'rail-cell';
        gapRow.appendChild(railCell);

        // select bar
        const bar = document.createElement('div');
        bar.className = 'timeline-bar';
        if (isInGroup) bar.classList.add('timeline-bar-ingroup');
        bar.dataset.gapIndex = String(gapIdx);
        if (this.selectBarIndex === gapIdx) bar.classList.add('active-bar');
        bar.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectBarBoundId = this.getBoundIdByGapIndex(gapIdx);
            this.render('renderOnly');
        });

        // 드래그 미리보기
        gapRow.addEventListener('mousemove', () => {
            if (!this.dragging) return;
            this._showDropIndicatorForGap(gapIdx, gapRow);
            this.dropGapIndex = gapIdx;
        });
        gapRow.addEventListener('mouseenter', () => {
            if (!this.dragging) return;
            this._showDropIndicatorForGap(gapIdx, gapRow);
            this.dropGapIndex = gapIdx;
        });

        gapRow.appendChild(bar);
        return gapRow;
    }

    _makeCardRow(procIdx, cardIdxNo, isInGroup = false) {
        const row = document.createElement('div');
        row.className = 'card-row';
        const proc = this.processes[procIdx];

        // rail cell (dot)
        const railCell = document.createElement('div');
        railCell.className = 'rail-cell';
        const dot = document.createElement('div');
        dot.className = 'rail-dot';
        if (this.arrowCardIndex === procIdx) dot.classList.add('active');
        dot.title = '현재 시점(이 카드까지 적용)';
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            this.arrowBoundId = proc.id;    // “이 카드까지”      
            this.render({ typ: 'explorer', procId: '' });
        });
        railCell.appendChild(dot);
        row.appendChild(railCell);

        // 카드 본체
        const cardDiv = document.createElement('div');
        cardDiv.className = 'processflow-component';
        cardDiv.classList.add('processflow-component-card');
        if (isInGroup) cardDiv.classList.add('processflow-component-ingroup');
        cardDiv.dataset.id = proc.id;
        if (this.selectedIds.has(proc.id)) cardDiv.classList.add('selected');

        // invalid card
        if ((proc.kind === 'NEW') || (['DEPO', 'ALD', 'ETCH', 'WETETCH', 'STRIP'].includes(proc.kind) && ((proc.material === '-') || (proc.material === '')))) {
            cardDiv.classList.add('card-invalid')
        } else if ((proc.mask === 'deleted') || proc.material === 'deleted') {
            cardDiv.classList.add('card-invalid')
        } else {
            cardDiv.classList.remove('card-invalid')
        }


        // 좌측: 번호+이름(한 줄) + 속성 칩
        const left = document.createElement('div');
        left.className = 'card-left';

        const label = document.createElement('span');
        label.className = 'proc-label oneline';
        label.textContent = `${cardIdxNo}. ${this.kindIcon[proc.kind] || '⚙️'} ${proc.kind} : ${proc.name}`;


        const meta = document.createElement('span');
        meta.className = 'proc-meta oneline';
        let metaHtml = '';
        if ((proc.material) && (proc.material !== '-')) {
            const clr = this.materialColor[proc.material]?.color || '#ccc';
            if (proc.kind == 'CMP') metaHtml += `<span class="material-circle" style="background:${clr}"></span> ${proc.material} Stopper `;
            else metaHtml += `<span class="material-circle" style="background:${clr}"></span> ${proc.material} `;
        }
        if (proc.mask !== '-' && proc.mask !== '') {
            if (proc.mask !== 'deleted') {
                const maskname = window.prj.maskmanager.maskList.find(mask => mask.id == proc.mask).name;
                metaHtml += `| ${maskname} `;
            } else {
                metaHtml += `| (Deleted Mask) `;
            }
        }
        if (proc.thickness && proc.thickness !== '-') {
            metaHtml += `| ${proc.thickness} nm`;
        }
        if (metaHtml.startsWith('|')) metaHtml = metaHtml.slice(1);
        meta.innerHTML = metaHtml;


        left.append(label, meta);

        const right = document.createElement('div');
        right.className = 'card-right';
        const editBtn = document.createElement('button');
        editBtn.className = 'icon-btn icon-btn-inspectorpanel';
        editBtn.title = 'Edit (inspector)';
        editBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        editBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.prj.inspector.toggle(cardDiv, proc);
        });

        right.appendChild(editBtn);

        cardDiv.append(left, right);
        row.appendChild(cardDiv);

        // 선택 & 드래그
        cardDiv.addEventListener('mousedown', (e) => {
            const id = proc.id;
            const idx = procIdx;
            this.dragStartY = e.clientY;
            let moved = false;   // 마우스가 움직였는지 여부
            this.dragging = false;
            this.isSelectedDragging = this.selectedIds.has(proc.id);

            let dragTarget = this.selectedIds.has(proc.id) ? Array.from(this.selectedIds) : [proc.id]

            // --- mousemove 핸들러 ---
            const onMove = (ev) => {
                const dy = Math.abs(ev.clientY - this.dragStartY);
                if (dy > 3) { // 3px 이상 움직이면 드래그로 간주
                    moved = true;
                    if (!this.dragging) {
                        this.dragging = true;
                        this._ensureDropIndicator();
                        this._startDragGhost(dragTarget, ev.clientX, ev.clientY);
                    }
                    this._moveGhost(ev.clientX, ev.clientY);
                }
            };

            // --- mouseup 핸들러 ---
            const onUp = (ev) => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);

                // 만약 이동이 없었다면 (= 클릭으로 간주)
                if (!moved) {
                    // === 클릭 동작 ===
                    if (e.shiftKey && this.lastFocusIndex != null) {
                        const isArr = Array.isArray(this.lastFocusIndex);
                        let a = Math.min(isArr ? Math.min(...this.lastFocusIndex) : this.lastFocusIndex, idx);
                        let b = Math.max(isArr ? Math.max(...this.lastFocusIndex) : this.lastFocusIndex, idx);


                        for (let idx = a; idx >= 0; idx--) {
                            if (this.processes[idx].kind === 'GROUPSTART') { a = idx; break; }
                            else if (this.processes[idx].kind === 'GROUPEND') break;
                        }

                        for (let idx = b; idx < this.processes.length; idx++) {
                            if (this.processes[idx].kind === 'GROUPEND') { b = idx; break; }
                            else if (this.processes[idx].kind === 'GROUPSTART') break;
                        }


                        this.selectedIds.clear();
                        for (let i = a; i <= b; i++) this.selectedIds.add(this.processes[i].id);
                    } else if (e.ctrlKey || e.metaKey) {
                        if (this.selectedIds.has(id)) this.selectedIds.delete(id);
                        else this.selectedIds.add(id);
                    } else {
                        this.selectedIds.clear();
                        this.selectedIds.add(id);
                    }
                    this.lastFocusIndex = idx;

                    this.render('renderOnly');
                }
                // === 드래그 종료 ===
                else {
                    this._removeGhost();
                    if (this.dragging) {
                        this.dragging = false;
                        this._hideDropIndicator();
                        if (this.dropGapIndex != null) {
                            this._commitHistory();
                            this._moveSelectedToGap(dragTarget, this.dropGapIndex);
                        }
                        this.dropGapIndex = null;
                    }
                }
            };

            // --- 이벤트 등록 ---
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });






        if (window.prj.inspector.expandedIds.has(proc.id) && !cardDiv.querySelector('.inspector-panel')) {
            window.prj.inspector._ensurePanelImmediate(cardDiv, proc);
        }

        return row;
    }

    _makeGroupRow(procIdx, cardIdxNo) {
        const row = document.createElement('div');
        row.className = 'card-row';
        const procGroup = this.processes[procIdx];
        const isunfolded = procGroup.unfolded;


        let nInner = 0;
        let ids = [procGroup.id];
        let idxs = [procIdx];
        let procGroupEndId;

        for (let p = procIdx + 1; p <= this.processes.length; p++) {
            const proc = this.processes[p];
            ids.push(proc.id);
            idxs.push(p);
            if (proc.kind === 'GROUPEND') {
                procGroupEndId = proc.id;
                break
            };
            nInner += 1;
        }
        let procIdx2 = procIdx + nInner + 1;

        // rail cell (dot)
        const railCell = document.createElement('div');
        railCell.className = 'rail-cell';
        if (!isunfolded && (nInner > 0)) {
            const dot = document.createElement('div');
            dot.className = 'rail-dot';
            if (this.arrowCardIndex === procIdx) dot.classList.add('active');
            dot.title = '현재 시점(이 그룹까지 적용)';
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                // this.arrowBoundId = procGroup.id;
                this.arrowBoundId = this.processes[procIdx2 - 1].id;
                this.render({ typ: 'explorer', procId: '' });
            });
            railCell.appendChild(dot);
        }
        row.appendChild(railCell);

        // 카드 본체
        const cardgroupDiv = document.createElement('div');
        cardgroupDiv.className = 'processflow-component'
        cardgroupDiv.dataset.id = procGroup.id;
        if (!isunfolded) cardgroupDiv.classList.add('groupstart')
        else cardgroupDiv.classList.add('groupstart-unfolded')

        cardgroupDiv.dataset.id = procGroup.id;
        if (this.selectedIds.has(procGroup.id)) cardgroupDiv.classList.add('selected-group');


        // 좌측: 번호+이름(한 줄) + 속성 칩
        const left = document.createElement('div');
        left.className = 'card-left';

        const label = document.createElement('span');
        label.className = 'proc-label oneline';
        if (nInner === 0) {
            label.innerHTML = `(Empty) <i class="fa-solid fa-layer-group"></i>`;
        } else {
            label.innerHTML = `${cardIdxNo}-${cardIdxNo + nInner - 1}. <i class="fa-solid fa-layer-group"></i>`;
        }

        const procGrpName = document.createElement('span');
        procGrpName.className = 'procgroup-label';
        procGrpName.title = 'Edit group name'
        procGrpName.innerText = `${procGroup.name}`;
        label.appendChild(procGrpName);



        procGrpName.addEventListener('mousedown', async (e) => {
            const oldName = procGroup.name;
            const newName = await window.prj.customModal.prompt(`Enter group name:`, oldName);
            if (!newName) return;
            this._commitHistory();
            procGroup.name = newName;
            this.render('renderOnly')
        })



        left.append(label);

        const right = document.createElement('div');
        right.className = 'card-right';


        const ungroupBtn = document.createElement('button');
        ungroupBtn.className = 'icon-btn';
        ungroupBtn.title = 'Ungroup';
        ungroupBtn.innerHTML = '<i class="fa-solid fa-object-ungroup"></i>';
        ungroupBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._commitHistory();

            this.selectedIds.clear();
            this.selectedIds.add(procGroup.id);
            this.selectedIds.add(procGroupEndId);
            this._deleteSelected();
            this.render('renderOnly');
        });

        const unfoldBtn = document.createElement('button');
        unfoldBtn.className = 'icon-btn';
        unfoldBtn.title = 'Unfold';
        unfoldBtn.innerHTML = procGroup.unfolded ? '<i class="fa-solid fa-chevron-up"></i>' : '<i class="fa-solid fa-chevron-down"></i>';
        unfoldBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            procGroup.unfolded = !procGroup.unfolded;
            this.render('renderOnly');
        });
        right.appendChild(ungroupBtn);
        right.appendChild(unfoldBtn);
        cardgroupDiv.append(left, right);
        row.appendChild(cardgroupDiv);

        // 선택 & 드래그
        cardgroupDiv.addEventListener('mousedown', (e) => {
            const id = procGroup.id;
            const idx = procIdx;
            const idx2 = procIdx2;
            this.dragStartY = e.clientY;
            let moved = false;   // 마우스가 움직였는지 여부
            this.dragging = false;
            this.isSelectedDragging = this.selectedIds.has(procGroup.id);

            let dragTarget = this.selectedIds.has(procGroup.id) ? Array.from(this.selectedIds) : ids;

            // --- mousemove 핸들러 ---
            const onMove = (ev) => {
                const dy = Math.abs(ev.clientY - this.dragStartY);
                if (dy > 3) { // 3px 이상 움직이면 드래그로 간주
                    moved = true;
                    if (!this.dragging) {
                        this.dragging = true;
                        this._ensureDropIndicator();
                        this._startDragGhost(dragTarget, ev.clientX, ev.clientY);
                    }
                    this._moveGhost(ev.clientX, ev.clientY);
                }
            };

            // --- mouseup 핸들러 ---
            const onUp = (ev) => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);

                // 만약 이동이 없었다면 (= 클릭으로 간주)
                if (!moved) {
                    // === 클릭 동작 ===
                    if (e.shiftKey && this.lastFocusIndex != null) {
                        const isArr = Array.isArray(this.lastFocusIndex);
                        const a = Math.min(isArr ? Math.min(...this.lastFocusIndex) : this.lastFocusIndex, idx);
                        const b = Math.max(isArr ? Math.max(...this.lastFocusIndex) : this.lastFocusIndex, idx2);
                        this.selectedIds.clear();
                        for (let i = a; i <= b; i++) this.selectedIds.add(this.processes[i].id);
                    } else if (e.ctrlKey || e.metaKey) {
                        if (this.selectedIds.has(id)) ids.forEach(id => this.selectedIds.delete(id));
                        else ids.forEach(id => this.selectedIds.add(id));
                    } else {
                        this.selectedIds.clear();
                        ids.forEach(id => this.selectedIds.add(id));
                    }
                    this.lastFocusIndex = idxs;
                    this.render('renderOnly');

                } else { // === 드래그 종료 ===
                    this._removeGhost();
                    if (this.dragging) {
                        this.dragging = false;
                        this._hideDropIndicator();
                        if ((this.dropGapIndex != null) && !this._checkIngroup(this.dropGapIndex)) {
                            this._commitHistory();
                            this._moveSelectedToGap(dragTarget, this.dropGapIndex);
                        }
                        this.dropGapIndex = null;
                    }
                }
            };

            // --- 이벤트 등록 ---
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });


        return row;

    }

    _makeGroupEndRow(procIdx) {
        const row = document.createElement('div');
        row.className = 'card-row';

        // rail cell (w/o dot)
        const railCell = document.createElement('div');
        railCell.className = 'rail-cell';
        row.appendChild(railCell);
        const groupEndRow = document.createElement('div');
        groupEndRow.className = 'processflow-component';
        groupEndRow.classList.add('groupend-unfolded');
        if (this.selectedIds.has(this.processes[procIdx].id)) groupEndRow.classList.add('selected-group');
        groupEndRow.dataset.id = this.processes[procIdx].id;

        row.appendChild(groupEndRow);

        return row;
    }

    /* --- 드롭 인디케이터 --- */
    _ensureDropIndicator() {
        if (!this.dropIndicator) {
            this.dropIndicator = document.createElement('div');
            this.dropIndicator.className = 'drop-indicator';
            this.listEl.appendChild(this.dropIndicator);
        }
        this.dropIndicator.style.display = 'block';
    }
    _showDropIndicatorForGap(gapIdx, gapRowEl) {
        this._ensureDropIndicator();
        const r = gapRowEl.getBoundingClientRect();
        const host = this.listEl.getBoundingClientRect();
        const top = r.top - host.top + (r.height / 2 - 1);
        this.dropIndicator.style.top = `${Math.max(0, top)}px`;
        this.dropIndicator.style.display = 'block';
    }
    _hideDropIndicator() { if (this.dropIndicator) this.dropIndicator.style.display = 'none'; }

    /* --- ghost --- */
    _startDragGhost(dragTarget, x, y) {
        this._removeGhost();
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.style.left = x + 'px';
        ghost.style.top = y + 'px';
        ghost.style.transform = 'scale(0.7)';         // 축소
        ghost.style.transformOrigin = 'top left';
        dragTarget.forEach(id => {
            const card = this.listEl.querySelector(`.processflow-component[data-id="${id}"]`);
            if (card) ghost.appendChild(card.cloneNode(true));
        });
        document.body.appendChild(ghost);
        this.ghostContainer = ghost;
    }
    _moveGhost(x, y) {
        if (this.ghostContainer) {
            this.ghostContainer.style.left = (x + 8) + 'px';
            this.ghostContainer.style.top = (y + 8) + 'px';
        }
    }
    _removeGhost() {
        if (this.ghostContainer) { this.ghostContainer.remove(); this.ghostContainer = null; }
    }

    /* --- 조작 --- */
    _insertAtGap(items, gapIdx) {
        const before = this.processes.slice(0, gapIdx);
        const after = this.processes.slice(gapIdx);
        this.processes = before.concat(items, after);
        if (items.length) {
            const last = items[items.length - 1];
            if (this.arrowBoundId == this.selectBarBoundId) this.arrowBoundId = last.id;
            this.selectBarBoundId = last.id;
        }
        const opts = { typ: 'process', procId: gapIdx };
        this.render(opts);
    }
    _deleteSelected() {
        if (!this.selectedIds.size) return;
        const ids = new Set(this.selectedIds);
        const oldList = this.processes.slice();
        const minIdxVal = this.processes[this.processes.findIndex(a => ids.has(a.id)) - 1];
        const minIdx = minIdxVal ? minIdxVal.id : 0;
        this.processes = this.processes.filter(p => !ids.has(p.id));

        const fixArrow = () => {
            if (!this.arrowBoundId) return null;
            if (this.processes.find(x => x.id === this.arrowBoundId)) return this.arrowBoundId;
            // 삭제되면 가장 가까운 직전 카드로
            const oldIdx = oldList.findIndex(x => x.id === this.arrowBoundId);
            for (let i = oldIdx - 1; i >= 0; i--) {
                const surv = oldList[i];
                if (this.processes.find(x => x.id === surv.id)) return surv.id;
            }
            return null;
        };
        const fixSelect = (boundId) => {
            if (boundId == null) return null;
            if (this.processes.find(x => x.id === boundId)) return boundId;
            const oldIdx = oldList.findIndex(x => x.id === boundId);
            for (let i = oldIdx - 1; i >= 0; i--) {
                const surv = oldList[i];
                if (this.processes.find(x => x.id === surv.id)) return surv.id;
            }
            return null;
        };

        this.arrowBoundId = fixArrow();
        this.selectBarBoundId = fixSelect(this.selectBarBoundId);

        this.selectedIds.clear();
        this.lastFocusIndex = null;

        const opts = { typ: 'process', procId: minIdx }
        this.render(opts);
    }
    _copy(cut) {
        if (!this.selectedIds.size) return;
        const pick = this.processes.filter(p => this.selectedIds.has(p.id)).map(this.deepClone);
        const reid = (p) => ({ ...p, id: 'p_' + Math.random().toString(36).slice(2, 9) });
        this.clipboard = pick.map(reid);
        if (cut) { this._commitHistory(); this._deleteSelected(); }
    }
    _paste() {
        if (!this.clipboard.length) return;

        for (let p of this.clipboard) {
            if (p.kind.startsWith('GROUP') && this._checkIngroup()) {
                return
            }
        }

        this._commitHistory();
        const clones = this.clipboard.map(this.deepClone).map(p => ({ ...p, id: 'p_' + Math.random().toString(36).slice(2, 9) }));
        this._insertAtGap(clones, this.selectBarIndex);
        this.selectedIds = new Set(clones.map(c => c.id));
        this.lastFocusIndex = this.processes.findIndex(p => p.id === clones[clones.length - 1].id);
        this.render('renderOnly');
    }
    _moveSelectedToGap(dragTarget, targetGap) {
        if (!dragTarget) return;
        if (dragTarget.length === 0) return;
        const selected = this.processes.filter(p => dragTarget.includes(p.id));
        if (!selected.length) return;


        const minIdx = this.processes[Math.min(targetGap, this.processes.findIndex(a => dragTarget.includes(a.id))) - 1].id;


        const remain = this.processes.filter(p => !dragTarget.includes(p.id));
        const removedAbove = this.processes.slice(0, targetGap).filter(p => dragTarget.includes(p.id)).length;
        let adjustedGap = targetGap - removedAbove;
        adjustedGap = Math.max(0, Math.min(adjustedGap, remain.length));

        this.processes = remain.slice(0, adjustedGap).concat(selected, remain.slice(adjustedGap));

        // 선택 마지막에 포커스
        this.lastFocusIndex = this.processes.findIndex(p => p.id === selected[selected.length - 1].id);

        const opts = { typ: 'process', procId: minIdx }
        this.render(opts);
    }

    /* --- 스타일 업데이트 --- */
    _updatePastFutureStyles() {
        const aidx = this.arrowCardIndex; // -1..n-1      
        for (let idx = 0; idx < this.processes.length; idx++) {
            const id = this.processes[idx].id;
            const card = this.listEl.querySelector(`.processflow-component[data-id="${id}"]`);
            if (card) {
                if (idx > aidx) {  // future (arrow 아래)
                    card.classList.add('future');
                    card.classList.remove('past');
                } else {          // past (arrow 포함)
                    card.classList.remove('future');
                    card.classList.add('past');
                }
            };

            const dot = card?.parentElement?.querySelector('.rail-dot');
            if (dot) {
                if (idx > aidx) {  // future (arrow 아래)
                    dot.classList.add('future');
                    dot.classList.remove('past');
                } else {          // past (arrow 포함)
                    dot.classList.remove('future');
                    dot.classList.add('past');
                }
            };
        }
    }


    _updateRailAndPastZone() {
        const list = this.listEl;


        // past-zone 보장
        if (!this.pastZoneEl) {
            this.pastZoneEl = document.createElement('div');
            this.pastZoneEl.className = 'past-zone';
            list.prepend(this.pastZoneEl);
        }
        // rail-line 보장
        if (!this.railLinePast) {
            this.railLinePast = document.createElement('div');
            this.railLinePast.className = 'rail-line past-rail';
            list.appendChild(this.railLinePast);
        }
        if (!this.railLineFuture) {
            this.railLineFuture = document.createElement('div');
            this.railLineFuture.className = 'rail-line future-rail';
            list.appendChild(this.railLineFuture);
        }

        // 기준 위치 계산
        const hostTop = list.getBoundingClientRect().top;
        const scrollY = list.scrollTop;  // 스크롤 오프셋 보정 추가
        let arrowBottomPx = 0;
        if (this.arrowCardIndex >= 0) {
            let curIdx = this.arrowCardIndex;
            let cardEl;
            while (true) {
                const id = this.processes[curIdx]?.id;
                cardEl = id ? list.querySelector(`.processflow-component[data-id="${id}"]`) : null;
                if (cardEl) break
                curIdx += -1;
            }
            arrowBottomPx = cardEl.getBoundingClientRect().bottom - hostTop + scrollY;
        }

        // 리스트 마지막 카드 bottom
        let railBottom = 0;
        let lastIdx = this.processes.length - 1;
        let lastEl;
        while (true) {
            const id = this.processes[lastIdx]?.id;
            lastEl = id ? list.querySelector(`.processflow-component[data-id="${id}"]`) : null;
            if (lastEl) break
            lastIdx += -1;
        }
        railBottom = lastEl.getBoundingClientRect().bottom - hostTop + scrollY;


        // 스타일 갱신(트랜지션으로 부드럽게 이동)
        this.pastZoneEl.style.height = Math.max(0, arrowBottomPx) + 'px';
        this.railLinePast.style.top = '0px';
        this.railLinePast.style.height = Math.max(0, arrowBottomPx) + 'px';
        this.railLineFuture.style.top = Math.max(0, arrowBottomPx) + 'px';
        this.railLineFuture.style.height = Math.max(0, railBottom - arrowBottomPx) + 'px';
    }



}

/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    const processflow = new ProcessFlow();
    processflow.arrowBoundId = processflow.processes[processflow.processes.length - 1]?.id || null;
    window.prj.processFlow = processflow;   // 👈 전역 포인터
});
