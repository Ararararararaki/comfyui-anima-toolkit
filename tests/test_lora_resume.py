"""LoRA 大文件断点续传回归测试：模拟断线、Range 追加和服务端忽略 Range。"""
from __future__ import annotations

import asyncio
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
    module = types.ModuleType(f"lora_resume_test.{name}")
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
sys.modules["lora_resume_test.anima_local_llm"] = types.ModuleType("lora_resume_test.anima_local_llm")

package = types.ModuleType("lora_resume_test")
package.__path__ = [str(ROOT)]
package.__package__ = "lora_resume_test"
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location(package.__name__, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
module = importlib.util.module_from_spec(spec)
sys.modules[package.__name__] = module
spec.loader.exec_module(module)


class FakeContent:
    def __init__(self, chunks):
        self.chunks = chunks

    async def iter_chunked(self, _size):
        for chunk in self.chunks:
            if isinstance(chunk, BaseException):
                raise chunk
            yield chunk


class FakeResponse:
    def __init__(self, status, headers, chunks):
        self.status = status
        self.headers = headers
        self.url = "https://cdn.example/model.safetensors"
        self.content = FakeContent(chunks)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, _url, **kwargs):
        self.calls.append(kwargs)
        return self.responses.pop(0)


async def exercise_resume(path: str):
    session = FakeSession([
        FakeResponse(206, {"Content-Range": "bytes 3-4/6", "Content-Length": "2"}, [b"de", module.aiohttp.ClientPayloadError("connection reset")]),
        FakeResponse(206, {"Content-Range": "bytes 5-5/6", "Content-Length": "1"}, [b"f"]),
    ])
    module._DOWNLOAD_PROGRESS["resume-test"] = {"status": "downloading"}
    original_sleep = module.asyncio.sleep
    module.asyncio.sleep = lambda *_args: original_sleep(0)
    try:
        result = await module._download_lora_part(session, "https://example/model", {}, {}, path, "resume-test", max_attempts=2)
    finally:
        module.asyncio.sleep = original_sleep
        module._DOWNLOAD_PROGRESS.pop("resume-test", None)
    return result, session.calls


with tempfile.TemporaryDirectory(prefix="tk-lora-resume-") as temp:
    part = os.path.join(temp, "model.safetensors.part")
    Path(part).write_bytes(b"abc")
    result, calls = asyncio.run(exercise_resume(part))
    assert Path(part).read_bytes() == b"abcdef"
    assert [call["headers"].get("Range") for call in calls] == ["bytes=3-", "bytes=5-"]
    assert result["done"] == 6 and result["total"] == 6 and result["resumed"] is True

    ignored = os.path.join(temp, "ignored.part")
    Path(ignored).write_bytes(b"old")
    session = FakeSession([FakeResponse(200, {"Content-Length": "6"}, [b"abcdef"])])
    module._DOWNLOAD_PROGRESS["ignore-test"] = {"status": "downloading"}
    try:
        result = asyncio.run(module._download_lora_part(session, "https://example/model", {}, {}, ignored, "ignore-test", max_attempts=1))
    finally:
        module._DOWNLOAD_PROGRESS.pop("ignore-test", None)
    assert Path(ignored).read_bytes() == b"abcdef"
    assert session.calls[0]["headers"]["Range"] == "bytes=3-"
    assert result["done"] == 6 and result["total"] == 6

def _test_lora_resume_script_regression():
    """原顶层自检段（逐行搬入，未改内容）。"""
    assert module._download_part_path("C:/models", "12345", "") == os.path.join("C:/models", ".anima-download-12345.part")
    print("PASS LoRA 断点续传 Range 追加、断线重试和忽略 Range 安全回退")

if __name__ == "__main__":
    _test_lora_resume_script_regression()


def test_test_lora_resume_script_regression():
    """把本文件的脚本自检接进 pytest。

    这些断言原本只在 `python test_lora_resume.py` 时执行，而 pytest 不跑 `__main__`，
    等于长期不在 CI 覆盖里。包装与直跑调用的是**同一个** `_test_lora_resume_script_regression()`，
    不会出现两套逻辑。
    """
    try:
        _test_lora_resume_script_regression()
    except SystemExit as exc:
        # 这类脚本用 sys.exit(0) 表示成功（自建 PASS/FAIL 计数器），
        # pytest 会把 SystemExit 当失败 —— 必须捕获并检查退出码。
        assert exc.code in (None, 0), f"脚本自检失败（exit={exc.code}）"

