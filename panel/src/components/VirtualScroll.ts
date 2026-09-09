// ── 通用虚拟滚动容器 ──
// 固定高度容器 + scroll 计算 + padding 撑高。
// 仅渲染可视区域内的条目，大幅降低大列表的 DOM 节点数。
// 参考 react-window 的 FixedSizeList 思路手写。

export interface VirtualScrollItemStyle {
  position: 'absolute'
  top: number
  left: number | string
  width: string | number
  height: number
}

export interface VirtualScrollOptions {
  container: HTMLElement
  itemHeight: number
  totalItems: number
  overscan?: number
  renderItem: (index: number, style: VirtualScrollItemStyle) => string
  /**
   * 在虚拟行发生增删前后同步执行。调用方可借此暂存并复用昂贵的 DOM 资源
   * （例如已经解码的图片节点），避免一次 update 把它们全部销毁后重新解码。
   */
  beforeRender?: (inner: HTMLElement) => void
  afterRender?: (inner: HTMLElement) => void
  /**
   * 可变条目高度：提供后按 index 计算每条高度（应含条目间间距），
   * 替代固定 itemHeight 的等行高布局（瀑布流等异构高度场景）。
   * 不提供时行为与固定行高完全一致。
   */
  getItemHeight?: (index: number) => number
}

type ResolvedOptions = Required<Omit<VirtualScrollOptions, 'getItemHeight'>> & {
  getItemHeight?: (index: number) => number
}

export class VirtualScroll {
  private container: HTMLElement
  private inner: HTMLElement
  private opts: ResolvedOptions
  private onScroll: () => void
  private rafId: number | null = null
  private renderedStartIndex = -1
  private renderedEndIndex = -1
  private renderedItems = new Map<number, HTMLElement>()

  // 可变高度布局：offsets[i] = 第 i 条顶部位置（offsets[0]=0），total 为内容总高度。
  // 只在 totalItems / itemHeight / getItemHeight 变化时重建。
  private offsets: number[] | null = null
  private sizes: number[] | null = null
  private lastTotalItems = -1
  private lastItemHeight = -1
  private lastGetItemHeight: ((index: number) => number) | null = null

  constructor(opts: VirtualScrollOptions) {
    this.opts = {
      overscan: 5,
      beforeRender: () => {},
      afterRender: () => {},
      ...opts,
    }
    this.container = opts.container

    // 确保容器可滚动
    this.container.style.overflowY = 'auto'
    this.container.style.position = 'relative'

    // 内部容器：用 padding 撑出总滚动高度
    this.inner = document.createElement('div')
    this.inner.className = 'virtual-scroll-inner'
    this.inner.style.position = 'relative'
    this.inner.style.width = '100%'
    this.container.appendChild(this.inner)

    // 绑定滚动事件（passive 提升性能）
    this.onScroll = () => {
      if (this.rafId === null) {
        this.rafId = requestAnimationFrame(() => {
          this.rafId = null
          this.render()
        })
      }
    }
    this.container.addEventListener('scroll', this.onScroll, { passive: true })

    // 首次渲染
    this.render(true)
  }

  // 重建 offsets/sizes。固定行高模式也统一走前缀数组，保证两条路径的滚动换算一致。
  private ensureLayout(): void {
    const { itemHeight, totalItems, getItemHeight } = this.opts
    if (this.lastTotalItems === totalItems && this.lastItemHeight === itemHeight
      && this.lastGetItemHeight === (getItemHeight || null)) return

    const offsets = new Array<number>(totalItems + 1)
    offsets[0] = 0
    let sizes: number[] | null = null
    if (getItemHeight) {
      sizes = new Array<number>(totalItems)
      for (let i = 0; i < totalItems; i++) {
        const s = getItemHeight(i)
        sizes[i] = s
        offsets[i + 1] = offsets[i] + s
      }
    } else {
      for (let i = 0; i < totalItems; i++) offsets[i + 1] = offsets[i] + itemHeight
    }
    this.offsets = offsets
    this.sizes = sizes
    this.lastTotalItems = totalItems
    this.lastItemHeight = itemHeight
    this.lastGetItemHeight = getItemHeight || null
  }

