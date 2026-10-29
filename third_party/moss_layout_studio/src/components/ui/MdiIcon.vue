<template><svg class="tk-studio-icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="path" /></svg></template>
<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { paths } from '../../lib/iconPaths'
const attrs = useAttrs()
const path = computed(() => {
  const name = String(attrs.class || '').split(/\s+/).find(k => k in paths)
  return name ? paths[name] : paths['mdi-vector-square']
})
</script>
<style>.tk-studio-icon{display:inline-block;width:16px;height:16px;min-width:16px;fill:currentColor;vertical-align:middle;flex:none}.tk-studio-icon.mdi-spin{animation:tk-moss-spin 1s linear infinite}@keyframes tk-moss-spin{to{transform:rotate(360deg)}}</style>
