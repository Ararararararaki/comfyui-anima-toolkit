/* ── Settings Panel ── */
import { loadSettings, saveSettings, getSettings, resetSettings, exportSettings, importSettings, saveBgImageDB, loadBgImageDB, clearBgImageDB, type AppSettings } from '../store/settings'
import { exportAll, importAll } from '../services/backupService'
import { openModal, closeModal, confirmModal, promptModal } from '../components/Modal'
import { showToast } from '../utils'
import { icon } from '../utils/icon'
import { getCivitaiHost, setCivitaiHost } from '../api/civitai'
import { t, setLocale, getLocale, type MessageKey } from '../i18n'

const SETTINGS_MODAL_ID = 'settingsModal'
let cssDraftTimer: ReturnType<typeof setTimeout> | undefined

// ── Background presets ──
const BG_PRESETS: { name: MessageKey; gradient: string }[] = [
  { name: 'settings.background.starry', gradient: 'radial-gradient(ellipse at 20% 50%, #1a1a3e 0%, #0a0a14 50%, #060610 100%)' },
  { name: 'settings.background.aurora', gradient: 'linear-gradient(135deg, #0a1628 0%, #0d2137 30%, #0a2a1f 60%, #0e1a2e 100%)' },
  { name: 'settings.background.sunset', gradient: 'linear-gradient(180deg, #1a0a1e 0%, #2d1520 30%, #3d1a15 60%, #1a0a0a 100%)' },
  { name: 'settings.background.ocean', gradient: 'linear-gradient(180deg, #040a12 0%, #061420 40%, #081e2e 70%, #040a12 100%)' },
  { name: 'settings.background.forest', gradient: 'linear-gradient(180deg, #060e08 0%, #0a1a0e 40%, #0e2414 70%, #060e08 100%)' },
  { name: 'settings.background.neon', gradient: 'radial-gradient(ellipse at 50% 50%, #1a0a2e 0%, #0a0a1a 60%, #060610 100%)' },
]

