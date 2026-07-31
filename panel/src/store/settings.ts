/* ── App Settings Store ── */

export interface AppSettings {
  // Background
  bgImage: string
  bgMode: 'cover' | 'contain' | 'center' | 'tile' | 'stretch'
  bgBlur: number
  bgOpacity: number

  // Layout
  density: 'compact' | 'default' | 'comfortable'
  cardSize: number

  // Motion
  motionMode: 'full' | 'reduced' | 'none'
  transitionSpeed: number

  // Custom CSS
  customCSS: string

  // Typography
  fontBody: string
  fontHeading: string
  fontMono: string
  fontSize: number
  lineHeight: number

  // Shortcuts
  shortcuts: Record<string, string>

  // ComfyUI
  comfyUIPath: string
}

const STORAGE_KEY = 'anima_settings'

const DEFAULTS: AppSettings = {
  bgImage: '',
  bgMode: 'cover',
  bgBlur: 0,
  bgOpacity: 1,
  density: 'default',
  cardSize: 320,
  motionMode: 'full',
  transitionSpeed: 250,
  customCSS: '',
  fontBody: '',
  fontHeading: '',
  fontMono: '',
  fontSize: 14,
  lineHeight: 1.6,
  shortcuts: {
    search: 'Ctrl+K',
    toggleTheme: 'T',
    copyPrompt: 'Ctrl+Shift+C',
    toggleSettings: 'Ctrl+,',
  },
  comfyUIPath: '',
}

let _settings: AppSettings = { ...DEFAULTS }

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) _settings = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ..._settings }
}

export function saveSettings(partial: Partial<AppSettings>) {
  Object.assign(_settings, partial)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_settings))
  } catch { /* quota exceeded */ }
}

export function getSettings(): AppSettings {
  return { ..._settings }
}

export function resetSettings(): AppSettings {
  _settings = { ...DEFAULTS }
  localStorage.removeItem(STORAGE_KEY)
  return { ..._settings }
}

export function exportSettings(): string {
  const all: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith('anima_')) all[k] = localStorage.getItem(k) || ''
  }
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data: all }, null, 2)
}

export function importSettings(json: string): boolean {
  try {
    const parsed = JSON.parse(json)
    if (parsed.data && typeof parsed.data === 'object') {
      for (const [k, v] of Object.entries(parsed.data)) {
        if (k.startsWith('anima_') && typeof v === 'string') {
          localStorage.setItem(k, v)
        }
      }
      return true
    }
    return false
  } catch { return false }
}
