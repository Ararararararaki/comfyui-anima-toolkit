"""分层清单的「防过期」守卫：tests/layer-manifest.json 必须与真实文件一致。

为什么需要：清单是给人看的「哪些是正式回归、哪些是一次性脚本」的真源，
但它**是从文件生成的**。有人新增/移动/删除了测试文件却忘了重新生成，
清单就会开始说谎 —— 那种过期的文档比没有文档更糟（会误导后续开发与 CI 决策）。
本测试把「重新生成一次」的结果与磁盘上的清单比对，不一致就 FAIL 并给出修复命令。

生成命令（改动 tests/ 结构后必须跑）：
    python tests/tools/classify_tests.py
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent
MANIFEST = TESTS / "layer-manifest.json"


def _load_classifier():
    """直接加载 tools/classify_tests.py（它不依赖 pytest，也不需要装成包）。"""
    path = TESTS / "tools" / "classify_tests.py"
    spec = importlib.util.spec_from_file_location("tk_classify_tests", path)
    assert spec and spec.loader, "无法加载 tools/classify_tests.py"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _expected_rows() -> dict[str, str]:
    """按与生成器完全相同的规则，现算一遍「文件 → 层」。"""
    clf = _load_classifier()
    rows: dict[str, str] = {}
    for p in sorted(TESTS.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts or p.name.startswith("."):
            continue
        if p.name in {"layer-manifest.json", "README.md", "conftest.py", "pytest.ini", "run_tests.py"}:
            continue
        if p.suffix not in {".py", ".js", ".mjs", ".html"}:
            continue
        layer, _why = clf.classify(p)
        rows[p.relative_to(TESTS).as_posix()] = layer
    return rows


def test_layer_manifest_matches_disk():
    assert MANIFEST.exists(), (
        "缺少 tests/layer-manifest.json —— 请运行：python tests/tools/classify_tests.py")
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    recorded = {r["file"]: r["layer"] for r in data["rows"]}
    expected = _expected_rows()

    added = sorted(set(expected) - set(recorded))
    removed = sorted(set(recorded) - set(expected))
    moved = sorted(f for f in (set(expected) & set(recorded)) if expected[f] != recorded[f])

    problems = []
    if added:
        problems.append(f"新增未登记 {len(added)}: {added[:8]}")
    if removed:
        problems.append(f"已删除未清理 {len(removed)}: {removed[:8]}")
    if moved:
        problems.append(f"分层变了 {len(moved)}: {[(f, recorded[f], expected[f]) for f in moved[:8]]}")

    assert not problems, (
        "layer-manifest.json 已过期，请运行 `python tests/tools/classify_tests.py` 重新生成。\n  "
        + "\n  ".join(problems))


@pytest.mark.unit
def test_ci_layer_has_no_browser_or_comfy_dependency():
    """CI 会跑的层（顶层 unit/js）绝不允许依赖真实浏览器或真实 ComfyUI。

    这条是整个 CI 能成立的前提：一旦有人往离线层塞进需要 playwright / :8188 的测试，
    CI 就会开始假红，然后被忽略 —— 那时 CI 就失去意义了。
    """
    import re
    browser_re = re.compile(r"playwright|chrome\.exe|msedge|chromium|webdriver", re.I)
    comfy_re = re.compile(r":8188|127\.0\.0\.1:8|localhost:8", re.I)

    offenders = []
    for name, layer in _expected_rows().items():
        if layer != "unit":
            continue
        p = TESTS / name
        if p.suffix != ".py":
            continue
        src = p.read_text(encoding="utf-8", errors="replace")
        if browser_re.search(src):
            offenders.append(f"{name}（用了浏览器）")
        elif comfy_re.search(src):
            offenders.append(f"{name}（连了 :8188）")

    assert not offenders, (
        "以下顶层测试需要真实环境，必须移到 tests/integration/ 并加 pytestmark 说明：\n  "
        + "\n  ".join(offenders))
