<template>
  <div v-if="open" class="liboverlay" @pointerdown.self="emit('update:open', false)" @contextmenu.prevent.stop>
    <div class="libpanel">
      <header class="libhead">
        <span class="t"><MdiIcon class="mdi mdi-bookshelf" /> 本机布局模板</span>
        <span v-if="templates.length" class="count">{{ shown.length }}</span>
        <span class="grow"></span>
        <div class="search">
          <MdiIcon class="mdi mdi-magnify" />
          <input v-model="query" placeholder="搜索模板…" spellcheck="false" />
          <button v-if="query" class="clr" title="Clear" @click="query = ''"><MdiIcon class="mdi mdi-close" /></button>
        </div>
        <UiButton icon title="刷新模板" @click="refresh"><MdiIcon class="mdi" :class="loading ? 'mdi-loading mdi-spin' : 'mdi-refresh'" /></UiButton>
        <UiButton icon title="关闭" @click="emit('update:open', false)"><MdiIcon class="mdi mdi-close" /></UiButton>
      </header>

      <div class="libbody">
        <div v-if="shown.length" class="grid">
          <div v-for="t in shown" :key="t.name" class="tile" :class="{ confirming: pendingDelete === t.name }">
            <button class="thumb" :title="'Load ' + t.stem" @click="load(t)">
              <img v-if="thumbOf(t)" :src="thumbOf(t)" :alt="t.stem" draggable="false" />
              <MdiIcon v-else class="mdi ph" :class="loading ? 'mdi-loading mdi-spin' : 'mdi-image-outline'" />
              <span v-if="elCount(t)" class="badge"><MdiIcon class="mdi mdi-shape-outline" /> {{ elCount(t) }}</span>
            </button>
            <button class="del" title="删除模板" @click.stop="pendingDelete = t.name"><MdiIcon class="mdi mdi-trash-can-outline" /></button>
            <div class="name" :title="t.stem">{{ t.stem }}</div>

            <div v-if="pendingDelete === t.name" class="confirm" @click.stop>
              <span class="q"><MdiIcon class="mdi mdi-trash-can-outline" /> 删除模板？</span>
              <div class="cbtns">
                <button class="yes" @click="doDelete(t)">删除</button>
                <button class="no" @click="pendingDelete = null">取消</button>
              </div>
            </div>
          </div>
        </div>
        <p v-else-if="loading" class="empty"><MdiIcon class="mdi mdi-loading mdi-spin" /> loading…</p>
        <p v-else-if="query" class="empty"><MdiIcon class="mdi mdi-magnify" /> No templates match “{{ query }}”.</p>
        <p v-else class="empty">
          <MdiIcon class="mdi mdi-bookshelf big" />
          <span>还没有保存的模板</span>
          <small>编辑布局后，输入名称并点下方<b>保存当前布局</b>。</small>
        </p>
      </div>

      <footer class="libfoot">
        <MdiIcon class="mdi mdi-content-save-outline fic" />
        <input v-model="saveName" class="nm" placeholder="模板名称" spellcheck="false" @keydown.enter="saveCurrent" />
        <label class="thumbck" :class="{ disabled: !store.refImage }" title="Save a small thumbnail of the current reference image so the template is easy to recognise">
          <input type="checkbox" v-model="withThumb" :disabled="!store.refImage" /> 参考图缩略图
        </label>
        <span class="grow"></span>
        <transition name="flash"><span v-if="flash" class="flash" :class="{ err: isErr }"><MdiIcon class="mdi" :class="isErr ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'" /> {{ flash }}</span></transition>
        <UiButton title="将完整布局保存为本机模板" @click="saveCurrent"><MdiIcon class="mdi mdi-content-save-outline" /> 保存当前布局</UiButton>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useStudioStore } from '@/lib/store'
import { serialize } from '@/lib/moss'
import { listLibrary, saveTemplate, deleteTemplate, previewJson, thumbUrl } from '@/lib/api'
import UiButton from '../ui/UiButton.vue'

interface LibItem { name: string; stem: string; caption: string; thumb?: boolean | string }

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const store = useStudioStore()
const templates = ref<LibItem[]>([])
const previews = reactive<Record<string, string>>({}) // bbox-render fallback
const libDir = ref('')
const loading = ref(false)
const saveName = ref('template_001')
const withThumb = ref(true)
const flash = ref('')
const query = ref('')
const pendingDelete = ref<string | null>(null)

const isErr = computed(() => /error|not found/i.test(flash.value))
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? templates.value.filter((t) => t.stem.toLowerCase().includes(q)) : templates.value
})

function nextName(stem: string): string {
  const m = /^(.*?)(\d+)$/.exec(stem)
  if (m) return m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0')
  return stem + '_002'
}

