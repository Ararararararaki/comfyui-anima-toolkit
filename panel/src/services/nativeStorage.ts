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

