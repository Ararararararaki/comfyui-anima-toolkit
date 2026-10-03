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
