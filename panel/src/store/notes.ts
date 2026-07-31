import { Cache } from './cache'
import type { ModelNote } from '../types'

const KEY = 'model_notes_v1'

function getAll(): Record<number, ModelNote> {
  return Cache.load<Record<number, ModelNote>>(KEY, 365 * 24 * 60 * 60 * 1000) || {}
}

function saveAll(data: Record<number, ModelNote>) {
  Cache.save(KEY, data)
}

export function getNote(id: number): ModelNote | undefined {
  return getAll()[id]
}

export function getNotesMap(): Record<number, ModelNote> {
  return getAll()
}

export function saveNote(id: number, data: { notes?: string; rating?: number; status?: ModelNote['status'] }): ModelNote {
  const all = getAll()
  const existing = all[id] || { id, notes: '', rating: 0, status: 'untried' as const, lastUsed: 0, updatedAt: 0 }
  const updated: ModelNote = {
    ...existing,
    ...data,
    id,
    updatedAt: Date.now(),
  }
  all[id] = updated
  saveAll(all)
  return updated
}

export function recordUse(id: number) {
  const all = getAll()
  if (all[id]) {
    all[id].lastUsed = Date.now()
    all[id].updatedAt = Date.now()
  } else {
    all[id] = { id, notes: '', rating: 0, status: 'untried', lastUsed: Date.now(), updatedAt: Date.now() }
  }
  saveAll(all)
}

export function getModelStatusText(status: string): string {
  const map: Record<string, string> = { untried: '未尝试', trying: '🔄 尝试中', success: '✅ 好用', abandoned: '❌ 放弃' }
  return map[status] || status
}