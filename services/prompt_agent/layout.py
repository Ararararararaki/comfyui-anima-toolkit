"""Visual-layout boundary: editor owns geometry, the model only writes captions."""
from copy import deepcopy
import asyncio
import json
import time

from .errors import AgentError, SessionConflict
from .moss import MOSS_SKILL_ID, compile_expansion_prompt, normalize_layout_draft
from .protocol import object_schema, complete_structured, _reject_explicit_refusal
from .providers import OpenAICompatibleProvider


def prepare_layout(value):
    if not isinstance(value, dict) or not isinstance(value.get("draft"), dict):
        raise AgentError("布局输入必须包含像素 Layout 草稿。")
    draft = deepcopy(value["draft"])
    for item in draft.get("items", []) if isinstance(draft.get("items"), list) else []:
        if isinstance(item, dict):
            item.pop("id", None)
            if item.get("label") != "text":
                item.pop("text", None)
    # The existing MOSS boundary validates finite coordinates, dimensions and text.
    try:
        normalized = normalize_layout_draft(draft)
    except (TypeError, ValueError, RecursionError) as error:
        raise AgentError("布局包含无法表示的数值或字段；请检查原始布局。") from error
    compile_expansion_prompt(normalized, "Layout")
    return json.loads(normalized)


def merge_captions(draft, response, indices=None):
    result = deepcopy(draft)
    wanted = set(range(len(draft["items"]))) if indices is None else set(indices)
    if not isinstance(response.get("summary"), str) or not response["summary"].strip():
        raise AgentError("布局扩写没有返回全局描述。")
    _reject_explicit_refusal(response["summary"])
    rows = response.get("items")
    if not isinstance(rows, list) or len(rows) != len(wanted):
        raise AgentError("布局扩写区域数量不完整；原布局仍保留。")
    seen = set()
    for row in rows:
        index = row.get("index")
        if type(index) is not int or index in seen or index not in wanted:
            raise AgentError("布局扩写区域编号无效；原布局仍保留。")
        if not isinstance(row.get("caption"), str) or not row["caption"].strip():
            raise AgentError("布局扩写区域描述为空。")
        _reject_explicit_refusal(row["caption"])
        seen.add(index)
        result["items"][index]["caption"] = row["caption"]
    if indices is None:
        result["summary"]["caption"] = response["summary"]
    # Coordinates, visible lettering, types and other metadata never come from the model.
    return result


async def accept_layout(runtime, request, tensor=None):
    from .execution import check_current
    from .interrogation_progress import reporter
    draft = prepare_layout(request["layout"])
    original = deepcopy(draft)
    indices = request["layout"].get("indices")
    if indices is not None:
        if (not isinstance(indices, list) or not indices or
                any(type(i) is not int or not 0 <= i < len(draft["items"]) for i in indices) or
                len(set(indices)) != len(indices)):
            raise AgentError("请选择有效的布局区域。")
    usage = None
    options = request.get("options", {})
    expand = request["layout"].get("llm_expand", True)
    if type(expand) is not bool:
        raise AgentError("布局扩写开关必须是布尔值。")
    state = runtime.sessions.load(request["session_id"])
    if type(request.get("revision")) is not int or request["revision"] != state["revision"]:
        raise SessionConflict("会话版本已变化，请重新加载。")
    if not isinstance(request.get("locks", []), list):
        raise AgentError("锁定分区必须是数组。")
    if state["prompt"] and request.get("locks"):
        raise AgentError("布局替换会覆盖锁定内容；请先解除锁定。")
    if expand:
        schema = object_schema({"summary": {"type": "string"}, "items": {
            "type": "array", "items": object_schema({"index": {"type": "integer"}, "caption": {"type": "string"}})}})
        skill = runtime.skills.compose(runtime.skills.get(MOSS_SKILL_ID), options.get("auxiliary_skills", [])) if options.get("auxiliary_skills") else None
        context = {"layout": draft, "instruction": request.get("instruction", "")}
        if indices is not None:
            context["expand_only_indices"] = indices
        if skill:
            context["skill_guidance"] = skill.instructions
            context["skill_guidance_scope"] = "Content guidance only. The response schema and supplied geometry/text take precedence."
        content = [{"type": "text", "text": json.dumps(context, ensure_ascii=False)}]
        if tensor is not None or request.get("image"):
            from .images import prepare_image
            from .interrogators.vision import _data_uri
            image = await asyncio.to_thread(prepare_image, request.get("image"), tensor, True)
            if isinstance(image, tuple):
                image, dimensions = image
                content[0]["text"] = json.dumps({**context, "reference_dimensions": dimensions}, ensure_ascii=False)
            content.append({"type": "image_url", "image_url": {"url": _data_uri(image), "detail": "auto"}})
        config = runtime.model_config({"source": options.get("vision_provider", "current"), "model": options.get("vision_model", "")})
        provider = OpenAICompatibleProvider(config)
        provider.bind_session(request["session_id"])
        provider.on_progress = reporter(request["session_id"])
        provider.require_model_match = bool(options.get("vision_model", "").strip())
        messages = [{"role": "system", "content": (
            "Expand a user-authored visual layout into precise English image captions. "
            "The layout defines the target composition; an optional image is supporting visual evidence. "
            "Follow the instruction for descriptions, preserving each region's subject, identity and relationships. "
            "Return only JSON with summary (global caption) and items [{index,caption}], one entry per supplied item, "
            "using zero-based indices from the supplied array. If expand_only_indices is supplied, return ONLY those indices, "
            "using the other regions as context; preserve the supplied global summary. Do not return geometry or text fields. "
            "The application preserves all boxes, labels and exact visible lettering. Describe text styling "
            "consistent with its supplied text. Never invent additional subjects or lettering. "
            "Global caption describes composition, environment and light; bind individual features to their own region. "
            "Do not claim tool execution. Schema: " + json.dumps(schema))}, {"role": "user", "content": content}]
        response = await complete_structured(provider, messages, schema, lambda value: merge_captions(draft, value, indices))
        draft = merge_captions(draft, response, indices)
        usage = {"source": options.get("vision_provider", "current"), "requested": config.get("model", ""),
                 "reported": getattr(provider, "last_model", {}).get("reported", ""), "completed_at": time.time(),
                 "protocol": getattr(provider, "protocol", "chat_completions")}
    prompt = compile_expansion_prompt(normalize_layout_draft(draft), "Layout")
    check_current()
    if request.get("preview_only") is True:
        return {"prompt": prompt, "draft": draft, "message": "布局描述已生成，等待画布版本核对。", "model_usage": usage}
    approved = runtime.agent.accept_interrogation({
        "session_id": request["session_id"], "revision": request["revision"], "profile": request["profile"],
        "prompt": prompt, "action": "replace", "locks": request.get("locks", []), "expansion_skill": MOSS_SKILL_ID})
    message = "布局已扩写并编译。" if expand else "布局已直接编译，未调用模型。"
    return {**approved, "message": message, "draft": draft, "interrogation": {
        "caption": json.dumps(original, ensure_ascii=False, indent=2), "formatted_prompt": prompt,
        "model_usage": usage, "layout_width": draft["width"], "layout_height": draft["height"], "message": message}}
