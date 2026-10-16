"""Pure, output-scoped generation configuration; never imports or executes nodes.

Core contracts are from ComfyUI nodes.py/nodes_custom_sampler.py. TK's loader
stores ``lora_syntax`` tags, not a JSON stack; disabled tags are serialized with
zero weights. ``active`` means a nonzero channel on the selected dependency
branch, not proof that an external LoRA file loaded successfully. Embedded
CLIP/VAE components report their checkpoint source file, not an invented name.
"""
from __future__ import annotations

import math
import re

from .output_metadata import image_dependency_nodes, normalize_graph, is_image_save_type

_IMAGE_KEYS = {"images", "image", "samples", "latent", "latent_image", "pixels", "input_image",
               "image_a", "image_b", "image1", "image2", "image_1", "image_2", "latents"}
_ROLES = {"model": "MODEL", "model1": "MODEL", "model2": "MODEL", "clip": "CLIP", "vae": "VAE",
          "positive": "CONDITIONING", "negative": "CONDITIONING", "positive_cond": "CONDITIONING",
          "negative_cond": "CONDITIONING", "conditioning": "CONDITIONING", "conditioning_1": "CONDITIONING",
          "conditioning_2": "CONDITIONING", "conditioning_to": "CONDITIONING", "conditioning_from": "CONDITIONING",
          "guider": "GUIDER", "sigmas": "SIGMAS", "sampler": "SAMPLER", "noise": "NOISE"}
_SAMPLERS = {"ksampler", "ksampleradvanced", "samplercustom", "samplercustomadvanced"}
_LORA_TYPES = {"loraloader", "loraloadermodelonly", "tk batch lora loader", "animabatchloraloader"}
_KNOWN_IMAGE = {"vaedecode", "vaedecodetiled", "vaeencode", "vaeencodetiled", "vaeencodeforinpaint",
                "latentupscale", "latentupscaleby", "imagescale", "imagescaleby", "reroute", "loadimage"}
_KNOWN_RESOURCE = {"basicguider", "cfgguider", "basicscheduler", "ksamplerselect", "randomnoise", "disablenoise",
                   "conditioningcombine", "conditioningconcat", "conditioningaverage", "conditioningsetarea",
                   "conditioningsetareapercentage", "conditioningsettimesteprange", "conditioningsetmask"}
_WIDGETS = {
    "checkpointloadersimple": ("ckpt_name",), "checkpointloader": ("config_name", "ckpt_name"),
    "unetloader": ("unet_name", "weight_dtype"), "diffusersloader": ("model_path",),
    "cliploader": ("clip_name", "type", "device"), "dualcliploader": ("clip_name1", "clip_name2", "type", "device"),
    "triplecliploader": ("clip_name1", "clip_name2", "clip_name3"), "vaeloader": ("vae_name",),
    "loraloader": ("lora_name", "strength_model", "strength_clip"),
    "loraloadermodelonly": ("lora_name", "strength_model"),
    "tk batch lora loader": ("lora_syntax", "output_trigger_words"),
    "animabatchloraloader": ("lora_syntax", "output_trigger_words"),
    "ksampler": ("seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"),
    "ksampleradvanced": ("add_noise", "noise_seed", "steps", "cfg", "sampler_name", "scheduler",
                          "start_at_step", "end_at_step", "return_with_leftover_noise"),
    "samplercustom": ("add_noise", "noise_seed", "cfg"), "cfgguider": ("cfg",),
    "basicscheduler": ("scheduler", "steps", "denoise"), "ksamplerselect": ("sampler_name",),
    "randomnoise": ("noise_seed",),
}
_LORA_RE = re.compile(r"<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>", re.IGNORECASE)


def _raw_nodes(graph):
    if isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
        return {str(row["id"]): row for row in graph["nodes"] if isinstance(row, dict) and row.get("id") is not None}
    if isinstance(graph, list):
        return {str(row["id"]): row for row in graph if isinstance(row, dict) and row.get("id") is not None}
    return {str(key): row for key, row in graph.items() if isinstance(row, dict)} if isinstance(graph, dict) else {}


