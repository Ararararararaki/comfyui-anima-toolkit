import { outputsDb } from '../db/outputsDb'
import type { OutputFile, OutputSource } from '../types/outputs'
import { PARSER_VERSION } from './outputMetadata'
import { listSourceStamp, registerOutputRootIdentity, type ImageSnapshot } from './outputIdentity'

// The output adapter keeps its historical IDs. Directory adapters own stable IDs and handles.
const sources = new Map<string, OutputSource>([['output', {
  id: 'output', kind: 'gallery', label: 'ComfyUI output', root: '',
  parserVersion: PARSER_VERSION, enabled: true, permission: 'granted',
}]])
type StoredSource = OutputSource & { removed?: boolean }
let restoreTask: Promise<OutputSource[]> | undefined
let registration: Promise<unknown> = Promise.resolve()
const listeners = new Set<() => void>()
function changed(): void { for (const listener of listeners) listener() }
export function subscribeOutputSources(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function outputSources(): OutputSource[] {
  return [...sources.values()].filter(source => !(source as StoredSource).removed).map(source => ({ ...getOutputSource(source.id)! }))
}
export function setOutputSource(kind: OutputSource['kind'], root: string, parserVersion: number): void {
  const previous = sources.get('output')!
  sources.set('output', { ...previous, kind, root, parserVersion })
  changed()
}
export function getOutputSource(fileOrId?: OutputFile | string): OutputSource | undefined {
  const id = typeof fileOrId === 'object' ? fileOrId.sourceId || 'output' : fileOrId || 'output'
  let source = sources.get(id)
  if (!source && typeof fileOrId === 'string') {
    try { const parsed = JSON.parse(decodeURIComponent(fileOrId)); if (Array.isArray(parsed)) source = sources.get(parsed[0]) } catch { /* legacy output ID */ }
  }
  if (!source) return undefined
  if (source.id === 'output') {
    const stamp = listSourceStamp()
    if (stamp && stamp.kind !== 'directory') return { ...source, kind: stamp.kind, root: stamp.root, parserVersion: stamp.parserVersion }
  }
  return source
}
export function sourceForFile(file: OutputFile): OutputSource {
  return getOutputSource(file) || {
    id: file.sourceId!, kind: 'directory', label: '未连接目录', root: file.sourceId!,
    parserVersion: PARSER_VERSION, enabled: false, permission: 'none',
  }
}
export function outputContentKey(file: Pick<OutputFile, 'sourceId' | 'path'>): string {
  return JSON.stringify([file.sourceId || 'output', file.path.replace(/\\/g, '/')])
}
export function fileSourceIdentity(file: OutputFile) {
  const source = sourceForFile(file)
  return { source: source.kind, root: source.root, parserVersion: source.parserVersion }
}
export function outputFileId(sourceId: string, path: string): string {
  return encodeURIComponent(JSON.stringify([sourceId, path.replace(/\\/g, '/')]))
}
export function outputDirectoryHandle(file: OutputFile): FileSystemDirectoryHandle | undefined { return sourceForFile(file).handle }

export async function requestOutputSourcePermission(id: string, mode: 'read' | 'readwrite' = 'read', prompt = true): Promise<boolean> {
  const source = sources.get(id)
  if (!source?.handle) return source?.id === 'output'
  const handle = source.handle as FileSystemDirectoryHandle & { requestPermission: (options: { mode: string }) => Promise<PermissionState>; queryPermission: (options: { mode: string }) => Promise<PermissionState> }
  const permission = await (prompt ? handle.requestPermission({ mode }) : handle.queryPermission({ mode }))
  // A routine permission check is not a source change. In particular it must
  // not reset the classification index or rewrite the source registration.
  if (source.permission !== permission) { source.permission = permission; await outputsDb.sources.put(source); changed() }
  return permission === 'granted'
}
export async function resolveOutputFileHandle(file: OutputFile): Promise<FileSystemFileHandle | null> {
  const source = sourceForFile(file)
  if (!source.handle || !source.enabled || (source as StoredSource).removed) return null
  const parts = file.path.replace(/\\/g, '/').split('/')
  let directory = source.handle
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
  return directory.getFileHandle(parts[parts.length - 1])
}
export async function readOutputSourceFile(target: OutputFile | ImageSnapshot): Promise<File | null> {
  const file = 'file' in target ? target.file : target
  try {
    const handle = await resolveOutputFileHandle(file)
    const bytes = await handle?.getFile()
    return bytes && bytes.size === file.size && bytes.lastModified === file.mtime ? bytes : null
  } catch { return null }
}

/** Only the old single `current` handle can attribute unmarked legacy annotations. */
async function migrateCurrent(handle: FileSystemDirectoryHandle): Promise<void> {
  const old = await outputsDb.files.toArray()
  const legacy = old.filter(file => !file.sourceId)
  const source = await addOutputDirectory(handle)
  await outputsDb.transaction('rw', outputsDb.files, outputsDb.manifest, outputsDb.dirHandles, async () => {
    for (const file of legacy) {
      const migrated = { ...file, sourceId: source.id, id: outputFileId(source.id, file.path) }
      // A previous interrupted migration wins, including any newer user annotations.
      if (!await outputsDb.files.get(migrated.id)) await outputsDb.files.put(migrated)
      const manifest = await outputsDb.manifest.get(file.id)
      if (manifest) await outputsDb.manifest.put({ ...manifest, id: migrated.id, sourceId: source.id })
      // The old key can also contain output annotations written after this handle was selected.
      // Keep it for output's exact-path restore; only clone ownership into the historical directory.
      // Derived metadata/thumbnails cannot be attributed from a handle alone and are not rebound.
    }
    await outputsDb.dirHandles.put({ done: true }, 'sources-migration-v1')
  })
}
export function restoreOutputSources(): Promise<OutputSource[]> {
  if (restoreTask) return restoreTask
  restoreTask = (async () => {
    const saved = await outputsDb.sources.toArray()
    for (const source of saved) {
      if (source.kind === 'directory') source.parserVersion = PARSER_VERSION
      if (source.handle) {
        registerOutputRootIdentity(source.handle, source.root)
        try { source.permission = await (source.handle as any).queryPermission({ mode: 'read' }) } catch { source.permission = 'denied' }
      }
      sources.set(source.id, source)
    }
    if (!await outputsDb.dirHandles.get('sources-migration-v1')) {
      const current = await outputsDb.dirHandles.get('current')
      const handle = current?.handle || current
      if (handle?.kind === 'directory') await migrateCurrent(handle)
    }
    const cached = await outputsDb.files.toArray()
    const orphaned = new Set((await outputsDb.manifest.toArray()).filter(entry => entry.orphaned).map(entry => entry.id))
    const { useOutputStore } = await import('../store/outputStore')
    const store = useOutputStore.getState()
    const ids = new Set(store.files.map(file => file.id))
    store.setFiles([...store.files, ...cached.filter(file => file.sourceId && !ids.has(file.id) && !orphaned.has(file.id))])
    changed()
    return outputSources()
  })()
  restoreTask.catch(() => { restoreTask = undefined })
  return restoreTask
}
export function addOutputDirectory(handle: FileSystemDirectoryHandle): Promise<OutputSource> {
  const task = registration.then(async () => {
    for (const source of sources.values()) {
      if (source.kind !== 'directory' || !source.handle) continue
      if (source.handle === handle || await source.handle.isSameEntry(handle)) {
        const retained: StoredSource = { ...source, handle, enabled: true, removed: false }
        sources.set(source.id, retained)
        registerOutputRootIdentity(handle, retained.root)
        await outputsDb.sources.put(retained)
        changed()
        return retained
      }
    }
    const id = `directory:${crypto.randomUUID()}`
    const source: OutputSource = { id, kind: 'directory', label: handle.name, root: id, parserVersion: PARSER_VERSION, handle, enabled: true, permission: 'prompt' }
    registerOutputRootIdentity(handle, id)
    await outputsDb.sources.put(source)
    sources.set(id, source)
    changed()
    return source
  })
  registration = task.catch(() => {})
  return task
}
export async function setOutputSourceEnabled(id: string, enabled: boolean): Promise<void> {
  const source = sources.get(id)
  if (!source) return
  const next: StoredSource = { ...source, enabled, ...(enabled ? { removed: false } : {}) }
  if (!enabled) { const { cancelOutputScan } = await import('./outputScanner'); cancelOutputScan(id) }
  await outputsDb.sources.put(next)
  sources.set(id, next)
  const { useOutputStore } = await import('../store/outputStore')
  useOutputStore.getState().applyFilters()
  changed()
}
export async function removeOutputSource(id: string): Promise<void> {
  const source = sources.get(id)
  if (!source) return
  const { cancelOutputScan } = await import('./outputScanner')
  cancelOutputScan(id)
  // Retain the registration and annotation ownership so re-adding the folder restores assets.
  const removed: StoredSource = { ...source, enabled: false, removed: true }
  await outputsDb.sources.put(removed)
  sources.set(id, removed)
  const { useOutputStore } = await import('../store/outputStore')
  const store = useOutputStore.getState()
  const removedIds = new Set(store.files.filter(file => file.sourceId === id).map(file => file.id))
  useOutputStore.setState({ selectedIds: new Set([...store.selectedIds].filter(key => !removedIds.has(key))) })
  if (store.currentSourceId === id) store.setCurrentSource('')
  else store.applyFilters()
  changed()
}
