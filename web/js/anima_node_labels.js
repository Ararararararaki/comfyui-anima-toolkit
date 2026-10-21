import { getNodeLocale, uiText, onNodeLocaleChange } from './anima_node_i18n.js';

// Presentation only: the identifiers, option values and positional widget
// contract remain owned by the Python node definitions.
export const NODE_LABELS = Object.freeze({
  'TK Batch LoRA Loader': ['TK 批量 LoRA 加载器', 'TK Batch LoRA Loader'],
  'TK Trigger Words': ['TK 触发词', 'TK Trigger Words'],
  'TK 3D Body Camera': ['TK 可动素体相机', 'TK 3D Body Camera'],
  'TK Prompt Batch': ['TK 批量提示词注入', 'TK Prompt Batch'],
  'TK Text Join': ['TK 文本合并', 'TK Text Join'],
  'TK String Router': ['TK 字符串路由器', 'TK String Router'],
  AnimaTKDanbooruTagGetter: ['TK Danbooru Tag Getter', 'TK Danbooru Tag Getter'],
  AnimaTKPromptSaver: ['TK Prompt Saver', 'TK Prompt Saver'],
  AnimaPresetEmptyLatent: ['TK 空Latent 图像', 'TK Empty Image Latent'],
  AnimaTKLatentSwitch: ['TK Latent 选择/合成', 'TK Latent Select / Composite'],
  DanbooruGallery: ['TK 多重画廊', 'TK Multi-source Gallery'],
  'TK Image Select': ['TK 图像选择', 'TK Image Select'],
  TKPromptCards: ['TK Prompt Cards', 'TK Prompt Cards'],
  AnimaClothingDraw: ['TK 服装抽卡', 'TK Clothing Draw'],
  AnimaTKAnimaFormatter: ['TK Anima 格式化', 'TK Anima Formatter'],
  AnimaTKPromptExpander: ['TK 提示词扩写', 'TK Prompt Expander'],
  TkPromptAgent: ['TK Prompt Agent', 'TK Prompt Agent'],
});

const DESCRIPTIONS = {
  'TK Batch LoRA Loader': 'Load LoRAs from the visual editor or LoRA syntax; optionally output their trigger words.',
  'TK Trigger Words': 'Extract LoRA trigger words and merge optional manually supplied words.',
  'TK 3D Body Camera': 'Pose a low-poly FK body by dragging its joints and preview the camera. Uses the shared CameraControlCore prompt algorithm.',
  'TK Prompt Batch': 'Read grouped prompt files and queue each group in sequence. Choose text and camera targets, output subfolders and per-group regions.',
  'TK Text Join': 'Join text with commas, spaces or line breaks for CLIPTextEncode.',
  'TK String Router': 'Select one or more of six text inputs, change their output order and customize input labels. Disabled inputs are omitted.',
  AnimaTKDanbooruTagGetter: 'Classify Danbooru tags from one prompt input while preserving natural language. Supports Packer category bundles.',
  AnimaTKPromptSaver: 'Select one or more prompt inputs and save them to the TK Toolkit prompt library when this node runs, with optional preview images.',
  AnimaPresetEmptyLatent: 'Create single-frame empty latents with common image-size presets for Anima/Cosmos workflows.',
  AnimaTKLatentSwitch: 'Select one of six latent inputs with linked denoise, or composite connected layers over a selected background.',
  DanbooruGallery: 'Search supported image sources, select images in order, and output images, prompts and metadata.',
  'TK Image Select': 'Route up to eight images by priority, index, random, stable seed or round robin. Skip disconnected inputs and output the selected source index and name.',
  TKPromptCards: 'Build prompts from grouped files and bilingual tag cards. Optionally encode with CLIP and output LoRA syntax for TK Batch LoRA Loader.',
  AnimaClothingDraw: 'Randomly draw or select clothing from the local TK Toolkit library. Preview the outfit and output its prompt, name, category and structured data.',
  AnimaTKAnimaFormatter: 'Format tags for Anima: replace underscores, escape brackets, prefix artists with @, reorder sections and apply length limits.',
  AnimaTKPromptExpander: 'Expand tags into English descriptions without an LLM. Optionally add curated tags and output a VLM instruction for visible details missing from the tags.',
  TkPromptAgent: 'Create and edit prompts or interrogate images. With IMAGE connected and replace/append enabled, read the image and output a prompt; otherwise follow the text execution setting.',
};

