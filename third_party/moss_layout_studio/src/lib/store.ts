import { reactive, inject, provide, type InjectionKey } from 'vue'
import { emptyState, emptyUi, newElement, newId, syncSeq, serialize, resolveToState, parseJsonLoose, clampBbox, matchingStudio, type MossElement, type MossState, type Label, type BboxMode } from './moss'

// Fields linked elements share; bbox excluded so each copy keeps its position.
export const SHARED_KEYS = ['label', 'caption', 'text', 'tags', 'palette', 'boxColor'] as const
type SharedKey = (typeof SHARED_KEYS)[number]

// Clear linkId on a now-lone link member.
function _pruneLink(elements: MossElement[], groupId: string | null) {
  if (!groupId) return
  const members = elements.filter((e) => e.linkId === groupId)
  if (members.length === 1) members[0].linkId = null
}

// Clear groupId on a now-lone group member.
function _pruneGroup(elements: MossElement[], groupId: string | null) {
  if (!groupId) return
  const members = elements.filter((e) => e.groupId === groupId)
  if (members.length === 1) members[0].groupId = null
}

// Expand ids to include every co-member of any group they touch (deduped, ordered).
function _expandGroups(elements: MossElement[], ids: string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const el = elements.find((e) => e.id === id)
    if (!el) continue
    const members = el.groupId ? elements.filter((e) => e.groupId === el.groupId) : [el]
    for (const m of members) if (!out.includes(m.id)) out.push(m.id)
  }
  return out
}

function _flipBbox(el: MossElement, axis: 'h' | 'v', w: number, h: number) {
  const [x1, y1, x2, y2] = el.bbox
  el.bbox = axis === 'h' ? [w - x2, y1, w - x1, y2] : [x1, h - y2, x2, h - y1]
}

export interface ImportOptions {
  keepDims?: boolean
  strict?: boolean
  bboxMode?: BboxMode
  bboxTolerance?: number
}

export interface ImportResult {
  ok: boolean
  error?: string
  warnings?: string[]
  errors?: string[]
}

// Clipboard entry; transient, not serialized.
export interface ClipItem {
  label: Label
  bbox: [number, number, number, number] | null
  caption: string
  text: string
  tags: string[]
  palette: string[]
  boxColor: string
  grouped: boolean
}

export interface StudioStore {
  _hist: string[]
  _hi: number
  _restore(snap: string): void
  _copyOf(element: MossElement, dx: number): MossElement
  state: MossState
  selectedIds: string[]
  readonly selectedId: string | null
  isSelected(id: string): boolean
  canUndo: boolean
  canRedo: boolean
  snapshot(): void
  undo(): void
  redo(): void
  resetHistory(): void
  select(id: string | null, additive?: boolean): void
  setSelection(ids: string[], additive?: boolean): void
  addElement(label: Label, bbox?: MossElement['bbox'] | null): MossElement
  removeElement(id: string): void
  duplicateElement(id: string): void
  duplicateMany(ids: string[]): void
  duplicateLinked(id: string): void
  unlink(id: string): void
  linkGroupSize(id: string): number
  group(ids: string[]): void
  ungroup(id: string): void
  groupMembers(id: string): MossElement[]
  groupSize(id: string): number
  copySelection(): void
  pasteAt(x: number, y: number): void
  setShared(id: string, key: SharedKey, value: unknown): void
  moveElement(id: string, dir: -1 | 1): void
  moveElementTo(id: string, index: number): void
  getElement(id: string | null): MossElement | undefined
  load(s: Partial<MossState>): void
  json: {
    editing: boolean
    draft: string
    syncError: string
    syncWarnings: string[]
    syncNote: string
    applyErrors: string[]
    applyWarnings: string[]
    wasOpen: boolean
  }
  refImage: string
  clipboard: ClipItem[]
  ctxMenu: { x: number; y: number; id: string } | null
  openContextMenu(x: number, y: number, id: string): void
  closeContextMenu(): void
  jsonStartEdit(): void
  jsonCancel(): void
  jsonTidy(): void
  jsonApply(): void
  jsonApplyClamp(): void
  refitToCanvas(): number
  importDraftJson(text: string, opts?: ImportOptions): ImportResult
  restoring: boolean
}