// ── Font options ──
const FONT_OPTIONS: { label: MessageKey; value: string }[] = [
  { label: 'settings.font.default', value: '' },
  { label: 'settings.font.sans', value: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { label: 'settings.font.serif', value: "Georgia, 'Songti SC', 'SimSun', serif" },
  { label: 'settings.font.mono', value: "'Cascadia Code', Consolas, 'Courier New', monospace" },
  { label: 'settings.font.inter', value: "'Inter', sans-serif" },
  { label: 'settings.font.jetbrains', value: "'JetBrains Mono', monospace" },
  { label: 'settings.font.noto', value: "'Noto Sans SC', sans-serif" },
  { label: 'settings.font.sourceHan', value: "'Source Han Sans SC', sans-serif" },
]

const DEFAULT_TOOLBOX_ICON = '../img/anima-btn.jpg'

function defaultToolboxIconUrl(): string {
  try {
    return new URL(DEFAULT_TOOLBOX_ICON, window.location.href).href
  } catch {
    return DEFAULT_TOOLBOX_ICON
  }
}

function normalizeToolboxIcon(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('data:image/')) return raw
  try {
    const url = new URL(raw, window.location.href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

function setToolboxIconPreview(value: unknown) {
  const preview = document.getElementById('toolboxIconPreview') as HTMLImageElement | null
  if (!preview) return
  const custom = normalizeToolboxIcon(value)
  const fallback = defaultToolboxIconUrl()
  preview.dataset.fallback = '0'
  preview.onerror = () => {
    if (preview.dataset.fallback === '0') {
      preview.dataset.fallback = '1'
      preview.src = fallback
    }
  }
  preview.src = custom || fallback
  const status = document.getElementById('toolboxIconStatus')
  if (status) status.textContent = custom ? t('settings.toolbox.customActive') : t('settings.toolbox.defaultActive')
}

function renderSettingsHTML(s: AppSettings): string {
  return `
    <div class="modal-box settings-modal-box">
      <div class="settings-header">
        <div class="settings-heading">
          <h3>${icon('settings', 18)} ${t('settings.title')}</h3>
          <p>${t('settings.intro')}</p>
        </div>
        <div class="settings-header-actions">
          <span class="settings-live-status" id="settingsLiveStatus" role="status" aria-live="polite">${t('settings.status.saved')}</span>
          <button class="icon-btn" id="settingsCloseBtn" title="${t('settings.close')}">${icon('x', 18)}</button>
        </div>
      </div>
      <div class="settings-shell">
        <div class="settings-body">

        <div class="settings-section">
          <h4 class="settings-section-title">${t('settings.language.title')}</h4>
          <div class="settings-row">
            <label class="settings-label" for="settingsLanguage">${t('settings.language.label')}</label>
            <select class="settings-select" id="settingsLanguage">
              <option value="zh-CN" ${s.locale === 'zh-CN' ? 'selected' : ''}>简体中文</option>
              <option value="en" ${s.locale === 'en' ? 'selected' : ''}>English</option>
            </select>
          </div>
          <p class="settings-help">${t('settings.language.help')}</p>
        </div>

        <!-- 📷 Background -->
        <div class="settings-section">
          <h4 class="settings-section-title">${icon('image', 14)} ${t('settings.background.title')}</h4>
          <div class="settings-row">
            <div class="settings-presets" id="bgPresets">
              ${BG_PRESETS.map(p => `
                <button class="settings-preset-chip" data-gradient="${p.gradient}" title="${t(p.name)}">
                  <span class="settings-preset-preview" style="background:${p.gradient}"></span>
                  <span>${t(p.name)}</span>
                </button>
              `).join('')}
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.image')}</label>
            <div class="settings-actions-inline">
              <button class="btn btn-sm" id="bgUploadBtn">${icon('upload', 12)} ${t('settings.upload')}</button>
              <button class="btn btn-sm" id="bgUrlBtn">${icon('external', 12)} ${t('settings.url')}</button>
              <button class="btn btn-sm btn-ghost" id="bgClearBtn">${icon('trash', 12)} ${t('settings.clear')}</button>
            </div>
            <input type="file" id="bgFileInput" accept="image/*" style="display:none">
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.mode')}</label>
            <select class="settings-select" id="bgMode">
              <option value="cover" ${s.bgMode === 'cover' ? 'selected' : ''}>${t('settings.background.cover')}</option>
              <option value="contain" ${s.bgMode === 'contain' ? 'selected' : ''}>${t('settings.background.contain')}</option>
              <option value="center" ${s.bgMode === 'center' ? 'selected' : ''}>${t('settings.background.center')}</option>
              <option value="tile" ${s.bgMode === 'tile' ? 'selected' : ''}>${t('settings.background.tile')}</option>
              <option value="stretch" ${s.bgMode === 'stretch' ? 'selected' : ''}>${t('settings.background.stretch')}</option>
            </select>
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.background.blur', { value: s.bgBlur })}</label>
            <input type="range" class="settings-range" id="bgBlur" min="0" max="20" step="1" value="${s.bgBlur}">
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.background.opacity', { value: Math.round(s.bgOpacity * 100) })}</label>
            <input type="range" class="settings-range" id="bgOpacity" min="30" max="100" step="5" value="${Math.round(s.bgOpacity * 100)}">
          </div>
        </div>

        <!-- 🧩 Toolbox entry icon -->
        <div class="settings-section">
          <h4 class="settings-section-title">${icon('image', 14)} ${t('settings.toolbox.title')}</h4>
          <div class="settings-toolbox-icon-row">
            <div class="settings-toolbox-icon-preview">
              <img id="toolboxIconPreview" src="${DEFAULT_TOOLBOX_ICON}" alt="${t('settings.toolbox.preview')}">
            </div>
            <div class="settings-toolbox-icon-content">
              <div class="settings-actions-inline">
                <button class="btn btn-sm" id="toolboxIconUploadBtn">${icon('upload', 12)} ${t('settings.toolbox.upload')}</button>
                <button class="btn btn-sm" id="toolboxIconUrlBtn">${icon('external', 12)} ${t('settings.toolbox.url')}</button>
                <button class="btn btn-sm btn-ghost" id="toolboxIconResetBtn">${icon('refresh', 12)} ${t('settings.toolbox.restore')}</button>
              </div>
              <span id="toolboxIconStatus" class="settings-hint">${t('settings.toolbox.defaultActive')}</span>
              <span class="settings-hint">${t('settings.toolbox.help')}</span>
            </div>
          </div>
          <input type="file" id="toolboxIconFileInput" accept="image/*" style="display:none">
        </div>

        <!-- 📐 Layout -->
        <div class="settings-section">
          <h4 class="settings-section-title">${t('settings.layout.title')}</h4>
          <div class="settings-row">
            <label class="settings-label">${t('settings.layout.density')}</label>
            <div class="settings-btn-group">
              <button class="settings-btn ${s.density === 'compact' ? 'active' : ''}" data-density="compact">${t('settings.layout.compact')}</button>
              <button class="settings-btn ${s.density === 'default' ? 'active' : ''}" data-density="default">${t('settings.layout.default')}</button>
              <button class="settings-btn ${s.density === 'comfortable' ? 'active' : ''}" data-density="comfortable">${t('settings.layout.comfortable')}</button>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.layout.cardSize', { value: s.cardSize })}</label>
            <input type="range" class="settings-range" id="cardSize" min="160" max="400" step="10" value="${s.cardSize}">
            <span class="settings-hint">${t('settings.layout.cardHelp')}</span>
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.layout.localCardSize', { value: s.localCardSize })}</label>
            <input type="range" class="settings-range" id="localCardSize" min="120" max="320" step="10" value="${s.localCardSize}">
            <span class="settings-hint">${t('settings.layout.localCardHelp')}</span>
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.layout.contentWidth')}</label>
            <div class="settings-btn-group">
              <button class="settings-btn ${s.contentWidth === 'standard' ? 'active' : ''}" data-content-width="standard">${t('settings.layout.standard')}</button>
              <button class="settings-btn ${s.contentWidth === 'wide' ? 'active' : ''}" data-content-width="wide">${t('settings.layout.wide')}</button>
              <button class="settings-btn ${s.contentWidth === 'full' ? 'active' : ''}" data-content-width="full">${t('settings.layout.full')}</button>
            </div>
          </div>
        </div>

        <!-- ◐ Surface opacity -->
        <div class="settings-section">
          <h4 class="settings-section-title">${t('settings.surface.title')}</h4>
          <p class="settings-help">${t('settings.surface.help')}</p>
          <div class="settings-row">
            <label class="settings-label">${t('settings.surface.panelOpacity', { value: Math.round(s.panelOpacity * 100) })}</label>
            <input type="range" class="settings-range" id="panelOpacity" min="20" max="100" step="5" value="${Math.round(s.panelOpacity * 100)}">
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.surface.buttonOpacity', { value: Math.round(s.buttonOpacity * 100) })}</label>
            <input type="range" class="settings-range" id="buttonOpacity" min="10" max="90" step="5" value="${Math.round(s.buttonOpacity * 100)}">
          </div>
        </div>

        <!-- ✨ Motion -->
        <div class="settings-section">
          <h4 class="settings-section-title">${t('settings.motion.title')}</h4>
          <div class="settings-row">
            <label class="settings-label">${t('settings.mode')}</label>
            <div class="settings-btn-group">
              <button class="settings-btn ${s.motionMode === 'full' ? 'active' : ''}" data-motion="full">${t('settings.motion.full')}</button>
              <button class="settings-btn ${s.motionMode === 'reduced' ? 'active' : ''}" data-motion="reduced">${t('settings.motion.reduced')}</button>
              <button class="settings-btn ${s.motionMode === 'none' ? 'active' : ''}" data-motion="none">${t('settings.motion.none')}</button>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.motion.speed', { value: s.transitionSpeed })}</label>
            <input type="range" class="settings-range" id="transitionSpeed" min="0" max="500" step="25" value="${s.transitionSpeed}">
          </div>
        </div>

        <!-- 🔤 Typography -->
        <div class="settings-section">
          <h4 class="settings-section-title">${t('settings.font.title')}</h4>
          <div class="settings-row settings-row-3col">
            <div>
              <label class="settings-label">${t('settings.font.body')}</label>
              <select class="settings-select" id="fontBody">
                ${FONT_OPTIONS.map(f => `<option value="${f.value}" ${s.fontBody === f.value ? 'selected' : ''}>${t(f.label)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="settings-label">${t('settings.font.heading')}</label>
              <select class="settings-select" id="fontHeading">
                ${FONT_OPTIONS.map(f => `<option value="${f.value}" ${s.fontHeading === f.value ? 'selected' : ''}>${t(f.label)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="settings-label">${t('settings.font.code')}</label>
              <select class="settings-select" id="fontMono">
                ${FONT_OPTIONS.map(f => `<option value="${f.value}" ${s.fontMono === f.value ? 'selected' : ''}>${t(f.label)}</option>`).join('')}
              </select>
            </div>
          </div>
          <p class="settings-help">${t('settings.font.help')}</p>
          <div class="settings-row">
            <label class="settings-label">${t('settings.font.size', { value: s.fontSize })}</label>
            <input type="range" class="settings-range" id="fontSize" min="12" max="18" step="1" value="${s.fontSize}">
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.font.lineHeight', { value: s.lineHeight.toFixed(1) })}</label>
            <input type="range" class="settings-range" id="lineHeight" min="12" max="20" step="1" value="${Math.round(s.lineHeight * 10)}">
          </div>
        </div>

        <!-- 🎨 Custom CSS -->
        <div class="settings-section">
          <h4 class="settings-section-title">${icon('edit3', 14)} ${t('settings.css.title')}</h4>
          <textarea class="settings-textarea" id="customCSS" placeholder="${t('settings.css.placeholder')}">${s.customCSS}</textarea>
        </div>

        <!-- ⌨️ Shortcuts -->
        <div class="settings-section">
          <h4 class="settings-section-title">${t('settings.shortcuts.title')}</h4>
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
          <h4 class="settings-section-title">${icon('copy', 14)} ${t('settings.transfer.title')}</h4>
          <div class="settings-row settings-actions-inline">
            <button class="btn btn-sm" id="exportSettingsBtn">${icon('upload', 12)} ${t('settings.transfer.exportSettings')}</button>
            <button class="btn btn-sm" id="importSettingsBtn">${icon('download', 12)} ${t('settings.transfer.importSettings')}</button>
            <button class="btn btn-sm btn-danger" id="resetSettingsBtn">${icon('refresh', 12)} ${t('settings.transfer.reset')}</button>
          </div>
          <div class="settings-row settings-actions-inline">
            <button class="btn btn-sm" id="exportAllBtn">${icon('upload', 12)} ${t('settings.transfer.exportAll')}</button>
            <button class="btn btn-sm" id="importAllBtn">${icon('download', 12)} ${t('settings.transfer.importAll')}</button>
          </div>
          <input type="file" id="importFileInput" accept=".json" style="display:none">
          <input type="file" id="backupFileInput" accept=".json" style="display:none">
        </div>

        <!-- 🔗 ComfyUI -->
        <div class="settings-section">
          <h4 class="settings-section-title">${icon('settings', 14)} ${t('settings.comfy.title')}</h4>
          <div class="settings-row">
            <label class="settings-label">${t('settings.comfy.bridge')}</label>
            <div class="settings-actions-inline">
              <span id="comfyDirStatus" style="font-size:11px;color:var(--text3)">${s.comfyUIPath ? t('settings.comfy.configured') : t('settings.comfy.automatic')}</span>
              <button class="btn btn-sm" id="comfyDirSelectBtn" style="display:none">${icon('folder', 12)} ${t('settings.comfy.legacyDirectory')}</button>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.civitai.apiKey')}</label>
            <input type="password" id="civitaiApiKey" value="${(() => { try { return localStorage.getItem('anima_civitai_token') || '' } catch { return '' } })()}" placeholder="${t('settings.civitai.keyPlaceholder')}" style="flex:1;padding:6px 8px;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:11px;outline:none;">
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.civitai.route')}</label>
            <select id="civitaiHost" style="flex:1;padding:6px 8px;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:11px;outline:none;">
              <option value="">${t('settings.civitai.defaultRoute')}</option>
              <option value="https://civitai.red">${t('settings.civitai.mirrorRoute')}</option>
              <option value="custom">${t('settings.civitai.customRoute')}</option>
            </select>
          </div>
          <div class="settings-row" id="civitaiHostCustomRow" style="display:none">
            <label class="settings-label">${t('settings.civitai.customDomain')}</label>
            <input type="text" id="civitaiHostCustomInput" value="${(() => { try { return localStorage.getItem('anima_civitai_host') || '' } catch { return '' } })()}" placeholder="https://civitai.com" style="flex:1;padding:6px 8px;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:11px;outline:none;">
          </div>
          <div class="settings-row">
            <span style="font-size:10px;color:var(--text3);line-height:1.5">${t('settings.civitai.routeHelp')}</span>
          </div>
          <div class="settings-row">
            <label class="settings-label">${t('settings.scan.directory')}</label>
            <input type="text" id="localScanDir" value="${(() => { try { return (s.localScanDir || '') } catch { return '' } })()}" placeholder="${t('settings.scan.placeholder')}" style="flex:1;padding:6px 8px;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:11px;outline:none;">
          </div>
          <div class="settings-row">
            <span style="font-size:10px;color:var(--text3);line-height:1.5">${t('settings.comfy.help')}</span>
          </div>
        </div>

        </div>

        <aside class="settings-preview" id="settingsPreview" data-density="${s.density}" data-motion="${s.motionMode}">
          <div class="settings-preview-header">
            <div>
              <span class="settings-preview-label">${t('settings.preview.label')}</span>
              <h4>${t('settings.preview.title')}</h4>
            </div>
          </div>
          <p class="settings-preview-intro">${t('settings.preview.intro')}</p>

          <div class="settings-preview-stage">
            <div class="settings-preview-card">
              <div class="settings-preview-card-meta"><span class="settings-preview-dot"></span><span>${t('settings.preview.currentControl')}</span><span class="settings-preview-card-code">UI</span></div>
              <span class="settings-preview-kicker">${t('settings.preview.page')}</span>
              <h5 class="settings-preview-title">${t('settings.preview.sample')}</h5>
              <p class="settings-preview-body">${t('settings.preview.body')}</p>
              <div class="settings-preview-ruler"><span>${t('settings.preview.cardWidth')}</span><strong data-preview-value="cardSize">${s.cardSize}px</strong></div>
              <div class="settings-preview-ruler-track"><i></i></div>
              <div class="settings-preview-actions">
                <span class="btn btn-primary settings-preview-button">${t('settings.preview.save')}</span>
                <span class="btn btn-ghost settings-preview-button">${t('settings.preview.changes')}</span>
              </div>
              <code class="settings-preview-code">${t('settings.preview.fontCode')}: <span data-preview-value="fontMono">${t('settings.font.mono')}</span> · ${t('settings.preview.lineCode')} <span data-preview-value="lineHeight">${s.lineHeight.toFixed(1)}</span></code>
            </div>
          </div>

          <div class="settings-preview-values">
            <div><span>${t('settings.layout.title')}</span><strong data-preview-value="density">${s.density === 'compact' ? t('settings.layout.compact') : s.density === 'comfortable' ? t('settings.layout.comfortable') : t('settings.layout.default')}</strong></div>
            <div><span>${t('settings.motion.title')}</span><strong data-preview-value="motion">${s.motionMode === 'none' ? t('settings.motion.none') : s.motionMode === 'reduced' ? t('settings.motion.reduced') : `${s.transitionSpeed}ms`}</strong></div>
            <div><span>${t('settings.preview.fontSize')}</span><strong data-preview-value="fontSize">${s.fontSize}px</strong></div>
            <div><span>${t('settings.font.body')}</span><strong data-preview-value="fontBody">${settingsOptionLabel(s.fontBody)}</strong></div>
            <div><span>${t('settings.preview.panel')}</span><strong data-preview-value="panelOpacity">${Math.round(s.panelOpacity * 100)}%</strong></div>
            <div><span>${t('settings.preview.button')}</span><strong data-preview-value="buttonOpacity">${Math.round(s.buttonOpacity * 100)}%</strong></div>
          </div>
          <p class="settings-preview-note">${t('settings.preview.note')}</p>
        </aside>
      </div>
    </div>
  `
}

function shortcutLabel(key: string): string {
  const labels: Record<string, string> = {
    search: t('settings.shortcut.search'),
    toggleTheme: t('settings.shortcut.toggleTheme'),
    copyPrompt: t('settings.shortcut.copyPrompt'),
    toggleSettings: t('settings.shortcut.toggleSettings'),
  }
  return labels[key] || key
}

function settingsOptionLabel(value: string): string {
  return t(FONT_OPTIONS.find(option => option.value === value)?.label || 'settings.font.default')
}

function updateSettingsPreview(st: AppSettings) {
  const preview = document.getElementById('settingsPreview')
  if (!preview) return

  preview.dataset.density = st.density
  preview.dataset.motion = st.motionMode
  preview.style.setProperty('--preview-card-size', `${st.cardSize}px`)

  // The real card width (160–400px) cannot be copied literally into the
  // narrow preview pane. Map it to a contained visual range so every slider
  // movement is visible without causing horizontal overflow.
  const cardSize = Math.max(160, Math.min(400, st.cardSize))
  const previewWidth = Math.round(56 + ((cardSize - 160) / 240) * 44)
  preview.style.setProperty('--preview-card-width', `${previewWidth}%`)

  const values: Record<string, string> = {
    density: st.density === 'compact' ? t('settings.layout.compact') : st.density === 'comfortable' ? t('settings.layout.comfortable') : t('settings.layout.default'),
    motion: st.motionMode === 'none' ? t('settings.motion.none') : st.motionMode === 'reduced' ? t('settings.motion.reduced') : `${st.transitionSpeed}ms`,
    fontSize: `${st.fontSize}px`,
    fontBody: settingsOptionLabel(st.fontBody),
    fontMono: settingsOptionLabel(st.fontMono),
    lineHeight: st.lineHeight.toFixed(1),
    cardSize: `${st.cardSize}px`,
    panelOpacity: `${Math.round(st.panelOpacity * 100)}%`,
    buttonOpacity: `${Math.round(st.buttonOpacity * 100)}%`,
  }
  Object.entries(values).forEach(([key, value]) => {
    preview.querySelectorAll<HTMLElement>(`[data-preview-value="${key}"]`).forEach(el => { el.textContent = value })
  })

  const ruler = preview.querySelector<HTMLElement>('.settings-preview-ruler-track i')
  if (ruler) ruler.style.width = `${Math.round(((st.cardSize - 160) / 240) * 100)}%`

  const status = document.getElementById('settingsLiveStatus')
  if (status) {
    status.textContent = t('settings.status.saved')
    status.dataset.state = 'applied'
  }
}

function syncSettingsRanges() {
  document.querySelectorAll<HTMLInputElement>('.settings-range').forEach(input => {
    const min = Number(input.min || 0)
    const max = Number(input.max || 100)
    const value = Number(input.value || min)
    const progress = max === min ? 0 : ((value - min) / (max - min)) * 100
    input.style.setProperty('--range-progress', `${Math.max(0, Math.min(100, progress))}%`)
  })
}

function markSettingsPending() {
  const status = document.getElementById('settingsLiveStatus')
  if (!status) return
  status.textContent = t('settings.status.pending')
  status.dataset.state = 'pending'
}

// ── Apply settings to DOM ──
export function applySettings(s?: AppSettings) {
  const st = s || getSettings()
  const root = document.documentElement

  // Background overlay — direct style manipulation (bypass CSS variable inheritance issues)
  let overlay = document.getElementById('bg-overlay')
  if (st.bgImage === '__idb__') {
    // 大背景图存在 IndexedDB（避免 localStorage 5MB 超限静默失败），异步加载
    loadBgImageDB().then((url) => {
      if (!url) return
      let ov = document.getElementById('bg-overlay')
      if (!ov) {
        ov = document.createElement('div')
        ov.id = 'bg-overlay'
        document.body.prepend(ov)
      }
      ov.style.backgroundImage = `url("${url}")`
      ov.style.backgroundSize = st.bgMode
      ov.style.backgroundPosition = 'center'
      ov.style.backgroundRepeat = 'no-repeat'
      ov.style.backgroundAttachment = 'fixed'
      ov.style.opacity = String(st.bgOpacity)
      ov.style.filter = `blur(${st.bgBlur}px)`
      ov.style.display = 'block'
    }).catch(() => {})
  } else if (st.bgImage) {
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
  root.style.setProperty('--card-min-width-local', `${st.localCardSize}px`)
  const contentMax = { standard: '1480px', wide: '1880px', full: '100%' }[st.contentWidth]
  root.style.setProperty('--content-max-width', contentMax)
  root.setAttribute('data-content-width', st.contentWidth)
  root.style.setProperty('--ui-panel-opacity', `${Math.round(st.panelOpacity * 100)}%`)
  root.style.setProperty('--ui-button-opacity', `${Math.round(st.buttonOpacity * 100)}%`)
  // 外层可以很透，但承载文字的内层需要一个最低对比度，避免背景图亮部吞掉文字。
  root.style.setProperty('--ui-readable-panel-opacity', `${Math.round(Math.max(st.panelOpacity, 0.58) * 100)}%`)
  root.style.setProperty('--ui-readable-button-opacity', `${Math.round(Math.max(st.buttonOpacity, 0.24) * 100)}%`)
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
  updateSettingsPreview(st)
  syncSettingsRanges()
  // 原生 CSS 网格会立即响应变量；虚拟网格需要收到通知后重算列数。
  window.dispatchEvent(new CustomEvent('anima:settings-applied', {
    detail: { cardSize: st.cardSize, density: st.density },
  }))
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
    case 'search': {
      // 按当前激活 section 聚焦对应搜索框（兼容主搜索 + 各 section 搜索）
      const section = document.querySelector('.main-tab.active')?.getAttribute('data-section') || 'lora'
      const map: Record<string, string> = {
        lora: 'searchInput',
        local: 'localSearch',
        artist: 'artistSearch',
        prompt: 'promptSearch',
        outputs: 'outputsSearch',
        // prompt-freq 无独立搜索框，回退主搜索
        'prompt-freq': 'searchInput',
      }
      const id = map[section]
      const el = id ? document.getElementById(id) : null
      if (el) { el.focus(); (el as HTMLInputElement).select?.() }
      else document.getElementById('searchInput')?.focus()
      break
    }
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
    // 遮罩点击关闭：仅创建时绑定一次，避免重复打开监听器堆积
    modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(SETTINGS_MODAL_ID) })
  }
  const s = getSettings()
  modal.innerHTML = renderSettingsHTML(s)
  openModal(SETTINGS_MODAL_ID)

  // Close handler（innerHTML 重建后重新绑定）
  document.getElementById('settingsCloseBtn')?.addEventListener('click', () => closeModal(SETTINGS_MODAL_ID))

  // Bind all events
  bindLanguageEvents()
  bindBackgroundEvents()
  setToolboxIconPreview(s.toolboxIcon)
  bindToolboxIconEvents()
  bindLayoutEvents()
  bindSurfaceEvents()
  bindMotionEvents()
  bindTypographyEvents()
  bindCSSEvents()
  bindShortcutEvents()
  bindImportExportEvents()
  syncSettingsRanges()

  // C 站 API Key 统一管理（下载弹窗自动用）
  document.getElementById('civitaiApiKey')?.addEventListener('change', (e) => {
    const v = ((e.target as HTMLInputElement).value || '').trim()
    if (v) localStorage.setItem('anima_civitai_token', v)
    else localStorage.removeItem('anima_civitai_token')
    showToast(v ? t('settings.civitai.keySaved') : t('settings.civitai.keyCleared'))
  })

  // C 站线路：默认 civitai.com；部分网络不可达时可切镜像站（civitai.red）
  const hostSel = document.getElementById('civitaiHost') as HTMLSelectElement | null
  const hostCustomRow = document.getElementById('civitaiHostCustomRow')
  const hostCustomInput = document.getElementById('civitaiHostCustomInput') as HTMLInputElement | null
  if (hostSel) {
    const current = getCivitaiHost()
    hostSel.value = current === 'https://civitai.com' ? '' : (current === 'https://civitai.red' ? current : 'custom')
    if (hostSel.value === 'custom') {
      if (hostCustomRow) hostCustomRow.style.display = ''
      if (hostCustomInput) hostCustomInput.value = current
    }
    hostSel.addEventListener('change', () => {
      if (hostSel.value === 'custom') {
        if (hostCustomRow) hostCustomRow.style.display = ''
        if (hostCustomInput) { if (!hostCustomInput.value.trim()) hostCustomInput.value = current; hostCustomInput.focus() }
        return
      }
      if (hostCustomRow) hostCustomRow.style.display = 'none'
      setCivitaiHost(hostSel.value)
      showToast(hostSel.value ? t('settings.civitai.routeChanged', { host: getCivitaiHost() }) : t('settings.civitai.defaultRestored'))
    })
    hostCustomInput?.addEventListener('change', () => {
      const v = hostCustomInput.value.trim()
      setCivitaiHost(v)
      showToast(v ? t('settings.civitai.routeChanged', { host: getCivitaiHost() }) : t('settings.civitai.defaultRestored'))
    })
  }

  // 本地 LoRA 扫描目录（预设路径）：留空 = 上次使用路径 = ComfyUI 注册的 loras 目录
  document.getElementById('localScanDir')?.addEventListener('change', (e) => {
    const v = ((e.target as HTMLInputElement).value || '').trim()
    saveSettings({ localScanDir: v })
    showToast(v ? t('settings.scan.saved') : t('settings.scan.cleared'))
  })
}

function bindLanguageEvents() {
  const select = document.getElementById('settingsLanguage') as HTMLSelectElement | null
  select?.addEventListener('change', () => {
    const locale = select.value === 'en' ? 'en' : 'zh-CN'
    if (locale === getLocale()) return
    const previous = getSettings()
    const textarea = document.getElementById('customCSS') as HTMLTextAreaElement | null
    clearTimeout(cssDraftTimer)
    // CSS has a debounce; save its current draft before reinitializing the page.
    if (!saveSettings({ locale, customCSS: textarea?.value ?? previous.customCSS })) {
      saveSettings(previous)
      select.value = previous.locale
      showToast(t('settings.language.saveFailed'))
      return
    }
    setLocale(locale)
    window.location.reload()
  })
}

function applyRestoredSettings() {
  clearTimeout(cssDraftTimer)
  const settings = loadSettings()
  if (settings.locale !== getLocale()) {
    setLocale(settings.locale)
    window.location.reload()
    return
  }
  applySettings(settings)
  closeModal(SETTINGS_MODAL_ID)
  setTimeout(openSettings, 100)
}

function readToolboxIconFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) return Promise.reject(new Error(t('settings.image.choose')))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(t('settings.image.readFailed')))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error(t('settings.image.decodeFailed')))
      image.onload = () => {
        const max = 128
        const scale = Math.min(1, max / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
        canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error(t('settings.toolbox.unsupported')))
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const webp = canvas.toDataURL('image/webp', 0.86)
        resolve(webp.startsWith('data:image/') ? webp : canvas.toDataURL('image/png'))
      }
      image.src = String(reader.result || '')
    }
    reader.readAsDataURL(file)
  })
}

