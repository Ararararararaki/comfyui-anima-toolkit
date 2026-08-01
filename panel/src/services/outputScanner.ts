import type { OutputFile, OutputMetadata, OutputDir } from '../types/outputs'
import { outputsDb } from '../db/outputsDb'
import { useOutputStore } from '../store/outputStore'
import { parseOutputMetadata, PARSER_VERSION } from './outputMetadata'
import { getThumbnail, deleteThumbnails } from './outputThumbnail'
import {
  diffManifest,
  restoreFilesFromDb,
  saveManifest,
  purgeDeletedFiles,
  fileToManifest,
  hashPath,
} from './outputManifest'
import { showToast } from '../utils'

/** 从已有 DB 记录恢复用户元数据（收藏/评分/标签等） */
async function withUserMetadata(base: OutputFile): Promise<OutputFile> {
  const existing = await outputsDb.files.get(base.id)
  if (!existing) return { ...base, status: '' }
  return {
    ...base,
    favorite: existing.favorite ?? false,
    rating: existing.rating ?? 0,
    notes: existing.notes ?? '',
    tags: existing.tags ?? [],
    category: existing.category ?? '',
    status: existing.status ?? '',
    pinned: existing.pinned ?? false,
    createdAt: existing.createdAt ?? Date.now(),
  }
}

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|webp|gif|bmp)$/i

/** 清理重复记录：相同 path 只保留最新的 mtime 的一条 */
async function dedupFilesByPath(allFiles: OutputFile[]): Promise<void> {
  const seen = new Map<string, OutputFile>()
  const dupIds: string[] = []
  for (const f of allFiles) {
    const existing = seen.get(f.path)
    if (existing) {
      // 保留 mtime 更新的那条
      if (f.mtime > existing.mtime) {
        seen.set(f.path, f)
        dupIds.push(existing.id)
      } else {
        dupIds.push(f.id)
      }
    } else {
      seen.set(f.path, f)
    }
  }
  if (dupIds.length > 0) {
    console.log(`[outputScanner] 发现 ${dupIds.length} 条重复记录，正在清理...`)
    await outputsDb.files.bulkDelete(dupIds)
  }
}

// hashPath 已迁移至 outputManifest.ts，通过 import 使用

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

async function getDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = dataUrl
  })
}

async function processFile(
  handle: FileSystemFileHandle,
  relativePath: string
): Promise<OutputFile | null> {
  try {
    const file = await handle.getFile()
    const filename = file.name
    const extension = filename.split('.').pop()?.toLowerCase() || ''

    if (!IMAGE_EXTENSIONS.test(filename)) return null

    const path = relativePath ? `${relativePath}/${filename}` : filename
    const id = hashPath(path)

    // 检查是否已索引
    const existing = await outputsDb.files.get(id)
    if (existing && existing.mtime === file.lastModified) {
      return existing
    }

    // 读取文件内容用于元数据解析
    const buf = await readFileAsArrayBuffer(file)
    const meta = await parseOutputMetadata(buf, extension)

    // 创建缩略图用于获取尺寸
    const blob = new Blob([buf], { type: `image/${extension}` })
    const dataUrl = URL.createObjectURL(blob)
    const dims = await getDimensions(dataUrl)
    URL.revokeObjectURL(dataUrl)

    const outputFile: OutputFile = {
      id,
      path,
      filename,
      extension,
      size: file.size,
      mtime: file.lastModified,
      width: dims.width,
      height: dims.height,
      favorite: existing?.favorite || false,
      rating: existing?.rating || 0,
      notes: existing?.notes || '',
      tags: existing?.tags || [],
      category: existing?.category ?? '',
      status: existing?.status || '',
      pinned: existing?.pinned ?? false,
      createdAt: existing?.createdAt || Date.now(),
    }

    // 保存文件信息
    await outputsDb.files.put(outputFile)

    // 保存元数据
    if (meta) {
      const outputMeta: OutputMetadata = {
        imageId: id,
        model: meta.model || '',
        seed: meta.seed || '',
        steps: meta.steps || '',
        cfg: meta.cfg || '',
        sampler: meta.sampler || '',
        vae: meta.vae || '',
        clipSkip: meta.clipSkip || 0,
        prompt: meta.prompt || '',
        negativePrompt: meta.negativePrompt || '',
        workflowJson: meta.workflowJson || '',
        rawMetadata: meta.raw || {},
      }
      await outputsDb.metadata.put(outputMeta)
    }

    return outputFile
  } catch {
    return null
  }
}

