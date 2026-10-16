"""Two public Gradio Space interrogators, without a gradio_client dependency.

API contracts were checked against both Space sources and /gradio_api/info.
The transport follows Gradio's upload + queue + SSE result protocol.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import uuid

import aiohttp

from ..errors import AgentError


SPACE_ENDPOINTS = {
    "pixai-online": ("https://pixai-labs-pixai-tagger-demo.hf.space", "tag"),
    "toriigate-online": ("https://minthy-toriigate-0-5-gradio.hf.space", "generate_caption"),
}
PIXAI_CATEGORIES = ("general", "character", "style", "copyright", "meta", "rating")
PIXAI_THRESHOLD_DEFAULTS = dict(zip(PIXAI_CATEGORIES, (0.17, 0.27, 0.15, 0.24, 0.17, 0.41)))
TORIIGATE_CAPTION_TYPES = (
    "long_thoughts_v2", "long_thoughts", "json", "long", "min_structured_md",
    "json_comic", "md_comic", "min_structured_json", "chroma-style", "short",
)
_MAX_RESULT_BYTES = 2 * 1024 * 1024


def _boolean(options: dict, key: str, default: bool) -> bool:
    value = options.get(key, default)
    if not isinstance(value, bool):
        raise AgentError(f"{key} 必须为布尔值")
    return value


def _parameters(source_id: str, image_data: dict, options: dict) -> list:
    if source_id == "pixai-online":
        selected = options.get("combined_categories", ["general", "character"])
        if not isinstance(selected, list) or not selected or any(c not in PIXAI_CATEGORIES for c in selected):
            raise AgentError("PixAI 分类必须从 general、character、style、copyright、meta、rating 中选择")
        thresholds = []
        for category, default in PIXAI_THRESHOLD_DEFAULTS.items():
            value = options.get(category + "_threshold", options.get("threshold", default) if category == "general" else default)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                raise AgentError(f"{category}_threshold 必须在 0 到 1 之间")
            thresholds.append(value)
        # Scores are returned separately by the API regardless of this display flag.
        return [image_data, False, _boolean(options, "keep_underscores", True), selected, *thresholds]
    caption_type = options.get("caption_type", "short")
    if caption_type not in TORIIGATE_CAPTION_TYPES:
        raise AgentError("ToriiGate 不支持所选 caption_type")
    # 29 arguments. Auxiliary tags, character lists and descriptions stay disabled.
    return [image_data, caption_type, _boolean(options, "use_names", True),
            False, False, False, False, *([""] * 22)]


def _remote_error(value, token: str) -> str:
    title = ""
    if isinstance(value, dict):
        title = str(value.get("title") or "")
        value = value.get("error") or value.get("message") or value.get("detail")
    message = str(value or "服务未提供错误详情；请查看对应 Space 的在线状态").splitlines()[0]
    if token:
        message = message.replace(token, "[redacted]")
    message = message[:300]
    if "illegal duration" in title.lower() or ("requested gpu duration" in message.lower() and "maximum allowed" in message.lower()):
        seconds = re.search(r"\((\d+)s\)", message)
        duration = f"（请求 {seconds.group(1)} 秒）" if seconds else ""
        return (f"HF Space 单次 GPU 时长超限{duration}：该 Space 要求更高的 HF 账号等级。"
                "有 HF PRO 可在高级设置填写对应 Token；免费使用请选择本地 WD14、PixAI 在线或 WorkBuddy。"
                "重启或等待不会解除此限制。")
    if any(word in message.lower() for word in ("quota", "gpu limit", "rate limit", "exceeded")):
        return "HF Space 额度不足：" + message
    return "HF Space 反推失败：" + message


async def _json_response(response: aiohttp.ClientResponse, token: str):
    if response.status != 200:
        if response.status == 429:
            raise AgentError("HF Space 额度不足或请求过多（HTTP 429）")
        if response.status in (401, 403):
            raise AgentError(f"HF Space 身份验证失败（HTTP {response.status}），请检查 HF token")
        raise AgentError(f"HF Space 请求失败（HTTP {response.status}）")
    body = await response.read()
    if len(body) > _MAX_RESULT_BYTES:
        raise AgentError("HF Space 返回内容过大")
    try:
        value = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise AgentError("HF Space 返回了无效 JSON") from exc
    if isinstance(value, dict) and ("error" in value or "detail" in value):
        raise AgentError(_remote_error(value, token))
    return value


async def _sse_result(response: aiohttp.ClientResponse, token: str, *, event_id: str = "", on_progress=None) -> list:
    if response.status != 200:
        await _json_response(response, token)
    event, data, total = "", [], 0

    def dispatch():
        nonlocal event, data
        current_event, payload = event, "\n".join(data)
        event, data = "", []
        if not payload or (not event_id and current_event not in ("complete", "error")):
            return None
        try:
            value = json.loads(payload)
        except ValueError as exc:
            raise AgentError("HF Space 事件流返回了无效 JSON") from exc
        if event_id:
            if not isinstance(value, dict):
                raise AgentError("HF Space 队列事件无效")
            if value.get("event_id") not in (None, event_id):
                return None
            kind = value.get("msg")
            if on_progress and kind in ("estimation", "process_starts", "progress"):
                progress = {"stage": "queued" if kind == "estimation" else "processing"}
                for name in ("rank", "queue_size", "rank_eta"):
                    number = value.get(name)
                    if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number):
                        progress[name] = number
                on_progress(progress)
            if kind in ("unexpected_error", "server_stopped"):
                raise AgentError(_remote_error(value, token))
            if kind != "process_completed":
                return None
            output = value.get("output") or {}
            if value.get("success") is not True:
                raise AgentError(_remote_error(output, token))
            value = output.get("data")
        elif current_event == "error":
            raise AgentError(_remote_error(value, token))
        if not isinstance(value, list):
            raise AgentError("HF Space 完成事件缺少结果数组")
        return value

    async for raw_line in response.content:
        total += len(raw_line)
        if total > _MAX_RESULT_BYTES:
            raise AgentError("HF Space 返回内容过大")
        try:
            line = raw_line.decode("utf-8").rstrip("\r\n")
        except UnicodeDecodeError as exc:
            raise AgentError("HF Space 事件流不是有效 UTF-8") from exc
        if not line:
            result = dispatch()
            if result is not None:
                return result
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
    if event or data:
        result = dispatch()
        if result is not None:
            return result
    raise AgentError("HF Space 连接已结束，但未返回完成结果")


def _normalize_result(source_id: str, outputs: list, options: dict, token: str) -> dict:
    result = {"source": source_id, "tags": [], "caption": "", "scores": {}, "categories": {}}
    if source_id == "toriigate-online":
        if len(outputs) != 1 or not isinstance(outputs[0], str) or not outputs[0].strip():
            raise AgentError("ToriiGate 未返回有效描述")
        caption = outputs[0].strip()
        if caption.startswith("Error:") or caption == "Please upload an image first.":
            raise AgentError(_remote_error(caption, token))
        result["caption"] = caption
        return result
    # /tag returns combined, six category strings, status, raw score dictionary.
    if len(outputs) != 9 or not isinstance(outputs[8], dict):
        raise AgentError("PixAI 返回结构与当前接口不符")
    selected = options.get("combined_categories", ["general", "character"])
    for category in PIXAI_CATEGORIES:
        values = outputs[8].get(category, {})
        if not isinstance(values, dict):
            raise AgentError("PixAI 返回的分类分数无效")
        names = []
        for tag, score in values.items():
            if not isinstance(tag, str) or not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
                raise AgentError("PixAI 返回的标签分数无效")
            names.append(tag)
            result["scores"][tag] = float(score)
        result["categories"][category] = names
    # Match the Space's combined category ordering; raw spelling stays intact.
    for category in ("character", "copyright", "style", "general", "meta", "rating"):
        if category in selected:
            for tag in result["categories"][category]:
                if tag not in result["tags"]:
                    result["tags"].append(tag)
    if not result["tags"]:
        raise AgentError("PixAI 在所选分类和阈值下没有找到标签，请降低阈值")
    return result


async def interrogate_space(source_id: str, image: bytes, options: dict, *,
                            token: str = "", proxy: str = "http://127.0.0.1:7890",
                            timeout: float = 180, on_progress=None) -> dict:
    """Upload one image and perform one inference, with no retries or fan-out."""
    if source_id not in SPACE_ENDPOINTS:
        raise AgentError("未知 HF Space 反推来源")
    if not isinstance(image, bytes) or not image:
        raise AgentError("反推需要有效图片")
    if not isinstance(options, dict):
        raise AgentError("HF Space 选项必须为对象")
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
        raise AgentError("HF Space 超时必须为正数")
    # Validate options before sending the image anywhere.
    _parameters(source_id, {}, options)
    base_url, api_name = SPACE_ENDPOINTS[source_id]
    headers = {"User-Agent": "TK-Prompt-Agent/0.1"}
    if token:
        # Current Gradio Python client uses this header for HF identity/ZeroGPU quota.
        headers["X-HF-Authorization"] = "Bearer " + token
    mime, filename = "image/png", "image.png"
    if image.startswith(b"\xff\xd8\xff"):
        mime, filename = "image/jpeg", "image.jpg"
    elif image.startswith(b"RIFF") and image[8:12] == b"WEBP":
        mime, filename = "image/webp", "image.webp"

    async def call():
        # Low PixAI thresholds can produce a long single SSE line of raw scores.
        async with aiohttp.ClientSession(headers=headers, timeout=aiohttp.ClientTimeout(total=timeout),
                                         read_bufsize=_MAX_RESULT_BYTES) as client:
            # Use the official queue protocol for both Spaces. The simplified
            # /call stream hides queue rank and drops useful failure details.
            async with client.get(base_url + "/config", proxy=proxy or None,
                                  allow_redirects=False) as response:
                config = await _json_response(response, token)
            fn_index = next((d.get("id") for d in config.get("dependencies", [])
                             if d.get("api_name") == api_name), None)
            if not isinstance(fn_index, int) or isinstance(fn_index, bool):
                raise AgentError(f"HF Space 当前接口缺少 {api_name} 队列函数")
            form = aiohttp.FormData()
            if on_progress:
                on_progress({"stage": "uploading"})
            form.add_field("files", image, filename=filename, content_type=mime)
            async with client.post(base_url + "/gradio_api/upload", data=form,
                                   proxy=proxy or None, allow_redirects=False) as response:
                uploaded = await _json_response(response, token)
            if not isinstance(uploaded, list) or len(uploaded) != 1 or not isinstance(uploaded[0], str) or not uploaded[0]:
                raise AgentError("HF Space 上传未返回图片路径")
            file_data = {"path": uploaded[0], "orig_name": filename, "mime_type": mime,
                         "size": len(image), "meta": {"_type": "gradio.FileData"}}
            session_hash = uuid.uuid4().hex
            url = base_url + "/gradio_api/queue/join"
            body = {"data": _parameters(source_id, file_data, options),
                    "fn_index": fn_index, "session_hash": session_hash}
            async with client.post(url, json=body,
                                   proxy=proxy or None, allow_redirects=False) as response:
                started = await _json_response(response, token)
            event_id = started.get("event_id") if isinstance(started, dict) else None
            if not isinstance(event_id, str) or not event_id:
                raise AgentError("HF Space 调用未返回事件 ID")
            if on_progress:
                on_progress({"stage": "queued"})
            async with client.get(base_url + "/gradio_api/queue/data",
                                  params={"session_hash": session_hash},
                                  proxy=proxy or None, allow_redirects=False) as response:
                outputs = await _sse_result(response, token, event_id=event_id, on_progress=on_progress)
            return _normalize_result(source_id, outputs, options, token)

    try:
        return await asyncio.wait_for(call(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise AgentError(f"HF Space 反推超时（{timeout:g} 秒），远端排队或处理未结束。可在高级设置调高在线反推等待上限，或选择本地 WD14。原提示词未被覆盖。") from exc
    except (aiohttp.ClientError, OSError) as exc:
        raise AgentError("无法连接 HF Space，请检查网络或代理") from exc
