"""把「脚本式」测试文件改成 pytest 能安全收集的形式。

两类问题：
 A. 顶层直接 `sys.exit(...)`：pytest 导入模块时抛 SystemExit → INTERNALERROR，整个收集崩掉。
    修法：把顶层执行段挪进 `if __name__ == "__main__":`（或已有函数就只加守卫）。
 B. 顶层裸 `assert`：pytest 导入时执行，**失败不会被报告**（静默假绿）。
    修法：包进 `def test_script_regression():`，既能被 pytest 收集，也能 `python file.py` 直接跑。

只做文本级、可验证的搬运；改完由 `python -m pytest --collect-only` 与逐个直跑验证。
"""
import io
import re
from pathlib import Path

TESTS = Path(__file__).resolve().parents[1]
MAIN_GUARD = re.compile(r'(?m)^\s*if\s+__name__\s*==\s*["\']__main__["\']\s*:')

# ── A 类：顶层有 sys.exit，但没有 __main__ 守卫 ──────────────────────────────
A_FILES = [
    "test_batch_controller_logic.py",
    "test_camera_presets.py",
    "test_cards_v2.py",
    "test_danbooru_meta.py",
    "test_image_select.py",
]


def guard_main_block(text: str) -> tuple[str, bool]:
    """把「从第一条顶层可执行语句开始到文件末」的整段缩进进 __main__ 守卫。

    定位方式：找最后一个 `def ` / 装饰器结束之后的第一条 0 缩进语句（跳过 import、
    常量赋值、注释、docstring）。保守起见只处理「模块末尾一段连续顶层代码」这种形态。
    """
    lines = text.split("\n")
    n = len(lines)

    # 从底部往上找：最后一段「0 缩进的可执行语句」区间
    def is_top_exec(s: str) -> bool:
        if not s.strip():
            return False
        if s[0] in " \t":
            return False
        st = s.strip()
        if st.startswith(("#", '"', "'", "@")):
            return False
        if re.match(r"^(import|from)\s", st):
            return False
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*\s*=", st) and "(" not in st.split("=")[0]:
            return False
        return True

    end = None
    for i in range(n - 1, -1, -1):
        if is_top_exec(lines[i]):
            end = i
            break
    if end is None:
        return text, False

    start = end
    i = end
    while i >= 0:
        s = lines[i]
        if not s.strip():
            i -= 1
            continue
        if is_top_exec(s):
            start = i
            i -= 1
            continue
        break

    block = lines[start:end + 1]
    if not any(re.search(r"sys\.exit|raise SystemExit", b) for b in block):
        return text, False

    indented = ["    " + b if b.strip() else b for b in block]
    out = lines[:start] + ["", 'if __name__ == "__main__":'] + indented + lines[end + 1:]
    return "\n".join(out), True


def main() -> int:
    changed = []
    # A 类
    for name in A_FILES:
        p = TESTS / name
        if not p.exists():
            print(f"  SKIP {name}（不存在）")
            continue
        src = io.open(p, encoding="utf-8").read()
        if MAIN_GUARD.search(src):
            print(f"  SKIP {name}（已有守卫）")
            continue
        new, ok = guard_main_block(src)
        if not ok:
            print(f"  MANUAL {name}（未能自动定位顶层执行段，需人工）")
            continue
        io.open(p, "w", encoding="utf-8", newline="").write(new)
        changed.append(name)
        print(f"  OK   {name}  已加 __main__ 守卫")

    print(f"\nA 类处理 {len(changed)} 个: {changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
