import Dexie, { type Table } from 'dexie'
import type { OutputFile, OutputMetadata, OutputThumbnail } from '../types/outputs'

// 与 outputManifest.hashPath 一致（文件路径 → 主键）。内联避免 db ↔ services 循环依赖。
function hashPath(path: string): string {
  let hash = 0
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export interface OutputManifest {
  id: string                    // 路径哈希（同 OutputFile.id）
  path: string                  // 相对路径
  mtime: number                 // 文件最后修改时间
  size: number                  // 文件大小
  metadataHash: string          // 元数据内容哈希（用于检测元数据变更）
  orphaned: boolean             // 是否已被文件系统删除
}

/**
 * 工作库名（v3 起）。
 * 旧库 'outputs-db' 曾出现主键与当前 schema 不一致（历史版本/外部工具残留），
 * Dexie 升级会直接抛 UpgradeError:"Not yet support for changing primary key"。
 * 改用新库名 + 一次性迁移，从根上绕开 Dexie 对旧库的升级校验。
 */
const DB_NAME = 'outputs-db-v3'
const LEGACY_DB_NAME = 'outputs-db'

export class OutputsDB extends Dexie {
  files!: Table<OutputFile, string>
  metadata!: Table<OutputMetadata, string>
  thumbnails!: Table<OutputThumbnail, string>
  dirHandles!: Table<any, string>
  manifest!: Table<OutputManifest, string>

  constructor() {
    super(DB_NAME)
    this.version(1).stores({
      files: '&id, path, filename, favorite, rating, createdAt, mtime',
      metadata: '&imageId',
      thumbnails: '&id',
    })
    this.version(2).stores({
      files: '&id, path, filename, favorite, rating, createdAt, mtime',
      metadata: '&imageId',
      thumbnails: '&id',
      dirHandles: '',
      manifest: '&id, path, mtime, orphaned',
    })
    this.version(3).stores({
      files: '&id, path, filename, favorite, rating, createdAt, mtime',
      metadata: '&imageId',
      thumbnails: '&id',
      dirHandles: '',
      manifest: '&id, path, mtime, orphaned',
    })
  }
}

export const outputsDb = new OutputsDB()

// ── 旧库一次性迁移（outputs-db → outputs-db-v3）──
// 旧库结构可能早已损坏（主键不符），这里用原生 IDB 只读旧数据，再写入全新库，
// 全程不经过 Dexie 对旧库的升级校验。files 是唯一不可重建的用户资产（分类/收藏/
// 评分/状态），metadata/thumbnails 仅当旧表主键恰好等于目标时才搬（否则后台重扫）。
// 幂等：新库已有数据则跳过；旧库不动（留待手工清理，避免误删用户数据）。

interface LegacyRecord {
  key: IDBValidKey
  value: Record<string, unknown>
}

interface LegacySnapshot {
  files: LegacyRecord[]
  metadata: LegacyRecord[]
  thumbnails: LegacyRecord[]
  dirHandles: LegacyRecord[]
  filesKeyPath: string
}

function openDb(name: string): Promise<{ db: IDBDatabase; version: number } | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(name)
    } catch {
      resolve(null)
      return
    }
    req.onsuccess = () => resolve({ db: req.result, version: req.result.version })
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

function readStoreWithKeys(db: IDBDatabase, name: string): Promise<LegacyRecord[]> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(name, 'readonly')
    } catch {
      resolve([])
      return
    }
    const store = tx.objectStore(name)
    const out: LegacyRecord[] = []
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        out.push({ key: cursor.key, value: cursor.value as Record<string, unknown> })
        cursor.continue()
      } else {
        resolve(out)
      }
    }
    req.onerror = () => resolve(out)
  })
}

function countStore(db: IDBDatabase, name: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(name).objectStore(name).count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(0)
    } catch {
      resolve(0)
    }
  })
}

/**
 * 启动时调用：若存在遗留的旧库 outputs-db 且有数据，且新库尚无数据，
 * 则把旧数据搬入 outputs-db-v3。任何失败都只打日志，绝不阻塞面板启动。
 */