const LABELS = {
  control_after_generate: 'Control after generation', model: 'Model', clip: 'CLIP', MODEL: 'Model', CLIP: 'CLIP', STRING: 'Prompt', CONDITIONING: 'Conditioning',
  lora_syntax: 'LoRA syntax', output_trigger_words: 'Output trigger words', trigger_words: 'Trigger words', tw_map: 'Trigger-word cards',
  pose_preset: 'Pose preset', pose: 'Pose', preset: 'Preset', pos_x: 'Position X', pos_y: 'Position Y', pos_z: 'Position Z',
  roll: 'Roll', fov: 'Field of view', extra_tags: 'Extra tags', config: 'Configuration', camera_meta: 'Camera metadata',
  prompt_files: 'Prompt files', positive_target: 'Positive text target', negative_target: 'Negative text target', camera_target: 'Camera target',
  output_subfolder: 'Output subfolder', groups_selection: 'Selected groups', region_values: 'Region settings', camera_values: 'Camera settings',
  extra_dirs: 'Additional directories', preview_prompt: 'Preview prompt', separator: 'Separator', router_settings: 'Router settings',
  tag_bundle: 'Category bundle', regex_blacklist: 'Regex exclusions', tag_blacklist: 'Exact tag exclusions', natural_language: 'Unified prompt',
  include_natural_language: 'Include natural language', filter_natural_language: 'Filter natural language', exclude_groups: 'Legacy group exclusions',
  exclude_groups_custom: 'Legacy custom exclusions', natural_mode: 'Legacy natural-language mode',
  prompt_category: 'Prompt category', prompt: 'Prompt', text: 'Text', width: 'Width', height: 'Height', batch_size: 'Batch size',
  latent: 'Latent', mode: 'Mode', select: 'Select input', base: 'Background input', layout: 'Layer offsets', denoise: 'Denoise',
  index: 'Index', summary: 'Summary', selection_data: 'Selection data', images: 'Images', prompts: 'Prompts', metadata_json: 'Metadata JSON',
  priority: 'Priority', seed: 'Seed', image: 'Image', source_index: 'Source index', source_name: 'Source name', positive: 'Current prompt',
  opt_text: 'Additional text', prompt_pieces: 'Prompt pieces', to_spaces: 'Replace underscores', escape_brackets: 'Escape brackets',
  at_artist: 'Prefix artists with @', reorder_sections: 'Reorder sections', dedupe: 'Remove duplicates', max_tags: 'Maximum tags',
  max_lines: 'Maximum lines', keep_natural_language: 'Keep natural language', trailing_comma: 'Trailing comma', force_lowercase: 'Force lowercase',
  natural_separator: 'Natural-language separator', merge_natural: 'Merge natural language', write_natural: 'Write natural language', style: 'Style',
  keep_input_natural: 'Keep input natural language', fill_lighting: 'Add lighting', fill_lighting_tags: 'Lighting tags', fill_camera: 'Add camera tags',
  fill_camera_tags: 'Camera tags', fill_quality: 'Add quality tags', fill_quality_tags: 'Quality tags', dedupe_filled: 'Deduplicate additions',
  vlm_output: 'VLM response', validate_vlm_tags: 'Validate VLM tags', keep_unknown_vlm_tags: 'Keep unknown VLM tags', keep_vlm_natural: 'Keep VLM prose',
  existing_tags_override: 'Existing tag override', normalise_output: 'Normalize output', natural: 'Natural language', vlm_prompt: 'VLM instruction',
  profile: 'Prompt profile', current_prompt: 'Current prompt', user_instruction: 'Your instruction', execution: 'Text execution', session_id: 'Session ID',
  custom_instructions: 'Additional instructions', locked_sections: 'Locked sections', edit_scope: 'Edit scope', approved_prompt: 'Final prompt',
  agent_response: 'Agent response', approved_profile: 'Confirmed profile', interrogation_source: 'Interrogation source',
  interrogation_image: 'Reference image', interrogation_action: 'Image output action', interrogation_options: 'Interrogation options', generation_strategy: 'Creation strategy',
  '相机提示词': 'Camera prompt', '服装提示词': 'Clothing prompt', '服装名称': 'Clothing name', '服装分类': 'Clothing category', '服装数据': 'Clothing data',
  '画师词': 'Artist tags', '背景词': 'Background tags', '人物对象词': 'Subject tags', '角色特征词': 'Character traits', '角色五官词': 'Facial features',
  '角色部位词': 'Body parts', '性征部位词': 'Anatomy tags', '服饰词': 'Clothing tags', '动作词': 'Action tags', '角色表情词': 'Expressions',
  '镜头词': 'Camera tags', '未归类词': 'Unclassified tags', '角色身份词': 'Character identities', '作品版权词': 'Copyright / series',
  '发色发型词': 'Hair color / style', '亚人特征词': 'Nonhuman traits', '审查遮挡词': 'Censorship / occlusion', '文字水印词': 'Text / watermark tags',
  '质量元词': 'Quality metadata', '物件道具词': 'Objects / props',
};