function bindToolboxIconEvents() {
  const fileInput = document.getElementById('toolboxIconFileInput') as HTMLInputElement | null
  document.getElementById('toolboxIconUploadBtn')?.addEventListener('click', () => fileInput?.click())
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    try {
      const iconData = await readToolboxIconFile(file)
      saveSettings({ toolboxIcon: iconData })
      setToolboxIconPreview(iconData)
      showToast(t('settings.toolbox.saved'))
    } catch (error) {
      showToast(t('settings.toolbox.failedPrefix') + String((error as Error)?.message || error))
    }
  })

  document.getElementById('toolboxIconUrlBtn')?.addEventListener('click', async () => {
    const current = normalizeToolboxIcon(getSettings().toolboxIcon)
    const value = await promptModal(t('settings.toolbox.urlPrompt'), current.startsWith('data:') ? '' : current, t('settings.toolbox.urlHelp'))
    if (value == null) return
    const normalized = normalizeToolboxIcon(value)
    if (!normalized) {
      showToast(t('settings.toolbox.invalidUrl'))
      return
    }
    saveSettings({ toolboxIcon: normalized })
    setToolboxIconPreview(normalized)
    showToast(t('settings.toolbox.saved'))
  })

  document.getElementById('toolboxIconResetBtn')?.addEventListener('click', () => {
    saveSettings({ toolboxIcon: '' })
    setToolboxIconPreview('')
    showToast(t('settings.toolbox.restored'))
  })
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
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      // 存 IndexedDB（localStorage 5MB 上限，大图会静默失败）
      try {
        await saveBgImageDB(dataUrl)
        saveSettings({ bgImage: '__idb__' })
        applySettings()
      } catch (e) {
        console.error('[背景图] IndexedDB 保存失败:', e)
        showToast(t('settings.background.saveFailed'))
      }
    }
    reader.readAsDataURL(file)
  })

  // URL
  document.getElementById('bgUrlBtn')?.addEventListener('click', async () => {
    const url = await promptModal(t('settings.background.urlPrompt'), '', t('settings.background.urlHelp'))
    if (url) {
      saveSettings({ bgImage: url })
      applySettings()
    }
  })

  // Clear
  document.getElementById('bgClearBtn')?.addEventListener('click', () => {
    clearBgImageDB().catch(() => {})
    saveSettings({ bgImage: '' })
    applySettings()
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
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = t('settings.background.blur', { value: v }))
  })

  // Opacity
  document.getElementById('bgOpacity')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value) / 100
    saveSettings({ bgOpacity: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = t('settings.background.opacity', { value: Math.round(v * 100) }))
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
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = t('settings.layout.cardSize', { value: v }))
  })

  document.getElementById('localCardSize')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value)
    saveSettings({ localCardSize: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = t('settings.layout.localCardSize', { value: v }))
  })

  document.querySelectorAll('[data-content-width]').forEach(btn => {
    btn.addEventListener('click', () => {
      const contentWidth = (btn as HTMLElement).dataset.contentWidth as AppSettings['contentWidth']
      saveSettings({ contentWidth })
      applySettings()
      document.querySelectorAll('[data-content-width]').forEach(b => b.classList.toggle('active', b === btn))
    })
  })
}

