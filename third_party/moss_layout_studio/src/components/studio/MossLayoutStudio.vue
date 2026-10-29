<template>
  <div class="studio" ref="rootEl" :class="{ 'panel-open': panelOpen }" @contextmenu.prevent.stop>
    <div class="main">
      <div class="left" ref="leftEl">
        <BBoxCanvas :prepare-reference="props.widget?.prepareReference">
          <template #lead>
            <UiButton icon :disabled="!store.canUndo" title="撤销 (Ctrl+Z)" @click="store.undo()"><MdiIcon class="mdi mdi-undo" /></UiButton>
            <UiButton icon :disabled="!store.canRedo" title="重做 (Ctrl+Shift+Z)" @click="store.redo()"><MdiIcon class="mdi mdi-redo" /></UiButton>
            <span class="divider"></span>
            <UiPopover align="left">
              <template #trigger><UiButton title="画布尺寸：比例与像素">{{ store.state.width }}×{{ store.state.height }} ▾</UiButton></template>
              <div class="resmenu">
                <div class="rsec">宽高比</div>
                <div class="aspects">
                  <button v-for="a in CORE_ASPECTS" :key="a.label" class="achip" :class="{ on: aspect === a.label }" :title="a.label + ' · ' + a.name" @click="setAspect(a.label)">
                    <span class="arect" :style="aspectRectStyle(a)"></span>
                    <span class="albl">{{ a.label }}</span>
                  </button>
                </div>
                <div class="rdiv"></div>
                <div class="mprow"><span>百万像素</span>
                  <div class="mppresets">
                    <button v-for="p in MP_PRESETS" :key="p" class="mpp" :class="{ on: mp === p }" @click="setMp(p)">{{ p }}</button>
                  </div>
                  <input type="number" min="0.1" max="16" step="0.1" v-model.number="mp" @input="applyRes" />
                </div>
                <div class="whrow">
                  <label><span>宽</span><input type="number" aria-label="画布宽度" min="1" step="1" :value="store.state.width" @change="setWH('width', ($event.target as HTMLInputElement).valueAsNumber)" /></label>
                  <button class="swap" title="Swap width &amp; height (flip orientation)" @click="swapWH"><MdiIcon class="mdi mdi-swap-horizontal" /></button>
                  <label><span>高</span><input type="number" aria-label="画布高度" min="1" step="1" :value="store.state.height" @change="setWH('height', ($event.target as HTMLInputElement).valueAsNumber)" /></label>
                </div>
                <div class="rfoot">
                  <span class="rmp">≈ {{ mpActual }} MP</span>
                </div>
                <div v-if="outsideCount" class="roob">
                  <span><MdiIcon class="mdi mdi-alert-outline" /> {{ outsideCount }} box{{ outsideCount === 1 ? '' : 'es' }} outside</span>
                  <button class="refit" title="Clamp every box into the current canvas" @click="refitBoxes">refit</button>
                </div>
              </div>
            </UiPopover>
          </template>

          <template #trail>
            <UiButton icon title="布局模板：保存 / 加载" @click="libraryOpen = true"><MdiIcon class="mdi mdi-bookshelf" /></UiButton>
            <UiPopover align="right">
              <template #trigger><UiButton icon title="操作帮助"><MdiIcon class="mdi mdi-help-circle-outline" /></UiButton></template>
              <div class="help">
                <p class="h">Canvas</p>
                <dl>
                  <dt>B / V</dt><dd>切换画框 / 选择；选择模式拖空白处可框选，Shift 追加</dd>
                  <dt>ctrl / ⌘ + drag</dt><dd>draw a new box</dd>
                  <dt>drag a box</dt><dd>move it</dd>
                  <dt>drag a handle</dt><dd>resize</dd>
                  <dt>click</dt><dd>select; ctrl / shift click to multi-select</dd>
                  <dt>click again</dt><dd>cycle through stacked / overlapping boxes</dd>
                </dl>
                <p class="h">Keyboard</p>
                <dl>
                  <dt>ctrl / ⌘ + C / V</dt><dd>copy / paste the selection (pastes at the cursor)</dd>
                  <dt>ctrl / ⌘ + G</dt><dd>group the selected boxes · + shift to ungroup</dd>
                  <dt>ctrl / ⌘ + Z</dt><dd>undo · + shift to redo</dd>
                  <dt>Delete / Backspace</dt><dd>remove the selected box(es)</dd>
                </dl>
                <p class="h">Items</p>
                <dl>
                  <dt>物体 / 人物 / 文字</dt><dd>在画框工具旁选择区域类型；选中后也可修改</dd>
                  <dt>text items</dt><dd>carry the exact visible characters</dd>
                </dl>
                <p class="h">Reference</p>
                <dl>
                  <dt><MdiIcon class="mdi mdi-image-outline" /> image</dt><dd>load an image to trace over (or drop one on the canvas)</dd>
                  <dt><MdiIcon class="mdi mdi-sync" /> 结果同步</dt><dd>将生成图像和本节点的布局接入 <b>TK MOSS 布局预览</b>，生成后同步参考图</dd>
                  <dt><MdiIcon class="mdi mdi-television-play" /> 采样实时预览</dt><dd>显示连接到布局预览节点的上游采样预览；只同步本编辑器绑定的结果</dd>
                </dl>
                <p class="h">Outputs</p>
                <dl>
                  <dt>prompt</dt><dd>compiled MOSS-Image JSON (center-origin yxyx) → your sampler's positive prompt</dd>
                  <dt>draft</dt><dd>the editable draft JSON — feed it back, save it, or edit it by script</dd>
                  <dt>辅助输出</dt><dd><b>TK MOSS 布局预览</b> 输出区域遮罩、叠框图、透明度、尺寸与框坐标</dd>
                </dl>
                <p class="tip">Tip: open the JSON card and paste a draft (or a compiled prompt) to import it.</p>
                <p class="credit">
                  MOSS edition of <b>ComfyUI-IdeogramHelper</b> by nynxz (GPLv3)<br />
                  <a href="https://github.com/OpenMOSS/MOSS-Image" target="_blank" rel="noopener noreferrer">MOSS-Image prompt spec ↗</a>
                </p>
              </div>
            </UiPopover>
            <UiPopover align="right">
              <template #trigger><UiButton icon title="清空画布"><MdiIcon class="mdi mdi-broom" /></UiButton></template>
              <template #default="{ close }">
                <div class="resetc">
                  <p class="rq"><MdiIcon class="mdi mdi-alert-outline" /> 清空整张画布？</p>
                  <p class="rh">删除全部区域及全局描述。可按 Ctrl+Z 撤销。</p>
                  <div class="rbtns">
                    <button class="rno" @click="close()">取消</button>
                    <button class="ryes" @click="resetAll(); close()"><MdiIcon class="mdi mdi-broom" /> 清空</button>
                  </div>
                </div>
              </template>
            </UiPopover>
            <span class="slim-controls"><UiButton icon :title="panelOpen ? '收起属性' : '展开属性'" @click="panelOpen = !panelOpen"><MdiIcon class="mdi mdi-dock-right" /></UiButton></span>
          </template>
        </BBoxCanvas>
      </div>
      <div class="right" ref="rightEl">
        <ElementEditor v-if="!store.state.ui.jsonOpen" />
        <SummaryPanel />
        <ElementList />
        <JsonControls />
      </div>
      <!-- slim mode (container query): tap-outside backdrop to close the drawer;
           scoped to .main so it doesn't cover the JSON/editor below -->
      <div class="drawer-backdrop" @click="panelOpen = false"></div>
    </div>

    <!-- mutually exclusive with the JSON view so the two don't stack and inflate height -->

    <JsonPreview />
    <ElementContextMenu />
    <StudioLibrary v-model:open="libraryOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { createStudioStore, provideStudioStore } from '@/lib/store'
