// TK browser-local template adapter. No independent plugin/server required.
import { parseJsonLoose, resolveToState, serialize, matchingStudio } from './moss'
type Entry = { name: string; stem: string; caption: string; thumb?: string }
let opening: Promise<IDBDatabase> | null = null
function database(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise((resolve, reject) => {
    const r = indexedDB.open('tk-moss-layout-templates-v1', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('templates', { keyPath: 'name' })
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); opening = null }; resolve(r.result) }
    r.onerror = () => { opening = null; reject(r.error) }
    r.onblocked = () => { opening = null; reject(new Error('请关闭旧版模板窗口后重试')) }
  })
  return opening
}
async function transaction<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('templates', mode), request = run(tx.objectStore('templates'))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('模板保存中断'))
  })
}
const thumbs = new Map<string, string>()
export function thumbUrl(_dir: string, name: string): string { return thumbs.get(name.replace(/\.thumb\.jpg$/, '.json')) || '' }
export interface PreviewResult { preview: string; valid: boolean; errors: string[]; warnings: string[]; error?: string }
export async function previewJson(json: string): Promise<PreviewResult> {
  const parsed = parseJsonLoose(json)
  if (!parsed.ok) return { preview: '', valid: false, errors: [parsed.error], warnings: [] }
  const result = resolveToState(parsed.obj?.draft || parsed.obj, 1024, 1024), state = result.state
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = Math.max(1, Math.min(1024, Math.round(320 * (state.height || 1024) / (state.width || 1024))))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#202026'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(canvas.width / (state.width || 1024), canvas.height / (state.height || 1024)); ctx.lineWidth = 5
  for (const el of state.elements || []) { const [x,y,x2,y2] = el.bbox; ctx.strokeStyle = el.boxColor; ctx.strokeRect(x,y,x2-x,y2-y) }
  return { preview: canvas.toDataURL('image/png'), valid: !result.errors.length, errors: result.errors, warnings: result.warnings }
}
export async function listLibrary() {
  const entries = await transaction<Entry[]>('readonly', s => s.getAll())
  thumbs.clear(); entries.forEach(e => { if (e.thumb) thumbs.set(e.name, e.thumb) })
  return { dir: 'browser', templates: entries.sort((a,b) => a.name.localeCompare(b.name)) }
}
export async function saveTemplate(_dir: string, name: string, json: string, overwrite = false, thumb = '') {
  const parsed = parseJsonLoose(json)
  if (!parsed.ok) throw new Error(parsed.error)
  const state = resolveToState(parsed.obj?.draft || parsed.obj, 1024, 1024, { strict: true })
  if (state.errors.length) throw new Error(state.errors.join('；'))
  const stem = name.trim().replace(/\.json$/i, '') || 'template_001', key = stem + '.json'
  const existing = await transaction<Entry>('readonly', s => s.get(key))
  if (existing && !overwrite) return { ok: false, error: '已有同名模板，请改名后保存' }
  const canonical = serialize(state.state as any).draft
  const studio = matchingStudio(parsed.obj?.studio, canonical)
  const payload = studio ? { draft: canonical, studio } : canonical
  await transaction('readwrite', s => s.put({ name: key, stem, caption: JSON.stringify(payload), thumb }))
  return { ok: true, name: stem }
}
export async function deleteTemplate(name: string) {
  await transaction('readwrite', s => s.delete(name)); thumbs.delete(name)
  return { ok: true, removed: [name] }
}
