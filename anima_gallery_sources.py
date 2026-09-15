"""多源画廊的**协议层**：统一 item schema、图源注册表、密钥存取、适配器容错加载。

契约唯一事实源：`docs/PLAN-2026-09-15-P站C站画廊接入.md` §5（并行契约）。
本模块**不注册任何路由**、不发起任何请求 —— 路由由各图源适配器自注册（`anima_gallery_civitai.py`
/ `anima_gallery_pixiv.py`），本模块只定义它们之间的共同形状：

    GallerySource.search(query, cursor, limit, **filters) -> (items, next_cursor)
    GallerySource.images_headers() -> {请求头}      （图片代理取图时附加，P站的 Referer 靠它）
    GallerySource.capabilities()   -> {tags,prompt,nsfw,login}   （前端隐藏/禁用控件的唯一依据）

适配器接入约定（两种都支持，越简单越好）：
  1. **推荐**：模块里放一个图源实例 `SOURCE = MySource()`，本模块加载时自动注册；
  2. 模块里只有 `search()/images_headers()` 平铺函数时，本模块用垫片包一层（见 `_ModuleFunctionSource`）。

设计纪律（与 D站 `anima_danbooru_gallery.py` 一致）：
  · 密钥只落 `data/` 下、不进 git、**任何日志/异常/回包都不得出现完整 key**，只允许 `前4…后4`；
  · 各图源的适配器缺失/导入失败**绝不能**影响插件加载与其它图源（容错加载见 `load_builtin_sources`）。
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol, runtime_checkable
from urllib.parse import urlparse

__all__ = [
    "ITEM_KEYS",
    "CAPABILITY_KEYS",
    "CAPABILITY_DEFAULTS",
    "GallerySource",
    "normalize_item",
    "normalize_items",
    "normalize_capabilities",
    "register",
    "unregister",
    "get_source",
    "list_sources",
    "list_source_ids",
    "sources_payload",
    "source_images_headers",
    "SOURCE_IMAGE_HOSTS",
    "source_for_image_url",
    "image_headers_for_url",
    "call_search",
    "load_builtin_sources",
    "ensure_adapters_loaded",
    "adapter_status",
    "civitai_key_path",
    "load_civitai_key",
    "save_civitai_key",
    "clear_civitai_key",
    "masked_civitai_key",
    "civitai_key_configured",
    "effective_civitai_key",
]


# ---------- 钉死的统一 item schema（PLAN §5.2，缺字段一律 null / []，绝不省略 key） ----------
ITEM_KEYS: tuple[str, ...] = (
    "source",
    "id",
    "preview_url",
    "full_url",
    "width",
    "height",
    "tags",
    "prompt",
    "negative_prompt",
    "rating",
    "score",
    "source_url",
    "meta",
)

# capabilities 的键就是前端「隐藏/禁用控件」的全部依据（多一个少一个都会让前端判错）。
# 第 5 键 `query` 是 2026-09-15 的契约补充（PLAN §6）：C站 图片端点实测不支持关键词搜索 → false，
# 前端据此自动禁用/标注搜索框（**不按源名硬编码**）；D站（标签检索）/P站（search/illust）都是 true。
CAPABILITY_KEYS: tuple[str, ...] = ("tags", "prompt", "nsfw", "login", "query")

# 各能力的**缺省值**（源没显式声明时用）：
# · 不认识的能力默认「不支持」—— 前端最多少显示一个控件，不会点出一个假功能；
# · 但 `query` 反过来缺省 True：绝大多数图源都能按关键词检索，缺省 false 会把搜索框误禁掉。
CAPABILITY_DEFAULTS: dict[str, bool] = {
    "tags": False,
    "prompt": False,
    "nsfw": False,
    "login": False,
    "query": True,
}

# 统一 item 里允许出现的「原始字段别名」：各源回包字段名不同，这里做一层收敛。
# 只收录语义明确、不会互相冲突的别名；其余源特有字段一律进 meta。
_ALIASES: dict[str, tuple[str, ...]] = {
    "id": ("id", "imageId", "post_id", "postId", "illust_id"),
    "preview_url": ("preview_url", "previewUrl", "preview", "thumbnail", "thumb", "url_small"),
    "full_url": ("full_url", "fullUrl", "original_url", "originalUrl", "url_large", "image_url"),
    "width": ("width", "image_width"),
    "height": ("height", "image_height"),
    "rating": ("rating", "nsfwLevel", "nsfw_level", "x_restrict"),
    "score": ("score", "total_reactions", "likes", "like_count", "bookmark_count"),
    "source_url": ("source_url", "sourceUrl", "page_url", "pageUrl", "post_url"),
    "tags": ("tags", "tag_list", "tagList"),
    "prompt": ("prompt",),
    "negative_prompt": ("negative_prompt", "negativePrompt", "uc"),
    "meta": ("meta", "metadata"),
}


@runtime_checkable
class GallerySource(Protocol):
    """图源适配器协议（PLAN §5.3：capabilities 是前端隐藏/禁用控件的唯一依据）。

    注意：只要求形状，不要求继承 —— 各图源适配器正常写类即可（`@runtime_checkable` 供 isinstance 粗筛）。
    """

    source_id: str
    label: str

    def search(
        self,
        query: str = "",
        cursor: str | None = None,
        limit: int = 24,
        **filters: Any,
    ) -> tuple[list[dict[str, Any]], str | None]:
        """返回 `(items, next_cursor)`；items 必须已归一化（`normalize_item`）。"""
        ...

    def images_headers(self) -> dict[str, str]:
        """图片代理取图时要附加的必需请求头（P站需要 Referer，C站返回 `{}`）。"""
        ...

    def capabilities(self) -> dict[str, bool]:
        """`{"tags","prompt","nsfw","login"}` 四个 bool。"""
        ...


# ---------- item 归一化 ----------

def _as_text(value: Any) -> str | None:
    """任意标量 → 去空白字符串；空/不可转 → None。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
    elif isinstance(value, (int, float)):
        text = str(value)
    else:
        return None
    return text or None


