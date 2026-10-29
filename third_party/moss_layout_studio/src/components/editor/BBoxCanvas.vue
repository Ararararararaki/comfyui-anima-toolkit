<template>
  <div class="canvas-wrap" ref="canvasWrap">
    <div class="toolbar" @pointerdown.stop>
      <slot name="lead" />
      <UiButton :active="drawMode" title="拖动即可画框（B）；画完自动回到选择工具" @click="drawMode = true">画框</UiButton>
      <UiButton :active="!drawMode" title="选择、框选、移动（V）" @click="drawMode = false">选择</UiButton>
      <select v-model="newType" aria-label="新区域类型"><option value="character">人物</option><option value="object">物体</option><option value="text">文字</option></select>
      <span v-if="$slots.lead" class="divider"></span>
      <span class="divider"></span>

      <UiPopover v-if="!hideRef" align="left">
        <template #trigger><UiButton icon :active="!!backdropUrl || syncRef" title="参考图 / 描摹底图"><MdiIcon class="mdi mdi-image-outline" /></UiButton></template>
        <div class="cmenu">
          <button class="citem" @click="pickImage"><MdiIcon class="mdi mdi-folder-image" /> 载入参考图…</button>
          <button class="citem" :class="{ on: syncRef }" title="连接 TK MOSS Layout Preview 节点，同步生成结果作为底图" @click="toggleSync"><MdiIcon class="mdi" :class="syncRef ? 'mdi-sync' : 'mdi-sync-off'" /> 同步生成结果</button>
          <button class="citem" :class="{ on: livePreview }" title="预览节点上游采样过程；连接 TK MOSS Layout Preview 后生效" @click="livePreview = !livePreview"><MdiIcon class="mdi" :class="livePreview ? 'mdi-television-play' : 'mdi-television-off'" /> 采样实时预览</button>
          <label class="crow">底图透明度 <input type="range" min="0" max="1" step="0.05" v-model.number="backdropOpacity" /></label>
          <button v-if="backdropUrl" class="citem" @click="backdropUrl = null"><MdiIcon class="mdi mdi-close" /> 移除参考图</button>
        </div>
      </UiPopover>

      <span v-if="!hideRef" class="divider"></span>

      <UiPopover align="left">
        <template #trigger><UiButton icon title="画布与叠框设置"><MdiIcon class="mdi mdi-tune-variant" /></UiButton></template>
        <div class="cmenu">
          <div class="cgroup">画布</div>
          <button class="citem" :class="{ on: showLabels }" title="Show 区域标签 on the canvas" @click="showLabels = !showLabels"><MdiIcon class="mdi" :class="showLabels ? 'mdi-label' : 'mdi-label-outline'" /> 区域标签</button>
          <div class="cdiv"></div>
          <div class="crow">镜像画布
            <button class="cic" title="水平镜像" @click="store.flipAll('h')"><MdiIcon class="mdi mdi-flip-horizontal" /></button>
            <button class="cic" title="垂直镜像" @click="store.flipAll('v')"><MdiIcon class="mdi mdi-flip-vertical" /></button>
          </div>
          <div class="cdiv"></div>
          <div class="cgroup">叠框图像输出</div>
          <label class="crow">线宽 <input type="number" min="1" max="40" v-model.number="store.state.overlay.lineWidth" /></label>
          <label class="crow">填充 <input type="range" min="0" max="1" step="0.02" v-model.number="store.state.overlay.fillAlpha" /></label>
          <label class="crow">字号 <input type="number" min="6" max="96" v-model.number="store.state.overlay.labelSize" /></label>
          <div class="crow ckrow">
            <label><input type="checkbox" v-model="store.state.overlay.showIndex" /> 序号</label>
            <label><input type="checkbox" v-model="store.state.overlay.showText" /> 文字</label>
          </div>
          <p class="chint">控制 TK MOSS Layout Preview 的 overlay 输出，不修改原图</p>
        </div>
      </UiPopover>

      <span class="spacer"></span>
      <slot name="trail" />
      <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
    </div>
    <span v-if="referenceError" role="alert" style="color:var(--error-text,#d95d5d)">{{ referenceError }}</span>

    <div
      ref="stage"
      class="stage"
      tabindex="0"
      :class="{ dragging: !!drag }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @lostpointercapture="onPointerUp"
      @keydown="onKeyDown"
      @contextmenu.prevent="onContextMenu"
      @dragover.prevent
      @drop="onDrop"
      :style="stageStyle"
    >
      <img v-if="effectiveBackdrop" class="backdrop" :src="effectiveBackdrop" :style="{ opacity: backdropOpacity }" draggable="false" alt="reference" @load="onBackdropLoad" />
      <img v-if="livePreview && previewSyncImage" class="livelayer" :src="previewSyncImage" draggable="false" alt="live preview" />
      <span v-if="livePreview && previewSyncImage" class="livebadge"><MdiIcon class="mdi mdi-record" /> live</span>
      <div class="grid"></div>

      <div
        v-for="(el, i) in boxed"
        :key="el.id"
        class="box"
        :class="{ sel: store.isSelected(el.id), primary: el.id === store.selectedId }"
        :style="boxStyle(el)"
        :data-box="el.id"
      >
        <span v-if="showLabels" class="tag" :class="{ grouped: !!el.groupId }" :style="tagStyle(el)">
          <span v-if="el.groupId" class="gseg"></span>
          <MdiIcon class="mdi tagi" :class="el.linkId ? 'mdi-link-variant' : labelIcon(el.label)" />
          <span class="tagn">{{ i + 1 }}</span>
          <span class="tagt">{{ el.label === 'text' ? (el.text || 'text') : (el.caption || el.label) }}</span>
        </span>
        <template v-if="el.id === store.selectedId && store.selectedIds.length === 1">
          <i v-for="hdl in HANDLES" :key="hdl" :class="['h', 'h-' + hdl]" :data-handle="hdl"></i>
        </template>
      </div>

      <!-- group bounding box (2+ selected): handles scale the selection proportionally -->
      <div v-if="groupBox" class="groupframe" :style="groupStyle">
        <i v-for="hdl in HANDLES" :key="hdl" :class="['h', 'h-' + hdl]" :data-handle="hdl" data-group="1"></i>
      </div>

      <div v-if="marquee" class="marquee" :style="marqueeStyle"></div>

      <div v-if="draft" class="box draft" :style="boxStyle({ bbox: draft, boxColor: '#9ca3af' })"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { useStudioStore } from '@/lib/store'
