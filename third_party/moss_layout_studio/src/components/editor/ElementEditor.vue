<template>
  <UiCard v-if="el">
    <template #header>
      <div class="ehead">
        <!-- index chip doubles as the color picker -->
        <label class="idchip" :title="'Item ' + (index + 1) + (linked ? ' · linked ×' + groupSize : '') + ' — click to recolour'">
          <span class="n" :style="{ background: el.boxColor }">{{ index + 1 }}</span>
          <input type="color" :value="el.boxColor" @input="setShared('boxColor', ($event.target as HTMLInputElement).value)" />
        </label>
        <div class="seg">
          <UiButton icon :active="el.label === 'object'" title="物体" @click="setShared('label', 'object')"><MdiIcon class="mdi mdi-vector-square" /></UiButton>
          <UiButton icon :active="el.label === 'character'" title="人物" @click="setShared('label', 'character')"><MdiIcon class="mdi mdi-account-outline" /></UiButton>
          <UiButton icon :active="el.label === 'text'" title="文字" @click="setShared('label', 'text')"><MdiIcon class="mdi mdi-format-text" /></UiButton>
        </div>
        <span class="grow"></span>
        <UiButton icon title="关联副本：共享内容，位置独立" @click="store.duplicateLinked(el.id)"><MdiIcon class="mdi mdi-link-variant-plus" /></UiButton>
        <UiButton v-if="linked" icon :title="'Unlink from group (×' + groupSize + ')'" @click="store.unlink(el.id)"><MdiIcon class="mdi mdi-link-variant-off" /></UiButton>
      </div>
    </template>

    <div class="coordinates" aria-label="区域像素坐标">
      <label v-for="(name, i) in ['左 X', '上 Y', '右 X', '下 Y']" :key="i">{{ name }}
        <input type="number" :aria-label="name" :value="el.bbox[i]" min="0" :max="i % 2 ? store.state.height : store.state.width" @change="coordinate(i, ($event.target as HTMLInputElement))" />
      </label>
    </div>
    <label v-if="el.label === 'text'" class="filine">
      <span>可见文字</span>
      <input :value="el.text" type="text" placeholder="要显示的原文；用 \n 换行"
        @input="setShared('text', ($event.target as HTMLInputElement).value)" />
    </label>
    <label class="filine">
      <span>区域描述</span>
      <textarea aria-label="区域描述" :value="el.caption" rows="2" :placeholder="el.label === 'text' ? '字体、气泡和文字外观；台词填在上方文字栏' : '简单描述这个区域，或写完整提示词直接使用'"
        @input="setShared('caption', ($event.target as HTMLTextAreaElement).value)"></textarea>
    </label>
    <div class="filine">
      <span>补充标签</span>
      <ComboInput v-model="sharedTags" :options="opts" placeholder="可选，逗号分隔" />
    </div>
    <!-- div, not label: a label would route clicks to the first color input -->
    <div class="filine">
      <span>区域配色</span>
      <PaletteEditor :modelValue="el.palette" :max="8" label="item colours"
        @update:modelValue="setShared('palette', $event)" />
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStudioStore, SHARED_KEYS } from '@/lib/store'
import UiCard from '../ui/UiCard.vue'
import UiButton from '../ui/UiButton.vue'
import PaletteEditor from './PaletteEditor.vue'
import ComboInput from './ComboInput.vue'
import { PRESETS } from '@/lib/presets'
import { clampBbox } from '@/lib/moss'

const store = useStudioStore()
const el = computed(() => store.getElement(store.selectedId))
const index = computed(() => store.state.elements.findIndex((e) => e.id === store.selectedId))
const linked = computed(() => !!el.value?.linkId)
const groupSize = computed(() => (el.value ? store.linkGroupSize(el.value.id) : 1))
const opts = computed(() => (store.state.ui.showPresets ? PRESETS.tags : []))

// tags edit via ComboInput (comma-separated string input); keep it shared like the rest
const sharedTags = computed({
  get: () => (el.value ? el.value.tags.join(', ') : ''),
  set: (v: string) => {
    if (el.value) store.setShared(el.value.id, 'tags', v.split(',').map((s) => s.trim()).filter(Boolean))
  },
})

function setShared(key: (typeof SHARED_KEYS)[number], value: unknown) {
  if (el.value) store.setShared(el.value.id, key, value)
}
function coordinate(index: number, input: HTMLInputElement) {
  if (!el.value) return
  const bbox = [...el.value.bbox] as [number,number,number,number]
  const value = Number(input.value)
  if (!Number.isFinite(value)) { input.value = String(bbox[index]); return }
  const limit = index % 2 ? store.state.height : store.state.width
  bbox[index] = index < 2
    ? Math.max(0, Math.min(bbox[index + 2] - 1, Math.round(value)))
    : Math.max(bbox[index - 2] + 1, Math.min(limit, Math.round(value)))
  store.snapshot()
  el.value.bbox = clampBbox(bbox, store.state.width, store.state.height)
  input.value = String(el.value.bbox[index])
  store.snapshot()
}
</script>

<style scoped>
.ehead { display: flex; align-items: center; gap: 6px; width: 100%; flex-wrap: wrap; }
.coordinates{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;font-size:10px;color:var(--st-muted)}
.coordinates label{display:flex;flex-direction:column;gap:3px}.coordinates input{min-width:0;width:100%;background:var(--st-input);color:var(--st-text);border:1px solid var(--st-border);border-radius:4px;padding:4px}
.grow { flex: 1 1 auto; }
/* overflow:hidden clips the absolute color input to the chip so it can't overlap the type buttons */
.idchip { position: relative; display: inline-flex; flex: none; cursor: pointer; overflow: hidden; border-radius: 5px; }
.idchip .n {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 22px; padding: 0 6px; box-sizing: border-box;
  border-radius: 5px; color: #fff; font-size: 11px; font-weight: 700;
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 1px rgba(0, 0, 0, .35);
  border: 1px solid rgba(0, 0, 0, .25);
}
.idchip input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.seg { display: flex; gap: 2px; }

.filine { display: flex; gap: 8px; align-items: flex-start; font-size: 11px; color: var(--st-muted); }
.filine > span { width: 44px; flex: none; padding-top: 5px; text-align: right; }
.filine input[type='text'], .filine textarea {
  flex: 1; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text);
  border-radius: 5px; padding: 6px; font-size: 12px; resize: vertical; font-family: inherit;
}
.filine :deep(.palette) { flex: 1; }
</style>
