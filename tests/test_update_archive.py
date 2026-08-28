"""安全更新 ZIP 的隔离回归，不联网、不修改真实运行目录。"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import types
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


folder_paths = types.ModuleType("folder_paths")
folder_paths.get_input_directory = lambda: tempfile.gettempdir()
folder_paths.get_folder_paths = lambda _kind: [tempfile.gettempdir()]
sys.modules["folder_paths"] = folder_paths


class Routes:
    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn

    def delete(self, _path):
        return lambda fn: fn


server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=Routes()))
sys.modules["server"] = server


def stub_module(name: str):
    module = types.ModuleType(f"update_archive_test.{name}")
    module.NODE_CLASS_MAPPINGS = {}
    module.NODE_DISPLAY_NAME_MAPPINGS = {}
    if name == "anima_batch_lora":
        module.BRIDGE_DATA = {}
        module.BRIDGE_LOCK = types.SimpleNamespace()
        module.BRIDGE_PATH = ""
        module._find_lora_path = lambda _name: None
    sys.modules[module.__name__] = module


for _name in (
    "anima_batch_lora", "anima_trigger_words", "anima_camera_control", "anima_prompt_batch",
    "anima_text_join", "anima_preset_latent", "anima_danbooru_gallery", "anima_image_select",
    "anima_prompt_cards",
):
    stub_module(_name)
local_llm = types.ModuleType("update_archive_test.anima_local_llm")
sys.modules[local_llm.__name__] = local_llm


package = types.ModuleType("update_archive_test")
package.__path__ = [str(ROOT)]
package.__package__ = "update_archive_test"
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location(package.__name__, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
module = importlib.util.module_from_spec(spec)
sys.modules[package.__name__] = module
spec.loader.exec_module(module)


def make_archive(path: Path, *, include_required: bool = True):
    with zipfile.ZipFile(path, "w") as archive:
        if include_required:
            archive.writestr("comfyui-anima-toolkit-main/__init__.py", "new init")
            archive.writestr("comfyui-anima-toolkit-main/VERSION", "9.9.9\n")
        archive.writestr("comfyui-anima-toolkit-main/web/js/update.js", "new js")
        archive.writestr("comfyui-anima-toolkit-main/app/index.html", "new app")
        archive.writestr("comfyui-anima-toolkit-main/data/keep-me.json", "must not stage")
        archive.writestr("comfyui-anima-toolkit-main/models/keep-me.safetensors", "must not stage")


with tempfile.TemporaryDirectory(prefix="tk-update-archive-") as temp:
    temp_path = Path(temp)
    archive_path = temp_path / "update.zip"
    stage_path = temp_path / "stage"
    make_archive(archive_path)
    staged = module._stage_update_archive(str(archive_path), str(stage_path))
    staged_names = {relative.replace(os.sep, "/") for relative, _ in staged}
    assert {"__init__.py", "VERSION", "web/js/update.js", "app/index.html"} <= staged_names, staged_names
    assert not any(name.startswith("data/") or name.startswith("models/") for name in staged_names), staged_names

    plugin_path = temp_path / "plugin"
    (plugin_path / "data").mkdir(parents=True)
    (plugin_path / "data/keep-me.json").write_text(json.dumps({"keep": True}), encoding="utf-8")
    (plugin_path / "__init__.py").write_text("old init", encoding="utf-8")
    module.PLUGIN_DIR = str(plugin_path)
    assert module._apply_staged_update(staged) == len(staged)
    assert (plugin_path / "__init__.py").read_text(encoding="utf-8") == "new init"
    assert (plugin_path / "web/js/update.js").read_text(encoding="utf-8") == "new js"
    assert json.loads((plugin_path / "data/keep-me.json").read_text(encoding="utf-8"))["keep"] is True

    invalid_archive = temp_path / "invalid.zip"
    make_archive(invalid_archive, include_required=False)
    try:
        module._stage_update_archive(str(invalid_archive), str(temp_path / "invalid-stage"))
    except RuntimeError as error:
        assert "更新包结构无效" in str(error), error
    else:
        raise AssertionError("缺少必要文件的更新包未被拒绝")

print("PASS 更新 ZIP 只覆盖发布文件并保留 data/models")
print("PASS 更新 ZIP 缺少必要文件时拒绝")
