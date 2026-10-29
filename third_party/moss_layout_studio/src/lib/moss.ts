// MOSS-Image Layout model + client-side compiler. Mirrors backend/utils/moss.py
// (key order, floor/ceil centering, minified separators); Python is authoritative.

import { isRecord } from './guards'

export type Label = 'object' | 'character' | 'text'
export const LABELS: Label[] = ['object', 'character', 'text']
export const CANVAS_MODES = ['single', 'multi_panel', 'collage'] as const
export type CanvasMode = (typeof CANVAS_MODES)[number]

export interface MossElement {
  id: string
  label: Label
  bbox: [number, number, number, number] // pixel [x1,y1,x2,y2], top-left origin
  caption: string
  text: string        // literal text (text items)
  tags: string[]
  palette: string[]   // hex colors
  // editor-only (never in the draft)
  boxColor: string
  linkId: string | null
  groupId: string | null
}

export interface SummaryState {
  caption: string
  meta: string[]
  canvas: CanvasMode
  palette: string[]
}

export interface OverlaySettings {
  lineWidth: number
  fillAlpha: number
  labelSize: number
  showIndex: boolean
  showText: boolean
}

export interface UiPrefs {
  showLabels: boolean
  backdropOpacity: number
  newType: Label
  jsonOpen: boolean
  summaryOpen: boolean
  itemsOpen: boolean
  showPresets: boolean
  jsonSync: boolean
  livePreview: boolean
  sync: boolean
}

export interface MossState {
  width: number
  height: number
  summary: SummaryState
  elements: MossElement[]
  overlay: OverlaySettings
  ui: UiPrefs
}

export interface DraftItem {
  label: Label
  caption: string
  bbox: [number, number, number, number]
  text?: string
  tags?: string[]
  palette?: string[]
}

export interface Draft {
  width: number
  height: number
  bbox_coord_space: 'abs'
  bbox_format: 'xyxy'
  summary: { caption: string; meta?: string[]; canvas?: CanvasMode; palette?: string[] }
  items: DraftItem[]
}

export type BboxMode = 'reject' | 'auto' | 'clamp'

export interface ResolveOptions {
  strict?: boolean
  bboxMode?: BboxMode
  bboxTolerance?: number
}

export interface ResolveResult {
  state: Partial<MossState>
  warnings: string[]
  errors: string[]
}

// ---- guards for untrusted JSON (workflow values, pasted text, sync payloads) ----

function isNumArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
}

// Colors auto-assigned to new boxes.
export const BOX_PALETTE = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee', '#f87171', '#a3e635']
let _colorSeq = 0
export function nextBoxColor(): string {
  return BOX_PALETTE[_colorSeq++ % BOX_PALETTE.length]
}

