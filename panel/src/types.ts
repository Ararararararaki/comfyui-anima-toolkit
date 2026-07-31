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
  metadata: { totalPages: number; nextPage: number | null }
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

export type SortKey = 'downloads' | 'likes' | 'ratio' | 'name'
export type PeriodKey = 'AllTime' | 'Month' | 'Week'
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