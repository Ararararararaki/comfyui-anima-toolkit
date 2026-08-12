import { icon } from './icon'

export { icon }

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

// 去掉文件扩展名(sigrika_v1.safetensors → sigrika_v1),用于与节点 LoRA 名(无扩展名)对齐
export function stripExt(name: string): string {
  return name.replace(/\.(safetensors|pt|ckpt|pth|sft|bin)$/i, '')
}

export function stripHtml(html: string): string {
  if (!html) return ''
  // 用 DOMParser 解析：不触发 img onerror / svg onload 等内联脚本（innerHTML 赋值会在解析瞬间执行，构成 UGC XSS）
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
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

// 复制反馈：每按钮独立保存原始 innerHTML（WeakMap 自动随元素 GC），
// 恢复时各按钮互不影响，天然幂等（重复恢复同一原始内容无害）
const _copyOrigMap = new WeakMap<HTMLElement, string>()
export function copyText(text: string, el?: HTMLElement) {
  if (el && !_copyOrigMap.has(el)) _copyOrigMap.set(el, el.innerHTML)
  const restore = (target: HTMLElement) => {
    const orig = _copyOrigMap.get(target)
    if (orig !== undefined) {
      // 用 innerHTML 恢复，避免抹掉按钮内的 SVG 图标
      target.innerHTML = orig
      target.classList.remove('copied')
      _copyOrigMap.delete(target)
    }
  }
  navigator.clipboard.writeText(text).then(() => {
    if (el) {
      el.innerHTML = '✅ 已复制!'
      el.classList.add('copied')
      setTimeout(() => restore(el), 1500)
    }
  }).catch(() => {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
    if (el) {
      el.innerHTML = '✅ 已复制!'
      el.classList.add('copied')
      setTimeout(() => restore(el), 1500)
    }
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
// ── SVG icon helpers（配合 data-icon 属性 / 动态按钮图标）──

// 给带 data-icon 属性的元素注入 SVG 图标（放在文本前），幂等：已注入则跳过
export function injectIcon(el: HTMLElement, name?: string, size = 14): boolean {
  const iconName = name || el.dataset.icon
  if (!iconName || el.querySelector('svg')) return false
  el.insertAdjacentHTML('afterbegin', icon(iconName, size))
  return true
}

// 初始化页面内所有 [data-icon] 元素
export function initIconButtons() {
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => injectIcon(el))
}

// 动态更新按钮内容 = SVG 图标 + 文本（用于 JS 覆盖 textContent 的按钮）
export function setBtnIcon(el: HTMLElement | null, iconName: string, text: string, size = 14) {
  if (!el) return
  el.innerHTML = icon(iconName, size) + '<span>' + esc(text) + '</span>'
}

// 给搜索框注入「清除 ✕」按钮：有输入时显示，点击清空并触发 onClear 回调。
// 幂等：同一输入框只注入一次。按钮放在 .search-wrap / .search-clear-host 容器内。
export function attachSearchClear(input: HTMLInputElement, onClear: () => void): void {
  const host = input.closest('.search-wrap, .search-clear-host, .local-sidebar-search, .outputs-search-wrap') as HTMLElement | null
  if (!host || host.querySelector('.search-clear')) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'search-clear'
  btn.title = '清空搜索'
  btn.setAttribute('aria-label', '清空搜索')
  btn.innerHTML = icon('x', 14)
  const update = () => { btn.style.display = input.value ? 'flex' : 'none' }
  btn.addEventListener('click', () => {
    input.value = ''
    update()
    input.focus()
    onClear()
  })
  input.addEventListener('input', update)
  host.appendChild(btn)
  update()
}
