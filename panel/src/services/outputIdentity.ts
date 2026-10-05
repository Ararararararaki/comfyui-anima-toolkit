import type { OutputFile, OutputMetadata } from '../types/outputs'

export type ImageSnapshot = Readonly<{
  file: OutputFile
  source: string
  root: string
  path: string
  mtime: number
  size: number
  parserVersion: number
  epoch: number
  key: string
}>

export const normalizeOutputPath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '')
export const metadataPathKey = (root: string, path: string): string => JSON.stringify(['output-path', normalizeOutputPath(root), normalizeOutputPath(path)])
const directoryRoots = new WeakMap<FileSystemDirectoryHandle, string>()
const directorySession = Date.now().toString(36)
let directorySequence = 0
export function outputRootIdentity(root: string, handle: FileSystemDirectoryHandle | null): string {
  if (!handle) return normalizeOutputPath(root)
  let identity = directoryRoots.get(handle)
  if (!identity) { identity = `directory:${directorySession}:${++directorySequence}:${handle.name}`; directoryRoots.set(handle, identity) }
  return identity
}

export function createImageSnapshot(file: OutputFile, source: string, root: string, parserVersion: number, epoch = 0): ImageSnapshot {
  const identity = { source, root: normalizeOutputPath(root), path: normalizeOutputPath(file.path), mtime: file.mtime, size: file.size, parserVersion }
  return Object.freeze({ ...identity, file: Object.freeze({ ...file }), epoch, key: JSON.stringify(identity) })
}
export const imageRevision = (snapshot: ImageSnapshot): string => JSON.stringify([snapshot.source, snapshot.root, snapshot.path, snapshot.mtime, snapshot.size])

export function bindMetadata(meta: OutputMetadata, snapshot: ImageSnapshot): OutputMetadata {
  const { source, root, path, mtime, size, parserVersion } = snapshot
  return { ...meta, imageId: snapshot.file.id, metadataIdentity: snapshot.key, sourceIdentity: { source, root, path, mtime, size, parserVersion }, parserVersion }
}

export function metadataMatches(meta: OutputMetadata | undefined | null, snapshot: ImageSnapshot): boolean {
  return !!meta && meta.metadataIdentity === snapshot.key
}

/** Legacy IDs remain annotation/IDB keys; image content is always resolved by path and revision. */
export function metadataForFile(cache: Map<string, OutputMetadata>, file: OutputFile, root?: string, parserVersion?: number): OutputMetadata | null {
  const meta = (root == null ? undefined : cache.get(metadataPathKey(root, file.path))) ?? cache.get(file.id)
  const identity = meta?.sourceIdentity
  return identity && normalizeOutputPath(identity.path) === normalizeOutputPath(file.path)
    && identity.mtime === file.mtime && identity.size === file.size
    && (root == null || normalizeOutputPath(identity.root) === normalizeOutputPath(root))
    && (parserVersion == null || identity.parserVersion === parserVersion) ? meta! : null
}

export function backendMetadataMatches(full: Record<string, unknown>, snapshot: ImageSnapshot): boolean {
  if (normalizeOutputPath(String(full.imageId || '')) !== snapshot.path) return false
  const identity = full.identity as { path?: string; root?: string; mtime?: number; size?: number } | undefined
  if (!identity) return false
  return normalizeOutputPath(String(identity.path || '')) === snapshot.path
    && normalizeOutputPath(String(identity.root || '')) === snapshot.root
    && Math.abs(Number(identity.mtime) * 1000 - snapshot.mtime) <= 1
    && Number(identity.size) === snapshot.size
    && Number(full.parserVersion) === snapshot.parserVersion
}

export function promptBody(meta: OutputMetadata | null): string {
  if (!meta || meta.promptStatus === 'missing' || meta.promptStatus === 'ambiguous') return ''
  return meta.prompt?.trim() || ''
}

