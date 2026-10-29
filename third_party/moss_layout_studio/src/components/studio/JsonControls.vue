<template>
  <div class="jctrl">
    <MdiIcon class="jstat mdi" :class="statusClass" :title="statusTitle" />
    <MdiIcon v-if="j.syncError" class="jstat mdi mdi-sync-alert bad" :title="j.syncError" />
    <MdiIcon v-else-if="j.syncWarnings.length" class="jstat mdi mdi-sync-alert warn" :title="syncWarningTitle" />
    <span v-if="j.syncNote" class="jnote" :title="j.syncNote">{{ j.syncNote }}</span>
    <!-- sync (live-import) is always reachable; token count only when the JSON is open -->
    <span v-if="store.state.ui.jsonOpen && !j.editing" class="jtok" title="Compiled prompt token estimate (rough)">~{{ tokens }} tok</span>
    <span class="grow"></span>
    <template v-if="!j.editing">
      <!-- copy only when the JSON is open (avoids mis-clicking it on the collapsed bar) -->
      <UiButton v-if="store.state.ui.jsonOpen" icon :title="copied ? 'Copied' : 'Copy draft JSON'" @click="copy"><MdiIcon class="mdi" :class="copied ? 'mdi-check' : 'mdi-content-copy'" /></UiButton>
      <UiButton icon title="编辑 / 粘贴 JSON" @click="store.jsonStartEdit()"><MdiIcon class="mdi mdi-pencil-outline" /></UiButton>
      <UiButton icon :title="store.state.ui.jsonOpen ? '收起 JSON' : '展开 JSON'" @click="store.state.ui.jsonOpen = !store.state.ui.jsonOpen"><MdiIcon class="mdi" :class="store.state.ui.jsonOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" /></UiButton>
    </template>
    <template v-else>
      <UiButton title="Re-indent the JSON" @click="store.jsonTidy()">格式化</UiButton>
      <UiButton variant="primary" :disabled="!!parseError" @click="store.jsonApply()">应用</UiButton>
      <UiButton @click="store.jsonCancel()">取消</UiButton>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useStudioStore } from '@/lib/store'
import { serialize, parseJsonLoose } from '@/lib/moss'
import UiButton from '../ui/UiButton.vue'

const store = useStudioStore()
const j = store.json
const copied = ref(false)
const result = computed(() => serialize(store.state))
const warnings = computed(() => result.value.warnings)
// rough token estimate on the compiled prompt (~4 chars/token)
const tokens = computed(() => Math.round(result.value.prompt.length / 4))
const parseError = computed(() => {
  if (!j.editing || !j.draft.trim()) return ''
  const res = parseJsonLoose(j.draft)
  return res.ok ? '' : res.error
})
const statusClass = computed(() => {
  if (j.editing) return parseError.value ? 'mdi-alert-circle bad' : 'mdi-check-circle good'
  return warnings.value.length ? 'mdi-alert warn' : 'mdi-check-circle good'
})
const statusTitle = computed(() => {
  if (j.editing) return parseError.value ? 'Invalid JSON' : 'Parses OK'
  return warnings.value.length
    ? `${warnings.value.length} warning${warnings.value.length > 1 ? 's' : ''}:\n${warnings.value.join('\n')}`
    : 'Valid draft'
})
const syncWarningTitle = computed(() => {
  const n = j.syncWarnings.length
  return `${n} import warning${n === 1 ? '' : 's'}:\n${j.syncWarnings.join('\n')}`
})
function toggleSync() {
  store.state.ui.jsonSync = !store.state.ui.jsonSync
  if (!store.state.ui.jsonSync) j.syncError = ''
}
async function copy() {
  try {
    await navigator.clipboard.writeText(serialize(store.state).draftPretty)
    copied.value = true
    setTimeout(() => (copied.value = false), 1200)
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<style scoped>
.jctrl { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; }
.grow { flex: 1 1 auto; }
.jstat { font-size: 15px; line-height: 1; cursor: help; }
.jstat.good { color: #34d399; }
.jstat.warn { color: #f59e0b; }
.jstat.bad { color: #f87171; }
.jnote {
  max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--st-muted); background: var(--st-btn);
  border: 1px solid var(--st-border); border-radius: var(--radius-sm, 5px);
  padding: 2px 6px; cursor: help;
}
.jtok { display: inline-flex; align-items: center; min-height: 24px; box-sizing: border-box; font-size: 10px; color: var(--st-muted); font-family: ui-monospace, monospace; background: var(--st-btn); border: 1px solid var(--st-border); border-radius: var(--radius-sm, 5px); padding: 0 7px; cursor: help; }
</style>
