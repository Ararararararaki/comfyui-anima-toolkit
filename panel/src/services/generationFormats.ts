/** Saved generator records, independent from container and ComfyUI graph parsing.
 * Field contracts were checked against official A1111 infotext/LoRA loaders,
 * Fooocus 2.5.5, NovelAI metadata 3428907a, and InvokeAI's metadata/save/import
 * implementations. No generator code is imported or executed. The caller keeps
 * its original raw record; normalization only exposes confirmed envelopes.
 */
import { parseMetadataJSON } from './metadataJSON'
import type { OutputGenerationDetails, PromptStage, PromptStatus } from '../types/outputs'

type JSONObject = Record<string, any>
type Source = 'a1111' | 'fooocus' | 'novelai' | 'invokeai'
export interface SavedGenerationFields extends OutputGenerationDetails {
  model: string
  vae: string
  seed: string
  steps: string
  cfg: string
  sampler: string
  scheduler: string
  denoise: string
  noiseSeed: string
  clipSkip: number
  prompt: string
  negativePrompt: string
  promptStages: PromptStage[]
  promptStatus: PromptStatus
  promptWarnings: string[]
  loras: string[]
  hasWorkflow: boolean
  hasPrompt: boolean
  metadataSource: Source
  generationScope: 'recorded'
  generationOutputNodeId: null
}

const NODE_ID = 'saved-parameters'
const LABELS: Record<Source, string> = { a1111: 'A1111', fooocus: 'Fooocus', novelai: 'NovelAI', invokeai: 'InvokeAI' }
const A1111_FIELDS: Record<string, string> = {
  Model: 'model', VAE: 'vae', Seed: 'seed', Steps: 'steps', 'CFG scale': 'cfg', Sampler: 'sampler',
  'Schedule type': 'scheduler', Scheduler: 'scheduler', 'Denoising strength': 'denoise', 'Noise seed': 'noiseSeed',
}
const A1111_ROW_KEYS = new Set([...Object.keys(A1111_FIELDS), 'Size', 'Clip skip', 'Model hash', 'VAE hash', 'Lora hashes', 'Lora weights', 'Version',
  'Hires steps', 'Hires upscale steps', 'Hires sampler', 'Hires schedule type', 'Hires CFG Scale', 'Hires CFG scale', 'Hires prompt',
  'Hires negative prompt', 'Hires upscale', 'Hires upscaler', 'Hires resize', 'Refiner', 'Refiner switch at', 'RNG', 'ENSD', 'Eta',
  'Variation seed', 'Variation seed strength', 'Seed resize from', 'Face restoration'])