import { emptyState, serialize, resolveToState, parseJsonLoose, type MossState } from '@/lib/moss'
import { isRecord } from '@/lib/guards'
import UiButton from '../ui/UiButton.vue'
import UiPopover from '../ui/UiPopover.vue'
import BBoxCanvas from '../editor/BBoxCanvas.vue'
import StudioLibrary from './StudioLibrary.vue'
import SummaryPanel from '../editor/SummaryPanel.vue'
import ElementList from '../editor/ElementList.vue'
import JsonControls from './JsonControls.vue'
import ElementEditor from '../editor/ElementEditor.vue'
import JsonPreview from './JsonPreview.vue'
import ElementContextMenu from '../editor/ElementContextMenu.vue'

const props = defineProps<{ widget: any; node?: any }>()

const store = createStudioStore()
provideStudioStore(store)

const rootEl = ref<HTMLElement | null>(null)
const libraryOpen = ref(false)
const panelOpen = ref(false) // slim-mode sidebar drawer open/closed
watch(() => store.selectedId, id => {
  if (id && (rootEl.value?.clientWidth || 0) <= 760) panelOpen.value = true
})
const leftEl = ref<HTMLElement | null>(null)
const rightEl = ref<HTMLElement | null>(null)

// No JS height-sync: sidebar height left to CSS/content so the node can shrink.
// Capture undo/redo keys before the graph; capture phase + stopImmediatePropagation
// so the graph's own undo doesn't also fire. Text fields keep native undo.
function onUndoKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey)) return
  const k = e.key.toLowerCase()
  if (k !== 'z' && k !== 'y') return
  const root = rootEl.value
  const ae = document.activeElement
  if (!root || !ae || !root.contains(ae)) return
  const tag = (ae as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (ae as HTMLElement).isContentEditable) return
  const redo = k === 'y' || (k === 'z' && e.shiftKey)
  if (redo) store.redo()
  else store.undo()
  e.preventDefault()
  e.stopImmediatePropagation()
}
onMounted(() => document.addEventListener('keydown', onUndoKey, true))
onBeforeUnmount(() => { document.removeEventListener('keydown', onUndoKey, true); clearTimeout(snapTimer) })

