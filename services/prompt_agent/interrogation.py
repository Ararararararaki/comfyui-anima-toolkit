"""One selected image source, a raw result, and a profile-safe prompt draft."""
from __future__ import annotations

import asyncio
import json

from .config import ConfigStore
from .errors import AgentError
from .images import prepare_image
from .storage import read_json, write_json

SOURCES = [
    {"id": "local-wd14", "label": "WD14 本地", "kind": "local", "note": "使用已安装模型；默认 CPU，不自动下载。"},
    {"id": "pixai-online", "label": "PixAI 在线", "kind": "online", "note": "PixAI 官方 Hugging Face Space；公开演示可能排队或限额。"},
    {"id": "toriigate-online", "label": "ToriiGate 在线（需 HF 账号权限）", "kind": "online", "note": "作者 Space 当前申请 270 秒 GPU 时长，匿名调用被账号等级限制拦截。有 HF PRO 可配置对应 Token；免费使用优先选本地 WD14 或 PixAI。"},
    {"id": "workbuddy-vision", "label": "WorkBuddy 看图", "kind": "llm", "note": "使用 WorkBuddy 配置中的视觉模型；每次只发当前图片和短描述指令。"},
]


class _HFConfigStore(ConfigStore):
    def _read(self):
        return {"api_key_env": "TK_PROMPT_AGENT_HF_TOKEN", **super()._read()}


class InterrogationConfig:
    def __init__(self, directory):
        self.secret = _HFConfigStore(directory / "interrogation-hf.json")
        self.path = directory / "interrogation-preferences.json"

    def load(self):
        config = {"wd14_model": "wd-v1-4-moat-tagger-v2", "proxy": "http://127.0.0.1:7890", "timeout": 180,
                  **read_json(self.path, {})}
        stored = self.secret.load()
        import os
        config["hf_token"] = os.environ.get("TK_PROMPT_AGENT_HF_TOKEN", "") or stored.get("api_key", "")
        return config

    def public(self):
        config = self.load()
        return {key: config[key] for key in ("wd14_model", "proxy", "timeout")} | {"hf_token_set": bool(config["hf_token"])}

    def save(self, update):
        current = self.load()
        model = update.get("wd14_model", current["wd14_model"])
        if not isinstance(model, str) or not model or len(model) > 256:
            raise AgentError("WD14 模型名称无效")
        settings = {"proxy": update.get("proxy", current["proxy"]), "timeout": update.get("timeout", current["timeout"]),
                    "api_key_env": "TK_PROMPT_AGENT_HF_TOKEN", "api_key": update.get("hf_token", ""),
                    "clear_api_key": update.get("clear_hf_token", False)}
        saved = self.secret.save(settings)
        write_json(self.path, {"wd14_model": model, "proxy": saved["proxy"], "timeout": saved["timeout"]})
        return self.public()


def format_result(result: dict, profile) -> str:
    tags = result.get("tags", [])
    caption = result.get("caption", "").strip()
    if caption.startswith("{"):
        # ToriiGate's minimal structured JSON holds visual caption fields.
        try:
            structured = json.loads(caption)
            def fragments(value):
                if isinstance(value, str):
                    return [value]
                if isinstance(value, list):
                    return [part for item in value for part in fragments(item)]
                if isinstance(value, dict):
                    return [part for key, item in value.items() if key not in ("thoughts", "reasoning", "confidence") for part in fragments(item)]
                return []
            caption = "; ".join(fragments(structured))
        except ValueError as error:
            raise AgentError("ToriiGate 结构化结果不是完整 JSON，请切换 short 或重试") from error
    if profile.data["style"] == "tags":
        text = ", ".join(tags) if tags else caption
    else:
        text = caption or ", ".join(tag.replace("_", " ") for tag in tags)
    if not text:
        raise AgentError("当前阈值下没有可导入的标签，请降低阈值或更换来源")
    return profile.validate_snapshot(text)


