/** Read image metadata containers without decoding pixels or inferring prompts.
 *
 * References checked 2026-10-15: W3C PNG Third Edition (text/eXIf), Google's
 * WebP RIFF specification, Pillow 12.1.0 container readers, Piexif 1.1.3's
 * UserComment encoding, and ExifTool's documented Unicode byte-order handling.
 * PNG scans through IEND, JPEG through EOI, WebP through its declared RIFF end.
 * This verifies metadata chunks/segment boundaries, not compressed image data.
 */
export interface ImageMetadataContainer {
  raw: Record<string, string>
  status: 'present' | 'absent' | 'error' | 'unsupported'
  format: 'png' | 'jpeg' | 'webp' | 'unknown'
  /** Stable diagnostic codes and numeric offsets only; never metadata values. */
  warnings: string[]
}

// Pillow's aggregate text policy is 64 MiB. Allow larger individual workflows
// than Pillow's default 1 MiB compressed-text cap, with explicit error on excess.
const FIELD_LIMIT = 16 * 1024 * 1024
const TOTAL_LIMIT = 64 * 1024 * 1024
const JPEG_SCAN_BLOCK = 64 * 1024
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0'
const XMP_EXTENDED_HEADER = 'http://ns.adobe.com/xmp/extension/\0'
const XMP_KEY = 'XML:com.adobe.xmp'
const EXIF_TEXT_TAGS: Record<number, string> = {
  0x010d: 'DocumentName', 0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model',
  0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist', 0x8298: 'Copyright',
  0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9286: 'UserComment',
  0x9c9b: 'XPTitle', 0x9c9c: 'XPComment', 0x9c9d: 'XPAuthor', 0x9c9e: 'XPKeywords',
  0x9c9f: 'XPSubject', 0xa430: 'CameraOwnerName',
}

class MetadataFault extends Error {}
// A damaged ancillary text header can be isolated without discarding another
// independently valid field. Payload decoding/inflate/CRC/limit faults remain
// container errors and must never be downgraded by this marker class.
class PngTextHeaderFault extends MetadataFault {}
function fault(code: string): never { throw new MetadataFault(code) }
function textHeaderFault(code: string): never { throw new PngTextHeaderFault(code) }
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Metadata read cancelled', 'AbortError')
}
function latin1(data: Uint8Array): string {
  // TextDecoder('latin1') actually uses Windows-1252; PNG tEXt is ISO-8859-1.
  let value = ''
  for (let i = 0; i < data.length; i += 8192) value += String.fromCharCode(...data.subarray(i, i + 8192))
  return value
}
function hasPrefix(data: Uint8Array, value: string): boolean {
  if (data.length < value.length) return false
  for (let i = 0; i < value.length; i++) if (data[i] !== value.charCodeAt(i)) return false
  return true
}
function decode(data: Uint8Array, encoding: string): string {
  try { return new TextDecoder(encoding, { fatal: true }).decode(data) }
  catch { return fault('metadata.text.decode-failed') }
}
function utfText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return decode(data.subarray(2), 'utf-16le')
  if (data[0] === 0xfe && data[1] === 0xff) return decode(data.subarray(2), 'utf-16be')
  return decode(data, 'utf-8')
}
function exifAscii(data: Uint8Array): string {
  const end = data.indexOf(0)
  const body = end < 0 ? data : data.subarray(0, end)
  // ASCII tags written as UTF-8 are common; both decodings are lossless here.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body) }
  catch { return latin1(body) }
}

class ContainerReader {
  readonly raw: Record<string, string> = Object.create(null)
  readonly warnings: string[] = []
  found = false
  failed = false
  private storedBytes = 0
  private metadataBytes = 0

  constructor(readonly blob: Blob, readonly signal?: AbortSignal) {}

