#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ai_verify.py —— 一条命令做完 AI 改完代码后该跑的全部只读自检。

为什么存在：本项目大量改动集中在「节点注册表 / 前端 widget / README 配图引用」三处，
这三处出问题时**都不会在语法层面报错**，只会在运行时静默失效（例：`__init__.py` 合并了
一张没导入的映射表 → 导入即 NameError；README 引用了被删的截图 → 图片裂开）。
手工逐个查过一轮成本很高，于是固化成本脚本。

**纯只读**：不写任何文件、不动 git、不联网（除非显式 --remote）。

用法:
    python tests/ai_verify.py              # 全部本地检查
    python tests/ai_verify.py --remote     # 额外用 GitHub API 核对远端 head 与漂移
    python tests/ai_verify.py -q           # 只报结论

退出码: 0 = 全过；1 = 有 FAIL。
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import py_compile
import re
import subprocess
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "Ararararararaki/comfyui-anima-toolkit"
CRED = r"C:\Users\Toki\.my-credentials"

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    return ok


def info(msg: str) -> None:
    if not QUIET:
        print(msg)


# ────────────────────────── 1. Python 编译 ──────────────────────────
def check_compile() -> None:
    bad = []
    targets = ["__init__.py"] + sorted(os.path.basename(p) for p in glob.glob(os.path.join(ROOT, "anima_*.py")))
    for rel in targets:
        p = os.path.join(ROOT, rel)
        try:
            py_compile.compile(p, doraise=True, cfile=None)
        except Exception as e:  # noqa: BLE001
            bad.append(f"{rel}: {e}")
    check("Python 编译 (__init__.py + anima_*.py)", not bad, f"{len(targets)} 个文件" if not bad else "; ".join(bad))


# ────────────────── 2. __init__.py 合并表的导入完整性 ──────────────────
def check_merge_integrity() -> None:
    """捕捉「合并了一张没导入的映射表」——这类错误导入即 NameError，最难靠肉眼发现。"""
    src = io.open(os.path.join(ROOT, "__init__.py"), encoding="utf-8").read()
    merged = set(re.findall(r"\*\*([A-Z][A-Z0-9_]*NODE_(?:CLASS|DISPLAY_NAME)_MAPPINGS)", src))
    imported = set(re.findall(r"as\s+([A-Z][A-Z0-9_]*NODE_(?:CLASS|DISPLAY_NAME)_MAPPINGS)", src))
    missing = sorted(merged - imported)
    unused = sorted(imported - merged)
    detail = f"合并 {len(merged)} 张表"
    if missing:
        detail += f"；❌ 未导入却被合并: {missing}"
    if unused:
        detail += f"；⚠️ 导入未用: {unused}"
    check("__init__.py 映射表导入完整性", not missing, detail)


# ────────────── 3. 真实导入：列出当前注册的节点类型 ──────────────
def _stub(name: str) -> types.ModuleType:
    """构造「什么属性都能取到」的占位模块；同时补齐各级父包，便于承载点号子模块。"""
    if "." in name:
        parent, _, child = name.rpartition(".")
        p = sys.modules.get(parent) or _stub(parent)
        if not hasattr(p, "__path__"):
            p.__path__ = []
        m = types.ModuleType(name)
        setattr(p, child, m)
        sys.modules[name] = m
        return m

    class _Permissive(types.ModuleType):
        def __getattr__(self, k):
            if k.startswith("__"):
                raise AttributeError(k)
            fn = lambda *a, **kw: []  # noqa: E731
            setattr(self, k, fn)
            return fn

    m = _Permissive(name)
    m.__path__ = []
    sys.modules[name] = m
    return m


def _install_stubs() -> None:
    server = _stub("server")

    class _Routes:
        def get(self, *_a, **_k):
            return lambda fn: fn

        def post(self, *_a, **_k):
            return lambda fn: fn

    class _PromptServer:
        instance = None

        def __init__(self):
            self.routes = _Routes()

    server.PromptServer = _PromptServer
    _PromptServer.instance = _PromptServer()

    # folder_paths 不能泛型 stub：模块级就会 `os.path.join(folder_paths.get_input_directory(), ...)`，
    # 返回非字符串会直接 TypeError。这里按真实 API 语义给**字符串路径**。
    fp = _stub("folder_paths")
    dirs = {
        "input": os.path.join(ROOT, "input"),
        "output": os.path.join(ROOT, "output"),
        "temp": os.path.join(ROOT, "temp"),
        "loras": os.path.join(ROOT, "models", "loras"),
        "checkpoints": os.path.join(ROOT, "models", "checkpoints"),
    }
    fp.get_input_directory = lambda: dirs["input"]
    fp.get_output_directory = lambda: dirs["output"]
    fp.get_temp_directory = lambda: dirs["temp"]
    fp.get_folder_paths = lambda name: [dirs.get(name) or os.path.join(ROOT, "models", str(name))]
    fp.get_filename_list = lambda name: []
    fp.get_full_path = lambda name, f=None: os.path.join(dirs.get(name) or ROOT, str(f or ""))
    fp.get_full_path_or_raise = fp.get_full_path
    fp.filter_files_content_symlink = lambda xs: xs
    fp.folder_names_and_paths = {}
    fp.models_dir = os.path.join(ROOT, "models")
    fp.base_path = ROOT
    fp.input_directory = dirs["input"]
    fp.output_directory = dirs["output"]
    fp.temp_directory = dirs["temp"]


