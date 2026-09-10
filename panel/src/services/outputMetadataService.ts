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

