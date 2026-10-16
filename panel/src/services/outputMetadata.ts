// Shared saved-image parser: container reads, generator fields, graph ownership.
import { parseGraphPrompt, graphIdentityPrompt, outputNodeForFilename } from './outputGraph'
import { parseGenerationDetails } from './outputGeneration'
import { parseMetadataJSON } from './metadataJSON'
import { normalizeGenerationRaw, parseGenerationFields } from './generationFormats'
import { readImageMetadataContainer, type ImageMetadataContainer } from './imageMetadataContainer'
import { PROMPT_PROVENANCE_KEY, applyPromptRecord, downgradeRejectedRecord, promptRecordFromRaw, promptRecordRejectedWarning } from './outputPromptRecord'
import type { MetadataState, OutputGenerationDetails, PromptStage, PromptStatus } from '../types/outputs'

export interface ParsedMetadata extends Partial<OutputGenerationDetails> {
  model: string; seed: string; steps: string; cfg: string; sampler: string
  scheduler?: string; denoise?: string; noiseSeed?: string
  vae: string; clipSkip: number; prompt: string; negativePrompt: string
  workflowJson: string; raw: Record<string, string>
  parserVersion?: number; hasWorkflow?: boolean
  metadataState?: MetadataState; metadataFormat?: string; metadataWarnings?: string[]
  promptStages?: PromptStage[]; promptStatus?: PromptStatus; promptWarnings?: string[]
  identityPrompt?: string
}

// v12: also recover Easy-Use imageSave's actual saved sampling branch.
export const PARSER_VERSION = 13
export const safeParseJSON = (text: string): any | null => parseMetadataJSON(text, true)

export function isComfyGraph(value: any): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value.nodes)) return value.nodes.some((node: any) => typeof node?.type === 'string')
  return (Array.isArray(value) ? value : Object.values(value)).some((node: any) => typeof node?.class_type === 'string')
}

export function parseComfyUIWorkflow(workflow: any, outputNodeId?: string | null): Partial<ParsedMetadata> {
  if (!isComfyGraph(workflow)) return {}
  const { samplerInputs: _inputs, ...prompts } = parseGraphPrompt(workflow, outputNodeId)
  const details = parseGenerationDetails(workflow, outputNodeId)
  const result: Partial<ParsedMetadata> = { ...prompts, ...details, metadataSource: 'comfyui',
    raw: { workflow: JSON.stringify(workflow) }, parserVersion: PARSER_VERSION,
    model: details.checkpoints.join(' / '), vae: details.vaes.join(' / '), clipSkip: 0, sampler: '' }
  if (details.generationScope === 'output' && details.generationStages.length) {
    const stage = details.generationStages[details.generationStages.length - 1]
    // Preserve the legacy ComfyUI summary contract; actual sampler names are
    // available per generation stage, including custom/advanced samplers.
    for (const key of ['seed', 'steps', 'cfg', 'scheduler', 'denoise', 'noiseSeed'] as const) result[key] = stage[key] || ''
  }
  return result
}

export async function decompressZlibAsync(data: Uint8Array): Promise<string> {
  try {
    // zTXt 使用 zlib 格式（deflate + 2 字节头部 + 4 字节校验）
    // 跳过头部 2 字节（CMF + FLG）和尾部 4 字节（Adler-32）
    const deflateData = data.slice(2, data.length - 4)
    const ds = new DecompressionStream('deflate-raw')
    const writer = ds.writable.getWriter()
    writer.write(deflateData).catch(() => { /* 取消路径下写入 promise 可能 reject，仅噪音（review nit） */ })
    writer.close().catch(() => { /* 解压流取消时关闭 promise 可能 reject，仅噪音（security low 修复） */ })
    const reader = ds.readable.getReader()
    const chunks: Uint8Array[] = []
    const MAX_OUTPUT = 2 * 1024 * 1024 // 2MB 上限，防解压炸弹 DoS（security HIGH 修复）
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.length
        if (total > MAX_OUTPUT) {
          // 超限：丢弃数据，取消解压流，返回空串（由调用方 fallback 处理）
          await reader.cancel().catch(() => { /* ignore */ })
          return ''
        }
        chunks.push(value)
      }
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { result.set(c, offset); offset += c.length }
    return new TextDecoder().decode(result)
  } catch {
    try {
      return new TextDecoder().decode(data)
    } catch {
      return ''
    }
  }
}

