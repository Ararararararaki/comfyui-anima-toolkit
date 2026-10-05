// ── 运行期提示词记录（wire schema v1）的纯解码器 ──
//
// 契约来源：`.scratch/harness-ui-20261004/prompt-consumer/python-reference/prompt_record.py`
// 的 `decode_record` / `to_public`，以及同目录 `fixtures.json` 公布的共享期望值。
// 本文件只做解码，不生成记录、不观察运行期、不猜文本：
//   · 只读文档化的键，未知键**不被遍历**（伪造的深嵌套字段不能拖慢解码器）；
//   · exact 导出已核验正文；dependency 是本次执行的保存分支，始终 partial；
//     两者都只做**精确重复**折叠；unknown/ambiguous 不导出正文。
//   · 越界（记录 256KiB / 128 阶段 / 32KiB 文本 / 64 警告）或未来版本一律返回 null，
//     由调用方保留自己的静态结果并另加警告。
//
// 注意：本模块不改变 ComfyUI 后端的权威性 —— 后端仍是提示词真源，这里只是
// 把图片里已经写好的运行期记录读出来。

import type { PromptStage, PromptStatus } from '../types/outputs'

/** 记录写入方使用的 PNG 文本块键名 */
export const PROMPT_PROVENANCE_KEY = 'tk_prompt_provenance'

export const SCHEMA_VERSION = 1
const MAX_RECORD_BYTES = 256 * 1024
const MAX_STAGES = 128
const MAX_TEXT_BYTES = 32 * 1024
const MAX_WARNINGS = 64

type Association = 'exact' | 'dependency' | 'ambiguous' | 'unknown'
type WireStage = { nodeId: string; label: string; positive: string[]; negative: string[]; status: PromptStatus }
type WireRecord = { schemaVersion: number; outputNodeId: string; imageAssociation: Association; stages: WireStage[]; warnings: string[] }

export interface PromptRecordPublic {
  prompt: string
  negativePrompt: string
  promptStages: PromptStage[]
  promptStatus: PromptStatus
  promptWarnings: string[]
}

const utf8 = new TextEncoder()

