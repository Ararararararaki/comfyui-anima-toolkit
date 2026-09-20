// Outputs 导出元数据策略：开关状态 + 自定义署名条目（localStorage 持久化）
//
// 语义（2026-09-21 与用户确认）：
//   · 开关**默认关闭**。关闭时导出路径完全不动字节（连署名也不写）——
//     署名是这个开关的一部分，不是独立功能。
//   · 开启后：去掉 ComfyUI 的 parameters/workflow/prompt，再覆盖写入下列条目。
//   · 条目值留空 = 只清不写；预置四键（Author/Copyright/Software/Comment）可改可删，也能加自定义键。
//   · 只作用于**导出副本**；磁盘原图永不被改写。
//
// 持久化沿用本栏目既有习惯（outputStore 的 persistFilterState）：localStorage + 模块加载时 restore。
// 这里不放进 outputStore：outputStore 管的是「文件浏览状态」，而导出策略是另一个关注点，
// 混进去会让它的 state 形状与持久化键都变复杂。

import { create } from 'zustand'
import type { ExportMetadataOptions } from '../utils/imageMetadata'

const STORAGE_KEY = 'outputs_exportMetadata'

export interface MetadataEntry {
  key: string
  value: string
}

/** 预置署名键（用户可改值、可删行、可另加自定义键） */
export const DEFAULT_METADATA_ENTRIES: MetadataEntry[] = [
  { key: 'Author', value: '' },
  { key: 'Copyright', value: '' },
  { key: 'Software', value: '' },
  { key: 'Comment', value: '' },
]

export interface ExportMetadataState {
  /** 导出时去除元数据 + 写入署名（默认关） */
  enabled: boolean
  entries: MetadataEntry[]
  setEnabled: (v: boolean) => void
  setEntry: (index: number, patch: Partial<MetadataEntry>) => void
  addEntry: () => void
  removeEntry: (index: number) => void
  restoreDefaults: () => void
}

function persist(state: { enabled: boolean; entries: MetadataEntry[] }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: state.enabled, entries: state.entries }))
  } catch { /* quota 或隐私模式：忽略，退回默认值 */ }
}

export const useExportMetadataStore = create<ExportMetadataState>((set, get) => ({
  enabled: false,
  entries: DEFAULT_METADATA_ENTRIES.map(e => ({ ...e })),

  setEnabled: (v) => {
    set({ enabled: !!v })
    persist(get())
  },
  setEntry: (index, patch) => {
    const entries = get().entries.map((e, i) => (i === index ? { ...e, ...patch } : e))
    set({ entries })
    persist({ enabled: get().enabled, entries })
  },
  addEntry: () => {
    const entries = [...get().entries, { key: '', value: '' }]
    set({ entries })
    persist({ enabled: get().enabled, entries })
  },
  removeEntry: (index) => {
    const entries = get().entries.filter((_, i) => i !== index)
    set({ entries })
    persist({ enabled: get().enabled, entries })
  },
  restoreDefaults: () => {
    const entries = DEFAULT_METADATA_ENTRIES.map(e => ({ ...e }))
    set({ entries })
    persist({ enabled: get().enabled, entries })
  },
}))

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as { enabled?: unknown; entries?: unknown }
    const st = useExportMetadataStore.getState()
    if (typeof saved.enabled === 'boolean') st.enabled = saved.enabled
    if (Array.isArray(saved.entries)) {
      const entries = saved.entries
        .filter((e): e is MetadataEntry => !!e && typeof e === 'object')
        .map(e => ({ key: String((e as MetadataEntry).key ?? ''), value: String((e as MetadataEntry).value ?? '') }))
      // 空数组视为「用户主动删光了预置键」——保留空，不强行塞回默认四键
      st.entries = entries
    }
  } catch { /* 损坏的存档：按默认值走 */ }
}
restore()

/**
 * 组装给 `applyExportMetadata` 的选项。
 * ⚠️ 开关关闭时 entries 必须是空对象：署名属于开关内部行为，
 * 否则「只想留个署名、不去元数据」会变成静默的元数据改写。
 */
export function exportMetadataOptions(): ExportMetadataOptions {
  const st = useExportMetadataStore.getState()
  if (!st.enabled) return { strip: false, entries: {} }
  const entries: Record<string, string> = {}
  for (const e of st.entries) {
    const key = e.key.trim()
    if (key && e.value !== '') entries[key] = e.value
  }
  return { strip: true, entries }
}
