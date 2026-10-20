/**
 * 底模口径单一真源（2026-10-19 补全 MOSS 底模时建立）。
 *
 * 项目里同一个「底模」此前存在三套口径，各自硬编码在不同文件里，加一个新底模要改多处且容易漏：
 *   ① Civitai API 的 baseModel 字符串 —— 既是 LoRA 探索下拉的筛选值，也决定能取到哪批数据；
 *   ② 训练器写进 safetensors 头部的 ss_base_model_version —— 本地离线判定的唯一稳定信号；
 *   ③ 面板展示文案（带 emoji 的下拉项、本地列表标签、详情行）。
 * 本模块把三套收敛到一张表：以后新增底模只改本文件 + index.html 的下拉选项。
 *
 * 实测依据（2026-10-19）：
 *   · Civitai 的 MOSS 取值是 **带空格** 的 "MOSS Image" / "MOSS Image Base"：
 *     `baseModels=MOSS Image` 有结果，`baseModels=MOSS` 返回 0 条；
 *     `baseModels=MOSS Image,MOSS Image Base` 返回 0 条 —— 逗号多值无效，所以两者必须是两个独立选项。
 *   · MOSS Image Base 侧有高下载量 LoRA（Lenovo UltraReal dl≈19.9 万），不是冷门分支。
 *   · 本机 371 个 safetensors 的 ss_base_model_version 分布：
 *     anima 193 / 无该字段 125 / moss_image 26 / krea2 25 / sdxl_base_v1-0 1 / **KREA2** 1。
 *     → 同一底模存在大小写不一致（krea2 vs KREA2），归一化必须大小写不敏感且下划线/空格/连字符等价。
 *   · 本地 moss_image 无法区分 SFT 与 Base（26 个文件全写作 moss_image），
 *     因此本地只归到 "MOSS Image"；要区分 Base 只能靠 C 站 by-hash 匹配回来的更精确值。
 */

/** 底模下拉的一项。value 与 Civitai API 的 baseModels 参数值逐字相同。 */
export interface BaseModelOption {
  /** C 站 baseModels 参数值，同时也是面板归一化后的目标口径 */
  value: string
  /** 下拉显示文案（含 emoji，与既有选项风格一致） */
  label: string
  /** 本地 ss_base_model_version 的等价写法（原始大小写，比较时统一归一化） */
  aliases: string[]
}

/**
 * LoRA 探索基座下拉的选项。index.html 里的 <select id="baseModelFilter"> 必须与本表保持一致，
 * `scripts/verify-base-model-catalog.mjs` 会逐项核对，任一侧漏项即失败。
 */
export const BASE_MODEL_OPTIONS: readonly BaseModelOption[] = [
  { value: 'Anima', label: '🎬 Anima', aliases: ['anima'] },
  { value: 'SD 1.5', label: '🎨 SD 1.5', aliases: ['sd15', 'sd_15', 'sd1.5', 'sd_v1', 'sd15_base'] },
  { value: 'Pony', label: '🦄 Pony', aliases: ['pony', 'pony_v6', 'ponyv6'] },
  { value: 'Illustrious', label: '✨ Illustrious', aliases: ['illustrious', 'ilxl', 'illustriousxl'] },
  { value: 'NoobAI', label: '🤖 NoobAI', aliases: ['noobai', 'noobai_xl', 'noobaixl'] },
  { value: 'Flux.1 D', label: '⚡ Flux.1 D', aliases: ['flux1d', 'flux1dev', 'flux'] },
  { value: 'Krea 2', label: '🟠 Krea 2', aliases: ['krea2', 'krea_2', 'krea2_0'] },
  // MOSS 必须两个独立项：C 站 baseModels 不接受逗号多值（实测返回 0 条）
  { value: 'MOSS Image', label: '🌿 MOSS Image', aliases: ['mossimage', 'moss_image', 'moss'] },
  { value: 'MOSS Image Base', label: '🌱 MOSS Image Base', aliases: ['mossimagebase', 'moss_image_base'] },
  { value: 'Other', label: '📦 Other', aliases: [] },
]

/**
 * 本地元数据归一化别名表：比下拉更宽，容纳「C 站上没有独立下拉项、但训练器会写出来」的底模
 * （例：sdxl_base_v1-0 → SDXL 1.0）。这些值只影响本地列表/详情里的显示，不参与远程筛选。
 */
const LOCAL_ONLY_ALIASES: ReadonlyArray<{ value: string; aliases: string[] }> = [
  { value: 'SDXL 1.0', aliases: ['sdxl', 'sdxlbase', 'sdxl_base_v1-0', 'sdxl10', 'sdxlv10'] },
  { value: 'SD 2.x', aliases: ['sd21', 'sd20', 'sd2', 'sd21_768'] },
  { value: 'WanVideo', aliases: ['wan', 'wanvideo', 'wan21'] },
  { value: 'Qwen-Image', aliases: ['qwenimage', 'qwen_image'] },
]

/** 归一化比较键：大小写、下划线、连字符、空格、点号一律等价 */
export function baseModelKey(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/[\s_.\-]+/g, '')
}

const LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>()
  const put = (value: string, aliases: readonly string[]) => {
    map.set(baseModelKey(value), value)
    for (const alias of aliases) map.set(baseModelKey(alias), value)
  }
  for (const option of BASE_MODEL_OPTIONS) put(option.value, option.aliases)
  for (const entry of LOCAL_ONLY_ALIASES) put(entry.value, entry.aliases)
  return map
})()

/**
 * 把本地训练器写入的 ss_base_model_version 归一到面板口径。
 * 识别不了时返回空串（调用方据此显示「底模未知」，而不是把裸值当底模名展示）。
 */
export function normalizeLocalBaseModel(raw: string): string {
  const key = baseModelKey(raw)
  if (!key) return ''
  return LOOKUP.get(key) || ''
}

/** 本地元数据原值是否已被识别（UI 可据此决定是否加已识别样式） */
export function isKnownLocalBaseModel(raw: string): boolean {
  return !!normalizeLocalBaseModel(raw)
}

/** 取深链，找不到返回 undefined；供 UI 需要 emoji 标签时用 */
export function findBaseModelOption(value: string): BaseModelOption | undefined {
  const key = baseModelKey(value)
  if (!key) return undefined
  const canonical = LOOKUP.get(key)
  if (!canonical) return undefined
  return BASE_MODEL_OPTIONS.find(option => option.value === canonical)
}

/**
 * 本地库「按底模」面板的取值口径：C 站匹配值优先（更精确，能区分 MOSS SFT/Base），
 * 否则退回本地 safetensors 元数据识别的值，两者都没有才返回空串（= 未匹配/未知）。
 */
export function resolveFileBaseModel(matchBaseModel: string | undefined | null, localBaseModel: string | undefined | null): string {
  const fromCivitai = String(matchBaseModel || '').trim()
  if (fromCivitai) return fromCivitai
  return String(localBaseModel || '').trim()
}
