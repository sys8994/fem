<!DOCTYPE html>
<html lang="ko">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SIMULOB</title>
  <link rel="stylesheet" href="template/style.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">

  <!-- Three.js & OrbitControls -->
  <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.0/fabric.min.js"></script>

</head>

<body>
  <div class="top-bar">
    <div class="top-bar-left">
      <span class="app-title">SIMULOBJ</span>
      <span class="project-title">Process-First MVP</span>
    </div>
    <div class="top-bar-right">
      <button class="top-bar-button"><i class="fa-solid fa-circle-info"></i></button>
      <button class="top-bar-button"><i class="fa-solid fa-floppy-disk"></i></button>
      <button class="top-bar-button"><i class="fa-solid fa-share-nodes"></i></button>
    </div>
  </div>

  <div class="main-content">
    <div class="tab-panel">
      <div class="tab active" data-tab="processflow-panel">Process Flow</div>
      <div class="tab" data-tab="maskeditor-panel">Mask Editor</div>
      <div class="tab" data-tab="materials-panel">Materials</div>
      <div class="tab" data-tab="simulation-panel">Simulation</div>
    </div>

    <!-- ================================================ 1. Process Flow Tab ================================================ -->
    <div id="processflow-panel" class="work-panel active">
      <!-- 좌: 캔버스 -->
      <div class="viewer-area" id="viewer-container-process"></div>
      <!-- 우: 프로세스 플로우 패널 -->
      <div class="input-panel" id="processflow-control-panel">
        <div class="rightpanel-header">
          <div>
            <div class="rightpanel-title">Process Flow</div>
          </div>
          <div>
            <button class="rightpanel-btn1" id="processflow-add-btn" title="현재 select bar 위치에 새 공정 추가"><i class="fa-solid fa-plus"></i> Process</button>
            <button class="rightpanel-btn1" id="processflow-setting"><i class="fa-solid fa-gear"></i> Setting</button>
          </div>
        </div>

        <div class="processflow-card-list" id="processflow-card-list">
          <!-- JS가 gap-row / card-row를 동적으로 전부 구성 -->
        </div>
      </div>
    </div>

    <!-- ================================================ 2. Mask Editor Tab ================================================ -->
    <div id="maskeditor-panel" class="work-panel">

      <!-- Mask Manager ==================================== -->
      <div id="maskeditor-main-maskmanager" class="work-subpanel active">
        <!-- 좌: Mask list -->
          <div class="masklist-viewer-area" >
            <div>
              <div class="row2">
                <div class="rightpanel-title" style="margin: 10px; padding: 10px;">Mask Manager :</div>
                <button class="rightpanel-btn3" id="btnCreateNewMask"><i class="fa-solid fa-plus"></i>Create Mask</button>
                <button class="rightpanel-btn3 unclickable" id="btnEditMask"><i class="fa-solid fa-pen-to-square"></i>Edit Mask</button>
                <button class="rightpanel-btn3 unclickable" id="btnCopyMask"><i class="fa-solid fa-copy"></i>Copy Mask</button>
                <button class="rightpanel-btn3 unclickable" id="btnDeleteMask"><i class="fa-solid fa-trash"></i>Delete Mask</button>
              </div>
            </div>
            <div id="maskListContainer"></div>

          </div>

      </div>


      <!-- Mask Editor ==================================== -->
      <div id="maskeditor-main-maskeditor" class="work-subpanel">

        <!-- 좌: 캔버스 -->
        <div class="viewer-area" id="viewer-container-mask">
          <canvas id="canvas-mask" style="width: 100%; height: 100%;"></canvas>
          <div id="text-coordi-xy"></div>
        </div>

        <!-- 우: Mask Editor panel -->
        <div class="input-panel" id="maskeditor-control-panel">
          <div class="rightpanel-header">
            <div>
              <div class="rightpanel-title">Mask Editor</div>
            </div>
            <div>
              <button class="rightpanel-btn1" id="maskeditor-list"><i class="fa-solid fa-list"></i> Mask List</button>
              <button class="rightpanel-btn1" id="maskeditor-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
              <button class="rightpanel-btn1" id="maskeditor-setting"><i class="fa-solid fa-gear"></i> Setting</button>
            </div>
          </div>

          <input id="inpStep" type="number" min="1" value="10" style="display:none;" />


          <div class="toolbar" id="maskeditor-addShapes">
            
            <div class="row">
              <div class="maskeditor-midtext">Mask Name : </div><input id="inpMaskName" type="text" placeholder="Enter Mask Name" style="margin: 5px 5px 5px 0px !important;"/><div id="maskeditor-star-edited" style="margin:0px 10px 10px 0px; visibility:hidden;">*</div>
            </div>

            <div class="divider"></div>
            
            <div class="maskeditor-midtext">Add Shape</div>
            <div class="row">
              <button class="rightpanel-btn2" id="btnAddRect"><i class="fa-regular fa-square"></i>Rectangle</button>
              <button class="rightpanel-btn2" id="btnAddCircle"><i class="fa-regular fa-circle"></i>Circle</button>
              <button class="rightpanel-btn2" id="btnAddFreeform"><i class="fa-solid fa-draw-polygon"></i>Polygon</button>
            </div>
          </div>

          <div style="height:10px;"></div> <!-- Padding==================================================== -->

          <div class="toolbar" id="maskeditor-editShapeBox" style="display:none;">
            <div class="maskeditor-midtext">Edit Shape</div>
            
            <!-- Dimension -->
            <div class="row">
              <label class="rightpanel-label">Left (nm)</label><input id="inpLeft" type="number" step="1" />
              <label class="rightpanel-label" style="margin-left: 15px;">Top (nm)</label><input id="inpTop" type="number" step="1" />
            </div>
            <div class="row">
              <label class="rightpanel-label">Width (nm)</label><input id="inpWidth" type="number" step="1" min="1" />
              <label class="rightpanel-label" style="margin-left: 15px;">Height (nm)</label><input id="inpHeight" type="number" step="1" min="1" />
            </div>

            <div class="divider"></div>
            
            <!-- Polarity -->
            <div class='row'><button class="rightpanel-btn2" id="btnTogglePolarity" style="flex:1 !important; min-width:0;"><i class="fa-solid fa-circle-half-stroke"></i>Toggle Polarity</button></div>
            
            <div class="divider"></div>

            <!-- Order -->
            <div class='row'>
              <button class="rightpanel-btn2" id="btnForward" title="Bring Forward"><i class="fa-solid fa-arrow-up-short-wide"></i>Bring Forward</button>
              <button class="rightpanel-btn2" id="btnToFront" title="Bring to Front"><i class="fa-solid fa-layer-group"></i>Bring to Front</button>
            </div>
            <div class='row'>
              <button class="rightpanel-btn2" id="btnBackward" title="Send Backward"><i class="fa-solid fa-arrow-down-wide-short"></i>Send Backward</button>
              <button class="rightpanel-btn2" id="btnToBack" title="Send to Back"><i class="fa-solid fa-layer-group fa-rotate-180"></i>Send to Back</button>
            </div>

          </div>

          <div style="height:10px;"></div> <!-- Padding==================================================== -->

          <div class="toolbar" id="maskeditor-alignBox" style="display:none;">
            <div class="maskeditor-midtext">Edit Alignment</div>


            <!-- Horizontal Align -->
            <div class='row'>
              <button class="rightpanel-btn2" id="btnAlignLeft" title="Align Left"><i class="fa-solid fa-align-left"></i> Align Left</button>
              <button class="rightpanel-btn2" id="btnAlignHCenter" title="Align Center"><i class="fa-solid fa-align-center"></i> Align Center</button>
              <button class="rightpanel-btn2" id="btnAlignRight" title="Align Right"><i class="fa-solid fa-align-right"></i> Align Right</button>
            </div>

            <div class="divider"></div>

            <!-- Vertical Align -->
            <div class='row'>
              <button class="rightpanel-btn2" id="btnAlignTop" title="Align Top"><i class="fa-solid fa-up-long"></i> Align Top</button>
              <button class="rightpanel-btn2" id="btnAlignVCenter" title="Align Middle"><i class="fa-solid fa-arrows-up-down"></i> Align Middle</button>
              <button class="rightpanel-btn2" id="btnAlignBottom" title="Align Bottom"> <i class="fa-solid fa-down-long"></i> Align Bottom</button>
            </div>

            <div class="divider"></div>

            <!-- Distribute -->
            <div class='row'>
              <button class="rightpanel-btn2" id="btnDistH" title="Distribute Horizontally"><i class="fa-solid fa-arrows-left-right"></i> Distribute Horizontally</button>
              <button class="rightpanel-btn2" id="btnDistV" title="Distribute Vertically"><i class="fa-solid fa-arrows-up-down"></i> Distribute Vertically</button>
            </div>
          </div>
          
          <div id="test"></div>

          








        </div>
        
      </div>
    </div>

  </div>

  <!-- ================================================ 3. materials Tab ================================================ -->
  <div id="materials-panel" class="work-panel">
    <p style="padding: 20px; color: var(--text-secondary)">Materials panel
      준비 중…</p>
  </div>

  <!-- ================================================ 4. simulation Tab ================================================ -->
  <div id="simulation-panel" class="work-panel">
    <p style="padding: 20px; color: var(--text-secondary)">Simulation panel
      준비 중… (공정 ↔ ColumnGrid 연동 후 구현)</p>
  </div>

  </div>

  <!-- 탭 전환 최소 스크립트 -->
  <script>
    window.SIMULOBJET = window.SIMULOBJET || {};
    const tabs = document.querySelectorAll('.tab');
    const panels = document.querySelectorAll('.work-panel');
    window.SIMULOBJET.activePanel = 'processflow-panel';
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
        window.SIMULOBJET.activePanel = tab.dataset.tab;

        if (tab.dataset.tab == 'processflow-panel') { 
          window.SIMULOBJET.processFlow.render();
          window.SIMULOBJET.processRuntime.renderer3D._onResize();
        }
      });
    });
  </script>

  <script src="template/script_processflow.js"></script>
  <script src="template/script_columngrid.js"></script>
  <script src="template/script_runtime.js"></script>
  <script src="template/script_inspector.js"></script>
  <script src="template/script_maskeditor.js"></script>
  <script src="template/script_util.js"></script>

</body>

</html>
