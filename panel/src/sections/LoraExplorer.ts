import { useModelStore } from '../store/models'
import { renderCard, refreshLocalNames } from '../components/ModelCard'
import { renderArtists } from './ArtistSeries'
import { renderClothingLibrary } from './ClothingLibrary'
import { fetchModels, fetchModelById, fetchModelImages, parseCivitaiModelId } from '../api/civitai'
import type { ModelFetchParams } from '../api/civitai'
import type { PeriodKey, SortKey } from '../types'
import { Cache } from '../store/cache'
import {
  initFavorites, getCollections, getActiveCol, setActiveCol,
  createCollection, renameCollection, deleteCollection,
  exportFavData, importFavData, favCount, toggleFav
} from '../store/favorites'
import { removeHidden, hiddenCount, getHiddenIds, clearHidden } from '../store/hidden'
import { addSearch, getSearches, clearSearches, getViews, addView } from '../store/history'
import { addArtistImage, removeArtistImage, getCustomImages, getMergedImages } from '../store/artistImages'
import { addArtist, deleteArtist, getArtists, extractTagsFromModels, addArtistFromExtraction } from '../store/artists'

import { openLightbox, closeLightbox, navLightbox } from '../components/Lightbox'
import { openModal, closeModal, confirmModal } from '../components/Modal'
import { esc, escAttr, copyText, showToast, sleep, thumbUrl, fmtNum } from '../utils'
import { icon } from '../utils/icon'
import { VirtualScroll } from '../components/VirtualScroll'
import { renderLocalView as renderLocal, activateLocalManager } from './LocalManager'
import { useLocalModelStore } from '../store/localModels'
import { initPromptDB, getPromptCountByModel } from '../store/prompts'
import { renderPromptLibrary, setupPromptHandlers } from './PromptLibrary'
import { activatePromptFreq, bindPromptFreqEvents } from './PromptFreq'
import { activateOutputs } from './Outputs'
// 图片加载服务（已实现，勿改）：重建后补水卡片图片；离开栏目时清缓存
import { hydrateLoraGallery, clearLoraImageCache } from '../services/loraCardImage'

const MAX_PAGES = 20
/** 已使用的 cursor 集合：防止 API 异常/回环导致重复加载已看内容 */
let usedCursors = new Set<string>()

// ── 随机探索：已看过 id 记录（跨会话，FIFO 上限），让每次探索优先带出新内容 ──
const SEEN_KEY = 'anima_lora_seen_ids'
const SEEN_CAP = 6000
let seenIds: Set<number> | null = null
function getSeen(): Set<number> {
  if (!seenIds) {
    try { seenIds = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as number[]) }
    catch { seenIds = new Set() }
  }
  return seenIds
}
function markSeen(ids: number[]) {
  const s = getSeen()
  for (const id of ids) { s.delete(id); s.add(id) } // 重新插入刷新顺序
  if (s.size > SEEN_CAP) {
    const arr = [...s]
    seenIds = new Set(arr.slice(arr.length - SEEN_CAP))
  }
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...getSeen()])) } catch { /* 存储满时静默跳过 */ }
}

/** 随机探索进行中：fetchPage 据此过滤已看过、自动续页、结束后标记 */
let exploring = false
/** 探索单次最多连续翻的页数（某组合新内容翻完就停，不无限请求） */
const EXPLORE_WALK_MAX = 6
/** 第一页新内容少于此数时自动再续一页，保证首屏有足够新货 */
const EXPLORE_MIN_FRESH = 60

const EXPLORE_SORTS: { key: SortKey; w: number; label: string }[] = [
  { key: 'Most Downloaded', w: 3, label: '下载量' },
  { key: 'Highest Rated', w: 2.5, label: '评分' },
  { key: 'Most Collected', w: 1.5, label: '收藏' },
  { key: 'Newest', w: 2, label: '最新发布' },
  { key: 'Most Discussed', w: 1, label: '讨论' },
]
const EXPLORE_PERIODS: { key: PeriodKey; w: number; label: string }[] = [
  { key: 'Month', w: 3, label: '本月' },
  { key: 'Week', w: 2, label: '本周' },
  { key: 'Year', w: 2.5, label: '今年' },
  { key: 'AllTime', w: 2.5, label: '全部' },
]
function weightedPick<T extends { w: number }>(arr: T[]): T {
  const total = arr.reduce((s, x) => s + x.w, 0)
  let r = Math.random() * total
  for (const x of arr) { r -= x.w; if (r <= 0) return x }
  return arr[arr.length - 1]
}
// ── 虚拟滚动:网格 absolute 布局,只渲染视口行 ──
let gridVirtual: VirtualScroll | null = null
let virtualList: any[] = []
let virtualCols = 1
const DEFAULT_CARD_W = 300
const DEFAULT_CARD_GAP = 14
const BASE_CARD_H = 380
let gridResizeObserver: ResizeObserver | null = null
let observedGrid: HTMLElement | null = null
let observedGridWidth = 0
let gridResizeFrame = 0
let gridSettingsFrame = 0
let gridRefreshBound = false
const galleryPos: Record<number, number> = {}

/** 自增请求序号：仅最新一次 fetchPage 负责把 loading 归位，
 *  避免被已 abort 的旧请求 finally 提前清零（修复「搜了没反应」的关键之一）。 */
let fetchSeq = 0

function cssPx(variable: string, fallback: number): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(variable))
  return Number.isFinite(value) ? value : fallback
}

function getGridMetrics() {
  const cardWidth = Math.max(160, Math.min(400, cssPx('--card-min-width', DEFAULT_CARD_W)))
  const gap = Math.max(8, cssPx('--grid-gap', DEFAULT_CARD_GAP))
  // 卡片正文在窄列时会自然换行；虚拟滚动必须预留足够行高，否则正文会被下一行覆盖。
  const narrowExtra = Math.max(0, 280 - cardWidth)
  const cardHeight = Math.round(BASE_CARD_H + narrowExtra * 0.55)
  return { cardWidth, gap, cardHeight }
}

function scheduleGridRefresh() {
  if (gridResizeFrame) return
  gridResizeFrame = requestAnimationFrame(() => {
    gridResizeFrame = 0
    const section = document.getElementById('sectionLora')
    const grid = document.getElementById('grid') as HTMLElement | null
    if (section?.classList.contains('section-hidden') || !grid || grid.clientWidth === 0) return
    observedGridWidth = grid.clientWidth
    renderGrid()
  })
}

function bindGridResize(grid: HTMLElement) {
  if (observedGrid === grid) return
  gridResizeObserver?.disconnect()
  observedGrid = grid
  observedGridWidth = grid.clientWidth
  if (typeof ResizeObserver === 'undefined') return
  gridResizeObserver = new ResizeObserver(() => {
    const width = grid.clientWidth
    if (width === 0 || Math.abs(width - observedGridWidth) < 1) return
    observedGridWidth = width
    scheduleGridRefresh()
  })
  gridResizeObserver.observe(grid)
}

function bindGridRefreshEvents() {
  if (gridRefreshBound) return
  gridRefreshBound = true
  window.addEventListener('anima:settings-applied', () => {
    if (gridSettingsFrame) return
    gridSettingsFrame = requestAnimationFrame(() => {
      gridSettingsFrame = 0
      const section = document.getElementById('sectionLora')
      const grid = document.getElementById('grid') as HTMLElement | null
      if (section && !section.classList.contains('section-hidden') && grid?.clientWidth) {
        observedGridWidth = grid.clientWidth
        renderGrid()
      }
    })
  })
}

/** 缓存 key 包含全部远程筛选参数，防止不同搜索条件互相串数据 */
function cacheKey(store: ReturnType<typeof useModelStore.getState>): string {
  return `models_${store.period}_${store.sort}_${store.filterBaseModel || 'all'}_${store.nsfw}_${store.remoteQuery}_${store.remoteTags.join(',')}`
}

/** 筛选条件变化：清空列表与 cursor，重新抓第一页（explore=true 时进入随机探索的过滤逻辑） */
function resetAndFetch(explore = false) {
  const store = useModelStore.getState()
  // 新搜索/筛选开始：清掉上次的错误态（数据层已新增 setError）
  useModelStore.getState().setError(null)
  exploring = explore
  usedCursors.clear()
  store.clearPageCursors()
  store.setRaw([])
  store.setPagination(0, 0, true)
  store.setNextPage(null)
  fetchPage(1)
}

function currentParams(): ModelFetchParams {
  const store = useModelStore.getState()
  return {
    query: store.remoteQuery,
    baseModels: store.filterBaseModel || undefined,
    sort: store.sort,
    nsfw: store.nsfw,
    tags: store.remoteTags,
    period: store.period,
  }
}

export async function initLoraExplorer() {
  bindGridRefreshEvents()
  initFavorites()
  initFavorites()
  initPromptDB() // Initialize IndexedDB prompt library

  // 立即渲染默认页面（force=true 确保即使 store.section 已匹配也触发渲染）
  // 放在 await 之前，确保页面内容优先显示
  switchSection(useModelStore.getState().section as any, true)

  const store = useModelStore.getState()
  // 不再自动抓取/恢复缓存：栏目打开显示空状态，由「快速抓取」或搜索/分类手动触发

  const fbModels = useModelStore.getState().processed.filter(m => m.needsFallback && m.images.length === 0)
  if (fbModels.length > 0) {
    for (const m of fbModels) {
      const imgs = await fetchModelImages(m.id)
      if (imgs.length > 0) m.images = imgs
      await sleep(600)
    }
    refreshView()
  }

  // 启动时自动检测本地目录是否有新文件
  const localStore = useLocalModelStore.getState()
  if (localStore.files.length > 0) {
    const restored = await localStore.loadDirHandle().catch(() => false)
    if (restored) {
      const newCount = await localStore.detectNewFiles().catch(() => 0)
      if (newCount > 0) {
        localStore.setNewFileCount(newCount)
        showToast(`📁 本地 LoRA 有新文件 (${newCount} 个)，切到「本地 lora 管理」可增量扫描`)
      }
    }
  }
}