/** UTF-8 字节长度（解码器的一切上限都按字节，不按字符） */
function utf8Len(text: string): number {
  return utf8.encode(text).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 状态折叠：矛盾优先于不完整；`missing` 只在完全不可读时发布 */
function worst(states: PromptStatus[]): PromptStatus {
  if (!states.length) return 'complete'
  if (states.includes('ambiguous')) return 'ambiguous'
  if (states.includes('partial')) return 'partial'
  if (states.every(state => state === 'missing')) return 'missing'
  if (states.includes('missing')) return 'partial'
  return 'complete'
}

/** 追加一条警告（去重 + 封顶）；返回新数组，不改动传入的列表 */
function appendWarning(existing: readonly string[], message: string): string[] {
  if (!message || existing.includes(message)) return [...existing]
  const items = [...existing, message]
  if (items.length <= MAX_WARNINGS) return items
  const extra = items.length - (MAX_WARNINGS - 1)
  return [...items.slice(0, MAX_WARNINGS - 1), `${extra} additional warnings suppressed`]
}

/** 文档化的字符串数组；非字符串、超长文本或超预算一律拒绝整条记录 */
function texts(value: unknown, budget: number): { items: string[]; size: number } | null {
  if (value === undefined || value === null) return { items: [], size: 0 }
  if (!Array.isArray(value)) return null
  const items: string[] = []
  let size = 0
  for (const item of value) {
    if (typeof item !== 'string') return null
    const length = utf8Len(item)
    if (length > MAX_TEXT_BYTES) return null
    size += length + 3
    if (size > budget) return null
    items.push(item)
  }
  return { items, size }
}

function stage(value: unknown, budget: number): { stage: WireStage; size: number } | null {
  if (!isRecord(value)) return null
  const nodeId = value.nodeId === undefined ? '' : value.nodeId
  const label = value.label === undefined ? 'Sampling' : value.label
  if (typeof nodeId !== 'string' || utf8Len(nodeId) > MAX_TEXT_BYTES) return null
  if (typeof label !== 'string' || utf8Len(label) > MAX_TEXT_BYTES) return null
  const status = value.status
  if (status !== 'complete' && status !== 'partial' && status !== 'ambiguous' && status !== 'missing') return null
  let size = utf8Len(nodeId) + utf8Len(label) + 24
  if (size > budget) return null
  const positive = texts(value.positive, budget - size)
  if (!positive) return null
  const negative = texts(value.negative, budget - size - positive.size)
  if (!negative) return null
  size += positive.size + negative.size
  return { stage: { nodeId, label, positive: positive.items, negative: negative.items, status }, size }
}

/** 只读文档化的键；任何类型不符、越界或未来版本都返回 null */
function normalize(value: unknown): WireRecord | null {
  if (!isRecord(value)) return null

  const version = value.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version)) return null
  if (version !== SCHEMA_VERSION) return null // 未来/未知 schema 绝不当作完整记录

  const outputNodeId = value.outputNodeId === undefined ? '' : value.outputNodeId
  if (typeof outputNodeId !== 'string' || utf8Len(outputNodeId) > MAX_TEXT_BYTES) return null
  let size = utf8Len(outputNodeId) + 8

  const association = value.imageAssociation
  if (association !== 'exact' && association !== 'dependency' && association !== 'ambiguous' && association !== 'unknown') return null
  size += association.length + 8

  const stagesIn = value.stages
  if (!Array.isArray(stagesIn)) return null
  const stages: WireStage[] = []
  for (const item of stagesIn) {
    if (stages.length >= MAX_STAGES) return null
    const validated = stage(item, MAX_RECORD_BYTES - size)
    if (!validated) return null
    size += validated.size
    stages.push(validated.stage)
  }

  const warningsIn = value.warnings === undefined || value.warnings === null ? [] : value.warnings
  if (!Array.isArray(warningsIn)) return null
  const warnings: string[] = []
  for (const item of warningsIn) {
    if (warnings.length >= MAX_WARNINGS) return null
    if (typeof item !== 'string' || utf8Len(item) > MAX_TEXT_BYTES) return null
    size += utf8Len(item) + 3
    if (size > MAX_RECORD_BYTES) return null
    warnings.push(item)
  }

  return { schemaVersion: SCHEMA_VERSION, outputNodeId, imageAssociation: association, stages, warnings }
}

/**
 * 公开字段。
 *
 * 所有权决定发布的状态：`exact` 导出文本；`dependency` 始终 partial。`ambiguous` 发布
 * `ambiguous`、`unknown` 发布 `missing` —— 阶段自己的标志无法补上"这张图属于这段
 * 提示词"这个缺失的前提。`exact` 且部分证据不成立时，**已验证的正面片段仍以
 * `partial` 保持可复制**（消费端在 ambiguous/missing 上禁用复制，把已验证文本
 * 藏进 ambiguous 是更差的答案），原因随警告一起发布。
 */
