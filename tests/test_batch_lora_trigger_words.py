"""TK 批量 LoRA 加载器 · trigger_words 输出行为回归（离线，无需启动 ComfyUI）。

覆盖用户需求：
  1. trigger_words 只输出「本节点激活（权重非 0）」LoRA 的触发词；
  2. 激活但文件缺失/加载失败的 LoRA 也要带出触发词；
  3. 总开关 output_trigger_words=False 时输出空字符串；
  4. 去重保序；触发词来源优先级：节点推送的持久表 > 内存 bridge > bridge 文件；
  5. 名称形态（带扩展名/子目录/纯文件名）都能命中同一份触发词。

用 stub 顶掉 comfy / folder_paths / server / aiohttp，直接 import 被测模块。
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import types

sys.stdout.reconfigure(encoding="utf-8")

PLUGIN_DIR = r"E:\claude program\ComfyUI-Anima-Batch-LoRA"
PKG = "tk_plugin_under_test"
FAILED = 0


def check(name: str, condition: bool, detail: object = "") -> None:
    global FAILED
    if condition:
        print(f"PASS {name}")
    else:
        FAILED += 1
        print(f"FAIL {name}  :: {detail}")


# ── stub 环境 ──
LORA_FILES = {
    "style/@zmd style_anima.safetensors": r"X:\fake\@zmd style_anima.safetensors",
    "chars/plana.safetensors": r"X:\fake\plana.safetensors",
    "deadpurity_c1-st3000-comfy.safetensors": r"X:\fake\deadpurity.safetensors",
}


def build_stubs():
    pkg = types.ModuleType(PKG)
    pkg.__path__ = [PLUGIN_DIR]
    sys.modules[PKG] = pkg

    comfy = types.ModuleType("comfy")
    comfy_sd = types.ModuleType("comfy.sd")
    comfy_utils = types.ModuleType("comfy.utils")
    loaded = []

    def load_lora_for_models(model, clip, data, ms, cs):
        loaded.append((ms, cs))
        return model, clip

    comfy_sd.load_lora_for_models = load_lora_for_models
    comfy_utils.load_torch_file = lambda path, safe_load=True: {"__path__": path}
    comfy.sd = comfy_sd
    comfy.utils = comfy_utils
    sys.modules["comfy"] = comfy
    sys.modules["comfy.sd"] = comfy_sd
    sys.modules["comfy.utils"] = comfy_utils

    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_filename_list = lambda kind: list(LORA_FILES) if kind == "loras" else []
    folder_paths.get_full_path = lambda kind, name: LORA_FILES.get(name)
    folder_paths.get_folder_paths = lambda kind: [r"X:\fake"]
    folder_paths.get_output_directory = lambda: tempfile.gettempdir()
    sys.modules["folder_paths"] = folder_paths

    aiohttp = types.ModuleType("aiohttp")
    web = types.ModuleType("aiohttp.web")
    web.json_response = lambda *a, **k: None
    web.Response = object
    web.FileResponse = object
    aiohttp.web = web
    sys.modules["aiohttp"] = aiohttp
    sys.modules["aiohttp.web"] = web

    server = types.ModuleType("server")

    class _Routes:
        def get(self, _path):
            return lambda fn: fn

        def post(self, _path):
            return lambda fn: fn

    class _PromptServer:
        instance = types.SimpleNamespace(routes=_Routes())

    server.PromptServer = _PromptServer
    sys.modules["server"] = server

    thumbs = types.ModuleType(PKG + ".anima_thumbs")
    thumbs.SUPPORTED_WIDTHS = (512, 768)
    thumbs.resolve_within_root = lambda root, rel: None
    thumbs.plugin_cache_root = lambda plugin_dir, width: tempfile.gettempdir()
    thumbs.ensure_thumbnail = lambda *a, **k: ("", False)
    gallery = types.ModuleType(PKG + ".anima_gallery")
    gallery.build_index = lambda *a, **k: {}
    gallery.load_index = lambda *a, **k: {}
    gallery.parse_full = lambda *a, **k: {}
    sys.modules[PKG + ".anima_thumbs"] = thumbs
    sys.modules[PKG + ".anima_gallery"] = gallery
    return loaded


def main() -> int:
    loaded = build_stubs()
    mod = importlib.import_module(PKG + ".anima_batch_lora")

    # 触发词持久表指向临时文件，别污染插件 data 目录
    tmpdir = tempfile.mkdtemp(prefix="tk-tw-")
    mod.TRIGGER_WORDS_PATH = os.path.join(tmpdir, "lora_trigger_words.json")
    mod._TRIGGER_WORDS_CACHE.update({"mtime": -1.0, "map": {}})
    mod.BRIDGE_DATA.clear()

    # ① 名称候选键
    keys = mod._trigger_word_keys("style/@zmd style_anima.safetensors")
    check("候选键覆盖 全路径/去扩展名/纯文件名", 
          "style/@zmd style_anima.safetensors" in keys and "style/@zmd style_anima" in keys
          and "@zmd style_anima.safetensors" in keys and "@zmd style_anima" in keys, keys)

    # ② 持久表读写
    total = mod._merge_trigger_words({
        "@zmd style_anima.safetensors": ["@zmd style"],
        "plana.safetensors": ["plana (blue archive)", "1girl"],
        "deadpurity_c1-st3000-comfy.safetensors": ["deadpurit"],
    })
    check("持久表写入并落盘", total == 3 and os.path.isfile(mod.TRIGGER_WORDS_PATH), total)
    with open(mod.TRIGGER_WORDS_PATH, encoding="utf-8") as fh:
        saved = json.load(fh)
    check("落盘 JSON 结构正确", isinstance(saved.get("loras"), dict) and len(saved["loras"]) == 3, list(saved))

    # ③ 只输出「激活」LoRA 的触发词；禁用(0 权重)项排除；文件缺失但激活的项要带出
    syntax = " ".join([
        "<lora:style/@zmd style_anima:0.90>",
        "<lora:chars/plana:0.00>",                                  # 禁用（前端以 0 权重写入）
        "<lora:missing/not_on_disk:0.80>",                           # 激活但文件不存在
    ])
    mod._merge_trigger_words({"missing/not_on_disk": ["missing-trigger"]})
    loader = mod.AnimaBatchLoRALoader()
    _model, _clip, text = loader.load_loras("MODEL", syntax, clip=None, output_trigger_words=True)
    check("输出激活 LoRA 的触发词（顺序=列表顺序）", text == "@zmd style, missing-trigger", text)
    check("禁用(0 权重)LoRA 的触发词不输出", "plana" not in text, text)
    check("文件缺失但激活的 LoRA 仍输出触发词", "missing-trigger" in text, text)
    check("只加载「激活且在盘」的项（0 权重不加载、缺文件跳过）", loaded == [(0.9, 0.9)], loaded)

    # ④ 总开关关闭 → 空字符串
    loaded.clear()
    _model, _clip, off_text = loader.load_loras("MODEL", syntax, clip=None, output_trigger_words=False)
    check("总开关关闭时输出空字符串", off_text == "", repr(off_text))
    check("总开关关闭不影响 LoRA 加载", loaded == [(0.9, 0.9)], loaded)

    # ⑤ 去重保序（大小写不敏感）
    mod._merge_trigger_words({"dup/a.safetensors": ["Shared Word"], "dup/b.safetensors": ["shared word", "unique"]})
    _m, _c, dedup = loader.load_loras("MODEL", "<lora:dup/a:1> <lora:dup/b:1>", clip=None, output_trigger_words=True)
    check("触发词去重且保序", dedup == "Shared Word, unique", dedup)

    # ⑥ 优先级：持久表 > 内存 bridge > bridge 文件
    mod.BRIDGE_DATA.clear()
    mod.BRIDGE_DATA.update({"lora_list": [{"name": "prio/x.safetensors", "trigger_words": ["from-memory-bridge"]}]})
    mod._merge_trigger_words({"prio/x.safetensors": ["from-node-push"]})
    _m, _c, prio = loader.load_loras("MODEL", "<lora:prio/x:1>", clip=None, output_trigger_words=True)
    check("节点推送的持久表优先于内存 bridge", prio == "from-node-push", prio)
    mod.BRIDGE_DATA.clear()

    # ⑦ 查不到触发词时输出空（不回退文件名，避免污染提示词）
    _m, _c, empty = loader.load_loras("MODEL", "<lora:style/@zmd style_anima:1>".replace("@zmd style_anima", "unknown_lora"), clip=None, output_trigger_words=True)
    check("未知 LoRA 不输出文件名当触发词", empty == "", repr(empty))

    # ⑧ 空 syntax → 空输出，不抛异常
    _m, _c, blank = loader.load_loras("MODEL", "   ", clip=None, output_trigger_words=True)
    check("空标签输入输出空字符串", blank == "", repr(blank))

    # ⑨ HTTP 契约：POST /anima/lora_trigger_words（前端 _pushTriggerWordsNow 的 payload）
    import asyncio

    captured = {}

    class _FakeRequest:
        def __init__(self, body):
            self._body = body

        async def json(self):
            return self._body

    def fake_json_response(payload=None, status=200, **kwargs):
        captured["payload"] = payload
        captured["status"] = status
        return captured

    web = sys.modules["aiohttp.web"]
    web.json_response = fake_json_response
    mod._merge_trigger_words({"http/x.safetensors": ["http-word"]})
    asyncio.run(mod.save_lora_trigger_words(_FakeRequest({"loras": {"http/y.safetensors": ["y-word", "  "]}})))
    check("POST 端点返回 saved/total 且忽略空词", 
          captured["payload"].get("saved") == 1 and captured["payload"].get("total", 0) >= 2, captured.get("payload"))
    check("POST 端点把新条目写入持久表", mod._load_trigger_words().get("http/y.safetensors") == ["y-word"],
          mod._load_trigger_words().get("http/y.safetensors"))
    asyncio.run(mod.save_lora_trigger_words(_FakeRequest({})))
    check("POST 端点缺 loras 字段时返回 400", captured.get("status") == 400, captured.get("payload"))
    asyncio.run(mod.get_lora_trigger_words(None))
    check("GET 端点返回触发词表", isinstance(captured["payload"].get("loras"), dict) and captured["payload"].get("total", 0) >= 2,
          captured["payload"].get("total"))

    # ⑩ 回归：模糊匹配分支不得再抛 NameError（历史 bug：调用了未定义的 base()）
    try:
        fuzzy = mod._find_lora_path("zmd style")   # 走 token 匹配分支
        check("模糊匹配分支不再抛 NameError", isinstance(fuzzy, str) and "zmd" in fuzzy.lower(), fuzzy)
    except NameError as exc:
        check("模糊匹配分支不再抛 NameError", False, f"NameError: {exc}")

    print("\n=== ALL PASS ===" if FAILED == 0 else f"\n=== {FAILED} FAILED ===")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
