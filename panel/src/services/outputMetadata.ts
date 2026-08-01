// ── 元数据解析服务 ──
// 支持 ComfyUI、A1111/Forge、Fooocus 等格式

export interface ParsedMetadata {
  model: string
  seed: string
  steps: string
  cfg: string
  sampler: string
  vae: string
  clipSkip: number
  prompt: string
  negativePrompt: string
  workflowJson: string
  raw: Record<string, string>
}

// 判断文本是否纯 <lora:...> 标签（LoRA 序列节点文本，不是有效 prompt）
function isPureLoraText(text: string): boolean {
  if (!text) return false
  return text.replace(/<lora:[^>]*>/gi, '').trim().length === 0
}

function decompressZlib(data: Uint8Array): string {
  // 浏览器环境没有原生 zlib，使用 DecompressionStream API
  // 如果浏览器不支持，尝试直接解码
  try {
    // 先尝试作为原始 deflate 数据解压（跳过 zlib 头部的 2 字节）
    const deflateData = data.slice(2)
    const ds = new DecompressionStream('deflate-raw')
    const writer = ds.writable.getWriter()
    writer.write(deflateData)
    writer.close()
    const reader = ds.readable.getReader()
    const chunks: Uint8Array[] = []
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
    }
    // 同步方式无法 await，使用 TextDecoder 兜底
    pump().then(() => { /* 异步解压完成 */ })
    return ''
  } catch {
    return new TextDecoder().decode(data)
  }
}

