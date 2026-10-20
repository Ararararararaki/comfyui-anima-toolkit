/**
 * safetensors 头部元数据读取（2026-10-19 补全 MOSS 底模时引入）。
 *
 * 为什么需要它：本地 LoRA 的底模此前**只**来自 Civitai `by-hash` 匹配，
 * 未上传 C 站的自训 LoRA（本机 26 个 moss_image 中的绝大多数）因此一律落进「未匹配」，
 * 底模标签、按底模筛选全部失效。而训练器本来就把底模写进了文件头部：
 *   __metadata__.ss_base_model_version = "moss_image" / "anima" / "krea2" …
 * 读这几十字节即可离线判定，无需联网、无需 C 站收录。
 *
 * 格式（safetensors 规范）：前 8 字节 = header 字节数 N（uint64 小端），随后 N 字节是 UTF-8 JSON，
 * 内含 `__metadata__` 与各 tensor 的偏移表。只读头部，不碰后面的权重数据。
 */

import { normalizeLocalBaseModel } from './baseModelCatalog'

/** 头部 JSON 的合理上限：正常 LoRA 头部 20–80 KB，超过 16 MB 视为损坏/异常，直接放弃 */
const MAX_HEADER_BYTES = 16 * 1024 * 1024

export interface SafetensorsLoraMeta {
  /** ss_base_model_version 原值（未归一化，保留大小写差异便于排查） */
  baseModelVersion: string
  /** ss_sd_model_name 原值：部分训练器只写这个 */
  sdModelName: string
  /** ss_output_name：训练时的输出名，可作辅助线索 */
  outputName: string
  networkModule: string
  networkDim: string
  networkAlpha: string
  /** 归一化到面板口径的底模；识别不出为空串 */
  baseModel: string
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 只认 safetensors：其他容器（pt/ckpt/bin）的元数据不可靠，交给 C 站匹配 */
export function isSafetensorsName(name: string): boolean {
  return /\.safetensors$/i.test(name || '')
}

/**
 * 读取单个文件的头部元数据。
 * 任何异常（非 safetensors、头部损坏、被取消、读取权限变化）都返回 null —— 扫描主流程不得因此中断。
 */
export async function readSafetensorsLoraMeta(
  file: Blob,
  options: { signal?: AbortSignal; fileName?: string } = {},
): Promise<SafetensorsLoraMeta | null> {
  if (options.fileName && !isSafetensorsName(options.fileName)) return null
  if (!file || typeof file.slice !== 'function' || file.size < 9) return null

  try {
    if (options.signal?.aborted) return null
    const lengthBytes = await file.slice(0, 8).arrayBuffer()
    if (lengthBytes.byteLength < 8) return null
    const headerLength = Number(new DataView(lengthBytes).getBigUint64(0, true))
    if (!Number.isFinite(headerLength) || headerLength <= 0 || headerLength > MAX_HEADER_BYTES) return null
    if (8 + headerLength > file.size) return null

    const headerBytes = await file.slice(8, 8 + headerLength).arrayBuffer()
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as { __metadata__?: Record<string, unknown> }
    const meta = header?.__metadata__
    // 头部能解析、但根本没有 __metadata__ 是**正常情况**（合并 LoRA、部分转换工具都不写元数据），
    // 必须与「读不了」区分开：本机 371 个 LoRA 里就有 14 个属于此类。
    // 返回一组空读数让调用方照常走「底模未知」；只有真的打不开/解析不了才返回 null。
    const fields = (meta && typeof meta === 'object') ? meta : {}

    const baseModelVersion = asText(fields['ss_base_model_version'])
    const sdModelName = asText(fields['ss_sd_model_name'])
    // 归一化优先用 ss_base_model_version；它缺失时才退回 ss_sd_model_name（少数转换版训练器只留后者）
    const baseModel = normalizeLocalBaseModel(baseModelVersion) || normalizeLocalBaseModel(sdModelName)

    return {
      baseModelVersion,
      sdModelName,
      outputName: asText(fields['ss_output_name']),
      networkModule: asText(fields['ss_network_module']),
      networkDim: asText(fields['ss_network_dim']),
      networkAlpha: asText(fields['ss_network_alpha']),
      baseModel,
    }
  } catch {
    return null
  }
}
