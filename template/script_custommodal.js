class CustomModalManager {
    constructor() {
        this.activeModal = null;
        this._createBaseElements();
    }

    // ======================
    // 공통 DOM 구조 생성
    // ======================
    _createBaseElements() {
        this.modal = document.createElement('div');
        this.modal.className = 'custom-modal hidden';
        this.modal.innerHTML = `
          <div class="custom-modal-backdrop"></div>
          <div class="custom-modal-box">
            <div class="custom-modal-message"></div>
    
            <!-- Prompt -->
            <div class="custom-modal-input hidden">
              <input type="text" class="custom-modal-textbox" placeholder="Enter text...">
            </div>
    
            <!-- Material picker -->
            <div class="custom-modal-material hidden">
                <div class="material-row">
                    <label class="material-label">Material:</label>
                    <input type="text" class="material-name-input" placeholder="Enter name...">
                </div>
                <div class="material-row">
                    <label class="material-label">Color:</label>
                    <div class="color-picker-wrapper">
                    <input type="color" class="material-color-input" value="#58a6ff">
                    </div>
                </div>    
            </div>
            <div class="custom-modal-buttons"></div>
        `;
        document.body.appendChild(this.modal);

        this.msgEl = this.modal.querySelector('.custom-modal-message');
        this.inputContainer = this.modal.querySelector('.custom-modal-input');
        this.textInput = this.modal.querySelector('.custom-modal-textbox');

        this.materialContainer = this.modal.querySelector('.custom-modal-material');
        this.materialName = this.modal.querySelector('.material-name-input');
        this.materialColor = this.modal.querySelector('.material-color-input');

        this.btnContainer = this.modal.querySelector('.custom-modal-buttons');
        this.backdrop = this.modal.querySelector('.custom-modal-backdrop');
        this.box = this.modal.querySelector('.custom-modal-box');

        document.addEventListener('keydown', (e) => {
            if (this.modal.classList.contains('hidden')) return;
            if (e.key === 'Escape') this._resolve(false);
            if (e.key === 'Enter' && this.activeModal?.type !== 'alert') {
                this._resolve(true);
            }
        });

        this.backdrop.onclick = () => this._resolve(false);
        this.box.onclick = (e) => e.stopPropagation();

        this._resolver = null;
        this.activeModal = null;
    }

    // ======================
    // Core Logic
    // ======================
    _open(options) {
        const { message, type, placeholder, defaultValue } = options;

        this.activeModal = { type };
        this.msgEl.textContent = message;

        this.inputContainer.classList.toggle('hidden', type !== 'prompt');
        this.materialContainer.classList.toggle('hidden', type !== 'material');

        this.textInput.value = defaultValue || '';
        if (placeholder) this.textInput.placeholder = placeholder;

        if (type === 'material') {
            this.materialName.value = '';
            this.materialColor.value = '#58a6ff';
        }

        this.btnContainer.innerHTML = '';
        const buttons = this._getButtonsByType(type);
        buttons.forEach(b => this._createButton(b));

        this.modal.classList.remove('hidden');

        if (type === 'prompt') this.textInput.focus();
        if (type === 'material') this.materialName.focus();

        return new Promise(resolve => {
            this._resolver = (ok) => {
                this.modal.classList.add('hidden');
                this.activeModal = null;
                const result = this._returnValue(type, ok);
                resolve(result);
            };
        });
    }

    _createButton({ label, action, isPrimary }) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.className = isPrimary ? 'btn-confirm' : 'btn-cancel';
        btn.onclick = (e) => {
            e.stopPropagation();
            this._resolve(action === 'confirm'); // true or false 명확히 전달
        };
        this.btnContainer.appendChild(btn);
    }

    _resolve(ok = false) {
        if (!this._resolver) return;
        this._resolver(ok);
        this._resolver = null;
    }

    _getButtonsByType(type) {
        switch (type) {
            case 'confirm':
                return [
                    { label: 'Cancel', action: 'cancel' },
                    { label: 'Yes', action: 'confirm', isPrimary: true },
                ];
            case 'prompt':
                return [
                    { label: 'Cancel', action: 'cancel' },
                    { label: 'OK', action: 'confirm', isPrimary: true },
                ];
            case 'material':
                return [
                    { label: 'Cancel', action: 'cancel' },
                    { label: 'Add', action: 'confirm', isPrimary: true },
                ];
            default: // alert
                return [{ label: 'OK', action: 'confirm', isPrimary: true }];
        }
    }

    _returnValue(type, ok) {
        if (!ok) return null; // 🚨 취소, ESC, 바깥 클릭 등 모두 null

        if (type === 'confirm') return true;
        if (type === 'prompt') return this.textInput.value.trim();
        if (type === 'material') {
            const name = this.materialName.value.trim();
            const hex = this.materialColor.value;
            const rgb = this._hexToRgbString(hex);
            return { name, color: rgb };
        }
        if (type === 'alert') return true;
    }

    _hexToRgbString(hex) {
        const c = hex.startsWith('#') ? hex.substring(1) : hex;
        const bigint = parseInt(c, 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return `rgb(${r}, ${g}, ${b})`;
    }


    // ======================
    // Public APIs
    // ======================
    confirm(message) {
        return this._open({ message, type: 'confirm' });
    }

    alert(message) {
        return this._open({ message, type: 'alert' });
    }

    prompt(message, defaultValue = '', placeholder = 'Enter text...') {
        return this._open({ message, type: 'prompt', defaultValue, placeholder });
    }

    material(message = "Please enter material information:") {
        return this._open({ message, type: 'material' });
    }
}




/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    window.SIMULOBJET.customModal = new CustomModalManager();
});
