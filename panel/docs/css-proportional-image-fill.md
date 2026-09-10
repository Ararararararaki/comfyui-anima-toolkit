# 图片「等比填充」的权威依据与实现要点（2026-09-10 整理）

> 用于本项目 Outputs B 布局（行内等高 / 宽度随比例伸缩）中「图片区盒子到底该由谁决定高度」的
> 判断依据。全部引用 MDN（官方文档）与一个被广泛使用的实现（react-photo-album）。

## 1. `aspect-ratio` 什么时候有效（决定性规则）

MDN · aspect-ratio：
<https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/aspect-ratio>

> "At least one of the box's sizes needs to be automatic in order for `aspect-ratio` to have any
> effect. If neither the width nor height is an automatic size, then the provided aspect ratio has
> no effect on the box's preferred sizes."

中文：**盒子的宽高至少要有一个是「自动尺寸」，`aspect-ratio` 才会生效；宽和高都被显式定死时，
它会被完全忽略。**

MDN · Understanding and setting aspect ratios：
<https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Box_sizing/Aspect_ratios>

> "For `aspect-ratio` to apply to replaced elements, only one dimension must be set.
> Setting both or neither doesn't work."
> "Only when you provide sizes for both dimensions is there a risk of distorting the replaced
> element."

⇒ **本项目的病根**：图片区 `.outputs-card-img` 同时拿到「宽 = 卡片 100%」和「高 = JS 内联的
`height: imgH`」，两个方向都是确定尺寸 → `aspect-ratio` 与 `<img>` 的固有比例双双失效 →
盒子的形状只由父级（行高）决定 → 图片只能被 `object-fit` 裁切。

## 2. `<img>` 的固有比例什么时候会被丢掉

MDN · Images, media, and form elements：
<https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics/Images_media_forms>

> "We could set the container to have a fixed `width` and `height`, and then give the image a
> `width` and `height` of 100%... However, the image is distorted as its aspect ratio has been
> changed — it looks stretched. To fix this, you can use the `object-fit` property."
> "`cover`: The image completely fills the `<img>` element while maintaining its aspect ratio,
> therefore some parts of the image are not displayed."
> "`contain`: The image completely fits inside the `<img>` element while maintaining its aspect
> ratio, therefore some parts of the `<img>` element are not filled."
> "If the `<img>` element is not resized, the image will be shown at its original (intrinsic) size
> and aspect ratio, therefore `object-fit` will have no effect."

⇒ 给 `<img>` 同时定死宽高后，**比例信息只能靠 `object-fit` 表达**：`cover` = 裁切，`contain` = 留白。
两者都是「比例正确但盒子没填满/内容被丢掉」，只有**盒子比例 == 原图比例**时二者等价（恒等缩放）。

## 3. 让「盒子比例 = 原图比例」的标准做法

`height: auto`（把高度交还给自动尺寸） + 比例来源（唯一的真源）：

```css
/* 盒子：一轴确定（宽度来自网格），另一轴自动 → aspect-ratio 生效 */
.card-img { height: auto; aspect-ratio: var(--card-ar, auto); }
/* 图片：内容盒已确定，contain/cover 在比例一致时等价 */
.card-img img { width: 100%; height: 100%; object-fit: contain; }
```

- `--card-ar` 有值 → 高度 = 宽度 ÷ 比例，**由浏览器算**，JS 不必也不该再内联高度。
- `--card-ar` 缺失/`auto` → 换成 `<img>` 的固有比例（MDN：`auto` 对「有固有比例的可替换元素」生效），
  即旧数据也能零裁切降级，而不是静默变成正方形。

## 4. 业界成熟实现的同一套约定

react-photo-album（Rows/justified 布局，被广泛使用）：
<https://react-photo-album.com/documentation>

- `RowsPhotoAlbum` = 行式（justified）布局，核心参数 `targetRowHeight`（目标行高），
  另有 `rowConstraints: { minPhotos, maxPhotos, singleRowMaxHeight }`。
- 布局回调把**每张图渲染后的 `width` / `height`（像素）**交给渲染层，渲染层据此设盒并配
  `object-fit`（其 `rows.css` 用 cover/min-height 组合）。即：**几何由布局算，渲染层只负责在
  给定盒子里等比填充**，与我们现在的做法一致；差别只在于它强制「同一个 Photo 的 srcSet 必须同一比例」。
- 关键约束（同页 "Photo" 一节）：`All images in a given Photo object must be of the same aspect ratio.`
  —— 即所有几何计算都假设我们**知道每张图的真实比例**（本项目来自扫描得到的 `width`/`height`）。

## 5. 本项目的落点（对照结论）

| 项 | 结论 |
|---|---|
| 盒子比例真源 | 布局层 `computeMasonryLayout` 的 `boxAspects[]`（宽/高，极端比例已被上下限截断） |
| 传给 CSS | `.outputs-card-img` 的 `--card-ar`（内联变量，不再是高度） |
| CSS | `height: auto` + `aspect-ratio: var(--card-ar, auto)`；masonry 模式 `object-fit: contain` |
| `object-fit` 何时改变观感 | 仅当 `--card-ar` 缺失或该卡比例被截断（越界）；正常比例下是恒等变换 |
| 边框 | 必须**不占布局空间**（用 inset 阴影）：`box-sizing:border-box` 下 border 会从内容宽扣 2px，让盒子高度与布局预算差 2px |
| 行高是否该统一 | 行式布局（justified rows）的定义就是「同一行高度统一、宽度随比例伸缩」，统一本身不等于失真；失真只会来自「盒子比例 ≠ 原图比例」 |
