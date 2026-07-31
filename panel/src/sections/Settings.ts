/* ── Settings Panel ── */
import { loadSettings, saveSettings, getSettings, resetSettings, exportSettings, importSettings, type AppSettings } from '../store/settings'
import { openModal, closeModal, confirmModal, promptModal } from '../components/Modal'
import { showToast } from '../utils'
import { icon } from '../utils/icon'

const SETTINGS_MODAL_ID = 'settingsModal'

// ── Background presets ──
const BG_PRESETS: { name: string; gradient: string }[] = [
  { name: '星空', gradient: 'radial-gradient(ellipse at 20% 50%, #1a1a3e 0%, #0a0a14 50%, #060610 100%)' },
  { name: '极光', gradient: 'linear-gradient(135deg, #0a1628 0%, #0d2137 30%, #0a2a1f 60%, #0e1a2e 100%)' },
  { name: '日落', gradient: 'linear-gradient(180deg, #1a0a1e 0%, #2d1520 30%, #3d1a15 60%, #1a0a0a 100%)' },
  { name: '海洋', gradient: 'linear-gradient(180deg, #040a12 0%, #061420 40%, #081e2e 70%, #040a12 100%)' },
  { name: '森林', gradient: 'linear-gradient(180deg, #060e08 0%, #0a1a0e 40%, #0e2414 70%, #060e08 100%)' },
  { name: '霓虹', gradient: 'radial-gradient(ellipse at 50% 50%, #1a0a2e 0%, #0a0a1a 60%, #060610 100%)' },
]

