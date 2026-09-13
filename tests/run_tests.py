#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""run_tests.py —— 一键跑「CI 会跑的全部检查」。

为什么存在：项目里有两类东西容易混淆 ——
  · **正式回归**：纯离线、可 CI（本脚本默认只跑这些）
  · **integration 验证**：需要真实浏览器 + 真实 ComfyUI(:8188)，**只能本机跑**
混在一起跑的后果是「本地绿、CI 红」或「CI 绿、本地红」，两边都失去意义。
本脚本把边界钉死：默认全离线，要跑真实环境的必须显式加 `--integration`。

用法:
    python tests/run_tests.py                 # CI 等价：编译 + 离线 pytest + ai_verify + JS
    python tests/run_tests.py --js            # 只跑 JS 测试
    python tests/run_tests.py --integration   # 额外跑需要 ComfyUI(:8188) 的验证脚本
    python tests/run_tests.py -q              # 精简输出

退出码: 0 = 全过；1 = 有失败（CI 直接据此判定）。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
QUIET = False


def info(msg: str) -> None:
    if not QUIET:
        print(msg, flush=True)


def _which(name: str) -> str | None:
    import shutil
    return shutil.which(name)


def run(cmd: list[str], cwd: Path = ROOT, label: str = "") -> tuple[bool, str]:
    """跑一条命令，返回 (成功?, 摘要)。输出实时透传，失败时 CI 日志里一眼能看到是哪一步。"""
    tag = label or " ".join(cmd[:3])
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
    except FileNotFoundError:
        print(f"\n----- {tag} FAILED: 找不到可执行文件 {cmd[0]}（是否未安装/不在 PATH？）-----")
        return False, "executable not found"
    dur = time.time() - t0
    out = (proc.stdout or "") + (proc.stderr or "")
    ok = proc.returncode == 0
    if not ok:
        print(f"\n----- {tag} FAILED (exit {proc.returncode}, {dur:.1f}s) -----")
        print("\n".join(out.splitlines()[-60:]))
        print(f"----- end {tag} -----\n")
    else:
        info(f"  OK   {tag}  ({dur:.1f}s)")
    return ok, out


def step_py_compile() -> bool:
    targets = ["__init__.py"] + sorted(p.name for p in ROOT.glob("anima_*.py"))
    ok, out = run([sys.executable, "-m", "py_compile", *targets], label="py_compile (全部插件 py)")
    return ok


def step_offline_pytest() -> bool:
    # 注意：必须传 tests 目录，且 pytest 配置在 tests/pytest.ini（原因见该文件顶部注释）
    ok, out = run([sys.executable, "-m", "pytest", "tests", "-q"],
                  label="pytest (离线层)")
    if ok:
        info("       " + (out.strip().splitlines() or [""])[-1])
    return ok


def step_ci_env_simulation() -> bool:
    """在「无 torch/numpy/PIL/psutil/playwright」的模拟干净环境里再跑一遍离线层。

    为什么值得多花这几秒：本机有 ComfyUI 带的这些重依赖，CI 没有 ——
    任何真实 import 它们、又没自己 stub 的测试都会「本地绿、CI 红」。
    这个模拟把 CI 才能暴露的失败提前到本地（首次 CI 就因此红过一次：
    test_danbooru_meta.py 顶层真的 `import PIL`）。
    """
    ok, out = run([sys.executable, str(TESTS / "tools" / "run_offline_like_ci.py")],
                  label="pytest (模拟 CI 干净环境)")
    if ok:
        info("       " + (out.strip().splitlines() or [""])[-1])
    return ok


def step_ai_verify() -> bool:
    ok, out = run([sys.executable, str(TESTS / "tools" / "ai_verify.py"), "-q"],
                  label="ai_verify (节点注册/README/版本一致性)")
    if ok:
        info("       " + (out.strip().splitlines() or [""])[-1])
    return ok