const loraTags = (value: string) => value.matchAll(/<lora:([^:>]+)(?::([^>]*))?>/gi)
const object = (value: any): value is JSONObject => !!value && typeof value === 'object' && !Array.isArray(value)
function json(value: any): JSONObject | null {
  const parsed = typeof value === 'string' ? parseMetadataJSON(value) : value
  return object(parsed) ? parsed : null
}
function scalar(value: any): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}
function text(value: any): string {
  return typeof value === 'string' ? value : Array.isArray(value) && value.every(part => typeof part === 'string') ? value.join('\n') : ''
}
function name(value: any): string {
  if (!object(value)) return scalar(value)
  for (const key of ['name', 'model_name', 'filename']) if (typeof value[key] === 'string' && value[key]) return value[key]
  return ''
}
function weight(value: any): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && !/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(value)) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
function pick(data: JSONObject, ...keys: string[]): any {
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(data, key) && data[key] != null) return data[key]
  return null
}
function isFooocus(data: JSONObject | null): data is JSONObject {
  if (!data) return false
  const hasPrompt = ['prompt', 'full_prompt', 'Prompt'].some(key => typeof data[key] === 'string' || Array.isArray(data[key]))
  const product = scalar(pick(data, 'version', 'Version', 'Software')).toLowerCase()
  return hasPrompt && ('base_model' in data || 'Base Model' in data || product.includes('fooocus'))
}
function legacyFooocus(value: any): JSONObject | null {
  if (typeof value !== 'string') return null
  const labels: Record<string, string> = { Prompt: 'prompt', Negative: 'negative_prompt', 'Negative prompt': 'negative_prompt',
    Model: 'base_model', Seed: 'seed', Steps: 'steps', CFG: 'guidance_scale', Sampler: 'sampler', Scheduler: 'scheduler', VAE: 'vae',
    'Clip skip': 'clip_skip', 'Denoising strength': 'denoise', 'Noise seed': 'noise_seed' }
  const data: JSONObject = Object.create(null)
  let current: string | null = null
  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    const separator = line.indexOf(':'), label = line.slice(0, separator)
    const target = separator >= 0 && Object.prototype.hasOwnProperty.call(labels, label) ? labels[label] : null
    if (target) { data[target] = line.slice(separator + 1).trim(); current = ['prompt', 'negative_prompt'].includes(target) ? target : null }
    else if (current) data[current] += '\n' + line
  }
  if (!('prompt' in data) || !['base_model', 'seed', 'steps', 'guidance_scale', 'sampler', 'vae'].some(key => key in data)) return null
  data.version = 'legacy-fooocus'
  return data
}
function naiComment(data: JSONObject | null): JSONObject | null {
  for (let index = 0; index < 4; index++) {
    if (!data) return null
    if (!('Comment' in data)) return data
    data = json(data.Comment)
  }
  return null
}
function isNAI(data: JSONObject | null, raw: JSONObject): data is JSONObject {
  if (!data) return false
  const product = ['Software', 'Source'].map(key => scalar(raw[key])).join(' ').toLowerCase()
  const hasConfig = 'sampler' in data && ['steps', 'scale', 'seed'].some(key => key in data)
  return hasConfig && (product.includes('novelai') || ['uc', 'sampler', 'scale', 'seed'].every(key => key in data))
}
function isInvoke(data: JSONObject | null): data is JSONObject {
  return !!data && ['positive_prompt', 'negative_prompt', 'positive_conditioning', 'negative_conditioning',
    'generation_mode', 'cfg_scale', 'model', 'scheduler'].some(key => key in data)
}
function isComfy(value: JSONObject | null): boolean {
  if (!value) return false
  if (Array.isArray(value.nodes)) return true
  const nodes = Object.values(value)
  return !!nodes.length && nodes.every(node => object(node) && typeof node.class_type === 'string' && object(node.inputs))
}

function parameterPairs(line: string, strict = false): Record<string, string> | null {
  const parts: string[] = []
  let start = 0, quoted = false, escaped = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (escaped) escaped = false
    else if (char === '\\' && quoted) escaped = true
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { parts.push(line.slice(start, index)); start = index + 1 }
  }
  if (quoted) return null
  parts.push(line.slice(start))
  const result: Record<string, string> = Object.create(null)
  for (const part of parts) {
    const separator = part.indexOf(':')
    if (separator < 0) { if (strict && part.trim()) return null; continue }
    const key = part.slice(0, separator).trim()
    let value = part.slice(separator + 1).trim()
    if (value.startsWith('"')) {
      const decoded = parseMetadataJSON(value)
      if (typeof decoded !== 'string') return null
      value = decoded
    }
    result[key] = value
  }
  return result
}
function a1111(value: any): { positive: string; negative: string; settings: Record<string, string> } | null {
  if (typeof value !== 'string') return null
  const lines = value.replace(/\r\n/g, '\n').trim().split('\n')
  let settings = parameterPairs(lines[lines.length - 1] || ''), parameterStart = lines.length - 1
  const confirmed = (pairs: Record<string, string> | null): pairs is Record<string, string> =>
    !!pairs && /^\d+$/.test(pairs.Steps || '') && ['Sampler', 'CFG scale', 'Seed', 'Size'].some(key => key in pairs)
  if (!confirmed(settings)) {
    settings = null
    const suffix: Record<string, string>[] = []
    for (let index = lines.length - 1; index >= 0; index--) {
      const row = parameterPairs(lines[index].trim(), true)
      if (!row || !Object.keys(row).length || !Object.keys(row).every(key => A1111_ROW_KEYS.has(key))) break
      suffix.unshift(row)
      if ('Steps' in row) {
        const candidate = Object.assign(Object.create(null), ...suffix)
        if (confirmed(candidate)) { settings = candidate; parameterStart = index }
        break
      }
    }
    if (!settings) return null
  }
  const positive: string[] = [], negative: string[] = []
  let inNegative = false
  for (const [index, rawLine] of lines.slice(0, parameterStart).entries()) {
    let line = index === 0 && rawLine.startsWith('Prompt:') ? rawLine.slice('Prompt:'.length).trimStart() : rawLine
    if (!inNegative && line.startsWith('Negative prompt:')) { inNegative = true; line = line.slice('Negative prompt:'.length).trimStart() }
    ;(inNegative ? negative : positive).push(line)
  }
  return { positive: positive.join('\n').trim(), negative: negative.join('\n').trim(), settings }
}

