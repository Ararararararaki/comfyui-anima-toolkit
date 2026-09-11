import type { CivitaiResponse, PeriodKey, SortKey } from '../types'
import { sleep, showToast, stripHtml } from '../utils'
import { Cache } from '../store/cache'

let controller: AbortController | null = null

export interface ModelFetchParams {
  query?: string
  baseModels?: string
  sort?: SortKey
  nsfw?: 'all' | 'sfw'
  tags?: string[]
  period?: PeriodKey
  limit?: number
}

const DEFAULT_HOST = 'https://civitai.com'
/** 面板本地排序项（API 不支持），请求时必须回退到合法的远程排序值 */
const API_SORTS = ['Most Downloaded', 'Highest Rated', 'Newest', 'Most Discussed', 'Most Collected']

/** C 站接口线路：默认 civitai.com，可在设置里切到镜像站（部分网络下 .com 不可达） */
export function getCivitaiHost(): string {
  try {
    const raw = (localStorage.getItem('anima_civitai_host') || '').trim().replace(/\/+$/, '')
    if (!raw) return DEFAULT_HOST
    return /^https?:\/\//i.test(raw) ? raw : 'https://' + raw
  } catch { return DEFAULT_HOST }
}

export function setCivitaiHost(host: string): void {
  try {
    const v = (host || '').trim().replace(/\/+$/, '')
    if (!v || v === DEFAULT_HOST) localStorage.removeItem('anima_civitai_host')
    else localStorage.setItem('anima_civitai_host', v)
  } catch { /* 存储不可用时忽略 */ }
}

function apiBase(path: string): string {
  return `${getCivitaiHost()}/api/v1${path}`
}

/**
 * 从 Civitai 模型页 URL 提取模型 ID（2026-09-12 修）。
 * 此前各处写死 `civitai\.com`，用户浏览器走镜像 civitai.red 时粘贴镜像链接直接解析失败。
 * 现兼容 civitai.com / civitai.red / 任意 civitai 子域与未来镜像域名（含 ?modelVersionId= 等查询参数）。
 */
export function parseCivitaiModelId(url: string): string | null {
  const m = url.match(/(?:[a-z0-9-]+\.)*civitai\.[a-z]{2,}(?:\.[a-z]{2,})?\/models\/(\d+)/i)
  return m ? m[1] : null
}

/** 带 HTTP 状态的错误：便于上层按 401/403/429/5xx 区分展示，而不是静默吞掉 */
export class CivitaiHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'CivitaiHttpError'
    this.status = status
  }
}

/** 首屏（无 cursor）缓存 TTL：同一 query 的重复请求直接走缓存，避免重复打 C 站 */
const MODELS_CACHE_TTL = 5 * 60 * 1000

/**
 * 缓存 key 单一来源：与取数参数一一对应，避免不同筛选条件串数据。
 * 与 LoraExplorer 旧 cacheKey 同构，但用 v2 前缀隔离旧缓存（旧缓存只存 raw 缺 nextCursor，不可直接复用）。
 */
export function modelsCacheKey(params: ModelFetchParams): string {
  return `models_v2_${params.period ?? 'AllTime'}_${params.sort ?? ''}_${params.baseModels || 'all'}_${params.nsfw ?? 'all'}_${(params.query || '').trim()}_${(params.tags || []).join(',')}`
}

/** 只读 API Key（设置 → C 站 API Key）。带 token 时能取到登录级浏览内容 */
function readToken(): string {
  try { return (localStorage.getItem('anima_civitai_token') || '').trim() } catch { return '' }
}

/** 给 API URL 附加 token（已有 query 时用 & 拼接） */
function withToken(url: string): string {
  const token = readToken()
  if (!token) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}

export function buildModelsUrl(params: ModelFetchParams, cursor?: string | null): string {
  const sp = new URLSearchParams()
  sp.set('types', 'LORA')
  if (params.query?.trim()) sp.set('query', params.query.trim())
  if (params.baseModels) sp.set('baseModels', params.baseModels)
  if (params.sort && API_SORTS.includes(params.sort)) sp.set('sort', params.sort)
  // ⚠️ 必须显式传 nsfw：Civitai API 省略该参数时按「仅 SFW」返回
  // （实测 query=pussy：不传 19 条全是 SFW；传 nsfw=true 后 20 条里 14 条为 NSFW）
  sp.set('nsfw', params.nsfw === 'sfw' ? 'false' : 'true')
  const token = readToken()
  if (token) sp.set('token', token)
  if (params.tags && params.tags.length > 0) sp.set('tag', params.tags.join(','))
  if (params.period) sp.set('period', params.period)
  sp.set('limit', String(params.limit ?? 100))
  if (cursor) sp.set('cursor', cursor)
  return apiBase('/models') + '?' + sp.toString()
}

