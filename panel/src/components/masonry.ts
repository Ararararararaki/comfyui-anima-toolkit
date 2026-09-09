// ── 瀑布流布局（列填充） ──
// 每张卡片按图片真实宽高比定高，依次放入当前最短列（Pinterest 式），
// 卡片宽度 = 列宽，高度 = 图片区（随比例）+ 信息区 + 边框。
// 与 CSS `.outputs-card-info` 的高度（92px）必须保持同步。

import type { OutputFile } from '../types/outputs'

/** 卡片信息区固定高度（actions 已图标化单行），与 CSS `.outputs-card-info` 同步 */
export const OUTPUTS_INFO_H = 92
/** 卡片上下边框 2px×2（box-sizing: border-box 下内容区少 4px） */
export const MASONRY_CARD_BORDER = 4
/** 全景图等极端比例时图片区下限（保证信息区可见、卡片不过于扁平） */
const MIN_IMG_H = 90
/** 图片区上限 = 卡宽 × 4，防超高竖图占满整屏 */
const MAX_IMG_RATIO = 4
/** 无宽高数据（旧扫描记录）时按正方形兜底，与旧平铺观感一致 */
const FALLBACK_ASPECT = 1

export interface MasonryLayout {
  /** 每张卡 top（内容坐标，相对虚拟滚动 inner） */
  tops: number[]
  /** 每张卡所在列 */
  colsOf: number[]
  /** 每张卡完整高度（不含列间距） */
  heights: number[]
  /** 内容总高度 */
  total: number
}

/** 单张卡高度（含信息区与边框） */
export function masonryCardHeight(file: OutputFile, cardW: number): number {
  const aspect = file.width > 0 && file.height > 0
    ? file.height / file.width
    : FALLBACK_ASPECT
  const imgH = Math.round(Math.min(Math.max(cardW * aspect, MIN_IMG_H), cardW * MAX_IMG_RATIO))
  return imgH + OUTPUTS_INFO_H + MASONRY_CARD_BORDER
}

// 布局缓存：同一 files 引用 + 几何不变时直接复用。
// 拖拽框选逐帧调用本函数，避免每帧 O(N·cols) 重算。
let _cacheFiles: OutputFile[] | null = null
let _cacheCols = 0
let _cacheCardW = 0
let _cacheGap = 0
let _cache: MasonryLayout | null = null

export function computeMasonryLayout(files: OutputFile[], cols: number, cardW: number, gap: number): MasonryLayout {
  if (_cacheFiles === files && _cacheCols === cols && _cacheCardW === cardW && _cacheGap === gap && _cache) {
    return _cache
  }
  const n = files.length
  const tops = new Array<number>(n)
  const colsOf = new Array<number>(n)
  const heights = new Array<number>(n)
  const colHeights = new Array<number>(cols).fill(0)

  for (let i = 0; i < n; i++) {
    let col = 0
    for (let c = 1; c < cols; c++) {
      if (colHeights[c] < colHeights[col]) col = c
    }
    colsOf[i] = col
    tops[i] = colHeights[col]
    const h = masonryCardHeight(files[i], cardW)
    heights[i] = h
    colHeights[col] += h + gap
  }

  let total = 0
  for (const ch of colHeights) total = Math.max(total, ch)
  total = Math.max(0, total - gap)

  _cacheFiles = files
  _cacheCols = cols
  _cacheCardW = cardW
  _cacheGap = gap
  _cache = { tops, colsOf, heights, total }
  return _cache
}