import UiButton from '../ui/UiButton.vue'
import UiPopover from '../ui/UiPopover.vue'
import { groupColor, LABELS, snapDim, type MossElement, type Label } from '@/lib/moss'

const store = useStudioStore()
const canvasWrap = ref<HTMLElement | null>(null)
const fit = ref({ width: '100%', height: '100%' })
let fitFrame = 0
let fitObserver: ResizeObserver | undefined
function fitCanvas() {
  cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => {
    const wrap = canvasWrap.value
    if (!wrap || !wrap.clientWidth || !wrap.clientHeight) return
    const toolbar = wrap.querySelector<HTMLElement>('.toolbar')
    const available = Math.max(40, wrap.clientHeight - (toolbar?.offsetHeight || 0) - 8)
    const ratio = store.state.width / store.state.height
    const width = Math.min(wrap.clientWidth, available * ratio)
    fit.value = { width: `${width}px`, height: `${width / ratio}px` }
  })
}
onMounted(() => { fitObserver = new ResizeObserver(fitCanvas); fitObserver.observe(canvasWrap.value!); fitCanvas() })
onBeforeUnmount(() => { fitObserver?.disconnect(); cancelAnimationFrame(fitFrame) })
watch(() => [store.state.width,store.state.height], fitCanvas)

// `backdrop` forces a trace image; `hideRef` hides the studio-only ref controls
const props = defineProps<{ backdrop?: string | null; hideRef?: boolean; prepareReference?: (source: string) => Promise<string> }>()
const referenceError = ref('')

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]
// pixel [x1, y1, x2, y2], top-left origin — the draft's own coordinate space
type Bbox = [number, number, number, number]

