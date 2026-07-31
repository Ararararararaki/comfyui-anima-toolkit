// ── 缩略图生成与缓存服务 ──

import type { OutputThumbnail } from '../types/outputs'
import { outputsDb } from '../db/outputsDb'

const MAX_THUMBNAILS = 200
const THUMBNAIL_SIZE = 200

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

async function createThumbnailFromBlob(
  blob: Blob,
  size: number = THUMBNAIL_SIZE
): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve({ dataUrl: '', width: 0, height: 0 })
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

      resolve({
        dataUrl: canvas.toDataURL('image/jpeg', 0.8),
        width: w,
        height: h,
      })
    }
    img.onerror = () => resolve({ dataUrl: '', width: 0, height: 0 })
    img.src = URL.createObjectURL(blob)
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

export async function clearThumbnailCache(): Promise<void> {
  await outputsDb.thumbnails.clear()
  accessOrder = []
}
