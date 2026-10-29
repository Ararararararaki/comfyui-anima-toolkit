<template>
  <div class="palette">
    <div class="swatches">
      <div v-for="(c, i) in modelValue" :key="i" class="swatch-wrap" @contextmenu.prevent="remove(i)">
        <label class="swatch" :style="{ background: c }" :title="c + '  —  click: edit · right-click: remove'">
          <input
            type="color"
            :value="c"
            @input="update(i, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <button v-if="modelValue.length < max" class="add" title="Add color" @click="add">+</button>
    </div>
    <div class="hint">{{ modelValue.length }}/{{ max }} {{ label }}</div>
  </div>
</template>

<script setup lang="ts">
import { normalizeHex } from '@/lib/moss'

const props = withDefaults(
  defineProps<{ modelValue: string[]; max?: number; label?: string }>(),
  { max: 16, label: 'colors' },
)
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

function add() {
  emit('update:modelValue', [...props.modelValue, '#888888'])
}
function remove(i: number) {
  const next = props.modelValue.slice()
  next.splice(i, 1)
  emit('update:modelValue', next)
}
function update(i: number, raw: string) {
  const h = normalizeHex(raw) ?? props.modelValue[i]
  const next = props.modelValue.slice()
  next[i] = h
  emit('update:modelValue', next)
}
</script>

<style scoped>
.palette { display: flex; flex-direction: column; gap: 4px; }
.swatches { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.swatch-wrap { position: relative; }
.swatch {
  display: block; width: 26px; height: 26px; border-radius: 5px;
  border: 1px solid var(--st-border); cursor: pointer; overflow: hidden;
}
.swatch input { opacity: 0; width: 100%; height: 100%; cursor: pointer; }
.add {
  width: 26px; height: 26px; border-radius: 5px; cursor: pointer;
  border: 1px dashed var(--st-border); background: transparent;
  color: var(--st-muted); font-size: 16px; line-height: 1;
}
.hint { font-size: 10px; color: var(--st-muted); }
</style>