export async function decompressZlibAsync(data: Uint8Array): Promise<string> {
  try {
    // zTXt 使用 zlib 格式（deflate + 2 字节头部 + 4 字节校验）
    // 跳过头部 2 字节（CMF + FLG）和尾部 4 字节（Adler-32）
    const deflateData = data.slice(2, data.length - 4)
    const ds = new DecompressionStream('deflate-raw')
    const writer = ds.writable.getWriter()
    writer.write(deflateData)
    writer.close()
    const reader = ds.readable.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0)
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
 */
export const PARSER_VERSION = 2

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
  const result: Partial<ParsedMetadata> = {
    raw: { workflow: JSON.stringify(workflow) },
  }

  if (!workflow || typeof workflow !== 'object') return result

  // 归一化节点列表：UI format（nodes 数组）/ API format（nodeId 键对象）
  const iterNodes: any[] = workflow.nodes || (Array.isArray(workflow) ? workflow : typeof workflow === 'object' ? Object.entries(workflow).map(([k, v]) => ({ id: k, ...(v as any) })) : [])

  // 构建 node_id → node 映射（同时注册 string / number 键，兼容 UI format 数字 id 与 API format 字符串 id）
  const nodeMap = new Map<any, any>()
  for (const n of iterNodes) {
    if (n && typeof n === 'object' && n.id !== undefined) {
      nodeMap.set(n.id, n)
      const numId = Number(n.id)
      if (!isNaN(numId)) nodeMap.set(numId, n)
    }
  }

  // 构建 link 映射：link_id → { to_node, to_slot }
  const linkMap = new Map<number, { toNode: number; toSlot: number }>()
  const links = workflow.links
  if (Array.isArray(links)) {
    for (const lnk of links) {
      if (Array.isArray(lnk) && lnk.length >= 5) {
        linkMap.set(lnk[0], { toNode: lnk[3], toSlot: lnk[4] })
      }
    }
  }

  // 判断 CLIPTextEncode 节点的输出连接到哪个输入槽位（positive / negative）
  function getPromptRole(nodeId: number): 'positive' | 'negative' | 'unknown' {
    const n = nodeMap.get(nodeId)
    if (!n) return 'unknown'
    const outputs = n.outputs
    if (!Array.isArray(outputs)) return 'unknown'
    for (const output of outputs) {
      const linkIds: number[] = output?.links?.filter((l: any) => l !== null) || []
      for (const lid of linkIds) {
        const link = linkMap.get(lid)
        if (!link) continue
        const targetNode = nodeMap.get(link.toNode)
        if (!targetNode) continue
        const inputs = targetNode.inputs
        if (Array.isArray(inputs)) {
          const slot = inputs[link.toSlot]
          if (slot?.name === 'positive') return 'positive'
          if (slot?.name === 'negative') return 'negative'
        }
        // 某些格式 inputs 是对象 { positive: {...}, negative: {...} }
        if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
          // 遍历输入键名
          for (const [key, val] of Object.entries(inputs)) {
            if (val && typeof val === 'object' && (val as any).link === lid) {
              if (key === 'positive') return 'positive'
              if (key === 'negative') return 'negative'
            }
          }
        }
      }
    }
    return 'unknown'
  }

  // 追踪 KSampler 对正/负向 prompt 的引用
  const posRefs = new Map<string, string>() // nodeId → 'positive' | 'negative'

  // 判断文本是否为负面 prompt（启发式）
  function isNegativeText(t: string): boolean {
    const lower = t.toLowerCase()
    // nsfw 常出现在正向 NSFW 提示词中，不作为负面判断词
    const badWords = ['worst quality', 'low quality', 'score_1', 'score_2', 'score_3', 'bad anatomy', 'bad proportions', 'extra limbs', 'extra fingers', 'missing fingers', 'ugly', 'blurry', 'jpeg artifacts', 'lowres', 'cropped', 'watermark']
    // 保守：需命中至少 2 个负面词才判负，避免把含 nsfw 的正向提示词误判为负向
    let hits = 0
    for (const w of badWords) { if (lower.includes(w)) hits++ }
    return hits >= 2
  }

  // 从节点提取文本内容（API format 的文本字段可能是数组链接 [srcId, slot]，递归解析上游文本）
  function getNodeText(node: any, visited = new Set<string>()): string {
    const inputs = node.inputs || {}
    const ct = node.class_type || node.type || ''
    // 直接文本字段（含 preview_text / prompt_text，如 PreviewAny / DanbooruTextPassthrough）
    for (const key of ['text', 'prompt', 'positive', 'negative', 'prompt_text', 'preview_text', 'preview_markdown']) {
      const v = inputs[key]
      if (typeof v === 'string' && v.length > 3) return v
    }
    // TextConcatenate: text1 + text2 + ...
    if (ct.includes('TextConcat') || ct.includes('Text Comb')) {
      let combined = ''
      for (let i = 1; i <= 10; i++) {
        const k = `text${i}`
        if (inputs[k] && typeof inputs[k] === 'string') combined += inputs[k]
      }
      if (combined.length > 3) return combined
    }
    // widgets_values（UI format fallback）
    if (Array.isArray(node.widgets_values)) {
      for (const w of node.widgets_values) {
        if (typeof w === 'string' && w.length > 5) return w
      }
    }
    // API format：输入值为数组链接 [srcId, slot] → 递归解析源节点文本
    const nodeId = node.id !== undefined ? String(node.id) : ''
    if (visited.has(nodeId)) return ''
    visited.add(nodeId)
    for (const key of Object.keys(inputs)) {
      const v = inputs[key]
      if (!Array.isArray(v) || v.length === 0) continue
      const srcVal = v[0]
      if (typeof srcVal !== 'number' && (typeof srcVal !== 'string' || isNaN(Number(srcVal)))) continue
      const srcNode = nodeMap.get(srcVal) || nodeMap.get(Number(srcVal))
      if (!srcNode || srcNode === node) continue
      const t = getNodeText(srcNode, visited)
      if (t) return t
    }
    return ''
  }

  // 判断节点是否为文本节点
  function isTextNode(node: any): boolean {
    const ct = node.class_type || node.type || ''
    if (ct === 'CLIPTextEncode' || ct === 'WeiLinPromptUI' || ct === 'TextConcatenate' || ct === 'Text Concatenate') return true
    // 带有文本输入字段的节点
    const inputs = node.inputs || {}
    if (inputs.text && typeof inputs.text === 'string' && inputs.text.length > 5) return true
    if (inputs.prompt && typeof inputs.prompt === 'string' && inputs.prompt.length > 5) return true
    if (inputs.prompt_text && typeof inputs.prompt_text === 'string' && inputs.prompt_text.length > 5) return true
    if (inputs.preview_text && typeof inputs.preview_text === 'string' && inputs.preview_text.length > 5) return true
    if (inputs.positive && typeof inputs.positive === 'string' && inputs.positive.length > 5) return true
    if (inputs.negative && typeof inputs.negative === 'string' && inputs.negative.length > 5) return true
    return false
  }

  // 收集所有文本节点
  const textNodes: { node: any; text: string }[] = []

  for (const n of iterNodes) {
    if (!n || typeof n !== 'object') continue

    const ct = n.class_type || n.type || ''
    if (ct.includes('KSampler')) {
      const inputs = n.inputs || {}
      if (Array.isArray(inputs)) {
        // UI format: inputs = [{name: "seed", value: 42}, {name: "positive", link: 3}, ...]
        for (const entry of inputs) {
          if (!entry || typeof entry !== 'object') continue
          if (entry.name === 'seed' && entry.value !== undefined) result.seed = String(entry.value)
          if (entry.name === 'steps' && entry.value !== undefined) result.steps = String(entry.value)
          if (entry.name === 'cfg' && entry.value !== undefined) result.cfg = String(entry.value)
          if (entry.name === 'sampler_name' && entry.value !== undefined) result.sampler = String(entry.value)
          if (entry.name === 'positive' && entry.link !== undefined) {
            // link entry.link → find (fromNode) in links array
            if (Array.isArray(links)) {
              for (const lnk of links) {
                if (Array.isArray(lnk) && lnk.length >= 5 && lnk[0] === entry.link) {
                  posRefs.set(String(lnk[1]), 'positive')
                  break
                }
              }
            }
          }
          if (entry.name === 'negative' && entry.link !== undefined) {
            if (Array.isArray(links)) {
              for (const lnk of links) {
                if (Array.isArray(lnk) && lnk.length >= 5 && lnk[0] === entry.link) {
                  posRefs.set(String(lnk[1]), 'negative')
                  break
                }
              }
            }
          }
        }
      } else {
        // 标准对象格式 (API format)
        if (inputs.seed !== undefined) result.seed = String(inputs.seed)
        if (inputs.steps !== undefined) result.steps = String(inputs.steps)
        if (inputs.cfg !== undefined) result.cfg = String(inputs.cfg)
        if (inputs.sampler_name) result.sampler = String(inputs.sampler_name)
        if (Array.isArray(inputs.positive)) posRefs.set(String(inputs.positive[0]), 'positive')
        if (Array.isArray(inputs.negative)) posRefs.set(String(inputs.negative[0]), 'negative')
      }
    }
    if (ct.includes('CheckpointLoader')) {
      if (n.inputs?.ckpt_name) result.model = String(n.inputs.ckpt_name)
    }
    if (ct.includes('VAELoader')) {
      if (n.inputs?.vae_name) result.vae = String(n.inputs.vae_name)
    }
    // 收集文本节点
    if (isTextNode(n)) {
      const text = getNodeText(n)
      if (text) {
        textNodes.push({ node: n, text })
        console.log(`[parser] 文本节点 id=${n.id} type=${ct} 文本前40字:`, text.slice(0, 40))
      }
    }
  }

  // posRefs 迭代回溯：posRefs 节点无文本时沿 inputs 链路上溯，直到找到有文本的节点
  let refsAdded = true
  while (refsAdded) {
    refsAdded = false
    for (const [nodeIdStr, role] of [...posRefs]) {
      const nodeId = Number(nodeIdStr)
      if (isNaN(nodeId)) continue
      if (textNodes.some(tn => String(tn.node.id) === nodeIdStr)) continue // 已有文本，不需回溯
      const n = nodeMap.get(nodeId)
      if (!n) continue
      const inputs = n.inputs
      if (!Array.isArray(inputs)) continue
      for (const entry of inputs) {
        if (!entry || entry.link === undefined) continue
        if (!Array.isArray(links)) break
        for (const lnk of links) {
          if (!Array.isArray(lnk) || lnk.length < 5 || lnk[0] !== entry.link) continue
          const srcId = String(lnk[1])
          if (!posRefs.has(srcId)) {
            posRefs.set(srcId, role)
            refsAdded = true
          }
          break
        }
      }
    }
  }

  // debug: 打印解析上下文
  console.log('[PromptFreq/debug] textNodes:', textNodes.map(n => ({
    id: n.node.id, type: n.node.class_type || n.node.type,
    textPreview: n.text.slice(0, 60),
    textLen: n.text.length,
  })))
  console.log('[PromptFreq/debug] posRefs:', Object.fromEntries(posRefs))
  console.log('[PromptFreq/debug] linkMap size:', linkMap.size,
    'links raw:', Array.isArray(links) ? links.length : 'none',
    'links format:', Array.isArray(links) && links.length > 0 ? JSON.stringify(links[0]).slice(0, 120) : '')
  // debug: 打印 KSampler inputs 结构
  for (const n of iterNodes) {
    const ct = n.class_type || n.type || ''
    if (ct.includes('KSampler')) {
      console.log('[PromptFreq/debug] KSampler id=' + n.id, 'inputs type:', Array.isArray(n.inputs) ? 'array' : typeof n.inputs,
        'inputs:', JSON.stringify(n.inputs).slice(0, 300))
    }
  }

  // 确定每个文本节点是正/负向。权威引用（KSampler/链路）优先，启发式仅补漏，
  // 防止 CR Prompt Text、PreviewAny 等旁路文本覆盖已确定的真实 prompt。
  let authoritativePrompt = false
  let authoritativeNegative = false
  for (const { node, text } of textNodes) {
    const nodeId = node.id !== undefined ? String(node.id) : ''
    let assigned = ''
    // 1. KSampler 引用
    const ref = nodeId ? posRefs.get(nodeId) : undefined
    if (ref === 'positive') { if (!isPureLoraText(text)) { result.prompt = text; authoritativePrompt = true } assigned = 'posRefs→positive' }
    else if (ref === 'negative') { result.negativePrompt = text; authoritativeNegative = true; assigned = 'posRefs→negative' }
    // 2. 链路追踪（UI format）
    if (!assigned && node.id !== undefined && linkMap.size > 0) {
      const role = getPromptRole(node.id)
      if (role === 'positive') { if (!isPureLoraText(text)) { result.prompt = text; authoritativePrompt = true } assigned = 'linkTrace→positive' }
      else if (role === 'negative') { result.negativePrompt = text; authoritativeNegative = true; assigned = 'linkTrace→negative' }
    }
    // 2.b 正向链路：文本节点的输出 → 下游节点 → 查 posRefs
    if (!assigned && node.id !== undefined && posRefs.size > 0) {
      const outputs = node.outputs
      if (Array.isArray(outputs)) {
        for (const output of outputs) {
          const linkIds: number[] = output?.links?.filter((l: any) => l !== null) || []
          for (const lid of linkIds) {
            const link = linkMap.get(lid)
            if (!link) continue
            const dnRef = posRefs.get(String(link.toNode))
            if (dnRef === 'positive') { if (!isPureLoraText(text)) { result.prompt = text; authoritativePrompt = true } assigned = 'posRefsFwd→positive'; break }
            if (dnRef === 'negative') { result.negativePrompt = text; authoritativeNegative = true; assigned = 'posRefsFwd→negative'; break }
          }
          if (assigned) break
        }
      }
    }
    // 3. 启发式判定（仅当无权威结果时补漏；无权威时保留"后者覆盖"旧行为）
    if (!assigned) {
      if (isNegativeText(text)) {
        if (!authoritativeNegative) { result.negativePrompt = text; assigned = 'heuristic→negative' }
      } else {
        if (!authoritativePrompt && !isPureLoraText(text)) { result.prompt = text; assigned = 'heuristic→positive' }
      }
    }
    console.log(`[PromptFreq/debug] 分类 node=${nodeId} ${assigned} 文本前50字:`, text.slice(0, 50))
  }

  return result
}

