"""TK 批量 LoRA 加载器：本地 LoRA 弹窗排序回归检查。"""
import re
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "web" / "js" / "anima_batch_lora_widget.js"


def test_local_lora_sort_key_is_not_overridden_by_usage_count():
    js = SOURCE.read_text(encoding="utf-8")
    start = js.index("const getMatched = () =>")
    end = js.index("// ── 侧边栏分类 ──", start)
    sorter = js[start:end]

    # ⚠️ 断言写法：原版硬编码整串 '<option value="date">按日期</option>'，
    # 但真实选项带 selected 与后缀（`value="date" selected>按日期（最新在前）`），
    # 于是这条回归**从来没通过过**（被 pytest 收不进来，直接跑才暴露）。
    # 这里只锁「排序键存在」这个语义，不锁 HTML 细节。
    assert re.search(r'<option value="date"[^>]*>按日期', js), "缺少「按日期」排序选项"
    assert re.search(r'<option value="usage"[^>]*>按使用次数', js), "缺少「按使用次数」排序选项"
    assert 'if (k === "size")' in sorter
    assert 'if (k === "date")' in sorter
    assert 'if (k === "usage")' in sorter
    assert "const ca = a.m.count" not in sorter
    assert "const cb = b.m.count" not in sorter
    assert "if (ca !== cb)" not in sorter


if __name__ == "__main__":
    test_local_lora_sort_key_is_not_overridden_by_usage_count()
    print("PASS: local LoRA sort key controls order without usage-count override")