def _is_local(missing: str) -> bool:
    """该缺失模块是否属于本项目（= 真错误，而非环境缺口）。"""
    return bool(missing) and (missing.startswith("anima_") or os.path.exists(os.path.join(ROOT, missing + ".py")))


def _import_module(mod: str, path: str, pkg: str):
    """导入单个节点模块：缺第三方/ComfyUI 运行时模块时**自动补 stub 后重试**。

    要点：失败时务必把半成品从 sys.modules 摘掉，否则下游 `from .anima_x import Y`
    会拿到一个只执行了一半的模块，报出误导性的 ImportError（这个坑本脚本踩过一次）。
    """
    import importlib.util

    full = f"{pkg}.{mod}"
    last_env_gap = None
    for _ in range(12):
        sys.modules.pop(full, None)
        try:
            spec = importlib.util.spec_from_file_location(full, path)
            m = importlib.util.module_from_spec(spec)
            sys.modules[full] = m
            spec.loader.exec_module(m)
            return m, None
        except ModuleNotFoundError as e:
            missing = getattr(e, "name", "") or ""
            sys.modules.pop(full, None)
            if _is_local(missing):
                raise
            last_env_gap = f"{type(e).__name__}: {e}"
            _stub(missing)
        except BaseException:
            sys.modules.pop(full, None)
            raise
    return None, last_env_gap


def check_node_registration() -> None:
    """用合成包 + 运行时 stub 真实导入各节点模块，列出注册结果。

    这是「改/删节点后插件还能不能加载」的唯一低成本实证手段 —— 不需要跑起 ComfyUI。
    用合成包是为了让模块内的相对导入（`from . import x`）能正常工作。
    """
    _install_stubs()
    PKG = "tkplugin"
    pkg = types.ModuleType(PKG)
    pkg.__path__ = [ROOT]
    sys.modules[PKG] = pkg

    empty, errored, skipped, registered = [], [], [], []
    for p in sorted(glob.glob(os.path.join(ROOT, "anima_*.py"))):
        mod = os.path.basename(p)[:-3]
        try:
            m, gap = _import_module(mod, p, PKG)
        except BaseException as e:  # noqa: BLE001
            errored.append(f"{mod}: {type(e).__name__}: {e}")
            continue
        if m is None:
            skipped.append(f"{mod} ({gap})")
            continue
        cls = getattr(m, "NODE_CLASS_MAPPINGS", None)
        if cls is None:
            continue
        if not cls:
            empty.append(mod)
        registered += list(cls)

    info(f"    注册节点 {len(registered)} 个: {', '.join(registered)}")
    if empty:
        info(f"    ℹ️ 映射表为空的模块（退役/条件注册，确认是有意的）: {empty}")
    if skipped:
        info(f"    ℹ️ 环境缺口无法导入 {len(skipped)} 个: {[s.split(' ')[0] for s in skipped]}")
    check("节点模块可导入（无代码级错误）", not errored,
          "; ".join(errored) if errored else f"注册 {len(registered)} 个节点，环境缺口 {len(skipped)} 个")


# ────────────────── 4. README 截图引用存在性 ──────────────────
def check_readme_images() -> None:
    readme = os.path.join(ROOT, "README.md")
    if not os.path.exists(readme):
        check("README 截图引用", False, "README.md 不存在")
        return
    body = io.open(readme, encoding="utf-8").read()
    refs = sorted(set(re.findall(r"\]\((screenshots/[^)]+)\)", body)))
    missing = [r for r in refs if not os.path.exists(os.path.join(ROOT, r))]
    shot_dir = os.path.join(ROOT, "screenshots")
    have = set(os.listdir(shot_dir)) if os.path.isdir(shot_dir) else set()
    unused = sorted(n for n in have if f"screenshots/{n}" not in refs)
    if unused:
        info(f"    ℹ️ 未被 README 引用的截图: {unused}")
    check("README 截图引用全部存在", not missing,
          f"{len(refs)} 个引用" + (f"；❌ 缺失: {missing}" if missing else ""))


# ────────────────── 5. README 站内链接存在性 ──────────────────
def check_readme_links() -> None:
    body = io.open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
    links = sorted(set(re.findall(r"\]\((?!https?:|#|screenshots/)([^)#]+)\)", body)))
    missing = [l for l in links if not os.path.exists(os.path.join(ROOT, l.split("#")[0]))]
    check("README 站内链接存在", not missing,
          f"{len(links)} 个链接" + (f"；❌ 缺失: {missing}" if missing else ""))


