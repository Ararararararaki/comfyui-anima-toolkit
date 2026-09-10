// ── 全库元数据索引：**按需**补齐（取代「进入页面即全库预载」）──
//
// 背景（2026-09-10）：
//   元数据记录每条都带 workflowJson（几十~几百 KB）。此前 Outputs 进入页面就按空闲分片把
//   全部 ~3900 条读一遍（随后还有第二次全库遍历提取 LoRA），bulkGet 的结构化克隆在主线程上
//   是数百 MB 的搬运 → 用户实测「进页面要等两三分钟」。分片只是摊开，总量没减少。
//
// 现在的原则：
//   · 单张卡的信息 → `store.loadMetadata(id)`（可见区/单图操作按需，见 Outputs.ts）
//   · **全局视野**（基座模型/LoRA/标签筛选、本地 LoRA 关联出图统计）→ 由用户真正用到时
//     调用本模块补齐一次，带进度回调；补完即长期复用（内存缓存），不会每次重跑。
//
// 之所以必须有这条「全局」路径：`applyFilters` 对 model/lora/tag 三项会**排除元数据未加载**
// 的条目 —— 若不补齐，懒加载会让这三项筛选静默漏结果（不是变慢，是结果错）。

import { outputsDb } from '../db/outputsDb'
import { useOutputStore } from '../store/outputStore'
import type { OutputMetadata } from '../types/outputs'

/** 每片处理多少条：片太大仍是长任务，片太小则调度开销占比高 */
const SLICE = 200

export interface MetadataIndexProgress {
  running: boolean
  done: number
  total: number
}

let _running = false
let _token = 0
const _listeners = new Set<(p: MetadataIndexProgress) => void>()

function emit(running: boolean, done: number, total: number): void {
  for (const fn of _listeners) {
    try { fn({ running, done, total }) } catch { /* 单个订阅者异常不影响其它 */ }
  }
}

/** 还有多少文件缺元数据（O(N) 轻量检查，不读 DB） */
export function countMetadataMissing(): number {
  const s = useOutputStore.getState()
  let n = 0
  for (const f of s.files) if (!s.metadataCache.has(f.id)) n++
  return n
}

/**
 * 本次会话是否已无缺失（每次都用 O(N) 的轻量检查实时判断，
 * 不做「一次跑完就永久为真」的标记 —— 重新扫描/新增文件后它会自动变回 false）。
 */
export function isMetadataIndexComplete(): boolean {
  return countMetadataMissing() === 0
}

/**
 * 按需补齐**全库**元数据。幂等：正在跑 / 无缺失时立即返回。
 * 分片执行并在片间让出主线程，整个过程不阻塞交互。
 */
export function ensureAllMetadata(): Promise<void> {
  if (_running) return Promise.resolve()
  if (countMetadataMissing() === 0) return Promise.resolve()

  const token = ++_token
  _running = true
  return new Promise<void>((resolve) => {
    const schedule = (fn: () => void) => {
      const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
      if (typeof idle === 'function') idle(fn, { timeout: 2000 })
      else setTimeout(fn, 60)
    }

    const step = () => {
      if (token !== _token) { _running = false; resolve(); return }
      const s = useOutputStore.getState()
      const cache = s.metadataCache
      const total = s.files.length
      if (total === 0) { _running = false; resolve(); return }

      const missing: string[] = []
      for (const f of s.files) {
        if (!cache.has(f.id)) missing.push(f.id)
        if (missing.length >= SLICE) break
      }
      if (missing.length === 0) {
        _running = false
        emit(false, total, total)
        resolve()
        return
      }
      emit(true, total - countMetadataMissing(), total)
      void outputsDb.metadata.bulkGet(missing)
        .then(rows => {
          const valid = rows.filter((m): m is OutputMetadata => !!m)
          if (valid.length > 0) useOutputStore.getState().putMetadataBatch(valid)
        })
        .catch(() => { /* 单片失败：下一片继续，不整体失败 */ })
        .then(() => schedule(step))
    }
    schedule(step)
  })
}

