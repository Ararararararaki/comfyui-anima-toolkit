# TK 本地 LLM 翻译 provider（小规模接入，不改变现有 Router 架构）
#
# - ComfyUI 启动时默认不下载、不加载；用户可通过 UI/API 主动启用。
#   Prompt Cards 选择 local_llm 翻译时会按需加载本地文件，翻译会话结束后自动释放。
# - 驱动：
#     gemma-4b  → TranslateGemma-4b-it GGUF Q4_K_M（llama-cpp-python，GPU offload）【默认，实测推荐】
#     qwen3-4b  → Qwen3-4B GGUF Q4_K_M（同一驱动；⚠️ 思考模式暂无法在此 llama.cpp 版本禁用，
#                 raw 调用会先吐 30s 思考块，暂不推荐，保留 Apache-2.0 档位待驱动升级）
# - 许可提示（只做文档/UI 展示，不设硬门禁）：
#     gemma-4b: Gemma License（可商用，遵守条款）
#     qwen3-4b: Apache-2.0（可商用）
#
# 2026-08-26 新建（调研接入轮第一版）；同日修订默认模型 gemma-4b（Qwen 思考问题实测）。

import gc
import json
import os
import threading
import time

# ── 常量 ──

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
try:
    import folder_paths
    TRANSLATORS_DIR = os.path.join(folder_paths.models_dir, "translators")
except Exception:
    TRANSLATORS_DIR = os.path.join(PLUGIN_DIR, "data", "models")
GGUF_DIR = os.path.join(TRANSLATORS_DIR, "translategemma-4b-it-GGUF")
HF_DIR = TRANSLATORS_DIR

MODELS = {
    "qwen3-4b": {
        "label": "Qwen3-4B (Q4_K_M)",
        "kind": "gguf",
        "dir": "qwen3-4b-GGUF",
        "repo": "Qwen/Qwen3-4B-GGUF",
        "file": "Qwen3-4B-Q4_K_M.gguf",
        "size": "≈2.6GB",
        "license": "Apache-2.0（可商用）",
    },
    "gemma-4b": {
        "label": "TranslateGemma-4B (Q4)",
        "kind": "gguf",
        "dir": "translategemma-4b-it-GGUF",
        "repo": "mradermacher/translategemma-4b-it-GGUF",
        "file": "translategemma-4b-it.Q4_K_M.gguf",
        "size": "≈2.3GB",
        "license": "Gemma License（可商用）",
    },
}

# GGUF 模型翻译 prompt 构建（自然语言翻译，不生成 Danbooru 标签；方向随 src/dst 动态）
# 2026-08-26 修订：修复两个实测 bug——
#   1) 模板曾硬编码 Chinese→English，en→zh 时模型收到方向矛盾的指令直接胡来；
#   2) 视觉细节引导被 Gemma 理解成「逐项填写 action/pose/body… 清单」，
#      现明令只输出自然译文、禁止标题/列表/逐字段描述。
_LANG_NAMES = {
    "zh": "Chinese", "zh-CN": "Chinese", "zh-cn": "Chinese",
    "en": "English", "en-US": "English", "en-us": "English",
    "ja": "Japanese", "jp": "Japanese",
}


def _lang_name(code: str) -> str:
    return _LANG_NAMES.get((code or "").strip(), (code or "").strip() or "the target language")


def _build_prompt(model_id: str, text: str, src_lang: str, dst_lang: str) -> str:
    src = _lang_name(src_lang)
    dst = _lang_name(dst_lang)
    if model_id == "qwen3-4b":
        return (
            "<|im_start|>system\n"
            f"Translate the following {src} text into {dst}. "
            "Keep every visual detail (actions, poses, body/limb positions, "
            "left-right/front-back/up-down relations, camera angle, shot distance, occlusion, "
            "number of people and their interaction); do not omit, add or rephrase any information. "
            f"Output ONLY the natural {dst} translation — no headings, no bullet lists, no explanations, no field descriptions.<|im_end|>\n"
            f"<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n"
        )
    return (
        "<start_of_turn>user\n"
        f"Translate the following {src} text into {dst}. "
        "Keep every visual detail (actions, poses, body/limb positions, "
        "left-right/front-back/up-down relations, camera angle, shot distance, occlusion, "
        "number of people and their interaction); do not omit or rephrase any information. "
        f"Output ONLY the natural {dst} translation — no headings, no bullet lists, no explanations, no field descriptions.\n"
        f"{text}<end_of_turn>\n<start_of_turn>model\n"
    )

