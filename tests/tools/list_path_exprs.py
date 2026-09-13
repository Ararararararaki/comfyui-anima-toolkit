"""列出各层文件里的「路径表达式」，用于判断移动是否安全。

移动一个文件会让 parents[N] / dirname(dirname(...)) 指向错的地方，
所以先看清每个候选文件到底用了哪种形态。
"""
import io
import json
import re
from pathlib import Path

TESTS = Path(__file__).resolve().parents[1]
MANIFEST = TESTS / "layer-manifest.json"

PATH_RE = re.compile(r"parents\[\d+\]|os\.path\.dirname\(os\.path\.dirname|rsplit\(\"\\\\\\\\tests\\\\\\\\\"|\.parent\.parent|__file__")


def main() -> int:
    data = json.load(io.open(MANIFEST, encoding="utf-8"))
    rows = {r["file"]: r for r in data["rows"]}
    print(f"{'file':<52} {'layer':<12} path-expressions")
    print("-" * 110)
    for name, r in sorted(rows.items()):
        p = TESTS / name
        if not p.exists() or p.suffix not in {".py", ".js", ".mjs"}:
            continue
        src = io.open(p, encoding="utf-8", errors="replace").read()
        exprs = sorted({m.group(0) for m in PATH_RE.finditer(src)})
        if exprs:
            print(f"{name:<52} {r['layer']:<12} {', '.join(exprs)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