class InterrogationService:
    def __init__(self, runtime):
        self.runtime = runtime
        self.config = InterrogationConfig(runtime.directory)
        from .image_expansion import ImageObservations
        self.observations = ImageObservations()

    def vision_config(self, choice):
        if choice == "current":
            return self.runtime.provider_config()
        if choice in ("dsh-workbuddy", "dsh-opencode"):
            from .native_config import transport_options
            overrides = transport_options(self.runtime.config.load())
            return self.runtime.native_source.resolve(choice, overrides)
        if choice == "workbuddy":
            path = self.runtime.directory / "providers" / "workbuddy.json"
            if not path.exists():
                raise AgentError("请先保存 WorkBuddy 看图模型配置，或选择当前模型连接。")
            return ConfigStore(path).load()
        raise AgentError("未知看图模型连接。")

    async def expand(self, request):
        from .image_expansion import expand_image
        from .interrogation_progress import reporter
        sid = request.get("session_id", "")
        progress = reporter(sid)
        options = request.get("options", {})
        if not isinstance(options, dict):
            raise AgentError("看图扩写参数必须是对象。")
        image = (await asyncio.to_thread(prepare_image, request["image"]) if request.get("image") else None)
        row = self.observations.get(sid, request.get("observation_id", ""), image)
        progress({"stage": "expanding"})
        expanded = await expand_image(row.image, row.result, self.runtime.profiles.get(request.get("profile") or "anima"),
                                      options, self.vision_config(options.get("vision_provider", "current")), session_id=sid)
        result = {**row.result, **expanded, "observation_id": request["observation_id"]}
        progress({"stage": "completed"})
        return result

    def meta(self):
        from .interrogators.local_wd14 import available_models
        return {"sources": SOURCES, "config": self.config.public(), "models": available_models()}

    async def run(self, request: dict, *, tensor=None):
        from .interrogation_progress import reporter
        progress = reporter(request.get("session_id", ""))
        try:
            progress({"stage": "preparing"})
            result = await self._run(request, tensor=tensor, on_progress=progress)
            if not result.get("expansion_error"):
                progress({"stage": "completed"})
            return result
        except asyncio.CancelledError:
            progress({"stage": "cancelled"})
            raise
        except AgentError as error:
            progress({"stage": "failed", "message": str(error)})
            raise

    async def _run(self, request: dict, *, tensor=None, on_progress=None):
        source = request.get("source") or "local-wd14"
        if source not in {item["id"] for item in SOURCES}:
            raise AgentError("未知反推来源")
        options = request.get("options", {})
        if not isinstance(options, dict):
            raise AgentError("反推参数必须是 JSON 对象")
        profile = self.runtime.profiles.get(request.get("profile") or "anima")
        image = await asyncio.to_thread(prepare_image, request.get("image"), tensor)
        config = self.config.load()
        if source == "local-wd14":
            on_progress({"stage": "processing"})
            from .interrogators.local_wd14 import interrogate_wd14
            result = await interrogate_wd14(image, {"model": config["wd14_model"], **options})
        elif source in ("pixai-online", "toriigate-online"):
            from .interrogators.hf_space import interrogate_space
            result = await interrogate_space(source, image, options, token=config["hf_token"],
                                             proxy=config["proxy"], timeout=config["timeout"], on_progress=on_progress)
        else:
            on_progress({"stage": "processing"})
            from .interrogators.vision import interrogate_vision
            path = self.runtime.directory / "providers" / "workbuddy.json"
            if not path.exists():
                raise AgentError("请先保存 WorkBuddy Provider 配置")
            result = await interrogate_vision(image, {**options, "profile": profile.id}, ConfigStore(path).load(),
                                              session_id=request.get("session_id", ""))
        message = "反推完成，确认后可导入并继续编辑。"
        try:
            formatted = format_result(result, profile)
        except AgentError as error:
            formatted, message = "", f"已取得原始结果，但尚不能直接导入：{error}"
        result = {**result, "formatted_prompt": formatted, "message": message}
        sid = request.get("session_id", "")
        result["observation_id"] = self.observations.store(sid, image, result)
        if options.get("auto_expand"):
            try:
                result = await self.expand({**request, "image": None, "observation_id": result["observation_id"]})
            except AgentError as error:
                result["expansion_error"] = str(error)
                result["message"] = "标签反推完成，但看图扩写失败：" + str(error)
                on_progress({"stage": "expansion_failed", "message": str(error), "result": result})
        return result
