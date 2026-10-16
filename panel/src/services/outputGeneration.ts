import { normalizeOutputGraph, isImageSaveType, type GraphNode, type Ref } from './outputGraph'

export interface LoraGenerationDetail {
  name: string
  strengthModel: number | null
  strengthClip: number | null
  enabled: boolean
  nodeId: string
  /** Nonzero channel on the selected dependency branch; not proof of successful loading. */
  active: boolean | null
}

export interface GenerationStage {
  nodeId: string
  label: string
  steps: string
  cfg: string
  seed: string
  noiseSeed?: string
  sampler: string
  scheduler: string
  denoise: string
  startAtStep?: string
  endAtStep?: string
  addNoise?: string
  returnWithLeftoverNoise?: string
  /** Scheduled sigma intervals, not measured runtime evaluations. */
  effectiveSteps?: number
  active: boolean | null
}

export interface GenerationDetails {
  checkpoints: string[]
  textEncoders: string[]
  vaes: string[]
  loraDetails: LoraGenerationDetail[]
  generationStages: GenerationStage[]
  generationStatus: 'complete' | 'partial' | 'ambiguous' | 'missing'
  generationScope: 'output' | 'recorded'
  generationOutputNodeId: string | null
  generationWarnings: string[]
}

type Graph = Map<string, GraphNode>
type ResourceKind = 'MODEL' | 'CLIP' | 'VAE' | 'CONDITIONING' | 'GUIDER' | 'SIGMAS' | 'SAMPLER' | 'NOISE'
const IMAGE_KEYS = new Set(['images', 'image', 'samples', 'latent', 'latent_image', 'pixels', 'input_image', 'image_a', 'image_b', 'image1', 'image2', 'image_1', 'image_2', 'latents'])
const ROLES: Record<string, ResourceKind> = {
  model: 'MODEL', model1: 'MODEL', model2: 'MODEL', clip: 'CLIP', vae: 'VAE', positive: 'CONDITIONING', negative: 'CONDITIONING',
  positive_cond: 'CONDITIONING', negative_cond: 'CONDITIONING', conditioning: 'CONDITIONING', conditioning_1: 'CONDITIONING',
  conditioning_2: 'CONDITIONING', conditioning_to: 'CONDITIONING', conditioning_from: 'CONDITIONING',
  guider: 'GUIDER', sigmas: 'SIGMAS', sampler: 'SAMPLER', noise: 'NOISE',
}
const RESOURCE_KINDS = new Set<string>(Object.values(ROLES))
const SAMPLERS = new Set(['ksampler', 'ksampleradvanced', 'samplercustom', 'samplercustomadvanced'])
const LORA_TYPES = new Set(['loraloader', 'loraloadermodelonly', 'tk batch lora loader', 'animabatchloraloader'])
const KNOWN_IMAGE = new Set(['vaedecode', 'vaedecodetiled', 'vaeencode', 'vaeencodetiled', 'vaeencodeforinpaint', 'latentupscale', 'latentupscaleby', 'imagescale', 'imagescaleby', 'reroute', 'loadimage'])
const KNOWN_RESOURCE = new Set(['basicguider', 'cfgguider', 'basicscheduler', 'ksamplerselect', 'randomnoise', 'disablenoise', 'conditioningcombine', 'conditioningconcat', 'conditioningaverage', 'conditioningsetarea', 'conditioningsetareapercentage', 'conditioningsettimesteprange', 'conditioningsetmask'])
// Positional UI contracts verified against official ComfyUI nodes and this plugin.
// API graph fields always remain authoritative. No node registry or user state is read.
const WIDGETS: Record<string, string[]> = {
  checkpointloadersimple: ['ckpt_name'], checkpointloader: ['config_name', 'ckpt_name'], unetloader: ['unet_name', 'weight_dtype'],
  diffusersloader: ['model_path'], cliploader: ['clip_name', 'type', 'device'], dualcliploader: ['clip_name1', 'clip_name2', 'type', 'device'],
  triplecliploader: ['clip_name1', 'clip_name2', 'clip_name3'], vaeloader: ['vae_name'],
  loraloader: ['lora_name', 'strength_model', 'strength_clip'], loraloadermodelonly: ['lora_name', 'strength_model'],
  'tk batch lora loader': ['lora_syntax', 'output_trigger_words'], animabatchloraloader: ['lora_syntax', 'output_trigger_words'],
  ksampler: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  ksampleradvanced: ['add_noise', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
  samplercustom: ['add_noise', 'noise_seed', 'cfg'], cfgguider: ['cfg'], basicscheduler: ['scheduler', 'steps', 'denoise'],
  ksamplerselect: ['sampler_name'], randomnoise: ['noise_seed'],
}

const reference = (value: unknown): Ref | null => Array.isArray(value) && value.length === 2 && ['string', 'number'].includes(typeof value[0]) && Number.isInteger(value[1])
  ? { nodeId: String(value[0]), outputSlot: value[1] } : null
// Python float (used by the saved TK syntax) accepts decimal/exponent strings,
// not Number()'s hexadecimal, binary or octal prefixes. Keep unknown weights null.
const DECIMAL = /^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:e[+-]?[0-9](?:_?[0-9])*)?$/i
const numeric = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !DECIMAL.test(value.trim()))) return null
  const number = Number(typeof value === 'string' ? value.trim().replace(/_/g, '') : value)
  return Number.isFinite(number) ? number : null
}
const integer = (value: unknown): number | null => { const number = numeric(value); return number !== null && number >= 0 && Number.isSafeInteger(number) ? number : null }
const text = (value: unknown): string => typeof value === 'boolean' ? String(value) : typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
const isStage = (node: GraphNode): boolean => SAMPLERS.has(node.type.toLowerCase()) || /sampler/i.test(node.type) && ['positive', 'positive_cond', 'guider', 'conditioning'].some(name => name in node.inputs)
const disabledName = (value: string) => value.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