# ────────────────── 6. 版本一致性 ──────────────────
def check_version() -> None:
    vf = os.path.join(ROOT, "VERSION")
    if not os.path.exists(vf):
        check("VERSION 与 __version__ 一致", False, "VERSION 文件不存在")
        return
    v = io.open(vf, encoding="utf-8").read().strip()
    src = io.open(os.path.join(ROOT, "__init__.py"), encoding="utf-8").read()
    m = re.search(r'__version__\s*=\s*"([^"]+)"', src)
    iv = m.group(1) if m else None
    ok = iv == v
    detail = f"VERSION={v} / __version__={iv}"
    if not ok:
        cl = os.path.join(ROOT, "CHANGELOG.md")
        if os.path.exists(cl) and f"[{v}]" not in io.open(cl, encoding="utf-8").read():
            detail += "；❌ CHANGELOG 缺少该版本条目"
    check("VERSION 与 __init__.__version__ 一致", ok, detail)


# ────────────────── 7. 工作区噪音（会让 AI 误判的未跟踪文件）──────────────────
JUNK = [
    (r"vite\.config\.ts\.timestamp-.*\.mjs$", "Vite 临时产物（应 gitignore）"),
    (r"^(test_gallery|tmp_.*|scratch_.*)\.py$", "疑似临时脚本"),
]


def check_workspace_noise() -> None:
    """只作提示，不作判定。

    未跟踪文件在开发仓库里是常态（临时脚本/日志/构建产物）。把它当 FAIL 会训练出
    「无视 FAIL」的坏习惯，所以这里永远 PASS，只在输出里点名需要留意的几类。
    """
    r = subprocess.run(["git", "-C", ROOT, "status", "--short"], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        check("工作区状态", True, "跳过（非 git 仓库或 git 不可用）")
        return
    lines = [l[3:] for l in r.stdout.split("\n") if l.startswith("??")]
    hits = []
    for f in lines:
        for pat, why in JUNK:
            if re.search(pat, os.path.basename(f)):
                hits.append(f"{f} ({why})")
                break
    tracked_dirty = len([l for l in r.stdout.split("\n") if l[:2].strip() and not l.startswith("??")])
    if hits:
        info(f"    ℹ️ 建议清理的未跟踪噪音 {len(hits)} 项: {hits[:5]}{' …' if len(hits) > 5 else ''}")
    check("工作区状态（提示性）", True,
          f"已修改 {tracked_dirty} 项 / 未跟踪 {len(lines)} 项 / 建议清理 {len(hits)} 项")


# ────────────────── 8. 远端漂移（可选，需 token + 网络）──────────────────
def check_remote() -> None:
    tok = None
    if os.path.exists(CRED):
        for line in io.open(CRED, encoding="utf-8", errors="ignore"):
            m = re.search(r"(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)", line)
            if m:
                tok = m.group(1)
                break
    if not tok:
        check("远端 head 核对", True, "跳过（未找到 token）")
        return
    import urllib.request
    H = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json", "User-Agent": "tk"}
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/commits/main", headers=H)
        head = json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e:  # noqa: BLE001
        check("远端 head 核对", True, f"跳过（网络/接口失败: {type(e).__name__}）")
        return
    sha, msg = head["sha"][:8], head["commit"]["message"].split("\n")[0][:60]
    local = subprocess.run(["git", "-C", ROOT, "log", "-1", "--format=%H"], capture_output=True,
                           text=True, encoding="utf-8", errors="replace").stdout.strip()[:8]
    same_content = _same_tree(sha, H)
    info(f"    远端 head={sha} ({msg}) / 本地 head={local}")
    check("远端 head 已核对", True,
          f"远端 {sha} / 本地 {local}" + ("（内容一致）" if same_content else "（⚠️ 内容有差异，推送前先 dry-run）"))


def _same_tree(remote_sha: str, H: dict) -> bool:
    """用守卫脚本的同一把尺子：远端 head tree vs 本地 HEAD 的文件集合。"""
    r = subprocess.run(["git", "-C", ROOT, "ls-tree", "-r", "--name-only", "HEAD"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    local_files = set(r.stdout.strip().split("\n")) - {"app/index.html"}
    import urllib.request
    try:
        t = json.load(urllib.request.urlopen(urllib.request.Request(
            f"https://api.github.com/repos/{REPO}/git/trees/{remote_sha}?recursive=1", headers=H), timeout=90))
    except Exception:  # noqa: BLE001
        return False
    remote_files = {x["path"] for x in t.get("tree", []) if x["type"] == "blob" and not x["path"].startswith("app/")}
    local_files = {f for f in local_files if not f.startswith("app/")}
    return remote_files == local_files


# ────────────────────────── main ──────────────────────────
QUIET = False


def main() -> int:
    global QUIET
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", action="store_true", help="额外核对远端 head（需要 token + 网络）")
    ap.add_argument("-q", "--quiet", action="store_true", help="只报结论")
    a = ap.parse_args()
    QUIET = a.quiet

    print(f"ai_verify — {ROOT}\n")
    check_compile()
    check_merge_integrity()
    check_node_registration()
    check_readme_images()
    check_readme_links()
    check_version()
    check_workspace_noise()
    if a.remote:
        check_remote()

    print()
    for name, ok, detail in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  —  {detail}" if detail else ""))
    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过" + (f"；失败: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