  warn(code: string): void { if (!this.warnings.includes(code)) this.warnings.push(code) }
  fail(error: unknown, offset: number): void {
    aborted(this.signal)
    this.failed = true
    // Do not log DOM/file errors, metadata keys or decoder exception messages.
    this.warn(`${error instanceof MetadataFault ? error.message : 'metadata.read-failed'} offset=${offset}`)
  }
  put(key: string, value: string, byteLength: number): void {
    if (byteLength > FIELD_LIMIT || this.storedBytes + byteLength > TOTAL_LIMIT) fault('metadata.text.limit')
    this.storedBytes += byteLength
    if (Object.prototype.hasOwnProperty.call(this.raw, key)) this.warn('metadata.duplicate-key.last-value')
    this.raw[key] = value
  }
  async read(start: number, length: number): Promise<Uint8Array> {
    aborted(this.signal)
    if (start < 0 || length < 0 || start + length > this.blob.size) fault('metadata.container.truncated')
    let onAbort: (() => void) | undefined
    const pending = this.blob.slice(start, start + length).arrayBuffer()
    try {
      const buffer = await (this.signal ? Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException('Metadata read cancelled', 'AbortError'))
          this.signal!.addEventListener('abort', onAbort, { once: true })
          if (this.signal!.aborted) onAbort()
        }),
      ]) : pending)
      aborted(this.signal)
      if (buffer.byteLength !== length) fault('metadata.container.truncated')
      return new Uint8Array(buffer)
    } finally {
      if (onAbort) this.signal?.removeEventListener('abort', onAbort)
    }
  }
  async metadata(start: number, length: number): Promise<Uint8Array> {
    this.found = true
    if (length > FIELD_LIMIT + 1024 || this.metadataBytes + length > TOTAL_LIMIT) fault('metadata.container.limit')
    this.metadataBytes += length
    return this.read(start, length)
  }
  async inflate(data: Uint8Array): Promise<Uint8Array> {
    aborted(this.signal)
    if (typeof DecompressionStream === 'undefined') fault('metadata.inflate.unavailable')
    const stream = new Blob([data.slice().buffer]).stream().pipeThrough(new DecompressionStream('deflate'))
    const reader = stream.getReader()
    const onAbort = () => { void reader.cancel().catch(() => {}) }
    this.signal?.addEventListener('abort', onAbort, { once: true })
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        aborted(this.signal)
        const { done, value } = await reader.read()
        aborted(this.signal)
        if (done) break
        total += value.length
        if (total > FIELD_LIMIT || this.storedBytes + total > TOTAL_LIMIT) fault('metadata.inflate.limit')
        chunks.push(value)
      }
      const output = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
      return output
    } catch (error) {
      aborted(this.signal)
      if (error instanceof MetadataFault) throw error
      return fault('metadata.inflate.invalid-zlib')
    } finally {
      this.signal?.removeEventListener('abort', onAbort)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  async pngText(type: string, data: Uint8Array): Promise<void> {
    const separator = data.indexOf(0)
    if (separator < 1 || separator > 79) textHeaderFault('png.text.invalid-keyword')
    const key = latin1(data.subarray(0, separator))
    let body = data.subarray(separator + 1)
    let value: string
    if (type === 'tEXt') value = latin1(body)
    else if (type === 'zTXt') {
      if (body.length < 1) textHeaderFault('png.text.invalid-compression')
      if (body[0] !== 0) fault('png.text.unsupported-compression-method')
      body = await this.inflate(body.subarray(1))
      value = latin1(body)
    } else {
      if (body.length < 2 || body[0] > 1) textHeaderFault('png.text.invalid-itxt')
      const compressed = body[0] === 1
      if (compressed && body[1] !== 0) fault('png.text.unsupported-compression-method')
      const languageEnd = body.indexOf(0, 2)
      const translatedEnd = languageEnd < 0 ? -1 : body.indexOf(0, languageEnd + 1)
      if (translatedEnd < 0) textHeaderFault('png.text.invalid-itxt')
      // TextDecoder('ascii') accepts Windows-1252 bytes. PNG language tags
      // require ASCII; mirror Python's strict language.decode('ascii').
      if (body.subarray(2, languageEnd).some(value => value > 0x7f)) fault('metadata.text.decode-failed')
      decode(body.subarray(languageEnd + 1, translatedEnd), 'utf-8')
      body = body.subarray(translatedEnd + 1)
      if (compressed) body = await this.inflate(body)
      value = decode(body, 'utf-8')
    }
    this.put(key, value, body.length)
  }
  userComment(data: Uint8Array): string | null {
    const body = data.subarray(8)
    if (hasPrefix(data, 'ASCII\0\0\0')) return exifAscii(body)
    if (hasPrefix(data, 'JIS\0\0\0\0\0')) return decode(body, body.includes(0x1b) ? 'iso-2022-jp' : 'shift_jis').replace(/\0+$/, '')
    if (hasPrefix(data, 'UNICODE\0')) {
      if (body.length % 2) fault('exif.user-comment.odd-unicode-length')
      if ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) return utfText(body).replace(/\0+$/, '')
      // Piexif always writes BE; ExifTool/cameras may use TIFF byte order. Like
      // ExifTool, recognize the ASCII zero-byte lane before applying BE default.
      let evenZeros = 0; let oddZeros = 0
      for (let i = 0; i + 1 < Math.min(body.length, 512); i += 2) {
        if (body[i] === 0 && body[i + 1] > 0 && body[i + 1] < 128) evenZeros++
        if (body[i + 1] === 0 && body[i] > 0 && body[i] < 128) oddZeros++
      }
      if (!evenZeros && !oddZeros && body.length) this.warn('exif.user-comment.unmarked-unicode-byte-order')
      return decode(body, oddZeros > evenZeros ? 'utf-16le' : 'utf-16be').replace(/\0+$/, '')
    }
    this.warn('exif.user-comment.encoding-unspecified')
    // Keep safely decodable nonstandard plain UTF-8; binary/unknown encodings
    // remain present without manufacturing a prompt or string from their bytes.
    const undefinedPrefix = data.length >= 8 && data.subarray(0, 8).every(value => value === 0)
    const text = undefinedPrefix ? body : data
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(text)
      return value.includes('\0') ? null : value
    } catch { return null }
  }
  exif(profile: Uint8Array): void {
    const data = hasPrefix(profile, 'Exif\0\0') ? profile.subarray(6) : profile
    if (data.length < 8) fault('exif.invalid-header')
    const order = latin1(data.subarray(0, 2))
    if (order !== 'II' && order !== 'MM') fault('exif.invalid-byte-order')
    const little = order === 'II'
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const u16 = (offset: number): number => view.getUint16(offset, little)
    const u32 = (offset: number): number => view.getUint32(offset, little)
    if (u16(2) !== 42) fault('exif.unsupported-tiff-header')
    const pending = [u32(4)]
    const seen = new Set<number>()
    while (pending.length) {
      aborted(this.signal)
      const offset = pending.shift()!
      if (offset === 0) continue
      if (seen.has(offset) || seen.size >= 64) fault('exif.invalid-directory-cycle')
      seen.add(offset)
      if (offset + 2 > data.length) fault('exif.truncated-directory')
      const count = u16(offset)
      const end = offset + 2 + count * 12
      if (end + 4 > data.length) fault('exif.truncated-directory')
      for (let entry = offset + 2; entry < end; entry += 12) {
        const tag = u16(entry); const type = u16(entry + 2); const count = u32(entry + 4)
        const pointer = tag === 0x8769 || tag === 0x014a
        const name = EXIF_TEXT_TAGS[tag]
        if (!pointer && !name && tag !== 0x02bc) continue
        const unit = type === 3 ? 2 : (type === 4 || type === 13) ? 4 : [1, 2, 7, 129].includes(type) ? 1 : 0
        if (!unit) { this.warn('exif.text.unsupported-field-type'); continue }
        const length = count * unit
        const start = length <= 4 ? entry + 8 : u32(entry + 8)
        if (length > FIELD_LIMIT || start + length > data.length) fault('exif.invalid-field-range')
        if (pointer) {
          if ((type !== 4 && type !== 13) || count > 64) fault('exif.invalid-directory-pointer')
          for (let i = 0; i < count; i++) pending.push(u32(start + i * 4))
          continue
        }
        const bytes = data.subarray(start, start + length)
        const value = tag === 0x9286 ? this.userComment(bytes)
          : tag >= 0x9c9b && tag <= 0x9c9f ? decode(bytes, 'utf-16le').replace(/\0+$/, '')
            : tag === 0x02bc || type === 129 ? utfText(bytes).replace(/\0+$/, '') : exifAscii(bytes)
        if (value !== null) this.put(tag === 0x02bc ? XMP_KEY : name, value, bytes.length)
      }
      pending.push(u32(end))
    }
  }
  async png(): Promise<void> {
    let offset = 8; let imageData = false; let first = true
    while (offset + 12 <= this.blob.size) {
      const header = await this.read(offset, 8)
      const length = new DataView(header.buffer).getUint32(0)
      const type = latin1(header.subarray(4))
      if (!/^[A-Za-z]{4}$/.test(type)) fault('png.invalid-chunk-type')
      if (length > 0x7fffffff || offset + length + 12 > this.blob.size) fault('png.truncated-chunk')
      if (first && (type !== 'IHDR' || length !== 13)) fault('png.invalid-ihdr')
      if (type === 'IHDR') {
        if (!first) fault('png.duplicate-ihdr')
        const data = await this.read(offset + 8, length)
        const view = new DataView(data.buffer)
        const crc = await this.read(offset + 8 + length, 4)
        if (!view.getUint32(0) || !view.getUint32(4) || crc32([header.subarray(4), data]) !== new DataView(crc.buffer).getUint32(0)) fault('png.invalid-ihdr')
      }
      first = false
      const metadata = ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)
      if (metadata) {
        try {
          const data = await this.metadata(offset + 8, length)
          const crc = await this.read(offset + 8 + length, 4)
          if (crc32([header.subarray(4), data]) !== new DataView(crc.buffer).getUint32(0)) fault('png.metadata.invalid-crc')
          if (type === 'eXIf') this.exif(data)
          else await this.pngText(type, data)
        } catch (error) {
          if (error instanceof PngTextHeaderFault) {
            aborted(this.signal)
            this.warn(`${error.message} offset=${offset}`)
          } else this.fail(error, offset)
        }
      }
      if (type === 'IDAT') imageData = true
      if (type === 'IEND') {
        if (length !== 0 || !imageData) fault('png.invalid-iend')
        const crc = await this.read(offset + 8, 4)
        if (crc32([header.subarray(4)]) !== new DataView(crc.buffer).getUint32(0)) fault('png.invalid-iend')
        return
      }
      offset += length + 12
    }
    fault('png.missing-iend')
  }
  async jpegScanMarker(start: number): Promise<number> {
    // Entropy-coded data cannot be skipped by length. Inspect only bounded
    // byte blocks; a pending FF survives the boundary between two blocks.
    let pendingFF = false
    while (start < this.blob.size) {
      const block = await this.read(start, Math.min(JPEG_SCAN_BLOCK, this.blob.size - start))
      let index = 0
      while (index < block.length) {
        if (!pendingFF) {
          const next = block.indexOf(0xff, index)
          if (next < 0) break
          index = next + 1
          pendingFF = true
          continue
        }
        const code = block[index++]
        if (code === 0xff) continue // Marker fill bytes.
        pendingFF = false
        if (code === 0 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) continue
        return start + index - 2 // The final FF immediately before the marker code.
      }
      start += block.length
    }
    return fault('jpeg.missing-scan-or-end')
  }
  async jpeg(): Promise<void> {
    let offset = 2
    let frameSeen = false
    let scanSeen = false
    while (offset < this.blob.size) {
      const head = await this.read(offset, 2)
      if (head[0] !== 0xff || head[1] === 0) fault('jpeg.invalid-marker')
      if (head[1] === 0xff) { offset++; continue }
      const marker = head[1]
      if (marker === 0xd9) {
        if (!frameSeen || !scanSeen) fault('jpeg.invalid-end')
        return
      }
      if (marker === 0x01) { offset += 2; continue }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) fault('jpeg.invalid-marker')
      const size = await this.read(offset + 2, 2)
      const length = new DataView(size.buffer).getUint16(0)
      if (length < 2 || offset + length + 2 > this.blob.size) fault('jpeg.truncated-segment')
      if (JPEG_SOF.has(marker)) frameSeen = true
      if (marker === 0xda) {
        if (!frameSeen) fault('jpeg.missing-frame')
        scanSeen = true
        offset = await this.jpegScanMarker(offset + length + 2)
        continue
      }
      if (marker === 0xfe) {
        try {
          const data = await this.metadata(offset + 4, length - 2)
          this.put('Comment', exifAscii(data), data.length)
        } catch (error) { this.fail(error, offset) }
      } else if (marker === 0xe1) {
        const prefix = await this.read(offset + 4, Math.min(length - 2, XMP_EXTENDED_HEADER.length))
        const exif = hasPrefix(prefix, 'Exif\0\0')
        const xmp = hasPrefix(prefix, XMP_HEADER)
        const extendedXmp = hasPrefix(prefix, XMP_EXTENDED_HEADER)
        if (exif || xmp || extendedXmp) {
          try {
            const data = await this.metadata(offset + 4, length - 2)
            if (exif) this.exif(data)
            else if (xmp) this.put(XMP_KEY, utfText(data.subarray(XMP_HEADER.length)), data.length - XMP_HEADER.length)
            else {
              const start = XMP_EXTENDED_HEADER.length
              if (data.length < start + 40 || !/^[0-9A-Fa-f]{32}$/.test(latin1(data.subarray(start, start + 32)))) fault('jpeg.xmp.invalid-extension-header')
              const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
              const total = view.getUint32(start + 32)
              const partOffset = view.getUint32(start + 36)
              if (total > FIELD_LIMIT) fault('jpeg.xmp.extension-limit')
              if (partOffset + data.length - start - 40 > total) fault('jpeg.xmp.invalid-extension-range')
              this.warn('jpeg.xmp.extended-packet-present')
            }
          } catch (error) { this.fail(error, offset) }
        }
      }
      offset += length + 2
    }
    fault('jpeg.missing-scan-or-end')
  }
  async webp(header: Uint8Array): Promise<void> {
    const end = new DataView(header.buffer).getUint32(4, true) + 8
    if (end < 12 || end !== this.blob.size || end % 2) fault('webp.invalid-riff-length')
    let offset = 12
    let imageSeen = false
    while (offset < end) {
      if (offset + 8 > end) fault('webp.truncated-chunk')
      const chunk = await this.read(offset, 8)
      const type = latin1(chunk.subarray(0, 4))
      const length = new DataView(chunk.buffer).getUint32(4, true)
      const next = offset + 8 + length + (length % 2)
      if (next > end) fault('webp.truncated-chunk')
      if (type === 'EXIF' || type === 'XMP ') {
        try {
          const data = await this.metadata(offset + 8, length)
          if (type === 'EXIF') this.exif(data)
          else this.put(XMP_KEY, utfText(data), data.length)
        } catch (error) { this.fail(error, offset) }
      }
      if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') imageSeen = true
      offset = next
    }
    if (!imageSeen) fault('webp.missing-image')
  }
}

