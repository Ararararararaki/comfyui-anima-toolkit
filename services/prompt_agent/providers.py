"""Bounded OpenAI-compatible chat transport, including explicit SSE mode."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
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


def _http_error(status: int, response_mode: str, *, error=None, model="", protocol="") -> ProviderError:
    if status in {401, 403}:
        message = "LLM 服务拒绝认证；请检查 API key 和服务访问权限。"
    elif status == 429:
        message = "LLM 服务限流或额度不足；请稍后重试并检查账户额度。"
    elif status == 404:
        message = "LLM 服务未找到接口或模型；请检查 Base URL 和 model。"
    elif status in {400, 422} and response_mode != "text":
        message = "LLM 请求未被接受；仅凭此状态不能判断 response_mode 是否不兼容。"
    elif status >= 500:
        message = "LLM 服务暂时不可用；请稍后重试。"
    elif 300 <= status < 400:
        message = "LLM 服务返回了重定向；为保护 API key，请配置服务的最终 Base URL。"
    else:
        message = "LLM 服务拒绝请求；请检查服务配置。"
    # Error messages may echo prompts, images or secrets. Only fixed identifiers
    # cross this display boundary; unknown upstream values are never echoed.
    known = {"invalid_request_error", "unsupported_parameter", "invalid_parameter",
             "unsupported_value", "invalid_json_schema", "content_policy_violation",
             "content_filter", "rate_limit_exceeded", "insufficient_quota",
             "ModelProtocolUnsupported", "MissingSessionID"}
    parameters = {"response_format", "text.format", "temperature", "max_tokens",
                  "max_output_tokens", "thinking", "reasoning", "reasoning.effort",
                  "messages", "input", "model", "stream"}
    detail = []
    if isinstance(error, dict):
        for field in ("type", "code", "param"):
            value = error.get(field)
            allowed = parameters if field == "param" else known
            if isinstance(value, str) and value in allowed:
                detail.append(f"{field}={value}")
    if model:
        detail.append("model=" + re.sub(r"[^a-zA-Z0-9._:/-]", "?", model)[:120])
    if protocol in {"responses", "chat_completions"}:
        detail.append("protocol=" + protocol)
    suffix = "; " + ", ".join(detail) if detail else ""
    return ProviderError(f"{message}（HTTP {status}{suffix}）", status=status)


def _reported_model(metadata, value):
    if metadata is not None and isinstance(value, str) and 0 < len(value) <= 256 and not any(ord(c) < 32 for c in value):
        metadata["reported"] = value


def _parse_sse(body: bytearray, metadata=None) -> str:
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
        _reported_model(metadata, event.get("model"))
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
    require_model_match = False

    def _check_reported_model(self):
        requested, reported = self.last_model["requested"], self.last_model["reported"]
        if self.require_model_match and reported and reported != requested:
            raise ProviderError(f"模型不一致：请求 {requested}，服务返回 {reported}；已停止扩写，请核对运营商模型映射。")

    def __init__(self, config: dict):
        self.config = validate_config(config)
        self._key = self.config.pop("api_key", "")
        self.last_model = {"requested": self.config["model"], "reported": ""}
        self.protocol = "chat_completions"
        self.reasoning_effort = ""
        self.on_progress = None
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

    async def list_models(self) -> list[dict]:
        """Explicit catalog request through the existing authenticated transport."""
        config = self.config
        headers = {"User-Agent": USER_AGENT}
        if self._key:
            headers["Authorization"] = "Bearer " + self._key
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=min(config["timeout"], 30)), trust_env=False) as session:
                async with session.get(config["base_url"] + "/models", headers=headers,
                                       proxy=None if self._local else config["proxy"] or "http://127.0.0.1:7890",
                                       allow_redirects=False) as response:
                    if response.status != 200:
                        raise ProviderError("该连接无法读取模型列表；可手动填写模型 ID。", status=response.status)
                    content = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        content.extend(chunk)
                        if len(content) > 8 * 1024 * 1024:
                            raise ProviderError("模型列表超过 8 MiB，请手动填写模型 ID。")
            data = json.loads(content)
        except (aiohttp.ClientError, TimeoutError, ValueError):
            raise ProviderError("读取模型列表失败；请检查代理，或手动填写模型 ID。") from None
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise ProviderError("该连接未返回有效模型列表，请手动填写模型 ID。")
        result = {}
        for row in rows[:3000]:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not 0 < len(row["id"]) <= 256:
                continue
            architecture = row.get("architecture")
            modalities = architecture.get("input_modalities") if isinstance(architecture, dict) else None
            vision = "image" in modalities if isinstance(modalities, list) else None
            result[row["id"]] = {"id": row["id"], "vision": vision}
        return sorted(result.values(), key=lambda row: row["id"])

    async def complete(self, messages: list[dict], schema: dict | None) -> str:
        if (not isinstance(messages, list) or not messages
                or any(not isinstance(message, dict) for message in messages)):
            raise ProviderError("LLM messages 必须是非空消息列表。")
        config = self.config
        self.last_model = {"requested": config["model"], "reported": ""}
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
        started, phase, received = time.monotonic(), "等待响应头", 0
        last_progress = 0
        def progress(stage):
            if self.on_progress is not None:
                self.on_progress({"stage": stage, "model": config["model"], "protocol": protocol,
                                  "received_bytes": received, "elapsed": round(time.monotonic() - started, 1)})
        protocol = self.protocol
        try:
            # Protocol negotiation retries the same model only on an explicit
            # protocol rejection, never on generic errors or model failures.
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
                for protocol in (self.protocol, "responses"):
                    if protocol == "responses":
                        from .responses import build_payload
                        wire_payload = build_payload(payload)
                    else:
                        wire_payload = payload
                    self.reasoning_effort = wire_payload.get("reasoning", {}).get("effort", "")
                    phase, received = "等待响应头", 0
                    progress("llm_waiting")
                    endpoint = "/responses" if protocol == "responses" else "/chat/completions"
                    async with session.post(config["base_url"] + endpoint, json=wire_payload,
                                            headers=headers, proxy=proxy, allow_redirects=False) as response:
                        phase = "读取响应"
                        if response.content_length is not None and response.content_length > MAX_RESPONSE_BYTES:
                            raise ProviderError("LLM 响应超过 1 MiB，请降低输出长度。")
                        body = bytearray()
                        async for chunk in response.content.iter_chunked(65536):
                            body.extend(chunk)
                            received = len(body)
                            now = time.monotonic()
                            if 200 <= response.status < 300 and now - last_progress >= 1:
                                progress("llm_receiving")
                                last_progress = now
                            if len(body) > MAX_RESPONSE_BYTES:
                                raise ProviderError("LLM 响应超过 1 MiB，请降低输出长度。")
                        if not 200 <= response.status < 300:
                            try:
                                error = json.loads(body).get("error", {})
                            except (ValueError, AttributeError):
                                error = {}
                            kind = error.get("type") if isinstance(error, dict) else None
                            if response.status == 400 and kind == "ModelProtocolUnsupported" and protocol == "chat_completions":
                                continue
                            if response.status == 400 and kind == "MissingSessionID":
                                raise ProviderError("OpenCode 缺少会话标识；请使用 DSH OpenCode 连接，或配置 x-opencode-session。", status=400)
                            raise _http_error(response.status, config["response_mode"], error=error,
                                              model=config["model"], protocol=protocol)
                        self.protocol = protocol
                        break
        except (asyncio.TimeoutError, TimeoutError):
            elapsed = round(time.monotonic() - started, 1)
            raise ProviderError(f"LLM 请求超时：模型 {config['model']}，接口 {protocol}，阶段 {phase}，已收 {received} 字节，累计 {elapsed} 秒，单次请求上限 {config['timeout']} 秒。") from None
        except aiohttp.ClientError:
            raise ProviderError("无法连接 LLM 服务；请检查 Base URL、代理和网络。") from None
        if self.protocol == "responses":
            from .responses import parse_response, parse_stream
            try:
                content, reported = (parse_stream(body) if config["stream"] else
                                     parse_response(json.loads(body.decode("utf-8"))))
            except AgentError as error:
                raise ProviderError(str(error)) from None
            except (ValueError, UnicodeError):
                raise ProviderError("LLM Responses 服务返回无效 JSON。") from None
            _reported_model(self.last_model, reported)
            self._check_reported_model()
            return content
        if config["stream"]:
            content = _parse_sse(body, self.last_model)
            self._check_reported_model()
            return content
        try:
            result = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise ProviderError("LLM 服务返回了无效的 JSON 响应。") from None
        if not isinstance(result, dict):
            raise ProviderError("LLM 服务返回了无效的响应对象。")
        _reported_model(self.last_model, result.get("model"))
        self._check_reported_model()
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
