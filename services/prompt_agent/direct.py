"""Single-call writing without a semantic JSON document or reply cache.

The transaction owner still decides when a candidate becomes the final prompt.
Explicit section locks use the existing structured editor instead of guessing
where protected text appears in an unclassified draft.
"""
from __future__ import annotations

import json

from .errors import AgentError

RULES = (
    "Write an image prompt for the supplied target model. Return only the final English image description, "
    "without JSON, Markdown, labels, commentary or reasoning. "
    "No implicit anchors or locked sections exist. "
    "Writing exclusions control what to omit, and are not image descriptions. "
    "Do not claim that you searched, ran scripts or verified tags or character facts: no tools are run in this mode. "
    "Treat prior drafts and examples as context, never as current editing permissions."
)

CREATIVE_BASE = (
    "Follow the latest instruction. "
    "An empty current prompt starts a new scene; do not borrow subjects from past drafts. "
    "For edits, keep unrelated visual facts while applying requested replacements, including identities and clothing. "
    "A request to keep a detail is a creative requirement. "
    "Expand adds useful requested details; rewrite may change the composition; convert preserves scene content. "
    "Prefer concrete subjects, actions and spatial relationships over boilerplate."
)


async def generate(provider, profile, state: dict, request: dict, preset: dict) -> dict:
    """Generate a candidate once; format failures do not silently spend a retry."""
    style = (
        "Use lowercase comma-separated tags with spaces instead of underscores. "
        "When useful, put a coherent natural-language image description after a blank line."
        if profile.data["style"] == "tags" else
        "Use coherent English prose, preserving capitalization and punctuation."
    )
    # Presets replace creative defaults, while response contracts and target
    # style remain in force for both append and replace.
    base = preset["instructions"] if preset["mode"] == "replace" else CREATIVE_BASE
    messages = [
        {"role": "system", "content": "\n\n".join(filter(None, (
            RULES, style, base,
            preset["instructions"] if preset["mode"] == "append" else "",
            request.get("custom_instructions", ""),
            "Final response contract: return only the English visual prompt. No Chinese explanation, no JSON envelope, no headings.",
        )))},
        {"role": "user", "content": json.dumps({
            "model_profile": profile.data["label"], "task": request["mode"],
            "instruction": request["instruction"], "current_prompt": state["prompt"],
            "recent_instructions": [turn["instruction"][:1000] for turn in state["history"][-4:]],
        }, ensure_ascii=False)},
    ]
    reply = await provider.complete(messages, None)
    try:
        wrapped = json.loads(reply)
    except (ValueError, TypeError):
        wrapped = None
    if isinstance(wrapped, (dict, list)):
        raise AgentError("快速直写收到 JSON 包装，未确认正文；请重试或切换按流程创作。")
    prompt = profile.validate_snapshot(reply)
    return {"prompt": prompt, "message": "已生成正文；快速直写未执行词条、人物或联网核验。",
            "changes": ["按本轮指令更新正文"], "warnings": [],
            "workflow": {"id": "direct-writing", "version": 1, "steps": [
                {"id": "draft", "label": "快速直写", "summary": "一次模型请求，直接生成正文；没有回复缓存。"},
                {"id": "validation", "label": "保存最终稿", "summary": "已检查正文格式；可继续修改、撤销或重试。未执行资料核验。"},
            ]}}
