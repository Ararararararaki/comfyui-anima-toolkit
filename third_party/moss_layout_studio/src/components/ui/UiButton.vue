<template>
  <button type="button" :aria-label="String($attrs['aria-label'] || $attrs.title || '') || undefined" class="ui-btn" :class="[variant, { on: active, icon }]">
    <slot />
  </button>
</template>

<script setup lang="ts">
// active = toggled/selected; variant 'primary' = main action; icon = square icon-only.
withDefaults(defineProps<{ variant?: 'default' | 'primary'; active?: boolean; icon?: boolean }>(), {
  variant: 'default',
  active: false,
  icon: false,
})
</script>

<style scoped>
.ui-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  min-height: 24px; padding: 3px 9px; box-sizing: border-box;
  background: var(--st-btn); color: var(--st-text); border: 1px solid var(--st-border);
  border-radius: var(--radius-sm, 5px); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit;
  white-space: nowrap; transition: border-color .1s, background .1s;
}
.ui-btn.icon { min-width: 26px; padding: 0 6px; font-size: 12px; }
.ui-btn :deep(.mdi) { font-size: 15px; line-height: 1; }
.ui-btn:hover { border-color: var(--st-accent); }
.ui-btn:disabled { opacity: .4; cursor: default; }
.ui-btn:disabled:hover { border-color: var(--st-border); }
.ui-btn.on,
.ui-btn.primary { background: var(--st-accent); border-color: var(--st-accent); color: var(--st-on-accent, #fff); }
.ui-btn.primary:hover { filter: brightness(1.08); }
</style>
