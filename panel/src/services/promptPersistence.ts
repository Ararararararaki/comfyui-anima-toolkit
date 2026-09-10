import { db } from '../store/db'
import type { PromptCategory, PromptEntry } from '../types'
import { showToast } from '../utils'

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
// 服务端 413 阈值为 64MB，预检留出余量，避免注定失败的请求白跑
const MAX_PUSH_BYTES = 60 * 1024 * 1024
let lastPushFailToast = 0
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

async function fetchDeletedIds(): Promise<string[]> {
  try {
    const response = await fetch(ENDPOINT + '/deleted', { cache: 'no-store' })
    const payload = await response.json() as { ok?: boolean; deletedIds?: unknown[] }
    if (!response.ok || !payload.ok || !Array.isArray(payload.deletedIds)) return []
    return payload.deletedIds.map(v => String(v).trim()).filter(Boolean)
  } catch (error) {
    console.warn('[Prompt 库] 墓碑列表读取失败（跳过删除同步）:', error)
    return []
  }
}

/** 把删除同步为服务端墓碑：从镜像剔除并记录，防止下次 hydrate 复活 */
export async function tombstonePrompts(ids: string[]): Promise<void> {
  const cleaned = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))]
  if (!cleaned.length) return
  try {
    const response = await fetch(ENDPOINT + '/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: cleaned }),    })
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  } catch (error) {
    console.warn('[Prompt 库] 删除同步失败（该条目刷新后可能复活）:', error)
    showToast('⚠️ 删除未能同步到镜像，此条目刷新后可能复现（可稍后重删）')
  }
}

export async function pushPromptLibrary(): Promise<boolean> {
  try {
    const snapshot = await readLocalSnapshot()
    const body = JSON.stringify(snapshot)
    if (body.length > MAX_PUSH_BYTES) {
      console.warn('[Prompt 库] 快照超过预检上限，跳过镜像写入')
      showToast('⚠️ Prompt 库体积过大（>60MB），镜像写入已跳过，数据仍保存在浏览器本地')
      return false
    }
    // ⚠️ 这里**不能**用 keepalive：Chrome 对 keepalive 请求体有 64KB 硬上限，
    // 超过时请求根本发不出去，直接抛 `TypeError: Failed to fetch`
    // —— 这正是「Prompt 库镜像写入失败」的真正原因（2026-09-10 用户控制台实测：
    // 报的是 Failed to fetch 而非任何 HTTP 状态码）。代价是页面关闭瞬间可能丢一次镜像写入，
    // 可接受：IndexedDB 仍是主库，且下次打开会重新校验并补推。
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const payload = await response.json().catch(() => ({})) as PromptLibraryResponse
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`)
    return true
  } catch (error) {
    // IndexedDB 仍是前端主库；服务端不可用时不阻塞用户保存。
    console.warn('[Prompt 库] 服务端镜像写入失败:', error)
    if (Date.now() - lastPushFailToast > 30000) {
      lastPushFailToast = Date.now()
      showToast('⚠️ Prompt 库镜像写入失败，本次更改仅保存在浏览器本地')
    }
    return false
  }
}

export function schedulePromptLibrarySync(): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = undefined
    if (remoteChecked) { void pushPromptLibrary(); return }
    // 首次远端校验尚未完成时不静默丢推送：等 hydrate 完成后立即补发
    void (hydratePromise ?? Promise.resolve()).then(() => pushPromptLibrary())
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
        // 同样不能用 keepalive（64KB 上限会让请求发不出去 → TypeError: Failed to fetch）
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