// LoRA 提取结果缓存：同一 workflowJson 只解析一次，避免每次渲染/筛选重复 JSON.parse + 正则（主要卡顿源）
const _loraExtractCache = new Map<string, string[]>()
const _LORA_CACHE_MAX = 2000

/** 从 ComfyUI workflow JSON 中提取所有 LoRA 名称 */
export function extractLorasFromWorkflow(
  workflowJson: string,
  rawMetadata?: Record<string, string>,
): string[] {
  if (!workflowJson) return []
  const _loraKey = workflowJson.length + ':' + workflowJson.slice(0, 256) + ':' + (rawMetadata?.prompt ? rawMetadata.prompt.length : 0)
  const _loraHit = _loraExtractCache.get(_loraKey)
  if (_loraHit) return _loraHit

  const LORA_TAG_RE = /<lora:([^:>]+):[^:>]*(?::[^:>]*)?>/gi
  const loras: string[] = []
  const seen = new Set<string>()

  function add(name: string) {
    if (name && !seen.has(name)) { seen.add(name); loras.push(name) }
  }

  // 解析 <lora:name:...> 标签
  function tagsOf(str: string): string[] {
    const out: string[] = []
    if (typeof str !== 'string') return out
    let m: RegExpExecArray | null
    while ((m = LORA_TAG_RE.exec(str)) !== null) out.push(m[1])
    return out
  }

  // 解析 API 数组链接 [srcId, slot] → 源节点的 lora 名
  function resolveName(v: any, nodeMap: Map<any, any>): string {
    if (typeof v === 'string') return v
    if (Array.isArray(v) && v.length) {
      const src = v[0]
      const srcNode = nodeMap.get(src) || nodeMap.get(Number(src))
      if (srcNode) {
        const iv = srcNode.inputs?.lora_name
        if (iv) return resolveName(iv, nodeMap)
        if (Array.isArray(srcNode.widgets_values)) {
          for (const w of srcNode.widgets_values) if (typeof w === 'string' && /\.(safetensors|pt|bin)$/i.test(w)) return w
        }
      }
    }
    return ''
  }

  function extractWorkflow(wf: any) {
    const iterNodes: any[] = wf?.nodes || (Array.isArray(wf) ? wf : typeof wf === 'object' ? Object.entries(wf).map(([k, v]) => ({ id: k, ...(v as any) })) : [])
    const nodeMap = new Map<any, any>()
    for (const n of iterNodes) {
      if (n && n.id !== undefined) { nodeMap.set(String(n.id), n); nodeMap.set(Number(n.id), n) }
    }
    for (const node of iterNodes) {
      if (!node || typeof node !== 'object') continue
      const ct = node.class_type || node.type || ''
      const isLoraNode = /Lora/i.test(ct)
      const inputs = node.inputs || {}
      const cands: string[] = []

      if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
        if (inputs.lora_name) cands.push(resolveName(inputs.lora_name, nodeMap))
        if (typeof inputs.text === 'string') cands.push(...tagsOf(inputs.text))
        if (inputs.loras && typeof inputs.loras === 'object') {
          const arr = Array.isArray(inputs.loras) ? inputs.loras : (inputs.loras as any).__value__
          if (Array.isArray(arr)) {
            for (const e of arr) if (e && typeof e === 'object') cands.push(e.name || e.lora_name || '')
          } else {
            for (const k of Object.keys(inputs.loras)) {
              const e = (inputs.loras as any)[k]
              if (e && typeof e === 'object') cands.push(e.name || e.lora_name || '')
            }
          }
        }
      }

      // UI format：widgets_values 里的 lora 文件名（仅 Lora 节点），及数组 inputs
      if (isLoraNode && Array.isArray(node.widgets_values)) {
        for (const w of node.widgets_values) {
          if (typeof w === 'string' && /\.(safetensors|pt|bin)$/i.test(w)) cands.push(w)
        }
      }
      // 通用：widgets_values 里可能含 <lora:name:...> 标签文本（LoraManager 等把 lora 标签放在 widget 中）
      if (Array.isArray(node.widgets_values)) {
        for (const w of node.widgets_values) {
          if (typeof w === 'string') cands.push(...tagsOf(w))
        }
      }
      if (Array.isArray(inputs)) {
        for (const entry of inputs) {
          if (!entry || typeof entry !== 'object') continue
          if (entry.name === 'lora_name' && typeof entry.value === 'string') cands.push(entry.value)
          if (entry.name === 'text' && typeof entry.value === 'string') cands.push(...tagsOf(entry.value))
        }
      }

      for (const c of cands) {
        const name = String(c || '').replace(/\.(safetensors|pt|bin)$/i, '').trim()
        if (name) add(name)
      }
    }
  }

  try { extractWorkflow(safeParseJSON(workflowJson)) } catch { /* skip */ }

  // Fallback: try raw prompt metadata (for old cached scans where workflowJson is UI format)
  if (loras.length === 0 && rawMetadata?.prompt && rawMetadata.prompt !== workflowJson) {
    try { extractWorkflow(safeParseJSON(rawMetadata.prompt)) } catch { /* skip */ }
  }

  // 写入缓存（LRU 简单淘汰）
  if (_loraExtractCache.size >= _LORA_CACHE_MAX) {
    const firstKey = _loraExtractCache.keys().next().value
    if (firstKey !== undefined) _loraExtractCache.delete(firstKey)
  }
  _loraExtractCache.set(_loraKey, loras)
  return loras
}

