"""Live, read-only connection settings from a DSH profile's static overrides.

This adapter reads the known WorkBuddy/pi-ai configuration seam. It does not
boot DSH, evaluate YAML ``!!js``, import plugins, or inherit DSH tools/prompts.
Connection identities and credentials remain owned by DSH; the node owns its
transport options. No native file or credential is ever copied to node storage.
"""
from __future__ import annotations

import io
import os
import re
from pathlib import Path

from .config import DEFAULT_CONFIG, ConfigError, validate_config

_LIMIT = 1024 * 1024
_IDENTITY_FIELDS = {"base_url", "model", "api_key_env", "api_key"}
_TRANSPORT_FIELDS = set(DEFAULT_CONFIG) - _IDENTITY_FIELDS
_SOURCE_ROUTES = {"dsh-workbuddy": "workbuddy", "dsh-opencode": "opencode-go"}
_DYNAMIC = object()


def transport_options(config):
    """Node tuning may follow a different native identity, never its credentials."""
    return {name: value for name, value in config.items()
            if name in _TRANSPORT_FIELDS and name != "session_header"}


def _read(path: Path, *, optional: bool = False) -> str:
    try:
        with path.open("rb") as stream:
            raw = stream.read(_LIMIT + 1)
        if len(raw) > _LIMIT:
            raise ConfigError("DSH 配置文件过大；请检查原生配置。")
        return raw.decode("utf-8-sig")
    except FileNotFoundError:
        if optional:
            return ""
        raise ConfigError("找不到 DSH 原生配置；请先在 DSH 配置模型。") from None
    except (OSError, UnicodeError):
        raise ConfigError("无法读取 DSH 原生配置。") from None


def _yaml(path: Path, *, optional: bool = False):
    text = _read(path, optional=optional)
    if not text:
        return None
    try:
        import yaml
    except ImportError:
        raise ConfigError("读取 DSH 原生配置需要 PyYAML。") from None

    class StaticLoader(yaml.SafeLoader):
        pass

    # Ignore expressions outside the supported connection seam. An expression
    # inside a required connection field is rejected by validation, never run.
    StaticLoader.add_constructor("tag:yaml.org,2002:js", lambda loader, node: _DYNAMIC)
    try:
        return yaml.load(text, Loader=StaticLoader)
    except (yaml.YAMLError, RecursionError):
        # YAML errors can echo credential lines: expose only this fixed message.
        raise ConfigError("DSH 原生配置不是可读取的 YAML。") from None


def _merge(before: dict, after: dict) -> dict:
    result = dict(before)
    for key, value in after.items():
        result[key] = (_merge(result[key], value)
                       if isinstance(value, dict) and isinstance(result.get(key), dict)
                       else value)
    return result


def _ref_value(mapping: dict, reference: str) -> object:
    if os.name == "nt":
        reference = reference.upper()
        return next((value for key, value in mapping.items()
                     if isinstance(key, str) and key.upper() == reference), None)
    return mapping.get(reference)


