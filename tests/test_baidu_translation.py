"""百度翻译 provider 配置与错误映射回归测试（不联网、不写入真实运行目录）。"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_folder_paths = lambda _kind: [tempfile.gettempdir()]
folder_paths.get_input_directory = lambda: tempfile.gettempdir()
sys.modules["folder_paths"] = folder_paths

server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(
    instance=types.SimpleNamespace(
        routes=types.SimpleNamespace(
            get=lambda _path: lambda fn: fn,
            post=lambda _path: lambda fn: fn,
            delete=lambda _path: lambda fn: fn,
        )
    )
)
sys.modules["server"] = server


def stub_module(name: str) -> None:
    module = types.ModuleType(f"baidu_translation_test.{name}")
    module.NODE_CLASS_MAPPINGS = {}
    module.NODE_DISPLAY_NAME_MAPPINGS = {}
    if name == "anima_batch_lora":
        module.BRIDGE_DATA = {}
        module.BRIDGE_LOCK = types.SimpleNamespace()
        module.BRIDGE_PATH = ""
        module._find_lora_path = lambda _name: None
    sys.modules[module.__name__] = module


for name in (
    "anima_batch_lora", "anima_trigger_words", "anima_camera_control", "anima_prompt_batch",
    "anima_text_join", "anima_preset_latent", "anima_danbooru_gallery", "anima_image_select",
    "anima_prompt_cards",
):
    stub_module(name)
sys.modules["baidu_translation_test.anima_local_llm"] = types.ModuleType("baidu_translation_test.anima_local_llm")

package = types.ModuleType("baidu_translation_test")
package.__path__ = [str(ROOT)]
package.__package__ = "baidu_translation_test"
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location(package.__name__, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
module = importlib.util.module_from_spec(spec)
sys.modules[package.__name__] = module
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="tk-baidu-config-") as temp:
    module._BAIDU_TRANSLATE_CONFIG_PATH = os.path.join(temp, "translation_providers.json")
    module._save_baidu_config({"appid": "appid-test", "api_key": "secret-test", "model_type": "nmt", "need_intervene": True})
    loaded = module._load_baidu_config()
    snapshot = module._baidu_config_snapshot()
    assert loaded == {"appid": "appid-test", "api_key": "secret-test", "model_type": "nmt", "need_intervene": True}
    assert snapshot == {
        "configured": True,
        "has_appid": True,
        "has_api_key": True,
        "model_type": "nmt",
        "need_intervene": True,
        "endpoint": module._BAIDU_TRANSLATE_ENDPOINT,
    }
    assert "secret-test" not in repr(snapshot)

assert module._baidu_language("zh-CN", "en") == "zh"
assert module._baidu_language("auto", "en") == "auto"
assert module._baidu_error_code("54001") == "authentication_error"
assert module._baidu_error_code("54003") == "upstream_rate_limit"
assert module._baidu_error_code("54004") == "quota_exhausted"
assert "baidu" in module._TRANSLATE_ORDER
print("PASS 百度翻译 provider 配置、隐私快照、语言和错误码映射")
