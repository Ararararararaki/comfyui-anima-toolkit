"""运行时回归：本地 Argos 应可独立完成中文到英文翻译。"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

def get_json(params: dict[str, str]) -> tuple[int, dict]:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request("http://127.0.0.1:8188/api/translate?" + query)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


status, payload = get_json({"q": "双脚被绑着挂起", "langpair": "auto|en", "source": "argos"})
if status != 200:
    raise AssertionError(f"Argos 翻译请求失败：HTTP {status} {payload}")

translated = str(payload.get("translatedText") or "")
if not payload.get("ok") or not translated or any("\u4e00" <= ch <= "\u9fff" for ch in translated):
    raise AssertionError(f"Argos 未返回英文：{payload}")
print(f"PASS Argos zh->en: {translated}")
if payload.get("source") != "argos":
    raise AssertionError(f"翻译源回报不正确：{payload}")
print("PASS 翻译源标记为 argos")

cache_status, cache_payload = get_json({"q": "双脚被绑着挂起", "langpair": "auto|en", "source": "argos"})
if cache_status != 200 or cache_payload.get("cacheType") != "provider_cache":
    raise AssertionError(f"provider cache 未命中：{cache_status} {cache_payload}")
print("PASS provider cache hit")

auto_status, auto_payload = get_json({"q": "双脚被绑着挂起", "langpair": "auto|en"})
if auto_status != 200:
    raise AssertionError(f"自动回退请求失败：HTTP {auto_status} {auto_payload}")
if not auto_payload.get("ok") or auto_payload.get("source") != "argos":
    raise AssertionError(f"自动回退未使用 Argos：{auto_payload}")
print("PASS 自动回退到 Argos")

deeplx_status, deeplx_payload = get_json({"q": "双脚被绑着挂起", "langpair": "auto|en", "source": "deeplx"})
deeplx_error_code = deeplx_payload.get("error_code")
deeplx_provider_code = (deeplx_payload.get("provider_status") or {}).get("error_code")
if deeplx_status != 502 or deeplx_error_code not in {"upstream_rate_limit", "cooldown"} or (
    deeplx_error_code == "cooldown" and deeplx_provider_code != "upstream_rate_limit"
):
    raise AssertionError(f"DeepLX 上游 429 未正确分类：{deeplx_status} {deeplx_payload}")
print("PASS DeepLX 上游限流分类")

cooldown_status, cooldown_payload = get_json({"q": "双脚被绑着挂起", "langpair": "auto|en", "source": "deeplx"})
attempt = (cooldown_payload.get("attempts") or {}).get("deeplx") or {}
if cooldown_status != 502 or attempt.get("error_code") != "cooldown":
    raise AssertionError(f"DeepLX cooldown 未生效：{cooldown_status} {cooldown_payload}")
print("PASS DeepLX cooldown 跳过已知故障")
