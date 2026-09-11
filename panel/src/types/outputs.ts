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
  loras?: string[]              // 内存缓存版：预提取的 LoRA 名列表（瘦身版元数据剥离 workflowJson 后仍可展示/筛选）
  hasWorkflow?: boolean         // 内存缓存版：是否原本有 workflow（剥离后仍可判断"下载工作流"按钮）
  lorasExtracted?: boolean      // 内存缓存版：LoRA 是否已提取完成。⚠️ 这是「是否已提取」的唯一真源 ——
                                // 全库元数据补齐（putMetadataBatch）会用 DB 记录覆盖缓存条目，
                                // 而 DB 不存 loras；靠本标记才能保住已提取结果、并在未提取时允许补提取
                                // （否则 Outputs 卡片的「复制 LoRA 标签」按钮会消失且不再恢复）
  workflowFingerprint?: string  // 内存缓存版：工作流内容指纹（长度+首尾片段）。写入新解析结果时
                                // 用它判断工作流是否真的变了：未变则沿用已提取的 loras，
                                // 避免扫描/重解析写回把刚提取好的结果清空
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
