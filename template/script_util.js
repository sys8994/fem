class CustomConfirmModal {
    constructor() {
      this.modal = document.createElement('div');
      this.modal.className = 'custom-modal hidden';
      this.modal.innerHTML = `
        <div class="custom-modal-backdrop"></div>
        <div class="custom-modal-box">
          <div class="custom-modal-message"></div>
          <div class="custom-modal-buttons">
            <button class="btn-cancel">Cancel</button>
            <button class="btn-confirm">Yes</button>
          </div>
        </div>
      `;
      document.body.appendChild(this.modal);
  
      this.msgEl = this.modal.querySelector('.custom-modal-message');
      this.btnCancel = this.modal.querySelector('.btn-cancel');
      this.btnConfirm = this.modal.querySelector('.btn-confirm');
      const backdrop = this.modal.querySelector('.custom-modal-backdrop');
      const box = this.modal.querySelector('.custom-modal-box');
  
      this._resolver = null;
  
      // --- 버튼 동작 ---
      this.btnCancel.onclick = (e) => { e.stopPropagation(); this._resolve(false); };
      this.btnConfirm.onclick = (e) => { e.stopPropagation(); this._resolve(true); };
      backdrop.onclick = (e) => { e.stopPropagation(); this._resolve(false); };
  
      // --- ESC 키 ---
      document.addEventListener('keydown', (e) => {
        if (this.modal.classList.contains('hidden')) return;
        if (e.key === 'Enter') {
            e.stopPropagation();
            this._resolve(true);
        }
        if (e.key === 'Escape') {            
            e.stopPropagation();
            this._resolve(false);
        }
      });
  
      // --- 클릭 이벤트 상위 전파 차단 ---
      box.addEventListener('mousedown', e => e.stopPropagation());
      box.addEventListener('click', e => e.stopPropagation());
    }
  
    open(message) {
      this.msgEl.textContent = message;
      this.modal.classList.remove('hidden');
      return new Promise(resolve => {
        this._resolver = resolve;
      });
    }
  
    _resolve(result) {
      if (this._resolver) {
        this._resolver(result);
        this._resolver = null;
      }
      this.modal.classList.add('hidden');
    }
  }
  




/* --- 부팅 --- */
window.addEventListener('DOMContentLoaded', () => {
    const confirmModal  = new CustomConfirmModal();
    window.SIMULOBJET.confirmModal = confirmModal;   // 👈 전역 포인터  
});
  