function elCount(t: LibItem): number {
  try {
    const value = JSON.parse(t.caption)
    const items = value?.draft?.items || value?.items
    return Array.isArray(items) ? items.length : 0
  } catch {
    return 0
  }
}

// prefer the saved ref thumbnail; fall back to a rendered bbox preview
function thumbOf(t: LibItem): string {
  if (t.thumb && libDir.value) return thumbUrl(libDir.value, `${t.stem}.thumb.jpg`, 256)
  return previews[t.stem] || ''
}

async function refresh() {
  loading.value = true
  flash.value = ''
  try {
    const r = await listLibrary()
    templates.value = r.templates || []
    libDir.value = r.dir || ''
  } catch (e: unknown) {
    flash.value = 'error: ' + String((e as Error)?.message || e)
  }
  loading.value = false
  // render a bbox preview only for templates without a ref thumbnail
  for (const t of templates.value) {
    if (t.thumb || previews[t.stem]) continue
    previewJson(t.caption).then((p) => {
      if (p.preview) previews[t.stem] = p.preview
    })
  }
}
watch(
  () => props.open,
  (o) => {
    if (o) {
      pendingDelete.value = null
      void refresh()
    }
  },
)

function load(t: LibItem) {
  const res = store.importDraftJson(t.caption)
  if (res.ok) emit('update:open', false)
  else flash.value = 'load error: ' + (res.error || 'invalid template')
}

async function doDelete(t: LibItem) {
  try {
    const r = await deleteTemplate(t.name)
    if (r.ok) {
      flash.value = 'deleted ' + t.stem
      pendingDelete.value = null
      delete previews[t.stem]
      await refresh()
    } else {
      flash.value = 'delete error: ' + (r.error || 'unknown')
    }
  } catch (e: unknown) {
    flash.value = 'delete error: ' + String((e as Error)?.message || e)
  }
}

function hexA(hex: string, a: number): string {
  const h = (hex || '').replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  return `rgba(${r},${g},${b},${a})`
}

// downscale the reference image and bake the bbox overlay onto it for the thumbnail
async function makeThumb(): Promise<string> {
  const src = store.refImage
  if (!src) return ''
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const max = 320
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.max(1, Math.round(img.naturalWidth * scale))
      const h = Math.max(1, Math.round(img.naturalHeight * scale))
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')
      if (!ctx) return resolve('')
      ctx.drawImage(img, 0, 0, w, h)
      // draft bboxes are pixel [x1, y1, x2, y2] on the W×H canvas
      const W = store.state.width, H = store.state.height
      ctx.lineWidth = Math.max(1, Math.round(w / 220))
      for (const el of store.state.elements) {
        const [x1, y1, x2, y2] = el.bbox
        const rx = (x1 / W) * w
        const ry = (y1 / H) * h
        const rw = ((x2 - x1) / W) * w
        const rh = ((y2 - y1) / H) * h
        const color = el.boxColor || '#60a5fa'
        ctx.fillStyle = hexA(color, 0.16)
        ctx.fillRect(rx, ry, rw, rh)
        ctx.strokeStyle = color
        ctx.strokeRect(rx, ry, rw, rh)
      }
      try {
        resolve(c.toDataURL('image/jpeg', 0.82))
      } catch {
        resolve('') // tainted canvas (cross-origin)
      }
    }
    img.onerror = () => resolve('')
    img.src = src
  })
}

async function saveCurrent() {
  const json = JSON.stringify({draft:serialize(store.state).draft,studio:JSON.parse(JSON.stringify(store.state))})
  const thumb = withThumb.value && store.refImage ? await makeThumb() : ''
  try {
    const r = await saveTemplate('', saveName.value.trim() || 'template_001', json, false, thumb)
    if (r.ok) {
      flash.value = 'saved as ' + (r.name || saveName.value) + '.json'
      saveName.value = nextName(r.name || saveName.value)
      await refresh()
    } else {
      flash.value = 'save error: ' + (r.error || 'unknown')
    }
  } catch (e: unknown) {
    flash.value = 'save error: ' + String((e as Error)?.message || e)
  }
}
</script>