function publicView(record: WireRecord): PromptRecordPublic {
  const exportable = record.imageAssociation === 'exact' || record.imageAssociation === 'dependency'
  const stages: PromptStage[] = []
  const allPositive: string[] = []
  const allNegative: string[] = []
  const seenPositive = new Set<string>()
  const seenNegative = new Set<string>()
  const states: PromptStatus[] = []

  for (const item of record.stages) {
    const positive = exportable ? item.positive : []
    const negative = exportable ? item.negative : []
    stages.push({ nodeId: item.nodeId, label: item.label, prompt: positive.join('\n'), negativePrompt: negative.join('\n') })
    for (const text of positive) if (!seenPositive.has(text)) { seenPositive.add(text); allPositive.push(text) }
    for (const text of negative) if (!seenNegative.has(text)) { seenNegative.add(text); allNegative.push(text) }
    states.push(item.status)
  }

  let warnings = [...record.warnings]
  const raw = states.length ? worst(states) : 'missing'
  let status: PromptStatus
  if (record.imageAssociation === 'ambiguous') status = 'ambiguous'
  else if (record.imageAssociation === 'unknown') status = 'missing'
  else if (record.imageAssociation === 'dependency') {
    status = allPositive.length ? 'partial' : 'missing'
    warnings = appendWarning(warnings, '已恢复本次执行中保存分支的实际采样正文；图像转换的精确归属未完整核验')
  }
  else if (raw === 'complete') status = 'complete'
  else if (allPositive.length) {
    status = 'partial'
    if (raw === 'ambiguous') {
      const ambiguous = states.filter(state => state === 'ambiguous').length
      warnings = appendWarning(warnings, `public status partial: verified text stays copyable while ${ambiguous} stage(s) remain ambiguous`)
    }
  } else if (raw === 'ambiguous') status = 'ambiguous'
  else status = 'missing'

  return { prompt: allPositive.join('\n'), negativePrompt: allNegative.join('\n'), promptStages: stages, promptStatus: status, promptWarnings: warnings }
}

/**
 * 解码一条记录，或返回 null。
 *
 * 接受已解析的对象或 JSON 文本；不合法、越界、格式错误或未来版本一律 null，
 * 绝不抛异常、也绝不改写调用方传入的对象。
 *
 * 失败关闭：**任何**取属性动作（包括调用方自定义的 getter/Proxy 陷阱）抛错都
 * 视为这条记录不可读，返回 null —— 调用方保留自己的静态结果并另加警告。
 */
export function decodePromptRecord(payload: unknown): PromptRecordPublic | null {
  try {
    let parsed: unknown = payload
    if (typeof payload === 'string') {
      // UTF-8 字节数永远不会小于字符数，但可以远大于它（如 emoji 占 4 字节）：
      // 必须先按**字节**设上限，否则一条 70k 字符的 JSON 会带着 280KiB 正文进 JSON.parse。
      if (utf8Len(payload) > MAX_RECORD_BYTES) return null
      parsed = JSON.parse(payload)
    } else if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return null
    }
    const record = normalize(parsed)
    return record ? publicView(record) : null
  } catch {
    return null
  }
}

/** PNG 文本块里的记录值 → 公开字段；缺失或不可用返回 null（每键只读一次） */
export function promptRecordFromRaw(raw: Record<string, string> | undefined): PromptRecordPublic | null {
  try {
    const value = raw?.[PROMPT_PROVENANCE_KEY]
    if (typeof value !== 'string' || !value) return null
    return decodePromptRecord(value)
  } catch {
    return null
  }
}

/** 记录被拒绝时的警告：只说明"没采用"，绝不含糊地声称记录已完整采用 */
export function promptRecordRejectedWarning(value: unknown): string {
  let size: string
  try {
    size = typeof value === 'string' ? `${utf8Len(value)} bytes` : typeof value
  } catch {
    size = 'unreadable'
  }
  return `prompt provenance record present (${size}) but was not accepted; prompt fields keep the parsed workflow result and the prompt status is downgraded`
}

/** 记录存在但被拒绝：`complete` 不能继续发布（正文不再是完整证据），可靠文本保留 */
export function downgradeRejectedRecord(status: PromptStatus | undefined): PromptStatus | undefined {
  return status === 'complete' ? 'partial' : status
}

/**
 * 有效记录覆盖提示词字段；模型/种子/LoRA/raw/workflow 等字段原样保留。
 * 无可用记录时返回原对象，调用方继续用既有静态结果。
 */
export function applyPromptRecord<T extends { prompt: string; negativePrompt: string }>(
  meta: T,
  record: PromptRecordPublic | null,
): T {
  if (!record) return meta
  return {
    ...meta,
    prompt: record.prompt,
    negativePrompt: record.negativePrompt,
    promptStages: record.promptStages,
    promptStatus: record.promptStatus,
    promptWarnings: record.promptWarnings,
  } as T
}
