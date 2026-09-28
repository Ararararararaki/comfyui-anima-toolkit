"""统一翻译设置：data/translate_settings.json 的读写与 /anima/translate/settings 路由。

背景（2026-09-23 改造）：
    翻译相关配置此前散落在源码常量与环境变量里（DeepLX 可执行文件路径、端口、
    DashScope Key/Base URL/模型、Ollama 地址、出图代理），普通用户没有任何入口，
    换台机器就不可用。这里把所有可配置项集中到一份 JSON，并统一由
    「翻译设置」面板读写。

取值优先级（服务端）：
    设置文件 > 环境变量 > 源码常量。文件缺失或字段为空时逐级回退，因此
    未配置任何内容的用户行为与改造前完全一致。
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
SETTINGS_DIR = os.path.join(PLUGIN_DIR, "data")
SETTINGS_PATH = os.path.join(SETTINGS_DIR, "translate_settings.json")

_LOCK = threading.RLock()

# provider id 与 __init__.py 的 _TRANSLATE_ORDER 保持一致（不含 auto）
PROVIDER_IDS = ("local", "local_llm", "deeplx", "baidu", "mymemory", "google", "dashscope")

DEFAULTS: dict[str, Any] = {
    "default_source": "auto",
    "enabled_sources": list(PROVIDER_IDS),
    "allow_fallback": True,
    "timeout_ms": 20000,
    "auto_calibrate": True,
    "semantic_enabled": False,
    "llm_model": "gemma-4b",
    "weight_min": -2,
    "weight_max": 2,
    "deeplx": {"exe_path": "", "log_path": "", "port": 1188},
    "dashscope": {"api_key": "", "base_url": "", "model": ""},
    "ollama_base": "",
    "proxy": "",
}

_TEXT_LIMITS = {
    "deeplx.exe_path": 500,
    "deeplx.log_path": 500,
    "dashscope.api_key": 500,
    "dashscope.base_url": 300,
    "dashscope.model": 120,
    "ollama_base": 200,
    "proxy": 200,
    "llm_model": 80,
}


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_settings() -> dict[str, Any]:
    """读取设置（与默认值深合并）。文件损坏时回退默认值，不抛异常。"""
    with _LOCK:
        raw: dict[str, Any] = {}
        try:
            if os.path.exists(SETTINGS_PATH):
                with open(SETTINGS_PATH, "r", encoding="utf-8") as handle:
                    parsed = json.load(handle)
                if isinstance(parsed, dict):
                    raw = parsed
        except (OSError, ValueError):
            raw = {}
        return _deep_merge(DEFAULTS, raw)


def get_setting(path: str, default: Any = None) -> Any:
    """按点路径取值，例如 get_setting("deeplx.port", 1188)。"""
    node: Any = load_settings()
    for part in str(path or "").split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node if node not in (None, "") else default


def _clean_number(value: Any, low: float, high: float, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(low, min(high, number))


def _clean_text(value: Any, limit: int = 200) -> str:
    return str(value if value is not None else "").strip()[:limit]


def normalize_settings(patch: dict[str, Any], current: dict[str, Any] | None = None) -> dict[str, Any]:
    """把前端提交的字段规范成可信值；非法项回退到当前值或默认值。"""
    base = _deep_merge(DEFAULTS, current or load_settings())
    incoming = patch if isinstance(patch, dict) else {}

    merged = _deep_merge(base, {})

    if "default_source" in incoming:
        source = _clean_text(incoming.get("default_source"), 40) or "auto"
        merged["default_source"] = source if source == "auto" or source in PROVIDER_IDS else "auto"

    if "enabled_sources" in incoming:
        raw_list = incoming.get("enabled_sources")
        chosen: list[str] = []
        if isinstance(raw_list, (list, tuple)):
            for item in raw_list:
                pid = _clean_text(item, 40)
                if pid in PROVIDER_IDS and pid not in chosen:
                    chosen.append(pid)
        merged["enabled_sources"] = chosen or list(PROVIDER_IDS)

    for flag in ("allow_fallback", "auto_calibrate", "semantic_enabled"):
        if flag in incoming:
            merged[flag] = bool(incoming.get(flag))

    if "timeout_ms" in incoming:
        merged["timeout_ms"] = int(_clean_number(incoming.get("timeout_ms"), 3000, 120000, merged["timeout_ms"]))

    if "llm_model" in incoming:
        merged["llm_model"] = _clean_text(incoming.get("llm_model"), _TEXT_LIMITS["llm_model"]) or DEFAULTS["llm_model"]

    if "weight_min" in incoming:
        # 下限先取绝对值再夹到 [0.1, 10]，最后取负（前端允许填 -3、-0.5 这类负值）
        try:
            magnitude = abs(float(incoming.get("weight_min")))
        except (TypeError, ValueError):
            magnitude = abs(float(merged["weight_min"]))
        merged["weight_min"] = -round(_clean_number(magnitude, 0.1, 10, abs(float(merged["weight_min"]))), 2)
    if "weight_max" in incoming:
        merged["weight_max"] = round(abs(_clean_number(incoming.get("weight_max"), 0.1, 10, abs(merged["weight_max"]))), 2)

    if "deeplx" in incoming:
        deeplx = incoming.get("deeplx") or {}
        if isinstance(deeplx, dict):
            if "exe_path" in deeplx:
                merged["deeplx"]["exe_path"] = _clean_text(deeplx.get("exe_path"), _TEXT_LIMITS["deeplx.exe_path"])
            if "log_path" in deeplx:
                merged["deeplx"]["log_path"] = _clean_text(deeplx.get("log_path"), _TEXT_LIMITS["deeplx.log_path"])
            if "port" in deeplx:
                merged["deeplx"]["port"] = int(_clean_number(deeplx.get("port"), 1, 65535, merged["deeplx"]["port"]))

    if "dashscope" in incoming:
        dashscope = incoming.get("dashscope") or {}
        if isinstance(dashscope, dict):
            if "base_url" in dashscope:
                merged["dashscope"]["base_url"] = _clean_text(dashscope.get("base_url"), _TEXT_LIMITS["dashscope.base_url"])
            if "model" in dashscope:
                merged["dashscope"]["model"] = _clean_text(dashscope.get("model"), _TEXT_LIMITS["dashscope.model"])
            if "api_key" in dashscope:
                key = _clean_text(dashscope.get("api_key"), _TEXT_LIMITS["dashscope.api_key"])
                if key:
                    merged["dashscope"]["api_key"] = key

    # 敏感字段与清除标记走独立通道（前端 api_keys 子对象）
    keys = incoming.get("api_keys") if isinstance(incoming.get("api_keys"), dict) else {}
    if keys:
        dash_key = _clean_text(keys.get("dashscope_api_key"), _TEXT_LIMITS["dashscope.api_key"])
        if dash_key:
            merged["dashscope"]["api_key"] = dash_key
        if keys.get("dashscope_api_key_clear") is True:
            merged["dashscope"]["api_key"] = ""

    for text_key in ("ollama_base", "proxy"):
        if text_key in incoming:
            merged[text_key] = _clean_text(incoming.get(text_key), _TEXT_LIMITS[text_key])

    return merged


def save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    """规范化并落盘，返回写入后的完整设置（含密钥本体，供内部读取）。"""
    with _LOCK:
        merged = normalize_settings(patch if isinstance(patch, dict) else {})
        os.makedirs(SETTINGS_DIR, exist_ok=True)
        tmp_path = SETTINGS_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(merged, handle, ensure_ascii=False, indent=2)
        os.replace(tmp_path, SETTINGS_PATH)
        return merged


def public_settings() -> dict[str, Any]:
    """给前端的设置快照：密钥不回传，只给 has_* 布尔（沿用既有约定）。"""
    data = load_settings()
    public = json.loads(json.dumps(data))
    dashscope = public.setdefault("dashscope", {})
    dashscope["has_api_key"] = bool(str(dashscope.get("api_key") or "").strip())
    dashscope["api_key"] = ""
    return public


def provider_fallback_order() -> list[str]:
    """按设置裁剪后的自动回退顺序（未自定义时与源码常量一致）。"""
    order = [pid for pid in PROVIDER_IDS if pid in (get_setting("enabled_sources") or [])]
    return order or list(PROVIDER_IDS)


def register_routes(routes, state_provider: Callable[[], dict[str, Any]] | None = None) -> None:
    """注册 /anima/translate/settings 读写路由。

    state_provider 由插件主模块注入，返回 deeplx / baidu / local_llm / providers
    的实时状态；不传时只返回设置本身（面板会显示为「状态不可用」）。
    """
    from aiohttp import web

    def _snapshot() -> dict[str, Any]:
        payload: dict[str, Any] = {"ok": True, "settings": public_settings()}
        if state_provider is not None:
            try:
                payload["state"] = state_provider() or {}
            except Exception as error:  # 状态只影响展示，绝不能让设置读不出来
                payload["state"] = {"error": str(error)}
        return payload

    @routes.get("/anima/translate/settings")
    async def _translate_settings_get(request):  # noqa: ANN001 - aiohttp 约定
        return web.json_response(_snapshot())

    @routes.post("/anima/translate/settings")
    async def _translate_settings_post(request):  # noqa: ANN001 - aiohttp 约定
        try:
            body = await request.json()
        except (ValueError, AttributeError):
            return web.json_response({"ok": False, "error": "body 必须是 JSON"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"ok": False, "error": "body 必须是对象"}, status=400)
        try:
            save_settings(body)
        except OSError as error:
            return web.json_response({"ok": False, "error": f"设置保存失败: {error}"}, status=500)
        return web.json_response(_snapshot())


__all__ = [
    "DEFAULTS",
    "PROVIDER_IDS",
    "SETTINGS_PATH",
    "get_setting",
    "load_settings",
    "normalize_settings",
    "provider_fallback_order",
    "public_settings",
    "register_routes",
    "save_settings",
]
