"""Clean image copies for native drag-out. The app owns bounded, expiring upload files."""
from collections import OrderedDict
from io import BytesIO
from pathlib import Path
import os
import secrets
import struct
import tempfile
import threading
import time

PNG = b'\x89PNG\r\n\x1a\n'
MAX_IMAGE_BYTES = 64 * 1024 * 1024
_PIXEL_CHUNKS = {'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'iCCP', 'acTL', 'fcTL', 'fdAT'}
RESOURCE_KEY = 'tk.toolkit.output-share'


def prepare_share_image(data, metadata_mode=None):
    """Legacy requests clean fully; explicit exports retain their frozen policy.

    The frontend uses the shared export metadata implementation before posting
    'prepared'. Validate the same PNG structure/size budget without stripping its
    chosen signature or reversing the user's disabled cleanup setting. Other
    formats still need the existing fresh PNG conversion for the bridge protocol.
    """
    if metadata_mode not in (None, 'prepared'):
        raise ValueError('无效的拖出元数据策略')
    clean = clean_share_image(data)
    return data if metadata_mode == 'prepared' and data.startswith(PNG) else clean


def clean_share_image(data):
    """Keep PNG pixel chunks verbatim; remove text, EXIF, time, private chunks and trailers.

    Transparency, colour profiles and animation belong to rendered pixels. For non-PNG,
    Pillow decodes once and writes a fresh PNG with no source metadata dictionary.
    """
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError('图片超过单次拖出大小预算，请使用下载')
    if not data.startswith(PNG):
        from PIL import Image
        with Image.open(BytesIO(data)) as image:
            if image.format not in {'JPEG', 'WEBP', 'GIF', 'BMP'}:
                raise ValueError('不支持此图片的干净拖出，请使用下载')
            image.load()
            if getattr(image, 'n_frames', 1) > 1:
                raise ValueError('动画图片请使用下载，拖出不自动丢弃帧')
            # A fresh image has no EXIF, XMP, comments or inherited Pillow .info.
            rgba = image.convert('RGBA')
            fresh = Image.new('RGBA', rgba.size)
            fresh.paste(rgba)
            output = BytesIO()
            fresh.save(output, format='PNG', compress_level=1)
            result = output.getvalue()
            if len(result) > MAX_IMAGE_BYTES:
                raise ValueError('转换后图片超过拖出预算，请使用下载')
            return result
    parts, offset, has_idat, first = [PNG], 8, False, True
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError('PNG 块被截断，不能作为干净图片拖出')
        length = struct.unpack_from('>I', data, offset)[0]
        chunk = data[offset + 4:offset + 8].decode('ascii', errors='strict')
        end = offset + length + 12
        if length > 0x7fffffff or end > len(data) or len(chunk) != 4 or not chunk.isalpha() or not chunk[2].isupper():
            raise ValueError('PNG 块头不合法')
        if first and (chunk != 'IHDR' or length != 13) or not first and chunk == 'IHDR':
            raise ValueError('PNG IHDR 不合法')
        first = False
        if chunk[0].isupper() or chunk in _PIXEL_CHUNKS:
            parts.append(data[offset:end])
        has_idat = has_idat or chunk == 'IDAT'
        if chunk == 'IEND':
            if length or not has_idat:
                raise ValueError('PNG 图像数据不完整')
            return b''.join(parts)
        offset = end
    raise ValueError('PNG 缺少 IEND')


class ShareStore:
    """Disk copies only; no original files, handles or credentials enter this store."""
    def __init__(self, root, max_bytes=128 * 1024 * 1024, max_files=8, ttl=600):
        self.root = Path(root).resolve()
        self.max_bytes, self.max_files, self.ttl = max_bytes, max_files, ttl
        self._directory = None
        self._files = OrderedDict()
        self._lock = threading.RLock()
        self._closed = False

    def _prune(self, now):
        for token, (path, size, expiry) in list(self._files.items()):
            if expiry <= now:
                self._files.pop(token)
                path.unlink(missing_ok=True)

    def put(self, data):
        if len(data) > min(MAX_IMAGE_BYTES, self.max_bytes):
            raise ValueError('图片超过拖出缓存预算')
        with self._lock:
            if self._closed:
                raise RuntimeError('拖出服务已关闭')
            self._prune(time.monotonic())
            while self._files and (len(self._files) >= self.max_files or sum(item[1] for item in self._files.values()) + len(data) > self.max_bytes):
                _, (old, _, _) = self._files.popitem(last=False)
                old.unlink(missing_ok=True)
            if self._directory is None:
                self.root.mkdir(parents=True, exist_ok=True)
                self._directory = Path(tempfile.mkdtemp(prefix='tk-clean-share-', dir=self.root)).resolve()
                if not self._directory.is_relative_to(self.root):
                    raise RuntimeError('拖出缓存目录无效')
            token = secrets.token_urlsafe(24)
            path = self._directory / (token + '.png')
            with path.open('xb') as stream:
                stream.write(data)
            self._files[token] = (path, len(data), time.monotonic() + self.ttl)
            return token

    def get(self, token):
        with self._lock:
            self._prune(time.monotonic())
            row = self._files.get(token)
            if not row or self._closed:
                raise FileNotFoundError('拖出副本已过期，请重新拖出')
            self._files.move_to_end(token)
            return row[0].read_bytes()

    def close(self):
        with self._lock:
            self._closed = True
            for path, _, _ in self._files.values():
                assert self._directory is not None and path.resolve().is_relative_to(self._directory)
                path.unlink(missing_ok=True)
            self._files.clear()
            if self._directory is not None:
                self._directory.rmdir()
                self._directory = None


def install_resources(app, temp_root):
    if app.get(RESOURCE_KEY) is not None:
        return app[RESOURCE_KEY]
    store = ShareStore(temp_root)
    app[RESOURCE_KEY] = store
    async def cleanup(_app):
        import asyncio
        await asyncio.to_thread(store.close)
    app.on_cleanup.append(cleanup)
    return store


def read_gallery_share(root, relative, expected_root, mtime, size):
    from ..anima_thumbs import resolve_within_root
    if os.path.normcase(os.path.normpath(str(root))) != os.path.normcase(os.path.normpath(str(expected_root))):
        raise ValueError('output 目录已变更，请刷新')
    path = resolve_within_root(root, relative)
    if not path:
        raise FileNotFoundError('图片不存在或已移动')
    def current():
        stat = os.stat(path)
        return round(stat.st_mtime * 1000) == mtime and stat.st_size == size
    if not current():
        raise ValueError('图片已变更，请刷新')
    if size > MAX_IMAGE_BYTES:
        raise ValueError('图片超过拖出大小预算，请使用下载')
    with open(path, 'rb') as stream:
        data = stream.read(MAX_IMAGE_BYTES + 1)
    result = clean_share_image(data)
    if not current():
        raise ValueError('图片在准备期间已变更，请刷新')
    return result
