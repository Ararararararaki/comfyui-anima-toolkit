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
    # 自适应张数（0 = 按节点尺寸算该显示几张）
    assert "function dgComputeAutoCount(grid, metrics)" in js
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
