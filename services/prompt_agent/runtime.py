"""One host service, with per-session state and injectable provider at its seam."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from .config import ConfigStore
from .core import PromptAgent
from .creation import WORKFLOW_ID, WORKFLOW_VERSION
from .direct import CREATIVE_BASE as DIRECT_CREATIVE_BASE
from .profiles import ProfileRegistry, SECTION_LABELS
from .skills import SkillRegistry
from .providers import OpenAICompatibleProvider
from .native_config import NativeConfigSource
from .references import host_references
from .storage import BUILTIN_PRESETS, PresetStore, SessionStore, identifier, read_json, write_json


class Runtime:
    def __init__(self, directory: Path, *, native_source=None, native_executor=None):
        self.directory = directory
        self.config = ConfigStore(directory / "config.json")
        self.profiles = ProfileRegistry()
        # 扩写 skill：内置（复用 profile 规则）+ DSH skills 目录里的 SKILL.md
        self.skills = SkillRegistry(self.profiles)
        self.presets = PresetStore(directory / "presets.json")
        self.sessions = SessionStore(directory / "sessions")
        self.native_source = native_source or NativeConfigSource()
        from .native_execution import NativeExecutor
        self.native = native_executor or NativeExecutor(request_root=directory / "native-requests")
        from .connections import ConnectionManager
        self.connections = ConnectionManager(self)
        if native_source is None and native_executor is None:
            self.connections.apply_dsh(self.connections.dsh_settings())
        self.references = host_references(lambda: self.preferences().get("reference_mode", "local"))
        self.agent = PromptAgent(self.profiles, self.sessions, self.presets,
                                 lambda: OpenAICompatibleProvider(self.provider_config()), self.references,
                                 native_generator=self.native_generate,
                                 native_provider_factory=self.native_provider,
                                 request_provider_factory=self.request_provider)
        from .interrogation import InterrogationService
        self.interrogation = InterrogationService(self)
        from .execution import ExecutionCore
        self.execution = ExecutionCore(self)

    def native_settings(self) -> dict:
        return {"workspace": "", "agent_preset": "", "skill": "anima-prompt-universal",
                **read_json(self.directory / "native-runtime.json", {})}

    def save_native_settings(self, data: dict) -> dict:
        from .errors import AgentError
        names = {"workspace", "agent_preset", "skill"}
        if set(data) - names or any(not isinstance(value, str) or len(value) > 2048 for value in data.values()):
            raise AgentError("原生设置仅支持工作目录、Agent 预设和 skill 名称。")
        settings = {**self.native_settings(), **data}
        if settings["workspace"]:
            path = Path(settings["workspace"]).expanduser().resolve()
            if not path.is_dir():
                raise AgentError("DSH 工作目录不存在。")
            settings["workspace"] = str(path)
        write_json(self.directory / "native-runtime.json", settings)
        return settings

    async def native_meta(self, source=None) -> dict:
        from .errors import AgentError
        settings = self.native_settings()
        try:
            catalog = await self.native.catalog()
            workspaces = catalog["workspaces"]
            if isinstance(workspaces, dict):
                workspaces = workspaces.get("workspaces", [])
            rows = [{"path": row["path"], "label": row.get("name") or Path(row["path"]).name}
                    for row in workspaces if isinstance(row, dict) and isinstance(row.get("path"), str)]
            if not settings["workspace"]:
                # Discover the user's existing project skill; don't copy it or
                # bake a machine-specific directory into the implementation.
                suitable = [row["path"] for row in rows if settings["skill"] and
                            (Path(row["path"]) / ".dsh" / "skills" / settings["skill"] / "SKILL.md").is_file()]
                settings["workspace"] = suitable[0] if suitable else str(self.directory)
            if settings["workspace"] not in {row["path"] for row in rows}:
                rows.append({"path": settings["workspace"], "label": Path(settings["workspace"]).name})
            capabilities = catalog["capabilities"]
            presets = capabilities.get("presets", {})
            presets = presets.get("presets", []) if isinstance(presets, dict) else presets
            if not settings["agent_preset"]:
                settings["agent_preset"] = next((p["id"] for p in presets if p.get("isDefault")), "")
            source = source or self.preferences()["provider_source"]
            connection = (capabilities.get("models", {}).get("default", {}) if source == "dsh-active" else
                          self.native_source.describe(source) if source != "manual" else {})
            return {"available": True, "error": "", **settings, "workspaces": rows,
                    "presets": [{"id": p["id"], "name": p.get("name") or p["id"]} for p in presets],
                    "provider_source": source, "provider": connection.get("provider", ""),
                    "model": connection.get("model", "")}
        except AgentError as error:
            return {"available": False, "error": str(error), **settings, "workspaces": [], "presets": []}

    async def native_context(self, request=None):
        from .errors import AgentError
        selection = (request or {}).get("model_selection")
        if selection is not None and not isinstance(selection, dict):
            raise AgentError("模型选择必须是对象。")
        source = (selection or {}).get("source", "current")
        source = self.preferences()["provider_source"] if source == "current" else source
        if not isinstance(source, str) or not source.startswith("dsh-"):
            raise AgentError("DSH 原生模式请先选择 DSH 当前模型、WorkBuddy 或 OpenCode 连接。")
        if not self.connections.dsh_settings()["enabled"]:
            raise AgentError("DSH 接入已停用，请在连接管理中启用。")
        metadata = await self.native_meta(source)
        if not metadata["available"]:
            raise AgentError(metadata["error"])
        model = (selection or {}).get("model", "")
        if not isinstance(model, str) or len(model) > 256 or any(ord(c) < 32 for c in model):
            raise AgentError("模型 ID 无效。")
        model = model.strip()
        return metadata, {"id": source, "provider": metadata["provider"],
                          "model": model or metadata["model"], "model_override": bool(model)}

    async def native_generate(self, profile, state, request, preset):
        settings, connection = await self.native_context(request)
        return await self.native.generate(profile, state, request, preset, settings, connection)

    def native_provider(self, session_id, request):
        runtime = self
        class NativeProviderAdapter:
            workflow = None
            delegate = None

            async def complete(self, messages, schema):
                if self.delegate is None:
                    settings, connection = await runtime.native_context(request)
                    self.delegate = runtime.native.provider(settings, connection, session_id,
                                                            operation_id=request.get("native_operation_id", ""))
                reply = await self.delegate.complete(messages, schema)
                self.workflow = self.delegate.workflow
                return reply
        return NativeProviderAdapter()

    def preferences(self) -> dict:
        return {"reference_mode": "local", "provider_source": "manual", **read_json(self.directory / "preferences.json",
                {"active_provider": "", "default_preset": "default"})}

    def provider_config(self) -> dict:
        source = self.preferences()["provider_source"]
        stored = self.config.load()
        if source == "manual":
            return stored
        # The node owns request tuning; the native source owns its connection
        # identity, credential and provider-specific session header.
        overrides = {name: value for name, value in stored.items()
                     if name not in ("base_url", "model", "api_key_env", "api_key", "session_header")}
        return self.native_source.resolve(source, overrides)

    def model_config(self, selection=None) -> dict:
        """Resolve one node's public selection afresh; credentials never enter its workflow."""
        from .errors import AgentError
        from .native_config import transport_options
        from .execution import model_snapshot
        snapshot = model_snapshot()
        if snapshot is not None:
            return snapshot
        if selection is None:
            selection = {}
        if not isinstance(selection, dict):
            raise AgentError("模型选择必须是对象。")
        source, model = selection.get("source", "current"), selection.get("model", "")
        if not isinstance(source, str) or not isinstance(model, str) or len(model) > 256 or any(ord(c) < 32 for c in model):
            raise AgentError("模型连接或模型 ID 无效。")
        if source == "current":
            config = self.provider_config()
        elif source == "manual":
            config = self.config.load()
        elif source in ("dsh-active", "dsh-workbuddy", "dsh-opencode") or source.startswith("dsh-provider-"):
            config = self.native_source.resolve(source, transport_options(self.config.load()), **({"model": model} if model else {}))
        elif source in {item["id"] for item in self.provider_presets()}:
            config = ConfigStore(self.directory / "providers" / f"{identifier(source)}.json").load()
        elif source == "workbuddy" and (self.directory / "providers" / "workbuddy.json").is_file():
            config = {**ConfigStore(self.directory / "providers" / "workbuddy.json").load(),
                      **transport_options(self.config.load())}
        else:
            raise AgentError("所选模型连接不存在，请重新选择连接。")
        return {**config, **({"model": model.strip()} if model.strip() else {})}

    def request_provider(self, request):
        selection = request.get("model_selection")
        provider = OpenAICompatibleProvider(self.model_config(selection))
        provider.require_model_match = bool(selection and selection.get("model", "").strip())
        return provider

    def public_config(self) -> dict:
        return ConfigStore._public(self.provider_config())

    def save_config(self, data: dict) -> dict:
        from .errors import AgentError
        mode = data.get("reference_mode", self.preferences()["reference_mode"])
        if mode not in ("local", "online"):
            raise AgentError("资料核验模式必须是 local 或 online")
        local_connection = data.get("connection_scope") == "manual"
        update = {key: value for key, value in data.items() if key not in ("reference_mode", "connection_scope")}
        if not local_connection and self.preferences()["provider_source"] != "manual" and any(name in update for name in
                ("base_url", "model", "api_key_env", "api_key", "clear_api_key", "session_header")):
            raise AgentError("当前连接跟随 DSH；请在 DSH 修改模型或凭据，或切回本机独立配置。")
        if update:
            self.config.save(update)
        if "reference_mode" in data:
            write_json(self.directory / "preferences.json", {**self.preferences(), "reference_mode": mode})
        return {**(self.config.public() if local_connection else self.public_config()), "reference_mode": mode}

    def provider_presets(self) -> list[dict]:
        items = read_json(self.directory / "provider-presets.json", [])
        return [{**item, "config": ConfigStore(self.directory / "providers" / f"{identifier(item['id'])}.json").public()}
                for item in items]

    def save_provider_preset(self, preset_id: str, name: str, config: dict) -> None:
        preset_id = identifier(preset_id)
        ConfigStore(self.directory / "providers" / f"{preset_id}.json").save(config)
        path = self.directory / "provider-presets.json"
        items = [item for item in read_json(path, []) if item["id"] != preset_id]
        write_json(path, items + [{"id": preset_id, "name": name}])

    def activate_provider(self, preset_id: str) -> dict:
        from .errors import AgentError
        preset_id = identifier(preset_id)
        if preset_id == "manual" or preset_id.startswith("dsh-"):
            if preset_id != "manual":
                self.native_source.resolve(preset_id)
            write_json(self.directory / "preferences.json", {**self.preferences(), "provider_source": preset_id})
            return self.public_config()
        if preset_id not in {p["id"] for p in self.provider_presets()}:
            raise AgentError("Provider 配置预设不存在")
        stored = ConfigStore(self.directory / "providers" / f"{identifier(preset_id)}.json").load()
        if not stored.get("api_key"):
            stored["clear_api_key"] = True
        self.config.save(stored)
        write_json(self.directory / "preferences.json", {**self.preferences(), "active_provider": preset_id,
                                                       "provider_source": "manual"})
        return self.config.public()

    def meta(self) -> dict:
        from .errors import AgentError
        builtins = {p["id"] for p in BUILTIN_PRESETS}
        provider_error = ""
        try:
            config = self.public_config()
        except AgentError as error:
            # Settings must remain reachable to select another connection.
            # Actual generation still fails explicitly, without fallback.
            config, provider_error = self.config.public(), str(error)
        return {"profiles": [{"id": p.id, "label": p.data["label"], "style": p.data["style"],
                              "base_agent_prompt": p.data["base_agent_prompt"],
                              "direct_base_agent_prompt": DIRECT_CREATIVE_BASE}
                             for p in self.profiles.all()],
                # 扩写 skill 列表（内置 + DSH）；前端只暴露这一层，不再让用户选模型
                "skills": self.skills.list_public(),
                "sections": [{"id": name, "label": label} for name, label in SECTION_LABELS.items()],
                "presets": [{**p, "builtin": p["id"] in builtins} for p in self.presets.all()],
                "config": config, "manual_config": self.config.public(), "provider_presets": self.provider_presets(), **self.preferences(),
                "native_providers": self.native_source.public(), "provider_error": provider_error,
                "dsh_connection": self.connections.dsh_status(),
                "interrogation": self.interrogation.meta(),
                "creation_workflow": {"id": WORKFLOW_ID, "version": WORKFLOW_VERSION}}


def default_directory() -> Path:
    configured = os.environ.get("TK_PROMPT_AGENT_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    import folder_paths
    getter = getattr(folder_paths, "get_user_directory", None)
    user_dir = getter() if callable(getter) else None
    if not isinstance(user_dir, (str, os.PathLike)) or not user_dir:
        user_dir = Path(folder_paths.base_path) / "user"
    return Path(user_dir) / "tk_prompt_agent"


@lru_cache(maxsize=1)
def get_runtime() -> Runtime:
    # No model, client session, disk write or network activity during plugin import.
    return Runtime(default_directory())
