# Anima Toolkit - on-disk thumbnail cache (M1)
# Pure-function module: no ComfyUI/server imports here, so the logic can be
# unit-tested standalone. Route registration lives in anima_batch_lora.py.
#
# 设计要点（见 docs/后端图片管线可行性评估-2026-09-11.md）：
# - 缓存键 = sha1(绝对路径 | mtime | size | width)：源文件一变就自动换新键，旧键成孤儿由清理函数回收
# - LANCZOS + WebP q85（列表 512 / 详情 768 两档），替代浏览器端 160px + low + JPEG 的糊图管线
# - 原子落盘（tmp + os.replace），同键并发用线程锁互斥
# - 路径校验用 commonpath 严格比较（防目录穿越），拒绝隐藏文件

import hashlib
import os
import threading
import time

from PIL import Image

SUPPORTED_WIDTHS = (512, 768)
ORPHAN_MAX_AGE_SECONDS = 30 * 24 * 3600
_CLEANUP_INTERVAL_SECONDS = 24 * 3600

_generate_locks: "dict[str, threading.Lock]" = {}
_locks_guard = threading.Lock()
_last_cleanup_at = 0.0
_cleanup_lock = threading.Lock()


def plugin_cache_root(plugin_dir: str, width: int) -> str:
    """缩略图缓存目录：<插件目录>/data/thumbs/<width>/"""
    if width not in SUPPORTED_WIDTHS:
        raise ValueError(f"unsupported thumbnail width: {width}")
    return os.path.join(plugin_dir, "data", "thumbs", str(width))


def resolve_within_root(root: str, rel_path: str):
    """把相对路径解析为 root 内的绝对路径；越界/隐藏文件/不存在 → None。

    防护用 commonpath 严格比较（startswith 有前缀兄弟目录绕过风险）。
    """
    root_abs = os.path.abspath(root)
    normalized = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not normalized:
        return None
    candidate = os.path.abspath(os.path.join(root_abs, normalized))
    try:
        if os.path.commonpath([root_abs, candidate]) != root_abs:
            return None
    except ValueError:
        return None
    base = os.path.basename(candidate)
    if not base or base.startswith("."):
        return None
    if not os.path.isfile(candidate):
        return None
    return candidate


def thumb_key(abs_path: str, mtime: float, size: int, width: int) -> str:
    raw = f"{os.path.abspath(abs_path)}|{mtime}|{size}|{width}".encode("utf-8", "surrogateescape")
    return hashlib.sha1(raw).hexdigest()


def _coerce_mode(image: "Image.Image") -> "Image.Image":
    """调色板/灰度带透明 → RGBA，其余非 RGB 模式 → RGB（WebP 两种都支持）。"""
    if image.mode == "P":
        return image.convert("RGBA" if "transparency" in image.info else "RGB")
    if image.mode in ("LA", "PA"):
        return image.convert("RGBA")
    if image.mode != "RGB":
        return image.convert("RGB")
    return image


def ensure_thumbnail(abs_path: str, width: int, cache_root: str):
    """确保 abs_path 的 width 档缩略图已落盘。返回 (缓存文件路径, 是否新生成)。

    键包含源文件 mtime/size：文件一变自动走新键，永不命中过期内容。
    """
    if width not in SUPPORTED_WIDTHS:
        raise ValueError(f"unsupported thumbnail width: {width}")
    stat = os.stat(abs_path)
    key = thumb_key(abs_path, stat.st_mtime, stat.st_size, width)
    out_path = os.path.join(cache_root, f"{key}.webp")

    if os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
        return out_path, False

    with _locks_guard:
        lock = _generate_locks.setdefault(key, threading.Lock())
    with lock:
        # 双检：等锁期间可能已被另一请求生成
        if os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
            return out_path, False
        os.makedirs(cache_root, exist_ok=True)
        tmp_path = f"{out_path}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with Image.open(abs_path) as image:
                # JPEG 的 draft() 在解码前按目标尺寸抽取采样，速度提升数倍；PNG 忽略
                if image.format == "JPEG":
                    try:
                        image.draft("RGB", (width, width))
                    except Exception:
                        pass
                image.thumbnail((width, width), Image.LANCZOS)
                image = _coerce_mode(image)
                image.save(tmp_path, "WEBP", quality=85, method=4)
            os.replace(tmp_path, out_path)
        finally:
            if os.path.isfile(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
        _maybe_cleanup(cache_root)
        return out_path, True


def cleanup_orphans(cache_root: str, max_age_seconds: int = ORPHAN_MAX_AGE_SECONDS) -> int:
    """删除长期未被访问的孤儿缓存（源文件变更/删除后遗留的旧键）。返回删除数。"""
    removed = 0
    now = time.time()
    if not os.path.isdir(cache_root):
        return 0
    for name in os.listdir(cache_root):
        if not name.endswith(".webp"):
            continue
        full = os.path.join(cache_root, name)
        try:
            if now - os.path.getmtime(full) > max_age_seconds:
                os.remove(full)
                removed += 1
        except OSError:
            pass
    return removed


def _maybe_cleanup(cache_root: str) -> None:
    """每 24 小时至多跑一次孤儿清理（在生成线程内顺手执行，量小不挡道）。"""
    global _last_cleanup_at
    now = time.monotonic()
    if now - _last_cleanup_at < _CLEANUP_INTERVAL_SECONDS:
        return
    with _cleanup_lock:
        if now - _last_cleanup_at < _CLEANUP_INTERVAL_SECONDS:
            return
        _last_cleanup_at = now
        try:
            cleanup_orphans(cache_root)
        except OSError:
            pass
