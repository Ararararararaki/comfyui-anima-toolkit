"""Explicit gallery saves: revision checked, original backed up, atomic replacement."""
from io import BytesIO
from pathlib import Path, PurePosixPath
import hashlib
import os
import tempfile
import threading
import uuid

MAX_BYTES = 64 * 1024 * 1024
_LOCK = threading.RLock()


def save_gallery_edit(root, backup_root, relative, expected_root, mtime, size, data, overwrite=False):
    root = Path(root).resolve()
    if os.path.normcase(str(root)) != os.path.normcase(str(Path(expected_root).resolve())):
        raise ValueError('输出目录已变化，请刷新后重试')
    part = PurePosixPath(str(relative).replace('\\', '/'))
    if part.is_absolute() or '..' in part.parts or ':' in str(part):
        raise ValueError('图片路径无效')
    original = (root / str(part)).resolve()
    if not original.is_relative_to(root) or not original.is_file():
        raise ValueError('图片不存在或路径不在输出目录内')
    formats = {'.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP'}
    if original.suffix.lower() not in formats or not data or len(data) > MAX_BYTES:
        raise ValueError('仅支持 PNG、JPEG、WebP 静态图片，大小不超过 64 MiB')
    from PIL import Image
    with Image.open(BytesIO(data)) as image:
        if image.format != formats[original.suffix.lower()] or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('编辑文件格式不匹配或包含动画')
        width, height = image.size
        if width * height > 64_000_000:
            raise ValueError('编辑图片超过 6400 万像素预算')
        image.verify()
    with Image.open(BytesIO(data)) as image:
        image.load()
    with Image.open(original) as image:
        if getattr(image, 'n_frames', 1) != 1:
            raise ValueError('动画原图不能覆盖为静态图')

    def check():
        stat = original.stat()
        if round(stat.st_mtime * 1000) != int(mtime) or stat.st_size != int(size):
            raise ValueError('原图已变化，未覆盖；请重新打开后编辑')
        if original.resolve() != original or not original.is_relative_to(root):
            raise ValueError('图片路径已变化')

    temporary = None
    with _LOCK:
        check()
        backup = None
        if overwrite:
            backups = Path(backup_root).resolve()
            backups.mkdir(parents=True, exist_ok=True)
            backup = backups / (uuid.uuid4().hex + original.suffix)
            old = original.read_bytes()
            with backup.open('xb') as stream:
                stream.write(old); stream.flush(); os.fsync(stream.fileno())
            if hashlib.sha256(backup.read_bytes()).digest() != hashlib.sha256(old).digest():
                raise OSError('原图备份核验失败，未覆盖')
        destination = original if overwrite else original.with_name(original.stem + '_edited_' + uuid.uuid4().hex[:10] + original.suffix)
        try:
            with tempfile.NamedTemporaryFile(dir=original.parent, suffix='.tk-edit', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            check()
            if overwrite:
                os.replace(temporary, destination)
            else:
                # Atomic publication that fails rather than replacing any existing file.
                os.link(temporary, destination)
            stat = destination.stat()
            return {'path': destination.relative_to(root).as_posix(), 'filename': destination.name,
                    'mtime': round(stat.st_mtime * 1000), 'size': stat.st_size,
                    'width': width, 'height': height, 'backup': str(backup) if backup else None}
        finally:
            if temporary and temporary.exists():
                assert temporary.resolve().is_relative_to(root)
                temporary.unlink()