// persisted in store.state.ui so toggles survive a reload
const drawMode = ref(false)
const newType = computed({ get: () => store.state.ui.newType, set: (v) => (store.state.ui.newType = v) })
const showLabels = computed({ get: () => store.state.ui.showLabels, set: (v) => (store.state.ui.showLabels = v) })
const backdropOpacity = computed({ get: () => store.state.ui.backdropOpacity, set: (v) => (store.state.ui.backdropOpacity = v) })
const syncRef = computed({ get: () => store.state.ui.sync, set: (v) => (store.state.ui.sync = v) })
const livePreview = computed({ get: () => store.state.ui.livePreview, set: (v) => (store.state.ui.livePreview = v) })
// client-side only, not persisted (temp URLs go stale)
const backdropUrl = computed({ get: () => (store.state.ui as any).referenceImage || null, set: (v) => { (store.state.ui as any).referenceImage = v } })
const effectiveBackdrop = computed(() => props.backdrop ?? backdropUrl.value)
const previewSyncImage = computed(() => (store as any).previewImage || null)
watch(effectiveBackdrop, (v) => (store.refImage = v || ''), { immediate: true })

// match canvas aspect to the prop-driven image so bboxes line up (no letterbox drift)
function onBackdropLoad(e: Event) {
  if (props.backdrop == null) return
  const img = e.target as HTMLImageElement
  if (img.naturalWidth && img.naturalHeight) {
    store.state.width = snapDim(img.naturalWidth)
    store.state.height = snapDim(img.naturalHeight)
  }
}
const fileInput = ref<HTMLInputElement | null>(null)
function toggleSync() {
  syncRef.value = !syncRef.value
}
function pickImage() {
  fileInput.value?.click()
}
function readImage(f: File) {
  referenceError.value = ''
  if (f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)) { referenceError.value = '请载入 PNG、JPEG 或 WebP 等位图参考图。'; return }
  const r = new FileReader()
  r.onload = () => {
    const image = new Image()
    image.onerror = () => { referenceError.value = '无法读取这张参考图，请使用浏览器支持的图片格式。' }
    image.onload = async () => {
      if (unmounted) return
      let source = r.result as string
      try { if (props.prepareReference) source = await props.prepareReference(source) }
      catch (e) { if (!unmounted) referenceError.value = String((e as Error).message || e); return }
      if (unmounted) return
      store.snapshot()
      const sx = image.naturalWidth / store.state.width, sy = image.naturalHeight / store.state.height
      store.state.elements.forEach(el => { el.bbox = el.bbox.map((v,i) => Math.round(v * (i % 2 ? sy : sx))) as Bbox })
      store.state.width = image.naturalWidth; store.state.height = image.naturalHeight
      backdropUrl.value = source
      store.snapshot()
    }
    image.src = r.result as string
  }
  r.readAsDataURL(f)
}
let unmounted = false
onBeforeUnmount(() => { unmounted = true })
function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) readImage(f)
  ;(e.target as HTMLInputElement).value = ''
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  const f = e.dataTransfer?.files?.[0]
  if (f && f.type.startsWith('image/')) readImage(f)
}
const stage = ref<HTMLElement | null>(null)
const draft = ref<Bbox | null>(null)
const marquee = ref<Bbox | null>(null)
const hint = ref('') // live bbox readout during a drag

const MIN_SPAN = 10 // smallest box dimension when resizing, in pixels

const boxed = computed(() => store.state.elements)

const newTypeIcon = computed(() =>
  newType.value === 'text' ? 'mdi-format-text' : newType.value === 'character' ? 'mdi-account-outline' : 'mdi-vector-square',
)
function cycleNewType() {
  const i = LABELS.indexOf(newType.value)
  newType.value = LABELS[(i + 1) % LABELS.length]
}
function labelIcon(label: Label): string {
  return label === 'text' ? 'mdi-format-text' : label === 'character' ? 'mdi-account-outline' : 'mdi-vector-square'
}

const selectedBoxes = computed(() =>
  store.selectedIds.map((id) => store.getElement(id)).filter((e): e is MossElement => !!e),
)
const groupBox = computed<Bbox | null>(() => {
  if (selectedBoxes.value.length < 2) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of selectedBoxes.value) {
    const [a, b, c, d] = e.bbox
    x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d)
  }
  return [x0, y0, x1, y1]
})
// one whole group → tint the frame with the group color; ad-hoc selection → accent
const groupFrameColor = computed(() => {
  const els = selectedBoxes.value
  if (els.length < 2) return ''
  const gid = els[0].groupId
  return gid && els.every((e) => e.groupId === gid) ? groupColor(gid) : ''
})