<style scoped>
/* absolute over .studio (which is position:relative) */
.liboverlay {
  position: absolute; inset: 0; z-index: 60;
  background: color-mix(in srgb, var(--st-bg, #1a1a1f) 72%, transparent);
  backdrop-filter: blur(4px);
  display: flex; padding: 12px; box-sizing: border-box;
  border-radius: 8px; /* follow the node's rounded corners */
}
.libpanel {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  background: var(--st-panel); border: 1px solid var(--st-border); border-radius: calc(var(--st-radius, 6px) + 3px);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); overflow: hidden;
}

/* ── header ─────────────────────────────────────────────── */
.libhead { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--st-border); flex-wrap: wrap; }
.libhead .t { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 700; letter-spacing: .2px; }
.libhead .t .mdi { font-size: 17px; color: var(--st-accent); }
.count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px;
  padding: 0 6px; border-radius: 9px; background: color-mix(in srgb, var(--st-accent) 22%, transparent);
  color: var(--st-accent); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
}
.grow { flex: 1; }
.search { display: flex; align-items: center; gap: 4px; background: var(--st-input); border: 1px solid var(--st-border); border-radius: 7px; padding: 0 6px; height: 28px; transition: border-color .12s; }
.search:focus-within { border-color: var(--st-accent); }
.search .mdi { font-size: 14px; color: var(--st-muted); }
.search input { background: none; border: none; outline: none; color: var(--st-text); font-size: 11px; font-family: inherit; width: 130px; padding: 0; }
.search .clr { display: inline-flex; background: none; border: none; color: var(--st-muted); cursor: pointer; padding: 0; }
.search .clr:hover { color: var(--st-text); }

/* ── body / grid ────────────────────────────────────────── */
.libbody { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 11px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); gap: 11px; }
.tile {
  position: relative; display: flex; flex-direction: column; gap: 6px; padding: 6px;
  background: var(--st-input); border: 1px solid var(--st-border); border-radius: calc(var(--st-radius, 6px) + 1px);
  transition: border-color .12s, box-shadow .12s, transform .1s;
}
.tile:hover { border-color: var(--st-accent); box-shadow: 0 0 0 1px var(--st-accent) inset, 0 6px 16px rgba(0, 0, 0, .35); transform: translateY(-2px); }
.tile.confirming { border-color: #ef4444; box-shadow: 0 0 0 1px #ef4444 inset; }

.thumb {
  position: relative; width: 100%; aspect-ratio: 1; border-radius: 5px; overflow: hidden;
  border: none; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--st-bg, #1a1a1f) 60%, #000);
}
/* cover so the thumbnail fills the frame without letterbox bars */
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb .ph { font-size: 24px; color: var(--st-muted); opacity: .45; }
.badge {
  position: absolute; top: 5px; left: 5px; display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 6px; border-radius: 8px; background: rgba(0, 0, 0, .62); color: #fff;
  font-size: 10px; font-weight: 600; backdrop-filter: blur(2px);
}
.badge .mdi { font-size: 11px; }

.del {
  position: absolute; top: 9px; right: 9px; z-index: 2; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 6px; background: rgba(0, 0, 0, .55); border: none; color: #fff;
  cursor: pointer; opacity: 0; transition: opacity .12s, background .12s;
}
.del .mdi { font-size: 15px; }
.tile:hover .del { opacity: 1; }
.del:hover { background: #dc2626; }

.name { font-size: 11px; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 2px; }

/* delete confirm overlay over the tile */
.confirm {
  position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px;
  background: color-mix(in srgb, var(--st-panel) 88%, transparent); backdrop-filter: blur(2px);
  border-radius: inherit; padding: 8px; text-align: center;
}
.confirm .q { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--st-text); }
.confirm .q .mdi { color: #ef4444; font-size: 15px; }
.cbtns { display: flex; gap: 6px; }
.cbtns button { border: none; border-radius: 6px; padding: 5px 11px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit; }
.cbtns .yes { background: #dc2626; color: #fff; }
.cbtns .yes:hover { background: #ef4444; }
.cbtns .no { background: var(--st-btn); color: var(--st-text); border: 1px solid var(--st-border); }
.cbtns .no:hover { border-color: var(--st-accent); }

/* ── empty / loading ────────────────────────────────────── */
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; height: 100%; min-height: 180px; color: var(--st-muted); font-size: 12px; text-align: center; }
.empty .mdi { font-size: 17px; }
.empty .big { font-size: 40px; opacity: .35; }
.empty small { font-size: 11px; opacity: .8; }

/* ── footer / save bar ──────────────────────────────────── */
.libfoot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-top: 1px solid var(--st-border); background: color-mix(in srgb, var(--st-bg, #1a1a1f) 35%, transparent); flex-wrap: wrap; }
.libfoot .fic { font-size: 16px; color: var(--st-muted); }
.nm { background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 7px; padding: 6px 9px; font-size: 11px; font-family: inherit; width: 150px; }
.nm:focus { outline: none; border-color: var(--st-accent); }
.thumbck { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--st-muted); white-space: nowrap; cursor: pointer; }
.thumbck.disabled { opacity: .45; cursor: not-allowed; }
.flash { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--st-accent); white-space: nowrap; }
.flash .mdi { font-size: 14px; }
.flash.err { color: #f87171; }
.flash-enter-active, .flash-leave-active { transition: opacity .18s; }
.flash-enter-from, .flash-leave-to { opacity: 0; }
</style>
