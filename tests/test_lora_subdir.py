"""TK 批量 LoRA 加载器的子目录标签兼容回归测试。"""
import importlib.util
import os
import sys
import types


FILES = [r"Illustrious\NiffiV1.3-000018.safetensors", "styles/detail.safetensors"]

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_filename_list = lambda _kind: FILES
folder_paths.get_full_path = lambda _kind, name: os.path.join("C:\\models", str(name).replace("/", "\\"))
sys.modules["folder_paths"] = folder_paths

comfy = types.ModuleType("comfy")
comfy.sd = types.SimpleNamespace()
comfy.utils = types.SimpleNamespace()
sys.modules["comfy"] = comfy
sys.modules["comfy.sd"] = comfy.sd
sys.modules["comfy.utils"] = comfy.utils

aiohttp = types.ModuleType("aiohttp")
aiohttp.web = types.SimpleNamespace(json_response=lambda *args, **kwargs: None, Response=lambda *args, **kwargs: None)
sys.modules["aiohttp"] = aiohttp
sys.modules["aiohttp.web"] = aiohttp.web

server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(
    instance=types.SimpleNamespace(
        routes=types.SimpleNamespace(
            get=lambda _path: lambda fn: fn,
            post=lambda _path: lambda fn: fn,
        )
    )
)
sys.modules["server"] = server

source = r"E:\claude program\ComfyUI-Anima-Batch-LoRA\anima_batch_lora.py"
spec = importlib.util.spec_from_file_location("anima_batch_lora_subdir_test", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

assert module._parse_lora_syntax(r"<lora:Illustrious\NiffiV1.3-000018:1.00>") == [
    {"name": r"Illustrious\NiffiV1.3-000018", "model_strength": 1.0, "clip_strength": 1.0}
]

without_extension = module._find_lora_path(r"Illustrious\NiffiV1.3-000018")
with_extension = module._find_lora_path(r"illustrious/NiffiV1.3-000018.safetensors")
assert without_extension == r"C:\models\Illustrious\NiffiV1.3-000018.safetensors", without_extension
assert with_extension == r"C:\models\Illustrious\NiffiV1.3-000018.safetensors", with_extension
assert module._normalize_lora_name(r"./Styles\Detail") == "styles/detail"
print("PASS TK LoRA 子目录标签支持反斜杠/正斜杠及带扩展名引用")
