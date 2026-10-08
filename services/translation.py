"""Translation policies, provider health, cache/glossary storage and routes.

The host supplies directory, HTTP session, settings and proxy detection through
configure(). Importing this module never discovers the root module or starts a
process, opens a configuration file or registers an HTTP route.
"""
from __future__ import annotations

import asyncio
import csv
from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
import os
import re
import socket
import sqlite3
import subprocess
import threading
import time
import unicodedata

import aiohttp
from aiohttp import web

__all__ = ["configure", "register_routes"]

PLUGIN_DIR = ""
_configured = False
_session_getter = None
_settings_getter = None
_provider_order = None
_proxy_detector = None


async def _get_session():
    if not _configured:
        raise RuntimeError("Translation host is not configured")
    return await _session_getter()


def _translate_setting(path, default=None):
    if not _configured:
        raise RuntimeError("Translation host is not configured")
    return _settings_getter(path, default)


def _translate_fallback_order():
    if not _configured:
        raise RuntimeError("Translation host is not configured")
    return _provider_order()


def _detect_proxy():
    if not _configured:
        raise RuntimeError("Translation host is not configured")
    return _proxy_detector()

_DEEPLX_EXE = r"E:\1gongju\DeepLX\deeplx_windows_amd64.exe"


_DEEPLX_LOG = r"E:\1gongju\DeepLX\deeplx.log"


_DEEPLX_PID_FILE = os.path.join(PLUGIN_DIR, "data", "deeplx.pid")