// TK: external imports are directed to this instance, never broadcast.

// total = MP × 1024², exact-ratio scale, /16 round
const CORE_ASPECTS = [
  { label: '1:1', name: 'square', w: 1, h: 1 },
  { label: '3:2', name: 'photo', w: 3, h: 2 },
  { label: '4:3', name: 'standard', w: 4, h: 3 },
  { label: '16:9', name: 'widescreen', w: 16, h: 9 },
  { label: '21:9', name: 'ultrawide', w: 21, h: 9 },
  { label: '2:3', name: 'portrait', w: 2, h: 3 },
  { label: '3:4', name: 'portrait', w: 3, h: 4 },
  { label: '9:16', name: 'portrait', w: 9, h: 16 },
]
const aspect = ref('1:1')
const mp = ref(1)
const MP_PRESETS = [0.5, 1, 2, 4]
const mpActual = computed(() => ((store.state.width * store.state.height) / (1024 * 1024)).toFixed(2))
const outsideCount = computed(() =>
  store.state.elements.filter((e) =>
    e.bbox[0] < 0 || e.bbox[1] < 0
    || e.bbox[2] > store.state.width || e.bbox[3] > store.state.height,
  ).length,
)
function aspectRectStyle(a: { w: number; h: number }) {
  const s = 15 / Math.max(a.w, a.h)
  return { width: Math.round(a.w * s) + 'px', height: Math.round(a.h * s) + 'px' }
}
function setAspect(label: string) {
  aspect.value = label
  applyRes()
}
function setMp(p: number) {
  mp.value = p
  applyRes()
}
function swapWH() {
  setCanvasSize(store.state.height, store.state.width)
}
function setCanvasSize(width: number, height: number) {
  const sx = width / store.state.width, sy = height / store.state.height
  store.snapshot()
  store.state.elements.forEach(el => { el.bbox = el.bbox.map((v,i) => Math.round(v * (i % 2 ? sy : sx))) as [number,number,number,number] })
  store.state.width = width; store.state.height = height
  store.snapshot()
  seedRes()
}
function setWH(dimension: 'width' | 'height', value: number) {
  if (!Number.isFinite(value)) return
  setCanvasSize(dimension === 'width' ? Math.max(1,Math.round(value)) : store.state.width,
    dimension === 'height' ? Math.max(1,Math.round(value)) : store.state.height)
}
// MOSS dimensions are multiples of 16
const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16)
function applyRes() {
  const a = CORE_ASPECTS.find((x) => x.label === aspect.value) || CORE_ASPECTS[0]
  const total = Math.max(0.1, mp.value || 1) * 1024 * 1024
  const scale = Math.sqrt(total / (a.w * a.h))
  setCanvasSize(snap16(a.w * scale), snap16(a.h * scale))
}
function seedRes() {
  // reflect current dims in the aspect/MP controls without resizing
  const w = store.state.width
  const h = store.state.height
  mp.value = Math.max(0.1, Number((((w * h) / (1024 * 1024))).toFixed(2)))
  const r = w / h
  aspect.value = CORE_ASPECTS.reduce(
    (best, x) => (Math.abs(x.w / x.h - r) < Math.abs(best.w / best.h - r) ? x : best),
    CORE_ASPECTS[0],
  ).label
}
function refitBoxes() {
  const n = store.refitToCanvas()
  if (!n) return
  store.json.syncError = ''
  store.json.syncWarnings = []
  store.json.syncNote = `Canvas refit · ${n} box${n === 1 ? '' : 'es'} clamped`
}

