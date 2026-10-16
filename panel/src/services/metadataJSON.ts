export interface MetadataJSONResult {
  value: any | null
  warnings: string[]
}

/** Preserve integer tokens before JSON.parse can round a 64-bit seed. This is
 * a lexical pass, not a regex over strings: escaped text and keys stay exact.
 * ComfyUI's non-standard NaN/Infinity tokens require an explicit opt-in; callers
 * that need diagnostics can use the result API instead of losing that fact.
 */
export function parseMetadataJSONResult(text: string, allowNonFinite = false): MetadataJSONResult {
  if (typeof text !== 'string') return { value: null, warnings: ['invalid-metadata-json'] }
  let cursor = 0, start = 0
  const pieces: string[] = [], warnings: string[] = []
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
  const replace = (end: number, replacement: string) => {
    pieces.push(text.slice(start, cursor), replacement)
    cursor = end; start = end
  }
  while (cursor < text.length) {
    const char = text[cursor]
    if (char === '"') {
      cursor++
      while (cursor < text.length) {
        if (text[cursor] === '\\') { cursor += 2; continue }
        if (text[cursor++] === '"') break
      }
      continue
    }
    if (char === '-' || char >= '0' && char <= '9') {
      numberPattern.lastIndex = cursor
      const match = numberPattern.exec(text)
      if (match) {
        const token = match[0]
        const numeric = Number(token)
        if ((!/[.eE]/.test(token) && !Number.isSafeInteger(numeric))
          || !Number.isFinite(numeric) || Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) {
          replace(cursor + token.length, JSON.stringify(token))
          continue
        }
        cursor += token.length
        continue
      }
    }
    if (allowNonFinite) {
      const token = text.startsWith('-Infinity', cursor) ? '-Infinity'
        : text.startsWith('Infinity', cursor) ? 'Infinity' : text.startsWith('NaN', cursor) ? 'NaN' : ''
      if (token && (cursor === 0 || /[\s\[:,]/.test(text[cursor - 1])) && /[\s,\]}]|^$/.test(text[cursor + token.length] || '')) {
        if (!warnings.includes('non-finite-json-number')) warnings.push('non-finite-json-number')
        replace(cursor + token.length, 'null')
        continue
      }
    }
    cursor++
  }
  try { return { value: JSON.parse(pieces.length ? pieces.join('') + text.slice(start) : text), warnings } }
  catch { return { value: null, warnings: [...warnings, 'invalid-metadata-json'] } }
}

export function parseMetadataJSON(text: string, allowNonFinite = false): any | null {
  return parseMetadataJSONResult(text, allowNonFinite).value
}
