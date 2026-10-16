import type { OutputFile, OutputMetadata, OutputDir } from '../types/outputs'
import { outputsDb } from '../db/outputsDb'
import { useOutputStore } from '../store/outputStore'
import { parseOutputMetadataBlob, PARSER_VERSION, outputLoraNames } from './outputMetadata'
import { createImageSnapshot, bindMetadata, imageRevision, type ImageSnapshot } from './outputIdentity'
import { getThumbnail, getCachedThumbnail } from './outputThumbnail'
import { diffManifest, fileToManifest, markOrphaned } from './outputManifest'
import { addOutputDirectory, getOutputSource, outputSources, outputFileId, fileSourceIdentity, restoreOutputSources, requestOutputSourcePermission, resolveOutputFileHandle } from './outputSources'
import { showToast } from '../utils'
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|webp|gif|bmp)$/i
/** 元数据落库（配额容错，防历史条目被 IndexedDB 配额静默丢弃）：
 * 先全量写；QuotaExceeded 时去掉冗余 rawMetadata 再试；仍失败清（可再生成的）缩略图再试；最后仍失败才跳过并 console 报告。 */
export async function putMetadataQuotaSafe(outputMeta: OutputMetadata): Promise<void> {
  const tryPut = (m: OutputMetadata) => outputsDb.metadata.put(m)
  try {
    await tryPut(outputMeta)
    return
  } catch (err) {
    const isQuota = err && (err as any)?.name === 'QuotaExceededError'
    if (!isQuota) throw err
    const slim: OutputMetadata = { ...outputMeta, rawMetadata: {} }
    try {
      await tryPut(slim)
      console.warn('[scan] 配额满：已降级存储（去掉 rawMetadata）')
      return
    } catch { /* 继续 */ }
    try {
      const { clearThumbnailCache } = await import('./outputThumbnail')
      await clearThumbnailCache()
    } catch { /* ignore */ }
    try {
      await tryPut(slim)
      console.warn('[scan] 配额满：清缩略图后重试成功')
      return
    } catch { /* 继续 */ }
    console.error('[scan] 配额满且降级仍失败，跳过该条元数据（文件行已保留，重扫可再补）', err)
    showToast('⚠️ 浏览器存储已满，部分图片元数据未保存；建议在浏览器「清除站点数据」后重新扫描')
    throw err
  }
}

/** 存储占用诊断：输出按日期文件数 vs 元数据数 + 浏览器存储占用，供定位"历史日期没加载/配额截断" */
export async function logStorageReport(): Promise<void> {
  try {
    const est = await (navigator.storage?.estimate?.() ?? Promise.resolve(null))
    const usageMB = est?.usage ? +(est.usage / 1048576).toFixed(1) : -1
    const quotaMB = est?.quota ? Math.round(est.quota / 1048576) : -1
    const pct = usageMB >= 0 && quotaMB > 0 ? Math.round((usageMB / quotaMB) * 100) : -1
    const files = await outputsDb.files.count().catch(() => -1)
    const meta = await outputsDb.metadata.count().catch(() => -1)
    const thumbs = await outputsDb.thumbnails.count().catch(() => -1)
    console.groupCollapsed('[Outputs] 存储诊断')
    console.table({ 文件数: files, 元数据数: meta, 缩略图数: thumbs, 占用MB: usageMB, 配额MB: quotaMB, 占用百分比: `${pct}%` })
    console.groupEnd()
    if (pct > 80) showToast(`⚠️ 浏览器存储已用约 ${pct}%，可能导致旧图片不加载；建议在浏览器「清除站点数据」后重新选择输出目录扫描`)
    if (meta >= 0 && files > 0 && meta < files * 0.9) showToast(`ℹ️ 元数据数(${meta}) < 文件数(${files})：存在未解析条目，点「重新解析」补齐`)
  } catch { /* ignore */ }
}

