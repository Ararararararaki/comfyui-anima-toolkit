// ── Outputs 目录扫描 Manifest 缓存服务 ──
// 复用 LocalManager 的 Manifest 模式：通过 mtime+size 比对实现增量扫描
// 参考: src/store/localModels.ts 的 Manifest 逻辑

import { outputsDb, type OutputManifest } from '../db/outputsDb'
import type { OutputFile } from '../types/outputs'

/**
 * Manifest 比对结果
 */
export interface ManifestDiff {
  /** 无变化的文件（可直接从 DB 恢复） */
  unchanged: OutputManifest[]
  /** 新增或变更的文件（需要重新处理） */
  changed: OutputManifest[]
  /** 在 manifest 中但文件系统已删除的记录 */
  orphaned: string[]
}

/**
 * 加载缓存中的 manifest
 */
export async function loadManifest(): Promise<OutputManifest[]> {
  return await outputsDb.manifest
    .where('orphaned')
    .equals(0)
    .toArray()
}

/**
 * 将扫描结果保存到 manifest
 */
export async function saveManifest(entries: OutputManifest[]): Promise<void> {
  await outputsDb.manifest.bulkPut(entries)
}

/**
 * 记录上一次增量扫描观察到的文件 size，用于识别"仍在写入"的同名文件：
 * ComfyUI 写图时文件 size 逐步变大，若每次轮询都把这种抖动判为「变更」，
 * 会反复删缩略图 + 重建网格，导致所有图片重新加载闪烁。
 */
let lastObservedSize = new Map<string, number>()

/** 切换目录或首次全量扫描时清空写入中观察状态 */
export function resetDiffObserver(): void {
  lastObservedSize.clear()
}

/**
 * 与文件系统目录条目比对，识别变化的文件
 * @param filesInDir 文件系统中当前存在的文件：Map<relativePath, { mtime: number, size: number }>
 * @returns 需要更新和清理的文件列表
 */
export async function diffManifest(
  filesInDir: Map<string, { mtime: number; size: number }>
): Promise<ManifestDiff> {
  const cachedManifests = await loadManifest()
  const cachedMap = new Map(cachedManifests.map(m => [m.path, m]))

  const unchanged: OutputManifest[] = []
  const changed: OutputManifest[] = []
  const orphaned: string[] = []

  // 比对缓存与文件系统的当前状态
  for (const [rawPath, fileInfo] of filesInDir) {
    const path = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath

    const cached = cachedMap.get(path)
    // mtime 用 1s 容差：FileSystem API 的 lastModified 可能有毫秒级抖动，
    // 严格相等会导致「无变化」误判为「有变化」，增量扫描每次轮询都重建网格、图片闪烁
    if (cached && Math.abs(cached.mtime - fileInfo.mtime) < 1000 && cached.size === fileInfo.size) {
      // 文件未变 —— 直接复用
      unchanged.push(cached)
      cachedMap.delete(path)
      lastObservedSize.delete(path)
    } else if (cached && fileInfo.size > cached.size) {
      // 同名文件疑似仍在写入（size 变大）。本次不判变更、不删缩略图，
      // 避免写图抖动反复重建网格导致图片闪烁；等 size 稳定（连续两次相同）后再确认变更
      const prev = lastObservedSize.get(path)
      lastObservedSize.set(path, fileInfo.size)
      cachedMap.delete(path)
      if (prev === fileInfo.size) {
        changed.push({
          id: hashPath(path),
          path,
          mtime: fileInfo.mtime,
          size: fileInfo.size,
          metadataHash: '',
          orphaned: false,
        })
      } else {
        // 仍在写入 —— 保留旧记录，不删缩略图
        unchanged.push(cached)
      }
    } else {
      // 新增文件或确定变更
      changed.push({
        id: hashPath(path),
        path,
        mtime: fileInfo.mtime,
        size: fileInfo.size,
        metadataHash: '',
        orphaned: false,
      })
      cachedMap.delete(path)
      lastObservedSize.delete(path)
    }
  }

  // 剩余的缓存记录对应已删除的文件
  for (const [, cached] of cachedMap) {
    orphaned.push(cached.id)
  }

  return { unchanged, changed, orphaned }
}

/**
 * 标记已删除文件的 manifest 记录为 orphaned
 */
export async function markOrphaned(ids: string[]): Promise<void> {
  for (const id of ids) {
    await outputsDb.manifest.update(id, { orphaned: true })
  }
}

/**
 * 清理已删除文件的 DB 记录（文件 + 元数据 + manifest）
 */
export async function purgeDeletedFiles(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await outputsDb.files.bulkDelete(ids)
  await outputsDb.metadata.bulkDelete(ids)
  await outputsDb.manifest.bulkDelete(ids)
}

/**
 * 获取所有标记为 orphaned 的 manifest 记录（用于 UI 提示哪些文件被删除了）
 */
export async function getOrphanedManifests(): Promise<OutputManifest[]> {
  return await outputsDb.manifest
    .where('orphaned')
    .equals(1)
    .toArray()
}

/**
 * 根据文件路径列表从 DB 批量恢复 OutputFile
 */
export async function restoreFilesFromDb(
  manifests: OutputManifest[]
): Promise<OutputFile[]> {
  const ids = manifests.map(m => m.id)
  const files = await outputsDb.files.bulkGet(ids)
  return files.filter((f): f is OutputFile => f !== undefined)
}

/**
 * 页面刷新后从 DB 直接恢复全部缓存文件（不遍历文件系统）：
 * manifest 未变更记录 + files 表 bulkGet，首屏秒出，再由增量扫描后台校正
 */
export async function restoreAllFromDb(): Promise<OutputFile[]> {
  const manifests = await loadManifest()
  if (manifests.length === 0) return []
  const files = await outputsDb.files.bulkGet(manifests.map(man => man.id))
  return files.filter((f): f is OutputFile => f !== undefined)
}

/**
 * 统一路径哈希函数（与 outputScanner / outputStore 保持一致）
 */
export function hashPath(path: string): string {
  let hash = 0
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

/**
 * 将 OutputFile 转换为 ManifestEntry
 */
export function fileToManifest(file: OutputFile): OutputManifest {
  return {
    id: file.id,
    path: file.path,
    mtime: file.mtime,
    size: file.size,
    metadataHash: file.id, // 简单实现：用 id 作为 metadata 变更的代理 hash
    orphaned: false,
  }
}
