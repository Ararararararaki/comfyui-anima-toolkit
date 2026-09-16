// ── 后端「自驱预备」状态（插件新契约 /anima/gallery/status）──
//
// 后端从「浏览器问了才扫盘」改成「后台低频轮询 + 增量索引 + 缩略图预热」之后，前端只需要一个
// **极轻**的判据回答两个问题：
//   ① 索引换代了吗（要不要重拉 manifest）？—— 看 index.builtAt / index.total；
//   ② 后端是不是正在预备？—— 看 index.building / warmup.pending；此刻拉 manifest 只会拿到
//      旧索引，UI 应该给一句人话提示，而不是让用户对着空网格。
// 该端点纯内存、不扫盘，代价远低于 /anima/gallery/fresh（后者要遍历输出目录并逐个 stat）。
//
// ⚠️ 可选契约：老后端没有这个路由（404）。必须**失败降级**——一旦判定不可用就永久静默
//    退回 /anima/gallery/fresh 的老判据，绝不每轮轮询都吃一个 404。

/** 上一轮预热的结果摘要（后端 lastResult 的形态并未写进契约，这里只取需要的两个字段）。 */
export interface GalleryWarmupResult {
  /** 该轮结束时索引对象的 builtAt —— 增量真写了盘就是新值，没变化就是旧值（0 = 该轮没给）。 */
  builtAt: number
  /** 该轮是否被跳过（签名没变 / 目录为空等，没动索引）。 */
  skipped: boolean
}

export interface GalleryWarmupInfo {
  /** 后端是否装了预热器（老后端/未启用时为 false）。 */
  installed: boolean
  /** 预热循环是否在跑。 */
  running: boolean
  /** 轮询间隔（秒）。 */
  intervalSec: number
  /** 上一次预热开始时刻（秒，后端 time.time()；只用来判断"有没有新的一轮"）。 */
  lastRunAt: number
  /** 上一次预热耗时（毫秒）。 */
  lastDurationMs: number
  /** 上一次预热报错（正常为 null）。 */
  lastError: string | null
  /** 累计预热轮次。 */
  runs: number
  /** 是否有一轮预热正在排队/进行（此刻索引尚未定稿）。 */
  pending: boolean
  /** 上一轮预热结果摘要。 */
  lastResult: GalleryWarmupResult | null
}

export interface GalleryIndexInfo {
  /** 索引里的文件条数。 */
  total: number
  /** 索引构建时刻（前端用它判断"换代了没有"）。 */
  builtAt: number
  /** 是否正在重建。 */
  building: boolean
  /** 重建进度（后端自定义刻度，仅用于展示，前端不做换算假设）。 */
  progress: number
  /** 索引是否已载入内存。 */
  loaded: boolean
}

export interface GalleryStatus {
  warmup: GalleryWarmupInfo | null
  index: GalleryIndexInfo | null
  outputRoot: string
  version: string
}

let _state: 'unknown' | 'ready' | 'no' = 'unknown'
let _inflight: Promise<GalleryStatus | null> | null = null

/** 端点是否确认可用（一旦判定为老后端就永久 false）。 */
export function galleryStatusAvailable(): boolean {
  return _state === 'ready'
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function bool(v: unknown): boolean {
  return v === true
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 探测后端预备状态。端点不可用（老后端 404 / 网络异常）时返回 null，调用方静默降级。
 * 并发去重：同一时刻只发一条请求，重复调用共享同一次结果。
 */
export async function probeGalleryStatus(): Promise<GalleryStatus | null> {
  if (_state === 'no') return null
  if (_inflight) return _inflight
  const p = (async (): Promise<GalleryStatus | null> => {
    try {
      const resp = await fetch('/anima/gallery/status', { cache: 'no-store' })
      if (!resp.ok) {
        // 404/405 = 老后端没有该路由：判定不可用，之后直接走 /fresh 老判据
        if (resp.status === 404 || resp.status === 405) _state = 'no'
        return null
      }
      const data = asObject(await resp.json())
      if (!data) { _state = 'no'; return null }
      _state = 'ready'
      const warmup = asObject(data.warmup)
      const index = asObject(data.index)
      const lastResult = warmup ? asObject(warmup.lastResult) : null
      return {
        warmup: warmup ? {
          installed: bool(warmup.installed),
          running: bool(warmup.running),
          intervalSec: num(warmup.intervalSec),
          lastRunAt: num(warmup.lastRunAt),
          lastDurationMs: num(warmup.lastDurationMs),
          lastError: typeof warmup.lastError === 'string' ? warmup.lastError : null,
          runs: num(warmup.runs),
          pending: bool(warmup.pending),
          lastResult: lastResult ? {
            builtAt: num(lastResult.builtAt),
            skipped: bool(lastResult.skipped),
          } : null,
        } : null,
        index: index ? {
          total: num(index.total),
          builtAt: num(index.builtAt),
          building: bool(index.building),
          progress: num(index.progress),
          loaded: bool(index.loaded),
        } : null,
        outputRoot: str(data.outputRoot),
        version: str(data.version),
      }
    } catch {
      // 网络异常（后端此刻不可达）不等于"老后端"：不判死，下一轮再试
      return null
    }
  })()
  _inflight = p
  try {
    return await p
  } finally {
    if (_inflight === p) _inflight = null
  }
}

/**
 * 后端是否正在预备/重建索引。真 ⇒ 本轮别拉 manifest（拿到的是旧索引），UI 该提示「预备中」。
 * `!loaded && running` 也算：索引还没进内存，此刻拉 manifest 一定是空的。
 */
export function galleryStatusBusy(s: GalleryStatus | null): boolean {
  if (!s) return false
  return !!(s.index?.building || s.warmup?.pending || (s.index && !s.index.loaded && s.warmup?.running))
}
