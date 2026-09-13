"""安全更新 ZIP 的隔离回归，不联网、不修改真实运行目录。

2026-09-13 改造（两个问题一起修）：
  1. 原理化逻辑写在**模块顶层**且没有 `def test_*` → pytest 收集不到，
     等于这条回归长期**根本没在跑**（静默黑洞）。现已包进 test 函数，pytest 与直跑都能跑。
  2. importlib 直接按文件路径加载包 `__init__.py`，模块内的相对导入会炸；
     现象是「stub 真模块 → 变成空 stub → 后续 import 失败 → 收集期报错」。
     现改为统一的「合成包 + 真模块优先、仅缺失时 stub」策略。
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import types
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = "tkupdate_archive_test"

# __init__ 会直接 import 的插件模块；单个模块的第三方依赖缺失时用 stub 兜底。
PLUGIN_SUBMODULES = (
    "anima_batch_lora", "anima_trigger_words", "anima_camera_control", "anima_prompt_batch",
    "anima_text_join", "anima_string_router", "anima_danbooru_tag_getter", "anima_prompt_saver",
    "anima_lighting_prompt", "anima_preset_latent", "anima_danbooru_gallery", "anima_image_select",
    "anima_prompt_cards", "anima_clothing_draw", "anima_3d_body_camera", "anima_local_llm",
    "anima_prompt_library",
)


def _ensure_route_stub() -> None:
    """补齐 server.PromptServer 的路由装饰器。

    ⚠️ 必须支持 get/post/**delete**（`__init__.py` 注册了 DELETE 路由 `/anima/bridge/update`）；
    旧版 stub 只有 get/post，于是这个测试在「能被收集」的那一刻就暴露成
    `AttributeError: '_Routes' object has no attribute 'delete'`。
    同时：**不要覆盖已存在的更完整 stub**（tests/conftest.py 里那份才是全局权威）。
    """
    existing = sys.modules.get("server")
    if existing is not None and hasattr(getattr(existing, "PromptServer", None), "instance"):
        routes = getattr(existing.PromptServer.instance, "routes", None)
        if routes is not None and hasattr(routes, "delete"):
            return

    class _Routes:
        def _decorator(self, *_a, **_k):
            return lambda fn: fn

        get = post = delete = patch = put = _decorator

    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=_Routes()))
    sys.modules["server"] = server


def _ensure_folder_paths_stub() -> None:
    """只在真的缺失时补一个最小 folder_paths（真存在时绝不覆盖）。"""
    if "folder_paths" in sys.modules:
        return
    fp = types.ModuleType("folder_paths")
    fp.__path__ = []
    fp.get_input_directory = lambda: tempfile.gettempdir()
    fp.get_output_directory = lambda: tempfile.gettempdir()
    fp.get_temp_directory = lambda: tempfile.gettempdir()
    fp.get_folder_paths = lambda _kind: [tempfile.gettempdir()]
    fp.get_filename_list = lambda _name: []
    fp.get_full_path = lambda name, f=None: os.path.join(tempfile.gettempdir(), str(f or ""))
    fp.get_full_path_or_raise = fp.get_full_path
    fp.filter_files_content_symlink = lambda items: items
    fp.folder_names_and_paths = {}
    sys.modules["folder_paths"] = fp


def _load_plugin_package():
    """把仓库根作为包加载，返回模块对象。**优先导入真模块**，缺失才 stub。"""
    _ensure_folder_paths_stub()
    _ensure_route_stub()

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
            m = importlib.util.module_from_spec(spec)
            sys.modules[full] = m
            spec.loader.exec_module(m)
        except BaseException:
            # 该模块的第三方依赖在测试环境缺失 → 用最小 stub 顶替（够 __init__ 继续导入即可）
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


def _make_archive(path: Path, *, include_required: bool = True) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        if include_required:
            archive.writestr("comfyui-anima-toolkit-main/__init__.py", "new init")
            archive.writestr("comfyui-anima-toolkit-main/VERSION", "9.9.9\n")
        archive.writestr("comfyui-anima-toolkit-main/web/js/update.js", "new js")
        archive.writestr("comfyui-anima-toolkit-main/app/index.html", "new app")
        # __init__.py 拆分后 services/ 是硬依赖，不下发就是 ImportError
        archive.writestr("comfyui-anima-toolkit-main/services/github_update.py", "new svc")
        archive.writestr("comfyui-anima-toolkit-main/data/keep-me.json", "must not stage")
        archive.writestr("comfyui-anima-toolkit-main/models/keep-me.safetensors", "must not stage")
        # 随包发布的词典：必须被下发（老用户点更新才拿得到新词典）
        archive.writestr("comfyui-anima-toolkit-main/data/danbooru_alias_index.json", '{"version":1}')


def _set_update_module_plugin_dir(module, plugin_dir: str) -> None:
    """把插件目录同步给**真正的 owner**，并把「是否真的生效」断言掉。

    背景（一次真实事故，务必保留这段防御）：
    拆分后 `__init__._apply_staged_update` 只是委托给 `services.github_update`，
    目录在那里是模块级 `_PLUGIN_DIR`。若只改 `__init__.PLUGIN_DIR`，`apply` 仍会写到
    **真实插件目录** —— 本测试曾因此把仓库根的 `__init__.py` / `VERSION` /
    `app/index.html` 一起覆盖成测试用的假内容（"new init" / "9.9.9"），
    属于**测试污染真实工作树**的严重事故。
    所以这里不仅设置，还要**验证设置生效**，不生效就立刻失败，绝不让它去写真实目录。
    """
    upd = getattr(module, "_UPDATE_MODULE", None)
    assert upd is not None, "未找到 _UPDATE_MODULE（拆分后 __init__ 应暴露它）"
    upd.configure(plugin_dir=plugin_dir)
    effective = getattr(upd, "_PLUGIN_DIR", None)
    assert effective is not None and os.path.abspath(str(effective)) == os.path.abspath(plugin_dir), (
        f"未能把更新模块的插件目录切到临时目录（当前 {effective!r}）—— "
        "继续跑会把测试内容写进真实插件目录，因此直接失败")


# 真实工作树里**绝不允许被本测试改动的文件**。`_apply_staged_update` 的目标目录一旦
# 没被成功重定向，它就会去覆盖这些文件 —— 事故就是这样发生的。每次跑前后各校验一次。
GUARDED_FILES = ("__init__.py", "VERSION", "app/index.html")


def _snapshot_guarded_files() -> dict[str, bytes]:
    out = {}
    for rel in GUARDED_FILES:
        p = ROOT / rel
        if p.is_file():
            out[rel] = p.read_bytes()
    return out


def _assert_guarded_files_unchanged(before: dict[str, bytes]) -> None:
    for rel, original in before.items():
        p = ROOT / rel
        assert p.is_file(), f"测试把真实文件删了：{rel}"
        now = p.read_bytes()
        assert now == original, (
            f"测试污染了真实工作树文件：{rel}（大小 {len(original)} → {len(now)}）。"
            "说明 _apply_staged_update 的目标目录没有被成功重定向到临时目录。")


def test_release_path_whitelist_covers_everything_the_plugin_needs_at_runtime():
    """内置更新链必须能下发「跑起来需要的一切」，同时绝不下发用户数据。

    这一条是 2026-09-13 两个真实缺陷的护栏：
      · `services/` 曾被排除 —— 但 `__init__.py` 拆分后硬依赖它，老用户点更新会 ImportError；
      · `data/` 曾被整目录排除 —— 于是新词典永远下发不到，功能静默失效。
    """
    module = _load_plugin_package()
    upd = module._UPDATE_MODULE

    # 运行时必需：必须下发
    for path in (
        "__init__.py", "VERSION", "README.md", "CHANGELOG.md", "LICENSE",
        "anima_prompt_cards.py",
        "anima_alias_index.json",          # 中文别名词典（必须放根目录才下发得动）
        "services/__init__.py",
        "services/github_update.py",
        "web/js/anima_prompt_cards_widget.js",
        "app/index.html",
        "data/danbooru_tags_with_description_v3_modified.csv",
        "data/danbooru_tags_zh.json",
    ):
        assert upd.is_release_path(path), f"更新链不下发 {path} —— 老用户会拿不到它"

    # 用户状态 / 体积无关物：必须挡住
    for path in (
        "data/prompt_library.json", "data/batches/bworker.json", "data/danbooru_account.json",
        "data/update_state.json", "data/translation_cache.sqlite3",
        "models/anything.safetensors",
        "panel/src/main.ts", "tests/test_cards_v2.py", "tools/bump_version.py", ".git/config",
    ):
        assert not upd.is_release_path(path), f"更新链不该下发 {path}"


def test_update_archive_stages_only_release_paths_and_keeps_user_data():
    """更新 ZIP 只覆盖发布文件；data/ 里仅白名单词典下发，其余用户数据与 models/ 原样保留；
    缺必要文件要拒绝。"""
    guard = _snapshot_guarded_files()
    module = _load_plugin_package()
    original_plugin_dir = module.PLUGIN_DIR
    try:
        with tempfile.TemporaryDirectory(prefix="tk-update-archive-") as temp:
            temp_path = Path(temp)
            archive_path = temp_path / "update.zip"
            stage_path = temp_path / "stage"
            _make_archive(archive_path)

            staged = module._stage_update_archive(str(archive_path), str(stage_path))
            # ⚠️ 内部用 os.sep 拼相对路径（Windows 上是 `\`），所以比较前必须归一化。
            #    原测试直接拿 '__init__.py' 比 → 该断言在 Windows 上永远是 False（假红隐患）。
            staged_rel = {Path(relative).as_posix() for relative, _ in staged}
            staged_names = {relative.replace(os.sep, "/") for relative, _ in staged}
            assert {"__init__.py", "VERSION", "web/js/update.js", "app/index.html"} <= staged_names, staged_names
            # services/ 必须下发（拆分后 __init__ 硬依赖它）
            assert "services/github_update.py" in staged_names, staged_names
            # data/ 里只有**白名单词典**能进更新包；其余用户状态与 models/ 一律不碰
            assert "data/danbooru_alias_index.json" in staged_names, staged_names
            assert "data/keep-me.json" not in staged_names, staged_names
            assert not any(n.startswith("models/") for n in staged_names), staged_names
            assert "__init__.py" in staged_rel and "VERSION" in staged_rel, staged_rel

            # 应用阶段：用户数据必须活下来
            plugin_path = temp_path / "plugin"
            (plugin_path / "data").mkdir(parents=True)
            (plugin_path / "data/keep-me.json").write_text(json.dumps({"keep": True}), encoding="utf-8")
            (plugin_path / "__init__.py").write_text("old init", encoding="utf-8")
            # ⚠️ PLUGIN_DIR 的**真正 owner 是 services/github_update.py**（拆分后 __init__ 只做委托），
            #    只改 __init__ 上的名字不会生效。两处都改，保证等价。
            module.PLUGIN_DIR = str(plugin_path)
            _set_update_module_plugin_dir(module, str(plugin_path))

            assert module._apply_staged_update(staged) == len(staged)
            assert (plugin_path / "__init__.py").read_text(encoding="utf-8") == "new init"
            assert (plugin_path / "web/js/update.js").read_text(encoding="utf-8") == "new js"
            assert json.loads((plugin_path / "data/keep-me.json").read_text(encoding="utf-8"))["keep"] is True
            assert (plugin_path / "data/danbooru_alias_index.json").read_text(encoding="utf-8") == '{"version":1}'

            # 结构无效的包必须被拒（而不是把插件覆盖坏）
            invalid_archive = temp_path / "invalid.zip"
            _make_archive(invalid_archive, include_required=False)
            try:
                module._stage_update_archive(str(invalid_archive), str(temp_path / "invalid-stage"))
            except RuntimeError as error:
                assert "更新包结构无效" in str(error), error
            else:
                raise AssertionError("缺少必要文件的更新包未被拒绝")
    finally:
        # 还原模块级可变状态，避免污染同进程内的其他测试
        module.PLUGIN_DIR = original_plugin_dir
        _set_update_module_plugin_dir(module, original_plugin_dir)
        # 最后一道：确认真实工作树没被动过
        _assert_guarded_files_unchanged(guard)


if __name__ == "__main__":
    test_update_archive_stages_only_release_paths_and_keeps_user_data()
    print("PASS 更新 ZIP 只覆盖发布文件并保留 data/models")
    print("PASS 更新 ZIP 缺少必要文件时拒绝")
