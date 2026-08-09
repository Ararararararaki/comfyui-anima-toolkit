import type { CivitaiResponse, PeriodKey, SortKey } from '../types'
import { sleep, showToast, stripHtml } from '../utils'

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

const BASE_URL = 'https://civitai.com/api/v1/models'

export function buildModelsUrl(params: ModelFetchParams, cursor?: string | null): string {
  const sp = new URLSearchParams()
  sp.set('types', 'LORA')
  if (params.query?.trim()) sp.set('query', params.query.trim())
  if (params.baseModels) sp.set('baseModels', params.baseModels)
  if (params.sort) sp.set('sort', params.sort)
  if (params.nsfw === 'sfw') sp.set('nsfw', 'false')
  if (params.tags && params.tags.length > 0) sp.set('tag', params.tags.join(','))
  if (params.period) sp.set('period', params.period)
  sp.set('limit', String(params.limit ?? 100))
  if (cursor) sp.set('cursor', cursor)
  return `${BASE_URL}?${sp.toString()}`
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
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
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
  if (controller) controller.abort()
  controller = new AbortController()
  return getJson(buildModelsUrl(params, cursor), controller.signal)
}

export async function fetchModelById(id: number): Promise<CivitaiResponse['items'][0] | null> {
  const resp = await fetch(`https://civitai.com/api/v1/models/${id}`)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export async function fetchModelVersionByHash(hash: string): Promise<{
  modelId: number; modelName: string; versionId: number; versionName: string;
  trainedWords: string[]; images: string[];
  creator: string; description: string; downloadCount: number;
  thumbsUpCount: number; baseModel: string; tags: string[]; nsfw: boolean
} | null> {
  const url = `https://civitai.com/api/v1/model-versions/by-hash/${hash.toLowerCase()}`
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
  const url = `https://civitai.com/api/v1/images?modelId=${modelId}&limit=3&sort=${encodeURIComponent('Most Reactions')}&period=AllTime&nsfw=true`
  const resp = await fetch(url)
  if (!resp.ok) return []
  const data = await resp.json()
  return (data.items || [])
    .filter((i: { type: string; url: string }) => i.type === 'image' && i.url)
    .map((i: { url: string }) => { let u = i.url.trim(); if (u.startsWith('//')) u = 'https:' + u; return u.startsWith('http') ? u : '' })
    .filter(Boolean) as string[]
}