/** 强制重新解析所有文件的元数据（解析逻辑升级后，旧缓存不会被增量扫描刷新） */
export async function reparseAllMetadata(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  const files = useOutputStore.getState().files
  const total = files.length
  useOutputStore.setState({ scanStatus: 'scanning', scanProgress: { done: 0, total }, loading: true })
  let done = 0
  const errors: string[] = []
  for (const f of files) {
    try {
      const parts = f.path.split('/')
      let current = dirHandle
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i])
      }
      const handle = await current.getFileHandle(parts[parts.length - 1])
      const file = await handle.getFile()
      const buf = await readFileAsArrayBuffer(file)
      const ext = f.extension || (f.filename.split('.').pop() || '')
      const meta = await parseOutputMetadata(buf, ext)
      if (meta) {
        const outputMeta: OutputMetadata = {
          imageId: f.id,
          model: meta.model || '',
          seed: meta.seed || '',
          steps: meta.steps || '',
          cfg: meta.cfg || '',
          sampler: meta.sampler || '',
          vae: meta.vae || '',
          clipSkip: meta.clipSkip || 0,
          prompt: meta.prompt || '',
          negativePrompt: meta.negativePrompt || '',
          workflowJson: meta.workflowJson || '',
          rawMetadata: meta.raw || {},
        }
        await outputsDb.metadata.put(outputMeta)
        useOutputStore.getState().putMetadata(outputMeta)
      }
    } catch {
      errors.push(f.filename)
    }
    done++
    useOutputStore.setState({ scanProgress: { done, total } })
  }
  useOutputStore.setState({ scanStatus: 'done', loading: false, scanProgress: { done, total } })
  if (errors.length) showToast(`⚠️ 重解析完成 ${done} 个，${errors.length} 个失败`)
  else showToast(`✅ 已重新解析 ${done} 个文件元数据`)
  return done
}

const PARSER_VERSION_KEY = 'anima_output_parser_version'

/**
 * 解析逻辑升级后自动失效旧元数据缓存并重新解析。
 * 增量扫描按 mtime+size 跳过未变更文件，解析器升级后旧缓存不会自动刷新，
 * 故用版本号标记：不匹配时清空 metadata/缩略图缓存并强制重解析一次。
 */
export async function ensureMetadataFresh(dirHandle: FileSystemDirectoryHandle | null): Promise<boolean> {
  try {
    const saved = localStorage.getItem(PARSER_VERSION_KEY)
    if (saved === String(PARSER_VERSION)) return false
    localStorage.setItem(PARSER_VERSION_KEY, String(PARSER_VERSION))
  } catch {
    return false
  }

  // 清空旧缓存，避免读到解析逻辑变更前的错误结果
  await outputsDb.metadata.clear()
  await outputsDb.thumbnails.clear()
  useOutputStore.setState({
    metadataCache: new Map(),
    thumbMemory: new Map(),
  })

  if (dirHandle) {
    showToast('🔍 解析逻辑已升级，正在重新解析元数据…')
    await reparseAllMetadata(dirHandle)
  }
  return true
}

async function scanDirectory(
  dirHandle: FileSystemDirectoryHandle,
  relativePath: string,
  allFiles: OutputFile[]
): Promise<void> {
  const iter = (dirHandle as any).entries()
  for (;;) {
    const next = await iter.next()
    if (next.done) break
    const [name, handle] = next.value as [string, FileSystemFileHandle | FileSystemDirectoryHandle]

    // 跳过隐藏文件和目录
    if (name.startsWith('.')) continue

    if ((handle as any).kind === 'directory') {
      const childPath = relativePath ? `${relativePath}/${name}` : name
      await scanDirectory(handle as FileSystemDirectoryHandle, childPath, allFiles)
    } else if ((handle as any).kind === 'file') {
      const file = await processFile(handle as FileSystemFileHandle, relativePath)
      if (file) allFiles.push(file)
    }
  }
}

