import type { OutputFile, OutputGroupMode, OutputSource, OutputSummary } from '../types/outputs'
import { outputGroups, compareOutputGroupDescriptors } from './outputQuery'

/** Virtual navigation changes the view only; source IDs and on-disk paths stay intact. */
export type OutputBrowseStep =
  | { kind: 'source'; id: string; label: string }
  | { kind: 'directory'; path: string; label: string }
  | { kind: 'work' | 'character'; key: string; label: string }
export interface OutputFolder {
  key: string
  kind: OutputBrowseStep['kind']
  label: string
  subtitle: string
  count: number
  covers: OutputFile[]
  step: OutputBrowseStep
  source?: OutputSource
}
export interface OutputBrowserView { folders: OutputFolder[]; files: OutputFile[]; count: number; home: boolean }

export function sourceBrowsePath(id: string, label: string, path = ''): OutputBrowseStep[] {
  const steps: OutputBrowseStep[] = [{ kind: 'source', id, label }]
  let prefix = ''
  for (const part of path.replace(/\\/g, '/').split('/').filter(Boolean)) {
    prefix = prefix ? `${prefix}/${part}` : part
    steps.push({ kind: 'directory', path: prefix, label: part })
  }
  return steps
}
export function browseSource(path: readonly OutputBrowseStep[]): { sourceId: string; directory: string } {
  const source = path.find(step => step.kind === 'source')
  const directories = path.filter(step => step.kind === 'directory')
  return { sourceId: source?.kind === 'source' ? source.id : '', directory: directories.length ? directories[directories.length - 1].path : '' }
}
export function restoreOutputBrowsePath(value: unknown): OutputBrowseStep[] {
  if (!Array.isArray(value)) return []
  const result: OutputBrowseStep[] = []
  for (const step of value) {
    if (!step || typeof step.label !== 'string') return []
    // Old combined identities no longer describe a folder. Keep its valid
    // parent, so re-opening a saved multi-character view does not look empty.
    if ((step.kind === 'work' || step.kind === 'character') && typeof step.key === 'string' && hasCombinedIdentity(step.key)) break
    if (step.kind === 'source' && result.length === 0 && typeof step.id === 'string') result.push({ kind: 'source', id: step.id, label: step.label })
    else if (step.kind === 'directory' && result.length && result.every(row => row.kind === 'source' || row.kind === 'directory') && typeof step.path === 'string') {
      const previous = browseSource(result).directory
      if (step.path.split('/').some((part: string) => !part || part === '.' || part === '..') || (previous && !step.path.startsWith(`${previous}/`))) return []
      result.push({ kind: 'directory', path: step.path, label: step.label })
    } else if (step.kind === 'work' && result.length && !result.some(row => row.kind === 'work' || row.kind === 'character') && typeof step.key === 'string') result.push({ kind: 'work', key: step.key, label: step.label })
    else if (step.kind === 'character' && result.length && !result.some(row => row.kind === 'character') && typeof step.key === 'string') result.push({ kind: 'character', key: step.key, label: step.label })
    else return []
  }
  return result
}
function hasCombinedIdentity(key: string): boolean {
  try {
    const outer = JSON.parse(key)
    return Array.isArray(outer) && outer.some(part => {
      if (typeof part !== 'string') return false
      try { const ids = JSON.parse(part); return Array.isArray(ids) && ids.length > 1 } catch { return false }
    })
  } catch { return false }
}
function cover(folder: OutputFolder, file: OutputFile): void {
  folder.count++
  if (folder.covers.length < 3) folder.covers.push(file)
}
function english(row: OutputSummary | undefined, kind: 'work' | 'character', id: string | undefined): string {
  const entities = kind === 'work' ? row?.works : row?.characters
  return [...new Map((entities || []).filter(entity => entity.id === id).map(entity => [entity.id, entity])).values()]
    .sort((a, b) => a.id.localeCompare(b.id)).map(entity => (entity.tag || entity.id).replace(/_/g, ' ')).join(' + ')
}

