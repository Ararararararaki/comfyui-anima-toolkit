import { create } from 'zustand'
import type { OutputFile, OutputMetadata, OutputViewMode, OutputSortKey, OutputFilterKey, OutputScanStatus } from '../types/outputs'
import { outputsDb } from '../db/outputsDb'
import { extractLorasFromWorkflow } from '../services/outputMetadata'
import { nativeStorageEnabled, nativeUpdateOutput } from '../services/nativeStorage'

const PAGE_SIZE = 50

// 快捷时间段工具
function getPeriodStart(period: string): number {
  const now = Date.now()
  const d = new Date()
  switch (period) {
    case 'today':
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    case '3d':
      return now - 3 * 24 * 60 * 60 * 1000
    case 'week':
      return now - 7 * 24 * 60 * 60 * 1000
    case 'month':
      d.setDate(1)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    default:
      return 0
  }
}

interface OutputState {
  // 目录
  dirHandle: FileSystemDirectoryHandle | null
  rootPath: string
  currentPath: string

  // 文件
  files: OutputFile[]
  filteredFiles: OutputFile[]
  selectedIds: Set<string>
  metadataCache: Map<string, OutputMetadata>
  /**
   * 元数据内容版本号（单调递增）：任何一次 metadataCache 写入都 +1。
   * ⚠️ 存在的意义（2026-09-11）：Outputs 的虚拟网格用「布局/内容签名」判重跳过重建，
   * 而签名里只有 `metadataCache.size`。元数据是**同 key 覆盖**（size 不变）——
   * 于是「按需加载到 LoRA 数据 » 签名不变 » 不重建 » 卡片按钮不出现」。
   * 用版本号代替 size，内容一变就必然重建（图片节点有 capture/restore，不会重新请求）。
   */
  metadataVersion: number

  // 视图
  viewMode: OutputViewMode
  sortKey: OutputSortKey
  sortOrder: 'asc' | 'desc'
  filterKey: OutputFilterKey
  searchQuery: string

  // 高级筛选
  filterModel: string
  filterLora: string
  filterDateMin: string
  filterDateMax: string
  filterQuickPeriod: string
  filterStatusFlags: string[]
  filterTag: string
  filterCategory: string

  // 分页
  page: number
  hasMore: boolean

  // UI 状态
  loading: boolean
  scanStatus: OutputScanStatus
  scanProgress: { done: number; total: number }

  // Actions
  setDirHandle: (handle: FileSystemDirectoryHandle | null) => void
  setFiles: (files: OutputFile[]) => void
  setViewMode: (mode: OutputViewMode) => void
  setSortKey: (key: OutputSortKey) => void
  setSortOrder: (order: 'asc' | 'desc') => void
  toggleSortOrder: () => void
  setFilterKey: (key: OutputFilterKey) => void
  setSearchQuery: (query: string) => void
  setCurrentPath: (path: string) => void
  setFilterModel: (model: string) => void
  setFilterLora: (lora: string) => void
  setFilterDateMin: (date: string) => void
  setFilterDateMax: (date: string) => void
  setFilterQuickPeriod: (period: string) => void
  setFilterStatusFlags: (flags: string[]) => void
  setFilterTag: (tag: string) => void
  setFilterCategory: (category: string) => void
  setCategory: (id: string, category: string) => Promise<void>
  batchSetCategory: (ids: string[], category: string) => Promise<number>
  deleteCategory: (category: string) => Promise<void>
  renameCategory: (oldName: string, newName: string) => Promise<void>
  clearAdvancedFilters: () => void

  toggleSelect: (id: string) => void
  selectAll: () => void
  clearSelection: () => void

  toggleFavorite: (id: string) => Promise<void>
  setRating: (id: string, rating: number) => Promise<void>
  setNotes: (id: string, notes: string) => Promise<void>
  setTags: (id: string, tags: string[]) => Promise<void>
  setStatus: (id: string, status: string) => Promise<void>
  togglePinned: (id: string) => Promise<void>
  batchPin: (ids: string[]) => Promise<void>
  batchUnpin: (ids: string[]) => Promise<void>

