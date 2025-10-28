class ProjectManager {
    constructor() {
        this.projectList = [];
        this.projectContainer = document.getElementById('project-card-container');
        this.mainPanel = document.getElementById('main-project');
        this.managerPanel = document.getElementById('project-manager-panel');
        this.projectName = document.getElementById('project-name');
        this.saveBtn = document.getElementById('project-save');
        this.saveasBtn = document.getElementById('project-saveas');
        this.newBtn = document.getElementById('btn-new-project');
        this.goHomeBtn = document.getElementById('project-go-home');
        this.loadedProject = null;
        this.currentTab = 'processflow-panel';
        this.isEdited = false;

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
        this.newBtn.onclick = () => this.newProject();
        this.goHomeBtn.onclick = () => this.goHome();

        // tab click bind events
        const tabs = document.querySelectorAll('.tab');
        window.SIMULOBJET.activePanel = 'processflow-panel';
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

        this.projectList.forEach((p, idx) => {

            const card = document.createElement('div');
            card.className = 'project-card';
            card.innerHTML = `
                <button class="project-upperbtn project-upperbtn-copy" title="Copy"><i class="fa-solid fa-copy"></i></button>
                <button class="project-upperbtn project-upperbtn-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
                <div class="project-thumb">
                    ${p.thumbnail? `<img src="${p.thumbnail}" class="thumb-img">` : `<div class="thumb-placeholder">No Preview</div>`}
                </div>
                <div class="project-info">
                    <div class="project-name">${p.name || 'Untitled Project'}</div>
                    <div class="project-meta">Created: ${p.created || '-'}</div>
                    <div class="project-meta">Modified: ${p.modified || '-'}</div>
                    <div class="project-meta">Author: ${p.author || '-'}</div>
                </div>
            `;


            // 삭제 버튼
            const deleteBtn = card.querySelector('.project-upperbtn-delete');
            deleteBtn.onclick = (e) => {
                e.stopPropagation(); // 카드 클릭 이벤트 차단
                window.SIMULOBJET.customModal.confirm(`Are you sure to delete "${p.name}"?`).then( ok => {
                    if (ok) this.deleteProject(idx);
                });
            };
            
            // copy 버튼
            const copyBtn = card.querySelector('.project-upperbtn-copy');
            copyBtn.onclick = (e) => {
                e.stopPropagation(); // 카드 클릭 이벤트 차단
                const oldName = p.name+'_copied';
                window.SIMULOBJET.customModal.prompt(`Enter copied project name:`, oldName).then( newName => {
                    if (newName) this.copyProject(idx,newName);
                });
            };

            // 카드 클릭 시 프로젝트 로드
            card.onclick = () => this.loadProject(idx);
            this.projectContainer.appendChild(card);
        });
    }

    deleteProject(index) {
        if (index < 0 || index >= this.projectList.length) return;
        this.projectList.splice(index, 1);
        this.saveProjectList();
        this.renderProjectList();
    }    

    copyProject(index,newName) {
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
        const newName = await window.SIMULOBJET.customModal.prompt(`Enter new project name:`, oldName);
        if (!newName) return;
        window.SIMULOBJET.processFlow._commitHistory();
        this.projectName.innerText = newName;
        
    }
    
    async saveCurrentProject(typ) {
        let dataURL;
        if (typ == 'saveas') { 
            const oldName = this.projectName.innerText + '_copy';
            const newName = await window.SIMULOBJET.customModal.prompt(`Enter copied project name:`, oldName);
            if (!newName) return;
            this.projectName.innerText = newName;
        } 
        dataURL = this._save3DStructure();
        this._commitProjectSave(dataURL,typ);      
      }
      

      _save3DStructure() {
        const runtime = window.SIMULOBJET?.processRuntime;
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
      

    _commitProjectSave(thumbnail,typ) {
        let prj;
        if ((!this.loadedProject) | (typ=='saveas')) {
            prj = {
                name: this.projectName.innerText,
                prjid: 'prj' + Date.now().toString().slice(-10),
                created: new Date().toLocaleString(),
                modified: new Date().toLocaleString(),
                author: 'ysun1.song',
                snapshot: window.SIMULOBJET.processFlow._snapshot(),
                process: window.SIMULOBJET?.processFlow?.processes || [],
                mask: window.SIMULOBJET?.maskmanager?.maskList || [],
                thumbnail: thumbnail || null,
            };
        } else {
            prj = this.loadedProject;
            prj.name = this.projectName.innerText;
            prj.modified = new Date().toLocaleString();
            prj.process = window.SIMULOBJET?.processFlow?.processes || [];
            prj.mask = window.SIMULOBJET?.maskmanager?.maskList || [];
            prj.thumbnail = thumbnail;
            prj.snapshot= window.SIMULOBJET.processFlow._snapshot();
        }
        this.loadProjectList();

        const index = this.projectList.findIndex(obj => obj.prjid === prj.prjid);
        if (index !== -1) { // 동일한 id를 가진 객체가 이미 있으면 교체            
            this.projectList[index] = prj;
          } else { // 없으면 새로 추가            
            this.projectList.unshift(prj); 
          }        
        this.saveProjectList();
        this.loadedProject = prj;
        window.SIMULOBJET.customModal.alert("Project saved!").then(() => {
            this.renderProjectList();
        });
        this._setEditStarStatus(false);
    }

    _setEditStarStatus(typ) {
        const star = document.getElementById("project-star-edited");
        this.isEdited = typ;
        if (typ) star.style.visibility = 'visible';
        else star.style.visibility = 'hidden';
      }

    loadProject(index) {
        const prj = this.projectList[index];
        if (!prj) return;

        this.loadedProject = prj;
        // TODO: 실제 데이터 초기화/로드 로직
        this.projectName.innerText = prj.name;
        this.managerPanel.classList.add('hidden');
        this.mainPanel.classList.remove('hidden');
        
        // window.SIMULOBJET.processFlow.initiate(prj.process);
        window.SIMULOBJET.maskmanager.maskList = prj.mask;
        window.SIMULOBJET.maskmanager.renderMaskList();
        
        window.SIMULOBJET.processFlow.initiate(prj.snapshot); 
        this.switchTab(this.currentTab);
        this._setEditStarStatus(false);

    }

    newProject() {
        this.loadedProject = null;
        this.managerPanel.classList.add('hidden');
        this.mainPanel.classList.remove('hidden');

        
        window.SIMULOBJET.maskmanager.maskList = [];

        window.SIMULOBJET.processFlow.initiate(null);
        this.switchTab(this.currentTab);
        this._setEditStarStatus(false);
        
    }

    // ==============================
    // Panel Switching
    // ==============================
    async goHome() {

        if (this.isEdited) {
            const result = await window.SIMULOBJET.customModal.confirm(`Unsaved project data will be lost. Continue?`);
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
            window.SIMULOBJET.processFlow.render();
            window.SIMULOBJET.processRuntime.renderer3D._onResize();
        }

    }




}











/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    window.SIMULOBJET = window.SIMULOBJET || {};
    window.SIMULOBJET.projectManager = new ProjectManager();
});
