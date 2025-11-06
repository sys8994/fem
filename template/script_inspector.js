class Inspector {
  constructor(flow) {
    this.flow = flow;
    // kind 아이콘은 없을 수도 있으니 기본값 마련
    this.kindIcon = this.flow.kindIcon;
    this.expandedIds = new Set();   // 열린 카드 id
    this.openMenus = new Set();   // 열린 메뉴 DOM 집합
    this.menuBtn = new Map();   // menu -> button 매핑


    this.isDragging = false;
    this.inspectedProcId = false;

    // === 포털 레이어 (카드 overflow에 안 잘리게 화면 최상단에 메뉴를 붙임) ===
    this.portal = document.getElementById('insp-portal');
    if (!this.portal) {
      this.portal = document.createElement('div');
      this.portal.id = 'insp-portal';
      this.portal.className = 'insp-portal-layer';
      document.body.appendChild(this.portal);
    }

    // ESC: 열려있는 드롭다운 먼저 닫고, 없으면 인스펙터 닫기
    document.addEventListener('keydown', (e) => {
      if (window.prj.projectManager.currentTab !== 'processflow-panel') return;

      if (e.key === 'Escape') {
        if (this.openMenus.size) {
          this._closeAllMenus();
          e.stopPropagation(); e.preventDefault();
          return;
        }
        this.closeAllImmediate();
      }
    });




    // 바깥 클릭: 메뉴 닫고 클릭 소거(카드 선택/드래그 방지)
    this._onDocDown = (e) => {
      if (!this.openMenus.size) return;
      for (const menu of this.openMenus) {
        const btn = this.menuBtn.get(menu);
        if (this._within(e.target, menu) || (btn && this._within(e.target, btn))) {
          return; // 메뉴/버튼 내부 클릭이면 무시
        }
      }
      this._closeAllMenus();
      e.stopPropagation(); e.preventDefault();
    };
    document.addEventListener('mousedown', this._onDocDown, true);

    // 스크롤/리사이즈 시 열린 메뉴 위치 재계산(화면 안으로 유지)
    this._onGlobalInvalidate = () => {
      for (const m of this.openMenus) {
        const btn = this.menuBtn.get(m);
        if (btn) this._placeMenu(m, btn.getBoundingClientRect());
      }
    };
    window.addEventListener('scroll', this._onGlobalInvalidate, true);
    window.addEventListener('resize', this._onGlobalInvalidate, true);


  }



  // 안전 호출
  _safe(fn, ctx, ...args) {
    if (typeof fn === 'function') { try { return fn.apply(ctx, args); } catch (_) { } }
  };

  _within(el, root) { return !!(el && root && (el === root || root.contains(el))); }

  // Edit 버튼 토글
  toggle(cardEl, proc) {
    if (cardEl.querySelector('.inspector-panel')) {
      this._collapseImmediate(cardEl, proc.id);
    } else {
      this._ensurePanelImmediate(cardEl, proc);
    }
  }


  // 렌더 후, 열려있던 카드만 패널 재부착
  rehydrateAll() {
    for (const id of this.expandedIds) {
      const card = this.flow.listEl.querySelector(`.processflow-card[data-id="${id}"]`);
      const proc = this.flow.processes.find(p => p.id === id);
      if (card && proc && !card.querySelector('.inspector-panel')) {
        this._ensurePanelImmediate(card, proc);
      }
    }
    this._safe(this.flow._updateRailAndPastZone, this.flow);
  }

  // 인스펙터 모두 닫기 (즉시)
  closeAllImmediate() {
    for (const id of Array.from(this.expandedIds)) {
      const card = this.flow.listEl.querySelector(`.processflow-card[data-id="${id}"]`);
      if (card) this._collapseImmediate(card, id, /*silent*/true);
    }
    this.expandedIds.clear();
    this._safe(this.flow._updateRailAndPastZone, this.flow);
  }

  /* ========== 열기/닫기 (전환 없음) ========== */

  _ensurePanelImmediate(cardEl, proc) {
    if (cardEl.querySelector('.inspector-panel')) return;

    const panel = document.createElement('div');
    panel.className = 'inspector-panel';
    panel.style.gridColumn = '1 / -1'; // 카드 그리드 하단 전폭
    panel.addEventListener('mousedown', (ev) => ev.stopPropagation()); // 카드 드래그로 번지지 않게

    // 행 구성
    this._setPanelOptions(cardEl, panel, proc);

    cardEl.appendChild(panel);
    cardEl.classList.add('expanded');
    this.expandedIds.add(proc.id);

    this._safe(this.flow._updateRailAndPastZone, this.flow);
  }

  _collapseImmediate(cardEl, id, silent = false) {
    const panel = cardEl.querySelector('.inspector-panel');
    if (panel) {
      // 이 패널 아래 열린 메뉴 닫기
      for (const menu of Array.from(this.openMenus)) {
        if (this._within(menu, panel)) this._closeMenu(menu);
      }
      panel.remove(); // 즉시 제거
    }
    cardEl.classList.remove('expanded');
    this.expandedIds.delete(id);
    if (!silent) this._safe(this.flow._updateRailAndPastZone, this.flow);
  }

  /* ========== 행 위젯들 ========== */


  _rowName(cardEl, proc) {
    return this._makeDropdownRow(
      {
        label: 'Process Name',
        items: proc.id,
        current: proc.name || "",
        onChange: (val) => {
          this.flow._commitHistory();
          proc.name = val;
          // 패널 내용만 재구성
          this._rebuildPanelInPlace(cardEl, proc);
          // 카드 라벨/메타 갱신
          this._updateCardLabelMeta(cardEl, proc);
          // 레일 보정
          this._safe(this.flow._updateRailAndPastZone, this.flow);
        },
        headerType: 'name',
      });
  }

  _rowType(cardEl, proc) {
    let types = Object.keys(this.kindIcon || {});
    if (!types || !types.length) types = ["SUBSTR", "DEPO", "ALD", "ETCH", "CMP"];
    return this._makeDropdownRow({
      label: "Type",
      items: types,
      current: proc.kind || "SUBSTR",
      onSelect: (val) => {
        this.flow._commitHistory();

        proc.kind = val;
        // 패널 내용만 재구성
        this._rebuildPanelInPlace(cardEl, proc);
        // 카드 라벨/메타 갱신
        this._updateCardLabelMeta(cardEl, proc);
        // 3D 갱신
        this._emitRuntimeChanged();
        // 레일 보정
        this._safe(this.flow._updateRailAndPastZone, this.flow);
      },
      headerType: 'icon',
    });
  }

  _rowMaterial(proc) {
    let mats = Object.keys(this.flow.materialColor || {});
    if (['ETCH', 'WETETCH'].includes(proc.kind)) mats.unshift('ALL');

    return this._makeDropdownRow({
      label: "Material",
      items: mats,
      current: proc.material || "",
      onSelect: async (val) => {
        if (val === "+Add") {
          const mat = await window.prj.customModal.material("Please select material name and color:");
          if (!mat) return;
          this.flow._commitHistory();
          const newId = Math.max(...this.materialColor.map(b => b.Id)) + 1;
          this.flow.materialColor[mat.name] = { color: mat.color || "#cccccc", id: newId };
          proc.material = mat.name;
          // this._rebuildPanelInPlace(cardEl,proc);
          this._rebuildPanelInPlaceAll() // 물질 추가할 경우, 모든 열려있는 inspector 내용을 업데이트
        } else {
          proc.material = val;
        }
        this._updateAnyCardMeta(proc.id);
        this._emitRuntimeChanged({ typ: 'inspector', procId: proc.id });
      },
      headerType: 'color',
      showAdd: true,
    });
  }

  _rowStopper(proc) {
    const mats = Object.keys(this.flow.materialColor || {});
    return this._makeDropdownRow({
      label: "Stopper",
      items: ["-", ...mats],
      current: proc.material || "",
      onSelect: async (val) => {
        if (val === "+Add") {
          const mat = await window.prj.customModal.material("Please select material name and color:");
          if (!mat) return;

          this.flow._commitHistory();
          const newId = Math.max(...this.materialColor.map(b => b.Id)) + 1;
          this.flow.materialColor[mat.name] = { color: mat.color || "#cccccc", id: newId };
          proc.material = mat.name;
          // this._rebuildPanelInPlace(cardEl,proc);
          this._rebuildPanelInPlaceAll() // 물질 추가할 경우, 모든 열려있는 inspector 내용을 업데이트
        } else {
          proc.material = val;
        }
        this._updateAnyCardMeta(proc.id);
        this._emitRuntimeChanged();
      },
      headerType: 'color',
      showAdd: true,
    });
  }

  _rowMask(proc) {
    // const masks = ["A", "B", "C"]; // TODO: 실제 마스크 목록 연동
    const masks = window.prj.maskmanager.maskList.map(mask => mask.id);
    return this._makeDropdownRow({
      label: "Mask",
      items: masks,
      current: proc.mask || "-",
      onSelect: (val) => {
        this.flow._commitHistory();
        if (val === '-') {
          proc.mask = '-'
        } else {
          proc.mask = val;
        }
        this._updateAnyCardMeta(proc.id);
        this._emitRuntimeChanged({ typ: 'inspector', procId: proc.id });
      },
      headerType: 'mask',
    });
  }

  _rowThickness(proc) {
    return this._makeSliderRow({
      label: "Thickness (nm)",
      min: 0,
      max: ['ALD', 'WETETCH'].includes(proc.kind) ? 10 : 100,
      val: Number(proc.thickness || 0),
      onChange: (v, typ) => {
        proc.thickness = v;
        this._updateAnyCardMeta(proc.id);
        this._emitRuntimeChanged({ typ: typ, procId: proc.id });
      },
      step: 1,
      procid: proc.id
    });
  }



  _rowConformality(proc) {
    return this._makeSliderRow({
      label: "Conformality",
      min: 0, max: 1, val: (typeof proc.conformality === 'number' ? proc.conformality : 0),
      onChange: (v, typ) => {
        proc.conformality = v;
        this._emitRuntimeChanged({ typ: typ, procId: proc.id });
      },
      step: 0.01,
      procid: proc.id
    });
  }


  /* ========== 패널 재구성/라벨 갱신 ========== */

  //processflow-card past expanded p_cgmv5kd
  _rebuildPanelInPlaceAll() {
    for (const id of this.expandedIds) {
      const card = this.flow.listEl.querySelector(`.processflow-card[data-id="${id}"]`);
      const proc = this.flow.processes.find(p => p.id === id);
      this._rebuildPanelInPlace(card, proc)
    }
  }

  _rebuildPanelInPlace(cardEl, proc) {
    const panel = cardEl.querySelector('.inspector-panel');
    if (!panel) return;

    // 이 패널 내부의 열린 메뉴 닫기
    for (const menu of Array.from(this.openMenus)) {
      if (this._within(menu, panel)) this._closeMenu(menu);
    }

    panel.innerHTML = '';
    this._setPanelOptions(cardEl, panel, proc);
  }

  _setPanelOptions(cardEl, panel, proc) {
    panel.appendChild(this._rowName(cardEl, proc));
    panel.appendChild(this._rowType(cardEl, proc));
    if (proc.kind !== 'SUBSTR' && proc.kind !== 'CMP') panel.appendChild(this._rowMaterial(proc));
    if (proc.kind === 'ETCH' || proc.kind === 'DEPO') panel.appendChild(this._rowMask(proc));
    if (proc.kind !== 'STRIP') panel.appendChild(this._rowThickness(proc));
    if (proc.kind === 'DEPO' || proc.kind === 'ETCH') panel.appendChild(this._rowConformality(proc));
    if (proc.kind === 'CMP') panel.appendChild(this._rowStopper(proc));

  }

  _updateAnyCardMeta(procId = null) {

    if (!procId) {
      const cardList = this.flow.listEl.querySelectorAll(`.processflow-card`);
      for (let card of cardList) {
        const cardId = card.dataset['id'];
        if (!cardId) continue;
        const proc = this.flow.processes.find(p => p.id === cardId);
        if (!proc) continue;
        this._updateCardLabelMeta(card, proc);
      }
    } else {
      const card = this.flow.listEl.querySelector(`.processflow-card[data-id="${procId}"]`);
      if (!card) return;
      const proc = this.flow.processes.find(p => p.id === procId);
      if (!proc) return;
      this._updateCardLabelMeta(card, proc);
    }
  }

  _updateCardLabelMeta(cardEl, proc) {
    const idx = this.flow.processes.findIndex(x => x.id === proc.id);
    const label = cardEl.querySelector('.proc-label');
    if (label) {
      const icon = this.kindIcon[proc.kind] || '⚙️';
      label.textContent = `${idx + 1}. ${icon} ${proc.kind || ''} : ${proc.name || ''}`;
    }

    const meta = cardEl.querySelector('.proc-meta');
    if (meta) {
      let metaHtml = '';
      if ((proc.material) && (proc.material !== '-')) {
        const clr = this.flow.materialColor[proc.material]?.color || '#ccc';
        if (proc.kind == 'CMP') metaHtml += `<span class="material-circle" style="background:${clr}"></span> ${proc.material} Stopper `;
        else metaHtml += `<span class="material-circle" style="background:${clr}"></span> ${proc.material} `;
      }
      if (proc.mask && proc.mask !== '-') {
        const maskname = window.prj.maskmanager.maskList.find(mask => mask.id == proc.mask).name;
        metaHtml += `| ${maskname} `;
      }
      if (proc.thickness && proc.thickness !== '-') {
        metaHtml += `| ${proc.thickness} nm`;
      }
      if (metaHtml.startsWith('|')) metaHtml = metaHtml.slice(1);
      meta.innerHTML = metaHtml;
    }
  }

  /* ========== 드롭다운 빌더 (포털/바깥클릭/ESC/뷰포트 내 배치) ========== */

  _makeDropdownRow(input) {
    const { label, items, current, onSelect, headerType = 'none', showAdd = false } = input;
    const row = document.createElement('div');
    row.className = 'insp-row';

    const lab = document.createElement('div');
    lab.className = 'insp-label';
    lab.textContent = label;
    row.appendChild(lab);

    const box = document.createElement('div');
    box.className = 'insp-dd-box'; // width:100%
    row.appendChild(box);


    if (headerType == 'name') {
      const procId = items;
      const btn = document.createElement('input');
      btn.className = 'insp-input-box';
      btn.style.position = 'relative'; // 화살표 absolute 배치용
      btn.value = current;
      btn.id = 'input-name-' + procId
      btn.addEventListener('change', (e) => {
        this.flow._commitHistory();
        const proc = this.flow.processes.find(p => p.id === procId);
        const cardEl = e.target.closest('.processflow-card');
        proc.name = e.target.value;
        this._updateAnyCardMeta(procId)
        // 패널 내용만 재구성
        this._rebuildPanelInPlace(cardEl, proc);
        // 카드 라벨/메타 갱신
        this._updateCardLabelMeta(cardEl, proc);
        // 레일 보정
        this._safe(this.flow._updateRailAndPastZone, this.flow);

      })
      box.appendChild(btn);
      return row

    }

    // 버튼: 왼쪽엔 텍스트, 오른쪽엔 화살표(별도 span)
    const btn = document.createElement('button');
    btn.className = 'insp-dropdown-btn';
    btn.style.position = 'relative'; // 화살표 absolute 배치용

    const textSpan = document.createElement('span');
    textSpan.className = 'insp-btn-text';
    btn.appendChild(textSpan);

    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'insp-dropdown-btn-arrow'; // CSS에서 right:10px 등 적용
    arrowSpan.textContent = '▼';
    btn.appendChild(arrowSpan);

    // 초기 텍스트 채우기
    this._setBtnText(btn, (current || '(select)'), headerType);

    box.appendChild(btn);

    // 메뉴는 포털에 띄운다 (처음엔 생성만)
    const menu = document.createElement('div');
    menu.className = 'insp-dropdown-menu hidden';
    menu.style.position = 'fixed';         // 뷰포트 기준
    menu.style.pointerEvents = 'auto';

    // 메뉴-버튼 매핑
    this.menuBtn.set(menu, btn);

    if (headerType == 'mask') {
      const add = document.createElement('div');
      add.className = 'insp-opt';
      add.textContent = '(No Mask)';
      add.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this._setBtnText(btn, '-', headerType);
        this._closeMenu(menu);
        onSelect('-');
      });
      menu.appendChild(add);
    }

    // 옵션들
    items.forEach(item => {
      const opt = document.createElement('div');
      opt.className = 'insp-opt';

      let optTx = item;

      if (headerType === 'color') {
        if (this.flow.materialColor[item]) {
          const dot = document.createElement('span');
          dot.className = 'color-dot';
          dot.style.background = this.flow.materialColor[item]?.color || '#aaa';
          opt.appendChild(dot);
        }
      } else if (headerType === 'icon') {
        const ic = document.createElement('span');
        ic.className = 'insp-kind-icon';
        ic.textContent = this.kindIcon[item] || '';
        opt.appendChild(ic);
      } else if (headerType === 'mask') {
        if (item !== '-') {
          const maskdata = window.prj.maskmanager.maskList.find(mask => mask.id === item);
          const ic = document.createElement('img');
          ic.className = 'insp-kind-maskthumbnail';
          ic.src = maskdata.thumbnail;
          opt.appendChild(ic);
          optTx = maskdata.name;
        }
      }

      const txt = document.createElement('span');
      txt.textContent = optTx;
      opt.appendChild(txt);

      opt.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        // 버튼 텍스트 갱신(화살표는 그대로 유지)

        this._setBtnText(btn, item, headerType);
        this._closeMenu(menu);
        onSelect(item);
      });
      menu.appendChild(opt);
    });

    if (showAdd) {
      const add = document.createElement('div');
      add.className = 'insp-opt add-opt';
      add.textContent = '+Add';
      add.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this._closeMenu(menu);
        onSelect('+Add');
      });
      menu.appendChild(add);
    }

    // 버튼 토글: 열 때는 포털에 붙이고 위치/폭 계산(뷰포트 안으로 강제)
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (menu.classList.contains('hidden')) {
        const r = btn.getBoundingClientRect();
        this.portal.appendChild(menu);
        menu.classList.remove('hidden');
        menu.style.width = r.width + 'px';
        this._placeMenu(menu, r);
        this.openMenus.add(menu);
        this._setBtnArrow(btn, /*open*/true);
      } else {
        this._closeMenu(menu);
        this._setBtnArrow(btn, /*open*/false);
      }
    });

    return row;
  }

  _setBtnText(btn, value, headerType) {
    const textSpan = btn.querySelector('.insp-btn-text');
    if (!textSpan) return;
    // 내용 재구성 (텍스트만 바꿈, 화살표 span은 유지)
    if (value && value !== '(select)') {
      if ((headerType === 'color') && this.flow.materialColor[value]) {
        textSpan.innerHTML = `<span class="color-dot" style="display:inline-block; vertical-align:middle; margin-right:8px; background:${this.flow.materialColor[value]?.color || '#aaa'}"></span>${value}`;
      } else if (headerType === 'icon') {
        const icon = this.kindIcon[value] || '';
        textSpan.innerHTML = `<span class="insp-kind-icon" style="display:inline-block; margin-right:6px;">${icon}</span>${value}`;
      } else if (headerType === 'mask') {
        if (value === '-') {
          textSpan.textContent = '(No Mask)';
        } else {
          const maskdata = window.prj.maskmanager.maskList.find(mask => mask.id === value);
          const maskthumbnail = maskdata.thumbnail;
          textSpan.innerHTML = `<div style="display:flex; align-items: center;"><img class="insp-kind-maskthumbnail" style="display:inline-block; margin-right:6px;" src="${maskthumbnail}"></img><span>${maskdata.name}</span></div>`;
        }

      } else {
        textSpan.textContent = value;
      }
    } else {
      textSpan.textContent = '(select)';
    }
  }

  _setBtnArrow(btn, open) {
    const arrow = btn.querySelector('.insp-dropdown-btn-arrow');
    if (arrow) arrow.textContent = open ? '▲' : '▼';
  }

  _placeMenu(menu, btnRect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 기본: 아래쪽
    let left = btnRect.left;
    let top = btnRect.bottom + 6;

    // 현재 메뉴 실제 크기
    const mr = menu.getBoundingClientRect();
    const mw = mr.width;
    const mh = mr.height;

    // 좌우 클램프 (여백 8px)
    const margin = 8;
    if (left + mw + margin > vw) left = vw - mw - margin;
    if (left < margin) left = margin;

    // 세로 조정: 아래로 넘치면 위로 뒤집기
    if (top + mh + margin > vh) {
      const topAbove = btnRect.top - mh - 6;
      if (topAbove >= margin) {
        top = topAbove; // 위로
      } else {
        // 위아래 모두 넘치면 화면 안으로 강제 + 스크롤 허용
        top = margin;
        menu.style.maxHeight = (vh - margin * 2) + 'px';
        menu.style.overflow = 'auto';
      }
    } else {
      // 여유 있으면 기본
      menu.style.maxHeight = '';
      menu.style.overflow = '';
    }

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  _closeMenu(menu) {
    if (!menu || menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    if (menu.parentNode === this.portal) this.portal.removeChild(menu);
    this.openMenus.delete(menu);
    const btn = this.menuBtn.get(menu);
    if (btn) this._setBtnArrow(btn, /*open*/false);
  }

  _closeAllMenus() {
    for (const m of Array.from(this.openMenus)) this._closeMenu(m);
  }

  /* ========== 슬라이더 빌더 (with throttle) ========== */
  _makeSliderRow(input) {
    const { label, min, max, val, onChange, step, procid } = input;
    const row = document.createElement('div');
    row.className = 'insp-row';

    const lab = document.createElement('div');
    lab.className = 'insp-label';
    lab.textContent = label;
    row.appendChild(lab);

    const wrap = document.createElement('div');
    wrap.className = 'slider-box';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = min; range.max = max; range.step = step; range.value = val;

    const num = document.createElement('input');
    num.type = 'number';
    num.min = min; num.max = max; num.step = step; num.value = val;

    // --- ✅ 쓰로틀 헬퍼 ---
    function throttle(fn, limit = 50) {
      let inThrottle = false;
      return function (...args) {
        if (!inThrottle) {
          fn.apply(this, args);
          inThrottle = true;
          setTimeout(() => (inThrottle = false), limit);
        }
      };
    }

    const sync = (v, typ) => {
      range.value = v;
      num.value = v;
      onChange(Number(v), typ);
    };

    // --- ✅ 디바운스 대신 쓰로틀 적용 ---
    const syncThrottled = throttle(sync, 40); // 약 25FPS

    this.isDragging = false;

    range.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      this.isDragging = true;
      this.inspectedProcId = procid;
      this.flow._commitHistory();
      sync(range.value, 'sliderdown');
    });

    range.addEventListener('mousemove', (e) => {
      e.stopPropagation();
      if (!this.isDragging) return;
      this.inspectedProcId = procid;
      // --- 🔽 디바운스 → 쓰로틀로 교체 ---
      syncThrottled(range.value, 'slidermove');
      // sync(range.value, 'slidermove');
    });

    range.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      if (!this.isDragging) return;
      this.isDragging = false;
      this.inspectedProcId = procid;
      sync(range.value, 'sliderup');
    });

    num.addEventListener('change', (e) => {
      e.stopPropagation();
      this.flow._commitHistory();
      this.inspectedProcId = procid;
      sync(num.value, 'inspector');
    });

    wrap.append(range, num);
    row.appendChild(wrap);
    return row;
  }


  /* ========== 3D 런타임 이벤트 ========== */

  _emitRuntimeChanged(opts) {
    const detail = this._safe(this.flow._snapshot, this.flow) || null;
    detail.opts = opts;
    if (!detail) return;
    window.dispatchEvent(new CustomEvent('simflow:changed', { detail }));
  }
}

// ===== ProcessFlow 주입 =====
window.addEventListener('DOMContentLoaded', () => {
  const processflow = window.prj.processFlow;
  if (!processflow) return;

  const inspector = new Inspector(processflow);

  // 카드 생성 시 Edit 버튼 핸들러 주입
  const origMakeCardRow = processflow._makeCardRow.bind(processflow);
  processflow._makeCardRow = function (idx) {
    const row = origMakeCardRow(idx);
    const card = row.querySelector('.processflow-card');
    const editBtn = card.querySelector('.icon-btn');
    const proc = this.processes[idx];

    editBtn.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      inspector.toggle(card, proc);
    });

    if (inspector.expandedIds.has(proc.id) && !card.querySelector('.inspector-panel')) {
      inspector._ensurePanelImmediate(card, proc);
    }
    return row;
  };

  // render 이후 인스펙터 복원
  const origRender = processflow.render.bind(processflow);
  processflow.render = function (opts) {
    origRender(opts);
    inspector.rehydrateAll();
  };


  window.prj.inspector = inspector;
});
