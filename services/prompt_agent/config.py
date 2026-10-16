"""Validated provider settings and local-only API key storage."""
from __future__ import annotations

import base64
import ctypes
import ipaddress
import json
import math
import os
import re
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit

from .errors import AgentError


class ConfigError(AgentError):
    """An invalid setting or an unavailable secure key store."""


DEFAULT_CONFIG = {
    "base_url": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "temperature": 0.6,
    "max_tokens": 2048,
    "timeout": 60,
    "response_mode": "json_object",
    "stream": False,
    "disable_thinking": False,
    "session_header": "",
    "api_key_env": "TK_PROMPT_AGENT_API_KEY",
    "proxy": "http://127.0.0.1:7890",
}
_WINDOWS = os.name == "nt"
_MAX_CONFIG_BYTES = 64 * 1024
_MAX_KEY_LENGTH = 8192


def is_local_url(value: str) -> bool:
    """Only a literal loopback address or localhost bypasses the proxy."""
    try:
        hostname = urlsplit(value).hostname or ""
        if hostname.lower() == "localhost":
            return True
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _validate_url(value: object, field: str, *, optional: bool = False) -> str:
    if not isinstance(value, str):
        raise ConfigError(f"{field} 必须是 URL 字符串。")
    value = value.strip()
    if optional and not value:
        return ""
    if len(value) > 2048 or any(ord(char) <= 32 for char in value):
        raise ConfigError(f"{field} 不是有效的 URL。")
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise ConfigError(f"{field} 不是有效的 URL。") from None
    if (parts.scheme not in {"http", "https"} or not parts.hostname
            or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment or "?" in value or "#" in value
            or "\\" in value or port == 0):
        raise ConfigError(f"{field} 只接受 HTTP(S) URL，不能包含凭据、查询参数或片段。")
    if parts.scheme == "http" and not is_local_url(value):
        raise ConfigError(f"{field} 外部服务必须使用 HTTPS；HTTP 仅用于 localhost/loopback。")
    if field == "proxy" and parts.path not in {"", "/"}:
        raise ConfigError("proxy 不能包含路径。")
    return value.rstrip("/")


def _validate_key(value: object) -> str:
    if not isinstance(value, str):
        raise ConfigError("API key 必须是字符串。")
    value = value.strip()
    if len(value) > _MAX_KEY_LENGTH or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ConfigError("API key 长度或格式无效。")
    return value


def validate_config(value: dict) -> dict:
    """Normalize public settings without consulting environment credentials."""
    if not isinstance(value, dict):
        raise ConfigError("配置必须是 JSON 对象。")
    config = {**DEFAULT_CONFIG, **{key: value[key] for key in DEFAULT_CONFIG if key in value}}
    config["base_url"] = _validate_url(config["base_url"], "base_url")
    config["proxy"] = _validate_url(config["proxy"], "proxy", optional=True)
    model = config["model"]
    if not isinstance(model, str) or not model.strip() or len(model) > 256 or any(ord(c) < 32 for c in model):
        raise ConfigError("model 必须是非空模型名称（最多 256 个字符）。")
    config["model"] = model.strip()
    for field, minimum, maximum in (("temperature", 0, 2), ("timeout", 0.1, 600)):
        number = config[field]
        if (isinstance(number, bool) or not isinstance(number, (int, float))
                or not minimum <= number <= maximum or not math.isfinite(number)):
            raise ConfigError(f"{field} 必须在 {minimum} 到 {maximum} 之间。")
    tokens = config["max_tokens"]
    if isinstance(tokens, bool) or not isinstance(tokens, int) or not 1 <= tokens <= 65536:
        raise ConfigError("max_tokens 必须是 1 到 65536 之间的整数。")
    if (not isinstance(config["response_mode"], str)
            or config["response_mode"] not in {"json_schema", "json_object", "text"}):
        raise ConfigError("response_mode 必须是 json_schema、json_object 或 text。")
    for field in ("stream", "disable_thinking"):
        if not isinstance(config[field], bool):
            raise ConfigError(f"{field} 必须是布尔值。")
    session_header = config["session_header"]
    if not isinstance(session_header, str) or session_header.strip().lower() not in {"", "x-opencode-session", "x-session-id"}:
        raise ConfigError("session_header 仅接受空值、x-opencode-session 或 x-session-id。")
    config["session_header"] = session_header.strip().lower()
    env_name = config["api_key_env"]
    if not isinstance(env_name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", env_name):
        raise ConfigError("api_key_env 必须是有效的环境变量名称。")
    if "api_key" in value:
        config["api_key"] = _validate_key(value["api_key"])
    return config


def _dpapi(data: bytes, *, decrypt: bool) -> bytes:
    """Use the current Windows user, without UI or a machine-wide key."""
    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    try:
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
        function.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_void_p,
                             ctypes.POINTER(DataBlob), ctypes.c_void_p,
                             ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob)]
        function.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        source_buffer = ctypes.create_string_buffer(data)
        source = DataBlob(len(data), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
        output = DataBlob()
        if not function(ctypes.byref(source), None, None, None, None, 4, ctypes.byref(output)):
            raise OSError("DPAPI operation failed")
        try:
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            if decrypt:
                ctypes.memset(output.pbData, 0, output.cbData)
            kernel32.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))
    except Exception:
        operation = "解密" if decrypt else "加密"
        raise ConfigError(f"Windows DPAPI {operation} API key 失败；请使用当前 Windows 用户重新配置 key。") from None


