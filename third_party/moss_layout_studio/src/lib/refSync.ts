// Bridge for the Ref Sync node: turns its broadcast temp-image descriptor into a
// /view URL exposed as a reactive ref.

import { api } from '@comfy/api'
import { ref } from 'vue'

export const refSyncImage = ref<string | null>(null)
export interface JsonSyncEvent {
  json: string
  n: number
  global: boolean
  force: boolean
  source: string
  importer: string
  itemCount: number
  bboxMode: string
  bboxTolerance: number
  warnings: string[]
}

// Draft JSON from a JSON Sync node / HTTP import; counter forces watchers on
// identical payloads. global/force bypass the per-studio jsonSync toggle.
export const jsonSyncCaption = ref<JsonSyncEvent>({
  json: '',
  n: 0,
  global: false,
  force: false,
  source: '',
  importer: '',
  itemCount: 0,
  bboxMode: 'auto',
  bboxTolerance: 2,
  warnings: [],
})

// ComfyUI's api is an EventTarget at runtime; its package types don't expose it.
const events = api as unknown as EventTarget

function eventDetail(ev: Event): Record<string, unknown> {
  if (ev instanceof CustomEvent) {
    const d: unknown = ev.detail
    return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}
  }
  return {}
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

let inited = false
export function initRefSync() {
  if (inited) return
  inited = true
  try {
    events.addEventListener('moss-layout.ref-sync', (ev) => {
      const d = eventDetail(ev)
      if (typeof d.filename !== 'string') return
      const p = new URLSearchParams({
        filename: d.filename,
        subfolder: str(d.subfolder),
        type: str(d.type, 'temp'),
      })
      // cache-bust so the same filename still triggers watchers + reloads
      refSyncImage.value = `/view?${p.toString()}&r=${Date.now()}`
    })
    events.addEventListener('moss-layout.json-sync', (ev) => {
      const d = eventDetail(ev)
      if (typeof d.json !== 'string') return
      const warnings = Array.isArray(d.warnings)
        ? d.warnings.filter((w): w is string => typeof w === 'string')
        : []
      jsonSyncCaption.value = {
        json: d.json,
        n: jsonSyncCaption.value.n + 1,
        global: d.global === true,
        force: d.force === true,
        source: str(d.source),
        importer: str(d.importer),
        itemCount: typeof d.item_count === 'number' ? d.item_count : 0,
        bboxMode: typeof d.bbox_mode === 'string' ? d.bbox_mode : 'auto',
        bboxTolerance: typeof d.bbox_tolerance === 'number' ? d.bbox_tolerance : 2,
        warnings,
      }
    })
  } catch (err: unknown) {
    console.warn('[MossLayoutStudio] sync listener failed to register', err)
  }
}
