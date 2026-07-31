import { Cache } from './cache'
import type { ViewItem } from '../types'

const MAX_VIEWS = 20
const MAX_SEARCHES = 10

export function getViews(): ViewItem[] {
  return Cache.load<ViewItem[]>('views', 7 * 24 * 60 * 60 * 1000) || []
}

export function addView(m: ViewItem) {
  const views = getViews().filter(v => v.id !== m.id)
  views.unshift({ ...m, time: Date.now() })
  if (views.length > MAX_VIEWS) views.length = MAX_VIEWS
  Cache.save('views', views)
}

export function clearViews() {
  Cache.remove('views')
}

export function getSearches(): string[] {
  return Cache.load<string[]>('searches', 30 * 24 * 60 * 60 * 1000) || []
}

export function addSearch(query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return
  const searches = getSearches().filter(s => s !== q)
  searches.unshift(q)
  if (searches.length > MAX_SEARCHES) searches.length = MAX_SEARCHES
  Cache.save('searches', searches)
}

export function clearSearches() {
  Cache.remove('searches')
}