interface MetadataLoaderOptions {
  read: (id: string) => Promise<OutputMetadata | undefined>
  fetch: (snapshot: ImageSnapshot) => Promise<OutputMetadata | null>
  write: (meta: OutputMetadata) => Promise<unknown>
  publish: (meta: OutputMetadata) => void
  isCurrent: (snapshot: ImageSnapshot) => boolean
}

/** One immutable image identity for all actions, including requests that finish after navigation. */
export function createMetadataLoader(options: MetadataLoaderOptions) {
  const inflight = new Map<string, Promise<OutputMetadata | null>>()
  const memory = new Map<string, OutputMetadata>()
  return async (snapshot: ImageSnapshot | null, force = false): Promise<OutputMetadata | null> => {
    if (!snapshot || !options.isCurrent(snapshot)) return null
    if (!force && memory.has(snapshot.key)) return memory.get(snapshot.key)!
    if (inflight.has(snapshot.key)) return inflight.get(snapshot.key)!
    const task = (async () => {
      let meta: OutputMetadata | undefined | null
      if (!force) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          meta = await Promise.race([options.read(snapshot.file.id), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 3000) })])
        } catch { /* A failed DB read can still use the original image/backend. */ }
        finally { if (timer) clearTimeout(timer) }
      }
      if (!options.isCurrent(snapshot)) return null
      if (!metadataMatches(meta, snapshot)) meta = await options.fetch(snapshot)
      if (!meta || !options.isCurrent(snapshot) || !metadataMatches(meta, snapshot)) return null
      memory.set(snapshot.key, meta)
      if (memory.size > 100) memory.delete(memory.keys().next().value!)
      options.publish(meta)
      // The snapshot is checked again immediately before persisting; the old primary key is retained.
      if (options.isCurrent(snapshot)) void options.write(meta).catch(() => {})
      return meta
    })()
    inflight.set(snapshot.key, task)
    try { return await task } finally { if (inflight.get(snapshot.key) === task) inflight.delete(snapshot.key) }
  }
}

/**
 * 当前**实际装载列表**的来源戳（单真源）。
 *
 * 为什么放在 identity 模块：来源决定「一条路径该由哪个 provider 解释」，
 * 与图片身份是同一个关注点；放在这里可以让 scanner（提交列表的一方）
 * 和 Outputs.ts（消费列表的一方）共用，不产生循环依赖。
 *
 * ⚠️ 2026-10-04 用户验收纠正（严重）：
 * 旧实现按**全局能力探测**推导来源（`galleryIndexEnabled() ? 'gallery' : ...`）。
 * 那是错的：后端画廊索引**可用** ≠ 用户当前看的列表**来自**画廊。
 * 用户在画廊可用的前提下再选浏览器目录后，列表是用户自己的文件，
 * 但来源仍被判成 gallery →
 *   · 预览/元数据会去取 ComfyUI output 里**同相对路径的另一张图**（错位）；
 *   · 删除会走 gallery 分支而失败。
 * 因此来源必须由「真正把列表写进 store 的那条路径」显式声明，
 * 绝不能由能力探测推导。
 */
export type OutputSourceKind = 'gallery' | 'native' | 'directory'
export type OutputSourceStamp = Readonly<{ kind: OutputSourceKind; root: string; parserVersion: number }>

let _listSource: OutputSourceStamp | null = null

/** 列表提交的同时显式声明其来源（只有真正装载列表的路径可调用） */
export function commitListSource(kind: OutputSourceKind, root: string, parserVersion: number): void {
  _listSource = Object.freeze({ kind, root: normalizeOutputPath(root), parserVersion })
}

/** 当前列表来源；null 表示尚未确立（此时调用方不得做来源相关的读写） */
export function listSourceStamp(): OutputSourceStamp | null {
  return _listSource
}

/** 仅测试/来源切换复位用 */
export function resetListSource(): void {
  _listSource = null
}
