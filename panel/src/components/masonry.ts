// ── B 布局：行内等高 + 宽度随比例伸缩（justified rows） ──
//
// 与上一版「列填充瀑布流」的区别：同一行里所有卡片的**图片区高度完全相同**，
// 整行按容器可用宽度做一次等比归一，使这一行恰好铺满 —— 左右边缘对齐、行与行之间
// 是整齐的横向条带，卡片宽度则随各自图片的宽高比伸缩。
//
// 算法（Google Photos / Flickr 式 justified layout）：
//   1. 以「单列卡宽」为目标行高 targetH，逐张累加 `宽/高` 比估算本行宽度；
//   2. 加下一张会超出容器时**先试算收行后的行高**：落在合理区间就收行；
//      若收行会让行高超过上限（说明本行太稀疏、收行会留下大片空白），则继续吃进
//      这一张——用更多卡片把行高压回区间，这是「不出现两张大图撑满一行」的关键。
//   3. 收行后按 `可用宽度 / Σ(宽/高)` 求出真实行高，行内等比缩放后恰好铺满；
//   4. 末行（数据不足一行）不强行拉宽，保持 targetH 的自然比例，避免最后一张被吹大。
//
// 比例截断（PACK_MIN/MAX_ASPECT）：真实出图的宽高比几乎都落在 21:9 ~ 9:16 之间，
// 该区间内**不做任何裁切**；只有极端比例（如 1:5 竖长、8:1 全景）才按上下限参与
// 装箱，否则会算出几十像素宽的卡片、或者一小段行高把整行压成细条。
// 被截断的卡片由渲染层加 .tall-clamped / .wide-clamped，用 object-fit:contain
// 显示完整画面（容器底色近黑，留白观感自然）。
//
// 信息区高度唯一真源 = CSS 变量 --outputs-info-h（.outputs-card-info 使用同一变量），
// 布局每次计算时读取，杜绝「改了 CSS 忘了改 TS」导致的整行错位。

import type { OutputFile } from '../types/outputs'

/** 信息区高度兜底值：CSS 变量 --outputs-info-h 缺失时使用（与 outputs.css 默认值一致） */
export const OUTPUTS_INFO_H = 82
/** 卡片上下边框 2px×2（box-sizing: border-box 下内容区少 4px） */
export const MASONRY_CARD_BORDER = 4
/** 单行行高下限（软下限，见 computeMasonryLayout 内注释）：防止极端比例把整行压成细条 */
export const MIN_ROW_H = 90
/** 单行行高上限 = 目标行高 × 此系数：防止稀疏行把图片吹得过大 */
export const MAX_ROW_H_FACTOR = 1.8
/** 宽高比（h/w）超过此值视为超高图 → 渲染层加 .tall-clamped 改用 contain */
export const CLAMP_MAX_ASPECT = 2.2
/** 宽高比（h/w）低于此值视为超宽全景 → 渲染层加 .wide-clamped 改用 contain */
export const CLAMP_MIN_ASPECT = 1 / 3
/** 参与装箱的宽高比区间（超出即按边界值参与计算） */
const PACK_MIN_ASPECT = CLAMP_MIN_ASPECT
const PACK_MAX_ASPECT = CLAMP_MAX_ASPECT
/** 无宽高数据（旧扫描记录）时按正方形兜底，与旧平铺观感一致 */
const FALLBACK_ASPECT = 1
/** 浮点比较容差（px） */
const EPS = 0.5

