<template>
  <span ref="root" class="ui-pop">
    <span class="ui-pop-trigger" @click="toggle"><slot name="trigger" /></span>
    <div v-if="open" class="ui-pop-panel" :class="[align, { up }]" @pointerdown.stop>
      <slot :close="close" />
    </div>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

withDefaults(defineProps<{ align?: 'left' | 'right'; up?: boolean }>(), { align: 'right', up: false })

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function onDoc(e: Event) {
  if (root.value && !root.value.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
function bind() {
  // pointerdown not mousedown: the canvas preventDefault()s pointerdown, suppressing
  // the compat mousedown. Capture phase beats the canvas's own handler.
  document.addEventListener('pointerdown', onDoc, true)
  document.addEventListener('keydown', onKey)
}
function unbind() {
  document.removeEventListener('pointerdown', onDoc, true)
  document.removeEventListener('keydown', onKey)
}
function close() {
  open.value = false
  unbind()
}
function toggle() {
  open.value = !open.value
  open.value ? bind() : unbind()
}
onBeforeUnmount(unbind)
</script>

<style scoped>
.ui-pop { position: relative; display: inline-flex; }
.ui-pop-panel {
  position: absolute; top: calc(100% + 5px); z-index: 50;
  background: var(--st-panel); border: 1px solid var(--st-border); border-radius: var(--st-radius, 6px);
  padding: 10px 12px; min-width: 240px; max-width: 320px; max-height: 360px; overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  font-size: 11px; line-height: 1.5; color: var(--st-text); cursor: default;
}
.ui-pop-panel.right { right: 0; }
.ui-pop-panel.left { left: 0; }
.ui-pop-panel.up { top: auto; bottom: calc(100% + 5px); }
</style>
