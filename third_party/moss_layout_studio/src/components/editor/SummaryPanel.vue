<template>
  <UiCard>
    <template #header>
      <div class="chead">
        <button class="fold" :title="store.state.ui.summaryOpen ? 'Collapse' : 'Expand'" @click="store.state.ui.summaryOpen = !store.state.ui.summaryOpen">
          <MdiIcon class="mdi" :class="store.state.ui.summaryOpen ? 'mdi-chevron-down' : 'mdi-chevron-right'" />
        </button>
        <span class="lhead" title="summary — global image description">全局描述</span>
        <span class="grow"></span>
        <select v-model="store.state.summary.canvas" class="canvasmode" title="summary.canvas — how the canvas is composed">
          <option v-for="m in CANVAS_MODES" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
    </template>

    <template v-if="store.state.ui.summaryOpen">
      <div class="field">
        <textarea v-model="store.state.summary.caption" rows="4" placeholder="整体场景、镜头与光照；人物专属特征写入各自区域，可见台词写入文字区域"></textarea>
      </div>
      <div class="field"><span>媒介 / 类型标签</span>
        <ComboInput v-model="metaText" :options="opts" placeholder="product campaign, studio photography" />
      </div>
      <div class="field"><span>全局配色（可选）</span>
        <PaletteEditor v-model="store.state.summary.palette" :max="16" label="image colors" />
      </div>
      <label class="presetsck"><input type="checkbox" v-model="store.state.ui.showPresets" /> 显示标签建议</label>
    </template>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStudioStore } from '@/lib/store'
import { CANVAS_MODES } from '@/lib/moss'
import UiCard from '../ui/UiCard.vue'
import PaletteEditor from './PaletteEditor.vue'
import ComboInput from './ComboInput.vue'
import { PRESETS } from '@/lib/presets'

const store = useStudioStore()
const opts = computed(() => (store.state.ui.showPresets ? PRESETS.meta : []))

const metaText = computed({
  get: () => store.state.summary.meta.join(', '),
  set: (v: string) => {
    store.state.summary.meta = v.split(',').map((s) => s.trim()).filter(Boolean)
  },
})
</script>

<style scoped>
.chead { display: flex; align-items: center; gap: 4px; }
.grow { flex: 1 1 auto; }
.fold { display: inline-flex; align-items: center; background: none; border: none; cursor: pointer; color: var(--st-muted); padding: 0; margin-left: -3px; }
.fold:hover { color: var(--st-text); }
.fold .mdi { font-size: 16px; line-height: 1; }
.lhead { display: inline-flex; align-items: center; font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--st-muted); }
.canvasmode { background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 5px; font-size: 11px; padding: 2px 4px; }
.field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--st-muted); }
.field textarea {
  background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text);
  border-radius: 5px; padding: 6px; font-size: 12px; resize: vertical; font-family: inherit; line-height: 1.45;
  min-height: 72px;
}
.field textarea:focus, .canvasmode:focus { outline: none; border-color: var(--st-accent); }
.presetsck { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--st-muted); cursor: pointer; }
</style>
