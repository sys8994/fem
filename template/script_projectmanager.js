class ProjectManager {
    constructor() {
        this.projectList = [];
        this.projectContainer = document.getElementById('project-card-container');
        this.mainPanel = document.getElementById('main-project');
        this.managerPanel = document.getElementById('project-manager-panel');
        this.projectName = document.getElementById('project-name');
        this.saveBtn = document.getElementById('project-save');
        this.saveasBtn = document.getElementById('project-saveas');
        this.shareBtn = document.getElementById('project-share');
        this.newBtn = document.getElementById('btn-new-project');
        this.goHomeBtn = document.getElementById('project-go-home');
        this.loadedProject = null;
        this.currentTab = 'processflow-panel';
        this.isEdited = false;

        this.GH_TOKEN = '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';

        this.author = 'ysun1.song';

        this._init();
    }

    deepClone(o) {
        return JSON.parse(JSON.stringify(o))
    };

    _init() {
        // Load from localStorage
        this.loadProjectList();
        this.renderProjectList();

        // Bind events
        this.projectName.onclick = () => this.renameProject();
        this.saveBtn.onclick = () => this.saveCurrentProject('save');
        this.saveasBtn.onclick = () => this.saveCurrentProject('saveas');
        this.shareBtn.onclick = () => this.shareCurrentProject();
        this.newBtn.onclick = () => this.newProject();
        this.goHomeBtn.onclick = () => this.goHome();

        // tab click bind events
        const tabs = document.querySelectorAll('.tab');
        window.prj.activePanel = 'processflow-panel';
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchTab(tab.dataset.tab);
            });
        });

    }

    // ==============================
    // Project List Handling
    // ==============================
    loadProjectList() {
        const data = localStorage.getItem('projectList');
        if (data) {
            try {
                this.projectList = JSON.parse(data);
            } catch {
                console.error('Failed to parse project list');
                this.projectList = [];
            }
        }
    }

    saveProjectList() {
        localStorage.setItem('projectList', JSON.stringify(this.projectList));
    }

    renderProjectList() {
        this.projectContainer.innerHTML = '';
        if (!this.projectList.length) {
            this.projectContainer.innerHTML = `<p style="color:#aaa; text-alignment: center; width:100%; font-size: 18px; font-style: italic;">No projects found. Sketch your ideation!</p>`;
            return;
        }

        this.projectList.forEach((prj, idx) => {

            const prjDiv = document.createElement('div');
            prjDiv.className = 'project-card';
            prjDiv.innerHTML = `
                <button class="project-upperbtn project-upperbtn-copy" title="Copy"><i class="fa-solid fa-copy"></i></button>
                <button class="project-upperbtn project-upperbtn-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
                <div class="project-thumb">
                    ${prj.thumbnail ? `<img src="${prj.thumbnail}" class="thumb-img">` : `<div class="thumb-placeholder">No Preview</div>`}
                </div>
                <div class="project-info">
                    <div class="project-name">${prj.name || 'Untitled Project'}</div>
                    <div class="project-meta">Created: ${prj.created || '-'}</div>
                    <div class="project-meta">Modified: ${prj.modified || '-'}</div>
                    <div class="project-meta">Processes: ${prj.processnum|| '-'} steps</div>
                    <div class="project-meta">Author: ${prj.author || '-'}</div>
                </div>
            `;


            // 삭제 버튼
            const deleteBtn = prjDiv.querySelector('.project-upperbtn-delete');
            deleteBtn.onclick = (e) => {
                e.stopPropagation(); // 카드 클릭 이벤트 차단
                window.prj.customModal.confirm(`Are you sure to delete "${prj.name}"?`).then(ok => {
                    if (ok) this.deleteProject(idx);
                });
            };

            // copy 버튼
            const copyBtn = prjDiv.querySelector('.project-upperbtn-copy');
            copyBtn.onclick = (e) => {
                e.stopPropagation(); // 카드 클릭 이벤트 차단
                const oldName = prj.name + '_copied';
                window.prj.customModal.prompt(`Enter copied project name:`, oldName).then(newName => {
                    if (newName) this.copyProject(idx, newName);
                });
            };

            // 카드 클릭 시 프로젝트 로드
            prjDiv.onclick = () => this.loadProject(idx);
            this.projectContainer.appendChild(prjDiv);
        });
    }

    deleteProject(index) {
        if (index < 0 || index >= this.projectList.length) return;
        this.projectList.splice(index, 1);
        this.saveProjectList();
        this.renderProjectList();
    }

    copyProject(index, newName) {
        if (index < 0 || index >= this.projectList.length) return;
        let prj = this.deepClone(this.projectList[index]);

        prj.prjid = 'prj' + Date.now().toString().slice(-10);
        prj.name = newName;
        prj.created = new Date().toLocaleString();
        prj.modified = new Date().toLocaleString();
        prj.snapshot.prjname = newName;

        this.projectList.unshift(prj);
        this.saveProjectList();
        this.renderProjectList();
    }

    // ==============================
    // Project Operations
    // ==============================
    async renameProject() {
        const oldName = this.projectName.innerText;
        const newName = await window.prj.customModal.prompt(`Enter new project name:`, oldName);
        if (!newName) return;
        window.prj.processFlow._commitHistory();
        this.projectName.innerText = newName;

    }

    async saveCurrentProject(typ) {
        let dataURL;
        if (typ == 'saveas') {
            const oldName = this.projectName.innerText + '_copy';
            const newName = await window.prj.customModal.prompt(`Enter copied project name:`, oldName);
            if (!newName) return;
            this.projectName.innerText = newName;
        }
        dataURL = this._save3DStructure();
        this._commitProjectSave(dataURL, typ);
    }


    _save3DStructure() {
        const runtime = window.prj?.processRuntime;
        const renderer3D = runtime?.renderer3D;
        const scene = renderer3D?.scene;

        if (!scene) {
            console.warn('No active 3D scene for thumbnail capture.');
            this._commitProjectSave(null);
            return;
        }

        // ---- 1. 썸네일용 더미 카메라 ----
        const camera = new THREE.PerspectiveCamera(45, 240 / 220, 1, 50000);
        camera.up.set(0, 0, 1);
        camera.position.set(400, -400, 500);   // default angle
        camera.lookAt(0, 0, 100);

        // ---- 2. 더미 렌더러 생성 (off-screen) ----
        const dummyRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        dummyRenderer.setSize(240, 220);
        dummyRenderer.setClearColor(0x12161c); // 배경색 동일하게

        // ---- 3. 한 프레임 렌더링 ----
        dummyRenderer.render(scene, camera);

        // ---- 4. 이미지 캡처 ----
        let dataURL = null;
        try {
            dataURL = dummyRenderer.domElement.toDataURL('image/png');
        } catch (err) {
            console.warn('Thumbnail capture failed:', err);
        }

        // ---- 5. WebGL 리소스 정리 (메모리 누수 방지) ----
        dummyRenderer.dispose();

        return dataURL;
    }


    _commitProjectSave(thumbnail, typ) {
        let prj;
        if ((!this.loadedProject) | (typ == 'saveas')) {
            prj = {
                name: this.projectName.innerText,
                prjid: 'prj' + Date.now().toString().slice(-10),
                created: new Date().toLocaleString(),
                modified: new Date().toLocaleString(),
                author: this.author,
                snapshot: window.prj.processFlow._snapshot(),
                mask: window.prj?.maskmanager?.maskList || [],
                thumbnail: thumbnail || null,                
            };
        } else {
            prj = this.loadedProject;
            prj.name = this.projectName.innerText;
            prj.modified = new Date().toLocaleString();
            prj.mask = window.prj?.maskmanager?.maskList || [];
            prj.thumbnail = thumbnail;
            prj.snapshot = window.prj.processFlow._snapshot();
        }
        prj.processnum = prj.snapshot.processes.filter(step => (step.kind !== 'GROUPSTART') && (step.kind !== 'GROUPEND')).length;

        this.loadProjectList();

        const index = this.projectList.findIndex(obj => obj.prjid === prj.prjid);
        if (index !== -1) { // 동일한 id를 가진 객체가 이미 있으면 교체            
            this.projectList[index] = prj;
        } else { // 없으면 새로 추가            
            this.projectList.unshift(prj);
        }
        this.saveProjectList();
        this.loadedProject = prj;
        if (this.ignoreAlert) {
            this.renderProjectList();
            this.ignoreAlert = false;
        } else {
            window.prj.customModal.alert("Project saved!").then(() => {
                this.renderProjectList();
            });
        }
        this._setEditStarStatus(false);
    }

    _setEditStarStatus(typ) {
        const star = document.getElementById("project-star-edited");
        this.isEdited = typ;
        if (typ) star.style.visibility = 'visible';
        else star.style.visibility = 'hidden';
    }


    loadProject(index) {

        let prj = this.projectList[index];
        if (!prj) return;
            
        this.loadedProject = prj;
        // TODO: 실제 데이터 초기화/로드 로직
        this.projectName.innerText = prj.name;
        this.managerPanel.classList.add('hidden');
        this.mainPanel.classList.remove('hidden');

        window.prj.maskmanager.maskList = prj.mask;
        window.prj.maskmanager.renderMaskList();
        window.prj.processFlow.initiate(prj.snapshot);
        window.prj.processRuntime.renderer3D.setDefaultCamera();
        this.switchTab(this.currentTab);
        this._setEditStarStatus(false);

    }


    async loadSharedProject(prjid) {

        const snapshotPath = `sharedprojects/${prjid}.json`;
        const apiBase = `https://github.samsungds.net/api/v3/repos/ysun1-song/layvue-db`;
        const snapshotURL = `${apiBase}/contents/${snapshotPath}`;
        const res = await fetch(snapshotURL, {
            method: "GET",
            headers: { "Authorization": `token ${this.GH_TOKEN}` }
        });    

        if (!res.ok) {
            window.prj.customModal.alert("Cannot open shared Project!")
            return;
        }
        const data = await res.json();
        const decodeB64 = (b64) => decodeURIComponent(escape(atob(b64)));
        const decoded = decodeB64(data.content);
        let prj;
        try {
            prj = JSON.parse(decoded);
        } catch (e) {
            console.error("JSON parse error:", e);
            console.log("Decoded text:", decoded);
            throw new Error("Snapshot decoding failed.");
        }
        if (!prj) return;
        
        

        this.loadedProject = prj;
        // TODO: 실제 데이터 초기화/로드 로직
        this.projectName.innerText = prj.name;
        this.managerPanel.classList.add('hidden');
        this.mainPanel.classList.remove('hidden');

        window.prj.maskmanager.maskList = prj.mask;
        window.prj.maskmanager.renderMaskList();
        window.prj.processFlow.initiate(prj.snapshot);
        window.prj.processRuntime.renderer3D.setDefaultCamera();
        this.switchTab(this.currentTab);
        this._setEditStarStatus(false);

    }

    newProject() {
        this.loadedProject = null;
        this.managerPanel.classList.add('hidden');
        this.mainPanel.classList.remove('hidden');


        window.prj.maskmanager.maskList = [];
        window.prj.maskmanager.renderMaskList();
        window.prj.processFlow.initiate(null);
        window.prj.processRuntime.renderer3D.setDefaultCamera();
        this.switchTab(this.currentTab);
        this._setEditStarStatus(false);


    }


    // ==============================
    // Project Sharing
    // ==============================

    // ProjectManager class 내부에 추가
    async shareCurrentProject() {

        const ok = await window.prj.customModal.confirm(`Are you sure to Share "${prj.name}"?`)
        if (!ok) return;

        if (this.isEdited) {
            this.ignoreAlert = true;
            this.saveCurrentProject();
        }


        const prjid = this.loadedProject.prjid;
        const index = this.projectList.findIndex(obj => obj.prjid === prjid);
        const currentPrj = this.projectList[index];



        if (!prjid) throw new Error("Project has no prjid");

        // Small utils
        const encodeB64 = (str) => btoa(unescape(encodeURIComponent(str)));
        const decodeB64 = (b64) => decodeURIComponent(escape(atob(b64)));

        const apiBase = `https://github.samsungds.net/api/v3/repos/ysun1-song/layvue-db`;
        const metadataPath = `sharedprojects/public_projects.json`;

        // ----------------------------
        // 1) Load metadata first
        // ----------------------------
        let metaArray = [];
        let metaSha = null;

        const metaURL = `${apiBase}/contents/${metadataPath}`;
        const metaRes = await fetch(metaURL, {
            method: "GET",
            headers: { "Authorization": `token ${this.GH_TOKEN}` }
        });

        if (metaRes.status === 200) {
            const metaData = await metaRes.json();
            metaSha = metaData.sha;
            metaArray = JSON.parse(decodeB64(metaData.content));
        } else if (metaRes.status === 404) {
            // metadata not found → create new
            metaArray = [];
        } else {
            const err = await metaRes.json();
            throw new Error("Failed to load metadata.");
        }

        // ----------------------------
        // 2) Check if prjid exists in metadata
        // ----------------------------
        let isUpdate = metaArray.some(e => e.prjid === prjid);

        // ----------------------------
        // 3) Prepare snapshot upload
        // ----------------------------
        const snapshotPath = `sharedprojects/${prjid}.json`;
        const snapshotURL = `${apiBase}/contents/${snapshotPath}`;
        const snapshotStr = JSON.stringify(currentPrj);
        const snapshotB64 = encodeB64(snapshotStr);

        // find snapshot sha if exists
        let snapshotSha = null;
        const snapCheck = await fetch(snapshotURL, {
            method: "GET",
            headers: { "Authorization": `token ${this.GH_TOKEN}` }
        });


        if (snapCheck.status === 200) {
            const snapData = await snapCheck.json();
            snapshotSha = snapData.sha;
        } else if (snapCheck.status !== 404) {
            const err = await snapCheck.json();
            console.error(err);
            throw new Error("Failed to check snapshot existence.");
        }

        // ----------------------------
        // 4) Upload snapshot (create/update)
        // ----------------------------
        const snapBody = {
            message: isUpdate ? `Update snapshot ${prjid}` : `Create snapshot ${prjid}`,
            content: snapshotB64,
            branch: "main"
        };
        if (snapshotSha) snapBody.sha = snapshotSha;

        const snapUpload = await fetch(snapshotURL, {
            method: "PUT",
            headers: {
                "Authorization": `token ${this.GH_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(snapBody)
        });

        if (!snapUpload.ok) {
            const err = await snapUpload.json();
            console.error(err);
            throw new Error("Snapshot upload failed.");
        }

        // ----------------------------
        // 5) Create or update metadata
        // ----------------------------
        const prjMetaData = {
            prjid: prjid,
            name: currentPrj.name || `Project ${prjid}`,
            created: currentPrj.created,
            modified: currentPrj.modified,
            author: currentPrj.author,
            thumbnail: currentPrj.thumbnail,
            processnum: currentPrj.processnum,
        };

        const metaIndex = metaArray.findIndex(obj => obj.prjid === prjid);
        if (metaIndex !== -1) { // 동일한 id를 가진 객체가 이미 있으면 교체            
            metaArray[metaIndex] = prjMetaData;
        } else { // 없으면 새로 추가            
            metaArray.unshift(prjMetaData);
        }

        const newMetaStr = JSON.stringify(metaArray, null, 2);
        const newMetaB64 = encodeB64(newMetaStr);

        const metaBody = {
            message: isUpdate ? `Update metadata for ${prjid}` : `Add metadata for ${prjid}`,
            content: newMetaB64,
            branch: "main"
        };
        if (metaSha) metaBody.sha = metaSha;

        const metaUpload = await fetch(metaURL, {
            method: "PUT",
            headers: {
                "Authorization": `token ${this.GH_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(metaBody)
        });

        if (!metaUpload.ok) {
            const err = await metaUpload.json();
            console.error(err);
            throw new Error("Metadata update failed.");
        }

        
        let isDevMode = window.location.href.includes('layvue/index.html')
        let homeUrl;
        if (isDevMode) {
            if (location.origin === "null" || location.protocol === "file:") {
                homeUrl = "file://" + location.pathname.substring(0, location.pathname.lastIndexOf("/") + 1);
            } else {
                homeUrl = location.origin + location.pathname.substring(0, location.pathname.lastIndexOf("/") + 1);
            }
            homeUrl = homeUrl + 'index.html'
        } else {
            homeUrl = `https://github.samsungds.net/pages/ysun1-song/layvue/`
        }


        const newUrl =  `${homeUrl}?q=${prjid}`;
        navigator.clipboard.writeText(newUrl);

        this.shareBtn.innerHTML = '<i class="fa-solid fa-check"></i>'
        window.prj.customModal.alert("Project URL copied!")
        setTimeout(() => {
            this.shareBtn.innerHTML = '<i class="fa-solid fa-share-nodes"></i>';     // 1초 뒤 다시 B로 변경
        }, 2000);






        return;
    }















    // ==============================
    // Panel Switching
    // ==============================
    async goHome() {

        if (this.isEdited) {
            const result = await window.prj.customModal.confirm(`Unsaved project data will be lost. Continue?`);
            if (!result) return;
        }

        this.mainPanel.classList.add('hidden');
        this.managerPanel.classList.remove('hidden');
        this.currentTab = 'processflow-panel';
        this.loadProjectList();
        this.renderProjectList();
    }

    // ==============================
    // Tab Switching
    // ==============================

    switchTab(tabId) {

        const tabs = document.querySelectorAll('.tab');
        const panels = document.querySelectorAll('.work-panel');
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));

        for (let tab of tabs) {
            if (tab.dataset.tab !== tabId) continue
            tab.classList.add('active');
        }
        document.getElementById(tabId).classList.add('active');
        this.currentTab = tabId;

        if (tabId == 'processflow-panel') {
            window.prj.processFlow.render();
            window.prj.processRuntime.renderer3D._onResize();
        }
    }
}











/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    window.prj = window.prj || {};
    window.prj.projectManager = new ProjectManager();
});
