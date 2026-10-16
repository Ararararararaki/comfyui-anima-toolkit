import { computeMasonryLayout } from '../components/masonry'
import { outputGroup } from './outputQuery'
import type { OutputFile, OutputSummary, OutputGroupMode } from '../types/outputs'
export interface OutputLayoutItem { file?: OutputFile; key: string; label?: string; count?: number; work?: boolean; collapsed?: boolean; top: number; left: number; width: number; height: number; aspect?: number }
export function outputGroupedLayout(files: OutputFile[], summaries: Map<string, OutputSummary>, mode: OutputGroupMode, collapsed: Set<string>, cols: number, cardW: number, gap: number) {
  const items: OutputLayoutItem[] = [], rects = new Map<string, OutputLayoutItem>()
  const width = cols * cardW + (cols - 1) * gap
  let top = 0, previousWork = ''
  for (let offset = 0; offset < files.length;) {
    const first = outputGroup(summaries.get(files[offset].id), mode)
    let end = offset + 1
    while (end < files.length && outputGroup(summaries.get(files[end].id), mode).key === first.key) end++
    const groupFiles = files.slice(offset, end)
    if (mode === 'work' && previousWork !== first.workKey) {
      let workEnd = end
      while (workEnd < files.length && outputGroup(summaries.get(files[workEnd].id), mode).workKey === first.workKey) workEnd++
      items.push({ key: first.workKey, label: first.workLabel, count: workEnd - offset, work: true, collapsed: collapsed.has(first.workKey), top, left: 0, width, height: 40 }); top += 46; previousWork = first.workKey
    }
    const workHidden = mode === 'work' && collapsed.has(first.workKey)
    if (mode !== 'none' && !workHidden) { items.push({ key: first.key, label: first.label, count: groupFiles.length, collapsed: collapsed.has(first.key), top, left: 0, width, height: 32 }); top += 38 }
    if (!workHidden && !(mode !== 'none' && collapsed.has(first.key))) {
      const layout = computeMasonryLayout(groupFiles, cols, cardW, gap)
      groupFiles.forEach((file, index) => { const item = { file, key: file.id, top: top + layout.tops[index], left: layout.lefts[index], width: layout.widths[index], height: layout.heights[index], aspect: layout.boxAspects[index] }; items.push(item); rects.set(file.id, item) })
      top += layout.total + (mode === 'none' ? 0 : gap)
    }
    offset = end
  }
  return { items, rects, total: top }
}
