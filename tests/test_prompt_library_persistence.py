"""Prompt 库服务端镜像的本地回归：合并、原子备份和损坏回退。

2026-09-13 改造：原来整段逻辑写在**模块顶层**（含 assert），pytest 导入时执行 →
失败不会被报告（静默假绿）；同时 importlib 直接按文件路径加载，
模块内的相对导入会炸。现改为：注入合成包 + 顶层只做导入，断言搬进 test 函数。
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load_module():
    """按「合成包内的子模块」加载 anima_prompt_library，让相对导入可用。"""
    routes = types.SimpleNamespace(
        get=lambda _path: (lambda fn: fn),
        post=lambda _path: (lambda fn: fn),
    )
    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
    sys.modules["server"] = server

    pkg_name = "tkpromptlib"
    if pkg_name not in sys.modules:
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(ROOT)]
        sys.modules[pkg_name] = pkg

    full = f"{pkg_name}.anima_prompt_library"
    sys.modules.pop(full, None)
    spec = importlib.util.spec_from_file_location(full, ROOT / "anima_prompt_library.py")
    assert spec and spec.loader, "无法为 anima_prompt_library 构造 loader"
    module = importlib.util.module_from_spec(spec)
    sys.modules[full] = module
    spec.loader.exec_module(module)
    return module


def test_prompt_library_merge_backup_and_corruption_fallback():
    """合并按 ID 保留双方条目；写盘生成备份；主文件损坏时可回退备份。

    ⚠️ 这里**必须**重定向 DATA_DIR 与 PROMPT_LIBRARY_PATH：早期实现把备份路径在导入时
    就固化成常量，测试改了主路径却仍把备份写到真实 data/（实测污染过仓库），
    同时让「回退备份」这条断言永远失败。现在生产代码改成现算，本测试即为该缺陷的回归。
    """
    module = _load_module()

    with tempfile.TemporaryDirectory(prefix="tk-prompt-library-") as temp:
        data_dir = Path(temp) / "data"
        module.DATA_DIR = str(data_dir)
        module.PROMPT_LIBRARY_PATH = str(data_dir / "prompt_library.json")
        primary = Path(module.PROMPT_LIBRARY_PATH)

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

        # 第一次写盘没有旧主文件 → 不产生备份；第二次写盘才轮换出 .bak.1
        newest_backup = data_dir / "prompt_library.json.bak.1"
        assert newest_backup.exists(), (
            f"第二次写盘应产出 .bak.1；实际 data 目录内容={sorted(p.name for p in data_dir.iterdir())}")
        # 备份必须落在**被重定向的**目录里，绝不能落到模块导入时的原始 data/
        assert newest_backup.parent == data_dir

        # 主文件损坏时，上一份原子备份仍可恢复。
        primary.write_text("{broken", encoding="utf-8")
        fallback, recovered = module.load_snapshot()
        assert recovered
        assert fallback and {i["id"] for i in fallback["prompts"]} == {"p_old"}

        module.save_snapshot({"prompts": [{"id": "p_recovered", "prompt": "recovered"}]})
        primary_after, _ = module.load_snapshot()
        assert primary_after and {i["id"] for i in primary_after["prompts"]} == {"p_recovered"}
        # 损坏的主文件不参与轮换 → 备份里保留的仍是最后一份已知good
        backup_after = module._read_file(str(newest_backup))
        assert backup_after is not None


if __name__ == "__main__":
    test_prompt_library_merge_backup_and_corruption_fallback()
    print("PASS Prompt 库镜像按 ID 合并且不因缺失记录而清空")
    print("PASS Prompt 库镜像主文件损坏时回退 .bak")