export function switchSection(id: 'lora' | 'artist' | 'prompt' | 'clothing' | 'prompt-freq' | 'local' | 'outputs', force?: boolean) {
  const store = useModelStore.getState()
  if (!force && id === store.section) return
  useModelStore.getState().setSection(id as any)
  document.querySelectorAll('#sectionLora, #sectionArtist, #sectionPrompt, #sectionClothing, #sectionPromptFreq, #sectionLocal, #sectionOutputs').forEach(el => el.classList.add('section-hidden'))
  const sectionMap: Record<string, string> = { lora: 'sectionLora', artist: 'sectionArtist', prompt: 'sectionPrompt', clothing: 'sectionClothing', 'prompt-freq': 'sectionPromptFreq', local: 'sectionLocal', outputs: 'sectionOutputs' }
  document.getElementById(sectionMap[id])?.classList.remove('section-hidden')
  // 离开 LoRA 栏目时释放图片缓存（图片服务要求），把内存让给生图；再次进入会重新 hydrate
  if (id !== 'lora') clearLoraImageCache()
  document.querySelectorAll('.main-tab').forEach(t => {
    const active = (t as HTMLElement).dataset.section === id
    t.classList.toggle('active', active)
    t.setAttribute('aria-selected', String(active))
  })
  if (id === 'artist') renderArtists()
  if (id === 'lora') { renderGrid(); startLoraDlBar() } else { stopLoraDlBar() }
  if (id === 'prompt') renderPromptLibrary()
  if (id === 'clothing') renderClothingLibrary()
  if (id === 'prompt-freq') activatePromptFreq()
  if (id === 'local') { renderLocal(); activateLocalManager() }
  if (id === 'outputs') { activateOutputs().catch(() => {}) }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 暴露给命令面板（CommandPalette.ts）跨模块调用，避免循环依赖
;(window as any).__animaSwitchSection = switchSection

async function fetchPage(p: number, options?: { quietError?: boolean; append?: boolean; cursor?: string | null }) {
  const store = useModelStore.getState()
  // 修复：在途请求时不再直接 return 丢弃新搜索。新请求到达 fetchModels 后，
  // 其内部的 AbortController 会中止旧的在途请求（旧请求拿到 null 后不写任何状态），
  // 从而解决「搜了没反应 / 旧结果残留」。若当前仍在 loading，旧请求的 finally 不会
  // 提前清零 loading（见下方 fetchSeq 守卫）。
  const mySeq = ++fetchSeq

  // 守卫①：重复 cursor（API 异常/回环）→ 立即终止，不再重复加载已看内容
  if (options?.cursor && usedCursors.has(options.cursor)) {
    store.setNextPage(null)
    store.setPagination(p, Math.max(p, store.maxPage), false)
    showToast('✅ 已加载全部内容')
    return
  }

  useModelStore.setState({ loading: true })
  try {
    if (options?.cursor) usedCursors.add(options.cursor)
    // cursor 分页：API 的 page 参数已失效（实测 page=1/2 返回相同数据），翻页必须携带 cursor
    const params = currentParams()
    const data = await fetchModels(params, options?.cursor)
    if (!data) return
    const meta = data.metadata || {}
    const nextCursor = meta.nextCursor || null
    // 探索模式：过滤掉已看过的 id，只带出新内容
    const items = exploring
      ? (data.items || []).filter(m => !getSeen().has(m.id))
      : (data.items || [])
    // ⚠️ 一律读实时 state：appendRaw 会写入新数组，起始快照 store.raw 仍指向旧数组。
    // 用快照算新增数会让 appended 恒为 0 → noGain → hasMore=false →
    // #loadMoreWrap（加载更多 + 回到顶部 + 分页栏）整块被隐藏且不再恢复。
    const before = options?.append ? useModelStore.getState().raw.length : 0
    if (options?.append) useModelStore.getState().appendRaw(items)
    else useModelStore.getState().setRaw(items)
    const appended = useModelStore.getState().raw.length - before
    // 记录本次结果对应的关键词：命中后本地不再二次过滤同一关键词（避免空态闪烁）
    useModelStore.getState().setResolvedQuery((params.query || '').trim().toLowerCase())
    // 守卫②：整页全是已加载 id（无新增）→ 视为到底，终止（探索模式有自己的续页逻辑，不受此守卫影响）
    const noGain = options?.append && appended === 0 && !exploring
    const hasMore = !noGain && !!nextCursor && p < MAX_PAGES && !(nextCursor && usedCursors.has(nextCursor))
    // 真实总页数：由 API metadata.totalPages 提供（跳转上限仍为 MAX_PAGES）
    const totalPages = meta.totalPages ? Math.max(p, meta.totalPages) : Math.max(p, store.maxPage)
    store.setPagination(p, totalPages, hasMore)
    store.setNextPage(nextCursor)
    if (nextCursor) store.setPageCursor(p + 1, nextCursor)
    useModelStore.getState().rebuild()
    refreshView(!!options?.append)

    const saved = useModelStore.getState()
    Cache.save(cacheKey(saved), saved.raw)
    if (exploring) {
      // 本组合抓到的都记为已看过（含被过滤的重复项，幂等）
      markSeen((data.items || []).map(m => m.id))
      // 探索历史：把本页新内容记入当前探索条目（供历史回看）
      if (_exploreEntry && items.length) {
        const pm = useModelStore.getState().processed
        for (const it of items) {
          if (_exploreEntry.items.length >= EXPLORE_HIST_ITEMS_CAP) break
          if (_exploreEntry.items.some(x => x.id === it.id)) continue
          const p2 = pm.find(x => x.id === it.id)
          if (!p2) continue
          _exploreEntry.items.push({ id: p2.id, uid: p2.uid, name: p2.name, creator: p2.creator, url: p2.url, thumb: p2.images?.[0] || '', categoryLabel: p2.categoryLabel || '', words: (p2.trainedWords || []).slice(0, 4), versionId: p2.versionId || 0 })
        }
      }
      let continueTo: (() => void) | null = null
      if (appended === 0) {
        if (nextCursor && p < EXPLORE_WALK_MAX) {
          // 本页全是看过的：继续翻下一页找新内容（有页数上限，不无限请求）
          continueTo = () => { void fetchPage(p + 1, { append: true, cursor: nextCursor, quietError: true }) }
        } else if (!options?.quietError) {
          showToast('🎲 这一组合的新内容探索完了，再点一次「随机探索」换个角度', 'success')
        }
      } else if (p === 1 && appended < EXPLORE_MIN_FRESH && nextCursor) {
        // 首屏新内容太少：自动再续一页补足
        continueTo = () => { void loadMore() }
      }
      if (continueTo) setTimeout(continueTo, 80)
      else { exploring = false; finishExploreEntry() }
    }
    return items
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null
    console.error(err)
    const e = err as any
    const status = typeof e?.status === 'number' ? e.status : 0
    // 数据层已新增 error / setError：把失败写入 store，UI 顶部 banner 展示可重试的错误态
    useModelStore.getState().setError({ status, message: String(e?.message || err) })
    if (!options?.quietError) showToast('❌ 抓取出错: ' + (err as Error).message)
    return null
  } finally {
    // 仅当本次请求仍是最新一次时才把 loading 归位，避免被已 abort 的旧请求 finally 提前清零
    if (mySeq === fetchSeq) useModelStore.setState({ loading: false })
  }
}

// ── 快速抓取:定向类别(人物/光影/画风)或随机类别,抓取第一批 ──
const QUICK_FETCH_TAGS = ['character', 'lighting', 'style', 'aesthetic', 'background']
export function quickFetchByTag(tag: string | null) {
  const store = useModelStore.getState()
  const pick = tag || QUICK_FETCH_TAGS[Math.floor(Math.random() * QUICK_FETCH_TAGS.length)]
  store.setRemoteTags([pick])
  const tagInput = document.getElementById('tagInput') as HTMLInputElement
  if (tagInput) tagInput.value = pick
  showToast(tag ? `⏳ 正在抓取「${pick}」类 LoRA…` : `🎲 随机抓取「${pick}」类…`)
  resetAndFetch()
}

// ── 探索历史：记录每次随机探索的组合与带出的新内容，支持回看 ──
const EXPLORE_HIST_KEY = 'anima_explore_history'
const EXPLORE_HIST_CAP = 20
const EXPLORE_HIST_ITEMS_CAP = 36
interface ExploreHistItem { id: number; uid: number; name: string; creator: string; url: string; thumb: string; categoryLabel: string; words: string[]; versionId: number }
interface ExploreHistEntry { time: number; sort: string; period: string; tag: string; items: ExploreHistItem[] }
let _exploreEntry: ExploreHistEntry | null = null
function loadExploreHist(): ExploreHistEntry[] {
  try { const r = JSON.parse(localStorage.getItem(EXPLORE_HIST_KEY) || '[]'); return Array.isArray(r) ? r : [] } catch { return [] }
}
function pushExploreHist(e: ExploreHistEntry) {
  const list = [e, ...loadExploreHist().filter(x => x.time !== e.time)]
  try { localStorage.setItem(EXPLORE_HIST_KEY, JSON.stringify(list.slice(0, EXPLORE_HIST_CAP))) }
  catch { try { localStorage.setItem(EXPLORE_HIST_KEY, JSON.stringify(list.slice(0, 5))) } catch { /* 存储满，放弃 */ } }
}
function finishExploreEntry() {
  if (!_exploreEntry) return
  if (_exploreEntry.items.length > 0) pushExploreHist(_exploreEntry)
  _exploreEntry = null
}
// ── 一键后台下载核心：入队后由服务端断点续传到 ComfyUI models/loras 根目录 ──
/**
 * 后台下载入队。**对齐「本地 lora 管理」面板的 URL 下载逻辑**（2026-09-10）：
 * 只要拿得到 C 站下载链接就能入队 —— 缺 versionId 时从 url 里解析
 * （`modelVersionId=123` 或 `/models/123`），不再直接拒绝用户。
 * 服务端 `/anima/lora/download/queue` 同时接受 versionId / modelId / url 三种入口。
 */
async function queueLoraDownload(versionId: string | number | undefined, url: string, label: string) {
  let vid = versionId ? String(versionId) : ''
  let modelId = ''
  if (!vid && url) {
    const mv = url.match(/modelVersionId=(\d+)/)
    const mm = url.match(/models\/(\d+)/)
    if (mv) vid = mv[1]
    else if (mm) modelId = mm[1]
  }
  if (!vid && !modelId && !url) { showToast('⚠️ 缺少下载链接，请从 C 站页面复制链接后手动下载'); return }
  try {
    const item: Record<string, string> = {
      target: 'auto',
      token: localStorage.getItem('anima_civitai_token') || '',
      url,
      label,
    }
    if (vid) item.versionId = vid
    else if (modelId) item.modelId = modelId
    const res = await fetch('/anima/lora/download/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [item] }),
    })
    const result = await res.json()
    if (!res.ok || !result.ok) throw new Error(result.error || `HTTP ${res.status}`)
    showToast(`📥 「${label}」已加入后台下载，完成后 LoRA 管理页会自动发现`, 'success')
  } catch (error) {
    showToast(`❌ 加入后台下载失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 后台下载浮动条：LoRA 探索内直接可见进度并取消，无需跑去「本地 lora 管理」──
// 数据源 = /anima/lora/download/list（后端维护的任务表）；只在 lora 栏目激活时轮询（2s）。
let dlBarTimer: ReturnType<typeof setInterval> | null = null
let dlBarBusy = false
let dlBarEl: HTMLElement | null = null

function ensureDlBar(): HTMLElement {
  if (!dlBarEl || !document.body.contains(dlBarEl)) {
    dlBarEl = document.createElement('div')
    dlBarEl.className = 'lora-dl-bar'
    dlBarEl.style.display = 'none'
    document.body.appendChild(dlBarEl)
  }
  return dlBarEl
}

async function pollLoraDlBar(): Promise<void> {
  if (dlBarBusy || !dlBarEl) return
  dlBarBusy = true
  try {
    const res = await fetch('/anima/lora/download/list')
    const data = await res.json()
    const jobs = (Array.isArray(data?.jobs) ? data.jobs : []).filter((j: any) => j.status === 'queued' || j.status === 'downloading')
    const bar = ensureDlBar()
    if (jobs.length === 0) {
      if (bar.style.display !== 'none') { bar.style.display = 'none'; bar.replaceChildren() }
      return
    }
    bar.style.display = 'flex'
    const head = document.createElement('div')
    head.className = 'ldb-head'
    head.textContent = `⬇ 后台下载中 ${jobs.length} 个`
    bar.replaceChildren(head)
    for (const j of jobs) {
      const row = document.createElement('div')
      row.className = 'ldb-row'
      const label = String(j.label || j.filename || j.url || j.progressId)
      const name = document.createElement('span')
      name.className = 'ldb-name'
      name.textContent = label.slice(0, 28)
      name.title = label
      const pct = document.createElement('span')
      pct.className = 'ldb-pct'
      const total = Number(j.total) || 0
      const done = Number(j.done) || 0
      pct.textContent = total > 0 ? `${Math.min(100, Math.round((done / total) * 100))}%` : (j.status === 'queued' ? '排队中' : '…')
      const cancel = document.createElement('button')
      cancel.className = 'ldb-cancel'
      cancel.textContent = '✕'
      cancel.title = '取消该下载'
      cancel.addEventListener('click', () => {
        void fetch(`/anima/lora/download/cancel?progressId=${encodeURIComponent(String(j.progressId))}`).catch(() => {})
      })
      row.append(name, pct, cancel)
      bar.appendChild(row)
    }
  } catch { /* 后端离线：静默，下一轮再试 */ } finally {
    dlBarBusy = false
  }
}

function startLoraDlBar(): void {
  ensureDlBar()
  if (!dlBarTimer) {
    void pollLoraDlBar()
    dlBarTimer = setInterval(() => { void pollLoraDlBar() }, 2000)
  }
}

function stopLoraDlBar(): void {
  if (dlBarTimer) { clearInterval(dlBarTimer); dlBarTimer = null }
  if (dlBarEl) dlBarEl.style.display = 'none'
}

// ── 随机探索：随机「排序×周期×类别」组合 + 只看没看过的 ──
// 解决"每次抓取都是固定那批"：同一组合的第一页内容恒定（cursor 分页无页码偏移），
// 所以随机化的是组合本身，并跨会话记录看过的 id，让每次探索优先带出新面孔。
// 质量与新旧由加权保证：下载/评分/收藏偏质量，本月/本周/最新偏新，今年/全部偏经典。
export function randomExploreFetch() {
  const store = useModelStore.getState()
  if (store.loading) return
  const sort = weightedPick(EXPLORE_SORTS)
  const period = weightedPick(EXPLORE_PERIODS)
  const tag = Math.random() < 0.45 ? QUICK_FETCH_TAGS[Math.floor(Math.random() * QUICK_FETCH_TAGS.length)] : ''
  store.setSort(sort.key)
  store.setPeriod(period.key)
  store.setRemoteTags(tag ? [tag] : [])
  // 同步工具栏 UI（直接改值，不触发各自的 resetAndFetch）
  const sel = document.getElementById('sortSelect') as HTMLSelectElement
  if (sel) sel.value = sort.key
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.period === period.key))
  const tagInput = document.getElementById('tagInput') as HTMLInputElement
  if (tagInput) tagInput.value = tag
  _exploreEntry = { time: Date.now(), sort: sort.key, period: period.key, tag, items: [] }
  showToast(`🎲 探索：${sort.label} · ${period.label}${tag ? ' · ' + tag : ' · 全类别'}`)
  resetAndFetch(true)
}

export async function loadMore() {
  const store = useModelStore.getState()
  if (store.loading || !store.hasMore) return
  const next = store.page + 1
  if (next > MAX_PAGES) { showToast('⚠️ 已达最大页数'); return }
  // append: true — 增量追加渲染，不重建已渲染的卡片 DOM
  await fetchPage(next, { append: true, cursor: store.nextPage })
}

// ── 页码跳转：已加载页用缓存 cursor 直接拉该页；未加载页连续请求到目标页 ──
export async function goToPage(target: number) {
  const st0 = useModelStore.getState()
  if (st0.loading) return
  const totalPages = Math.max(1, Math.min(st0.maxPage || 1, MAX_PAGES))
  const page = Math.max(1, Math.min(target, totalPages))
  if (page === st0.page) return
  const st = useModelStore.getState()
  if (page === 1 || st.pageCursors[page]) {
    // 已加载页：用缓存 cursor 重置加载该页
    await fetchPage(page, { cursor: st.pageCursors[page] || null })
  } else if (page > st.page) {
    // 未加载页：连续请求到目标页（增量追加）
    showToast(`⏳ 加载到第 ${page} 页…`)
    let cur = st.page
    while (cur < page) {
      const s = useModelStore.getState()
      if (!s.hasMore) { showToast('⚠️ 已无更多内容'); break }
      await fetchPage(cur + 1, { append: true, cursor: s.nextPage, quietError: true })
      cur = useModelStore.getState().page
      if (cur >= page) break
    }
  }
  const grid = document.getElementById('grid')
  if (grid) grid.scrollTo({ top: 0, behavior: 'smooth' })
  else window.scrollTo({ top: 0, behavior: 'smooth' })
}

export function setPeriod(period: PeriodKey) {
  const store = useModelStore.getState()
  if (store.period === period) return
  useModelStore.getState().setPeriod(period)
  showToast(`📊 切换到「${{ AllTime: '全部', Year: '今年', Month: '本月', Week: '本周', Day: '今日' }[period]}」`)
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.period === period))
  resetAndFetch()
}

export function refreshView(append = false) {
  updateStats()
  updateTabs()
  renderGrid(append)
}

function updateStats() {
  const store = useModelStore.getState()
  const total = store.processed.length
  const totalDl = store.processed.reduce((s, m) => s + m.stats.downloadCount, 0)
  const totalLk = store.processed.reduce((s, m) => s + m.stats.thumbsUpCount, 0)
  const avgR = totalDl > 0 ? totalLk / totalDl : 0

  setText('totalCount', String(total))
  setText('totalDl', fmtNum(totalDl))
  setText('totalLike', fmtNum(totalLk))
  setText('avgRatio', (avgR * 100).toFixed(2) + '%')
  setText('pageInfo', `${store.page}/${Math.min(store.maxPage, MAX_PAGES)}`)
  const totalPages = Math.max(1, store.maxPage)
  setText('pageTotalText', String(Math.min(totalPages, MAX_PAGES)))
  const jump = document.getElementById('pageJumpInput') as HTMLInputElement
  if (jump && document.activeElement !== jump) jump.value = String(store.page)

  const pct = store.maxPage > 0 ? (store.page / Math.min(store.maxPage, MAX_PAGES)) * 100 : 0
  const fill = document.getElementById('loadingFill')
  if (fill) (fill as HTMLElement).style.width = Math.min(100, pct) + '%'

  setText('loraBadge', String(total))
}

function updateTabs() {
  const store = useModelStore.getState()
  const hiddenSet = new Set(getHiddenIds())

  const counts: Record<string, number> = { all: 0, artist: 0, character: 0, aesthetic: 0, background: 0, other: 0 }
  for (const m of store.processed) {
    if (hiddenSet.has(m.id)) continue
    counts.all++
    if (counts[m.category] !== undefined) counts[m.category]++
  }

  const idMap: Record<string, string> = { all: 'cAll', artist: 'cArtist', character: 'cCharacter', aesthetic: 'cAesthetic', background: 'cBg', other: 'cOther', fav: 'cFav' }
  for (const [k, id] of Object.entries(idMap)) {
    setText(id, String(k === 'fav' ? favCount() : (counts[k] || 0)))
  }
  renderColTabs()

  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', (t as HTMLElement).dataset.cat === store.category)
  )
}

function renderColTabs() {
  const container = document.getElementById('colTabs')
  if (!container) return
  const store = useModelStore.getState()
  const show = store.category === 'fav'
  container.style.display = show ? 'flex' : 'none'
  if (!show) return

  const cols = getCollections()
  const activeCol = getActiveCol()
  container.innerHTML = cols.map(c =>
    `<button class="tab ${c.id === activeCol ? 'active' : ''}" data-colid="${c.id}" role="tab">${c.icon} ${esc(c.name)} <span class="count">${c.count}</span></button>`
  ).join('') +
    `<button class="tab" id="manageColBtn" role="tab" style="border-color:var(--accent);color:var(--accent);font-size:11px">${icon('settings', 12)} 管理</button>`
}

/** 上一次虚拟网格的布局签名：签名不变时不重建 DOM，避免缩放/设置变更时整块闪烁 */
let lastGridSig = ''

/** 空状态签名：同一条空态只渲染一次，缩放/重排不再重建节点（否则文案会反复闪烁） */
function emptyStateSignature(store: ReturnType<typeof useModelStore.getState>): string {
  const b = store.filterBreakdown()
  return [store.page, b.remote, store.raw.length, store.search, store.filterBaseModel, store.qualityFilter, store.category, store.remoteQuery, b.stages.map(s => s.key + s.count).join('.')].join('|')
}

/** 清掉遗留的空状态节点（空态 → 有结果时旧代码只 append 虚拟层，空态会一直留在网格里） */
function clearEmptyState(grid: HTMLElement) {
  grid.querySelectorAll(':scope > .empty-state').forEach(el => el.remove())
}

function emptyStateHtml(store: ReturnType<typeof useModelStore.getState>): string {
  const b = store.filterBreakdown()
  const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string))

  // ① 远程就没有数据
  if (b.remote === 0) {
    if (store.page === 0 && !store.loading) {
      return `<div class="big">${icon('package', 28)}</div><p>还没有数据，点击上方「快速抓取」或搜索开始</p>`
    }
    const conds = [store.remoteQuery ? `关键词「${esc(store.remoteQuery)}」` : '', store.filterBaseModel ? `基座 ${esc(store.filterBaseModel)}` : '', store.remoteTags.length ? `标签 ${esc(store.remoteTags.join(','))}` : ''].filter(Boolean).join(' · ')
    return `<div class="big">${icon('search', 28)}</div><p>C 站没有匹配结果</p><p class="sub">当前条件：${conds || '无'}</p>` +
      `<div class="empty-actions">` +
      (store.filterBaseModel ? `<button class="btn btn-primary btn-sm" data-clear="baseModel" data-research="1">放宽为「全部基座」重搜</button>` : '') +
      (store.remoteQuery ? `<button class="btn btn-ghost btn-sm" data-clear="search" data-research="1">清空关键词重搜</button>` : '') +
      `</div>`
  }

  // ② 远程有结果，被本地条件筛掉 → 指出是哪个条件
  const culprit = b.stages.find(s => s.count === 0)
  if (culprit) {
    const clearable = culprit.key !== 'hidden' && culprit.key !== 'category'
    return `<div class="big">${icon('search', 28)}</div><p>C 站返回 ${b.remote} 个结果，但都被「${esc(culprit.label)}」筛掉了</p>` +
      (clearable ? `<div class="empty-actions"><button class="btn btn-primary btn-sm" data-clear="${culprit.key}">清除「${esc(culprit.label)}」并显示</button></div>` : '<p class="sub">切回「全部」标签页即可看到这些结果</p>')
  }

  return `<div class="big">${icon('package', 28)}</div><p>没有匹配的 LoRA</p>`
}

function renderGrid(append = false) {
  refreshLocalNames()
  const grid = document.getElementById('grid')
  if (!grid) return
  bindGridResize(grid)
  const store = useModelStore.getState()
  // 顶部错误态（401/403/429/0）：先于网格渲染，保证即使列表为空也可见且可重试
  renderErrorBanner(store)
  const list = store.getFiltered()

  if (list.length === 0) {
    if (gridVirtual) { gridVirtual.destroy(); gridVirtual = null }
    grid.classList.remove('virtualized')
    grid.onscroll = null
    lastGridSig = ''
    const inner = emptyStateHtml(store)
    const sig = emptyStateSignature(store)
    const existing = grid.querySelector(':scope > .empty-state') as HTMLElement | null
    if (existing?.dataset.sig === sig && existing.innerHTML === inner) {
      // 同一条空态：保留现有节点，避免每次 resize/缩放都重建文案（反复闪烁的观感来源）
    } else {
      grid.replaceChildren()
      grid.insertAdjacentHTML('beforeend', `<div class="empty-state" data-sig="${escAttr(sig)}">${inner}</div>`)
    }
    updatePager(store)
    return
  }

  // 有结果：先清掉可能残留的空状态节点，否则它会一直压在卡片上方
  clearEmptyState(grid)
  updatePager(store)

  // 虚拟滚动：读取设置后的卡片宽度/间距，并为窄卡片预留换行高度。
  const { cardWidth, gap, cardHeight } = getGridMetrics()
  virtualList = list
  virtualCols = Math.max(1, Math.floor((grid.clientWidth + gap) / (cardWidth + gap)))
  const rows = Math.ceil(list.length / virtualCols)
  grid.classList.add('virtualized')
  const renderItem = (row: number) => {
    let html = ''
    for (let col = 0; col < virtualCols; col++) {
      const idx = row * virtualCols + col
      if (idx >= virtualList.length) break
      const m = virtualList[idx]
      html += `<div class="vs-card-wrap" data-uid="${m.uid}" style="position:absolute;top:0;left:${col * (cardWidth + gap)}px;width:${cardWidth}px;height:${cardHeight}px;border-radius:10px;overflow:hidden;">${renderCard(m, store.category)}</div>`
    }
    return html
  }
  // 布局签名一致（列数/行高/内容都没变，仅窗口变宽）时跳过重建：
  // VirtualScroll.update() 内部是 replaceChildren 全量重建，会让所有缩略图重新解码，看起来就是整屏闪烁。
  // 布局签名：覆盖所有影响「要不要重建」的入口（筛选/排序/回到顶部不改变 sig → 不重建）。
  // 补充 period/nsfw/filterBaseModel —— 这几项变化会经 resetAndFetch 重新取数，
  // 极端情况下（返回首末 uid 与条数恰好相同）需靠它们命中 sig 差异以触发重建。
  const sig = [cardWidth, gap, cardHeight, virtualCols, list.length, list[0]?.uid ?? 0, list[list.length - 1]?.uid ?? 0, store.category, store.qualityFilter, store.sort, store.search, store.resolvedQuery, store.period, store.nsfw, store.filterBaseModel].join('|')
  if (!gridVirtual) {
    grid.replaceChildren()
    gridVirtual = new VirtualScroll({
      container: grid,
      itemHeight: cardHeight + gap,
      totalItems: rows,
      renderItem,
      // 虚拟行渲染完成后立即补水卡片图片；放在 afterRender 内不会触发二次重建（整屏闪的根因）
      afterRender: (inner: HTMLElement) => { hydrateLoraGallery(inner) },
    })
    lastGridSig = sig
  } else if (sig !== lastGridSig) {
    // 复用实例时也必须替换 renderItem；否则滑块/窗口缩放后仍会用旧宽度闭包渲染。
    gridVirtual.update({ totalItems: rows, itemHeight: cardHeight + gap, renderItem, afterRender: (inner: HTMLElement) => { hydrateLoraGallery(inner) } })
    gridVirtual.refresh()
    lastGridSig = sig
  }
  // 触底自动加载（网格内部滚动，提前 400px；loadMore 自带 loading/hasMore 保护）
  grid.onscroll = () => {
    const st = useModelStore.getState()
    if (!st.hasMore || st.loading) return
    // 内容未超过视口（可滚动余量不足 400px）时不自动加载：此时滚动事件会反复命中「触底」条件，
    // 反复触发 loadMore 是空态/网格闪烁的来源之一（取第三方补丁的守卫）
    if (grid.scrollHeight <= grid.clientHeight + 400) return
    if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) {
      loadMore()
    }
  }
}

/**
 * 分页区显示规则：只要抓过（page>0）就保留整块分页区，
 * 仅在没有下一页时隐藏「加载更多」按钮 —— 而不是把分页栏一起藏掉。
 */
function updatePager(store: ReturnType<typeof useModelStore.getState>) {
  const wrap = document.getElementById('loadMoreWrap')
  if (!wrap) return
  wrap.style.display = store.page > 0 ? 'flex' : 'none'
  const lm = document.getElementById('loadMoreBtn')
  if (lm) (lm as HTMLElement).style.display = store.hasMore ? '' : 'none'
  const tip = document.getElementById('loadMoreTip')
  if (tip) (tip as HTMLElement).style.display = store.page > 0 && !store.hasMore ? '' : 'none'
}

/**
 * 顶部错误态 banner（数据层 error / setError 已就绪）。
 * - 401/403 → 提示检查 API Key / 线路
 * - 429     → 请求过频稍后再试
 * - 0       → 网络失败
 * 始终带「重试」按钮（调用 resetAndFetch，会先清 error 再重抓）。
 * 安全：message 来自服务端错误，必须用 esc() 插值；重试按钮用 onclick 属性绑定（非内联字符串）。
 */
function renderErrorBanner(store: ReturnType<typeof useModelStore.getState>) {
  const grid = document.getElementById('grid')
  if (!grid) return
  const err = store.error
  let banner = document.getElementById('loraErrorBanner')
  if (!err) {
    if (banner) banner.remove()
    return
  }
  const container = grid.parentElement
  if (!container) return
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'loraErrorBanner'
    container.insertBefore(banner, grid)
  }
  const code = err.status
  let title = '加载失败'
  let hint = '请稍后重试，或检查网络与线路设置'
  if (code === 401 || code === 403) { title = '🔑 API Key / 线路异常'; hint = '请检查 Civitai API Key 是否填写，或切换镜像线路' }
  else if (code === 429) { title = '⏳ 请求过于频繁'; hint = 'C 站正在限流，请稍候再试' }
  else if (code === 0) { title = '🌐 网络请求失败'; hint = '请检查网络连接、代理或防火墙设置' }
  // 所有插值走 esc()，避免 XSS / 样式注入
  banner.innerHTML =
    `<div class="leb-icon">⚠️</div>` +
    `<div class="leb-text"><div class="leb-title">${esc(title)}</div>` +
    `<div class="leb-hint">${esc(hint)}</div>` +
    (err.message ? `<div class="leb-detail">${esc(err.message)}</div>` : '') +
    `</div>` +
    `<button class="btn btn-primary btn-sm leb-retry" type="button">↻ 重试</button>`
  const retry = banner.querySelector('.leb-retry') as HTMLButtonElement | null
  if (retry) retry.onclick = () => { resetAndFetch() }
}

function setText(id: string, text: string) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

function randomPick() {
  const store = useModelStore.getState()
  const filtered = store.getFiltered()
  if (filtered.length === 0) { showToast('⚠️ 当前筛选结果为空'); return }
  const pick = filtered[Math.floor(Math.random() * filtered.length)]
  // 虚拟化下卡片可能未渲染：滚动到所在行再高亮
  const idx = filtered.indexOf(pick)
  if (gridVirtual && idx >= 0) {
    gridVirtual.scrollToIndex(Math.floor(idx / virtualCols))
    setTimeout(() => {
      const wrap = document.querySelector(`.vs-card-wrap[data-uid="${pick.uid}"] .card`) as HTMLElement
      if (wrap) {
        wrap.style.transition = 'box-shadow .3s, transform .3s'
        wrap.style.boxShadow = '0 0 30px var(--accent-glow)'
        wrap.style.transform = 'translateY(-4px)'
        setTimeout(() => { wrap.style.boxShadow = ''; wrap.style.transform = '' }, 2000)
      }
    }, 300)
  }
  showToast('🎲 随机选中: ' + pick.name, 'success')
}

function renderArtistImgList(tag: string) {
  const list = document.getElementById('artistImgList')
  if (!list) return
  const imgs = getCustomImages(tag)
  if (imgs.length === 0) {
    list.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--text3);font-size:12px">暂无自定义图片，下方粘贴URL添加</div>'
  } else {
    list.innerHTML = imgs.map((url) =>
      `<div style="position:relative;aspect-ratio:1"><img src="${esc(url)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px"><button class="btn btn-danger" style="position:absolute;top:2px;right:2px;padding:1px 5px;font-size:9px;opacity:.8" onclick="window.__removeArtistImg('${esc(tag)}','${esc(url)}')">${icon('x', 11)}</button></div>`
    ).join('')
  }
}

function getTagSuggestions(limit: number): { tag: string; count: number }[] {
  // 从当前已加载 LoRA 的触发词统计高频词（@画师/角色 tag + 风格词），过滤质量词与权重语法
  const count = new Map<string, number>()
  const store = useModelStore.getState()
  for (const m of store.processed) {
    for (const w of m.trainedWords || []) {
      const t = w.trim()
      if (t.length < 2 || t.length > 60) continue
      if (/^(masterpiece|best quality|high quality|worst quality|low quality|nsfw|rating\w*|score_\w+|year \d+)/i.test(t)) continue
      if (/^[[(（]/.test(t)) continue
      count.set(t, (count.get(t) || 0) + 1)
    }
  }
  return [...count.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, c]) => ({ tag, count: c }))
}

function renderSearchHistory() {
  const dd = document.getElementById('searchHistory')
  if (!dd) return
  const searches = getSearches()
  const views = getViews()
  if (searches.length === 0 && views.length === 0) {
    dd.style.display = 'none'
    return
  }
  let html = ''
  // 「💡 触发词联想」已随触发词一起移除（2026-09-10，用户要求）
  if (searches.length > 0) {
    html += `<div class="sh-title">${icon('search', 11)} 搜索历史 <button type="button" onclick="clearSearches();renderSearchHistory();showToast('已清空搜索历史')">清空</button></div>`
    for (const q of searches) {
      html += `<div class="sh-item" data-action="search" data-query="${esc(q)}"><span class="sh-icon">🕐</span><span class="sh-text">${esc(q)}</span></div>`
    }
  }
  if (views.length > 0) {
    html += `<div class="sh-title" style="margin-top:4px">👁️ 最近浏览</div>`
    for (const v of views) {
      html += `<div class="sh-item" data-action="view" data-url="${esc(v.url)}">${
        v.thumb ? `<img src="${esc(thumbUrl(v.thumb))}" style="width:28px;height:28px;border-radius:4px;object-fit:cover;flex-shrink:0">` : '<span class="sh-icon">📦</span>'
      }<span class="sh-text">${esc(v.name || '未知')}</span></div>`
    }
  }
  dd.innerHTML = html
  dd.style.display = 'block'
  dd.querySelectorAll('.sh-item').forEach(el => {
    el.addEventListener('click', function (this: HTMLElement, e) {
      e.stopPropagation()
      const q = this.dataset.query || ''
      if (this.dataset.action === 'search' || this.dataset.action === 'suggest') {
        ;(document.getElementById('searchInput') as HTMLInputElement).value = q
        useModelStore.getState().setSearch(q)
        useModelStore.getState().setRemoteQuery(q)
        addSearch(q)
        resetAndFetch()
      } else if (this.dataset.action === 'view') {
        window.open(this.dataset.url, '_blank')
      }
      dd.style.display = 'none'
    })
  })
}

function openColManage() {
  renderColManageList()
  openModal('colManageModal')
}

function renderColManageList() {
  const list = document.getElementById('colList')
  if (!list) return
  const cols = getCollections()
  list.innerHTML = cols.map(c => {
    const isDefault = c.id === 'default'
    const safeName = esc(c.name)
    const safeId = esc(c.id)
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)">' +
      '<span style="font-size:16px">' + c.icon + '</span>' +
      (isDefault
        ? '<span style="flex:1;font-size:13px">' + safeName + '</span>'
        : '<input class="col-rename-input" data-colid="' + safeId + '" type="text" value="' + safeName + '" style="flex:1;padding:4px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;font-family:var(--font);outline:none">'
      ) +
      '<span style="font-size:11px;color:var(--text3);white-space:nowrap">' + c.count + ' 项</span>' +
      (isDefault ? '' : '<button class="btn btn-danger col-del-btn" style="padding:3px 8px;font-size:10px;opacity:.6" data-colid="' + safeId + '" data-colname="' + safeName + '">' + icon('x', 11) + '</button>') +
      '</div>'
  }).join('')

  list.querySelectorAll('.col-rename-input').forEach(inp => {
    inp.addEventListener('change', function (this: HTMLInputElement) {
      renameCollection(this.dataset.colid || '', this.value)
      refreshView()
    })
  })

  // Event delegation for delete collection button
  list.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    const delBtn = target.closest('.col-del-btn') as HTMLElement
    if (delBtn) {
      const colId = delBtn.dataset.colid
      const colName = delBtn.dataset.colname
      if (colId && await confirmModal('删除合集', `确认删除「${colName}」？`)) {
        deleteCollection(colId)
        refreshView()
      }
    }
  })
}

export function setupGlobalHandlers() {
  const w = window as any

  w.__copyText = copyText

  w.__searchByTag = (tag: string) => {
    const input = document.querySelector('.search-wrap input') as HTMLInputElement
    if (input) input.value = tag
    useModelStore.getState().setSearch(tag)
    useModelStore.getState().setRemoteQuery(tag)
    addSearch(tag)
    resetAndFetch()
    switchSection('lora')
    const artists = getArtists()
    const artist = artists.find(a => a.tag.toLowerCase() === tag.toLowerCase())
    const banner = document.getElementById('artistPreviewBanner')
    if (artist && banner) {
      const autoFilled = [...artist.images]
      if (autoFilled.length === 0) {
        const q = tag.toLowerCase()
        const models = useModelStore.getState().processed
        for (const m of models) {
          if (!m.trainedWords?.some(w => w.toLowerCase() === q)) continue
          for (const img of m.images) {
            if (!autoFilled.includes(img)) autoFilled.push(img)
            if (autoFilled.length >= 3) break
          }
          if (autoFilled.length >= 3) break
        }
      }
      const imgs = getMergedImages(artist.tag, autoFilled).slice(0, 6)
      banner.style.display = imgs.length > 0 ? 'block' : 'none'
      banner.innerHTML = imgs.length > 0 ? `<div style="margin-bottom:16px;padding:16px;background:linear-gradient(135deg,var(--accent-soft),transparent);border:1px solid var(--border);border-radius:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="font-size:20px;font-weight:700;color:var(--accent)">${esc(artist.tag)}</span>
          <span style="font-size:13px;color:var(--text2)">${esc(artist.name)}</span>
          <span style="font-size:11px;color:var(--text3)">— ${imgs.length} 张示例图</span>
        </div>
        <p style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.5">${esc(artist.desc)}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px">${imgs.map((u,i) => `<img src="${esc(u)}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;cursor:pointer;transition:transform .2s" loading="lazy" onclick="window.__openLightbox(${JSON.stringify(imgs)},${i})">`).join('')}</div>
      </div>` : ''
    } else if (banner) {
      banner.style.display = 'none'
    }
  }

  // 按作者搜索：Civitai API 的 username/creator 参数实测均无效（返回未过滤结果），
  // 降级为 query=作者名近似匹配（可命中名称/描述中含作者名的模型）
  w.__searchCreator = (name: string) => {
    const input = document.querySelector('.search-wrap input') as HTMLInputElement
    if (input) input.value = name
    useModelStore.getState().setSearch(name)
    useModelStore.getState().setRemoteQuery(name)
    addSearch(name)
    resetAndFetch()
    switchSection('lora')
    showToast(`🔍 按作者搜索: ${name}`)
  }

  w.__toggleFav = (id: number, btn: HTMLElement) => {
    const m = useModelStore.getState().processed.find(p => p.id === id)
    if (!m) return
    const added = toggleFav(m)
    btn.innerHTML = icon('star', 14)
    btn.classList.toggle('on', added)
    btn.classList.remove('pop')
    void btn.offsetWidth
    btn.classList.add('pop')
    updateTabs()
  }

  w.__deleteCard = async (id: number) => {
    const m = useModelStore.getState().processed.find(p => p.id === id)
    const name = m?.name || `#${id}`
    if (!await confirmModal('永久删除', `确认永久删除「${name}」？\n此操作不可恢复！`)) return
    // 永久删除：从已加载数据与缓存中剔除，并清除隐藏记录（不可恢复）
    const store = useModelStore.getState()
    const raw = store.raw.filter(m => m.id !== id)
    store.setRaw(raw)
    store.rebuild()
    removeHidden(id)
    Cache.save(cacheKey(store), raw)
    refreshView()
    updateTabs()
    showToast('🗑️ 已永久删除', 'success')
  }

  w.__addViewHistory = (data: { id: number; uid: number; name: string; creator: string; url: string; category: string; thumb: string }) => {
    addView({ ...data, time: Date.now() })
  }

  w.__openLightbox = (imgs: string[], idx: number) => openLightbox(imgs, idx)

  // ── 探索历史回看面板 ──
  w.__showExploreHistory = () => {
    document.getElementById('exploreHistOverlay')?.remove()
    const list = loadExploreHist()
    const SORT_LBL: Record<string, string> = { 'Most Downloaded': '下载量', 'Highest Rated': '评分', 'Most Collected': '收藏', 'Newest': '最新发布', 'Most Discussed': '讨论', 'LikeRatio': '赞比' }
    const PERIOD_LBL: Record<string, string> = { AllTime: '全部', Year: '今年', Month: '本月', Week: '本周', Day: '今日' }
    const overlay = document.createElement('div')
    overlay.id = 'exploreHistOverlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px'
    const panel = document.createElement('div')
    panel.style.cssText = 'background:var(--bg1);border:1px solid var(--border);border-radius:14px;max-width:880px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden'
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="font-weight:700;font-size:14px">🕘 探索历史${list.length ? `（最近 ${list.length} 次）` : ''}</div>
        <button class="eh-close btn btn-ghost" style="padding:4px 8px">${icon('x', 14)}</button>
      </div>
      <div style="overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:16px">
        ${list.length === 0 ? '<div style="color:var(--text3);font-size:13px;padding:24px;text-align:center">还没有探索记录，点「随机探索」开始</div>' : list.map(e => `
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;color:var(--text2)">
              <span style="font-weight:600">${esc(SORT_LBL[e.sort] || e.sort)} · ${esc(PERIOD_LBL[e.period] || e.period)}${e.tag ? ' · ' + esc(e.tag) : ' · 全类别'}</span>
              <span style="color:var(--text3)">${new Date(e.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${e.items.length} 个</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:8px">
              ${e.items.map(it => `
                <div class="eh-item" data-url="${escAttr(it.url)}" style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg2);cursor:pointer">
                  ${it.thumb ? `<img src="${esc(thumbUrl(it.thumb, 300))}" loading="lazy" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;display:block">` : '<div style="width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center;color:var(--text3)">🖼️</div>'}
                  <div style="padding:6px 8px">
                    <div style="font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(it.name)}">${esc(it.name)}</div>
                    <div style="font-size:10px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.creator)}</div>
                    ${it.versionId ? `<button class="eh-dl" data-vid="${it.versionId}" data-url="${escAttr(it.url)}" data-nm="${escAttr(it.name)}" style="margin-top:4px;width:100%;border:none;border-radius:6px;background:var(--accent-soft);color:var(--accent);font-size:10px;padding:3px 0;cursor:pointer">⬇ 后台下载</button>` : ''}
                  </div>
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>`
    overlay.appendChild(panel)
    overlay.addEventListener('click', ev => {
      if (ev.target === overlay) { overlay.remove(); return }
      const t = ev.target as HTMLElement
      if (t.closest('.eh-close')) { overlay.remove(); return }
      const dl = t.closest('.eh-dl') as HTMLElement | null
      if (dl) { void queueLoraDownload(dl.dataset.vid || '', dl.dataset.url || '', dl.dataset.nm || ''); return }
      const item = t.closest('.eh-item') as HTMLElement | null
      if (item?.dataset.url) window.open(item.dataset.url, '_blank', 'noopener')
    })
    document.body.appendChild(overlay)
  }

  w.__openLoraLightbox = (modelId: number, imgIdx: number) => {
    const m = useModelStore.getState().processed.find(p => p.id === modelId)
    if (m?.images?.length) openLightbox(m.images, imgIdx)
  }

  w.__copyWorkflowPrompt = (modelId: number, btn: HTMLElement) => {
    const m = useModelStore.getState().processed.find(p => p.id === modelId)
    if (!m || !m.trainedWords?.length) return
    const words = m.trainedWords.join(', ')
    const weight = '1.0'
    const comfyui = m.trainedWords.map(w => `<lora:${m.name.replace(/[^a-zA-Z0-9_]/g, '_')}:${weight}>`).join(' ')
    const prompt = `${words}, masterpiece, best quality, high quality, ${comfyui}`
    copyText(prompt, btn)
    showToast('⚡ 工作流 Prompt 已复制', 'success')
  }

  w.__toggleBatchMode = () => {
    useModelStore.getState().toggleBatchMode()
    const mode = useModelStore.getState().batchMode
    document.body.classList.toggle('batch-mode', mode)
    document.getElementById('batchBar')!.style.display = mode ? 'flex' : 'none'
    if (!mode) refreshView()
    showToast(mode ? '✂️ 选择模式已开启' : '✂️ 选择模式已关闭')
  }

  w.__toggleBatchSelect = (id: number) => {
    useModelStore.getState().toggleBatchSelect(id)
    const count = useModelStore.getState().batchSelected.size
    document.getElementById('batchCount')!.textContent = `已选 ${count} 项`
    refreshView()
  }

  w.__batchFavorite = () => {
    const store = useModelStore.getState()
    const ids = [...store.batchSelected]
    for (const id of ids) {
      const m = store.processed.find(p => p.id === id)
      if (m) toggleFav(m)
    }
    showToast(`⭐ 已收藏 ${ids.length} 个模型`, 'success')
    store.clearBatch()
    document.body.classList.remove('batch-mode')
    document.getElementById('batchBar')!.style.display = 'none'
    refreshView()
    updateTabs()
  }

  w.__batchHide = async () => {
    const store = useModelStore.getState()
    const ids = [...store.batchSelected]
    if (ids.length === 0) return
    if (!await confirmModal('批量永久删除', `确认永久删除选中的 ${ids.length} 个模型？\n此操作不可恢复！`)) return
    // 批量永久删除：从已加载数据与缓存中剔除（不可恢复）
    const idSet = new Set(ids)
    const raw = store.raw.filter(m => !idSet.has(m.id))
    store.setRaw(raw)
    store.rebuild()
    ids.forEach(id => removeHidden(id))
    Cache.save(cacheKey(store), raw)
    showToast(`🗑️ 已永久删除 ${ids.length} 个模型`, 'success')
    store.clearBatch()
    document.body.classList.remove('batch-mode')
    document.getElementById('batchBar')!.style.display = 'none'
    refreshView()
  }

  w.__batchCopy = () => {
    const store = useModelStore.getState()
    const ids = [...store.batchSelected]
    const words: string[] = []
    for (const id of ids) {
      const m = store.processed.find(p => p.id === id)
      if (m?.trainedWords) words.push(...m.trainedWords)
    }
    if (words.length === 0) { showToast('⚠️ 所选模型没有触发词'); return }
    copyText(words.join(', '))
    showToast(`📋 已复制 ${words.length} 个触发词`, 'success')
  }

  w.__extractPrompt = async (modelId: number, word: string, btn: HTMLElement) => {
    try {
      const store = useModelStore.getState()
      const m = store.processed.find(p => p.id === modelId)
      if (!m) { showToast('⚠️ 未找到模型数据'); return }

      // Check if already extracted
      const count = await getPromptCountByModel(modelId)

      btn.innerHTML = icon('check', 12)
      btn.style.background = 'var(--green-dim)'

      const modal = document.getElementById('promptEditModal')
      if (modal) {
        modal.dataset.editId = 'new_' + Date.now()
        modal.dataset.sourceModelId = String(m.id)
        modal.dataset.sourceModelName = m.name
        modal.dataset.sourceModelUrl = m.url
        modal.dataset.sourceModelCategory = m.category
        modal.dataset.promptImages = JSON.stringify(m.images || [])
        modal.dataset.editTags = m.tags?.join(',') || word
      }

      // Prefill editor
      const { renderPromptEditor } = await import('../components/PromptEditor')
      renderPromptEditor({
        id: 'prefill',
        prompt: word,
        displayText: word,
        tags: m.tags || [],
        loras: [],
        categoryId: 'uncategorized',
        notes: count > 0 ? `📦 已从该模型提取 ${count + 1} 个 Prompt` : '',
        images: m.images || [],
        primaryImage: m.images?.[0] || '',
      })

      const { openModal } = await import('../components/Modal')
      openModal('promptEditModal')

      showToast('📥 已预填 Prompt 信息，点击保存即可加入库中', 'success')
    } catch (err) {
      showToast('❌ 提取失败: ' + (err as Error).message)
    }
  }

  w.__editArtistImages = (tag: string) => {
    const modal = document.getElementById('artistImgModal')
    const desc = document.getElementById('artistImgModalDesc')
    if (desc) desc.textContent = '为 ' + tag + ' 管理自定义预览图片'
    if (modal) {
      modal.setAttribute('data-artist-tag', tag)
      renderArtistImgList(tag)
    }
    ;(document.getElementById('artistImgUrl') as HTMLInputElement).value = ''
    setText('artistImgStatus', '')
    openModal('artistImgModal')
  }

  // 「➕ 添加」按钮(artistImgAddBtn)此前无 click 绑定,输入框回车白触发(Modal.ts 只绑定 Enter→click)
  document.getElementById('artistImgAddBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('artistImgModal')
    const tag = modal?.getAttribute('data-artist-tag') || ''
    const input = document.getElementById('artistImgUrl') as HTMLInputElement
    const url = (input?.value || '').trim()
    if (!tag) { showToast('⚠️ 请先打开某位画师的「管理预览图」'); return }
    if (!url) { showToast('⚠️ 请粘贴图片 URL'); return }
    addArtistImage(tag, url)
    if (input) input.value = ''
    setText('artistImgStatus', '✅ 已添加')
    renderArtistImgList(tag)
    renderArtists()
    showToast('✅ 已添加预览图')
  })

  w.__removeArtistImg = (tag: string, url: string) => {
    removeArtistImage(tag, url)
    renderArtistImgList(tag)
    renderArtists()
  }

  w.__deleteArtist = (tag: string) => {
    deleteArtist(tag)
    renderArtists()
    showToast('🗑️ 已删除画师 ' + tag)
  }

  w.renderArtists = renderArtists
  w.addArtistFromExtraction = addArtistFromExtraction
  w.showToast = showToast

  w.__deleteCol = (colId: string) => {
    deleteCollection(colId)
    renderColManageList()
    refreshView()
  }

  // Lightbox event listeners
  document.querySelector('.lightbox .close')?.addEventListener('click', () => closeLightbox())
  document.querySelectorAll('.lightbox .lb-nav').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const dir = parseInt((b as HTMLElement).dataset.dir || ((b as HTMLElement).classList.contains('prev') ? '-1' : '1'))
      navLightbox(dir)
    })
  })
  document.getElementById('lightbox')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLightbox()
  })

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const lightbox = document.getElementById('lightbox')
    if (lightbox?.classList.contains('open')) {
      if (e.key === 'Escape') closeLightbox()
      if (e.key === 'ArrowLeft') { e.preventDefault(); navLightbox(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); navLightbox(1) }
    } else {
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !(e.target as HTMLElement).closest('input,textarea')) {
        randomPick()
      }
    }
  })
}

export function setupBindingListeners() {
  // Section switching
  document.getElementById('mainTabs')?.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.main-tab') as HTMLElement
    if (tab) switchSection(tab.dataset.section as 'lora' | 'artist' | 'prompt' | 'local' | 'outputs')
  })

  // Category tabs —— 本地分类过滤；浏览模式（无远程查询）下点击角色/画风等类别
  // 会用类别对应 Civitai tag 发起远程搜索，扩大结果面
  const CAT_REMOTE_TAG: Record<string, string> = {
    character: 'character',
    artist: 'style',
    aesthetic: 'aesthetic',
    background: 'background',
  }
  // 记录类别 tab 自动设置的远程 tag，切回「全部/收藏/隐藏」时清除，避免残留过滤
  let autoCategoryTag: string | null = null
  document.getElementById('tabsContainer')?.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab') as HTMLElement
    if (tab) {
      const cat = tab.dataset.cat || 'all'
      const store = useModelStore.getState()
      store.setCategory(cat)
      const remoteTag = CAT_REMOTE_TAG[cat]
      if (remoteTag && !store.remoteQuery.trim()) {
        // 浏览模式：用类别 tag 远程搜索，扩大覆盖面
        store.setRemoteTags([remoteTag])
        autoCategoryTag = remoteTag
        const tagInput = document.getElementById('tagInput') as HTMLInputElement
        if (tagInput) tagInput.value = remoteTag
        resetAndFetch()
      } else {
        if (!remoteTag && autoCategoryTag) {
          // 切回全部/收藏/隐藏等：清除类别自动 tag，保留用户手动输入的 tag
          store.setRemoteTags(store.remoteTags.filter(t => t !== autoCategoryTag))
          autoCategoryTag = null
          const tagInput = document.getElementById('tagInput') as HTMLInputElement
          if (tagInput) tagInput.value = store.remoteTags.join(', ')
          resetAndFetch()
        } else {
          refreshView()
        }
      }
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  })

  // Collection sub-tabs
  document.getElementById('colTabs')?.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab') as HTMLElement
    if (!tab) return
    const colId = tab.dataset.colid
    if (colId) {
      setActiveCol(colId)
      refreshView()
    } else if (tab.id === 'manageColBtn') {
      openColManage()
    }
  })

  // Search —— 输入时先本地过滤即时响应，防抖 600ms 后发起远程搜索（query 参数）
  const searchInput = document.getElementById('searchInput') as HTMLInputElement
  if (searchInput) {
    let searchTimer: ReturnType<typeof setTimeout>
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer)
      useModelStore.getState().setSearch(searchInput.value)
      refreshView()
      searchTimer = setTimeout(() => {
        useModelStore.getState().setRemoteQuery(searchInput.value)
        resetAndFetch()
      }, 600)
    })
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimer)
        useModelStore.getState().setRemoteQuery(searchInput.value)
        resetAndFetch()
        addSearch(searchInput.value)
        renderSearchHistory()
      }
    })
    searchInput.addEventListener('focus', () => renderSearchHistory())
    document.addEventListener('click', (e) => {
      const dd = document.getElementById('searchHistory')
      if (dd && !(e.target as HTMLElement).closest('.search-wrap')) dd.style.display = 'none'
    })
  }

  // 空状态里的可操作按钮：一键清除"把结果全筛掉"的那一条条件
  document.getElementById('grid')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-clear]') as HTMLElement | null
    if (!btn) return
    const key = btn.dataset.clear || ''
    const reSearch = btn.dataset.research === '1'
    const store = useModelStore.getState()
    if (key === 'baseModel') {
      store.setFilterBaseModel('')
      const sel = document.getElementById('baseModelFilter') as HTMLSelectElement | null
      if (sel) sel.value = ''
      showToast('🗂️ 已放宽为「全部基座」')
    } else if (key === 'search') {
      store.setSearch('')
      const input = document.getElementById('searchInput') as HTMLInputElement | null
      if (input) input.value = ''
      showToast('🔍 已清空关键词')
    } else if (key === 'quality') {
      store.setQualityFilter('all')
      const sel = document.getElementById('qualityFilter') as HTMLSelectElement | null
      if (sel) sel.value = 'all'
      showToast('📋 已恢复「全部」质量筛选')
    } else if (key === 'category') {
      store.setCategory('all')
      showToast('📂 已切回「全部」分类')
    } else return
    updateTabs()
    if (reSearch) resetAndFetch()
    else refreshView()
  })

  // Sort —— 赞比是本地排序（API 无此参数），其余走远程 sort 参数
  document.getElementById('sortSelect')?.addEventListener('change', (e) => {
    const sort = (e.target as HTMLSelectElement).value as SortKey
    useModelStore.getState().setSort(sort)
    if (sort === 'LikeRatio') {
      showToast('📊 已按赞比（点赞/下载）排序已加载结果')
      refreshView()
      return
    }
    resetAndFetch()
  })

  // Quality filter
  document.getElementById('qualityFilter')?.addEventListener('change', (e) => {
    useModelStore.getState().setQualityFilter((e.target as HTMLSelectElement).value)
    refreshView()
  })

  // BaseModel —— 远程限定（Civitai API baseModels 参数）
  document.getElementById('baseModelFilter')?.addEventListener('change', (e) => {
    useModelStore.getState().setFilterBaseModel((e.target as HTMLSelectElement).value)
    resetAndFetch()
  })

  // NSFW 过滤（Civitai API nsfw 参数）
  document.getElementById('nsfwFilter')?.addEventListener('change', (e) => {
    useModelStore.getState().setNsfw((e.target as HTMLSelectElement).value as 'all' | 'sfw')
    resetAndFetch()
  })

  // 标签过滤（Civitai API tag 参数，逗号分隔）
  const tagInput = document.getElementById('tagInput') as HTMLInputElement
  if (tagInput) {
    let tagTimer: ReturnType<typeof setTimeout>
    tagInput.addEventListener('input', () => {
      clearTimeout(tagTimer)
      tagTimer = setTimeout(() => {
        const tags = tagInput.value.split(/[,，]/).map(t => t.trim()).filter(Boolean)
        useModelStore.getState().setRemoteTags(tags)
        resetAndFetch()
      }, 600)
    })
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(tagTimer)
        const tags = tagInput.value.split(/[,，]/).map(t => t.trim()).filter(Boolean)
        useModelStore.getState().setRemoteTags(tags)
        resetAndFetch()
      }
    })
  }

  // Batch mode buttons
  document.getElementById('batchCloseBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__toggleBatchMode) w.__toggleBatchMode()
  })
  document.getElementById('batchFavBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__batchFavorite) w.__batchFavorite()
  })
  const batchHideBtn = document.getElementById('batchHideBtn') as HTMLButtonElement
  if (batchHideBtn) batchHideBtn.innerHTML = icon('trash', 14) + '<span style="margin-left:5px">批量删除</span>'
  document.getElementById('batchHideBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__batchHide) w.__batchHide()
  })
  // 清空历史隐藏记录(之前隐藏的数据一并永久清理)
  const clearHiddenBtn = document.getElementById('clearHiddenBtn') as HTMLButtonElement
  if (clearHiddenBtn) clearHiddenBtn.innerHTML = icon('trash', 14)
  document.getElementById('clearHiddenBtn')?.addEventListener('click', async () => {
    const n = hiddenCount()
    if (n === 0) { showToast('没有隐藏记录'); return }
    if (await confirmModal('清空隐藏记录', `确认清除 ${n} 条历史隐藏记录？清理后这些 LoRA 可被再次抓取显示。`)) {
      clearHidden()
      refreshView()
      updateTabs()
      showToast('🧹 隐藏记录已清空', 'success')
    }
  })
  document.getElementById('batchCopyBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__batchCopy) w.__batchCopy()
  })

  // Buttons
  const loadMoreBtn = document.getElementById('loadMoreBtn') as HTMLButtonElement
  if (loadMoreBtn) loadMoreBtn.innerHTML = icon('arrowDown', 14) + '<span style="margin-left:5px">加载更多</span>'
  document.getElementById('loadMoreBtn')?.addEventListener('click', () => loadMore())
  // 页码导航：上一页 / 下一页 / 输入跳转
  const pagePrevBtn = document.getElementById('pagePrevBtn') as HTMLButtonElement
  if (pagePrevBtn) {
    pagePrevBtn.innerHTML = icon('chevronLeft', 14) + '<span style="margin-left:5px">上一页</span>'
    pagePrevBtn.addEventListener('click', () => goToPage(useModelStore.getState().page - 1))
  }
  const pageNextBtn = document.getElementById('pageNextBtn') as HTMLButtonElement
  if (pageNextBtn) {
    pageNextBtn.innerHTML = '<span style="margin-right:5px">下一页</span>' + icon('chevronRight', 14)
    pageNextBtn.addEventListener('click', () => goToPage(useModelStore.getState().page + 1))
  }
  const pageJumpInput = document.getElementById('pageJumpInput') as HTMLInputElement
  const doJump = () => {
    const v = parseInt(pageJumpInput.value, 10)
    if (!isNaN(v)) goToPage(v)
  }
  if (pageJumpInput) {
    pageJumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump() })
    pageJumpInput.addEventListener('change', doJump)
  }
  // 触底自动加载已交由 renderGrid 的 grid.onscroll 处理（虚拟滚动容器内部滚动）
  // 快速抓取按钮:图标由 icon() 生成(符合色调);前三个为定向类别,骰子为随机探索
  ;([
    { id: 'fetchCharBtn', iconName: 'user', tag: 'character' },
    { id: 'fetchLightBtn', iconName: 'zap', tag: 'lighting' },
    { id: 'fetchStyleBtn', iconName: 'palette', tag: 'style' },
    { id: 'fetchRandomBtn', iconName: 'dice', tag: null },
  ] as { id: string; iconName: string; tag: string | null }[]).forEach(({ id, iconName, tag }) => {
    const btn = document.getElementById(id) as HTMLButtonElement
    if (!btn) return
    const label = btn.dataset.label || ''
    btn.innerHTML = icon(iconName, 14) + (label ? '<span style="margin-left:5px">' + label + '</span>' : '')
    btn.addEventListener('click', () => (tag ? quickFetchByTag(tag) : randomExploreFetch()))
  })
  const exploreHistBtn = document.getElementById('exploreHistBtn') as HTMLButtonElement
  if (exploreHistBtn) {
    exploreHistBtn.innerHTML = icon('clock', 14)
    exploreHistBtn.addEventListener('click', () => (window as any).__showExploreHistory())
  }
  const batchModeBtn = document.getElementById('batchModeBtn') as HTMLButtonElement
  if (batchModeBtn) batchModeBtn.innerHTML = icon('checkSquare', 14)
  document.getElementById('batchModeBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__toggleBatchMode) w.__toggleBatchMode()
  })

  // Add LoRA modal
  const addLoraBtn = document.getElementById('addLoraBtn') as HTMLButtonElement
  if (addLoraBtn) addLoraBtn.innerHTML = icon('plus', 14)
  document.getElementById('addLoraBtn')?.addEventListener('click', () => {
    openModal('addModal')
    const input = document.getElementById('addUrlInput') as HTMLInputElement
    if (input) { input.value = ''; input.focus() }
    setText('addStatus', '')
  })
  document.getElementById('addConfirmBtn')?.addEventListener('click', async () => {
    const url = (document.getElementById('addUrlInput') as HTMLInputElement).value.trim()
    const status = document.getElementById('addStatus')
    if (!url) { if (status) status.textContent = '⚠️ 请输入 Civitai URL'; return }
    if (status) status.textContent = '⏳ 正在获取…'
    try {
      const idStr = parseCivitaiModelId(url)
      if (!idStr) throw new Error('❌ 无效的 Civitai URL（civitai.com / civitai.red 均可）')
      const id = parseInt(idStr)
      if (isNaN(id) || id <= 0) throw new Error('❌ 无法从 URL 中提取模型 ID')
      const customList = Cache.load<any[]>('custom_loras', 365 * 24 * 60 * 60 * 1000) || []
      if (customList.some((c: any) => c.id === id)) throw new Error('⚠️ 该 LoRA 已添加过')
      const data = await fetchModelById(id)
      if (!data?.id) throw new Error('❌ 未能获取模型信息')
      customList.unshift(data)
      if (customList.length > 100) customList.length = 100
      Cache.save('custom_loras', customList)
      if (status) status.textContent = '✅ 添加成功！'
      useModelStore.getState().rebuild()
      refreshView()
      setTimeout(() => closeModal('addModal'), 1500)
    } catch (err) {
      if (status) status.textContent = (err as Error).message
    }
  })

  // Collection management buttons
  document.getElementById('createColBtn')?.addEventListener('click', () => {
    const input = document.getElementById('newColName') as HTMLInputElement
    const name = input.value.trim()
    if (!name) { showToast('⚠️ 请输入收藏夹名称'); return }
    createCollection(name)
    input.value = ''
    renderColManageList()
    refreshView()
    showToast('✅ 收藏夹「' + name + '」已创建', 'success')
  })
  document.getElementById('exportFavBtn')?.addEventListener('click', () => {
    const data = exportFavData()
    if (!data) { showToast('⚠️ 没有可导出的数据'); return }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'civitai_favorites_' + new Date().toISOString().slice(0, 10) + '.json'
    a.click()
    URL.revokeObjectURL(url)
    showToast('📤 收藏夹已导出', 'success')
  })
  document.getElementById('importFavBtn')?.addEventListener('click', () => {
    document.getElementById('importFavFile')?.click()
  })
  document.getElementById('importFavFile')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string)
        if (importFavData(data)) {
          renderColManageList()
          refreshView()
          showToast('📥 收藏夹已导入', 'success')
        } else {
          showToast('⚠️ 无效的收藏夹数据格式')
        }
      } catch (err) {
        showToast('❌ 导入失败: ' + (err as Error).message)
      }
    }
    reader.readAsText(file)
    ;(e.target as HTMLInputElement).value = ''
  })

  // Extract from current search results（类型可选 + 阈值 + 过滤规则）
  let extractType: 'artist' | 'character' | 'style' = 'artist'
  let extractMinCount = 1

  function renderExtractList() {
    const store = useModelStore.getState()
    const processed = store.processed
    const container = document.getElementById('artistExtractList')
    if (!container) return
    const desc = document.getElementById('artistExtractDesc')
    if (desc) desc.textContent = `从当前搜索结果（${processed.length} 个 LoRA）的触发词中提取`
    const found = extractTagsFromModels(processed, extractType, extractMinCount)
    const existing = new Set(getArtists().map(a => a.tag))
    const newCount = found.filter(f => !existing.has(f.tag)).length
    const typeIcon = extractType === 'artist' ? '🎨' : extractType === 'character' ? '👤' : '🏷️'
    const label = { artist: '画师', character: '角色', style: '风格词' }[extractType]

    if (found.length === 0) {
      container.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text3);font-size:12px">当前结果中未提取到${label}标签<br>（可先远程搜索缩小范围，或调低阈值）</div>`
      return
    }

    container.innerHTML = `<div style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center">
      <span style="font-size:12px;color:var(--text2)">发现 <b>${found.length}</b> 个${label}，<b style="color:var(--green)">${newCount}</b> 个可添加</span>
      ${extractType === 'artist' && newCount > 0 ? `<button class="btn btn-primary" id="extractAddAllBtn" style="padding:4px 12px;font-size:10px;margin-left:auto">${icon('plus', 12)} 添加全部 (${newCount})</button>` : ''}
    </div>`
    + found.map(f => {
      const already = existing.has(f.tag)
      const sources = f.sources || []
      const action = extractType === 'artist'
        ? (already
          ? '<span style="font-size:10px;color:var(--text3);white-space:nowrap">✅ 已存在</span>'
          : `<button class="btn btn-primary extract-add-one" data-tag="${escAttr(f.tag)}" data-count="${f.count}" style="padding:3px 10px;font-size:10px;white-space:nowrap">${icon('plus', 12)} 添加</button>`)
        : `<button class="btn btn-ghost extract-search-one" data-tag="${escAttr(f.tag)}" style="padding:3px 10px;font-size:10px;white-space:nowrap">${icon('search', 12)} 搜索</button>`
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)">
        <span style="font-size:16px;width:24px;text-align:center">${typeIcon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-family:'Courier New',monospace;color:var(--accent)">${esc(f.tag)}</div>
          <div style="font-size:9px;color:var(--text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            出现 ${f.count} 次 · 来源: ${sources.slice(0, 3).join(', ')}${sources.length > 3 ? ` 等 ${sources.length} 个模型` : ''}
          </div>
        </div>
        ${action}
      </div>`
    }).join('')
  }

  document.getElementById('extractArtistBtn')?.addEventListener('click', () => {
    const store = useModelStore.getState()
    if (store.processed.length === 0) { showToast('⚠️ 当前没有已加载的 LoRA，先搜索或抓取'); return }
    renderExtractList()
    openModal('artistExtractModal')
  })

  // 类型切换
  document.getElementById('artistExtractModal')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const typeBtn = target.closest('.extract-type-btn') as HTMLElement
    if (typeBtn) {
      extractType = typeBtn.dataset.type as 'artist' | 'character' | 'style'
      document.querySelectorAll('.extract-type-btn').forEach(b => {
        const active = b === typeBtn
        b.classList.toggle('btn-primary', active)
        b.classList.toggle('btn-ghost', !active)
      })
      renderExtractList()
      return
    }
    if (target.id === 'extractMinCountBtn') {
      extractMinCount = extractMinCount >= 3 ? 1 : extractMinCount + 1
      target.textContent = `≥${extractMinCount}次`
      renderExtractList()
      return
    }
  })

  // 角色/风格词：点击直接远程搜索该词
  document.getElementById('artistExtractModal')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.extract-search-one') as HTMLElement
    if (btn) {
      const tag = btn.dataset.tag || ''
      closeModal('artistExtractModal')
      const w = window as any
      if (w.__searchByTag) w.__searchByTag(tag)
    }
  })

  // Extract modal event delegation (add single / add all)
  document.getElementById('artistExtractModal')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement

    if (target.id === 'extractAddAllBtn') {
      const btns = document.querySelectorAll('#artistExtractList .extract-add-one:not([disabled])')
      let added = 0
      btns.forEach(btn => {
        const tag = (btn as HTMLElement).dataset.tag
        const count = parseInt((btn as HTMLElement).dataset.count || '1')
        if (tag && addArtistFromExtraction(tag, count)) added++
        btn.setAttribute('disabled', 'disabled')
      })
      if (added > 0) {
        showToast(`✅ 已添加 ${added} 个画师`, 'success')
        renderArtists()
        renderExtractList()
      }
      return
    }

    const addBtn = target.closest('.extract-add-one') as HTMLElement
    if (addBtn) {
      const tag = addBtn.dataset.tag
      const count = parseInt(addBtn.dataset.count || '1')
      if (tag && addArtistFromExtraction(tag, count)) {
        showToast(`✅ 已添加 ${tag}`, 'success')
        renderArtists()
        renderExtractList()
      }
      return
    }
  })

  // Artist modals handled by ArtistSeries.ts bindArtistEvents()

  // Global gallery click delegation
  document.addEventListener('click', handleGalleryClick)

  // ── 版本下拉的「脱离裁切」处理 ──
  // .version-dropdown 是 position:absolute + bottom:100%，而卡片链路上有 3 层
  // overflow:hidden（.card-body → .card → .vs-card-wrap），浮层会被裁掉大半
  // （用户反馈「展开的选项被覆盖住一大部分」）。打开时临时解除「浮层 → 滚动容器」
  // 之间所有祖先的裁剪并把卡片抬到同级之上，关闭时逐级还原；上方放不下则改为向下展开。
  const DD_OPEN_Z = '40'

  const findScrollParent = (start: HTMLElement | null): HTMLElement | null => {
    let el = start
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY
      if (oy === 'auto' || oy === 'scroll') return el
      el = el.parentElement
    }
    return null
  }

  const releaseDropdownClip = (dd: HTMLElement) => {
    let el = dd.parentElement
    while (el && el !== document.body) {
      const raw = el.dataset.ddClip
      if (raw) {
        const prev = JSON.parse(raw) as { o: string; cv: string; z: string }
        el.style.overflow = prev.o
        el.style.contentVisibility = prev.cv
        el.style.zIndex = prev.z
        delete el.dataset.ddClip
      }
      el = el.parentElement
    }
  }

  const applyDropdownClip = (dd: HTMLElement) => {
    // 只解除「浮层自身 → 滚动容器」之间的裁剪；滚动容器本身必须保留，否则整页会跟着滚
    const scroller = findScrollParent(dd.parentElement)
    let el = dd.parentElement
    while (el && el !== document.body && el !== scroller) {
      const cs = getComputedStyle(el)
      if (cs.overflow !== 'visible' || cs.contentVisibility === 'auto') {
        el.dataset.ddClip = JSON.stringify({
          o: el.style.overflow, cv: el.style.contentVisibility, z: el.style.zIndex,
        })
        el.style.overflow = 'visible'
        if (cs.contentVisibility === 'auto') el.style.contentVisibility = 'visible'
        el.style.zIndex = DD_OPEN_Z
      }
      el = el.parentElement
    }
    // 上方放不下 → 翻到向下展开，避免被滚动容器顶边裁掉
    const ddRect = dd.getBoundingClientRect()
    const limit = scroller ? scroller.getBoundingClientRect().top : 0
    if (ddRect.top < limit + 4) {
      dd.style.bottom = 'auto'; dd.style.top = '100%'
      dd.style.marginTop = '4px'; dd.style.marginBottom = '0'
    } else {
      dd.style.bottom = '100%'; dd.style.top = 'auto'
      dd.style.marginTop = '0'; dd.style.marginBottom = '4px'
    }
  }

  const closeVersionDropdowns = (except?: HTMLElement | null) => {
    document.querySelectorAll<HTMLElement>('.version-dropdown').forEach((d) => {
      if (except && d === except) return
      if (getComputedStyle(d).display === 'none') return
      d.style.display = 'none'
      releaseDropdownClip(d)
    })
  }

  // Version dropdown：主按钮=展开/收起版本列表（**不直接下载**，2026-09-10 用户反馈
  // 「点一下就直接下载」误触多次 —— 必须经过「开列表 → 选版本」两步）；option=下载该版本
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const btn = target.closest('.version-dropdown-btn') as HTMLElement
    if (btn) {
      e.stopPropagation()
      const wrap = btn.closest('.version-dropdown-wrap') as HTMLElement
      if (!wrap) return
      const dd = wrap.querySelector('.version-dropdown') as HTMLElement
      closeVersionDropdowns(dd) // 关闭其他 dropdown
      if (getComputedStyle(dd).display === 'none') {
        dd.style.display = 'block'
        applyDropdownClip(dd)
      } else {
        dd.style.display = 'none'
        releaseDropdownClip(dd)
      }
      return
    }
    const opt = target.closest('.version-option') as HTMLElement
    if (opt) {
      e.stopPropagation()
      const vid = opt.dataset.vid || ''
      const url = opt.dataset.url || ''
      const nm = opt.dataset.nm || ''
      if (url || vid) { void queueLoraDownload(vid, url, nm) }
      const dd = opt.closest('.version-dropdown') as HTMLElement
      if (dd) { dd.style.display = 'none'; releaseDropdownClip(dd) }
      return
    }
    // 点击外部关闭所有 dropdown
    if (!target.closest('.version-dropdown-wrap')) {
      closeVersionDropdowns()
    }
  })

  // Period buttons
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setPeriod((btn as HTMLElement).dataset.period as 'AllTime' | 'Month' | 'Week')
    })
  })
}

function handleGalleryClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('.gallery-btn') as HTMLElement
  if (btn) {
    e.stopPropagation()
    const g = btn.closest('.gallery') as HTMLElement
    if (!g) return
    const t = g.querySelector('.gallery-track') as HTMLElement
    if (!t || t.children.length <= 1) return
    const card = btn.closest('.card') as HTMLElement
    const uid = parseInt(card?.dataset.uid || '0') || 0
    const cur = galleryPos[uid] ?? 0
    const n = cur + parseInt(btn.dataset.dir || '0')
    const imgs = t.children.length
    const clamped = ((n % imgs) + imgs) % imgs
    t.style.transform = `translateX(-${clamped * 100}%)`
    g.querySelectorAll('.gallery-dots span').forEach((s, i) => s.classList.toggle('active', i === clamped))
    galleryPos[uid] = clamped
    return
  }

  const img = (e.target as HTMLElement).closest('.gallery-track img') as HTMLElement
  if (img && img.dataset.uid) {
    e.stopPropagation()
    const idx = parseInt(img.dataset.imgidx || '0')
    const track = img.closest('.gallery-track')
    let fullUrls: string[] = []
    if (track) {
      fullUrls = [...track.querySelectorAll('img')].map(el => (el as HTMLElement).dataset.fullurl || (el as HTMLImageElement).src).filter(Boolean)
    }
    if (fullUrls.length > 0) openLightbox(fullUrls, idx)
    return
  }

  const dot = (e.target as HTMLElement).closest('.gallery-dots span') as HTMLElement
  if (dot && dot.dataset.uid) {
    e.stopPropagation()
    const g = dot.closest('.gallery') as HTMLElement
    if (!g) return
    const t = g.querySelector('.gallery-track') as HTMLElement
    if (!t) return
    const idx = parseInt(dot.dataset.imgidx || '0')
    t.style.transform = `translateX(-${idx * 100}%)`
    g.querySelectorAll('.gallery-dots span').forEach((s, i) => s.classList.toggle('active', i === idx))
    const uid = parseInt(dot.dataset.uid || g.dataset.uid || '0')
    if (uid) galleryPos[uid] = idx
  }
}
