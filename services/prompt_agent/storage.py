"""Bounded local sessions and editable instruction presets, outside workflows."""
from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from pathlib import Path

from .errors import AgentError, SessionConflict
from .profiles import SECTIONS


def identifier(value: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 80 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in value):
        raise AgentError("会话或预设 ID 无效")
    return value


def read_json(path: Path, default: object) -> object:
    if not path.exists():
        return copy.deepcopy(default)
    try:
        if path.stat().st_size > 2_000_000:
            raise AgentError("本地状态文件过大")
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise AgentError("本地状态文件损坏，请备份并检查配置目录") from error


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            json.dump(value, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        if os.name != "nt":
            temporary.chmod(0o600)
        os.replace(temporary, path)
    except OSError as error:
        raise AgentError("本地状态保存失败；本次编辑未确认") from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def empty_state(session_id: str) -> dict:
    return {"session_id": identifier(session_id), "revision": 0, "profile": "anima", "prompt": "", "prompt_skill": "",
            "sections": {name: [] for name in SECTIONS}, "locks": [], "history": [], "undo": [],
            "last_request": None, "retry_base": None, "needs_classification": False, "unclassified_prompt": ""}


def public_state(state: dict) -> dict:
    value = {key: copy.deepcopy(state[key]) for key in
             ("session_id", "revision", "profile", "prompt", "sections", "locks", "history")}
    value["prompt_skill"] = state.get("prompt_skill", "")
    return value


def snapshot(state: dict) -> dict:
    value = {key: copy.deepcopy(state[key]) for key in ("profile", "prompt", "sections", "locks", "history")}
    value["prompt_skill"] = state.get("prompt_skill", "")
    value["needs_classification"] = state.get("needs_classification", False)
    value["unclassified_prompt"] = state.get("unclassified_prompt", "")
    value["history"] = value["history"][-4:]
    return value


class SessionStore:
    def __init__(self, directory: Path):
        self.directory = directory
        self._guard = threading.Lock()
        self._busy: set[str] = set()

    def begin(self, session_id: str) -> None:
        identifier(session_id)
        with self._guard:
            if session_id in self._busy:
                raise SessionConflict("该会话正在编辑，请等待完成")
            self._busy.add(session_id)

    def end(self, session_id: str) -> None:
        with self._guard:
            self._busy.discard(session_id)

    def load(self, session_id: str) -> dict:
        value = read_json(self.directory / f"{identifier(session_id)}.json", empty_state(session_id))
        if not isinstance(value, dict) or value.get("session_id") != session_id or type(value.get("revision")) is not int:
            raise AgentError("会话状态无效")
        if (not isinstance(value.get("sections"), dict) or set(value["sections"]) != set(SECTIONS)
                or any(not isinstance(parts, list) or any(not isinstance(p, str) for p in parts)
                       for parts in value["sections"].values())
                or any(not isinstance(value.get(name), list) for name in ("history", "undo", "locks"))
                or not isinstance(value.get("prompt"), str)):
            raise AgentError("会话语义状态无效")
        value.setdefault("prompt_skill", "")
        if not isinstance(value["prompt_skill"], str):
            raise AgentError("会话扩写 Skill 无效")
        value.setdefault("needs_classification", False)
        value.setdefault("unclassified_prompt", value["prompt"] if value["needs_classification"] else "")
        return value

    def save(self, state: dict) -> None:
        from .execution import check_current
        check_current()
        write_json(self.directory / f"{identifier(state['session_id'])}.json", state)


BUILTIN_PRESETS = [
    {"id": "default", "name": "默认创作助手", "mode": "append", "instructions": ""},
    {"id": "concise", "name": "精简有效", "mode": "append", "instructions":
     "Favor a small number of concrete, visually effective details. Never add generic quality, texture or style terms unless requested."},
    {"id": "interaction", "name": "人物与环境互动", "mode": "append", "instructions":
     "When requested, improve physical interaction between the subject and environment with clear spatial relationships. Respect all preserved sections."},
]


class PresetStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()

    def all(self) -> list[dict]:
        with self._lock:
            custom = read_json(self.path, [])
            if not isinstance(custom, list) or len(custom) > 100:
                raise AgentError("预设文件无效")
            return copy.deepcopy(BUILTIN_PRESETS) + custom

    def get(self, preset_id: str) -> dict:
        for item in self.all():
            if item["id"] == (preset_id or "default"):
                return item
        raise AgentError("预设不存在，请重新选择")

    def save(self, update: dict) -> dict:
        import uuid
        item = {"id": identifier(update.get("id") or uuid.uuid4().hex),
                "name": update.get("name", ""), "mode": update.get("mode", "append"),
                "instructions": update.get("instructions", "")}
        if item["id"] in {p["id"] for p in BUILTIN_PRESETS}:
            raise AgentError("内置预设请另存为自定义预设")
        if not isinstance(item["name"], str) or not item["name"].strip() or len(item["name"]) > 120:
            raise AgentError("预设名称不能为空或过长")
        if item["mode"] not in ("append", "replace") or not isinstance(item["instructions"], str) or len(item["instructions"]) > 64000:
            raise AgentError("预设规则无效")
        with self._lock:
            custom = [p for p in self.all()[len(BUILTIN_PRESETS):] if p["id"] != item["id"]]
            if len(custom) >= 100:
                raise AgentError("最多保存 100 个自定义预设")
            write_json(self.path, custom + [item])
        return item

    def delete(self, preset_id: str) -> None:
        identifier(preset_id)
        if preset_id in {p["id"] for p in BUILTIN_PRESETS}:
            raise AgentError("不能删除内置预设")
        with self._lock:
            write_json(self.path, [p for p in self.all()[len(BUILTIN_PRESETS):] if p["id"] != preset_id])
