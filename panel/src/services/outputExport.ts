// Selection, metadata policy and resource ownership belong to one cancellable export job.
// Views inject file reads and delivery; no original file or persisted default is modified.
import type { ExportMetadataOptions, ExportMetadataResult } from '../utils/imageMetadata'
import { applyExportMetadataResult, isExportMetadataNoop } from '../utils/imageMetadata'
import { generateOutputArchive, type OutputArchiveEntry } from './outputExportArchive'

export interface OutputExportItem {
  id: string
  sourceId?: string
  path: string
  filename: string
  size: number
}
export type OutputExportAction = 'download' | 'zip' | 'copy'
export interface OutputExportProgress {
  phase: 'reading' | 'processing' | 'packing' | 'copying' | 'downloading' | 'complete' | 'cancelled'
  completed: number
  total: number
  succeeded: number
  failed: number
  part: number
  currentFilename?: string
  worker: 'worker' | 'fallback'
}
export interface OutputExportArtifact {
  name: string
  blob: Blob
  part: number
  itemIds: string[]
}
export interface PreparedOutputExportItem<T extends OutputExportItem = OutputExportItem> {
  item: Readonly<T>
  name: string
  blob: Blob
  metadataStatus: ExportMetadataResult['status']
}
export interface OutputExportFailure {
  id: string
  name: string
  stage: 'read' | 'metadata' | 'download' | 'zip' | 'copy'
  message: string
}
export interface OutputExportResult {
  status: 'completed' | 'cancelled'
  total: number
  succeeded: number
  failures: OutputExportFailure[]
  warnings: Array<{ id: string; name: string; message: string }>
  artifacts: Array<{ name: string; part: number; itemIds: string[] }>
}
export interface OutputExportDependencies<T extends OutputExportItem> {
  policy: ExportMetadataOptions
  readBlob: (item: Readonly<T>, signal: AbortSignal) => Promise<Blob>
  download?: (artifact: OutputExportArtifact, signal: AbortSignal) => Promise<void>
  copy?: (items: readonly PreparedOutputExportItem<T>[], signal: AbortSignal) => Promise<{ copied: number }>
  /** Sum of prepared input bytes per ZIP part, not a claim about JSZip's peak memory. */
  maxArchiveBytes?: number
  maxClipboardBytes?: number
  archiveName?: string
  /** Behaviour tests can inject a processor without creating browser workers. */
  processor?: OutputExportProcessor
}
export interface OutputExportProcessor {
  mode: 'worker' | 'fallback'
  metadata: (blob: Blob, policy: ExportMetadataOptions, signal: AbortSignal) => Promise<ExportMetadataResult>
  archive: (items: readonly OutputArchiveEntry[], signal: AbortSignal, progress: (percent: number) => void) => Promise<Blob>
  dispose: () => void
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('导出已取消', 'AbortError')
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function safeSegment(value: string): string {
  return value.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+$/, '_') || '_'
}
/** Source identity and full path prevent same-filename overwrite across directories. */
export function outputArchivePath(item: OutputExportItem): string {
  const source = safeSegment((item.sourceId || 'output').replace(/[\\/]/g, '_'))
  const path = item.path.replace(/\\/g, '/').split('/').filter(Boolean).map(safeSegment)
  return [source, ...(path.length ? path : [safeSegment(item.filename)])].join('/')
}

/**
 * Workers are owned by the job and terminated on cancel/dispose. Environments with no
 * Worker (tests or restricted browsers) use the same bounded, sequential implementation.
 * A worker startup failure is explicit; it never silently retries a large ZIP on the UI.
 */
