// ===== 3D 렌더러 (VRAM 누수 방지, 인스턴스 용량 관리, 요청형 렌더) =====



// ===== 프로세스 실행기 =====
class ProcessRuntime {
    constructor(domain) {
        // 렌더러 준비
        this.renderer3D = window.prj.gridRenderer;




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

        if ((step.kind === 'GROUPSTART') || step.kind === 'GROUPEND') return;

        if ((step.kind === 'NEW') || (['DEPO', 'ALD', 'ETCH', 'WETETCH', 'STRIP'].includes(step.kind) && ((step.material === '-') || (step.material === '')))) return;
        if (step.mask === 'deleted') return;

        let kind = (step.kind || '').toUpperCase();

        const mat = step.material == 'ALL' ? 255 :
            (step.material == '' || step.material == '-') ? 0 : window.prj.processFlow.materialColor[step.material].id || null;

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



        const processesOri = snapshot?.processes || [];
        const processes = processesOri.filter(a => (a.kind !== 'GROUPSTART') && (a.kind !== 'GROUPEND')); // groupstart/end 제외
        const nSaveIntervalDefault = Math.max(3, Math.floor(processes.length / this.grid.nMaxCache)); // sparse cache 조건: 3step 간격 이상, 최대 10개 까지

        const nowProcId = snapshot?.arrowBoundId;
        const nowProcIndex = this._arrowGapIndex(processes, nowProcId);
        const processesUptoNow = processes.slice(0, nowProcIndex);
        // if (processesUptoNow.length === 0) return;


        const changeProcId = opts.procId;
        const changeProcIndex = this._arrowGapIndex(processes, changeProcId);
        const cacheIdxFinder = opts.typ === 'explorer' ? nowProcIndex-1 : opts.typ === 'process' ? changeProcIndex-1 : changeProcIndex-2;

        // finding last cache
        let lastCacheId = null;   
        let lastCacheIndex = 0;
        let validCacheIds = [];
        for (let p = cacheIdxFinder; p >=0; p--) {          
            if (processes[p].id in this.grid.colsCache) {
                if (!lastCacheId) {
                    lastCacheId = processes[p].id;
                    lastCacheIndex = p+1;
                }
                validCacheIds.push(processes[p].id);
            }
        }    




        if ((opts.typ === 'process') && this._deepEqual(this.oldUpto, processesUptoNow)) return;
        if (((opts.typ === 'process') || (opts.typ === 'maskchange')) && (lastCacheId === null)) {
            const initId = processes[0].id;
            this.grid.initializeCache(initId);
            this.grid.createNewGrid();
        } else {
            this.grid.loadCache(lastCacheId);
            if (opts.typ !== 'explorer') this.grid.clearCacheExcept(validCacheIds);
        }

     

        // applying steps
        if ((opts.typ === 'process') || (opts.typ === 'maskchange')) {
            let nStepSav = 0;
            for (let nstep = lastCacheIndex; nstep < nowProcIndex; nstep += 1) {
                let step = processes[nstep];
                nStepSav += 1;
                this._applyStep(this.grid, step, false);
                if ((nStepSav === nSaveIntervalDefault) || (['ALD', 'WETETCH'].includes(step.kind))) {
                    nStepSav = 0;
                    this.grid.saveCache(step.id);
                }
            }

        } else if (opts.typ === 'explorer') {
            if (this._deepEqual(this.oldUpto, processesUptoNow)) return;
            let nStepSav = 0;
            for (let nstep = lastCacheIndex; nstep < nowProcIndex; nstep += 1) {
                let step = processes[nstep];
                nStepSav += 1;
                this._applyStep(this.grid, step, false);
                if (step.id in this.grid.colsCache) nStepSav = 0;
                if ((nStepSav === nSaveIntervalDefault) || (['ALD', 'WETETCH'].includes(step.kind))) {
                    nStepSav = 0;
                    this.grid.saveCache(step.id);
                }


            }
            if (lastCacheId) this.grid.colsCache[lastCacheId][1] += 1;

        } else if ((opts.typ === 'inspector') || (opts.typ == 'sliderup')) {
            let nStepSav = 0;
            for (let nstep = lastCacheIndex; nstep < nowProcIndex; nstep += 1) {
                let step = processes[nstep];
                nStepSav += 1;
                this._applyStep(this.grid, step, false);
                if ((nstep === (changeProcIndex - 2)) || (nStepSav === nSaveIntervalDefault) || (['ALD', 'WETETCH'].includes(step.kind))) {
                    nStepSav = 0;
                    this.grid.saveCache(step.id);
                }
            }
            if (this._deepEqual(this.oldUpto, processesUptoNow)) return;
            if (lastCacheId) this.grid.colsCache[lastCacheId][1] += 1;

        } else if (opts.typ === 'sliderdown') {
            if (!this.grid.sliderCache.changedProcIndex || this.grid.sliderCache.changedProcIndex !== changeProcIndex) this.grid.sliderCache = { changedProcIndex: changeProcIndex };


            for (let nstep = lastCacheIndex; nstep < nowProcIndex; nstep += 1) {
                let step = processes[nstep];
                this._applyStep(this.grid, step, false);
                if (nstep === (changeProcIndex - 2)) {
                    this.grid.saveCache(step.id);
                }
            }

            if (this._deepEqual(this.oldUpto, processesUptoNow)) return;

        } else if (opts.typ === 'slidermove') {

            for (let nstep = lastCacheIndex; nstep < nowProcIndex; nstep += 1) {
                let step = processes[nstep];
                let useCache = changeProcIndex === nstep + 1;
                this._applyStep(this.grid, step, useCache);
            }

        }

        this.oldUpto = processesUptoNow;
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
});
