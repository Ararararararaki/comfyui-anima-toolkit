<template>
  <UiCard v-if="store.state.ui.jsonOpen" class="jcard">
    <textarea
      v-if="j.editing"
      ref="taEl"
      v-model="j.draft"
      class="json edit"
      :class="{ bad: !!parseError }"
      spellcheck="false"
      placeholder="Paste a whole MOSS draft JSON (or a compiled prompt) here, then Apply to load it into the studio."
    ></textarea>
    <pre v-else class="json">{{ pretty }}</pre>

    <div v-if="!j.editing" class="compiled">
      <span class="clbl" title="The compiled model prompt — what the prompt output sends to the sampler">compiled prompt</span>
      <button class="cbtn" :title="copiedPrompt ? 'Copied' : 'Copy the compiled prompt'" @click="copyPrompt">{{ copiedPrompt ? '✓' : '⧉' }}</button>
      <pre class="cline">{{ prompt }}</pre>
    </div>

    <div v-if="j.editing && parseError" class="parseerr">
      <div class="errhead">
        <span class="msg">⚠ {{ parseMsg }}</span>
        <button v-if="parseInfo.line" class="ebtn" title="Jump to this line in the editor" @click="jumpToError">go to →</button>
        <button class="ebtn" title="Copy the error" @click="copyError">{{ copiedErr ? 'copied ✓' : 'copy' }}</button>
      </div>
      <pre v-if="parseFrame" class="errframe" title="Jump to this line" @click="jumpToError">{{ parseFrame }}</pre>
    </div>
    <div v-if="j.editing && j.applyErrors.length" class="applyerr">
      <div class="errhead">
        <span class="msg">⚠ Import rejected — nothing was applied</span>
        <button v-if="canClamp" class="ebtn clamp" title="Clamp every out-of-canvas bbox and apply" @click="store.jsonApplyClamp()">clamp &amp; apply</button>
      </div>
      <ul class="errlist">
        <li v-for="(e, i) in j.applyErrors" :key="i">{{ e }}</li>
      </ul>
    </div>
    <ul v-if="j.editing && j.applyWarnings.length" class="warnlist">
      <li v-for="(w, i) in j.applyWarnings" :key="i">{{ w }}</li>
    </ul>
    <div v-if="!j.editing && (j.syncError || j.syncWarnings.length || j.syncNote)" class="syncbox" :class="{ bad: !!j.syncError }">
      <div v-if="j.syncError" class="syncbad">sync: {{ j.syncError }}</div>
      <div v-if="j.syncNote" class="syncnote">{{ j.syncNote }}</div>
      <ul v-if="j.syncWarnings.length" class="warnlist">
        <li v-for="(w, i) in j.syncWarnings" :key="i">sync: {{ w }}</li>
      </ul>
    </div>
    <ul v-if="!j.editing && warnings.length" class="warnlist">
      <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
    </ul>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useStudioStore } from '@/lib/store'
import { serialize, parseJsonLoose } from '@/lib/moss'
import UiCard from '../ui/UiCard.vue'

const store = useStudioStore()
const j = store.json
const taEl = ref<HTMLTextAreaElement | null>(null)
const copiedErr = ref(false)
const copiedPrompt = ref(false)

const result = computed(() => serialize(store.state))
const pretty = computed(() => result.value.draftPretty)
const prompt = computed(() => result.value.prompt)
const warnings = computed(() => result.value.warnings)

