"""版本号单一真源的「一处改、四处同步」脚本。

用于发版时把新版本号写到 5 个位置（其中 VERSION 是唯一真源，其余都必须与它一致）：
  VERSION                              ← 唯一真源（本脚本第一个写的就是它）
  __init__.py  _FALLBACK_VERSION        ← 读 VERSION 失败时的兜底，也要同步
  README.md    「当前发布版本: **X**」
  pyproject.toml  [project].version     ← 发布给 ComfyUI Registry 的版本号
  CHANGELOG.md 插入 `## [X] - YYYY-MM-DD` 骨架（若该版本条目不存在）

注意：CHANGELOG 只插入**骨架**，正文要人写 —— 本脚本不编造变更内容。
写完请跑 `python tests/run_tests.py`（ai_verify 会验证五处一致）。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import io
import re
from pathlib import Path

# 本文件在 <repo>/tools/ 下 → parents[0]=tools, parents[1]=<repo>
ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("version", help="新版本号，如 2.11.0")
    ap.add_argument("--date", default=_dt.date.today().isoformat())
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    v = a.version.strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", v):
        raise SystemExit(f"版本号格式应为 X.Y.Z，收到 {v!r}")

    changes: list[tuple[Path, str, str]] = []

    # 1) VERSION（唯一真源）
    p = ROOT / "VERSION"
    changes.append((p, p.read_text(encoding="utf-8"), v + "\n"))

    # 2) __init__.py 的兜底版本
    p = ROOT / "__init__.py"
    body = p.read_text(encoding="utf-8")
    new = re.sub(r'(?m)^(_FALLBACK_VERSION\s*=\s*)"[^"]*"', rf'\1"{v}"', body, count=1)
    if new == body:
        raise SystemExit("未在 __init__.py 找到 _FALLBACK_VERSION")
    changes.append((p, body, new))

    # 3) README「当前发布版本」
    p = ROOT / "README.md"
    body = p.read_text(encoding="utf-8")
    new = re.sub(r"(?m)^(当前发布版本[:：]\s*\*\*)[0-9]+\.[0-9]+\.[0-9]+(\*\*)", rf"\g<1>{v}\g<2>", body, count=1)
    if new == body:
        raise SystemExit("未在 README 找到「当前发布版本: **X.Y.Z**」")
    changes.append((p, body, new))

    # 4) pyproject.toml（ComfyUI Registry 版本）
    p = ROOT / "pyproject.toml"
    body = p.read_text(encoding="utf-8")
    new = re.sub(r'(?m)^(version\s*=\s*)"[^"]*"', rf'\1"{v}"', body, count=1)
    if new == body:
        raise SystemExit("未在 pyproject.toml 找到 [project].version")
    changes.append((p, body, new))

    # 5) CHANGELOG：只插骨架，不编内容
    p = ROOT / "CHANGELOG.md"
    body = p.read_text(encoding="utf-8")
    if f"## [{v}]" in body:
        print(f"CHANGELOG 已有 [{v}] 条目，跳过插入")
    else:
        anchor = re.search(r"(?m)^## \[", body)
        if not anchor:
            raise SystemExit("CHANGELOG 里找不到任何 `## [` 版本条目作为锚点")
        skeleton = (
            f"## [{v}] - {a.date}\n\n"
            "### 新增\n\n- （待写：本条从 CHANGELOG 提炼后用于 GitHub Release notes）\n\n"
        )
        changes.append((p, body, body[:anchor.start()] + skeleton + body[anchor.start():]))

    for path, old, new in changes:
        rel = path.relative_to(ROOT)
        if old == new:
            print(f"  = {rel} 无需改动")
            continue
        print(f"  * {rel}")
        if not a.dry_run:
            path.write_text(new, encoding="utf-8", newline="")

    print(f"\n{'[dry-run] ' if a.dry_run else ''}版本已设为 {v}（共 {len(changes)} 处）")
    if not a.dry_run:
        print("下一步：补写 CHANGELOG 正文 → python tests/run_tests.py → 推送")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
