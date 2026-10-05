import type { PromptStage, PromptStatus } from '../types/outputs'

type Ref = { nodeId: string; outputSlot: number }
type GraphNode = { id: string; type: string; inputs: Record<string, unknown>; inputTypes: Record<string, string>; raw: any }
type Graph = Map<string, GraphNode>

export interface GraphPromptResult {
  prompt: string
  negativePrompt: string
  promptStages: PromptStage[]
  promptStatus: PromptStatus
  promptWarnings: string[]
  samplerInputs?: Record<string, unknown>
}

const IMAGE_INPUTS = new Set(['images', 'image', 'samples', 'latent', 'latent_image', 'pixels', 'image_a', 'image_b', 'samples_from', 'samples_to', 'input_image', 'image1', 'image2', 'image_1', 'image_2', 'latents'])
const TEXT_INPUT = /^(text(?:_[a-z0-9]+)?|prompt(?:_text)?|positive|negative|string(?:_\d+)?|value|content|contents|input_str|opt_text|caption|tags)$/i
const dedup = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))]
const join = (values: string[]) => dedup(values).join(', ')

/**
 * **已证实的显示缓存型节点**（语义防护，不是"通用提取算法"）。
 *
 * 这类节点的序列化字段只是"上一次前端预览的显示状态"，**不是**本次执行
 * 真正喂给下游的文本，因此不能作为提示词来源。
 *
 * 约束（2026-10-04 owner 明确）：
 *  · 判据**只有 class 名 + 该节点的执行语义**；
 *  · **不得**按字段名（`tags`/`text`）做宽泛规则 —— 那会把任意合法自定义
 *    文本节点的 TEXT/STRING 输入误判成显示缓存；
 *  · **不得**按字符串内容（"看起来像占位符/节点名"）猜测提示词；
 *  · 名单只收**已被实测确认**的节点，新增需有实测依据，不得凭名字推测，
 *    也不得为个别工作流加特例；
 *  · 未来做通用方案时应按**实际执行数据 + 类型 + 槽位**追踪，不在本名单里堆节点。
 *
 * 依据（owner 审计 WD14 运行时实现）：WD14Tagger 的 INPUT_TYPES 与 tag() 只有
 * image/model/threshold/character_threshold/exclude_tags/replace_underscore/
 * trailing_comma；序列化出的 `tags` 是前端显示状态，tag() 只是
 * `return ui.tags, result`，不持久化本次真实结果 → 保存值可能过期
 * （0423 实测不含用户实际角色词）。
 */
const DISPLAY_CACHE_TEXT_NODES = [
  /^WD14Tagger\b/i,          // 打标器：tags 是前端显示状态，不持久化本次结果
  /^easy\s*showAnything$/i,  // 纯显示节点：text 是上次预览留痕
]

/** 该节点类型是否属于已证实的显示缓存型（只按 class 名） */
function isRuntimeOnlyTextNode(type: string): boolean {
  const name = String(type || '').trim()
  return DISPLAY_CACHE_TEXT_NODES.some(pattern => pattern.test(name))
}

function ref(value: unknown): Ref | null {
  return Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number') && Number.isInteger(value[1])
    ? { nodeId: String(value[0]), outputSlot: value[1] } : null
}

