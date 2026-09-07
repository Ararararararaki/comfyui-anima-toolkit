import { db } from '../store/db'
import type { PromptCategory, PromptEntry } from '../types'

export interface PromptLibrarySnapshot {
  schemaVersion: 1
  updatedAt: number
  categories: PromptCategory[]
  prompts: PromptEntry[]
}

interface PromptLibraryResponse {
  ok: boolean
  snapshot?: PromptLibrarySnapshot | null
  recoveredFromBackup?: boolean
  error?: string
}

const ENDPOINT = '/anima/prompt-library'
const SYNC_DELAY = 800
let syncTimer: ReturnType<typeof setTimeout> | undefined
let hydratePromise: Promise<void> | null = null
let remoteChecked = false
let lifecycleBound = false

async function readLocalSnapshot(): Promise<PromptLibrarySnapshot> {
  const [categories, prompts] = await Promise.all([
    db.promptCategories.toArray(),
    db.prompts.toArray(),
  ])
  return { schemaVersion: 1, updatedAt: Date.now(), categories, prompts }
}

function mergeById<T extends { id: string }>(remote: T[], local: T[], preferNewer: boolean): T[] {
  const result = new Map<string, T>()
  for (const item of remote) if (item?.id) result.set(item.id, item)
  for (const item of local) {
    if (!item?.id) continue
    const previous = result.get(item.id)
    if (!previous || !preferNewer) {
      result.set(item.id, item)
      continue
    }
    const localTime = Number((item as T & { updatedAt?: number }).updatedAt || 0)
    const remoteTime = Number((previous as T & { updatedAt?: number }).updatedAt || 0)
    if (localTime >= remoteTime) result.set(item.id, item)
  }
  return [...result.values()]
}

function mergeSnapshots(remote: PromptLibrarySnapshot, local: PromptLibrarySnapshot): PromptLibrarySnapshot {
  return {
    schemaVersion: 1,
    updatedAt: Math.max(remote.updatedAt || 0, local.updatedAt || 0, Date.now()),
    // Categories do not have a historical updatedAt field; the current browser
    // view wins for matching IDs, while remote-only custom categories survive.
    categories: mergeById(remote.categories || [], local.categories || [], false),
    prompts: mergeById(remote.prompts || [], local.prompts || [], true),
  }
}

async function writeMergedSnapshot(snapshot: PromptLibrarySnapshot): Promise<void> {
  await db.transaction('rw', db.promptCategories, db.prompts, async () => {
    if (snapshot.categories.length) await db.promptCategories.bulkPut(snapshot.categories)
    if (snapshot.prompts.length) await db.prompts.bulkPut(snapshot.prompts)
  })
}

async function fetchRemote(): Promise<PromptLibrarySnapshot | null> {
  try {
    const response = await fetch(ENDPOINT, { cache: 'no-store' })
    const payload = await response.json() as PromptLibraryResponse
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`)
    return payload.snapshot || null
  } catch (error) {
    console.warn('[Prompt 库] 服务端镜像读取失败，保留浏览器本地库:', error)
    return null
  } finally {
    remoteChecked = true
  }
}

export async function pushPromptLibrary(): Promise<boolean> {
  try {
    const snapshot = await readLocalSnapshot()
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
      keepalive: true,
    })
    const payload = await response.json().catch(() => ({})) as PromptLibraryResponse
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`)
    return true
  } catch (error) {
    // IndexedDB 仍是前端主库；服务端不可用时不阻塞用户保存。
    console.warn('[Prompt 库] 服务端镜像写入失败:', error)
    return false
  }
}

export function schedulePromptLibrarySync(): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = undefined
    if (remoteChecked) void pushPromptLibrary()
  }, SYNC_DELAY)
}

/**
 * Hydrate the browser library from the durable server mirror once per page.
 * Merge-only semantics deliberately keep records missing from a cleared
 * browser profile; an explicit user import remains the only destructive path.
 */
export async function restorePromptLibrary(): Promise<void> {
  if (hydratePromise) return hydratePromise
  if (typeof window !== 'undefined' && !lifecycleBound) {
    lifecycleBound = true
    const flush = () => {
      if (remoteChecked) void pushPromptLibrary()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
  hydratePromise = (async () => {
    const remote = await fetchRemote()
    const local = await readLocalSnapshot()
    if (remote) {
      const merged = mergeSnapshots(remote, local)
      await writeMergedSnapshot(merged)
      // Re-post the merged view so records created in this browser also reach
      // the durable mirror, regardless of whether localhost or 127.0.0.1 is used.
      await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
        keepalive: true,
      }).catch(error => console.warn('[Prompt 库] 合并结果回写失败:', error))
    } else if (local.categories.length || local.prompts.length) {
      // First run on an older plugin: seed the server mirror from the local DB.
      await pushPromptLibrary()
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('anima-prompt-library-restored'))
    }
  })().catch(error => {
    console.warn('[Prompt 库] 恢复失败，继续使用浏览器本地库:', error)
  })
  return hydratePromise
}