function rectStyle(b: Bbox): Record<string, string> {
  const W = store.state.width, H = store.state.height
  const x0 = Math.min(b[0], b[2]), x1 = Math.max(b[0], b[2])
  const y0 = Math.min(b[1], b[3]), y1 = Math.max(b[1], b[3])
  return {
    left: `${(x0 / W) * 100}%`,
    top: `${(y0 / H) * 100}%`,
    width: `${((x1 - x0) / W) * 100}%`,
    height: `${((y1 - y0) / H) * 100}%`,
  }
}
const groupStyle = computed(() => {
  const b = groupBox.value
  if (!b) return {}
  const s = rectStyle(b)
  if (groupFrameColor.value) s['--gc'] = groupFrameColor.value
  return s
})
const marqueeStyle = computed(() => (marquee.value ? rectStyle(marquee.value) : {}))

const stageStyle = computed(() => ({ ...fit.value, aspectRatio: `${store.state.width} / ${store.state.height}` }))

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  return `rgba(${r},${g},${b},${a})`
}

// bbox = pixel [x1, y1, x2, y2]
function boxStyle(el: { bbox: Bbox; boxColor?: string }) {
  const color = el.boxColor || '#60a5fa'
  return {
    ...rectStyle(el.bbox),
    borderColor: color,
    '--c': color,
    '--fill': hexToRgba(color, 0.16),
  }
}
function tagStyle(el: { boxColor?: string; groupId?: string | null }) {
  const s: Record<string, string> = { background: hexToRgba(el.boxColor || '#60a5fa', 0.88), color: '#fff' }
  if (el.groupId) s['--gc'] = groupColor(el.groupId)
  return s
}

function pointToCoords(ev: PointerEvent): { x: number; y: number } {
  const r = stage.value!.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(store.state.width, Math.round(((ev.clientX - r.left) / r.width) * store.state.width))),
    y: Math.max(0, Math.min(store.state.height, Math.round(((ev.clientY - r.top) / r.height) * store.state.height))),
  }
}

interface DragSession {
  kind: 'draw' | 'move' | 'resize' | 'resize-group' | 'marquee'
  el?: MossElement
  handle?: Handle
  start: { x: number; y: number }
  moved: boolean
  moveTargets?: { el: MossElement; start: Bbox }[]
  clickedId?: string
  wasPrimary?: boolean // clicked box was the sole selection → cycle on click
  wasClickedPrimary?: boolean // clicked box was the primary at press → deselect on click
  ctrlClick?: boolean // ctrl/⌘ held on a draw session; no-drag → toggle select
  additive?: boolean // shift held; marquee adds to the selection
  groupStart?: Bbox // selection union bbox at the start of a group resize
  groupTargets?: { el: MossElement; start: Bbox }[]
}
let drag: DragSession | null = null
let lastPointer = { x: 512, y: 512 } // last cursor pos (pixels), for paste-at-cursor

// items containing the point, in paint order; for cycling stacked boxes
function boxesUnder(p: { x: number; y: number }) {
  return store.state.elements
    .filter((el) => p.x >= el.bbox[0] && p.x <= el.bbox[2] && p.y >= el.bbox[1] && p.y <= el.bbox[3])
    .map((el) => el.id)
}

