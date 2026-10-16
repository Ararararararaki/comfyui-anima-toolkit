// ── Outputs 模块类型定义 ──

export interface OutputFile {
  sourceId?: string             // 缺省为历史 ComfyUI output；外部目录使用持久来源 ID
  id: string                    // output 保留旧 ID；目录使用来源+路径的可逆编码
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

export type OutputSourceKind = 'gallery' | 'native' | 'directory'
export interface OutputSource {
  id: string
  kind: OutputSourceKind
  label: string
  root: string
  parserVersion: number
  handle?: FileSystemDirectoryHandle
  enabled: boolean
  permission: 'granted' | 'prompt' | 'denied' | 'none'
}

export type PromptStatus = 'complete' | 'partial' | 'ambiguous' | 'missing'
export type MetadataState = 'present' | 'absent' | 'error' | 'unsupported' | 'unknown'

export interface OutputGenerationDetails {
  checkpoints: string[]
  textEncoders: string[]
  vaes: string[]
  loraDetails: { name: string; strengthModel: number | null; strengthClip: number | null; enabled: boolean; nodeId: string; active: boolean | null }[]
  generationStages: { nodeId: string; label: string; steps: string; cfg: string; seed: string; noiseSeed?: string; sampler: string; scheduler: string; denoise: string; effectiveSteps?: number }[]
  generationStatus: PromptStatus
  generationWarnings: string[]
  generationScope?: 'output' | 'recorded'
  generationOutputNodeId?: string | null
  metadataSource?: string
}

export interface PromptStage {
  nodeId: string
  label: string
  prompt: string
  negativePrompt: string
}

export interface OutputMetadata extends Partial<OutputGenerationDetails> {
  /** Agreed saved-branch text for identity matching; never a copyable actual prompt. */
  identityPrompt?: string
  imageId: string               // 关联 OutputFile.id
  identity?: { path: string; root: string; mtime: number; size: number }
  parserVersion?: number
  summaryStatus?: 'pending' | 'ready' | 'error'
  metadataState?: MetadataState
  metadataFormat?: string
  metadataWarnings?: string[]
  promptStages?: PromptStage[]
  promptStatus?: PromptStatus
  promptWarnings?: string[]
  metadataIdentity?: string
  sourceIdentity?: { source: string; root: string; path: string; mtime: number; size: number; parserVersion: number }
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
  /** 目录句柄：文件系统授权构建的树才有；Gallery 索引推导的树没有（仅用于浏览/前缀过滤，不做文件操作） */
  handle?: FileSystemDirectoryHandle
  children: OutputDir[]
  fileCount: number
}

export type OutputViewMode = 'grid' | 'list'
export type OutputSortKey = 'date' | 'name' | 'size'
export type OutputGroupMode = 'none' | 'flat' | 'work' | 'character'
export interface OutputEntity { id: string; name: string; tag?: string; aliases?: string[]; workIds?: string[] }
/** Rebuildable search data; file IDs and user annotations keep their existing ownership. */
export interface OutputSummary {
  identityPrompt?: string
  imageId: string
  sourceId: string
  path: string
  filename: string
  root: string
  mtime: number
  size: number
  parserVersion: number
  indexVersion: number
  key: string
  model: string
  prompt: string
  loras: string[]
  tagKeys: string[]
  searchAliases: string[]
  characters: OutputEntity[]
  works: OutputEntity[]
  classificationVersion: string
  hasWorkflow?: boolean
  metadataState?: MetadataState
  metadataWarnings?: string[]
  classificationStatus: 'pending' | 'identified' | 'unrecognized' | 'error'
  classificationAmbiguous?: boolean
  indexStatus: 'ready' | 'pending' | 'error'
  error?: string
  retryAt?: number
  notes?: string
  manualTags?: string[]
  inferredTags?: string[]
  inferenceStatus?: 'pending' | 'ready' | 'error'
  inferenceVersion?: string
  inferenceModel?: string
  inferenceError?: string
  tagSource?: 'saved' | 'wd14' | 'none'
}
export type OutputFilterKey = 'all' | 'favorites' | 'rated' | 'missingMetadata' | 'inferred'
export type OutputScanStatus = 'idle' | 'scanning' | 'done' | 'error'

export interface OutputThumbnail {
  id: string                    // 对应 OutputFile.id
  dataUrl: string               // base64 数据 URL
  width: number
  height: number
  createdAt: number
}
