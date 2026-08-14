// ── 缩略图生成与缓存服务 ──

import type { OutputThumbnail } from '../types/outputs'
import { outputsDb } from '../db/outputsDb'

const MAX_THUMBNAILS = 200
const THUMBNAIL_SIZE = 200

// 缩略图解码并发限制：首屏数百张同时 new Image() 解码大图会阻塞主线程，限制同时解码数量
let _thumbActive = 0
const _thumbQueue: (() => void)[] = []
const _THUMB_CONCURRENT = 4

let accessOrder: string[] = []

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

  // 清理旧缓存
  if (accessOrder.length > MAX_THUMBNAILS) {
    const toRemove = accessOrder.splice(0, accessOrder.length - MAX_THUMBNAILS)
    for (const key of toRemove) {
      await outputsDb.thumbnails.delete(key)
    }
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
}