/** Compact search names preserve the existing no-extension identity contract. */
export function outputLoraNames(meta: Pick<ParsedMetadata, 'workflowJson' | 'raw' | 'loraDetails'>): string[] {
  // An explicitly empty output-scoped result is authoritative. Falling back to
  // the whole graph could leak another branch after a rejected output ID.
  const names = meta.loraDetails ? meta.loraDetails.map(item => item.name) : extractLorasFromWorkflow(meta.workflowJson, meta.raw)
  return [...new Set(names.map(name => name.replace(/\.(safetensors|pt|bin)$/i, '').trim()).filter(Boolean))]
}

/** Copy only known saved strengths. Preserve independent model/clip values. */
export function loraTagsFromDetails(details: OutputGenerationDetails['loraDetails'] | undefined): string[] {
  return (details || []).flatMap(item => {
    if (item.strengthModel === null || item.strengthClip === null) return []
    const name = item.name.replace(/\.(safetensors|pt|bin)$/i, '')
    return name ? [`<lora:${name}:${item.strengthModel}:${item.strengthClip}>`] : []
  })
}

export function extractLoraTagsFromWorkflow(workflowJson: string, rawMetadata?: Record<string, string>): string[] {
  const graph = safeParseJSON(rawMetadata?.prompt || '') || safeParseJSON(workflowJson)
  return loraTagsFromDetails(parseGenerationDetails(graph).loraDetails)
}