/** Re-read only the requested image. Legacy rows without identity are never attributed to it. */
export async function readImageMetadata(dirHandle: FileSystemDirectoryHandle, snapshot: ImageSnapshot, opts?: { strict?: boolean; signal?: AbortSignal }): Promise<OutputMetadata | null> {
  try {
    const parts = snapshot.path.split('/')
    let directory = dirHandle
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
    const handle = await directory.getFileHandle(parts[parts.length - 1])
    const file = await handle.getFile()
    if (file.lastModified !== snapshot.mtime || file.size !== snapshot.size) return null
    const meta = await parseOutputMetadataBlob(file, snapshot.file.extension, opts?.signal, snapshot.path)
    const after = await handle.getFile()
    if (!meta || after.lastModified !== snapshot.mtime || after.size !== snapshot.size) return null
    return bindMetadata({ ...meta, imageId: snapshot.file.id, rawMetadata: meta.raw, loras: outputLoraNames(meta), lorasExtracted: true }, snapshot)
  } catch (err) { if (opts?.strict) throw err; return null }
}

async function getDimensionsByImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = dataUrl
  })
}

/** 获取图片尺寸：PNG 直接从 IHDR chunk 读取（避免完整解码 4K 大图），其他格式回退完整解码 */
async function getDimensions(buf: ArrayBuffer, extension: string): Promise<{ width: number; height: number }> {
  if (extension === 'png') {
    const bytes = new Uint8Array(buf)
    // PNG 签名 8 字节 + IHDR chunk(长度4+类型4+宽4+高4) => 宽高在偏移 16/20
    if (bytes.length >= 24) {
      const sig = [137, 80, 78, 71, 13, 10, 26, 10]
      let ok = true
      for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) { ok = false; break }
      if (ok && String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) === 'IHDR') {
        const dv = new DataView(buf)
        return { width: dv.getUint32(16), height: dv.getUint32(20) }
      }
    }
  }
  const blob = new Blob([buf], { type: `image/${extension}` })
  const dataUrl = URL.createObjectURL(blob)
  const dims = await getDimensionsByImage(dataUrl)
  URL.revokeObjectURL(dataUrl)
  return dims
}


