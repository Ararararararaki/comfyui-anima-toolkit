export interface CivitaiImage {
  url: string
  type: string
  nsfw: string
  width: number
  height: number
}

export interface CivitaiModelVersion {
  id: number
  name: string
  baseModel: string
  createdAt: string
  images: CivitaiImage[]
  trainedWords: string[]
  files: { name: string; downloadUrl: string; primary: boolean }[]
}

export interface CivitaiCreator {
  username: string
  image: string
}

export interface CivitaiModel {
  id: number
  name: string
  description: string
  type: string
  nsfw: boolean
  nsfwLevel: number
  creator: CivitaiCreator
  tags: string[]
  modelVersions: CivitaiModelVersion[]
  stats: { downloadCount: number; thumbsUpCount: number }
}

export interface CivitaiResponse {
  items: CivitaiModel[]
  metadata: {
    totalPages?: number
    nextPage?: string | null
    nextCursor?: string | null
    currentPage?: number
  }
}

export type ModelCategory = 'artist' | 'character' | 'aesthetic' | 'background' | 'other'

export interface ProcessedModel {
  id: number
  uid: number
  name: string
  description: string
  creator: string
  creatorUrl: string
  url: string
  downloadUrl: string
  stats: { downloadCount: number; thumbsUpCount: number; ratio: number }
  nsfw: boolean
  tags: string[]
  category: ModelCategory
  categoryLabel: string
  badgeClass: string
  images: string[]
  trainedWords: string[]
  versionId: number
  versionName: string
  customAdded: boolean
  needsFallback: boolean
  fallbackLoading: boolean
  fallbackDone: boolean
  quality: string[]
  baseModel: string
  versions?: { id: number; name: string; files: { name: string; downloadUrl: string; primary: boolean }[] }[]
  versionCreatedAt: string
}

export type SortKey = 'Most Downloaded' | 'Highest Rated' | 'Newest' | 'Most Discussed' | 'Most Collected'
export type PeriodKey = 'AllTime' | 'Year' | 'Month' | 'Week' | 'Day'
export type SectionKey = 'lora' | 'artist' | 'prompt' | 'prompt-freq' | 'local' | 'outputs'

export interface FavItem {
  id: number
  uid: number
  name: string
  creator: string
  url: string
  category: string
  thumb: string
  time: number
}

export interface FavCollection {
  name: string
  icon: string
  items: FavItem[]
}

export interface FavData {
  collections: Record<string, FavCollection>
  order: string[]
  active: string
}

export interface ViewItem {
  id: number
  uid: number
  name: string
  creator: string
  url: string
  category: string
  thumb: string
  time: number
}

export interface ArtistData {
  id: string
  tag: string
  name: string
  desc: string
  categories: string[]
  loras: { name: string; creator: string; url: string; downloads: number | string; likes?: number }[]
  images: string[]
  hasLora: boolean
  danbooruCount: number
  danbooruName: string
  socialLinks: string[]
  createdAt: number
  _ghost?: boolean
}

export interface RankEntry {
  tag: string
  name: string
  desc: string
  dl: number
  like: number
  hasLora: boolean
  danbooruCount: number
  socialLinks: string[]
  score: number
}

export interface PromptParsed {
  tag: string
  weight: number
}

export interface DanbooruResult {
  count: number
  name: string | null
  category: string
  error?: string
}

export interface ArtistPreset {
  id: string
  name: string
  artists: { tag: string; weight: number }[]
  createdAt: number
}

export interface PromptEntry {
  id: string
  sourceModelId?: number
  sourceModelName?: string
  sourceModelUrl?: string
  sourceModelCategory?: string
  prompt: string
  displayText: string
  images: string[]
  primaryImage: string
  tags: string[]
  loras?: string[]
  categoryId: string
  /** 已废弃：新记录不再写入，仅兼容旧数据 */
  weight?: number
  notes: string
  isFavorite: boolean
  createdAt: number
  updatedAt: number
}

export interface PromptCategory {
  id: string
  name: string
  icon: string
  sortOrder: number
  parentId?: string
}

export interface ModelNote {
  id: number
  notes: string
  rating: number
  status: 'untried' | 'trying' | 'success' | 'abandoned'
  lastUsed: number
  updatedAt: number
}

// ── 服装卡片库 ──
export interface ClothingCard {
  id: string
  /** 显示名（无图时卡片大字显示） */
  name: string
  /** 英文 tag 串（抽卡复制时按逗号连接） */
  prompt: string
  /** 平铺分类 id（一个名字一组，无层级） */
  categoryId: string
  /** 从 prompt 拆分出的 tag，用于搜索 */
  tags: string[]
  /** 本地图片（IndexedDB Blob，优先于 imageUrl） */
  imageBlob?: Blob
  /** 远程图片 URL（无本地图时兜底） */
  imageUrl?: string
  favorite: boolean
  /** 被抽中次数（后续可做常用优先） */
  useCount: number
  /** import=从 Prompt-Manager 迁入 / manual=手建 */
  source: 'import' | 'manual'
  createdAt: number
  updatedAt: number
}

export interface ClothingCategory {
  id: string
  name: string
  sortOrder: number
}

export interface LocalLoraFile {
  name: string
  path: string
  size: number
  lastModified: number
  sha256: string
  matched: boolean
  matchData: LocalLoraMatch | null
  matchError: string
  scanning: boolean
}


export interface LocalLoraMatch {
  modelId: number
  modelName: string
  versionId: number
  versionName: string
  trainedWords: string[]
  images: string[]
  creator: string
  description: string
  downloadCount: number
  thumbsUpCount: number
  baseModel: string
  tags: string[]
  nsfw: boolean
}

export interface PngMeta {
  fileName: string
  fileSize: number
  positive: string
  negative: string
  seed: string
  steps: string
  cfg: string
  sampler: string
  model: string
  loras: string[]
  raw: Record<string, string>
}

export interface TagFreq {
  tag: string
  count: number
  source: 'trained' | 'prompt'
}

export type LocalScanStatus = 'idle' | 'scanning' | 'matching' | 'done' | 'error'