function generationGraph(workflow: unknown): Graph {
  const graph = normalizeOutputGraph(workflow)
  for (const node of graph.values()) {
    const widgets = node.raw.widgets_values
    if (!Array.isArray(node.raw.inputs) || !Array.isArray(widgets)) continue
    let names = WIDGETS[node.type.toLowerCase()] || []
    const controlIndex = /^KSampler$/i.test(node.type) ? 1 : /^(KSamplerAdvanced|SamplerCustom)$/i.test(node.type) ? 2 : null
    if (controlIndex !== null && ['fixed', 'increment', 'decrement', 'randomize'].includes(widgets[controlIndex])) names = [...names.slice(0, controlIndex), 'control_after_generate', ...names.slice(controlIndex)]
    const explicit = new Map<string, unknown>()
    for (const input of node.raw.inputs) if (input && typeof input === 'object' && input.widget && typeof input.widget === 'object' && ('value' in input.widget || 'value' in input)) {
      explicit.set(String(input.widget.name || input.name), 'value' in input.widget ? input.widget.value : input.value)
    }
    names.forEach((name, index) => { if (!reference(node.inputs[name]) && index < widgets.length) node.inputs[name] = explicit.has(name) ? explicit.get(name) : widgets[index] })
  }
  return graph
}

/** Same conservative IMAGE/LATENT spine as services.output_metadata.image_dependency_nodes. */
function imageSpine(graph: Graph, rootId: string): { nodes: Set<string>; warnings: string[] } {
  const root = graph.get(rootId)
  if (!root || !['images', 'image'].some(key => reference(root.inputs[key]))) return { nodes: new Set(), warnings: ['保存节点未提供可核验的图像输入'] }
  const visited = new Set<string>(), active = new Set<string>(), warnings: string[] = []
  function visit(nodeId: string) {
    if (active.has(nodeId)) { warnings.push('图像依赖包含循环'); return }
    if (visited.has(nodeId)) return
    if (visited.size >= 4096 || active.size >= 256) { warnings.push('图像依赖超过解析上限'); return }
    const node = graph.get(nodeId)
    if (!node) { warnings.push('图像依赖引用缺失节点'); return }
    visited.add(nodeId)
    const edges = Object.entries(node.inputs).flatMap(([name, value]) => {
      const edge = reference(value)
      return edge && (IMAGE_KEYS.has(name) || ['IMAGE', 'LATENT'].includes(node.inputTypes[name])) ? [edge] : []
    })
    if (edges.length > 1) { warnings.push('未记录图像分流的实际选择；更早阶段未补猜'); return }
    active.add(nodeId)
    for (const edge of edges) visit(edge.nodeId)
    active.delete(nodeId)
  }
  visit(rootId)
  return { nodes: visited, warnings: [...new Set(warnings)].slice(0, 64) }
}