function normalize(workflow: any): Graph {
  const graph: Graph = new Map()
  const ui = Array.isArray(workflow?.nodes)
  const list = ui ? workflow.nodes : Array.isArray(workflow) ? workflow : Object.entries(workflow || {}).map(([id, value]) => ({ id, ...(value as object) }))
  const links = new Map<string, Ref>()
  if (Array.isArray(workflow?.links)) for (const link of workflow.links) {
    if (Array.isArray(link) && link.length >= 5) links.set(String(link[0]), { nodeId: String(link[1]), outputSlot: Number(link[2]) })
    else if (link && typeof link === 'object') links.set(String(link.id), { nodeId: String(link.origin_id), outputSlot: Number(link.origin_slot) })
  }
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || raw.id === undefined) continue
    const type = String(raw.class_type || raw.type || '')
    const inputs: Record<string, unknown> = {}
    const inputTypes: Record<string, string> = {}
    const widgets: unknown[] = Array.isArray(raw.widgets_values) ? raw.widgets_values : []
    if (Array.isArray(raw.inputs)) {
      let widgetIndex = 0
      for (const input of raw.inputs) {
        if (!input?.name) continue
        inputTypes[input.name] = String(input.type || '')
        const source = input.link !== null && input.link !== undefined ? links.get(String(input.link)) : undefined
        if (source) inputs[input.name] = [source.nodeId, source.outputSlot]
        else if (input.value !== undefined) inputs[input.name] = input.value
        if (input.widget) {
          if (!source && input.widget.value !== undefined) inputs[input.name] = input.widget.value
          else if (!source && inputs[input.name] === undefined && widgetIndex < widgets.length) inputs[input.name] = widgets[widgetIndex]
          widgetIndex++
        }
      }
    } else if (raw.inputs && typeof raw.inputs === 'object') Object.assign(inputs, raw.inputs)
    // The saved UI graph only has positional widget values for many nodes. Decode
    // known contracts rather than treating every widget/configuration as prompt.
    let names: string[] = []
    if (/^CLIPTextEncode$/i.test(type)) names = ['text']
    else if (/^CLIPTextEncodeSDXL$/i.test(type)) names = ['width', 'height', 'crop_w', 'crop_h', 'target_width', 'target_height', 'text_g', 'text_l']
    else if (/^CLIPTextEncodeSDXLRefiner$/i.test(type)) names = ['ascore', 'width', 'height', 'text']
    else if (/^Primitive(?:String(?:Multiline)?)?$|^String(?:Constant|Multiline)?$/i.test(type)) names = ['value']
    else if (/^TK\s*Prompt\s*Cards$/i.test(type)) names = ['positive', 'opt_text', 'lora_syntax', 'prompt_pieces']
    else if (/WeiLinPromptUI/i.test(type)) names = typeof widgets[1] === 'string' ? ['positive', 'negative'] : ['positive', 'auto_random', 'lora_str', 'temp_str', 'temp_lora_str', 'random_template', 'opt_text']
    else if (/^CLIPTextEncodeFlux$/i.test(type)) names = ['clip_l', 't5xxl', 'guidance']
    else if (/^(TK Text Join|AnimaTextJoin)$/i.test(type)) names = ['text_a', 'separator', 'text_b', 'text_c', 'text_d']
    else if (/danboorugallery/i.test(type)) names = ['selection_data']
    else if (/^KSampler$/i.test(type)) names = ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']
    else if (/^KSamplerAdvanced$/i.test(type)) names = ['add_noise', 'noise_seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise']
    else if (/SaveImage/i.test(type)) names = ['filename_prefix']
    else if (/TK\s*String\s*Router/i.test(type)) names = ['separator', 'router_settings']
    for (let index = 0; index < names.length; index++) if (inputs[names[index]] === undefined && widgets[index] !== undefined) inputs[names[index]] = widgets[index]
    if (/TK\s*String\s*Router/i.test(type)) {
      const settings = widgets.find(value => typeof value === 'string' && /"(?:mode|enabled|selected)"\s*:/.test(value))
      inputs.router_settings = settings || raw.properties?.router_settings || raw.properties?.routerSettings || raw.properties?.tk_router_settings || inputs.router_settings
    }
    if (/danboorugallery/i.test(type)) {
      const selection = widgets.find(value => typeof value === 'string' && /"selections"\s*:/.test(value))
      if (selection) inputs.selection_data = selection
    }
    graph.set(String(raw.id), { id: String(raw.id), type, inputs, inputTypes, raw })
  }
  return graph
}