async function getJson(url: string, signal?: AbortSignal): Promise<CivitaiResponse | null> {
  // 429 限流与 503 搜索服务过载均自动重试（实测 query 搜索会偶发 503）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { signal })
      if (resp.status === 429 || resp.status === 503) {
        showToast(attempt === 0 ? '⚠️ API 限流/过载，等待重试…' : `⚠️ 重试中…(${attempt + 1}/3)`)
        await sleep(3000)
        continue
      }
      if (!resp.ok) throw new CivitaiHttpError(resp.status, `HTTP ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`)
      return resp.json()
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null
      if (attempt < 2) { await sleep(2000); continue }
      throw err
    }
  }
  return null
}

/**
 * 抓取模型列表。不传 cursor 时按当前筛选构造新 URL（第一页）；
 * 传 cursor 时使用 Civitai 返回的 nextPage URL（含 cursor）直接翻页。
 * 注意：API 已改为 cursor 分页，page 参数不再生效（实测 page=1/2 返回相同数据）。
 */
export async function fetchModels(params: ModelFetchParams, cursor?: string | null): Promise<CivitaiResponse | null> {
  // 仅首屏（无 cursor）走缓存：翻页靠 API 返回的 nextCursor，必须实时请求，不可复用旧结果
  if (!cursor) {
    const hit = Cache.load<CivitaiResponse>(modelsCacheKey(params), MODELS_CACHE_TTL)
    if (hit && Array.isArray(hit.items)) {
      console.debug('[civitai] 命中缓存', modelsCacheKey(params), '条数', hit.items.length)
      return hit
    }
  }
  // 新请求中止上一请求：避免慢响应把旧结果写进新列表（数据串味/闪烁的根因）
  if (controller) controller.abort()
  controller = new AbortController()
  const url = buildModelsUrl(params, cursor)
  const data = await getJson(url, controller.signal)
  if (data) {
    if (!cursor) {
      Cache.save(modelsCacheKey(params), data)
      console.debug('[civitai] 请求完成(已写缓存)', url, '返回', data.items?.length ?? 0)
    } else {
      console.debug('[civitai] 翻页完成', 'cursor=', (cursor || '').slice(0, 16), '返回', data.items?.length ?? 0)
    }
  }
  return data
}

export async function fetchModelById(id: number): Promise<CivitaiResponse['items'][0] | null> {
  const resp = await fetch(withToken(apiBase(`/models/${id}`)))
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export async function fetchModelVersionByHash(hash: string): Promise<{
  modelId: number; modelName: string; versionId: number; versionName: string;
  trainedWords: string[]; images: string[];
  creator: string; description: string; downloadCount: number;
  thumbsUpCount: number; baseModel: string; tags: string[]; nsfw: boolean
} | null> {
  const url = withToken(apiBase(`/model-versions/by-hash/${hash.toLowerCase()}`))
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) {
      if (resp.status === 404) return null
      if (resp.status === 429) { await sleep(3000); return fetchModelVersionByHash(hash) }
      return null
    }
    const d = await resp.json()
    const imgs = (d.images || [])
      .filter((i: { type: string }) => i.type === 'image')
      .map((i: { url: string }) => {
        let u = i.url.trim()
        if (u.startsWith('//')) u = 'https:' + u
        return u.startsWith('http') ? u : ''
      })
      .filter(Boolean)
    return {
      modelId: d.modelId,
      modelName: d.model?.name || d.modelName || '',
      versionId: d.id,
      versionName: d.name || '',
      trainedWords: d.trainedWords || [],
      images: imgs,
      creator: d.model?.creator?.username || d.creator?.username || '',
      description: stripHtml(d.model?.description || ''),
      downloadCount: d.model?.stats?.downloadCount ?? d.stats?.downloadCount ?? 0,
      thumbsUpCount: d.model?.stats?.thumbsUpCount ?? d.stats?.thumbsUpCount ?? 0,
      baseModel: d.baseModel || '',
      tags: d.model?.tags || [],
      nsfw: !!(d.model?.nsfw || d.nsfw),
    }
  } catch {
    return null
  }
}

export async function fetchModelImages(modelId: number): Promise<string[]> {
  const url = withToken(apiBase(`/images?modelId=${modelId}&limit=3&sort=${encodeURIComponent('Most Reactions')}&period=AllTime&nsfw=true`))
  const resp = await fetch(url)
  if (!resp.ok) return []
  const data = await resp.json()
  return (data.items || [])
    .filter((i: { type: string; url: string }) => i.type === 'image' && i.url)
    .map((i: { url: string }) => { let u = i.url.trim(); if (u.startsWith('//')) u = 'https:' + u; return u.startsWith('http') ? u : '' })
    .filter(Boolean) as string[]
}