function createProcessor(): OutputExportProcessor {
  if (typeof Worker === 'undefined') {
    return {
      mode: 'fallback',
      metadata: (blob, policy, signal) => applyExportMetadataResult(blob, policy, { signal }),
      archive: (items, signal, progress) => generateOutputArchive(items, signal, progress),
      dispose() {},
    }
  }
  let worker: Worker | null = null
  let sequence = 0
  let pending: { id: number; resolve: (value: any) => void; reject: (error: Error) => void; progress?: (percent: number) => void } | null = null
  function stop(error: Error = new DOMException('导出已取消', 'AbortError')): void {
    worker?.terminate()
    worker = null
    const job = pending
    pending = null
    job?.reject(error)
  }
  function request<T>(payload: Record<string, unknown>, signal: AbortSignal, progress?: (percent: number) => void): Promise<T> {
    cancelled(signal)
    if (pending) return Promise.reject(new Error('导出后台任务仍在处理上一项请求'))
    if (!worker) {
      worker = new Worker(new URL('./outputExportWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event) => {
        if (!pending || event.data.id !== pending.id) return
        if (event.data.type === 'progress') { pending.progress?.(event.data.percent); return }
        const job = pending
        pending = null
        if (event.data.type === 'error') {
          const error = new Error(event.data.message)
          error.name = event.data.name || 'Error'
          job.reject(error)
        } else job.resolve(event.data.result)
      }
      worker.onerror = event => stop(new Error(`导出后台任务启动或执行失败：${event.message || '无法启动'}`))
    }
    const id = ++sequence
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => stop()
      signal.addEventListener('abort', onAbort, { once: true })
      const done = (callback: (value: any) => void) => (value: any) => {
        signal.removeEventListener('abort', onAbort)
        callback(value)
      }
      pending = { id, resolve: done(resolve), reject: done(reject), progress }
      try { worker!.postMessage({ ...payload, id }) } catch (error) {
        pending = null
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    })
  }
  return {
    mode: 'worker',
    metadata: (blob, policy, signal) => isExportMetadataNoop(policy)
      ? Promise.resolve({ blob, status: 'unchanged', removedKeywords: [] })
      : request({ type: 'metadata', blob, policy }, signal),
    archive: (items, signal, progress) => request({ type: 'archive', items }, signal, progress),
    dispose: () => stop(),
  }
}

/** A fresh clone is safe to hand to previews/edit copies as well as the export job. */
export function snapshotExportMetadataPolicy(policy: ExportMetadataOptions): ExportMetadataOptions {
  return Object.freeze({ strip: Boolean(policy.strip), entries: Object.freeze({ ...policy.entries }) })
}

/** Actual image copy. Browser clipboards may transcode; this does not promise PNG byte identity. */
export async function copyOutputExportImages<T extends OutputExportItem>(
  items: readonly PreparedOutputExportItem<T>[], signal: AbortSignal,
  options: { maxBytes?: number } = {},
): Promise<{ copied: number }> {
  cancelled(signal)
  if (!items.length) return { copied: 0 }
  if (!globalThis.navigator?.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('当前浏览器不支持复制图片到剪贴板，请改用下载')
  }
  if (items.length === 1) {
    const image = items[0].blob.type === 'image/png'
      ? items[0].blob : await reencodeOutputImage(items[0].blob, 'image/png', undefined, signal)
    cancelled(signal)
    await navigator.clipboard.write([new ClipboardItem({ [image.type || 'image/png']: image })])
  } else {
    const tags: string[] = []
    const htmlBudget = options.maxBytes ?? 16 * 1024 * 1024
    let htmlBytes = 0
    for (const image of items) {
      cancelled(signal)
      if (!image.blob.type.startsWith('image/')) throw new Error(`无法复制 ${image.name}：无法识别图片格式`)
      const dataUrl = await blobDataUrl(image.blob, signal)
      const alt = image.name.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)
      const tag = `<img src="${dataUrl}" alt="${alt}">`
      htmlBytes += new TextEncoder().encode(tag).length + 1
      if (htmlBytes > htmlBudget) throw new Error('多图剪贴板内容超过大小预算，请改用下载或打包')
      tags.push(tag)
    }
    cancelled(signal)
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([tags.join('\n')], { type: 'text/html' }),
      'text/plain': new Blob([`${items.length} 张图片`], { type: 'text/plain' }),
    })])
  }
  cancelled(signal)
  return { copied: items.length }
}

/** Shared by Prompt-library thumbnails, not the lossless download/metadata path. */
export async function compressOutputImage(blob: Blob, maxDimension = 1920, signal?: AbortSignal): Promise<Blob> {
  return reencodeOutputImage(blob, 'image/webp', maxDimension, signal)
}

