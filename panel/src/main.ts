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
import { initIconButtons } from './utils'
import { initCommandPalette } from './sections/CommandPalette'

declare const __BUILD_TIME__: string

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
