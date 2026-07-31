import type { PromptParsed } from '../types'

export function parsePromptInput(text: string): PromptParsed[] {
  text = text.trim()
  if (!text) return []
  const results: PromptParsed[] = []

  const hasNaiSyntax = text.includes('::')

  if (hasNaiSyntax) {
    const naiGroupRegex = /(\d+(?:\.\d+)?)\s*::\s*((?:[^:]|:(?!:))+?)\s*::/g
    const groupMatches: { weight: number; content: string; start: number; end: number }[] = []
    let match

    while ((match = naiGroupRegex.exec(text)) !== null) {
      groupMatches.push({
        weight: parseFloat(match[1]),
        content: match[2],
        start: match.index,
        end: match.index + match[0].length,
      })
    }

    let cursor = 0
    for (const gm of groupMatches) {
      if (gm.start > cursor) {
        const bareText = text.slice(cursor, gm.start).trim().replace(/^[,\s]+|[,\s]+$/g, '')
        if (bareText) {
          bareText.split(',').forEach(t => {
            const tag = t.trim().replace(/^artist:\s*/i, '')
            if (tag) results.push({ tag, weight: 1.0 })
          })
        }
      }
      const weight = (isNaN(gm.weight) || gm.weight <= 0) ? 1.0 : Math.round(gm.weight * 10) / 10
      gm.content.split(',').forEach(t => {
        const tag = t.trim().replace(/^artist:\s*/i, '')
        if (tag) results.push({ tag, weight })
      })
      cursor = gm.end
    }

    if (cursor < text.length) {
      const bareText = text.slice(cursor).trim().replace(/^[,\s]+|[,\s]+$/g, '')
      if (bareText) {
        bareText.split(',').forEach(t => {
          const tag = t.trim().replace(/^artist:\s*/i, '')
          if (tag) results.push({ tag, weight: 1.0 })
        })
      }
    }
  } else {
    text.split(',').forEach(token => {
      token = token.trim()
      if (!token) return
      const webuiMatch = token.match(/^\(\s*(.+?)\s*:\s*([\d.]+)\s*\)$/)
      if (webuiMatch) {
        const tag = webuiMatch[1].trim().replace(/^artist:\s*/i, '')
        let w = parseFloat(webuiMatch[2])
        if (isNaN(w) || w <= 0) w = 1.0
        if (tag) results.push({ tag, weight: Math.round(w * 10) / 10 })
      } else {
        const tag = token.replace(/^\(+|\)+$/g, '').trim().replace(/^artist:\s*/i, '')
        if (tag) results.push({ tag, weight: 1.0 })
      }
    })
  }

  return results
}

export function generatePromptText(
  artists: { tag: string; weight: number }[],
  format: 'webui' | 'nai' = 'webui',
): string {
  if (format === 'nai') {
    return artists.map(a => a.weight + '::' + a.tag + '::').join(', ')
  }
  return artists
    .map(a => a.weight === 1.0 ? a.tag : '(' + a.tag + ':' + a.weight + ')')
    .join(', ')
}