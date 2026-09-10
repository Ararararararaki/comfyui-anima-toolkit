/**
 * 缓存并复用已解码的图片 DOM 节点。
 *
 * dataURL / Blob URL 只保证源数据还在，不保证浏览器下一帧前已经完成解码。
 * 虚拟列表重排行时复用同一个 img 节点，才能避免先绘制空容器再重新解码的黑帧。
 *
 * ⚠️ 容量必须**双重限制**（2026-09-10 修）：
 * 只按「条数」限制挡不住大图。保留 600 个节点时，如果其中混入了接近原始分辨率的图
 * （每张解码位图约 4~6MB），600 × 4.3MB ≈ **2.6GB** —— 用户实测到过这个数字。
 * 现在同时按「已解码位图字节数」计费并 LRU 淘汰，条数上限退化为次级保险。
 */
export class ImageNodeCache {
  private nodes = new Map<string, HTMLImageElement>()
  private bytes = new Map<string, number>()
  private totalBytes = 0

  constructor(
    private readonly maxEntries = 600,
    /**
     * 已解码位图内存预算（字节）。
     * 目标：面板是本地管理工具，**不能和生图抢内存**（ComfyUI 需要大块 RAM/VRAM）。
     * 默认 32MB ≈ 130 张 200px 缩略图，足够滚动复用；宁可多解码几次，也不常驻几十上百 MB。
     */
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  /** 估算一个节点的解码内存：宽 × 高 × 4 字节（未加载完时返回 0，由条数上限兜底） */
  private sizeOf(img: HTMLImageElement): number {
    const w = img.naturalWidth || 0
    const h = img.naturalHeight || 0
    return w > 0 && h > 0 ? w * h * 4 : 0
  }

  remember(img: HTMLImageElement): void {
    const path = img.dataset.filePath
    if (!path) return
    if (this.nodes.has(path)) {
      this.totalBytes -= this.bytes.get(path) || 0
      this.nodes.delete(path)
      this.bytes.delete(path)
    }
    this.nodes.set(path, img)
    const size = this.sizeOf(img)
    this.bytes.set(path, size)
    this.totalBytes += size

    // LRU 淘汰：条数或字节预算任一超限就丢最旧的（至少保留 1 个，避免死循环）
    while ((this.nodes.size > this.maxEntries || this.totalBytes > this.maxBytes) && this.nodes.size > 1) {
      const oldest = this.nodes.keys().next().value
      if (oldest === undefined) break
      this.nodes.delete(oldest)
      this.totalBytes -= this.bytes.get(oldest) || 0
      this.bytes.delete(oldest)
    }
  }

  /** 当前占用（字节，仅统计已能算出尺寸的节点；调试用） */
  byteSize(): number {
    return this.totalBytes
  }

  /** 全部丢弃（离开栏目时调用，把已解码位图的内存让给生图） */
  clear(): void {
    this.nodes.clear()
    this.bytes.clear()
    this.totalBytes = 0
  }

  capture(inner: HTMLElement): void {
    inner.querySelectorAll<HTMLImageElement>('img[data-file-path]').forEach(img => this.remember(img))
  }

  restore(inner: HTMLElement, desiredSources: ReadonlyMap<string, string>): void {
    inner.querySelectorAll<HTMLImageElement>('img[data-file-path]').forEach(fresh => {
      const path = fresh.dataset.filePath
      if (!path) return
      const desiredSrc = desiredSources.get(path)
      const cached = this.nodes.get(path)
      const cachedSrc = cached?.getAttribute('src') || ''
      const sameFileVersion = cached?.dataset.fileVersion === fresh.dataset.fileVersion

      if (cached && cached !== fresh && sameFileVersion && cachedSrc && (!desiredSrc || cachedSrc === desiredSrc)) {
        fresh.replaceWith(cached)
        this.remember(cached)
        return
      }
      this.remember(fresh)
    })
  }
}
