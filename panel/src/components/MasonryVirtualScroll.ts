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
 */
export class MasonryVirtualScroll {
  private container: HTMLElement
  private inner: HTMLElement
  private opts: ResolvedOptions
  private renderedItems = new Map<number, HTMLElement>()
  private rafId: number | null = null
  private onScroll: () => void

  constructor(options: MasonryVirtualScrollOptions) {
    this.opts = {
      overscanPx: 600,
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
    this.render(true)
  }

  private visibleIndexes(): number[] {
    const top = Math.max(0, this.container.scrollTop - this.opts.overscanPx)
    const bottom = this.container.scrollTop + this.container.clientHeight + this.opts.overscanPx
    const indexes: number[] = []
    for (let index = 0; index < this.opts.totalItems; index++) {
      const rect = this.opts.getItemRect(index)
      if (rect.top + rect.height >= top && rect.top <= bottom) indexes.push(index)
    }
    return indexes
  }

  private render(force = false): void {
    this.opts.beforeRender(this.inner)
    this.inner.style.height = `${Math.max(0, this.opts.totalHeight)}px`

    const visible = this.visibleIndexes()
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
      this.inner.appendChild(item)
      this.renderedItems.set(index, item)
    }
    this.opts.afterRender(this.inner)
  }

  update(options: Partial<MasonryVirtualScrollOptions>): void {
    Object.assign(this.opts, options)
    this.render(true)
  }

  refresh(): void {
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
  }
}
