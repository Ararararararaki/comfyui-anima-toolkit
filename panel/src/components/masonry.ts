// ── 瀑布流布局（列填充 + 超宽图跨列） ──
// 每张卡片按图片真实宽高比定高，依次放入当前最短列（Pinterest 式），
// 卡片宽度 = 列宽，高度 = 图片区（随比例）+ 信息区 + 边框。
// 超宽全景（宽高比 ≥ 2.2）跨 2 列、极宽（≥ 4）跨 3 列：盒子比例贴合原图，
// 既避免被 MIN_IMG_H 压成细条强裁，也让这类图获得应有的展示面积。
//
// 信息区高度唯一真源 = CSS 变量 --outputs-info-h（.outputs-card-info 使用同一变量），
// 布局每次计算时读取，杜绝「改了 CSS 忘了改 TS」导致的整列错位。

import type { OutputFile } from '../types/outputs'

/** 信息区高度兜底值：CSS 变量 --outputs-info-h 缺失时使用（与 outputs.css 默认值一致） */
export const OUTPUTS_INFO_H = 82
/** 卡片上下边框 2px×2（box-sizing: border-box 下内容区少 4px） */
export const MASONRY_CARD_BORDER = 4
/** 全景图等极端比例时图片区下限（保证信息区可见、卡片不过于扁平） */
export const MIN_IMG_H = 90
/** 图片区上限 = 卡宽 × 4，防超高竖图占满整屏 */
export const MAX_IMG_RATIO = 4
/** 宽高比（h/w）≤ 此值 → 跨 2 列（即宽 ≥ 2.2 倍高） */
export const SPAN2_MAX_ASPECT = 0.45
/** 宽高比（h/w）≤ 此值 → 跨 3 列（即宽 ≥ 4 倍高） */
export const SPAN3_MAX_ASPECT = 0.25
/** 无宽高数据（旧扫描记录）时按正方形兜底，与旧平铺观感一致 */
const FALLBACK_ASPECT = 1

export interface MasonryLayout {
  /** 每张卡 top（内容坐标，相对虚拟滚动 inner） */
  tops: number[]
  /** 每张卡 left（内容坐标） */
  lefts: number[]
  /** 每张卡所在列（跨列时为起始列） */
  colsOf: number[]
  /** 每张卡宽度（跨列时含列间距） */
  widths: number[]
  /** 每张卡完整高度（不含列间距） */
  heights: number[]
  /** 每张卡图片区高度（heights - 信息区 - 边框） */
  imgHeights: number[]
  /** 图片区是否被 MAX_IMG_RATIO 截断（渲染层用 object-fit: contain 保内容） */
  clamped: boolean[]
  /** 内容总高度 */
  total: number
}

/** 运行时读取信息区高度：CSS 变量为唯一真源，读不到时用兜底常量 */
export function readInfoHeight(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--outputs-info-h')
    const v = Number.parseFloat(raw)
    if (Number.isFinite(v) && v > 0) return v
  } catch { /* 非浏览器环境（脚本/测试）走兜底 */ }
  return OUTPUTS_INFO_H
}

function aspectOf(file: OutputFile): number {
  return file.width > 0 && file.height > 0 ? file.height / file.width : FALLBACK_ASPECT
}

/** 图片区高度：随比例伸缩，夹在 [MIN_IMG_H, 卡宽 × MAX_IMG_RATIO] */
function imgHeightFor(aspect: number, boxW: number): number {
  return Math.round(Math.min(Math.max(boxW * aspect, MIN_IMG_H), boxW * MAX_IMG_RATIO))
}

/** 单张卡高度（含信息区与边框） */
export function masonryCardHeight(file: OutputFile, cardW: number, infoH: number = readInfoHeight()): number {
  return imgHeightFor(aspectOf(file), cardW) + infoH + MASONRY_CARD_BORDER
}

/** 该比例需要跨几列（受总列数限制） */
export function spanFor(aspect: number, cols: number): number {
  if (cols < 2) return 1
  if (aspect <= SPAN3_MAX_ASPECT && cols >= 3) return 3
  if (aspect <= SPAN2_MAX_ASPECT) return 2
  return 1
}

// 布局缓存：同一 files 引用 + 几何/信息区高度不变时直接复用。
// 拖拽框选逐帧调用本函数，避免每帧 O(N·cols) 重算。
let _cacheFiles: OutputFile[] | null = null
let _cacheCols = 0
let _cacheCardW = 0
let _cacheGap = 0
let _cacheInfoH = 0
let _cache: MasonryLayout | null = null

export function computeMasonryLayout(files: OutputFile[], cols: number, cardW: number, gap: number): MasonryLayout {
  const infoH = readInfoHeight()
  if (
    _cacheFiles === files && _cacheCols === cols && _cacheCardW === cardW &&
    _cacheGap === gap && _cacheInfoH === infoH && _cache
  ) {
    return _cache
  }
  const n = files.length
  const tops = new Array<number>(n)
  const lefts = new Array<number>(n)
  const colsOf = new Array<number>(n)
  const widths = new Array<number>(n)
  const heights = new Array<number>(n)
  const imgHeights = new Array<number>(n)
  const clamped = new Array<boolean>(n)
  const colHeights = new Array<number>(cols).fill(0)
  const colStep = cardW + gap

  for (let i = 0; i < n; i++) {
    const aspect = aspectOf(files[i])
    const span = spanFor(aspect, cols)
    const boxW = cardW * span + gap * (span - 1)
    const imgH = imgHeightFor(aspect, boxW)
    const h = imgH + infoH + MASONRY_CARD_BORDER

    // 选「放下去之后这组列的顶部最靠上」的起始列；跨列时整组列高度对齐到同一 top，
    // 后续单列卡不会插进跨列卡的缝隙，避免重叠。
    let start = 0
    let top = Infinity
    for (let c = 0; c + span <= cols; c++) {
      let maxH = 0
      for (let k = c; k < c + span; k++) if (colHeights[k] > maxH) maxH = colHeights[k]
      if (maxH < top) { top = maxH; start = c }
    }
    const drop = top + h + gap
    for (let k = start; k < start + span; k++) colHeights[k] = drop

    colsOf[i] = start
    tops[i] = top
    lefts[i] = start * colStep
    widths[i] = boxW
    heights[i] = h
    imgHeights[i] = imgH
    clamped[i] = aspect > MAX_IMG_RATIO
  }

  let total = 0
  for (const ch of colHeights) total = Math.max(total, ch)
  total = Math.max(0, total - gap)

  _cacheFiles = files
  _cacheCols = cols
  _cacheCardW = cardW
  _cacheGap = gap
  _cacheInfoH = infoH
  _cache = { tops, lefts, colsOf, widths, heights, imgHeights, clamped, total }
  return _cache
}