def _nodes(graph):
    nodes, raw_nodes = normalize_graph(graph), _raw_nodes(graph)
    for node_id, node in nodes.items():
        raw = raw_nodes.get(node_id, {})
        node["properties"] = raw.get("properties") if isinstance(raw.get("properties"), dict) else {}
        meta = raw.get("_meta")
        if not raw.get("title") and isinstance(meta, dict) and isinstance(meta.get("title"), str):
            node["label"] = meta["title"]
        widgets = raw.get("widgets_values")
        if not isinstance(raw.get("inputs"), list) or not isinstance(widgets, list):
            continue
        names = _WIDGETS.get(node["type"].lower(), ())
        control_index = 1 if node["type"].lower() == "ksampler" else 2 if node["type"].lower() in {"ksampleradvanced", "samplercustom"} else None
        if control_index is not None and len(widgets) > control_index and widgets[control_index] in ("fixed", "increment", "decrement", "randomize"):
            names = names[:control_index] + ("control_after_generate",) + names[control_index:]
        explicit = {str(item.get("widget", {}).get("name") or item.get("name")): item.get("widget", {}).get("value", item.get("value"))
                    for item in raw["inputs"] if isinstance(item, dict) and isinstance(item.get("widget"), dict)
                    and ("value" in item["widget"] or "value" in item)}
        for index, name in enumerate(names):
            if name not in node["refs"] and index < len(widgets):
                node["values"][name] = explicit[name] if name in explicit else widgets[index]
    return nodes


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)) or value == "":
        return None
    try:
        number = float(value)
    except (ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _integer(value):
    number = _number(value)
    return int(number) if number is not None and 0 <= number <= 9007199254740991 and number.is_integer() else None


def _string(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int)):
        return str(value).strip()
    return str(int(value)) if isinstance(value, float) and math.isfinite(value) and value.is_integer() else str(value) if isinstance(value, float) and math.isfinite(value) else ""


def _is_stage(node):
    ctype = node["type"].lower()
    if ctype in _SAMPLERS:
        return True
    fields = set(node["refs"]) | set(node["values"])
    return "sampler" in ctype and bool(fields & {"positive", "positive_cond", "guider", "conditioning"})


