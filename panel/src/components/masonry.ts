// ── 列填充瀑布流（Pinterest 式 + 超宽跨列）──
//
// 每张卡**宽度和高度都随图片比例变化**：
//   · 常规图：宽度 = 单列列宽，高度 = 列宽 ÷ 盒比（竖图更高、横图更矮）；
//   · 超宽全景：跨 2 列（宽高比 ≥ 2.2:1）/ 3 列（≥ 4:1），盒子更宽、同时更矮。
// 因此同一行里不同卡的 top / left / 宽 / 高都不一样：逐张放入**当前最矮的列**
// （列填充）；跨列时整组列对齐到同一 top，避免后续单列卡插进跨列卡的缝隙造成重叠。
//
// 图片区高度由 CSS 从 `--card-ar`（= 本布局的 boxAspects）算出：高度 = 宽度 ÷ 盒比，
// 盒子比例因此严格等于布局所用比例 —— 常规比例零裁切零留白（contain 与 cover 等价），
// 只有超高图被比例上限截断，改用 contain 完整嵌入（见 CLAMP_MAX_ASPECT）。
//
// 信息区高度唯一真源 = CSS 变量 --outputs-info-h（.outputs-card-info 使用同一变量），
// 布局每次计算时读取，杜绝「改了 CSS 忘了改 TS」导致的错位。

import type { OutputFile } from '../types/outputs'

/** 信息区高度兜底值：CSS 变量 --outputs-info-h 缺失时使用（与 outputs.css 默认值一致） */
export const OUTPUTS_INFO_H = 82
/**
 * 卡片在图片区 + 信息区之外额外占用的垂直高度。
 * 卡片边框已改为 inset 阴影（outputs.css：`.outputs-card.masonry { border: 0 }`），
 * **不占布局空间**，因此这里是 0 —— 卡高 = 图片区 + 信息区，与 DOM 实测一致。
 */
export const MASONRY_CARD_BORDER = 0
/**
 * 宽高比（h/w）上限 = 盒子比例下限：超过即视为超高图，盒子比例按上限截断，
 * 渲染层加 .tall-clamped 用 object-fit:contain 完整嵌入。
 * 不设下限（超宽图保持真实比例、不做任何留白/裁切），宽度不足由「跨列」解决。
 */
export const CLAMP_MAX_ASPECT = 2.2
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
  /** 每张卡起始列（跨列时为起始列） */
  colsOf: number[]
  /** 每张卡宽度（跨列时含列间距） */
  widths: number[]
  /** 每张卡完整高度（= 图片区 + 信息区 + 边框） */
  heights: number[]
  /** 每张卡图片区高度（= 卡宽 ÷ 盒比） */
  imgHeights: number[]
  /** 盒子比例是否被上限截断（渲染层用 object-fit: contain 保内容） */
  clamped: boolean[]
  /**
   * 每张卡**盒子实际使用的宽高比**（= 宽/高，超高图已按 CLAMP_MAX_ASPECT 截断）。
   * 渲染层把它写进 `--card-ar`，CSS 用「高 = 宽 ÷ 盒比」反算高度 ——
   * 与布局的 imgHeights 同源，盒子高度才会严格等于虚拟滚动的二维几何。
   */
  boxAspects: number[]
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

/** 盒子比例（宽/高）：超高图按 CLAMP_MAX_ASPECT 截断，其余保持原图真实比例（零裁切） */
function boxRatioFor(aspect: number): number {
  return 1 / Math.min(Math.max(aspect, 1e-6), CLAMP_MAX_ASPECT)
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
  const boxAspects = new Array<number>(n)
  const colHeights = new Array<number>(cols).fill(0)
  const colStep = cardW + gap

  for (let i = 0; i < n; i++) {
    const aspect = aspectOf(files[i])
    const span = spanFor(aspect, cols)
    const boxW = cardW * span + gap * (span - 1)
    const ratio = boxRatioFor(aspect)
    // 高度 = 宽度 ÷ 盒比：**不取整**，与 CSS 由 aspect-ratio 反算的高度保持同源
    const imgH = boxW / ratio
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
    clamped[i] = aspect > CLAMP_MAX_ASPECT
    boxAspects[i] = ratio
  }

  let total = 0
  for (const ch of colHeights) total = Math.max(total, ch)
  total = Math.max(0, total - gap)

  _cacheFiles = files
  _cacheCols = cols
  _cacheCardW = cardW
  _cacheGap = gap
  _cacheInfoH = infoH
  _cache = { tops, lefts, colsOf, widths, heights, imgHeights, clamped, boxAspects, total }
  return _cache
}
