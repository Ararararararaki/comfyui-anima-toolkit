"""TK 批量 LoRA 加载器：本地 LoRA 弹窗排序回归检查。"""
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "web" / "js" / "anima_batch_lora_widget.js"


def test_local_lora_sort_key_is_not_overridden_by_usage_count():
    js = SOURCE.read_text(encoding="utf-8")
    start = js.index("const getMatched = () =>")
    end = js.index("// ── 侧边栏分类 ──", start)
    sorter = js[start:end]

    assert '<option value="date">按日期</option>' in js
    assert '<option value="usage">按使用次数</option>' in js
    assert 'if (k === "size")' in sorter
    assert 'if (k === "date")' in sorter
    assert 'if (k === "usage")' in sorter
    assert "const ca = a.m.count" not in sorter
    assert "const cb = b.m.count" not in sorter
    assert "if (ca !== cb)" not in sorter


if __name__ == "__main__":
    test_local_lora_sort_key_is_not_overridden_by_usage_count()
    print("PASS: local LoRA sort key controls order without usage-count override")
