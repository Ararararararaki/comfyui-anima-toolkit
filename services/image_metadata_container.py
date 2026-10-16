"""Read image metadata containers without loading or decoding pixel data.

PNG text may occur after IDAT. JPEG markers and WebP RIFF chunks are visited
to their container end; TIFF/EXIF values are decoded by Pillow's existing
Image.Exif reader. Generation-format interpretation belongs to the caller.

Limits match the browser reader: 16 MiB per metadata block, 64 MiB total
text. Structural/metadata corruption is reported; pixel codec validity is
deliberately outside this reader's scope.
"""
from __future__ import annotations

import os
import struct
import warnings
import zlib
from dataclasses import dataclass, field
from typing import BinaryIO, Literal, TypedDict

from PIL import ExifTags, Image

MAX_METADATA_BLOCK = 16 * 1024 * 1024
MAX_TEXT_MEMORY = 64 * 1024 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_XMP_KEY = "XML:com.adobe.xmp"
_XMP_APP1 = b"http://ns.adobe.com/xap/1.0/\0"
_SCAN_BLOCK = 64 * 1024
_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
             0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


class ImageMetadataContainer(TypedDict):
    raw: dict[str, str]
    status: Literal["present", "absent", "error", "unsupported"]
    format: Literal["png", "jpeg", "webp", "unknown"]
    warnings: list[str]


class _MetadataError(ValueError):
    """All messages are fixed diagnostic codes, never source text or paths."""


class _UnsupportedPngTextCompression(_MetadataError):
    """Bounded text chunk can be skipped, but the container remains error."""


@dataclass
class _Metadata:
    raw: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    present: bool = False
    failed: bool = False
    text_bytes: int = 0

    def add(self, key: str, value: str) -> None:
        size = len(value.encode("utf-8"))
        if size > MAX_METADATA_BLOCK:
            raise _MetadataError("metadata-block-limit")
        if self.text_bytes + size > MAX_TEXT_MEMORY:
            raise _MetadataError("metadata-total-limit")
        self.text_bytes += size
        self.present = True
        if key in self.raw and "duplicate-metadata-key" not in self.warnings:
            self.warnings.append("duplicate-metadata-key")
        self.raw[key] = value


def _read(fp: BinaryIO, length: int) -> bytes:
    data = fp.read(length)
    if len(data) != length:
        raise _MetadataError("truncated-container")
    return data


def _skip(fp: BinaryIO, length: int, end: int) -> None:
    if length < 0 or fp.tell() + length > end:
        raise _MetadataError("truncated-container")
    fp.seek(length, os.SEEK_CUR)


def _inflate(data: bytes) -> bytes:
    inflater = zlib.decompressobj()
    try:
        result = inflater.decompress(data, MAX_METADATA_BLOCK + 1)
    except zlib.error as error:
        raise _MetadataError("invalid-compressed-metadata") from error
    if len(result) > MAX_METADATA_BLOCK or inflater.unconsumed_tail:
        raise _MetadataError("metadata-block-limit")
    if not inflater.eof or inflater.unused_data:
        raise _MetadataError("invalid-compressed-metadata")
    return result


def _utf_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    return data.decode("utf-8-sig")


def _user_comment(value: bytes | str, meta: _Metadata) -> str | None:
    if isinstance(value, str):
        return value.rstrip("\0")
    prefix, body = value[:8], value[8:]
    if prefix == b"ASCII\0\0\0":
        return body.decode("ascii").rstrip("\0")
    if prefix == b"JIS\0\0\0\0\0":
        return body.decode("shift_jis").rstrip("\0")
    if prefix == b"UNICODE\0":
        codec = "utf-16" if body.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-16-be"
        return body.decode(codec).rstrip("\0")
    data = body if prefix == bytes(8) else value
    # Some writers use undefined UTF-8 or a bare textual UserComment. Unknown
    # binary data remains EXIF-present, without inventing a prompt-like value.
    try:
        text = _utf_text(data).rstrip("\0")
        if "\0" not in text:
            return text
    except UnicodeError:
        pass
    meta.warnings.append("unknown-user-comment-encoding")
    return None


def _exif(data: bytes, meta: _Metadata) -> None:
    meta.present = True
    if len(data) > MAX_METADATA_BLOCK:
        raise _MetadataError("metadata-block-limit")
    tiff = data[6:] if data.startswith(b"Exif\0\0") else data
    if len(tiff) < 8 or tiff[:4] not in (b"II*\0", b"MM\0*"):
        raise _MetadataError("invalid-exif-metadata")
    try:
        # Pillow may warn and drop a truncated TIFF value instead of raising.
        # Those warnings must be an error, and their potentially private body
        # must never be forwarded to diagnostics.
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            exif = Image.Exif()
            exif.load(data)
            directories = [dict(exif.items())]
            if 0x8769 in exif:
                directories.append(exif.get_ifd(0x8769))
            for directory in directories:
                for tag, value in directory.items():
                    key = ExifTags.TAGS.get(tag, str(tag))
                    text = None
                    if tag == 0x9286 and isinstance(value, (bytes, str)):
                        text = _user_comment(value, meta)
                    elif tag == 0x02BC:
                        packet = bytes(value) if not isinstance(value, str) else value
                        text = _utf_text(packet) if isinstance(packet, bytes) else packet
                        key = _XMP_KEY
                    elif 0x9C9B <= tag <= 0x9C9F and isinstance(value, (bytes, tuple)):
                        text = bytes(value).decode("utf-16-le").rstrip("\0")
                    elif isinstance(value, str):
                        text = value.rstrip("\0")
                    if text is not None:
                        meta.add(key, text)
            if caught:
                raise _MetadataError("invalid-exif-metadata")
    except _MetadataError:
        raise
    except Exception as error:
        raise _MetadataError("invalid-exif-metadata") from error


