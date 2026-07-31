import { Cache } from './cache'
import type { ArtistData } from '../types'

const KEY = 'artists_v3'

function genId(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

let _artists: ArtistData[] | null = null

function migrateOld(entry: any): ArtistData {
  return {
    id: entry.id || genId(),
    tag: entry.tag || '',
    name: entry.name || entry.tag || '',
    desc: entry.desc || '',
    categories: entry.categories || [entry.category || '未分类'].filter(Boolean),
    loras: entry.loras || [],
    images: entry.images || [],
    hasLora: !!entry.hasLora,
    danbooruCount: entry.danbooruCount ?? 0,
    danbooruName: entry.danbooruName || '',
    socialLinks: entry.socialLinks || [],
    createdAt: entry.createdAt || Date.now(),
    _ghost: !!entry._ghost,
  }
}

function getAll(): ArtistData[] {
  if (_artists) return _artists
  const cached = Cache.load<any[]>(KEY, 365 * 24 * 60 * 60 * 1000)
  if (cached && cached.length > 0) {
    _artists = cached.map(migrateOld)
  } else {
    _artists = []
  }
  return _artists
}

function saveAll(list?: ArtistData[]) {
  if (list) _artists = list
  if (_artists) Cache.save(KEY, _artists)
}

export function refreshArtists(): ArtistData[] {
  _artists = null
  return getAll()
}

export function getArtists() { return getAll() }

export function getArtistById(id: string): ArtistData | undefined {
  return getAll().find(a => a.id === id)
}

export function getArtistByTag(tag: string): ArtistData | undefined {
  const t = tag.toLowerCase().trim()
  return getAll().find(a => a.tag.toLowerCase().trim() === t)
}

export function getArtistCategories(): string[] {
  const cats = new Set<string>()
  getAll().forEach(a => a.categories.forEach(c => cats.add(c)))
  return Array.from(cats).sort()
}

export function addArtist(tag: string, name: string, desc: string, categories?: string[]): ArtistData | null {
  const list = getAll()
  const fixedTag = '@' + tag.replace(/^@+/, '')
  if (list.some(a => a.tag === fixedTag)) return null
  const artist: ArtistData = {
    id: genId(),
    tag: fixedTag,
    name: name || fixedTag,
    desc: desc || '',
    categories: categories && categories.length > 0 ? categories : ['未分类'],
    loras: [],
    images: [],
    hasLora: false,
    danbooruCount: 0,
    danbooruName: '',
    socialLinks: [],
    createdAt: Date.now(),
  }
  list.push(artist)
  saveAll()
  return artist
}

export function updateArtist(id: string, updates: Partial<ArtistData>) {
  const list = getAll()
  const idx = list.findIndex(a => a.id === id)
  if (idx < 0) return
  list[idx] = { ...list[idx], ...updates, id }
  saveAll()
}

export function deleteArtistById(id: string) {
  saveAll(getAll().filter(a => a.id !== id))
}

export function deleteArtist(tag: string) {
  saveAll(getAll().filter(a => a.tag !== tag))
}

export function extractArtistsFromModels(trainedWordsLists: string[][]): { tag: string; name: string; count: number }[] {
  const tagCount = new Map<string, number>()
  for (const words of trainedWordsLists) {
    for (const w of words) {
      const trimmed = w.trim()
      if (trimmed.startsWith('@') && trimmed.length > 2) {
        tagCount.set(trimmed, (tagCount.get(trimmed) || 0) + 1)
      }
    }
  }
  return [...tagCount.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, name: tag.replace('@', ''), count }))
}

export function addArtistFromExtraction(tag: string, count: number): ArtistData | null {
  const list = getAll()
  if (list.some(a => a.tag === tag)) return null
  const artist: ArtistData = {
    id: genId(),
    tag,
    name: tag.replace('@', ''),
    desc: `从 LoRA 数据自动提取（出现 ${count} 次）`,
    categories: ['未分类'],
    loras: [],
    images: [],
    hasLora: false,
    danbooruCount: 0,
    danbooruName: '',
    socialLinks: [],
    createdAt: Date.now(),
  }
  list.push(artist)
  saveAll()
  return artist
}

export function addGhostArtist(tag: string): ArtistData {
  const list = getAll()
  const id = '_ghost_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
  const artist: ArtistData = {
    id,
    tag: tag.startsWith('@') ? tag : '@' + tag,
    name: tag.replace(/^@+/, ''),
    desc: '未在数据库中找到，临时占位',
    categories: ['未分类'],
    loras: [],
    images: [],
    hasLora: false,
    danbooruCount: 0,
    danbooruName: '',
    socialLinks: [],
    createdAt: Date.now(),
    _ghost: true,
  }
  list.push(artist)
  saveAll()
  return artist
}

export function clearGhostArtists() {
  saveAll(getAll().filter(a => !a._ghost))
}

export function importArtists(imported: ArtistData[]): { added: number; updated: number } {
  const list = getAll()
  let added = 0, updated = 0
  const existingByTag = new Map<string, ArtistData>()
  for (const a of list) existingByTag.set(a.tag.toLowerCase().trim(), a)

  for (const item of imported) {
    const tag = (item.tag || '').trim()
    if (!tag) continue
    const existing = existingByTag.get(tag.toLowerCase())
    if (existing) {
      if (item.danbooruCount !== undefined && item.danbooruCount > 0) {
        existing.danbooruCount = item.danbooruCount
        if (item.danbooruName) existing.danbooruName = item.danbooruName
      }
      if (item.socialLinks && item.socialLinks.length > 0) {
        const seen = new Set(existing.socialLinks)
        for (const u of item.socialLinks) if (!seen.has(u)) { seen.add(u); existing.socialLinks.push(u) }
      }
      if (item.categories && item.categories.length > 0) {
        const seen = new Set(existing.categories)
        for (const c of item.categories) if (c !== '未分类' && !seen.has(c)) { seen.add(c); existing.categories.push(c) }
      }
      if (item.images && item.images.length > 0 && existing.images.length === 0) {
        existing.images = item.images
      }
      if (item.desc && !existing.desc) existing.desc = item.desc
      updated++
    } else {
      const artist: ArtistData = {
        id: item.id || genId(),
        tag,
        name: item.name || tag,
        desc: item.desc || '',
        categories: item.categories || ['未分类'],
        loras: item.loras || [],
        images: item.images || [],
        hasLora: !!item.hasLora,
        danbooruCount: item.danbooruCount ?? 0,
        danbooruName: item.danbooruName || '',
        socialLinks: item.socialLinks || [],
        createdAt: item.createdAt || Date.now(),
      }
      list.push(artist)
      existingByTag.set(tag.toLowerCase(), artist)
      added++
    }
  }

  saveAll()
  return { added, updated }
}

export function exportArtists(): { version: number; artists: ArtistData[] } {
  return { version: 3, artists: getAll().filter(a => !a._ghost) }
}