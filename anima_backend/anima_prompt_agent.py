"""ComfyUI adapter: editable chat state and a stable STRING execution snapshot."""
from __future__ import annotations

import json
import uuid

from .services.prompt_agent.core import MODES
from .services.prompt_agent.errors import AgentError
from .services.prompt_agent.profiles import ProfileRegistry
from .services.prompt_agent.runtime import get_runtime
from .services.prompt_agent.execution_wait import await_interruptible


class TkPromptAgent:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "profile": ([""] + [p.id for p in ProfileRegistry().all()], {"default": "anima"}),
            "mode": ([""] + list(MODES), {"default": "create"}),
            "current_prompt": ("STRING", {"default": "", "multiline": True}),
            "user_instruction": ("STRING", {"default": "", "multiline": True}),
            "execution": (["", "snapshot", "execute"], {"default": "snapshot"}),
            "session_id": ("STRING", {"default": ""}),
            "preset": ("STRING", {"default": "default"}),
            "custom_instructions": ("STRING", {"default": "", "multiline": True}),
            "locked_sections": ("STRING", {"default": "[]"}),
            "edit_scope": ("STRING", {"default": "[]"}),
            "approved_prompt": ("STRING", {"default": "", "multiline": True}),
            "agent_response": ("STRING", {"default": "", "multiline": True}),
            "approved_profile": ("STRING", {"default": ""}),
            "interrogation_source": ("STRING", {"default": "local-wd14"}),
            "interrogation_image": ("STRING", {"default": ""}),
            "interrogation_action": ("STRING", {"default": "none"}),
            "interrogation_options": ("STRING", {"default": "{}"}),
            "generation_strategy": ("STRING", {"default": "direct"}),
        }, "optional": {"image": ("IMAGE",)}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("agent_response", "final_prompt")
    FUNCTION = "run"
    CATEGORY = "TK/prompt"
    OUTPUT_NODE = True
    DESCRIPTION = "连续创作与图片反推。有图片并选择‘反推并替换/加入’时读取 IMAGE 并输出 Prompt；没有图片时按文字编辑行为运行。"
    SEARCH_ALIASES = ["Prompt Agent", "提示词助手", "Krea 2", "Anima", "反推", "PixAI", "ToriiGate"]

    @classmethod
    def IS_CHANGED(cls, execution="snapshot", interrogation_action="none", image=None, interrogation_image="", **kwargs):
        # An explicit image action is new work even when the workflow keeps the
        # legacy snapshot selector value.
        if execution == "execute" or (interrogation_action in ("replace", "append")
                                     and (image is not None or interrogation_image)):
            return float("nan")
        return kwargs.get("approved_prompt", ""), kwargs.get("profile", ""), kwargs.get("agent_response", "")

    async def run(self, profile="anima", mode="create", current_prompt="", user_instruction="",
                  execution="snapshot", session_id="", preset="default", custom_instructions="",
                  locked_sections="[]", edit_scope="[]", approved_prompt="", agent_response="", approved_profile="",
                  interrogation_source="local-wd14", interrogation_image="", interrogation_action="none",
                  interrogation_options="{}", image=None, generation_strategy="guided"):
        profile = profile or "anima"
        execution = execution or "snapshot"
        model_profile = ProfileRegistry().get(profile)
        interrogation_action = interrogation_action or "none"
        if interrogation_action not in ("none", "replace", "append"):
            raise AgentError("反推导入方式必须是 none、replace 或 append")
        # Removing an image must not leave a saved image action forcing text
        # workflows into interrogation. Use the selected text behavior instead.
        if image is None and not interrogation_image:
            interrogation_action = "none"
        if execution == "snapshot" and interrogation_action == "none":
            if not approved_prompt.strip():
                raise AgentError("Final Prompt 为空。创作请先发送文字指令；图片反推请连接 IMAGE，并在‘节点运行方式’选‘反推并替换/加入’，然后运行节点。")
            if approved_profile != profile:
                raise AgentError("目标 Profile 与已确认 Prompt 不一致，请先 Convert 并确认新 Prompt")
            prompt = model_profile.validate_snapshot(approved_prompt)
            return {"ui": {"prompt": [prompt], "message": [agent_response]}, "result": (agent_response, prompt)}
        if execution not in ("snapshot", "execute"):
            raise AgentError("未知执行方式")
        try:
            locks, scope = json.loads(locked_sections or "[]"), json.loads(edit_scope or "[]")
        except ValueError as error:
            raise AgentError("锁定/编辑分区必须是 JSON 数组") from error
        runtime = get_runtime()
        sid = session_id or uuid.uuid4().hex
        state = runtime.sessions.load(sid)
        if interrogation_action != "none":
            try:
                descriptor = json.loads(interrogation_image) if interrogation_image else None
                options = json.loads(interrogation_options or "{}")
            except ValueError as error:
                raise AgentError("反推图片与参数必须是有效 JSON") from error
            raw = await await_interruptible(runtime.interrogation.run({"session_id": sid, "profile": profile,
                "source": interrogation_source, "image": descriptor, "options": options}, tensor=image))
            if raw.get("expansion_error"):
                raise AgentError("标签反推已完成，但看图扩写失败：" + raw["expansion_error"])
            if not raw["formatted_prompt"]:
                raise AgentError(raw["message"])
            result = runtime.agent.accept_interrogation({"session_id": sid, "revision": state["revision"],
                "profile": profile, "prompt": raw["formatted_prompt"], "action": interrogation_action, "locks": locks})
            return {"ui": {"prompt": [result["prompt"]], "message": [result["message"]], "state": [result["state"]],
                           "interrogation": [raw]}, "result": (result["message"], result["prompt"])}
        result = await await_interruptible(runtime.agent.edit({"session_id": sid, "revision": state["revision"], "profile": profile,
            "mode": mode or "create", "current_prompt": current_prompt, "instruction": user_instruction,
            "preset": preset or "default", "custom_instructions": custom_instructions, "locks": locks, "scope": scope,
            "generation_strategy": generation_strategy or "guided"}))
        return {"ui": {"prompt": [result["prompt"]], "message": [result["message"]], "state": [result["state"]]},
                "result": (result["message"], result["prompt"])}


NODE_CLASS_MAPPINGS = {"TkPromptAgent": TkPromptAgent}
NODE_DISPLAY_NAME_MAPPINGS = {"TkPromptAgent": "TK Prompt Agent"}
