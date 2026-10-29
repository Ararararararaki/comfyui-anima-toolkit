<template>
  <div class="combo">
    <input
      :value="modelValue"
      :placeholder="placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <!-- native select: own browser layer, so it won't jolt the node's scroll container -->
    <select v-if="options.length" class="cpick" title="Pick a preset" @change="pick">
      <option value="" disabled selected hidden>presets…</option>
      <option v-for="p in options" :key="p" :value="p">{{ p }}</option>
    </select>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ modelValue: string; options?: string[]; placeholder?: string }>(), {
  options: () => [],
  placeholder: '',
})
const emit = defineEmits<{ 'update:modelValue': [string] }>()
function pick(e: Event) {
  const sel = e.target as HTMLSelectElement
  if (sel.value) emit('update:modelValue', sel.value)
  sel.value = '' // reset to the placeholder
}
</script>

<style scoped>
.combo { display: flex; gap: 4px; }
.combo input { flex: 1; min-width: 0; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 5px; padding: 6px; font-size: 12px; }
.cpick { flex: none; width: 74px; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-muted); border-radius: 5px; cursor: pointer; font-size: 11px; padding: 0 2px; }
.cpick:hover { border-color: var(--st-accent); }
.cpick:hover { border-color: var(--st-accent); }
</style>
