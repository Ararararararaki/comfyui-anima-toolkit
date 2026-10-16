export const MAX_BYTES = 32 * 1024 * 1024
export const TICKET_TTL_MS = 90000

export function localPage(raw) {
  try {
    const u = new URL(raw)
    const port = Number(u.port || 80)
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) && port >= 1 && port <= 65535 && !u.username && !u.password
  } catch { return false }
}

export function uploadPage(raw) {
  try {
    const u = new URL(raw)
    return u.origin === 'https://www.pixiv.net' && !u.username && !u.password
  } catch { return false }
}

export function cleanURL(raw) {
  const u = new URL(raw)
  if (!localPage(raw) || u.pathname !== '/anima/gallery/share' || u.hash) throw Error('仅接收本机 Toolkit 分享导出地址')
  const entries = [...u.searchParams.keys()]
  if (new Set(entries).size !== entries.length) throw Error('导出地址参数重复')
  if (u.searchParams.has('token')) {
    if (entries.length !== 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(u.searchParams.get('token'))) throw Error('导出票据无效')
  } else {
    // Compatibility with Toolkit's existing local-gallery export route.
    if (entries.length !== 4 || !['path', 'root', 'mtime', 'size'].every(k => u.searchParams.has(k)) || !u.searchParams.get('path')) throw Error('导出参数不完整')
    for (const k of ['mtime', 'size']) {
      const value = u.searchParams.get(k)
      if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw Error('图片版本参数无效')
    }
  }
  return u.href
}

export async function readClean(url, fetcher = fetch) {
  const response = await fetcher(cleanURL(url), { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw Error(`导出图片读取失败 HTTP ${response.status}`)
  if (response.headers.get('content-type')?.split(';')[0].trim() !== 'image/png') throw Error('导出服务没有返回 PNG')
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw Error('图片超过接收桥单张 32 MiB 限制')
  if (!response.body) throw Error('导出服务没有返回图片内容')
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) throw Error('图片超过接收桥单张 32 MiB 限制'); chunks.push(value) }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) throw Error('PNG 文件签名无效')
  // Preserve Toolkit's final bytes, including its global metadata policy.
  // Chromium runtime messages use JSON, not transferable ArrayBuffers.
  let binary = ''; for (let i = 0; i < size; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return { base64: btoa(binary), size, mime: 'image/png' }
}

export function createBridge({ now = Date.now, makeID = () => crypto.randomUUID(), read = readClean } = {}) {
  let armed = null, reading = false
  return {
    async handle(message, senderURL) {
      if (message.kind === 'arm') {
        if (!localPage(senderURL)) throw Error('来源不是本机 Toolkit')
        const url = cleanURL(message.url)
        if (new URL(url).origin !== new URL(senderURL).origin) throw Error('导出地址来源不一致')
        const name = String(message.name || 'image-export.png').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 180)
        armed = { id: makeID(), url, name: name.endsWith('.png') ? name : name + '.png', expires: now() + TICKET_TTL_MS }
        return { ok: true }
      }
      if (!uploadPage(senderURL)) throw Error('接收端不是 Pixiv')
      if (armed && armed.expires <= now()) armed = null
      const current = armed
      if (message.kind === 'peek') return { ok: true, copy: current && { id: current.id, name: current.name, expires: current.expires } }
      if (message.kind !== 'receive') throw Error('接收请求无效')
      if (!current || current.id !== message.id) throw Error('图片接收票据已过期，请重新拖出')
      if (message.url && cleanURL(message.url) !== current.url) throw Error('拖入地址与刚拖出的图片不一致')
      if (reading) throw Error('正在接收一张图片，请稍后重试')
      reading = true
      try { return { ok: true, name: current.name, ...(await read(current.url)) } } finally { reading = false }
    },
  }
}