export function groupColor(groupId: string): string {
  let h = 0
  for (let i = 0; i < groupId.length; i++) h = (h * 31 + groupId.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 70% 55%)`
}

export function emptyOverlay(): OverlaySettings {
  return { lineWidth: 3, fillAlpha: 0.18, labelSize: 16, showIndex: true, showText: true }
}

export function emptyUi(): UiPrefs {
  return { sync: true, showLabels: true, backdropOpacity: 0.5, newType: 'object', jsonOpen: false, summaryOpen: true, itemsOpen: true, showPresets: false, jsonSync: false, livePreview: false }
}

let _seq = 0
export function newId(): string {
  return `e${++_seq}_${Math.random().toString(36).slice(2, 7)}`
}

export function syncSeq(ids: Array<string | null | undefined>) {
  for (const id of ids) {
    const m = id && /^(?:e)(\d+)_/.exec(id)
    if (m) _seq = Math.max(_seq, parseInt(m[1], 10))
  }
}

export function newElement(label: Label, bbox: MossElement['bbox']): MossElement {
  return { id: newId(), label, bbox, caption: '', text: '', tags: [], palette: [], boxColor: nextBoxColor(), linkId: null, groupId: null }
}

export function emptyState(): MossState {
  return {
    width: 1024, height: 1024,
    summary: { caption: '', meta: [], canvas: 'single', palette: [] },
    elements: [],
    overlay: emptyOverlay(),
    ui: emptyUi(),
  }
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/

export function normalizeHex(raw: string): string | null {
  const s = raw.trim()
  if (HEX_RE.test(s)) return s.toUpperCase()
  if (/^#[0-9A-Fa-f]{3}$/.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('').toUpperCase()
  return null
}

export function snapDim(v: number): number {
  const n = Math.round(v)
  // TK: layout coordinates belong to the exact canvas. Latent alignment belongs upstream.
  return Math.max(1, n)
}

export function clampBbox(b: [number, number, number, number], w: number, h: number): [number, number, number, number] {
  let [x1, y1, x2, y2] = b
  x1 = Math.max(0, Math.min(w, x1)); x2 = Math.max(0, Math.min(w, x2))
  y1 = Math.max(0, Math.min(h, y1)); y2 = Math.max(0, Math.min(h, y2))
  if (x1 > x2) [x1, x2] = [x2, x1]
  if (y1 > y2) [y1, y2] = [y2, y1]
  return [x1, y1, x2, y2]
}

// The canonical draft exactly as it appears in the workflow JSON.
export function buildDraft(state: MossState): Draft {
  const width = snapDim(state.width)
  const height = snapDim(state.height)
  const summary: Draft['summary'] = { canvas: state.summary.canvas, caption: state.summary.caption.trim() || 'A scene arranged according to the specified regional composition.' }
  if (state.summary.meta.length) summary.meta = [...state.summary.meta]
  if (state.summary.palette.length) summary.palette = [...state.summary.palette]
  const items: DraftItem[] = state.elements.map((el) => {
    const it: DraftItem = { label: el.label, caption: el.caption.trim() || (el.label === 'text' ? 'Visible lettering.' : el.label === 'character' ? 'A character in this region.' : 'An object in this region.'), bbox: clampBbox(el.bbox, width, height) }
    if (el.label === 'text') it.text = el.text
    if (el.tags.length) it.tags = [...el.tags]
    if (el.palette.length) it.palette = [...el.palette]
    return it
  })
  return { width, height, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary, items }
}

// Compiled model prompt: integer center-origin yxyx boxes, minified one line.
// Mirrors the official compiler (floor mins / ceil maxs, then subtract center).
export function compileDraft(draft: Draft): { json: string; warnings: string[] } {
  const warnings: string[] = []
  const width = draft.width, height = draft.height
  const items = draft.items.map((it) => {
    const [x1, y1, x2, y2] = it.bbox
    const box = [
      Math.floor(y1) - (height >> 1),
      Math.floor(x1) - (width >> 1),
      Math.ceil(y2) - (height >> 1),
      Math.ceil(x2) - (width >> 1),
    ]
    const out: Record<string, unknown> = { label: it.label, caption: it.caption, bbox: box }
    if (it.text) out.text = it.text
    if (it.tags?.length) out.tags = it.tags
    if (it.palette?.length) out.palette = it.palette
    return out
  })
  const result = { summary: draft.summary, items, bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx' }
  return { json: JSON.stringify(result), warnings }
}

export function serialize(state: MossState): { draft: Draft; draftPretty: string; prompt: string; warnings: string[] } {
  const draft = buildDraft(state)
  const compiled = compileDraft(draft)
  return { draft, draftPretty: JSON.stringify(draft, null, 2), prompt: compiled.json, warnings: compiled.warnings }
}

// Editor metadata is accepted only when it still describes the authoritative draft.
export function matchingStudio(value: unknown, draft: Draft): MossState | null {
  if (!isRecord(value) || !Array.isArray(value.elements) || !isRecord(value.summary) || !isRecord(value.ui) || !isRecord(value.overlay)) return null
  try {
    const state = value as unknown as MossState
    return JSON.stringify(serialize(state).draft) === JSON.stringify(draft) ? state : null
  } catch { return null }
}

// Recover a JSON object from text that may be wrapped in code fences or prose.
export function parseJsonLoose(text: string): { ok: true; obj: Record<string, unknown> } | { ok: false; error: string } {
  if (!text || !text.trim()) return { ok: false, error: 'empty input' }
  let s = text.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^`+/, '').replace(/`+$/, '')
    if (/^json/i.test(s.trim())) s = s.trim().slice(4)
    s = s.trim()
  }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' }
  try {
    const obj: unknown = JSON.parse(s.slice(start, end + 1))
    if (!isRecord(obj)) return { ok: false, error: 'payload is not a JSON object' }
    return { ok: true, obj }
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

// Any of: draft JSON (abs/xyxy), compiled prompt JSON (abs_centralized/yxyx),
// or {'caption': ...} -> editor state. Mirrors backend import_payload.
//
// Legacy workflow loads call this non-strict: coercions become warnings.
// Manual paste / JSON Sync call it strict: invalid labels, missing text,
// unsupported formats and out-of-canvas boxes are errors, and the caller must
// not apply the result.
function _issue(strict: boolean, message: string, warnings: string[], errors: string[]) {
  if (strict) errors.push(message)
  else warnings.push(message)
}

function _readDim(value: unknown, where: string, strict: boolean, warnings: string[], errors: string[]): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    _issue(strict, `${where} must be a positive integer; got ${String(value)}`, warnings, errors)
    return null
  }
  if (strict) {
    if (!Number.isInteger(value)) {
      _issue(strict, `${where} must be a positive integer; got ${value}`, warnings, errors)
      return null
    }
    return value
  }
  const snapped = snapDim(value)
  if (!Number.isInteger(value)) {
    warnings.push(`${where} ${value} rounded to ${snapped}`)
  }
  return snapped
}

function _stringList(value: unknown, where: string, strict: boolean, warnings: string[], errors: string[]): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    _issue(strict, `${where}: expected an array of strings`, warnings, errors)
    return []
  }
  const out: string[] = []
  value.forEach((entry, j) => {
    if (typeof entry === 'string') out.push(entry)
    else warnings.push(`${where}[${j}]: non-string entry dropped`)
  })
  return out
}

function _fallbackBox(w: number, h: number): [number, number, number, number] {
  return [0, 0, Math.min(64, Math.max(16, w)), Math.min(64, Math.max(16, h))]
}

function _fmtBox(box: unknown): string {
  return Array.isArray(box) ? `[${box.map((v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v)).join(', ')}]` : String(box)
}

export function resolveToState(
  obj: unknown,
  width: number,
  height: number,
  opts: ResolveOptions = {},
): ResolveResult {
  const strict = opts.strict ?? false
  const bboxMode: BboxMode = opts.bboxMode ?? (strict ? 'reject' : 'clamp')
  const rawTolerance = Number(opts.bboxTolerance ?? 2)
  const bboxTolerance = Number.isFinite(rawTolerance) ? Math.max(0, rawTolerance) : 2
  const warnings: string[] = []
  const errors: string[] = []
  if (!isRecord(obj)) {
    _issue(strict, 'payload is not a JSON object', warnings, errors)
    return { state: {}, warnings, errors }
  }

  // ---- format detection: never silently reinterpret an unknown format ----
  const hasCoord = 'bbox_coord_space' in obj
  const hasFmt = 'bbox_format' in obj
  let compiled = false
  let editor = false
  if (hasCoord) {
    const coord = obj.bbox_coord_space
    if (typeof coord !== 'string') {
      _issue(strict, 'bbox_coord_space must be a string', warnings, errors)
    } else if (coord !== 'abs' && coord !== 'abs_centralized') {
      _issue(strict, `unsupported bbox_coord_space '${coord}'; expected 'abs' or 'abs_centralized'`, warnings, errors)
    } else if (coord === 'abs_centralized') {
      compiled = true
    } else {
      editor = true
    }
  }
  if (hasFmt) {
    const fmt = obj.bbox_format
    if (typeof fmt !== 'string') {
      _issue(strict, 'bbox_format must be a string', warnings, errors)
    } else if (fmt !== 'xyxy' && fmt !== 'yxyx') {
      _issue(strict, `unsupported bbox_format '${fmt}'; expected 'xyxy' or 'yxyx'`, warnings, errors)
    } else if (fmt === 'yxyx') {
      compiled = true
    } else {
      editor = true
    }
  }
  if (compiled && editor) {
    _issue(
      strict,
      'conflicting bbox_coord_space/bbox_format: compiled coordinates (abs_centralized/yxyx) '
        + 'cannot be combined with editor coordinates (abs/xyxy)',
      warnings,
      errors,
    )
  }

  type Kind = 'editor_draft' | 'compiled_prompt' | 'caption_only'
  let kind: Kind = compiled ? 'compiled_prompt' : 'editor_draft'
  if (!compiled && !editor && !hasCoord && !hasFmt) {
    const summary = isRecord(obj.summary) ? obj.summary : {}
    if (!('items' in obj) && (typeof obj.caption === 'string' || typeof summary.caption === 'string')) {
      kind = 'caption_only'
    } else {
      warnings.push(
        'bbox_coord_space/bbox_format missing; assuming an editor draft (abs/xyxy). '
          + 'Compiled payloads must declare abs_centralized/yxyx.',
      )
    }
  }

  // ---- canvas: payload dims win; target is only a fallback ----
  const hasW = 'width' in obj
  const hasH = 'height' in obj
  if (hasW !== hasH) _issue(strict, 'width and height must both be provided', warnings, errors)
  const pw = hasW ? _readDim(obj.width, 'width', strict, warnings, errors) : null
  const ph = hasH ? _readDim(obj.height, 'height', strict, warnings, errors) : null
  const tw = _readDim(width, 'target width', strict, warnings, errors)
  const th = _readDim(height, 'target height', strict, warnings, errors)

  let w: number
  let h: number
  if (pw && ph) {
    w = pw
    h = ph
    if (tw && th && (tw !== pw || th !== ph)) {
      warnings.push(
        `target canvas ${tw}x${th} ignored: payload declares ${pw}x${ph} `
          + '(external width/height take priority)',
      )
    }
    if (kind === 'compiled_prompt') {
      warnings.push(`compiled prompt de-centered onto its declared canvas ${pw}x${ph}`)
    }
  } else if (kind === 'compiled_prompt') {
    if (!hasW && !hasH) {
      _issue(
        strict,
        'compiled prompt has no width/height; pass target width/height '
          + '(the canvas cannot be inferred from center-origin boxes)',
        warnings,
        errors,
      )
    }
    w = tw ?? snapDim(width)
    h = th ?? snapDim(height)
    if (tw && th) warnings.push(`compiled prompt has no width/height; de-centered onto target canvas ${tw}x${th}`)
  } else if (tw && th) {
    w = tw
    h = th
    if (!(hasW && hasH)) warnings.push(`width/height missing; using target canvas ${tw}x${th}`)
  } else {
    w = snapDim(width)
    h = snapDim(height)
    warnings.push('width/height missing; defaulted to 1024x1024')
  }

  // ---- summary ----
  let rawSummary: Record<string, unknown> = {}
  if (obj.summary !== undefined) {
    if (isRecord(obj.summary)) rawSummary = obj.summary
    else _issue(strict, 'summary must be an object', warnings, errors)
  }
  let caption = ''
  if (kind === 'caption_only' && 'caption' in obj) {
    if (typeof obj.caption === 'string') {
      caption = obj.caption
      if (typeof rawSummary.caption === 'string' && rawSummary.caption && rawSummary.caption !== caption) {
        warnings.push('caption-only payload: root caption overrides summary.caption')
      }
    } else {
      _issue(strict, 'caption must be a string', warnings, errors)
    }
  } else if ('caption' in rawSummary) {
    if (typeof rawSummary.caption === 'string') caption = rawSummary.caption
    else _issue(strict, 'summary.caption must be a string', warnings, errors)
  }
  if (!caption.trim()) warnings.push('summary.caption is empty; the compiled prompt requires caption text')

  const meta = _stringList(rawSummary.meta, 'summary.meta', strict, warnings, errors)
  const palette = _stringList(rawSummary.palette, 'summary.palette', strict, warnings, errors)
  const canvasRaw = rawSummary.canvas ?? 'single'
  const canvas: CanvasMode = (CANVAS_MODES as readonly string[]).includes(canvasRaw as string)
    ? (canvasRaw as CanvasMode)
    : (() => {
        _issue(strict, `summary.canvas '${String(canvasRaw)}' invalid; expected single, multi_panel or collage`, warnings, errors)
        return 'single' as CanvasMode
      })()
  for (const key of Object.keys(rawSummary)) {
    if (!['meta', 'canvas', 'caption', 'palette'].includes(key)) {
      warnings.push(`summary.${key}: not an official summary field; dropped`)
    }
  }
  const summary: SummaryState = { caption, meta, canvas, palette }

  // ---- items ----
  let rawItems: unknown[] = []
  if (obj.items === undefined) {
    if (kind !== 'caption_only') warnings.push('items is missing; imported an empty layout')
  } else if (!Array.isArray(obj.items)) {
    _issue(strict, 'items must be an array', warnings, errors)
  } else {
    rawItems = obj.items
  }

  const halfW = w >> 1
  const halfH = h >> 1
  const elements: MossElement[] = []
  rawItems.forEach((raw, i) => {
    const where = `items[${i}]`
    if (!isRecord(raw)) {
      _issue(strict, `${where} is not an object; the item was not imported`, warnings, errors)
      elements.push(newElement('object', _fallbackBox(w, h)))
      return
    }
    for (const key of Object.keys(raw)) {
      if (!['label', 'caption', 'bbox', 'text', 'tags', 'palette'].includes(key)) {
        warnings.push(`${where}.${key}: not an official item field; dropped`)
      }
    }

    let label: Label = 'object'
    if (raw.label !== 'object' && raw.label !== 'character' && raw.label !== 'text') {
      _issue(strict, `${where}.label '${String(raw.label)}' invalid; expected object, character or text`, warnings, errors)
    } else {
      label = raw.label
    }

    let itemCaption = ''
    if (typeof raw.caption === 'string') {
      itemCaption = raw.caption
      if (!itemCaption.trim()) warnings.push(`${where}.caption is empty; the compiled prompt requires caption text`)
    } else if (raw.caption !== undefined) {
      _issue(strict, `${where}.caption must be a string`, warnings, errors)
    }

    let bbox: [number, number, number, number]
    if (!isNumArray(raw.bbox)) {
      _issue(strict, `${where}.bbox must be four finite numbers`, warnings, errors)
      bbox = _fallbackBox(w, h)
    } else {
      const box: [number, number, number, number] = kind === 'compiled_prompt'
        ? [
            raw.bbox[1] + halfW, raw.bbox[0] + halfH,
            raw.bbox[3] + halfW, raw.bbox[2] + halfH,
          ]
        : [...raw.bbox] as [number, number, number, number]
      if (!(box[0] < box[2] && box[1] < box[3])) {
        _issue(strict, `${where}.bbox must have positive width and height; got ${_fmtBox(box)}`, warnings, errors)
        bbox = _fallbackBox(w, h)
      } else if (!(0 <= box[0] && box[2] <= w && 0 <= box[1] && box[3] <= h)) {
        const overflow = Math.max(0 - box[0], box[2] - w, 0 - box[1], box[3] - h)
        const shouldClamp = bboxMode === 'clamp'
          || (bboxMode === 'auto' && overflow <= bboxTolerance)
        if (shouldClamp) {
          const clamped = clampBbox(box, w, h)
          if (!(clamped[0] < clamped[2] && clamped[1] < clamped[3])) {
            _issue(
              strict,
              `${where}.bbox ${_fmtBox(box)} collapses to zero area when clamped to ${w}x${h}`,
              warnings,
              errors,
            )
            bbox = _fallbackBox(w, h)
          } else {
            const how = bboxMode === 'auto' ? 'auto-clamped' : 'clamped'
            const extra = bboxMode === 'auto'
              ? ` (overflow ${overflow.toFixed(2)}px <= tolerance ${bboxTolerance}px)`
              : ''
            warnings.push(`${where}.bbox ${_fmtBox(box)} exceeded canvas ${w}x${h}; ${how} to ${_fmtBox(clamped)}${extra}`)
            bbox = clamped
          }
        } else {
          const hint = bboxMode === 'auto'
            ? `bbox_mode='auto', tolerance=${bboxTolerance}px; use 'clamp' to accept a clamped box`
            : "bbox_mode='reject'; use 'auto' with a tolerance or 'clamp' to accept a clamped box"
          _issue(
            strict,
            `${where}.bbox ${_fmtBox(box)} exceeds canvas ${w}x${h} by ${overflow.toFixed(2)}px (${hint})`,
            warnings,
            errors,
          )
          bbox = clampBbox(box, w, h)
          if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) bbox = _fallbackBox(w, h)
        }
      } else {
        bbox = box
      }
    }

    const el = newElement(label, bbox)
    el.caption = itemCaption
    if (raw.text !== undefined) {
      if (typeof raw.text === 'string') {
        if (label === 'text' && !raw.text.trim()) {
          _issue(strict, `${where}: text items require a non-empty literal 'text'`, warnings, errors)
        } else if (label !== 'text' && !raw.text.trim()) {
          warnings.push(`${where}.text is empty; omitted from the canonical draft`)
        }
        el.text = raw.text
      } else if (label === 'text') {
        _issue(strict, `${where}: text items require a non-empty literal 'text'`, warnings, errors)
      } else {
        warnings.push(`${where}.text is not a string; omitted from the canonical draft`)
      }
    } else if (label === 'text') {
      _issue(strict, `${where}: text items require a non-empty literal 'text'`, warnings, errors)
    }
    el.tags = _stringList(raw.tags, `${where}.tags`, strict, warnings, errors)
    el.palette = _stringList(raw.palette, `${where}.palette`, strict, warnings, errors)
    elements.push(el)
  })

  if (!elements.length) warnings.push('items is empty; the compiled prompt requires at least one item')
  return { state: { width: w, height: h, summary, elements }, warnings, errors }
}

// Parse an aspect-ratio string ("16:9", "16x9") into width/height preserving the
// megapixel count (snapped to /16). Null if not a ratio.
export function aspectToWH(ar: string, refW = 1024, refH = 1024): { w: number; h: number } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(ar)
  if (!m) return null
  const rw = parseFloat(m[1]), rh = parseFloat(m[2])
  if (!rw || !rh) return null
  const scale = Math.sqrt((refW * refH) / (rw * rh))
  return { w: snapDim(rw * scale), h: snapDim(rh * scale) }
}
