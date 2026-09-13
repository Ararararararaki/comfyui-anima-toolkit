#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""registry_setup.py —— ComfyUI Registry 发布助手（尽量把人工步骤压到最少）。

为什么有这个脚本：发布到 registry.comfy.org 需要两样东西，而它们的获取顺序是**死结**：
  · publisher 账号 —— 只能在网页上用 **GitHub OAuth 登录**创建（任何 GitHub token 都代替不了）
  · publishing PAT —— 又必须先有账号才能生成

所以**第一步只能人工**（浏览器登录 + 建 publisher + 生成 PAT），本脚本负责之后的一切：
  1. 校验 PAT 是否绑定到了真实用户（`user not found` = 尚未登录过，PAT 是"孤儿"）
  2. PAT + publisher 归属校验
  3. 核对本地 `pyproject.toml` 的 PublisherId / version 与 registry 要求
  4. 跑 `comfy node validate`
  5. 执行 `comfy node publish`

用法:
    # 只体检（不发布）
    python tools/registry_setup.py --token <PAT> --check

    # 体检 + 发布
    python tools/registry_setup.py --token <PAT>

    # 首次发布后想顺手建 publisher（仅当你的账号已登录过、但还没建 publisher）
    python tools/registry_setup.py --token <PAT> --create-publisher

环境变量 `COMFY_REGISTRY_TOKEN` 可作为 --token 的替代。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = "https://api.comfy.org"
PUBLISHER_HINT = "ararararararaki"  # registry 要求小写


def _req(method: str, path: str, token: str, payload: dict | None = None) -> tuple[int, str]:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "tk-registry-setup",
    })
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.status, (resp.read().decode("utf-8", "replace") or "")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, f"{type(e).__name__}: {e}"


def _read_pyproject() -> dict:
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    def grab(key: str) -> str | None:
        m = re.search(rf'(?m)^{key}\s*=\s*"([^"]*)"', text)
        return m.group(1) if m else None
    return {
        "name": grab("name"),
        "version": grab("version"),
        "publisher_id": grab("PublisherId"),
        "display_name": grab("DisplayName"),
        "requires_comfyui": grab("requires-comfyui"),
    }


def check_token(token: str) -> tuple[bool, str]:
    """判定 PAT 是否可用：关键是它有没有绑定到真实用户。"""
    code, body = _req("GET", f"/publishers/{PUBLISHER_HINT}/tokens", token)
    if code == 200:
        return True, "PAT 已绑定用户，且对目标 publisher 有读写权限"
    if "user not found" in body:
        return False, ("PAT 未绑定任何用户（'user not found'）—— 说明该 token 对应的账号"
                       "从未在 registry.comfy.org 用 GitHub 登录过，registry 里没有这个 user。")
    if code == 401:
        return False, f"鉴权失败（401）：{body[:200]}"
    if code == 404:
        return False, f"publisher `{PUBLISHER_HINT}` 不存在（404）—— 需要先创建 publisher。"
    return False, f"HTTP {code}: {body[:200]}"


def create_publisher(token: str, cfg: dict) -> bool:
    payload = {
        "id": cfg["publisher_id"],
        "name": cfg["display_name"] or cfg["publisher_id"],
        "description": "",
        "source_code_repo": "https://github.com/Ararararararaki/comfyui-anima-toolkit",
        "support": "https://github.com/Ararararararaki/comfyui-anima-toolkit/issues",
    }
    code, body = _req("POST", "/publishers", token, payload)
    print(f"POST /publishers -> {code} {body[:300]}")
    return code in (200, 201)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default=os.environ.get("COMFY_REGISTRY_TOKEN", ""))
    ap.add_argument("--check", action="store_true", help="只体检，不发布")
    ap.add_argument("--create-publisher", action="store_true", help="尝试创建 publisher")
    a = ap.parse_args()

    if not a.token:
        print("需要 --token <PAT>（或环境变量 COMFY_REGISTRY_TOKEN）")
        return 2

    cfg = _read_pyproject()
    print("=== 本地 pyproject.toml ===")
    for k, v in cfg.items():
        print(f"  {k:<18} {v}")

    ver_file = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    print(f"  VERSION 文件       {ver_file}")
    if cfg["version"] != ver_file:
        print(f"  ✗ pyproject version 与 VERSION 不一致（{cfg['version']} vs {ver_file}）—— 先跑 tools/bump_version.py")
        return 1
    if cfg["publisher_id"] != cfg["publisher_id"].lower():
        print("  ✗ PublisherId 必须全小写")
        return 1

    print("\n=== PAT 体检 ===")
    ok, why = check_token(a.token)
    print(("  ✓ " if ok else "  ✗ ") + why)
    if not ok:
        print("""
下一步（只能人工，1 分钟）：
  1. 浏览器打开 https://registry.comfy.org 并用 **GitHub 登录**（这一步会创建 registry 的 user 记录；
     任何 GitHub token 都不能代替 —— 这就是为什么 `comfy node publish` 会报
     `Failed to validate token` / `user not found`）。
  2. 登录后创建 Publisher，id 填 **ararararararaki**（registry 只接受小写）。
  3. 在同一账号页生成 **Publishing API Key**，重新执行本脚本：`--token <新 PAT>`。
""")
        return 1

    if a.create_publisher:
        print("\n=== 尝试创建 publisher ===")
        create_publisher(a.token, cfg)

    if a.check:
        print("\n--check：未发布。")
        return 0

    print("\n=== comfy node validate ===")
    v = subprocess.run([sys.executable, "-m", "comfy_cli", "node", "validate"],
                       cwd=str(ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    tail = (v.stdout or "").strip().splitlines()[-1:] or [""]
    print("  " + tail[0])
    if v.returncode != 0:
        print((v.stdout or "")[-1500:])
        return v.returncode

    print("\n=== comfy node publish ===")
    p = subprocess.run([sys.executable, "-m", "comfy_cli", "node", "publish", "--token", a.token],
                       cwd=str(ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    print("\n".join(out.splitlines()[-12:]))
    return p.returncode


if __name__ == "__main__":
    raise SystemExit(main())