// ── Font options ──
const FONT_OPTIONS = [
  { label: '系统默认', value: '' },
  { label: 'Inter', value: "'Inter', sans-serif" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
  { label: 'Noto Sans SC', value: "'Noto Sans SC', sans-serif" },
  { label: 'Source Han Sans', value: "'Source Han Sans SC', sans-serif" },
]

function renderSettingsHTML(s: AppSettings): string {
  return `
    <div class="modal-box settings-modal-box">
      <div class="settings-header">
        <h3>${icon('settings', 18)} 设置</h3>
        <button class="icon-btn" id="settingsCloseBtn" title="关闭">${icon('x', 18)}</button>
      </div>
      <div class="settings-body">

        <!-- 📷 Background -->
        <div class="settings-section">
          <h4 class="settings-section-title">${icon('image', 14)} 背景图</h4>
          <div class="settings-row">
            <div class="settings-presets" id="bgPresets">
              ${BG_PRESETS.map(p => `
                <button class="settings-preset-chip" data-gradient="${p.gradient}" title="${p.name}">
                  <span class="settings-preset-preview" style="background:${p.gradient}"></span>
                  <span>${p.name}</span>
                </button>
              `).join('')}
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">图片</label>
            <div class="settings-actions-inline">
              <button class="btn btn-sm" id="bgUploadBtn">${icon('upload', 12)} 上传</button>
              <button class="btn btn-sm" id="bgUrlBtn">${icon('external', 12)} URL</button>
              <button class="btn btn-sm btn-ghost" id="bgClearBtn">${icon('trash', 12)} 清除</button>
            </div>
            <input type="file" id="bgFileInput" accept="image/*" style="display:none">
          </div>
          <div class="settings-row">
            <label class="settings-label">模式</label>
            <select class="settings-select" id="bgMode">
              <option value="cover" ${s.bgMode === 'cover' ? 'selected' : ''}>覆盖</option>
              <option value="contain" ${s.bgMode === 'contain' ? 'selected' : ''}>包含</option>
              <option value="center" ${s.bgMode === 'center' ? 'selected' : ''}>居中</option>
              <option value="tile" ${s.bgMode === 'tile' ? 'selected' : ''}>平铺</option>
              <option value="stretch" ${s.bgMode === 'stretch' ? 'selected' : ''}>拉伸</option>
            </select>
          </div>
          <div class="settings-row">
            <label class="settings-label">模糊 ${s.bgBlur}px</label>
            <input type="range" class="settings-range" id="bgBlur" min="0" max="20" step="1" value="${s.bgBlur}">
          </div>
          <div class="settings-row">
            <label class="settings-label">透明度 ${Math.round(s.bgOpacity * 100)}%</label>
            <input type="range" class="settings-range" id="bgOpacity" min="30" max="100" step="5" value="${Math.round(s.bgOpacity * 100)}">
          </div>
        </div>

        <!-- 📐 Layout -->
        <div class="settings-section">
          <h4 class="settings-section-title">布局</h4>
          <div class="settings-row">
            <label class="settings-label">密度</label>
            <div class="settings-btn-group">
              <button class="settings-btn ${s.density === 'compact' ? 'active' : ''}" data-density="compact">紧凑</button>
              <button class="settings-btn ${s.density === 'default' ? 'active' : ''}" data-density="default">默认</button>
              <button class="settings-btn ${s.density === 'comfortable' ? 'active' : ''}" data-density="comfortable">宽松</button>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">卡片宽度 ${s.cardSize}px</label>
            <input type="range" class="settings-range" id="cardSize" min="160" max="400" step="10" value="${s.cardSize}">
          </div>
        </div>

        <!-- ✨ Motion -->
        <div class="settings-section">
          <h4 class="settings-section-title">动画</h4>
          <div class="settings-row">
            <label class="settings-label">模式</label>
            <div class="settings-btn-group">
              <button class="settings-btn ${s.motionMode === 'full' ? 'active' : ''}" data-motion="full">完整</button>
              <button class="settings-btn ${s.motionMode === 'reduced' ? 'active' : ''}" data-motion="reduced">减弱</button>
              <button class="settings-btn ${s.motionMode === 'none' ? 'active' : ''}" data-motion="none">关闭</button>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">速度 ${s.transitionSpeed}ms</label>
            <input type="range" class="settings-range" id="transitionSpeed" min="0" max="500" step="25" value="${s.transitionSpeed}">
          </div>
        </div>

        <!-- 🔤 Typography -->
        <div class="settings-section">
          <h4 class="settings-section-title">🔤 字体</h4>
          <div class="settings-row settings-row-2col">
            <div>
              <label class="settings-label">正文</label>
              <select class="settings-select" id="fontBody">
                ${FONT_OPTIONS.map(f => `<option value="${f.value}" ${s.fontBody === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="settings-label">标题</label>
              <select class="settings-select" id="fontHeading">
                ${FONT_OPTIONS.map(f => `<option value="${f.value}" ${s.fontHeading === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">字号 ${s.fontSize}px</label>
            <input type="range" class="settings-range" id="fontSize" min="12" max="18" step="1" value="${s.fontSize}">
          </div>
          <div class="settings-row">
            <label class="settings-label">行高 ${s.lineHeight.toFixed(1)}</label>
            <input type="range" class="settings-range" id="lineHeight" min="12" max="20" step="1" value="${Math.round(s.lineHeight * 10)}">
          </div>
        </div>

        <!-- 🎨 Custom CSS -->
        <div class="settings-section">
          <h4 class="settings-section-title">${icon('edit3', 14)} 自定义 CSS</h4>
          <textarea class="settings-textarea" id="customCSS" placeholder="在此输入自定义 CSS 样式...">${s.customCSS}</textarea>
        </div>

        <!-- ⌨️ Shortcuts -->
        <div class="settings-section">
          <h4 class="settings-section-title">⌨️ 快捷键</h4>
          <div class="settings-shortcuts" id="shortcutsList">
            ${Object.entries(s.shortcuts).map(([key, val]) => `
              <div class="settings-shortcut-row">
                <span class="settings-shortcut-label">${shortcutLabel(key)}</span>
                <button class="settings-shortcut-btn" data-action="${key}">${val}</button>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 📦 Import/Export -->
        <div class="settings-section">
          <h4 class="settings-section-title">${icon('copy', 14)} 导入/导出</h4>
          <div class="settings-row settings-actions-inline">
            <button class="btn btn-sm" id="exportSettingsBtn">📤 导出设置</button>
            <button class="btn btn-sm" id="importSettingsBtn">📥 导入设置</button>
            <button class="btn btn-sm btn-danger" id="resetSettingsBtn">🔄 重置默认</button>
          </div>
          <input type="file" id="importFileInput" accept=".json" style="display:none">
        </div>

        <!-- 🔗 ComfyUI -->
        <div class="settings-section">
          <h4 class="settings-section-title">${icon('settings', 14)} ComfyUI 集成</h4>
          <div class="settings-row">
            <label class="settings-label">桥接状态</label>
            <div class="settings-actions-inline">
              <span id="comfyDirStatus" style="font-size:11px;color:var(--text3)">${s.comfyUIPath ? '已配置' : 'HTTP API (自动)'}</span>
              <button class="btn btn-sm" id="comfyDirSelectBtn" style="display:none">📂 桥接目录 (旧版)</button>
            </div>
          </div>
          <div class="settings-row">
            <span style="font-size:10px;color:var(--text3);line-height:1.5">桥接使用 HTTP API（POST /anima/bridge/update），无需文件系统权限，所有浏览器均支持。前端部署仍然需要通过 npm run setup:comfyui 配置路径。</span>
          </div>
          <div class="settings-row" style="margin-top:6px">
            <button class="btn btn-sm btn-primary" id="comfyDeployBtn" style="margin-right:6px">🚀 部署到 ComfyUI</button>
            <span id="comfyDeployStatus" style="font-size:11px;color:var(--text3)"></span>
          </div>
        </div>

      </div>
    </div>
  `
}

function shortcutLabel(key: string): string {
  const labels: Record<string, string> = {
    search: '搜索',
    toggleTheme: '切换主题',
    copyPrompt: '复制 Prompt',
    toggleSettings: '打开设置',
  }
  return labels[key] || key
}

// ── Apply settings to DOM ──
export function applySettings(s?: AppSettings) {
  const st = s || getSettings()
  const root = document.documentElement

  // Background overlay — direct style manipulation (bypass CSS variable inheritance issues)
  let overlay = document.getElementById('bg-overlay')
  if (st.bgImage) {
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'bg-overlay'
      document.body.prepend(overlay)
    }
    const isGradient = st.bgImage.includes('gradient(')
    const isUrlWrapped = st.bgImage.startsWith('url(')
    const bgCss = isGradient || isUrlWrapped ? st.bgImage : `url("${st.bgImage}")`
    // 直接设置 background-image 到 overlay 本身（不依赖 ::before 或 CSS 变量）
    overlay.style.backgroundImage = bgCss
    overlay.style.backgroundSize = st.bgMode
    overlay.style.backgroundPosition = 'center'
    overlay.style.backgroundRepeat = 'no-repeat'
    overlay.style.backgroundAttachment = 'fixed'
    overlay.style.opacity = String(st.bgOpacity)
    overlay.style.filter = `blur(${st.bgBlur}px)`
    overlay.style.display = 'block'
  } else {
    overlay?.remove()
  }
  root.style.setProperty('--bg-blur', `${st.bgBlur}px`)
  root.style.setProperty('--bg-opacity', String(st.bgOpacity))
  root.style.setProperty('--bg-mode', st.bgMode)

  // Density
  root.setAttribute('data-density', st.density)
  root.style.setProperty('--card-min-width', `${st.cardSize}px`)
  const gaps = { compact: '8px', default: '14px', comfortable: '20px' }
  root.style.setProperty('--grid-gap', gaps[st.density])

  // Motion
  root.setAttribute('data-motion', st.motionMode)
  root.style.setProperty('--transition-speed', `${st.transitionSpeed}ms`)
  const fast = Math.round(st.transitionSpeed * 0.6)
  const slow = Math.round(st.transitionSpeed * 1.6)
  root.style.setProperty('--transition-fast', `${fast}ms`)
  root.style.setProperty('--transition-normal', `${st.transitionSpeed}ms`)
  root.style.setProperty('--transition-slow', `${slow}ms`)

  // Typography
  if (st.fontBody) root.style.setProperty('--font-body', st.fontBody)
  else root.style.removeProperty('--font-body')
  if (st.fontHeading) root.style.setProperty('--font-heading', st.fontHeading)
  else root.style.removeProperty('--font-heading')
  if (st.fontMono) root.style.setProperty('--font-mono', st.fontMono)
  else root.style.removeProperty('--font-mono')
  root.style.setProperty('--font-size-base', `${st.fontSize}px`)
  root.style.setProperty('--line-height', String(st.lineHeight))

  // Custom CSS
  let styleEl = document.getElementById('user-custom-css') as HTMLStyleElement
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'user-custom-css'
    document.head.append(styleEl)
  }
  styleEl.textContent = st.customCSS
}

// ── Init ──
export function initSettings() {
  const s = loadSettings()
  if (s.bgImage) console.log('[背景图] 从 localStorage 读取到，长度:', s.bgImage.length, '前50字符:', s.bgImage.slice(0, 50))
  else console.log('[背景图] localStorage 中无背景图')
  applySettings(s)

  // Settings button click
  document.getElementById('settingsBtn')?.addEventListener('click', openSettings)

  // Global shortcut
  document.addEventListener('keydown', (e) => {
    const st = getSettings()
    if (e.key === 'Escape') {
      const modal = document.getElementById(SETTINGS_MODAL_ID)
      if (modal?.classList.contains('open')) closeModal(SETTINGS_MODAL_ID)
    }
    // 在输入框中输入时不触发快捷键
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
    // Check shortcuts
    for (const [action, shortcut] of Object.entries(st.shortcuts)) {
      if (matchShortcut(e, shortcut)) {
        e.preventDefault()
        handleShortcut(action)
        break
      }
    }
  })
}

function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+')
  const key = parts.pop()!
  const ctrl = parts.includes('ctrl')
  const shift = parts.includes('shift')
  const alt = parts.includes('alt')
  return e.key.toLowerCase() === key && e.ctrlKey === ctrl && e.shiftKey === shift && e.altKey === alt
}

function handleShortcut(action: string) {
  switch (action) {
    case 'search':
      document.getElementById('searchInput')?.focus()
      break
    case 'toggleTheme': {
      const dots = document.querySelectorAll('.theme-dot')
      const active = document.querySelector('.theme-dot.active')
      const idx = Array.from(dots).indexOf(active as Element)
      const next = dots[(idx + 1) % dots.length] as HTMLElement
      next?.click()
      break
    }
    case 'toggleSettings':
      openSettings()
      break
    case 'copyPrompt': {
      const el = document.querySelector('.prompt-preview, .prompt-output, #promptText') as HTMLElement
      if (el?.textContent) {
        navigator.clipboard.writeText(el.textContent)
      }
      break
    }
  }
}

function openSettings() {
  let modal = document.getElementById(SETTINGS_MODAL_ID)
  if (!modal) {
    modal = document.createElement('div')
    modal.id = SETTINGS_MODAL_ID
    modal.className = 'modal-overlay'
    document.body.appendChild(modal)
  }
  const s = getSettings()
  modal.innerHTML = renderSettingsHTML(s)
  modal.classList.add('open')

  // Close handlers
  document.getElementById('settingsCloseBtn')?.addEventListener('click', () => closeModal(SETTINGS_MODAL_ID))
  modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(SETTINGS_MODAL_ID) })

  // Bind all events
  bindBackgroundEvents()
  bindLayoutEvents()
  bindMotionEvents()
  bindTypographyEvents()
  bindCSSEvents()
  bindShortcutEvents()
  bindImportExportEvents()
  bindComfyEvents()
}

function bindBackgroundEvents() {
  // Presets
  document.getElementById('bgPresets')?.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.settings-preset-chip') as HTMLElement
    if (!chip) return
    const gradient = chip.dataset.gradient || ''
    saveSettings({ bgImage: gradient })
    applySettings()
  })

  // Upload
  const fileInput = document.getElementById('bgFileInput') as HTMLInputElement
  document.getElementById('bgUploadBtn')?.addEventListener('click', () => fileInput?.click())
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      console.log('[背景图] 上传 DataURL 长度:', dataUrl.length)
      saveSettings({ bgImage: dataUrl })
      applySettings()
      // 验证
      const overlay = document.getElementById('bg-overlay')
      console.log('[背景图] overlay 存在:', !!overlay, 'backgroundImage:', overlay?.style.backgroundImage?.slice(0,60))
    }
    reader.readAsDataURL(file)
  })

  // URL
  document.getElementById('bgUrlBtn')?.addEventListener('click', async () => {
    const url = await promptModal('输入图片 URL', '', '支持 jpg/png/webp 格式')
    if (url) {
      saveSettings({ bgImage: url })
      applySettings()
    }
  })

  // Clear
  document.getElementById('bgClearBtn')?.addEventListener('click', () => {
    saveSettings({ bgImage: '' })
    applySettings()
    console.log('[背景图] 已清除，overlay 已移除')
  })

  // Mode
  document.getElementById('bgMode')?.addEventListener('change', (e) => {
    saveSettings({ bgMode: (e.target as HTMLSelectElement).value as AppSettings['bgMode'] })
    applySettings()
  })

  // Blur
  document.getElementById('bgBlur')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value)
    saveSettings({ bgBlur: v })
    applySettings()
    const label = document.querySelector('label[for="bgBlur"], .settings-row label')
    // Update label text
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = `模糊 ${v}px`)
  })

  // Opacity
  document.getElementById('bgOpacity')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value) / 100
    saveSettings({ bgOpacity: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = `透明度 ${Math.round(v * 100)}%`)
  })
}

function bindLayoutEvents() {
  document.querySelectorAll('[data-density]').forEach(btn => {
    btn.addEventListener('click', () => {
      const density = (btn as HTMLElement).dataset.density as AppSettings['density']
      saveSettings({ density })
      applySettings()
      // Update active state
      document.querySelectorAll('[data-density]').forEach(b => b.classList.toggle('active', b === btn))
    })
  })

  document.getElementById('cardSize')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value)
    saveSettings({ cardSize: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = `卡片宽度 ${v}px`)
  })
}

function bindMotionEvents() {
  document.querySelectorAll('[data-motion]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLElement).dataset.motion as AppSettings['motionMode']
      saveSettings({ motionMode: mode })
      applySettings()
      document.querySelectorAll('[data-motion]').forEach(b => b.classList.toggle('active', b === btn))
    })
  })

  document.getElementById('transitionSpeed')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value)
    saveSettings({ transitionSpeed: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = `速度 ${v}ms`)
  })
}

function bindTypographyEvents() {
  document.getElementById('fontBody')?.addEventListener('change', (e) => {
    saveSettings({ fontBody: (e.target as HTMLSelectElement).value })
    applySettings()
  })
  document.getElementById('fontHeading')?.addEventListener('change', (e) => {
    saveSettings({ fontHeading: (e.target as HTMLSelectElement).value })
    applySettings()
  })
  document.getElementById('fontSize')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value)
    saveSettings({ fontSize: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = `字号 ${v}px`)
  })
  document.getElementById('lineHeight')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value) / 10
    saveSettings({ lineHeight: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = `行高 ${v.toFixed(1)}`)
  })
}

function bindCSSEvents() {
  const textarea = document.getElementById('customCSS') as HTMLTextAreaElement
  let timer: ReturnType<typeof setTimeout>
  textarea?.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      saveSettings({ customCSS: textarea.value })
      applySettings()
    }, 500)
  })
}

function bindShortcutEvents() {
  let recording = false
  let currentAction = ''

  document.getElementById('shortcutsList')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.settings-shortcut-btn') as HTMLElement
    if (!btn) return
    if (recording) return
    recording = true
    currentAction = btn.dataset.action || ''
    btn.textContent = '按下快捷键...'
    btn.classList.add('recording')

    const handler = (ev: KeyboardEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      let combo = ''
      if (ev.ctrlKey) combo += 'Ctrl+'
      if (ev.shiftKey) combo += 'Shift+'
      if (ev.altKey) combo += 'Alt+'
      combo += ev.key.length === 1 ? ev.key.toUpperCase() : ev.key

      const shortcuts = getSettings().shortcuts
      shortcuts[currentAction] = combo
      saveSettings({ shortcuts })

      btn.textContent = combo
      btn.classList.remove('recording')
      recording = false
      document.removeEventListener('keydown', handler, true)
    }
    document.addEventListener('keydown', handler, true)
  })
}

function bindImportExportEvents() {
  // Export
  document.getElementById('exportSettingsBtn')?.addEventListener('click', () => {
    const json = exportSettings()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `anima-settings-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  })

  // Import
  const fileInput = document.getElementById('importFileInput') as HTMLInputElement
  document.getElementById('importSettingsBtn')?.addEventListener('click', () => fileInput?.click())
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const text = await file.text()
    const ok = importSettings(text)
    if (ok) {
      applySettings(loadSettings())
      closeModal(SETTINGS_MODAL_ID)
      // Re-open to refresh UI
      setTimeout(openSettings, 100)
    }
  })

  // Reset
  document.getElementById('resetSettingsBtn')?.addEventListener('click', async () => {
    const ok = await confirmModal('重置所有设置', '将恢复默认设置，自定义背景、CSS、快捷键等将丢失。')
    if (ok) {
      resetSettings()
      applySettings()
      closeModal(SETTINGS_MODAL_ID)
      setTimeout(openSettings, 100)
    }
  })
}

