import { icon } from '../utils/icon'
import { t } from '../i18n'

/** 21st-inspired palettes adapted to the Toolkit's existing tokens, not copied
 * React components. Theme selection shares the established anima_theme key. */
export type ToolkitThemeId = 'graphite-mono' | 'modern-minimal' | 'sage-garden' | 'claude-amber' | 'catppuccin'
export type ToolkitThemeMode = 'light' | 'dark' | 'system'
export type LegacyThemeId = 'drinkit' | 'mono' | 'mono-light'
export type ToolkitThemeChoice = ToolkitThemeId | LegacyThemeId

export interface ToolkitThemePreset {
  id: ToolkitThemeId
  name: string
  description: string
  sourceUrl: string
  lightPreview: readonly [string, string, string]
  darkPreview: readonly [string, string, string]
}

export const TOOLKIT_THEMES: readonly ToolkitThemePreset[] = [
  { id: 'graphite-mono', get name() { return t('shell.themeGraphite') }, get description() { return t('shell.themeGraphiteDescription') }, sourceUrl: 'https://21st.dev/@serafimcloud/themes/graphite-mono', lightPreview: ['#f4f5f6', '#ffffff', '#34373b'], darkPreview: ['#17191d', '#202328', '#dee1e6'] },
  { id: 'modern-minimal', get name() { return t('shell.themeMinimal') }, get description() { return t('shell.themeMinimalDescription') }, sourceUrl: 'https://21st.dev/@serafimcloud/themes/modern-minimal', lightPreview: ['#f5f7fa', '#ffffff', '#286bd1'], darkPreview: ['#151b25', '#1d2633', '#8db5fb'] },
  { id: 'sage-garden', get name() { return t('shell.themeSage') }, get description() { return t('shell.themeSageDescription') }, sourceUrl: 'https://21st.dev/@serafimcloud/themes/sage-garden', lightPreview: ['#f3f5ef', '#fcfdf9', '#426b48'], darkPreview: ['#18201b', '#222d25', '#a5c49e'] },
  { id: 'claude-amber', get name() { return t('shell.themeAmber') }, get description() { return t('shell.themeAmberDescription') }, sourceUrl: 'https://21st.dev/@serafimcloud/themes/claude-amber', lightPreview: ['#f7f4ee', '#fffdf8', '#986829'], darkPreview: ['#211d19', '#2c2721', '#ecc08f'] },
  { id: 'catppuccin', get name() { return t('shell.themeCatppuccin') }, get description() { return t('shell.themeCatppuccinDescription') }, sourceUrl: 'https://21st.dev/@serafimcloud/themes/catppuccin', lightPreview: ['#f2f0f7', '#fcfbff', '#7756ba'], darkPreview: ['#1e1e2e', '#29293d', '#c4acee'] },
]

const LEGACY_THEMES: readonly { id: LegacyThemeId; name: string }[] = [
  { id: 'drinkit', get name() { return t('shell.themeLegacyBlue') } },
  { id: 'mono', get name() { return t('shell.themeLegacyBlack') } },
  { id: 'mono-light', get name() { return t('shell.themeLegacyWhite') } },
]
const THEME_KEY = 'anima_theme'
const MODE_KEY = 'anima_theme_mode'
let selectorSequence = 0

export function getToolkitThemePreset(id: string | null | undefined): ToolkitThemePreset | undefined {
  return TOOLKIT_THEMES.find(theme => theme.id === id)
}

function readPreference(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function normalizeMode(value: string | null | undefined): ToolkitThemeMode {
  return value === 'dark' || value === 'system' ? value : 'light'
}

export function getToolkitThemeSelection(): { theme: string; mode: ToolkitThemeMode } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') || readPreference(THEME_KEY) || 'drinkit',
    mode: normalizeMode(root.getAttribute('data-theme-preference-mode') || readPreference(MODE_KEY)),
  }
}

function applyTheme(theme: ToolkitThemeChoice, mode: ToolkitThemeMode): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  if (getToolkitThemePreset(theme)) {
    const resolved = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode
    root.setAttribute('data-theme-preference-mode', mode)
    root.setAttribute('data-theme-mode', resolved)
  } else {
    root.removeAttribute('data-theme-preference-mode')
    root.removeAttribute('data-theme-mode')
  }
  // Keep the original three shortcuts truthful when the new selector is used.
  document.querySelectorAll<HTMLElement>('.theme-dot').forEach(dot => {
    const selected = dot.dataset.theme === theme
    dot.classList.toggle('active', selected)
    dot.setAttribute('aria-pressed', String(selected))
  })
}

/** Explicit user action only. A storage failure still applies to this page and
 * is reported to the caller so the selector does not falsely promise a save. */
export function setToolkitTheme(theme: ToolkitThemeChoice, mode: ToolkitThemeMode = 'light'): { saved: boolean } {
  if (!getToolkitThemePreset(theme) && !LEGACY_THEMES.some(item => item.id === theme)) {
    throw new Error(`Unknown Toolkit theme: ${theme}`)
  }
  const selectedMode = normalizeMode(mode)
  applyTheme(theme, selectedMode)
  try {
    localStorage.setItem(THEME_KEY, theme)
    localStorage.setItem(MODE_KEY, selectedMode)
    return { saved: true }
  } catch {
    return { saved: false }
  }
}