def step_js_tests() -> bool:
    """JS 测试：tests/js/*.js|mjs（Node 直接跑，不进 pytest）。"""
    if not _which("node"):
        info("  SKIP JS 测试（PATH 里没有 node）")
        return True
    js_dir = TESTS / "js"
    files: list[Path] = []
    if js_dir.is_dir():
        files += sorted([*js_dir.glob("*.mjs"), *js_dir.glob("*.js")])
    # 兜底：早期 JS 测试散在 tests/ 顶层。
    # ⚠️ 用「任意 .js/.mjs」而不是 `test_*.mjs`：后者会漏掉
    #    test_preset_latent_resolution.js 这种命名（曾经就没被跑到，
    #    于是里面硬编码绝对路径的问题一直没在 CI 暴露）。
    for pat in ("test_*.mjs", "test_*.js", "*.test.js"):
        files += sorted(TESTS.glob(pat))
    # 去重且保持稳定顺序
    seen: set[Path] = set()
    files = [f for f in files if not (f in seen or seen.add(f))]
    if not files:
        info("  SKIP JS 测试（未找到）")
        return True
    all_ok = True
    for f in files:
        ok, _ = run(["node", str(f)], label=f"node {f.name}")
        all_ok &= ok
    return all_ok


def step_panel_typecheck() -> bool:
    """面板 TypeScript 检查。没装依赖时跳过（不当失败，避免 CI 误红）。"""
    panel = ROOT / "panel"
    if not (panel / "node_modules").is_dir():
        info("  SKIP panel tsc（未安装 panel/node_modules）")
        return True
    tsc = panel / "node_modules" / "typescript" / "bin" / "tsc"
    if tsc.exists():
        # 直接调本地 tsc，绕开 npx（npx 在某些 PATH 组合下不可用）
        cmd = ["node", str(tsc), "--noEmit", "-p", "tsconfig.json"]
    elif _which("npx"):
        cmd = ["npx", "--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"]
    else:
        info("  SKIP panel tsc（node_modules 里没有 tsc，PATH 里也没有 npx）")
        return True
    ok, _ = run(cmd, cwd=panel, label="panel tsc --noEmit")
    return ok


def step_integration() -> bool:
    """需要真实 ComfyUI(:8188) + 浏览器的验证脚本。**CI 永不跑**。"""
    integ = TESTS / "integration"
    if not integ.is_dir():
        info("  SKIP integration（目录不存在）")
        return True
    all_ok = True
    for f in sorted(integ.glob("*.py")):
        ok, _ = run([sys.executable, str(f)], label=f"integration {f.name}")
        all_ok &= ok
    return all_ok


def main() -> int:
    global QUIET
    ap = argparse.ArgumentParser()
    ap.add_argument("--integration", action="store_true",
                    help="额外跑需要真实 ComfyUI(:8188) 的脚本（本机专用，勿在 CI 用）")
    ap.add_argument("--js", action="store_true", help="只跑 JS 测试")
    ap.add_argument("--no-panel", action="store_true", help="跳过 panel tsc")
    ap.add_argument("-q", "--quiet", action="store_true")
    a = ap.parse_args()
    QUIET = a.quiet

    print(f"run_tests — {ROOT}\n")
    results: list[tuple[str, bool]] = []

    if a.js:
        results.append(("JS 测试", step_js_tests()))
    else:
        results.append(("Python 编译", step_py_compile()))
        results.append(("离线 pytest", step_offline_pytest()))
        results.append(("离线 pytest（模拟 CI 干净环境）", step_ci_env_simulation()))
        results.append(("ai_verify", step_ai_verify()))
        results.append(("JS 测试", step_js_tests()))
        if not a.no_panel:
            results.append(("panel 类型检查", step_panel_typecheck()))
        if a.integration:
            results.append(("integration（需 ComfyUI 在线）", step_integration()))

    print()
    for name, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} 通过" + (f"；失败: {failed}" if failed else ""))
    if not a.integration and not a.js:
        print("\n提示：integration（真实浏览器 + ComfyUI:8188）未跑；需要时加 --integration")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