  /**
   * 按需读取**单张**图片的元数据（2026-09-10：不再有全库预载）。
   * opts.loras = true 时从同一条 DB 记录里顺带提取 LoRA（一次读盘覆盖卡片所有信息）。
   */
  loadMetadata: (id: string, opts?: { loras?: boolean }) => Promise<OutputMetadata | null>
  putMetadata: (meta: OutputMetadata) => void
  putMetadataBatch: (metas: OutputMetadata[]) => void
  removeMetadata: (ids: string[]) => void
  thumbMemory: Map<string, string>
  setThumbMemory: (path: string, dataUrl: string) => void
  invalidateThumbnails: (paths?: string[]) => void
  loadMore: () => void
  applyFilters: () => void
}

function matchSearch(file: OutputFile, query: string, metadata: OutputMetadata | null): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    file.filename.toLowerCase().includes(q) ||
    file.path.toLowerCase().includes(q) ||
    (metadata?.model || '').toLowerCase().includes(q) ||
    (metadata?.prompt || '').toLowerCase().includes(q)
  )
}

// ── 内存瘦身：缓存版元数据剥离 workflowJson（单条几十~几百 KB，几百张图即数百 MB 内存 → GC 长暂停卡顿）
// 提取 loras 供渲染/筛选直接使用；需要完整 workflow 的路径（下载 .json/复制标签/元数据面板）从 DB 懒读。
function slimMeta(meta: OutputMetadata): OutputMetadata {
  const copy: OutputMetadata = { ...meta }
  if (meta.workflowJson) {
    // ⚠️ 这里刻意**不做** LoRA 提取（2026-09-10 修；首开卡顿的真正根因）：
    // extractLorasFromWorkflow → safeParseJSON 会对**每条记录** JSON.parse 一个
    // 几百 KB 的工作流 JSON，再跑 <lora:...> 正则。3918 条就是数秒到十几秒的纯解析，
    // 而且发生在 putMetadataBatch 里（每条路径都要过 slimMeta），全部砸在首屏。
    // 火焰图实测：单帧自耗时 149ms 集中在解析函数上、并伴随 RegExp 帧。
    // 现在只做它注释里原本的职责——内存瘦身（剥掉 workflowJson）；
    // loras 交给空闲分片按需提取，见 Outputs.ts 的 scheduleIdleLoraExtraction()。
    copy.hasWorkflow = true
    // 剥离前留一个轻量指纹：后续写入（扫描/重解析/全库补齐）据此判断工作流是否真的变了，
    // 未变就沿用已提取的 loras，避免把刚提取好的结果清空导致「复制 LoRA 标签」按钮消失
    copy.workflowFingerprint = wfFingerprint(meta.workflowJson)
    copy.workflowJson = ''
    if (!Array.isArray(copy.loras)) copy.loras = []
  }
  // rawMetadata（原始 PNG chunk 全量，平均 80KB+/张）与 negativePrompt 只在解析/提取/展示时用：
  // 内存版剥离（完整数据从 DB 懒读），渲染/筛选/搜索不需要
  copy.rawMetadata = {}
  copy.negativePrompt = ''
  return copy
}

/** 工作流内容指纹（长度 + 首尾片段即可，避免在内存里保留整串工作流） */
function wfFingerprint(workflowJson: string): string {
  return `${workflowJson.length}:${workflowJson.slice(0, 64)}:${workflowJson.slice(-64)}`
}

/** 诊断开关：URL 带 ?metaDbg=1 时打印 LoRA 提取链路（生产无副作用，便于线上复现排查） */
const META_DBG = (() => { try { return new URLSearchParams(location.search).has('metaDbg') } catch { return false } })()

/**
 * 元数据 DB 读超时（2026-09-11）：实测在「扫描刚结束」的时序下，Dexie 的
 * `metadata.get()` 会长时间不返回（IndexedDB 层本身健康：原生直读同一时刻可正常
 * 返回全部记录；浏览器端探针实测悬挂 >9s 且无任何错误回调）。
 * UI 不能依赖「DB 读必定返回」——超时即抛错，由可见区队列安排退避重试，
 * 否则这些卡片会拿不到 meta.loras，「复制 LoRA 标签」按钮永久不出现。
 */
export const DB_READ_TIMEOUT_MS = 3000
export class MetadataReadTimeoutError extends Error {
  constructor(id: string) {
    super(`metadata read timeout: ${id}`)
    this.name = 'MetadataReadTimeoutError'
  }
}

/**
 * 写入元数据时是否可沿用缓存里已提取的 LoRA 结果。
 * 条件：先前确实提取过 + 两次都带工作流 + 工作流指纹一致（说明内容没变）。
 */