def _encrypt_key(key: str) -> str:
    return base64.b64encode(_dpapi(key.encode("utf-8"), decrypt=False)).decode("ascii")


def _decrypt_key(value: object) -> str:
    if not isinstance(value, str) or len(value) > _MAX_CONFIG_BYTES:
        raise ConfigError("已保存的加密 API key 格式无效。")
    try:
        encrypted = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise ConfigError("已保存的加密 API key 格式无效。") from None
    try:
        return _validate_key(_dpapi(encrypted, decrypt=True).decode("utf-8"))
    except UnicodeError:
        raise ConfigError("已保存的加密 API key 无法读取；请重新配置 key。") from None


class ConfigStore:
    """One provider config file. Public data never contains a secret value."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.RLock()

    def _read(self) -> dict:
        try:
            with self.path.open("rb") as stream:
                payload = stream.read(_MAX_CONFIG_BYTES + 1)
        except FileNotFoundError:
            return {}
        except OSError:
            raise ConfigError("无法读取 Prompt Agent 配置文件。") from None
        if len(payload) > _MAX_CONFIG_BYTES:
            raise ConfigError("Prompt Agent 配置文件过大。")
        try:
            value = json.loads(payload.decode("utf-8"))
        except (UnicodeError, ValueError):
            raise ConfigError("Prompt Agent 配置文件不是有效的 UTF-8 JSON。") from None
        if not isinstance(value, dict):
            raise ConfigError("Prompt Agent 配置文件必须是 JSON 对象。")
        return value

    def load(self) -> dict:
        with self._lock:
            stored = self._read()
            config = validate_config(stored)
            env_key = _validate_key(os.environ.get(config["api_key_env"], ""))
            if env_key:
                key = env_key
            elif stored.get("key_encrypted"):
                if not _WINDOWS:
                    raise ConfigError("此 API key 使用 Windows DPAPI 保存；请在当前平台重新配置 key。")
                key = _decrypt_key(stored["key_encrypted"])
            else:
                key = _validate_key(stored.get("api_key", ""))
                if _WINDOWS and key:
                    raise ConfigError("Windows 配置文件中的 API key 必须使用 DPAPI 加密；请重新保存 key。")
            config["api_key"] = key
            return config

    @staticmethod
    def _public(config: dict) -> dict:
        return {**{key: config[key] for key in DEFAULT_CONFIG}, "api_key_set": bool(config.get("api_key"))}

    def public(self) -> dict:
        return self._public(self.load())

    def _write(self, value: dict) -> None:
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                if not _WINDOWS:
                    os.chmod(temporary, 0o600)
                json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        except (OSError, ValueError, TypeError):
            raise ConfigError("无法安全保存 Prompt Agent 配置文件。") from None
        finally:
            if temporary and os.path.exists(temporary):
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def save(self, update: dict) -> dict:
        if not isinstance(update, dict):
            raise ConfigError("配置更新必须是 JSON 对象。")
        allowed = set(DEFAULT_CONFIG) | {"api_key", "clear_api_key"}
        if set(update) - allowed:
            raise ConfigError("配置更新包含未知字段。")
        clear = update.get("clear_api_key", False)
        if not isinstance(clear, bool):
            raise ConfigError("clear_api_key 必须是布尔值。")
        key = _validate_key(update.get("api_key", ""))
        if clear and key:
            raise ConfigError("不能同时清除并设置 API key。")
        with self._lock:
            stored = self._read()
            safe_fields = {name: stored[name] for name in DEFAULT_CONFIG if name in stored}
            safe_fields.update({name: update[name] for name in DEFAULT_CONFIG if name in update})
            config = validate_config(safe_fields)
            if not clear:
                if key:
                    if _WINDOWS:
                        config["key_encrypted"] = _encrypt_key(key)
                    else:
                        config["api_key"] = key
                elif stored.get("key_encrypted"):
                    config["key_encrypted"] = stored["key_encrypted"]
                elif stored.get("api_key"):
                    old_key = _validate_key(stored["api_key"])
                    if _WINDOWS:
                        config["key_encrypted"] = _encrypt_key(old_key)
                    else:
                        config["api_key"] = old_key
            self._write(config)
            return self.public()