def _png_text(kind: bytes, data: bytes, meta: _Metadata) -> None:
    key, separator, body = data.partition(b"\0")
    if not separator or not 1 <= len(key) <= 79:
        raise _MetadataError("invalid-png-text")
    if kind == b"zTXt":
        if not body:
            raise _MetadataError("invalid-png-text")
        if body[0] != 0:
            raise _UnsupportedPngTextCompression("unsupported-png-text-compression-method")
        text = _inflate(body[1:]).decode("latin-1")
    elif kind == b"iTXt":
        # W3C PNG 3rd ed §11.3.3.2：未压缩文本的 compression method 由解码器忽略，
        # 因此只在压缩标志为 1 时才校验 method 必须为 0。
        if len(body) < 2 or body[0] not in (0, 1):
            raise _MetadataError("invalid-png-text")
        if body[0] == 1 and body[1] != 0:
            raise _UnsupportedPngTextCompression("unsupported-png-text-compression-method")
        compressed, body = body[0], body[2:]
        language, separator, body = body.partition(b"\0")
        translated, second_separator, body = body.partition(b"\0")
        if not separator or not second_separator:
            raise _MetadataError("invalid-png-text")
        language.decode("ascii")
        translated.decode("utf-8")
        text = (_inflate(body) if compressed else body).decode("utf-8")
    else:
        text = body.decode("latin-1")
    meta.add(key.decode("latin-1"), text)


def _png(fp: BinaryIO, end: int, meta: _Metadata) -> None:
    if _read(fp, 8) != _PNG_SIGNATURE:
        raise _MetadataError("invalid-png-header")
    first, image_seen = True, False
    while fp.tell() < end:
        length, kind = struct.unpack(">I4s", _read(fp, 8))
        if length > 0x7FFFFFFF or fp.tell() + length + 4 > end:
            raise _MetadataError("truncated-container")
        if first and (kind != b"IHDR" or length != 13):
            raise _MetadataError("invalid-png-header")
        first = False
        if kind in (b"IHDR", b"tEXt", b"zTXt", b"iTXt", b"eXIf", b"IEND"):
            if length > MAX_METADATA_BLOCK:
                raise _MetadataError("metadata-block-limit")
            data = _read(fp, length)
            checksum = struct.unpack(">I", _read(fp, 4))[0]
            if checksum != zlib.crc32(kind + data) & 0xFFFFFFFF:
                raise _MetadataError("invalid-png-metadata-crc")
            if kind in (b"tEXt", b"zTXt", b"iTXt"):
                # A recognized text block proves presence even when its
                # ancillary header cannot be interpreted. Never infer absent
                # from an image containing only such damaged text headers.
                meta.present = True
                try:
                    _png_text(kind, data, meta)
                except _UnsupportedPngTextCompression as error:
                    # Keep the failure distinct from an unusable header, but
                    # retain independent valid fields after this bounded block.
                    meta.failed = True
                    meta.warnings.append(str(error))
                except _MetadataError as error:
                    # 只有"文本块头部畸形"降级为警告并跳过：不能因此丢弃同一文件里其他
                    # 可靠的文本块（例如 tEXt 的 parameters）。安全限额与压缩/CRC 错误
                    # 仍是容器级 error，必须继续抛出。
                    if str(error) != "invalid-png-text":
                        raise
                    meta.warnings.append("invalid-text-chunk:" + str(error))
            elif kind == b"eXIf":
                _exif(data, meta)
            elif kind == b"IEND":
                if length or not image_seen:
                    raise _MetadataError("invalid-png-end")
                return
        else:
            if kind == b"IDAT":
                image_seen = True
            _skip(fp, length + 4, end)
    raise _MetadataError("missing-png-end")


def _jpeg_scan_marker(fp: BinaryIO) -> int:
    """Find the next unescaped marker in entropy bytes, without decoding them."""
    pending_ff = False
    while True:
        start = fp.tell()
        block = fp.read(_SCAN_BLOCK)
        if not block:
            raise _MetadataError("missing-jpeg-end")
        index = 0
        while index < len(block):
            if not pending_ff:
                index = block.find(b"\xff", index)
                if index < 0:
                    break
                index += 1
                pending_ff = True
                continue
            code = block[index]
            index += 1
            if code == 0xFF:
                continue
            pending_ff = False
            if code == 0 or 0xD0 <= code <= 0xD7 or code == 0x01:
                continue
            fp.seek(start + index)
            return code