function canReuseLoras(prev: OutputMetadata | undefined, next: OutputMetadata): boolean {
  return !!prev?.lorasExtracted && !!prev.workflowFingerprint && prev.workflowFingerprint === next.workflowFingerprint
}

/**
 * 按需元数据读取的并发去重表：id → 正在进行的 DB 读。
 * （可见区一次会出现十几张卡同时要元数据，连点「复制 Prompt」也会撞上同一条）
 */
const _metaInflight = new Map<string, Promise<OutputMetadata | null>>()
// ⚠️ 「LoRA 是否已提取」的唯一真源 = 缓存条目上的 `lorasExtracted` 标记（不再用独立 Set）。
// 原因（2026-09-11）：独立 Set 与缓存条目会失配 —— 全库补齐覆盖条目（putMetadataBatch）时
// 条目被换成未提取的瘦身版，而 Set 里的记录未必同步，导致「该补提取却被判为已提取」或反之，
// 表现为 Outputs 卡片的「复制 LoRA 标签」按钮消失后无法恢复。

export const useOutputStore = create<OutputState>((set, get) => ({
  dirHandle: null,
  rootPath: '',
  currentPath: '',

  files: [],
  filteredFiles: [],
  selectedIds: new Set(),
  metadataCache: new Map(),
  metadataVersion: 0,
  thumbMemory: new Map(),

  viewMode: 'grid',
  sortKey: 'date',
  sortOrder: 'desc',
  filterKey: 'all',
  searchQuery: '',

  filterModel: '',
  filterLora: '',
  filterDateMin: '',
  filterDateMax: '',
  filterQuickPeriod: '',
  filterStatusFlags: [],
  filterTag: '',
  filterCategory: '',

  page: 1,
  hasMore: false,

  loading: false,
  scanStatus: 'idle',
  scanProgress: { done: 0, total: 0 },

  setDirHandle: (dirHandle) => set({ dirHandle }),
  setFiles: (files) => {
    set({ files })
    get().applyFilters()
  },
  setViewMode: (viewMode) => { set({ viewMode }); persistFilterState(get()); get().applyFilters() },
  setSortKey: (sortKey) => {
    set({ sortKey, page: 1 })
    persistFilterState(get())
    get().applyFilters()
  },
  setSortOrder: (sortOrder) => {
    localStorage.setItem('outputs_sortOrder', sortOrder)
    set({ sortOrder, page: 1 })
    get().applyFilters()
  },
  toggleSortOrder: () => {
    const next = get().sortOrder === 'asc' ? 'desc' : 'asc'
    localStorage.setItem('outputs_sortOrder', next)
    set({ sortOrder: next, page: 1 })
    get().applyFilters()
  },
  setFilterKey: (filterKey) => {
    set({ filterKey, page: 1 })
    persistFilterState(get())
    get().applyFilters()
  },
  setSearchQuery: (searchQuery) => {
    set({ searchQuery, page: 1 })
    persistFilterState(get())
    get().applyFilters()
  },
  setCurrentPath: (currentPath) => {
    set({ currentPath, page: 1 })
    get().applyFilters()
  },
  setPage: (page: number) => set({ page }),
  setFilterModel: (filterModel) => { set({ filterModel, page: 1 }); persistFilterState(get()); get().applyFilters() },
  setFilterLora: (filterLora) => { set({ filterLora, page: 1 }); persistFilterState(get()); get().applyFilters() },
  setFilterDateMin: (filterDateMin) => { set({ filterDateMin, page: 1 }); persistFilterState(get()); get().applyFilters() },
  setFilterDateMax: (filterDateMax) => { set({ filterDateMax, page: 1 }); persistFilterState(get()); get().applyFilters() },
  setFilterQuickPeriod: (filterQuickPeriod) => { set({ filterQuickPeriod, page: 1 }); persistFilterState(get()); get().applyFilters() },
  setFilterStatusFlags: (filterStatusFlags) => { set({ filterStatusFlags, page: 1 }); persistFilterState(get()); get().applyFilters() },
  setFilterTag: (filterTag) => { set({ filterTag, page: 1 }); persistFilterState(get()); get().applyFilters() },
  setFilterCategory: (filterCategory) => { set({ filterCategory, page: 1 }); persistFilterState(get()); get().applyFilters() },
  setCategory: async (id, category) => {
    try {
      if (nativeStorageEnabled()) await nativeUpdateOutput(id, { category })
      else await outputsDb.files.update(id, { category })
      set(s => ({ files: s.files.map(f => f.id === id ? { ...f, category } : f) }))
      get().applyFilters()
    } catch (err) { console.warn('[outputStore] setCategory 失败:', err) }
  },
  batchSetCategory: async (ids, category) => {
    const results = await Promise.allSettled(ids.map(id => nativeStorageEnabled()
      ? nativeUpdateOutput(id, { category })
      : outputsDb.files.update(id, { category })))
    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length > 0) console.warn(`[outputStore] batchSetCategory 失败 ${failed.length}/${ids.length}`)
    // 仅更新 DB 写入成功的项，失败项保持原值（内存与 DB 一致）
    const okIds = new Set(ids.filter((_, i) => results[i].status === 'fulfilled'))
    set(s => ({ files: s.files.map(f => okIds.has(f.id) ? { ...f, category } : f) }))
    get().applyFilters()
    return failed.length
  },
  deleteCategory: async (category) => {
    if (!category) return
    const ids = get().files.filter(f => f.category === category).map(f => f.id)
    const results = await Promise.allSettled(ids.map(id => nativeStorageEnabled()
      ? nativeUpdateOutput(id, { category: '' })
      : outputsDb.files.update(id, { category: '' })))
    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length > 0) console.warn(`[outputStore] deleteCategory 失败 ${failed.length}/${ids.length}`)
    const okIds = new Set(ids.filter((_, i) => results[i].status === 'fulfilled'))
    set(s => ({ files: s.files.map(f => okIds.has(f.id) ? { ...f, category: '' } : f) }))
    get().applyFilters()
  },
  renameCategory: async (oldName, newName) => {
    if (!oldName || !newName) return
    const ids = get().files.filter(f => f.category === oldName).map(f => f.id)
    const results = await Promise.allSettled(ids.map(id => nativeStorageEnabled()
      ? nativeUpdateOutput(id, { category: newName })
      : outputsDb.files.update(id, { category: newName })))
    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length > 0) console.warn(`[outputStore] renameCategory 失败 ${failed.length}/${ids.length}`)
    const okIds = new Set(ids.filter((_, i) => results[i].status === 'fulfilled'))
    set(s => ({ files: s.files.map(f => okIds.has(f.id) ? { ...f, category: newName } : f) }))
    get().applyFilters()
  },
  clearAdvancedFilters: () => {
    set({ filterModel: '', filterLora: '', filterDateMin: '', filterDateMax: '', filterQuickPeriod: '', filterStatusFlags: [], filterTag: '', filterCategory: '', page: 1 })
    get().applyFilters()
  },

  toggleSelect: (id) => set(s => {
    const next = new Set(s.selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { selectedIds: next }
  }),
  selectAll: () => set(s => ({
    // Ctrl+A 语义 = 全选当前过滤视图（替换式，避免跨筛选累积选择波及不可见文件）
    selectedIds: new Set(s.filteredFiles.map(f => f.id))
  })),
  clearSelection: () => set({ selectedIds: new Set() }),

  toggleFavorite: async (id) => {
    const file = get().files.find(f => f.id === id)
    if (!file) return
    const next = !file.favorite
    if (nativeStorageEnabled()) await nativeUpdateOutput(id, { favorite: next })
    else await outputsDb.files.update(id, { favorite: next })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, favorite: next } : f)
    }))
    get().applyFilters()
  },

  setRating: async (id, rating) => {
    try {
      if (nativeStorageEnabled()) await nativeUpdateOutput(id, { rating })
      else await outputsDb.files.update(id, { rating })
      set(s => ({
        files: s.files.map(f => f.id === id ? { ...f, rating } : f)
      }))
      get().applyFilters()
    } catch (err) {
      console.warn('[outputStore] setRating 失败:', err)
    }
  },

  setNotes: async (id, notes) => {
    if (nativeStorageEnabled()) await nativeUpdateOutput(id, { notes })
    else await outputsDb.files.update(id, { notes })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, notes } : f)
    }))
  },

  setTags: async (id, tags) => {
    if (nativeStorageEnabled()) await nativeUpdateOutput(id, { tags })
    else await outputsDb.files.update(id, { tags })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, tags } : f)
    }))
  },

  setStatus: async (id, status) => {
    if (nativeStorageEnabled()) await nativeUpdateOutput(id, { status })
    else await outputsDb.files.update(id, { status })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, status } : f)
    }))
    get().applyFilters()
  },

  togglePinned: async (id) => {
    const file = get().files.find(f => f.id === id)
    if (!file) return
    const next = !file.pinned
    if (nativeStorageEnabled()) await nativeUpdateOutput(id, { pinned: next })
    else await outputsDb.files.update(id, { pinned: next })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, pinned: next } : f)
    }))
    get().applyFilters()
  },

  batchPin: async (ids) => {
    if (nativeStorageEnabled()) {
      for (const id of ids) await nativeUpdateOutput(id, { pinned: true })
    } else {
      for (const id of ids) await outputsDb.files.update(id, { pinned: true })
    }
    set(s => ({ files: s.files.map(f => ids.includes(f.id) ? { ...f, pinned: true } : f) }))
    get().applyFilters()
  },

  batchUnpin: async (ids) => {
    if (nativeStorageEnabled()) {
      for (const id of ids) await nativeUpdateOutput(id, { pinned: false })
    } else {
      for (const id of ids) await outputsDb.files.update(id, { pinned: false })
    }
    set(s => ({ files: s.files.map(f => ids.includes(f.id) ? { ...f, pinned: false } : f) }))
    get().applyFilters()
  },

  loadMetadata: async (id, opts) => {
    const cached = get().metadataCache.get(id)
    // 内存命中且不追加 LoRA 需求（或该条已提取过）→ 直接返回，绝不回 DB
    const wantLoras = !!opts?.loras && !!cached?.hasWorkflow && !cached.lorasExtracted
    if (META_DBG) console.log('[meta-dbg] loadMetadata', id, { wantLorasOpt: !!opts?.loras, cached: !!cached, hasWf: cached?.hasWorkflow, extracted: cached?.lorasExtracted, wantLoras, earlyReturn: !!(cached && !wantLoras) })
    if (cached && !wantLoras) return cached
    // 并发去重：同一 id 的多个请求（连点、可见区批量加载）共享同一个 Promise
    const inflight = _metaInflight.get(id)
    if (inflight) {
      if (META_DBG) console.log('[meta-dbg] reuse inflight', id)
      return inflight
    }

    const task = (async () => {
      try {
        if (META_DBG) console.log('[meta-dbg] db read start', id)
        const meta = await Promise.race([
          outputsDb.metadata.get(id),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new MetadataReadTimeoutError(id)), DB_READ_TIMEOUT_MS)
          }),
        ])
        if (META_DBG) console.log('[meta-dbg] db read done', id, { found: !!meta, wfLen: meta ? String(meta.workflowJson || '').length : -1 })
        if (!meta) return null
        const slim = slimMeta(meta)
        if (opts?.loras) {
          // ⚠️ 只对这一张卡的工作流做 JSON.parse（历史上的做法是全库遍历解析，秒级到分钟级）
          try {
            slim.loras = meta.workflowJson ? extractLorasFromWorkflow(meta.workflowJson, meta.rawMetadata) : []
          } catch {
            slim.loras = []
          }
          slim.lorasExtracted = true
          if (META_DBG) console.log('[meta-dbg] extracted', id, { n: slim.loras.length, sample: slim.loras.slice(0, 2), hasWf: !!meta.workflowJson })
        }
        set(s => {
          const next = new Map(s.metadataCache)
          next.set(id, slim)
          return { metadataCache: next, metadataVersion: s.metadataVersion + 1 }
        })
        return meta
      } finally {
        _metaInflight.delete(id)
      }
    })()
    _metaInflight.set(id, task)
    return task
  },

  putMetadata: (meta) => set(s => {
    const prev = s.metadataCache.get(meta.imageId)
    const slim = slimMeta(meta)
    // ⚠️ 扫描/重解析/编辑保存都会走这里（2026-09-11 修）：工作流没变就必须沿用已提取的 loras。
    // 否则「可见区刚提取好 → scanner 解析完成写回」的时序会把结果清空，
    // 首屏卡片的「复制 LoRA 标签」按钮永远不出现（可见区观察器已 unobserve，不会再试）。
    if (canReuseLoras(prev, slim)) {
      slim.loras = prev?.loras || []
      slim.lorasExtracted = true
    } else {
      slim.lorasExtracted = false
    }
    if (META_DBG) console.log('[meta-dbg] putMetadata', meta.imageId, { reuse: canReuseLoras(prev, slim), prevExtracted: prev?.lorasExtracted, fpSame: !!prev && prev.workflowFingerprint === slim.workflowFingerprint })
    const next = new Map(s.metadataCache)
    next.set(meta.imageId, slim)
    return { metadataCache: next, metadataVersion: s.metadataVersion + 1 }
  }),
  putMetadataBatch: (metas) => set(s => {
    if (metas.length === 0) return {}
    const next = new Map(s.metadataCache)
    let dbgReuse = 0
    for (const m of metas) {
      const prev = next.get(m.imageId)
      const slim = slimMeta(m)
      // ⚠️ 这里不能无条件覆盖（2026-09-11 修）：全库元数据补齐（ensureAllMetadata → bulkGet →
      // 本方法）传进来的是 DB 原始记录，而 DB **不存** loras/hasWorkflow（见 types/outputs.ts），
      // slimMeta 只会把 loras 置 []。无条件覆盖会把已提取的 LoRA 列表清空 →
      // Outputs 卡片的「复制 LoRA 标签」按钮消失，且因可见区早退判据不再补提取（本次会话不恢复）。
      // 已提取过、且工作流指纹未变 → 沿用已提取结果。
      if (canReuseLoras(prev, slim)) {
        slim.loras = prev?.loras || []
        slim.lorasExtracted = true
        if (META_DBG) dbgReuse++
      } else {
        slim.lorasExtracted = false
      }
      next.set(m.imageId, slim)
    }
    if (META_DBG) console.log('[meta-dbg] batch', { total: metas.length, reuse: dbgReuse })
    return { metadataCache: next, metadataVersion: s.metadataVersion + 1 }
  }),
  removeMetadata: (ids) => set(s => {
    if (ids.length === 0) return {}
    const next = new Map(s.metadataCache)
    let changed = false
    for (const id of ids) {
      if (next.delete(id)) changed = true
    }
    return changed ? { metadataCache: next, metadataVersion: s.metadataVersion + 1 } : {}
  }),
  setThumbMemory: (path, dataUrl) => set(s => {
    const next = new Map(s.thumbMemory)
    // 已存在则先删除再插入：移到队尾，配合队首淘汰近似 LRU
    if (next.has(path)) next.delete(path)
    next.set(path, dataUrl)
    // 内存上限 500 条：超出淘汰最早缓存的 dataURL（200px JPEG，约几十 MB 封顶）
    if (next.size > 500) {
      const oldest = next.keys().next().value
      if (oldest !== undefined) next.delete(oldest)
    }
    return { thumbMemory: next }
  }),
  invalidateThumbnails: (paths) => set(s => {
    if (!paths) return { thumbMemory: new Map() }
    if (paths.length === 0) return {}
    const next = new Map(s.thumbMemory)
    for (const p of paths) next.delete(p)
    return { thumbMemory: next }
  }),

  loadMore: () => {
    set(s => ({ page: s.page + 1 }))
    get().applyFilters()
  },

  applyFilters: () => {
    const { files, filterKey, searchQuery, sortKey, sortOrder, currentPath, metadataCache, page, viewMode,
      filterModel, filterLora, filterDateMin, filterDateMax, filterQuickPeriod, filterStatusFlags, filterTag, filterCategory } = get()

    let filtered = [...files]

    // 路径筛选
    if (currentPath) {
      filtered = filtered.filter(f => f.path.startsWith(currentPath))
    }

    // 预设筛选（收藏/评分）
    switch (filterKey) {
      case 'favorites':
        filtered = filtered.filter(f => f.favorite)
        break
      case 'rated':
        filtered = filtered.filter(f => f.rating > 0)
        break
    }

    // 搜索
    if (searchQuery) {
      filtered = filtered.filter(f => matchSearch(f, searchQuery, metadataCache.get(f.id) || null))
    }

    // 高级筛选
    const hasAdvanced = filterModel || filterLora || filterDateMin || filterDateMax || filterQuickPeriod || filterStatusFlags.length > 0 || filterTag || filterCategory
    if (hasAdvanced) {
      const periodStart = filterQuickPeriod ? getPeriodStart(filterQuickPeriod) : 0
      filtered = filtered.filter(f => {
        const meta = metadataCache.get(f.id)

        // 快捷时间段
        if (filterQuickPeriod && f.mtime < periodStart) return false

        // 日期范围
        if (filterDateMin) {
          const min = new Date(filterDateMin).getTime()
          if (f.mtime < min) return false
        }
        if (filterDateMax) {
          const max = new Date(filterDateMax).getTime() + 86400000
          if (f.mtime > max) return false
        }

        // 状态标记筛选
        if (filterStatusFlags.length > 0) {
          if (filterStatusFlags.includes('favorite') && !f.favorite) return false
          if (filterStatusFlags.includes('rated') && !(f.rating > 0)) return false
          if (filterStatusFlags.includes('status') && !f.status) return false
        }

        // 自定义分类筛选（挂在文件上，无需元数据）
        if (filterCategory) {
          if (filterCategory === '__none__' && f.category !== '') return false
          if (filterCategory !== '__none__' && f.category !== filterCategory) return false
        }

        // 需要元数据的筛选
        if (!meta) return !(filterModel || filterLora || filterTag)

        if (filterModel && !meta.model.toLowerCase().includes(filterModel.toLowerCase())) return false
        if (filterLora) {
          const loras = meta.loras || []
          if (!loras.some(l => l.toLowerCase().includes(filterLora.toLowerCase()))) return false
        }
        if (filterTag && !f.tags.some(t => t.toLowerCase().includes(filterTag.toLowerCase()))) return false

        return true
      })
    }

    // 排序（置顶优先，同组内按当前规则）
    const dir = sortOrder === 'desc' ? -1 : 1
    filtered.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      switch (sortKey) {
        case 'date': return a.pinned && b.pinned || !a.pinned && !b.pinned ? (a.mtime - b.mtime) * dir : 0
        case 'name': return (a.pinned && b.pinned || !a.pinned && !b.pinned) ? a.filename.localeCompare(b.filename) * dir : 0
        case 'size': return (a.pinned && b.pinned || !a.pinned && !b.pinned) ? (a.size - b.size) * dir : 0
        default: return 0
      }
    })

    // 分页：仅列表模式保留「加载更多」限流（列表未虚拟化，DOM 会随页数累积）；
    // 网格模式由 VirtualScroll 渲染全量（DOM 只含可视行，无需切片）
    const total = filtered.length
    const paged = viewMode === 'list' ? filtered.slice(0, page * PAGE_SIZE) : filtered

    set({
      filteredFiles: paged,
      hasMore: viewMode === 'list' && paged.length < total
    })
  },
}))