const KEY: InjectionKey<StudioStore> = Symbol('moss-studio')

export function createStudioStore(): StudioStore {
  const store = reactive({
    state: emptyState(),
    selectedIds: [] as string[],
    get selectedId(): string | null {
      return store.selectedIds.length ? store.selectedIds[store.selectedIds.length - 1] : null
    },
    isSelected(id: string) {
      return store.selectedIds.includes(id)
    },

    _hist: [] as string[],
    _hi: -1,
    restoring: false,
    get canUndo() {
      return store._hi > 0
    },
    get canRedo() {
      return store._hi >= 0 && store._hi < store._hist.length - 1
    },
    snapshot() {
      if (store.restoring) return
      const snap = JSON.stringify(store.state)
      if (store._hist[store._hi] === snap) return
      store._hist = store._hist.slice(0, store._hi + 1)
      store._hist.push(snap)
      if (store._hist.length > 80) store._hist.shift()
      store._hi = store._hist.length - 1
    },
    _restore(snap: string) {
      store.restoring = true
      const parsed = JSON.parse(snap) as MossState
      Object.assign(store.state, emptyState(), parsed)
      _syncSeq(store.state.elements)
      store.selectedIds = store.selectedIds.filter((id) => store.getElement(id))
      // let the deep watcher flush before re-arming snapshots
      setTimeout(() => {
        store.restoring = false
      }, 0)
    },
    undo() {
      if (!store.canUndo) return
      store._hi -= 1
      store._restore(store._hist[store._hi])
    },
    redo() {
      if (!store.canRedo) return
      store._hi += 1
      store._restore(store._hist[store._hi])
    },
    resetHistory() {
      store._hist = [JSON.stringify(store.state)]
      store._hi = 0
    },

    select(id: string | null, additive = false) {
      if (id == null) {
        store.selectedIds = []
        return
      }
      // Selecting any group member selects the whole group; the clicked id stays primary.
      const members = _expandGroups(store.state.elements, [id])
      if (additive) {
        const allSel = members.every((m) => store.selectedIds.includes(m))
        if (allSel) store.selectedIds = store.selectedIds.filter((x) => !members.includes(x))
        else for (const m of members) if (!store.selectedIds.includes(m)) store.selectedIds.push(m)
      } else {
        store.selectedIds = [...members.filter((m) => m !== id), id] // id last = primary
      }
    },
    setSelection(ids: string[], additive = false) {
      const valid = _expandGroups(store.state.elements, ids.filter((id) => store.getElement(id)))
      if (additive) {
        for (const id of valid) if (!store.selectedIds.includes(id)) store.selectedIds.push(id)
      } else {
        store.selectedIds = valid
      }
    },
    addElement(label: Label, bbox: MossElement['bbox'] | null = null) {
      // Default to a centered quarter-canvas box, staggered so repeats don't stack.
      if (!bbox) {
        const w = store.state.width, h = store.state.height
        const o = (store.state.elements.length % 6) * 32
        bbox = [
          Math.round(w * 0.2) + o, Math.round(h * 0.2) + o,
          Math.round(w * 0.55) + o, Math.round(h * 0.55) + o,
        ]
      }
      const el = newElement(label, bbox)
      store.state.elements.push(el)
      store.select(el.id)
      return el
    },
    removeElement(id: string) {
      const src = store.getElement(id)
      const lid = src?.linkId ?? null
      const grp = src?.groupId ?? null
      const i = store.state.elements.findIndex((e) => e.id === id)
      if (i >= 0) store.state.elements.splice(i, 1)
      store.selectedIds = store.selectedIds.filter((x) => x !== id)
      _pruneLink(store.state.elements, lid)
      _pruneGroup(store.state.elements, grp)
    },
    _copyOf(src: MossElement, dx: number): MossElement {
      const copy = newElement(src.label, [...src.bbox] as [number, number, number, number])
      copy.caption = src.caption
      copy.text = src.text
      copy.tags = [...src.tags]
      copy.palette = [...src.palette]
      copy.boxColor = src.boxColor
      copy.bbox = copy.bbox.map((v, idx) => {
        const max = idx % 2 === 0 ? store.state.width : store.state.height
        return Math.max(0, Math.min(max, v + dx))
      }) as [number, number, number, number]
      return copy
    },
    duplicateElement(id: string) {
      const src = store.getElement(id)
      if (!src) return
      const copy = store._copyOf(src, 24)
      store.state.elements.push(copy)
      store.select(copy.id)
    },
    // Copies of a single group form a new group.
    duplicateMany(ids: string[]) {
      const srcs = ids.map((id) => store.getElement(id)).filter((e): e is MossElement => !!e)
      if (!srcs.length) return
      const wasGroup = srcs.length > 1 && !!srcs[0].groupId && srcs.every((e) => e.groupId === srcs[0].groupId)
      const gid = wasGroup ? newId() : null
      const copyIds: string[] = []
      for (const src of srcs) {
        const copy = store._copyOf(src, 24)
        copy.groupId = gid
        store.state.elements.push(copy)
        copyIds.push(copy.id)
      }
      store.setSelection(copyIds)
    },
    flipAll(axis: 'h' | 'v') {
      for (const el of store.state.elements) _flipBbox(el, axis, store.state.width, store.state.height)
    },
    duplicateLinked(id: string) {
      const src = store.getElement(id)
      if (!src) return
      if (!src.linkId) src.linkId = newId()
      const copy = store._copyOf(src, 32)
      copy.linkId = src.linkId
      store.state.elements.push(copy)
      store.select(copy.id)
    },
    unlink(id: string) {
      const el = store.getElement(id)
      if (!el?.linkId) return
      const gid = el.linkId
      el.linkId = null
      _pruneLink(store.state.elements, gid)
    },
    linkGroupSize(id: string) {
      const el = store.getElement(id)
      if (!el?.linkId) return 1
      return store.state.elements.filter((e) => e.linkId === el.linkId).length
    },
    group(ids: string[]) {
      const valid = ids.filter((id) => store.getElement(id))
      if (valid.length < 2) return
      const gid = newId()
      for (const id of valid) {
        const e = store.getElement(id)
        if (e) e.groupId = gid
      }
      store.selectedIds = _expandGroups(store.state.elements, valid)
    },
    ungroup(id: string) {
      const el = store.getElement(id)
      if (!el?.groupId) return
      const gid = el.groupId
      for (const e of store.state.elements) if (e.groupId === gid) e.groupId = null
    },
    groupMembers(id: string) {
      const el = store.getElement(id)
      if (!el?.groupId) return el ? [el] : []
      return store.state.elements.filter((e) => e.groupId === el.groupId)
    },
    groupSize(id: string) {
      const el = store.getElement(id)
      if (!el?.groupId) return 1
      return store.state.elements.filter((e) => e.groupId === el.groupId).length
    },
    copySelection() {
      const els = store.selectedIds.map((id) => store.getElement(id)).filter((e): e is MossElement => !!e)
      if (!els.length) return
      const grouped = els.length > 1 && !!els[0].groupId && els.every((e) => e.groupId === els[0].groupId)
      store.clipboard = els.map((e) => ({
        label: e.label,
        bbox: [...e.bbox] as [number, number, number, number],
        caption: e.caption,
        text: e.text,
        tags: [...e.tags],
        palette: [...e.palette],
        boxColor: e.boxColor,
        grouped,
      }))
    },
    // Paste centered on (x,y) in pixel coords, preserving relative layout; a copied
    // group pastes as a new group. Falls back to stored positions if x/y are invalid.
    pasteAt(x: number, y: number) {
      const clip = store.clipboard
      if (!clip.length) return
      const W = store.state.width, H = store.state.height
      // rigid offset landing the bbox center at the cursor, clamped on-canvas.
      const boxed = clip.filter((c) => c.bbox)
      let dx = 0
      let dy = 0
      if (boxed.length && Number.isFinite(x) && Number.isFinite(y)) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const c of boxed) {
          x0 = Math.min(x0, c.bbox![0]); y0 = Math.min(y0, c.bbox![1]); x1 = Math.max(x1, c.bbox![2]); y1 = Math.max(y1, c.bbox![3])
        }
        dx = Math.max(-x0, Math.min(W - x1, Math.round(x - (x0 + x1) / 2)))
        dy = Math.max(-y0, Math.min(H - y1, Math.round(y - (y0 + y1) / 2)))
      }
      const grouped = clip.length > 1 && clip.every((c) => c.grouped)
      const gid = grouped ? newId() : null
      const ids: string[] = []
      for (const c of clip) {
        const el = store._copyOf({ ...c, id: '', linkId: null, groupId: null, bbox: c.bbox ?? [0, 0, 64, 64] } as MossElement, 0)
        el.groupId = gid
        if (c.bbox && (dx || dy)) {
          const [bx1, by1, bx2, by2] = el.bbox
          el.bbox = [bx1 + dx, by1 + dy, bx2 + dx, by2 + dy]
        }
        store.state.elements.push(el)
        ids.push(el.id)
      }
      store.setSelection(ids)
    },
    setShared(id: string, key: SharedKey, value: unknown) {
      const el = store.getElement(id)
      if (!el) return
      const members = el.linkId ? store.state.elements.filter((e) => e.linkId === el.linkId) : [el]
      for (const m of members) Object.assign(m, { [key]: value })
    },
    moveElement(id: string, dir: -1 | 1) {
      const i = store.state.elements.findIndex((e) => e.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= store.state.elements.length) return
      const arr = store.state.elements
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    },
    moveElementTo(id: string, index: number) {
      const arr = store.state.elements
      const from = arr.findIndex((e) => e.id === id)
      if (from < 0) return
      const to = Math.max(0, Math.min(arr.length - 1, index))
      if (from === to) return
      const [el] = arr.splice(from, 1)
      arr.splice(to, 0, el)
    },
    getElement(id: string | null) {
      return store.state.elements.find((e) => e.id === id)
    },
    refitToCanvas() {
      const w = store.state.width
      const h = store.state.height
      let changed = 0
      for (const el of store.state.elements) {
        let box = clampBbox(el.bbox, w, h)
        if (!(box[0] < box[2] && box[1] < box[3])) {
          // Fully outside; keep a small box at the nearest edge instead of collapsing.
          const cx = Math.max(0, Math.min(w, Math.round((el.bbox[0] + el.bbox[2]) / 2)))
          const cy = Math.max(0, Math.min(h, Math.round((el.bbox[1] + el.bbox[3]) / 2)))
          const x1 = Math.max(0, Math.min(w - 16, cx - 8))
          const y1 = Math.max(0, Math.min(h - 16, cy - 8))
          box = [x1, y1, Math.min(w, x1 + 16), Math.min(h, y1 + 16)]
        }
        if (box.some((v, i) => v !== el.bbox[i])) {
          el.bbox = box
          changed += 1
        }
      }
      if (changed) store.snapshot()
      return changed
    },
    load(s: Partial<MossState>) {
      Object.assign(store.state, emptyState(), s)
      // deep-merge ui/overlay so older saves (missing newer keys) get defaults
      store.state.ui = { ...emptyUi(), ...(s.ui || {}) }
      _syncSeq(store.state.elements)
    },

    json: {
      editing: false,
      draft: '',
      syncError: '',
      syncWarnings: [],
      syncNote: '',
      applyErrors: [],
      applyWarnings: [],
      wasOpen: false,
    },

    refImage: '',
    clipboard: [] as ClipItem[],
    ctxMenu: null as { x: number; y: number; id: string } | null,
    openContextMenu(x: number, y: number, id: string) {
      store.ctxMenu = { x, y, id }
    },
    closeContextMenu() {
      store.ctxMenu = null
    },
    jsonStartEdit() {
      store.json.draft = serialize(store.state).draftPretty
      store.json.applyErrors = []
      store.json.applyWarnings = []
      store.json.wasOpen = store.state.ui.jsonOpen
      store.json.editing = true
      store.state.ui.jsonOpen = true
    },
    jsonCancel() {
      store.json.editing = false
      store.state.ui.jsonOpen = store.json.wasOpen
    },
    jsonTidy() {
      // Tolerant: unwraps code fences / strips preamble while pretty-printing.
      const res = parseJsonLoose(store.json.draft)
      if (res.ok) store.json.draft = JSON.stringify(res.obj, null, 2)
    },
    jsonApply() {
      const res = store.importDraftJson(store.json.draft)
      store.json.applyErrors = res.errors ?? (res.error ? [res.error] : [])
      store.json.applyWarnings = res.warnings ?? []
      if (res.ok) {
        store.json.editing = false
        store.state.ui.jsonOpen = store.json.wasOpen
      }
    },
    jsonApplyClamp() {
      const res = store.importDraftJson(store.json.draft, { bboxMode: 'clamp' })
      store.json.applyErrors = res.errors ?? (res.error ? [res.error] : [])
      store.json.applyWarnings = res.warnings ?? []
      if (res.ok) {
        store.json.editing = false
        store.state.ui.jsonOpen = store.json.wasOpen
        store.json.syncError = ''
        store.json.syncWarnings = res.warnings ?? []
        const n = store.state.elements.length
        const warnCount = store.json.syncWarnings.length
        const warnNote = warnCount ? ` · ${warnCount} warning${warnCount === 1 ? '' : 's'}` : ''
        store.json.syncNote = `Clamped import applied · ${n} item${n === 1 ? '' : 's'}${warnNote}`
      }
    },
    importDraftJson(text: string, opts: ImportOptions = {}): ImportResult {
      // Tolerant of code fences and prose; strict on schema by default.
      const keepDims = opts.keepDims ?? false
      const strict = opts.strict ?? true
      const bboxMode: BboxMode = opts.bboxMode ?? (strict ? 'reject' : 'clamp')
      const bboxTolerance = opts.bboxTolerance ?? 2
      const res = parseJsonLoose(text)
      if (!res.ok) return { ok: false, error: res.error, errors: [res.error], warnings: [] }
      const { state, warnings, errors } = resolveToState(
        res.obj?.draft || res.obj,
        keepDims ? store.state.width : 1024,
        keepDims ? store.state.height : 1024,
        { strict, bboxMode, bboxTolerance },
      )
      if (errors.length) {
        return { ok: false, error: errors.join('; '), errors, warnings }
      }
      const curUi = store.state.ui
      const curOverlay = store.state.overlay
      const stored = matchingStudio(res.obj?.studio, serialize(state as MossState).draft)
      store.load(stored || { ...state, ui: curUi, overlay: curOverlay })
      if (!keepDims && state.width) store.state.width = state.width
      if (!keepDims && state.height) store.state.height = state.height
      store.select(null)
      store.snapshot()
      return { ok: true, warnings, errors: [] }
    },
  }) as StudioStore
  return store
}

function _syncSeq(elements: MossElement[]) {
  syncSeq(elements.flatMap((e) => [e.id, e.linkId, e.groupId]))
}

export function provideStudioStore(store: StudioStore) {
  provide(KEY, store)
}

export function useStudioStore(): StudioStore {
  return inject(KEY) as StudioStore
}