export async function scanOutputDir(dirHandle: FileSystemDirectoryHandle): Promise<void> {
  const store = useOutputStore.getState()
  store.setDirHandle(dirHandle)
  useOutputStore.setState({ scanStatus: 'scanning', scanProgress: { done: 0, total: 0 }, loading: true })

  try {
    // 检查目录权限
    const perm = await (dirHandle as any).requestPermission({ mode: 'readwrite' })
    if (perm !== 'granted') {
      showToast('需要读取权限才能扫描目录')
      useOutputStore.setState({ scanStatus: 'idle', loading: false })
      return
    }

    // 阶段 1: 快速遍历目录 — 建立文件清单
    const filesInDir = new Map<string, { mtime: number; size: number }>()
    await walkDir(dirHandle, '', filesInDir)

    // 阶段 2: 与 manifest 比对，分离变更/未变/已删
    const diff = await diffManifest(filesInDir)
    const totalFiles = filesInDir.size
    let processedCount = 0

    useOutputStore.setState({
      scanProgress: { done: 0, total: totalFiles },
      scanStatus: diff.changed.length > 0 ? 'scanning' : 'done',
    })

    // 阶段 3: 从 DB 恢复未变更文件
    const restoredFiles = await restoreFilesFromDb(diff.unchanged)
    processedCount += diff.unchanged.length

    // 清理已删除文件的 DB 记录
    if (diff.orphaned.length > 0) {
      await purgeDeletedFiles(diff.orphaned)
    }

    // 阶段 4: 增量处理变更文件（分批处理）
    const newFiles: OutputFile[] = []
    const metaUpdates: OutputMetadata[] = []
    const BATCH_SIZE = 10
    for (let i = 0; i < diff.changed.length; i += BATCH_SIZE) {
      const batch = diff.changed.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.map(async (entry) => {
          try {
            // 在文件系统中定位文件
            const fileHandle = await resolveFileInDir(dirHandle, entry.path)
            if (!fileHandle) return null

            const file = await fileHandle.getFile()

            const extension = file.name.split('.').pop()?.toLowerCase() || ''
            if (!IMAGE_EXTENSIONS.test(file.name)) return null

            const buf = await readFileAsArrayBuffer(file)
            const meta = await parseOutputMetadata(buf, extension)

            const blob = new Blob([buf], { type: `image/${extension}` })
            const dataUrl = URL.createObjectURL(blob)
            const dims = await getDimensions(dataUrl)
            URL.revokeObjectURL(dataUrl)

            const outputFile = await withUserMetadata({
              id: entry.id,
              path: entry.path,
              filename: file.name,
              extension,
              size: file.size,
              mtime: file.lastModified,
              width: dims.width,
              height: dims.height,
            } as OutputFile)

            // 保存文件信息（保留已有收藏/评分/标签）
            await outputsDb.files.put(outputFile)

            // 保存元数据
            if (meta) {
              const outputMeta: OutputMetadata = {
                imageId: entry.id,
                model: meta.model || '',
                seed: meta.seed || '',
                steps: meta.steps || '',
                cfg: meta.cfg || '',
                sampler: meta.sampler || '',
                vae: meta.vae || '',
                clipSkip: meta.clipSkip || 0,
                prompt: meta.prompt || '',
                negativePrompt: meta.negativePrompt || '',
                workflowJson: meta.workflowJson || '',
                rawMetadata: meta.raw || {},
              }
              await outputsDb.metadata.put(outputMeta)
              metaUpdates.push(outputMeta)
            }

            return outputFile
          } catch (err) {
            console.warn('[outputScanner] 文件处理失败，跳过:', entry.path, (err as Error)?.message)
            return null
          }
        })
      )

      for (const f of batchResults) {
        if (f) newFiles.push(f)
      }

      processedCount += batch.length
      useOutputStore.setState({
        scanProgress: { done: processedCount, total: totalFiles },
      })
    }

    // A1+C: 变更文件元数据同步到内存缓存，失效旧缩略图，清理孤儿缓存
    if (metaUpdates.length > 0) useOutputStore.getState().putMetadataBatch(metaUpdates)
    const changedPaths = diff.changed.map(c => c.path)
    useOutputStore.getState().invalidateThumbnails(changedPaths)
    await deleteThumbnails(changedPaths)
    useOutputStore.getState().removeMetadata(diff.orphaned)

    // 阶段 5: 保存 manifest 快照
    const allManifests = [...diff.unchanged, ...diff.changed.map(c => {
      const file = newFiles.find(f => f.id === c.id)
      return file ? fileToManifest(file) : c
    })]
    await saveManifest(allManifests)

    // 保存目录句柄（原始 handle + 外部 key）
    try {
      await (outputsDb.dirHandles as any).put(dirHandle, 'current')
    } catch (err) {
      console.warn('[outputScanner] 目录句柄存储失败（非关键错误）:', (err as Error)?.message)
    }

    const allFiles = [...restoredFiles, ...newFiles]

    // 更新状态
    useOutputStore.setState({
      files: allFiles,
      scanStatus: 'done',
      scanProgress: { done: allFiles.length, total: allFiles.length },
      loading: false,
      currentPath: '',
      searchQuery: '',
      filterKey: 'all',
      page: 1,
    })

    store.setFiles(allFiles)

    const changed = diff.changed.length
    const restored = diff.unchanged.length
    showToast(`扫描完成: 新增 ${changed}，恢复 ${restored}，共 ${allFiles.length} 张图片`)
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      useOutputStore.setState({ scanStatus: 'idle', loading: false })
    } else {
      useOutputStore.setState({ scanStatus: 'error', loading: false })
      showToast('扫描失败: ' + (err as Error).message)
    }
  }
}

