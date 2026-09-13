"""TK 批量 LoRA 加载器的子目录标签兼容回归测试。

2026-09-13 改造：原理化逻辑写在模块顶层（含 assert）→ pytest 导入时执行且**失败不报告**；
且用 importlib 按文件路径加载，模块内的 `from . import anima_thumbs` 相对导入会 ImportError。
现改为：注入合成包（相对导入可用）+ 断言搬进 test 函数 + 去掉硬编码绝对路径。
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FILES = [r"Illustrious\NiffiV1.3-000018.safetensors", "styles/detail.safetensors"]


def _load_module():
    """按「合成包内的子模块」加载 anima_batch_lora，并 stub 掉 ComfyUI 运行时。"""
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_filename_list = lambda _kind: FILES
    folder_paths.get_full_path = lambda _kind, name: os.path.join("C:\\models", str(name).replace("/", "\\"))
    folder_paths.get_input_directory = lambda: os.path.join(str(ROOT), "input")
    folder_paths.get_output_directory = lambda: os.path.join(str(ROOT), "output")
    folder_paths.get_temp_directory = lambda: os.path.join(str(ROOT), "temp")
    folder_paths.get_folder_paths = lambda _name: [str(ROOT)]
    folder_paths.folder_names_and_paths = {}
    sys.modules["folder_paths"] = folder_paths

    comfy = types.ModuleType("comfy")
    comfy.sd = types.SimpleNamespace()
    comfy.utils = types.SimpleNamespace()
    sys.modules["comfy"] = comfy
    sys.modules["comfy.sd"] = comfy.sd
    sys.modules["comfy.utils"] = comfy.utils

    # ⚠️ 只在**真的缺失**时 stub aiohttp，缺失时也要补齐 ClientSession/ClientTimeout。
    #    原来无条件用空 ModuleType 覆盖 sys.modules["aiohttp"]，且不做还原 ——
    #    pytest 同 session 里后面的测试（如 test_update_archive）会 import __init__.py，
    #    而 __init__.py 模块级就写 `_PROXY_SESSION: aiohttp.ClientSession | None = None`
    #    → AttributeError: module 'aiohttp' has no attribute 'ClientSession'。
    #    这就是「单独跑绿、整套跑红」的测试间污染。
    if "aiohttp" not in sys.modules:
        aiohttp = types.ModuleType("aiohttp")
        aiohttp.__path__ = []
        aiohttp.ClientSession = type("ClientSession", (), {})
        aiohttp.ClientTimeout = type("ClientTimeout", (), {"__init__": lambda self, **k: None})
        aiohttp.web = types.SimpleNamespace(
            json_response=lambda *a, **k: None, Response=lambda *a, **k: None)
        sys.modules["aiohttp"] = aiohttp
        sys.modules["aiohttp.web"] = aiohttp.web

    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(
        instance=types.SimpleNamespace(
            routes=types.SimpleNamespace(
                get=lambda _path: (lambda fn: fn),
                post=lambda _path: (lambda fn: fn),
            )
        )
    )
    sys.modules["server"] = server

    pkg_name = "tklora"
    if pkg_name not in sys.modules:
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(ROOT)]
        sys.modules[pkg_name] = pkg

    full = f"{pkg_name}.anima_batch_lora"
    sys.modules.pop(full, None)
    spec = importlib.util.spec_from_file_location(full, ROOT / "anima_batch_lora.py")
    assert spec and spec.loader, "无法为 anima_batch_lora 构造 loader"
    module = importlib.util.module_from_spec(spec)
    sys.modules[full] = module
    spec.loader.exec_module(module)
    return module


def test_lora_syntax_and_subdir_resolution():
    """`<lora:...>` 解析、子目录名的正/反斜杠与带扩展名引用、列表项字段。"""
    module = _load_module()

    assert module._parse_lora_syntax(r"<lora:Illustrious\NiffiV1.3-000018:1.00>") == [
        {"name": r"Illustrious\NiffiV1.3-000018", "model_strength": 1.0, "clip_strength": 1.0}
    ]
    assert module._parse_lora_syntax(r"<lora:styles/detail:-0.75:-0.25>") == [
        {"name": "styles/detail", "model_strength": -0.75, "clip_strength": -0.25}
    ]

    without_extension = module._find_lora_path(r"Illustrious\NiffiV1.3-000018")
    with_extension = module._find_lora_path(r"illustrious/NiffiV1.3-000018.safetensors")
    # ⚠️ 断言必须与**平台无关**：
    #   stub 的 get_full_path 用 os.path.join("C:\\models", <filename>)，而这里传入的
    #   *文件名* 本身是 Windows 风格（`Illustrious\NiffiV1.3-...`，来自上面的 FILES），
    #   于是 Linux 上 join 出来的结果混了两种分隔符（`C:\models/Illustrious\...`）。
    #   这纯粹是测试夹具的产物，不是 _find_lora_path 的行为问题 —— 真实 ComfyUI 的
    #   filename_list 全用正斜杠，不会出现这种混合。
    #   所以这里只断言「同一目录 + 同名文件 + 两边解析到同一个结果」，
    #   不再硬编码分隔符（硬编码反斜杠会让本地绿、CI 红）。
    def _split_any(p: str) -> tuple[str, str]:
        parts = re.split(r"[\\/]+", p)
        return parts[-2], parts[-1]

    assert without_extension is not None, "未解析出 LoRA 路径"
    assert with_extension is not None, "未解析出 LoRA 路径"
    assert _split_any(without_extension) == ("Illustrious", "NiffiV1.3-000018.safetensors"), without_extension
    assert _split_any(with_extension) == ("Illustrious", "NiffiV1.3-000018.safetensors"), with_extension
    # 两种写法（反斜杠、正斜杠+带扩展名、忽略大小写）必须落到**同一个**文件
    assert without_extension == with_extension, (without_extension, with_extension)
    # 目录部分应指向 stub 给出的基目录（允许分隔符差异）
    assert re.split(r"[\\/]+", without_extension)[-3] == "models", without_extension

    assert module._normalize_lora_name(r"./Styles\Detail") == "styles/detail"

    listed = module._list_lora_entries()
    assert {item["relativePath"] for item in listed} == {
        "Illustrious/NiffiV1.3-000018.safetensors",
        "styles/detail.safetensors",
    }, listed
    assert next(i for i in listed if i["name"] == "styles/detail")["filename"] == "styles/detail.safetensors"


if __name__ == "__main__":
    test_lora_syntax_and_subdir_resolution()
    print("PASS TK LoRA 子目录标签支持反斜杠/正斜杠及带扩展名引用")