class GenerationParser {
  readonly warnings: string[] = []
  ambiguous = false
  readonly files = { checkpoints: [] as string[], textEncoders: [] as string[], vaes: [] as string[] }
  readonly loras = new Map<string, LoraGenerationDetail>()
  private loraUnknownActive = new Set<string>()
  private resourceSeen = new Set<string>()
  private resourceActive = new Set<string>()
  constructor(readonly graph: Graph) {}
  warn(message: string) { if (!this.warnings.includes(message) && this.warnings.length < 64) this.warnings.push(message) }

  field(node: GraphNode | undefined, key: string, stack: string[] = []): unknown {
    if (!node) return undefined
    const edge = reference(node.inputs[key])
    if (!edge) return node.inputs[key]
    const source = this.graph.get(edge.nodeId)
    if (!source || stack.includes(edge.nodeId) || stack.length >= 128) { this.warn(`生成参数 ${node.id}.${key} 的来源缺失或包含循环`); return undefined }
    const kind = source.type.toLowerCase()
    if (kind.includes('primitive') || ['string', 'stringconstant', 'string constant', 'string literal'].includes(kind)) return edge.outputSlot === 0 ? this.field(source, 'value', [...stack, edge.nodeId]) : undefined
    const refs = Object.entries(source.inputs).filter(([, value]) => reference(value))
    if (kind === 'reroute' && refs.length === 1) return this.field(source, refs[0][0], [...stack, edge.nodeId])
    this.warn(`生成参数 ${node.id}.${key} 的运行期变换未记录`)
    return undefined
  }

  provider(node: GraphNode, key: string, allowed: string[]): GraphNode | undefined {
    let edge = reference(node.inputs[key])
    const seen = new Set<string>()
    while (edge && !seen.has(edge.nodeId)) {
      seen.add(edge.nodeId)
      const source = this.graph.get(edge.nodeId)
      if (source && allowed.includes(source.type.toLowerCase()) && edge.outputSlot === 0) return source
      const refs = source && Object.values(source.inputs).map(reference).filter((value): value is Ref => value !== null)
      if (source && source.type.toLowerCase() === 'reroute' && refs?.length === 1) edge = refs[0]
      else break
    }
    return undefined
  }

  stage(node: GraphNode, active: boolean | null): GenerationStage {
    const kind = node.type.toLowerCase()
    const stage: GenerationStage = { nodeId: node.id, label: String(node.raw.title || node.raw._meta?.title || node.type), steps: '', cfg: '', seed: '', sampler: '', scheduler: '', denoise: '', active }
    for (const [output, key] of [['steps', 'steps'], ['cfg', 'cfg'], ['seed', 'seed'], ['sampler', 'sampler_name'], ['scheduler', 'scheduler'], ['denoise', 'denoise']] as const) stage[output] = text(this.field(node, key))
    let noiseSeed = this.field(node, 'noise_seed')
    if (kind === 'samplercustom' || kind === 'samplercustomadvanced') {
      const scheduler = this.provider(node, 'sigmas', ['basicscheduler']), sampler = this.provider(node, 'sampler', ['ksamplerselect'])
      if (scheduler) for (const [output, key] of [['steps', 'steps'], ['scheduler', 'scheduler'], ['denoise', 'denoise']] as const) stage[output] = text(this.field(scheduler, key))
      if (sampler) stage.sampler = text(this.field(sampler, 'sampler_name'))
      if (kind === 'samplercustomadvanced') {
        const guider = this.provider(node, 'guider', ['cfgguider', 'basicguider']), noise = this.provider(node, 'noise', ['randomnoise', 'disablenoise'])
        if (guider) stage.cfg = guider.type.toLowerCase() === 'basicguider' ? '1' : text(this.field(guider, 'cfg'))
        if (noise) noiseSeed = noise.type.toLowerCase() === 'randomnoise' ? this.field(noise, 'noise_seed') : 0
      }
      if (!scheduler || !sampler) this.warn(`采样阶段 ${node.id} 的自定义采样器或 sigma 序列未完整记录`)
    }
    if (noiseSeed !== undefined && noiseSeed !== null) stage.noiseSeed = stage.seed = text(noiseSeed)
    if (kind === 'ksampleradvanced') {
      stage.denoise ||= '1'
      for (const [output, key] of [['startAtStep', 'start_at_step'], ['endAtStep', 'end_at_step'], ['addNoise', 'add_noise'], ['returnWithLeftoverNoise', 'return_with_leftover_noise']] as const) stage[output] = text(this.field(node, key))
    } else if ('add_noise' in node.inputs) stage.addNoise = text(this.field(node, 'add_noise'))
    const rawSeed = noiseSeed ?? this.field(node, 'seed')
    if (typeof rawSeed === 'number' && Number.isInteger(rawSeed) && !Number.isSafeInteger(rawSeed)) {
      stage.seed = ''
      if (stage.noiseSeed !== undefined) stage.noiseSeed = ''
      this.warn(`采样阶段 ${node.id} 的 seed 超出浏览器精确整数范围；需要原始字符串记录`)
    }
    const steps = integer(stage.steps), denoise = numeric(stage.denoise)
    if (steps !== null && denoise !== null && SAMPLERS.has(kind)) {
      let effective: number | null = denoise <= 0 ? 0 : steps
      if (kind === 'ksampleradvanced') {
        const start = integer(stage.startAtStep), end = integer(stage.endAtStep)
        if (start === null || end === null) { effective = null; this.warn(`采样阶段 ${node.id} 的开始或结束步数未完整记录`) }
        else effective = denoise > 0 ? Math.max(0, Math.min(steps, end) - start) : 0
      }
      if (effective !== null) stage.effectiveSteps = effective
    }
    for (const field of ['steps', 'cfg', 'seed', 'sampler', 'scheduler', 'denoise'] as const) if (!stage[field]) this.warn(`采样阶段 ${node.id} 的 ${field} 未完整记录`)
    if (!SAMPLERS.has(kind)) this.warn(`采样阶段 ${node.id} 的扩展节点语义未完整识别；保留已记录参数`)
    return stage
  }