function bindSurfaceEvents() {
  const bindOpacity = (id: 'panelOpacity' | 'buttonOpacity', key: 'panelOpacity' | 'buttonOpacity', labelKey: MessageKey) => {
    document.getElementById(id)?.addEventListener('input', (e) => {
      const percent = Number((e.target as HTMLInputElement).value)
      saveSettings({ [key]: percent / 100 })
      applySettings()
      const row = (e.target as HTMLElement).closest('.settings-row')
      row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = t(labelKey, { value: percent }))
    })
  }

  bindOpacity('panelOpacity', 'panelOpacity', 'settings.surface.panelOpacity')
  bindOpacity('buttonOpacity', 'buttonOpacity', 'settings.surface.buttonOpacity')
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
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = t('settings.motion.speed', { value: v }))
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
  document.getElementById('fontMono')?.addEventListener('change', (e) => {
    saveSettings({ fontMono: (e.target as HTMLSelectElement).value })
    applySettings()
  })
  document.getElementById('fontSize')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value)
    saveSettings({ fontSize: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = t('settings.font.size', { value: v }))
  })
  document.getElementById('lineHeight')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value) / 10
    saveSettings({ lineHeight: v })
    applySettings()
    const row = (e.target as HTMLElement).closest('.settings-row')
    row?.querySelector('.settings-label')?.textContent && ((row.querySelector('.settings-label') as HTMLElement).textContent = t('settings.font.lineHeight', { value: v.toFixed(1) }))
  })
}

