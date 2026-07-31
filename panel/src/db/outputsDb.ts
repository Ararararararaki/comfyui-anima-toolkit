import Dexie, { type Table } from 'dexie'
import type { OutputFile, OutputMetadata, OutputThumbnail } from '../types/outputs'

export interface OutputManifest {
  id: string                    // 路径哈希（同 OutputFile.id）
  path: string                  // 相对路径
  mtime: number                 // 文件最后修改时间
  size: number                  // 文件大小
  metadataHash: string          // 元数据内容哈希（用于检测元数据变更）
  orphaned: boolean             // 是否已被文件系统删除
}

export class OutputsDB extends Dexie {
  files!: Table<OutputFile, string>
  metadata!: Table<OutputMetadata, string>
  thumbnails!: Table<OutputThumbnail, string>
  dirHandles!: Table<any, string>
  manifest!: Table<OutputManifest, string>

  constructor() {
    super('outputs-db')
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
  }
}

export const outputsDb = new OutputsDB()
