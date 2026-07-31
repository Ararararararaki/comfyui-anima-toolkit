import { create } from 'zustand'
import type { LocalLoraFile, LocalLoraMatch, PngMeta, TagFreq, LocalScanStatus } from '../types'
import { Cache } from './cache'
import { fetchModelVersionByHash, fetchModelById } from '../api/civitai'
import { showToast } from '../utils'

function progressShow(done: number, total: number, label: string) {
  const wrap = document.getElementById('localProgress')
  const bar = document.getElementById('localProgressBar')
  const text = document.getElementById('localProgressText')
  if (!wrap || !bar || !text) return
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  bar.style.width = `${pct}%`
  text.textContent = `${label} ${done}/${total} (${pct}%)`
  wrap.style.display = 'flex'
}

function progressHide() {
  const wrap = document.getElementById('localProgress')
  const bar = document.getElementById('localProgressBar')
  if (!wrap || !bar) return
  wrap.style.display = 'none'
  bar.style.width = '0%'
}

export type LocalSortKey = 'name' | 'size' | 'date' | 'match'
export type LocalFilterKey = 'all' | 'matched' | 'unmatched'
export type LocalViewKey = 'home' | 'detail' | 'gallery' | 'prompt'

const SCAN_CACHE_KEY = 'local_loras_v2'
const PNG_CACHE_KEY = 'local_pngs_v1'
const TAG_CACHE_KEY = 'local_tag_freq_v1'
const CAT_CACHE_KEY = 'local_categories_v1'
const MANIFEST_CACHE_KEY = 'local_manifest_v1'

type ManifestEntry = { name: string; size: number; lastModified: number; sha256: string }

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

  dirHandle: FileSystemDirectoryHandle | null

  categories: string[]
  modelCategories: Record<string, string[]>
  filterCategory: string | null
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
  clearModelCategories: (fileName: string) => void
  setFilterCategory: (cat: string | null) => void
  setBatchMode: (b: boolean) => void
  toggleBatchSelection: (name: string) => void
  clearBatchSelection: () => void
  setPromptWeights: (w: Record<string, number>) => void
  setDescription: (fileName: string, text: string) => void
  toggleCategoryExpanded: (cat: string) => void

  matchByUrl: (name: string, url: string) => Promise<void>

  setSearchQuery: (q: string) => void
  setSortKey: (k: LocalSortKey) => void
  setFilterKey: (k: LocalFilterKey) => void
  selectModel: (name: string | null) => void
  setCurrentView: (v: LocalViewKey) => void

  setScanPath: (p: string) => void
  setFiles: (files: LocalLoraFile[]) => void
  updateFile: (name: string, upd: Partial<LocalLoraFile>) => void
  setScanStatus: (s: LocalScanStatus) => void
  setScanProgress: (p: { done: number; total: number }) => void
  setPngs: (pngs: PngMeta[]) => void
  addPng: (png: PngMeta) => void
  setTagFreq: (f: TagFreq[]) => void
  rebuildTagFreq: () => void
  setScanningDir: (d: string) => void

  scanDir: () => Promise<void>
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