const TOOLTIPS = {
  lora_syntax: 'LoRA syntax shared with the visual editor. Trigger words are extracted from these LoRAs.',
  output_trigger_words: 'Disable to output an empty trigger-word string. LoRA loading is unaffected.',
  trigger_words: 'Optional manually supplied trigger words, merged with the extracted words.',
  tw_map: 'Trigger-word card JSON saved with the workflow and restored after reload.',
  prompt_files: 'Prompt files with ## Group N, bracketed group headings or numbered groups.',
  positive_target: 'Target text node and input key (nodeId.inputKey), selected by the frontend.',
  negative_target: 'Optional target text node for the negative prompt.',
  camera_target: 'Optional TK 3D Body Camera target. The older TK Camera Control node is retired.',
  output_subfolder: 'Override SaveImage filename_prefix with each group name, saving groups in separate subfolders.',
  groups_selection: 'Selected group names stored as workflow JSON. Empty means all groups.',
  region_values: 'Per-group x, y, width, height and strength, using 0–1 ratios. Applied through ConditioningSetAreaPercentage when queued.',
  camera_values: 'Per-group camera descriptions, preset names or px,py,pz,roll. These override camera lines in prompt files.',
  extra_dirs: 'Additional absolute prompt directories, one per line, included in latest-file and recursive browsing.',
  natural_language: 'Connect tags from WD14, Packer or any source. Known Danbooru tags are classified; unknown prose can be preserved.',
  exclude_groups: 'Deprecated workflow placeholder. The old exclusion module has been removed.',
  exclude_groups_custom: 'Deprecated workflow placeholder. The old exclusion module has been removed.',
  natural_mode: 'Deprecated workflow placeholder. Natural language is always preserved without filtering.',
  preset: 'Choose a preset. An empty value leaves preset behavior disabled.',
  width: 'Output image width in pixels; must be a multiple of 16.',
  height: 'Output image height in pixels; must be a multiple of 16.',
  batch_size: 'Number of empty latents to create.',
  layout: 'Composite layer offsets, for example: 2 = 0, -128, 8. Unspecified layers are centered.',
  positive: 'Current prompt, filled from grouped files or tag cards and saved with the workflow.',
  opt_text: 'Additional text from another node, joined to the current prompt with commas.',
  natural_separator: 'Use commas for natural-language segments to keep Anima prompt punctuation consistent.',
  merge_natural: 'Merge natural language and tags into a comma-separated prompt instead of separating them with blank lines.',
  vlm_output: 'Connect the VLM response generated using vlm_prompt. Parses <danbooru_tags> and <natural> blocks.',
};

