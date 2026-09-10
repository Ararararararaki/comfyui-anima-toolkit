// ── LoRA 卡片图片加载服务 ──
// 目标：解决「虚拟滚动重建 → 卡片图片重新请求 + 重新解码 → 整屏闪烁」以及
// 「上游 404 / 节点抖动(5xx) 时卡片长时间空白、反复重试」。
//
// 设计照搬项目里已验证的成熟做法：
//   - outputThumbnail.ts：并发限流 + 失败不再重试同一个键
//   - ImageNodeCache.ts：内存缓存必须带**字节上限**（不能只按条数，否则大图撑爆内存）
//
// 不引入任何第三方依赖；缓存源数据用 dataURL（同源字符串，无需 revoke，
// 即使被 LRU 淘汰，正在显示的 <img> 也已持有该字符串，不会瞬间变空白）。

import { escAttr, thumbUrl } from '../utils'

export type LoraImageStatus = 'ok' | 'missing' | 'error'

export interface LoraImageCacheValue {
  status: LoraImageStatus
  /** ok = dataURL；missing/error = 占位 SVG data URI */
  src: string
  /** 仅 ok 计入字节预算（blob.size） */
  bytes: number
  reason?: string
  /** error 类结论带 TTL：5xx/网络抖动是瞬时的，过期后允许下次重建时再试一次 */
  expires?: number
}

// ── 可调参数（理由见文件尾交付说明）──
const CONCURRENCY = 6 // 同时最多 6 个图片请求；首屏数十张并发会被限流排队
const MAX_BYTES = 28 * 1024 * 1024 // 28MB 已解码/缓存字节预算（< outputs 的 32MB）
const RETRIES = 1 // 5xx/网络错误额外重试 1 次（即最多 2 次 fetch）
const BACKOFF_MS = 500 // 重试退避
const ERROR_TTL_MS = 60_000 // 失败结论缓存 60s，过期可再试，避免瞬时抖动永久失效

