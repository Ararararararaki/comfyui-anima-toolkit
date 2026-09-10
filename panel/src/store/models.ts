import { create } from 'zustand'
import type { ProcessedModel, CivitaiModel, ModelCategory, SortKey, PeriodKey, SectionKey } from '../types'
import { Cache } from './cache'
import { stripHtml } from '../utils'
import { getCivitaiHost } from '../api/civitai'
import { isHidden, getHiddenIds } from './hidden'
import { isFav, getCollectionFavs, getActiveCol } from './favorites'
import { getLocalFileNames } from './localModels'

// 与 ModelCard.isLocalModel 保持一致的本地匹配（名称规范化后与本地文件名互相包含）
function isLocalByName(name: string): boolean {
  const names = getLocalFileNames()
  if (names.length === 0) return false
  const q = name.toLowerCase().replace(/[\s_-]/g, '')
  return names.some(n => n.includes(q) || q.includes(n))
}

const CAT_LABEL: Record<ModelCategory, string> = {
  artist: '画师风格', character: '人物角色', aesthetic: '美学优化', background: '背景环境', other: '其他',
}
const CAT_BADGE: Record<ModelCategory, string> = {
  artist: 'badge-artist', character: 'badge-character', aesthetic: 'badge-aesthetic', background: 'badge-bg', other: 'badge-other',
}

interface FilterStage { key: string; label: string; count: number }

/**
 * 逐级筛选：getFiltered 与 filterBreakdown 共用同一实现，
 * 保证空状态里显示的"是谁筛掉了结果"与实际展示完全一致。
 */
function applyFilters(state: ModelState): { list: ProcessedModel[]; stages: FilterStage[] } {
  let list = [...state.processed]
  const stages: FilterStage[] = []
  const step = (key: string, label: string, fn: (m: ProcessedModel) => boolean) => {
    list = list.filter(fn)
    stages.push({ key, label, count: list.length })
  }

  if (state.category === 'fav') {
    const favIds = new Set(getCollectionFavs(getActiveCol()).map(f => f.id))
    step('category', '收藏合集', m => favIds.has(m.id))
  } else if (state.category === 'hidden') {
    const hiddenIds = new Set(getHiddenIds())
    step('category', '隐藏记录', m => hiddenIds.has(m.id))
  } else if (state.category !== 'all') {
    step('category', `分类 = ${CAT_LABEL[state.category as ModelCategory] || state.category}`, m => m.category === state.category)
  }

  if (state.category !== 'hidden') {
    const hiddenIds = new Set(getHiddenIds())
    if (hiddenIds.size > 0) step('hidden', `已隐藏 ${hiddenIds.size} 条`, m => !hiddenIds.has(m.id))
  }

  if (state.qualityFilter === 'rec') {
    step('quality', '质量筛选 = 推荐', m => m.quality.some(q => q === 'hot' || q === 'quality'))
  } else if (state.qualityFilter === 'new') {
    step('quality', '质量筛选 = 新发布', m => m.quality.includes('new'))
  } else if (state.qualityFilter === 'local') {
    step('quality', '质量筛选 = 仅本地', m => isLocalByName(m.name))
  } else if (state.qualityFilter === 'highq') {
    // 高质：下载量 ≥ 250 且 赞比 ≥ 5%（沿用第三方补丁的阈值语义）。
    // 与既有「推荐」的区别：阈值更宽松（推荐 = 热门或赞比 ≥ 15%），且两项必须同时满足。
    // 必须由用户显式选中才生效——不做默认开启，避免静默丢掉结果。
    step('quality', '质量筛选 = 高质（下载≥250 且 赞比≥5%）', m =>
      m.stats.downloadCount >= 250 && m.stats.ratio >= 0.05)
  }

  if (state.filterBaseModel) {
    step('baseModel', `基座模型 = ${state.filterBaseModel}`, m => m.baseModel === state.filterBaseModel)
  }

  const q = state.search.trim().toLowerCase()
  // 远程已按同一关键词检索完成时不再本地二次过滤：否则会出现"远程有结果、本地全被筛掉"
  // 的空状态（用户看到的"无符合条件的 LoRA"闪烁）。本地过滤只在输入防抖期间生效。
  const handledByApi = !!q && state.resolvedQuery.trim().toLowerCase() === q
  if (q && !handledByApi) {
    step('search', `关键词 = ${state.search.trim()}`, m =>
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      m.tags.some(t => t.toLowerCase().includes(q)) ||
      m.creator.toLowerCase().includes(q) ||
      m.trainedWords.some(w => w.toLowerCase().includes(q))
    )
  }

  // 赞比排序：Civitai API 无该排序参数，按已加载结果本地降序
  if (state.sort === 'LikeRatio') {
    list = [...list].sort((a, b) => b.stats.ratio - a.stats.ratio || b.stats.thumbsUpCount - a.stats.thumbsUpCount)
  }

  return { list, stages }
}

