// ── 元数据筛选服务 ──
// 从 IndexedDB 或缓存中提取筛选选项（模型列表、LoRA 列表等）

import type { OutputMetadata } from '../types/outputs'
import { extractLorasFromWorkflow, parseComfyUIWorkflow } from './outputMetadata'
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
export async function backfillPrompts(cache: Map<string, OutputMetadata>): Promise<number> {
  let fixed = 0
  for (const [id, meta] of cache) {
    if (!meta.workflowJson) continue
    try {
      const workflow = JSON.parse(meta.workflowJson)
      const parsed = parseComfyUIWorkflow(workflow)
      if (parsed.prompt && parsed.prompt !== meta.prompt) {
        await outputsDb.metadata.update(id, { prompt: parsed.prompt, negativePrompt: parsed.negativePrompt || '' })
        cache.set(id, { ...meta, prompt: parsed.prompt, negativePrompt: parsed.negativePrompt || '' })
        fixed++
        console.log(`[backfill] 图片 ${id}: 原prompt="${meta.prompt?.slice(0,30)}" → 新prompt="${parsed.prompt?.slice(0,30)}"`)
      }
    } catch { /* 跳过解析失败 */ }
  }
  if (fixed > 0) console.log(`[backfill] 补全 ${fixed} 条 prompt`)
  else {
    // 输出一条有效数据的结构用于调试
    for (const [id, meta] of cache) {
      if (meta.workflowJson) {
        try {
          const wf = JSON.parse(meta.workflowJson)
          const allNodes = wf.nodes || (Array.isArray(wf) ? wf : Object.entries(wf).filter(([k, v]) => typeof v === 'object' && v !== null).map(([k, v]) => Object.assign({ id: k }, v)))
          const textNodes = allNodes.filter((n: any) => n?.class_type === 'CLIPTextEncode' || n?.type === 'CLIPTextEncode')
          console.log(`[backfill] 找到 ${textNodes.length} 个 CLIPTextEncode 节点:`)
          textNodes.forEach((n: any) => {
            console.log(`  节点 ${n.id || n.title || '?'}: inputs=`, JSON.stringify(n.inputs || {}).slice(0, 200))
            console.log(`  widgets_values=`, n.widgets_values?.slice(0, 2))
          })
          // 找 KSampler 的 positive/negative 引用
          const samplers = allNodes.filter((n: any) => n?.class_type?.includes('KSampler') || n?.type?.includes('KSampler'))
          samplers.forEach((s: any) => {
            console.log(`  KSampler ${s.id}: positive=`, s.inputs?.positive, 'negative=', s.inputs?.negative)
          })
        } catch {}
        break
      }
    }
  }
  return fixed
}