function englishLabel(name) {
  if (Object.prototype.hasOwnProperty.call(LABELS, name)) return LABELS[name];
  if (name.endsWith('_weight')) return `${englishLabel(name.slice(0, -7))} weight`;
  const numbered = /^(text|string|prompt|image|latent|denoise)_?([a-d]|\d+)$/i.exec(name);
  if (numbered) return `${numbered[1][0].toUpperCase()}${numbered[1].slice(1)} ${numbered[2].toUpperCase()}`;
  return name;
}

export function nodeFieldLabel(name) {
  return uiText(name, englishLabel(name));
}

function englishTooltip(name, nodeId, original) {
  if (name.endsWith('_weight')) return `${englishLabel(name.slice(0, -7))} weight. 1.0 keeps the original strength; range 0.05–2.0.`;
  if (/^latent_\d+$/.test(name)) return `Optional latent input ${name.split('_')[1]}.`;
  if (/^denoise_\d+$/.test(name)) return `Denoise value when input ${name.split('_')[1]} is selected or used as the background.`;
  if (nodeId === 'AnimaTKLatentSwitch') {
    if (name === 'mode') return 'Select one connected latent, or composite the other connected layers over the selected background.';
    if (name === 'select') return 'Input to output in selection mode. A disconnected choice falls back to the first connected input.';
    if (name === 'base') return 'Background input for compositing; the remaining connected inputs are layered over it.';
  }
  if (nodeId === 'AnimaClothingDraw' && name === 'seed') return 'Stable seed for random clothing draws. The draw button chooses a new seed.';
  if (nodeId === 'AnimaTKAnimaFormatter' && name === 'prompt') return 'Tags from WD14, a tag filter or manual input.';
  if (nodeId === 'AnimaTKPromptExpander' && name === 'prompt') return 'Input tags. Paragraphs after a blank line are preserved as natural language.';
  return TOOLTIPS[name] || original;
}

// ComfyUI ComboWidget and WidgetSelect both expose options.getOptionLabel.
// Only presentation changes; options.values and widget.value stay untouched.
const BUILTIN_OPTION_LABELS = {
  '自定义':'Custom', '正面':'Front', '背面':'Back', '左侧':'Left', '右侧':'Right',
  '正上方俯视':'Overhead', '俯视':'High angle', '仰视':'Low angle', '正下方仰视':'From below',
  '特写':'Close-up', '近景':'Medium close-up', '中景':'Medium shot', '全身':'Full body', '远景':'Wide shot',
  '荷兰角':'Dutch angle', '足控仰视':'Low angle from feet', '角色特写':'Character close-up', '角色中景':'Character medium shot',
  '逗号 ,':'Comma ,', '空格':'Space', '换行':'Line break', '无':'None',
  '选择一路':'Select one', '合成叠加':'Composite layers', '优先顺序':'Priority order', '指定索引':'Specified index',
  '随机':'Random', 'Seed 稳定':'Stable seed', '轮询':'Round robin', '随机抽取':'Random draw', '手动选择':'Manual selection',
  '不限制':'Unlimited', '句号转逗号':'Replace periods with commas', '去掉句号':'Remove periods', '保留句号':'Keep periods',
  '简洁（1 句）':'Concise (1 sentence)', '标准（2-3 句）':'Standard (2–3 sentences)', '详细（3-4 句）':'Detailed (3–4 sentences)',
};
const OPTION_FIELDS = {
  'TK 3D Body Camera': ['pose_preset','preset'], 'TK Text Join':['separator'], 'TK String Router':['separator'],
  AnimaTKPromptSaver:['separator'], AnimaTKLatentSwitch:['mode'], 'TK Image Select':['mode'], AnimaClothingDraw:['mode'],
  AnimaTKAnimaFormatter:['max_tags','max_lines','natural_separator'], AnimaTKPromptExpander:['style'],
};
const optionFormatters = new WeakMap();
function applyOptionLabels(widget, nodeId) {
  if (!OPTION_FIELDS[nodeId]?.includes(widget.name) || widget.type !== 'combo' || !widget.options) return;
  const options = widget.options;
  if (optionFormatters.has(options)) return;
  const previous = options.getOptionLabel;
  const formatter = value => {
    if (getNodeLocale() === 'en' && Object.prototype.hasOwnProperty.call(BUILTIN_OPTION_LABELS, value)) return BUILTIN_OPTION_LABELS[value];
    return typeof previous === 'function' ? previous.call(options, value) : value;
  };
  optionFormatters.set(options, formatter);
  options.getOptionLabel = formatter;
}

