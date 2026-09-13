"""``__init__.py`` 拆分的**第一阶段**产物：GitHub 自动更新链。

为什么优先拆这一块：
  · 它是全仓库**边界最清晰**的一段 —— 实测只依赖「一个 aiohttp session」和「插件目录路径」，
    其余全是自洽的纯逻辑（版本比较 / 发布文件白名单 / git blob sha / ZIP 校验与暂存 / 状态落盘）；
  · 对外只暴露「检查更新」与「应用更新」两件事，不碰节点注册、不碰任何路由；
  · 已有独立回归 `tests/test_update_archive.py` 兜底（ZIP 白名单、data/models 保留、坏包拒绝）。

拆分纪律（照做，别破坏）：
  · **路由仍留在 `__init__.py`** —— 那里是所有 `/anima/*` 的唯一入口，集中才看得清 API 面；
    本模块只提供函数。
  · **不改任何 API 路径、不改落盘格式**（`data/update_state.json` 的字段不变）。
  · 会话与插件目录用**显式注入**（`configure()`），不用 import 回 `__init__` —— 避免循环导入。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import zipfile

import aiohttp

# ── 运行时注入（由 __init__.py 调用 configure()）─────────────────────────────
_PLUGIN_DIR: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_get_session = None  # type: ignore[assignment]

_REPO = "Ararararararaki/comfyui-anima-toolkit"
_API_BASE = f"https://api.github.com/repos/{_REPO}"
_ARCHIVE_BASE = f"https://github.com/{_REPO}/archive"
_EXCLUDED_DIRS = {".git", "data", "input", "outputs", "models", "panel", "tests", "node_modules",
                  "__pycache__", ".github", ".venv", "venv"}

# `data/` 里混着两类东西，必须**逐文件**区分，不能整目录放过、也不能整目录挡掉：
#   · 用户状态（prompt_library.json / batches/ / danbooru_account.json …）→ 永不覆盖
#   · 随包发布的词典 → 必须随更新一起下发
# 2026-09-13 的真实缺陷：data/ 整个被排除，于是老用户点「更新」只会拿到新代码、
# 拿不到新词典 —— 2.12.0 的中文联想在老用户机器上会**静默失效**（代码在、索引不在）。
# 而且 `check_update` 的 package_match 也看不见这些文件，连"有更新"都判不出来。
#
# 同理 `services/` 也必须下发：`__init__.py` 拆分后 `from .services.github_update import …`
# 是硬依赖，老用户点更新拿到新 `__init__.py` 却拿不到 services/ → **ImportError，插件整个加载不了**。
_SHIPPED_DATA_FILES = {
    "data/danbooru_tags_with_description_v3_modified.csv",
    "data/danbooru_tags_zh.json",
    "data/danbooru_alias_index.json",
}

# 检查结果缓存（30 秒）+ 串行化锁；与应用锁分开，避免「检查」把「应用」堵住
UPDATE_CHECK_CACHE: dict = {"expires": 0.0, "value": None}
UPDATE_APPLY_LOCK: "object | None" = None  # 由 __init__ 注入 asyncio.Lock（跨版本保持兼容）


def configure(*, plugin_dir: str | None = None, session_getter=None,
              apply_lock=None, check_lock=None) -> None:
    """注入宿主环境。幂等，可重复调用（例如测试里改 PLUGIN_DIR 后）。"""
    global _PLUGIN_DIR, _get_session, UPDATE_APPLY_LOCK
    if plugin_dir is not None:
        _PLUGIN_DIR = plugin_dir
    if session_getter is not None:
        _get_session = session_getter
    if apply_lock is not None:
        UPDATE_APPLY_LOCK = apply_lock
    if check_lock is not None:
        globals()["_CHECK_LOCK"] = check_lock


_CHECK_LOCK = None


def update_state_path() -> str:
    return os.path.join(_PLUGIN_DIR, "data", "update_state.json")


def repo_url() -> str:
    return f"https://github.com/{_REPO}"


# ── 版本比较 ────────────────────────────────────────────────────────────────
def version_tuple(v: str) -> tuple:
    nums = [int(x) for x in re.split(r"[^0-9]+", v) if x.isdigit()][:3]
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


# ── 发布文件白名单 / 遍历 / git blob sha ─────────────────────────────────────
def is_release_path(relative_path: str) -> bool:
    path = relative_path.replace("\\", "/").strip("/")
    if not path:
        return False
    # 白名单要**先于** _EXCLUDED_DIRS 判断：否则 data/ 会先被整目录挡掉
    if path in _SHIPPED_DATA_FILES:
        return True
    if any(part in _EXCLUDED_DIRS for part in path.split("/")):
        return False
    return (
        path in {"__init__.py", "VERSION", "README.md", "CHANGELOG.md", "LICENSE"}
        or path.startswith("anima_")
        or path.startswith("services/")
        or path.startswith("web/")
        or path.startswith("app/")
    )


def iter_update_files(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in _EXCLUDED_DIRS]
        for filename in filenames:
            absolute = os.path.join(dirpath, filename)
            relative = os.path.relpath(absolute, root).replace(os.sep, "/")
            if is_release_path(relative):
                yield relative, absolute


def git_blob_sha(path: str) -> str:
    size = os.path.getsize(path)
    digest = hashlib.sha1()
    digest.update(f"blob {size}\0".encode("utf-8"))
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def local_update_commit() -> str:
    try:
        root_result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], cwd=_PLUGIN_DIR,
            capture_output=True, text=True, timeout=5, check=False,
        )
        repo_root = os.path.normcase(os.path.abspath(root_result.stdout.strip())) if root_result.returncode == 0 else ""
        plugin_root = os.path.normcase(os.path.abspath(_PLUGIN_DIR))
        if not repo_root or repo_root != plugin_root:
            raise RuntimeError("运行目录不是独立 Git 仓库")
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=_PLUGIN_DIR,
            capture_output=True, text=True, timeout=5, check=False,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    try:
        with open(update_state_path(), "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return str(value.get("commit") or "").strip()
    except Exception:
        return ""


def write_update_state(commit: str, version: str) -> bool:
    state_path = update_state_path()
    try:
        os.makedirs(os.path.dirname(state_path), exist_ok=True)
        temp_path = state_path + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump({"commit": commit, "version": version, "updatedAt": time.time()}, handle, ensure_ascii=False)
        os.replace(temp_path, state_path)
        return True
    except Exception:
        try:
            if os.path.exists(state_path + ".tmp"):
                os.remove(state_path + ".tmp")
        except Exception:
            pass
        return False


# ── GitHub 读取 ─────────────────────────────────────────────────────────────
async def _github_json(url: str) -> dict:
    session = await _get_session()
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "ComfyUI-Anima-Batch-LoRA"}
    async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
        if resp.status != 200:
            raise RuntimeError(f"GitHub HTTP {resp.status}")
        data = await resp.json()
        return data if isinstance(data, dict) else {}


async def _github_text(url: str) -> str:
    session = await _get_session()
    headers = {"User-Agent": "ComfyUI-Anima-Batch-LoRA"}
    async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
        if resp.status != 200:
            raise RuntimeError(f"GitHub HTTP {resp.status}")
        return (await resp.text()).strip()


# ── 检查更新 ────────────────────────────────────────────────────────────────
async def get_update_info(current_version: str, force: bool = False) -> dict:
    """返回更新状态。`current_version` 由宿主传入（= __init__.__version__，运行时读 VERSION）。"""
    now = time.time()
    cached = UPDATE_CHECK_CACHE.get("value")
    if not force and cached and now < UPDATE_CHECK_CACHE.get("expires", 0):
        return dict(cached)
    async with _CHECK_LOCK:
        now = time.time()
        cached = UPDATE_CHECK_CACHE.get("value")
        if not force and cached and now < UPDATE_CHECK_CACHE.get("expires", 0):
            return dict(cached)

        latest = ""
        remote_commit = ""
        remote_tree: dict[str, str] = {}
        remote_error = ""
        try:
            latest = await _github_text(f"https://raw.githubusercontent.com/{_REPO}/main/VERSION")
        except Exception as error:
            remote_error = str(error)
        try:
            commit_data = await _github_json(f"{_API_BASE}/commits/main")
            remote_commit = str(commit_data.get("sha") or "").strip()
        except Exception as error:
            remote_error = remote_error or str(error)
        try:
            tree_data = await _github_json(f"{_API_BASE}/git/trees/main?recursive=1")
            if not tree_data.get("truncated"):
                remote_tree = {
                    str(item.get("path")): str(item.get("sha"))
                    for item in tree_data.get("tree", [])
                    if item.get("type") == "blob" and item.get("path") and item.get("sha")
                    and is_release_path(str(item.get("path")))
                }
        except Exception as error:
            remote_error = remote_error or str(error)

        local_commit = local_update_commit()
        package_checked = bool(remote_tree)
        package_match = None
        if package_checked:
            package_match = True
            local_files = dict(iter_update_files(_PLUGIN_DIR))
            for relative, remote_sha in remote_tree.items():
                local_path = local_files.get(relative)
                if not local_path or git_blob_sha(local_path) != remote_sha:
                    package_match = False
                    break
        version_behind = bool(latest and version_tuple(current_version) < version_tuple(latest))
        commit_behind = bool(local_commit and remote_commit and local_commit != remote_commit)
        package_behind = package_checked and package_match is False
        update_available = version_behind or commit_behind or package_behind
        value = {
            "version": current_version,
            "latest": latest or None,
            "behind": update_available,
            "versionBehind": version_behind,
            "updateAvailable": update_available,
            "localCommit": local_commit or None,
            "remoteCommit": remote_commit or None,
            "commitChecked": bool(remote_commit),
            "packageChecked": package_checked,
            "packageMatch": package_match,
            "canAutoUpdate": bool(remote_commit and os.access(_PLUGIN_DIR, os.W_OK)),
            "error": remote_error or None,
            "checkedAt": time.time(),
            "url": repo_url(),
        }
        UPDATE_CHECK_CACHE["value"] = value
        UPDATE_CHECK_CACHE["expires"] = time.time() + 30
        return dict(value)


async def download_update_archive(remote_commit: str, archive_path: str) -> None:
    session = await _get_session()
    url = f"{_ARCHIVE_BASE}/{remote_commit}.zip"
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_connect=30, sock_read=120)
    max_size = 128 * 1024 * 1024
    async with session.get(url, allow_redirects=True, timeout=timeout,
                           headers={"User-Agent": "ComfyUI-Anima-Batch-LoRA"}) as resp:
        if resp.status != 200:
            raise RuntimeError(f"GitHub 更新包 HTTP {resp.status}")
        content_length = int(resp.headers.get("Content-Length", 0) or 0)
        if content_length > max_size:
            raise RuntimeError("GitHub 更新包超过 128MB，已拒绝写入")
        downloaded = 0
        with open(archive_path, "wb") as handle:
            async for chunk in resp.content.iter_chunked(256 * 1024):
                downloaded += len(chunk)
                if downloaded > max_size:
                    raise RuntimeError("GitHub 更新包超过 128MB，已拒绝写入")
                handle.write(chunk)


# ── ZIP 校验 / 暂存 / 应用 ───────────────────────────────────────────────────
# ⚠️ 下面两个函数是**逐行照搬**原 __init__.py 的实现（只把模块级全局换成同模块版本）。
#    它们带着两处安全防护，**任何"顺手简化"都会变成漏洞**：
#      · 路径穿越防护（`..` / 绝对路径 / commonpath 越界）
#      · 应用失败时的**逐文件回滚**（含备份目录）
#    改它们之前先读 tests/test_update_archive.py 里对应的断言。
def stage_update_archive(archive_path: str, stage_dir: str) -> list[tuple[str, str]]:
    with zipfile.ZipFile(archive_path) as archive:
        members = [item for item in archive.infolist() if not item.is_dir()]
        roots = {
            item.filename.replace("\\", "/").split("/", 1)[0]
            for item in members if "/" in item.filename.replace("\\", "/")
        }
        root = next((candidate for candidate in roots if f"{candidate}/__init__.py" in {m.filename.replace('\\', '/') for m in members}), "")
        if not root or f"{root}/VERSION" not in {m.filename.replace("\\", "/") for m in members}:
            raise RuntimeError("更新包结构无效：缺少插件根目录、__init__.py 或 VERSION")
        staged = []
        stage_root = os.path.abspath(stage_dir)
        for item in members:
            archive_name = item.filename.replace("\\", "/")
            prefix = f"{root}/"
            if not archive_name.startswith(prefix):
                continue
            relative = archive_name[len(prefix):]
            if not is_release_path(relative):
                continue
            normalized = os.path.normpath(relative.replace("/", os.sep))
            if normalized in {"", "."} or normalized.startswith("..") or os.path.isabs(normalized):
                raise RuntimeError("更新包包含非法路径")
            destination = os.path.abspath(os.path.join(stage_root, normalized))
            if os.path.commonpath([stage_root, destination]) != stage_root:
                raise RuntimeError("更新包路径越界")
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with archive.open(item) as source, open(destination, "wb") as target:
                shutil.copyfileobj(source, target)
            staged.append((relative.replace("/", os.sep), destination))
        if not any(relative == "__init__.py" for relative, _ in staged) or not any(relative == "VERSION" for relative, _ in staged):
            raise RuntimeError("更新包校验失败：未找到必要发布文件")
        return staged


def apply_staged_update(staged: list[tuple[str, str]]) -> int:
    backup_dir = tempfile.mkdtemp(prefix="anima-update-backup-", dir=os.path.dirname(_PLUGIN_DIR))
    applied: list[tuple[str, str, bool]] = []
    try:
        for relative, source in staged:
            destination = os.path.abspath(os.path.join(_PLUGIN_DIR, relative))
            if os.path.commonpath([_PLUGIN_DIR, destination]) != os.path.abspath(_PLUGIN_DIR):
                raise RuntimeError("更新目标路径越界")
            backup = os.path.join(backup_dir, relative)
            had_old = os.path.isfile(destination)
            if had_old:
                os.makedirs(os.path.dirname(backup), exist_ok=True)
                shutil.copy2(destination, backup)
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            try:
                shutil.copy2(source, destination)
            except Exception:
                if had_old:
                    shutil.copy2(backup, destination)
                elif os.path.exists(destination):
                    os.remove(destination)
                raise
            applied.append((destination, backup, had_old))
        return len(applied)
    except Exception:
        for destination, backup, had_old in reversed(applied):
            try:
                if had_old:
                    shutil.copy2(backup, destination)
                elif os.path.exists(destination):
                    os.remove(destination)
            except Exception:
                pass
        raise
    finally:
        shutil.rmtree(backup_dir, ignore_errors=True)