class _Generation:
    def __init__(self, nodes):
        self.nodes = nodes
        self.warnings = []
        self.ambiguous = False
        self.files = {"checkpoints": [], "textEncoders": [], "vaes": []}
        self.loras = {}
        self.lora_unknown_active = set()
        self.resource_seen = set()
        self.resource_active = set()

    def warn(self, message):
        if message not in self.warnings and len(self.warnings) < 64:
            self.warnings.append(message)

    def field(self, node, key, stack=()):
        if not node:
            return None
        if key not in node["refs"]:
            return node["values"].get(key)
        node_id, slot = node["refs"][key]
        source = self.nodes.get(node_id)
        if not source or node_id in stack or len(stack) >= 128:
            self.warn("生成参数 " + node["id"] + "." + key + " 的来源缺失或包含循环")
            return None
        ctype = source["type"].lower()
        if "primitive" in ctype or ctype in {"string", "stringconstant", "string constant", "string literal"}:
            return self.field(source, "value", stack + (node_id,)) if slot == 0 else None
        if ctype == "reroute" and len(source["refs"]) == 1:
            return self.field(source, next(iter(source["refs"])), stack + (node_id,))
        self.warn("生成参数 " + node["id"] + "." + key + " 的运行期变换未记录")
        return None

    def provider(self, node, key, allowed):
        edge = node["refs"].get(key)
        seen = set()
        while edge and edge[0] not in seen:
            seen.add(edge[0])
            source = self.nodes.get(edge[0])
            if source and source["type"].lower() in allowed and edge[1] == 0:
                return source
            if source and source["type"].lower() == "reroute" and len(source["refs"]) == 1:
                edge = next(iter(source["refs"].values()))
            else:
                break
        return None

    def stage(self, node, active):
        ctype = node["type"].lower()
        stage = {"nodeId": node["id"], "label": node["label"], "steps": "", "cfg": "", "seed": "",
                 "sampler": "", "scheduler": "", "denoise": "", "active": active}
        for output, key in (("steps", "steps"), ("cfg", "cfg"), ("seed", "seed"), ("sampler", "sampler_name"),
                            ("scheduler", "scheduler"), ("denoise", "denoise")):
            stage[output] = _string(self.field(node, key))
        noise_seed = self.field(node, "noise_seed")
        if ctype in {"samplercustom", "samplercustomadvanced"}:
            scheduler = self.provider(node, "sigmas", {"basicscheduler"})
            sampler = self.provider(node, "sampler", {"ksamplerselect"})
            if scheduler:
                for output, key in (("steps", "steps"), ("scheduler", "scheduler"), ("denoise", "denoise")):
                    stage[output] = _string(self.field(scheduler, key))
            if sampler:
                stage["sampler"] = _string(self.field(sampler, "sampler_name"))
            if ctype == "samplercustomadvanced":
                guider = self.provider(node, "guider", {"cfgguider", "basicguider"})
                noise = self.provider(node, "noise", {"randomnoise", "disablenoise"})
                if guider:
                    stage["cfg"] = "1" if guider["type"].lower() == "basicguider" else _string(self.field(guider, "cfg"))
                if noise:
                    noise_seed = self.field(noise, "noise_seed") if noise["type"].lower() == "randomnoise" else 0
            if not scheduler or not sampler:
                self.warn("采样阶段 " + node["id"] + " 的自定义采样器或 sigma 序列未完整记录")
        if noise_seed is not None:
            stage["noiseSeed"] = stage["seed"] = _string(noise_seed)
        if ctype == "ksampleradvanced":
            stage["denoise"] = stage["denoise"] or "1"  # Core method's explicit default; no denoise widget.
            for output, key in (("startAtStep", "start_at_step"), ("endAtStep", "end_at_step"),
                                ("addNoise", "add_noise"), ("returnWithLeftoverNoise", "return_with_leftover_noise")):
                stage[output] = _string(self.field(node, key))
        elif "add_noise" in node["values"] or "add_noise" in node["refs"]:
            stage["addNoise"] = _string(self.field(node, "add_noise"))
        steps, denoise = _integer(stage["steps"]), _number(stage["denoise"])
        if steps is not None and denoise is not None and ctype in _SAMPLERS:
            effective = 0 if denoise <= 0 else steps
            if ctype == "ksampleradvanced":
                start, end = _integer(stage["startAtStep"]), _integer(stage["endAtStep"])
                if start is None or end is None:
                    effective = None
                    self.warn("采样阶段 " + node["id"] + " 的开始或结束步数未完整记录")
                else:
                    effective = max(0, min(steps, end) - start) if denoise > 0 else 0
            if effective is not None:
                stage["effectiveSteps"] = effective
        for field in ("steps", "cfg", "seed", "sampler", "scheduler", "denoise"):
            if not stage[field]:
                self.warn("采样阶段 " + node["id"] + " 的 " + field + " 未完整记录")
        if ctype not in _SAMPLERS:
            self.warn("采样阶段 " + node["id"] + " 的扩展节点语义未完整识别；保留已记录参数")
        return stage

    def file(self, node, key, target):
        value = self.field(node, key)
        if isinstance(value, str) and value.strip():
            value = value.strip()
            if value not in self.files[target]:
                self.files[target].append(value)
        else:
            self.warn("资源节点 " + node["id"] + " 的 " + key + " 未完整记录")

    def lora_entries(self, node):
        ctype = node["type"].lower()
        if ctype in {"tk batch lora loader", "animabatchloraloader"}:
            syntax = self.field(node, "lora_syntax")
            if not isinstance(syntax, str) or not syntax.strip():
                self.warn("LoRA 节点 " + node["id"] + " 使用运行期 bridge，图片未记录其实际列表")
                return []
            rows = []
            for match in _LORA_RE.finditer(syntax):
                model, clip = _number(match[2]), _number(match[3] if match[3] is not None else match[2])
                if model is None or clip is None:
                    self.warn("LoRA 节点 " + node["id"] + " 含无效权重，未推测其加载状态")
                    continue
                rows.append((match[1].strip(), model, clip))
            return rows
        name = self.field(node, "lora_name")
        if not isinstance(name, str) or not name.strip():
            self.warn("LoRA 节点 " + node["id"] + " 的名称未完整记录")
            return []
        model = _number(self.field(node, "strength_model"))
        clip = 0 if ctype == "loraloadermodelonly" else _number(self.field(node, "strength_clip"))
        if model is None or clip is None:
            self.warn("LoRA 节点 " + node["id"] + " 的权重未完整记录")
        return [(name.strip(), model, clip)]

    def add_loras(self, node, role, output_owned):
        disabled = node["properties"].get("animaLoraDisabled", {})
        disabled = {str(name).strip().replace("\\", "/").removeprefix("./").lower() for name in disabled} if isinstance(disabled, dict) else set()
        for index, (name, model, clip) in enumerate(self.lora_entries(node)):
            key = (node["id"], index)
            enabled = node["mode"] not in (2, 4) and name.strip().replace("\\", "/").removeprefix("./").lower() not in disabled and not (model == 0 and clip == 0)
            row = self.loras.setdefault(key, {"name": name, "strengthModel": model, "strengthClip": clip,
                                             "enabled": enabled, "nodeId": node["id"], "active": False if not enabled else None})
            if output_owned and enabled:
                weight = model if role == "MODEL" else clip
                if weight is None:
                    self.lora_unknown_active.add(key)
                elif weight != 0:
                    row["active"] = True
                if row["active"] is not True:
                    row["active"] = None if key in self.lora_unknown_active else False

    def resource(self, edge, role, output_owned):
        node_id, slot = edge
        key = (node_id, slot, role)
        if key in self.resource_seen:
            return
        if key in self.resource_active or len(self.resource_active) >= 256 or len(self.resource_seen) >= 4096:
            self.warn("生成资源依赖包含循环或超过解析上限")
            return
        node = self.nodes.get(node_id)
        if node is None:
            self.warn("生成资源依赖引用缺失节点 " + node_id)
            return
        self.resource_active.add(key)
        ctype = node["type"].lower()
        if ctype in {"checkpointloadersimple", "checkpointloader", "diffusersloader"}:
            targets = {0: ("MODEL", "checkpoints"), 1: ("CLIP", "textEncoders"), 2: ("VAE", "vaes")}
            match = targets.get(slot)
            if match and role == match[0]:
                self.file(node, "model_path" if ctype == "diffusersloader" else "ckpt_name", match[1])
            else:
                self.warn("Checkpoint 节点 " + node_id + " 的输出槽与资源类型不匹配")
        elif ctype == "unetloader" and role == "MODEL" and slot == 0:
            self.file(node, "unet_name", "checkpoints")
        elif ctype in {"cliploader", "dualcliploader", "triplecliploader"} and role == "CLIP" and slot == 0:
            fields = ("clip_name",) if ctype == "cliploader" else ("clip_name1", "clip_name2") if ctype == "dualcliploader" else ("clip_name1", "clip_name2", "clip_name3")
            for field in fields:
                self.file(node, field, "textEncoders")
        elif ctype == "vaeloader" and role == "VAE" and slot == 0:
            self.file(node, "vae_name", "vaes")
        elif ctype in _LORA_TYPES and role in {"MODEL", "CLIP"}:
            expected = "MODEL" if slot == 0 else "CLIP" if slot == 1 and ctype != "loraloadermodelonly" else None
            if expected != role:
                self.warn("LoRA 节点 " + node_id + " 的输出槽与资源类型不匹配")
            else:
                input_key = "model" if role == "MODEL" else "clip"
                source = node["refs"].get(input_key)
                if source:
                    self.resource(source, role, output_owned)
                else:
                    self.warn("LoRA 节点 " + node_id + " 缺少 " + input_key + " 资源输入")
                self.add_loras(node, role, output_owned)
        else:
            edges = [(edge, _ROLES.get(name) or node["inputTypes"].get(name))
                     for name, edge in node["refs"].items() if name in _ROLES or node["inputTypes"].get(name) in set(_ROLES.values())]
            if ctype == "reroute" and len(node["refs"]) == 1:
                edges = [(next(iter(node["refs"].values())), role)]
            same = [edge for edge, kind in edges if kind == role]
            known = ctype in _KNOWN_RESOURCE or "cliptextencode" in ctype
            if len(same) > 1 and role in {"MODEL", "CLIP", "VAE"}:
                self.ambiguous = True
                self.warn("资源节点 " + node_id + " 的实际选择未记录；仅保留记录配置")
            elif not known and ctype != "reroute" and edges:
                self.warn("资源变换节点 " + node_id + " 未完整识别；保留可核验输入配置")
            elif not edges and role in {"MODEL", "CLIP", "VAE"}:
                self.warn("资源节点 " + node_id + "（" + node["type"] + "）的来源未完整识别")
            for source, kind in edges:
                self.resource(source, kind, output_owned)
        self.resource_active.remove(key)
        self.resource_seen.add(key)

    def dependencies(self, node, output_owned):
        for name, edge in node["refs"].items():
            kind = _ROLES.get(name) or node["inputTypes"].get(name)
            if kind in set(_ROLES.values()):
                self.resource(edge, kind, output_owned)

    def recorded(self):
        """All recorded loaders are candidates when output ownership is unknown."""
        for node in self.nodes.values():
            ctype = node["type"].lower()
            if ctype in {"checkpointloadersimple", "checkpointloader", "diffusersloader"}:
                for slot, role in enumerate(("MODEL", "CLIP", "VAE")):
                    self.resource((node["id"], slot), role, False)
            elif ctype in {"unetloader", "cliploader", "dualcliploader", "triplecliploader", "vaeloader"}:
                self.resource((node["id"], 0), "MODEL" if ctype == "unetloader" else "VAE" if ctype == "vaeloader" else "CLIP", False)
            elif ctype in _LORA_TYPES:
                self.add_loras(node, "MODEL", False)
            if _is_stage(node):
                self.dependencies(node, False)


