"""LoRA preferences: merge policy and atomic user-data persistence."""
import os
import json
import threading
import shutil
import tempfile
import asyncio
from aiohttp import web
PLUGIN_DIR = os.path.dirname(os.path.dirname(__file__))
META_PATH = os.path.join(PLUGIN_DIR, "data", "anima_meta.json")


META_LEGACY_PATH = os.path.join(PLUGIN_DIR, "anima_meta.json")


META_BAK_PATH = META_PATH + ".bak"


META_LOCK = threading.RLock()


def _normalize_meta_keys(data: dict):
    """把 loraMeta 中带扩展名的 key 合并到无扩展名（分类取并集），删除带扩展名条目。

    面板旧数据用完整文件名（sigrika_v1.safetensors），节点用去扩展名（sigrika_v1），
    两边 key 不一致导致分类互不可见。此函数读时归一化，幂等，下次保存时落盘清理。
    """
    lm = data.get("loraMeta")
    if not isinstance(lm, dict):
        return
    merged = {}

    def _merge(dst: dict, src: dict):
        for k, v in src.items():
            if k == "categories" and isinstance(v, list):
                cats = list(dst.get("categories", []) or [])
                for c in v:
                    if c not in cats:
                        cats.append(c)
                dst["categories"] = cats
            else:
                dst[k] = v

    for name, entry in lm.items():
        if not isinstance(entry, dict):
            continue
        base = _strip_model_ext(name)
        if base in merged:
            _merge(merged[base], entry)
        else:
            merged[base] = entry
    data["loraMeta"] = merged


def _strip_model_ext(name: str) -> str:
    """只去掉模型文件扩展名（避免把 chen-bin_v4.0 这类文件名误拆）"""
    low = name.lower()
    for ext in (".safetensors", ".pt", ".ckpt", ".pth", ".sft", ".bin"):
        if low.endswith(ext):
            return name[: -len(ext)]
    return name


def _meta_read_path() -> str:
    """读路径：优先新位置 data/anima_meta.json；不存在则回退旧位置（老用户平滑迁移）。"""
    if os.path.exists(META_PATH):
        return META_PATH
    if os.path.exists(META_LEGACY_PATH):
        return META_LEGACY_PATH
    return META_PATH


def _is_empty_meta_value(value) -> bool:
    """判定「空值」：None / [] / {} / ""（0 与 False 不算空，它们可能是有效值）。"""
    if value is None:
        return True
    if isinstance(value, (str, list, dict, tuple, set)):
        return len(value) == 0
    return False


def _load_meta() -> dict:
    with META_LOCK:
        try:
            path = _meta_read_path()
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        _normalize_meta_keys(data)
                        return data
        except Exception:
            pass
    return {"categories": [], "loraMeta": {}, "loraGroups": []}


def _save_meta(data: dict):
    """落盘：先备份旧内容 → 临时文件 + os.replace 原子替换。

    失败时**必须**保持原文件不变并向上抛异常（端点回 500）——
    绝不留下半写完的 anima_meta.json。
    """
    with META_LOCK:
        parent = os.path.dirname(META_PATH)
        os.makedirs(parent, exist_ok=True)
        # 备份「写入前的有效内容」：新位置优先；迁移场景下就是旧位置那一份。
        try:
            src = _meta_read_path()
            if os.path.exists(src):
                shutil.copy2(src, META_BAK_PATH)
        except OSError as e:
            # 备份只是第二道保险，失败不阻断保存（原子写才是主保险）
            print(f"[anima] 警告：meta 备份失败 {META_BAK_PATH}: {e}")
        # 先写同目录临时文件并原子替换，避免 ComfyUI 意外退出时留下半截 JSON。
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=parent,
                prefix=".anima_meta_",
                suffix=".tmp",
                delete=False,
            ) as f:
                temp_path = f.name
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_path, META_PATH)
            temp_path = None
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass


