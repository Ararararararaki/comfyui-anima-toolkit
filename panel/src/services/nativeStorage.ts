/**
 * TK 启动器本地存储桥。
 *
 * 浏览器版继续使用 Dexie；当面板由 TK 启动器提供时，启动器会在同源
 * 暴露 /api/tk/*，这里优先使用 SQLite 索引，避免把 Outputs 整表和大段
 * 元数据反复序列化进 IndexedDB/内存。桥接失败时必须静默回退，保证
 * ComfyUI 扩展模式和远端部署不受影响。
 */

import type { OutputFile, OutputMetadata } from '../types/outputs'

export interface NativeStorageHealth {
  ok: boolean
  storage?: string
  version?: string
  outputRoot?: string
  port?: number
}

export interface NativeOutputRecord extends OutputFile {
  metadata?: Partial<OutputMetadata> | null
}

export interface NativeOutputPage {
  items: NativeOutputRecord[]
  total: number
  offset: number
  limit: number
  scannedAt?: number
}

let _baseUrl = ''
let _enabled = false
let _probePromise: Promise<boolean> | null = null

function configuredBase(): string {
  const configured = (globalThis as any).__TK_STORAGE_URL__
  if (typeof configured === 'string' && configured.trim()) return configured.replace(/\/$/, '')
  return ''
}

function url(path: string): string {
  return `${_baseUrl}${path}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url(path), {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`TK storage HTTP ${response.status}`)
  return response.json() as Promise<T>
}

/** 探测 TK 本地服务。只在启动器页面执行，不会触碰 ComfyUI 的 API。 */
export async function probeNativeStorage(): Promise<boolean> {
  if (_enabled) return true
  if (_probePromise) return _probePromise
  _probePromise = (async () => {
    _baseUrl = configuredBase()
    try {
      const health = await request<NativeStorageHealth>('/api/tk/health')
      _enabled = health.ok === true && health.storage === 'sqlite'
    } catch {
      _enabled = false
    }
    return _enabled
  })().finally(() => { _probePromise = null })
  return _probePromise
}

export function nativeStorageEnabled(): boolean {
  return _enabled
}

export function nativeOutputUrl(path: string): string {
  return url(`/api/tk/output-file?path=${encodeURIComponent(path)}`)
}

/**
 * ComfyUI **原生**原图 URL（`/view`）。
 *
 * 为什么需要它（2026-10-04 用户实测 404）：
 * 画廊来源（gallery）的 Outputs **不是** TK 原生桥的场景 —— 它由插件侧的
 * `/anima/gallery/*` 索引驱动，而原图必须走 ComfyUI 自带的 `/view`。
 * 旧代码在 gallery 分支误用了 `nativeOutputUrl()`（`/api/tk/output-file`），
 * 那个端点属于外部 TK 启动器、插件并不提供 → 真实 HTTP **404** →
 * 预览固定报「图片加载失败，保留当前预览，请重试」。
 *
 * `/view` 的参数契约（ComfyUI `server.py` 的 `view_image`）：
 *   filename=<basename>、subfolder=<相对目录>、type=output
 * 且它自身会拒绝绝对路径与 `..`（返回 400），并做 commonpath 越界校验（403）。
 */
export function comfyViewUrl(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const slash = normalized.lastIndexOf('/')
  const filename = slash === -1 ? normalized : normalized.slice(slash + 1)
  const subfolder = slash === -1 ? '' : normalized.slice(0, slash)
  const params = new URLSearchParams()
  params.set('filename', filename)
  if (subfolder) params.set('subfolder', subfolder)
  params.set('type', 'output')
  return `/view?${params.toString()}`
}

/**
 * 删除一张 output 图片（服务端执行，**不依赖目录句柄**）。
 *
 * 画廊来源下前端没有 `dirHandle`，浏览器侧的 File System Access 删除永远进不去；
 * 必须由插件在服务端删除，并且由服务端做 output 根内校验与修订冲突校验。
 * 携带删除前的 mtime/size：文件已被替换时服务端返回 409，避免误删同名的**新**图。
 */
export async function deleteOutputFile(
  path: string,
  revision: { mtime: number; size: number; root: string },
): Promise<void> {
  const resp = await fetch('/anima/outputs/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // root 必须发出：`source + root + path + mtime + size` 才是真实图片身份。
    // 服务端会把它与**实际** output 根核对，避免 output 目录配置变更后
    // 把「同相对路径 + 同 mtime/size」的另一张图删掉。
    body: JSON.stringify({ path, root: revision.root, mtime: revision.mtime / 1000, size: revision.size }),
    cache: 'no-store',
  })
  if (resp.ok) return
  let detail = `HTTP ${resp.status}`
  try {
    const data = await resp.json() as { error?: string; conflict?: boolean; rootMismatch?: boolean; missing?: boolean }
    if (data?.error) detail = data.error
  } catch { /* 响应体不是 JSON：沿用状态码 */ }
  const err = new Error(detail) as Error & { status?: number }
  err.status = resp.status
  throw err
}

export async function nativeScanOutputs(): Promise<{ added: number; changed: number; removed: number; total: number }> {
  return request('/api/tk/outputs/scan', { method: 'POST' })
}

export async function nativeListOutputs(options: {
  offset?: number
  limit?: number
  sort?: 'date' | 'name' | 'size'
  order?: 'asc' | 'desc'
  query?: string
  category?: string
} = {}): Promise<NativeOutputPage> {
  const params = new URLSearchParams()
  params.set('offset', String(options.offset ?? 0))
  params.set('limit', String(options.limit ?? 10000))
  params.set('sort', options.sort ?? 'date')
  params.set('order', options.order ?? 'desc')
  if (options.query) params.set('q', options.query)
  if (options.category) params.set('category', options.category)
  return request(`/api/tk/outputs?${params.toString()}`)
}

export async function nativeUpdateOutput(id: string, patch: Partial<OutputFile>): Promise<void> {
  await request(`/api/tk/outputs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

