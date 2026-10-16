"""Bounded OpenAI-compatible chat transport, including explicit SSE mode."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from typing import Protocol
from uuid import uuid4

import aiohttp

from .config import is_local_url, validate_config
from .errors import AgentError

MAX_RESPONSE_BYTES = 1024 * 1024
USER_AGENT = "TK-Prompt-Agent/0.1"


class ProviderError(AgentError):
    """A safe error suitable for displaying without the provider's raw body."""

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


class Provider(Protocol):
    async def complete(self, messages: list[dict], schema: dict | None) -> str:
        """Return text; the caller owns schema validation and repair."""
        ...


def _http_error(status: int, response_mode: str) -> ProviderError:
    if status in {401, 403}:
        message = "LLM 服务拒绝认证；请检查 API key 和服务访问权限。"
    elif status == 429:
        message = "LLM 服务限流或额度不足；请稍后重试并检查账户额度。"
    elif status == 404:
        message = "LLM 服务未找到接口或模型；请检查 Base URL 和 model。"
    elif status in {400, 422} and response_mode != "text":
        message = "LLM 服务拒绝请求；请检查模型和参数，若服务不支持结构化输出，可手动切换 response_mode。"
    elif status >= 500:
        message = "LLM 服务暂时不可用；请稍后重试。"
    elif 300 <= status < 400:
        message = "LLM 服务返回了重定向；为保护 API key，请配置服务的最终 Base URL。"
    else:
        message = "LLM 服务拒绝请求；请检查服务配置。"
    return ProviderError(f"{message}（HTTP {status}）", status=status)


def _parse_sse(body: bytearray) -> str:
    """Dispatch standard SSE data events; consume only chat delta.content."""
    try:
        source = body.decode("utf-8").removeprefix("\ufeff")
    except UnicodeError:
        raise ProviderError("LLM 流式响应不是有效的 UTF-8 SSE。") from None
    # An event is dispatched by a completed blank line, never guessed at EOF.
    events = []
    data_lines = []
    event_name = ""
    for match in re.finditer(r"([^\r\n]*)(?:\r\n|\r|\n)", source):
        line = match.group(1)
        if not line:
            if data_lines:
                events.append((event_name, "\n".join(data_lines)))
            data_lines = []
            event_name = ""
            continue
        if line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "data":
            data_lines.append(value if separator else "")
        elif field == "event":
            event_name = value
    if not events:
        raise ProviderError("LLM 流式响应不是完整的 SSE data 事件；请检查服务的 stream 支持。")
    content_parts = []
    finished = False
    for event_name, payload in events:
        if event_name == "error":
            raise ProviderError("LLM 流式服务返回错误。")
        if payload.strip() == "[DONE]":
            finished = True
            break
        if not payload.strip():
            continue
        try:
            event = json.loads(payload)
        except ValueError:
            raise ProviderError("LLM 流式服务返回无效的 JSON data 事件。") from None
        if not isinstance(event, dict):
            raise ProviderError("LLM 流式服务返回无效的 data 对象。")
        if "error" in event:
            raise ProviderError("LLM 流式服务返回错误。")
        choices = event.get("choices")
        if choices == []:
            # OpenAI-compatible providers may send a usage-only tail chunk.
            continue
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise ProviderError("LLM 流式服务未返回 choices。")
        choice = choices[0]
        reason = choice.get("finish_reason")
        if reason is not None and not isinstance(reason, str):
            raise ProviderError("LLM 流式服务返回了无效的 finish_reason。")
        if reason == "length":
            raise ProviderError("LLM 输出因 max_tokens 截断；请提高输出上限或缩短输入。")
        if reason in {"content_filter", "refusal"}:
            raise ProviderError("LLM 服务拒绝了此请求。")
        if reason == "stop":
            finished = True
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            raise ProviderError("LLM 流式服务未返回 delta。")
        if delta.get("refusal"):
            raise ProviderError("LLM 服务拒绝了此请求。")
        content = delta.get("content")
        if content is not None:
            if not isinstance(content, str):
                raise ProviderError("LLM 流式服务返回了无效的文本内容。")
            content_parts.append(content)
        # reasoning_content is intentionally not part of the working prompt.
    if not finished:
        raise ProviderError("LLM 流式响应被截断，缺少 [DONE] 或 finish_reason=stop。")
    content = "".join(content_parts)
    if not content.strip():
        raise ProviderError("LLM 服务未返回文本内容。")
    return content


