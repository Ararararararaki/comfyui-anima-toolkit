// ── Outputs 模块编排服务 ──
// 三层架构中的 Service 层：所有 I/O 操作（扫描、IndexedDB、文件系统）的编排入口。
// View（或 Store 的纯状态 setter）→ Service，禁止反向调用。

import { useOutputStore } from '../store/outputStore'
import { outputsDb } from '../db/outputsDb'
import { showToast } from '../utils'
import { hashPath } from './outputManifest'
import { deleteThumbnails } from './outputThumbnail'
import { deleteOutputFile } from './nativeStorage'
import { bindMetadata, createImageSnapshot } from './outputIdentity'
import { sourceForFile, outputFileId, outputContentKey, requestOutputSourcePermission } from './outputSources'
import type { OutputFile } from '../types/outputs'

// ── 文件操作 ──

export interface DeleteFilesResult {
  /** 文件系统 + IndexedDB 都处置成功、可以从列表移除的 id */
  deletedIds: string[]
  /** 未能删除、必须原样保留的 id */
  failedIds: string[]
  /** id → 失败原因（已翻译成用户可读文本） */
  reasons: Record<string, string>
}

/**
 * 把底层异常翻译成用户能看懂的原因。
 * 删除失败必须解释原因，不能只给一句"已删除 0 个文件"——用户无法判断该怎么办。
 */
function describeDeleteError(err: unknown): string {
  const name = (err as { name?: string })?.name || ''
  const message = (err as Error)?.message || String(err)
  switch (name) {
    case 'NoModificationAllowedError':
      return '目录为只读或已被其它程序占用'
    case 'NotAllowedError':
      return '目录授权已失效，请点「重新授权」后再试'
    case 'NotFoundError':
      return '文件已不在磁盘上（可能已被其它程序删除）'
    case 'InvalidModificationError':
      return '文件被占用（ComfyUI 正在写入或预览程序打开了它）'
    case 'QuotaExceededError':
    case 'InvalidStateError':
      return '本地索引写入失败（非文件系统问题）'
    default:
      return message || '未知错误'
  }
}

/**
 * 批量删除文件（按来源走对应存储通道 + 索引清理）。
 *
 * 语义（当前实现，务必与代码一致）：
 *   · 只有**真正从存储层删掉**的 id 才进 `deletedIds`；
 *   · 目标不在发起时的列表里 → **失败**（"缺失"不等于"已删除"，不得谎报成功）；
 *   · 短 ID 命中多条 → **歧义，拒绝执行**（删除不可逆，宁可保留也不猜）；
 *   · 修订不符（mtime/size）→ 拒绝，文件保留；
 *   · 失败的 id 原样保留在列表与选中态，原因经 `reasons` 回传展示。
 *
 * ⚠️ 历史缺陷（2026-10-04 修）：旧实现收尾按**请求的 ids** 过滤列表，
 * 于是删除失败的文件在 UI 上也"消失"（用户以为成功、重扫又出现）；
 * 且部分成功无区分，10 张全失败也显示「已删除 10 个文件」。
 */
export async function deleteFiles(ids: string[]): Promise<DeleteFilesResult> {
  const result: DeleteFilesResult = { deletedIds: [], failedIds: [], reasons: {} }
  const original = useOutputStore.getState().files
  const targets = ids.map(id => {
    const matches = original.filter(file => file.id === id)
    if (matches.length !== 1) {
      result.failedIds.push(id); result.reasons[id] = matches.length ? '图片身份存在歧义，未执行删除' : '图片已不在当前列表'
      return null
    }
    const file = { ...matches[0] }
    return { file, source: { ...sourceForFile(file) } }
  }).filter((target): target is NonNullable<typeof target> => !!target)
  const sameRevision = (a: OutputFile, b: OutputFile) => a.id === b.id && a.sourceId === b.sourceId && a.path === b.path && a.mtime === b.mtime && a.size === b.size
  for (const { file, source } of targets) {
    try {
      if (source.kind === 'directory') {
        if (!source.handle || !await requestOutputSourcePermission(source.id, 'readwrite')) throw new DOMException('目录授权已失效', 'NotAllowedError')
        const parts = file.path.split('/')
        let directory = source.handle
        for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
        const disk = await (await directory.getFileHandle(parts[parts.length - 1])).getFile()
        if (disk.lastModified !== file.mtime || disk.size !== file.size) throw new Error('图片内容已变化，未执行删除')
        await directory.removeEntry(parts[parts.length - 1])
      } else if (source.kind === 'gallery') {
        await deleteOutputFile(file.path, { mtime: file.mtime, size: file.size, root: source.root })
      } else throw new Error('该图片来源暂不支持删除')
      result.deletedIds.push(file.id)
      await outputsDb.transaction('rw', outputsDb.files, outputsDb.manifest, async () => {
        const current = await outputsDb.files.get(file.id)
        if (current && sameRevision(current, file)) await outputsDb.files.delete(file.id)
        const manifest = await outputsDb.manifest.get(file.id)
        if (manifest && manifest.path === file.path && manifest.mtime === file.mtime && manifest.size === file.size) await outputsDb.manifest.delete(file.id)
      })
      const store = useOutputStore.getState()
      if (store.files.some(current => sameRevision(current, file))) {
        store.removeMetadata([file.id]); store.invalidateThumbnails([outputContentKey(file)])
        useOutputStore.setState(state => ({ files: state.files.filter(current => !sameRevision(current, file)), selectedIds: new Set([...state.selectedIds].filter(id => id !== file.id || state.files.some(current => current.id === id && !sameRevision(current, file)))) }))
      }
    } catch (err) {
      if (!result.deletedIds.includes(file.id)) { result.failedIds.push(file.id); result.reasons[file.id] = describeDeleteError(err) }
      else console.warn('[Outputs] 已删除磁盘文件，索引清理待刷新:', file.path, err)
    }
  }
  useOutputStore.getState().applyFilters()
  const failure = result.failedIds.length ? `，${result.failedIds.length} 个失败：${result.reasons[result.failedIds[0]]}` : ''
  showToast(`已删除 ${result.deletedIds.length} 个文件${failure}`)
  return result
}