def parse_generation_details(graph, output_node_id=None):
    """Return JSON-safe known configuration and a separate ownership status.

    A unique active SaveImage, or its explicit ID, determines the image spine.
    Unknown image routing and multiple saves never select a longest/first path.
    ``effectiveSteps`` counts scheduled sigma intervals (including Advanced
    clipping), not runtime model evaluations or a benchmark of completed steps.
    Dynamic sigma transforms/custom nodes need runtime receipts or an adapter.
    """
    nodes = _nodes(graph)
    parser = _Generation(nodes)
    result = {**parser.files, "loraDetails": [], "generationStages": [], "generationStatus": "missing",
              "generationScope": "recorded", "generationOutputNodeId": None, "generationWarnings": []}
    saves = [node["id"] for node in nodes.values() if is_image_save_type(node["type"])
             and node["mode"] not in (2, 4) and any(key in node["refs"] for key in ("images", "image"))]
    root = str(output_node_id) if output_node_id is not None else saves[0] if len(saves) == 1 else None
    if output_node_id is not None and root not in saves:
        result["generationWarnings"] = ["图片的保存节点标识不存在"]
        return result
    if not nodes:
        return result
    stages = []
    if root:
        spine, warnings = image_dependency_nodes(graph, root)
        for warning in warnings:
            parser.warn(warning)
        parser.ambiguous = any("分流" in warning for warning in warnings)
        if not parser.ambiguous:
            visited = set()

            def visit(node_id):
                if node_id in visited or node_id not in spine:
                    return
                visited.add(node_id)
                node = nodes[node_id]
                for name, edge in node["refs"].items():
                    if name in _IMAGE_KEYS or node["inputTypes"].get(name) in ("IMAGE", "LATENT"):
                        visit(edge[0])
                if _is_stage(node):
                    stages.append(parser.stage(node, True))
                elif node["refs"] and node["type"].lower() not in _KNOWN_IMAGE and not is_image_save_type(node["type"]):
                    parser.warn("图像变换节点 " + node_id + " 未完整识别；保留可核验输入配置")
                parser.dependencies(node, True)

            visit(root)
            result["generationScope"] = "output"
            result["generationOutputNodeId"] = root
            # 链上没有任何模型/LoRA 记录时退到图级记录配置：部分保存的图只留下记录
            # 字段而没有保留连线（旧实现按节点顺序提取，这里保持同等覆盖）。链上已
            # 取到文件时保持严格排除未连接节点，两者不冲突。
            if not any(parser.files.values()) and not parser.loras:
                parser.recorded()
                if stages or any(parser.files.values()) or parser.loras:
                    parser.warn("模型连线未保存；补充资源仅为工作流记录配置，未核验用于本图")
    else:
        parser.ambiguous = len(saves) > 1 or sum(_is_stage(node) for node in nodes.values()) > 1
        parser.warn("图片包含多个保存分支，未记录对应保存节点；仅列记录配置" if len(saves) > 1
                    else "缺少保存节点，无法核验本图所属分支；仅列记录配置")
    if parser.ambiguous or not root:
        parser.recorded()
        stages = [parser.stage(node, None) for node in nodes.values() if _is_stage(node) and node["mode"] not in (2, 4)]
        result["generationScope"] = "recorded"
        result["generationOutputNodeId"] = None
        if parser.ambiguous:
            parser.warn("输出归属不确定；以上内容仅为记录配置，不代表本图实际使用")
            for row in parser.loras.values():
                row["active"] = None if row["enabled"] else False
    result["loraDetails"] = list(parser.loras.values())
    result["generationStages"] = stages
    result["generationWarnings"] = parser.warnings
    has_data = bool(stages or result["loraDetails"] or any(parser.files.values()))
    result["generationStatus"] = "ambiguous" if parser.ambiguous else "missing" if not has_data else "partial" if parser.warnings else "complete"
    return result