export async function ensureOutputsDbCompatible(): Promise<void> {
  try {
    const legacy = await openDb(LEGACY_DB_NAME)
    if (!legacy || legacy.db.objectStoreNames.length === 0) return

    // 新库已有数据（迁移已完成/用户新装）→ 跳过
    if (await outputsDb.files.count() > 0 || await outputsDb.metadata.count() > 0) return

    const { db } = legacy
    const legacyFileCount = await countStore(db, 'files')
    if (legacyFileCount === 0) {
      db.close()
      return
    }

    // 决定各表是否可搬：files 必搬（键与 id 重新映射）；metadata/thumbnails 仅当
    // 主键恰好为 imageId/id 才搬，否则丢给后台重扫（缩略图/元数据均可再生）。
    const filesKeyPath = db.transaction('files').objectStore('files').keyPath as string
    const metaKeyPath = db.objectStoreNames.contains('metadata')
      ? (db.transaction('metadata').objectStore('metadata').keyPath as string)
      : ''
    const thumbKeyPath = db.objectStoreNames.contains('thumbnails')
      ? (db.transaction('thumbnails').objectStore('thumbnails').keyPath as string)
      : ''

    const snapshot: LegacySnapshot = {
      files: await readStoreWithKeys(db, 'files'),
      metadata: metaKeyPath === 'imageId' ? await readStoreWithKeys(db, 'metadata') : [],
      thumbnails: thumbKeyPath === 'id' ? await readStoreWithKeys(db, 'thumbnails') : [],
      dirHandles: db.objectStoreNames.contains('dirHandles') ? await readStoreWithKeys(db, 'dirHandles') : [],
      filesKeyPath,
    }
    db.close()

    // 用新库名打开（Dexie 建全新 v3，零升级冲突）
    await outputsDb.open()

    if (snapshot.files.length > 0) {
      const legacyKeyToId = new Map<IDBValidKey, string>()
      const normalized = snapshot.files.map(({ key, value: raw }) => {
        const path = String(raw.path || '')
        const id = typeof raw.id === 'string' && raw.id ? raw.id : hashPath(path)
        legacyKeyToId.set(key, id)
        const file: OutputFile = {
          id,
          path,
          filename: String(raw.filename || path.split('/').pop() || ''),
          extension: String(raw.extension || 'png'),
          size: Number(raw.size || 0),
          mtime: Number(raw.mtime || Date.now()),
          width: Number(raw.width || 0),
          height: Number(raw.height || 0),
          favorite: Boolean(raw.favorite),
          rating: Number(raw.rating || 0),
          notes: String(raw.notes || ''),
          tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
          category: String(raw.category || ''),
          status: String(raw.status || ''),
          pinned: Boolean(raw.pinned),
          createdAt: Number(raw.createdAt || Date.now()),
        }
        return file
      })
      await outputsDb.files.bulkPut(normalized)

      // metadata 迁移：优先用记录自带 imageId；否则用旧文件键映射（键相同场景）
      const migratedMeta = snapshot.metadata
        .map(({ key, value: raw }) => {
          const imageId = typeof raw.imageId === 'string' && raw.imageId
            ? raw.imageId
            : (snapshot.filesKeyPath === 'path' ? hashPath(String(raw.path || '')) : (legacyKeyToId.get(key) || ''))
          if (!imageId) return null
          return { ...raw, imageId } as unknown as OutputMetadata
        })
        .filter((m): m is OutputMetadata => !!m)
      if (migratedMeta.length > 0) await outputsDb.metadata.bulkPut(migratedMeta)

      if (snapshot.thumbnails.length > 0) {
        await outputsDb.thumbnails.bulkPut(snapshot.thumbnails.map(({ value }) => value as unknown as OutputThumbnail))
      }
      if (snapshot.dirHandles.length > 0) {
        for (const { key, value } of snapshot.dirHandles) {
          await (outputsDb.dirHandles as any).put(value, key)
        }
      }
    }

    console.info(`[outputsDb] 旧库迁移完成：files ${snapshot.files.length} / metadata ${snapshot.metadata.length} / thumbnails ${snapshot.thumbnails.length} / dirHandles ${snapshot.dirHandles.length}`)
  } catch (err) {
    console.warn('[outputsDb] 旧库迁移失败（不影响新库使用）:', (err as Error)?.message || err)
  }
}