// Each source owns its task. A new task cancels the old task before either can commit.
const scans = new Map<string, { controller: AbortController; done: number; total: number; background?: boolean }>()
let refreshEpoch = 0
const AUTO_RECONCILE_MS = 5 * 60_000
const nextAutomaticCheck = new Map<string, number>()
let automaticRefresh: Promise<number> | undefined
function scanUi(status: 'done' | 'idle' | 'error' = 'done'): void {
  const jobs = [...scans.values()].filter(job => !job.background)
  useOutputStore.setState({ scanStatus: jobs.length ? 'scanning' : status, loading: false,
    scanProgress: { done: jobs.reduce((n, job) => n + job.done, 0), total: jobs.reduce((n, job) => n + job.total, 0) } })
}
export function cancelOutputScan(sourceId?: string): void {
  if (!sourceId) refreshEpoch++
  for (const [id, job] of scans) if (!sourceId || sourceId === id) { job.controller.abort(); scans.delete(id) }
  scanUi('idle')
}
function checkScan(id: string, job: { controller: AbortController }): void {
  if (job.controller.signal.aborted || scans.get(id) !== job || !getOutputSource(id)?.enabled) throw new DOMException('Scan cancelled', 'AbortError')
}
function defaultFile(id: string, path: string, file: File, sourceId: string): OutputFile {
  return { id, sourceId, path, filename: file.name, extension: file.name.split('.').pop()?.toLowerCase() || '',
    size: file.size, mtime: file.lastModified, width: 0, height: 0,
    favorite: false, rating: 0, notes: '', tags: [], category: '', status: '', pinned: false, createdAt: Date.now() }
}
/** Enumerate names/revisions and PNG IHDR only; creation metadata is loaded on demand. */
export async function scanOutputSource(sourceId: string, options: { background?: boolean } = {}): Promise<number> {
  const source = getOutputSource(sourceId)
  if (!source?.handle || source.kind !== 'directory' || !source.enabled) return 0
  if (options.background && scans.has(sourceId)) return 0
  scans.get(sourceId)?.controller.abort()
  const job = { controller: new AbortController(), done: 0, total: 0, background: options.background }
  scans.set(sourceId, job); if (!job.background) scanUi()
  let status: 'done' | 'idle' | 'error' = 'done'
  try {
    if (!await requestOutputSourcePermission(sourceId, 'read', !job.background)) {
      if (job.background) return 0
      throw new DOMException('目录未授权，请重新授权后扫描', 'NotAllowedError')
    }
    checkScan(sourceId, job)
    const previous = (await outputsDb.files.where('sourceId').equals(sourceId).toArray())
    const previousByPath = new Map(previous.map(file => [file.path, file]))
    const files: OutputFile[] = []
    const seen = new Map<string, { mtime: number; size: number }>()
    const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, handle] of (directory as any).entries()) {
        checkScan(sourceId, job)
        if (name.startsWith('.')) continue
        const path = prefix ? `${prefix}/${name}` : name
        if (handle.kind === 'directory') { await walk(handle, path); continue }
        if (!IMAGE_EXTENSIONS.test(name)) continue
        job.total++
        let bytes: File
        try { bytes = await handle.getFile() } catch {
          const retained = previousByPath.get(path)
          if (retained) { files.push(retained); seen.set(path, { mtime: retained.mtime, size: retained.size }) }
          job.done++; continue
        }
        const old = previousByPath.get(path)
        const row = old && old.mtime === bytes.lastModified && old.size === bytes.size ? { ...old } : { ...old, ...defaultFile(outputFileId(sourceId, path), path, bytes, sourceId),
          favorite: old?.favorite ?? false, rating: old?.rating ?? 0, notes: old?.notes ?? '', tags: old?.tags ?? [], category: old?.category ?? '', status: old?.status ?? '', pinned: old?.pinned ?? false, createdAt: old?.createdAt ?? Date.now() }
        if (row.extension === 'png' && (!old || old.mtime !== row.mtime || old.size !== row.size)) {
          const header = await bytes.slice(0, 32).arrayBuffer()
          const dims = await getDimensions(header, 'png')
          row.width = dims.width; row.height = dims.height
        }
        files.push(row); seen.set(path, { mtime: row.mtime, size: row.size }); job.done++
        if (job.done % 64 === 0) { if (!job.background) scanUi(); await new Promise(resolve => setTimeout(resolve, 0)) }
      }
    }
    await walk(source.handle, '')
    checkScan(sourceId, job)
    const diff = await diffManifest(seen, sourceId)
    checkScan(sourceId, job)
    const sameRevision = (a: OutputFile, b: OutputFile) => a.id === b.id && a.path === b.path && a.mtime === b.mtime && a.size === b.size && a.width === b.width && a.height === b.height
    const updates = files.filter(row => { const old = previousByPath.get(row.path); return !old || !sameRevision(old, row) })
    const updateIds = new Set(updates.map(row => row.id))
    const manifestIds = new Set([...updateIds, ...diff.changed.map(row => row.id)])
    const manifestUpdates = files.filter(row => manifestIds.has(row.id))
    let committed: OutputFile[] = []
    if (updates.length || manifestUpdates.length || diff.orphaned.length) await outputsDb.transaction('rw', outputsDb.files, outputsDb.manifest, async () => {
      checkScan(sourceId, job)
      const current = await outputsDb.files.bulkGet(updates.map(file => file.id))
      committed = updates.map((row, i) => current[i] ? { ...current[i]!, sourceId: row.sourceId, id: row.id, path: row.path, filename: row.filename, extension: row.extension, mtime: row.mtime, size: row.size, width: row.width, height: row.height } : row)
      if (committed.length) await outputsDb.files.bulkPut(committed)
      if (manifestUpdates.length) await outputsDb.manifest.bulkPut(manifestUpdates.map(fileToManifest))
      await markOrphaned(diff.orphaned)
      checkScan(sourceId, job)
    })
    checkScan(sourceId, job)
    nextAutomaticCheck.set(sourceId, Date.now() + AUTO_RECONCILE_MS)
    const store = useOutputStore.getState()
    const visible = new Map(store.files.filter(file => file.sourceId === sourceId).map(file => [file.id, file]))
    const changedRows = new Map(committed.map(file => [file.id, file]))
    const next = files.map(row => changedRows.get(row.id) || visible.get(row.id) || row)
    if (updateIds.size) store.removeMetadata([...updateIds])
    // Keep the array and summary/index job untouched when nothing changed.
    if (visible.size !== next.length || next.some(row => !visible.has(row.id) || !sameRevision(visible.get(row.id)!, row))) {
      store.setFiles([...store.files.filter(file => file.sourceId !== sourceId), ...next])
    }
    return updates.length + diff.orphaned.length
  } catch (err) {
    if ((err as Error).name !== 'AbortError') { status = 'error'; console.warn('[Outputs] Source scan failed:', source.label, err); throw err }
    status = 'idle'
    return 0
  } finally { if (scans.get(sourceId) === job) { scans.delete(sourceId); if (!job.background) scanUi(status) } }
}
export async function scanOutputDir(handle: FileSystemDirectoryHandle): Promise<void> {
  const source = await addOutputDirectory(handle)
  await scanOutputSource(source.id)
}
export async function scanOutputDirIncremental(handle: FileSystemDirectoryHandle): Promise<number> {
  const source = await addOutputDirectory(handle)
  return scanOutputSource(source.id)
}
export function refreshOutputSources(options: { automatic?: boolean } = {}): Promise<number> {
  if (options.automatic && automaticRefresh) return automaticRefresh
  const epoch = ++refreshEpoch
  const run = async () => {
    let count = 0
    for (const source of outputSources()) {
      if (epoch !== refreshEpoch) break
      if (source.kind !== 'directory' || !source.enabled) continue
      if (options.automatic) {
        if (scans.has(source.id) || Date.now() < (nextAutomaticCheck.get(source.id) || 0)) continue
        // Bound failures/denied permissions too, without prompting on a timer.
        nextAutomaticCheck.set(source.id, Date.now() + 60_000)
      }
      count += await scanOutputSource(source.id, { background: options.automatic })
    }
    return count
  }
  const task = run()
  if (options.automatic) { automaticRefresh = task; void task.finally(() => { if (automaticRefresh === task) automaticRefresh = undefined }).catch(() => {}) }
  return task
}
/** Explicit reparse refreshes only the requested source; it is never part of opening a folder. */
export async function reparseOutputSource(id: string): Promise<number> {
  const source = getOutputSource(id)
  if (!source?.handle || !source.enabled) return 0
  scans.get(id)?.controller.abort()
  const files = useOutputStore.getState().files.filter(file => file.sourceId === id)
  const job = { controller: new AbortController(), done: 0, total: files.length }
  scans.set(id, job); scanUi()
  let done = 0
  let status: 'done' | 'idle' | 'error' = 'done'
  try {
    if (!await requestOutputSourcePermission(id)) throw new DOMException('目录未授权，请重新授权后解析', 'NotAllowedError')
    for (const file of files) {
      checkScan(id, job)
      const identity = fileSourceIdentity(file)
      const snapshot = createImageSnapshot(file, identity.source, identity.root, identity.parserVersion)
      const meta = await readImageMetadata(source.handle, snapshot, { strict: true })
      checkScan(id, job)
      if (meta) {
        await outputsDb.transaction('rw', outputsDb.metadata, async () => {
          checkScan(id, job); await putMetadataQuotaSafe(meta); checkScan(id, job)
        })
        checkScan(id, job)
        useOutputStore.getState().putMetadata(meta); done++
      }
      job.done++; scanUi()
      if (job.done % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
    return done
  } catch (err) {
    if ((err as Error).name !== 'AbortError') { status = 'error'; console.warn('[Outputs] 元数据重解析失败:', source.label, err); throw err }
    status = 'idle'
    return done
  } finally { if (scans.get(id) === job) { scans.delete(id); scanUi(status) } }
}
export async function reparseAllMetadata(handle: FileSystemDirectoryHandle): Promise<number> {
  const source = await addOutputDirectory(handle)
  return reparseOutputSource(source.id)
}
export async function ensureMetadataFresh(_handle: FileSystemDirectoryHandle | null): Promise<boolean> {
  return false // Per-image parser identity owns invalidation; no library-wide startup task.
}
export interface LoadDirHandleResult { restored: boolean; permission: 'granted' | 'prompt' | 'denied' | 'none' }
/** Compatibility entry for older callers. It no longer installs a global directory handle. */
export async function loadOutputDirHandle(_opts?: { skipFiles?: boolean }): Promise<LoadDirHandleResult> {
  const restored = await restoreOutputSources()
  const directory = restored.find(source => source.kind === 'directory')
  return { restored: !!directory, permission: directory?.permission || 'none' }
}
/** Explicit maintenance only; there are no automatic all-library thumbnail jobs. */
export async function ensureThumbnails(handle: FileSystemDirectoryHandle | null): Promise<void> {
  if (!handle) return
  const source = await addOutputDirectory(handle)
  for (const file of useOutputStore.getState().files.filter(file => file.sourceId === source.id)) {
    const identity = fileSourceIdentity(file)
    const revision = imageRevision(createImageSnapshot(file, identity.source, identity.root, identity.parserVersion))
    if (await getCachedThumbnail(file.id, revision)) continue
    const entry = await resolveOutputFileHandle(file)
    if (entry) await getThumbnail(await entry.getFile(), file.id, revision)
  }
}
export async function buildDirTree(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string = ''
): Promise<OutputDir> {
  const dir: OutputDir = {
    path: basePath,
    name: dirHandle.name,
    handle: dirHandle,
    children: [],
    fileCount: 0,
  }

  const iter = (dirHandle as any).entries()
  for (;;) {
    const next = await iter.next()
    if (next.done) break
    const [name, handle] = next.value as [string, FileSystemFileHandle | FileSystemDirectoryHandle]

    // 跳过隐藏文件和目录
    if (name.startsWith('.')) continue

    if ((handle as any).kind === 'directory') {
      const child = await buildDirTree(
        handle as FileSystemDirectoryHandle,
        `${basePath ? basePath + '/' : ''}${name}`
      )
      dir.children.push(child)
    } else if ((handle as any).kind === 'file' && IMAGE_EXTENSIONS.test(name)) {
      dir.fileCount++
    }
  }

  return dir
}

/**
 * 从相对路径列表推导目录树（纯数据，不访问文件系统）。
 * 用于 Gallery 索引模式：manifest 的 key 就是相对路径，无需目录授权即可渲染左侧树；
 * 之后若拿到已授权句柄，可用 buildDirTree 的磁盘树替换（还能包含空目录）。
 * fileCount 语义与 buildDirTree 保持一致 = 该目录**直接**包含的图片数（不含子目录）。
 */
export function buildDirTreeFromPaths(paths: string[], rootName = 'output'): OutputDir {
  const root: OutputDir = { path: '', name: rootName, children: [], fileCount: 0 }
  const dirMap = new Map<string, OutputDir>([['', root]])
  for (const p of paths) {
    const segs = p.split('/')
    const dirPath = segs.slice(0, -1).join('/')
    let parent = ''
    for (const seg of segs.slice(0, -1)) {
      const acc = parent ? `${parent}/${seg}` : seg
      let d = dirMap.get(acc)
      if (!d) {
        d = { path: acc, name: seg, children: [], fileCount: 0 }
        dirMap.set(acc, d)
        dirMap.get(parent)!.children.push(d)
      }
      parent = acc
    }
    dirMap.get(dirPath)!.fileCount++
  }
  const sortRec = (d: OutputDir) => {
    d.children.sort((a, b) => a.name.localeCompare(b.name))
    d.children.forEach(sortRec)
  }
  sortRec(root)
  return root
}