/** One projection, shared by counts, cards and leaf selection. No image or workflow reads. */
export function outputBrowserView(files: OutputFile[], sources: OutputSource[], summary: (file: OutputFile) => OutputSummary | undefined,
  path: readonly OutputBrowseStep[], mode: OutputGroupMode): OutputBrowserView {
  const folders = new Map<string, OutputFolder>()
  if (!path.length) {
    const all: OutputFolder = { key: 'source:all', kind: 'source', label: '全部图片', subtitle: '汇总已启用的目录', count: 0, covers: [], step: { kind: 'source', id: '', label: '全部图片' } }
    folders.set(all.key, all)
    for (const source of sources) folders.set(`source:${source.id}`, { key: `source:${source.id}`, kind: 'source', label: source.label,
      subtitle: source.enabled ? source.kind === 'directory' && source.permission !== 'granted' ? '点击授权后读取' : '图片目录' : '未加入汇总',
      count: 0, covers: [], step: { kind: 'source', id: source.id, label: source.label }, source })
    for (const file of files) { if (sources.find(source => source.id === (file.sourceId || 'output'))?.enabled) cover(all, file); const folder = folders.get(`source:${file.sourceId || 'output'}`); if (folder) cover(folder, file) }
    return { home: true, folders: [...folders.values()], files: [], count: all.count }
  }
  const { sourceId, directory } = browseSource(path)
  const work = path.find(step => step.kind === 'work'), character = path.find(step => step.kind === 'character')
  let scoped = files.filter(file => (!sourceId || (file.sourceId || 'output') === sourceId) && (!directory || file.path.startsWith(`${directory}/`)))
  if (work?.kind === 'work') scoped = scoped.filter(file => outputGroups(summary(file), 'work').some(group => group.workKey === work.key))
  if (character?.kind === 'character') scoped = scoped.filter(file => outputGroups(summary(file), work ? 'work' : 'character').some(group => group.key === character.key))
  if (character || mode === 'flat' || mode === 'none' && !sourceId) return { home: false, folders: [], files: scoped, count: scoped.length }
  if (mode !== 'none') {
    const kind = mode === 'work' && !work ? 'work' : 'character'
    const descriptors = new Map<string, ReturnType<typeof outputGroups>[number]>()
    for (const file of scoped) {
      const row = summary(file), memberships = outputGroups(row, mode)
      const seen = new Set<string>()
      for (const descriptor of memberships) {
        if (work?.kind === 'work' && descriptor.workKey !== work.key) continue
        const key = kind === 'work' ? descriptor.workKey : descriptor.key
        if (seen.has(key)) continue
        seen.add(key)
        let folder = folders.get(key)
        if (!folder) {
          const label = kind === 'work' ? descriptor.workLabel : descriptor.label
          folder = { key, kind, label, subtitle: english(row, kind, kind === 'work' ? descriptor.workId : descriptor.characterId), count: 0, covers: [], step: { kind, key, label } }
          folders.set(key, folder); descriptors.set(key, descriptor)
        }
        cover(folder, file)
      }
    }
    return { home: false, files: [], count: scoped.length, folders: [...folders.values()].sort((a, b) => compareOutputGroupDescriptors(descriptors.get(a.key)!, descriptors.get(b.key)!, mode)) }
  }
  const direct: OutputFile[] = []
  for (const file of scoped) {
    const relative = directory ? file.path.slice(directory.length + 1) : file.path
    const slash = relative.indexOf('/')
    if (slash < 0) { direct.push(file); continue }
    const label = relative.slice(0, slash), childPath = directory ? `${directory}/${label}` : label
    let folder = folders.get(childPath)
    if (!folder) { folder = { key: childPath, kind: 'directory', label, subtitle: '子目录', count: 0, covers: [], step: { kind: 'directory', path: childPath, label } }; folders.set(childPath, folder) }
    cover(folder, file)
  }
  return { home: false, files: direct, count: scoped.length, folders: [...folders.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true })) }
}
