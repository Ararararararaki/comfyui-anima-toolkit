import { create } from 'zustand'
import type { OutputFile, OutputMetadata, OutputViewMode, OutputSortKey, OutputFilterKey, OutputScanStatus } from '../types/outputs'
import { outputsDb } from '../db/outputsDb'
import { extractLorasFromWorkflow } from '../services/outputMetadata'

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

  loadMetadata: (id: string) => Promise<OutputMetadata | null>
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
    copy.loras = extractLorasFromWorkflow(meta.workflowJson, meta.rawMetadata)
    copy.hasWorkflow = true
    copy.workflowJson = ''
  }
  // rawMetadata（原始 PNG chunk 全量，平均 80KB+/张）与 negativePrompt 只在解析/提取/展示时用：
  // 内存版剥离（完整数据从 DB 懒读），渲染/筛选/搜索不需要
  copy.rawMetadata = {}
  copy.negativePrompt = ''
  return copy
}

export const useOutputStore = create<OutputState>((set, get) => ({
  dirHandle: null,
  rootPath: '',
  currentPath: '',

  files: [],
  filteredFiles: [],
  selectedIds: new Set(),
  metadataCache: new Map(),
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
      await outputsDb.files.update(id, { category })
      set(s => ({ files: s.files.map(f => f.id === id ? { ...f, category } : f) }))
      get().applyFilters()
    } catch (err) { console.warn('[outputStore] setCategory 失败:', err) }
  },
  batchSetCategory: async (ids, category) => {
    const results = await Promise.allSettled(ids.map(id => outputsDb.files.update(id, { category })))
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
    const results = await Promise.allSettled(ids.map(id => outputsDb.files.update(id, { category: '' })))
    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length > 0) console.warn(`[outputStore] deleteCategory 失败 ${failed.length}/${ids.length}`)
    const okIds = new Set(ids.filter((_, i) => results[i].status === 'fulfilled'))
    set(s => ({ files: s.files.map(f => okIds.has(f.id) ? { ...f, category: '' } : f) }))
    get().applyFilters()
  },
  renameCategory: async (oldName, newName) => {
    if (!oldName || !newName) return
    const ids = get().files.filter(f => f.category === oldName).map(f => f.id)
    const results = await Promise.allSettled(ids.map(id => outputsDb.files.update(id, { category: newName })))
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
    await outputsDb.files.update(id, { favorite: next })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, favorite: next } : f)
    }))
    get().applyFilters()
  },

  setRating: async (id, rating) => {
    try {
      await outputsDb.files.update(id, { rating })
      set(s => ({
        files: s.files.map(f => f.id === id ? { ...f, rating } : f)
      }))
      get().applyFilters()
    } catch (err) {
      console.warn('[outputStore] setRating 失败:', err)
    }
  },

  setNotes: async (id, notes) => {
    await outputsDb.files.update(id, { notes })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, notes } : f)
    }))
  },

  setTags: async (id, tags) => {
    await outputsDb.files.update(id, { tags })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, tags } : f)
    }))
  },

  setStatus: async (id, status) => {
    await outputsDb.files.update(id, { status })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, status } : f)
    }))
    get().applyFilters()
  },

  togglePinned: async (id) => {
    const file = get().files.find(f => f.id === id)
    if (!file) return
    const next = !file.pinned
    await outputsDb.files.update(id, { pinned: next })
    set(s => ({
      files: s.files.map(f => f.id === id ? { ...f, pinned: next } : f)
    }))
    get().applyFilters()
  },

  batchPin: async (ids) => {
    for (const id of ids) await outputsDb.files.update(id, { pinned: true })
    set(s => ({ files: s.files.map(f => ids.includes(f.id) ? { ...f, pinned: true } : f) }))
    get().applyFilters()
  },

  batchUnpin: async (ids) => {
    for (const id of ids) await outputsDb.files.update(id, { pinned: false })
    set(s => ({ files: s.files.map(f => ids.includes(f.id) ? { ...f, pinned: false } : f) }))
    get().applyFilters()
  },

  loadMetadata: async (id) => {
    const cached = get().metadataCache.get(id)
    if (cached) return cached
    const meta = await outputsDb.metadata.get(id)
    if (meta) {
      const slim = slimMeta(meta)
      set(s => {
        const next = new Map(s.metadataCache)
        next.set(id, slim)
        return { metadataCache: next }
      })
    }
    return meta || null
  },

  putMetadata: (meta) => set(s => {
    const next = new Map(s.metadataCache)
    next.set(meta.imageId, slimMeta(meta))
    return { metadataCache: next }
  }),
  putMetadataBatch: (metas) => set(s => {
    if (metas.length === 0) return {}
    const next = new Map(s.metadataCache)
    for (const m of metas) next.set(m.imageId, slimMeta(m))
    return { metadataCache: next }
  }),
  removeMetadata: (ids) => set(s => {
    if (ids.length === 0) return {}
    const next = new Map(s.metadataCache)
    let changed = false
    for (const id of ids) { if (next.delete(id)) changed = true }
    return changed ? { metadataCache: next } : {}
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

// ── 筛选状态持久化（viewMode/sortKey/filterKey/searchQuery/高级筛选）──
const FILTER_STORAGE_KEY = 'outputs_filterState'
function persistFilterState(state: { viewMode: string; sortKey: string; filterKey: string; searchQuery: string; filterModel: string; filterLora: string; filterDateMin: string; filterDateMax: string; filterQuickPeriod: string; filterStatusFlags: string[]; filterCategory: string }) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
      viewMode: state.viewMode, sortKey: state.sortKey, filterKey: state.filterKey,
      searchQuery: state.searchQuery, filterModel: state.filterModel, filterLora: state.filterLora,
      filterDateMin: state.filterDateMin, filterDateMax: state.filterDateMax,
      filterQuickPeriod: state.filterQuickPeriod, filterStatusFlags: state.filterStatusFlags,
      filterCategory: state.filterCategory,
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
    if (typeof saved.filterModel === 'string') st.filterModel = saved.filterModel
    if (typeof saved.filterLora === 'string') st.filterLora = saved.filterLora
    if (typeof saved.filterDateMin === 'string') st.filterDateMin = saved.filterDateMin
    if (typeof saved.filterDateMax === 'string') st.filterDateMax = saved.filterDateMax
    if (typeof saved.filterQuickPeriod === 'string') st.filterQuickPeriod = saved.filterQuickPeriod
    if (Array.isArray(saved.filterStatusFlags)) st.filterStatusFlags = saved.filterStatusFlags
    if (typeof saved.filterCategory === 'string') st.filterCategory = saved.filterCategory
  } catch { /* ignore */ }
}
restoreFilterState()