/** Call once after the existing theme restoration. With no new theme saved,
 * this leaves the established default and all user appearance settings alone. */
export function initToolkitTheme(): () => void {
  const restore = () => {
    const saved = readPreference(THEME_KEY)
    if (getToolkitThemePreset(saved)) applyTheme(saved as ToolkitThemeId, normalizeMode(readPreference(MODE_KEY)))
  }
  restore()
  const media = matchMedia('(prefers-color-scheme: dark)')
  const onSystemChange = () => {
    const { theme, mode } = getToolkitThemeSelection()
    if (getToolkitThemePreset(theme) && mode === 'system') applyTheme(theme as ToolkitThemeId, mode)
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_KEY && event.key !== MODE_KEY) return
    const saved = readPreference(THEME_KEY)
    if (getToolkitThemePreset(saved) || LEGACY_THEMES.some(item => item.id === saved)) {
      applyTheme(saved as ToolkitThemeChoice, normalizeMode(readPreference(MODE_KEY)))
    }
  }
  media.addEventListener('change', onSystemChange)
  window.addEventListener('storage', onStorage)
  return () => {
    media.removeEventListener('change', onSystemChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** Mount into a settings section or the appearance footer. The owned DOM,
 * attribute subscription and listeners are removed together on dispose. */
export function mountToolkitThemeSelector(host: HTMLElement, options: { compact?: boolean } = {}): { dispose: () => void } {
  const abort = new AbortController()
  const root = document.createElement('div')
  root.className = `toolkit-theme-selector${options.compact ? ' toolkit-theme-selector--compact' : ''}`
  const heading = document.createElement('div')
  heading.className = 'toolkit-theme-selector-heading'
  heading.innerHTML = `${icon('palette', 15)}<span>${t('shell.appearanceTheme')}</span>`
  root.append(heading)

  const id = ++selectorSequence
  const themeLabel = document.createElement('label')
  themeLabel.className = 'toolkit-theme-field'
  themeLabel.textContent = t('shell.themePalette')
  const select = document.createElement('select')
  select.id = `toolkit-theme-${id}`
  select.setAttribute('aria-label', t('shell.themeAria'))
  themeLabel.htmlFor = select.id
  LEGACY_THEMES.forEach(theme => select.add(new Option(theme.name, theme.id)))
  TOOLKIT_THEMES.forEach(theme => select.add(new Option(theme.name, theme.id)))
  themeLabel.append(select)

  const modeLabel = document.createElement('label')
  modeLabel.className = 'toolkit-theme-field'
  modeLabel.textContent = t('shell.themeMode')
  const mode = document.createElement('select')
  mode.id = `toolkit-theme-mode-${id}`
  mode.setAttribute('aria-label', t('shell.themeModeAria'))
  modeLabel.htmlFor = mode.id
  mode.add(new Option(t('shell.themeLight'), 'light'))
  mode.add(new Option(t('shell.themeDark'), 'dark'))
  mode.add(new Option(t('shell.themeSystem'), 'system'))
  modeLabel.append(mode)
  root.append(themeLabel, modeLabel)

  const details = document.createElement('div')
  details.className = 'toolkit-theme-details'
  const palette = document.createElement('span')
  palette.className = 'toolkit-theme-palette'
  palette.setAttribute('aria-hidden', 'true')
  const description = document.createElement('span')
  description.className = 'toolkit-theme-description'
  details.append(palette, description)
  const source = document.createElement('a')
  source.className = 'toolkit-theme-source'
  source.target = '_blank'
  source.rel = 'noopener noreferrer'
  source.innerHTML = `${t('shell.themeReference')} ${icon('external', 12)}`
  const status = document.createElement('span')
  status.className = 'toolkit-theme-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  root.append(details, source, status)
  host.append(root)

  const sync = () => {
    const current = getToolkitThemeSelection()
    select.value = current.theme
    mode.value = current.mode
    const preset = getToolkitThemePreset(current.theme)
    mode.disabled = !preset
    palette.replaceChildren()
    if (preset) {
      const dark = document.documentElement.getAttribute('data-theme-mode') === 'dark'
      for (const color of dark ? preset.darkPreview : preset.lightPreview) {
        const swatch = document.createElement('i')
        swatch.style.backgroundColor = color
        palette.append(swatch)
      }
      description.textContent = preset.description
      source.href = preset.sourceUrl
    } else {
      description.textContent = t('shell.themeLegacyDescription')
      source.removeAttribute('href')
    }
    source.hidden = !preset
  }
  const onChange = () => {
    const { saved } = setToolkitTheme(select.value as ToolkitThemeChoice, mode.value as ToolkitThemeMode)
    status.textContent = saved ? t('shell.themeSaved') : t('shell.themeNotSaved')
    sync()
  }
  select.addEventListener('change', onChange, { signal: abort.signal })
  mode.addEventListener('change', onChange, { signal: abort.signal })
  const observer = new MutationObserver(sync)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-mode', 'data-theme-preference-mode'] })
  sync()
  return { dispose: () => { abort.abort(); observer.disconnect(); root.remove() } }
}
