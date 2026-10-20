"""Exact JSON decoding and strict shape validation; no prose scraping."""
from __future__ import annotations

import json
import hashlib
import logging
import re
from .errors import AgentError, ModelRefusal
from .profiles import SECTIONS


def object_schema(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def section_schema(item_type: str) -> dict:
    return object_schema({name: {"type": "array", "items": {"type": item_type}} for name in SECTIONS})


IMPORT_SCHEMA = object_schema({"sections": section_schema("integer")})
EDIT_SCHEMA = object_schema({
    "message": {"type": "string"}, "sections": section_schema("string"),
    "changes": {"type": "array", "items": {"type": "string"}},
    "warnings": {"type": "array", "items": {"type": "string"}},
})


def edit_schema(allowed: set[str]) -> dict:
    """Only writable fields are representable in an edit response."""
    import copy
    schema = copy.deepcopy(EDIT_SCHEMA)
    schema["properties"]["sections"] = object_schema({name: {"type": "array", "items": {"type": "string"}}
                                                      for name in SECTIONS if name in allowed})
    return schema


class SchemaValidationError(AgentError):
    def __init__(self, message, issues):
        super().__init__(message)
        self.issues = issues


def _type(value):
    if value is None:
        return "null"
    return {dict: "object", list: "array", str: "string", int: "integer",
            float: "number", bool: "boolean"}.get(type(value), "unknown")


def _safe_field(name):
    # Unknown keys can themselves contain credentials or user text.
    safe = {"caption", "prompt", "tags", "message", "response", "output", "description",
            "final_prompt", "analysis", "api_key", "token", "password", "reasoning"}
    return name if name in safe else "extra_" + hashlib.sha256(name.encode("utf-8", errors="surrogatepass")).hexdigest()[:8]


def _diagnose(text, value, issues):
    # Shape-only summaries never include string values, request headers or images.
    summary = {"root_type": _type(value), "chars": len(text) if isinstance(text, str) else None}
    if isinstance(value, dict):
        summary["fields"] = [{"name": _safe_field(k), "type": _type(v),
                              "length": len(v) if isinstance(v, (str, list, dict)) else None}
                             for k, v in list(value.items())[:20]]
    logging.getLogger(__name__).warning("prompt_agent.schema_validation %s", json.dumps({
        "event": "schema_validation_failed", "issues": issues, "response_summary": summary,
    }, ensure_ascii=False))


def _validate(value: object, schema: dict, path: str = "response") -> None:
    if "anyOf" in schema:
        for branch in schema["anyOf"]:
            try:
                _validate(value, branch, path)
                return
            except SchemaValidationError:
                pass
        raise SchemaValidationError(f"{path} 的类型不符合任一允许格式",
                                    [{"path": path, "expected": "anyOf", "actual": _type(value)}])
    kind = schema["type"]
    def fail(message, expected=kind, actual=None, location=path):
        raise SchemaValidationError(message, [{"path": location, "expected": expected,
                                              "actual": _type(value) if actual is None else actual}])
    if kind == "object":
        if not isinstance(value, dict):
            fail(f"{path} 的字段不符合 Schema：预期 object，实际 {_type(value)}")
        properties = schema.get("properties", {})
        issues = [{"path": f"{path}.{name}", "expected": properties[name].get("type", "anyOf"), "actual": "missing"}
                  for name in schema.get("required", properties) if name not in value]
        issues += [{"path": f"{path}.{_safe_field(name)}", "expected": "absent", "actual": _type(value[name])}
                   for name in value if name not in properties and not schema.get("additionalProperties", False)]
        if issues:
            raise SchemaValidationError(f"{path} 的字段不符合 Schema：" + json.dumps(issues, ensure_ascii=False), issues)
        for name, child in properties.items():
            if name in value:
                _validate(value[name], child, f"{path}.{name}")
    elif kind == "array":
        if not isinstance(value, list) or len(value) > 150:
            fail(f"{path} 必须是有限长度数组")
        for index, child in enumerate(value):
            _validate(child, schema["items"], f"{path}[{index}]")
    elif kind == "string":
        if not isinstance(value, str) or len(value) > 12000 or ("enum" in schema and value not in schema["enum"]):
            fail(f"{path} 字符串无效")
    elif kind == "integer" and type(value) is not int:
        fail(f"{path} 必须是整数")
    elif kind == "number" and type(value) not in (int, float):
        fail(f"{path} 必须是数字")


def parse_response(text: str, schema: dict, *, unwrap_json_string: bool = False) -> dict:
    if not isinstance(text, str) or len(text) > 100000:
        raise AgentError("模型响应为空或过大")
    # Only an entire, unambiguous fenced JSON document is recoverable locally.
    stripped = text.strip()
    lines = stripped.splitlines()
    if len(lines) >= 3 and lines[0].lower() in ("```json", "```") and lines[-1] == "```":
        stripped = "\n".join(lines[1:-1]).strip()
    def pairs(items):
        obj = {}
        for name, value in items:
            if name in obj:
                raise AgentError("JSON 出现重复字段")
            obj[name] = value
        return obj
    try:
        result = json.loads(stripped, object_pairs_hook=pairs,
                            parse_constant=lambda value: (_ for _ in ()).throw(AgentError("JSON 常量无效")))
    except (ValueError, RecursionError) as error:
        _diagnose(text, None, [{"path": "response", "expected": "complete JSON", "actual": "invalid JSON"}])
        raise AgentError("模型未返回完整 JSON；不会把解释文字作为 Prompt") from error
    if unwrap_json_string and isinstance(result, str):
        # One complete JSON string wrapping the entire document is reversible.
        return parse_response(result, schema)
    try:
        _validate(result, schema)
    except SchemaValidationError as error:
        _diagnose(text, result, error.issues)
        raise
    return result


def _reject_explicit_refusal(text):
    # Match reply-leading refusal statements, not quoted lettering in a scene.
    if isinstance(text, str) and re.match(
            r"^(?:refused(?:[.!:]|$)|this request is illegal[.!]?\s*$|"
            r"i (?:cannot|can't|can’t) (?:assist|help|comply)\b|"
            r"(?:抱歉|对不起)[，,：:]?\s*我(?:不能|无法)(?:帮助|协助|提供|满足|处理))",
            text.strip(), re.IGNORECASE):
        raise ModelRefusal("模型明确拒绝了此请求；拒绝回复未写入 Final Prompt，已停止本轮，不自动重试。")


async def complete_structured(provider, messages: list[dict], schema: dict, validate, *, unwrap_json_string=False) -> dict:
    """Share the same bounded response repair policy for plans and edits."""
    # JSON-object transports need an explicit JSON instruction and schema.
    contract = ("Return exactly one valid JSON document matching this JSON schema. "
                "Escape control characters inside strings; no Markdown or commentary. JSON schema: "
                + json.dumps(schema, ensure_ascii=False))
    messages = [dict(message) for message in messages]
    if messages and messages[0].get("role") == "system" and isinstance(messages[0].get("content"), str):
        try:
            system = json.loads(messages[0]["content"])
        except (ValueError, TypeError):
            system = None
        if isinstance(system, dict):
            # Creation uses a structured system document; keep it valid JSON.
            system["response_contract"] = {"instruction": contract, "schema": schema}
            messages[0]["content"] = json.dumps(system, ensure_ascii=False)
        else:
            messages[0]["content"] += "\n" + contract
    else:
        messages.insert(0, {"role": "system", "content": contract})
    for attempt in range(2):
        raw = await provider.complete(messages, schema)
        try:
            _reject_explicit_refusal(raw)
            result = parse_response(raw, schema, unwrap_json_string=unwrap_json_string)
            _reject_explicit_refusal(result.get("prompt"))
            validate(result)
            return result
        except ModelRefusal:
            raise
        except AgentError as error:
            if attempt:
                raise AgentError(f"模型响应修复后仍无效：{error}") from error
            messages = messages + [{"role": "user", "content": json.dumps({
                "task": "repair_response", "validation_error": str(error),
                "instruction": "Return a fresh complete JSON document matching the schema and all original constraints. Do not quote the invalid response.",
            }, ensure_ascii=False)}]
    raise AgentError("没有合法响应")
