interface CacheEntry<T> {
  data: T
  timestamp: number
  version: number
}

const PREFIX = 'anima_'

/**
 * 只允许被自动淘汰的 key 前缀 —— 仅画廊列表缓存（随时可从 Civitai 重新抓取）。
 *
 * ⚠️ 其余 anima_* 一律不在此列，永远不会被自动清理，包括：
 *   · anima_local_*（本地 LoRA 扫描 / 清单缓存，重建要重扫目录）
 *   · anima_explore_history（探索历史）
 *   · anima_custom_loras、anima_artists* 等（用户配置与自定义数据）
 *   · anima_civitai_token（登录态）
 */
const EVICTABLE_PREFIXES = ['anima_models_']

/**
 * 「可淘汰缓存」允许占用的字符预算。
 *
 * 背景：localStorage 每个源上限约 524 万字符（UTF-16）。本插件的画廊缓存按
 * 「筛选条件组合」无限增长（单条可达 130 万字符），曾把整源占到 96%，导致
 * ComfyUI 自己的「工作流草稿」写不进去（报「保存工作流草稿失败」）。
 * 这里把画廊缓存压在这个预算内，其余空间留给 ComfyUI 草稿（一份 12~35 万字符）
 * 与其它数据。调大 = 画廊缓存更持久、ComfyUI 余量更小；调小 = 反之。
 */
const EVICTABLE_BUDGET = 1_500_000

/** 无论多满都至少保留的最新缓存条数（避免淘汰掉正在查看的那条） */
const KEEP_AT_LEAST = 1

function isEvictable(storageKey: string): boolean {
  return EVICTABLE_PREFIXES.some(prefix => storageKey.startsWith(prefix))
}

interface EvictableRow {
  key: string
  size: number
  /** 条目自身的写入时间（用于「最旧优先」淘汰） */
  timestamp: number
  /** localStorage 中的遍历序号，仅作 timestamp 相同时的稳定兜底 */
  index: number
}

function collectEvictable(): EvictableRow[] {
  const rows: EvictableRow[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !isEvictable(key)) continue
      const raw = localStorage.getItem(key) || ''
      let timestamp = 0
      try {
        timestamp = (JSON.parse(raw) as CacheEntry<unknown>)?.timestamp || 0
      } catch {
        timestamp = 0 // 坏数据视为最旧，优先淘汰
      }
      rows.push({ key, index: i, size: key.length + raw.length, timestamp })
    }
  } catch {
    /* 读不到就当作没有可淘汰项 */
  }
  return rows
}

/**
 * 只淘汰「可重建缓存」里最旧的条目，直到总量 + incoming 落回预算内。
 *
 * @param incoming   即将写入的字符数（0 = 只做压缩，不预留）
 * @param protectKey 本次正在写的 key：绝不淘汰它（避免刚写完就被自己删掉）
 *
 * 出错或已无可淘汰项时静默返回 —— 绝不触碰不可重建的 key。
 */
function enforceEvictableBudget(incoming = 0, protectKey?: string): void {
  const all = collectEvictable()
  let total = all.reduce((sum, row) => sum + row.size, 0)
  if (total + incoming <= EVICTABLE_BUDGET) return

  const rows = all.filter(row => row.key !== protectKey)
  const minKeep = protectKey ? 0 : KEEP_AT_LEAST
  rows.sort((a, b) => (a.timestamp - b.timestamp) || (a.index - b.index)) // 最旧优先

  while (rows.length > minKeep && total + incoming > EVICTABLE_BUDGET) {
    const victim = rows.shift()
    if (!victim) break
    try {
      localStorage.removeItem(victim.key)
      total -= victim.size
    } catch {
      break
    }
  }
}

/**
 * 写入 storageKey；若配额不足，按「最旧优先」逐个淘汰可重建缓存并立即重试，
 * 直到写入成功或已无可淘汰项。
 *
 * 与 enforceEvictableBudget 的分工：这个是「按需抢救」—— 即使可淘汰缓存尚未超出
 * 自身预算，只要整源配额被其它数据占满也会动手，从而把这次写入救回来。
 * 同样只碰可重建缓存，绝不动用户数据；任何异常都吞掉。
 */
function writeWithEviction(storageKey: string, payload: string): boolean {
  try {
    localStorage.setItem(storageKey, payload)
    return true
  } catch { /* 配额不足，进入淘汰重试 */ }

  let rows: EvictableRow[] = []
  try {
    rows = collectEvictable()
      .filter(row => row.key !== storageKey)
      .sort((a, b) => (a.timestamp - b.timestamp) || (a.index - b.index))
  } catch {
    return false
  }

  for (const row of rows) {
    try {
      localStorage.removeItem(row.key)
    } catch {
      return false
    }
    try {
      localStorage.setItem(storageKey, payload)
      return true
    } catch { /* 还不够，继续淘汰下一条 */ }
  }
  return false
}

export const Cache = {
  save<T>(key: string, data: T) {
    const payload = JSON.stringify({
      data, timestamp: Date.now(), version: 1,
    } as CacheEntry<T>)
    const storageKey = PREFIX + key

    // 先直接写（正常路径零额外开销）；配额不足才逐个淘汰可重建缓存重试。
    if (!writeWithEviction(storageKey, payload)) return // 写不进就静默放弃，绝不影响主流程

    // 写入成功后，若是会膨胀的画廊列表缓存，顺手把总量压回预算内，
    // 保证 ComfyUI 的草稿区始终有空间（否则会静默挤掉它）。
    if (isEvictable(storageKey)) enforceEvictableBudget(0, storageKey)
  },

  load<T>(key: string, ttl: number): T | null {
    try {
      const raw = localStorage.getItem(PREFIX + key)
      if (!raw) return null
      const entry: CacheEntry<T> = JSON.parse(raw)
      if (Date.now() - entry.timestamp > ttl) {
        localStorage.removeItem(PREFIX + key)
        return null
      }
      return entry.data
    } catch { return null }
  },

  remove(key: string) {
    localStorage.removeItem(PREFIX + key)
  },

  clearAll() {
    Object.keys(localStorage).filter(k => k.startsWith('anima_')).forEach(k => localStorage.removeItem(k))
  },
}