function bindCSSEvents() {
  const textarea = document.getElementById('customCSS') as HTMLTextAreaElement
  textarea?.addEventListener('input', () => {
    markSettingsPending()
    clearTimeout(cssDraftTimer)
    cssDraftTimer = setTimeout(() => {
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
    btn.textContent = t('settings.shortcut.record')
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
      applyRestoredSettings()
    }
  })

  // Backup: 导出全部数据（IndexedDB + Prompt 库 + 设置 + 背景图，不含缩略图）
  document.getElementById('exportAllBtn')?.addEventListener('click', async () => {
    try {
      const data = await exportAll()
      const json = JSON.stringify(data, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `anima-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      showToast(t('settings.transfer.exported'))
    } catch (e) {
      showToast(t('settings.transfer.exportFailedPrefix') + String((e && (e as Error).message) || e))
    }
  })

  // Backup: 导入全部数据（导入前自动备份当前数据）
  const backupInput = document.getElementById('backupFileInput') as HTMLInputElement
  document.getElementById('importAllBtn')?.addEventListener('click', () => backupInput?.click())
  backupInput?.addEventListener('change', async () => {
    const file = backupInput.files?.[0]
    if (!file) return
    const text = await file.text()
    // 导入前自动把当前数据再导出一份到下载，防止误覆盖
    try {
      const current = await exportAll()
      const json = JSON.stringify(current, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `anima-backup-before-import-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) { /* 自动备份失败不阻塞导入 */ }
    const res = await importAll(text)
    if (res.ok) {
      applyRestoredSettings()
      showToast(t('settings.transfer.restored'))
    } else {
      showToast(t('settings.transfer.importFailedPrefix') + (res.error || t('settings.transfer.unknownError')))
    }
  })

  // Reset
  document.getElementById('resetSettingsBtn')?.addEventListener('click', async () => {
    const ok = await confirmModal(t('settings.transfer.resetTitle'), t('settings.transfer.resetBody'))
    if (ok) {
      resetSettings()
      applyRestoredSettings()
    }
  })
}


