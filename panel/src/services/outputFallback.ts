import type { ImageSnapshot } from './outputIdentity'

export interface OutputFallbackSettings { enabled: boolean; model: string; threshold: number; characterThreshold: number; includeUnrecognized: boolean; libraryMatching: boolean }
export interface OutputFallbackResult { status: 'complete' | 'deferred' | 'unavailable' | 'error'; reason?: string; cacheMiss?: boolean; error?: string; tags?: string[]; model?: string; version?: string }
const storageKey = 'outputs_fallback_wd14_v1'
let settings: OutputFallbackSettings = { enabled: true, model: '', threshold: 0.35, characterThreshold: 0.85, includeUnrecognized: false, libraryMatching: true }
let catalog = { models: [] as string[], defaultModel: '', modelVersion: '', error: '', libraryMatches: { count: 0, version: '' } }
const cacheMisses = new Set<string>()
const listeners = new Set<() => void>()
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
  if (typeof saved.enabled === 'boolean') settings.enabled = saved.enabled
  if (typeof saved.includeUnrecognized === 'boolean') settings.includeUnrecognized = saved.includeUnrecognized
  if (typeof saved.libraryMatching === 'boolean') settings.libraryMatching = saved.libraryMatching
  if (typeof saved.model === 'string') settings.model = saved.model
  for (const field of ['threshold', 'characterThreshold'] as const) if (typeof saved[field] === 'number' && Number.isFinite(saved[field]) && saved[field] >= 0 && saved[field] <= 1) settings[field] = saved[field]
} catch { /* Invalid preferences use the tested local-tagger defaults. */ }
export function outputFallbackSettings(): Readonly<OutputFallbackSettings> { return { ...settings } }
export function outputFallbackCatalog() { return { ...catalog, models: [...catalog.models] } }
export function outputFallbackVersion(): string { return JSON.stringify(['wd14-v2', catalog.modelVersion, settings.model || catalog.defaultModel, settings.threshold, settings.characterThreshold, settings.libraryMatching ? catalog.libraryMatches.version : '']) }
export function setOutputFallbackSettings(patch: Partial<OutputFallbackSettings>): void {
  const next = { ...settings, ...patch }
  for (const field of ['threshold', 'characterThreshold'] as const) if (!Number.isFinite(next[field]) || next[field] < 0 || next[field] > 1) throw new Error('WD14 阈值必须在 0 到 1 之间')
  localStorage.setItem(storageKey, JSON.stringify(next))
  settings = next
  for (const listener of listeners) listener()
}
export function subscribeOutputFallback(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
export async function refreshOutputFallbackCatalog(signal?: AbortSignal): Promise<void> {
  const response = await fetch('/anima/gallery/fallback', { signal })
  if (!response.ok) throw new Error(`WD14 后台接口 HTTP ${response.status}`)
  const result = await response.json()
  if (!Array.isArray(result.models) || result.models.some((model: unknown) => typeof model !== 'string')) throw new Error('WD14 模型列表无效')
  const matches = result.libraryMatches
  catalog = { models: result.models, defaultModel: result.defaultModel || '', modelVersion: result.modelVersion || '', error: result.error || '',
    libraryMatches: matches && Number.isInteger(matches.count) && matches.count >= 0 && typeof matches.version === 'string' ? { count: matches.count, version: matches.version } : { count: 0, version: '' } }
  for (const listener of listeners) listener()
}
/** External files stay in their authorised adapter; only one image reaches the local CPU service. */
export async function inferOutputFallback(snapshot: ImageSnapshot, signal: AbortSignal, readBlob: () => Promise<Blob | null>, cacheOnly = false): Promise<OutputFallbackResult> {
  const options = { model: settings.model || catalog.defaultModel, threshold: settings.threshold, character_threshold: settings.characterThreshold, library_matching: settings.libraryMatching }
  const deferred: OutputFallbackResult = { status: 'deferred', reason: 'memory-pressure', cacheMiss: true }
  const missKey = JSON.stringify([snapshot.key, outputFallbackVersion()])
  if (signal.aborted) throw new DOMException('补标签已取消', 'AbortError')
  if (cacheOnly && cacheMisses.has(missKey)) return deferred
  let blob: Blob | null = null
  if (settings.libraryMatching && catalog.libraryMatches.count && snapshot.size <= 64 * 1024 * 1024) {
    blob = await readBlob()
    if (!blob) throw new Error('图片未授权或已变更')
    if (blob.size <= 64 * 1024 * 1024) {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      if (signal.aborted) throw new DOMException('补标签已取消', 'AbortError')
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      const response = await fetch('/anima/gallery/fallback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ ...options, source: 'library', sha256 }) })
      if (!response.ok) throw new Error(`本机识别缓存 HTTP ${response.status}`)
      const result = await response.json() as OutputFallbackResult | { status: 'miss' }
      if (result.status === 'complete') {
        if (!Array.isArray(result.tags) || result.tags.some(tag => typeof tag !== 'string')) throw new Error('识别缓存标签无效')
        return result
      }
      if (result.status !== 'miss') throw new Error('识别缓存返回格式无效')
    }
    if (cacheMisses.size >= 50000) cacheMisses.clear()
    cacheMisses.add(missKey)
  }
  if (cacheOnly) return deferred
  let body: FormData | string
  let headers: HeadersInit | undefined
  if (snapshot.source === 'gallery') {
    body = JSON.stringify({ ...options, source: 'gallery', root: snapshot.root, path: snapshot.path, mtime: snapshot.mtime, size: snapshot.size })
    headers = { 'Content-Type': 'application/json' }
  } else {
    blob ||= await readBlob()
    if (!blob) throw new Error('图片未授权或已变更')
    body = new FormData(); body.append('image', blob, snapshot.file.filename); body.append('options', JSON.stringify(options))
  }
  if (signal.aborted) throw new DOMException('补标签已取消', 'AbortError')
  const response = await fetch('/anima/gallery/fallback', { method: 'POST', headers, body, signal })
  const result = await response.json() as OutputFallbackResult & { error?: string }
  if (!response.ok) throw new Error(result.error || `WD14 补标签 HTTP ${response.status}`)
  if (!['complete', 'deferred', 'unavailable', 'error'].includes(result.status)) throw new Error('WD14 补标签返回格式无效')
  if (result.status === 'complete' && (!Array.isArray(result.tags) || result.tags.some(tag => typeof tag !== 'string'))) throw new Error('WD14 没有返回有效标签')
  return result
}
