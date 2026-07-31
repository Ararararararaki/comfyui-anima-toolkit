import { Cache } from './cache'

const KEY = 'hidden'
const MAX = 500

export function getHiddenIds(): number[] {
  return Cache.load<number[]>(KEY, 365 * 24 * 60 * 60 * 1000) || []
}

export function isHidden(id: number): boolean {
  return getHiddenIds().indexOf(id) >= 0
}

export function addHidden(id: number) {
  const list = getHiddenIds()
  if (list.indexOf(id) >= 0) return
  list.unshift(id)
  if (list.length > MAX) list.length = MAX
  Cache.save(KEY, list)
}

export function removeHidden(id: number) {
  Cache.save(KEY, getHiddenIds().filter(x => x !== id))
}

export function toggleHidden(id: number): boolean {
  if (isHidden(id)) { removeHidden(id); return false }
  addHidden(id); return true
}

export function hiddenCount(): number {
  return getHiddenIds().length
}