// Persist sortOrder from localStorage
const savedOrder = localStorage.getItem('outputs_sortOrder')
if (savedOrder === 'asc' || savedOrder === 'desc') {
  useOutputStore.getState().sortOrder = savedOrder
}

// ── 筛选状态持久化 ──
// 只持久化「浏览偏好」：视图/排序/预设筛选/搜索。高级筛选（模型/LoRA/日期范围/快捷时段/状态/分类）
// 是临时探索条件，不跨会话保存——否则一次误设的日期范围会长期静默生效，把历史日期全部藏掉
// （复现：dateMin=2026-08-12 导致 8.12 及之前永久不显示，"清除筛选"才恢复）。
const FILTER_STORAGE_KEY = 'outputs_filterState'
function persistFilterState(state: { viewMode: string; sortKey: string; filterKey: string; searchQuery: string; filterModel: string; filterLora: string; filterDateMin: string; filterDateMax: string; filterQuickPeriod: string; filterStatusFlags: string[]; filterCategory: string }) {
  void state.filterModel; void state.filterLora; void state.filterDateMin; void state.filterDateMax
  void state.filterQuickPeriod; void state.filterStatusFlags; void state.filterCategory
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
      viewMode: state.viewMode, sortKey: state.sortKey, filterKey: state.filterKey,
      searchQuery: state.searchQuery,
    }))
  } catch { /* quota */ }
}
function restoreFilterState() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw)
    const st = useOutputStore.getState()
    if (saved.viewMode === 'grid' || saved.viewMode === 'list') st.viewMode = saved.viewMode
    if (typeof saved.sortKey === 'string') st.sortKey = saved.sortKey
    if (typeof saved.filterKey === 'string') st.filterKey = saved.filterKey
    if (typeof saved.searchQuery === 'string') st.searchQuery = saved.searchQuery
    // 历史残留的高级筛选一律忽略并显式清空，防止幽灵过滤（如遗留 dateMin）把历史日期藏掉
    st.filterModel = ''; st.filterLora = ''; st.filterDateMin = ''; st.filterDateMax = ''
    st.filterQuickPeriod = ''; st.filterStatusFlags = []; st.filterTag = ''; st.filterCategory = ''
  } catch { /* ignore */ }
}
restoreFilterState()