interface ModelState {
  raw: CivitaiModel[]
  processed: ProcessedModel[]
  filtered: ProcessedModel[]
  page: number
  maxPage: number
  loading: boolean
  hasMore: boolean
  category: string
  search: string
  /** 远程搜索关键词（Civitai API query 参数） */
  remoteQuery: string
  /** 已经由远程 API 检索完成的关键词；与 search 相等时本地不再二次严格过滤 */
  resolvedQuery: string
  /** 远程标签过滤（Civitai API tag 参数，逗号分隔） */
  remoteTags: string[]
  /** NSFW 过滤：all 全部 / sfw 仅安全 */
  nsfw: 'all' | 'sfw'
  /** 下一页 cursor URL（Civitai cursor 分页） */
  nextPage: string | null
  /** 页码 → 该页起始 cursor（用于页码跳转；第 1 页为 null 不入表） */
  pageCursors: Record<number, string>
  sort: SortKey
  period: PeriodKey
  section: SectionKey
  qualityFilter: string
  filterBaseModel: string
  batchMode: boolean
  batchSelected: Set<number>
  autoFetching: boolean
  fetchAllBusy: boolean
  cardUid: number
  imgStore: Record<number, string[]>

  setPeriod: (period: PeriodKey) => void
  setCategory: (cat: string) => void
  setSearch: (q: string) => void
  setRemoteQuery: (q: string) => void
  setResolvedQuery: (q: string) => void
  setRemoteTags: (t: string[]) => void
  setNsfw: (n: 'all' | 'sfw') => void
  setNextPage: (u: string | null) => void
  setPageCursor: (page: number, cursor: string) => void
  clearPageCursors: () => void
  setSort: (s: SortKey) => void
  setSection: (s: SectionKey) => void
  setQualityFilter: (q: string) => void
  setFilterBaseModel: (m: string) => void
  toggleBatchMode: () => void
  toggleBatchSelect: (id: number) => void
  clearBatch: () => void

  categorize: (m: CivitaiModel) => ModelCategory
  processModel: (m: CivitaiModel, needsFallback?: boolean) => ProcessedModel
  rebuild: () => void
  getFiltered: () => ProcessedModel[]
  /** 逐级统计各筛选条件剩余数量（用于空状态定位"是谁把结果筛没了"） */
  filterBreakdown: () => { remote: number; stages: { key: string; label: string; count: number }[] }
  setRaw: (raw: CivitaiModel[]) => void
  appendRaw: (items: CivitaiModel[]) => void
  setPagination: (page: number, maxPage: number, hasMore: boolean) => void
}

