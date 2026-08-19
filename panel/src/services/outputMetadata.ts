// ── 元数据解析服务 ──
// 支持 ComfyUI、A1111/Forge、Fooocus 等格式

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
}

// 判断文本是否纯 <lora:...> 标签（LoRA 序列节点文本，不是有效 prompt）
function isPureLoraText(text: string): boolean {
  if (!text) return false
  return text.replace(/<lora:[^>]*>/gi, '').trim().length === 0
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
 */
export const PARSER_VERSION = 4

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

  // ── 正片文本提取（泛化版，2026-08-20）──
  // 不依赖具体节点型号：按「内容字段白名单 + 配置字段黑名单 + 节点类别」沿 KSampler.positive 链路通用取文本，
  // 覆盖任意型号的拼接/组装节点（Text Concatenate、String Combiner、Prompt Builder…）、叶节点（Primitive/String/textbox…）、
  // 以及"文本来自其输入链路"的透传/过滤节点（Danbooru Tag Sorter、Clean Tags、Tag Mapper…）。
  const _TEXT_KEY_RE = /(text|prompt|caption|description|tags|keyword|string|content|value|nl_prompt|extra_tags|subtitle|quality|style|character|background|general|identity|rating|aspect_ratio|length)$/i
  const _CONFIG_KEY_RE = /^(delimiter|separator|clean_whitespace|seed|width|height|steps|cfg|sampler_name|scheduler|denoise|device|type|model|clip|unet|vae|batch_size|anything|preset|roll|pos_x|pos_y|pos_z|excel_file|category_mapping|new_category_order|regex_blacklist|tag_blacklist|validation|is_comment|force_reload|config|settings|json|data_json|schema)$/i
  const _LEAF_CT_RE = /^(primitive|string|multiline|textbox|keyword|property|single.?line|text.?input)/i
  const _JOIN_CT_RE = /(concat|combine|concatenate|joining|join|assemble|merge|compose|builder|section|smith|text.?comb)/i

  const _cleanTags = (t: string) => t.split(/[\r\n]+/).join(', ').replace(/,\s*,/g, ',').trim()
  const _isContentKey = (k: string) => !_CONFIG_KEY_RE.test(k) && _TEXT_KEY_RE.test(k)

  function getNodeText(node: any, visited = new Set<string>()): string {
    const inputs = node.inputs || {}
    const ct = (node.class_type || node.type || '').toLowerCase()
    const nodeId = node.id !== undefined ? String(node.id) : ''
    // 进入即标记自己（防环）。注意：不能在组装分支里"先标记孩子再递归"，
    // 否则像 DanbooruTagSorter 这类"文本来自其输入链路"的节点会在自身递归段被判 visited 而整支丢失。
    if (nodeId && visited.has(nodeId)) return ''
    if (nodeId) visited.add(nodeId)

    const resolveSource = (v: any): string => {
      if (typeof v === 'string' && v.length > 3) return v
      if (!Array.isArray(v) || v.length === 0) return ''
      const srcVal = v[0]
      if (typeof srcVal !== 'number' && (typeof srcVal !== 'string' || isNaN(Number(srcVal)))) return ''
      const srcNode = nodeMap.get(srcVal) || nodeMap.get(Number(srcVal))
      if (!srcNode || srcNode === node) return ''
      return getNodeText(srcNode, visited)
    }

    // 1) 内容字段直读（多个同类字段按序聚合，如 preview_text + prompt_text）
    //    注意：只要存在数组链接输入，就可能是"混合型组装"（部分分区字面量、部分分区链接）——此时不提前短路，交给下面的组装分支全量聚合。
    const hasLinkInput = Object.values(inputs).some((v) => Array.isArray(v) && v.length > 0)
    const direct: string[] = []
    for (const [k, v] of Object.entries(inputs)) if (typeof v === 'string' && _isContentKey(k) && v.length > 3) direct.push(v)
    if (direct.length && !hasLinkInput) return _cleanTags(direct.join(', '))

    // 2) 生态特例：TK D站画廊把选中 prompt 存在 selection_data JSON（多选逗号连接，供拼接节点注入）
    if (ct.includes('danboorugallery')) {
      const sd = inputs.selection_data
      if (typeof sd === 'string') {
        try {
          const data = JSON.parse(sd)
          const list = data?.selections
          if (Array.isArray(list)) {
            const ps = list.map((s: any) => (s && typeof s === 'object' ? String(s.prompt || '') : '')).filter(Boolean)
            if (ps.length) return ps.join(', ')
          }
        } catch { /* 非 JSON 忽略 */ }
      }
    }

    // 3) 通用字符串叶节点：PrimitiveStringMultiline / String / textbox 等
    if (_LEAF_CT_RE.test(ct)) {
      for (const k of ['value', 'string', 'contents', 'content', 'data', 'text']) {
        const v = inputs[k]
        if (typeof v === 'string' && v.length > 3) return v
      }
    }

    // 4) 组装/拼接节点：把非配置输入按字段顺序聚合（值可为字面量或数组链接）
    //    兼容没进正则的"类 Prompt Builder"节点：≥2 个非配置输入即按组装处理；字符串仅当 key 属内容白名单。
    const contentInputs = Object.entries(inputs).filter(
      ([k, v]) =>
        !_CONFIG_KEY_RE.test(k) &&
        ((Array.isArray(v) && v.length > 0) || (typeof v === 'string' && _isContentKey(k) && v.length > 3)),
    )
    if (_JOIN_CT_RE.test(ct) || contentInputs.length >= 2) {
      const parts: string[] = []
      for (const [k, v] of contentInputs) {
        const t = resolveSource(v)
        if (t) parts.push(_cleanTags(t))
      }
      const joined = _cleanTags(parts.join(', '))
      if (joined.length > 3) return joined
    }

    // 5) widgets_values（UI format fallback）
    if (Array.isArray(node.widgets_values)) {
      for (const w of node.widgets_values) if (typeof w === 'string' && w.length > 5) return w
    }

    // 6) 兜底：剩余的内容输入——数组链接（透传/过滤类：Danbooru Tag Sorter / Clean Tags → 上游文本），
    //    以及 key 属内容白名单的字符串（如 CLIP 的 text；单内容串+黑名单数组链接时第 4 步不触发，这里补上）。
    //    config/settings 等非内容 key 的字符串一律跳过，绝不进正片。
    for (const [k, v] of Object.entries(inputs)) {
      if (_CONFIG_KEY_RE.test(k)) continue
      if (typeof v === 'string' && v.length > 3 && _isContentKey(k)) return v
      if (!Array.isArray(v) || v.length === 0) continue
      const t = resolveSource(v)
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
          if (entry.name === 'scheduler' && entry.value !== undefined) result.scheduler = String(entry.value)
          if (entry.name === 'denoise' && entry.value !== undefined) result.denoise = String(entry.value)
          if (entry.name === 'noise_seed' && entry.value !== undefined) result.noiseSeed = String(entry.value)
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
        if (inputs.scheduler) result.scheduler = String(inputs.scheduler)
        if (inputs.denoise !== undefined) result.denoise = String(inputs.denoise)
        if (inputs.noise_seed !== undefined) result.noiseSeed = String(inputs.noise_seed)
        if (Array.isArray(inputs.positive)) posRefs.set(String(inputs.positive[0]), 'positive')
        if (Array.isArray(inputs.negative)) posRefs.set(String(inputs.negative[0]), 'negative')
      }
    }
    if (ct.includes('CheckpointLoader') || ct.includes('DiffusionModelLoader') || ct.includes('UNETLoader')) {
      // 底模：CheckpointLoader→ckpt_name，UNETLoader/DiffusionModelLoader→unet_name
      const key = ct.includes('UNETLoader') || ct.includes('DiffusionModelLoader') ? 'unet_name' : 'ckpt_name'
      let name: any = n.inputs?.[key]
      if (Array.isArray(name) && name.length) {
        // API 数组链接 [srcId, slot] → 递归源节点（loader 的输出可能是链接）
        const src = nodeMap.get(name[0]) || nodeMap.get(Number(name[0]))
        name = src && (src.inputs?.ckpt_name || src.inputs?.unet_name)
        if (!name && src && Array.isArray(src.widgets_values)) {
          name = src.widgets_values.find((w: any) => typeof w === 'string' && /\.(safetensors|ckpt|pt|bin)$/i.test(w)) || ''
        }
      }
      if (name && typeof name === 'string') result.model = String(name)
    }
    if (ct.includes('VAELoader')) {
      if (n.inputs?.vae_name) result.vae = String(n.inputs.vae_name)
    }
    // 收集文本节点
    if (isTextNode(n)) {
      const text = getNodeText(n)
      if (text) {
        textNodes.push({ node: n, text })
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

  // posRefs 迭代回溯：posRefs 节点无文本时沿 inputs 链路上溯，直到找到有文本的节点
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

/** 判断 PNG 元数据是否含真实 UI 格式工作流（workflow chunk） */
export function hasUiWorkflow(raw: Record<string, string>): boolean {
  return !!(raw && raw['workflow'])
}

/**
 * 将 ComfyUI API 格式工作流（prompt chunk：键为节点 id、值为 {class_type, inputs}）转换为
 * UI 格式（workflow chunk：nodes + links），使只有 API 参数的图也能在 ComfyUI 前端导入。
 * API 不含节点坐标/布局，转换后节点按顺序错开排列；任何异常或非 API 输入返回 null（调用方回退提示）。
 */
export function apiWorkflowToUI(apiJson: string): string | null {
  try {
    const api = safeParseJSON(apiJson)
    if (!api || typeof api !== 'object' || Array.isArray(api)) return null

    const entries = Object.entries(api)
    if (entries.length === 0) return null
    // 校验是 API 格式（值含 class_type）；UI 格式（nodes 数组）等返回 null
    const isApi = entries.every(([, v]) => v && typeof v === 'object' && typeof (v as any).class_type === 'string')
    if (!isApi) return null

    // API key → UI 数字 id
    const idMap = new Map<string, number>()
    let maxId = 0
    for (const [key] of entries) {
      const num = Number(key)
      const uiId = Number.isInteger(num) ? num : maxId + 1
      idMap.set(key, uiId)
      if (uiId > maxId) maxId = uiId
    }

    const nodes: any[] = []
    const links: any[] = []
    let linkCounter = 1
    entries.forEach(([key, val], idx) => {
      const uiId = idMap.get(key)!
      const inputs: any[] = []
      const widgets_values: any[] = []
      const rawInputs = (val as any).inputs || {}
      for (const [iname, ival] of Object.entries(rawInputs)) {
        // 数组链接 [srcId, srcSlot]
        const isLink = Array.isArray(ival) && ival.length >= 2
          && (typeof ival[0] === 'number' || /^\d+$/.test(String(ival[0])))
          && idMap.has(String(ival[0]))
        if (isLink) {
          const linkId = linkCounter++
          const fromNode = idMap.get(String(ival[0]))!
          links.push([linkId, fromNode, Number(ival[1]) || 0, uiId, inputs.length, '*'])
          inputs.push({ name: iname, type: '*', link: linkId })
        } else {
          inputs.push({ name: iname, type: '*', value: ival })
          // 简单值进入 widgets_values（对象/数组值不入，避免污染 widget 顺序）
          if (ival === null || typeof ival !== 'object') widgets_values.push(ival)
        }
      }
      nodes.push({
        id: uiId,
        type: (val as any).class_type,
        pos: [idx * 20, idx * 20],
        size: [200, 100],
        flags: {},
        order: idx,
        mode: 0,
        inputs,
        outputs: [],
        properties: {},
        widgets_values,
      })
    })

    return JSON.stringify({
      last_node_id: maxId,
      last_link_id: linkCounter - 1,
      nodes,
      links,
      groups: [],
      config: {},
      extra: {},
      version: 0.4,
    })
  } catch {
    return null
  }
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
      while (keyEnd < dataEnd && bytes[keyEnd] !== 0 && keyEnd - dataStart < 79) keyEnd++
      // key 按 PNG 规范 ≤79 字节截断，循环拼接避免超大 spread 抛 RangeError（security 修复）
      let key = ''
      for (let i = dataStart; i < keyEnd; i++) key += String.fromCharCode(bytes[i])

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
      // 正片兜底（2026-08-20）：API(prompt) chunk 里正片由其他节点注入/拼接时可能取不全或取不到，
      // 此时改用 workflow(UI) chunk 再解一次补正片（只补 prompt/negativePrompt，参数仍以 API 为准）。
      if (!parsed.prompt && workflowData && parseSrc !== workflowData) {
        const altWf = safeParseJSON(workflowData)
        if (altWf) {
          const altParsed = parseComfyUIWorkflow(altWf)
          if (altParsed.prompt) parsed.prompt = altParsed.prompt
          if (!parsed.negativePrompt && altParsed.negativePrompt) parsed.negativePrompt = altParsed.negativePrompt
        }
      }
      return {
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