function onPointerDown(ev: PointerEvent) {
  // keep LiteGraph from dragging the node / panning the canvas
  ev.preventDefault()
  ev.stopPropagation()
  if (ev.button !== 0) return
  try {
    stage.value!.setPointerCapture(ev.pointerId)
  } catch {
    /* best effort */
  }
  stage.value?.focus({ preventScroll: true }) // so Delete works after a click

  const target = ev.target as HTMLElement
  const handle = target.dataset.handle as Handle | undefined
  const isGroupHandle = !!target.dataset.group
  const boxId = target.closest('[data-box]')?.getAttribute('data-box') ?? undefined
  const start = pointToCoords(ev)
  const drawMod = drawMode.value || ev.ctrlKey || ev.metaKey
  const additive = ev.shiftKey

  if (handle && isGroupHandle && groupBox.value) {
    drag = {
      kind: 'resize-group',
      handle,
      start,
      moved: false,
      groupStart: [...groupBox.value] as Bbox,
      groupTargets: selectedBoxes.value.map((e) => ({ el: e, start: [...e.bbox] as Bbox })),
    }
    return
  }
  if (handle && store.selectedId && store.selectedIds.length === 1) {
    const el = store.getElement(store.selectedId)
    if (el) {
      drag = { kind: 'resize', el, handle, start, moved: false }
      return
    }
  }
  // Ctrl/⌘+drag draws a new box anywhere; ctrl-click with no drag toggles the box under it
  if (drawMod) {
    draft.value = [start.x, start.y, start.x, start.y]
    drag = { kind: 'draw', start, moved: false, ctrlClick: true, clickedId: boxId }
    return
  }
  if (boxId) {
    if (additive) {
      store.select(boxId, true) // shift+click toggles selection, no drag
      return
    }
    const wasPrimary = store.selectedIds.length === 1 && store.selectedId === boxId
    const wasClickedPrimary = store.selectedId === boxId
    // don't re-select an already-selected box here — preserves the multi/group selection
    // for a drag; re-target/deselect happens on click (no drag)
    if (!store.isSelected(boxId)) store.select(boxId)
    const moveTargets = store.selectedIds
      .map((id) => store.getElement(id))
      .filter((e): e is MossElement => !!e)
      .map((e) => ({ el: e, start: [...e.bbox] as Bbox }))
    drag = { kind: 'move', start, moved: false, moveTargets, clickedId: boxId, wasPrimary, wasClickedPrimary }
    return
  }
  // empty space → marquee box-select; shift adds to the selection
  marquee.value = [start.x, start.y, start.x, start.y]
  drag = { kind: 'marquee', start, moved: false, additive }
}

function onPointerMove(ev: PointerEvent) {
  lastPointer = pointToCoords(ev)
  if (!drag) return
  ev.preventDefault()
  const p = pointToCoords(ev)
  if (Math.abs(p.x - drag.start.x) > 2 || Math.abs(p.y - drag.start.y) > 2) drag.moved = true

  if (drag.kind === 'draw') {
    draft.value = [Math.min(drag.start.x, p.x), Math.min(drag.start.y, p.y), Math.max(drag.start.x, p.x), Math.max(drag.start.y, p.y)]
    hint.value = bboxLabel(draft.value)
  } else if (drag.kind === 'marquee') {
    marquee.value = [Math.min(drag.start.x, p.x), Math.min(drag.start.y, p.y), Math.max(drag.start.x, p.x), Math.max(drag.start.y, p.y)]
  } else if (drag.kind === 'resize-group' && drag.groupStart && drag.groupTargets && drag.handle) {
    // resize the union bbox, then map each member linearly from old to new bounds
    const [ox0, oy0, ox1, oy1] = drag.groupStart
    let gx0 = ox0, gy0 = oy0, gx1 = ox1, gy1 = oy1
    if (drag.handle.includes('n')) gy0 = Math.min(p.y, oy1 - MIN_SPAN)
    if (drag.handle.includes('s')) gy1 = Math.max(p.y, oy0 + MIN_SPAN)
    if (drag.handle.includes('w')) gx0 = Math.min(p.x, ox1 - MIN_SPAN)
    if (drag.handle.includes('e')) gx1 = Math.max(p.x, ox0 + MIN_SPAN)
    const sx = ox1 - ox0 ? (gx1 - gx0) / (ox1 - ox0) : 1
    const sy = oy1 - oy0 ? (gy1 - gy0) / (oy1 - oy0) : 1
    for (const t of drag.groupTargets) {
      const [x0, y0, x1, y1] = t.start
      t.el.bbox = [
        clampCoord(gx0 + (x0 - ox0) * sx, store.state.width),
        clampCoord(gy0 + (y0 - oy0) * sy, store.state.height),
        clampCoord(gx1 + (x1 - ox0) * sx, store.state.width),
        clampCoord(gy1 + (y1 - oy0) * sy, store.state.height),
      ]
    }
  } else if (drag.kind === 'move' && drag.moveTargets) {
    const targets = drag.moveTargets
    // clamp the delta uniformly so the group moves rigidly and stays in bounds
    let dx = p.x - drag.start.x
    let dy = p.y - drag.start.y
    let loX = -Infinity, hiX = Infinity, loY = -Infinity, hiY = Infinity
    for (const t of targets) {
      const [x0, y0, x1, y1] = t.start
      loX = Math.max(loX, -x0); hiX = Math.min(hiX, store.state.width - x1)
      loY = Math.max(loY, -y0); hiY = Math.min(hiY, store.state.height - y1)
    }
    dx = Math.max(loX, Math.min(hiX, dx))
    dy = Math.max(loY, Math.min(hiY, dy))
    for (const t of targets) {
      const [x0, y0, x1, y1] = t.start
      t.el.bbox = [Math.round(x0 + dx), Math.round(y0 + dy), Math.round(x1 + dx), Math.round(y1 + dy)]
    }
    if (targets.length === 1) hint.value = bboxLabel(targets[0].el.bbox)
  } else if (drag.kind === 'resize' && drag.el && drag.handle) {
    const [x0, y0, x1, y1] = drag.el.bbox
    let nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1
    if (drag.handle.includes('n')) ny0 = Math.min(p.y, y1 - 2)
    if (drag.handle.includes('s')) ny1 = Math.max(p.y, y0 + 2)
    if (drag.handle.includes('w')) nx0 = Math.min(p.x, x1 - 2)
    if (drag.handle.includes('e')) nx1 = Math.max(p.x, x0 + 2)
    drag.el.bbox = [nx0, ny0, nx1, ny1]
    hint.value = bboxLabel(drag.el.bbox)
  }
}

