/* ── 面板数据备份服务 ──
 * 导出/导入 IndexedDB outputs-db（files/metadata/manifest/dirHandles，不含 thumbnails）
 * + localStorage 设置（anima_*）+ 背景图（IndexedDB anima-bg）
 */
import { outputsDb } from '../db/outputsDb'
import { exportSettings, importSettings, saveBgImageDB, loadBgImageDB } from '../store/settings'

export interface BackupData {
  schemaVersion: 1
  exportedAt: string
  settings: Record<string, string>
  bgImageData?: string | null
  db: {
    files: unknown[]
    metadata: unknown[]
    manifest: unknown[]
    dirHandles: unknown[]
  }
}

const ALLOWED_TABLES = new Set(['files', 'metadata', 'manifest', 'dirHandles'])

async function serializeDirHandles(): Promise<unknown[]> {
  try {
    const rows = await outputsDb.dirHandles.toArray()
    return rows.map((r) => {
      if (r && typeof r === 'object') {
        const obj = { ...r } as Record<string, unknown>
        // FileSystemDirectoryHandle 不能 JSON 序列化，降级为 name/path 字符串
        for (const k of Object.keys(obj)) {
          const v = (obj as Record<string, unknown>)[k] as unknown
          if (v && typeof v === 'object' && 'name' in (v as object)) {
            obj[k] = String((v as { name?: unknown }).name || '')
          }
        }
        return obj
      }
      return r
    })
  } catch {
    return []
  }
}

export async function exportAll(): Promise<BackupData> {
  const settingsText = exportSettings()
  let settings: Record<string, string> = {}
  try {
    const parsed = JSON.parse(settingsText)
    settings = parsed.data || {}
  } catch {
    settings = {}
  }

  const [files, metadata, manifest, dirHandles, bgImageData] = await Promise.all([
    outputsDb.files.toArray(),
    outputsDb.metadata.toArray(),
    outputsDb.manifest.toArray(),
    serializeDirHandles(),
    loadBgImageDB().catch(() => null),
  ])

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    settings,
    bgImageData: bgImageData || null,
    db: { files, metadata, manifest, dirHandles },
  }
}

export async function importAll(json: string): Promise<{ ok: boolean; error?: string }> {
  let data: BackupData
  try {
    data = JSON.parse(json)
  } catch {
    return { ok: false, error: '文件不是合法 JSON' }
  }

  if (data.schemaVersion !== 1) {
    return { ok: false, error: `不支持的备份版本：${data.schemaVersion}（当前支持 1）` }
  }
  if (!data.db || typeof data.db !== 'object') {
    return { ok: false, error: '备份缺少 db 数据' }
  }
  for (const table of Object.keys(data.db)) {
    if (!ALLOWED_TABLES.has(table)) {
      return { ok: false, error: `备份包含未知表：${table}` }
    }
  }

  // 导入设置
  if (data.settings && typeof data.settings === 'object') {
    const fakeJson = JSON.stringify({ version: 1, exportedAt: data.exportedAt || '', data: data.settings })
    if (!importSettings(fakeJson)) {
      return { ok: false, error: '设置数据导入失败' }
    }
  }

  // 导入背景图（大图存 IndexedDB）
  if (data.bgImageData && typeof data.bgImageData === 'string') {
    try {
      await saveBgImageDB(data.bgImageData)
    } catch (e) {
      console.error('[备份] 背景图导入失败:', e)
    }
  }

  // 导入 outputs-db（事务内清空 + 写入；thumbnails 不导入，扫描时自动重建）
  try {
    await outputsDb.transaction('rw', outputsDb.files, outputsDb.metadata, outputsDb.manifest, outputsDb.dirHandles, async () => {
      await outputsDb.files.clear()
      await outputsDb.metadata.clear()
      await outputsDb.manifest.clear()
      await outputsDb.dirHandles.clear()

      if (Array.isArray(data.db.files)) await outputsDb.files.bulkPut(data.db.files as never[])
      if (Array.isArray(data.db.metadata)) await outputsDb.metadata.bulkPut(data.db.metadata as never[])
      if (Array.isArray(data.db.manifest)) await outputsDb.manifest.bulkPut(data.db.manifest as never[])
      if (Array.isArray(data.db.dirHandles)) await outputsDb.dirHandles.bulkPut(data.db.dirHandles as never[])
    })
  } catch (e) {
    return { ok: false, error: `IndexedDB 导入失败：${String((e && (e as Error).message) || e)}` }
  }

  return { ok: true }
}
