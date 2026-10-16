import type { ImageSnapshot } from './outputIdentity'
import { applyExportMetadataResult, type ExportMetadataOptions } from '../utils/imageMetadata'

export interface OutputDragCopy { url: string; name: string; mime: string; file?: File }
export function galleryDragCopy(snapshot: ImageSnapshot): OutputDragCopy | null {
  if (snapshot.source !== 'gallery') return null
  const query = new URLSearchParams({ path: snapshot.path, root: snapshot.root, mtime: String(snapshot.mtime), size: String(snapshot.size) })
  return { url: new URL('/anima/gallery/share?' + query, location.href).href, name: dragFilename(snapshot.file.filename), mime: 'image/png' }
}
function dragFilename(filename: string): string {
  return (filename.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_') || 'image') + '-clean.png'
}
/** Override native image drag data completely: no original/thumb URL or workflow payload. */
export function writeOutputDragData(transfer: Pick<DataTransfer, 'clearData' | 'setData'> & { effectAllowed: string; items?: Pick<DataTransferItemList, 'add' | 'clear'> }, copy: OutputDragCopy): void {
  transfer.clearData()
  transfer.items?.clear?.()
  transfer.effectAllowed = 'copy'
  if (copy.file && transfer.items && !transfer.items.add(copy.file)) throw new Error('当前浏览器无法拖出文件，请下载干净副本后上传')
  transfer.setData('DownloadURL', `${copy.mime}:${copy.name}:${copy.url}`)
  transfer.setData('text/uri-list', copy.url)
  transfer.setData('text/html', `<img src="${copy.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" alt="">`)
}
/** One preparation slot, bounded by the backend. Late results never attach to a new image. */
export function createOutputDragSession(options: {
  forceUpload?: boolean
  metadataPolicy?: () => ExportMetadataOptions
  read: (snapshot: ImageSnapshot, signal: AbortSignal) => Promise<Blob | null>
  current: (snapshot: ImageSnapshot) => boolean
  upload?: (blob: Blob, signal: AbortSignal, mode?: 'prepared') => Promise<{ url: string; expiresIn: number }>
  fetchCopy?: (url: string, signal: AbortSignal) => Promise<Blob>
}) {
  let owner: AbortController | undefined, key = '', ready: (OutputDragCopy & { expires: number }) | undefined, pending: Promise<OutputDragCopy | null> | undefined
  const identity = (snapshot: ImageSnapshot) => JSON.stringify([snapshot.file.id, snapshot.source, snapshot.root, snapshot.path, snapshot.mtime, snapshot.size, options.metadataPolicy?.()])
  const upload = options.upload || (async (blob: Blob, signal: AbortSignal, mode?: 'prepared') => {
    const body = new FormData(); body.append('image', blob, 'image')
    if (mode) body.append('metadata', mode)
    const response = await fetch('/anima/gallery/share', { method: 'POST', body, signal })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `准备拖出 HTTP ${response.status}`)
    return result as { url: string; expiresIn: number }
  })
  const fetchCopy = options.fetchCopy || (async (url: string, signal: AbortSignal) => {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`读取拖出副本 HTTP ${response.status}`)
    if (Number(response.headers.get('Content-Length')) > 64 * 1024 * 1024) throw new Error('拖出副本超过 64 MiB，请使用下载')
    const blob = await response.blob()
    if (blob.size > 64 * 1024 * 1024) throw new Error('拖出副本超过 64 MiB，请使用下载')
    if (blob.type !== 'image/png') throw new Error('拖出服务没有返回 PNG 图片')
    return blob
  })
  const cancel = () => { owner?.abort(); owner = undefined; pending = undefined; ready = undefined; key = '' }
  const get = (snapshot: ImageSnapshot): OutputDragCopy | null => {
    if (!options.current(snapshot)) return null
    return key === identity(snapshot) && ready && ready.expires > Date.now() ? ready : null
  }
  const prepare = (snapshot: ImageSnapshot): Promise<OutputDragCopy | null> => {
    const cached = get(snapshot)
    if (cached) return Promise.resolve(cached)
    const next = identity(snapshot)
    if (next === key && pending) return pending
    cancel(); key = next
    const requested = options.metadataPolicy?.()
    const policy = requested && Object.freeze({ strip: requested.strip, entries: Object.freeze({ ...requested.entries }) })
    const abort = owner = new AbortController()
    const current = () => owner === abort && !abort.signal.aborted && options.current(snapshot) && identity(snapshot) === next
    const task = (async () => {
      let copy = options.forceUpload || policy ? null : galleryDragCopy(snapshot), expiresIn = 600
      if (!copy) {
        const blob = await options.read(snapshot, abort.signal)
        if (!blob) throw new Error('无法读取图片，请授权目录或刷新后重试')
        if (!current()) return null
        if (blob.size > 64 * 1024 * 1024) throw new Error('拖出副本超过 64 MiB，请使用下载')
        const prepared = policy ? (await applyExportMetadataResult(blob, policy, { signal: abort.signal })).blob : blob
        if (!current()) return null
        const result = await upload(prepared, abort.signal, policy ? 'prepared' : undefined)
        if (!current()) return null
        const url = new URL(result.url, location.href)
        if (url.origin !== location.origin || url.pathname !== '/anima/gallery/share' || !url.searchParams.has('token')) throw new Error('拖出服务返回了无效地址')
        copy = { url: url.href, name: dragFilename(snapshot.file.filename), mime: 'image/png' }
        if (policy && !policy.strip) copy.name = copy.name.replace(/-clean\.png$/, '-export.png')
        expiresIn = Math.min(600, result.expiresIn)
      }
      // The File and receiver bridge URL must deliver the same policy-processed bytes.
      const clean = await fetchCopy(copy.url, abort.signal)
      if (!current()) return null
      ready = { ...copy, file: new File([clean], copy.name, { type: copy.mime }), expires: Date.now() + expiresIn * 1000 - 5000 }
      return ready
    })()
    pending = task
    void task.finally(() => { if (owner === abort) pending = undefined }).catch(() => {})
    return task
  }
  return { get, prepare, cancel }
}
