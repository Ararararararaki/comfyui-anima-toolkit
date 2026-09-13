"""模拟 CI 的「没有 torch / numpy / PIL / psutil」环境，跑离线层。

**这是防「本地绿、CI 红」的本地复现手段**：CI 只装 requirements-dev.txt，
而本机有 ComfyUI 带的 torch/numpy/PIL。任何真实 import 到它们、又没自己 stub 的
离线测试，在这个模拟环境里会立刻暴露，不用等推上去才知道。

用法:
    python tests/tools/run_offline_like_ci.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 这个 sitecustomize 会把这些模块变成「import 即失败」，模拟干净环境。
# 注意：conftest 若自己 stub 了它们（塞进 sys.modules），import 根本不会发生 → 不算失败。
SITECUSTOMIZE = '''
import sys

BLOCKED = {"torch", "numpy", "PIL", "psutil", "playwright"}


class _Blocker:
    def find_module(self, name, path=None):
        return self if name.split(".")[0] in BLOCKED else None

    def load_module(self, name):
        raise ModuleNotFoundError(f"No module named {name!r} (CI-simulation blocker)")


sys.meta_path.insert(0, _Blocker())
'''


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="tk-ci-sim-") as temp:
        Path(temp, "sitecustomize.py").write_text(SITECUSTOMIZE, encoding="utf-8")
        env = dict(os.environ)
        env["PYTHONPATH"] = temp + os.pathsep + str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
        env["PYTHONIOENCODING"] = "utf-8"
        print(f"[CI 模拟] 屏蔽 torch/numpy/PIL/psutil/playwright，跑 python -m pytest tests -q\n")
        proc = subprocess.run([sys.executable, "-m", "pytest", "tests", "-q"],
                              cwd=str(ROOT), env=env, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        out = (proc.stdout or "") + (proc.stderr or "")
        print("\n".join(out.splitlines()[-40:]))
        print(f"\n[CI 模拟] exit={proc.returncode}")
        if proc.returncode != 0:
            # 不写 emoji：Windows 控制台是 GBK，报告失败时 print 自己会 UnicodeEncodeError，
            # 把真正的报错盖掉（ai_verify.py 踩过同一个坑）。
            print("\n[X] 上面这些在真实 CI（干净环境）里也会失败 —— 推之前先修掉。")
        else:
            print("\n[OK] 离线层在「无重依赖」环境下通过，CI 不应再因依赖缺失而红。")
        return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
