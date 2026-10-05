// ── Outputs 模块编排服务 ──
// 三层架构中的 Service 层：所有 I/O 操作（扫描、IndexedDB、文件系统）的编排入口。
// View（或 Store 的纯状态 setter）→ Service，禁止反向调用。

import { useOutputStore } from '../store/outputStore'
import { outputsDb } from '../db/outputsDb'
import { showToast } from '../utils'
import { hashPath } from './outputManifest'
import { deleteThumbnails } from './outputThumbnail'
import { deleteOutputFile } from './nativeStorage'
import { listSourceStamp } from './outputIdentity'
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
  const state = useOutputStore.getState()
  const stamp = listSourceStamp()
  const { dirHandle } = state

  // ── 按**实际列表来源**选择删除通道（2026-10-04 用户验收纠正）──
  // 画廊来源没有目录句柄，必须走服务端端点；
  // 只有确实来自用户选中目录的列表才用 File System Access。
  const kind = stamp?.kind ?? (dirHandle ? 'directory' : null)
  if (kind === null) {
    result.failedIds = [...ids]
    for (const id of ids) result.reasons[id] = '尚未确定图片来源（请先选择目录或载入列表）'
    showToast('删除失败：尚未确定图片来源')
    return result
  }
  if (kind === 'directory' && !dirHandle) {
    // 列表声称来自目录，但句柄已丢失（如刷新后未授权）→ 明确报错，绝不静默"删成功"
    result.failedIds = [...ids]
    for (const id of ids) result.reasons[id] = '目录授权已失效，请点「重新授权」后再试'
    showToast('删除失败：目录授权已失效，请重新授权')
    return result
  }
  if (kind === 'native') {
    // ⚠️ 2026-10-04 owner 要求：native 来源**既没有可核对的真实 root，也没有删除桥协议**
    // （/api/tk/output-file 只做整文件读取，没有删除端点）。
    // 因此**不得**让它走 ComfyUI 的 /anima/outputs/delete 端点 ——
    // 那会把「另一个存储根」的删除当成同一个根处理。
    // 本轮已验证可用的只有 gallery 与 directory 两条通道；native 明确报不支持并保留。
    result.failedIds = [...ids]
    for (const id of ids) result.reasons[id] = '该来源（TK 原生桥）暂不支持删除，文件未改动'
    showToast('删除失败：该来源暂不支持删除，文件未改动')
    return result
  }
  if (kind !== 'gallery' && kind !== 'directory') {
    // 其余未知来源同样拒绝，绝不用未验证的通道执行不可逆操作
    result.failedIds = [...ids]
    for (const id of ids) result.reasons[id] = `不支持的图片来源：${kind}`
    showToast('删除失败：不支持的图片来源')
    return result
  }

  // ── 一次性捕获**不可变目标**（2026-10-04 owner 要求）──
  // 绝不能等到每个 await 之后再回读 live store：
  //  · 慢删除 A 期间用户切到目录 B，live store 已经是 B 的列表；
  //    旧实现"逐个 id 现查 + 最后按 id 过滤 live store"会把 B 视图里
  //    恰好同 id 的行一起移除（删 A 却动了 B 的视图）。
  //  · 回读还会让"列表里没有该 id"被当成"已删除"——缺失记录**不是**删除成功的证据。
  //
  // ⚠️ 2026-10-04 owner 验收纠正（短 ID 歧义）：
  // `hashPath` 是 32 位散列，**真实会碰撞**（实测 hashPath('Aa.png') === hashPath('BB.png')
  // === 'wa58cb'）。旧实现 `files.find(f => f.id === id)` 取**第一个**候选 →
  // 用户想删 BB.png 却删掉 Aa.png。**删除不可逆，歧义必须拒绝执行**，绝不许猜。
  const listRevision = listSourceStamp()
  const targets: Array<{ id: string; path: string; mtime: number; size: number; source: string; root: string }> = []
  // 显式状态位：不使用用户文案/中文正则去反推内部状态
  let sawAmbiguous = false
  for (const id of ids) {
    const matches = state.files.filter(f => f.id === id && f.path)
    if (matches.length === 0) {
      // 目标不在**发起删除时**的列表里：无法证明磁盘上有这张图，不得计入已删除
      result.failedIds.push(id)
      result.reasons[id] = '目标不在当前列表（未执行删除）'
      continue
    }
    if (matches.length > 1) {
      // 短 ID 命中多条 → 无法证明是同一张图 → 歧义，保留（宁可留着也不能删错）
      result.failedIds.push(id)
      result.reasons[id] = `短 ID 命中 ${matches.length} 张图片，无法确定要删除哪一张（歧义，已保留）`
      sawAmbiguous = true
      console.warn('[outputService] 删除目标歧义，已拒绝:', id, matches.map(f => f.path))
      continue
    }
    const file = matches[0]
    targets.push({ id, path: file.path, mtime: file.mtime, size: file.size, source: kind, root: listRevision?.root || '' })
  }
  if (targets.length === 0) {
    showToast(sawAmbiguous ? '未执行删除：目标存在歧义（请改用完整路径定位）' : '未执行删除：目标不在当前列表')
    return result
  }

  /** 只有当列表来源与发起时完全一致，才允许改动当前列表/选中态 */
  const stillSameList = () => {
    const now = listSourceStamp()
    if (!now || !listRevision) return false
    return now.kind === listRevision.kind && now.root === listRevision.root && now.parserVersion === listRevision.parserVersion
  }

  /**
   * 该行在**当前**列表里是否仍是我们要删的那一张（来源 + 完整路径 + 修订一致）。
   *
   * 用于清理阶段的自我校验：源切换或同根重扫换了内容之后，
   * 绝不能仅凭短 ID 就把新列表里的同名/同 id 行当成本次删除目标去清缓存。
   */
  const rowStillTarget = (t: { id: string; path: string; mtime: number; size: number }) => {
    const live = useOutputStore.getState().files.filter(f => f.id === t.id)
    if (live.length !== 1) return false
    const only = live[0]
    return only.path === t.path && only.mtime === t.mtime && only.size === t.size
  }

  for (const target of targets) {
    try {
      if (kind === 'directory') {
        const root = dirHandle!
        const parts = target.path.split('/')
        let current = root
        for (let i = 0; i < parts.length - 1; i++) {
          current = await current.getDirectoryHandle(parts[i])
        }
        // ── 删除前核对 path/mtime/size（owner 要求）──
        // 浏览器目录句柄没有修订 API，只能先读回该文件再比：
        // 列表里的记录与磁盘现状不符（同名新图 / 被别的程序替换）→ 拒绝删除。
        let diskFile: File | null = null
        try {
          const handle = await current.getFileHandle(parts[parts.length - 1])
          diskFile = await handle.getFile()
        } catch {
          diskFile = null
        }
        if (!diskFile) {
          result.failedIds.push(target.id)
          result.reasons[target.id] = '文件不存在（可能已被其它程序删除）'
          continue
        }
        if (Math.abs(diskFile.lastModified - target.mtime) >= 1 || diskFile.size !== target.size) {
          result.failedIds.push(target.id)
          result.reasons[target.id] = '文件内容已变化（与列表记录不符），未删除'
          continue
        }
        await current.removeEntry(parts[parts.length - 1])
      } else {
        // gallery：服务端删除（含 output 根核对 + 修订冲突校验）
        await deleteOutputFile(target.path, { mtime: target.mtime, size: target.size, root: target.root })
      }
    } catch (err) {
      const reason = describeDeleteError(err)
      result.failedIds.push(target.id)
      result.reasons[target.id] = reason
      console.warn('[outputService] 删除文件失败:', target.id, target.path, reason)
      continue
    }
    // 存储层已删。索引清理失败不影响"文件确实没了"这一事实，但要让用户知道索引没跟上
    //
    // ⚠️ 清理一律按**完整图片身份**（path + mtime + size），并在**每一次** live 缓存变更前
    // 重新校验来源与修订：safeToClean 算完之后仍有 await（DB 写入），
    // 期间用户可能切来源 / 重扫换了内容 —— 那时同短 ID 的行属于**另一张图**，动了就是误伤。
    const targetKey = JSON.stringify([target.id, target.path, target.mtime, target.size])
    const canCleanNow = () => stillSameList() && rowStillTarget(target)

    if (!canCleanNow()) {
      console.warn('[outputService] 存储层已删除，但列表来源/内容已变化，跳过缓存清理:', target.path)
      result.deletedIds.push(target.id)
      continue
    }

    // ── DB 行删除：只删"实际存储记录确实还是本次目标"的那条 ──
    // IndexedDB 的记录若已被同路径的新版本（新 mtime/size）替换，删掉它等于抹掉
    // 用户刚生成的那张图的索引 —— 必须比对记录自身的修订后再删。
    try {
      const rec = await outputsDb.files.get(target.id).catch(() => undefined) as
        { path?: string; mtime?: number; size?: number } | undefined
      const recMatches = !!rec
        && rec.path === target.path
        && rec.mtime === target.mtime
        && rec.size === target.size
      if (recMatches) {
        if (!canCleanNow()) {
          console.warn('[outputService] DB 写入前来源已变化，跳过索引清理:', target.path)
        } else {
          await outputsDb.files.delete(target.id)
          // Persisted metadata validates full identity on read; retain it rather than delete by a collision-prone ID.
        }
      } else if (rec) {
        console.warn('[outputService] 索引记录已是另一版本，保留不删:', target.path)
      }
    } catch (err) {
      console.warn('[outputService] 文件已删除但索引清理失败:', target.id, (err as Error)?.message)
    }

    // 内存缓存：变更前再校验一次（每个 live 变更前都重校验）
    if (canCleanNow()) {
      try {
        const cur = useOutputStore.getState().files.filter(f => f.id === target.id)
        const stillTheSame = cur.length === 1 && JSON.stringify([cur[0].id, cur[0].path, cur[0].mtime, cur[0].size]) === targetKey
        if (stillTheSame) useOutputStore.getState().removeMetadata([target.id])
      } catch { /* 内存缓存清理失败无碍 */ }
    }
    // Thumbnail records use legacy path hashes. Retain them; identity validation and bounded LRU reclaim stale data.
    result.deletedIds.push(target.id)
  }

  if (result.deletedIds.length === 0) {
    const first = result.reasons[result.failedIds[0]] || '未知错误'
    showToast(`删除失败：${first}${result.failedIds.length > 1 ? `（共 ${result.failedIds.length} 个未删除）` : ''}`)
    return result
  }

  // ── 只在**列表来源未变**时才改动当前列表/选中态 ──
  // 慢删除期间用户切了目录/来源：此刻 store 里是另一批文件，
  // 按 id 过滤会把新列表里恰好同 id 的行也移除（删 A 动了 B 的视图）。
  if (!stillSameList()) {
    showToast(`已删除 ${result.deletedIds.length} 个文件（列表已切换，未改动当前视图）`)
    return result
  }
  // ⚠️ 移除时按**完整身份**（path + mtime + size）匹配，不能只按短 id：
  // 同根重扫后同一路径可能是**新内容**（mtime/size 变了），
  // 只按 id 过滤会把用户刚生成的那一张从列表里抹掉。
  const removedKeys = new Set(
    targets
      .filter(t => result.deletedIds.includes(t.id))
      .map(t => JSON.stringify([t.id, t.path, t.mtime, t.size]))
  )
  const removedIds = new Set(result.deletedIds)
  useOutputStore.setState(s => {
    const files = s.files.filter(f => !removedKeys.has(JSON.stringify([f.id, f.path, f.mtime, f.size])))
    // 只移除"确实删掉了"的选中项：失败项保持选中，用户可以直接重试。
    // 选中态本身没有修订信息，只在该 id 已不存在于新列表时才清（避免清掉同名新图的选择）
    const stillPresent = new Set(files.map(f => f.id))
    const selectedIds = new Set([...s.selectedIds].filter(id => !removedIds.has(id) || stillPresent.has(id)))
    return { files, selectedIds }
  })
  useOutputStore.getState().applyFilters()

  if (result.failedIds.length === 0) {
    showToast(`已删除 ${result.deletedIds.length} 个文件`)
  } else if (result.deletedIds.length === 0) {
    const first = result.reasons[result.failedIds[0]] || '未知错误'
    showToast(`删除失败：${first}${result.failedIds.length > 1 ? `（共 ${result.failedIds.length} 个未删除）` : ''}`)
  } else {
    const first = result.reasons[result.failedIds[0]] || '未知错误'
    showToast(`已删除 ${result.deletedIds.length} 个，${result.failedIds.length} 个失败：${first}`)
  }
  return result
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

// ── 缩略图 ──