function bindComfyEvents() {
  const statusEl = document.getElementById('comfyDirStatus')
  const selBtn = document.getElementById('comfyDirSelectBtn')

  selBtn?.addEventListener('click', async () => {
    try {
      if (!('showDirectoryPicker' in window)) {
        showToast('⚠️ 当前浏览器不支持目录访问。请使用 Chrome/Edge。')
        return
      }
      let dh: any = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
      // Auto-create ComfyUI-Anima-Batch-LoRA subfolder if not already inside one
      const NODE_DIR_NAME = 'ComfyUI-Anima-Batch-LoRA'
      if (dh.name !== NODE_DIR_NAME) {
        try {
          dh = await dh.getDirectoryHandle(NODE_DIR_NAME, { create: true })
        } catch {
          showToast('⚠️ 无法在所选目录下创建 ' + NODE_DIR_NAME)
          return
        }
      }
      // Store handle via in-memory manager (no IndexedDB!)
      const { setHandle, getStoredDirName } = await import('../store/handleManager')
      setHandle('comfyBridge', dh)
      saveSettings({ comfyUIPath: dh.name })
      if (statusEl) statusEl.textContent = dh.name
      statusEl?.classList.add('configured')
      showToast(`✅ 已设置桥接目录: ${dh.name}`)
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        showToast(`❌ 选择目录失败: ${e.message || '未知错误'}`)
      }
    }
  })

  // ─── 部署按钮 ───
  const deployBtn = document.getElementById('comfyDeployBtn')
  const deployStatus = document.getElementById('comfyDeployStatus')
  deployBtn?.addEventListener('click', async () => {
    if (!deployStatus) return
    deployStatus.textContent = '⏳ 构建+部署中...（请稍候）'
    try {
      const resp = await fetch('http://localhost:5166/deploy', { method: 'POST' })
      const result = await resp.json()
      if (result.ok) {
        deployStatus.textContent = '✅ 部署完成！重启 ComfyUI 后即可使用'
      } else {
        deployStatus.textContent = `❌ 部署失败: ${result.error || '未知错误'}`
      }
    } catch (e: any) {
      deployStatus.textContent = `❌ 部署失败: ${e.message}. 确保 npm run dev 和构建服务同时运行`
    }
  })
}

// Deploy is handled by the local deploy server (POST /deploy on port 5166).
// Configure path via npm run setup:comfyui (creates .comfyui-path).


