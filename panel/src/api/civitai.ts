import type { CivitaiResponse, PeriodKey } from '../types'
import { sleep, showToast, stripHtml } from '../utils'

let controller: AbortController | null = null

export async function fetchModels(page: number, period: PeriodKey): Promise<CivitaiResponse | null> {
  if (controller) controller.abort()
  controller = new AbortController()

  const url = `https://civitai.com/api/v1/models?types=LORA&baseModels=Anima&sort=${encodeURIComponent('Most Downloaded')}&limit=100&period=${period}&page=${page}`

  try {
    const resp = await fetch(url, { signal: controller.signal })
    if (resp.status === 429) {
      showToast('⚠️ API 限流，等待重试…')
      await sleep(3000)
      return fetchModels(page, period)
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null
    throw err
  }
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
