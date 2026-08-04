// ── PNG 文本元数据 chunk 处理（tEXt/zTXt/iTXt）──
// 图片编辑保存副本时，把原始 PNG 的 prompt/workflow 等文本元数据重新嵌入导出结果，
// 保证 ComfyUI 与面板解析器仍能读取编辑后的图片。

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const TEXT_TYPES = new Set(['tEXt', 'zTXt', 'iTXt'])

/** 遍历 PNG chunk，产出 { type, start, end }（start/end 为 chunk 在字节流中的区间） */
function* pngChunks(bytes: Uint8Array): Generator<{ type: string; start: number; end: number }> {
  if (bytes.length < 8) return
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const len = view.getUint32(offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const end = offset + 12 + len
    if (end > bytes.length) return
    yield { type, start: offset, end }
    offset = end
    if (type === 'IEND') return
  }
}

/** 提取 PNG 中的文本元数据 chunk（含长度/类型/CRC 的完整字节），供注入到编辑后的图片 */
export function extractPngTextChunks(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const out: Uint8Array<ArrayBuffer>[] = []
  for (const { type, start, end } of pngChunks(bytes)) {
    if (TEXT_TYPES.has(type)) out.push(bytes.slice(start, end))
  }
  return out
}

/**
 * 将文本元数据 chunk 注入 PNG，插入在第一个 IDAT 之前。
 * 直接复用原始 chunk 字节（含正确 CRC），确保注入后 PNG 依然合法。
 */
export function injectPngTextChunks(
  pngBytes: Uint8Array<ArrayBuffer>,
  textChunks: Uint8Array<ArrayBuffer>[]
): Uint8Array<ArrayBuffer> {
  if (textChunks.length === 0) return pngBytes
  let idatStart = -1
  for (const { type, start } of pngChunks(pngBytes)) {
    if (type === 'IDAT') { idatStart = start; break }
  }
  if (idatStart < 0) return pngBytes // 非法 PNG（无 IDAT），原样返回
  const head = pngBytes.slice(0, idatStart)
  const tail = pngBytes.slice(idatStart)
  const total = head.length + tail.length + textChunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  out.set(head, 0)
  let pos = head.length
  for (const c of textChunks) { out.set(c, pos); pos += c.length }
  out.set(tail, pos)
  return out
}
