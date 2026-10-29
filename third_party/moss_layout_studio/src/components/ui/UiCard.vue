<template>
  <div class="ui-card">
    <div v-if="title || $slots.header" class="ui-card-head">
      <span v-if="title" class="ui-card-title">{{ title }}</span>
      <slot name="header" />
    </div>
    <slot />
  </div>
</template>

<script setup lang="ts">
// title = plain header; #header slot = header-aligned controls.
defineProps<{ title?: string }>()
</script>

<style scoped>
.ui-card {
  background: var(--st-panel); border: 1px solid var(--st-border); border-radius: var(--st-radius, 6px);
  padding: 8px; display: flex; flex-direction: column; gap: 7px;
}
.ui-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ui-card-title { font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--st-muted); }
</style>
