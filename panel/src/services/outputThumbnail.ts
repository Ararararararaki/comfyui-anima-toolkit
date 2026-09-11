// ── 缩略图生成与缓存服务 ──

import type { OutputThumbnail } from '../types/outputs'
import { outputsDb } from '../db/outputsDb'

const MAX_THUMBNAILS = 2000
/**
 * 缩略图长边像素。
 * 200 → 160（2026-09-10）：面板定位是"轻量本地管理、不与生图抢资源"，
 * 解码位图与 dataURL 内存/带宽均随面积下降约 35%。卡片宽度约 250px，160px 略有放大但不影响辨识。
 * 注意：IndexedDB 缓存键只用路径哈希（不含尺寸），所以旧 200px 缓存仍会被复用、不会失效。
 */
const THUMBNAIL_SIZE = 160

// LRU 访问顺序持久化：没有它，刷新页面后顺序清零，2000 张上限形同虚设
const LRU_KEY = 'anima_outputs_thumb_lru'
let _lruSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleLruPersist(): void {
  if (_lruSaveTimer) return
  _lruSaveTimer = setTimeout(() => {
    _lruSaveTimer = null
    try {
      localStorage.setItem(LRU_KEY, JSON.stringify(accessOrder.slice(-MAX_THUMBNAILS)))
    } catch { /* localStorage 配额不足时静默放弃，仅损失跨会话顺序 */ }
  }, 3000)
}

function restoreLru(): void {
  try {
    const raw = localStorage.getItem(LRU_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as string[]
      if (Array.isArray(arr)) accessOrder = arr.slice(-MAX_THUMBNAILS)
    }
  } catch { accessOrder = [] }
}

// 缩略图解码并发限制：首屏数百张同时 new Image() 解码大图会阻塞主线程，限制同时解码数量
let _thumbActive = 0
const _thumbQueue: (() => void)[] = []
const _THUMB_CONCURRENT = 4

let accessOrder: string[] = []
restoreLru()

function hashPath(path: string): string {
  let hash = 0
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export async function createThumbnailFromBlob(
  blob: Blob,
  size: number = THUMBNAIL_SIZE
): Promise<{ dataUrl: string; width: number; height: number }> {
  // 限流：同时最多 _THUMB_CONCURRENT 个解码，超出排队，避免首屏大量图片同时解码阻塞主线程
  while (_thumbActive >= _THUMB_CONCURRENT) {
    await new Promise<void>((res) => _thumbQueue.push(res))
  }
  _thumbActive++
  try {
    return await _createThumbFromBlob(blob, size)
  } finally {
    _thumbActive--
    const next = _thumbQueue.shift()
    if (next) next()
  }
}

async function _createThumbFromBlob(
  blob: Blob,
  size: number = THUMBNAIL_SIZE
): Promise<{ dataUrl: string; width: number; height: number }> {
  // ── 快路径：createImageBitmap 的 resize 选项在浏览器图像管线里完成解码 + 缩放，
  //    主线程只把已经缩小的小位图（200px 级）画到画布上，开销从数百毫秒降到 ~1ms。
  //    旧实现直接把数千像素的原图 drawImage 缩到 200px 并同步 toDataURL：单张可占主线程
  //    数百毫秒，同时加载数十张就会把主线程堵死——表现为「图片加载期间所有按钮都点不了、
  //    切换栏目也没反应，要等加载完才能操作」。
  if (typeof createImageBitmap === 'function') {
    try {
      // 超大文件先挡掉（解码峰值保护）；正常图片由解码器直接按目标宽度下采样
      if (blob.size <= 80 * 1024 * 1024) {
        const bmp = await createImageBitmap(blob, { resizeWidth: size, resizeQuality: 'low' })
        const w = bmp.width
        const h = bmp.height
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(bmp, 0, 0)
          bmp.close?.()
          return { dataUrl: canvas.toDataURL('image/jpeg', 0.8), width: w, height: h }
        }
        bmp.close?.()
      }
    } catch {
      /* 个别格式不支持 resize 选项时，回退到下面的 Image 路径 */
    }
  }

  return new Promise((resolve) => {
    const img = new Image()
    // 创建后必须 revoke，否则每张新缩略图泄漏一个 Blob URL（底层 Blob 无法回收）
    const url = URL.createObjectURL(blob)
    const done = (result: { dataUrl: string; width: number; height: number }) => {
      URL.revokeObjectURL(url)
      resolve(result)
    }
    img.onload = () => {
      // 像素炸弹防护：超大尺寸图片（如 40000x40000）完整解码内存峰值可达数百 MB，直接放弃缩略图
      const MAX_PIXELS = 40 * 1000 * 1000 // 4000 万像素上限（review should-fix 修复）
      if (img.naturalWidth * img.naturalHeight > MAX_PIXELS) {
        done({ dataUrl: '', width: 0, height: 0 })
        return
      }
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        done({ dataUrl: '', width: 0, height: 0 })
        return
      }

      let { naturalWidth: w, naturalHeight: h } = img
      if (w > size || h > size) {
        const ratio = Math.min(size / w, size / h)
        w = Math.round(w * ratio)
        h = Math.round(h * ratio)
      }

      canvas.width = w
      canvas.height = h
      ctx.drawImage(img, 0, 0, w, h)

      done({
        dataUrl: canvas.toDataURL('image/jpeg', 0.8),
        width: w,
        height: h,
      })
    }
    img.onerror = () => done({ dataUrl: '', width: 0, height: 0 })
    img.src = url
  })
}

