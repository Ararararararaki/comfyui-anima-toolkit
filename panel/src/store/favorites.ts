import { Cache } from './cache'
import type { FavData, ProcessedModel } from '../types'

const KEY = 'favorites_v2'
const KEY_OLD = 'favorites'
const MAX_PER_COL = 200

function getFavData(): FavData | null {
  return Cache.load<FavData>(KEY, 365 * 24 * 60 * 60 * 1000)
}

function saveFavData(data: FavData) {
  Cache.save(KEY, data)
}

function defaultFavData(): FavData {
  return { collections: { default: { name: '默认收藏', icon: '⭐', items: [] } }, order: ['default'], active: 'default' }
}

export function initFavorites() {
  const existing = Cache.load<FavData>(KEY, 365 * 24 * 60 * 60 * 1000)
  if (existing && existing.collections) return
  const oldData = Cache.load<{ id: number; uid: number; name: string; creator: string; url: string; category: string; thumb: string; time: number }[]>(KEY_OLD, 365 * 24 * 60 * 60 * 1000)
  if (oldData && Array.isArray(oldData) && oldData.length > 0) {
    saveFavData({ collections: { default: { name: '默认收藏', icon: '⭐', items: oldData } }, order: ['default'], active: 'default' })
    Cache.remove(KEY_OLD)
  } else {
    saveFavData(defaultFavData())
  }
}

export function getAllFavs() {
  const data = getFavData()
  if (!data?.collections) return []
  const all: typeof data.collections[string]['items'] = []
  for (const id of data.order) {
    const col = data.collections[id]
    if (col?.items) all.push(...col.items)
  }
  return all
}

export function getCollectionFavs(colId: string) {
  const data = getFavData()
  return data?.collections?.[colId]?.items ?? []
}

export function isFav(id: number) {
  return getAllFavs().some(f => f.id === id)
}

export function findItemCollection(id: number): string | null {
  const data = getFavData()
  if (!data?.collections) return null
  for (const colId of data.order) {
    if (data.collections[colId]?.items?.some(f => f.id === id)) return colId
  }
  return null
}

export function toggleFav(m: ProcessedModel, colId?: string): boolean {
  const data = getFavData() ?? defaultFavData()
  if (!data.collections) return false

  for (const cid of data.order) {
    const col = data.collections[cid]
    if (!col?.items) continue
    const idx = col.items.findIndex(f => f.id === m.id)
    if (idx >= 0) {
      if (colId && colId !== cid) {
        col.items.splice(idx, 1)
        const target = data.collections[colId]
        if (target) {
          target.items.unshift({ id: m.id, uid: m.uid, name: m.name, creator: m.creator, url: m.url, category: m.category, thumb: m.images?.[0] || '', time: Date.now() })
          if (target.items.length > MAX_PER_COL) target.items.length = MAX_PER_COL
        }
        saveFavData(data)
        return true
      }
      col.items.splice(idx, 1)
      saveFavData(data)
      return false
    }
  }

  const targetId = colId || data.active || 'default'
  const target = data.collections[targetId]
  if (!target) return false
  target.items.unshift({ id: m.id, uid: m.uid, name: m.name, creator: m.creator, url: m.url, category: m.category, thumb: m.images?.[0] || '', time: Date.now() })
  if (target.items.length > MAX_PER_COL) target.items.length = MAX_PER_COL
  saveFavData(data)
  return true
}

export function removeFav(id: number) {
  const data = getFavData()
  if (!data?.collections) return
  for (const cid of data.order) {
    const col = data.collections[cid]
    if (col?.items) col.items = col.items.filter(f => f.id !== id)
  }
  saveFavData(data)
}

export function favCount() {
  return getAllFavs().length
}

export function getActiveCol() {
  return getFavData()?.active || 'default'
}

export function setActiveCol(colId: string) {
  const data = getFavData()
  if (data?.collections?.[colId]) {
    data.active = colId
    saveFavData(data)
  }
}

export function getCollections() {
  const data = getFavData()
  if (!data?.collections) return []
  return data.order.map(id => ({
    id,
    name: data.collections[id].name || '未命名',
    icon: data.collections[id].icon || '📁',
    count: (data.collections[id].items || []).length,
  }))
}

export function createCollection(name: string, icon = '📁'): string | null {
  const data = getFavData() ?? defaultFavData()
  if (!data.collections) return null
  const id = 'col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  data.collections[id] = { name: name || '新收藏夹', icon, items: [] }
  data.order.push(id)
  saveFavData(data)
  return id
}

export function renameCollection(colId: string, name: string) {
  const data = getFavData()
  if (data?.collections?.[colId]) {
    data.collections[colId].name = name
    saveFavData(data)
  }
}

export function deleteCollection(colId: string) {
  if (colId === 'default') return
  const data = getFavData()
  if (!data?.collections?.[colId]) return
  delete data.collections[colId]
  data.order = data.order.filter(id => id !== colId)
  if (data.active === colId) data.active = 'default'
  saveFavData(data)
}

export function exportFavData() {
  return getFavData()
}

export function importFavData(data: FavData): boolean {
  if (!data?.collections || !data.order) return false
  saveFavData(data)
  return true
}
