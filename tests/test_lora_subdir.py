"""TK 批量 LoRA 加载器的子目录标签兼容回归测试。

2026-09-13 改造：原理化逻辑写在模块顶层（含 assert）→ pytest 导入时执行且**失败不报告**；
且用 importlib 按文件路径加载，模块内的 `from . import anima_thumbs` 相对导入会 ImportError。
现改为：注入合成包（相对导入可用）+ 断言搬进 test 函数 + 去掉硬编码绝对路径。
"""
from __future__ import annotations

import importlib.util
import os
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

    aiohttp = types.ModuleType("aiohttp")
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
    expected = r"C:\models\Illustrious\NiffiV1.3-000018.safetensors"
    assert without_extension == expected, without_extension
    assert with_extension == expected, with_extension

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