/**
 * 增量扫描入口——在已有缓存基础上快速恢复
 */
export async function scanOutputDirIncremental(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  try {
    const perm = await (dirHandle as any).requestPermission({ mode: 'readwrite' })
    if (perm !== 'granted') return 0

    // 快速目录遍历
    const filesInDir = new Map<string, { mtime: number; size: number }>()
    await walkDir(dirHandle, '', filesInDir)

    // 比对 manifest
    const diff = await diffManifest(filesInDir)

    if (diff.changed.length === 0 && diff.orphaned.length === 0) {
      // 完全无变化 — 直接恢复缓存
      const restored = await restoreFilesFromDb(diff.unchanged)
      useOutputStore.getState().setFiles(restored)
      return restored.length
    }

    // 有变化但已有文件缓存 → 增量更新
    const existingFiles = useOutputStore.getState().files
    if (existingFiles.length === 0) {
      // 首次运行（无缓存）→ 由 scanOutputDir 处理全量扫描
      return 0
    }

    // 增量处理变更的文件
    const metaUpdates: OutputMetadata[] = []
    const BATCH_SIZE = 10
    for (let i = 0; i < diff.changed.length; i += BATCH_SIZE) {
      const batch = diff.changed.slice(i, i + BATCH_SIZE)
      await Promise.all(
        batch.map(async (entry) => {
          try {
            const fileHandle = await resolveFileInDir(dirHandle, entry.path)
            if (!fileHandle) return null

            const file = await fileHandle.getFile()
            const extension = file.name.split('.').pop()?.toLowerCase() || ''
            if (!IMAGE_EXTENSIONS.test(file.name)) return null

            const buf = await readFileAsArrayBuffer(file)
            const meta = await parseOutputMetadata(buf, extension)
            const blob = new Blob([buf], { type: `image/${extension}` })
            const dataUrl = URL.createObjectURL(blob)
            const dims = await getDimensions(dataUrl)
            URL.revokeObjectURL(dataUrl)

            const outputFile = await withUserMetadata({
              id: entry.id, path: entry.path, filename: file.name,
              extension, size: file.size, mtime: file.lastModified,
              width: dims.width, height: dims.height,
            } as OutputFile)
            await outputsDb.files.put(outputFile)
            if (meta) {
              const outputMeta: OutputMetadata = {
                imageId: entry.id, model: meta.model || '', seed: meta.seed || '',
                steps: meta.steps || '', cfg: meta.cfg || '', sampler: meta.sampler || '',
                vae: meta.vae || '', clipSkip: meta.clipSkip || 0,
                prompt: meta.prompt || '', negativePrompt: meta.negativePrompt || '',
                workflowJson: meta.workflowJson || '', rawMetadata: meta.raw || {},
              }
              await outputsDb.metadata.put(outputMeta)
              metaUpdates.push(outputMeta)
            }
            return outputFile
          } catch (err) {
            console.warn('[outputScanner] 增量扫描: 文件跳过', entry.path, (err as Error)?.message)
            return null
          }
        })
      )
    }

    // A1+C: 变更文件元数据同步到内存缓存，失效旧缩略图
    if (metaUpdates.length > 0) useOutputStore.getState().putMetadataBatch(metaUpdates)
    const changedPaths = diff.changed.map(c => c.path)
    useOutputStore.getState().invalidateThumbnails(changedPaths)
    await deleteThumbnails(changedPaths)

    // 清理 orphaned
    if (diff.orphaned.length > 0) {
      await purgeDeletedFiles(diff.orphaned)
    }

    // 保存 manifest 快照并刷新
    const allManifests = [...diff.unchanged, ...diff.changed]
    await saveManifest(allManifests)

    // 从 DB 重新加载完整列表
    const allFiles = await outputsDb.files.toArray()
    useOutputStore.getState().setFiles(allFiles)
    return allFiles.length
  } catch {
    return 0
  }
}

