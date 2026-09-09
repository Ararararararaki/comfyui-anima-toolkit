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
  localCardSize: number
  contentWidth: 'standard' | 'wide' | 'full'
  panelOpacity: number
  buttonOpacity: number

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

  // LoRA 管理静默扫描的预设目录（绝对路径；留空 = 上次使用路径 = ComfyUI 注册的 loras 目录）
  localScanDir: string

  // ComfyUI 顶部工具箱入口
  toolboxIcon: string
}

const STORAGE_KEY = 'anima_settings'

const DEFAULTS: AppSettings = {
  bgImage: '',
  bgMode: 'cover',
  bgBlur: 0,
  bgOpacity: 1,
  density: 'default',
  cardSize: 320,
  // Surface strength: lower values reveal more of the background image.
  panelOpacity: 0.72,
  buttonOpacity: 0.30,
  localCardSize: 180,
  // 默认全宽自适应铺满窗口；'standard'/'wide' 是用户主动选择的定宽档
  contentWidth: 'full',
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
  localScanDir: '',
  toolboxIcon: '',
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

/* ── 背景图 IndexedDB 存储（localStorage 有 ~5MB 上限，大背景图存这里避免静默失败） ── */

const BG_DB = 'anima-bg'
const BG_STORE = 'bg'

function openBgDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BG_DB, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(BG_STORE)) req.result.createObjectStore(BG_STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveBgImageDB(dataUrl: string): Promise<void> {
  const db = await openBgDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BG_STORE, 'readwrite')
    tx.objectStore(BG_STORE).put(dataUrl, 'bgImage')
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function loadBgImageDB(): Promise<string | null> {
  const db = await openBgDb()
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(BG_STORE, 'readonly')
    const req = tx.objectStore(BG_STORE).get('bgImage')
    req.onsuccess = () => { db.close(); resolve((req.result as string) || null) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

export async function clearBgImageDB(): Promise<void> {
  const db = await openBgDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BG_STORE, 'readwrite')
    tx.objectStore(BG_STORE).delete('bgImage')
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}
