"""tests/ 的 pytest 引导 —— 让测试套件在**没有 ComfyUI 的环境**（CI）里也能跑。

⚠️ 为什么必须有这个文件（不是可选项）：

本仓库是 ComfyUI 插件，**仓库根目录就有一个 `__init__.py`**。pytest 在 setup 阶段
会为测试文件所在目录的每一级父目录尝试导入 `__init__.py` 来决定包结构，于是它会把
仓库根当包导入，触发 `import folder_paths` / `from server import PromptServer`
（这两个模块由 ComfyUI 运行时提供，独立环境里不存在）→ 全部测试 setup ERROR。

pytest 9 里 `import-mode` 不是合法的 ini 选项（实测 `Unknown config option`），
`collect_ignore` 也拦不住这条 setup 路径 —— 所以唯一稳的办法是
**在这里先把 ComfyUI 运行时模块 stub 掉**（conftest 在收集测试模块之前就被导入）。
这在真实安装里是 no-op（真模块已存在，不会被覆盖）。

这一条同样是「节点模块可离线导入」这条项目既有约定的复用：
`tools/ai_verify.py` 用的是同一套 stub 思路。
"""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent

# 让测试模块能 `import anima_*`（多数测试自己会处理，这里统一兜底）
for _p in (str(REPO_ROOT), str(TESTS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ.setdefault("MPLBACKEND", "Agg")


def _permissive(name: str) -> types.ModuleType:
    """构造「取任何属性都返回可调用对象」的占位模块（与 ai_verify 同款）。

    比逐个函数 stub 稳：ComfyUI 运行时 API 面很宽，逐个列举必然滞后。
    """
    if name in sys.modules:
        return sys.modules[name]

    class _Permissive(types.ModuleType):
        def __getattr__(self, key):  # noqa: D105
            if key.startswith("__"):
                raise AttributeError(key)
            fn = lambda *a, **kw: []  # noqa: E731
            setattr(self, key, fn)
            return fn

    module = _Permissive(name)
    module.__path__ = []
    sys.modules[name] = module
    return module


def install_comfy_runtime_stubs() -> None:
    """注入 ComfyUI 运行时模块占位（幂等；真实模块已存在时直接返回）。"""
    # folder_paths：模块级就会用它拼路径，必须给**字符串**而不是泛型返回
    if "folder_paths" not in sys.modules:
        fp = _permissive("folder_paths")
        _dirs = {
            "input": str(REPO_ROOT / "input"),
            "output": str(REPO_ROOT / "output"),
            "temp": str(REPO_ROOT / "temp"),
            "loras": str(REPO_ROOT / "models" / "loras"),
            "checkpoints": str(REPO_ROOT / "models" / "checkpoints"),
        }
        fp.get_input_directory = lambda: _dirs["input"]
        fp.get_output_directory = lambda: _dirs["output"]
        fp.get_temp_directory = lambda: _dirs["temp"]
        fp.get_folder_paths = lambda name: [_dirs.get(name) or str(REPO_ROOT / "models" / str(name))]
        fp.get_filename_list = lambda _name: []
        fp.get_full_path = lambda name, f=None: os.path.join(_dirs.get(name) or str(REPO_ROOT), str(f or ""))
        fp.get_full_path_or_raise = fp.get_full_path
        fp.filter_files_content_symlink = lambda items: items
        fp.folder_names_and_paths = {}
        fp.models_dir = str(REPO_ROOT / "models")
        fp.base_path = str(REPO_ROOT)
        fp.input_directory = _dirs["input"]
        fp.output_directory = _dirs["output"]
        fp.temp_directory = _dirs["temp"]

    # server.PromptServer：路由装饰器需要能当装饰器用
    if "server" not in sys.modules:
        server = _permissive("server")

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

    # torch 只被少数节点用到，CI 里没装也不能让根 __init__ 导入失败
    for optional in ("torch", "numpy", "psutil", "PIL"):
        try:
            __import__(optional)
        except Exception:
            _permissive(optional)
            _permissive(f"{optional}.Image") if optional == "PIL" else None


install_comfy_runtime_stubs()

# 阻止 pytest 把仓库根的 __init__.py（ComfyUI 插件入口）当测试模块**跑**；
# stub 已经让它能导入，但没必要真的执行它（会注册全部路由）。
collect_ignore = [str(REPO_ROOT / "__init__.py")]
# 一次性复现/诊断脚本、开发工具、Node 测试目录都不作为 pytest 用例收集
collect_ignore += [
    str(TESTS_DIR / "repro"),
    str(TESTS_DIR / "tools"),
    str(TESTS_DIR / "js"),
    str(TESTS_DIR / "shots"),
]