class DeepLXManager:
    """DeepLX 本地进程的唯一管理者；只管理自己启动的进程。"""

    def __init__(self, exe: str, log_path: str, pid_file: str, port: int = 1188):
        self.exe = exe
        self.log_path = log_path
        self.pid_file = pid_file
        self.port = port
        self.process: subprocess.Popen | None = None
        self._start_lock: asyncio.Lock | None = None

    # ── 三级取值：设置文件 > 环境变量 > 源码常量 ──
    # 源码里的默认路径（E:\1gongju\DeepLX\...）只是本机安装位置，别的用户必然对不上，
    # 因此设置面板可覆盖；未配置时逐级回退，行为与改造前完全一致。
    def configured_exe(self) -> str:
        return str(_translate_setting("deeplx.exe_path") or os.environ.get("DEEPLX_EXE") or self.exe or "").strip()

    def configured_log(self) -> str:
        return str(_translate_setting("deeplx.log_path") or os.environ.get("DEEPLX_LOG") or self.log_path or "").strip()

    def configured_port(self) -> int:
        try:
            return int(_translate_setting("deeplx.port", self.port))
        except (TypeError, ValueError):
            return self.port

    def _listening_sync(self) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", self.configured_port()), timeout=0.4):
                return True
        except OSError:
            return False

    def _existing_pids_sync(self) -> list[int]:
        """发现同名 DeepLX 进程，避免只依赖本实例的 Popen 引用。"""
        if os.name != "nt":
            return []
        image_name = os.path.basename(self.configured_exe())
        if not image_name:
            return []
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {image_name}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=2,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
            pids: list[int] = []
            for row in csv.reader(result.stdout.splitlines()):
                if len(row) < 2 or row[0].casefold() != image_name.casefold():
                    continue
                try:
                    pids.append(int(row[1]))
                except ValueError:
                    continue
            return pids
        except (OSError, subprocess.SubprocessError, ValueError):
            return []

    def _write_pid(self, pid: int | None) -> None:
        try:
            if pid is None:
                if os.path.isfile(self.pid_file):
                    os.unlink(self.pid_file)
                return
            os.makedirs(os.path.dirname(self.pid_file), exist_ok=True)
            with open(self.pid_file, "w", encoding="utf-8") as f:
                f.write(str(pid))
        except OSError:
            pass

    def _start_sync(self) -> bool:
        if self._listening_sync():
            return True
        exe = self.configured_exe()
        if not exe or not os.path.isfile(exe):
            return False
        if self.process is not None and self.process.poll() is None:
            return self._listening_sync()
        existing_pids = self._existing_pids_sync()
        if existing_pids:
            # 同名进程可能仍在启动；等待它接管 1188，绝不再起第二个实例。
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                if self._listening_sync():
                    return True
                time.sleep(0.2)
            return False
        args = [exe]
        proxy = os.environ.get("DEEPLX_PROXY", "").strip() or _detect_proxy()
        if proxy:
            args.extend(["-proxy", proxy])
        log_path = self.configured_log() or os.devnull
        try:
            log_dir = os.path.dirname(log_path)
            if log_dir:
                os.makedirs(log_dir, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as log_file:
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                self.process = subprocess.Popen(
                    args,
                    cwd=os.path.dirname(exe),
                    stdin=subprocess.DEVNULL,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    creationflags=flags,
                )
            self._write_pid(self.process.pid)
        except (OSError, ValueError):
            self.process = None
            return False
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if self._listening_sync():
                return True
            time.sleep(0.2)
        return False

    async def ensure_started(self) -> bool:
        if self._listening_sync():
            return True
        if self._start_lock is None:
            self._start_lock = asyncio.Lock()
        async with self._start_lock:
            if self._listening_sync():
                return True
            return await asyncio.get_running_loop().run_in_executor(None, self._start_sync)

    def status_sync(self) -> dict[str, object]:
        listening = self._listening_sync()
        managed_running = self.process is not None and self.process.poll() is None
        existing_pids = self._existing_pids_sync()
        process_running = managed_running or bool(existing_pids)
        return {
            "installed": bool(os.path.isfile(self.configured_exe())),
            "listening": listening,
            "process_running": process_running,
            "managed": managed_running,
            "pid": self.process.pid if managed_running else (existing_pids[0] if existing_pids else None),
            "port": self.configured_port(),
            "exe": self.configured_exe(),
            "log": self.configured_log(),
        }

    def _stop_managed_sync(self) -> bool:
        if self.process is None or self.process.poll() is not None:
            return False
        try:
            self.process.terminate()
            self.process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            try:
                self.process.kill()
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass
        finally:
            self.process = None
            self._write_pid(None)
        return True

    async def restart(self) -> dict[str, object]:
        if self._start_lock is None:
            self._start_lock = asyncio.Lock()
        async with self._start_lock:
            stopped = await asyncio.get_running_loop().run_in_executor(None, self._stop_managed_sync)
            started = await asyncio.get_running_loop().run_in_executor(None, self._start_sync)
            return {"stopped": stopped, "started": started, **self.status_sync()}


_DEEPLX_MANAGER = DeepLXManager(_DEEPLX_EXE, _DEEPLX_LOG, _DEEPLX_PID_FILE)


async def _ensure_deeplx_started() -> bool:
    return await _DEEPLX_MANAGER.ensure_started()


_TRANSLATION_CACHE_TTL = 3600 * 24  # SQLite provider 缓存 1 天（内容稳定，省配额）


_TRANSLATE_DICT: dict | None = None


_TRANSLATE_DICT_MTIME = 0.0


_TRANSLATE_ORDER = ("local", "local_llm", "deeplx", "baidu", "mymemory", "google", "dashscope")


_TRANSLATION_DB_PATH = os.path.join(PLUGIN_DIR, "data", "translation_cache.sqlite3")


_TRANSLATOR_VERSION = "tk-translation-router-v1"


_BAIDU_TRANSLATE_ENDPOINT = "https://fanyi-api.baidu.com/ait/api/aiTextTranslate"


_BAIDU_TRANSLATE_CONFIG_PATH = os.path.join(PLUGIN_DIR, "data", "translation_providers.json")


_BAIDU_CONFIG_LOCK = threading.Lock()


def _dashscope_key() -> str:
    return str(_translate_setting("dashscope.api_key") or _get_env("DASHSCOPE_API_KEY") or "").strip()


def _dashscope_base() -> str:
    return str(_translate_setting("dashscope.base_url") or _get_env("DASHSCOPE_BASE_URL")
               or "https://dashscope.aliyuncs.com/compatible-mode/v1").strip()


def _dashscope_model() -> str:
    return str(_translate_setting("dashscope.model") or _get_env("DASHSCOPE_MODEL") or "qwen-turbo").strip()


class TranslationProviderError(RuntimeError):
    """可分类的 provider 错误；保留旧调用方可理解的字符串。"""

    def __init__(self, message: str, code: str = "provider_error"):
        super().__init__(message)
        self.code = code


@dataclass
class ProviderState:
    health: str = "unknown"
    last_success: float = 0.0
    last_error: str = ""
    error_code: str = ""
    success_count: int = 0
    failure_count: int = 0
    consecutive_failures: int = 0
    cooldown_until: float = 0.0
    latency_ms: float | None = None


_PROVIDER_STATES = {name: ProviderState() for name in _TRANSLATE_ORDER}


_PROVIDER_STATE_LOCK = threading.Lock()


_PROVIDER_COOLDOWN_SECONDS = {
    "not_found": 0,
    "unsupported": 0,
    "upstream_rate_limit": 480,
    "quota_exhausted": 3600,
    "account_arrears": 3600,
    "authentication_error": 1800,
    "model_permission_error": 3600,
    "service_unavailable": 45,
    "network_error": 60,
    "quality_rejected": 120,
    "provider_error": 60,
}


_LAST_TRANSLATION_PROVIDER = ""


_TRANSLATION_DB_READY = False


_TRANSLATION_DB_LOCK = threading.Lock()


def _normalize_translation_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    return re.sub(r"\s+", " ", text)


def _ensure_translation_db() -> None:
    global _TRANSLATION_DB_READY
    if _TRANSLATION_DB_READY:
        return
    with _TRANSLATION_DB_LOCK:
        if _TRANSLATION_DB_READY:
            return
        os.makedirs(os.path.dirname(_TRANSLATION_DB_PATH), exist_ok=True)
        with closing(sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5)) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS translation_cache (
                    cache_key TEXT PRIMARY KEY,
                    source_text TEXT NOT NULL,
                    normalized_source_text TEXT NOT NULL,
                    source_language TEXT NOT NULL,
                    target_language TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    translated_text TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    translator_version TEXT NOT NULL,
                    user_confirmed INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_translation_cache_lookup
                ON translation_cache(normalized_source_text, source_language, target_language, provider);
                CREATE TABLE IF NOT EXISTS prompt_glossary (
                    glossary_key TEXT PRIMARY KEY,
                    source_text TEXT NOT NULL,
                    normalized_source_text TEXT NOT NULL,
                    source_language TEXT NOT NULL,
                    target_language TEXT NOT NULL,
                    translated_text TEXT NOT NULL,
                    tag_text TEXT NOT NULL DEFAULT '',
                    timestamp REAL NOT NULL,
                    translator_version TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_prompt_glossary_lookup
                ON prompt_glossary(normalized_source_text, source_language, target_language);
            """)
        _TRANSLATION_DB_READY = True


def _translation_key(text: str, source_language: str, target_language: str, provider: str) -> str:
    raw = "|".join((_normalize_translation_text(text), source_language.lower(), target_language.lower(), provider.lower()))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _glossary_key(text: str, source_language: str, target_language: str) -> str:
    raw = "|".join((_normalize_translation_text(text), source_language.lower(), target_language.lower()))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _get_glossary(text: str, source_language: str, target_language: str) -> dict[str, str] | None:
    _ensure_translation_db()
    key = _glossary_key(text, source_language, target_language)
    with closing(sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5)) as db, db:
        row = db.execute(
            "SELECT translated_text, tag_text, translator_version FROM prompt_glossary WHERE glossary_key = ?",
            (key,),
        ).fetchone()
    if not row:
        return None
    return {"translated_text": str(row[0]), "tag_text": str(row[1] or ""), "translator_version": str(row[2] or "")}


def _put_glossary(text: str, source_language: str, target_language: str, translated: str, tag_text: str = "") -> None:
    _ensure_translation_db()
    now = time.time()
    with closing(sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5)) as db, db:
        db.execute(
            """INSERT INTO prompt_glossary
               (glossary_key, source_text, normalized_source_text, source_language, target_language,
                translated_text, tag_text, timestamp, translator_version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(glossary_key) DO UPDATE SET
                 source_text=excluded.source_text, translated_text=excluded.translated_text,
                 tag_text=excluded.tag_text, timestamp=excluded.timestamp,
                 translator_version=excluded.translator_version""",
            (_glossary_key(text, source_language, target_language), text, _normalize_translation_text(text),
             source_language, target_language, translated, tag_text, now, _TRANSLATOR_VERSION),
        )


def _get_provider_cache(text: str, source_language: str, target_language: str, provider: str) -> str | None:
    _ensure_translation_db()
    key = _translation_key(text, source_language, target_language, provider)
    with closing(sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5)) as db, db:
        row = db.execute(
            "SELECT translated_text, timestamp FROM translation_cache WHERE cache_key = ?",
            (key,),
        ).fetchone()
    if not row or float(row[1] or 0) + _TRANSLATION_CACHE_TTL <= time.time():
        return None
    return str(row[0])


def _put_provider_cache(text: str, source_language: str, target_language: str, provider: str, translated: str) -> None:
    _ensure_translation_db()
    now = time.time()
    with closing(sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5)) as db, db:
        db.execute(
            """INSERT INTO translation_cache
               (cache_key, source_text, normalized_source_text, source_language, target_language,
                provider, translated_text, timestamp, translator_version, user_confirmed)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
               ON CONFLICT(cache_key) DO UPDATE SET translated_text=excluded.translated_text,
                 timestamp=excluded.timestamp, translator_version=excluded.translator_version""",
            (_translation_key(text, source_language, target_language, provider), text,
             _normalize_translation_text(text), source_language, target_language, provider,
             translated, now, _TRANSLATOR_VERSION),
        )


def _get_env(name: str) -> str | None:
    """读环境变量；进程启动早于 setx 时从用户级注册表兜底（Windows）。"""
    v = os.environ.get(name)
    if v:
        return v
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            v, _ = winreg.QueryValueEx(k, name)
        return str(v) if v else None
    except Exception:
        return None


def _load_baidu_config() -> dict[str, object]:
    """读取百度翻译本机配置；密钥只在后端使用，不回传给前端。"""
    config: dict[str, object] = {}
    try:
        with open(_BAIDU_TRANSLATE_CONFIG_PATH, "r", encoding="utf-8") as file:
            raw = json.load(file)
        if isinstance(raw, dict):
            config = raw
    except (OSError, ValueError, TypeError):
        pass
    appid = str(config.get("appid") or _get_env("BAIDU_TRANSLATE_APPID") or "").strip()
    api_key = str(config.get("api_key") or _get_env("BAIDU_TRANSLATE_API_KEY") or "").strip()
    model_type = str(config.get("model_type") or "llm").strip().lower()
    if model_type not in {"llm", "nmt"}:
        model_type = "llm"
    return {
        "appid": appid[:200],
        "api_key": api_key[:500],
        "model_type": model_type,
        "need_intervene": bool(config.get("need_intervene", False)),
    }


def _save_baidu_config(config: dict[str, object]) -> None:
    with _BAIDU_CONFIG_LOCK:
        os.makedirs(os.path.dirname(_BAIDU_TRANSLATE_CONFIG_PATH), exist_ok=True)
        temp_path = _BAIDU_TRANSLATE_CONFIG_PATH + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as file:
            json.dump(config, file, ensure_ascii=False, indent=2)
        os.replace(temp_path, _BAIDU_TRANSLATE_CONFIG_PATH)


def _baidu_config_snapshot() -> dict[str, object]:
    config = _load_baidu_config()
    return {
        "configured": bool(config["appid"] and config["api_key"]),
        "has_appid": bool(config["appid"]),
        "has_api_key": bool(config["api_key"]),
        "model_type": config["model_type"],
        "need_intervene": config["need_intervene"],
        "endpoint": _BAIDU_TRANSLATE_ENDPOINT,
    }


def _baidu_language(value: str, default: str) -> str:
    language = str(value or default).strip().lower().replace("_", "-")
    if language in {"zh-cn", "zh-sg", "zh-hans"}:
        return "zh"
    if language in {"zh-tw", "zh-hk", "zh-hant"}:
        return "zh"
    if language in {"auto", "en", "zh", "ja", "ko", "fr", "de", "es", "ru"}:
        return language
    return language.split("-", 1)[0] or default


def _baidu_error_code(code: object) -> str:
    mapping = {
        "52001": "network_error",
        "52002": "service_unavailable",
        "52003": "authentication_error",
        "54000": "provider_error",
        "54001": "authentication_error",
        "54003": "upstream_rate_limit",
        "54004": "quota_exhausted",
        "54005": "upstream_rate_limit",
        "58000": "authentication_error",
        "58001": "unsupported",
        "58002": "service_unavailable",
        "58003": "authentication_error",
        "58004": "provider_error",
        "59002": "provider_error",
        "59003": "provider_error",
        "59004": "upstream_rate_limit",
        "59005": "provider_error",
        "59006": "provider_error",
        "59007": "provider_error",
        "90107": "authentication_error",
    }
    text = str(code)
    if text in {"401", "403"}:
        return "authentication_error"
    if text == "429":
        return "upstream_rate_limit"
    if text.isdigit() and 500 <= int(text) <= 599:
        return "network_error"
    return mapping.get(text, "provider_error")


def _provider_configured(provider: str) -> bool:
    if provider == "local":
        return bool(_load_translate_dict())
    if provider == "local_llm":
        from ..anima_local_llm import is_ready as _llm_ready
        return _llm_ready()
    if provider == "deeplx":
        # 与 DeepLXManager.configured_exe() 同一套取值（设置 > 环境变量 > 源码常量）：
        # 否则用户在「翻译设置」里填的自定义 exe 会被这里判成「未配置」，
        # 表现为面板显示 DeepLX 已安装/在监听，却永远不参与自动回退链。
        return os.path.isfile(_DEEPLX_MANAGER.configured_exe())
    if provider == "dashscope":
        return bool(_dashscope_key())
    if provider == "baidu":
        config = _load_baidu_config()
        return bool(config["appid"] and config["api_key"])
    # MyMemory/Google are keyless adapters; their health is learned on request.
    return True


def _classify_provider_error(error: BaseException) -> str:
    message = str(error).lower()
    if "arrearage" in message or "overdue" in message or "欠费" in message:
        return "account_arrears"
    if "unpurchased" in message or "accessdenied" in message or "model permission" in message or "无权限" in message:
        return "model_permission_error"
    if "quota" in message or "额度" in message or "all available free" in message:
        return "quota_exhausted"
    if "429" in message or "too many requests" in message or "rate limit" in message or "限流" in message:
        return "upstream_rate_limit"
    if "401" in message or "unauthorized" in message or "api key" in message or "鉴权" in message:
        return "authentication_error"
    if "未收录" in message or "not installed" in message or "unsupported" in message or "不支持" in message:
        return "not_found" if "未收录" in message or "not installed" in message else "unsupported"
    if "未启动" in message or "not found" in message or "cannot connect" in message or "connection refused" in message:
        return "service_unavailable"
    if "timeout" in message or "timed out" in message or "network" in message or "连接失败" in message:
        return "network_error"
    if "quality" in message or "译文质量" in message:
        return "quality_rejected"
    code = getattr(error, "code", "")
    if code:
        if str(code).endswith("_429"):
            return "upstream_rate_limit"
        if str(code).endswith("_401"):
            return "authentication_error"
        if str(code).endswith("_403"):
            return "model_permission_error"
        if str(code).endswith("_408") or re.search(r"_5\d\d$", str(code)):
            return "network_error"
        return str(code)
    return "provider_error"


def _provider_record_success(provider: str, latency_ms: float) -> None:
    global _LAST_TRANSLATION_PROVIDER
    now = time.time()
    with _PROVIDER_STATE_LOCK:
        state = _PROVIDER_STATES.setdefault(provider, ProviderState())
        state.health = "healthy"
        state.last_success = now
        state.last_error = ""
        state.error_code = ""
        state.success_count += 1
        state.consecutive_failures = 0
        state.cooldown_until = 0.0
        state.latency_ms = round(latency_ms, 1)
        _LAST_TRANSLATION_PROVIDER = provider


def _provider_record_failure(provider: str, error: BaseException, latency_ms: float) -> str:
    code = _classify_provider_error(error)
    cooldown = _PROVIDER_COOLDOWN_SECONDS.get(code, 60)
    now = time.time()
    with _PROVIDER_STATE_LOCK:
        state = _PROVIDER_STATES.setdefault(provider, ProviderState())
        state.health = "cooldown" if cooldown > 0 else "unhealthy"
        state.last_error = str(error)[:400]
        state.error_code = code
        state.failure_count += 1
        state.consecutive_failures += 1
        state.cooldown_until = now + cooldown
        state.latency_ms = round(latency_ms, 1)
    return code


def _provider_is_cooling(provider: str) -> bool:
    with _PROVIDER_STATE_LOCK:
        state = _PROVIDER_STATES.setdefault(provider, ProviderState())
        return state.cooldown_until > time.time()


def _provider_snapshot(provider: str) -> dict[str, object]:
    with _PROVIDER_STATE_LOCK:
        state = _PROVIDER_STATES.setdefault(provider, ProviderState())
        snapshot = {
            "health": state.health,
            "configured": _provider_configured(provider),
            "last_success": state.last_success or None,
            "last_error": state.last_error,
            "error_code": state.error_code,
            "success_count": state.success_count,
            "failure_count": state.failure_count,
            "success_rate": round(state.success_count / max(1, state.success_count + state.failure_count), 3),
            "consecutive_failures": state.consecutive_failures,
            "cooldown_until": state.cooldown_until or None,
            "cooldown_seconds": max(0, int(state.cooldown_until - time.time())),
            "latency_ms": state.latency_ms,
        }
    if provider == "deeplx":
        manager = _DEEPLX_MANAGER.status_sync()
        snapshot["manager"] = manager
        if manager["listening"] and snapshot["health"] == "unknown":
            snapshot["health"] = "healthy"
        elif not manager["listening"] and snapshot["error_code"] == "":
            snapshot["health"] = "service_unavailable"
            snapshot["error_code"] = "service_unavailable"
            snapshot["last_error"] = "DeepLX 未监听"
    return snapshot


def _provider_order_for(source: str) -> list[str]:
    if source != "auto":
        return [source]
    now = time.time()
    def sort_key(provider: str) -> tuple:
        with _PROVIDER_STATE_LOCK:
            state = _PROVIDER_STATES.setdefault(provider, ProviderState())
            cooling = state.cooldown_until > now
            health_rank = {"healthy": 0, "unknown": 1, "service_unavailable": 3, "cooldown": 4}.get(state.health, 2)
            latency = state.latency_ms if state.latency_ms is not None else 99999
            failures = state.consecutive_failures
            total = state.success_count + state.failure_count
            success_rate = state.success_count / max(1, total)
        # 本地词典与手动启用模型优先（命中即权威且质量可控）：
        # 词典 > 本地 LLM（已加载）> 网络源；health 只在其内部比较。
        local_rank = 0 if provider == "local" else (1 if provider == "local_llm" else 2)
        return (cooling, local_rank, health_rank, -success_rate, failures, latency, _TRANSLATE_ORDER.index(provider))
    # 「翻译设置」里勾选的源才参与自动回退（默认全选，链与旧行为完全一致）；
    # 关掉自动回退时只用第一个可用源，不再串到后面的源。
    allowed = set(_translate_fallback_order())
    candidates = [provider for provider in _TRANSLATE_ORDER if provider in allowed and _provider_configured(provider)]
    ordered = sorted(candidates, key=sort_key)
    if _translate_setting("allow_fallback") is False and ordered:
        return ordered[:1]
    return ordered


def _translation_quality(source_text: str, translated_text: str, source_lang: str, target_lang: str) -> dict[str, object]:
    source = str(source_text or "").strip()
    output = str(translated_text or "").strip()
    compact_source = re.sub(r"[\s\W_]+", "", unicodedata.normalize("NFKC", source).casefold())
    compact_output = re.sub(r"[\s\W_]+", "", unicodedata.normalize("NFKC", output).casefold())
    cjk = sum(1 for char in output if "\u4e00" <= char <= "\u9fff")
    latin = sum(1 for char in output if ("a" <= char.lower() <= "z"))
    letters = cjk + latin
    cjk_ratio = cjk / max(1, len(output.replace(" ", "")))
    latin_ratio = latin / max(1, letters)
    length_ratio = len(output) / max(1, len(source))
    fatal: list[str] = []
    warnings: list[str] = []
    low = output.casefold()
    if not output:
        fatal.append("empty_output")
    if re.match(r"^\s*(?:<!doctype|<html|<head|\{\s*[\"']?(?:error|message|status)|http\s*[/]?\d|502\b|429\b)", low):
        fatal.append("error_page_or_http_text")
    if compact_source and compact_source == compact_output and source_lang.casefold() != target_lang.casefold():
        fatal.append("same_as_input")
    target_is_en = target_lang.casefold().startswith("en")
    target_is_zh = target_lang.casefold().startswith("zh")
    if target_is_en and cjk_ratio > 0.20:
        fatal.append("cjk_residue")
    if target_is_en and output and latin_ratio < 0.18:
        warnings.append("low_english_ratio")
    if target_is_zh and output and cjk_ratio < 0.12:
        warnings.append("low_chinese_ratio")
    if len(source) >= 4 and (length_ratio < 0.05 or length_ratio > 12):
        warnings.append("length_anomaly")
    score = 1.0
    score -= 0.55 * len(fatal)
    score -= 0.12 * len(warnings)
    return {
        "status": "rejected" if fatal else ("warning" if warnings else "ok"),
        "score": round(max(0.0, min(1.0, score)), 3),
        "issues": fatal,
        "warnings": warnings,
        "cjk_ratio": round(cjk_ratio, 3),
        "latin_ratio": round(latin_ratio, 3),
        "length_ratio": round(length_ratio, 3),
    }


def _quality_error(quality: dict[str, object]) -> TranslationProviderError:
    issues = ", ".join(str(item) for item in quality.get("issues", [])) or "quality_check"
    return TranslationProviderError(f"译文质量检查未通过: {issues}", "quality_rejected")


def _load_translate_dict() -> dict:
    """本地 Danbooru 标签中文字典（data/danbooru_tags_zh.json，mtime+size 指纹热重载）。"""
    global _TRANSLATE_DICT, _TRANSLATE_DICT_MTIME
    for p in (
        os.path.join(PLUGIN_DIR, "data", "danbooru_tags_zh.json"),
        os.path.join(PLUGIN_DIR, "danbooru_tags_zh.json"),
    ):
        try:
            mtime = os.path.getmtime(p)
            size = os.path.getsize(p)
            if _TRANSLATE_DICT is not None and (mtime, size) == _TRANSLATE_DICT_MTIME:
                return _TRANSLATE_DICT
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            d = {str(k).strip().lower(): str(v) for k, v in data.items() if v}
            _TRANSLATE_DICT, _TRANSLATE_DICT_MTIME = d, (mtime, size)
            return d
        except OSError:
            continue
        except Exception as e:
            print(f"[Anima] 翻译词典加载失败 {p}: {e}")
            continue
    _TRANSLATE_DICT = {}
    return _TRANSLATE_DICT


def _deepl_langs(langpair: str) -> tuple[str, str]:
    """en|zh-CN → ("EN","ZH")；DeepLX/DeepL 用大写双字母码。"""
    src, _, dst = (langpair or "en|zh-CN").partition("|")
    m = {"en": "EN", "auto": "AUTO", "zh": "ZH", "zh-cn": "ZH", "zh-tw": "ZH",
         "ja": "JA", "ko": "KO", "fr": "FR", "de": "DE", "es": "ES", "ru": "RU"}
    return m.get(src.strip().lower(), src.strip().upper() or "AUTO"), \
        m.get(dst.strip().lower(), dst.strip().upper() or "ZH")


async def _translate_baidu(text: str, src_lang: str, dst_lang: str, config: dict[str, object] | None = None) -> str:
    """调用百度大模型文本翻译 API；使用 Bearer API Key，不把密钥暴露给前端。"""
    settings = config or _load_baidu_config()
    appid = str(settings.get("appid") or "").strip()
    api_key = str(settings.get("api_key") or "").strip()
    if not appid or not api_key:
        raise TranslationProviderError("百度翻译未配置 APPID 或 API Key", "not_configured")
    payload: dict[str, object] = {
        "appid": appid,
        "from": _baidu_language(src_lang, "auto"),
        "to": _baidu_language(dst_lang, "en"),
        "q": str(text or "")[:2000],
        "model_type": str(settings.get("model_type") or "llm"),
    }
    if bool(settings.get("need_intervene")):
        payload["needIntervene"] = 1
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.post(
                _BAIDU_TRANSLATE_ENDPOINT,
                json=payload,
                headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
            ) as response:
                status = response.status
                raw = await response.text()
    except Exception as error:
        raise TranslationProviderError(f"百度翻译连接失败: {error}", "network_error") from error
    try:
        body = json.loads(raw)
    except (TypeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    error_code = body.get("error_code")
    if status != 200 or error_code:
        code = str(error_code or status)
        message = str(body.get("error_msg") or body.get("message") or raw[:200]).strip()
        raise TranslationProviderError(f"百度翻译 {code}: {message}", _baidu_error_code(error_code or status))
    rows = body.get("trans_result")
    if not isinstance(rows, list):
        rows = (body.get("data") or {}).get("trans_result") if isinstance(body.get("data"), dict) else []
    translated = "".join(str(row.get("dst") or "") for row in rows if isinstance(row, dict)).strip()
    if translated:
        return translated
    raise TranslationProviderError("百度翻译返回空译文", "empty_output")


async def _translate_via(source: str, text: str, src_lang: str, dst_lang: str) -> str:
    """单源翻译；失败抛异常（自动链路靠异常切源）。"""
    if source == "local":
        hit = _load_translate_dict().get(text.strip().lower())
        if not hit:
            raise TranslationProviderError("本地词典未收录该词", "not_found")
        return hit

    if source == "local_llm":
        # 手动启用的本地翻译模型（TranslateGemma / NLLB，anima_local_llm.py）。
        # 推理放线程池，避免阻塞 ComfyUI 事件循环。
        from ..anima_local_llm import translate as _llm_translate
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, lambda: _llm_translate(text[:2000], src_lang, dst_lang)
            )
        except Exception as error:
            raise TranslationProviderError(f"本地 LLM 失败: {error}", "provider_error") from error
        if result and str(result).strip():
            return str(result).strip()
        raise RuntimeError("本地 LLM 返回空")

    if source == "deeplx":
        if not await _ensure_deeplx_started():
            raise RuntimeError("DeepLX 未启动且未找到可用的本地程序")
        sl, tl = _deepl_langs(f"{src_lang}|{dst_lang}")
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as s:
                async with s.post("http://127.0.0.1:1188/translate",
                                  json={"text": text[:2000], "source_lang": sl, "target_lang": tl}) as r:
                    raw = await r.text()
                    try:
                        body = json.loads(raw)
                    except (TypeError, ValueError):
                        body = {}
        except Exception as e:
            raise TranslationProviderError(f"DeepLX 连接失败: {e}", "service_unavailable") from e
        if r.status != 200:
            raise TranslationProviderError(f"DeepLX 上游 HTTP {r.status}: {raw[:160]}", f"upstream_http_{r.status}")
        if body.get("code") == 200 and body.get("data"):
            return str(body["data"])
        code = body.get("code", "?")
        raise TranslationProviderError(f"DeepLX 上游返回 {code}: {raw[:160]}", f"upstream_http_{code}")

    if source == "baidu":
        return await _translate_baidu(text, src_lang, dst_lang)

    if source == "mymemory":
        import urllib.parse
        url = ("https://api.mymemory.translated.net/get?q="
               + urllib.parse.quote(text[:500])
               + "&langpair=" + urllib.parse.quote(f"{src_lang}|{dst_lang}"))
        email = _get_env("MYMEMORY_EMAIL")
        if email:
            # 匿名池经常被耗尽；de= 邮箱参数走该邮箱独立免费额度（上限更高）
            url += "&de=" + urllib.parse.quote(email)
        session = await _get_session()
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as r:
            raw = await r.text()
            try:
                body = json.loads(raw)
            except (TypeError, ValueError):
                body = {}
        if r.status != 200:
            raise TranslationProviderError(f"MyMemory HTTP {r.status}: {raw[:160]}", f"upstream_http_{r.status}")
        if body.get("responseStatus") == 200 and body.get("responseData", {}).get("translatedText"):
            return str(body["responseData"]["translatedText"])
        raise TranslationProviderError(body.get("responseDetails") or f"MyMemory 状态 {body.get('responseStatus')}: {raw[:160]}", f"upstream_http_{body.get('responseStatus', '?')}")

    if source == "google":
        import urllib.parse
        url = ("https://translate.googleapis.com/translate_a/single?client=gtx"
               f"&sl={src_lang}&tl={dst_lang}&dt=t&q=" + urllib.parse.quote(text[:2000]))
        session = await _get_session()
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as r:
            raw = await r.text()
            try:
                data = json.loads(raw)
            except (TypeError, ValueError):
                data = []
        if r.status != 200:
            raise TranslationProviderError(f"Google HTTP {r.status}: {raw[:160]}", f"upstream_http_{r.status}")
        parts = []
        if isinstance(data, list) and data and isinstance(data[0], list):
            for row in data[0]:
                if isinstance(row, list) and row and row[0]:
                    parts.append(str(row[0]))
        if parts:
            return "".join(parts)
        raise TranslationProviderError("Google 返回空", "empty_output")

    if source == "dashscope":
        key = _dashscope_key()
        if not key:
            raise RuntimeError("未配置 DashScope API Key（可在「翻译设置 → 服务配置」里填写）")
        base = _dashscope_base().rstrip("/")
        model = _dashscope_model()
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content":
                 ("你是翻译助手。把用户给出的中文自然语言或图片标签翻译成英文，"
                  "保持原有结构，只输出译文，不要解释。" if dst_lang.lower().startswith("en") else
                  "你是翻译助手。把用户给出的英文图片标签/提示词翻译成简体中文，"
                  "保持原有结构（逗号分隔、括号、下划线等），只输出译文，不要解释。")},
                {"role": "user", "content": text[:4000]},
            ],
            "temperature": 0.1,
            "max_tokens": 2048,
        }
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as s:
                async with s.post(base + "/chat/completions", json=payload,
                                  headers={"Authorization": "Bearer " + key,
                                           "Content-Type": "application/json"}) as r:
                    raw = await r.text()
                    try:
                        body = json.loads(raw)
                    except (TypeError, ValueError):
                        body = {}
        except Exception as e:
            raise TranslationProviderError(f"DashScope 连接失败: {e}", "network_error") from e
        if r.status != 200:
            detail = body.get("error") if isinstance(body, dict) else raw[:160]
            if isinstance(detail, dict):
                detail = detail.get("message") or detail.get("code") or detail
            raise TranslationProviderError(f"DashScope HTTP {r.status}: {detail}", f"upstream_http_{r.status}")
        content = ((body.get("choices") or [{}])[0].get("message") or {}).get("content")
        if content:
            return str(content).strip()
        raise TranslationProviderError("DashScope 返回空", "empty_output")

    raise RuntimeError(f"未知翻译源: {source}")


_TAG_TRANSLATION_TRAILING = " \t.,;:!?，。；：、…·"


def _normalize_tag_translation(translated: str) -> str:
    """译文输出规范化（Prompt Cards 标签风格）：全小写、首字母不大写、末尾统一英文逗号。"""
    text = (translated or "").strip()
    if not text:
        return translated or ""
    text = text.lower().rstrip(_TAG_TRANSLATION_TRAILING)
    return text + ","


class TranslationRouter:
    """统一翻译入口：缓存、provider 选择、QA、熔断和可解释错误都在此处。"""

    @staticmethod
    def _effective_languages(source_text: str, source_language: str, target_language: str) -> tuple[str, str]:
        src = source_language.strip().lower() or "auto"
        dst = target_language.strip().lower() or "en"
        if src == "auto":
            src = "zh" if any("\u4e00" <= char <= "\u9fff" for char in source_text) else "en"
        return src, dst.split("-", 1)[0]

    @staticmethod
    def _success(source_text: str, translated: str, source_language: str, target_language: str,
                 provider: str, cache_type: str, attempts: dict[str, object] | None = None) -> dict[str, object]:
        translated = _normalize_tag_translation(translated)
        quality = _translation_quality(source_text, translated, source_language, target_language)
        return {
            "ok": True,
            "translatedText": translated,
            "source": provider,  # 兼容旧前端字段
            "provider": provider,
            "cacheType": cache_type,
            "fromCache": cache_type != "provider_call",
            "quality": quality,
            "attempts": attempts or {},
        }

    async def translate(self, text: str, langpair: str, want: str = "auto") -> dict[str, object]:
        source_text = str(text or "").strip()
        raw_src, _, raw_dst = (langpair or "en|zh-CN").partition("|")
        source_language, target_language = self._effective_languages(source_text, raw_src or "auto", raw_dst or "en")
        glossary = _get_glossary(source_text, source_language, target_language)
        if glossary:
            result = self._success(source_text, glossary["translated_text"], source_language, target_language, "user_glossary", "glossary")
            result["tagText"] = glossary["tag_text"]
            return result

        attempts: dict[str, object] = {}
        order = _provider_order_for(want)
        if not order:
            return {"ok": False, "error": f"翻译源 {want} 未配置或不可用", "error_code": "not_configured", "provider": want,
                    "attempts": attempts, "provider_status": _provider_snapshot(want) if want in _PROVIDER_STATES else None, "canUseAuto": want != "auto"}
        for provider in order:
            if _provider_is_cooling(provider):
                snapshot = _provider_snapshot(provider)
                attempts[provider] = {
                    "status": "skipped",
                    "error_code": "cooldown",
                    "cooldown_seconds": snapshot.get("cooldown_seconds", 0),
                }
                continue
            if not _provider_configured(provider):
                attempts[provider] = {"status": "skipped", "error_code": "not_configured"}
                if want != "auto":
                    break
                continue
            # local（本地词典）零成本且词典热重载后应立即生效，不读不写 provider cache，
            # 否则旧词典时代的缓存译文会永久锁死新词条。
            # local_llm（本地模型）同样不读不写：模型延迟 ~5ms，缓存零收益；且 NLLB 时代
            # 曾以同名 provider 写入劣质译文（"he was tied to his legs,"），会毒化 gemma/qwen 实时输出。
            cached = _get_provider_cache(source_text, source_language, target_language, provider) if provider not in ("local", "local_llm") else None
            if cached:
                quality = _translation_quality(source_text, cached, source_language, target_language)
                if quality["status"] != "rejected":
                    _provider_record_success(provider, 0.0)
                    return self._success(source_text, cached, source_language, target_language, provider, "provider_cache", attempts)
            started = time.perf_counter()
            try:
                translated = await _translate_via(provider, source_text, source_language, target_language)
                quality = _translation_quality(source_text, translated, source_language, target_language)
                if quality["status"] == "rejected":
                    raise _quality_error(quality)
                latency = (time.perf_counter() - started) * 1000
                if provider not in ("local", "local_llm"):
                    _put_provider_cache(source_text, source_language, target_language, provider, translated.strip())
                _provider_record_success(provider, latency)
                return self._success(source_text, translated.strip(), source_language, target_language, provider, "provider_call", attempts)
            except Exception as error:
                latency = (time.perf_counter() - started) * 1000
                error_code = _provider_record_failure(provider, error, latency)
                attempts[provider] = {
                    "status": "failed",
                    "error_code": error_code,
                    "error": str(error)[:400],
                    "latency_ms": round(latency, 1),
                }
                if want != "auto":
                    break
        return {
            "ok": False,
            "error": "所有翻译源均失败" if want == "auto" else f"翻译源 {want} 失败",
            "error_code": next((v.get("error_code") for v in attempts.values() if isinstance(v, dict) and v.get("error_code")), "provider_error"),
            "provider": want,
            "attempts": attempts,
            "provider_status": _provider_snapshot(want) if want != "auto" else None,
            "canUseAuto": want != "auto",
        }


_TRANSLATION_ROUTER = TranslationRouter()


async def anima_baidu_translate_config_get(request):
    return web.json_response({"ok": True, **_baidu_config_snapshot()})


async def anima_baidu_translate_config_save(request):
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return web.json_response({"ok": False, "error": "body 必须是 JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body 必须是对象"}, status=400)
    current = _load_baidu_config()
    appid = str(body.get("appid") or "").strip()
    api_key = str(body.get("api_key") or "").strip()
    if appid:
        current["appid"] = appid[:200]
    elif body.get("clear_appid") is True:
        current["appid"] = ""
    if api_key:
        current["api_key"] = api_key[:500]
    elif body.get("clear_api_key") is True:
        current["api_key"] = ""
    model_type = str(body.get("model_type") or current.get("model_type") or "llm").strip().lower()
    if model_type not in {"llm", "nmt"}:
        return web.json_response({"ok": False, "error": "model_type 只能是 llm 或 nmt"}, status=400)
    current["model_type"] = model_type
    current["need_intervene"] = bool(body.get("need_intervene", current.get("need_intervene", False)))
    try:
        _save_baidu_config(current)
    except OSError as error:
        return web.json_response({"ok": False, "error": f"百度配置保存失败: {error}"}, status=500)
    return web.json_response({"ok": True, **_baidu_config_snapshot()})


async def anima_baidu_translate_test(request):
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    config = _load_baidu_config()
    for key in ("appid", "api_key"):
        value = str(body.get(key) or "").strip()
        if value:
            config[key] = value[:500 if key == "api_key" else 200]
    if body.get("model_type") in {"llm", "nmt"}:
        config["model_type"] = body["model_type"]
    if "need_intervene" in body:
        config["need_intervene"] = bool(body["need_intervene"])
    text = str(body.get("q") or "你好，世界").strip()[:2000]
    started = time.perf_counter()
    try:
        translated = await _translate_baidu(text, "auto", "en", config)
    except TranslationProviderError as error:
        _provider_record_failure("baidu", error, (time.perf_counter() - started) * 1000)
        return web.json_response({"ok": False, "error": str(error), "error_code": error.code}, status=502)
    except Exception as error:
        _provider_record_failure("baidu", error, (time.perf_counter() - started) * 1000)
        return web.json_response({"ok": False, "error": f"百度翻译测试失败: {error}", "error_code": "provider_error"}, status=502)
    _provider_record_success("baidu", (time.perf_counter() - started) * 1000)
    return web.json_response({"ok": True, "provider": "baidu", "translatedText": translated})


async def anima_translate_status(request):
    result = {
        "providers": {provider: _provider_snapshot(provider) for provider in _TRANSLATE_ORDER},
        "actual_provider": _LAST_TRANSLATION_PROVIDER or None,
        "auto_order": _provider_order_for("auto"),
        "deeplx": _DEEPLX_MANAGER.status_sync(),
        "baidu": _baidu_config_snapshot(),
    }
    try:
        from ..anima_local_llm import state_snapshot as _llm_state
        result["local_llm"] = _llm_state()
    except Exception:
        pass
    return web.json_response(result)


async def anima_translate_glossary_save(request):
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return web.json_response({"ok": False, "error": "请求体必须是 JSON"}, status=400)
    source_text = str(body.get("source_text") or "").strip() if isinstance(body, dict) else ""
    translated_text = str(body.get("translated_text") or "").strip() if isinstance(body, dict) else ""
    tag_text = str(body.get("tag_text") or "").strip() if isinstance(body, dict) else ""
    if not source_text or not translated_text:
        return web.json_response({"ok": False, "error": "source_text 和 translated_text 不能为空"}, status=400)
    source_language = str(body.get("source_language") or ("zh" if any("\u4e00" <= c <= "\u9fff" for c in source_text) else "en")).strip().lower()
    target_language = str(body.get("target_language") or "en").strip().lower().split("-", 1)[0]
    if len(source_text) > 1000 or len(translated_text) > 2000 or len(tag_text) > 2000:
        return web.json_response({"ok": False, "error": "词典内容过长"}, status=400)
    _put_glossary(source_text, source_language, target_language, translated_text, tag_text)
    return web.json_response({"ok": True, "source_text": source_text, "translated_text": translated_text, "tag_text": tag_text})


async def anima_translate_glossary_get(request):
    source_text = str(request.query.get("q") or "").strip()
    if not source_text:
        return web.json_response({"ok": True, "entry": None})
    source_language = str(request.query.get("source_language") or ("zh" if any("\u4e00" <= c <= "\u9fff" for c in source_text) else "en")).strip().lower()
    target_language = str(request.query.get("target_language") or "en").strip().lower().split("-", 1)[0]
    return web.json_response({"ok": True, "entry": _get_glossary(source_text, source_language, target_language)})


async def anima_translate_deeplx_restart(request):
    return web.json_response(await _DEEPLX_MANAGER.restart())


def _translate_settings_state() -> dict[str, object]:
    """统一设置面板要展示的实时状态（只读；任何一步失败都不能影响设置读写）。"""
    state: dict[str, object] = {
        "providers": {provider: _provider_snapshot(provider) for provider in _TRANSLATE_ORDER},
        "deeplx": _DEEPLX_MANAGER.status_sync(),
        "baidu": _baidu_config_snapshot(),
    }
    try:
        from ..anima_local_llm import TRANSLATORS_DIR as _translators_dir
        from ..anima_local_llm import state_snapshot as _llm_state
        state["local_llm"] = {**_llm_state(), "models_dir": _translators_dir}
    except Exception:
        pass
    return state


async def anima_translate_glossary_list(request):
    """用户词典列表（旧接口只能按词查单条，前端无法浏览/纠错）。"""
    _ensure_translation_db()
    try:
        limit = int(request.query.get("limit") or 500)
    except (TypeError, ValueError):
        limit = 500
    limit = max(1, min(2000, limit))
    with closing(sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5)) as db, db:
        rows = db.execute(
            "SELECT glossary_key, source_text, translated_text, tag_text, source_language, target_language, timestamp"
            " FROM prompt_glossary ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        ).fetchall()
        total = db.execute("SELECT COUNT(*) FROM prompt_glossary").fetchone()[0]
    entries = [
        {
            "id": row[0],
            "source_text": row[1],
            "translated_text": row[2],
            "tag_text": row[3],
            "source_language": row[4],
            "target_language": row[5],
            "timestamp": row[6],
        }
        for row in rows
    ]
    return web.json_response({"ok": True, "entries": entries, "total": int(total or 0)})


async def anima_translate_glossary_delete(request):
    """按 id（glossary_key）删除一条用户词典条目。"""
    key = str(request.query.get("id") or "").strip()
    if not key:
        return web.json_response({"ok": False, "error": "缺少 id 参数"}, status=400)
    _ensure_translation_db()
    with closing(sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5)) as db, db:
        cursor = db.execute("DELETE FROM prompt_glossary WHERE glossary_key = ?", (key,))
        removed = cursor.rowcount
    return web.json_response({"ok": True, "removed": max(0, int(removed or 0))})


async def anima_translate_cache_clear(request):
    """清空翻译缓存表（机翻结果缓存，删掉只是下次重新请求）。"""
    _ensure_translation_db()
    with closing(sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5)) as db, db:
        cursor = db.execute("DELETE FROM translation_cache")
        removed = cursor.rowcount
    return web.json_response({"ok": True, "removed": max(0, int(removed or 0))})


async def proxy_translate(request):
    """多源翻译。参数：q 文本；langpair 如 en|zh-CN；source=auto|local|local_llm|deeplx|mymemory|google|dashscope
    （缺省 auto=按健康度/延迟动态回退；指定 source 始终只用该源）。
    返回 {ok, translatedText, source, attempts}。"""
    q = (request.query.get("q") or "").strip()
    if not q:
        return web.json_response({"ok": False, "error": "缺少 q 参数"}, status=400)
    langpair = request.query.get("langpair") or "en|zh-CN"
    want = (request.query.get("source") or "auto").strip().lower() or "auto"
    if want != "auto" and want not in _TRANSLATE_ORDER:
        return web.json_response({"ok": False, "error": f"未知翻译源: {want}"}, status=400)
    src_lang, dst_lang = langpair.split("|", 1) if "|" in langpair else ("en", "zh-CN")
    result = await _TRANSLATION_ROUTER.translate(q, langpair, want)
    return web.json_response(result, status=200 if result.get("ok") else 502)


def configure(*, plugin_dir, session_getter, settings_getter, provider_order, proxy_detector):
    """Bind a host without I/O; reconfiguring the same host preserves its state.

    session_getter is asynchronous; settings_getter accepts (path, default),
    provider_order and proxy_detector are zero-argument callbacks. Paths remain
    the plugin's existing data directory. A different directory resets only this
    module's in-memory provider/cache state, as in a fresh plugin load.
    """
    global PLUGIN_DIR, _configured, _session_getter, _settings_getter, _provider_order, _proxy_detector
    global _TRANSLATION_DB_PATH, _BAIDU_TRANSLATE_CONFIG_PATH, _DEEPLX_PID_FILE, _DEEPLX_MANAGER
    global _TRANSLATION_DB_READY, _TRANSLATE_DICT, _TRANSLATE_DICT_MTIME
    global _PROVIDER_STATES, _LAST_TRANSLATION_PROVIDER
    for name, dependency in (("session_getter", session_getter), ("settings_getter", settings_getter),
                             ("provider_order", provider_order), ("proxy_detector", proxy_detector)):
        if not callable(dependency):
            raise TypeError(name + " must be callable")
    directory = os.path.abspath(os.fspath(plugin_dir))
    if not _configured or directory != PLUGIN_DIR:
        PLUGIN_DIR = directory
        _TRANSLATION_DB_PATH = os.path.join(directory, "data", "translation_cache.sqlite3")
        _BAIDU_TRANSLATE_CONFIG_PATH = os.path.join(directory, "data", "translation_providers.json")
        _DEEPLX_PID_FILE = os.path.join(directory, "data", "deeplx.pid")
        _DEEPLX_MANAGER = DeepLXManager(_DEEPLX_EXE, _DEEPLX_LOG, _DEEPLX_PID_FILE)
        _TRANSLATION_DB_READY = False
        _TRANSLATE_DICT = None
        _TRANSLATE_DICT_MTIME = 0.0
        _PROVIDER_STATES = {name: ProviderState() for name in _TRANSLATE_ORDER}
        _LAST_TRANSLATION_PROVIDER = ""
    _session_getter, _settings_getter = session_getter, settings_getter
    _provider_order, _proxy_detector = provider_order, proxy_detector
    _configured = True


def register_routes(routes):
    """Register the unchanged translation wire contract after configure()."""
    if not _configured:
        raise RuntimeError("Translation host is not configured")
    routes.get('/anima/translate/baidu/config')(anima_baidu_translate_config_get)
    routes.post('/anima/translate/baidu/config')(anima_baidu_translate_config_save)
    routes.post('/anima/translate/baidu/test')(anima_baidu_translate_test)
    routes.get('/anima/translate/status')(anima_translate_status)
    routes.post('/anima/translate/glossary')(anima_translate_glossary_save)
    routes.get('/anima/translate/glossary')(anima_translate_glossary_get)
    routes.post('/anima/translate/deeplx/restart')(anima_translate_deeplx_restart)
    routes.get('/anima/translate/glossary/list')(anima_translate_glossary_list)
    routes.delete('/anima/translate/glossary')(anima_translate_glossary_delete)
    routes.post('/anima/translate/cache/clear')(anima_translate_cache_clear)
    routes.get('/api/translate')(proxy_translate)
    from ..anima_translate_settings import register_routes as register_settings_routes
    register_settings_routes(routes, _translate_settings_state)