async function reencodeOutputImage(blob: Blob, type: 'image/png' | 'image/webp', maxDimension?: number, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError')
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('当前浏览器无法转换此图片格式，请改用下载')
  }
  const bitmap = await createImageBitmap(blob)
  try {
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError')
    const scale = maxDimension ? Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height)) : 1
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('图片转换画布不可用')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const output = await canvas.convertToBlob({ type, quality: 0.85 })
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError')
    return output
  } finally { bitmap.close() }
}

function blobDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const onAbort = () => reader.abort()
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    reader.onload = () => { cleanup(); resolve(String(reader.result)) }
    reader.onerror = () => { cleanup(); reject(reader.error || new Error('剪贴板图片读取失败')) }
    reader.onabort = () => { cleanup(); reject(new DOMException('导出已取消', 'AbortError')) }
    if (signal.aborted) { cleanup(); reject(new DOMException('导出已取消', 'AbortError')); return }
    reader.readAsDataURL(blob)
  })
}

export function createOutputExportSession<T extends OutputExportItem>(
  selection: readonly T[], dependencies: OutputExportDependencies<T>,
) {
  const items = selection.map(item => Object.freeze({ ...item }))
  const policy = snapshotExportMetadataPolicy(dependencies.policy)
  const controller = new AbortController()
  const listeners = new Set<(progress: OutputExportProgress) => void>()
  const archiveBudget = Math.max(1, dependencies.maxArchiveBytes ?? 64 * 1024 * 1024)
  const clipboardBudget = Math.max(1, dependencies.maxClipboardBytes ?? 16 * 1024 * 1024)
  const processor = dependencies.processor ?? createProcessor()
  let started = false
  const result: OutputExportResult = { status: 'completed', total: items.length, succeeded: 0, failures: [], warnings: [], artifacts: [] }
  let state: OutputExportProgress = { phase: 'reading', completed: 0, total: items.length, succeeded: 0, failed: 0, part: 0, worker: processor.mode }
  function emit(patch: Partial<OutputExportProgress>): void {
    state = { ...state, ...patch, succeeded: result.succeeded, failed: result.failures.length }
    for (const listener of listeners) listener({ ...state })
  }
  function fail(item: Readonly<T>, stage: OutputExportFailure['stage'], error: unknown): void {
    result.failures.push({ id: item.id, name: item.filename, stage, message: errorMessage(error) })
  }
  async function prepare(item: Readonly<T>): Promise<PreparedOutputExportItem<T> | null> {
    emit({ phase: 'reading', currentFilename: item.filename })
    let blob: Blob
    try {
      blob = await dependencies.readBlob(item, controller.signal)
      cancelled(controller.signal)
    } catch (error) {
      cancelled(controller.signal)
      fail(item, 'read', error)
      return null
    }
    try {
      emit({ phase: 'processing' })
      const metadata = await processor.metadata(blob, policy, controller.signal)
      cancelled(controller.signal)
      if (metadata.status === 'unsupported') result.warnings.push({
        id: item.id, name: item.filename,
        message: '此格式按原文件导出，未清理生成信息；生成信息清理目前仅支持 PNG',
      })
      return { item, name: item.filename, blob: metadata.blob, metadataStatus: metadata.status }
    } catch (error) {
      cancelled(controller.signal)
      fail(item, 'metadata', error)
      return null
    }
  }
  async function deliver(blob: Blob, name: string, part: number, prepared: readonly PreparedOutputExportItem<T>[]): Promise<void> {
    cancelled(controller.signal)
    if (!dependencies.download) throw new Error('下载接口尚未配置')
    const itemIds = prepared.map(entry => entry.item.id)
    await dependencies.download({ blob, name, part, itemIds }, controller.signal)
    cancelled(controller.signal)
    result.succeeded += prepared.length
    result.artifacts.push({ name, part, itemIds })
    emit({ phase: 'downloading', part })
  }
  async function run(action: OutputExportAction): Promise<OutputExportResult> {
    if (started) throw new Error('一个导出任务只能执行一次，请重新创建任务')
    started = true
    let batch: PreparedOutputExportItem<T>[] = []
    let batchBytes = 0
    let part = 0
    const copyItems: PreparedOutputExportItem<T>[] = []
    let copyBytes = 0
    const archiveBase = (dependencies.archiveName || 'outputs').replace(/\.zip$/i, '')
    async function flush(): Promise<void> {
      if (!batch.length) return
      const current = batch
      batch = []; batchBytes = 0
      const names = new Set<string>()
      const archiveItems = current.map(entry => {
        const base = outputArchivePath(entry.item)
        let path = base
        let duplicate = 1
        while (names.has(path)) path = base.replace(/(\.[^./]+)?$/, ` (${++duplicate})$1`)
        names.add(path)
        return { path, blob: entry.blob }
      })
      try {
        emit({ phase: 'packing', part: ++part })
        const blob = await processor.archive(archiveItems, controller.signal, () => emit({ phase: 'packing' }))
        cancelled(controller.signal)
        await deliver(blob, `${archiveBase}-part${String(part).padStart(2, '0')}.zip`, part, current)
      } catch (error) {
        cancelled(controller.signal)
        for (const entry of current) fail(entry.item, 'zip', error)
      }
    }
    try {
      cancelled(controller.signal)
      for (const item of items) {
        cancelled(controller.signal)
        // Flush before reading the next large item so only one budgeted batch is resident.
        if (action === 'zip' && batch.length && batchBytes + Math.max(0, item.size) > archiveBudget) await flush()
        const prepared = await prepare(item)
        if (prepared) {
          if (action === 'download') {
            try { await deliver(prepared.blob, prepared.name, 0, [prepared]) } catch (error) {
              cancelled(controller.signal); fail(item, 'download', error)
            }
          } else if (action === 'zip') {
            if (batch.length && batchBytes + prepared.blob.size > archiveBudget) await flush()
            if (prepared.blob.size > archiveBudget) {
              result.warnings.push({ id: item.id, name: item.filename, message: '此图片超过单个 ZIP 的大小预算，已改为单图下载' })
              try { await deliver(prepared.blob, prepared.name, 0, [prepared]) } catch (error) {
                cancelled(controller.signal); fail(item, 'download', error)
              }
            } else { batch.push(prepared); batchBytes += prepared.blob.size }
          } else if (copyBytes + (items.length > 1 ? Math.ceil(prepared.blob.size / 3) * 4 + 1024 : prepared.blob.size) > clipboardBudget) {
            fail(item, 'copy', new Error('此图片加入后会超过剪贴板大小预算，请改用下载或打包'))
          } else {
            copyItems.push(prepared)
            copyBytes += items.length > 1 ? Math.ceil(prepared.blob.size / 3) * 4 + 1024 : prepared.blob.size
          }
        }
        emit({ completed: state.completed + 1 })
      }
      if (action === 'zip') await flush()
      if (action === 'copy' && copyItems.length) {
        try {
          emit({ phase: 'copying' })
          const copied = await (dependencies.copy ?? ((prepared, signal) => copyOutputExportImages(prepared, signal, { maxBytes: clipboardBudget })))(copyItems, controller.signal)
          cancelled(controller.signal)
          if (copied.copied !== copyItems.length) throw new Error('剪贴板接口未确认全部候选图片复制成功')
          result.succeeded += copied.copied
        } catch (error) {
          cancelled(controller.signal)
          for (const entry of copyItems) fail(entry.item, 'copy', error)
        }
      }
      emit({ phase: 'complete', currentFilename: undefined })
    } catch (error) {
      if (!controller.signal.aborted) throw error
      result.status = 'cancelled'
      emit({ phase: 'cancelled', currentFilename: undefined })
    } finally {
      batch = []; copyItems.length = 0
      processor.dispose()
      listeners.clear()
    }
    return result
  }
  return {
    policy,
    subscribe(listener: (progress: OutputExportProgress) => void): () => void {
      listeners.add(listener); listener({ ...state })
      return () => listeners.delete(listener)
    },
    cancel(): void { controller.abort(); processor.dispose() },
    run,
  }
}