class OpenAICompatibleProvider:
    def __init__(self, config: dict):
        self.config = validate_config(config)
        self._key = self.config.pop("api_key", "")
        self._session_token = uuid4().hex
        self._local = is_local_url(self.config["base_url"])
        if not self._key and not self._local:
            raise ProviderError("外部 LLM 服务需要 API key；请在设置中填写，或设置指定的环境变量。")

    def bind_session(self, session_id: str) -> None:
        """Bind an opaque, stable identifier without exposing the session input."""
        if not isinstance(session_id, str):
            raise ProviderError("LLM session_id 必须是字符串。")
        try:
            self._session_token = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
        except UnicodeError:
            raise ProviderError("LLM session_id 不是有效的 UTF-8 字符串。") from None

    async def complete(self, messages: list[dict], schema: dict | None) -> str:
        if (not isinstance(messages, list) or not messages
                or any(not isinstance(message, dict) for message in messages)):
            raise ProviderError("LLM messages 必须是非空消息列表。")
        config = self.config
        payload = {
            "model": config["model"], "messages": messages,
            "temperature": config["temperature"], "max_tokens": config["max_tokens"], "stream": config["stream"],
        }
        if config["disable_thinking"]:
            payload["thinking"] = {"type": "disabled"}
        # A plain-writing request owns its text format, regardless of the
        # connection's structured default. Structured callers still send schema.
        if schema is not None and config["response_mode"] == "json_schema":
            if not isinstance(schema, dict):
                raise ProviderError("json_schema 模式需要 JSON schema 对象。")
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "prompt_agent_response", "strict": True, "schema": schema},
            }
        elif schema is not None and config["response_mode"] == "json_object":
            payload["response_format"] = {"type": "json_object"}
        try:
            json.dumps(payload, allow_nan=False)
        except (ValueError, TypeError):
            raise ProviderError("LLM 请求内容不是有效 JSON。") from None
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        if config["session_header"]:
            headers[config["session_header"]] = self._session_token
        if self._key:
            headers["Authorization"] = f"Bearer {self._key}"
        proxy = None if self._local else config["proxy"] or None
        timeout = aiohttp.ClientTimeout(total=config["timeout"])
        try:
            # Sessions belong to the request's running loop, never module globals.
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
                async with session.post(config["base_url"] + "/chat/completions", json=payload,
                                        headers=headers, proxy=proxy, allow_redirects=False) as response:
                    if not 200 <= response.status < 300:
                        raise _http_error(response.status, config["response_mode"])
                    if response.content_length is not None and response.content_length > MAX_RESPONSE_BYTES:
                        raise ProviderError("LLM 响应超过 1 MiB，请降低输出长度。")
                    body = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise ProviderError("LLM 响应超过 1 MiB，请降低输出长度。")
        except (asyncio.TimeoutError, TimeoutError):
            raise ProviderError("LLM 请求超时；请稍后重试或调整 timeout。") from None
        except aiohttp.ClientError:
            raise ProviderError("无法连接 LLM 服务；请检查 Base URL、代理和网络。") from None
        if config["stream"]:
            return _parse_sse(body)
        try:
            result = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise ProviderError("LLM 服务返回了无效的 JSON 响应。") from None
        if not isinstance(result, dict):
            raise ProviderError("LLM 服务返回了无效的响应对象。")
        choices = result.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise ProviderError("LLM 服务未返回 choices。")
        choice = choices[0]
        if choice.get("finish_reason") is not None and not isinstance(choice.get("finish_reason"), str):
            raise ProviderError("LLM 服务返回了无效的 finish_reason。")
        if choice.get("finish_reason") == "length":
            raise ProviderError("LLM 输出因 max_tokens 截断；请提高输出上限或缩短输入。")
        if choice.get("finish_reason") in {"content_filter", "refusal"}:
            raise ProviderError("LLM 服务拒绝了此请求。")
        message = choice.get("message")
        if not isinstance(message, dict):
            raise ProviderError("LLM 服务未返回 message。")
        if message.get("refusal"):
            raise ProviderError("LLM 服务拒绝了此请求。")
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ProviderError("LLM 服务未返回文本内容。")
        return content
