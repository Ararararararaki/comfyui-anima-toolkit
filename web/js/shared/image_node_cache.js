/** Reuse ready thumbnail nodes within a document, bounded by decoded bytes. */
export class ImageNodeCache {
  constructor(maxEntries = 600, maxBytes = 32 * 1024 * 1024) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.nodes = new Map(); this.bytes = new Map(); this.loads = new WeakMap(); this.totalBytes = 0;
  }

  keyOf(img) { return img.dataset.cacheKey || img.dataset.filePath; }
  sizeOf(img) { return (img.naturalWidth || 0) * (img.naturalHeight || 0) * 4; }
  forget(key) {
    const img = this.nodes.get(key), load = img && this.loads.get(img);
    if (load) { img.removeEventListener('load', load); this.loads.delete(img); }
    this.nodes.delete(key); this.totalBytes -= this.bytes.get(key) || 0; this.bytes.delete(key);
  }

  remember(img) {
    const key = this.keyOf(img); if (!key) return;
    this.forget(key);
    this.nodes.set(key, img);
    const size = this.sizeOf(img); this.bytes.set(key, size); this.totalBytes += size;
    if (!img.complete) {
      const version = img.dataset.fileVersion;
      const load = () => { if (this.nodes.get(key) === img && img.dataset.fileVersion === version) this.remember(img); };
      this.loads.set(img, load); img.addEventListener('load', load, { once: true });
    }
    // A single oversized original is also evicted; a byte limit is a real limit.
    while (this.nodes.size && (this.nodes.size > this.maxEntries || this.totalBytes > this.maxBytes)) this.forget(this.nodes.keys().next().value);
  }

  byteSize() { return this.totalBytes; }
  clear() { for (const key of this.nodes.keys()) this.forget(key); }
  capture(inner) { inner.querySelectorAll('img[data-file-path],img[data-cache-key]').forEach(img => this.remember(img)); }
  restore(inner, desiredSources = new Map()) {
    inner.querySelectorAll('img[data-file-path],img[data-cache-key]').forEach(fresh => {
      const key = this.keyOf(fresh); if (!key) return;
      const cached = this.nodes.get(key), desired = desiredSources.get(key) || fresh.getAttribute('src') || '';
      const src = cached?.getAttribute('src') || '';
      // Never steal an image from a second, still visible browser. In-flight
      // nodes keep their original owner; only complete thumbnails are reusable.
      if (cached && cached !== fresh && !cached.isConnected && cached.complete && cached.naturalWidth > 0 &&
          cached.dataset.fileVersion === fresh.dataset.fileVersion && src && (!desired || src === desired)) {
        cached.className = fresh.className; cached.alt = fresh.alt; cached.loading = fresh.loading; cached.decoding = fresh.decoding;
        cached.draggable = fresh.draggable; cached.title = fresh.title;
        cached.style.cssText = fresh.style.cssText; Object.assign(cached.dataset, fresh.dataset);
        fresh.replaceWith(cached); this.remember(cached);
      } else this.remember(fresh);
    });
  }
}