export async function getThumbnail(
  file: File,
  fileId: string
): Promise<string> {
  const id = hashPath(fileId)

  // 检查缓存
  const cached = await outputsDb.thumbnails.get(id)
  if (cached) {
    // 更新访问顺序
    accessOrder = accessOrder.filter(k => k !== id)
    accessOrder.push(id)
    scheduleLruPersist()
    return cached.dataUrl
  }

  // 创建缩略图
  const result = await createThumbnailFromBlob(file)
  if (!result.dataUrl) return ''

  // 保存到缓存
  const thumbnail: OutputThumbnail = {
    id,
    dataUrl: result.dataUrl,
    width: result.width,
    height: result.height,
    createdAt: Date.now(),
  }
  await outputsDb.thumbnails.put(thumbnail)

  // 更新访问顺序
  accessOrder.push(id)
  scheduleLruPersist()

  // 清理旧缓存
  if (accessOrder.length > MAX_THUMBNAILS) {
    const toRemove = accessOrder.splice(0, accessOrder.length - MAX_THUMBNAILS)
    for (const key of toRemove) {
      await outputsDb.thumbnails.delete(key)
    }
    scheduleLruPersist()
  }

  return result.dataUrl
}

/** 批量把 DB 缩略图读回内存（一次 bulkGet 替代每张图独立查询），返回 path → dataUrl */
export async function preloadThumbnailsFromDb(files: { path: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (files.length === 0) return out
  const ids = files.map(f => hashPath(f.path))
  const cached = await outputsDb.thumbnails.bulkGet(ids)
  for (let i = 0; i < files.length; i++) {
    const thumb = cached[i]
    if (thumb?.dataUrl) out.set(files[i].path, thumb.dataUrl)
  }
  return out
}

export async function getCachedThumbnail(fileId: string): Promise<string | null> {
  const id = hashPath(fileId)
  const cached = await outputsDb.thumbnails.get(id)
  if (cached) {
    accessOrder = accessOrder.filter(k => k !== id)
    accessOrder.push(id)
    scheduleLruPersist()
    return cached.dataUrl
  }
  return null
}

/** 按文件路径删除缩略图缓存（文件变更后失效旧图） */
export async function deleteThumbnails(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await outputsDb.thumbnails.bulkDelete(paths.map(hashPath))
}

export async function clearThumbnailCache(): Promise<void> {
  await outputsDb.thumbnails.clear()
  accessOrder = []
  try { localStorage.removeItem(LRU_KEY) } catch { /* 忽略 */ }
}

// ── 后端直供图源（插件 ≥2.5.1 的 /anima/thumb）：浏览器只解码小图，不再自己读盘生成 ──

let _backendThumbs: boolean | null = null

export function animaThumbUrl(relPath: string, width: 512 | 768 = 512): string {
  return `/anima/thumb?path=${encodeURIComponent(relPath)}&w=${width}`
}

export function backendThumbsEnabled(): boolean {
  return _backendThumbs === true
}

/** 探测后端缩略图端点是否可用。会话内只探测一次，失败走旧管线。
 *
 * ⚠️ 2026-09-11 修正：不要按 /anima/version 的版本号判断 —— 运行目录的 py 靠手动同步，
 * __init__.py 的版本号经常落后于实际能力（本机就出现过 2.4.0 但 /anima/thumb 已上线的组合）。
 * 改为直接探测端点本身：新版对未知 path 返回 JSON 错误体（application/json），
 * 旧版没有该路由、返回 aiohttp 默认 404（text/plain/html），用 Content-Type 精确区分。
 */
export async function probeBackendThumbs(): Promise<boolean> {
  if (_backendThumbs !== null) return _backendThumbs
  try {
    const resp = await fetch('/anima/thumb?path=__probe__&w=512', { cache: 'no-store' })
    const contentType = resp.headers.get('content-type') || ''
    _backendThumbs = contentType.includes('application/json')
    return _backendThumbs
  } catch { /* 后端不可用：走旧管线 */ }
  _backendThumbs = false
  return false
}
