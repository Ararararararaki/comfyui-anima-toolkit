/**
 * 缓存并复用已解码的图片 DOM 节点。
 *
 * dataURL / Blob URL 只保证源数据还在，不保证浏览器下一帧前已经完成解码。
 * 虚拟列表重排行时复用同一个 img 节点，才能避免先绘制空容器再重新解码的黑帧。
 */
export class ImageNodeCache {
  private nodes = new Map<string, HTMLImageElement>()

  constructor(private readonly maxEntries = 600) {}

  remember(img: HTMLImageElement): void {
    const path = img.dataset.filePath
    if (!path) return
    if (this.nodes.has(path)) this.nodes.delete(path)
    this.nodes.set(path, img)
    while (this.nodes.size > this.maxEntries) {
      const oldest = this.nodes.keys().next().value
      if (oldest === undefined) break
      this.nodes.delete(oldest)
    }
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