/** 从 ComfyUI workflow JSON 中提取所有 LoRA 名称 */
export function extractLorasFromWorkflow(
  workflowJson: string,
  rawMetadata?: Record<string, string>,
): string[] {
  if (!workflowJson) return []

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
      while (keyEnd < dataEnd && bytes[keyEnd] !== 0) keyEnd++
      const key = String.fromCharCode(...bytes.slice(dataStart, keyEnd))

      let val: string
      if (type === 'zTXt') {
        try {
          const compData = bytes.slice(keyEnd + 2, dataEnd)
          val = await decompressZlibAsync(compData)
        } catch {
          val = new TextDecoder().decode(bytes.slice(keyEnd + 1, dataEnd))
        }
      } else {
        val = new TextDecoder().decode(bytes.slice(keyEnd + 1, dataEnd))
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

  // 尝试解析工作流
  if (parseSrc) {
    const workflow = safeParseJSON(parseSrc)
    if (workflow) {
      const parsed = parseComfyUIWorkflow(workflow)
      const workflowJson = workflowData || promptData || ''
      return {
        model: parsed.model || '',
        seed: parsed.seed || '',
        steps: parsed.steps || '',
        cfg: parsed.cfg || '',
        sampler: parsed.sampler || '',
        vae: parsed.vae || '',
        clipSkip: parsed.clipSkip || 0,
        prompt: parsed.prompt || '',
        negativePrompt: parsed.negativePrompt || '',
        workflowJson,
        raw,
      }
    }
  }

  // 尝试 A1111 格式
  const params = raw['parameters'] || raw['prompt'] || ''
  if (params) {
    const parsed = parseA1111Parameters(params)
    return {
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
    }
  }

  // 尝试 Fooocus 格式
  const fooocusParams = raw['fooocus_params'] || ''
  if (fooocusParams) {
    const parsed = parseFooocusParams(fooocusParams)
    return {
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
    }
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
  }
}