export const useLocalModelStore = create<LocalModelState>((set, get) => ({
  files: [],
  scanPath: '',
  scanStatus: 'idle',
  scanProgress: { done: 0, total: 0 },
  pngs: Cache.load<PngMeta[]>(PNG_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || [],
  tagFreq: [],
  scanningDir: '',

  searchQuery: '',
  sortKey: 'name',
  filterKey: 'all',
  selectedModel: null,
  currentView: 'home',

  dirHandle: null,

  categories: Cache.load<string[]>(CAT_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || ['人物', '风格', '背景', '姿势'],
  modelCategories: Cache.load<Record<string, string[]>>(CAT_CACHE_KEY + '_mc', 365 * 24 * 60 * 60 * 1000) || {},
  filterCategory: null,
  batchMode: false,
  batchSelection: [],
  promptWeights: {},
  descriptions: Cache.load<Record<string, string>>(CAT_CACHE_KEY + '_desc', 365 * 24 * 60 * 60 * 1000) || {},
  expandedCategories: Cache.load<string[]>(CAT_CACHE_KEY + '_exp', 365 * 24 * 60 * 60 * 1000) || ['__uncategorized__', '人物', '风格', '背景', '姿势'],
  manifest: Cache.load<Record<string, ManifestEntry>>(MANIFEST_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || {},
  newFileCount: 0,

  setCategories: (categories) => { set({ categories }); Cache.save(CAT_CACHE_KEY, categories) },
  addCategory: (name) => set(s => {
    if (s.categories.includes(name)) return s
    const c = [...s.categories, name]
    const exp = s.expandedCategories.includes(name) ? s.expandedCategories : [...s.expandedCategories, name]
    Cache.save(CAT_CACHE_KEY, c)
    Cache.save(CAT_CACHE_KEY + '_exp', exp)
    return { categories: c, expandedCategories: exp }
  }),
  removeCategory: (name) => set(s => {
    const c = s.categories.filter(x => x !== name)
    const mc: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(s.modelCategories)) {
      mc[k] = v.filter(x => x !== name)
    }
    Cache.save(CAT_CACHE_KEY, c)
    Cache.save(CAT_CACHE_KEY + '_mc', mc)
    return { categories: c, modelCategories: mc, filterCategory: s.filterCategory === name ? null : s.filterCategory }
  }),
  renameCategory: (oldName, newName) => set(s => {
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
  }),
  setModelCategories: (fileName, cats) => set(s => {
    const mc = { ...s.modelCategories, [fileName]: cats }
    Cache.save(CAT_CACHE_KEY + '_mc', mc)
    return { modelCategories: mc }
  }),
  setBatchModelCategories: (fileNames, cat) => set(s => {
    const mc = { ...s.modelCategories }
    for (const fn of fileNames) {
      const existing = mc[fn] || []
      if (!existing.includes(cat)) mc[fn] = [...existing, cat]
    }
    Cache.save(CAT_CACHE_KEY + '_mc', mc)
    return { modelCategories: mc }
  }),
  clearModelCategories: (fileName) => set(s => {
    const mc = { ...s.modelCategories }
    delete mc[fileName]
    Cache.save(CAT_CACHE_KEY + '_mc', mc)
    return { modelCategories: mc }
  }),
  setFilterCategory: (filterCategory) => set({ filterCategory }),
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
    const m = url.match(/civitai\.com\/models\/(\d+)/)
    if (!m) { showToast('URL 格式错误，需要 Civitai 模型链接'); return }
    const id = parseInt(m[1])
    const data = await fetchModelById(id)
    if (!data) { showToast('无法获取模型数据'); return }
    const v = data.modelVersions?.[0]
    if (!v) { showToast('该模型没有版本'); return }
    const imgs = (v.images || [])
      .filter((i: { type: string }) => i.type === 'image')
      .map((i: { url: string }) => { let u = i.url.trim(); if (u.startsWith('//')) u = 'https:' + u; return u.startsWith('http') ? u : '' })
      .filter(Boolean)
    get().updateFile(name, {
      matched: true, matchError: '', scanning: false,
      matchData: {
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
      },
    })
    get().saveToCache()
    get().rebuildTagFreq()
    showToast(`✅ 已匹配: ${data.name}`)
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSortKey: (sortKey) => set({ sortKey }),
  setFilterKey: (filterKey) => set({ filterKey }),
  selectModel: (selectedModel) => set({ selectedModel, currentView: selectedModel ? 'detail' : 'home' }),
  setCurrentView: (currentView) => set({ currentView }),

  setScanPath: (p) => set({ scanPath: p }),
  setFiles: (files) => set({ files }),
  updateFile: (name, upd) => set(s => ({
    files: s.files.map(f => f.name === name ? { ...f, ...upd } : f)
  })),
  setScanStatus: (scanStatus) => set({ scanStatus }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
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

  scanDir: async () => {
    try {
      if (!('showDirectoryPicker' in window)) {
        showToast('⚠️ 当前浏览器不支持目录访问。请使用 Chrome/Edge。')
        return
      }
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
      set({ dirHandle, scanStatus: 'scanning', scanProgress: { done: 0, total: 0 } })
      get().saveDirHandle()
      const dirName = dirHandle.name
      const entries: { name: string; handle: FileSystemFileHandle }[] = []
      const iter = dirHandle.entries()
      for (;;) {
        const next = await iter.next()
        if (next.done) break
        const [name, handle] = next.value as [string, FileSystemFileHandle]
        if ((handle as any).kind === 'file' && /\.(safetensors|pt|ckpt|pth)$/i.test(name)) {
          entries.push({ name, handle })
        }
      }
      if (entries.length === 0) {
        progressHide()
        set({ scanStatus: 'done', files: [], newFileCount: 0 })
        return
      }

      // --- 增量扫描逻辑 ---
      const oldManifest = Cache.load<Record<string, ManifestEntry>>(MANIFEST_CACHE_KEY, 365 * 24 * 60 * 60 * 1000) || {}
      const oldFiles = get().files
      const oldFileMap = new Map(oldFiles.map(f => [f.name, f]))
      const oldMatchedCache = new Map(oldFiles.filter(f => f.matched).map(f => [f.name, f.matchData]))

      const newManifest: Record<string, ManifestEntry> = {}
      const results: LocalLoraFile[] = []
      let unchanged = 0, changed = 0, added = 0, total = entries.length

      progressShow(0, total, '扫描')
      set({ scanProgress: { done: 0, total }, scanningDir: dirName })

      for (let i = 0; i < entries.length; i++) {
        const { name, handle } = entries[i]
        const file = await handle.getFile()
        const key = `${name}|${file.size}|${file.lastModified}`

        const cached = oldManifest[name]
        if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
          // 未变更: 保留上次的 sha256 和匹配状态
          unchanged++
          const prev = oldFileMap.get(name)
          results.push({
            name, path: name, size: file.size, lastModified: file.lastModified,
            sha256: cached.sha256,
            matched: prev?.matched || false,
            matchData: prev?.matchData || null,
            matchError: prev?.matchError || '',
            scanning: false,
          })
          newManifest[name] = cached
        } else {
          // 新文件或变更文件: 算 SHA-256
          const buf = await file.arrayBuffer()
          const hashBuf = await crypto.subtle.digest('SHA-256', buf)
          const hashArr = Array.from(new Uint8Array(hashBuf))
          const sha256 = hashArr.map(b => b.toString(16).padStart(2, '0')).join('')
          results.push({
            name, path: name, size: file.size, lastModified: file.lastModified,
            sha256, matched: false, matchData: null, matchError: '', scanning: false,
          })
          newManifest[name] = { name, size: file.size, lastModified: file.lastModified, sha256 }
          if (cached) changed++; else added++
        }
        progressShow(i + 1, total, `扫描  (新${added} 变${changed} 同${unchanged})`)
        set({ scanProgress: { done: i + 1, total } })
      }

      // 清理 manifest 中已删除的文件
      const currentNames = new Set(entries.map(e => e.name))
      for (const k of Object.keys(oldManifest)) {
        if (!currentNames.has(k)) delete oldManifest[k]
      }

      progressHide()
      Cache.save(MANIFEST_CACHE_KEY, newManifest)
      set({ files: results, manifest: newManifest, scanStatus: 'done', newFileCount: 0 })
      get().saveToCache()
      if (added + changed > 0) {
        showToast(`📁 扫描完成: 新增 ${added}，变更 ${changed}，跳过 ${unchanged}`)
        // 自动匹配新文件
        get().matchAll()
      }
    } catch (err) {
      progressHide()
      if ((err as Error).name === 'AbortError' || (err as Error).message?.includes('abort')) {
        set({ scanStatus: 'idle' })
      } else {
        set({ scanStatus: 'error' })
      }
    }
  },

  matchAll: async () => {
    const { files } = get()
    const unmatched = files.filter(f => !f.matched)
    if (unmatched.length === 0) {
      showToast('✅ 所有文件已匹配')
      return
    }
    set({ scanStatus: 'matching', scanProgress: { done: 0, total: unmatched.length } })
    progressShow(0, unmatched.length, '匹配')

    const CONCURRENCY = 3
    let done = 0
    let nextIdx = 0
    const errors: string[] = []

    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (nextIdx < unmatched.length) {
        const idx = nextIdx++
        const f = unmatched[idx]
        get().updateFile(f.name, { scanning: true })
        try {
          const data = await fetchModelVersionByHash(f.sha256)
          if (data) {
            get().updateFile(f.name, {
              matched: true, matchData: data, scanning: false, matchError: '',
            })
          } else {
            get().updateFile(f.name, { matched: false, scanning: false, matchError: 'C站未匹配到此文件' })
          }
        } catch {
          get().updateFile(f.name, { scanning: false, matchError: '匹配异常' })
          errors.push(f.name)
        }
        done++
        progressShow(done, unmatched.length, `匹配  (${done}/${unmatched.length})`)
        set({ scanProgress: { done, total: unmatched.length } })
      }
    }))

    progressHide()
    get().saveToCache()
    get().rebuildTagFreq()
    set({ scanStatus: 'done' })
    if (errors.length) showToast(`⚠️ ${errors.length} 个匹配异常`)
    else showToast(`✅ 匹配完成 (${done} 个)`)
  },

  matchOne: async (name) => {
    const f = get().files.find(x => x.name === name)
    if (!f) return
    get().updateFile(name, { scanning: true })
    const data = await fetchModelVersionByHash(f.sha256)
    if (data) {
      get().updateFile(name, { matched: true, matchData: data, scanning: false, matchError: '' })
    } else {
      get().updateFile(name, { matched: false, scanning: false, matchError: 'C站未匹配到此文件' })
    }
    get().saveToCache()
    get().rebuildTagFreq()
  },

  deleteFile: async (name) => {
    const f = get().files.find(x => x.name === name)
    if (!f) return
    const dh = get().dirHandle
    if (!dh) {
      showToast('请重新扫描文件夹后再删除')
      return
    }
    try {
      await dh.removeEntry(name)
      set(s => ({ files: s.files.filter(x => x.name !== name) }))
      // 同步清理 manifest
      const m = { ...get().manifest }
      delete m[name]
      set({ manifest: m })
      get().saveToCache()
      get().rebuildTagFreq()
      showToast(`已删除 ${name}`)
    } catch {
      showToast('删除失败，权限不足或文件已被移动')
    }
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
      const ok = await (dh as any).requestPermission({ mode: 'readwrite' })
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
      const perm = await (dh as any).requestPermission({ mode: 'readwrite' })
      if (perm !== 'granted') return 0
      const oldManifest = get().manifest || {}
      let count = 0
      const iter = (dh as any).entries()
      for (;;) {
        const next = await iter.next()
        if (next.done) break
        const [name, handle] = next.value as [string, FileSystemFileHandle]
        if ((handle as any).kind !== 'file') continue
        if (!/\.(safetensors|pt|ckpt|pth)$/i.test(name)) continue
        const cached = oldManifest[name]
        if (!cached) { count++; continue }
        const file = await handle.getFile()
        if (file.size !== cached.size || file.lastModified !== cached.lastModified) count++
      }
      set({ newFileCount: count })
      return count
    } catch { return 0 }
  },

  setNewFileCount: (newFileCount) => set({ newFileCount }),
}))

/** 返回所有本地 LoRA 文件的 basename（不含扩展名）+ 已匹配的 Civitai 模型名，用于在线卡片匹配 */
export function getLocalFileNames(): string[] {
  const state = useLocalModelStore.getState()
  const raw = state.files.map(f => f.name.replace(/\.\w+$/, '').toLowerCase())
  const matched = state.files.filter(f => f.matchData?.modelName).map(f => f.matchData!.modelName.toLowerCase().replace(/[\s_-]/g, ''))
  return [...new Set([...raw, ...matched])]
}
