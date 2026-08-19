// ── 元数据筛选服务 ──
// 从 IndexedDB 或缓存中提取筛选选项（模型列表、LoRA 列表等）

import type { OutputMetadata } from '../types/outputs'
import { extractLorasFromWorkflow, parseComfyUIWorkflow, PARSER_VERSION } from './outputMetadata'
import { outputsDb } from '../db/outputsDb'

export interface FilterOptions {
  models: string[]
  loras: string[]
  seedMin: number
  seedMax: number
  stepsMin: number
  stepsMax: number
}

/**
 * 从 metadataCache 中提取所有筛选选项
 */
export function extractFilterOptions(metadataCache: Map<string, OutputMetadata>): FilterOptions {
  const modelSet = new Set<string>()
  const loraSet = new Set<string>()
  let seedMin = Infinity, seedMax = -Infinity
  let stepsMin = Infinity, stepsMax = -Infinity

  for (const meta of metadataCache.values()) {
    if (meta.model) modelSet.add(meta.model)

    if (meta.workflowJson) {
      const loras = extractLorasFromWorkflow(meta.workflowJson, meta.rawMetadata)
      for (const lora of loras) loraSet.add(lora)
    }

    const seed = parseInt(meta.seed)
    if (!isNaN(seed)) {
      if (seed < seedMin) seedMin = seed
      if (seed > seedMax) seedMax = seed
    }

    const steps = parseInt(meta.steps)
    if (!isNaN(steps)) {
      if (steps < stepsMin) stepsMin = steps
      if (steps > stepsMax) stepsMax = steps
    }
  }

  return {
    models: Array.from(modelSet).sort(),
    loras: Array.from(loraSet).sort(),
    seedMin: seedMin === Infinity ? 0 : seedMin,
    seedMax: seedMax === -Infinity ? 0 : seedMax,
    stepsMin: stepsMin === Infinity ? 0 : stepsMin,
    stepsMax: stepsMax === -Infinity ? 0 : stepsMax,
  }
}

/**
 * 对已有元数据重新解析 prompt（widgets_values 等）
 * 在扫描逻辑更新后调用，补全旧数据中缺失的 prompt
 */
// 同一 PARSER_VERSION 只补全一次：避免每次进入 Outputs 都全量 JSON.parse 所有 workflow（大目录下是主要卡顿源）
const BACKFILL_KEY = 'anima_backfill_v'

export async function backfillPrompts(cache: Map<string, OutputMetadata>): Promise<number> {
  try {
    if (localStorage.getItem(BACKFILL_KEY) === String(PARSER_VERSION)) return 0
  } catch { /* localStorage 不可用时照常执行 */ }
  let fixed = 0
  for (const [id, meta] of cache) {
    if (!meta.workflowJson) continue
    try {
      const workflow = JSON.parse(meta.workflowJson)
      const parsed = parseComfyUIWorkflow(workflow)
      // 只填空、不覆盖非空（2026-08-20）：新解析可能比 workflow 存的值更新更准（如 API 链路取回完整正片），
      // 避免 backfill 用 UI 旧值把已正确的 prompt 覆盖回去。
      const patch: { prompt?: string; negativePrompt?: string } = {}
      if (parsed.prompt && !meta.prompt) patch.prompt = parsed.prompt
      if (parsed.negativePrompt && !meta.negativePrompt) patch.negativePrompt = parsed.negativePrompt
      if (Object.keys(patch).length) {
        await outputsDb.metadata.update(id, patch)
        cache.set(id, { ...meta, ...patch })
        fixed++
      }
    } catch { /* 跳过解析失败 */ }
  }
  if (fixed > 0) console.log(`[backfill] 补全 ${fixed} 条 prompt`)
  // 记录版本：同版本解析逻辑不再重跑（新版本号由 PARSER_VERSION 升级驱动）
  try { localStorage.setItem(BACKFILL_KEY, String(PARSER_VERSION)) } catch { /* 忽略 */ }
  return fixed
}
