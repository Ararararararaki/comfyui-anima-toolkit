# TK Toolkit composition: register logical node modules, routes and resource owners.
# Keep backend-first __path__ for established ComfyUI module identities.

import os

_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anima_backend")

__path__ = [_BACKEND_DIR] + [path for path in __path__ if path != _BACKEND_DIR]

import folder_paths

from aiohttp import web

from server import PromptServer

from .services import github_update as _github_update

from .anima_batch_lora import (
    NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS,
    _find_lora_path,
)

from .anima_trigger_words import (
    NODE_CLASS_MAPPINGS as TW_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as TW_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_3d_body_camera import (
    NODE_CLASS_MAPPINGS as BODY_CAMERA_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as BODY_CAMERA_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_translate_settings import (
    get_setting as _translate_setting,
    provider_fallback_order as _translate_fallback_order,
)

from .anima_prompt_batch import (
    NODE_CLASS_MAPPINGS as BATCH_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as BATCH_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_text_join import (
    NODE_CLASS_MAPPINGS as JOIN_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as JOIN_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_string_router import (
    NODE_CLASS_MAPPINGS as STRING_ROUTER_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as STRING_ROUTER_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_danbooru_tag_getter import (
    NODE_CLASS_MAPPINGS as DANBOORU_TAG_GETTER_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as DANBOORU_TAG_GETTER_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_prompt_saver import (
    NODE_CLASS_MAPPINGS as PROMPT_SAVER_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as PROMPT_SAVER_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_preset_latent import (
    NODE_CLASS_MAPPINGS as PRESET_LATENT_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as PRESET_LATENT_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_latent_switch import (
    NODE_CLASS_MAPPINGS as LATENT_SWITCH_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as LATENT_SWITCH_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_danbooru_gallery import (
    NODE_CLASS_MAPPINGS as DANBOORU_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as DANBOORU_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_image_select import (
    NODE_CLASS_MAPPINGS as SELECT_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as SELECT_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_prompt_cards import (
    NODE_CLASS_MAPPINGS as CARDS_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as CARDS_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_clothing_draw import (
    NODE_CLASS_MAPPINGS as CLOTHING_DRAW_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as CLOTHING_DRAW_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_anima_formatter import (
    NODE_CLASS_MAPPINGS as ANIMA_FORMATTER_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as ANIMA_FORMATTER_NODE_DISPLAY_NAME_MAPPINGS,
)

from .anima_prompt_expander import (
    NODE_CLASS_MAPPINGS as PROMPT_EXPANDER_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as PROMPT_EXPANDER_NODE_DISPLAY_NAME_MAPPINGS,
)

from . import anima_local_llm

from . import anima_prompt_library

try:
    from . import anima_prompt_provenance as _prompt_provenance
    _PROMPT_PROVENANCE_INFO = _prompt_provenance.install()
except Exception as _prompt_provenance_error:
    print(f"[TK 提示词来源] 记录模块不可用（图片生成不受影响）：{_prompt_provenance_error}")

try:
    from . import anima_gallery_sources  # noqa: F401
except Exception as _gallery_sources_error:  # noqa: BLE001
    print(f"[多源画廊] 协议层加载失败（其它节点与 TK 多重画廊节点不受影响）：{_gallery_sources_error}")

try:
    from . import anima_gallery_categories  # noqa: F401
except Exception as _gallery_categories_error:  # noqa: BLE001
    print(f"[多重画廊·分类库] 加载失败（画廊其它功能不受影响）：{_gallery_categories_error}")

try:
    from .services import gallery_warmup as _gallery_warmup
    # ⚠️ 索引路径的**唯一真源**在 anima_batch_lora（/anima/gallery/* 那几个端点同源读写它）
    from .anima_batch_lora import _gallery_index_path as _gallery_index_path_getter

    def _gallery_output_root_getter() -> str:
        """output 目录 getter（folder_paths 在配置损坏/早期加载时会抛，兜底成空串）。"""
        try:
            return folder_paths.get_output_directory()
        except Exception:  # noqa: BLE001
            return ""

    _GALLERY_WARMUP_INFO = _gallery_warmup.install_gallery_warmup(
        app=getattr(PromptServer.instance, 'app', None),
        output_root_getter=_gallery_output_root_getter,
        index_path_getter=_gallery_index_path_getter,
        interval_sec=20,
        debounce_sec=1.5,
    )
    print(f"[画廊预热] 后台预热已挂载：{_GALLERY_WARMUP_INFO}")
except Exception as _gallery_warmup_error:  # noqa: BLE001
    print(f"[画廊预热] 预热器不可用（画廊/面板不受影响，退回按需触发）：{_gallery_warmup_error}")

try:
    from .anima_tag_index import warm_async as _tag_index_warm_async

    _TAG_INDEX_WARM_THREAD = _tag_index_warm_async()
    if _TAG_INDEX_WARM_THREAD is not None:
        print("[画廊标签索引] 已启动后台预热（首次联想无需等待建索引）")
except Exception as _tag_index_error:  # noqa: BLE001
    print(f"[画廊标签索引] 预热不可用（联想退回远程路径，功能不受影响）：{_tag_index_error}")

try:
    from .anima_animadex import warm_async as _animadex_warm_async

    _ANIMADEX_WARM_THREAD = _animadex_warm_async()
    if _ANIMADEX_WARM_THREAD is not None:
        print("[AnimaDex] 已启动后台预热（首次打开角色浮窗无需等待建索引）")
except Exception as _animadex_error:  # noqa: BLE001
    print(f"[AnimaDex] 预热不可用（浮窗功能不受影响，首次打开时按需构建）：{_animadex_error}")

NODE_CLASS_MAPPINGS = {
    **NODE_CLASS_MAPPINGS,
    **TW_NODE_CLASS_MAPPINGS,
    **BODY_CAMERA_NODE_CLASS_MAPPINGS,
    **BATCH_NODE_CLASS_MAPPINGS,
    **JOIN_NODE_CLASS_MAPPINGS,
    **STRING_ROUTER_NODE_CLASS_MAPPINGS,
    **DANBOORU_TAG_GETTER_NODE_CLASS_MAPPINGS,
    **PROMPT_SAVER_NODE_CLASS_MAPPINGS,
    **PRESET_LATENT_NODE_CLASS_MAPPINGS,
    **LATENT_SWITCH_NODE_CLASS_MAPPINGS,
    **DANBOORU_NODE_CLASS_MAPPINGS,
    **SELECT_NODE_CLASS_MAPPINGS,
    **CARDS_NODE_CLASS_MAPPINGS,
    **CLOTHING_DRAW_NODE_CLASS_MAPPINGS,
    **ANIMA_FORMATTER_NODE_CLASS_MAPPINGS,
    **PROMPT_EXPANDER_NODE_CLASS_MAPPINGS,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **NODE_DISPLAY_NAME_MAPPINGS,
    **TW_NODE_DISPLAY_NAME_MAPPINGS,
    **BODY_CAMERA_NODE_DISPLAY_NAME_MAPPINGS,
    **BATCH_NODE_DISPLAY_NAME_MAPPINGS,
    **JOIN_NODE_DISPLAY_NAME_MAPPINGS,
    **STRING_ROUTER_NODE_DISPLAY_NAME_MAPPINGS,
    **DANBOORU_TAG_GETTER_NODE_DISPLAY_NAME_MAPPINGS,
    **PROMPT_SAVER_NODE_DISPLAY_NAME_MAPPINGS,
    **PRESET_LATENT_NODE_DISPLAY_NAME_MAPPINGS,
    **LATENT_SWITCH_NODE_DISPLAY_NAME_MAPPINGS,
    **DANBOORU_NODE_DISPLAY_NAME_MAPPINGS,
    **SELECT_NODE_DISPLAY_NAME_MAPPINGS,
    **CARDS_NODE_DISPLAY_NAME_MAPPINGS,
    **CLOTHING_DRAW_NODE_DISPLAY_NAME_MAPPINGS,
    **ANIMA_FORMATTER_NODE_DISPLAY_NAME_MAPPINGS,
    **PROMPT_EXPANDER_NODE_DISPLAY_NAME_MAPPINGS,
}

WEB_DIRECTORY = "./web"

_FALLBACK_VERSION = "2.31.1"

try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION"), encoding="utf-8") as _vf:
        __version__ = _vf.read().strip() or _FALLBACK_VERSION
except Exception:  # noqa: BLE001
    __version__ = _FALLBACK_VERSION

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))

from .services import http_resources as _http_resources

_HTTP_RESOURCES = _http_resources.HttpResources(lambda: _http_resources.detect_proxy(_translate_setting))

_host_app = getattr(PromptServer.instance, 'app', None)

if hasattr(_host_app, 'on_shutdown') and hasattr(_host_app, 'get'):
    _http_resources.install(_host_app, _HTTP_RESOURCES)

def detect_proxy():
    return _http_resources.detect_proxy(_translate_setting)

async def http_client():
    return _HTTP_RESOURCES

from .services import lora_metadata as _lora_metadata

from .services import translation as _translation

from .anima_danbooru_gallery import install_resources as _install_danbooru_resources

from .anima_gallery_civitai import install_resources as _install_civitai_resources

from .anima_gallery_pixiv import install_resources as _install_pixiv_resources

_lora_metadata.configure(_find_lora_path, http_client)

_lora_metadata.register_routes(PromptServer.instance.routes)

_translation.configure(plugin_dir=PLUGIN_DIR, session_getter=http_client,
                       settings_getter=_translate_setting, provider_order=_translate_fallback_order,
                       proxy_detector=detect_proxy)

_translation.register_routes(PromptServer.instance.routes)

if hasattr(_host_app, 'on_cleanup') and hasattr(_host_app, 'get'):
    _install_danbooru_resources(_host_app)
    _install_civitai_resources(_host_app)
    _install_pixiv_resources(_host_app)

from .services import image_proxy as _image_proxy

from .services import panel_assets as _panel_assets

from .services import lora_preferences as _lora_preferences

_image_proxy.configure(http_client)

_panel_assets.configure(PLUGIN_DIR)

_lora_preferences.configure(PLUGIN_DIR)

for _service in (_image_proxy, _panel_assets, _lora_preferences):
    _service.register_routes(PromptServer.instance.routes)

from .services import downloads as _downloads

_downloads.configure(session_getter=http_client, model_paths=folder_paths.get_folder_paths)

_downloads.register_routes(PromptServer.instance.routes, app=_host_app)

from .services import bridge as _bridge

_bridge.register_routes(PromptServer.instance.routes)

_github_update.configure(plugin_dir=PLUGIN_DIR, session_getter=http_client)

_github_update.register_routes(PromptServer.instance.routes, __version__)