# ── 状态 ──

_STATE = {
    "model": None,        # 当前已加载模型 id
    "status": "idle",     # idle | downloading | loading | ready | error | unloaded
    "progress": 0.0,
    "error": "",
    "started_at": 0.0,
    "finished_at": 0.0,
}
_STATE_LOCK = threading.Lock()
_INFER_LOCK = threading.Lock()  # 推理互斥（GGUF 单实例）

_GEM_LLM = None       # llama_cpp 实例（当前加载的 GGUF 模型）
_GEM_MODEL_ID = None  # 当前 _GEM_LLM 对应的模型 id
_DL_THREAD = None


def state_snapshot() -> dict:
    with _STATE_LOCK:
        return dict(_STATE)


def _set_status(status: str, progress: float = 0.0, error: str = ""):
    with _STATE_LOCK:
        _STATE["status"] = status
        _STATE["progress"] = progress
        _STATE["error"] = error
        if status == "ready":
            _STATE["finished_at"] = time.time()
        elif status == "downloading" or status == "loading":
            _STATE["started_at"] = time.time()


def _model_path(model_id: str) -> str | None:
    spec = MODELS.get(model_id)
    if not spec:
        return None
    if spec["kind"] == "gguf":
        sub = spec.get("dir") or spec["repo"].split("/")[-1]
        return os.path.join(TRANSLATORS_DIR, sub, spec["file"]) if spec.get("file") else None
    return os.path.join(HF_DIR, spec["repo"].split("/")[-1])


def _model_available(model_id: str) -> bool:
    path = _model_path(model_id)
    return bool(path and os.path.isfile(path) and os.path.getsize(path) > 1024 * 1024)


def _generation_tasks_remaining() -> int | None:
    """读取 ComfyUI 队列；无法确认时返回 None，调用方应安全拒绝。"""
    try:
        from server import PromptServer
        return int(PromptServer.instance.prompt_queue.get_tasks_remaining())
    except Exception:
        return None


def _assert_generation_idle() -> None:
    remaining = _generation_tasks_remaining()
    if remaining is None:
        raise RuntimeError("无法确认 ComfyUI 生图队列状态，为避免显存冲突已阻止本地 LLM")
    if remaining > 0:
        raise RuntimeError(f"ComfyUI 当前有 {remaining} 个生图任务，本地 LLM 暂不加载/推理")


def _hf_env_ok() -> bool:
    """探测官方 HF 可用性；不可用时切 hf-mirror 重试（国内常见）。"""
    import urllib.request
    try:
        with urllib.request.urlopen("https://huggingface.co/api/models/facebook/nllb-200-distilled-600M", timeout=8) as r:
            return r.status == 200
    except Exception:
        return False


def _download_model(model_id: str) -> str:
    """下载 GGUF 到本地；本地文件已完整则跳过（幂等，不联网核对远端）。"""
    spec = MODELS[model_id]
    dest = _model_path(model_id)
    if dest and os.path.exists(dest) and os.path.getsize(dest) > 1024 * 1024:
        return dest
    from huggingface_hub import hf_hub_download
    os.makedirs(GGUF_DIR, exist_ok=True)
    use_mirror = not _hf_env_ok()
    if use_mirror:
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    path = hf_hub_download(repo_id=spec["repo"], filename=spec["file"], local_dir=GGUF_DIR)
    return str(path)


def _load_model(model_id: str):
    global _GEM_LLM, _GEM_MODEL_ID
    from llama_cpp import Llama
    _set_status("loading", 0.9)
    _GEM_LLM = Llama(model_path=_model_path(model_id), n_ctx=4096, verbose=False, n_gpu_layers=-1)
    _GEM_MODEL_ID = model_id


