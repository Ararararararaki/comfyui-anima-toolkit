import { create } from 'zustand'
import { Cache } from './cache'
import type { ArtistPreset } from '../types'

const KEY_SEL = 'artist_sel_v3'
const KEY_PRE = 'artist_presets_v3'

const COLORS = ['#f43f5e', '#8b5cf6', '#06b6d4', '#22c55e', '#eab308', '#f97316', '#ec4899', '#14b8a6', '#6366f1', '#d946ef']

interface ArtistStoreState {
  // 选择状态 — 核心简化：单一数组保证顺序
  selectedTags: string[]
  weights: Record<string, number>

  // 预设
  presets: ArtistPreset[]

  // UI 状态
  searchQuery: string
  filterCat: string
  sortMode: 'default' | 'alpha' | 'hot'
  promptFormat: 'webui' | 'nai'
  batchMode: boolean
  batchSelection: string[]

  // Actions — 选择管理
  toggleArtist: (tag: string) => void
  setWeight: (tag: string, weight: number) => void
  removeFromCombo: (tag: string) => void
  clearCombo: () => void
  reorderCombo: (fromIdx: number, toIdx: number) => void
  moveUp: (tag: string) => void
  moveDown: (tag: string) => void

  // Actions — 预设
  savePreset: (name: string) => void
  deletePreset: (id: string) => void
  loadPreset: (preset: ArtistPreset) => void

  // Actions — UI
  setSearch: (q: string) => void
  setFilterCat: (cat: string) => void
  setSortMode: (mode: 'default' | 'alpha' | 'hot') => void
  setPromptFormat: (format: 'webui' | 'nai') => void
  toggleBatchMode: () => void
  toggleBatchSelection: (tag: string) => void
  clearBatchSelection: () => void

  // Helpers
  isSelected: (tag: string) => boolean
  getWeight: (tag: string) => number
  getColor: (idx: number) => string
  getSelectionIndex: (tag: string) => number
}

// 读取持久化数据
const saved = Cache.load<{ tags: string[]; weights: Record<string, number> }>(KEY_SEL, 365 * 24 * 60 * 60 * 1000)

export const useArtistStore = create<ArtistStoreState>((set, get) => ({
  selectedTags: saved?.tags || [],
  weights: saved?.weights || {},
  presets: Cache.load<ArtistPreset[]>(KEY_PRE, 365 * 24 * 60 * 60 * 1000) || [],

  searchQuery: '',
  filterCat: 'all',
  sortMode: 'default',
  promptFormat: 'webui',
  batchMode: false,
  batchSelection: [],

  // ── 选择管理 ──

  toggleArtist: (tag) => set(s => {
    const exists = s.selectedTags.includes(tag)
    let tags: string[]
    let weights = { ...s.weights }

    if (exists) {
      tags = s.selectedTags.filter(t => t !== tag)
      delete weights[tag]
    } else {
      tags = [...s.selectedTags, tag]
      weights[tag] = 1.0
    }

    Cache.save(KEY_SEL, { tags, weights })
    return { selectedTags: tags, weights }
  }),

  setWeight: (tag, weight) => set(s => {
    const w = Math.max(0.1, Math.min(2.0, Math.round(weight * 10) / 10))
    const weights = { ...s.weights, [tag]: w }
    Cache.save(KEY_SEL, { tags: s.selectedTags, weights })
    return { weights }
  }),

  removeFromCombo: (tag) => set(s => {
    const tags = s.selectedTags.filter(t => t !== tag)
    const weights = { ...s.weights }
    delete weights[tag]
    Cache.save(KEY_SEL, { tags, weights })
    return { selectedTags: tags, weights }
  }),

  clearCombo: () => {
    Cache.save(KEY_SEL, { tags: [], weights: {} })
    set({ selectedTags: [], weights: {} })
  },

  reorderCombo: (fromIdx, toIdx) => set(s => {
    const tags = [...s.selectedTags]
    const [moved] = tags.splice(fromIdx, 1)
    tags.splice(toIdx, 0, moved)
    Cache.save(KEY_SEL, { tags, weights: s.weights })
    return { selectedTags: tags }
  }),

  moveUp: (tag) => set(s => {
    const idx = s.selectedTags.indexOf(tag)
    if (idx <= 0) return {}
    const tags = [...s.selectedTags]
    ;[tags[idx - 1], tags[idx]] = [tags[idx], tags[idx - 1]]
    Cache.save(KEY_SEL, { tags, weights: s.weights })
    return { selectedTags: tags }
  }),

  moveDown: (tag) => set(s => {
    const idx = s.selectedTags.indexOf(tag)
    if (idx < 0 || idx >= s.selectedTags.length - 1) return {}
    const tags = [...s.selectedTags]
    ;[tags[idx], tags[idx + 1]] = [tags[idx + 1], tags[idx]]
    Cache.save(KEY_SEL, { tags, weights: s.weights })
    return { selectedTags: tags }
  }),

  // ── 预设 ──

  savePreset: (name) => set(s => {
    const preset: ArtistPreset = {
      id: Date.now().toString(36),
      name,
      artists: s.selectedTags.map(tag => ({ tag, weight: s.weights[tag] || 1.0 })),
      createdAt: Date.now(),
    }
    const presets = [...s.presets, preset]
    Cache.save(KEY_PRE, presets)
    return { presets }
  }),

  deletePreset: (id) => set(s => {
    const presets = s.presets.filter(p => p.id !== id)
    Cache.save(KEY_PRE, presets)
    return { presets }
  }),

  loadPreset: (preset) => {
    const tags: string[] = []
    const weights: Record<string, number> = {}
    for (const a of preset.artists) {
      tags.push(a.tag)
      weights[a.tag] = a.weight
    }
    Cache.save(KEY_SEL, { tags, weights })
    set({ selectedTags: tags, weights })
  },

  // ── UI ──

  setSearch: (searchQuery) => set({ searchQuery }),
  setFilterCat: (filterCat) => set({ filterCat }),
  setSortMode: (sortMode) => set({ sortMode }),
  setPromptFormat: (promptFormat) => set({ promptFormat }),

  toggleBatchMode: () => set(s => ({
    batchMode: !s.batchMode,
    batchSelection: [],
  })),

  toggleBatchSelection: (tag) => set(s => ({
    batchSelection: s.batchSelection.includes(tag)
      ? s.batchSelection.filter(t => t !== tag)
      : [...s.batchSelection, tag],
  })),

  clearBatchSelection: () => set({ batchSelection: [] }),

  // ── Helpers ──

  isSelected: (tag) => get().selectedTags.includes(tag),
  getWeight: (tag) => get().weights[tag] || 1.0,
  getColor: (idx) => COLORS[idx % COLORS.length],
  getSelectionIndex: (tag) => get().selectedTags.indexOf(tag),
}))