function plainState(): MossState {
  return JSON.parse(JSON.stringify(store.state)) as MossState
}
function resetAll() {
  store.snapshot()
  store.load(emptyState())
  store.select(null)
  store.snapshot()
}

let snapTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSnapshot() {
  clearTimeout(snapTimer)
  snapTimer = setTimeout(() => store.snapshot(), 350)
}

// widget payload = { draft: canonical draft JSON, studio: full editor state }.
// On load, `studio` wins when its own derived draft matches the saved `draft`
// byte-for-byte; otherwise (a script edited the draft) the draft is authoritative
// and editor-only metadata is regenerated. This keeps the whole-segment JSON the
// single source of truth for scripts while the editor round-trips losslessly.
function deriveDraft(state: Partial<MossState> | undefined): string {
  // Workflows produced by the API/CLI may carry only { width, height } in the
  // editor state while the full layout lives in `draft`. Never throw here; an
  // empty result forces the draft-authoritative path below.
  if (!state || !Array.isArray(state.elements) || !state.summary) return ''
  try {
    return JSON.stringify(serialize(state as MossState).draft)
  } catch {
    return ''
  }
}

type DraftWidget = { name?: string; value?: unknown; link?: unknown }
function draftInputWidget(): DraftWidget | undefined {
  const node = props.node as { widgets?: DraftWidget[] } | undefined
  return node?.widgets?.find((w) => w.name === 'draft')
}

function readDraftInput(): string {
  const value = draftInputWidget()?.value
  return typeof value === 'string' && value.trim() ? value : ''
}

function clearDraftInput(): boolean {
  const widget = draftInputWidget()
  const node = props.node as { inputs?: Array<{ name?: string; link?: unknown }> } | undefined
  const linked = !!node?.inputs?.find((i) => i.name === 'draft')?.link
  if (!widget || widget.link || linked) return false
  widget.value = ''
  return true
}