function onPointerUp(ev: PointerEvent) {
  if (!drag) return
  try {
    stage.value!.releasePointerCapture(ev.pointerId)
  } catch {
    /* fine */
  }
  if (drag.kind === 'draw') {
    const b = draft.value
    draft.value = null
    if (b && b[2] - b[0] >= 8 && b[3] - b[1] >= 8) {
      store.addElement(newType.value, b)
      drawMode.value = false
      nextTick(() => {
        const field = stage.value?.closest('.studio')?.querySelector<HTMLTextAreaElement>('textarea[aria-label="区域描述"]')
        field?.focus({ preventScroll: true })
      })
    } else if (!drag.moved && drag.ctrlClick && drag.clickedId) {
      store.select(drag.clickedId, true)
    }
  } else if (drag.kind === 'marquee') {
    const m = marquee.value
    marquee.value = null
    if (drag.moved && m) {
      const ids = store.state.elements.filter((el) => intersects(el.bbox, m)).map((el) => el.id)
      store.setSelection(ids, drag.additive)
    } else if (!drag.moved && !drag.additive) {
      store.select(null)
    }
  } else if (drag.kind === 'move' && !drag.moved && drag.clickedId) {
    const el = store.getElement(drag.clickedId)
    if (el?.groupId) {
      // grouped: re-click the primary deselects the group; click another member re-targets it
      if (drag.wasClickedPrimary) store.select(null)
      else store.select(drag.clickedId)
    } else if (store.selectedIds.length > 1) {
      store.select(drag.clickedId) // collapse an ungrouped multi-selection to the clicked box
    } else if (drag.wasPrimary) {
      // re-clicking the selected box cycles to the next box under the cursor (wraps)
      const ids = boxesUnder(drag.start)
      if (ids.length > 1) {
        const ci = ids.indexOf(drag.clickedId)
        store.select(ids[ci === -1 ? 0 : (ci + 1) % ids.length])
      }
    }
  }
  drag = null
  hint.value = ''
}

