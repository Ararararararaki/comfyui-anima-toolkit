"""Static regression checks for TK D gallery image rendering efficiency."""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "js" / "anima_danbooru_gallery_widget.js"
STYLES = ROOT / "web" / "css" / "anima_danbooru_gallery.css"
BACKEND = ROOT / "anima_danbooru_gallery.py"


def test_gallery_uses_column_filling_waterfall_that_fills_the_grid():
    """2026-09-13：瀑布流从「CSS Grid + grid-row-end:span」换成**列填充 + 超宽跨列**的绝对定位。

    旧写法有两个实测问题：① 卡片宽度恒等于列宽（156px），节点越宽只是列数越多、图越小；
    ② 同一行里高矮不一会留下成片空白（实测 48 张卡在 1298×1438 里底部空 106px、行间还有洞）。
    新写法逐张放进当前最矮的列，超宽图横跨 2~3 列，盒子宽高都随图片真实盒比变化。
    """
    js = SOURCE.read_text(encoding="utf-8")
    css = STYLES.read_text(encoding="utf-8")

    # 布局容器：绝对定位的子项 + 由 JS 写入内容总高（min-height 撑出滚动条）
    assert "position: relative; display: block;" in css
    assert ".adg-card { position: absolute;" in css
    # 卡片图片吃掉剩余高度、铺满盒子（contain 会按比例留黑边）
    assert "object-fit: cover" in css
    # 列填充 + 跨列的核心实现
    assert "function dgSpanFor(aspect, cols)" in js
    assert "colHeights" in js
    assert 'card.style.left = ' in js
    assert "this.lastColStep = colStep" in js
    # 自适应张数（0 = 按节点尺寸算该显示几张）；2026-09-16 起第三个参数传入
    # 「上一次实测的平均卡高」，避免按 fallback 比例猜出来的卡高偏大导致首屏就填不满
    assert "function dgComputeAutoCount(grid, metrics, measuredCardH = 0)" in js
    assert "resolveLimit()" in js
    # 铺不满时收掉底部空白
    assert "shrinkGridToContent(total)" in js
    # 懒加载仍按网格自身视口裁剪（不要退回「一次性加载整页」）
    assert "this.imageLoadObserver = new IntersectionObserver" in js
    assert "root: this.grid" in js
    assert "this.setupImageLoading()" in js
    assert "preview.dataset.src" in js
    assert "preview.width = imageWidth" in js
    assert "this.applyMasonryLayout()" in js


def test_gallery_node_size_is_owned_by_user_not_content():
    """2026-09-16 用户要求：「节点大小完全限制于我的设定，不要因为图像而改变，也不要自主变大变小」。

    历史根因（真机实测）：applyMasonryLayout 把**内容总高**写进 .adg-grid 的 min-height
    （grid 661px → 1708px），叠加 CSS 的 `flex: 1 1 auto`（basis:auto ⇒ 按内容长高），
    DOM 面板被顶高，前端布局器随即把节点从 900 撑到 1994 —— 表现为"一直扩充、卡死"。
    """
    js = SOURCE.read_text(encoding="utf-8")
    css = STYLES.read_text(encoding="utf-8")

    # 网格不得按内容长高：min-height 归零 + flex-basis 0 + height 0（内容多了走 overflow-y）
    assert 'this.grid.style.minHeight = "0";' in js, "不得把内容总高写进网格 min-height"
    assert 'this.grid.style.minHeight = `${Math.ceil(total + 8)}px`;' not in js, "内容总高不得再回写 DOM"
    assert "flex: 1 1 0%;" in css and "height: 0;" in css and "overflow-y: auto;" in css

    # 用户尺寸要给布局器钉成固定区间（setBounds），且拖动时立即跟随
    assert "setBounds(nextMin, nextMax = nextMin) {" in js or "setBounds" in js
    assert "uiRef.domSizeSync?.setBounds?.(nowHeight, nowHeight);" in js, "拖动中必须实时跟随，否则拖不动"

    # 自动收缩（"自主变小"）不再被调用；方法保留供回退/测试
    assert "this.shrinkGridToContent(total);" not in js, "不得再自动收缩节点"


