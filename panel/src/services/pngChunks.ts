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

// ── 元数据「去除 / 覆盖写入」（导出副本方向，与上面的「保留注入」正好相反）──
// 语义（2026-09-21 与用户确认）：
//   · 去除范围只限调用方指定的关键词（现有调用方只传 ComfyUI 的 parameters/workflow/prompt），
//     eXIf / tIME / pHYs / 其它 tEXt 一律保留。
//   · 覆盖语义：同名旧块先删再写，避免出现两个 Author。
//   · 图像数据（IHDR/PLTE/tRNS/IDAT）原样搬运，**一个像素都不改**，也不重算它们的 CRC。
//
// 为什么不用 canvas / 图片库重编码：重编码会改像素、改体积、丢色深与 ICC，
// 而本功能要的只是「去掉几个文本块」。

let _crcTable: Uint32Array | null = null
/** CRC32 表（PNG 用反射多项式 0xEDB88320） */
function crcTable(): Uint32Array {
  if (_crcTable) return _crcTable
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  _crcTable = t
  return t
}

/** CRC32 覆盖 chunk 的 type + data（不含 length 字段），分片累加避免额外拼接 */
function crc32Of(parts: Uint8Array[]): number {
  const t = crcTable()
  let c = 0xffffffff
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) c = t[(c ^ p[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function joinBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const p of parts) { out.set(p, pos); pos += p.length }
  return out
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false
  return true
}

function latin1Bytes(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** PNG keyword 规范：Latin-1、1-79 字节、不可有前后空格。
 *  非法字符降级为下划线、超长截断——键名是用户自己填的，能被写进去比静默丢弃好，
 *  但绝不往文件里写非法字节（否则整张图可能被严格的解码器判为损坏）。 */
export function sanitizePngKeyword(raw: string): string {
  return raw.replace(/[^\x20-\x7e\xa1-\xff]/g, '_').slice(0, 79).trim()
}

/** 取文本 chunk 的 keyword（chunk data 开头到第一个 \0，Latin-1）。
 *  tEXt/zTXt/iTXt 三者的 keyword 布局一致 ⇒ 删块无需解压 zTXt 正文。 */
function readTextKeyword(bytes: Uint8Array, start: number, end: number): string | null {
  const dataStart = start + 8
  const dataEnd = end - 4
  const limit = Math.min(dataEnd, dataStart + 80) // keyword ≤79 字节 + 终止符
  let s = ''
  for (let i = dataStart; i < limit; i++) {
    if (bytes[i] === 0) return s
    s += String.fromCharCode(bytes[i])
  }
  return null // 没有终止符 = 不合法，不碰它
}

/**
 * 构造一个文本 chunk（含 length / type / data / CRC）。
 * 纯 ASCII 走 tEXt；含任何非 ASCII（中文署名等）走 iTXt 的 UTF-8 形式。
 * 为什么中文不能塞 tEXt：tEXt 正文按规范是 Latin-1，中文只能被按单字节截断成乱码；
 * iTXt 是 PNG 里唯一能无损装 UTF-8 的标准文本块。
 */
export function makePngTextChunk(keyword: string, text: string): Uint8Array<ArrayBuffer> {
  const kwBytes = latin1Bytes(sanitizePngKeyword(keyword))
  let type: string
  let data: Uint8Array<ArrayBuffer>
  if (isAscii(text)) {
    type = 'tEXt'
    // keyword \0 text(Latin-1)
    data = joinBytes([kwBytes, new Uint8Array([0]), latin1Bytes(text)])
  } else {
    type = 'iTXt'
    // iTXt 结构：keyword \0 压缩标志(0) 压缩方法(0) 语言标签\0 翻译关键词\0 正文(UTF-8)
    // ⇒ keyword 之后紧跟 5 个 0 字节（\0 + flag + method + langTag 的 \0 + translated 的 \0）
    data = joinBytes([kwBytes, new Uint8Array([0, 0, 0, 0, 0]), new TextEncoder().encode(text)])
  }
  const typeBytes = latin1Bytes(type)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length) // length 大端
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32Of([typeBytes, data]))
  return out
}

/**
 * 重写 PNG 文本元数据：删掉 dropKeywords 命中的文本 chunk，并把 entries 插入到
 * 第一个 IDAT 之前（与上面 injectPngTextChunks 的插入位置保持一致）。
 * 返回新数组；无实际改动时返回入参本身 —— 调用方可用 `out === input` 判断「零改动」。
 */
export function rewritePngTextChunks(
  bytes: Uint8Array<ArrayBuffer>,
  dropKeywords: Iterable<string>,
  entries: Array<[string, string]>
): Uint8Array<ArrayBuffer> {
  const drop = new Set<string>()
  for (const k of dropKeywords) drop.add(k)
  if (drop.size === 0 && entries.length === 0) return bytes

  const chunks = [...pngChunks(bytes)]
  if (chunks.length === 0) return bytes // 非法 PNG（签名不符）：宁可不动
  const idat = chunks.find(c => c.type === 'IDAT')
  if (!idat) return bytes // 无 IDAT 不冒险改写
  // 没有 IEND = 文件被截断/畸形（实测 no-IEND 输入也会被改写）：
  // 「看不懂就不动」优先于「尽量去元数据」，否则会把截断图改成另一种畸形。
  if (!chunks.some(c => c.type === 'IEND')) return bytes

  const inserted = entries.map(([k, v]) => makePngTextChunk(k, v))
  const kept: Uint8Array<ArrayBuffer>[] = []
  let dropped = 0
  for (const c of chunks) {
    if (c.start === idat.start) for (const chunk of inserted) kept.push(chunk)
    if (TEXT_TYPES.has(c.type)) {
      const kw = readTextKeyword(bytes, c.start, c.end)
      if (kw !== null && drop.has(kw)) { dropped++; continue }
    }
    kept.push(bytes.slice(c.start, c.end))
  }
  if (dropped === 0 && inserted.length === 0) return bytes

  const head = bytes.slice(0, 8)
  let total = head.length
  for (const c of kept) total += c.length
  // 尾部若有未解析的残余字节（截断/畸形文件），原样保留，绝不丢数据
  const lastEnd = chunks[chunks.length - 1].end
  const tail = lastEnd < bytes.length ? bytes.slice(lastEnd) : null
  const out = new Uint8Array(total + (tail ? tail.length : 0))
  out.set(head, 0)
  let pos = head.length
  for (const c of kept) { out.set(c, pos); pos += c.length }
  if (tail) out.set(tail, pos)
  return out
}
