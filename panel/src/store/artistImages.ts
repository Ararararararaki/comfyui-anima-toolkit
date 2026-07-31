import { Cache } from './cache'

const KEY = 'artist_images'

type ArtistImageMap = Record<string, string[]>

function getAll(): ArtistImageMap {
  return Cache.load<ArtistImageMap>(KEY, 365 * 24 * 60 * 60 * 1000) || {}
}

function saveAll(data: ArtistImageMap) {
  Cache.save(KEY, data)
}

export function getCustomImages(tag: string): string[] {
  return getAll()[tag] || []
}

export function addArtistImage(tag: string, url: string) {
  const all = getAll()
  if (!all[tag]) all[tag] = []
  if (!all[tag].includes(url)) {
    all[tag].push(url)
    saveAll(all)
  }
}

export function removeArtistImage(tag: string, url: string) {
  const all = getAll()
  if (all[tag]) {
    all[tag] = all[tag].filter(u => u !== url)
    if (all[tag].length === 0) delete all[tag]
    saveAll(all)
  }
}

export function getMergedImages(tag: string, defaultImages: string[]): string[] {
  const custom = getCustomImages(tag)
  const all = [...custom, ...defaultImages.filter(u => !custom.includes(u))]
  return all.slice(0, 8)
}

export function hasCustomImages(tag: string): boolean {
  const all = getAll()
  return !!all[tag]?.length
}