export function parseOutputMetadataRaw(container: ImageMetadataContainer, sourceFilename = ''): ParsedMetadata {
  const raw = normalizeGenerationRaw(container.raw)
  const record = promptRecordFromRaw(raw)
  const wire = record ? safeParseJSON(raw[PROMPT_PROVENANCE_KEY]) : null
  const recordedOutputId = wire && ['exact', 'dependency'].includes(wire.imageAssociation) ? wire.outputNodeId || null : null
  const api = safeParseJSON(raw.prompt || ''), ui = safeParseJSON(raw.workflow || '')
  const graph = isComfyGraph(api) ? api : isComfyGraph(ui) ? ui : null
  let fields: Partial<ParsedMetadata> = graph ? parseComfyUIWorkflow(graph, recordedOutputId) : parseGenerationFields(raw) || {}
  const filenameId = graph && !recordedOutputId && (fields.promptStatus === 'ambiguous' || record && !record.prompt) ? outputNodeForFilename(graph, sourceFilename) : null
  if (filenameId) fields = parseComfyUIWorkflow(graph, filenameId)
  const staticPrompt = fields.prompt
  if (filenameId) {
    fields.promptWarnings = [...(fields.promptWarnings || []), '按文件名与唯一保存前缀匹配分支；静态文本不代表已核验的运行期全文']
    if (fields.promptStatus === 'complete') fields.promptStatus = 'partial'
  }
  if (wire && ['unknown', 'ambiguous'].includes(wire.imageAssociation) && graph) {
    fields.generationScope = 'recorded'; fields.generationOutputNodeId = null
    fields.generationStatus = wire.imageAssociation === 'ambiguous' ? 'ambiguous' : 'partial'
    fields.generationWarnings = [...new Set([...(fields.generationWarnings || []), '图片归属未核验，以下仅为保存工作流的记录配置'])]
    fields.loraDetails = fields.loraDetails?.map(item => ({ ...item, active: null }))
    for (const key of ['seed', 'steps', 'cfg', 'sampler', 'scheduler', 'denoise', 'noiseSeed'] as const) fields[key] = ''
  }
  const result: ParsedMetadata = { model: '', seed: '', steps: '', cfg: '', sampler: '', scheduler: '', denoise: '', noiseSeed: '', vae: '', clipSkip: 0,
    prompt: '', negativePrompt: '', promptStages: [], promptStatus: 'missing', promptWarnings: [],
    checkpoints: [], textEncoders: [], vaes: [], loraDetails: [], generationStages: [],
    generationStatus: 'missing', generationWarnings: [], generationScope: 'recorded', generationOutputNodeId: null,
    ...fields, workflowJson: isComfyGraph(ui) ? raw.workflow : isComfyGraph(api) ? raw.prompt : '',
    hasWorkflow: !!graph, raw: container.raw, parserVersion: PARSER_VERSION,
    metadataState: container.status, metadataFormat: container.format, metadataWarnings: [...container.warnings] }
  const recordText = raw[PROMPT_PROVENANCE_KEY]
  // Classification evidence only. It never fills the copyable prompt or claims
  // which output sampled this file; authoritative runtime records take precedence.
  if (!recordText && graph && !result.prompt && result.promptStatus === 'ambiguous') result.identityPrompt = graphIdentityPrompt(graph)
  if (recordText && !record) {
    result.promptStatus = downgradeRejectedRecord(result.promptStatus)
    const warning = promptRecordRejectedWarning(recordText)
    if (warning) result.promptWarnings = [warning, ...(result.promptWarnings || [])]
  }
  const applied = applyPromptRecord(result, record)
  if (filenameId && record && !applied.prompt && staticPrompt) applied.identityPrompt = staticPrompt
  return applied
}

/** Primary API: bounded Blob reads; complete absence is an explicit result. */
export async function parseOutputMetadataBlob(blob: Blob, _extension?: string, signal?: AbortSignal, sourceFilename = ''): Promise<ParsedMetadata> {
  const name = sourceFilename || ('name' in blob && typeof blob.name === 'string' ? blob.name : '')
  return parseOutputMetadataRaw(await readImageMetadataContainer(blob, signal), name)
}

/** Compatibility API for existing ArrayBuffer callers; unsupported/empty stays null. */
export async function parseOutputMetadata(buf: ArrayBuffer, extension: string): Promise<ParsedMetadata | null> {
  const result = await parseOutputMetadataBlob(new Blob([buf]), extension)
  const expected = extension.toLowerCase().replace(/^jpeg$/, 'jpg')
  const actual = result.metadataFormat === 'jpeg' ? 'jpg' : result.metadataFormat
  if (expected !== actual || result.metadataState === 'unsupported' || !Object.keys(result.raw).length) return null
  return result
}
