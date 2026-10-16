import type { OutputFile, OutputMetadata, OutputSummary, OutputGroupMode, MetadataState } from '../types/outputs'

export const OUTPUT_SEARCH_VERSION = 2
/** Text ownership and container presence are independent. A failed parser is never proof of absence. */
export function metadataStateOf(meta: { metadataState?: MetadataState; prompt?: string; model?: string; hasWorkflow?: boolean; workflowJson?: string; rawMetadata?: Record<string, string> } | null | undefined): MetadataState {
  if (!meta) return 'unknown'
  if (meta.metadataState && meta.metadataState !== 'absent' && meta.metadataState !== 'unknown') return meta.metadataState
  if (meta.prompt?.trim() || meta.model || meta.hasWorkflow || meta.workflowJson || Object.keys(meta.rawMetadata || {}).length) return 'present'
  return meta.metadataState || 'unknown'
}
export function canInferOutputTags(row: OutputSummary | undefined, includeUnrecognized = false): boolean {
  if (!row || row.indexStatus !== 'ready' || row.characters.length || row.classificationAmbiguous) return false
  const state = metadataStateOf(row)
  if (includeUnrecognized && ['present', 'absent'].includes(state) && ['identified', 'unrecognized'].includes(row.classificationStatus) && !row.characters.length && !row.classificationAmbiguous) return true
  return state === 'absent' && !row.prompt.trim() && !row.hasWorkflow
}
export const normalizeOutputSearch = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/\\([()])/g, '$1').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
export function outputSearchTerms(query: string): string[] {
  return [...new Set(Array.from(query.matchAll(/"([^"]+)"|(\S+)/g), match => normalizeOutputSearch(match[1] || match[2])).filter(Boolean))]
}
export function summaryKey(file: OutputFile, root: string, parserVersion: number): string {
  return JSON.stringify([file.sourceId || 'output', root.replace(/\\/g, '/'), file.path.replace(/\\/g, '/'), file.mtime, file.size, parserVersion, OUTPUT_SEARCH_VERSION])
}
export function summaryMatches(row: OutputSummary | undefined, file: OutputFile, root: string, parserVersion: number): row is OutputSummary {
  return !!row && row.key === summaryKey(file, root, parserVersion)
}
export function makeOutputSummary(file: OutputFile, meta: OutputMetadata | null, parserVersion: number, root = meta?.sourceIdentity?.root || file.sourceId || 'output'): OutputSummary {
  return { imageId: file.id, sourceId: file.sourceId || 'output', path: file.path, filename: file.filename,
    root, mtime: file.mtime, size: file.size, parserVersion, indexVersion: OUTPUT_SEARCH_VERSION,
    key: summaryKey(file, root, parserVersion), model: meta?.model || '', prompt: meta?.prompt || '', identityPrompt: meta?.identityPrompt || '',
    loras: meta?.loras || [], hasWorkflow: meta?.hasWorkflow || !!meta?.workflowJson, metadataState: metadataStateOf(meta), metadataWarnings: meta?.metadataWarnings, tagKeys: [], searchAliases: [], characters: [], works: [],
    classificationVersion: '', classificationStatus: 'pending', indexStatus: meta ? meta.summaryStatus || 'ready' : 'pending',
    notes: file.notes, manualTags: file.tags, tagSource: (meta?.prompt || meta?.identityPrompt)?.trim() ? 'saved' : 'none' }
}
export interface OutputQuery { query: string; model?: string; lora?: string; tag?: string }
function documentText(row: OutputSummary): string {
  return normalizeOutputSearch([row.filename, row.path, row.model, row.prompt, row.notes || '',
    ...row.loras, ...row.tagKeys, ...row.searchAliases, ...(row.manualTags || []), ...(row.inferredTags || []),
    ...row.characters.flatMap(entity => [entity.name, entity.tag || entity.id, ...(entity.aliases || [])]),
    ...row.works.flatMap(entity => [entity.name, entity.tag || entity.id, ...(entity.aliases || [])])].join('\n'))
}
export function matchesOutputQuery(row: OutputSummary, query: OutputQuery): boolean {
  const terms = outputSearchTerms(query.query)
  const text = documentText(row)
  if (!terms.every(term => text.includes(term))) return false
  if (query.model && !normalizeOutputSearch(row.model).includes(normalizeOutputSearch(query.model))) return false
  if (query.lora && !row.loras.some(lora => normalizeOutputSearch(lora).includes(normalizeOutputSearch(query.lora!)))) return false
  if (query.tag && ![...row.tagKeys, ...(row.manualTags || [])].some(tag => normalizeOutputSearch(tag).includes(normalizeOutputSearch(query.tag!)))) return false
  return true
}
/** Text is normalized once per changed record, never once per search or per term. */
export class OutputQueryIndex {
  private records = new Map<string, { row: OutputSummary; text: string }>()
  replace(rows: OutputSummary[]): void { this.records.clear(); this.upsert(rows) }
  upsert(rows: OutputSummary[]): void { for (const row of rows) this.records.set(row.imageId, { row, text: documentText(row) }) }
  remove(ids: string[]): void { for (const id of ids) this.records.delete(id) }
  query(query: OutputQuery): string[] {
    const terms = outputSearchTerms(query.query), model = normalizeOutputSearch(query.model || ''), lora = normalizeOutputSearch(query.lora || ''), tag = normalizeOutputSearch(query.tag || '')
    const ids: string[] = []
    for (const [id, { row, text }] of this.records) {
      if (!terms.every(term => text.includes(term))) continue
      if (model && !normalizeOutputSearch(row.model).includes(model)) continue
      if (lora && !row.loras.some(value => normalizeOutputSearch(value).includes(lora))) continue
      if (tag && ![...row.tagKeys, ...(row.manualTags || [])].some(value => normalizeOutputSearch(value).includes(tag))) continue
      ids.push(id)
    }
    return ids
  }
}
function orderedEntities(entities: OutputSummary['characters']) {
  return [...new Map(entities.map(entity => [entity.id, entity])).values()].sort((a, b) => a.id.localeCompare(b.id))
}
/** Memberships project one image into each named character/work folder; storage stays unique. */
export interface OutputGroupDescriptor { key: string; label: string; workKey: string; workLabel: string; rank: number; characterId?: string; workId?: string }
export function outputGroups(row: OutputSummary | undefined, mode: OutputGroupMode): OutputGroupDescriptor[] {
  if (mode === 'none' || mode === 'flat') return [{ key: '', label: '', workKey: '', workLabel: '', rank: 0 }]
  const pending = !row || row.indexStatus === 'pending' || row.classificationStatus === 'pending'
  const failed = row?.indexStatus === 'error' || row?.classificationStatus === 'error'
  // The classifier excludes unresolved candidates from characters already.
  // A separate ambiguous term must not hide identities confirmed in this image.
  const characters = orderedEntities(pending || failed ? [] : row?.characters || [])
  const works = orderedEntities(pending || failed ? [] : row?.works || [])
  const empty = pending ? '待整理' : failed ? row?.indexStatus === 'error' ? '读取失败' : '识别失败' : '未识别'
  const rows: OutputGroupDescriptor[] = []
  for (const work of mode === 'work' ? works.length ? works : [undefined] : [undefined]) {
    const assigned = mode === 'work' && work ? characters.filter(character => !character.workIds?.length || character.workIds.includes(work.id)) : characters
    for (const character of assigned.length ? assigned : [undefined]) {
      const characterKey = character ? JSON.stringify([character.id]) : empty
      const workKey = work ? JSON.stringify([work.id]) : empty
      rows.push({ key: JSON.stringify(mode === 'work' ? [workKey, characterKey] : [characterKey]),
        characterId: character?.id, workId: work?.id,
        label: character?.name || character?.tag || character?.id || empty,
        workKey: JSON.stringify(['work', workKey]), workLabel: work?.name || work?.tag || work?.id || empty,
        rank: pending ? 2 : failed ? 3 : (mode === 'work' ? !work : !character) ? 1 : 0 })
    }
  }
  return rows
}
/** Stable first membership is used only for sorting, never to choose a folder's contents. */
export const outputGroup = (row: OutputSummary | undefined, mode: OutputGroupMode) => outputGroups(row, mode)[0]
export const outputGroupKey = (row: OutputSummary | undefined, mode: OutputGroupMode): string => outputGroup(row, mode).key
const groupCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
export function compareOutputGroupDescriptors(left: ReturnType<typeof outputGroup>, right: ReturnType<typeof outputGroup>, mode: OutputGroupMode): number {
  return left.rank - right.rank || (mode === 'work' && left.workKey !== right.workKey ? groupCollator.compare(left.workLabel, right.workLabel) || left.workKey.localeCompare(right.workKey) : 0)
    || (left.key === right.key ? 0 : groupCollator.compare(left.label, right.label) || left.key.localeCompare(right.key))
}
export function compareOutputGroups(a: OutputSummary | undefined, b: OutputSummary | undefined, mode: OutputGroupMode): number {
  const left = outputGroup(a, mode), right = outputGroup(b, mode)
  return compareOutputGroupDescriptors(left, right, mode)
}