def _as_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_score(value: Any) -> int | float | None:
    """score 保留整数形态（前端按数字展示）；非数字 → None。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        try:
            number = float(text)
        except ValueError:
            return None
        return int(number) if number.is_integer() else number


def _as_url(value: Any) -> str | None:
    text = _as_text(value)
    if not text:
        return None
    return text if text.startswith(("http://", "https://")) else None


def _as_tags(value: Any) -> list[str]:
    """标签列表：list/tuple/set 逐个取文本；字符串按逗号/顿号切（适配器偷懒也不至于崩）。"""
    if value is None:
        return []
    if isinstance(value, str):
        raw_items: Iterable[Any] = value.replace("，", ",").replace("、", ",").split(",")
    elif isinstance(value, (list, tuple, set, frozenset)):
        raw_items = value
    else:
        return []
    tags: list[str] = []
    seen: set[str] = set()
    for raw in raw_items:
        text = _as_text(raw)
        if text and text not in seen:
            seen.add(text)
            tags.append(text)
    return tags


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    return {}


def _pick(raw: dict[str, Any], overrides: dict[str, Any], key: str) -> Any:
    """取值优先级：显式 overrides > raw 里的规范名 > raw 里的别名。

    overrides 里值为 None 视为「未提供」（不覆盖 raw），避免适配器只映射一半时把已有值抹成 null。
    """
    if key in overrides and overrides[key] is not None:
        return overrides[key]
    for name in _ALIASES.get(key, (key,)):
        if name in raw and raw[name] is not None:
            return raw[name]
    return None


def normalize_item(raw: Any = None, source: str = "", **overrides: Any) -> dict[str, Any]:
    """把任意图源的原始条目收敛成 PLAN §5.2 的统一 item。

    · 返回**永远包含全部 13 个 key**（顺序固定）：缺的补 `None`，列表补 `[]`，`meta` 补 `{}`；
    · 不认识的多余字段一律丢弃（源特有信息请自行塞进 `meta`）——前端按 key 判断能力，脏 key 只会误导；
    · 映射规则：`prompt`/`negative_prompt`/`sampler`… 由适配器在 overrides 里显式指定（各源字段名差异太大，
      这里不做猜测式映射）。

    例（C站）：
        normalize_item(raw, "civitai",
                       prompt=meta.get("prompt"), negative_prompt=meta.get("negativePrompt"),
                       preview_url=..., full_url=..., score=..., meta={...})
    """
    raw_dict = raw if isinstance(raw, dict) else {}
    source_text = _as_text(source) or _as_text(raw_dict.get("source")) or ""
    item: dict[str, Any] = {
        "source": source_text,
        "id": _as_text(_pick(raw_dict, overrides, "id")),
        "preview_url": _as_url(_pick(raw_dict, overrides, "preview_url")),
        "full_url": _as_url(_pick(raw_dict, overrides, "full_url")),
        "width": _as_int(_pick(raw_dict, overrides, "width")),
        "height": _as_int(_pick(raw_dict, overrides, "height")),
        "tags": _as_tags(_pick(raw_dict, overrides, "tags")),
        "prompt": _as_text(_pick(raw_dict, overrides, "prompt")),
        "negative_prompt": _as_text(_pick(raw_dict, overrides, "negative_prompt")),
        "rating": _as_text(_pick(raw_dict, overrides, "rating")),
        "score": _as_score(_pick(raw_dict, overrides, "score")),
        "source_url": _as_url(_pick(raw_dict, overrides, "source_url")),
        "meta": _as_dict(_pick(raw_dict, overrides, "meta")),
    }
    # 键序与 schema 常量严格一致：回包 JSON 稳定，前端与测试都不用猜顺序
    return {key: item[key] for key in ITEM_KEYS}


def normalize_items(raw_items: Any, source: str = "", mapper: Any = None) -> list[dict[str, Any]]:
    """批量归一化；`mapper(raw) -> overrides dict` 可选（各源把自己的字段翻译成统一形状）。"""
    if not isinstance(raw_items, (list, tuple)):
        return []
    result: list[dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        extra = mapper(raw) if callable(mapper) else {}
        result.append(normalize_item(raw, source, **(extra or {})))
    return result


def normalize_capabilities(capabilities: Any) -> dict[str, bool]:
    """capabilities 收敛成契约里的**恰好这些键**（多余键丢弃；缺的按键缺省补，见 `CAPABILITY_DEFAULTS`）。

    ⚠️ 这里是 `query` 能否真的发到前端的**唯一咽喉**：源的 `capabilities()` 写成方法、属性、
    可调用 dict 都行，但都必须过这一关（旧版本只回 4 键，PLAN §6 的 `query:false` 因此永远发不出去）。
    """
    data = capabilities if isinstance(capabilities, dict) else {}
    return {key: bool(data.get(key, CAPABILITY_DEFAULTS.get(key, False))) for key in CAPABILITY_KEYS}


# ---------- 图源注册表 ----------

_register_lock = threading.RLock()
_sources: "OrderedDict[str, Any]" = OrderedDict()
# 适配器加载结果（模块名 → "ok" / 失败原因），供 /anima/gallery/sources 与诊断使用
_adapter_status: dict[str, str] = {}


def _source_id_of(candidate: Any) -> str:
    """尽力从实例/模块/类上取图源 id（各 agent 命名习惯不同，这里都认）。"""
    for attr in ("source_id", "id", "SOURCE_ID", "sourceId", "source"):
        value = getattr(candidate, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    name = getattr(candidate, "__name__", "") or candidate.__class__.__name__
    if isinstance(name, str) and name.startswith("anima_gallery_"):
        return name[len("anima_gallery_"):]
    return ""


def _label_of(candidate: Any, source_id: str) -> str:
    for attr in ("label", "LABEL", "display_name", "DISPLAY_NAME"):
        value = getattr(candidate, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return source_id


def register(source: Any, *, replace: bool = False) -> str:
    """注册一个图源实例（或模块），返回它的 id。

    `source` 必须提供可调用的 `search`；id 取 `source_id`/`id`/`SOURCE_ID`…任一（全无则报错，
    因为 id 就是路由 `{source}` 段）。
    """
    search_fn = getattr(source, "search", None)
    if not callable(search_fn):
        raise ValueError("图源必须提供可调用的 search()")
    source_id = _source_id_of(source)
    if not source_id:
        raise ValueError("图源缺少 source_id（路由 {source} 段要用它）")
    with _register_lock:
        if source_id in _sources and not replace:
            raise ValueError(f"图源 {source_id!r} 已注册（要覆盖请传 replace=True）")
        _sources[source_id] = source
    return source_id


def unregister(source_id: str) -> bool:
    with _register_lock:
        return _sources.pop(str(source_id or "").strip().lower(), None) is not None


def get_source(source_id: str) -> Any | None:
    with _register_lock:
        return _sources.get(str(source_id or "").strip().lower())


def list_source_ids() -> list[str]:
    with _register_lock:
        return list(_sources.keys())


def list_sources() -> list[Any]:
    with _register_lock:
        return list(_sources.values())


def source_capabilities(source: Any) -> dict[str, bool]:
    """容错取 capabilities：方法缺失/抛异常时回落到「全 false」（前端只会少显示控件，不会崩）。"""
    getter = getattr(source, "capabilities", None)
    if not callable(getter):
        return normalize_capabilities(None)
    try:
        return normalize_capabilities(getter())
    except Exception as error:  # noqa: BLE001
        print(f"[多源画廊] 取 capabilities 失败（按全 false 处理）：{type(error).__name__}: {error}")
        return normalize_capabilities(None)


def source_images_headers(source: Any) -> dict[str, str]:
    """容错取 images_headers()：失败 → `{}`（少一个请求头最多图片 403，不影响整个路由）。"""
    getter = getattr(source, "images_headers", None)
    if not callable(getter):
        return {}
    try:
        headers = getter()
    except Exception as error:  # noqa: BLE001
        print(f"[多源画廊] 取 images_headers 失败（按空处理）：{type(error).__name__}: {error}")
        return {}
    if not isinstance(headers, dict):
        return {}
    return {str(key): str(value) for key, value in headers.items() if key and value is not None}


# ---------- 按 URL 找图源（节点侧下载路径用：非 D站 的图也必须能取到字节） ----------
# 各图源的图片主机（后缀匹配、含子域）。新增图源在这里登记一行，下载路径就能认出它。
# ⚠️ 这张表是「哪些第三方主机允许取图」的**单一 owner**：C站 图片路由的白名单也从这里派生。
SOURCE_IMAGE_HOSTS: dict[str, tuple[str, ...]] = {
    "civitai": ("civitai.com", "image.civitai.com", "imagecache.civitai.com"),
    "pixiv": ("pximg.net", "pixiv.net"),
}


def _image_host_of(url: Any) -> str:
    """取 URL 主机（小写）；畸形 URL / 非 http(s) / 没有主机 → 空串。"""
    text = _as_text(url)
    if not text:
        return ""
    try:
        parsed = urlparse(text)
    except ValueError:  # 畸形 URL（例如未闭合的 IPv6 字面量 http://[::1）
        return ""
    if parsed.scheme not in ("http", "https"):
        return ""
    return (parsed.hostname or "").lower()


def _host_matches_domain(host: str, domain: str) -> bool:
    """后缀匹配（含子域）：`i.pximg.net` 命中 `pximg.net`；`evilcivitai.com` **不**命中 `civitai.com`。"""
    return bool(host) and bool(domain) and (host == domain or host.endswith("." + domain))


def source_for_image_url(url: Any) -> str | None:
    """这个图片 URL 属于哪个图源（PLAN §5.2 的 source id）；未知主机 / 畸形 URL → `None`。

    只看主机与协议（http/https），**不查该图源是否已装配** —— 装配状态交给 `image_headers_for_url`。
    """
    host = _image_host_of(url)
    if not host:
        return None
    for source_id, domains in SOURCE_IMAGE_HOSTS.items():
        if any(_host_matches_domain(host, domain) for domain in domains):
            return source_id
    return None


def image_headers_for_url(url: Any) -> dict[str, str] | None:
    """取这个图片 URL 需要的额外请求头（节点下载路径与图片代理共用）。

    · 未知主机（不属于任何已知图源）→ `None`：调用方应维持「不认识就拒绝」的原有语义；
    · 认识但该图源**未装配** → `{}`：照常取图（C站 无防盗链；P站 没装配本来也没有 token）；
    · 已装配 → 该源的 `images_headers()`（**P站 的 Referer 就在这里**，缺了 `i.pximg.net` 直接 403）。
    """
    source_id = source_for_image_url(url)
    if source_id is None:
        return None
    source = get_source(source_id)
    if source is None:
        return {}
    return source_images_headers(source)


def sources_payload() -> list[dict[str, Any]]:
    """`/anima/gallery/sources` 的回包体（PLAN §5.3 钉死的形状）。"""
    ensure_adapters_loaded()  # 幂等补加载：启动期导入顺序再乱，图源清单也不会漏
    payload: list[dict[str, Any]] = []
    for source in list_sources():
        source_id = _source_id_of(source)
        payload.append({
            "id": source_id,
            "label": _label_of(source, source_id),
            "capabilities": source_capabilities(source),
        })
    return payload


def _build_search_call(search_fn: Any, kwargs: dict[str, Any]) -> Any:
    """按 search() 的真实签名决定怎么调（**不做异常驱动重试**：TypeError 可能是实现自身的 bug，
    重试只会把它执行两遍、更难定位）。

    三种写法都认：
      · `search(query, cursor, limit, **filters)` / 任意子集 → 关键字调用（过滤掉它不接受的）
      · `search(query, cursor, filters)`（PLAN §3 的老写法：filters 是字典）→ 位置调用
      · 纯位置形参 `search(query, cursor)` → 位置调用
    """
    try:
        signature = inspect.signature(search_fn)
    except (TypeError, ValueError):  # 内建/奇怪可调用对象：直接按关键字调
        return lambda: search_fn(**kwargs)
    parameters = signature.parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        return lambda: search_fn(**kwargs)
    accepted = {name for name, p in parameters.items()
                if p.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)}
    if accepted & {"query", "cursor", "limit", "filters"}:
        trimmed = {key: value for key, value in kwargs.items() if key in accepted}
        if "filters" in accepted and "filters" not in trimmed:
            # 老写法：filter 参数收一个 dict（把 query/cursor/limit 之外的过滤项打包进去）
            trimmed["filters"] = {k: v for k, v in kwargs.items()
                                  if k not in {"query", "cursor", "limit"} and k not in accepted}
        return lambda: search_fn(**trimmed)
    positional = [p for p in parameters.values()
                  if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)]
    if len(positional) >= 3:
        return lambda: search_fn(kwargs.get("query", ""), kwargs.get("cursor"),
                                 {k: v for k, v in kwargs.items() if k not in {"query", "cursor"}})
    return lambda: search_fn(*[kwargs.get(name, "") for name in list(parameters)[:max(0, len(positional))]])


async def call_search(
    source: Any,
    *,
    query: str = "",
    cursor: str | None = None,
    limit: int = 24,
    filters: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """统一调用图源的 search()，并抹平两种实现风格：

    · 同步实现 → 丢线程池（不阻塞 aiohttp 事件循环，与 D站 run_in_executor 同规矩）；
    · 协程实现 → 直接 await；
    · 签名差异 → 见 `_build_search_call`。
    """
    import asyncio

    search_fn = getattr(source, "search", None)
    if not callable(search_fn):
        raise ValueError("图源缺少可调用的 search()")
    kwargs: dict[str, Any] = {"query": query, "cursor": cursor, "limit": limit, **dict(filters or {})}
    invoke = _build_search_call(search_fn, kwargs)
    if inspect.iscoroutinefunction(search_fn):
        result = await invoke()
    else:
        result = await asyncio.get_running_loop().run_in_executor(None, invoke)
    return _split_search_result(result)


def _split_search_result(result: Any) -> tuple[list[dict[str, Any]], str | None]:
    """把图源返回值收敛成 `(items, next_cursor)`；宽容处理 dict 回包。"""
    if isinstance(result, dict):
        items = result.get("items") or []
        next_cursor = result.get("next_cursor") or result.get("nextCursor")
        return (list(items) if isinstance(items, (list, tuple)) else [], _as_text(next_cursor))
    if isinstance(result, (list, tuple)):
        items = result[0] if result else []
        next_cursor = result[1] if len(result) > 1 else None
        return (list(items) if isinstance(items, (list, tuple)) else [], _as_text(next_cursor))
    return [], None


# ---------- 适配器容错加载 ----------

# 内置图源模块名（均与 `anima_gallery_sources` 同级）；**缺失/导入失败绝不允许影响插件加载**。
BUILTIN_ADAPTER_MODULES: tuple[str, ...] = ("anima_gallery_civitai", "anima_gallery_pixiv")
# 适配器此刻**正在被导入中**（它自己 import 了本模块 → 本模块又在加载它）。
# 这种重入场景（ai_verify 会「先塞 sys.modules 再 exec」）下模块里的 SOURCE 还没定义，
# 不能当成错误、也不能就此放弃：稍后由适配器自注册或 `ensure_adapters_loaded()` 补加载。
ADAPTER_IMPORTING = "importing"


class _ModuleFunctionSource:
    """垫片：把「只有模块级 search()/images_headers() 平铺函数」的适配器包成图源对象。

    存在的唯一理由：三个 agent 并行开发时，适配器写法可能对不齐；包一层比让协调者改契约便宜。
    """

    def __init__(self, module: Any, module_name: str) -> None:
        self._module = module
        self.source_id = (_as_text(getattr(module, "SOURCE_ID", None)) or module_name).lower()
        self.label = _as_text(getattr(module, "SOURCE_LABEL", None)) or self.source_id

    def search(self, *args: Any, **kwargs: Any) -> Any:
        return self._module.search(*args, **kwargs)

    def images_headers(self) -> dict[str, str]:
        getter = getattr(self._module, "images_headers", None)
        return getter() if callable(getter) else {}

    def capabilities(self) -> dict[str, bool]:
        getter = getattr(self._module, "capabilities", None)
        return getter() if callable(getter) else {}


def _import_adapter_module(module_name: str) -> Any:
    """导入适配器模块：包内相对导入优先，退回顶层导入（pytest / 独立探针没有包上下文）。

    ⚠️ 只在「**模块本身**不在包内」时才退回顶层导入。若模块存在、只是它依赖的第三方缺失
    （ModuleNotFoundError 指向别的模块），必须原样抛出 —— 否则会把同一个模块执行两遍，
    模块内的路由注册就会重复。
    """
    package = __package__ or ""
    if not package:
        return importlib.import_module(module_name)
    try:
        return importlib.import_module(f".{module_name}", package)
    except ModuleNotFoundError as error:
        missing = getattr(error, "name", "") or ""
        if missing not in {module_name, f"{package}.{module_name}"}:
            raise
        return importlib.import_module(module_name)


def _source_from_module(module: Any, module_name: str) -> Any | None:
    """从适配器模块里找出图源对象（认多种写法，找不到返回 None）。"""
    for attr in ("SOURCE", "source", "SOURCE_INSTANCE", "GALLERY_SOURCE"):
        candidate = getattr(module, attr, None)
        if candidate is not None and callable(getattr(candidate, "search", None)):
            return candidate
    for attr in ("get_source", "create_source", "build_source", "make_source"):
        factory = getattr(module, attr, None)
        if callable(factory):
            candidate = factory()
            if candidate is not None and callable(getattr(candidate, "search", None)):
                return candidate
    if callable(getattr(module, "search", None)):
        return _ModuleFunctionSource(module, module_name)
    return None


def load_adapter(module_name: str, *, force: bool = False) -> Any | None:
    """加载单个适配器并注册；任何异常都被吞掉（返回 None），并记录原因到 `_adapter_status`。"""
    source_id = (module_name or "").strip()
    if not source_id:
        return None
    if not force and _adapter_status.get(source_id) == "ok":
        # 已加载过：直接从注册表回取（模块可能自注册，id 未必等于模块名）
        existing = get_source(_source_id_of_module_cache.get(module_name, ""))
        if existing is not None:
            return existing
    try:
        module = _import_adapter_module(module_name)
    except Exception as error:  # noqa: BLE001 —— 导入失败是**预期情况**（并行开发时对方模块可能还没落地）
        reason = f"{type(error).__name__}: {error}"
        _adapter_status[module_name] = reason
        print(f"[多源画廊] 图源 {module_name} 未加载（不影响其它图源）：{reason}")
        return None
    # 重入保护：模块正在 exec 中（它的 import 触发了本模块的加载）→ 此刻还没有 SOURCE，
    # 静默跳过。等它执行到自注册（推荐写法）或路由首次访问时的补加载。
    if getattr(getattr(module, "__spec__", None), "_initializing", False):
        _adapter_status[module_name] = ADAPTER_IMPORTING
        return None

    source: Any = None
    error: Exception
    try:
        source = _source_from_module(module, module_name)
        if source is not None:
            discovered = _source_id_of(source) or source_id
            _source_id_of_module_cache[module_name] = discovered
            if get_source(discovered) is not source:
                register(source, replace=get_source(discovered) is not None)
            _adapter_attempts.pop(module_name, None)
            _adapter_status[module_name] = "ok"
            return source
        error = ValueError("模块里没有找到图源对象（需要 SOURCE 实例或模块级 search()）")
    except Exception as caught:  # noqa: BLE001
        error = caught

    # 首次「没找到」先按「模块可能还在导入中」处理，不当错误、不打印：
    # 有些加载路径（如 ai_verify 的「先塞 sys.modules 再 exec_module」）绕过了标准导入机制，
    # 拿不到 `_initializing` 标记，此刻模块体还没跑到 SOURCE 那一行。
    # 补加载（`ensure_adapters_loaded`，路由首次访问时触发）会再试一次：
    # 真的坏掉的适配器仍然会在第二次如实报错 —— 宽限只有一次，不会永久掩盖问题。
    attempts = _adapter_attempts.get(module_name, 0) + 1
    _adapter_attempts[module_name] = attempts
    if attempts == 1:
        _adapter_status[module_name] = ADAPTER_IMPORTING
        return None
    reason = f"{type(error).__name__}: {error}"
    _adapter_status[module_name] = reason
    print(f"[多源画廊] 图源 {module_name} 注册失败（不影响其它图源）：{reason}")
    return None


# 模块名 → 实际注册的图源 id（模块名与 id 不一致时也能定位）
_source_id_of_module_cache: dict[str, str] = {}
# 模块名 → 已尝试加载次数（只用来给「首次没找到」一次宽限，见 load_adapter）
_adapter_attempts: dict[str, int] = {}


def load_builtin_sources(*, force: bool = False) -> dict[str, str]:
    """容错加载全部内置图源；返回 `{模块名: "ok" | 失败原因}`，**永不抛异常**。

    这一层是并行开发的缓冲垫：P站适配器此刻可能还不存在（另一个 agent 在写），
    导入失败只是「该图源不可用」，插件与 C站图源照常工作。
    """
    for module_name in BUILTIN_ADAPTER_MODULES:
        load_adapter(module_name, force=force)
    return dict(_adapter_status)


def ensure_adapters_loaded() -> dict[str, str]:
    """补加载：给「上次因模块正在导入中被跳过 / 从未尝试」的适配器第二次机会。

    幂等且极廉价（已导入的模块在 sys.modules 里，import_module 只是一次字典查找）。
    路由取图源清单与 P站登录态前都会先调它 —— 这样无论启动期的导入顺序如何，
    图源最终都会出现在注册表里（而不是永久缺失）。
    """
    for module_name in BUILTIN_ADAPTER_MODULES:
        if _adapter_status.get(module_name) in (None, ADAPTER_IMPORTING):
            load_adapter(module_name)
    return dict(_adapter_status)


def adapter_status() -> dict[str, str]:
    """各适配器最近一次加载结果（诊断用；只含模块名与原因，不含任何密钥）。"""
    return dict(_adapter_status)


# ---------- C站密钥存取（PLAN §5.5；落盘 data/civitai_key.json，不进 git） ----------
# 文件格式（已就位）：{"version":1,"api_key":"...","saved_at":"..."}
# 优先级：界面保存的值 > 环境变量 CIVITAI_API_KEY > 无。
# ⚠️ 任何日志/异常/回包都不得出现完整 key，只允许 前4…后4 掩码。
CIVITAI_KEY_ENV = "CIVITAI_API_KEY"
CIVITAI_KEY_FILE = "civitai_key.json"
CIVITAI_KEY_VERSION = 1
# 掩码符号用省略号（与 PLAN §5.5 的示例 "b45c…f4d" 保持同一种观感）
MASK_ELLIPSIS = "…"
_MAX_KEY_LENGTH = 512

_key_lock = threading.RLock()
_key_cache: dict[str, Any] = {"stamp": None, "value": ""}


def civitai_key_path() -> Path:
    """密钥文件路径（与 D站账号凭证同约定：插件目录下 data/）。

    刻意做成**函数**而不是模块常量 —— 测试可以直接 monkeypatch 它指向 tmp 目录。
    """
    return Path(__file__).with_name("data") / CIVITAI_KEY_FILE


def normalize_civitai_key(raw: Any) -> str:
    """清洗用户输入：去掉 `Bearer ` 前缀、引号与首尾空白（粘贴整行 header 是常见误操作）。"""
    text = str(raw or "").strip().strip('"').strip("'").strip()
    if text.lower().startswith("bearer "):
        text = text[7:].strip()
    if len(text) > _MAX_KEY_LENGTH or any(ch.isspace() for ch in text):
        return ""
    return text


def _read_civitai_key_file() -> str:
    """读盘（带 mtime+size 缓存）：文件被外部改动会自动失效，不用重启 ComfyUI。"""
    path = civitai_key_path()
    try:
        stat = path.stat()
    except OSError:
        with _key_lock:
            _key_cache["stamp"] = None
            _key_cache["value"] = ""
        return ""
    stamp = (stat.st_mtime_ns, stat.st_size)
    with _key_lock:
        if _key_cache["stamp"] == stamp:
            return str(_key_cache["value"] or "")
    value = ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            value = normalize_civitai_key(data.get("api_key"))
    except (OSError, ValueError, TypeError):
        value = ""
    with _key_lock:
        _key_cache["stamp"] = stamp
        _key_cache["value"] = value
    return value


def load_civitai_key() -> str:
    """返回**已保存到文件**的 key（不含环境变量兜底）；没有则空串。"""
    return _read_civitai_key_file()


def save_civitai_key(key: Any) -> None:
    """保存 key（原子写：先写临时文件再 replace，避免半截文件）；`key=""` 等价于清除。"""
    value = normalize_civitai_key(key)
    if not value:
        clear_civitai_key()
        return
    path = civitai_key_path()
    payload = {
        "version": CIVITAI_KEY_VERSION,
        "api_key": value,
        "saved_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    temp_path = path.with_name(path.name + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(temp_path, path)
    with _key_lock:
        _key_cache["stamp"] = None  # 让下次读取重新落盘解析
    print(f"[多源画廊] 已保存 Civitai API key（{masked_civitai_key(value)}）")


def clear_civitai_key() -> None:
    """删除已保存的 key（界面里的「清除」按钮）。"""
    path = civitai_key_path()
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    with _key_lock:
        _key_cache["stamp"] = None
        _key_cache["value"] = ""
    print("[多源画廊] 已清除 Civitai API key")


def _env_civitai_key() -> str:
    return normalize_civitai_key(os.environ.get(CIVITAI_KEY_ENV, ""))


def effective_civitai_key() -> str:
    """实际用于请求的 key：界面/文件保存的 > 环境变量 > 空。"""
    return _read_civitai_key_file() or _env_civitai_key()


def civitai_key_configured() -> bool:
    return bool(effective_civitai_key())


def civitai_key_source() -> str:
    """key 来自哪里（"file" / "env" / ""）—— 只回来源，不回值。"""
    if _read_civitai_key_file():
        return "file"
    if _env_civitai_key():
        return "env"
    return ""


def masked_civitai_key(key: Any = None) -> str:
    """掩码：只给**前 4 位 + 后 4 位**（`b45c…9f4d`），中间一律不回。

    · 未配置 → 空串；
    · 长度 ≤ 8 时任何切片都可能泄露有效信息，只回一个省略号。
    """
    value = normalize_civitai_key(key) if key is not None else effective_civitai_key()
    if not value:
        return ""
    if len(value) <= 8:
        return MASK_ELLIPSIS
    return f"{value[:4]}{MASK_ELLIPSIS}{value[-4:]}"


# 模块导入即尝试加载内置图源（容错：任何失败都只是打印一行中文提示）。
# 时序：放在文件末尾，保证被加载的适配器 `from .anima_gallery_sources import ...` 时名字都已就绪。
load_builtin_sources()
