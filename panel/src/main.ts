import './styles/global.css'
import './styles/outputs.css'
import './styles/clothing.css'
import './styles/polish.css'
import './styles/design-system.css'
import { initLoraExplorer, setupBindingListeners, setupGlobalHandlers } from './sections/LoraExplorer'
import { setupModalListeners } from './components/Modal'
import { setupPromptHandlers } from './sections/PromptLibrary'
import { initLocalManager } from './sections/LocalManager'
import { bindArtistEvents } from './sections/ArtistSeries'
import { initSettings, applySettings } from './sections/Settings'
import { initOutputs } from './sections/Outputs'
import { ensureOutputsDbCompatible } from './db/outputsDb'
import { bindPromptFreqEvents } from './sections/PromptFreq'
import { initClothing } from './sections/ClothingLibrary'
import { initIconButtons, showToast } from './utils'
import { initCommandPalette } from './sections/CommandPalette'

declare const __BUILD_TIME__: string

/**
 * 「有新版本」自检（2026-09-10 增）：
 * 面板是长时间开着的标签页，部署新版后旧页面**不会自己刷新**，而右上角构建时间
 * 又是旧 bundle 里烤进去的 —— 于是"看起来是最新版、行为却是旧版"极难分辨
 * （本次 Outputs 卡顿排查就卡在这一步）。这里在页面获得焦点/可见时对比
 * `index.html` 实际引用的 bundle 名与当前运行的 bundle 名，不一致就明确提示刷新。
 */
function initBuildFreshnessCheck() {
  const running = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
    .map(s => (/(index-[A-Za-z0-9_-]+\.js)/.exec(s.src) || [])[1])
    .find(Boolean)
  if (!running) return
  let last = 0
  const check = async () => {
    if (Date.now() - last < 60000) return
    last = Date.now()
    try {
      const res = await fetch(location.pathname + '?_=' + Date.now(), { cache: 'no-store' })
      if (!res.ok) return
      const html = await res.text()
      const latest = (/(index-[A-Za-z0-9_-]+\.js)/.exec(html) || [])[1]
      if (latest && latest !== running) {
        console.warn(`[panel] 有新版可用：运行中 ${running} → 服务器上 ${latest}（请 Ctrl+Shift+R 刷新）`)
        showToast('🔄 面板有新版本，按 Ctrl+Shift+R 刷新即可生效')
      }
    } catch { /* 离线/服务未起：忽略 */ }
  }
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
  setTimeout(check, 8000)
}

// ── 构建时间显示（右上角；确认是否加载新版本）──
function initBuildTime() {
  const el = document.getElementById('buildTime')
  if (el && typeof __BUILD_TIME__ !== 'undefined') {
    el.textContent = `构建 ${__BUILD_TIME__}`
    el.title = `面板构建时间：${__BUILD_TIME__}（发布新版后重开面板窗口即更新）`
  }
}

// ── Theme switcher ──
function initThemeSwitcher() {
  const saved = localStorage.getItem('anima_theme') || 'drinkit'
  if (saved) document.documentElement.setAttribute('data-theme', saved)

  document.getElementById('themeSwitcher')?.addEventListener('click', (e) => {
    const dot = (e.target as HTMLElement).closest('.theme-dot') as HTMLElement
    if (!dot) return
    const theme = dot.dataset.theme || 'mono'
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('anima_theme', theme)
    document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', d === dot))
  })

  // Set initial active state
  document.querySelectorAll('.theme-dot').forEach(d => {
    d.classList.toggle('active', (d as HTMLElement).dataset.theme === saved)
  })
}

// ── 布局自适应：header 实际高度写入 CSS 变量，主容器高度跟随（替换写死的 calc(100vh - 100px)）──
function initLayoutVars() {
  const header = document.querySelector('header')
  if (!header) return
  const update = () => document.documentElement.style.setProperty('--header-h', `${Math.round(header.getBoundingClientRect().height)}px`)
  update()
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(update).observe(header)
  } else {
    window.addEventListener('resize', update)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // 库结构预检（异步）：历史版本/外部工具留下的主键不符库会让 Dexie 升级抛
  // UpgradeError，这里先探测并自愈，扫描等 DataBase 操作都在其之后触发。
  ensureOutputsDbCompatible().catch(err => console.warn('[outputsDb] 预检/自愈异常:', err))
  initIconButtons()
  initThemeSwitcher()
  initLayoutVars()
  initBuildTime()
  initBuildFreshnessCheck()
  initSettings()
  setupGlobalHandlers()
  setupBindingListeners()
  setupModalListeners()
  setupPromptHandlers()
  bindPromptFreqEvents()
  initClothing()
  initLoraExplorer()
  initLocalManager()
  bindArtistEvents()
  initOutputs()
  initCommandPalette()
})