// ── 占位图（内联 SVG data URI，无需改任何 CSS 文件）──
const TRANSPARENT =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
const PLACEHOLDER = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
    '<rect width="100%" height="100%" fill="#15140f"/>' +
    '<text x="50%" y="48%" fill="#9a9486" font-size="15" text-anchor="middle" font-family="sans-serif">🚫 图片不可用</text>' +
    '<text x="50%" y="62%" fill="#6b665a" font-size="11" text-anchor="middle" font-family="sans-serif">点击重试请刷新栏目</text>' +
    '</svg>',
)}`

// ── 缓存与限流状态 ──
const cache = new Map<string, LoraImageCacheValue>()
const inFlight = new Map<string, Promise<LoraImageCacheValue>>()
const accessOrder: string[] = [] // LRU 顺序（ok 条目按此淘汰）
let totalOkBytes = 0
let active = 0
const queue: (() => void)[] = []

/** 调试开关：window.__loraImgDebug = true 时打印命中日志（默认关闭，避免噪音） */
function debugging(): boolean {
  return typeof window !== 'undefined' && (window as unknown as { __loraImgDebug?: boolean }).__loraImgDebug === true
}

function short(url: string): string {
  return url.length > 44 ? '…' + url.slice(-42) : url
}

// ── 同步读缓存（render 阶段用，命中可直接把 src 写进 HTML，零闪）──
export function getCachedLoraImage(proxiedUrl: string): LoraImageCacheValue | null {
  const v = cache.get(proxiedUrl)
  if (!v) return null
  if (v.expires !== undefined && v.expires <= Date.now()) {
    cache.delete(proxiedUrl)
    return null
  }
  if (debugging() && v.status === 'ok') {
    console.log('[loraCardImage] cache hit', short(proxiedUrl))
  }
  return v
}

// ── 并发限流 ──
function withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active++
      fn().then(resolve, reject).finally(() => {
        active--
        const next = queue.shift()
        if (next) next()
      })
    }
    if (active < CONCURRENCY) run()
    else queue.push(run)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// ── 单次网络取图 ──
// 404 → missing（永久，不再重试）；5xx/网络 → error（交给上层有限重试）
async function fetchImage(proxiedUrl: string): Promise<LoraImageCacheValue> {
  const res = await fetch(proxiedUrl)
  if (res.status === 404) {
    return { status: 'missing', src: PLACEHOLDER, bytes: 0, reason: 'upstream http_404' }
  }
  if (!res.ok) {
    return { status: 'error', src: PLACEHOLDER, bytes: 0, reason: `http_${res.status}` }
  }
  try {
    const blob = await res.blob()
    const dataUrl = await blobToDataUrl(blob)
    return { status: 'ok', src: dataUrl, bytes: blob.size }
  } catch (e) {
    return { status: 'error', src: PLACEHOLDER, bytes: 0, reason: 'decode_fail' }
  }
}

// 5xx/网络错误的有限重试（404 与成功不进这里）
async function loadOnce(proxiedUrl: string): Promise<LoraImageCacheValue> {
  let last: LoraImageCacheValue | null = null
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let v: LoraImageCacheValue
    try {
      v = await fetchImage(proxiedUrl)
    } catch {
      v = { status: 'error', src: PLACEHOLDER, bytes: 0, reason: 'network' }
    }
    if (v.status === 'ok' || v.status === 'missing') return v
    last = v
    if (attempt < RETRIES) await sleep(BACKOFF_MS)
  }
  return last!
}

// ── LRU / 字节预算 ──
function bump(key: string): void {
  const i = accessOrder.indexOf(key)
  if (i >= 0) accessOrder.splice(i, 1)
  accessOrder.push(key)
}

function evictIfNeeded(): void {
  while (totalOkBytes > MAX_BYTES && accessOrder.length > 1) {
    const oldest = accessOrder[0]
    const v = cache.get(oldest)
    if (v && v.status === 'ok') totalOkBytes -= v.bytes
    accessOrder.shift()
    cache.delete(oldest)
  }
}

function store(key: string, v: LoraImageCacheValue): void {
  cache.set(key, v)
  bump(key)
  if (v.status === 'ok') {
    totalOkBytes += v.bytes
    evictIfNeeded()
  } else if (v.status === 'error') {
    v.expires = Date.now() + ERROR_TTL_MS
  }
}

function logResult(v: LoraImageCacheValue, proxiedUrl: string): void {
  const s = short(proxiedUrl)
  if (v.status === 'ok') console.log('[loraCardImage] load ok', s, v.bytes + 'B')
  else if (v.status === 'missing') console.log('[loraCardImage] 404 missing (cached)', s)
  else console.warn('[loraCardImage] load failed', s, v.reason)
}

// ── 对外：异步加载（带请求去重 + 并发限流 + 失败缓存）──
export function loadLoraImage(proxiedUrl: string): Promise<LoraImageCacheValue> {
  const cached = getCachedLoraImage(proxiedUrl)
  if (cached) return Promise.resolve(cached)

  const inflight = inFlight.get(proxiedUrl)
  if (inflight) return inflight // 同 url 多张卡同时请求 → 只发一次

  const p = withConcurrency(() => loadOnce(proxiedUrl)).then((v) => {
    inFlight.delete(proxiedUrl)
    store(proxiedUrl, v)
    logResult(v, proxiedUrl)
    return v
  })
  inFlight.set(proxiedUrl, p)
  return p
}

// ── 渲染期调用：返回一段 <img> 标签 ──
// ok 命中 → 直接把 dataURL 写进 src（重建零闪）；
// missing/error 命中 → 直接写占位（不再请求）；
// 未缓存 → 透明占位 + data-lora-img，等 hydrate 异步填上。
export function loraImgTag(fullUrl: string, idx: number, uid: number): string {
  const proxied = thumbUrl(fullUrl, 400)
  const common = `alt="" data-uid="${uid}" data-imgidx="${idx}" data-fullurl="${escAttr(fullUrl)}"`
  const cached = getCachedLoraImage(proxied)
  if (cached && cached.status === 'ok') {
    return `<img src="${escAttr(cached.src)}" loading="${idx === 0 ? 'eager' : 'lazy'}" ${common}>`
  }
  if (cached && cached.status !== 'ok') {
    return `<img src="${escAttr(cached.src)}" class="lora-img-unavailable" ${common}>`
  }
  return `<img src="${TRANSPARENT}" data-lora-img="${escAttr(proxied)}" ${common}>`
}

// ── 插入 DOM 后调用：为本次渲染里未命中缓存的图发起加载 ──
// 需在 LoraExplorer 把卡片 HTML 写进容器后调用一次（见交付说明第 5 条）。
export function hydrateLoraGallery(root: ParentNode): void {
  root.querySelectorAll<HTMLImageElement>('img[data-lora-img]').forEach((img) => {
    const url = img.dataset.loraImg
    if (!url) return
    const cached = getCachedLoraImage(url)
    if (cached) {
      img.src = cached.src
      img.removeAttribute('data-lora-img')
      return
    }
    loadLoraImage(url).then((res) => {
      if (!img.isConnected) return // 已被虚拟滚动重建，缓存里已有，下次渲染命中
      img.src = res.src
      img.removeAttribute('data-lora-img')
    })
  })
}

// ── 离开栏目时调用，把缓存内存让给生图（见交付说明第 5 条）──
export function clearLoraImageCache(): void {
  cache.clear()
  inFlight.clear()
  accessOrder.length = 0
  totalOkBytes = 0
  queue.length = 0
  active = 0
}

// 调试用：当前缓存占用
export function loraImageCacheInfo(): { entries: number; okBytes: number } {
  return { entries: cache.size, okBytes: totalOkBytes }
}
