/* ========= utils ========= */
/* ========= 메인 클래스 ========= */
class ProcessFlow {
  constructor() {
    this.listEl = document.getElementById('processflow-card-list'),
      this.addBtn = document.getElementById('processflow-add-btn')
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
    const maskList = window.prj.maskmanager.maskList.map(obj=>obj.id);

      
    for (let proc of this.processes) {
      if (proc.mask === '' || proc.mask === '-') {
        proc.mask = '';
      } else {
        if (!maskList.includes(proc.mask))
        proc.mask = 'deleted';
      }
    }
    console.log(this.processes,maskList)




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

  /* --- UI 바인딩 --- */
  _wireUI() {
    this.addBtn.addEventListener('click', () => {
      this._commitHistory();
      const proc = this.createDefaultProcess();
      const at = this.selectBarIndex;
      this._insertAtGap([proc], at);
      this.selectBarBoundId = proc.id;
      this.render();
    });
  }
  _wireGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (window.prj.projectManager.currentTab !== 'processflow-panel') return;
      const ctrl = e.ctrlKey || e.metaKey;

      // ↑↓ 로 현재시점 arrow 이동 (arrowCardIndex 기준)
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const cur = this.arrowCardIndex;   // -1 ~ n-1
        if (cur > 0) {                       // 위로 (한 칸 이전 카드)
          this._commitHistory();
          this.arrowBoundId = this.processes[cur - 1].id;
          this.render({ typ: 'explorer', procId: '' });
        } else if (cur === 0) {              // 첫 카드에서 위 → 아무 것도 선택 안 함
          this._commitHistory();
          this.arrowBoundId = null;
          this.render({ typ: 'explorer', procId: '' });
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const cur = this.arrowCardIndex;   // -1 (none) or 0~n-1
        if (cur < this.processes.length - 1) {
          this._commitHistory();
          this.arrowBoundId = this.processes[cur + 1].id;
          this.render({ typ: 'explorer', procId: '' });
        } else if (cur === -1 && this.processes.length > 0) {
          // 현재 arrow가 없으면 첫 카드로 이동
          this._commitHistory();
          this.arrowBoundId = this.processes[0].id;
          this.render({ typ: 'explorer', procId: '' });
        }
      }

      // Delete, Ctrl+C/X/V/Z/Y 기존 로직은 그대로...
      if (e.key === 'Delete' && this.selectedIds.size) {
        e.preventDefault(); this._commitHistory(); this._deleteSelected();
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
        this.render();
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

    // gap(0) ~ [card0] ~ gap(1) ~ ... ~ [card n-1] ~ gap(n)
    for (let gap = 0; gap <= n; gap++) {
      const gapRow = this._makeGapRow(gap);   // select bar row
      list.appendChild(gapRow);
      if (gap < n) {
        const cardRow = this._makeCardRow(gap); // card row with rail-dot
        list.appendChild(cardRow);
      }
    }

    // past/future + past-zone + rail 라인 길이/위치 보정
    this._updatePastFutureStyles();
    this._updateRailAndPastZone();

    list.scrollTop = prevScroll;

    // 런타임 갱신 이벤트(색 정보 포함)
    let detail = this._snapshot();
    if (opts) {
      detail.opts = opts;
    }
    window.dispatchEvent(new CustomEvent('simflow:changed', { detail: detail }));



  }

  _makeGapRow(gapIdx) {
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
    bar.dataset.gapIndex = String(gapIdx);
    if (this.selectBarIndex === gapIdx) bar.classList.add('active-bar');
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectBarBoundId = this.getBoundIdByGapIndex(gapIdx);
      this.render();
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

  _makeCardRow(cardIdx) {
    const row = document.createElement('div');
    row.className = 'card-row';
    const proc = this.processes[cardIdx];

    // rail cell (dot)
    const railCell = document.createElement('div');
    railCell.className = 'rail-cell';
    const dot = document.createElement('div');
    dot.className = 'rail-dot';
    if (this.arrowCardIndex === cardIdx) dot.classList.add('active');
    dot.title = '현재 시점(이 카드까지 적용)';
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      this._commitHistory();
      this.arrowBoundId = proc.id;    // “이 카드까지”      
      this.render({ typ: 'explorer', procId: '' });
    });
    railCell.appendChild(dot);
    row.appendChild(railCell);

    // 카드 본체
    const card = document.createElement('div');
    card.className = 'processflow-card';
    card.dataset.id = proc.id;
    if (this.selectedIds.has(proc.id)) card.classList.add('selected');

    // 좌측: 번호+이름(한 줄) + 속성 칩
    const left = document.createElement('div');
    left.className = 'card-left';

    const label = document.createElement('span');
    label.className = 'proc-label oneline';
    label.textContent = `${cardIdx + 1}. ${this.kindIcon[proc.kind] || '⚙️'} ${proc.kind} : ${proc.name}`;


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
    editBtn.className = 'icon-btn';
    editBtn.title = 'Edit (inspector)';
    editBtn.textContent = '▼';
    right.appendChild(editBtn);

    card.append(left, right);
    row.appendChild(card);

    // 선택 & 드래그
    card.addEventListener('mousedown', (e) => {
      const id = proc.id;
      const idx = cardIdx;
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
            const a = Math.min(this.lastFocusIndex, idx);
            const b = Math.max(this.lastFocusIndex, idx);
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
          this.render();
        } 
        // === 드래그 종료 ===
        else {
          this._removeGhost();
          if (this.dragging) {
            this.dragging = false;
            this._hideDropIndicator();
            if (this.dropGapIndex != null) {
              this._commitHistory();
              this._moveSelectedToGap(dragTarget,this.dropGapIndex);
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
      const card = this.listEl.querySelector(`.processflow-card[data-id="${id}"]`);
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
    this.render();
  }
  _deleteSelected() {
    if (!this.selectedIds.size) return;
    const ids = new Set(this.selectedIds);
    const oldList = this.processes.slice();
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
    this.render();
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
    this._commitHistory();
    const clones = this.clipboard.map(this.deepClone).map(p => ({ ...p, id: 'p_' + Math.random().toString(36).slice(2, 9) }));
    this._insertAtGap(clones, this.selectBarIndex);
    this.selectedIds = new Set(clones.map(c => c.id));
    this.lastFocusIndex = this.processes.findIndex(p => p.id === clones[clones.length - 1].id);
    this.render();
  }
  _moveSelectedToGap(dragTarget,targetGap) {
    if (!dragTarget) return;
    if (dragTarget.length === 0) return;
    const selected = this.processes.filter(p => dragTarget.includes(p.id));
    if (!selected.length) return;

    const remain = this.processes.filter(p => !dragTarget.includes(p.id));
    const removedAbove = this.processes.slice(0, targetGap).filter(p => dragTarget.includes(p.id)).length;
    let adjustedGap = targetGap - removedAbove;
    adjustedGap = Math.max(0, Math.min(adjustedGap, remain.length));

    this.processes = remain.slice(0, adjustedGap).concat(selected, remain.slice(adjustedGap));

    // 선택 마지막에 포커스
    this.lastFocusIndex = this.processes.findIndex(p => p.id === selected[selected.length - 1].id);
    this.render();
  }

  /* --- 스타일 업데이트 --- */
  _updatePastFutureStyles() {
    const aidx = this.arrowCardIndex; // -1..n-1

    let idx = 0;
    for (const card of this.listEl.querySelectorAll('.processflow-card')) {
      if (idx > aidx) {  // future (arrow 아래)
        card.classList.add('future');
        card.classList.remove('past');
      } else {          // past (arrow 포함)
        card.classList.remove('future');
        card.classList.add('past');
      }
      idx++;
    }

    idx = 0;
    for (const card of this.listEl.querySelectorAll('.rail-dot')) {
      if (idx > aidx) {  // future (arrow 아래)
        card.classList.add('future');
        card.classList.remove('past');
      } else {          // past (arrow 포함)
        card.classList.remove('future');
        card.classList.add('past');
      }
      idx++;
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
      const id = this.processes[this.arrowCardIndex]?.id;
      const cardEl = id ? list.querySelector(`.processflow-card[data-id="${id}"]`) : null;
      if (cardEl) {
        arrowBottomPx = cardEl.getBoundingClientRect().bottom - hostTop + scrollY;
      }
    }

    // 리스트 마지막 카드 bottom
    let railBottom = 0;
    const lastProc = this.processes[this.processes.length - 1];
    if (lastProc) {
      const lastEl = list.querySelector(`.processflow-card[data-id="${lastProc.id}"]`);
      if (lastEl) {
        railBottom = lastEl.getBoundingClientRect().bottom - hostTop + scrollY;
      }
    }

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

  // 데모 초기값
  // let initialProcess = [{ id: 'p_init0', kind: 'SUBSTR', mask: '-', material: 'Si', thickness: 20, name: 'Substrate' }];
  // processflow._commitHistory();
  // processflow._insertAtGap(initialProcess, 0);

  // 현재 시점: 두 번째 카드까지 적용 예시
  processflow.arrowBoundId = processflow.processes[processflow.processes.length - 1]?.id || null;
  // processflow.render();

  window.prj.processFlow = processflow;   // 👈 전역 포인터
});