/** Resolve only the generation ancestry of one saved output. No UI/global state. */
export function parseGraphPrompt(workflow: unknown): GraphPromptResult {
  const graph = normalize(workflow)
  const warnings: string[] = []
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message) }
  const isSampler = (node: GraphNode) => !(node.type.toLowerCase() === 'ultimatesdupscale' && node.inputs.mode_type === 'None' && node.inputs.seam_fix_mode === 'None')
    && /sampler|upscal/i.test(node.type) && ('positive' in node.inputs || 'positive_cond' in node.inputs || 'guider' in node.inputs || 'conditioning' in node.inputs)
  const savers = [...graph.values()].filter(node => /saveimage/i.test(node.type) && node.raw.mode !== 2 && node.raw.mode !== 4 && Object.keys(node.inputs).some(key => IMAGE_INPUTS.has(key)))
  let imageAmbiguous = false
  const stages: GraphNode[] = []
  const visitedImages = new Set<string>()
  const activeImages = new Set<string>()
  function visitImage(node: GraphNode) {
    if (visitedImages.has(node.id)) return
    if (activeImages.has(node.id) || activeImages.size > 256) { warn('图片生成链包含循环或超过解析上限'); return }
    activeImages.add(node.id)
    const edges = Object.entries(node.inputs).filter(([name, value]) => ref(value) && (IMAGE_INPUTS.has(name) || ['IMAGE', 'LATENT'].includes(node.inputTypes[name])))
    const known = isSampler(node) || /saveimage/i.test(node.type) || new Set(['vaedecode', 'vaedecodetiled', 'vaeencode', 'vaeencodetiled', 'vaeencodeforinpaint', 'latentupscale', 'latentupscaleby', 'imagescale', 'imagescaleby', 'reroute', 'imageblend', 'imagecompositemasked', 'latentcomposite', 'latentcompositemasked', 'ultimatesdupscale']).has(node.type.toLowerCase())
    if (!known && edges.length > 1) {
      imageAmbiguous = true
      warn('无法确定图像分流节点的实际输入分支')
      activeImages.delete(node.id)
      visitedImages.add(node.id)
      return
    }
    if (!known && edges.length) warn('图像转换节点的运行期来源未完整记录：' + node.type)
    for (const [, value] of edges) {
      const source = ref(value)
      const upstream = source && graph.get(source.nodeId)
      if (upstream) visitImage(upstream)
      else warn('图片生成链引用不存在的节点')
    }
    activeImages.delete(node.id)
    visitedImages.add(node.id)
    if (isSampler(node)) stages.push(node)
  }
  if (savers.length > 1) return { prompt: '', negativePrompt: '', promptStages: [], promptStatus: 'ambiguous', promptWarnings: ['图片包含多个保存分支，未记录本图对应的保存节点'] }
  if (savers.length === 1) visitImage(savers[0])
  else {
    const samplers = [...graph.values()].filter(isSampler)
    if (samplers.length === 1) { visitImage(samplers[0]); warn('缺少保存节点，按唯一采样分支恢复文本') }
    else if (samplers.length > 1) return { prompt: '', negativePrompt: '', promptStages: [], promptStatus: 'ambiguous', promptWarnings: ['缺少保存节点，无法确定本图的采样分支'] }
  }

  function values(node: GraphNode, names: string[], role: 'positive' | 'negative', stack: Set<string>): string[] {
    return names.flatMap(name => text(node.inputs[name], role, stack))
  }
  let textSteps = 0
  const textMemo = new Map<string, string[]>()
  function text(value: unknown, role: 'positive' | 'negative', stack = new Set<string>()): string[] {
    if (typeof value === 'string') return value.trim() ? [value.trim()] : []
    const source = ref(value)
    if (!source) return []
    const node = graph.get(source.nodeId)
    if (!node) { warn('提示词连线引用不存在的节点'); return [] }
    const key = node.id + ':' + source.outputSlot + ':' + role
    const cached = textMemo.get(key)
    if (cached) return cached
    if (stack.has(key) || stack.size > 128 || textSteps++ > 4096) { warn('提示词连线包含循环或超过解析上限'); return [] }
    const next = new Set(stack).add(key)
    const result = dedup(nodeText(source, node, role, next))
    textMemo.set(key, result)
    return result
  }
  function nodeText(source: Ref, node: GraphNode, role: 'positive' | 'negative', next: Set<string>): string[] {
    const type = node.type.toLowerCase()
    // ── 运行期文本节点：保存值不是本次执行文本 ──
    // WD14Tagger.tags / easy showAnything.text 是前端显示缓存，实测（0423 实图）
    // 不含本次出图实际用到的角色词 → 用它会跨图污染。一律按"不可还原"处理。
    if (isRuntimeOnlyTextNode(node.type)) {
      warn('无法完整还原节点的运行期文本：' + node.type)
      return []
    }
    if (/^tk\s*prompt\s*cards$/.test(type)) {
      if (source.outputSlot === 2) { warn('LoRA 语法输出不属于提示词'); return [] }
      return [join(values(node, ['positive', 'opt_text'], role, next))]
    }
    if (type.includes('weilinpromptui')) {
      if ('negative' in node.inputs) return text(node.inputs[source.outputSlot === 1 ? 'negative' : 'positive'], role, next)
      if (source.outputSlot !== 0 && source.outputSlot !== 1) { warn('魏林节点的非文本输出无法还原为提示词'); return [] }
      if (node.inputs.auto_random) warn('魏林节点的随机文本未完整写入图片')
      let hasLora = false
      const positiveParts = text(node.inputs.positive, role, next).map(part => {
        try {
          const data = JSON.parse(part)
          if (data && typeof data === 'object' && !Array.isArray(data)) { hasLora ||= Boolean(data.lora?.length); return typeof data.prompt === 'string' ? data.prompt : '' }
          return part
        } catch { return part }
      })
      const combined = join([...text(node.inputs.opt_text, role, next), ...positiveParts])
      if (/<wlr:/.test(combined) || (node.inputs.lora_str || hasLora) && ref(node.inputs.opt_model)) warn('魏林 LoRA 触发词是运行期文本，图片未完整记录')
      return [combined.replace(/<wlr:[^>]*>/g, '').replace(/,\s*,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '')]

    }
    if (/tk\s*string\s*router/.test(type)) {
      let settings: any = {}
      try { settings = typeof node.inputs.router_settings === 'string' ? JSON.parse(node.inputs.router_settings) : node.inputs.router_settings || {} } catch { warn('路由器设置无效，按节点默认设置恢复') }
      const bool = (value: unknown) => typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : !['', '0', 'false', 'off', 'no', 'none'].includes(String(value).trim().toLowerCase())
      const enabled = Array.isArray(settings.enabled) ? Array.from({ length: 6 }, (_, index) => index < settings.enabled.length && bool(settings.enabled[index])) : [true, false, false, false, false, false]
      let selected = Math.trunc(Number(settings.selected ?? 0))
      if (!Number.isFinite(selected) || selected < 0 || selected >= 6) selected = 0
      const rawOrder = settings.order ?? settings.output_order
      const order: number[] = []
      if (Array.isArray(rawOrder)) for (const value of rawOrder) {
        const index = Math.trunc(Number(value))
        if (Number.isFinite(index) && index >= 0 && index < 6 && !order.includes(index)) order.push(index)
      }
      for (let index = 0; index < 6; index++) if (!order.includes(index)) order.push(index)
      const indices = settings.mode === 'multi' ? order.filter(index => enabled[index]) : enabled[selected] ? [selected] : []
      const separators: Record<string, string> = { '逗号 ,': ', ', '空格': ' ', '换行': '\n', '无': '' }
      const separatorName = String(node.inputs.separator || '逗号 ,')
      const separator = separators[separatorName] ?? ', '
      let combined = indices.map(index => join(text(node.inputs['string_' + (index + 1)], role, next))).filter(Boolean).join(separator)
      if (separatorName === '逗号 ,') combined = combined.replace(/\s*,\s*,+/g, ',').replace(/^[ ,]+|[ ,]+$/g, '')
      return combined ? [combined] : []
    }
    if (/controlnet.*apply|apply.*controlnet/.test(type) && ('positive' in node.inputs || 'negative' in node.inputs)) return text(node.inputs[source.outputSlot === 1 ? 'negative' : 'positive'], role, next)
    if (/cliptextencode/.test(type)) return values(node, ['text', 'text_g', 'text_l', 'clip_l', 't5xxl', 'clip_g'], role, next)
    if (type === 'conditioningcombine') return values(node, ['conditioning_1', 'conditioning_2'], role, next)
    if (type === 'conditioningconcat' || type === 'conditioningaverage') {
      const strength = Number(node.inputs.conditioning_to_strength ?? 0.5)
      if (type === 'conditioningaverage') {
        if (!Number.isFinite(strength)) warn('ConditioningAverage 权重未记录')
        if (strength >= 1) return text(node.inputs.conditioning_to, role, next)
      }
      const edge = ref(node.inputs.conditioning_from)
      const upstream = edge && graph.get(edge.nodeId)
      const upstreamType = upstream?.type.toLowerCase() || ''
      let source: string[]
      if (upstreamType === 'conditioningcombine') {
        warn('ConditioningConcat/Average 仅使用来源条件的首项')
        source = text(upstream!.inputs.conditioning_1, role, next)
      } else {
        source = text(node.inputs.conditioning_from, role, next)
        if (source.length > 1 && !/cliptextencode|weilinpromptui|tk\s*prompt\s*cards/.test(upstreamType)) warn('来源条件的分组未完整记录，无法确认首项全部文本')
      }
      if (type === 'conditioningaverage' && strength <= 0) return source
      return [...text(node.inputs.conditioning_to, role, next), ...source]
    }
    if (type === 'conditioningzeroout') { warn('ConditioningZeroOut 已清零文本条件'); return [] }
    if (/conditioning(?:setarea|setmask|settimesteprange)/.test(type)) return values(node, ['conditioning'], role, next)
    if (/^(?:primitive(?:string(?:multiline)?)?|string(?:constant|multiline)?|text(?:box|input|multiline)?|multiline)$/.test(type)) return values(node, ['value', 'string', 'text', 'content', 'contents'], role, next)
    if (/^(?:reroute|conditioningreroute)$/.test(type)) return values(node, Object.keys(node.inputs), role, next)
    if (/^(?:tk text join|animatextjoin|join[ _]?strings|text[ _]?(?:concatenate|concat|combine|join)|string[ _]?(?:concatenate|concat|combine|join))/.test(type)) {
      const parts = values(node, ['text_a', 'text_b', 'text_c', 'text_d', 'text1', 'text2', 'text_1', 'text_2', 'string_a', 'string_b', 'string_1', 'string_2'].filter(name => name in node.inputs), role, next)
      const separatorValue = typeof node.inputs.separator === 'string' ? node.inputs.separator : typeof node.inputs.delimiter === 'string' ? node.inputs.delimiter : ', '
      const separator = ({ '逗号 ,': ', ', '空格': ' ', '换行': '\n', '无': '' } as Record<string, string>)[separatorValue] ?? separatorValue
      const result = dedup(parts).join(separator)
      return result ? [result] : []
    }
    if (/danboorugallery/.test(type)) {
      if (source.outputSlot !== 1) { warn('图库非提示词输出无法还原为文本'); return [] }
      let selection: any = {}
      try { selection = JSON.parse(String(node.inputs.selection_data || '{}')) } catch { /* invalid selection is treated as unavailable */ }
      if (selection?.prompt_output_enabled === false) return []
      if (!Array.isArray(selection?.selections) || selection.selections.length !== 1) { warn('图库批量文本缺少本图的运行期选择索引'); return [] }
      return [join([selection.role_prompt, selection.selections[0]?.prompt].filter(value => typeof value === 'string'))]
    }
    if (/guider/.test(type)) return values(node, role === 'negative' ? ['negative'] : ['positive', 'conditioning'], role, next)
    // Unknown text transforms expose only confirmed input fragments; never infer
    // runtime output or traverse model/CLIP/image/configuration branches.
    warn('无法完整还原节点的运行期文本：' + node.type)
    const names = Object.keys(node.inputs).filter(name => (TEXT_INPUT.test(name) || ['natural_language', 'text_g', 'text_l', 'clip_l', 'clip_g', 't5xxl'].includes(name) || /^conditioning(?:_|$)/i.test(name)) && (!['positive', 'negative'].includes(name) || name === role))
    return values(node, names, role, next)
  }
  if (imageAmbiguous) return { prompt: '', negativePrompt: '', promptStages: [], promptStatus: 'ambiguous', promptWarnings: warnings }
  const promptStages: PromptStage[] = stages.map((node, index) => {
    const positive = node.inputs.positive ?? node.inputs.positive_cond ?? node.inputs.guider ?? node.inputs.conditioning
    const negative = node.inputs.negative ?? node.inputs.negative_cond ?? (node.inputs.guider ? node.inputs.guider : undefined)
    const prompt = join(text(positive, 'positive'))
    const negativePrompt = join(text(negative, 'negative'))
    if (!prompt) warn('无法恢复采样阶段的正面提示词：' + node.id)
    return { nodeId: node.id, label: String(node.raw.title || node.type), prompt, negativePrompt }
  })
  const prompt = join(promptStages.map(stage => stage.prompt))
  const negativePrompt = join(promptStages.map(stage => stage.negativePrompt))
  const promptStatus: PromptStatus = warnings.length ? 'partial' : prompt ? 'complete' : 'missing'
  return { prompt, negativePrompt, promptStages, promptStatus, promptWarnings: warnings, samplerInputs: stages[stages.length - 1]?.inputs }
}
