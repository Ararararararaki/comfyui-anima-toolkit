// ── Outputs 模块编排服务 ──
// 三层架构中的 Service 层：所有 I/O 操作（扫描、IndexedDB、文件系统）的编排入口。
// View（或 Store 的纯状态 setter）→ Service，禁止反向调用。

import { useOutputStore } from '../store/outputStore'
import { outputsDb } from '../db/outputsDb'
import { showToast } from '../utils'
import { hashPath } from './outputManifest'
import { deleteThumbnails } from './outputThumbnail'
import type { OutputFile, OutputMetadata } from '../types/outputs'

// ── 扫描编排 ──

/**
 * 选择目录并执行全量扫描
 */
export async function pickAndScan(): Promise<void> {
  // TODO: 调 window.showDirectoryPicker + outputScanner.scanOutputDir
}

/**
 * 刷新当前目录（重新全量扫描）
 */
export async function refresh(): Promise<void> {
  // TODO: 从 store 取 dirHandle → outputScanner.scanOutputDir
}

/**
 * 增量扫描（启动时轻量检测新文件）
 */
export async function incrementalScan(): Promise<number> {
  // TODO: 从 store 取 dirHandle → outputScanner.scanOutputDirIncremental
  return 0
}

/**
 * 从 IndexedDB 缓存恢复（刷新页面时先显示缓存）
 */
export async function restoreFromCache(): Promise<boolean> {
  // TODO: 调 outputScanner.loadOutputDirHandle
  return false
}

// ── 文件操作 ──

/**
 * 批量删除文件（文件系统 + IndexedDB）
 */
export async function deleteFiles(ids: string[]): Promise<void> {
  const { dirHandle } = useOutputStore.getState()
  if (!dirHandle) {
    showToast('请先选择目录')
    return
  }
  let deleted = 0
  for (const id of ids) {
    const file = useOutputStore.getState().files.find(f => f.id === id)
    if (!file) continue
    try {
      const parts = file.path.split('/')
      let current = dirHandle
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i])
      }
      await current.removeEntry(parts[parts.length - 1])
      await outputsDb.files.delete(id)
      await outputsDb.metadata.delete(id)
      useOutputStore.getState().removeMetadata([id])
      deleted++
    } catch (err) {
      console.warn('[outputService] 删除文件失败:', id, file?.path, (err as Error)?.message)
    }
  }
  useOutputStore.setState(s => ({
    files: s.files.filter(f => !ids.includes(f.id)),
    selectedIds: new Set(),
  }))
  useOutputStore.getState().applyFilters()
  showToast(`已删除 ${deleted} 个文件`)
}

/**
 * 重命名文件（文件系统复制 + IndexedDB 更新）
 */
export async function renameFile(id: string, newName: string): Promise<void> {
  const { dirHandle, files } = useOutputStore.getState()
  if (!dirHandle) {
    showToast('请先选择目录')
    return
  }

  const file = files.find(f => f.id === id)
  if (!file) return

  try {
    // 导航到文件所在目录
    const parts = file.path.split('/')
    let current = dirHandle
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i])
    }

    // 获取旧文件句柄
    const oldName = parts[parts.length - 1]
    const oldHandle = await current.getFileHandle(oldName)

    // 创建新文件（重命名）
    const newHandle = await current.getFileHandle(newName, { create: true })
    const fileData = await oldHandle.getFile()
    const writable = await newHandle.createWritable()
    await writable.write(fileData)
    await writable.close()

    // 删除旧文件
    await current.removeEntry(oldName)

    // 更新数据库
    const oldPath = file.path
    const newPath = parts.length > 1
      ? parts.slice(0, -1).join('/') + '/' + newName
      : newName
    const newId = hashPath(newPath)

    // 更新文件记录
    await outputsDb.files.delete(id)
    const updatedFile: OutputFile = {
      ...file,
      id: newId,
      path: newPath,
      filename: newName,
      extension: newName.split('.').pop()?.toLowerCase() || '',
    }
    await outputsDb.files.put(updatedFile)

    // 更新元数据
    const meta = await outputsDb.metadata.get(id)
    if (meta) {
      await outputsDb.metadata.delete(id)
      await outputsDb.metadata.put({ ...meta, imageId: newId })
    }

    // 同步内存缓存 + 失效缩略图
    const st = useOutputStore.getState()
    st.removeMetadata([id])
    if (meta) st.putMetadata({ ...meta, imageId: newId })
    st.invalidateThumbnails([oldPath, newPath])
    await deleteThumbnails([oldPath, newPath])

    // 更新状态
    useOutputStore.setState(s => ({
      files: s.files.map(f => f.id === id ? updatedFile : f)
    }))
    useOutputStore.getState().applyFilters()

    showToast(`已重命名: ${oldName} → ${newName}`)
  } catch (err) {
    showToast('重命名失败: ' + (err as Error).message)
  }
}

// ── 元数据操作 ──

/**
 * 切换收藏状态
 */
export async function toggleFavorite(id: string): Promise<void> {
  // TODO: outputsDb.files.update + store setState
}

/**
 * 设置评分
 */
export async function setRating(id: string, rating: number): Promise<void> {
  // TODO: outputsDb.files.update + store setState
}

/**
 * 设置笔记
 */
export async function setNotes(id: string, notes: string): Promise<void> {
  // TODO: outputsDb.files.update + store setState
}

/**
 * 设置标签
 */
export async function setTags(id: string, tags: string[]): Promise<void> {
  // TODO: outputsDb.files.update + store setState
}

/**
 * 批量收藏/取消收藏
 */
export async function batchFavorite(ids: string[], favorite: boolean): Promise<void> {
  for (const id of ids) {
    await outputsDb.files.update(id, { favorite })
  }
  useOutputStore.setState(s => ({
    files: s.files.map(f => ids.includes(f.id) ? { ...f, favorite } : f)
  }))
  useOutputStore.getState().applyFilters()
  showToast(favorite ? `已收藏 ${ids.length} 个文件` : `已取消收藏 ${ids.length} 个文件`)
}

/**
 * 批量评分
 */
export async function batchRate(ids: string[], rating: number): Promise<void> {
  for (const id of ids) {
    await outputsDb.files.update(id, { rating })
  }
  useOutputStore.setState(s => ({
    files: s.files.map(f => ids.includes(f.id) ? { ...f, rating } : f)
  }))
  useOutputStore.getState().applyFilters()
}

/**
 * 加载元数据（带缓存）
 */
export async function loadMetadata(id: string): Promise<OutputMetadata | null> {
  // TODO: 检查 store.metadataCache → outputsDb.metadata.get
  return null
}

/**
 * 批量预加载元数据
 */
export async function preloadMetadataBatch(): Promise<void> {
  // TODO: 从 store 取 files + metadataCache 交集 → outputsDb.metadata.bulkGet
}

// ── 缩略图 ──

/**
 * 加载图片缩略图
 */
export async function loadThumbnail(
  img: HTMLImageElement,
  fileId: string,
  filePath: string
): Promise<void> {
  // TODO: outputThumbnail.getCachedThumbnail → 若空则读文件系统 → outputThumbnail.getThumbnail
}

/**
 * 打开预览（大图 + 元数据面板）
 */
export async function openPreview(fileId: string): Promise<void> {
  // TODO: 读文件系统生成 blob URL → 显示 lightbox + 元数据面板
}

// ── 目录树 ──

/**
 * 构建目录树
 */
export async function buildDirTree(): Promise<void> {
  // TODO: outputScanner.buildDirTree → store/渲染
}
