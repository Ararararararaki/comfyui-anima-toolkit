import { create } from 'zustand'
import type { LocalLoraFile, PngMeta, TagFreq, LocalScanStatus } from '../types'
import { Cache } from './cache'
import { fetchModelVersionByHash, fetchModelById, parseCivitaiModelId } from '../api/civitai'
import { showToast, stripExt } from '../utils'
import { collectLoraFiles, groupLoraNamesByTopLevelFolder, normalizeRelativeLoraPath, removeLoraFile } from '../services/localLoraScanner'
import { LocalScanSession, type ManifestEntry, type ScanListing } from '../services/localScanSession'
import { hashFileSha256 } from '../services/fileHashWorker'
import { getSettings } from './settings'

let _lastBackendSync = 0
let _backendMetaLoad: Promise<boolean> | null = null
// 分类操作可能在短时间内连续触发；串行化 POST，避免后发请求先完成后又被旧快照覆盖。
let _categorySyncQueue: Promise<void> = Promise.resolve()
export const localScanSession: LocalScanSession<ScanFile> = new LocalScanSession<ScanFile>({
  read: () => useLocalModelStore.getState(),
  commit: update => useLocalModelStore.setState(update),
  hash: hashScanFile,
  match: (hash, signal) => fetchModelVersionByHash(hash, signal),
  persist: () => {
    useLocalModelStore.getState().saveToCache()
    useLocalModelStore.getState().rebuildTagFreq()
  },
  removePreviews: names => { for (const name of names) void deleteLocalLoraPreview(name) },
})

export type LocalSortKey = 'name' | 'size' | 'date' | 'match'
export type LocalFilterKey = 'all' | 'matched' | 'unmatched'
export type LocalViewKey = 'home' | 'detail' | 'gallery' | 'prompt' | 'models'
export type LocalDisplayMode = 'list' | 'grid'

