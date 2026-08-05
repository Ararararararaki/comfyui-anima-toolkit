// ── Outputs 模块类型定义 ──

export interface OutputFile {
  id: string                    // 路径哈希 (用于 IndexedDB 主键)
  path: string                  // 相对路径 (output/2024-01/img001.png)
  filename: string
  extension: string
  size: number
  mtime: number
  width: number
  height: number
  favorite: boolean
  rating: number                // 0-5
  notes: string
  tags: string[]
  category: string              // 自定义分类（空字符串=未分类）
  status: string                // '' | 'approved' | 'review' | 'edit' | 'rejected' | 'select'
  pinned: boolean               // 是否置顶
  createdAt: number
}

export interface OutputMetadata {
  imageId: string               // 关联 OutputFile.id
  model: string
  seed: string
  steps: string
  cfg: string
  sampler: string
  scheduler?: string
  denoise?: string
  noiseSeed?: string
  vae: string
  clipSkip: number
  prompt: string                // 正向提示词
  negativePrompt: string        // 负向提示词
  workflowJson: string          // ComfyUI 工作流 JSON
  rawMetadata: Record<string, string>
}

export interface OutputDir {
  path: string
  name: string
  handle: FileSystemDirectoryHandle
  children: OutputDir[]
  fileCount: number
}

export type OutputViewMode = 'grid' | 'list'
export type OutputSortKey = 'date' | 'name' | 'size'
export type OutputFilterKey = 'all' | 'favorites' | 'rated'
export type OutputScanStatus = 'idle' | 'scanning' | 'done' | 'error'

export interface OutputThumbnail {
  id: string                    // 文件路径哈希
  dataUrl: string               // base64 数据 URL
  width: number
  height: number
  createdAt: number
}
