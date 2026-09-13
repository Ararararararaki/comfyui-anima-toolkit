#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CI 自检：workflow 文件本身必须合法且守住两条硬约束。

为什么需要：「CI 配置写错」的失败模式很隐蔽 ——
  · YAML 语法错 → workflow 根本不跑，而 GitHub 只发一封邮件，很容易被忽略；
  · 验证 workflow 误拿到写权限 → 可能与 build-app.yml 互相触发形成循环；
  · 验证 workflow 误改/误提交 app/ → 静默污染构建产物。
这三条都不该靠人去 review diff 发现，这里固化成测试。

只在有 PyYAML 时做完整解析；没有则退化为文本级约束检查（不跳测）。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
CI_YML = WORKFLOWS / "ci.yml"
BUILD_YML = WORKFLOWS / "build-app.yml"


def _try_yaml(path: Path):
    try:
        import yaml  # type: ignore
    except Exception:
        return None
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def test_ci_workflow_exists_and_is_valid_yaml():
    assert CI_YML.is_file(), "缺少 .github/workflows/ci.yml"
    data = _try_yaml(CI_YML)
    if data is None:
        pytest.skip("未安装 PyYAML，跳过 YAML 结构解析（文本级约束仍由其他用例覆盖）")
    assert isinstance(data, dict), "workflow 顶层必须是映射"
    # YAML 里 `on:` 会被解析成布尔键 True，两种都接受
    triggers = data.get("on", data.get(True))
    assert triggers, "ci.yml 必须有触发器（on:）"
    text = CI_YML.read_text(encoding="utf-8")
    assert "pull_request" in text, "CI 必须在 PR 时运行"
    assert "push" in text, "CI 必须在推送到 main 时运行"


def test_verify_workflow_is_read_only():
    """验证型 workflow 绝不能有写权限 —— 这是「不形成循环」的结构性保证。"""
    text = CI_YML.read_text(encoding="utf-8")
    assert "contents: read" in text, "验证 CI 必须显式声明 contents: read"
    assert "contents: write" not in text, "验证 CI 不允许有写权限"
    # 不允许出现任何推送/提交动作
    for forbidden in ("git push", "git commit", "git add"):
        assert forbidden not in text, f"验证 CI 不允许 `{forbidden}`（它必须只读）"


def test_build_workflow_stays_separate_and_cannot_loop():
    """build-app 是唯一允许提交 app/ 的 workflow，且必须防「自己触发自己」。"""
    assert BUILD_YML.is_file(), "缺少 build-app.yml"
    text = BUILD_YML.read_text(encoding="utf-8")
    assert "git push" in text, "build-app.yml 负责提交 app/（若已改设计请同步本测试）"
    # 路径过滤必须挡掉 app/**，否则 bot 提交会再次触发自己
    assert "panel/**" in text, "build-app 应只在 panel/** 变化时运行"
    # 防循环双保险：bot 自己的提交不再触发
    assert "github-actions[bot]" in text, "build-app 应识别 bot 提交以避免自触发"


def _run_scripts(text: str) -> str:
    """只取 workflow 里真正会被执行的 `run:` 内容，**排除注释**。

    否则「注释里写了 --integration 用于说明为什么不跑」会被误判成「CI 在跑 integration」。
    """
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        lines.append(line)
    return "\n".join(lines)


def test_ci_does_not_require_real_comfyui():
    """CI 不能真的执行 integration/repro —— 它们要真实浏览器与 ComfyUI(:8188)。"""
    body = _run_scripts(CI_YML.read_text(encoding="utf-8"))
    assert "--integration" not in body, "CI 不允许真的跑 integration 层"
    assert "tests/integration" not in body, "CI 不允许直接收集 integration 目录"
    assert "repro/" not in body, "CI 不允许跑 repro 层"
    # 必须留下「为何不跑」的说明，避免后人误加
    assert "integration" in CI_YML.read_text(encoding="utf-8"), \
        "CI 里应留下「为何不跑 integration」的说明"


def test_registry_version_matches_version_file():
    """`pyproject.toml` 的 [project].version 必须等于仓库根 VERSION。

    Registry 一旦发布过某个版本号就不能重发，所以它和 README/CHANGELOG 一样，
    必须与唯一真源 VERSION 严格同步（ai_verify 也查，这里再挡一道，因为跑 pytest 的人更多）。
    """
    pp = ROOT / "pyproject.toml"
    assert pp.is_file(), "缺少 pyproject.toml（ComfyUI Registry 元数据）"
    body = pp.read_text(encoding="utf-8")
    m = re.search(r'(?m)^version\s*=\s*"([^"]+)"', body)
    assert m, "pyproject.toml 缺少 [project].version"
    ver = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    assert m.group(1) == ver, f"pyproject version={m.group(1)} != VERSION={ver}"


def test_registry_requirements_are_minimal():
    """Registry 依赖清单只放必需的；重量/可选依赖必须分开写。

    否则每个从 ComfyUI-Manager 安装的用户都会被强制拉 playwright / llama-cpp-python
    这种几百 MB 的编译型包 —— 对本插件多数用户是纯负担。
    """
    req = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "aiohttp" in req, "必需的 aiohttp 应在 requirements.txt"
    for heavy in ("playwright", "llama-cpp-python", "llama_cpp"):
        assert not re.search(rf"(?m)^{re.escape(heavy)}", req), (
            f"{heavy} 属可选依赖，必须放 requirements-optional.txt，不能进 requirements.txt")
    # torch/numpy/PIL 由 ComfyUI 自带，重复声明会引发版本冲突
    for provided in ("torch", "numpy", "Pillow", "PIL"):
        assert not re.search(rf"(?m)^{re.escape(provided)}", req), (
            f"{provided} 由 ComfyUI 提供，不要在 requirements.txt 里重复声明")
    opt = ROOT / "requirements-optional.txt"
    assert opt.is_file(), "可选依赖应集中写在 requirements-optional.txt"

def test_registry_publisher_id_is_lowercase():
    """`[tool.comfy].PublisherId` 必须全小写。

    registry 的校验规则是「只能小写字母/数字/连字符」，而且 /publishers/validate 实测会把
    `Ararararararaki` 直接拒掉（"Must start with a lowercase letter"）。
    更坑的是：**publish 时**如果 id 里带大写，报错是含糊的
    `Failed to validate token`，很容易误判成「PAT 坏了」而浪费半天。
    """
    body = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r'(?m)^PublisherId\s*=\s*"([^"]*)"', body)
    assert m, "pyproject.toml 缺少 [tool.comfy].PublisherId"
    pid = m.group(1)
    assert pid, "PublisherId 不能为空"
    assert pid == pid.lower(), f"PublisherId={pid!r} 含大写，registry 只接受小写"
    assert re.fullmatch(r"[a-z0-9][a-z0-9-]*", pid), f"PublisherId={pid!r} 含非法字符"


def test_ci_dev_requirements_exist_and_are_minimal():
    """CI 依赖清单必须存在，且不能把 ComfyUI 运行时重量依赖塞进来。"""
    req = ROOT / "requirements-dev.txt"
    assert req.is_file(), "缺少 requirements-dev.txt（CI 用它装依赖）"
    body = req.read_text(encoding="utf-8")
    assert "pytest" in body, "要求清单里必须有 pytest"
    for heavy in ("torch", "torchvision", "numpy==1.", "playwright"):
        assert not re.search(rf"^{re.escape(heavy)}", body, re.M), (
            f"requirements-dev.txt 不该包含 {heavy}（CI 不需要，装上会拖慢几十倍）")