  file(node: GraphNode, key: string, target: keyof GenerationParser['files']) {
    const value = this.field(node, key)
    if (typeof value === 'string' && value.trim()) { if (!this.files[target].includes(value.trim())) this.files[target].push(value.trim()) }
    else this.warn(`资源节点 ${node.id} 的 ${key} 未完整记录`)
  }

  loraEntries(node: GraphNode): Array<[string, number | null, number | null]> {
    const kind = node.type.toLowerCase()
    if (kind === 'tk batch lora loader' || kind === 'animabatchloraloader') {
      const syntax = this.field(node, 'lora_syntax')
      if (typeof syntax !== 'string' || !syntax.trim()) { this.warn(`LoRA 节点 ${node.id} 使用运行期 bridge，图片未记录其实际列表`); return [] }
      const entries: Array<[string, number, number]> = []
      for (const match of syntax.matchAll(/<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>/gi)) {
        const model = numeric(match[2]), clip = numeric(match[3] ?? match[2])
        if (model === null || clip === null) { this.warn(`LoRA 节点 ${node.id} 含无效权重，未推测其加载状态`); continue }
        entries.push([match[1].trim(), model, clip])
      }
      return entries
    }
    const name = this.field(node, 'lora_name')
    if (typeof name !== 'string' || !name.trim()) { this.warn(`LoRA 节点 ${node.id} 的名称未完整记录`); return [] }
    const model = numeric(this.field(node, 'strength_model')), clip = kind === 'loraloadermodelonly' ? 0 : numeric(this.field(node, 'strength_clip'))
    if (model === null || clip === null) this.warn(`LoRA 节点 ${node.id} 的权重未完整记录`)
    return [[name.trim(), model, clip]]
  }

  addLoras(node: GraphNode, role: ResourceKind, outputOwned: boolean) {
    const map = node.raw.properties?.animaLoraDisabled
    const disabled = new Set(map && typeof map === 'object' && !Array.isArray(map) ? Object.keys(map).map(disabledName) : [])
    this.loraEntries(node).forEach(([name, model, clip], index) => {
      const key = JSON.stringify([node.id, index]), enabled = ![2, 4].includes(node.raw.mode) && !disabled.has(disabledName(name)) && !(model === 0 && clip === 0)
      let row = this.loras.get(key)
      if (!row) { row = { name, strengthModel: model, strengthClip: clip, enabled, nodeId: node.id, active: enabled ? null : false }; this.loras.set(key, row) }
      if (outputOwned && enabled) {
        const weight = role === 'MODEL' ? model : clip
        if (weight === null) this.loraUnknownActive.add(key)
        else if (weight !== 0) row.active = true
        if (row.active !== true) row.active = this.loraUnknownActive.has(key) ? null : false
      }
    })
  }

