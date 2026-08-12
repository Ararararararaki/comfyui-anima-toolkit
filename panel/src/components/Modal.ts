let _lastFocused: HTMLElement | null = null

function focusableIn(el: Element): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null || el === document.activeElement)
}

function trapFocus(modal: HTMLElement, e: KeyboardEvent) {
  if (e.key !== 'Tab') return
  const items = focusableIn(modal)
  if (items.length === 0) { e.preventDefault(); return }
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
    e.preventDefault(); last.focus()
  } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
    e.preventDefault(); first.focus()
  }
}

export function openModal(id: string) {
  const modal = document.getElementById(id)
  if (!modal) return
  modal.classList.add('open')
  _lastFocused = document.activeElement as HTMLElement
  // 聚焦策略：输入框优先；无输入框时聚焦主操作按钮（data-primary / .btn-primary / 末尾按钮），
  // 避免确认框焦点落在「取消」上导致 Enter 误取消
  const inputs = focusableIn(modal).filter(el => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
  let target: HTMLElement | undefined
  if (inputs.length > 0) target = inputs[0]
  else {
    const all = focusableIn(modal)
    target = all.find(el => el.hasAttribute('data-primary')) ||
      all.find(el => el.classList.contains('btn-primary')) ||
      all[all.length - 1]
  }
  if (target) target.focus()
  else modal.setAttribute('tabindex', '-1'), modal.focus()
  // Escape 关闭 + Tab 循环（命名函数 + 显式移除，避免重复打开时监听器堆积）
  modal.removeEventListener('keydown', modalKeyHandler)
  modal.addEventListener('keydown', modalKeyHandler)
}

function modalKeyHandler(e: KeyboardEvent) {
  const modal = e.currentTarget as HTMLElement
  if (e.key === 'Escape') {
    if (modal.id === 'customPromptModal') resolvePromptModal(false)
    else if (modal.id === 'customConfirmModal') resolveConfirmModal(false)
    else closeModal(modal.id)
  } else trapFocus(modal, e)
}

export function closeModal(id: string) {
  const modal = document.getElementById(id)
  modal?.classList.remove('open')
  if (modal && document.activeElement && modal.contains(document.activeElement)) {
    _lastFocused?.focus?.()
  }
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
        <input type="text" id="cpmInput" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;outline:none;font-family:var(--font)">
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
  if (modal) {
    modal.classList.remove('open')
    if (modal.contains(document.activeElement)) _lastFocused?.focus?.()
  }
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
    if (input) input.value = defaultValue
    _promptResolver = resolve
    openModal('customPromptModal')
    // openModal 已聚焦输入框；select 全选（在 openModal 之后调用，避免 _lastFocused 记录成 input 自身）
    input?.select?.()
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
          <button class="btn btn-danger" id="ccmConfirmBtn" data-primary>确定</button>
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
  if (modal) {
    modal.classList.remove('open')
    if (modal.contains(document.activeElement)) _lastFocused?.focus?.()
  }
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
    openModal('customConfirmModal')
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