def load_model(model_id: str, force: bool = False, allow_download: bool = True) -> dict:
    """用户主动启用或翻译会话按需启用；可禁止缺失模型自动下载。"""
    global _DL_THREAD
    if model_id not in MODELS:
        return {"ok": False, "error": f"未知模型: {model_id}"}
    try:
        _assert_generation_idle()
    except RuntimeError as error:
        return {"ok": False, "error": str(error), "error_code": "generation_busy"}
    if not allow_download and not _model_available(model_id):
        return {"ok": False, "error": f"本地模型文件不存在：{model_id}（自动翻译不会下载，请在模型管理中明确下载）"}
    with _STATE_LOCK:
        if _STATE["model"] == model_id and _STATE["status"] == "ready" and not force:
            return {"ok": True, "message": f"已加载 {model_id}"}
        if _STATE["model"] == model_id and _STATE["status"] in {"downloading", "loading"} and not force:
            return {"ok": True, "message": f"正在加载 {model_id}"}
        _STATE["model"] = model_id

    def work():
        global _GEM_LLM, _GEM_MODEL_ID
        try:
            # 切换模型时先释放旧实例（避免显存/内存叠加）
            with _INFER_LOCK:
                _GEM_LLM = None
                _GEM_MODEL_ID = None
            _set_status("downloading", 0.05)
            if allow_download:
                _download_model(model_id)
            elif not _model_available(model_id):
                raise FileNotFoundError(f"本地模型文件不存在：{model_id}")
            _set_status("loading", 0.85)
            with _INFER_LOCK:
                _load_model(model_id)
            with _STATE_LOCK:
                _STATE["model"] = model_id
            _set_status("ready", 1.0)
        except Exception as e:
            with _STATE_LOCK:
                _STATE["model"] = None
            _set_status("error", 0.0, str(e)[:300])

    _DL_THREAD = threading.Thread(target=work, name="tk-local-llm-load", daemon=True)
    _DL_THREAD.start()
    return {"ok": True, "message": f"开始加载 {model_id}（后台进行，轮询 status 查看进度）"}


def unload_model() -> dict:
    global _GEM_LLM, _GEM_MODEL_ID
    with _INFER_LOCK:
        _GEM_LLM = None
        _GEM_MODEL_ID = None
    # llama.cpp 的 CUDA/CPU 资源由模型对象析构释放；主动触发回收，避免
    # 切回生图后仍因 Python 引用延迟而保留大块显存。
    gc.collect()
    with _STATE_LOCK:
        _STATE["model"] = None
        _STATE["status"] = "unloaded"
        _STATE["progress"] = 0.0
        _STATE["error"] = ""
    return {"ok": True}


def is_ready() -> bool:
    with _STATE_LOCK:
        return _STATE["status"] == "ready" and _STATE["model"] in MODELS


def translate(text: str, src_lang: str, dst_lang: str) -> str:
    """已加载模型的自然语言翻译（只翻译，不做 Danbooru 标签）。失败抛异常。"""
    if not is_ready():
        raise RuntimeError("本地 LLM 未加载（POST /anima/translate/local_llm/load 启用）")
    with _STATE_LOCK:
        model_id = _STATE["model"]
    prompt = _build_prompt(model_id, str(text)[:2000], src_lang, dst_lang)
    _assert_generation_idle()
    with _INFER_LOCK:
        if _GEM_LLM is None:
            raise RuntimeError("GGUF 驱动未就绪")
        out = _GEM_LLM(prompt, max_tokens=384, temperature=0.1, top_p=0.9, echo=False)
        result = (out["choices"][0]["text"] or "").split("<end_of_turn>")[0].strip()
        result = result.split("<|im_end|>")[0].strip().split("<|im_start|>")[0].strip()
    if not result:
        raise RuntimeError("本地 LLM 返回空")
    return result


# ── 路由（手动管理；Prompt Cards 的显式本地 LLM 翻译会话按需加载/释放） ──

from aiohttp import web
from server import PromptServer


@PromptServer.instance.routes.get("/anima/translate/local_llm/status")
async def local_llm_status(request):
    return web.json_response({
        "ok": True,
        **state_snapshot(),
        "models": {
            mid: {
                "label": spec["label"],
                "size": spec["size"],
                "license": spec["license"],
                "available": _model_available(mid),
            }
            for mid, spec in MODELS.items() if spec.get("label")
        },
    })


@PromptServer.instance.routes.post("/anima/translate/local_llm/load")
async def local_llm_load(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    model_id = str((body or {}).get("model") or "gemma-4b")
    force = bool((body or {}).get("force"))
    allow_download = bool((body or {}).get("download", True))
    return web.json_response(load_model(model_id, force=force, allow_download=allow_download))


@PromptServer.instance.routes.post("/anima/translate/local_llm/unload")
async def local_llm_unload(request):
    return web.json_response(unload_model())