/**
 * 快速遍历目录，收集文件路径和基本信息（不解析文件内容）
 */
async function walkDir(
  handle: FileSystemDirectoryHandle,
  relativePath: string,
  result: Map<string, { mtime: number; size: number }>
): Promise<void> {
  const iter = (handle as any).entries()
  for (;;) {
    const next = await iter.next()
    if (next.done) break
    const [name, entry] = next.value as [string, FileSystemFileHandle | FileSystemDirectoryHandle]

    // 跳过隐藏文件和目录（以 . 开头）
    if (name.startsWith('.')) continue

    if ((entry as any).kind === 'directory') {
      const childPath = relativePath ? `${relativePath}/${name}` : name
      await walkDir(entry as FileSystemDirectoryHandle, childPath, result)
    } else if ((entry as any).kind === 'file' && IMAGE_EXTENSIONS.test(name)) {
      try {
        const file = await (entry as FileSystemFileHandle).getFile()
        const path = relativePath ? `${relativePath}/${name}` : name
        result.set(path, { mtime: file.lastModified, size: file.size })
      } catch {
        // 权限不足或文件被占用时跳过
      }
    }
  }
}

/**
 * 根据相对路径在目录结构中定位文件句柄
 */
async function resolveFileInDir(
  dirHandle: FileSystemDirectoryHandle,
  filePath: string
): Promise<FileSystemFileHandle | null> {
  try {
    const parts = filePath.split('/')
    let current = dirHandle
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i])
    }
    return await current.getFileHandle(parts[parts.length - 1])
  } catch {
    return null
  }
}

export interface LoadDirHandleResult {
  /** 是否恢复了缓存文件列表（即使句柄权限未恢复，列表仍显示） */
  restored: boolean
  /** 句柄权限状态：none=无保存句柄；granted=可直接读写；prompt/denied=需重新授权 */
  permission: 'granted' | 'prompt' | 'denied' | 'none'
}

