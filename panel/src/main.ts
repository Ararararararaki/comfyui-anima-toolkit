import './styles/global.css'
import './styles/outputs.css'
import './styles/clothing.css'
import { initLoraExplorer, setupBindingListeners, setupGlobalHandlers } from './sections/LoraExplorer'
import { setupModalListeners } from './components/Modal'
import { setupPromptHandlers } from './sections/PromptLibrary'
import { initLocalManager } from './sections/LocalManager'
import { bindArtistEvents } from './sections/ArtistSeries'
import { initSettings, applySettings } from './sections/Settings'
import { initOutputs } from './sections/Outputs'
import { bindPromptFreqEvents } from './sections/PromptFreq'
import { initClothing } from './sections/ClothingLibrary'
import { initIconButtons } from './utils'
import { initCommandPalette } from './sections/CommandPalette'

// ── Theme switcher ──
function initThemeSwitcher() {
  const saved = localStorage.getItem('anima_theme') || 'mono-light'
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

document.addEventListener('DOMContentLoaded', () => {
  initIconButtons()
  initThemeSwitcher()
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