  resource(edge: Ref, role: ResourceKind, outputOwned: boolean) {
    const { nodeId, outputSlot: slot } = edge, key = JSON.stringify([nodeId, slot, role])
    if (this.resourceSeen.has(key)) return
    if (this.resourceActive.has(key) || this.resourceActive.size >= 256 || this.resourceSeen.size >= 4096) { this.warn('生成资源依赖包含循环或超过解析上限'); return }
    const node = this.graph.get(nodeId)
    if (!node) { this.warn(`生成资源依赖引用缺失节点 ${nodeId}`); return }
    this.resourceActive.add(key)
    const kind = node.type.toLowerCase()
    if (['checkpointloadersimple', 'checkpointloader', 'diffusersloader'].includes(kind)) {
      const targets = [['MODEL', 'checkpoints'], ['CLIP', 'textEncoders'], ['VAE', 'vaes']] as const
      const target = targets[slot]
      if (target && role === target[0]) this.file(node, kind === 'diffusersloader' ? 'model_path' : 'ckpt_name', target[1])
      else this.warn(`Checkpoint 节点 ${nodeId} 的输出槽与资源类型不匹配`)
    } else if (kind === 'unetloader' && role === 'MODEL' && slot === 0) this.file(node, 'unet_name', 'checkpoints')
    else if (['cliploader', 'dualcliploader', 'triplecliploader'].includes(kind) && role === 'CLIP' && slot === 0) {
      const fields = kind === 'cliploader' ? ['clip_name'] : kind === 'dualcliploader' ? ['clip_name1', 'clip_name2'] : ['clip_name1', 'clip_name2', 'clip_name3']
      for (const field of fields) this.file(node, field, 'textEncoders')
    } else if (kind === 'vaeloader' && role === 'VAE' && slot === 0) this.file(node, 'vae_name', 'vaes')
    else if (LORA_TYPES.has(kind) && ['MODEL', 'CLIP'].includes(role)) {
      const expected = slot === 0 ? 'MODEL' : slot === 1 && kind !== 'loraloadermodelonly' ? 'CLIP' : null
      if (expected !== role) this.warn(`LoRA 节点 ${nodeId} 的输出槽与资源类型不匹配`)
      else {
        const input = role === 'MODEL' ? 'model' : 'clip', source = reference(node.inputs[input])
        if (source) this.resource(source, role, outputOwned)
        else this.warn(`LoRA 节点 ${nodeId} 缺少 ${input} 资源输入`)
        this.addLoras(node, role, outputOwned)
      }
    } else {
      let edges = this.resourceEdges(node)
      const refs = Object.values(node.inputs).map(reference).filter((value): value is Ref => value !== null)
      if (kind === 'reroute' && refs.length === 1) edges = [[refs[0], role]]
      const same = edges.filter(([, candidate]) => candidate === role), known = KNOWN_RESOURCE.has(kind) || kind.includes('cliptextencode')
      if (same.length > 1 && ['MODEL', 'CLIP', 'VAE'].includes(role)) { this.ambiguous = true; this.warn(`资源节点 ${nodeId} 的实际选择未记录；仅保留记录配置`) }
      else if (!known && kind !== 'reroute' && edges.length) this.warn(`资源变换节点 ${nodeId} 未完整识别；保留可核验输入配置`)
      else if (!edges.length && ['MODEL', 'CLIP', 'VAE'].includes(role)) this.warn(`资源节点 ${nodeId}（${node.type}）的来源未完整识别`)
      for (const [source, candidate] of edges) this.resource(source, candidate, outputOwned)
    }
    this.resourceActive.delete(key)
    this.resourceSeen.add(key)
  }

  resourceEdges(node: GraphNode): Array<[Ref, ResourceKind]> {
    return Object.entries(node.inputs).flatMap(([name, value]) => {
      const edge = reference(value), kind = ROLES[name] || node.inputTypes[name]
      return edge && RESOURCE_KINDS.has(kind) ? [[edge, kind as ResourceKind]] : []
    })
  }
  dependencies(node: GraphNode, outputOwned: boolean) { for (const [edge, role] of this.resourceEdges(node)) this.resource(edge, role, outputOwned) }
  recorded() {
    for (const node of this.graph.values()) {
      const kind = node.type.toLowerCase()
      if (['checkpointloadersimple', 'checkpointloader', 'diffusersloader'].includes(kind)) ['MODEL', 'CLIP', 'VAE'].forEach((role, slot) => this.resource({ nodeId: node.id, outputSlot: slot }, role as ResourceKind, false))
      else if (['unetloader', 'cliploader', 'dualcliploader', 'triplecliploader', 'vaeloader'].includes(kind)) this.resource({ nodeId: node.id, outputSlot: 0 }, kind === 'unetloader' ? 'MODEL' : kind === 'vaeloader' ? 'VAE' : 'CLIP', false)
      else if (LORA_TYPES.has(kind)) this.addLoras(node, 'MODEL', false)
      if (isStage(node)) this.dependencies(node, false)
    }
  }
}

