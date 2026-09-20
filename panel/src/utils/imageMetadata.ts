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
// 内存特征：PNG 路径要同时持有原图与结果（O(n) 拷贝；42MB 图实测 RSS 峰值约 9× 文件大小）。
// 单张（数 MB）无压力；批量导出请在调用侧逐张处理并给进度，不要一次性把所有图读进内存。
//
// 性能基线（2026-09-21 实测，node 24）：42MB 图单次 rewrite 30-34ms，
// applyExportMetadata（含 Blob 读 + 拷贝）82-122ms。

import { rewritePngTextChunks, sanitizePngKeyword } from '../services/pngChunks'

/**
 * 要去掉的文本块关键词。
 * ⚠️ 实测（2026-09-21，本机 400 张真实出图采样）：ComfyUI **只写 `prompt` 与 `workflow`**
 * 两个关键词，都是 `tEXt` 且位于第一个 IDAT 之前；`parameters` **一次都没出现** ——
 * 它是 A1111 / WebUI 的关键词。这里仍然保留 `parameters`，是为了让从别处拿来的
 * A1111 图也能被一并清理（对 ComfyUI 自己的图它是空操作，无副作用）。
 * 去掉 `prompt` / `workflow` = 图片无法反查提示词与工作流。
 */
export const COMFY_METADATA_KEYWORDS = ['parameters', 'workflow', 'prompt'] as const

/** 面板内置的署名键（用户可留空；也可在「自定义键值」里增删） */
export const AUTHOR_KEY_PRESETS = ['Author', 'Copyright', 'Software', 'Comment'] as const

export interface ExportMetadataOptions {
  /** 是否去除 ComfyUI 的 parameters / workflow / prompt */
  strip: boolean
  /** 要覆盖写入的自定义元数据（Author / Copyright / ...）；值为空串 = 不写该键 */
  entries: Record<string, string>
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPng(head: Uint8Array): boolean {
  if (head.length < 8) return false
  for (let i = 0; i < 8; i++) if (head[i] !== PNG_SIGNATURE[i]) return false
  return true
}

/** 过滤出**要写入**的条目：键名 sanitize 后为空、或值为空的都丢弃（留空 = 不写该键） */
function normalizeEntries(entries: Record<string, string> | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (!entries) return out
  for (const key of Object.keys(entries)) {
    const kw = sanitizePngKeyword(String(key))
    if (!kw) continue
    const raw = entries[key]
    if (raw === undefined || raw === null) continue
    const text = String(raw)
    if (text === '') continue
    out.push([kw, text])
  }
  return out
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
 * 非 PNG（含压缩后的 WebP）原样返回，调用方无需分支。
 */
export async function applyExportMetadata(blob: Blob, opts: ExportMetadataOptions): Promise<Blob> {
  if (isExportMetadataNoop(opts)) return blob
  if (blob.size < 8) return blob
  if (!isPng(new Uint8Array(await blob.slice(0, 8).arrayBuffer()))) return blob

  const bytes = new Uint8Array(await blob.arrayBuffer())
  const write = normalizeEntries(opts.entries)
  const drop: string[] = [
    ...(opts.strip ? COMFY_METADATA_KEYWORDS : []),
    // ⚠️ 这条不能省：漏掉它就会出现两个同名块、且旧值生效（见文件头注释的实测教训）
    ...write.map(([k]) => k),
  ]
  const out = rewritePngTextChunks(bytes, drop, write)
  if (out === bytes) return blob // 零改动：复用原 Blob，不产生新对象
  // 用精确切片构造，避免把整个底层 ArrayBuffer（可能远大于视图）交给 Blob
  const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
  return new Blob([ab], { type: 'image/png' })
}