// Keep source display text separately; never use translated labels as keys.
const originalFields = new WeakMap();
function displayField(target, key, english, { canonical = [] } = {}) {
  if (!target || !['object', 'function'].includes(typeof target) || !english) return;
  let fields = originalFields.get(target);
  if (!fields) originalFields.set(target, fields = new Map());
  let saved = fields.get(key);
  if (!saved) {
    const original = target[key];
    if (key === 'label' && original != null && original !== '' && !canonical.includes(original) && original !== english) return;
    fields.set(key, saved = { original, previous: original, had: Object.prototype.hasOwnProperty.call(target, key) });
  }
  // A later custom name is data, even when the locale changes again.
  if (target[key] !== saved.previous) return;
  if (getNodeLocale() === 'en') target[key] = english;
  else if (saved.had) target[key] = saved.original;
  else delete target[key];
  saved.previous = target[key];
}

function applyNode(node, data) {
  const id = data.name;
  const pair = NODE_LABELS[id];
  const title = uiText(data.originalDisplayName, pair[1]);
  const defaults = [id, pair[0], pair[1], data.originalDisplayName];
  if (defaults.includes(node.title)) node.title = title;
  const inputInfo = Object.assign({}, ...Object.values(data.input || {}));
  for (const item of [...(node.widgets || []), ...(node.inputs || []), ...(node.outputs || [])]) {
    const name = String(item.name || '');
    applyOptionLabels(item, id);
    displayField(item, 'label', englishLabel(name), { canonical: name === 'control_after_generate' ? [name, '生成后控制'] : [name] });
    const input = inputInfo[name];
    const options = Array.isArray(input) && typeof input[1] === 'object' ? input[1] : null;
    const sourceTip = item.tooltip || options?.tooltip;
    if (sourceTip) displayField(item, 'tooltip', englishTooltip(name, id, sourceTip));
  }
  node.setDirtyCanvas?.(true, false);
}

const registrations = new WeakSet();
export function registerNodeLabels(app) {
  if (!app?.registerExtension || registrations.has(app)) return;
  registrations.add(app);
  const definitions = new Map();
  function applyDefinition(record) {
    const { nodeType, nodeData, originalDisplayName, originalDescription } = record;
    nodeData.display_name = uiText(originalDisplayName, NODE_LABELS[nodeData.name][1]);
    nodeData.description = uiText(originalDescription, DESCRIPTIONS[nodeData.name]);
    displayField(nodeType, 'title', NODE_LABELS[nodeData.name][1]);
    for (const group of Object.values(nodeData.input || {})) {
      for (const [name, input] of Object.entries(group)) {
        const options = Array.isArray(input) && input[1] && typeof input[1] === 'object' ? input[1] : null;
        if (options?.tooltip) displayField(options, 'tooltip', englishTooltip(name, nodeData.name, options.tooltip));
      }
    }
  }
  function refreshNode(node) {
    const data = definitions.get(node?.comfyClass || node?.type);
    if (data) applyNode(node, data);
  }
  app.registerExtension({
    name: 'TK.NodeDisplayLabels',
    beforeRegisterNodeDef(nodeType, nodeData) {
      if (!Object.prototype.hasOwnProperty.call(NODE_LABELS, nodeData.name)) return;
      const record = { nodeType, nodeData, ...nodeData,
        originalDisplayName: nodeData.display_name || NODE_LABELS[nodeData.name][0], originalDescription: nodeData.description || '' };
      definitions.set(nodeData.name, record);
      applyDefinition(record);
    },
    nodeCreated: refreshNode,
    loadedGraphNode: refreshNode,
  });
  onNodeLocaleChange(() => {
    for (const data of definitions.values()) applyDefinition(data);
    for (const node of app.graph?._nodes || []) refreshNode(node);
    app.canvas?.setDirty?.(true, true);
  });
}