/** Never executes nodes or selects a first/longest branch when ownership is unknown. */
export function parseGenerationDetails(workflow: unknown, outputNodeId?: string | number | null): GenerationDetails {
  const graph = generationGraph(workflow), parser = new GenerationParser(graph)
  const result: GenerationDetails = { ...parser.files, loraDetails: [], generationStages: [], generationStatus: 'missing', generationScope: 'recorded', generationOutputNodeId: null, generationWarnings: [] }
  const saves = [...graph.values()].filter(node => isImageSaveType(node.type) && ![2, 4].includes(node.raw.mode) && ['images', 'image'].some(key => reference(node.inputs[key]))).map(node => node.id)
  const root = outputNodeId !== undefined && outputNodeId !== null ? String(outputNodeId) : saves.length === 1 ? saves[0] : null
  if (outputNodeId !== undefined && outputNodeId !== null && (!root || !saves.includes(root))) { result.generationWarnings = ['图片的保存节点标识不存在']; return result }
  if (!graph.size) return result
  let stages: GenerationStage[] = []
  if (root) {
    const spine = imageSpine(graph, root)
    for (const warning of spine.warnings) parser.warn(warning)
    parser.ambiguous = spine.warnings.some(warning => warning.includes('分流'))
    if (!parser.ambiguous) {
      const visited = new Set<string>()
      function visit(nodeId: string) {
        if (visited.has(nodeId) || !spine.nodes.has(nodeId)) return
        visited.add(nodeId)
        const node = graph.get(nodeId)!
        for (const [name, value] of Object.entries(node.inputs)) { const edge = reference(value); if (edge && (IMAGE_KEYS.has(name) || ['IMAGE', 'LATENT'].includes(node.inputTypes[name]))) visit(edge.nodeId) }
        if (isStage(node)) stages.push(parser.stage(node, true))
        else if (Object.values(node.inputs).some(value => reference(value)) && !KNOWN_IMAGE.has(node.type.toLowerCase()) && !isImageSaveType(node.type)) parser.warn(`图像变换节点 ${nodeId} 未完整识别；保留可核验输入配置`)
        parser.dependencies(node, true)
      }
      visit(root)
      result.generationScope = 'output'
      result.generationOutputNodeId = root
      // Incomplete saved graphs may omit all resource links. Match Python's
      // recorded-file fallback only when no file or LoRA was resolved.
      if (!Object.values(parser.files).some(files => files.length) && !parser.loras.size) {
        parser.recorded()
        if (stages.length || Object.values(parser.files).some(files => files.length) || parser.loras.size) parser.warn('模型连线未保存；补充资源仅为工作流记录配置，未核验用于本图')
      }
    }
  } else {
    parser.ambiguous = saves.length > 1 || [...graph.values()].filter(isStage).length > 1
    parser.warn(saves.length > 1 ? '图片包含多个保存分支，未记录对应保存节点；仅列记录配置' : '缺少保存节点，无法核验本图所属分支；仅列记录配置')
  }
  if (parser.ambiguous || !root) {
    parser.recorded()
    stages = [...graph.values()].filter(node => isStage(node) && ![2, 4].includes(node.raw.mode)).map(node => parser.stage(node, null))
    result.generationScope = 'recorded'
    result.generationOutputNodeId = null
    if (parser.ambiguous) { parser.warn('输出归属不确定；以上内容仅为记录配置，不代表本图实际使用'); for (const row of parser.loras.values()) row.active = row.enabled ? null : false }
  }
  result.loraDetails = [...parser.loras.values()]
  result.generationStages = stages
  result.generationWarnings = parser.warnings
  const hasData = Boolean(stages.length || result.loraDetails.length || Object.values(parser.files).some(files => files.length))
  result.generationStatus = parser.ambiguous ? 'ambiguous' : !hasData ? 'missing' : parser.warnings.length ? 'partial' : 'complete'
  return result
}