class NativeConfigSource:
    """Resolve a supported native source afresh for each operation.

    ``list()``/``public()`` contain only allowlisted metadata. ``resolve()`` is
    the private transport boundary and includes the key in memory only. The
    optional workspace supplies DSH's project-.env fallback, after stored refs.
    Only explicitly declared static overrides are supported; missing providers
    are never reconstructed from guessed defaults or bundled plugin code.
    """

    def __init__(self, home: Path | str | None = None, *, profile: str = "web",
                 workspace: Path | str | None = None):
        if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", profile):
            raise ConfigError("DSH profile 名称无效。")
        configured_home = os.environ.get("DSH_HOME", "").strip()
        self.home = Path(home if home is not None else configured_home or Path.home() / ".dsh").expanduser()
        self.profile = profile
        self.workspace = Path(workspace) if workspace is not None else Path.cwd()

    def _snapshot(self) -> tuple[dict, dict]:
        path = self.home / "profiles" / self.profile / "cordis.patch.yml"
        entries = _yaml(path)
        if not isinstance(entries, list):
            raise ConfigError("DSH profile 的 cordis.patch.yml 必须是配置条目列表。")
        known = {}
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                continue
            identifier = entry["id"]
            if identifier in {"agent-default-model", "llm-workbuddy", "llm-pi-ai"}:
                known[identifier] = _merge(known.get(identifier, {}), entry)
        active_entry = known.get("agent-default-model", {})
        active = active_entry.get("config", {}) if not active_entry.get("disabled") else {}
        if not isinstance(active, dict):
            active = {}
        providers = {}
        workbuddy = known.get("llm-workbuddy", {})
        if not workbuddy.get("disabled") and isinstance(workbuddy.get("config"), dict):
            providers["workbuddy"] = workbuddy["config"]
        pi_ai = known.get("llm-pi-ai", {})
        if not pi_ai.get("disabled") and isinstance(pi_ai.get("config"), dict):
            configured = pi_ai["config"].get("providers", {})
            if isinstance(configured, dict):
                for route, provider in configured.items():
                    if route == "opencode-go" and isinstance(provider, dict):
                        if provider.get("api") == "openai-completions":
                            providers[route] = provider
        return providers, active

    def _credential(self, reference: str) -> tuple[str, str]:
        # Official credentials-local order: inherited process > stored refs >
        # invocation project .env > DSH home .env. Empty values are absent.
        inherited = _ref_value(dict(os.environ), reference)
        if isinstance(inherited, str) and inherited:
            return inherited, "env"
        document = _yaml(self.home / ".credentials.yaml", optional=True)
        if document is not None:
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ConfigError("DSH 凭据存储格式不受支持；请在 DSH 更新配置。")
            refs = document.get("refs", {})
            if not isinstance(refs, dict):
                raise ConfigError("DSH 凭据 refs 格式无效。")
            stored = _ref_value(refs, reference)
            if isinstance(stored, str) and stored:
                return stored, "file"
            if stored is not None and not isinstance(stored, str):
                raise ConfigError("DSH 凭据引用必须是静态字符串。")
        for source, path in (("project-env", self.workspace / ".env"), ("user-env", self.home / ".env")):
            text = _read(path, optional=True)
            if not text:
                continue
            try:
                from dotenv import dotenv_values
            except ImportError:
                raise ConfigError("读取 DSH .env 凭据需要 python-dotenv。") from None
            # Parse values without interpolation, executing code, or modifying
            # the process environment. Never expose file contents on errors.
            values = dotenv_values(stream=io.StringIO(text), interpolate=False)
            value = _ref_value(values, reference)
            if isinstance(value, str) and value:
                return value, source
        return "", "unset"

    def _resolve(self, source_id: str, overrides: dict | None = None) -> tuple[dict, dict]:
        if source_id != "dsh-active" and source_id not in _SOURCE_ROUTES:
            raise ConfigError("未知的 DSH 模型配置来源。")
        providers, active = self._snapshot()
        route = active.get("provider") if source_id == "dsh-active" else _SOURCE_ROUTES[source_id]
        if not isinstance(route, str) or route not in providers:
            raise ConfigError("DSH 中未找到此来源的静态模型配置。")
        provider = providers[route]
        models = provider.get("models")
        if not isinstance(models, list):
            raise ConfigError("DSH 来源需要显式声明 models 列表。")
        model_ids = [item["id"] for item in models
                     if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]]
        if not model_ids:
            raise ConfigError("DSH 来源没有可用的静态模型。")
        if source_id == "dsh-active" or active.get("provider") == route:
            model = active.get("model")
            if not isinstance(model, str) or model not in model_ids:
                raise ConfigError("DSH 默认模型未出现在此来源的 models 中。")
        elif len(model_ids) == 1:
            model = model_ids[0]
        else:
            raise ConfigError("DSH 此来源有多个模型，请先在 DSH 选定默认模型。")
        reference = provider.get("apiKeyEnv")
        if not isinstance(reference, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", reference):
            raise ConfigError("DSH 来源需要静态 apiKeyEnv 凭据引用。")
        base_url = provider.get("baseURL")
        if not isinstance(base_url, str):
            raise ConfigError("DSH 来源需要静态 baseURL；本节点不会执行 !!js。")
        headers = provider.get("headers", {})
        if not isinstance(headers, dict) or any(str(name).lower() != "x-opencode-session" for name in headers):
            raise ConfigError("DSH 此来源的自定义 headers 需要专用传输适配器。")
        settings = {"base_url": base_url, "model": model, "api_key_env": reference,
                    "session_header": "x-opencode-session" if headers else ""}
        if overrides is not None:
            if not isinstance(overrides, dict) or set(overrides) - _TRANSPORT_FIELDS:
                raise ConfigError("DSH 来源仅允许覆盖节点传输参数，不能覆盖原生模型、地址或凭据。")
            settings.update(overrides)
        key, credential_source = self._credential(reference)
        settings["api_key"] = key
        normalized = validate_config(settings)
        metadata = {"id": source_id,
                    "name": "DSH 当前模型" if source_id == "dsh-active" else f"DSH {'WorkBuddy' if route == 'workbuddy' else 'OpenCode'}",
                    "provider": route, "model": normalized["model"], "base_url": normalized["base_url"],
                    "api_key_set": bool(normalized.get("api_key")), "credential_source": credential_source,
                    "config_source": f"DSH profiles/{self.profile}/cordis.patch.yml", "live": True,
                    "scope": "connection"}
        return normalized, metadata

    def resolve(self, source_id: str, overrides: dict | None = None) -> dict:
        return self._resolve(source_id, overrides)[0]

    def describe(self, source_id: str) -> dict:
        """Resolve a single live native identity without exporting credentials."""
        return self._resolve(source_id)[1]

    def list(self) -> list[dict]:
        """List only sources that can be resolved; no raw settings or keys."""
        result = []
        for identifier in ("dsh-active", *_SOURCE_ROUTES):
            try:
                result.append(self._resolve(identifier)[1])
            except ConfigError:
                continue
        return result

    def public(self) -> list[dict]:
        return self.list()