onMounted(() => {
  const v = props.widget?.value
  const inputDraft = readDraftInput()
  let loadedFromExternal = false
  if (isRecord(v) && isRecord(v.studio)) {
    const fromStudio = deriveDraft(v.studio as unknown as MossState)
    const savedDraft = inputDraft || (typeof v.draft === 'string' ? v.draft : JSON.stringify(v.draft ?? {}))
    if (fromStudio === savedDraft) {
      store.load(v.studio as Partial<MossState>)
      loadedFromExternal = !!inputDraft
    } else {
      const parsed = parseJsonLoose(savedDraft)
      if (parsed.ok) {
        const { state } = resolveToState(parsed.obj, (v.studio as MossState).width || 1024, (v.studio as MossState).height || 1024)
        const ui = (v.studio as Partial<MossState>).ui
        const overlay = (v.studio as Partial<MossState>).overlay
        store.load({ ...state, ui, overlay })
        loadedFromExternal = !!inputDraft
      } else {
        store.load(v.studio as Partial<MossState>)
      }
    }
    if (loadedFromExternal) {
      const cleared = clearDraftInput()
      store.json.syncError = ''
      store.json.syncWarnings = []
      store.json.syncNote = cleared
        ? 'Loaded external draft into editor · draft input cleared'
        : 'Draft input is connected · it overrides editor changes'
    }
  } else if (isRecord(v) && (v.draft || v.caption)) {
    const parsed = parseJsonLoose(typeof v.draft === 'string' ? v.draft : JSON.stringify(v.draft))
    if (parsed.ok) {
      const { state } = resolveToState(parsed.obj, 1024, 1024)
      store.load(state)
    }
  }
  seedRes()
  store.resetHistory()

  props.widget.serializeValue = async () => {
    const { draft } = serialize(store.state)
    return { draft, studio: plainState() }
  }

  watch(
    () => store.state,
    () => {
      const { draft } = serialize(store.state)
      props.widget.value = { draft, studio: plainState() }
      if (!store.restoring) scheduleSnapshot()
    },
    { deep: true, immediate: true },
  )
})

// TK instance boundary. Editor metadata and geometry remain owned by this store.
function exportPayload() { return { draft: serialize(store.state).draft, studio: plainState() } }
function loadPayload(v: any) {
  if (!v || !v.draft) throw new Error('布局数据缺少 draft')
  const parsed = parseJsonLoose(typeof v.draft === 'string' ? v.draft : JSON.stringify(v.draft))
  if (!parsed.ok) throw new Error(parsed.error)
  const result = resolveToState(parsed.obj, 1024, 1024, { strict: true })
  if (result.errors.length) throw new Error(result.errors.join('；'))
  if (v.studio && deriveDraft(v.studio) === JSON.stringify(parsed.obj)) store.load(v.studio)
  else store.load(result.state)
  store.select(null); seedRes(); store.resetHistory()
}
function selection() { return store.state.elements.flatMap((el, i) => store.selectedIds.includes(el.id) ? [i] : []) }
function compiled() { return serialize(store.state) }
function reference(url: string | null, transient = false) {
  if (transient) (store as any).previewImage = url
  else { (store as any).previewImage = null; (store.state.ui as any).referenceImage = url }
}
function applyCaptions(draft: any) {
  const original = serialize(store.state).draft
  if (original.width !== draft.width || original.height !== draft.height || original.items.length !== draft.items?.length)
    throw new Error('画布已变化，未覆盖当前布局')
  for (let i = 0; i < original.items.length; i++) {
    const before = original.items[i], after = draft.items[i]
    if (before.label !== after.label || JSON.stringify(before.bbox) !== JSON.stringify(after.bbox) || before.text !== after.text)
      throw new Error('区域已变化，未覆盖当前布局')
  }
  store.snapshot()
  store.state.summary.caption = draft.summary.caption
  store.state.elements.forEach((el, i) => { el.caption = draft.items[i].caption })
  store.snapshot()
}
defineExpose({ exportPayload, loadPayload, selection, applyCaptions, compiled, reference })

</script>

