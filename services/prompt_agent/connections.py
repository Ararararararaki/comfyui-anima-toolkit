"""User-managed API connections and explicit, local DSH discovery settings."""
from __future__ import annotations

import os
from pathlib import Path
import uuid

from .config import ConfigStore, validate_config
from .errors import AgentError
from .native_config import NativeConfigSource
from .native_execution import NativeExecutor
from .providers import OpenAICompatibleProvider
from .storage import identifier, read_json, write_json


class ConnectionManager:
    def __init__(self, runtime):
        self.runtime = runtime
        self.path = runtime.directory / "dsh-connection.json"

    def dsh_settings(self):
        return {"home": str(getattr(self.runtime.native_source, "home", os.environ.get("DSH_HOME", "").strip() or Path.home() / ".dsh")),
                "profile": getattr(self.runtime.native_source, "profile", os.environ.get("DSH_PROFILE", "").strip() or "web"), "descriptor": "",
                "enabled": True, **read_json(self.path, {})}

    def validate_dsh(self, data):
        if not isinstance(data, dict) or set(data) - {"home", "profile", "descriptor", "enabled"}:
            raise AgentError("DSH 接入仅支持目录、配置档、Relay 描述文件和启用状态。")
        settings = {**self.dsh_settings(), **data}
        if not isinstance(settings["enabled"], bool):
            raise AgentError("DSH 启用状态必须是布尔值。")
        for name in ("home", "profile", "descriptor"):
            if not isinstance(settings[name], str) or len(settings[name]) > 2048:
                raise AgentError("DSH 接入字段无效。")
            settings[name] = settings[name].strip()
        home = Path(settings["home"]).expanduser()
        if not home.is_absolute():
            raise AgentError("DSH 目录必须是 ComfyUI 所在机器的绝对路径。")
        settings["home"] = str(home)
        NativeConfigSource(home, profile=settings["profile"])
        if settings["descriptor"] and not Path(settings["descriptor"]).is_absolute():
            raise AgentError("Relay 描述文件必须使用绝对路径。")
        return settings

    def apply_dsh(self, settings):
        runtime = self.runtime
        runtime.native_source = NativeConfigSource(settings["home"], profile=settings["profile"])
        runtime.native_source.enabled = settings["enabled"]
        descriptor = settings["descriptor"] or str(Path(settings["home"]) / "plugins" / "dsh-relay" /
                                                   settings["profile"] / "relay-endpoint.json")
        # Keep the executor and its active operations; changing discovery only
        # affects subsequent runs. Each active operation owns its endpoint.
        runtime.native.descriptor = Path(descriptor)
        runtime.skills._dsh_dir = Path(settings["home"]) / "skills"
        runtime.skills.invalidate()

    def save_dsh(self, data):
        settings = self.validate_dsh(data)
        write_json(self.path, settings)
        self.apply_dsh(settings)
        return self.dsh_status()

    def dsh_status(self):
        settings = self.dsh_settings()
        source = self.runtime.native_source
        try:
            providers = source.public() if settings["enabled"] else []
            if hasattr(source, "_snapshot") and settings["enabled"]:
                providers, _ = source._snapshot()
            error = "" if providers else "未发现兼容的静态 API 连接；可检测 Relay 并使用 DSH 原生模式。"
        except AgentError as exc:
            error = str(exc)
        profiles = Path(settings["home"]) / "profiles"
        try:
            available = sorted(p.name for p in profiles.iterdir() if p.is_dir() and (p / "cordis.patch.yml").is_file())
        except OSError:
            available = []
        return {**settings, "profiles": available, "sources": source.public() if settings["enabled"] else [],
                "error": error, "relay_descriptor_exists": self.runtime.native.descriptor.is_file()}

    async def test_dsh(self, data):
        settings = self.validate_dsh(data)
        source = NativeConfigSource(settings["home"], profile=settings["profile"])
        descriptor = settings["descriptor"] or str(Path(settings["home"]) / "plugins" / "dsh-relay" /
                                                   settings["profile"] / "relay-endpoint.json")
        executor = NativeExecutor(self.runtime.directory / "native-requests", descriptor=descriptor)
        try:
            catalog = await executor.catalog()
            relay = {"available": True, "host_url": catalog["host_url"],
                     "models": catalog["capabilities"].get("models", {}), "error": ""}
        except AgentError as exc:
            relay = {"available": False, "error": str(exc)}
        return {"sources": source.public(), "relay": relay}

    def list(self):
        return {"connections": [{"id": "manual", "name": "本机默认 API", "config": self.runtime.config.public()},
                                 *self.runtime.provider_presets()], "dsh": self.dsh_status()}

    def save(self, data):
        if not isinstance(data, dict) or set(data) - {"id", "name", "config"}:
            raise AgentError("连接字段无效。")
        connection_id = data.get("id") or "api-" + uuid.uuid4().hex[:16]
        connection_id = identifier(connection_id)
        if connection_id == "current" or connection_id.startswith("dsh-"):
            raise AgentError("DSH 实时来源请在 DSH 接入中设置；API 连接不能使用保留 ID。")
        name = data.get("name", "").strip() if isinstance(data.get("name"), str) else ""
        if not name or len(name) > 100 or any(ord(c) < 32 for c in name):
            raise AgentError("请输入 1–100 字的连接名称。")
        config = data.get("config")
        if not isinstance(config, dict):
            raise AgentError("连接配置必须是对象。")
        if connection_id != "manual" and not str(config.get("model", "")).strip():
            raise AgentError("请填写此 API 连接的默认模型。")
        # Per-connection env references must not inherit another connection's
        # global key. ConfigStore already encrypts explicit keys on Windows.
        if connection_id == "manual":
            self.runtime.config.save(config)
        else:
            path = self.runtime.directory / "providers" / f"{connection_id}.json"
            if not path.exists():
                config = {"api_key_env": "TK_AGENT_KEY_" + connection_id.upper().replace("-", "_"), **config}
            self.runtime.save_provider_preset(connection_id, name, config)
        return {"id": connection_id, **self.list()}

    def delete(self, connection_id):
        connection_id = identifier(connection_id)
        if connection_id == "manual" or connection_id.startswith("dsh-"):
            raise AgentError("默认 API 连接不能删除；DSH 接入可停用。")
        path = self.runtime.directory / "provider-presets.json"
        rows = read_json(path, [])
        if not any(row["id"] == connection_id for row in rows):
            raise AgentError("连接不存在。")
        write_json(path, [row for row in rows if row["id"] != connection_id])
        config = self.runtime.directory / "providers" / f"{connection_id}.json"
        if config.exists():
            config.unlink()
        if self.runtime.preferences().get("provider_source") == connection_id:
            write_json(self.runtime.directory / "preferences.json", {**self.runtime.preferences(), "provider_source": "manual"})
        # Nodes retaining the deleted ID fail explicitly; never reroute them.
        return self.list()

    async def test(self, data):
        connection_id = data.get("id", "")
        update = data.get("config", {})
        if not isinstance(update, dict):
            raise AgentError("连接配置必须是对象。")
        stored = (self.runtime.model_config({"source": connection_id}) if connection_id else
                  {**self.runtime.config.load(), "api_key": "", "api_key_env": "TK_AGENT_TEST_KEY"})
        allowed = set(stored) | {"clear_api_key"}
        if set(update) - allowed:
            raise AgentError("连接配置包含未知字段。")
        config = validate_config({**stored, **{k: v for k, v in update.items() if k not in {"api_key", "clear_api_key"}}})
        if not isinstance(update.get("clear_api_key", False), bool):
            raise AgentError("clear_api_key 必须是布尔值。")
        config["api_key"] = ("" if update.get("clear_api_key") else update.get("api_key") or stored.get("api_key", ""))
        models = await OpenAICompatibleProvider(validate_config(config)).list_models()
        return {"ok": True, "models": models, "message": "已成功读取模型列表；尚未发起生成请求。"}
