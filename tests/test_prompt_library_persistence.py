"""Prompt 库服务端镜像的本地回归：合并、原子备份和损坏回退。"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path


class Routes:
    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn


server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=Routes()))
sys.modules["server"] = server

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("prompt_library_test", ROOT / "anima_prompt_library.py")
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


with tempfile.TemporaryDirectory(prefix="tk-prompt-library-") as temp:
    data_dir = Path(temp) / "data"
    module.DATA_DIR = str(data_dir)
    module.PROMPT_LIBRARY_PATH = str(data_dir / "prompt_library.json")
    module.PROMPT_LIBRARY_BACKUP_PATH = module.PROMPT_LIBRARY_PATH + ".bak"

    first = {
        "schemaVersion": 1,
        "categories": [{"id": "cat_old", "name": "旧分类"}],
        "prompts": [{"id": "p_old", "prompt": "old", "updatedAt": 10}],
    }
    module.save_snapshot(first)
    second = {
        "schemaVersion": 1,
        "categories": [{"id": "cat_new", "name": "新分类"}],
        "prompts": [{"id": "p_new", "prompt": "new", "updatedAt": 20}],
    }
    module.save_snapshot(module.merge_snapshots(module.load_snapshot()[0], second))
    snapshot, recovered = module.load_snapshot()
    assert not recovered
    assert {item["id"] for item in snapshot["categories"]} == {"cat_old", "cat_new"}
    assert {item["id"] for item in snapshot["prompts"]} == {"p_old", "p_new"}
    assert Path(module.PROMPT_LIBRARY_BACKUP_PATH).exists()

    # 主文件损坏时，上一份原子备份仍可恢复。
    Path(module.PROMPT_LIBRARY_PATH).write_text("{broken", encoding="utf-8")
    fallback, recovered = module.load_snapshot()
    assert recovered
    assert fallback and {item["id"] for item in fallback["prompts"]} == {"p_old"}
    module.save_snapshot({"prompts": [{"id": "p_recovered", "prompt": "recovered"}]})
    primary_after_recovery, _ = module.load_snapshot()
    backup_after_recovery = module._read_file(module.PROMPT_LIBRARY_BACKUP_PATH)
    assert primary_after_recovery and {item["id"] for item in primary_after_recovery["prompts"]} == {"p_recovered"}
    assert backup_after_recovery and {item["id"] for item in backup_after_recovery["prompts"]} == {"p_old"}

print("PASS Prompt 库镜像按 ID 合并且不因缺失记录而清空")
print("PASS Prompt 库镜像主文件损坏时回退 .bak")
