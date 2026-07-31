interface CacheEntry<T> {
  data: T
  timestamp: number
  version: number
}

export const Cache = {
  save<T>(key: string, data: T) {
    try {
      localStorage.setItem('anima_' + key, JSON.stringify({
        data, timestamp: Date.now(), version: 1,
      } as CacheEntry<T>))
    } catch { /* quota exceeded */ }
  },

  load<T>(key: string, ttl: number): T | null {
    try {
      const raw = localStorage.getItem('anima_' + key)
      if (!raw) return null
      const entry: CacheEntry<T> = JSON.parse(raw)
      if (Date.now() - entry.timestamp > ttl) {
        localStorage.removeItem('anima_' + key)
        return null
      }
      return entry.data
    } catch { return null }
  },

  remove(key: string) {
    localStorage.removeItem('anima_' + key)
  },

  clearAll() {
    Object.keys(localStorage).filter(k => k.startsWith('anima_')).forEach(k => localStorage.removeItem(k))
  },
}