export const useModelStore = create<ModelState>((set, get) => ({
  raw: [],
  processed: [],
  filtered: [],
  page: 0,
  maxPage: 0,
  loading: false,
  hasMore: true,
  category: 'all',
  search: '',
  remoteQuery: '',
  resolvedQuery: '',
  remoteTags: [],
  nsfw: 'all',
  nextPage: null,
  pageCursors: {},
  sort: 'Most Downloaded',
  period: 'AllTime',
  section: 'local',
  qualityFilter: 'all',
  filterBaseModel: 'Anima',
  batchMode: false,
  batchSelected: new Set(),
  autoFetching: false,
  fetchAllBusy: false,
  cardUid: 0,
  imgStore: {},

  setPeriod: (period) => set({ period, raw: [], page: 0, hasMore: true, nextPage: null, pageCursors: {} }),
  setCategory: (category) => set({ category }),
  setSearch: (search) => set({ search }),
  setRemoteQuery: (remoteQuery) => set({ remoteQuery }),
  setResolvedQuery: (resolvedQuery) => set({ resolvedQuery }),
  setRemoteTags: (remoteTags) => set({ remoteTags }),
  setNsfw: (nsfw) => set({ nsfw }),
  setNextPage: (nextPage) => set({ nextPage }),
  setPageCursor: (page, cursor) => set(s => ({ pageCursors: { ...s.pageCursors, [page]: cursor } })),
  clearPageCursors: () => set({ pageCursors: {} }),
  setSort: (sort) => set({ sort }),
  setSection: (section) => set({ section }),
  setQualityFilter: (qualityFilter) => set({ qualityFilter }),
  setFilterBaseModel: (filterBaseModel) => set({ filterBaseModel }),
  toggleBatchMode: () => set(s => ({ batchMode: !s.batchMode, batchSelected: new Set() })),
  toggleBatchSelect: (id: number) => set(s => {
    const next = new Set(s.batchSelected)
    if (next.has(id)) next.delete(id); else next.add(id)
    return { batchSelected: next }
  }),
  clearBatch: () => set({ batchSelected: new Set(), batchMode: false }),

  categorize(m) {
    const n = (m.name || '').toLowerCase()
    const d = stripHtml(m.description || '').toLowerCase()
    const tg = (m.tags || []).map(t => t.toLowerCase())
    const tw = (m.modelVersions?.[0]?.trainedWords || []).map(t => t.toLowerCase())
    const all = [...tg, ...tw, n, d].join(' ')
    if (/\b(style|art style|artist|画师|画风|artstyle|painting style)\b/.test(all)) return 'artist'
    if (/\b(character|person|girl|boy|woman|man|portrait|角色|人物|cosplay|actress|actor|oc)\b/.test(all)) return 'character'
    if (/\b(aesthetic|enhance|quality|detail|sharp|clarity|hdr|光影|色彩|优化|画质|高清|细节|texture|shading|lighting|render)\b/.test(all)) return 'aesthetic'
    if (/\b(background|bg |environment|scene|landscape|背景|环境|场景|风景|天空|城市|nature|outdoor)\b/.test(all)) return 'background'
    return 'other'
  },

  processModel(m, needsFallback = false) {
    const dl = m.stats?.downloadCount ?? 0
    const like = m.stats?.thumbsUpCount ?? 0
    const ratio = dl > 0 ? like / dl : 0
    const cat = get().categorize(m)
    const ver = (m.modelVersions || []).find(v => v.baseModel === 'Anima') || (m.modelVersions || [])[0] || {}
    const imgs = (ver.images || []).filter(i => i.type === 'image' && i.url).map(i => {
      let u = i.url.trim()
      if (u.startsWith('//')) u = 'https:' + u
      return u.startsWith('http') ? u : ''
    }).filter(Boolean) as string[]
    const trained = ver.trainedWords || []
    const pf = (ver.files || []).find(f => f.primary) || (ver.files || [])[0]
    const desc = stripHtml(m.description || '')
    const uid = ++get().cardUid
    // 详情/作者链接跟随当前 C 站线路（镜像站下 .com 链接打不开）
    const host = getCivitaiHost()
    return {
      id: m.id, uid, name: m.name || 'Untitled', description: desc,
      creator: m.creator?.username || 'unknown',
      creatorUrl: m.creator?.username ? `${host}/user/${encodeURIComponent(m.creator.username)}` : '',
      url: `${host}/models/${m.id}`,
      downloadUrl: pf?.downloadUrl || '',
      stats: { downloadCount: dl, thumbsUpCount: like, ratio },
      nsfw: m.nsfw || m.nsfwLevel >= 15,
      tags: m.tags || [],
      category: cat,
      categoryLabel: CAT_LABEL[cat] || '其他',
      badgeClass: CAT_BADGE[cat] || 'badge-other',
      images: imgs,
      trainedWords: trained,
      versionId: ver.id,
      versionName: (ver.name || '').replace(/^v/i, ''),
      versionCreatedAt: ver.createdAt || '',
      baseModel: ver.baseModel || '',
      versions: (m.modelVersions || []).map(v => ({
        id: v.id,
        name: (v.name || '').replace(/^v/i, ''),
        files: (v.files || []).map(f => ({ name: f.name, downloadUrl: f.downloadUrl, primary: !!f.primary }))
      })),
      quality: [],
      needsFallback, fallbackLoading: false, fallbackDone: false, customAdded: false,
    }
  },

  rebuild() {
    const state = get()
    const seen = new Set<number>()
    const processed: ProcessedModel[] = []
    const fallbackQueue: ProcessedModel[] = []
    const imgStore: Record<number, string[]> = {}
    let cardUid = state.cardUid

    for (const m of state.raw) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      const dl = m.stats?.downloadCount ?? 0
      const like = m.stats?.thumbsUpCount ?? 0
      const ratio = dl > 0 ? like / dl : 0
      const ver = (m.modelVersions || []).find(v => v.baseModel === 'Anima') || (m.modelVersions || [])[0] || {}
      const hasImgs = (ver.images || []).some(i => i.type === 'image' && i.url)
      cardUid++
      const p = state.processModel(m, !hasImgs)
      p.uid = cardUid
      processed.push(p)
      imgStore[p.uid] = p.images
      if (!hasImgs) fallbackQueue.push(p)
    }

    const customModels = Cache.load<CivitaiModel[]>('custom_loras', 365 * 24 * 60 * 60 * 1000) || []
    for (const c of customModels) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      cardUid++
      const p = state.processModel(c, true)
      p.uid = cardUid
      p.customAdded = true
      processed.push(p)
      imgStore[p.uid] = p.images
    }

    // ── Quality badges ──
    if (processed.length > 0) {
      const sortedByDl = [...processed].sort((a, b) => b.stats.downloadCount - a.stats.downloadCount)
      const hotCutoff = Math.max(1, Math.floor(processed.length * 0.1))
      const hotSet = new Set(sortedByDl.slice(0, hotCutoff).map(m => m.uid))

      const now = Date.now()
      const monthAgo = now - 30 * 24 * 60 * 60 * 1000

      for (const p of processed) {
        if (hotSet.has(p.uid)) p.quality.push('hot')
        if (p.stats.ratio >= 0.15) p.quality.push('quality')
        if (p.versionCreatedAt) {
          const t = new Date(p.versionCreatedAt).getTime()
          if (!isNaN(t) && t > monthAgo) p.quality.push('new')
        }
      }
    }

    set({ processed, cardUid, imgStore })
  },

  getFiltered() {
    return applyFilters(get()).list
  },

  filterBreakdown() {
    const state = get()
    return { remote: state.processed.length, stages: applyFilters(state).stages }
  },

  setRaw(raw) { set({ raw }) },
  // 去重从 O(n²) 优化为 O(n)：先收集已有 id 到 Set 再过滤
  appendRaw(items) { set(s => {
    const known = new Set(s.raw.map(m => m.id))
    return { raw: [...s.raw, ...items.filter(m => !known.has(m.id))] }
  }) },
  setPagination(page, maxPage, hasMore) { set({ page, maxPage, hasMore }) },
}))
