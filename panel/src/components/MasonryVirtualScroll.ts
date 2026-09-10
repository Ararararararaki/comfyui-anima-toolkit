import type { VirtualScrollItemStyle } from './VirtualScroll'

export interface MasonryItemRect {
  top: number
  left: number
  width: number
  height: number
}

export interface MasonryVirtualScrollOptions {
  container: HTMLElement
  totalItems: number
  totalHeight: number
  getItemRect: (index: number) => MasonryItemRect
  renderItem: (index: number, style: VirtualScrollItemStyle) => string
  overscanPx?: number
  /**
   * 布局/内容签名。update() 时若签名、总条目数、总高度都未变化，
   * 则不做任何重建（不 replaceChildren）——卡片里的 <img> 会被保留，
   * 避免「重建 → 图片重新请求/重新解码」的首屏抖动与卡顿。
   */
  signature?: string
  beforeRender?: (inner: HTMLElement) => void
  afterRender?: (inner: HTMLElement) => void
}

type ResolvedOptions = Required<MasonryVirtualScrollOptions>

/**
 * 二维瀑布流专用虚拟滚动。
 *
 * 普通 VirtualScroll 的 offsets 是一维前缀和，只适合列表/整行；瀑布流中
 * 相邻数据可能位于不同列、共享同一个 top，因此必须按每张卡的真实矩形判断
 * 可见性和定位，不能再把卡高累加成一条竖直长列表。
 *
 * 性能设计（对齐 ComfyUI-Lora-Manager 的做法）：
 *  1. 几何缓存：布局变化时把每张卡的 top/bottom 预计算进 TypedArray，
 *     并把「按 top 排序」的下标序列一并生成 —— 之后判断可见性不再逐条回调
 *     getItemRect（此前每帧 N 次闭包调用）。
 *  2. 可见性二分：按 top 排序后二分出上界，只回溯可能重叠的少数几条，
 *     复杂度 O(log N + k)，与总数无关。
 *  3. 区间不变跳过：可见集合与上一帧相同则整帧不做任何 DOM 操作。
 *  4. 批量插入：新入窗卡片先攒进 DocumentFragment，最后一次性插入，
 *     避免逐个 appendChild 触发反复 reflow。
 */
export class MasonryVirtualScroll {
  private container: HTMLElement
  private inner: HTMLElement
  private opts: ResolvedOptions
  private renderedItems = new Map<number, HTMLElement>()
  private rafId: number | null = null
  private lastSignature = ''
  private lastVisibleKey = ''
  private onScroll: () => void

  // ── 几何缓存（TypedArray + 按 top 排序的下标，避免每帧 O(N) 闭包调用）──
  private cacheItems = -1
  private cacheHeight = -1
  private cacheHeightSig = ''
  private cTops: Float64Array | null = null
  private cBottoms: Float64Array | null = null
  private cOrder: Int32Array | null = null
  private cMaxHeight = 0

