// 导出副本的元数据策略层（Options / 入口）。
//
// 底层的 PNG chunk 读写原语在 `services/pngChunks.ts`（与「图片编辑器保存副本时保留
// prompt/workflow」共用同一套遍历与 CRC 实现，不要在这里另写一份 chunk 解析）。
//
// 语义（2026-09-21 与用户确认，勿擅自放宽）：
//   · 开关默认关闭；关闭且无自定义条目时 `applyExportMetadata` 原样返回入参 Blob，字节零改动。
//   · 去除范围**只限** ComfyUI 写的 parameters / workflow / prompt（防提示词与工作流泄露），
//     其余元数据（eXIf / tIME / pHYs / 其它 tEXt）一律保留。
//   · 自定义条目是「覆盖」语义：同名旧块先删再写，避免出现两个 Author。
//     ⚠️ 实测教训（2026-09-21，字节级坐实）：传给 rewritePngTextChunks 的 drop 列表**必须同时
//     包含条目自己的键名**。漏掉时旧块留在 IDAT 之后、新块插在 IDAT 之前 → 同名两份，而读取端
//     以靠后的旧值为准（改了署名实际生效的是旧署名，功能反向），且每导出一次多累积一份、不幂等。
//   · 值留空 = **不写入该键**（默认四键都空 = 只去 ComfyUI 元数据、不写署名）。
//     注意：留空**不会**清除图里已有的同名块 —— 署名是用户自己的数据，宁可不碰。
//     （本机 output 里已存在带写入方署名的历史图，默认删除会破坏用户数据。）
//   · 只作用于**导出副本**（下载 / 打包 / 复制到剪贴板 / 预览 / 编辑器副本，见 Outputs.ts 的接线）。
//     磁盘原图永不经过本模块。
//     ⇒ 去掉 workflow 块后图片拖回 ComfyUI 无法恢复工作流，这是预期效果，UI 上要说明。
//
// PNG 导出只读取 chunk header/keyword，以 Blob slice 复用像素与其它元数据；
// 批量导出仍须限制 ZIP / 剪贴板的合计驻留大小。
//
// 性能基线（2026-09-21 实测，node 24）：42MB 图单次 rewrite 30-34ms，
// applyExportMetadata（含 Blob 读 + 拷贝）82-122ms。

import { isPngBlob, rewritePngTextBlob, sanitizePngKeyword } from '../services/pngChunks'
import { PROMPT_PROVENANCE_KEY } from '../services/outputPromptRecord'

/**
 * 要去掉的文本块关键词。
 * ⚠️ 实测（2026-09-21，本机 400 张真实出图采样）：ComfyUI **只写 `prompt` 与 `workflow`**
 * 两个关键词，都是 `tEXt` 且位于第一个 IDAT 之前；`parameters` **一次都没出现** ——
 * 它是 A1111 / WebUI 的关键词。这里仍然保留 `parameters`，是为了让从别处拿来的
 * A1111 图也能被一并清理（对 ComfyUI 自己的图它是空操作，无副作用）。
 * 去掉 `prompt` / `workflow` = 图片无法反查提示词与工作流。
 */
export const COMFY_METADATA_KEYWORDS = ['parameters', 'workflow', 'prompt', PROMPT_PROVENANCE_KEY] as const

/** 面板内置的署名键（用户可留空；也可在「自定义键值」里增删） */
export const AUTHOR_KEY_PRESETS = ['Author', 'Copyright', 'Software', 'Comment'] as const

export interface ExportMetadataOptions {
  /** 去除生成提示词、工作流及运行期提示词来源记录 */
  strip: boolean
  /** 要覆盖写入的自定义元数据（Author / Copyright / ...）；值为空串 = 不写该键 */
  entries: Record<string, string>
}

/** 过滤出**要写入**的条目：键名 sanitize 后为空、或值为空的都丢弃（留空 = 不写该键） */
function normalizeEntries(entries: Record<string, string> | undefined): Array<[string, string]> {
  const out = new Map<string, string>()
  if (!entries) return []
  for (const key of Object.keys(entries)) {
    const kw = sanitizePngKeyword(String(key))
    if (!kw) continue
    const raw = entries[key]
    if (raw === undefined || raw === null) continue
    const text = String(raw)
    if (text === '') continue
    out.set(kw, text) // Different input keys may sanitize to the same PNG keyword: last value wins.
  }
  return [...out]
}

/** 这套策略是否会改动任何字节（无改动时调用方可直接跳过整份字节读取） */
export function isExportMetadataNoop(opts: ExportMetadataOptions): boolean {
  if (opts.strip) return false
  return normalizeEntries(opts.entries).length === 0
}

/**
 * 对一份导出 Blob 应用元数据策略 —— 所有导出路径（单张下载 / 打包 zip / 单图复制 /
 * 多图复制 / 大图预览 / 编辑器副本）的统一收口。
 *
 * 只处理 PNG：ComfyUI 的 parameters/workflow/prompt 只写在 PNG 里，JPEG/WebP 上本就没有
 * 这三块（去除阶段无事可做），本轮也不往它们里写署名 —— 面板导出的原图基本都是 PNG。
 * 非 PNG 原样返回；需要呈现处理结果的入口使用 applyExportMetadataResult，
 * 不能把非 PNG 文件标记成已经去除生成信息。
 */
export async function applyExportMetadata(blob: Blob, opts: ExportMetadataOptions): Promise<Blob> {
  return (await applyExportMetadataResult(blob, opts)).blob
}

export interface ExportMetadataResult {
  blob: Blob
  status: 'unchanged' | 'processed' | 'unsupported'
  removedKeywords: string[]
}

/** Policy-off is an exact object identity no-op; malformed PNGs reject rather than pretend cleanup. */
export async function applyExportMetadataResult(
  blob: Blob,
  opts: ExportMetadataOptions,
  options: { signal?: AbortSignal } = {},
): Promise<ExportMetadataResult> {
  if (options.signal?.aborted) throw new DOMException('导出已取消', 'AbortError')
  if (isExportMetadataNoop(opts)) return { blob, status: 'unchanged', removedKeywords: [] }
  if (!(await isPngBlob(blob))) {
    // MIME/suffix claims PNG but the signature is broken: do not quietly export it as cleaned.
    if (blob.type.toLowerCase().split(';')[0] === 'image/png') {
      throw new Error('PNG 文件签名不合法，无法清理生成信息')
    }
    return { blob, status: 'unsupported', removedKeywords: [] }
  }
  const write = normalizeEntries(opts.entries)
  if (opts.strip && write.some(([key]) => (COMFY_METADATA_KEYWORDS as readonly string[]).includes(key))) {
    throw new Error('启用清理时，自定义条目不能重新写入生成信息')
  }
  const drop: string[] = [
    ...(opts.strip ? COMFY_METADATA_KEYWORDS : []),
    // ⚠️ 这条不能省：漏掉它就会出现两个同名块、且旧值生效（见文件头注释的实测教训）
    ...write.map(([k]) => k),
  ]
  const result = await rewritePngTextBlob(blob, drop, write, options)
  return { ...result, status: result.blob === blob ? 'unchanged' : 'processed' }
}