<style scoped>
/* Map ComfyUI theme vars to semantic names (dark fallbacks); inherited by children. */
.studio {
  position: relative; container-type: inline-size;
  --st-bg: var(--comfy-menu-bg, #1a1a1f);
  --st-panel: var(--comfy-menu-secondary-bg, #202026);
  --st-input: var(--comfy-input-bg, #15151a);
  --st-btn: var(--comfy-input-bg, #2a2a30);
  --st-border: var(--border-color, #3a3a44);
  --st-text: var(--input-text, #e5e5ea);
  --st-muted: var(--descrip-text, #9aa0aa);
  --st-accent: var(--p-primary-color, #60a5fa);
  --st-on-accent: var(--p-primary-button-text-color, #fff);
  --st-radius: var(--radius-md, 6px);
  color: var(--st-text);
  background: var(--st-bg);
  font-family: var(--p-font-family, -apple-system, system-ui, sans-serif);
  height: 100%;
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  overscroll-behavior: contain;
}
.main { display: flex; gap: 12px; flex: 1; min-height: 0; }
.left { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.right { flex: none; width: 300px; display: flex; flex-direction: column; gap: 10px; overflow: auto; min-height: 0; overscroll-behavior: contain; }
.drawer-backdrop { display: none; }
.slim-controls { display: none; }
@container (max-width: 760px) {
  .main { position: relative; }
  .right {
    position: absolute; right: 0; top: 0; bottom: 0; z-index: 30;
    background: var(--st-panel); padding: 8px; width: 260px;
    transform: translateX(100%); transition: transform .15s;
  }
  .studio.panel-open .right { transform: none; }
  .studio.panel-open .drawer-backdrop { display: block; position: absolute; inset: 0; z-index: 29; background: rgba(0,0,0,.4); }
  .slim-controls { display: inline-flex; }
}
.resmenu { display: flex; flex-direction: column; gap: 6px; min-width: 210px; }
.rsec, .rdiv { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--st-muted); }
.rdiv { border-top: 1px solid var(--st-border); margin: 2px 0; }
.aspects { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.achip { display: flex; flex-direction: column; align-items: center; gap: 3px; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 6px; padding: 6px 2px; cursor: pointer; }
.achip.on { border-color: var(--st-accent); color: var(--st-accent); }
.arect { border: 1.5px solid currentColor; border-radius: 2px; display: block; }
.albl { font-size: 9px; font-variant-numeric: tabular-nums; }
.mprow { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--st-muted); }
.mppresets { display: flex; gap: 3px; }
.mpp { background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; font-size: 10px; padding: 2px 6px; cursor: pointer; }
.mpp.on { border-color: var(--st-accent); color: var(--st-accent); }
.mprow input[type='number'] { width: 52px; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; padding: 3px; font-size: 11px; }
.whrow { display: flex; align-items: center; gap: 8px; }
.whrow label { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--st-muted); flex: 1; }
.whrow input { width: 100%; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; padding: 4px; font-size: 12px; }
.swap { background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-muted); border-radius: 4px; width: 26px; height: 26px; cursor: pointer; flex: none; }
.swap:hover { color: var(--st-accent); border-color: var(--st-accent); }
.rfoot { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--st-muted); }
.roob { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 5px; border-top: 1px solid var(--st-border); font-size: 10px; color: #f59e0b; }
.roob .refit { background: var(--st-btn); border: 1px solid rgba(245, 158, 11, .45); color: #fbbf24; border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer; }
.roob .refit:hover { border-color: #fbbf24; }
.help { display: flex; flex-direction: column; gap: 6px; min-width: 240px; max-width: 300px; font-size: 11px; }
.help .h { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--st-muted); margin: 2px 0 0; }
.help dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
.help dt { color: var(--st-muted); white-space: nowrap; }
.help dd { margin: 0; }
.help .tip { color: var(--st-muted); font-size: 10px; margin: 4px 0 0; }
.help .credit { color: var(--st-muted); font-size: 9px; margin: 6px 0 0; border-top: 1px solid var(--st-border); padding-top: 6px; }
.help .credit a { color: var(--st-accent); }
.resetc { display: flex; flex-direction: column; gap: 6px; min-width: 210px; }
.resetc .rq { margin: 0; font-size: 12px; font-weight: 600; }
.resetc .rh { margin: 0; font-size: 10px; color: var(--st-muted); }
.rbtns { display: flex; gap: 6px; justify-content: flex-end; }
.rno, .ryes { border: 1px solid var(--st-border); background: var(--st-btn); color: var(--st-text); border-radius: 5px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
.ryes { background: #b91c1c; border-color: #b91c1c; color: #fff; }
</style>