def _merge_and_save_meta(incoming, replace_keys):
    """Run the locked disk transaction in a worker so saves never stall the server loop."""
    # 读-改-写必须持有同一把锁；否则面板和节点的并发 POST 会互相覆盖。
    with META_LOCK:
        current = _load_meta()
        merged = {**current, **incoming}
        skipped = []
        # ③ 空值护栏：空的 incoming 不许覆盖非空的 current
        for key, value in incoming.items():
            if not _is_empty_meta_value(value):
                continue
            if _is_empty_meta_value(current.get(key)):
                continue  # 旧值本来也是空（或不存在），照常写入
            if key in replace_keys:
                continue  # __replace 显式声明允许清空
            merged[key] = current[key]
            skipped.append(key)
        merged.pop("__replace", None)
        # 落盘前归一化（与读路径同一函数、幂等；旧数据的带扩展名 key 在保存时被清理）
        _normalize_meta_keys(merged)
        # saved：值确实变了的键（被护栏跳过的键值不变，自然不入列）
        saved = [k for k in incoming if k not in current or current[k] != merged.get(k)]

        try:
            if saved:
                _save_meta(merged)
        except Exception as e:
            # 写入失败：原文件保持不变（见 _save_meta），端点回 500 —— 绝不允许半写完的文件
            return {"ok": False, "error": f"meta 写入失败: {e}"}

    return {"ok": True, "skipped": sorted(skipped), "saved": sorted(saved)}


async def get_meta(request):
    """Get LoRA metadata (categories / favorite / pinned)."""
    return web.json_response(await asyncio.to_thread(_load_meta))


async def set_meta(request):
    """Persist LoRA metadata (categories / favorite / pinned) —— 键级合并 + 空值护栏。

    背景（用户投诉的「LoRA 组丢失」根因）：前端多处把**整份** meta POST 上来
    （web/js/anima_batch_lora_widget.js: JSON.stringify(this.meta) / JSON.stringify(metaData)），
    而其中一处拉取失败时手里是 `.catch(() => ({ loraGroups: [] }))` 的空对象，接着就 POST。
    旧实现按「categories 以 body 为准 / loraGroups 有键就用 body」处理 → 空数组把后端
    的 LoRA 组、分类、loraMeta 一起清空。用户明确要求：自定义存储的永久化保存，决不能丢失。

    现在的语义：
    - 键级合并：merged = {**current, **incoming}
      （前端 POST 的都是从 GET 拿回的整份对象，所以键级合并不会丢字段）
    - 空值护栏：incoming 某键为空（[] / {} / "" / None）且 current 该键**非空** → 跳过该键、
      保留 current 的值，并把键名记入回包 skipped；body 里的 __replace（字符串数组）
      显式列出的键允许被清空。__replace 只用于判定，**绝不写进存储文件**。
    - 回包：{"ok": true, "skipped": [...], "saved": [...]}，saved = 真正被更新的键。
    """
    # ① 请求体解析容错：非 JSON / 空 body / 非对象一律 400，且完全不触碰磁盘
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"ok": False, "error": f"请求体不是合法 JSON: {e}"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "请求体必须是 JSON 对象"}, status=400)

    # ② __replace 先从 body 摘掉（只用于判定，绝不落盘）
    replace_keys = set()
    raw_replace = body.pop("__replace", None)
    if isinstance(raw_replace, (list, tuple)):
        for item in raw_replace:
            if isinstance(item, str) and item.strip():
                replace_keys.add(item.strip())

    incoming = dict(body)
    # categories 沿用既有清洗（去空白、丢空项）；清洗后若为空，同样受下面的护栏保护
    if isinstance(incoming.get("categories"), list):
        incoming["categories"] = [str(c).strip() for c in incoming["categories"] if str(c).strip()]

    result = await asyncio.to_thread(_merge_and_save_meta, incoming, replace_keys)
    return web.json_response(result, status=200 if result["ok"] else 500)


def configure(plugin_dir):
    global PLUGIN_DIR, META_PATH, META_LEGACY_PATH, META_BAK_PATH
    PLUGIN_DIR = os.path.abspath(plugin_dir)
    META_PATH = os.path.join(PLUGIN_DIR, "data", "anima_meta.json")
    META_LEGACY_PATH = os.path.join(PLUGIN_DIR, "anima_meta.json")
    META_BAK_PATH = META_PATH + ".bak"


def register_routes(routes):
    routes.get('/anima/meta')(get_meta)
    routes.post('/anima/meta')(set_meta)