export function normalizeGenerationRaw(raw: Record<string, string>): Record<string, string> {
  if (!object(raw)) return {}
  const normalized = { ...raw }, wrapper = json(raw.UserComment)
  if (!wrapper) return normalized
  const additions: JSONObject = {}
  for (const key of ['prompt', 'workflow']) if (isComfy(json(wrapper[key]))) additions[key] = wrapper[key]
  const parameters = wrapper.parameters
  if (isFooocus(json(parameters)) || a1111(parameters)) additions.parameters = parameters
  else if (isFooocus(wrapper)) additions.parameters = wrapper
  if (legacyFooocus(wrapper.fooocus_params)) additions.fooocus_params = wrapper.fooocus_params
  for (const key of ['invokeai_metadata', 'invokeai', 'sd-metadata']) {
    const invoke = json(wrapper[key])
    if (key === 'sd-metadata' && invoke && object(invoke.image) || isInvoke(invoke)) additions[key] = wrapper[key]
  }
  // A saved Invoke workflow/graph is never promoted into ComfyUI prompt/workflow.
  for (const key of ['invokeai_workflow', 'invokeai_graph']) if (json(wrapper[key])) additions[key] = wrapper[key]
  const nai = naiComment(wrapper)
  if (isNAI(nai, { ...wrapper, ...raw })) {
    additions.Comment = wrapper.Comment ?? wrapper
    for (const key of ['Description', 'Software', 'Source']) if (typeof wrapper[key] === 'string') additions[key] = wrapper[key]
  }
  for (const [key, value] of Object.entries(additions)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) normalized[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return normalized
}

function base(source: Source): SavedGenerationFields {
  return { model: '', vae: '', seed: '', steps: '', cfg: '', sampler: '', scheduler: '', denoise: '', noiseSeed: '', clipSkip: 0,
    prompt: '', negativePrompt: '', promptStages: [], promptStatus: 'missing', promptWarnings: [], loras: [],
    hasWorkflow: false, hasPrompt: false, metadataSource: source, checkpoints: [], textEncoders: [], vaes: [],
    loraDetails: [], generationStages: [], generationStatus: 'missing', generationWarnings: [],
    generationScope: 'recorded', generationOutputNodeId: null }
}
function addLora(result: SavedGenerationFields, loraName: any, modelValue: any = null, clipValue: any = null, enabled = true, deduplicate = false) {
  if (typeof loraName !== 'string' || !loraName || loraName === 'None') return
  const modelWeight = weight(modelValue), clipWeight = weight(clipValue)
  const active = !enabled || modelWeight === 0 && clipWeight === 0 ? false
    : modelWeight !== null && modelWeight !== 0 || clipWeight !== null && clipWeight !== 0 ? true : null
  const detail = { name: loraName, strengthModel: modelWeight, strengthClip: clipWeight, enabled, nodeId: NODE_ID, active }
  if (!deduplicate || !result.loraDetails.some(item => JSON.stringify(item) === JSON.stringify(detail))) result.loraDetails.push(detail)
  if (!result.loras.includes(loraName)) result.loras.push(loraName)
  if ((modelWeight === null || clipWeight === null) && !result.generationWarnings.includes('lora-weight-not-recorded')) result.generationWarnings.push('lora-weight-not-recorded')
}
function fooocusLoras(data: JSONObject, result: SavedGenerationFields) {
  for (const [key, value] of Object.entries(data)) {
    if (!/^(?:lora_combined_\d+|LoRA \d+)$/.test(key) || typeof value !== 'string') continue
    let parts = value.split(' : '), enabled = true
    if (parts.length === 3 && ['true', 'false'].includes(parts[0].toLowerCase())) { enabled = parts[0].toLowerCase() === 'true'; parts = parts.slice(1) }
    if (parts.length === 2) addLora(result, parts[0], parts[1], parts[1], enabled)
  }
  if (Array.isArray(data.loras)) {
    for (const item of data.loras) if (Array.isArray(item) && item.length >= 2) addLora(result, item[0], item[1], item[1], true, true)
  }
}
function finish(result: SavedGenerationFields): SavedGenerationFields {
  result.hasPrompt = !!result.prompt
  result.promptStatus = result.prompt ? result.promptWarnings.length ? 'partial' : 'complete' : 'missing'
  if (result.prompt || result.negativePrompt) result.promptStages.unshift({ nodeId: NODE_ID, label: LABELS[result.metadataSource], prompt: result.prompt, negativePrompt: result.negativePrompt })
  if (result.model && !result.checkpoints.includes(result.model)) result.checkpoints.unshift(result.model)
  if (result.vae) result.vaes = [result.vae]
  const config = { steps: result.steps, cfg: result.cfg, seed: result.seed, noiseSeed: result.noiseSeed, sampler: result.sampler, scheduler: result.scheduler, denoise: result.denoise }
  if (result.metadataSource === 'a1111' && result.generationStages.some(item => item.nodeId === 'saved-hires')) config.denoise = ''
  if (Object.values(config).some(Boolean)) result.generationStages.unshift({ nodeId: NODE_ID, label: LABELS[result.metadataSource], ...config })
  if (result.metadataSource === 'a1111') {
    // Official A1111 LoRA positional order is TE, then UNet. A missing saved
    // weight stays unknown even if a generator release has a runtime default.
    for (const match of loraTags(result.prompt)) {
      const tokens = match[2]?.split(':') || [], positional = tokens.filter(part => !part.includes('='))
      const named = Object.fromEntries(tokens.filter(part => part.includes('=')).map(part => { const index = part.indexOf('='); return [part.slice(0, index), part.slice(index + 1)] }))
      const clip = named.te ?? positional[0] ?? null, model = named.unet ?? positional[1] ?? clip
      addLora(result, match[1], model, clip)
    }
  }
  if (result.generationStages.length || result.checkpoints.length || result.loraDetails.length) {
    const complete = ['steps', 'cfg', 'seed'].every(key => (result as any)[key] !== '') && !!(result.sampler || result.scheduler)
    result.generationStatus = complete && !result.generationWarnings.length ? 'complete' : 'partial'
  }
  return result
}
function apply(result: SavedGenerationFields, data: JSONObject, mapping: Record<string, string[]>) {
  for (const [key, aliases] of Object.entries(mapping)) (result as any)[key] = scalar(pick(data, ...aliases))
  const clip = pick(data, 'clip_skip', 'Clip skip', 'CLIP Skip')
  if ((typeof clip === 'string' && /^[+-]?\d+$/.test(clip.trim()) || typeof clip === 'number' && Number.isInteger(clip)) && Number.isSafeInteger(Number(clip))) result.clipSkip = Number(clip)
}
function stage(result: SavedGenerationFields, nodeId: string, label: string, data: JSONObject, mapping: Record<string, string[]>) {
  const config = { steps: '', cfg: '', seed: '', noiseSeed: '', sampler: '', scheduler: '', denoise: '' }
  for (const [key, aliases] of Object.entries(mapping)) (config as any)[key] = scalar(pick(data, ...aliases))
  if (Object.values(config).some(Boolean)) result.generationStages.push({ nodeId, label, ...config })
}
function legacyInvoke(data: JSONObject): { invoke: JSONObject | null; warnings: string[] } {
  let legacy = json(data.invokeai)
  if (isInvoke(legacy)) return { invoke: { ...legacy, positive_prompt: legacy.positive_conditioning ?? null, negative_prompt: legacy.negative_conditioning ?? null }, warnings: [] }
  legacy = json(data['sd-metadata'])
  const image = legacy?.image
  if (!object(image) || !['prompt', 'seed', 'steps'].some(key => key in image)) return { invoke: null, warnings: [] }
  const positive: string[] = [], negative: string[] = [], warnings: string[] = []
  const prompts = typeof image.prompt === 'string' ? [{ prompt: image.prompt }] : image.prompt
  if (Array.isArray(prompts)) for (const part of prompts) {
    const promptText = object(part) ? part.prompt : null
    if (typeof promptText !== 'string') { warnings.push('legacy-weighted-prompts-not-fully-expanded'); continue }
    const blocks = [...promptText.matchAll(/\[([^\[\]]+)\]/g)]
    positive.push(promptText.replace(/\[[^\[\]]+\]/g, '').trim())
    negative.push(...blocks.map(block => block[1].trim().replace(/^,+|,+$/g, '')))
    if ((part.weight ?? 1) !== 1 || prompts.length > 1) if (!warnings.includes('legacy-weighted-prompts-not-fully-expanded')) warnings.push('legacy-weighted-prompts-not-fully-expanded')
  }
  return { invoke: { ...image, positive_prompt: positive.join('\n'), negative_prompt: negative.join('\n'), model: legacy?.model_weights ?? null, strength: pick(image, 'strength', 'strength_steps') }, warnings }
}

/** Returns null for unrelated/unsupported metadata, without treating arbitrary
 * Description or JSON objects as prompts. Every field describes saved records.
 */
export function parseGenerationFields(raw: Record<string, string>): SavedGenerationFields | null {
  if (!object(raw)) return null
  const data = normalizeGenerationRaw(raw)
  let invoke = json(data.invokeai_metadata), promptWarnings: string[] = []
  if (!isInvoke(invoke)) { const legacy = legacyInvoke(data); invoke = legacy.invoke; promptWarnings = legacy.warnings }
  if (isInvoke(invoke)) {
    const result = base('invokeai')
    result.promptWarnings.push(...promptWarnings)
    Object.assign(result, { prompt: text(invoke.positive_prompt), negativePrompt: text(invoke.negative_prompt), model: name(invoke.model), vae: name(invoke.vae) })
    apply(result, invoke, { steps: ['steps'], seed: ['seed'], cfg: ['cfg_scale'], sampler: ['sampler'], scheduler: ['scheduler'], denoise: ['strength'], noiseSeed: ['noise_seed'] })
    for (const key of ['qwen3_encoder', 'mistral_encoder']) { const encoder = name(invoke[key]); if (encoder && !result.textEncoders.includes(encoder)) result.textEncoders.push(encoder) }
    if (Array.isArray(invoke.loras)) for (const item of invoke.loras) if (object(item)) addLora(result, name(item.model), item.weight, item.weight)
    const refiner = name(invoke.refiner_model)
    if (refiner) {
      result.checkpoints.push(refiner)
      stage(result, 'saved-refiner', 'InvokeAI refiner', invoke, { steps: ['refiner_steps'], cfg: ['refiner_cfg_scale'], scheduler: ['refiner_scheduler'] })
      result.generationWarnings.push('refiner-stage-fields-incomplete')
    }
    if (invoke.hrf_enabled === true) {
      stage(result, 'saved-hires', 'InvokeAI high resolution', invoke, { denoise: ['hrf_strength'] })
      result.generationWarnings.push('hires-stage-fields-incomplete')
    }
    const style = text(invoke.positive_style_prompt), negativeStyle = text(invoke.negative_style_prompt)
    if (style || negativeStyle) result.promptStages.push({ nodeId: 'saved-style', label: 'InvokeAI style', prompt: style, negativePrompt: negativeStyle })
    return finish(result)
  }
  let fooocus = json(data.parameters)
  if (!isFooocus(fooocus) && !a1111(data.parameters)) fooocus = legacyFooocus(data.fooocus_params)
  if (isFooocus(fooocus)) {
    const result = base('fooocus')
    Object.assign(result, { prompt: text(pick(fooocus, 'full_prompt', 'prompt', 'Prompt')), negativePrompt: text(pick(fooocus, 'full_negative_prompt', 'negative_prompt', 'Negative Prompt')) })
    apply(result, fooocus, { model: ['base_model', 'Base Model'], vae: ['vae', 'VAE'], steps: ['steps', 'Steps'], seed: ['seed', 'Seed'],
      cfg: ['guidance_scale', 'Guidance Scale', 'CFG scale'], sampler: ['sampler', 'Sampler'], scheduler: ['scheduler', 'Scheduler'], denoise: ['denoise'], noiseSeed: ['noise_seed'] })
    const refiner = name(pick(fooocus, 'refiner_model', 'Refiner Model'))
    if (refiner && refiner !== 'None') { result.checkpoints.push(refiner); result.generationWarnings.push('refiner-stage-not-recorded') }
    fooocusLoras(fooocus, result)
    return finish(result)
  }
  const nai = naiComment(json(pick(data, 'Comment', 'UserComment')))
  if (isNAI(nai, data)) {
    const result = base('novelai')
    Object.assign(result, { prompt: text(nai.prompt) || text(pick(data, 'Description', 'ImageDescription')), negativePrompt: text(nai.uc), model: scalar(pick(data, 'Source', 'Software')) })
    apply(result, nai, { steps: ['steps'], seed: ['seed'], cfg: ['scale'], sampler: ['sampler'], scheduler: ['scheduler'], denoise: ['strength'], noiseSeed: ['noise_seed'] })
    if ('v4_prompt' in nai || 'v4_negative_prompt' in nai) result.promptWarnings.push('structured-character-prompts-not-expanded')
    return finish(result)
  }
  for (const key of ['parameters', 'UserComment']) {
    const parsed = a1111(data[key])
    if (!parsed) continue
    const { positive, negative, settings } = parsed, result = base('a1111')
    result.prompt = positive; result.negativePrompt = negative
    for (const [original, normalized] of Object.entries(A1111_FIELDS)) if (original in settings) (result as any)[normalized] = settings[original]
    apply(result, settings, {})
    if (settings.Refiner && settings.Refiner !== 'None') { result.checkpoints.push(settings.Refiner); result.generationWarnings.push('refiner-stage-not-recorded') }
    for (const item of (settings['Lora weights'] || '').split(',')) {
      const separator = item.lastIndexOf(':')
      if (separator >= 0) addLora(result, item.slice(0, separator).trim(), item.slice(separator + 1).trim(), item.slice(separator + 1).trim())
    }
    for (const item of (settings['Lora hashes'] || '').split(',')) {
      const separator = item.lastIndexOf(':'), loraName = item.slice(0, separator).trim()
      if (separator >= 0 && !result.loras.includes(loraName) && ![...loraTags(positive)].some(tag => tag[1] === loraName)) addLora(result, loraName)
    }
    if (Object.keys(settings).some(setting => setting.startsWith('Hires '))) {
      result.generationWarnings.push('additional-stage-parameters-present')
      stage(result, 'saved-hires', 'A1111 high resolution', settings, { steps: ['Hires steps', 'Hires upscale steps'], cfg: ['Hires CFG Scale', 'Hires CFG scale'], sampler: ['Hires sampler'], scheduler: ['Hires schedule type'], denoise: ['Denoising strength'] })
      if (settings['Hires prompt'] || settings['Hires negative prompt']) result.promptStages.push({ nodeId: 'saved-hires', label: 'A1111 high resolution', prompt: settings['Hires prompt'] || '', negativePrompt: settings['Hires negative prompt'] || '' })
    }
    return finish(result)
  }
  return null
}