// On parse failure pin down line/column (V8 reports "position", Firefox "line/column").
const parseInfo = computed<{ error: string; line: number | null; col: number | null }>(() => {
  if (!j.editing || !j.draft.trim()) return { error: '', line: null, col: null }
  // accept anything parseJsonLoose can recover; only report a position when nothing parses
  if (parseJsonLoose(j.draft).ok) return { error: '', line: null, col: null }
  try {
    JSON.parse(j.draft)
    return { error: '', line: null, col: null }
  } catch (e: unknown) {
    const msg = String((e as Error)?.message || e)
    let line: number | null = null
    let col: number | null = null
    const pos = msg.match(/position (\d+)/)
    if (pos) {
      const i = Number(pos[1])
      const upto = j.draft.slice(0, i)
      line = upto.split('\n').length
      col = i - upto.lastIndexOf('\n')
    } else {
      const lc = msg.match(/line (\d+) column (\d+)/)
      if (lc) {
        line = Number(lc[1])
        col = Number(lc[2])
      }
    }
    return { error: msg, line, col }
  }
})
const parseError = computed(() => parseInfo.value.error)
const canClamp = computed(() =>
  j.applyErrors.some((e) => /exceeds canvas/i.test(e) && !/collapses/i.test(e)),
)
const parseMsg = computed(() => {
  const { error, line, col } = parseInfo.value
  if (!error) return ''
  const short = error
    .replace(/^JSON\.parse: /, '')
    .replace(/ in JSON at position \d+.*/i, '')
    .replace(/ at line \d+ column \d+.*/i, '')
  return line ? `Line ${line}, column ${col}: ${short}` : short
})
// code frame: offending line (+ the one before) with a caret
const parseFrame = computed(() => {
  const { line, col } = parseInfo.value
  if (!line) return ''
  const lines = j.draft.split('\n')
  const w = String(line).length
  const rows: string[] = []
  if (line - 2 >= 0) rows.push(`${String(line - 1).padStart(w)} | ${lines[line - 2]}`)
  rows.push(`${String(line).padStart(w)} | ${lines[line - 1] ?? ''}`)
  rows.push(`${' '.repeat(w)} | ${' '.repeat(Math.max(0, (col ?? 1) - 1))}^`)
  return rows.join('\n')
})

function jumpToError() {
  const ta = taEl.value
  const { line } = parseInfo.value
  if (!ta || !line) return
  const lines = j.draft.split('\n')
  let start = 0
  for (let i = 0; i < line - 1; i++) start += lines[i].length + 1
  const end = start + (lines[line - 1]?.length ?? 0)
  ta.focus()
  ta.setSelectionRange(start, end)
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 16
  ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2)
}
async function copyError() {
  const text = parseFrame.value ? `${parseMsg.value}\n${parseFrame.value}` : parseMsg.value
  try {
    await navigator.clipboard.writeText(text)
    copiedErr.value = true
    setTimeout(() => (copiedErr.value = false), 1200)
  } catch {
    /* clipboard unavailable */
  }
}
async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(prompt.value)
    copiedPrompt.value = true
    setTimeout(() => (copiedPrompt.value = false), 1200)
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<style scoped>
.jcard { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.json {
  background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text);
  border-radius: 6px; padding: 8px; font-size: 11px; line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  max-height: 240px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word;
}
textarea.json { width: 100%; box-sizing: border-box; resize: vertical; min-height: 140px; }
textarea.json:focus, textarea.json.bad:focus { outline: none; }
textarea.json.bad { border-color: #f87171; }
.compiled { position: relative; display: flex; flex-direction: column; gap: 2px; }
.clbl { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--st-muted); }
.cbtn { position: absolute; right: 10px; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-muted); border-radius: 4px; width: 22px; height: 20px; cursor: pointer; font-size: 12px; line-height: 1; }
.cbtn:hover { color: var(--st-text); border-color: var(--st-accent); }
.cline {
  background: var(--st-input); border: 1px dashed var(--st-border); color: var(--st-muted);
  border-radius: 6px; padding: 6px 8px; font-size: 10px; line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  max-height: 110px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-all;
}
.parseerr { display: flex; flex-direction: column; gap: 4px; }
.errhead { display: flex; align-items: center; gap: 6px; }
.errhead .msg { flex: 1; font-size: 11px; color: #f87171; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ebtn { background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-muted); border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer; }
.ebtn:hover { color: var(--st-text); border-color: var(--st-accent); }
.ebtn.clamp { color: #fbbf24; border-color: rgba(251, 191, 36, .45); }
.errframe {
  background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text);
  border-radius: 6px; padding: 6px 8px; font-size: 10px; line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  max-height: 120px; overflow: auto; margin: 0; cursor: pointer;
}
.warnlist { margin: 0; padding: 0 0 0 16px; font-size: 10px; color: #f59e0b; display: flex; flex-direction: column; gap: 2px; }
.errlist { margin: 0; padding: 0 0 0 16px; font-size: 10px; color: #f87171; display: flex; flex-direction: column; gap: 2px; }
.applyerr { display: flex; flex-direction: column; gap: 4px; }
.syncbox { border-top: 1px solid var(--st-border); padding-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.syncbad { font-size: 10px; color: #f87171; overflow-wrap: anywhere; }
.syncnote { font-size: 10px; color: #34d399; overflow-wrap: anywhere; }
</style>
