"""TK Prompt Cards ②区联想的回归测试。

覆盖三件事（都是用户实际报过的问题）：
  1. 中文角色名能查到 —— 「望」曾只出 telescope（说明字段里「望远镜」含「望」）
  2. 输出符合 Anima 写法 —— 下划线转空格 + 括号转义（nozomi \\(blue archive\\)）
  3. 查询够快 —— 中文查询不再扫描 20 万条英文说明

不需要运行中的 ComfyUI：conftest 已注入运行时占位模块。
"""
from __future__ import annotations

import os
import sys
import time
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# 与 tests/test_cards_v2.py 同样的运行时占位（conftest 也做，这里保证单跑本文件时可用）
if "folder_paths" not in sys.modules:
    _folder = types.ModuleType("folder_paths")
    _folder.__path__ = []
    _folder.get_input_directory = lambda: str(REPO_ROOT / "input")
    _folder.get_output_directory = lambda: str(REPO_ROOT / "output")
    _folder.get_temp_directory = lambda: str(REPO_ROOT / "temp")
    _folder.get_folder_paths = lambda _n: [str(REPO_ROOT)]
    _folder.get_filename_list = lambda _n: []
    sys.modules["folder_paths"] = _folder
if "server" not in sys.modules:
    _server = types.ModuleType("server")
    _server.PromptServer = types.SimpleNamespace(
        instance=types.SimpleNamespace(
            routes=types.SimpleNamespace(
                get=lambda _p: (lambda fn: fn),
                post=lambda _p: (lambda fn: fn),
                delete=lambda _p: (lambda fn: fn),
            )
        )
    )
    sys.modules["server"] = _server

_PKG = types.ModuleType("tk_cards_probe")
_PKG.__path__ = [str(REPO_ROOT)]
sys.modules.setdefault("tk_cards_probe", _PKG)


