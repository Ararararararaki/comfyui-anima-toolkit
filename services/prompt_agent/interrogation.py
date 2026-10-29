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
    {"id": "workbuddy-vision", "label": "所选模型看图", "kind": "llm", "note": "使用本节点统一选择的连接与模型；每次只发当前图片和短描述指令。"},
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

    def vision_config(self, choice, model=""):
        return self.runtime.model_config({"source": choice, "model": model})

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
        # 扩写 skill 优先（内置基础 skill / DSH skill）；没选则沿用 profile，兼容旧工作流。
        # skill 的 style 决定用哪套输出契约，因此 profile 由 skill 反查而不是让用户手选。
        skill = None
        skill_id = str(request.get("skill") or options.get("expansion_skill") or "").strip()
        if not skill_id:
            # 前端把 skill id 存在既有的 profile 字段里（不改节点 input 定义，旧工作流照旧）。
            # profile id 是不带冒号的短名（anima / krea2），skill id 一定带前缀。
            legacy = str(request.get("profile") or "").strip()
            if ":" in legacy:
                skill_id = legacy
        if skill_id:
            skill = self.runtime.skills.get(skill_id)
            skill = self.runtime.skills.compose(skill, options.get("auxiliary_skills", []))
            profile = self.runtime.skills.profile_for(skill)
        else:
            profile = self.runtime.profiles.get(request.get("profile") or "anima")
        from .image_options import (filter_observation, classify_host_tag,
                                    plan_character_operations, select_character_candidate)
        from .image_expansion import OpenAICompatibleProvider, character_references
        filtered, report = await asyncio.to_thread(filter_observation, row.result, options, classify_host_tag)
        model = options.get("vision_model", "")
        config = dict(self.vision_config(options.get("vision_provider", "current"), model))
        planning = OpenAICompatibleProvider({**config, "max_tokens": min(config.get("max_tokens", 1024), 1024)})
        planning.on_progress = progress
        planning.require_model_match = bool(model.strip())
        planning.bind_session(sid + ":character-plan")
        identities = character_references(row.result)
        instruction = options.get("expansion_instruction", "")
        source_lookup = options.get("lookup_source_characters", True)
        if type(source_lookup) is not bool:
            raise AgentError("源角色查库必须是布尔值。")
        source_evidence, source_warnings = {}, []
        if source_lookup and identities:
            try:
                source_evidence = await self.runtime.references.lookup({"tags": [], "characters": identities})
                for entry in source_evidence.get("characters", []):
                    if len(entry.get("candidates", [])) > 1:
                        source_warnings.append("源角色存在多个候选：" + entry["query"] + "；需结合原图特征判断，不自动认定首项。")
                    if not entry.get("candidates"):
                        source_warnings.append("源角色资料未确认：" + entry["query"] + "；结合原图保留可见特征，不推定人物位置。")
            except (AgentError, OSError, RuntimeError, ValueError):
                source_warnings.append("源角色资料查询暂不可用；继续结合原图和反推标签扩写。")
        # The image pass also detects optional identity edits. Ordinary rewrites
        # now make one model call, with no mandatory standalone planning request.
        expanded = await expand_image(row.image, filtered, profile,
            {**options, "filter_report": report, "source_identities": identities,
             "source_character_evidence": source_evidence}, config, session_id=sid, skill=skill,
            detect_operations=True)
        operations = expanded["character_operations"]
        queries = list(dict.fromkeys(op["target"].strip() for op in operations))
        evidence = await self.runtime.references.lookup({"tags": queries, "characters": queries}) if queries else {}
        resolved, warnings = {}, list(source_warnings)
        for entry in evidence.get("characters", []):
            candidates = entry.get("candidates", [])
            exact = [c for c in candidates if entry["query"].casefold() in
                     [str(c.get(k) or "").casefold() for k in ("zh", "name", "slug", "trigger")]]
            matches = exact or candidates
            picked = matches[0] if len(matches) == 1 else (
                await select_character_candidate(instruction, entry["query"], matches, planning) if matches else None)
            if picked:
                resolved[entry["query"]] = picked.get("trigger") or picked.get("slug") or picked.get("name")
            else:
                warnings.append("角色资料未能唯一匹配：" + entry["query"] + "；按扩写要求使用原名称，不虚构词条。可在扩写要求补充作品名。")
        operations = [{**op, "target": op["target"].strip(), "resolved": resolved.get(op["target"].strip()) or op["target"].strip()} for op in operations]
        targets = list(dict.fromkeys(resolved[query] for query in queries if resolved.get(query)))
        replacements = [op for op in operations if op["action"] == "replace"]
        remaining = [name for name in identities if not any(not op["source"] or op["source"] == name for op in replacements)]
        effective = {**options, "reference_evidence": evidence, "filter_report": report,
                     "source_character_evidence": source_evidence,
                     "character_operations": operations,
                     "requested_characters": list(dict.fromkeys(targets + (remaining if options.get("preserve_identity", True) else [])))}
        if replacements:
            effective.update(preserve_identity=False, replacement_characters=[resolved[op["target"]] for op in replacements if resolved.get(op["target"])])
        if operations:
            expanded = await expand_image(row.image, filtered, profile,
                                          effective, config, session_id=sid, skill=skill)
        source_summary = (f" 源角色查库 {len(identities)} 项，{sum(bool(entry.get('candidates')) for entry in source_evidence.get('characters', []))} 项取得候选资料。" if source_lookup and identities else "")
        result = {**row.result, **expanded, "filter_report": report, "reference_evidence": evidence, "source_character_evidence": source_evidence, "reference_warnings": warnings, "character_operations": operations, "observation_id": request["observation_id"],
                  "message": expanded.get("message", "看图扩写完成。") + source_summary + (" 资料提示：" + "；".join(warnings) if warnings else "")}
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
        prepared = await asyncio.to_thread(prepare_image, request.get("image"), tensor, True)
        image, source_dimensions = prepared if isinstance(prepared, tuple) else (prepared, {})
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
            connection = self.vision_config(options.get("vision_provider", "current"), options.get("vision_model", ""))
            result = await interrogate_vision(image, {**options, "profile": profile.id}, connection,
                                              session_id=request.get("session_id", ""))
        report = {}
        message = "反推完成，确认后可导入并继续编辑。"
        try:
            from .image_options import filter_observation, classify_host_tag
            filtered, report = await asyncio.to_thread(filter_observation, result, options, classify_host_tag)
            formatted = format_result(filtered, profile)
        except AgentError as error:
            formatted, message = "", f"已取得原始结果，但尚不能直接导入：{error}"
        result = {**result, "source_dimensions": source_dimensions, "filter_report": report, "formatted_prompt": formatted, "message": message}
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