// scoped to the focused canvas + stopPropagation so LiteGraph doesn't act on these
function onKeyDown(ev: KeyboardEvent) {
  const mod = ev.ctrlKey || ev.metaKey
  if (!mod && ['b', 'v'].includes(ev.key.toLowerCase())) {
    drawMode.value = ev.key.toLowerCase() === 'b'; ev.preventDefault(); ev.stopPropagation(); return
  }
  const step = ev.shiftKey ? 10 : 1
  const delta: Record<string, number[]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
  if (delta[ev.key] && store.selectedIds.length) {
    ev.preventDefault(); ev.stopPropagation()
    const targets = selectedBoxes.value
    let [dx, dy] = delta[ev.key]
    dx = Math.max(-Math.min(...targets.map(e => e.bbox[0])), Math.min(dx, store.state.width - Math.max(...targets.map(e => e.bbox[2]))))
    dy = Math.max(-Math.min(...targets.map(e => e.bbox[1])), Math.min(dy, store.state.height - Math.max(...targets.map(e => e.bbox[3]))))
    store.snapshot(); targets.forEach(e => { const b = e.bbox; e.bbox = [b[0]+dx,b[1]+dy,b[2]+dx,b[3]+dy] }); store.snapshot(); return
  }
  if (mod && (ev.key === 'c' || ev.key === 'C')) {
    ev.preventDefault()
    ev.stopPropagation()
    store.copySelection()
    return
  }
  if (mod && (ev.key === 'v' || ev.key === 'V')) {
    ev.preventDefault()
    ev.stopPropagation()
    store.pasteAt(lastPointer.x, lastPointer.y)
    return
  }
  // Ctrl/⌘+G group; +Shift+G ungroup
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'g' || ev.key === 'G')) {
    ev.preventDefault()
    ev.stopPropagation()
    if (ev.shiftKey) {
      if (store.selectedId) store.ungroup(store.selectedId)
    } else if (store.selectedIds.length >= 2) {
      store.group(store.selectedIds)
    }
    return
  }
  if (ev.key !== 'Delete' && ev.key !== 'Backspace') return
  if (!store.selectedIds.length) return
  ev.preventDefault()
  ev.stopPropagation()
  for (const id of [...store.selectedIds]) store.removeElement(id)
  store.snapshot()
}

function onContextMenu(ev: MouseEvent) {
  const id = (ev.target as HTMLElement).closest('[data-box]')?.getAttribute('data-box')
  if (!id) return
  if (!store.isSelected(id)) store.select(id) // keep a multi-selection for bulk actions
  store.openContextMenu(ev.clientX, ev.clientY, id)
}

function bboxLabel(b: Bbox) {
  return `bbox [x${b[0]} y${b[1]} x${b[2]} y${b[3]}]  ·  ${b[2] - b[0]}×${b[3] - b[1]}`
}

function clampCoord(v: number, max: number) {
  return Math.max(0, Math.min(max, Math.round(v)))
}

// marquee hit-test: do two bboxes overlap?
function intersects(a: Bbox, m: Bbox) {
  return a[0] < m[2] && a[2] > m[0] && a[1] < m[3] && a[3] > m[1]
}
</script>

<style scoped>
.canvas-wrap { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; align-items: center; }
.toolbar { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; align-self: stretch; flex: none; }
.mdi { font-size: 15px; line-height: 1; }
.tag .mdi { font-size: 1em; }
.seg { display: flex; gap: 2px; }
.divider { width: 1px; height: 18px; background: var(--st-border); margin: 0 2px; }
.spacer { flex: 1 1 auto; }
.cmenu { display: flex; flex-direction: column; gap: 5px; min-width: 170px; }
.citem { display: flex; align-items: center; gap: 6px; text-align: left; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 5px; padding: 5px 8px; font-size: 11px; cursor: pointer; }
.citem:hover { border-color: var(--st-accent); }
.citem.on { background: var(--st-accent); border-color: var(--st-accent); color: var(--st-on-accent, #fff); }
.crow { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--st-muted); }
.crow input[type='range'] { flex: 1; accent-color: var(--st-accent); }
.crow input[type='number'] { width: 54px; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; padding: 3px; font-size: 11px; }
.ckrow { gap: 12px; }
.cdiv { border-top: 1px solid var(--st-border); margin: 3px 0; }
.cgroup { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--st-muted); }
.chint { margin: 2px 0 0; font-size: 10px; line-height: 1.4; color: var(--st-muted); }
.cic { display: inline-flex; align-items: center; justify-content: center; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; width: 26px; height: 24px; cursor: pointer; }
.cic:hover { border-color: var(--st-accent); }