def test_span_never_exceeds_columns_and_top_is_finite():
    """2026-09-16 用户实测「图片在抖动，要我手动改变一次节点大小才恢复正常」的真根因。

    `dgSpanFor()` 的 span-2 分支原先**不检查列数**：首次布局时容器宽度可能还没稳定
    （clientWidth=0 → usable=DG_MIN_PT → cols=1），横图返回 span=2 →
    下面「找起点」循环 `for (c = 0; c + 2 <= 1; c++)` 一次都不执行 → `top` 停在 Infinity
    → 卡片被甩出可视区，而且**不会自我恢复**（只有 resize 触发重排才回来）。
    """
    js = SOURCE.read_text(encoding="utf-8")
    css = STYLES.read_text(encoding="utf-8")
    assert "if (aspect <= DG_SPAN2_MAX_ASPECT) return Math.min(2, cols);" in js, (
        "span 必须夹到 cols，否则 cols=1 时横图会算出 span=2"
    )
    assert "if (span > cols) span = 1;" in js, "布局侧要有兜底"
    assert "if (!Number.isFinite(top)) { top = 0; start = 0; }" in js, (
        "绝不把 Infinity 写进 card.style.top（那会让卡片彻底消失且无法自愈）"
    )
    # 跨列基准值不应被顺手改动（它们决定哪些图跨 2/3 列）
    assert "const DG_SPAN2_MAX_ASPECT = 0.45;" in js
    assert "const DG_SPAN3_MAX_ASPECT = 0.25;" in js

    # 宽度大改时丢掉 lastColStep 反推基准（否则会收敛到错误列数：实测 1743px 下 14 列被推成 10 列）
    assert "const rawUsable = Math.max(DG_MIN_PT, (this.grid.clientWidth || 780) - padX);" in js
    assert "if (previousUsable > 0 && (rawUsable > previousUsable * 1.25 || rawUsable < previousUsable * 0.8)) {" in js
    assert "this._lastLayoutUsable = rawUsable;" in js
    # 抗滚动条造成的宽度抖动（CSS 兜底）
    assert "scrollbar-gutter: stable" in css


def test_gallery_masonry_has_no_overlap_and_fills_width():
    """离线复算布局算法：任取一组真实盒比，断言无重叠、右边界贴合、跨列生效。"""
    # 与 widget 中同一套常量
    MIN_PT, GAP, SPAN2, SPAN3 = 116, 7, 0.45, 0.25
    CLAMP = 2.2

    def span_for(aspect, cols):
        if cols < 2:
            return 1
        if aspect <= SPAN3 and cols >= 3:
            return 3
        if aspect <= SPAN2:
            return 2
        return 1

    usable = 1298 - 3
    cols = max(1, (usable + GAP) // (MIN_PT + GAP))
    card_w = (usable - GAP * (cols - 1)) / cols
    col_step = card_w + GAP

    # 真实 D站 帖子盒比样本（含超宽全景与超高竖图）
    aspects = [1.33, 1.0, 1.0, 0.613, 0.633, 0.862, 0.563, 0.566, 0.639, 0.409, 0.425,
               0.35, 0.51, 0.244, 0.642, 0.684, 0.525, 0.413, 0.555, 0.5, 0.75, 2.0, 3.0]
    aspects = [min(a, CLAMP) for a in aspects]

    col_heights = [0.0] * cols
    boxes = []
    for i, aspect in enumerate(aspects):
        span = span_for(aspect, cols)
        box_w = card_w * span + GAP * (span - 1)
        box_h = box_w * aspect
        start, top = 0, float("inf")
        for c in range(0, cols - span + 1):
            m = max(col_heights[c:c + span])
            if m < top:
                top, start = m, c
        drop = top + box_h + GAP
        for k in range(start, start + span):
            col_heights[k] = drop
        boxes.append((start * col_step, top, box_w, box_h))

    # ① 无重叠
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            ax, ay, aw, ah = boxes[i]
            bx, by, bw, bh = boxes[j]
            overlap = ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah
            assert not overlap, f"卡片 {i} 与 {j} 重叠"
    # ② 右边界贴合（最后一个列位刚好填满可用宽度）
    right = max(x + w for x, _, w, _ in boxes)
    assert abs(right - usable) < 1.0, f"右侧未贴合：{right} vs {usable}"
    # ③ 超宽图确实跨列
    assert any(x + w > card_w + GAP for x, _, w, _ in boxes), "没有任何卡片跨列"


def test_gallery_image_proxy_has_bounded_concurrency_and_day_cache():
    py = BACKEND.read_text(encoding="utf-8")

    assert "IMAGE_PROXY_CONCURRENCY = 3" in py
    assert "async with _get_image_proxy_semaphore()" in py
    assert '"Cache-Control": "public, max-age=86400"' in py


def test_gallery_order_consumes_a_counting_slot():
    """回归：order 必须算 1 个计数槽。

    历史 bug：`order` 被加进 FREE_METATAGS（那是给 presetTagParts 判断「是不是标签」用的），
    于是 countedSearchTerms 把排序当成免费 → 计数永不超限 → 「自动移除排序」分支与其提示条
    变成死代码（tests/test_danbooru_gallery_interactions.py 自 2026-09-07 起一直红）。
    """
    js = SOURCE.read_text(encoding="utf-8")
    assert "FREE_METATAGS_THAT_STILL_COUNT" in js
    assert 'FREE_METATAGS_THAT_STILL_COUNT = new Set(["order"])' in js
    # countedSearchTerms 必须先判 order 占槽，再回落 FREE_METATAGS
    counted = js.split("function countedSearchTerms", 1)[1].split("}", 1)[0]
    assert "FREE_METATAGS_THAT_STILL_COUNT.has(prefix)" in counted
    assert "return true" in counted


if __name__ == "__main__":
    test_gallery_uses_column_filling_waterfall_that_fills_the_grid()
    test_gallery_masonry_has_no_overlap_and_fills_width()
    test_gallery_image_proxy_has_bounded_concurrency_and_day_cache()
    test_gallery_order_consumes_a_counting_slot()
    print("PASS: Danbooru gallery layout + efficiency safeguards")