def _load_module():
    """导入 anima_prompt_cards（相对导入的兄弟模块用占位替代，避免拖进 PIL/torch）。"""
    import importlib.util

    for sub, attrs in (
        ("anima_batch_lora", {"BRIDGE_DATA": {}, "BRIDGE_LOCK": None, "_find_lora_path": lambda *a, **k: None}),
        ("anima_prompt_batch", {"_input_root": lambda: str(REPO_ROOT / "input"), "_safe_resolve": lambda *a, **k: None}),
        ("anima_prompt_parser", {"parse_prompt_groups": lambda *a, **k: []}),
    ):
        name = "%s.%s" % (_PKG.__name__, sub)
        if name in sys.modules:
            continue
        node = types.ModuleType(name)
        for attr, value in attrs.items():
            setattr(node, attr, value)
        sys.modules[name] = node

    spec = importlib.util.spec_from_file_location(
        "%s.anima_prompt_cards" % _PKG.__name__, REPO_ROOT / "anima_prompt_cards.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def apc():
    return _load_module()


@pytest.fixture(scope="module")
def search(apc):
    def _search(query, limit=8):
        return [item["tag"] for item in apc._search_autocomplete(query, limit)]

    return _search


# ── 1. 中文角色名 ────────────────────────────────────────────────────────────
# (查询, 期望出现在结果里的 tag)
CJK_CASES = [
    ("望", "nozomi (blue archive)"),
    ("橘望", "nozomi (blue archive)"),
    ("妃咲", "kisaki (blue archive)"),
    ("龙华妃咲", "kisaki (blue archive)"),
    ("日奈", "hina (blue archive)"),
    ("空崎日奈", "hina (blue archive)"),
    ("星野", "hoshino (blue archive)"),
    ("小鸟游星野", "hoshino (blue archive)"),
    ("白子", "shiroko (blue archive)"),
    ("砂狼白子", "shiroko (blue archive)"),
    ("优香", "yuuka (blue archive)"),
    ("早濑优香", "yuuka (blue archive)"),
    ("未花", "mika (blue archive)"),
    ("圣园未花", "mika (blue archive)"),
    ("雷电将军", "raiden shogun"),
    ("甘雨", "ganyu (genshin impact)"),
    ("初音未来", "hatsune miku"),
]


@pytest.mark.parametrize("query,expected", CJK_CASES)
def test_cjk_character_lookup(search, query, expected):
    tags = search(query, 8)
    assert tags, "「%s」没有任何联想结果" % query
    assert expected in tags, "「%s」未命中 %s，实际前 8 条：%s" % (query, expected, tags)


def test_series_name_lists_its_characters(search):
    """输入作品名应能带出该作品角色（AnimaDex 角色表 + 作品归属）。"""
    tags = search("碧蓝档案", 8)
    assert any("(blue archive)" in tag for tag in tags), tags


def test_chinese_query_does_not_fall_back_to_description_noise(search):
    """「望」曾被说明字段里的「望远镜」带出 telescope —— 别名命中必须压过说明命中。"""
    tags = search("望", 8)
    assert "telescope" not in tags, tags


# ── 2. Latin 回归（不能因为中文改动而退化）──────────────────────────────────
LATIN_CASES = [
    ("nozomi", "nozomi (blue archive)"),
    ("nozomi (blue archive)", "nozomi (blue archive)"),
    ("blue_archive", "blue archive"),
    ("hoshino (blue archive)", "hoshino (blue archive)"),
    ("long_hair", "long hair"),
    ("1girl", "1girl"),
]


@pytest.mark.parametrize("query,expected", LATIN_CASES)
def test_latin_lookup_regression(search, query, expected):
    tags = search(query, 8)
    assert expected in tags, "「%s」未命中 %s，实际：%s" % (query, expected, tags)


# ── 3. Anima 输出格式 ────────────────────────────────────────────────────────
def test_prompt_text_replaces_underscores(apc):
    assert apc._autocomplete_prompt_text("nozomi_(blue_archive)") == "nozomi (blue archive)"


def test_prompt_text_escapes_brackets_when_asked(apc):
    """ComfyUI 把裸括号当权重语法；转义后才是字面标签。"""
    assert apc._autocomplete_prompt_text("nozomi_(blue_archive)", True) == r"nozomi \(blue archive\)"


def test_prompt_text_escaping_is_idempotent(apc):
    once = apc._autocomplete_prompt_text("nozomi_(blue_archive)", True)
    again = apc._autocomplete_prompt_text(once, True)
    assert once == again == r"nozomi \(blue archive\)"


def test_prompt_text_keeps_plain_tags_untouched(apc):
    assert apc._autocomplete_prompt_text("long_hair", True) == "long hair"


# ── 4. 数据文件与规模 ────────────────────────────────────────────────────────
def test_alias_index_ships_and_has_expected_shape(apc):
    assert os.path.exists(apc.ALIAS_INDEX_PATH), (
        "缺少 %s —— 它是随包发布的词典，必须提交到仓库" % apc.ALIAS_INDEX_PATH
    )
    # 必须放在插件根目录（anima_* 前缀）才会被内置更新链下发；放 data/ 里老用户更新不到
    assert os.path.basename(apc.ALIAS_INDEX_PATH).startswith("anima_"), apc.ALIAS_INDEX_PATH
    index = apc._load_alias_index()
    for key in ("characters", "series", "aliases"):
        assert isinstance(index.get(key), dict) and index[key], "别名索引缺少 %s" % key
    assert len(index["characters"]) > 20000, len(index["characters"])
    assert len(index["series"]) > 1000, len(index["series"])


def test_alias_tables_are_consistent(apc):
    apc._build_autocomplete_alias_tables()
    assert apc._AUTOCOMPLETE_ZH_BY_TAG, "中文别名表为空"
    assert apc._AUTOCOMPLETE_ZH_EXACT, "中文精确匹配表为空"
    # 尾缀表是「望」→「橘望」这类中文名（名而非姓）能被命中的关键
    assert "望" in apc._AUTOCOMPLETE_ZH_SUFFIX
    assert "nozomibluearchive" in apc._AUTOCOMPLETE_ZH_SUFFIX["望"]


def test_entries_with_aliases_expose_them(apc):
    entries = {e["tag_key"]: e for e in apc._load_autocomplete_entries()}
    # _autocomplete_key 会去掉括号和空格：'nozomi (blue archive)' -> 'nozomibluearchive'
    entry = entries["nozomibluearchive"]
    assert entry["zh_all"], "nozomi (blue archive) 没有中文别名"
    assert any("望" in alias for alias in entry["zh_all"]), entry["zh_all"]


# ── 5. 性能 ──────────────────────────────────────────────────────────────────
def test_cjk_query_is_fast(apc):
    """中文查询过去要 key() 20 万条说明（数秒）。现在走别名表，必须是毫秒级。"""
    apc._build_autocomplete_alias_tables()
    apc._search_autocomplete("碧蓝档案", 8)
    query = "空崎日奈"  # 未预热过的查询，确保真的走查询路径
    started = time.perf_counter()
    apc._search_autocomplete(query, 8)
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, "中文查询耗时 %.0fms，超过 1s" % (elapsed * 1000)
