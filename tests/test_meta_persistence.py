"""anima_meta.json 持久化回归：键级合并 / 空值护栏 / __replace / .bak 备份 / 原子写。

背景（真实事故）：前端拉取 `GET /anima/meta` 失败时拿**空对象**去 POST，
后端**整体覆盖**，于是 LoRA 组 / 分类 / 偏好全部丢失。
用户要求「项目自定义存储永久化保存，决不能丢失」。本文件把修复契约钉成回归。

契约（本文件即契约的可执行版本）：
  1. `POST /anima/meta` 是**键级合并**：`merged = {**current, **incoming}`
     —— body 未提及的顶层键必须完整保留。
  2. **空值护栏**：incoming 某键为「空」（`[]` / `{}` / `""` / `None`）而 current 非空
     → 跳过该键（保留 current），键名进回包 `skipped`；
     例外：body 里带 `__replace: ["键名"]` 时允许清空。
  3. 回包 `{"ok": true, "skipped": [...], "saved": [...]}`；`__replace` 是控制指令，
     **不写入存储**。
  4. 落盘前把旧文件复制为 `anima_meta.json.bak`。
  5. 原子写（临时文件 + `os.replace`）；写失败保留原文件。

⚠️⚠️ 测试隔离（这里有两次真实事故，别再犯）：
  A. 本项目出过「测试把假数据写进真实工作树」。所以本文件把 `PLUGIN_DIR` 与**全部**
     `META*_PATH` 常量重定向到 `tmp_path`，并且**断言重定向确实生效**。
  B. **只改 `META_PATH` 是不够的** —— `META_BAK_PATH` 是**导入期固化**的常量
     （`META_BAK_PATH = META_PATH + ".bak"`）。本文件初版漏了它，于是测试跑一次就把
     测试用的假 meta 复制进了真实 `data/anima_meta.json.bak`（实测污染，已清理）。
     现在 `test_redirect_is_effective_and_real_meta_untouched` 会对**所有** `*META*_PATH`
     常量做「必须落在临时目录内」的自检，未来实现新增同类常量会立刻被抓住。
  C. 本仓库工作树与**运行目录**的真实 `anima_meta.json`（用户真实数据）在
     测试前后都做存在性 + SHA-256 快照比对，写盘动作后再比对一次。

⚠️ 桩的所有权纪律（本项目「单跑绿、全量跑红」的根因）：
   本文件**不替换** `sys.modules` 里的任何真模块，只对 `tests/conftest.py` 已有的
   `server.PromptServer.instance.routes` 做**增补**（补 delete/patch/put 装饰器），
   并在加载结束后立刻 `delattr` 还原 —— 绝不整体换掉那个模块对象。
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PKG = "tkmeta_persistence_test"

BAK_NAME = "anima_meta.json.bak"

# 真实存储位置：主位置 data/anima_meta.json（旧位置是插件根，作只读兜底）
REPO_META_PATHS = (
    ROOT / "data" / "anima_meta.json",
    ROOT / "data" / BAK_NAME,
    ROOT / "anima_meta.json",
    ROOT / "anima_meta.json.bak",
)

# 用户真实数据所在（实际运行的那份插件副本）—— 只读守卫目标。
# ⚠️ 绝不写死本机绝对路径（离线层禁止，见 tests/test_offline_portability.py）：
#    这里从 `folder_paths.base_path`（真实 ComfyUI 运行时才有正确值）或环境变量
#    `TK_RUNTIME_PLUGIN_DIR` 推导。两者都拿不到就没有额外守卫目标 —— 本测试也**绝不写入**那里，
#    只在它存在时对 SHA-256 做前后比对。
def _runtime_meta_paths() -> tuple:
    """运行目录里真实存储的候选路径（推导式；拿不到就是空元组）。"""
    candidates = []

    def _add(plugin_dir) -> None:
        if not plugin_dir:
            return
        candidates.append(Path(plugin_dir) / "anima_meta.json")
        candidates.append(Path(plugin_dir) / "data" / "anima_meta.json")

    try:
        import folder_paths
        base = getattr(folder_paths, "base_path", None)
        if base:
            _add(Path(base) / "custom_nodes" / ROOT.name)
    except Exception:  # noqa: BLE001 — 拿不到就不守卫，绝不因此让测试红
        pass

    _add(os.environ.get("TK_RUNTIME_PLUGIN_DIR", "").strip())
    return tuple(dict.fromkeys(candidates))


def _real_guard_dirs() -> tuple:
    """可能出现测试产物的真实目录（残留 .tmp / 轮换备份都要在这里抓）。"""
    dirs = [ROOT / "data", ROOT]
    dirs += [p.parent for p in _runtime_meta_paths()]
    return tuple(dict.fromkeys(dirs))

# `__init__.py` 直接 import 的插件模块：优先加载真模块，第三方依赖缺失时才用最小 stub 兜底
# （与 tests/test_update_archive.py 同一策略；那份列表是拆分后验证过的）
PLUGIN_SUBMODULES = (
    "anima_batch_lora", "anima_trigger_words", "anima_camera_control", "anima_prompt_batch",
    "anima_text_join", "anima_string_router", "anima_danbooru_tag_getter", "anima_prompt_saver",
    "anima_lighting_prompt", "anima_preset_latent", "anima_latent_switch", "anima_danbooru_gallery",
    "anima_image_select", "anima_prompt_cards", "anima_clothing_draw", "anima_3d_body_camera",
    "anima_anima_formatter", "anima_prompt_expander", "anima_local_llm", "anima_prompt_library",
)

_ROUTE_VERBS = ("get", "post", "delete", "patch", "put")


# ── 真实文件守卫（存在性 + 内容 hash） ───────────────────────────────────────────

def _fingerprint(path: Path):
    """返回 (是否存在, SHA-256)；不存在 → (False, None)。"""
    if not path.is_file():
        return (False, None)
    return (True, hashlib.sha256(path.read_bytes()).hexdigest())


def _snapshot_real() -> dict:
    paths = tuple(REPO_META_PATHS) + _runtime_meta_paths()
    return {str(p): _fingerprint(p) for p in paths}


def _assert_real_untouched(before: dict, *, context: str = "") -> None:
    tag = f"（{context}）" if context else ""
    for raw, (existed, digest) in before.items():
        path = Path(raw)
        now_exists, now_digest = _fingerprint(path)
        if not existed:
            assert not now_exists, (
                f"{tag}测试在真实位置造出了文件 {path} —— "
                "说明 META_PATH / PLUGIN_DIR 的重定向没有真正生效")
        else:
            assert now_exists, f"{tag}测试把真实用户数据删了：{path}"
            assert now_digest == digest, (
                f"{tag}测试改动了真实用户数据：{path}"
                f"（SHA-256 {digest[:12]}… → {now_digest[:12]}…）")

    # 临时文件与轮换备份都不许落在真实存储目录里
    for directory in _real_guard_dirs():
        if not directory.is_dir():
            continue
        for pattern in (".anima_meta_*.tmp", "anima_meta.json.bak.*"):
            leftovers = sorted(p.name for p in directory.glob(pattern))
            assert not leftovers, f"{tag}真实目录 {directory} 残留测试产物：{leftovers}"


# ── 插件加载（合成包；不替换任何真模块） ──────────────────────────────────────────

def _ensure_routes() -> list:
    """给现有的 routes 对象补上 `__init__.py` 需要的路由装饰器，返回本次新增项。

    `__init__.py` 注册了 DELETE 路由，而 tests/conftest.py 的 stub 只有 get/post。
    ⚠️ 只增补、不整体替换 `sys.modules['server']` —— 换掉真模块会顺带丢掉它的其它公开
    属性，那正是本项目「单测绿、全量红」的经典根因。
    """
    server = sys.modules.get("server")
    instance = getattr(getattr(server, "PromptServer", None), "instance", None)
    routes = getattr(instance, "routes", None)
    assert routes is not None, "缺少 server.PromptServer.instance.routes —— conftest 未生效？"
    added = []
    for verb in _ROUTE_VERBS:
        if not hasattr(routes, verb):
            setattr(routes, verb, (lambda *_a, **_k: (lambda fn: fn)))
            added.append((routes, verb))
    return added


def _load_plugin_package():
    """把仓库根作为包加载，返回 `__init__.py` 模块对象。"""
    added = _ensure_routes()
    try:
        pkg = types.ModuleType(PKG)
        pkg.__path__ = [str(ROOT)]
        pkg.__package__ = PKG
        sys.modules[PKG] = pkg

        for name in PLUGIN_SUBMODULES:
            full = f"{PKG}.{name}"
            if full in sys.modules:
                continue
            try:
                spec = importlib.util.spec_from_file_location(full, ROOT / f"{name}.py")
                sub = importlib.util.module_from_spec(spec)
                sys.modules[full] = sub
                spec.loader.exec_module(sub)
            except BaseException:
                # 该模块的第三方依赖在测试环境缺失 → 用最小 stub 顶替（够 __init__ 继续导入）
                sys.modules.pop(full, None)
                stub = types.ModuleType(full)
                stub.NODE_CLASS_MAPPINGS = {}
                stub.NODE_DISPLAY_NAME_MAPPINGS = {}
                if name == "anima_batch_lora":
                    stub.BRIDGE_DATA = {}
                    stub.BRIDGE_LOCK = types.SimpleNamespace()
                    stub.BRIDGE_PATH = ""
                    stub._find_lora_path = lambda _name: None
                sys.modules[full] = stub

        spec = importlib.util.spec_from_file_location(
            PKG, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[PKG] = module
        spec.loader.exec_module(module)
        return module
    finally:
        for routes, verb in added:
            try:
                delattr(routes, verb)
            except AttributeError:
                pass


_CACHED_MODULE = None


@pytest.fixture(scope="session")
def plugin_module():
    """整份 `__init__.py`。只加载一次（加载 20 个子模块，代价不低）。"""
    global _CACHED_MODULE
    if _CACHED_MODULE is None:
        _CACHED_MODULE = _load_plugin_package()
    return _CACHED_MODULE


def _meta_path_constants(module) -> dict:
    """模块上所有形如 `*META*_PATH` 的字符串常量（当前有 META_PATH / META_BAK_PATH /
    META_LEGACY_PATH）。测试必须把它们**全部**重定向 —— 漏一个就会写到真实目录。"""
    found = {}
    for name, value in vars(module).items():
        upper = name.upper()
        if isinstance(value, str) and "META" in upper and upper.endswith("_PATH"):
            found[name] = value
    return found


@pytest.fixture()
def meta_env(plugin_module, tmp_path, monkeypatch):
    """把 PLUGIN_DIR 与**所有** META*_PATH 重定向到 tmp_path，并守卫真实文件。

    ⚠️ 一个都不能漏：`META_BAK_PATH` 是 `META_PATH + ".bak"` 这种**导入期固化**的常量，
    只改 META_PATH 会让备份照旧落进真实 `data/`（实测污染过仓库，见模块 docstring B 条）。
    `monkeypatch.setattr` 负责在 teardown 还原模块属性。
    """
    guard = _snapshot_real()
    real_dir = Path(plugin_module.PLUGIN_DIR).resolve()

    data_dir = tmp_path / "data"
    meta = data_dir / "anima_meta.json"
    bak = data_dir / BAK_NAME
    legacy = tmp_path / "anima_meta.json"

    monkeypatch.setattr(plugin_module, "PLUGIN_DIR", str(tmp_path), raising=True)
    monkeypatch.setattr(plugin_module, "META_PATH", str(meta), raising=True)
    monkeypatch.setattr(plugin_module, "META_BAK_PATH", str(bak), raising=True)
    monkeypatch.setattr(plugin_module, "META_LEGACY_PATH", str(legacy), raising=True)

    # 「重定向确实生效」—— 不生效就立刻失败，绝不让它去写真实插件目录
    assert Path(plugin_module.PLUGIN_DIR).resolve() == tmp_path.resolve(), "PLUGIN_DIR 未指向临时目录"
    for name, value in _meta_path_constants(plugin_module).items():
        resolved = Path(value).resolve()
        assert str(resolved).startswith(str(tmp_path.resolve())), (
            f"{name}={value!r} 没有落在临时目录内 —— 它可能指向真实存储，"
            "继续跑会污染真实用户数据")
    assert meta.resolve() != (ROOT / "data" / "anima_meta.json").resolve()
    assert tmp_path.resolve() != real_dir, "临时目录与真实插件目录重合"

    env = types.SimpleNamespace(
        module=plugin_module, meta=meta, bak=bak, tmp=tmp_path, data_dir=data_dir)
    yield env
    _assert_real_untouched(guard, context="fixture teardown")


# ── 端点调用辅助 ────────────────────────────────────────────────────────────────

class _FakeRequest:
    """够 `set_meta` 用的最小 aiohttp Request 替身（只要 async json()）。"""

    def __init__(self, payload):
        self._payload = payload
        self._text = json.dumps(payload, ensure_ascii=False)

    async def json(self):
        return self._payload

    async def text(self):
        return self._text

    async def post(self):
        return {}


def _post_meta(module, payload):
    """直接调用 POST /anima/meta 端点协程，返回 (status, 回包 dict)。"""
    response = asyncio.run(module.set_meta(_FakeRequest(payload)))
    body = getattr(response, "body", None)
    assert body is not None, "端点没有返回带 body 的 aiohttp Response"
    return response.status, json.loads(body.decode("utf-8"))


def _post_ok(module, payload):
    status, data = _post_meta(module, payload)
    assert status == 200 and data.get("ok") is True, (
        f"POST /anima/meta 未成功：status={status} body={data}")
    return data


def _read_disk(meta: Path) -> dict:
    assert meta.is_file(), (
        f"存储文件不存在：{meta}（目录内容={sorted(p.name for p in meta.parent.iterdir())}）")
    return json.loads(meta.read_text(encoding="utf-8"))


def _clone(value):
    """深拷贝（测试里要保存「写入前」的期望值，避免被实现原地修改）。"""
    return json.loads(json.dumps(value, ensure_ascii=False))


SEED_GROUPS = [{"id": "g1", "name": "主组", "loras": ["sigrika_v1"]}]
SEED_META = {
    "categories": ["角色"],
    "loraMeta": {"sigrika_v1": {"categories": ["角色"], "favorite": True}},
    "loraGroups": SEED_GROUPS,
}


def _seed(module, data=None) -> None:
    module._save_meta(_clone(SEED_META if data is None else data))


# ── 1. 空数组不覆盖非空 ─────────────────────────────────────────────────────────

def test_empty_array_does_not_wipe_existing_groups(meta_env):
    """前端拉取失败后拿 `{"loraGroups": []}` 去 POST：旧组必须原样活着，且键名进 skipped。"""
    module = meta_env.module
    _seed(module)

    reply = _post_ok(module, {"loraGroups": []})

    assert "loraGroups" in reply.get("skipped", []), (
        f"空数组覆盖了非空 loraGroups —— 回包应把它列进 skipped；实际回包={reply}")
    assert _read_disk(meta_env.meta)["loraGroups"] == SEED_GROUPS, (
        "磁盘上的 LoRA 组被空数组清掉了（这正是事故本身）")
    assert isinstance(reply.get("saved"), list), f"回包缺少 saved 列表：{reply}"


def test_empty_object_and_empty_string_are_also_guarded(meta_env):
    """空 dict / 空字符串 / None 同样受护栏保护（契约里的「空值」不是只有空数组）。"""
    module = meta_env.module
    _seed(module)

    reply = _post_ok(module, {"loraMeta": {}, "loraGroups": None})
    skipped = reply.get("skipped", [])
    assert "loraMeta" in skipped, f"空对象覆盖了非空 loraMeta；回包={reply}"
    assert "loraGroups" in skipped, f"None 覆盖了非空 loraGroups；回包={reply}"

    disk = _read_disk(meta_env.meta)
    assert disk["loraMeta"] == SEED_META["loraMeta"]
    assert disk["loraGroups"] == SEED_GROUPS


def test_wildly_empty_body_changes_nothing(meta_env):
    """`{}`（前端彻底拿不到数据时的最极端形态）不得改动任何已有数据。"""
    module = meta_env.module
    _seed(module)
    before = meta_env.meta.read_bytes()

    reply = _post_ok(module, {})

    assert reply.get("skipped") == [], f"body 没有任何键，不该有 skipped：{reply}"
    assert meta_env.meta.read_bytes() == before, "空 body 竟然改动了存储内容"


# ── 2. __replace 显式声明时允许清空 ─────────────────────────────────────────────

def test_replace_directive_allows_clearing(meta_env):
    """`__replace` 是护栏的显式逃生门：声明后允许把该键清空。"""
    module = meta_env.module
    _seed(module)

    reply = _post_ok(module, {"loraGroups": [], "__replace": ["loraGroups"]})

    assert "loraGroups" not in reply.get("skipped", []), (
        f"__replace 已显式声明，不该再被护栏跳过；回包={reply}")
    assert _read_disk(meta_env.meta)["loraGroups"] == [], "显式 __replace 未能清空 loraGroups"


def test_replace_on_one_key_does_not_weaken_other_keys(meta_env):
    """`__replace` 只对点名的键生效，别的空键仍要被护栏拦住。"""
    module = meta_env.module
    _seed(module)

    reply = _post_ok(module, {"loraGroups": [], "loraMeta": {}, "__replace": ["loraGroups"]})

    assert "loraGroups" not in reply.get("skipped", []), f"回包={reply}"
    assert "loraMeta" in reply.get("skipped", []), f"未点名的空键仍应被护栏跳过；回包={reply}"
    disk = _read_disk(meta_env.meta)
    assert disk["loraGroups"] == []
    assert disk["loraMeta"] == SEED_META["loraMeta"], "未点名的键不该被连带清空"


# ── 3. body 未提及的顶层键被完整保留 ─────────────────────────────────────────────

def test_unmentioned_top_level_keys_are_preserved(meta_env):
    """键级合并 = {**current, **incoming}：body 没提的顶层键（包括后端自有键）原样保留。"""
    module = meta_env.module
    stored = _clone(SEED_META)
    # 后端自有 / 未来新增的顶层键：键级合并必须让它活下来（整体覆盖式实现会把它丢掉）
    stored["customKey"] = {"keep": "me"}
    _seed(module, stored)

    _post_ok(module, {"categories": ["角色", "风格"]})

    disk = _read_disk(meta_env.meta)
    assert disk["categories"] == ["角色", "风格"]
    assert disk["loraGroups"] == SEED_GROUPS, "body 未提及 loraGroups，它必须完整保留"
    assert disk["loraMeta"] == SEED_META["loraMeta"], "body 未提及 loraMeta，它必须完整保留"
    assert disk.get("customKey") == {"keep": "me"}, (
        f"body 未提及的顶层键 customKey 丢了（说明不是键级合并而是整体覆盖）；实际键={sorted(disk)}")


# ── 3b. 真实数据形状：一个都不能少 ───────────────────────────────────────────────

def _realistic_dataset(groups: int = 34, categories: int = 12, loras: int = 195) -> dict:
    """按运行目录用户数据的**形状**自造数据（34 组 / 12 分类 / 195 条 loraMeta）。

    ⚠️ 数据全部在这里现造，绝不读取、也绝不写入真实 `anima_meta.json`。
    """
    cats = [f"分类{i:02d}" for i in range(categories)]
    lora_meta = {}
    for i in range(loras):
        lora_meta[f"lora_{i:03d}"] = {
            "categories": [cats[i % categories]],
            "favorite": i % 3 == 0,
            "count": i,
        }
    names = sorted(lora_meta)
    lora_groups = [
        {
            "id": f"group_{g:02d}",
            "name": f"组{g:02d}",
            "loras": names[g::groups][:6],
        }
        for g in range(groups)
    ]
    return {"categories": cats, "loraMeta": lora_meta, "loraGroups": lora_groups}


def test_realistic_dataset_survives_empty_overwrite(meta_env):
    """整份真实规模的数据，被前端那份「空数组」POST 打过来时必须一条不少。"""
    module = meta_env.module
    dataset = _realistic_dataset()
    assert len(dataset["loraGroups"]) == 34
    assert len(dataset["categories"]) == 12
    assert len(dataset["loraMeta"]) == 195
    _seed(module, dataset)
    before = meta_env.meta.read_bytes()
    before_digest = hashlib.sha256(before).hexdigest()

    reply = _post_ok(module, {"loraGroups": [], "categories": [], "loraMeta": {}})

    disk = _read_disk(meta_env.meta)
    assert len(disk["loraGroups"]) == 34, f"LoRA 组少了：{len(disk['loraGroups'])}/34"
    assert len(disk["categories"]) == 12, f"分类少了：{len(disk['categories'])}/12"
    assert len(disk["loraMeta"]) == 195, f"loraMeta 少了：{len(disk['loraMeta'])}/195"
    assert disk["loraGroups"] == dataset["loraGroups"]
    assert disk["loraMeta"] == dataset["loraMeta"]
    assert sorted(reply.get("skipped", [])) == ["categories", "loraGroups", "loraMeta"], (
        f"三个被空值冲击的键都该进 skipped；回包={reply}")
    assert hashlib.sha256(meta_env.meta.read_bytes()).hexdigest() == before_digest, (
        "数据一条不少，但落盘内容与写入前不是逐字节相同（被无谓重排/改写）")


# ── 4. .bak 备份 == 写入前的旧内容 ──────────────────────────────────────────────

def test_backup_holds_pre_write_content(meta_env):
    """落盘前把旧文件复制为 anima_meta.json.bak，内容必须是**写入前**那一份。"""
    module = meta_env.module
    first = {"categories": ["角色"], "loraMeta": {}, "loraGroups": SEED_GROUPS}
    module._save_meta(first)
    before = meta_env.meta.read_bytes()

    second = {"categories": ["角色", "风格"], "loraMeta": {}, "loraGroups": SEED_GROUPS}
    module._save_meta(second)

    assert meta_env.bak.is_file(), (
        f"落盘前未产生 {BAK_NAME}；目录内容={sorted(p.name for p in meta_env.data_dir.iterdir())}")
    assert meta_env.bak.read_bytes() == before, "备份内容不是写入前的旧内容"
    assert _read_disk(meta_env.meta) == second


def test_backup_is_refreshed_by_endpoint_writes(meta_env):
    """走端点写入时同样要轮换备份（备份不能只挂在底层 _save_meta 的某一条路径上）。"""
    module = meta_env.module
    _seed(module)
    before = meta_env.meta.read_bytes()

    _post_ok(module, {"categories": ["角色", "风格"]})

    assert meta_env.bak.is_file(), f"端点写入未产生 {BAK_NAME}"
    assert meta_env.bak.read_bytes() == before
    # 备份必须落在**被重定向的**目录里，绝不能落到模块导入时的真实 data/
    assert meta_env.bak.parent.resolve() == meta_env.data_dir.resolve()


# ── 5. 原子写：os.replace 失败时原文件逐字节不变 ─────────────────────────────────

def test_failed_atomic_replace_keeps_original_file(meta_env, monkeypatch):
    """`os.replace` 抛异常时必须保留原文件（不能半写、不能留残渣）。"""
    module = meta_env.module
    _seed(module)
    before = meta_env.meta.read_bytes()

    def _boom(*_args, **_kwargs):
        raise OSError("simulated os.replace failure")

    monkeypatch.setattr(os, "replace", _boom)
    # 契约只要求「写失败保留原文件」，没有规定异常是否向上抛 —— 两种实现都接受
    try:
        module._save_meta({"categories": [], "loraMeta": {}, "loraGroups": []})
    except OSError:
        pass

    assert meta_env.meta.read_bytes() == before, (
        "os.replace 失败后原文件被改动了（半写）—— 原子写没做到")
    leftovers = sorted(p.name for p in meta_env.data_dir.glob(".anima_meta_*.tmp"))
    assert not leftovers, f"写失败路径应清理临时文件，实际残留 {leftovers}"


def test_endpoint_reports_write_failure_without_destroying_data(meta_env, monkeypatch):
    """端点层：底层写盘失败时不得回 `ok: true`，且旧数据必须完好。"""
    module = meta_env.module
    _seed(module)
    before = meta_env.meta.read_bytes()

    def _boom(*_args, **_kwargs):
        raise OSError("simulated os.replace failure")

    monkeypatch.setattr(os, "replace", _boom)
    status, data = _post_meta(module, {"categories": ["角色", "风格"]})

    assert data.get("ok") is not True, f"写盘失败却回了成功：{data}"
    assert status >= 400, f"写盘失败应回 4xx/5xx，实际 {status}"
    # ⚠️ 不要 monkeypatch.undo()：meta_env fixture 用的是同一个 monkeypatch 实例，
    #    undo 会连 META_PATH 的重定向一起撤销，后续任何写盘都会落到真实目录。
    assert meta_env.meta.read_bytes() == before, "写盘失败后旧数据被破坏"


# ── 6. __replace 不落盘 ────────────────────────────────────────────────────────

def test_replace_directive_is_not_persisted(meta_env):
    """`__replace` 是控制指令，绝不能变成存储里的一等键。"""
    module = meta_env.module
    _seed(module)

    _post_ok(module, {"loraGroups": [], "categories": ["角色"], "__replace": ["loraGroups"]})

    disk = _read_disk(meta_env.meta)
    assert "__replace" not in disk, f"__replace 被写进了存储：{sorted(disk)}"
    assert disk["loraGroups"] == []


def test_replace_directive_never_reaches_disk_even_when_unused(meta_env):
    """`__replace` 点名一个 body 里没有的键时，也不许漏进存储。"""
    module = meta_env.module
    _seed(module)

    _post_ok(module, {"__replace": ["loraGroups", "categories"]})

    disk = _read_disk(meta_env.meta)
    assert "__replace" not in disk, f"__replace 被写进了存储：{sorted(disk)}"


# ── 7. 隔离守卫：重定向真的生效，真实文件毫发无伤 ────────────────────────────────

def test_redirect_is_effective_and_real_meta_untouched(meta_env):
    """显式证明「写的是临时目录」：真实用户数据（本仓库与运行目录）前后 hash 一致。

    这条是本文件的**命门**：本项目两次真实事故都是「测试写到真实目录」。
    """
    before = _snapshot_real()
    module = meta_env.module

    # ① 所有 META*_PATH 常量都必须在临时目录内（漏一个就会写真实存储）
    constants = _meta_path_constants(module)
    assert constants, "没有找到任何 *META*_PATH 常量 —— 实现的存储路径常量被改名了？"
    for name, value in constants.items():
        assert str(Path(value).resolve()).startswith(str(meta_env.tmp.resolve())), (
            f"{name}={value!r} 不在临时目录内")
    assert Path(module.PLUGIN_DIR).resolve() == meta_env.tmp.resolve()

    # ② 真的写一次，且写到了临时目录
    _seed(module)
    assert meta_env.meta.is_file(), "重定向后的 META_PATH 应该真的写到临时目录"

    # ③ 真实文件（本仓库 + 运行目录真实用户数据）逐字节 hash 未变
    _assert_real_untouched(before, context="写盘后")

    # ④ 运行目录那份**真实用户数据**若可推导（真实部署 / TK_RUNTIME_PLUGIN_DIR），
    #    它必须确实被纳入了快照守卫 —— 本测试只读它，绝不写。CI 上推导不到即为空循环。
    runtime_files = [p for p in _runtime_meta_paths() if p.is_file()]
    for path in runtime_files:
        assert str(path) in before, f"运行目录真实数据 {path} 没有被纳入快照守卫"
        assert isinstance(json.loads(path.read_text(encoding="utf-8")), dict), (
            f"运行目录真实数据 {path} 不可解析（本测试只读它）")