  /** 第一个 offsets[i] >= x 的下标 */
  private lowerBound(x: number): number {
    const arr = this.offsets!
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid] < x) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private render(force = false): void {
    const { overscan, totalItems } = this.opts
    this.ensureLayout()
    const offsets = this.offsets!
    const scrollTop = this.container.scrollTop
    const viewportHeight = this.container.clientHeight

    if (totalItems === 0) {
      this.opts.beforeRender(this.inner)
      this.inner.style.height = 'auto'
      this.inner.style.paddingTop = '0'
      this.inner.style.paddingBottom = '0'
      this.inner.replaceChildren()
      this.renderedStartIndex = -1
      this.renderedEndIndex = -1
      this.renderedItems.clear()
      this.opts.afterRender(this.inner)
      return
    }

    const totalHeight = offsets[totalItems]
    const startIndex = Math.max(0, this.lowerBound(scrollTop) - overscan)
    // 视口底边重用 lowerBound（第一个 top >= 底边的行）：与旧固定行高
    // ceil((scrollTop+viewport)/itemHeight) 的端点语义逐像素一致。
    const endIndex = Math.min(totalItems, this.lowerBound(scrollTop + viewportHeight) + overscan)

    // 范围未变时保留现有 DOM：每个滚动像素都重建 img 会触发重复解码，
    // 即使缩略图已缓存也会短暂显示卡片背景色。
    if (!force && startIndex === this.renderedStartIndex && endIndex === this.renderedEndIndex) return

    this.opts.beforeRender(this.inner)

    // 内层固定总高度，行按其绝对索引定位；这样滚动窗口变化时，重叠行无需改变位置或重建。
    this.inner.style.paddingTop = '0'
    this.inner.style.paddingBottom = '0'
    this.inner.style.height = totalHeight + 'px'

    if (force) {
      this.inner.replaceChildren()
      this.renderedItems.clear()
    }

    // 只移除离开窗口的行，保留重叠行及其已解码的图片元素。
    for (const [index, item] of this.renderedItems) {
      if (index < startIndex || index >= endIndex) {
        item.remove()
        this.renderedItems.delete(index)
      }
    }

    // 仅创建新进入窗口的行。包装层提供固定坐标，让所有现有 renderItem 保持不变。
    for (let i = startIndex; i < endIndex; i++) {
      if (this.renderedItems.has(i)) continue
      const itemTop = offsets[i]
      const itemHeight = offsets[i + 1] - offsets[i]
      const item = document.createElement('div')
      item.className = 'virtual-scroll-item'
      item.dataset.index = String(i)
      item.style.position = 'absolute'
      item.style.top = itemTop + 'px'
      item.style.left = '0'
      item.style.width = '100%'
      item.style.height = itemHeight + 'px'
      item.innerHTML = this.opts.renderItem(i, {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: itemHeight,
      })
      this.inner.appendChild(item)
      this.renderedItems.set(i, item)
    }
    this.renderedStartIndex = startIndex
    this.renderedEndIndex = endIndex
    this.opts.afterRender(this.inner)
  }

  /**
   * 更新配置（如 totalItems 变化时调用）
   */
  update(opts: Partial<VirtualScrollOptions>): void {
    Object.assign(this.opts, opts)
    this.render(true)
  }

  /**
   * 强制重新渲染（如 itemHeight 变化时）
   */
  refresh(): void {
    this.render(true)
  }

  /**
   * 滚动到指定索引
   */
  scrollToIndex(index: number): void {
    this.ensureLayout()
    this.container.scrollTop = this.offsets![Math.min(index, this.opts.totalItems)]
  }

  /**
   * 清理事件监听和 DOM
   */
  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.container.removeEventListener('scroll', this.onScroll)
    this.inner.remove()
  }
}