def _jpeg(fp: BinaryIO, end: int, meta: _Metadata) -> None:
    if _read(fp, 2) != b"\xff\xd8":
        raise _MetadataError("invalid-jpeg-header")
    frame_seen, scan_seen, marker = False, False, None
    while marker is not None or fp.tell() < end:
        if marker is None:
            if _read(fp, 1) != b"\xff":
                raise _MetadataError("invalid-jpeg-marker")
            marker = _read(fp, 1)[0]
            while marker == 0xFF:
                marker = _read(fp, 1)[0]
        if marker == 0xD9:
            if not frame_seen or not scan_seen:
                raise _MetadataError("invalid-jpeg-end")
            return
        if marker == 0x01:
            marker = None
            continue
        if marker in (0, 0xD8) or 0xD0 <= marker <= 0xD7:
            raise _MetadataError("invalid-jpeg-marker")
        length = struct.unpack(">H", _read(fp, 2))[0] - 2
        if length < 0 or fp.tell() + length > end:
            raise _MetadataError("truncated-container")
        if marker in (0xE1, 0xFE):
            data = _read(fp, length)
            if marker == 0xFE:
                try:
                    text = _utf_text(data)
                except UnicodeError:
                    # JPEG COM has no defined charset. Latin-1 is reversible;
                    # retain it as a raw comment, not as a generation prompt.
                    text = data.decode("latin-1")
                    meta.warnings.append("jpeg-comment-latin1")
                meta.add("Comment", text)
            elif data.startswith(b"Exif\0\0"):
                _exif(data, meta)
            elif data.startswith(_XMP_APP1):
                meta.add(_XMP_KEY, _utf_text(data[len(_XMP_APP1):]))
            elif data.startswith(b"http://ns.adobe.com/xmp/extension/\0"):
                meta.present = True
                meta.warnings.append("extended-xmp-not-decoded")
        else:
            _skip(fp, length, end)
        frame_seen |= marker in _JPEG_SOF
        if marker == 0xDA:
            scan_seen = True
            marker = _jpeg_scan_marker(fp)
        else:
            marker = None
    raise _MetadataError("missing-jpeg-end")


def _webp(fp: BinaryIO, end: int, meta: _Metadata) -> None:
    signature, size, kind = struct.unpack("<4sI4s", _read(fp, 12))
    if signature != b"RIFF" or kind != b"WEBP" or size + 8 != end:
        raise _MetadataError("invalid-webp-header")
    image_seen = False
    while fp.tell() < end:
        kind, length = struct.unpack("<4sI", _read(fp, 8))
        padded = length + (length & 1)
        if fp.tell() + padded > end:
            raise _MetadataError("truncated-container")
        if kind in (b"EXIF", b"XMP "):
            if length > MAX_METADATA_BLOCK:
                raise _MetadataError("metadata-block-limit")
            data = _read(fp, length)
            if kind == b"EXIF":
                _exif(data, meta)
            else:
                meta.add(_XMP_KEY, _utf_text(data))
            _skip(fp, length & 1, end)
        else:
            image_seen |= kind in (b"VP8 ", b"VP8L", b"ANMF")
            _skip(fp, padded, end)
    if not image_seen:
        raise _MetadataError("missing-webp-image")


def read_image_metadata(path: str | os.PathLike[str]) -> ImageMetadataContainer:
    """Return raw textual metadata and a separate, honest container status.

    ``present`` includes an EXIF/XMP packet with no recoverable generation
    prompt. A failure retains metadata read before the failure, with a fixed
    diagnostic code; no exception message, source body or path is logged.
    """
    meta = _Metadata()
    image_format = "unknown"
    status = "unsupported"
    try:
        with open(path, "rb") as fp:
            end = os.fstat(fp.fileno()).st_size
            signature = fp.read(12)
            fp.seek(0)
            if not signature:
                raise _MetadataError("empty-container")
            if signature.startswith(b"\x89PNG"):
                image_format = "png"
                _png(fp, end, meta)
            elif signature.startswith(b"\xff\xd8"):
                image_format = "jpeg"
                _jpeg(fp, end, meta)
            elif signature.startswith(b"RIFF") and signature[8:12] == b"WEBP":
                image_format = "webp"
                _webp(fp, end, meta)
            elif signature.startswith(b"RIFF") and len(signature) < 12:
                raise _MetadataError("truncated-container")
            else:
                return {"raw": {}, "format": image_format, "status": status, "warnings": []}
            status = "error" if meta.failed else "present" if meta.present else "absent"
    except _MetadataError as error:
        status = "error"
        meta.warnings.append(str(error))
    except UnicodeError:
        status = "error"
        meta.warnings.append("invalid-metadata-text-encoding")
    except OSError:
        status = "error"
        meta.warnings.append("container-read-error")
    except Exception:
        status = "error"
        meta.warnings.append("container-parse-error")
    return {"raw": meta.raw, "format": image_format, "status": status,
            "warnings": list(dict.fromkeys(meta.warnings))}
