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

async function decompressZlibAsync(data: Uint8Array): Promise<string> {
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

export function parseComfyUIWorkflow(workflow: any): Partial<ParsedMetadata> {
  const result: Partial<ParsedMetadata> = {
    raw: { workflow: JSON.stringify(workflow) },
  }

  if (!workflow || typeof workflow !== 'object') return result

  // 构建 node_id → node 映射
  const nodeMap = new Map<number, any>()
  const uiNodes: any[] = workflow.nodes || (Array.isArray(workflow) ? workflow : [])
  for (const n of uiNodes) {
    if (n && typeof n === 'object' && n.id !== undefined) nodeMap.set(n.id, n)
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
    const badWords = ['worst quality', 'low quality', 'score_1', 'score_2', 'score_3', 'bad anatomy', 'bad proportions', 'extra limbs', 'extra fingers', 'missing fingers', 'nsfw', 'ugly', 'blurry', 'jpeg artifacts']
    return badWords.some(w => lower.includes(w))
  }

  // 从节点提取文本内容
  function getNodeText(node: any): string {
    const inputs = node.inputs || {}
    const ct = node.class_type || node.type || ''
    // CLIPTextEncode
    if (inputs.text && typeof inputs.text === 'string' && inputs.text.length > 3) return inputs.text
    if (inputs.prompt && typeof inputs.prompt === 'string' && inputs.prompt.length > 3) return inputs.prompt
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
    return false
  }

  // 收集所有文本节点
  const textNodes: { node: any; text: string }[] = []
  const iterNodes: any[] = workflow.nodes || (Array.isArray(workflow) ? workflow : typeof workflow === 'object' ? Object.entries(workflow).map(([k, v]) => ({ id: k, ...(v as any) })) : [])

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

  // 确定每个文本节点是正/负向
  for (const { node, text } of textNodes) {
    const nodeId = node.id !== undefined ? String(node.id) : ''
    let assigned = ''
    // 1. KSampler 引用
    const ref = nodeId ? posRefs.get(nodeId) : undefined
    if (ref === 'positive') { if (!isPureLoraText(text)) result.prompt = text; assigned = 'posRefs→positive' }
    else if (ref === 'negative') { result.negativePrompt = text; assigned = 'posRefs→negative' }
    // 2. 链路追踪（UI format）
    if (!assigned && node.id !== undefined && linkMap.size > 0) {
      const role = getPromptRole(node.id)
      if (role === 'positive') { if (!isPureLoraText(text)) result.prompt = text; assigned = 'linkTrace→positive' }
      else if (role === 'negative') { result.negativePrompt = text; assigned = 'linkTrace→negative' }
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
            if (dnRef === 'positive') { if (!isPureLoraText(text)) result.prompt = text; assigned = 'posRefsFwd→positive'; break }
            if (dnRef === 'negative') { result.negativePrompt = text; assigned = 'posRefsFwd→negative'; break }
          }
          if (assigned) break
        }
      }
    }
    // 3. 启发式判定
    if (!assigned) {
      if (isNegativeText(text)) {
        result.negativePrompt = text; assigned = 'heuristic→negative'
      } else {
        if (!isPureLoraText(text)) result.prompt = text; assigned = 'heuristic→positive'
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

  // Regex to parse <lora:name:weight> from LoraManager's text input
  const LORA_TAG_RE = /<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>/gi
  const loras: string[] = []
  const seen = new Set<string>()

  function add(name: string) {
    if (name && !seen.has(name)) { seen.add(name); loras.push(name) }
  }

  function extractFromNode(node: any) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') return

    // Standard ComfyUI LoraLoader: inputs.lora_name (string)
    if (inputs.lora_name && typeof inputs.lora_name === 'string') {
      add(inputs.lora_name.replace(/\.(safetensors|pt|bin)$/i, '').trim())
      return
    }

    // LoraManager: inputs.text contains <lora:name:w> syntax
    if (inputs.text && typeof inputs.text === 'string') {
      let m: RegExpExecArray | null
      while ((m = LORA_TAG_RE.exec(inputs.text)) !== null) {
        const name = m[1].trim()
        if (name) add(name)
      }
      return
    }

    // LoraManager widget object
    if (inputs.loras && typeof inputs.loras === 'object' && !Array.isArray(inputs.loras)) {
      for (const key of Object.keys(inputs.loras)) {
        const entry = inputs.loras[key]
        if (entry && typeof entry === 'object') {
          const name = (entry.name || entry.lora_name || '').trim()
          if (name) add(name)
        }
      }
    }
  }

  function parseJsonAndExtract(jsonStr: string) {
    try {
      const workflow = JSON.parse(jsonStr)
      for (const node of (workflow.nodes || [])) extractFromNode(node)
      if (typeof workflow === 'object') {
        for (const key of Object.keys(workflow)) extractFromNode(workflow[key])
      }
    } catch { /* skip */ }
  }

  // Primary: try workflowJson
  parseJsonAndExtract(workflowJson)

  // Fallback: try raw prompt metadata (for old cached scans where workflowJson is UI format)
  if (loras.length === 0 && rawMetadata?.prompt && rawMetadata.prompt !== workflowJson) {
    parseJsonAndExtract(rawMetadata.prompt)
  }

  return loras
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

  // 优先用 prompt 格式（inputs 为对象，易解析），其次 workflow 格式
  const bestWorkflow = promptData || workflowData

  // 尝试解析工作流（优先 prompt 格式，inputs 为对象易解析）
  if (bestWorkflow) {
    try {
      const workflow = JSON.parse(bestWorkflow)
      const parsed = parseComfyUIWorkflow(workflow)
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
        workflowJson: bestWorkflow,
        raw,
      }
    } catch {
      // 解析失败，继续尝试其他格式
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