const SCAN_CACHE_KEY = 'local_loras_v2'
const PNG_CACHE_KEY = 'local_pngs_v1'
const TAG_CACHE_KEY = 'local_tag_freq_v1'
const CAT_CACHE_KEY = 'local_categories_v1'
const MANIFEST_CACHE_KEY = 'local_manifest_v1'
const DISPLAY_MODE_CACHE_KEY = 'local_display_mode_v1'
const BASE_MODEL_CACHE_KEY = 'local_basemodel_filter_v1'
const _bmPersist = Cache.load<{ filter?: string; open?: boolean }>(BASE_MODEL_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || {}

const PREVIEW_DB_NAME = 'anima-local-lora-previews-v1'
const PREVIEW_STORE_NAME = 'images'
type LocalPreviewRecord = { name: string; image: string }

function openLocalPreviewDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(PREVIEW_DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PREVIEW_STORE_NAME)) {
          request.result.createObjectStore(PREVIEW_STORE_NAME, { keyPath: 'name' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** 自定义预览图放 IndexedDB，避免把图片 data URL 塞进 localStorage 扫描缓存导致超额。 */
export async function loadLocalLoraPreviews(): Promise<Record<string, string>> {
  const db = await openLocalPreviewDb()
  if (!db) return {}
  return new Promise(resolve => {
    try {
      const request = db.transaction(PREVIEW_STORE_NAME, 'readonly').objectStore(PREVIEW_STORE_NAME).getAll()
      request.onsuccess = () => {
        const result: Record<string, string> = {}
        for (const row of (request.result as LocalPreviewRecord[] || [])) {
          if (row?.name && row.image) result[row.name] = row.image
        }
        db.close()
        resolve(result)
      }
      request.onerror = () => { db.close(); resolve({}) }
    } catch {
      db.close()
      resolve({})
    }
  })
}

export async function saveLocalLoraPreview(name: string, image: string): Promise<boolean> {
  const db = await openLocalPreviewDb()
  if (!db) return false
  return new Promise(resolve => {
    try {
      const tx = db.transaction(PREVIEW_STORE_NAME, 'readwrite')
      tx.objectStore(PREVIEW_STORE_NAME).put({ name, image } satisfies LocalPreviewRecord)
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
      tx.onabort = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}

export async function deleteLocalLoraPreview(name: string): Promise<void> {
  const db = await openLocalPreviewDb()
  if (!db) return
  try {
    const tx = db.transaction(PREVIEW_STORE_NAME, 'readwrite')
    tx.objectStore(PREVIEW_STORE_NAME).delete(name)
    tx.oncomplete = () => db.close()
    tx.onerror = () => db.close()
    tx.onabort = () => db.close()
  } catch {
    db.close()
  }
}
interface LocalModelState {
  files: LocalLoraFile[]
  scanPath: string
  scanStatus: LocalScanStatus
  scanProgress: { done: number; total: number }
  pngs: PngMeta[]
  tagFreq: TagFreq[]
  scanningDir: string

  searchQuery: string
  sortKey: LocalSortKey
  filterKey: LocalFilterKey
  selectedModel: string | null
  currentView: LocalViewKey
  displayMode: LocalDisplayMode
  previewImages: Record<string, string>

  dirHandle: FileSystemDirectoryHandle | null

  categories: string[]
  modelCategories: Record<string, string[]>
  filterCategory: string | null
  /** 「按底模」筛选：'' = 全部；'__unmatched__' = 未匹配/未知；否则 = Civitai baseModel 字符串 */
  filterBaseModel: string
  /** 左栏「按底模」展开面板是否展开（持久化） */
  baseModelPanelOpen: boolean
  batchMode: boolean
  batchSelection: string[]

  promptWeights: Record<string, number>

  descriptions: Record<string, string>

  expandedCategories: string[]

  manifest: Record<string, ManifestEntry>
  newFileCount: number

  setCategories: (cats: string[]) => void
  addCategory: (name: string) => void
  removeCategory: (name: string) => void
  renameCategory: (oldName: string, newName: string) => void
  setModelCategories: (fileName: string, cats: string[]) => void
  setBatchModelCategories: (fileNames: string[], cat: string) => void
  categorizeBySubfolders: () => { folders: string[]; createdCategories: number; assignedFiles: number }
  clearModelCategories: (fileName: string) => void
  setFilterCategory: (cat: string | null) => void
  setFilterBaseModel: (bm: string) => void
  toggleBaseModelPanel: () => void
  setBatchMode: (b: boolean) => void
  toggleBatchSelection: (name: string) => void
  clearBatchSelection: () => void
  setPromptWeights: (w: Record<string, number>) => void
  setDescription: (fileName: string, text: string) => void
  toggleCategoryExpanded: (cat: string) => void

  // 与节点 /anima/meta 双向分类同步
  fetchBackendMeta: () => Promise<any | null>
  loadBackendMeta: (force?: boolean) => Promise<boolean>
  syncCategoriesToBackend: () => Promise<void>

  matchByUrl: (name: string, url: string) => Promise<void>

  setSearchQuery: (q: string) => void
  setSortKey: (k: LocalSortKey) => void
  setFilterKey: (k: LocalFilterKey) => void
  selectModel: (name: string | null) => void
  setCurrentView: (v: LocalViewKey) => void
  setDisplayMode: (mode: LocalDisplayMode) => void
  setPreviewImage: (fileName: string, image: string) => void
  clearPreviewImage: (fileName: string) => void

  setScanPath: (p: string) => void
  setFiles: (files: LocalLoraFile[]) => void
  updateFile: (name: string, upd: Partial<LocalLoraFile>) => void
  setScanStatus: (s: LocalScanStatus) => void
  setScanProgress: (p: { done: number; total: number }) => void
  cancelScan: () => void
  setPngs: (pngs: PngMeta[]) => void
  addPng: (png: PngMeta) => void
  setTagFreq: (f: TagFreq[]) => void
  rebuildTagFreq: () => void
  setScanningDir: (d: string) => void

  scanDir: () => Promise<void>
  scanIncremental: () => Promise<void>
  matchAll: () => Promise<void>
  matchOne: (name: string) => Promise<void>
  deleteFile: (name: string) => Promise<void>
  saveDirHandle: () => Promise<void>
  loadDirHandle: () => Promise<boolean>
  saveToCache: () => void
  loadFromCache: () => boolean
  detectNewFiles: () => Promise<number>
  setNewFileCount: (n: number) => void
}

/** 后端静默扫描返回的文件引用：没有浏览器 File 对象，
 *  哈希与删除走 /anima/panel_scan/* 端点（ComfyUI 后端与本机文件系统同权）。 */
type BackendFileRef = { size: number; lastModified: number; __path: string }
type ScanFile = File | BackendFileRef
const isBackendRef = (f: ScanFile): f is BackendFileRef => '__path' in (f as BackendFileRef)

/** 上次使用的后端扫描目录（预设目录 = ComfyUI 注册的 loras 根，用空串表示） */
const SCAN_BACKEND_DIR_KEY = 'anima_scan_backend_dir'
function getLastScanDir(): string {
  try { return localStorage.getItem(SCAN_BACKEND_DIR_KEY) || '' } catch { return '' }
}
function setLastScanDir(dir: string) {
  try { localStorage.setItem(SCAN_BACKEND_DIR_KEY, dir) } catch {}
}

/** 哈希分派：后端引用走 /anima/panel_scan/hash，浏览器 File 走原 FileReader 管线。 */
async function hashScanFile(
  file: ScanFile,
  opts?: { signal?: AbortSignal; onProgress?: (p: { bytesRead: number; totalBytes: number }) => void }
): Promise<string> {
  if (isBackendRef(file)) {
    const resp = await fetch('/anima/panel_scan/hash?path=' + encodeURIComponent(file.__path), { signal: opts?.signal })
    if (!resp.ok) throw new Error(`后端哈希失败（HTTP ${resp.status}）`)
    const data = await resp.json()
    opts?.onProgress?.({ bytesRead: file.size, totalBytes: file.size })
    return String(data.sha256 || '')
  }
  return hashFileSha256(file as File, opts)
}

/** 列目录与哈希是 I/O 适配；扫描身份、取消和提交由 session 管理。 */
async function listBackendScan(dir: string, signal: AbortSignal): Promise<ScanListing<ScanFile>> {
  const q = dir ? ('?dir=' + encodeURIComponent(dir)) : ''
  const resp = await fetch('/anima/panel_scan/list' + q, { signal })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({} as { error?: string }))
    throw new Error(err.error || `后端扫描失败（HTTP ${resp.status}）`)
  }
  const data = await resp.json() as { files: { name: string; size: number; lastModified: number; path: string }[] }
  if (signal.aborted) throw new DOMException('扫描已取消', 'AbortError')
  setLastScanDir(dir)
  return {
    directory: dir || 'ComfyUI loras 目录',
    entries: (data.files || []).map(file => ({
      name: file.name,
      file: { size: file.size, lastModified: file.lastModified, __path: file.path },
    })),
  }
}

function listConfiguredDirectory(signal: AbortSignal): Promise<ScanListing<ScanFile>> {
  const preset = (getSettings().localScanDir || '').trim()
  return listBackendScan(preset || getLastScanDir(), signal)
}

export const useLocalModelStore = create<LocalModelState>((set, get) => ({
  files: [],
  scanPath: '',
  scanStatus: 'idle',
  scanProgress: { done: 0, total: 0 },
  pngs: Cache.load<PngMeta[]>(PNG_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || [],
  tagFreq: [],
  scanningDir: '',

  searchQuery: '',
  // 默认按时间倒序（=「扫描顺序」选项）：最新添加的 LoRA 排最前，与节点浏览窗默认排序统一。
  sortKey: 'date',
  filterKey: 'all',
  selectedModel: null,
  currentView: 'home',
  // 网格更适合本地 LoRA 的预览和批量操作；用户切换后的选择仍由缓存优先。
  displayMode: Cache.load<LocalDisplayMode>(DISPLAY_MODE_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || 'grid',
  previewImages: {},

  dirHandle: null,

  categories: Cache.load<string[]>(CAT_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || ['人物', '风格', '背景', '姿势'],
  modelCategories: Cache.load<Record<string, string[]>>(CAT_CACHE_KEY + '_mc', 365 * 24 * 60 * 60 * 1000) || {},
  filterCategory: null,
  filterBaseModel: typeof _bmPersist.filter === 'string' ? _bmPersist.filter : '',
  baseModelPanelOpen: !!_bmPersist.open,
  batchMode: false,
  batchSelection: [],
  promptWeights: {},
  descriptions: Cache.load<Record<string, string>>(CAT_CACHE_KEY + '_desc', 365 * 24 * 60 * 60 * 1000) || {},
  expandedCategories: Cache.load<string[]>(CAT_CACHE_KEY + '_exp', 365 * 24 * 60 * 60 * 1000) || ['__uncategorized__', '人物', '风格', '背景', '姿势'],
  manifest: Cache.load<Record<string, ManifestEntry>>(MANIFEST_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || {},
  newFileCount: 0,

  setCategories: (categories) => { set({ categories }); Cache.save(CAT_CACHE_KEY, categories); get().syncCategoriesToBackend() },
  addCategory: (name) => {
    set(s => {
      if (s.categories.includes(name)) return s
      const c = [...s.categories, name]
      const exp = s.expandedCategories.includes(name) ? s.expandedCategories : [...s.expandedCategories, name]
      Cache.save(CAT_CACHE_KEY, c)
      Cache.save(CAT_CACHE_KEY + '_exp', exp)
      return { categories: c, expandedCategories: exp }
    })
    get().syncCategoriesToBackend()
  },
  removeCategory: (name) => {
    set(s => {
      const c = s.categories.filter(x => x !== name)
      const mc: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(s.modelCategories)) {
        mc[k] = v.filter(x => x !== name)
      }
      Cache.save(CAT_CACHE_KEY, c)
      Cache.save(CAT_CACHE_KEY + '_mc', mc)
      return { categories: c, modelCategories: mc, filterCategory: s.filterCategory === name ? null : s.filterCategory }
    })
    get().syncCategoriesToBackend()
  },
  renameCategory: (oldName, newName) => {
    set(s => {
      if (s.categories.includes(newName)) return s
      const c = s.categories.map(x => x === oldName ? newName : x)
      const mc: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(s.modelCategories)) {
        mc[k] = v.map(x => x === oldName ? newName : x)
      }
      const exp = s.expandedCategories.map(x => x === oldName ? newName : x)
      const fc = s.filterCategory === oldName ? newName : s.filterCategory
      Cache.save(CAT_CACHE_KEY, c)
      Cache.save(CAT_CACHE_KEY + '_mc', mc)
      Cache.save(CAT_CACHE_KEY + '_exp', exp)
      return { categories: c, modelCategories: mc, expandedCategories: exp, filterCategory: fc }
    })
    get().syncCategoriesToBackend()
  },
  setModelCategories: (fileName, cats) => {
    set(s => {
      const mc = { ...s.modelCategories, [stripExt(fileName)]: cats }
      Cache.save(CAT_CACHE_KEY + '_mc', mc)
      return { modelCategories: mc }
    })
    get().syncCategoriesToBackend()
  },
  setBatchModelCategories: (fileNames, cat) => {
    set(s => {
      const mc = { ...s.modelCategories }
      for (const fn of fileNames) {
        const key = stripExt(fn)
        const existing = mc[key] || []
        if (!existing.includes(cat)) mc[key] = [...existing, cat]
      }
      Cache.save(CAT_CACHE_KEY + '_mc', mc)
      return { modelCategories: mc }
    })
    get().syncCategoriesToBackend()
  },
  categorizeBySubfolders: () => {
    const grouped = groupLoraNamesByTopLevelFolder(get().files.map(file => file.name))
    const folders = [...grouped.keys()]
    if (!folders.length) {
      showToast('未发现子目录 LoRA，请先扫描包含子目录的文件夹')
      return { folders: [], createdCategories: 0, assignedFiles: 0 }
    }

    let createdCategories = 0
    let assignedFiles = 0
    set(state => {
      const categories = [...state.categories]
      const expandedCategories = [...state.expandedCategories]
      const modelCategories = { ...state.modelCategories }
      for (const [folder, names] of grouped) {
        if (!categories.includes(folder)) {
          categories.push(folder)
          if (!expandedCategories.includes(folder)) expandedCategories.push(folder)
          createdCategories++
        }
        for (const name of names) {
          const key = stripExt(name)
          const existing = modelCategories[key] || []
          if (!existing.includes(folder)) {
            modelCategories[key] = [...existing, folder]
            assignedFiles++
          }
        }
      }
      Cache.save(CAT_CACHE_KEY, categories)
      Cache.save(CAT_CACHE_KEY + '_mc', modelCategories)
      Cache.save(CAT_CACHE_KEY + '_exp', expandedCategories)
      return { categories, modelCategories, expandedCategories }
    })
    get().syncCategoriesToBackend()
    showToast(`✅ 已按 ${folders.length} 个子目录创建/更新分类，归类 ${assignedFiles} 个 LoRA`)
    return { folders, createdCategories, assignedFiles }
  },
  clearModelCategories: (fileName) => {
    set(s => {
      const mc = { ...s.modelCategories }
      mc[stripExt(fileName)] = []
      Cache.save(CAT_CACHE_KEY + '_mc', mc)
      return { modelCategories: mc }
    })
    get().syncCategoriesToBackend()
  },
  setFilterCategory: (filterCategory) => set({ filterCategory }),
  setFilterBaseModel: (filterBaseModel) => {
    set({ filterBaseModel })
    Cache.save(BASE_MODEL_CACHE_KEY, { filter: filterBaseModel, open: get().baseModelPanelOpen })
  },
  toggleBaseModelPanel: () => set(s => {
    const baseModelPanelOpen = !s.baseModelPanelOpen
    Cache.save(BASE_MODEL_CACHE_KEY, { filter: s.filterBaseModel, open: baseModelPanelOpen })
    return { baseModelPanelOpen }
  }),
  setBatchMode: (batchMode) => set({ batchMode, batchSelection: [] }),
  toggleBatchSelection: (name) => set(s => {
    const sel = s.batchSelection.includes(name)
      ? s.batchSelection.filter(x => x !== name)
      : [...s.batchSelection, name]
    return { batchSelection: sel }
  }),
  clearBatchSelection: () => set({ batchSelection: [] }),
  setPromptWeights: (promptWeights) => set({ promptWeights }),
  setDescription: (fileName, text) => set(s => {
    const desc = { ...s.descriptions, [fileName]: text }
    Cache.save(CAT_CACHE_KEY + '_desc', desc)
    return { descriptions: desc }
  }),
  toggleCategoryExpanded: (cat) => set(s => {
    const exp = s.expandedCategories.includes(cat)
      ? s.expandedCategories.filter(x => x !== cat)
      : [...s.expandedCategories, cat]
    Cache.save(CAT_CACHE_KEY + '_exp', exp)
    return { expandedCategories: exp }
  }),

  matchByUrl: async (name, url) => {
    const idStr = parseCivitaiModelId(url)
    if (!idStr) { showToast('URL 格式错误，需要 Civitai 模型链接（civitai.com / civitai.red 均可）'); return }
    const id = parseInt(idStr)
    await localScanSession.run({ kind: 'match', names: [name], resolve: async (_file, signal) => {
      const data = await fetchModelById(id, signal)
      if (!data) throw new Error('无法获取模型数据')
      const v = data.modelVersions?.[0]
      if (!v) throw new Error('该模型没有版本')
      const imgs = (v.images || [])
        .filter((i: { type: string }) => i.type === 'image')
        .map((i: { url: string }) => { let u = i.url.trim(); if (u.startsWith('//')) u = 'https:' + u; return u.startsWith('http') ? u : '' })
        .filter(Boolean)
      return {
        modelId: data.id,
        modelName: data.name,
        versionId: v.id,
        versionName: v.name,
        trainedWords: v.trainedWords || [],
        images: imgs,
        creator: data.creator?.username || '',
        description: data.description || '',
        downloadCount: data.stats?.downloadCount ?? 0,
        thumbsUpCount: data.stats?.thumbsUpCount ?? 0,
        baseModel: v.baseModel || '',
        tags: data.tags || [],
        nsfw: !!data.nsfw,
      }
    } })
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSortKey: (sortKey) => set({ sortKey }),
  setFilterKey: (filterKey) => set({ filterKey }),
  selectModel: (selectedModel) => set({ selectedModel, currentView: selectedModel ? 'detail' : 'home' }),
  setCurrentView: (currentView) => set({ currentView }),
  setDisplayMode: (displayMode) => {
    set({ displayMode })
    Cache.save(DISPLAY_MODE_CACHE_KEY, displayMode)
  },
  setPreviewImage: (fileName, image) => set(s => ({ previewImages: { ...s.previewImages, [fileName]: image } })),
  clearPreviewImage: (fileName) => set(s => {
    const previewImages = { ...s.previewImages }
    delete previewImages[fileName]
    return { previewImages }
  }),

  setScanPath: (p) => set({ scanPath: p }),
  setFiles: (files) => set({ files }),
  updateFile: (name, upd) => set(s => ({
    files: s.files.map(f => f.name === name ? { ...f, ...upd } : f)
  })),
  setScanStatus: (scanStatus) => set({ scanStatus }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
  cancelScan: () => localScanSession.cancel(),
  setPngs: (pngs) => set({ pngs }),
  addPng: (png) => set(s => ({ pngs: [...s.pngs.filter(p => p.fileName !== png.fileName), png] })),
  setTagFreq: (tagFreq) => set({ tagFreq }),
  setScanningDir: (scanningDir) => set({ scanningDir }),

  rebuildTagFreq: () => {
    const { files, pngs } = get()
    const map = new Map<string, number>()
    for (const f of files) {
      if (f.matchData) {
        for (const tw of f.matchData.trainedWords) {
          const t = tw.toLowerCase().trim()
          if (t) map.set(t, (map.get(t) || 0) + 1)
        }
      }
    }
    for (const p of pngs) {
      const all = [p.positive, p.negative].join(',').toLowerCase()
      const tags = all.split(/[,，、\s]+/).filter(Boolean)
      const seen = new Set<string>()
      for (const t of tags) {
        const clean = t.trim()
        if (clean && !seen.has(clean)) {
          seen.add(clean)
          map.set(clean, (map.get(clean) || 0) + 1)
        }
      }
    }
    const sorted = [...map.entries()]
      .map(([tag, count]): TagFreq => ({ tag, count, source: 'trained' }))
      .sort((a, b) => b.count - a.count)
    set({ tagFreq: sorted.slice(0, 500) })
    Cache.save(TAG_CACHE_KEY, sorted.slice(0, 500))
  },

  scanDir: () => localScanSession.run({ kind: 'scan', list: listConfiguredDirectory }),

  /** 只用已有目录授权，失效时静默回退后端，不弹浏览器权限框。 */
  scanIncremental: () => localScanSession.run({
    kind: 'scan',
    list: async signal => {
      const directory = get().dirHandle
      if (directory) {
        const permission = await (directory as any).queryPermission?.({ mode: 'readwrite' })
        if (signal.aborted) throw new DOMException('扫描已取消', 'AbortError')
        if (permission === 'granted') {
          return { entries: await collectLoraFiles(directory, signal), directory: directory.name || '本地目录' }
        }
      }
      return listConfiguredDirectory(signal)
    },
  }),

  matchAll: () => localScanSession.run({ kind: 'match' }),
  matchOne: name => localScanSession.run({ kind: 'match', names: [name] }),

  deleteFile: async (name) => {
    const f = get().files.find(x => x.name === name)
    if (!f) return
    const dh = get().dirHandle
    if (!dh) {
      // 后端静默扫描没有句柄：走后端删除（dir 空 = 按 ComfyUI loras 根解析）
      try {
        const resp = await fetch('/anima/panel_scan/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: getLastScanDir(), name }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      } catch {
        showToast('删除失败，权限不足或文件已被移动')
        return
      }
    } else {
      try {
        await removeLoraFile(dh, name)
      } catch {
        showToast('删除失败，权限不足或文件已被移动')
        return
      }
    }
    set(s => ({ files: s.files.filter(x => x.name !== name) }))
    get().clearPreviewImage(name)
    void deleteLocalLoraPreview(name)
    // 同步清理 manifest
    const m = { ...get().manifest }
    delete m[name]
    set({ manifest: m })
    get().saveToCache()
    get().rebuildTagFreq()
    showToast(`已删除 ${name}`)
  },

  saveDirHandle: async () => {
    const dh = get().dirHandle
    if (dh) {
      const { setHandle } = await import('./handleManager')
      setHandle('localDir', dh)
    }
  },

  loadDirHandle: async () => {
    try {
      const { getHandle } = await import('./handleManager')
      const dh = getHandle('localDir')
      if (!dh) return false
      // queryPermission 不弹浏览器权限框：权限失效时返回 false，由调用方回退后端静默扫描
      const ok = await (dh as any).queryPermission?.({ mode: 'readwrite' })
      if (ok !== 'granted') return false
      set({ dirHandle: dh })
      return true
    } catch { return false }
  },

  saveToCache: () => {
    const { files, pngs, tagFreq, categories, modelCategories, expandedCategories, descriptions, manifest } = get()
    Cache.save(SCAN_CACHE_KEY, files)
    Cache.save(PNG_CACHE_KEY, pngs)
    Cache.save(TAG_CACHE_KEY, tagFreq)
    Cache.save(CAT_CACHE_KEY, categories)
    Cache.save(CAT_CACHE_KEY + '_mc', modelCategories)
    Cache.save(CAT_CACHE_KEY + '_exp', expandedCategories)
    Cache.save(CAT_CACHE_KEY + '_desc', descriptions)
    Cache.save(MANIFEST_CACHE_KEY, manifest)
  },

  loadFromCache: () => {
    const YEAR = 365 * 24 * 60 * 60 * 1000
    const cached = Cache.load<LocalLoraFile[]>(SCAN_CACHE_KEY, YEAR)
    if (cached && cached.length > 0) {
      set({ files: cached, dirHandle: null })
      const pngs = Cache.load<PngMeta[]>(PNG_CACHE_KEY, YEAR) || []
      const tagFreq = Cache.load<TagFreq[]>(TAG_CACHE_KEY, YEAR) || []
      const categories = Cache.load<string[]>(CAT_CACHE_KEY, YEAR) || ['人物', '风格', '背景', '姿势']
      const modelCategories = Cache.load<Record<string, string[]>>(CAT_CACHE_KEY + '_mc', YEAR) || {}
      const expandedCategories = (() => {
        const exp = Cache.load<string[]>(CAT_CACHE_KEY + '_exp', YEAR) || categories
        // 未分类组默认展开，避免未分类的 LoRA 因折叠而看不到
        return exp.includes('__uncategorized__') ? exp : ['__uncategorized__', ...exp]
      })()
      const descriptions = Cache.load<Record<string, string>>(CAT_CACHE_KEY + '_desc', YEAR) || {}
      const manifest = Cache.load<Record<string, ManifestEntry>>(MANIFEST_CACHE_KEY, YEAR) || {}
      set({ pngs, tagFreq, categories, modelCategories, expandedCategories, descriptions, manifest, scanStatus: 'done' })
      return true
    }
    return false
  },

  detectNewFiles: async () => {
    const dh = get().dirHandle
    if (!dh) return 0
    try {
      // 零弹窗：权限失效返回 0，自动链路交给 scanIncremental 的后端回退
      const perm = await (dh as any).queryPermission?.({ mode: 'readwrite' })
      if (perm !== 'granted') return 0
      const oldManifest = get().manifest || {}
      const entries = await collectLoraFiles(dh)
      let count = 0
      for (const entry of entries) {
        const name = normalizeRelativeLoraPath(entry.name)
        const cached = oldManifest[name]
        if (!cached) { count++; continue }
        const file = entry.file
        if (file.size !== cached.size || file.lastModified !== cached.lastModified) count++
      }
      set({ newFileCount: count })
      return count
    } catch { return 0 }
  },

  setNewFileCount: (newFileCount) => set({ newFileCount }),

  // ---- 与节点 /anima/meta 双向分类同步 ----
  fetchBackendMeta: async () => {
    try {
      const resp = await fetch('/anima/meta')
      if (!resp.ok) return null
      return await resp.json()
    } catch { return null }
  },
  // 从后端拉取分类合并到本地(节点侧改的分类同步回面板);60s 节流避免每次切换栏目都请求+重渲染
  // 返回是否真的发生了变化（无变化时调用方不应重渲染 —— 切页路径的全量重建是大头开销）
  loadBackendMeta: async (force = false): Promise<boolean> => {
    if (_backendMetaLoad) return _backendMetaLoad
    const now = Date.now()
    if (!force && now - _lastBackendSync < 60000) return false
    const request = (async (): Promise<boolean> => {
      const backend = await get().fetchBackendMeta()
      // 只有成功拿到快照才更新时间戳；网络/服务端异常允许下一次激活立即重试。
      if (!backend) return false
      _lastBackendSync = Date.now()
      const cats: string[] = Array.isArray(backend.categories) ? backend.categories.map(String) : []
      const lm: Record<string, { categories?: string[] }> = backend.loraMeta || {}
      // 先比较后写入：快照与本地一致时不动 store、不触发任何重渲染
      const cur = get()
      const curCats = cur.categories
      const normCurMc: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(cur.modelCategories)) normCurMc[stripExt(k)] = v
      const backendCats = (() => {
        const hasBackendMeta = cats.length > 0 || Object.keys(lm).length > 0
        return hasBackendMeta ? [...new Set(cats.filter(Boolean))] : curCats
      })()
      const backendMc: Record<string, string[]> = { ...normCurMc }
      const lmBase: Record<string, { categories?: string[] }> = {}
      for (const [name, entry] of Object.entries(lm)) {
        const base = stripExt(name)
        if (!(base in lmBase) || name === base) lmBase[base] = entry
      }
      for (const [base, entry] of Object.entries(lmBase)) {
        // 空数组也是有意义的状态：它表示节点侧已清空该 LoRA 的分类。
        if (entry && Array.isArray(entry.categories)) {
          backendMc[base] = [...new Set(entry.categories.map(String).filter(Boolean))]
        }
      }
      const catsEqual = backendCats.length === curCats.length && backendCats.every((c, i) => c === curCats[i])
      const mcKeys = Object.keys(backendMc)
      const mcEqual = mcKeys.length === Object.keys(normCurMc).length &&
        mcKeys.every(k => { const a = backendMc[k]; const b = normCurMc[k]; if (!b) return false; return a.length === b.length && a.every((x, i) => x === b[i]) })
      if (catsEqual && mcEqual) return false
      Cache.save(CAT_CACHE_KEY, backendCats)
      Cache.save(CAT_CACHE_KEY + '_mc', backendMc)
      set({ categories: backendCats, modelCategories: backendMc })
      return true
    })()
    _backendMetaLoad = request
    try {
      return await request
    } finally {
      if (_backendMetaLoad === request) _backendMetaLoad = null
    }
  },
  // 推送本地分类到后端(合并式,只带分类相关字段;不携带 loraGroups,避免清空节点组)
  syncCategoriesToBackend: () => {
    _categorySyncQueue = _categorySyncQueue
      .catch(() => undefined)
      .then(async () => {
        const s = get()
        const loraMeta: Record<string, { categories: string[] }> = {}
        for (const [name, cats] of Object.entries(s.modelCategories)) {
          loraMeta[name] = { categories: cats || [] }
        }
        const response = await fetch('/anima/meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ categories: s.categories, loraMeta }),
        })
        if (!response.ok) throw new Error(`分类同步失败（HTTP ${response.status}）`)
      })
      .catch(error => {
        // 后端不可用时保持离线编辑；下一次操作会继续尝试，不吞掉队列链。
        console.warn('[LocalManager] 分类同步失败:', error)
      })
    return _categorySyncQueue
  },
}))

/** 返回所有本地 LoRA 文件的 basename（不含扩展名）+ 已匹配的 Civitai 模型名，用于在线卡片匹配 */
export function getLocalFileNames(): string[] {
  const state = useLocalModelStore.getState()
  const raw = state.files.map(f => f.name.replace(/\.\w+$/, '').toLowerCase())
  const matched = state.files.filter(f => f.matchData?.modelName).map(f => f.matchData!.modelName.toLowerCase().replace(/[\s_-]/g, ''))
  return [...new Set([...raw, ...matched])]
}

localScanSession.subscribe(progress => {
  useLocalModelStore.setState({
    scanStatus: progress.status,
    scanProgress: { done: progress.done, total: progress.total },
    scanningDir: progress.directory,
  })
  if (progress.notice) showToast(progress.notice)
})