export async function loadOutputDirHandle(): Promise<LoadDirHandleResult> {
  const result: LoadDirHandleResult = { restored: false, permission: 'none' }
  try {
    const record = await outputsDb.dirHandles.get('current')
    console.log('🔍 [loadOutputDirHandle] dirHandle 记录:', !!record)
    if (!record) {
      // 没有保存的句柄但有缓存文件 → 仍然显示缓存内容
      const cached = await outputsDb.files.toArray()
      console.log('🔍 [loadOutputDirHandle] 无 dirHandle，IndexedDB 总文件数:', cached.length)
      if (cached.length > 0) {
        // 清理重复记录（保留相同 path 的最新一条）
        await dedupFilesByPath(cached)
        const deduped = await outputsDb.files.toArray()
        console.log('🔍 [loadOutputDirHandle] 去重后文件数:', deduped.length)
        // 直接全量展示，绕过 page=1 的 50 条限制
        useOutputStore.setState({ files: deduped, page: Math.ceil(deduped.length / 50) })
        useOutputStore.getState().applyFilters()
        result.restored = true
      }
      return result
    }

    // 兼容新旧存储格式：新版直接存原始 handle，旧版存 { id, handle } wrapper
    const dh = (record as any).handle || record
    // 始终恢复句柄引用——即使权限降级（浏览器重启后 FS Access 授权会回到 prompt），
    // 后续可一键重新授权恢复图片，避免被迫重新「选择目录」而触发全量扫描
    useOutputStore.getState().setDirHandle(dh)

    try {
      const perm = await (dh as any).queryPermission({ mode: 'readwrite' })
      result.permission = (perm === 'granted' || perm === 'prompt' || perm === 'denied') ? perm : 'prompt'
    } catch {
      result.permission = 'denied'
    }
    console.log('🔍 [loadOutputDirHandle] 句柄权限:', result.permission)

    // 从 DB 加载已索引的文件（核心：无论如何都尝试加载）
    const files = await outputsDb.files.toArray()
    console.log('🔍 [loadOutputDirHandle] 有 dirHandle，IndexedDB 总文件数:', files.length)
    if (files.length > 0) {
      // 清理重复记录
      await dedupFilesByPath(files)
      const deduped = await outputsDb.files.toArray()
      console.log('🔍 [loadOutputDirHandle] 去重后:', deduped.length)
      // 缓存文件全量展示（绕过初始 page=1 的 50 条限制）
      useOutputStore.setState({ files: deduped, page: Math.ceil(deduped.length / 50) })
      useOutputStore.getState().applyFilters()
      result.restored = true
    }
    return result
  } catch {
    return result
  }
}

export async function buildDirTree(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string = ''
): Promise<OutputDir> {
  const dir: OutputDir = {
    path: basePath,
    name: dirHandle.name,
    handle: dirHandle,
    children: [],
    fileCount: 0,
  }

  const iter = (dirHandle as any).entries()
  for (;;) {
    const next = await iter.next()
    if (next.done) break
    const [name, handle] = next.value as [string, FileSystemFileHandle | FileSystemDirectoryHandle]

    // 跳过隐藏文件和目录
    if (name.startsWith('.')) continue

    if ((handle as any).kind === 'directory') {
      const child = await buildDirTree(
        handle as FileSystemDirectoryHandle,
        `${basePath ? basePath + '/' : ''}${name}`
      )
      dir.children.push(child)
    } else if ((handle as any).kind === 'file' && IMAGE_EXTENSIONS.test(name)) {
      dir.fileCount++
    }
  }

  return dir
}

/** 已生成缩略图的文件路径集合（用于避免重复生成） */
async function getCachedThumbnailPaths(): Promise<Set<string>> {
  const thumbnails = await outputsDb.thumbnails.toArray()
  const set = new Set<string>()
  for (const t of thumbnails) {
    // 通过文件名倒推出路径（thumbnails 表的 id 是路径哈希）
    const file = await outputsDb.files.get(t.id)
    if (file) set.add(file.path)
  }
  return set
}

/**
 * 补生成缺失的缩略图
 * 在加载缓存后调用，确保所有图片的缩略图已生成
 */
export async function ensureThumbnails(dirHandle: FileSystemDirectoryHandle | null): Promise<void> {
  if (!dirHandle) return

  const files = useOutputStore.getState().files
  if (files.length === 0) return

  // 检查哪些文件已有缓存缩略图
  const cachedPaths = await getCachedThumbnailPaths()
  const missing = files.filter(f => !cachedPaths.has(f.path))
  if (missing.length === 0) return

  console.log(`[outputScanner] 补生成 ${missing.length} 个缩略图...`)
  let done = 0

  // 分批处理，每批 5 个
  const BATCH = 5
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    await Promise.all(
      batch.map(async (file) => {
        try {
          const fileHandle = await resolveFileInDir(dirHandle, file.path)
          if (!fileHandle) return
          const f = await fileHandle.getFile()
          const dataUrl = await getThumbnail(f, file.path)
          if (dataUrl) done++
        } catch (err) {
          // 单个文件失败不影响其他
        }
      })
    )
  }

  console.log(`[outputScanner] 缩略图补完成: ${done}/${missing.length}`)
}
