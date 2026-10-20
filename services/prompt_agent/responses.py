"""Stateless Responses wire adapter; no I/O and no provider-specific defaults.

Protocol reference: https://developers.openai.com/api/docs/guides/migrate-to-responses
"""
from __future__ import annotations

import json

from .errors import AgentError


class ResponsesError(AgentError):
    """A Responses document cannot safely be used as a complete answer."""


def _fail():
    raise ResponsesError("Responses 返回不完整、格式不合法或未成功完成；本轮结果未采用。")


def _model(value):
    if isinstance(value, str) and len(value) <= 256 and not any(ord(c) < 32 for c in value):
        return value
    return ""


def build_payload(chat_payload: dict) -> dict:
    """Translate the supported chat text/image request, without changing it."""
    if not isinstance(chat_payload, dict) or not isinstance(chat_payload.get("messages"), list):
        _fail()
    out = {key: chat_payload[key] for key in ("model", "temperature", "top_p", "stream") if key in chat_payload}
    out.update(input=[], store=False)
    # Reviewed xAI contract: these models cannot disable reasoning and
    # otherwise default to high. Honour the existing low-thinking preference
    # using their supported minimum, rather than silently dropping it.
    if (chat_payload.get("model") in {"grok-4.5", "grok-4.6", "grok-4.7"}
            and chat_payload.get("thinking") == {"type": "disabled"}):
        out["reasoning"] = {"effort": "low"}
    if "max_tokens" in chat_payload:
        out["max_output_tokens"] = chat_payload["max_tokens"]
    for message in chat_payload["messages"]:
        if not isinstance(message, dict) or message.get("role") not in ("system", "developer", "user", "assistant"):
            _fail()
        role = message["role"]
        content = message.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        if not isinstance(content, list):
            _fail()
        parts = []
        for part in content:
            if not isinstance(part, dict):
                _fail()
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                parts.append({"type": "input_text", "text": part["text"]})
            elif part.get("type") == "image_url" and role == "user":
                image = part.get("image_url")
                if isinstance(image, str):
                    image = {"url": image}
                if not isinstance(image, dict) or not isinstance(image.get("url"), str) or not image["url"]:
                    _fail()
                mapped = {"type": "input_image", "image_url": image["url"]}
                if "detail" in image:
                    if image["detail"] not in ("auto", "low", "high", "original"):
                        _fail()
                    mapped["detail"] = image["detail"]
                parts.append(mapped)
            else:
                _fail()
        out["input"].append({"role": role, "content": parts})
    if "response_format" in chat_payload:
        fmt = chat_payload["response_format"]
        if not isinstance(fmt, dict):
            _fail()
        kind = fmt.get("type")
        if kind == "json_schema":
            schema = fmt.get("json_schema")
            if not isinstance(schema, dict) or not isinstance(schema.get("schema"), dict) or not isinstance(schema.get("name"), str):
                _fail()
            mapped = {"type": "json_schema", **{key: schema[key] for key in ("name", "strict", "schema") if key in schema}}
        elif kind in ("json_object", "text"):
            mapped = {"type": kind}
        else:
            _fail()
        out["text"] = {"format": mapped}
    return out


def _response_text(document: dict, *, allow_empty=False) -> tuple[str, str]:
    if (not isinstance(document, dict) or document.get("status") != "completed"
            or document.get("error") is not None or document.get("incomplete_details") is not None):
        _fail()
    output = document.get("output")
    if not isinstance(output, list):
        _fail()
    texts = []
    for item in output:
        if not isinstance(item, dict):
            _fail()
        if item.get("type") == "reasoning":
            continue
        if item.get("type") != "message":
            # Tools are deliberately unsupported by the prompt-only protocol.
            _fail()
        if item.get("status", "completed") != "completed" or item.get("role", "assistant") != "assistant":
            _fail()
        if not isinstance(item.get("content"), list):
            _fail()
        for part in item["content"]:
            if not isinstance(part, dict) or part.get("type") != "output_text" or not isinstance(part.get("text"), str):
                _fail()
            texts.append(part["text"])
    text = "".join(texts)
    if not allow_empty and not text.strip():
        _fail()
    return text, _model(document.get("model"))


def parse_response(document: dict) -> tuple[str, str]:
    return _response_text(document)


def _load(data):
    try:
        def constant(_value):
            _fail()
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    _fail()
                value[key] = item
            return value
        document = json.loads(data, parse_constant=constant, object_pairs_hook=unique)
    except (ValueError, TypeError, RecursionError):
        _fail()
    if not isinstance(document, dict):
        _fail()
    return document


def parse_stream(body: bytearray) -> tuple[str, str]:
    """Parse complete SSE frames; EOF and [DONE] are not success states."""
    try:
        wire = bytes(body).decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    except (ValueError, TypeError, UnicodeError):
        _fail()
    if not wire.endswith("\n\n"):
        _fail()
    deltas, completed, model = [], None, ""
    for frame in wire.split("\n\n"):
        if not frame.strip():
            continue
        data, event_type = [], ""
        for line in frame.split("\n"):
            if line.startswith(":"):
                continue
            field, sep, value = line.partition(":")
            if value.startswith(" "):
                value = value[1:]
            if field == "data" and sep:
                data.append(value)
            elif field == "event" and sep:
                event_type = value
        if not data:
            continue
        raw = "\n".join(data)
        if raw == "[DONE]":
            if completed is None:
                _fail()
            continue
        document = _load(raw)
        kind = document.get("type", event_type)
        if not isinstance(kind, str) or (event_type and event_type != kind):
            _fail()
        if kind in ("error", "response.failed", "response.incomplete") or "refusal" in kind:
            _fail()
        if completed is not None:
            _fail()
        if kind == "response.output_text.delta":
            if not isinstance(document.get("delta"), str):
                _fail()
            deltas.append(document["delta"])
        elif kind == "response.completed":
            completed = document.get("response")
            final, reported = _response_text(completed, allow_empty=True)
            model = reported or model
        elif kind in ("response.created", "response.in_progress"):
            value = document.get("response")
            if isinstance(value, dict):
                if value.get("error") is not None:
                    _fail()
                model = _model(value.get("model")) or model
        elif kind == "response.output_item.done":
            item = document.get("item")
            if isinstance(item, dict) and item.get("type") == "message":
                _response_text({"status": "completed", "output": [item]}, allow_empty=True)
        elif kind == "response.content_part.done":
            part = document.get("part")
            if isinstance(part, dict) and part.get("type") == "refusal":
                _fail()
    if completed is None:
        _fail()
    text = final if final.strip() else "".join(deltas)
    if not text.strip():
        _fail()
    return text, model