.stage {
  position: relative; flex: none; max-width: 100%; background: var(--st-input);
  border: 1px solid var(--st-border); border-radius: 6px; overflow: hidden;
  touch-action: none; user-select: none; cursor: crosshair;
}
.stage.dragging { cursor: grabbing; }
.stage:focus { outline: none; }
.backdrop { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
/* no z-index: DOM order paints it above the backdrop but below the grid/boxes */
.livelayer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
.livebadge {
  position: absolute; top: 6px; left: 6px; z-index: 2; pointer-events: none;
  display: inline-flex; align-items: center; gap: 3px;
  background: rgba(0,0,0,.6); color: #fff; border-radius: 4px;
  padding: 1px 6px 1px 4px; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .5px;
}
.livebadge .mdi { font-size: 11px; color: #ef4444; animation: livepulse 1.2s ease-in-out infinite; }
@keyframes livepulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
.grid {
  position: absolute; inset: 0; pointer-events: none;
  background-image: linear-gradient(to right, rgba(128,128,128,.18) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(128,128,128,.18) 1px, transparent 1px);
  background-size: 10% 10%;
}
.box { position: absolute; box-sizing: border-box; cursor: move; background: transparent; transition: background .1s; }
/* border as ::after (painted after children) so the outline sits over the label */
.box::after { content: ''; position: absolute; inset: 0; border: 2px solid var(--c, #60a5fa); pointer-events: none; }
.box:hover { background: var(--fill); }
.box.sel { background: var(--fill); box-shadow: 0 0 0 1.5px var(--st-accent, #60a5fa); z-index: 4; }
.box.primary { box-shadow: 0 0 0 1px #fff, 0 0 0 2px var(--st-accent, #60a5fa), 0 0 10px rgba(0,0,0,.6); z-index: 5; }
.box.draft { opacity: 0.8; pointer-events: none; background: rgba(156,163,175,.12); }
.box.draft::after { border-style: dashed; }
.groupframe { position: absolute; box-sizing: border-box; border: 1px dashed var(--gc, var(--st-accent, #60a5fa)); background: transparent; z-index: 6; pointer-events: none; }
.groupframe .h { pointer-events: auto; background: var(--gc, var(--st-accent, #60a5fa)); border-color: #fff; }
.marquee { position: absolute; box-sizing: border-box; border: 1px solid var(--st-accent, #60a5fa); background: color-mix(in srgb, var(--st-accent, #60a5fa) 15%, transparent); z-index: 7; pointer-events: none; }
.tag {
  position: absolute; top: 0; left: 0; transform: translateY(-100%);
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 10px; line-height: 1.4; padding: 1px 5px; white-space: nowrap;
  max-width: 240px; overflow: hidden; border-radius: 3px 3px 0 0; pointer-events: none;
}
.tag .tagi { flex: none; }
.tag .tagn { flex: none; font-weight: 700; font-variant-numeric: tabular-nums; }
/* text hidden by default (icon + index only); shown on hover/selection */
.tag .tagt { display: none; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.box:hover .tag .tagt, .box.sel .tag .tagt, .box.primary .tag .tagt { display: inline; }
.tag .tagt::before { content: '· '; }
/* per-group color tab on the label's left edge; negative margins bleed to the tag edges */
.tag.grouped .gseg { flex: none; align-self: stretch; width: 4px; margin: -1px 3px -1px -5px; border-radius: 3px 0 0 0; background: var(--gc, var(--st-accent)); }
.h { position: absolute; width: 11px; height: 11px; background: #fff; border: 1px solid #333; border-radius: 2px; z-index: 1; }
.h-nw { top: -6px; left: -6px; cursor: nwse-resize; }
.h-n  { top: -6px; left: 50%; margin-left: -5px; cursor: ns-resize; }
.h-ne { top: -6px; right: -6px; cursor: nesw-resize; }
.h-e  { top: 50%; right: -6px; margin-top: -5px; cursor: ew-resize; }
.h-se { bottom: -6px; right: -6px; cursor: nwse-resize; }
.h-s  { bottom: -6px; left: 50%; margin-left: -5px; cursor: ns-resize; }
.h-sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
.h-w  { top: 50%; left: -6px; margin-top: -5px; cursor: ew-resize; }
</style>
