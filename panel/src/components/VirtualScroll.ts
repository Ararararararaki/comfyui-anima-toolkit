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
}

export class VirtualScroll {
  private container: HTMLElement
  private inner: HTMLElement
  private opts: Required<VirtualScrollOptions>
  private onScroll: () => void
  private rafId: number | null = null

  constructor(opts: VirtualScrollOptions) {
    this.opts = { overscan: 5, ...opts }
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
    this.render()
  }

  private render(): void {
    const { itemHeight, overscan, totalItems } = this.opts
    const scrollTop = this.container.scrollTop
    const viewportHeight = this.container.clientHeight

    if (totalItems === 0) {
      this.inner.style.paddingTop = '0'
      this.inner.style.paddingBottom = '0'
      this.inner.innerHTML = ''
      return
    }

    const totalHeight = totalItems * itemHeight
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
    const endIndex = Math.min(totalItems, Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan)

    // 用 padding 撑出滚动空间
    this.inner.style.paddingTop = (startIndex * itemHeight) + 'px'
    this.inner.style.paddingBottom = (Math.max(0, totalItems - endIndex) * itemHeight) + 'px'

    // 只渲染可见条目
    let html = ''
    for (let i = startIndex; i < endIndex; i++) {
      html += this.opts.renderItem(i, {
        position: 'absolute',
        top: (i - startIndex) * itemHeight,
        left: 0,
        width: '100%',
        height: itemHeight,
      })
    }
    this.inner.innerHTML = html
  }

  /**
   * 更新配置（如 totalItems 变化时调用）
   */
  update(opts: Partial<VirtualScrollOptions>): void {
    Object.assign(this.opts, opts)
    this.render()
  }

  /**
   * 强制重新渲染（如 itemHeight 变化时）
   */
  refresh(): void {
    this.render()
  }

  /**
   * 滚动到指定索引
   */
  scrollToIndex(index: number): void {
    const { itemHeight } = this.opts
    this.container.scrollTop = index * itemHeight
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
