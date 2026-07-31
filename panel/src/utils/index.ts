export function fmtNum(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

export function esc(s: string): string {
  if (typeof s !== 'string') s = String(s ?? '')
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: unknown[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

export function stripHtml(html: string): string {
  if (!html) return ''
  const d = document.createElement('div')
  d.innerHTML = html
  return (d.textContent || d.innerText || '').replace(/\s+/g, ' ').trim()
}

export function thumbUrl(url: string, width = 400): string {
  if (!url) return url
  let u = url
  if (u.includes('original=true')) u = u.replace('original=true', `width=${width}`)
  if (u.includes('width=')) u = u.replace(/width=\d+/g, `width=${width}`)
  // C 站图走后端代理（浏览器无代理无法直连 image.civitai.com，ComfyUI 后端可走代理）
  if (u.startsWith('https://image.civitai.com/')) {
    return '/anima/image?url=' + encodeURIComponent(u)
  }
  return u
}

export function copyText(text: string, el?: HTMLElement) {
  navigator.clipboard.writeText(text).then(() => {
    if (el) {
      const orig = el.textContent!
      el.textContent = '✅ 已复制!'
      el.classList.add('copied')
      setTimeout(() => { el.textContent = orig; el.classList.remove('copied') }, 1500)
    }
  }).catch(() => {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
    if (el) { el.textContent = '✅ 已复制!'; setTimeout(() => el.textContent = '📋 复制', 1500) }
  })
}

let toastTimer: ReturnType<typeof setTimeout>
export function showToast(msg: string, type = '') {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.className = 'toast ' + type
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500)
}
