// ── 元数据解析服务 ──
// 支持 ComfyUI、A1111/Forge、Fooocus 等格式

import { parseGraphPrompt } from './outputGraph'
import { PROMPT_PROVENANCE_KEY, applyPromptRecord, downgradeRejectedRecord, promptRecordFromRaw, promptRecordRejectedWarning } from './outputPromptRecord'
import type { PromptStage, PromptStatus } from '../types/outputs'

export interface ParsedMetadata {
  model: string
  seed: string
  steps: string
  cfg: string
  sampler: string
  scheduler?: string
  denoise?: string
  noiseSeed?: string
  vae: string
  clipSkip: number
  prompt: string
  negativePrompt: string
  workflowJson: string
  raw: Record<string, string>
  parserVersion?: number
  promptStages?: PromptStage[]
  promptStatus?: PromptStatus
  promptWarnings?: string[]
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

/**
 * 解析器版本：解析逻辑变更时递增，Outputs 借此自动失效旧的元数据缓存并重新解析。
 *
 * 8（2026-10-04）：拒绝**已证实的显示缓存型节点**的保存值
 *   （WD14Tagger 的 tags、easy showAnything 的 text）。这些字段是前端上次预览
 *   的显示状态、不是本次执行文本（0423 实测不含用户实际角色词）。
 *   旧缓存里已把这些值当正文存过 → 必须换代，否则用户会继续看到旧显示词。
 *   判据只按 class 名 + 执行语义，不按字段名或字符串内容。
 *
 * 9（2026-10-04）：PNG 文本块 `tk_prompt_provenance` 的运行期记录接入。
 *   记录有效 → 只覆盖提示词字段（prompt/negativePrompt/promptStages/
 *   promptStatus/promptWarnings），模型、种子、LoRA、raw、workflow 一律保留；
 *   记录缺失 → 既有静态解析结果不变；记录不合法/未来版本 → 保留静态结果并
 *   追加一条明确警告，不谎称记录已完整采用。
 *
 * 注意（诚实说明）：**ComfyUI 后端仍是提示词真源**。本版本只把图片里已写好的
 *   运行期记录读出来，后端与 Python 消费端的接入是**另一条独立工作线**，不在
 *   本文件内完成。此前 PNG 未保存运行期正文的历史图片，仍然只能给静态结果，
 *   不虚构缺失的提示词。
 *
 * v10 支持保存分支的运行期采样记录（dependency 明确为 partial）。后端 v5
 * 同时支持经图片路径、时间与 API 输入图核验的执行历史补救。旧缓存按需换代。
 */
export const PARSER_VERSION = 10

/**
 * 安全 JSON 解析：ComfyUI 的 json.dumps 会把 NaN/Infinity 原样写入（如 is_changed:[NaN]），
 * 这些不是合法 JSON，导致 JSON.parse 抛异常。先原样尝试，失败则清洗 NaN/Infinity 后重试。
 */
export function safeParseJSON(str: string): any | null {
  try {
    return JSON.parse(str)
  } catch {
    try {
      return JSON.parse(str
        .replace(/:\s*NaN/g, ': null')
        .replace(/\[\s*NaN/g, '[null')
        .replace(/,\s*NaN/g, ', null')
        .replace(/:\s*Infinity/g, ': null')
        .replace(/:\s*-Infinity/g, ': null'))
    } catch {
      return null
    }
  }
}

export function parseComfyUIWorkflow(workflow: any): Partial<ParsedMetadata> {
  const result: Partial<ParsedMetadata> = { raw: { workflow: JSON.stringify(workflow) }, parserVersion: PARSER_VERSION }
  if (!workflow || typeof workflow !== 'object') return result
  const parsed = parseGraphPrompt(workflow)
  const { samplerInputs, ...prompts } = parsed
  Object.assign(result, prompts)
  const inputs = samplerInputs || {}
  for (const [source, target] of Object.entries({ seed: 'seed', noise_seed: 'noiseSeed', steps: 'steps', cfg: 'cfg', sampler_name: 'sampler', scheduler: 'scheduler', denoise: 'denoise' })) {
    if (inputs[source] !== undefined && !Array.isArray(inputs[source])) (result as any)[target] = String(inputs[source])
  }
  const nodes: any[] = workflow.nodes || (Array.isArray(workflow) ? workflow : Object.entries(workflow).map(([id, node]) => ({ id, ...(node as object) })))
  for (const node of nodes) {
    const type = String(node?.class_type || node?.type || '')
    const nodeInputs = node?.inputs && !Array.isArray(node.inputs) ? node.inputs : {}
    if (/CheckpointLoader|DiffusionModelLoader|UNETLoader/.test(type)) {
      const name = nodeInputs.ckpt_name || nodeInputs.unet_name || node.widgets_values?.find((value: unknown) => typeof value === 'string' && /\.(safetensors|ckpt|pt|bin)$/i.test(value))
      if (typeof name === 'string') result.model = name
    }
    if (/VAELoader/.test(type)) {
      const name = nodeInputs.vae_name || node.widgets_values?.[0]
      if (typeof name === 'string') result.vae = name
    }
  }
  return result
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

/** 从 workflow 提取 LoRA 标签 `<lora:name:weight>`（含权重，可直接粘贴到节点 lora_syntax） */
export function extractLoraTagsFromWorkflow(
  workflowJson: string,
  rawMetadata?: Record<string, string>,
): string[] {
  if (!workflowJson) return []

  const LORA_TAG_RE = /<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>/gi
  const tags: string[] = []
  const seen = new Set<string>()

  function addTag(name: string, weight: number) {
    const clean = String(name || '').replace(/\.(safetensors|pt|bin)$/i, '').trim()
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    const w = isNaN(weight) ? 0.8 : weight
    tags.push(`<lora:${clean}:${Number(w).toFixed(2)}>`)
  }

  function resolveName(v: any, nodeMap: Map<any, any>): string {
    if (typeof v === 'string') return v
    if (Array.isArray(v) && v.length) {
      const srcNode = nodeMap.get(v[0]) || nodeMap.get(Number(v[0]))
      if (srcNode) {
        if (srcNode.inputs?.lora_name) return resolveName(srcNode.inputs.lora_name, nodeMap)
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
      const inputs = node.inputs || {}
      if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
        if (inputs.lora_name) {
          const name = resolveName(inputs.lora_name, nodeMap)
          const w = typeof inputs.strength_model === 'number' ? inputs.strength_model : 0.8
          if (name) addTag(name, w)
        }
        if (typeof inputs.text === 'string') {
          let m: RegExpExecArray | null
          while ((m = LORA_TAG_RE.exec(inputs.text)) !== null) addTag(m[1], parseFloat(m[2]))
        }
        if (inputs.loras && typeof inputs.loras === 'object') {
          const arr = Array.isArray(inputs.loras) ? inputs.loras : (inputs.loras as any).__value__
          const list = Array.isArray(arr) ? arr : Object.values(inputs.loras)
          for (const e of list) {
            if (e && typeof e === 'object') {
              const name = e.name || e.lora_name || ''
              const w = parseFloat(e.strength ?? e.model_strength ?? 0.8)
              if (name) addTag(name, w)
            }
          }
        }
      }
      // UI format：Lora 节点 widgets_values（[lora_name, strength, ...]）
      if (/Lora/i.test(ct) && Array.isArray(node.widgets_values)) {
        const n0 = node.widgets_values[0]
        const numVals = node.widgets_values.filter((x: any) => typeof x === 'number')
        if (typeof n0 === 'string' && /\.(safetensors|pt|bin)$/i.test(n0)) addTag(n0, numVals[0] ?? 0.8)
      }
      // 通用：widgets_values 里可能含 <lora:name:weight> 标签（LoraManager 等把 lora 标签放在 widget 中）
      if (Array.isArray(node.widgets_values)) {
        for (const w of node.widgets_values) {
          if (typeof w !== 'string') continue
          let m: RegExpExecArray | null
          while ((m = LORA_TAG_RE.exec(w)) !== null) addTag(m[1], parseFloat(m[2]))
        }
      }
      if (Array.isArray(inputs)) {
        for (const entry of inputs) {
          if (!entry || typeof entry !== 'object') continue
          if (entry.name === 'lora_name' && typeof entry.value === 'string') addTag(entry.value, 0.8)
          if (entry.name === 'text' && typeof entry.value === 'string') {
            let m: RegExpExecArray | null
            while ((m = LORA_TAG_RE.exec(entry.value)) !== null) addTag(m[1], parseFloat(m[2]))
          }
        }
      }
    }
  }

  try { extractWorkflow(safeParseJSON(workflowJson)) } catch { /* skip */ }
  if (tags.length === 0 && rawMetadata?.prompt && rawMetadata.prompt !== workflowJson) {
    try { extractWorkflow(safeParseJSON(rawMetadata.prompt)) } catch { /* skip */ }
  }
  return tags
}

function parseA1111Parameters(params: string): Partial<ParsedMetadata> {
  const result: Partial<ParsedMetadata> = {
    raw: { parameters: params },
  }

  if (!params) return result

  const lines = params.split('\n')
  const posParts: string[] = []
  let inNeg = false
  const negParts: string[] = []

  for (const line of lines) {
    // 兼容部分旧工作流把 A1111 正面提示词写成「Prompt: ...」的格式。
    if (!inNeg && /^Prompt:/i.test(line)) {
      const positive = line.replace(/^Prompt:/i, '').trim()
      if (positive) posParts.push(positive)
      continue
    }

    // 负向提示词开始
    if (line.startsWith('Negative prompt:')) {
      inNeg = true
      const negText = line.replace('Negative prompt:', '').trim()
      if (negText) negParts.push(negText)
      continue
    }

    // 参数行
    if (/^Steps:|^Sampler:|^CFG scale:|^Seed:|^Model:|^Size:|^Model hash:|^Clip skip:/i.test(line)) {
      const [key, ...rest] = line.split(':')
      const value = rest.join(':').trim()
      const keyLower = key.toLowerCase().trim()

      if (keyLower === 'steps') result.steps = value
      else if (keyLower === 'sampler') result.sampler = value
      else if (keyLower === 'cfg scale') result.cfg = value
      else if (keyLower === 'seed') result.seed = value
      else if (keyLower === 'model') result.model = value
      else if (keyLower === 'clip skip') result.clipSkip = parseInt(value) || 0

      continue
    }

    // 提示词行
    if (inNeg) {
      negParts.push(line)
    } else {
      posParts.push(line)
    }
  }

  result.prompt = posParts.join('\n').trim()
  result.negativePrompt = negParts.join('\n').trim()

  return result
}

function parseFooocusParams(params: string): Partial<ParsedMetadata> {
  const result: Partial<ParsedMetadata> = {
    raw: { fooocus_params: params },
  }

  if (!params) return result

  // Fooocus 格式类似 A1111，但可能有额外字段
  const lines = params.split('\n')
  for (const line of lines) {
    if (line.startsWith('Prompt:')) {
      result.prompt = line.replace('Prompt:', '').trim()
    } else if (line.startsWith('Negative:')) {
      result.negativePrompt = line.replace('Negative:', '').trim()
    } else if (line.startsWith('Model:')) {
      result.model = line.replace('Model:', '').trim()
    } else if (line.startsWith('Seed:')) {
      result.seed = line.replace('Seed:', '').trim()
    } else if (line.startsWith('Steps:')) {
      result.steps = line.replace('Steps:', '').trim()
    } else if (line.startsWith('CFG:')) {
      result.cfg = line.replace('CFG:', '').trim()
    } else if (line.startsWith('Sampler:')) {
      result.sampler = line.replace('Sampler:', '').trim()
    } else if (line.startsWith('VAE:')) {
      result.vae = line.replace('VAE:', '').trim()
    }
  }

  return result
}

export async function parseOutputMetadata(
  buf: ArrayBuffer,
  extension: string
): Promise<ParsedMetadata | null> {
  const bytes = new Uint8Array(buf)
  const raw: Record<string, string> = {}

  // 只解析 PNG 文件的元数据
  if (extension !== 'png') {
    return null
  }

  // 检查 PNG 签名
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== pngSig[i]) return null
  }

  // 解析 PNG chunks
  const view = new DataView(buf)
  let offset = 8
  let workflowData = ''
  let promptData = ''

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) break
    const len = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    )

    const isText = type === 'tEXt' || type === 'zTXt' || type === 'iTXt'
    if (isText) {
      const dataStart = offset + 8
      const dataEnd = dataStart + len
      if (dataEnd > bytes.length) break

      let keyEnd = dataStart
      while (keyEnd < dataEnd && bytes[keyEnd] !== 0 && keyEnd - dataStart < 79) keyEnd++
      // key 按 PNG 规范 ≤79 字节截断，循环拼接避免超大 spread 抛 RangeError（security 修复）
      let key = ''
      for (let i = dataStart; i < keyEnd; i++) key += String.fromCharCode(bytes[i])

      // 结构不合法的块一律**跳过**，绝不把半截内容当成一个值写进 raw：
      // 那会让一个损坏的块冒充"记录存在但被拒绝"，从而误报并降级可信的静态结果。
      let val: string | null = null
      if (keyEnd >= dataEnd || keyEnd === dataStart || bytes[keyEnd] !== 0) {
        val = null // 键名没有终止符：块结构非法
      } else if (type === 'zTXt') {
        try {
          const compData = bytes.slice(keyEnd + 2, dataEnd)
          val = await decompressZlibAsync(compData)
        } catch {
          val = new TextDecoder().decode(bytes.slice(keyEnd + 1, dataEnd))
        }
      } else if (type === 'iTXt') {
        // iTXt 结构：keyword\0 压缩标志(1) 压缩方法(1) 语言标签\0 翻译关键字\0 文本。
        // 旧实现从 keyEnd+1 直接取文本，等于把这两个标志字节当成 JSON 的一部分
        // → 带 iTXt 的图（含运行期记录）会整块解析失败。这里按规范跳过头部字段。
        const p = keyEnd + 1
        const compressed = bytes[p] === 1
        let q = p + 2 // 压缩标志 + 压缩方法
        let ok = q <= dataEnd && (bytes[p] === 0 || bytes[p] === 1) && bytes[p + 1] === 0
        // 语言标签与翻译关键字各需一个 NUL 终止符；缺一个就说明块结构非法
        for (let field = 0; field < 2 && ok; field++) {
          while (q < dataEnd && bytes[q] !== 0) q++
          if (q >= dataEnd) ok = false
          else q += 1
        }
        if (!ok) {
          val = null
        } else if (compressed) {
          // 声称压缩却解不开：块已损坏，跳过而不是把原始字节当文本
          // （那是"猜内容"，会伪装成一条被拒绝的记录）。zTXt 保持既有回退行为不变。
          const inflated = await decompressZlibAsync(bytes.slice(q, dataEnd))
          val = inflated ? inflated : null
        } else {
          val = new TextDecoder().decode(bytes.slice(q, dataEnd))
        }
      } else {
        val = new TextDecoder().decode(bytes.slice(keyEnd + 1, dataEnd))
      }

      if (val === null) {
        offset += 12 + len
        continue
      }
      raw[key] = val

      // 分离存储 prompt（标准格式）和 workflow（UI 格式）
      if (key === 'prompt') {
        promptData = val
      } else if (key === 'workflow') {
        workflowData = val
      }
    }

    offset += 12 + len
  }

  // 提示词解析：prompt chunk（API，图实际执行的提示词）优先；workflow chunk（UI）兜底
  // 但返回的 workflowJson 用 workflow chunk（UI 格式）优先 —— ComfyUI 前端「导入工作流」只认 UI 格式，
  // API 格式粘贴会被忽略导致复制到"当前工作流"
  const parseSrc = (promptData && safeParseJSON(promptData)) ? promptData : workflowData

  // 运行期提示词记录（PNG 文本块，键名由写入方定义）：每键只读一次。
  // 有效记录只覆盖提示词字段；缺失（含空值）→ 静态结果不变；
  // 不合法/未来版本 → 保留可靠的静态文本与警告，并把 complete 降级为 partial
  // （记录存在却被拒绝时，静态正文已不是完整证据，不能继续自称完整）。
  const recordValue = raw[PROMPT_PROVENANCE_KEY]
  const promptRecord = promptRecordFromRaw(raw)
  const recordWarning = typeof recordValue === 'string' && recordValue && !promptRecord ? promptRecordRejectedWarning(recordValue) : null
  const recordWarnings = (base: readonly string[] | undefined): string[] => {
    const warnings = base ? [...base] : []
    if (recordWarning && !warnings.includes(recordWarning)) warnings.unshift(recordWarning)
    return warnings
  }
  const recordStatus = (status: PromptStatus | undefined): PromptStatus | undefined =>
    recordWarning ? downgradeRejectedRecord(status) : status

  // 尝试解析工作流
  if (parseSrc) {
    const workflow = safeParseJSON(parseSrc)
    if (workflow) {
      const parsed = parseComfyUIWorkflow(workflow)
      const workflowJson = workflowData || promptData || ''
      // API prompt records the executed graph. A different UI graph must not
      // silently replace an incomplete result from that execution.
      const staticResult: ParsedMetadata = {
        model: parsed.model || '',
        seed: parsed.seed || '',
        steps: parsed.steps || '',
        cfg: parsed.cfg || '',
        sampler: parsed.sampler || '',
        scheduler: parsed.scheduler || '',
        denoise: parsed.denoise || '',
        noiseSeed: parsed.noiseSeed || '',
        vae: parsed.vae || '',
        clipSkip: parsed.clipSkip || 0,
        prompt: parsed.prompt || '',
        negativePrompt: parsed.negativePrompt || '',
        workflowJson,
        raw,
        parserVersion: PARSER_VERSION,
        promptStages: parsed.promptStages,
        promptStatus: recordStatus(parsed.promptStatus),
        promptWarnings: recordWarnings(parsed.promptWarnings),
      }
      return applyPromptRecord(staticResult, promptRecord)
    }
  }

  // 尝试 A1111 格式
  const params = raw['parameters'] || raw['prompt'] || ''
  if (params) {
    const parsed = parseA1111Parameters(params)
    const staticResult: ParsedMetadata = {
      ...parsed,
      model: parsed.model || '',
      seed: parsed.seed || '',
      steps: parsed.steps || '',
      cfg: parsed.cfg || '',
      sampler: parsed.sampler || '',
      vae: parsed.vae || '',
      clipSkip: parsed.clipSkip || 0,
      prompt: parsed.prompt || '',
      negativePrompt: parsed.negativePrompt || '',
      workflowJson: '',
      raw,
      parserVersion: PARSER_VERSION,
      promptStatus: recordStatus(parsed.prompt ? 'complete' : 'missing'),
      promptStages: [],
      promptWarnings: recordWarnings([]),
    }
    return applyPromptRecord(staticResult, promptRecord)
  }

  // 尝试 Fooocus 格式
  const fooocusParams = raw['fooocus_params'] || ''
  if (fooocusParams) {
    const parsed = parseFooocusParams(fooocusParams)
    const staticResult: ParsedMetadata = {
      ...parsed,
      model: parsed.model || '',
      seed: parsed.seed || '',
      steps: parsed.steps || '',
      cfg: parsed.cfg || '',
      sampler: parsed.sampler || '',
      vae: parsed.vae || '',
      clipSkip: parsed.clipSkip || 0,
      prompt: parsed.prompt || '',
      negativePrompt: parsed.negativePrompt || '',
      workflowJson: '',
      raw,
      parserVersion: PARSER_VERSION,
      promptStatus: recordStatus(parsed.prompt ? 'complete' : 'missing'),
      promptStages: [],
      promptWarnings: recordWarnings([]),
    }
    return applyPromptRecord(staticResult, promptRecord)
  }

  // 没有任何工作流：有效记录本身就能给出提示词文本（PNG 没有 workflow 块也一样）
  if (promptRecord) {
    return applyPromptRecord({
      model: '',
      seed: '',
      steps: '',
      cfg: '',
      sampler: '',
      vae: '',
      clipSkip: 0,
      prompt: '',
      negativePrompt: '',
      workflowJson: '',
      raw,
      parserVersion: PARSER_VERSION,
      promptStages: [],
      promptStatus: 'missing' as PromptStatus,
      promptWarnings: [],
    }, promptRecord)
  }

  // 如果没有任何元数据，返回空结果
  if (Object.keys(raw).length === 0) {
    return null
  }

  return {
    model: '',
    seed: '',
    steps: '',
    cfg: '',
    sampler: '',
    vae: '',
    clipSkip: 0,
    prompt: raw['prompt'] || raw['description'] || '',
    negativePrompt: raw['negative_prompt'] || '',
    workflowJson: '',
    raw,
    parserVersion: PARSER_VERSION,
    promptWarnings: recordWarnings([]),
  }
}