/** Directory rename uses its own handle. It never applies a directory handle to output rows. */
export async function renameFile(id: string, newName: string): Promise<void> {
  const matches = useOutputStore.getState().files.filter(file => file.id === id)
  if (matches.length !== 1) { showToast('图片身份不明确'); return }
  const file = { ...matches[0] }
  const source = { ...sourceForFile(file) }
  if (source.kind !== 'directory' || !source.handle) { showToast('该图片来源暂不支持重命名'); return }
  if (!newName.trim() || /[\\/]/.test(newName)) { showToast('请输入有效文件名'); return }
  if (newName === file.filename) return
  try {
    if (!await requestOutputSourcePermission(source.id, 'readwrite')) throw new DOMException('目录授权已失效', 'NotAllowedError')
    const parts = file.path.split('/')
    let directory = source.handle
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
    try { await directory.getFileHandle(newName); throw new Error('目标文件名已存在') } catch (err) { if ((err as Error).name !== 'NotFoundError') throw err }
    const old = await (await directory.getFileHandle(file.filename)).getFile()
    if (old.lastModified !== file.mtime || old.size !== file.size) throw new Error('图片内容已变化，请刷新后重试')
    const handle = await directory.getFileHandle(newName, { create: true })
    const writable = await handle.createWritable()
    await writable.write(old); await writable.close()
    const fresh = await handle.getFile()
    const unchanged = await (await directory.getFileHandle(file.filename)).getFile()
    if (unchanged.lastModified !== file.mtime || unchanged.size !== file.size) throw new Error('原图片在复制期间变化，已保留原图，请刷新')
    await directory.removeEntry(file.filename)
    const path = [...parts.slice(0, -1), newName].join('/')
    const updated: OutputFile = { ...file, id: outputFileId(source.id, path), path, filename: newName, extension: newName.split('.').pop()?.toLowerCase() || '', size: fresh.size, mtime: fresh.lastModified }
    await outputsDb.transaction('rw', outputsDb.files, outputsDb.metadata, outputsDb.manifest, async () => {
      const annotation = await outputsDb.files.get(file.id)
      await outputsDb.files.put({ ...annotation, ...updated, favorite: annotation?.favorite ?? file.favorite, rating: annotation?.rating ?? file.rating, tags: annotation?.tags ?? file.tags, notes: annotation?.notes ?? file.notes, category: annotation?.category ?? file.category, status: annotation?.status ?? file.status, pinned: annotation?.pinned ?? file.pinned })
      const meta = await outputsDb.metadata.get(file.id)
      if (meta) await outputsDb.metadata.put(bindMetadata({ ...meta, imageId: updated.id }, createImageSnapshot(updated, source.kind, source.root, source.parserVersion)))
      await outputsDb.manifest.put({ id: updated.id, sourceId: source.id, path, mtime: updated.mtime, size: updated.size, metadataHash: '', orphaned: false })
      await outputsDb.files.delete(file.id); await outputsDb.metadata.delete(file.id); await outputsDb.manifest.delete(file.id)
    })
    const store = useOutputStore.getState()
    store.removeMetadata([file.id]); store.invalidateThumbnails([outputContentKey(file), outputContentKey(updated)])
    useOutputStore.setState(state => ({ files: state.files.map(current => current.id === file.id && current.sourceId === file.sourceId && current.mtime === file.mtime && current.size === file.size ? updated : current) }))
    store.applyFilters(); showToast(`已重命名：${file.filename} → ${newName}`)
  } catch (err) { showToast(`重命名失败：${describeDeleteError(err)}`) }
}

// ── 元数据操作 ──

/**
 * 批量收藏/取消收藏
 */
export async function batchFavorite(ids: string[], favorite: boolean): Promise<void> {
  const store = useOutputStore.getState()
  for (const id of ids) {
    const file = store.files.find(file => file.id === id)
    if (file && file.favorite !== favorite) await useOutputStore.getState().toggleFavorite(id)
  }
  showToast(favorite ? `已收藏 ${ids.length} 个文件` : `已取消收藏 ${ids.length} 个文件`)
}

/**
 * 批量评分
 */
export async function batchRate(ids: string[], rating: number): Promise<void> {
  for (const id of ids) {
    await useOutputStore.getState().setRating(id, rating)
  }
}

// ── 缩略图 ──
