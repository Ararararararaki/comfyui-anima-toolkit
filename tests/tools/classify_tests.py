"""把 tests/ 下的脚本按「依赖什么」自动分类，输出供 CI 与 pytest.ini 使用的事实清单。

分层模型（见 tests/README.md）：
  tests/*.py            单元/静态回归（CI 必跑，纯离线）
  tests/integration/    需要真实浏览器 + 真实 ComfyUI（仅本机跑，CI 永不跑）
  tests/repro/          一次性复现/诊断脚本（开发时工具，**不进 CI**）
  tests/tools/          开发自检工具（ai_verify 等）
  tests/js/             Node 侧测试

分类依据（只看源码文本，保守）：
  integration : 需要真实浏览器（playwright/chrome.exe/msedge）或真实 ComfyUI（:8188）
  repro       : 住在 tests/repro/ 里，或名字含 repro/probe/diag/compare/restore_/setup_
  tools       : ai_verify 这类开发自检工具（非测试）
  unit        : 其余（纯离线、可 CI）
"""
import io
import json
import re
from pathlib import Path

TESTS = Path(__file__).resolve().parents[1]

BROWSER_RE = re.compile(r"playwright|chrome\.exe|msedge|chromium|CDP|webdriver", re.I)
COMFY_RE = re.compile(r":8188|127\.0\.0\.1:8|localhost:8", re.I)

# 不是「可执行的测试」，而是共享夹具/页面壳：按扩展名单独归类
FIXTURE_SUFFIXES = {".html"}

# 测试基础设施（不是用例，不参与分层）；test_layer_manifest.py 必须用同一份清单
INFRA_FILES = {
    "layer-manifest.json",  # 本脚本的产物
    "README.md",            # 分层说明
    "conftest.py",          # pytest 引导
    "pytest.ini",           # pytest 配置
    "run_tests.py",         # 一键跑测入口
}


def classify(p: Path) -> tuple[str, list[str]]:
    name = p.name.lower()
    rel = p.relative_to(TESTS).as_posix()
    # 用 with 读取：本函数被 test_layer_manifest.py 在 pytest 内调用，
    # io.open(...).read() 不关文件会刷出上百条 ResourceWarning
    if p.suffix == ".html":
        src = ""
    else:
        with io.open(p, encoding="utf-8", errors="replace") as fh:
            src = fh.read()
    why: list[str] = []
    needs_browser = bool(BROWSER_RE.search(src))
    needs_comfy = bool(COMFY_RE.search(src))
    if needs_browser:
        why.append("browser")
    if needs_comfy:
        why.append("comfy8188")

    if p.suffix in FIXTURE_SUFFIXES:
        return "fixture", why + ["shared-fixture"]
    if rel.startswith("repro/"):
        return "repro", why + ["one-shot"]
    if rel.startswith("tools/"):
        return "tools", why + ["dev-tool"]
    if rel.startswith("integration/"):
        return "integration", why
    if rel.startswith("js/"):
        return "js", why

    if name.startswith("ai_verify") or name.startswith("update_handoff"):
        return "tools", why + ["dev-tool"]
    if re.search(r"\b(repro|probe|diag|compare|restore_|setup_)", name):
        return "repro", why + ["one-shot"]
    if name.startswith("smoke_") or "smoke" in name:
        return "smoke", why
    if name.endswith((".js", ".mjs")):
        return "js", why
    if needs_browser or needs_comfy:
        return "integration", why
    return "unit", why


LAYERS = ("unit", "js", "integration", "smoke", "repro", "tools", "fixture")


def main() -> int:
    rows = []
    for p in sorted(TESTS.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts or p.name.startswith("."):
            continue
        if p.name in INFRA_FILES:
            continue
        if p.suffix not in {".py", ".js", ".mjs", ".html"}:
            continue
        layer, why = classify(p)
        rows.append({"file": p.relative_to(TESTS).as_posix(), "layer": layer, "why": why,
                     "bytes": p.stat().st_size})

    buckets: dict[str, list[str]] = {}
    for r in rows:
        buckets.setdefault(r["layer"], []).append(r["file"])

    print(f"tests/ 共 {len(rows)} 个文件\n")
    for layer in LAYERS:
        files = buckets.get(layer, [])
        print(f"── {layer} ({len(files)}) ──")
        for f in files:
            why = next((r["why"] for r in rows if r["file"] == f), [])
            print(f"   {f}" + (f"   [{','.join(why)}]" if why else ""))
        print()

    out = TESTS / "layer-manifest.json"
    io.open(out, "w", encoding="utf-8").write(json.dumps(
        {"generated_by": "tools/classify_tests.py", "layers": list(LAYERS),
         "buckets": buckets, "rows": rows},
        ensure_ascii=False, indent=1))
    print(f"清单已写入 {out.name}（供 tests/test_layer_manifest.py 校验是否过期）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