export interface MasonryLayout {
  /** 每张卡 top（内容坐标，相对虚拟滚动 inner） */
  tops: number[]
  /** 每张卡 left（内容坐标，同一行内依次累加） */
  lefts: number[]
  /** 每张卡起始列（B 布局下行内位置由 lefts 表达，此处恒 0，保留以兼容旧调用） */
  colsOf: number[]
  /** 每张卡宽度（行内按比例分配，整行铺满容器） */
  widths: number[]
  /** 每张卡完整高度（= 行内图片区高度 + 信息区 + 边框，同一行内相等） */
  heights: number[]
  /** 每张卡图片区高度（同一行内相等） */
  imgHeights: number[]
  /** 图片区是否被比例上下限截断（渲染层用 object-fit: contain 保内容） */
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

/** 装箱用的「宽/高」比：极端比例按上下限截断（见文件头说明） */
function packRatio(aspect: number): number {
  const a = Math.min(Math.max(aspect, PACK_MIN_ASPECT), PACK_MAX_ASPECT)
  return 1 / a
}

// 布局缓存：同一 files 引用 + 几何/信息区高度不变时直接复用。
// 拖拽框选逐帧调用本函数，避免每帧 O(N) 重算。
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
  const colsOf = new Array<number>(n).fill(0)
  const widths = new Array<number>(n)
  const heights = new Array<number>(n)
  const imgHeights = new Array<number>(n)
  const clamped = new Array<boolean>(n)

  // 容器可用宽度 = 旧网格几何推回（cols 列 + 列间距），与实际渲染宽度一致
  const width = cols * cardW + (cols - 1) * gap
  // 目标行高 = 单列卡宽：全正方形图时行高与列宽一致，观感与等宽网格对齐
  const targetH = Math.max(MIN_ROW_H, cardW)
  const maxRowH = targetH * MAX_ROW_H_FACTOR

  let y = 0
  let i = 0
  while (i < n) {
    const rowStart = i
    let sumRatio = 0
    let count = 0
    let full = false

    // ① 贪心装箱
    while (i < n) {
      const r = packRatio(aspectOf(files[i]))
      if (count > 0) {
        const projected = (sumRatio + r) * targetH + gap * count
        if (projected > width + EPS) {
          // 收行后行高 = 可用宽 / Σ(宽/高)。只有落在合理区间才收行；
          // 若会超过上限（本行太稀疏），继续吃进这一张，让行高下降。
          const rowHIfClose = (width - gap * (count - 1)) / sumRatio
          if (rowHIfClose <= maxRowH) { full = true; break }
        }
      }
      sumRatio += r
      count++
      i++
    }

    // ② 行高归一：收行（铺满）的整行等比缩放；末行（数据不足一行）不强行拉宽
    const avail = width - gap * (count - 1)
    let rowH = full ? avail / sumRatio : Math.min(targetH, avail / sumRatio)
    rowH = Math.min(rowH, maxRowH)
    if (rowH < MIN_ROW_H) {
      // 软下限：只有抬高后仍不撑破容器才生效，否则会把整行挤出右边界
      const floored = Math.min(MIN_ROW_H, maxRowH)
      if (sumRatio * floored + gap * (count - 1) <= width + EPS) rowH = floored
    }

    // 图片区高度取整后**整行共用**：这是「行内等高」的落点
    const imgH = Math.round(rowH)
    const cardH = imgH + infoH + MASONRY_CARD_BORDER

    // ③ 行内按比例分配宽度（浮点累计，Σwidth + gap 恰好等于容器宽度）
    let left = 0
    for (let k = rowStart; k < rowStart + count; k++) {
      const aspect = aspectOf(files[k])
      const w = packRatio(aspect) * rowH
      tops[k] = y
      lefts[k] = left
      widths[k] = w
      heights[k] = cardH
      imgHeights[k] = imgH
      clamped[k] = aspect > CLAMP_MAX_ASPECT || aspect < CLAMP_MIN_ASPECT
      left += w + gap
    }

    y += cardH + gap
  }

  const total = n > 0 ? Math.max(0, y - gap) : 0

  _cacheFiles = files
  _cacheCols = cols
  _cacheCardW = cardW
  _cacheGap = gap
  _cacheInfoH = infoH
  _cache = { tops, lefts, colsOf, widths, heights, imgHeights, clamped, total }
  return _cache
}