  constructor(options: MasonryVirtualScrollOptions) {
    this.opts = {
      overscanPx: 600,
      signature: '',
      beforeRender: () => {},
      afterRender: () => {},
      ...options,
    }
    this.container = options.container
    this.container.style.overflowY = 'auto'
    this.container.style.position = 'relative'
    this.inner = document.createElement('div')
    this.inner.className = 'virtual-scroll-inner masonry-virtual-scroll-inner'
    this.inner.style.position = 'relative'
    this.inner.style.width = '100%'
    this.container.appendChild(this.inner)

    this.onScroll = () => {
      if (this.rafId !== null) return
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null
        this.render()
      })
    }
    this.container.addEventListener('scroll', this.onScroll, { passive: true })
    this.lastSignature = this.opts.signature
    this.render(true)
  }

  /** 几何变化时重建 TypedArray 与排序下标；否则复用 */
  private ensureGeometryCache(): void {
    const n = this.opts.totalItems
    const sig = `${this.opts.signature}|${n}|${this.opts.totalHeight}`
    if (this.cacheItems === n && this.cacheHeightSig === sig && this.cTops && this.cOrder) return

    const tops = new Float64Array(n)
    const bottoms = new Float64Array(n)
    let maxH = 0
    for (let i = 0; i < n; i++) {
      const r = this.opts.getItemRect(i)
      tops[i] = r.top
      bottoms[i] = r.top + r.height
      if (r.height > maxH) maxH = r.height
    }
    const order = new Int32Array(n)
    for (let i = 0; i < n; i++) order[i] = i
    // 按 top 升序（瀑布流中 top 相同者相邻，排序整体接近有序，V8 上开销很低）
    order.sort((a, b) => tops[a] - tops[b])

    this.cTops = tops
    this.cBottoms = bottoms
    this.cOrder = order
    this.cMaxHeight = maxH
    this.cacheItems = n
    this.cacheHeightSig = sig
    this.cacheHeight = this.opts.totalHeight
  }

  /** O(log N + k) 求可见下标：按 top 排序后二分上界，再回溯可能压住视口顶部的高卡片 */
  private visibleIndexes(): number[] {
    this.ensureGeometryCache()
    const tops = this.cTops!
    const bottoms = this.cBottoms!
    const order = this.cOrder!
    const n = this.opts.totalItems
    const viewTop = this.container.scrollTop - this.opts.overscanPx
    const viewBottom = this.container.scrollTop + this.container.clientHeight + this.opts.overscanPx
    const indexes: number[] = []
    if (n === 0) return indexes

    // 二分：order 中第一个 top > viewBottom 的位置
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tops[order[mid]] > viewBottom) hi = mid
      else lo = mid + 1
    }
    // 从该位置向前回溯：top 低于 (viewTop - 最大卡高) 的一定不可见，可停
    const minTop = viewTop - this.cMaxHeight
    for (let k = lo - 1; k >= 0; k--) {
      const i = order[k]
      const t = tops[i]
      if (t < minTop) break
      if (bottoms[i] >= viewTop) indexes.push(i)
    }
    return indexes
  }

  private render(force = false): void {
    this.opts.beforeRender(this.inner)
    this.inner.style.height = `${Math.max(0, this.opts.totalHeight)}px`

    const visible = this.visibleIndexes()
    // 闸门：可见集合与上一帧完全一致 → 整帧不碰 DOM
    const key = visible.length === 0 ? '0' : `${visible.length}:${visible[0]}:${visible[visible.length - 1]}`
    if (!force && key === this.lastVisibleKey) {
      this.opts.afterRender(this.inner)
      return
    }
    this.lastVisibleKey = key

    const visibleSet = new Set(visible)
    if (force) {
      this.inner.replaceChildren()
      this.renderedItems.clear()
    } else {
      for (const [index, item] of this.renderedItems) {
        if (!visibleSet.has(index)) {
          item.remove()
          this.renderedItems.delete(index)
        }
      }
    }

    // 批量插入：攒进 DocumentFragment 后一次性入 DOM
    const fragment = document.createDocumentFragment()
    for (const index of visible) {
      if (this.renderedItems.has(index)) continue
      const rect = this.opts.getItemRect(index)
      const item = document.createElement('div')
      item.className = 'virtual-scroll-item masonry-virtual-scroll-item'
      item.dataset.index = String(index)
      item.style.position = 'absolute'
      item.style.top = `${Math.round(rect.top)}px`
      item.style.left = `${Math.round(rect.left)}px`
      item.style.width = `${rect.width}px`
      item.style.height = `${rect.height}px`
      item.innerHTML = this.opts.renderItem(index, {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: rect.height,
      })
      fragment.appendChild(item)
      this.renderedItems.set(index, item)
    }
    if (fragment.childNodes.length > 0) this.inner.appendChild(fragment)
    this.opts.afterRender(this.inner)
  }

  update(options: Partial<MasonryVirtualScrollOptions>): void {
    const prevItems = this.opts.totalItems
    const prevHeight = this.opts.totalHeight
    Object.assign(this.opts, options)

    // 签名与几何都没变：只换闭包、不动 DOM。这是首屏不抖动的关键——
    // 否则每次 update() 都会重建全部可见卡片，图片随之重新请求/解码。
    const sig = this.opts.signature
    const geometryChanged = prevItems !== this.opts.totalItems || prevHeight !== this.opts.totalHeight
    if (sig && sig === this.lastSignature && !geometryChanged) return

    this.lastSignature = sig
    this.lastVisibleKey = ''
    this.render(true)
  }

  refresh(): void {
    this.lastSignature = this.opts.signature
    this.lastVisibleKey = ''
    this.render(true)
  }

  scrollToIndex(index: number): void {
    const safeIndex = Math.max(0, Math.min(index, this.opts.totalItems - 1))
    if (this.opts.totalItems > 0) this.container.scrollTop = this.opts.getItemRect(safeIndex).top
  }

  destroy(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.container.removeEventListener('scroll', this.onScroll)
    this.inner.remove()
    this.renderedItems.clear()
    this.cTops = this.cBottoms = null
    this.cOrder = null
    this.cacheItems = -1
  }
}