let crcTable: Uint32Array | undefined
function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let value = i
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
      crcTable[i] = value >>> 0
    }
  }
  let crc = 0xffffffff
  for (const data of parts) for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Cancellation rejects AbortError; unreadable/malformed containers return error
 * with any successfully extracted fields retained. Only a completed scan with
 * no text/Exif/XMP reports absent. Unknown signatures report unsupported.
 */
export async function readImageMetadataContainer(blob: Blob, signal?: AbortSignal): Promise<ImageMetadataContainer> {
  const reader = new ContainerReader(blob, signal)
  let format: ImageMetadataContainer['format'] = 'unknown'
  try {
    if (blob.size === 0) fault('metadata.container.empty')
    const header = await reader.read(0, Math.min(blob.size, 12))
    if (PNG_SIGNATURE.every((value, index) => header[index] === value)) { format = 'png'; await reader.png() }
    else if (header.length >= 4 && header.length < 8 && PNG_SIGNATURE.slice(0, header.length).every((value, index) => header[index] === value)) { format = 'png'; fault('png.truncated-signature') }
    else if (header[0] === 0xff && header[1] === 0xd8) { format = 'jpeg'; await reader.jpeg() }
    else if (hasPrefix(header, 'RIFF') && hasPrefix(header.subarray(8), 'WEBP')) { format = 'webp'; await reader.webp(header) }
    else if (hasPrefix(header, 'RIFF') && header.length < 12) fault('metadata.container.truncated')
    else return { raw: reader.raw, format, status: 'unsupported', warnings: reader.warnings }
  } catch (error) { reader.fail(error, 0) }
  return { raw: reader.raw, format, status: reader.failed ? 'error' : reader.found ? 'present' : 'absent', warnings: reader.warnings }
}
