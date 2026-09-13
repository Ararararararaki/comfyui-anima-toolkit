"""守卫：离线层测试里**不允许**出现「本机专属」的东西。

为什么需要（血泪）：CI 首跑连红 4 次，全是一类问题 —— 本机成立、干净环境不成立：
  · `test_batch_lora_trigger_words.py` 写死 `E:\\claude program\\...` 当包目录 → Linux ENOENT
  · `cards_widget_logic.test.js` / `test_preset_latent_resolution.js` 写死
    `E:/claude program/.../web/js/...` → Linux ENOENT
  · `test_lora_subdir.py` 断言硬编码 Windows 反斜杠路径 → Linux 分隔符不同
  · `test_danbooru_meta.py` 顶层 `import PIL`（本机有 ComfyUI 带的，CI 没有）
  · 某测试用空 ModuleType 覆盖真 `aiohttp` 且不还原 → 污染同 session 后续测试

这类问题本地**永远复现不出来**，只能靠推上去才发现，一次 CI 周期好几分钟。
本测试把它们提前到本地：把「机器专属」变成确定的 FAIL。
"""
from __future__ import annotations

import io
import re
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent

# 本机专属的绝对路径前缀（写死在测试里就一定会在 CI 上 ENOENT）
MACHINE_PATH_RE = re.compile(r"[\"'][A-Za-z]:[\\/](?:claude|Users|1AI|1gongju)", re.I)
# Windows 专属反斜杠路径断言（应改用 os.path.join / 正斜杠归一化）
WIN_SEP_ASSERT_RE = re.compile(r"assert[^\n]*==\s*[\"'][A-Za-z]:\\\\[^\n]*[\"']")

# CI 只装 requirements-dev.txt；本机多出来的是 ComfyUI 自带的这些。
# 离线层若**真实 import** 它们（没自己 stub）→ CI 收集期就炸。
CI_MISSING_RE = re.compile(
    r"(?m)^\s*(?:import|from)\s+(torch|numpy|PIL|psutil|playwright)(?:\.|\s|$)")


def _lines(path: Path):
    """逐行读取。用 with 关闭句柄 —— 直接对 io.open(...) 迭代会漏 ResourceWarning。"""
    with io.open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            yield line


def _text(path: Path) -> str:
    with io.open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _offline_py_files() -> list[Path]:
    return sorted(p for p in TESTS.glob("test_*.py"))


def test_offline_tests_have_no_machine_specific_absolute_paths():
    """离线层不得写死本机绝对路径（用 __file__ 推导）。"""
    offenders = []
    for p in _offline_py_files():
        for i, line in enumerate(_lines(p), 1):
            if line.lstrip().startswith("#"):
                continue
            m = MACHINE_PATH_RE.search(line)
            if m:
                offenders.append(f"{p.name}:{i} {m.group(0)}")
    assert not offenders, (
        "以下测试写死了本机绝对路径（CI/Linux 上必失败），请改成从 __file__ 推导：\n  "
        + "\n  ".join(offenders))


def test_offline_js_tests_have_no_machine_specific_absolute_paths():
    """JS 测试同样不得写死本机绝对路径（本次 CI 就是被这个卡住的）。"""
    offenders = []
    for p in sorted(list(TESTS.glob("*.js")) + list(TESTS.glob("*.mjs"))):
        text = _text(p)
        for i, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("//"):
                continue
            m = MACHINE_PATH_RE.search(line)
            if m:
                offenders.append(f"{p.name}:{i} {m.group(0)}")
    assert not offenders, (
        "以下 JS 测试写死了本机绝对路径（CI/Linux 上必 ENOENT），请用 path.resolve(__dirname, ...)：\n  "
        + "\n  ".join(offenders))


def test_offline_layer_does_not_hard_import_ci_missing_heavy_deps():
    """离线层不得**真实 import** ComfyUI 自带、而 CI 没有的重依赖。

    要么自己用 sys.modules 造 stub（且 stub 必须看着像包：__path__ = []），
    要么把依赖加进 requirements-dev.txt。二者都不做就会「本地绿、CI 红」。
    """
    offenders = []
    for p in _offline_py_files():
        text = _text(p)
        # 该文件自己 stub 了某模块则放过（说明作者是有意为之）
        stubbed = set(re.findall(r'sys\.modules\[\s*[\'"]([^\'"]+)[\'"]\s*\]\s*=', text))
        for m in CI_MISSING_RE.finditer(text):
            mod = m.group(1)
            if mod in stubbed or any(s.split(".")[0] == mod for s in stubbed):
                continue
            line_no = text[:m.start()].count("\n") + 1
            offenders.append(f"{p.name}:{line_no} import {mod}")
    assert not offenders, (
        "以下测试真实 import 了 CI 未安装的重依赖（本机靠 ComfyUI 环境蒙混）：\n  "
        + "\n  ".join(offenders)
        + "\n处理：A) 加进 requirements-dev.txt；B) 自己 stub（__path__ = []）")


@pytest.mark.unit
def test_offline_layer_has_no_windows_only_separator_assertions():
    """不得断言硬编码的反斜杠路径（平台不同必红）。"""
    offenders = []
    for p in _offline_py_files():
        for i, line in enumerate(_lines(p), 1):
            if line.lstrip().startswith("#"):
                continue
            if WIN_SEP_ASSERT_RE.search(line):
                offenders.append(f"{p.name}:{i} {line.strip()[:90]}")
    assert not offenders, (
        "以下断言硬编码了 Windows 反斜杠路径，请用 os.path.join 或归一化后比较：\n  "
        + "\n  ".join(offenders))
