export function openModal(id: string) {
  document.getElementById(id)?.classList.add('open')
}

export function closeModal(id: string) {
  document.getElementById(id)?.classList.remove('open')
}

// ── Custom prompt/confirm dialogs ──

function getPromptModal(): HTMLElement {
  let modal = document.getElementById('customPromptModal')
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'customPromptModal'
    modal.className = 'modal-overlay'
    modal.innerHTML = `
      <div class="modal-box" style="max-width:400px">
        <h3 id="cpmTitle">输入</h3>
        <p class="sub" id="cpmDesc"></p>
        <input type="text" id="cpmInput" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,0.04);color:var(--text);font-size:13px;outline:none;font-family:var(--font)">
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cpmCancelBtn">取消</button>
          <button class="btn btn-primary" id="cpmConfirmBtn">确定</button>
        </div>
      </div>`
    document.body.appendChild(modal)
    modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) resolvePromptModal(false) })
    document.getElementById('cpmCancelBtn')?.addEventListener('click', () => resolvePromptModal(false))
    document.getElementById('cpmConfirmBtn')?.addEventListener('click', () => resolvePromptModal(true))
    document.getElementById('cpmInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') resolvePromptModal(true)
      if (e.key === 'Escape') resolvePromptModal(false)
    })
  }
  return modal
}

let _promptResolver: ((value: string | null) => void) | null = null

function resolvePromptModal(confirmed: boolean) {
  const modal = document.getElementById('customPromptModal')
  const input = document.getElementById('cpmInput') as HTMLInputElement
  if (modal) modal.classList.remove('open')
  if (_promptResolver) {
    _promptResolver(confirmed ? (input?.value ?? '') : null)
    _promptResolver = null
  }
}

export function promptModal(title: string, defaultValue = '', desc = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = getPromptModal()
    const titleEl = document.getElementById('cpmTitle')
    const descEl = document.getElementById('cpmDesc')
    const input = document.getElementById('cpmInput') as HTMLInputElement
    if (titleEl) titleEl.textContent = title
    if (descEl) { descEl.textContent = desc; descEl.style.display = desc ? '' : 'none' }
    if (input) { input.value = defaultValue; input.focus(); input.select() }
    _promptResolver = resolve
    modal.classList.add('open')
  })
}

function getConfirmModal(): HTMLElement {
  let modal = document.getElementById('customConfirmModal')
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'customConfirmModal'
    modal.className = 'modal-overlay'
    modal.innerHTML = `
      <div class="modal-box" style="max-width:400px">
        <h3 id="ccmTitle">确认</h3>
        <p class="sub" id="ccmDesc" style="white-space:pre-wrap"></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="ccmCancelBtn">取消</button>
          <button class="btn btn-danger" id="ccmConfirmBtn">确定</button>
        </div>
      </div>`
    document.body.appendChild(modal)
    modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) resolveConfirmModal(false) })
    document.getElementById('ccmCancelBtn')?.addEventListener('click', () => resolveConfirmModal(false))
    document.getElementById('ccmConfirmBtn')?.addEventListener('click', () => resolveConfirmModal(true))
  }
  return modal
}

let _confirmResolver: ((value: boolean) => void) | null = null

function resolveConfirmModal(confirmed: boolean) {
  const modal = document.getElementById('customConfirmModal')
  if (modal) modal.classList.remove('open')
  if (_confirmResolver) {
    _confirmResolver(confirmed)
    _confirmResolver = null
  }
}

export function confirmModal(title: string, desc = ''): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = getConfirmModal()
    const titleEl = document.getElementById('ccmTitle')
    const descEl = document.getElementById('ccmDesc')
    if (titleEl) titleEl.textContent = title
    if (descEl) { descEl.textContent = desc; descEl.style.display = desc ? '' : 'none' }
    _confirmResolver = resolve
    modal.classList.add('open')
  })
}

export function setupModalListeners() {
  // Add LoRA modal
  setupModal('addModal', 'addCancelBtn')
  document.getElementById('addUrlInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('addConfirmBtn')?.click()
  })

  // Add artist modal
  setupModal('addArtistModal', 'addArtistCancelBtn')
  document.getElementById('artistDescInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('addArtistConfirmBtn')?.click() }
  })

  // Artist image modal
  setupModal('artistImgModal', 'closeArtistImgBtn')

  // Artist extract modal
  setupModal('artistExtractModal', 'closeArtistExtractBtn')
  document.getElementById('artistImgUrl')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('artistImgAddBtn')?.click()
  })

  // Collection manage modal
  setupModal('colManageModal', 'closeColManageBtn')
  document.getElementById('newColName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('createColBtn')?.click()
  })

  // Notes modal
  setupModal('notesModal', 'notesCancelBtn')

  // Prompt edit modal
  setupModal('promptEditModal', 'promptEditCancelBtn')
  document.getElementById('pe_prompt')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { }
  })
}

function setupModal(modalId: string, closeBtnId: string) {
  const modal = document.getElementById(modalId)
  const closeBtn = document.getElementById(closeBtnId)
  closeBtn?.addEventListener('click', () => closeModal(modalId))
  modal?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal(modalId)
  })
}
