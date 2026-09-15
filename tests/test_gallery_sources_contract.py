"""多源画廊（协议层 + C站图源）的**契约锁**：PLAN §5 钉死的形状一旦漂移就在这里红。

覆盖四件事（对应验收 1）：
  1. 统一 item schema 归一化：缺字段补 `null` / `[]`、**绝不省略 key**，键序与常量一致；
  2. C站 search 的 cursor **透传**（透传 `metadata.nextCursor`，不自造页码）+ `withMeta=true` 必带；
  3. 密钥掩码只回 `前4…后4`，任何回包/URL 里都不出现完整 key；
  4. 图源注册表容错：对方适配器**缺失或导入即炸**时，加载不崩、其它图源照常可用。

本文件必须留在 tests/ 顶层（CI 离线层）：全程 monkeypatch 网络入口，不碰真实 C站。
"""
from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
from pathlib import Path

import aiohttp.web
import pytest

ROOT = Path(__file__).resolve().parents[1]

import anima_gallery_sources as sources  # noqa: E402
import anima_gallery_civitai as civitai  # noqa: E402

# 节点下载路径（D站 侧）：本文件只读它，用来验证「新图源的图能被下载路径认出来」
danbooru_gallery = importlib.import_module("anima_danbooru_gallery")


def _real_json_response(payload=None, status=200, **kwargs):
    """`aiohttp.web.json_response` 的自足实现（只用于顶掉被别的测试改坏的版本）。"""
    body = json.dumps({} if payload is None else payload, ensure_ascii=False).encode("utf-8")
    return aiohttp.web.Response(body=body, status=status, content_type="application/json")


@pytest.fixture(autouse=True)
def _guard_aiohttp_json_response(monkeypatch):
    """防止**别的测试文件**把 `aiohttp.web.json_response` 换成返回 dict 的桩后不还原。

    实测污染源：`tests/test_batch_lora_trigger_words.py` 的 `web.json_response = fake_json_response`
    （直接改真实 aiohttp.web 模块属性，且从不还原）→ 同 session 里后面所有用 json_response 的测试
    都会拿到 dict（表现为 `'dict' object has no attribute 'body'`，「单独跑绿、整套跑红」）。
    本夹具只在自己的用例期间确保它是可用的实现，跑完由 monkeypatch 还原 —— 不改别人的文件，
    但保证本文件的结论不被别人的污染左右。
    """
    probe = aiohttp.web.json_response({"probe": True})
    if not hasattr(probe, "body") or not hasattr(probe, "status"):
        monkeypatch.setattr(aiohttp.web, "json_response", _real_json_response)
    yield


# ---------- 测试替身 ----------
class FakeQuery(dict):
    """aiohttp 的 request.query 只用到 .get(key, default)。"""

    def get(self, key, default=None):  # noqa: D102
        return dict.get(self, key, default)


class FakeRequest:
    """最小请求替身：handler 只用到 query / json()。"""

    def __init__(self, body=None, **params):
        self.query = FakeQuery({key: str(value) for key, value in params.items()})
        self._body = body

    async def json(self):
        return self._body


class FakeResponse:
    """requests.Response 的最小替身（只用到 raise_for_status / json / headers）。"""

    def __init__(self, payload, status=200, headers=None):
        self._payload = payload
        self.status_code = status
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests

            error = requests.HTTPError(f"HTTP {self.status_code}")
            error.response = self
            raise error

    def json(self):
        return self._payload


def run(coro):
    return asyncio.run(coro)


def body_of(response) -> str:
    return response.body.decode("utf-8") if isinstance(response.body, (bytes, bytearray)) else str(response.text)


@pytest.fixture
def isolated_key_store(tmp_path, monkeypatch):
    """把 C站密钥文件指到 tmp_path，并清掉进程内缓存 + 环境变量（测试绝不碰用户真实 key）。"""
    path = tmp_path / "civitai_key.json"
    monkeypatch.setattr(sources, "civitai_key_path", lambda: path)
    monkeypatch.delenv(sources.CIVITAI_KEY_ENV, raising=False)
    sources._key_cache.update({"stamp": None, "value": ""})
    yield path
    sources._key_cache.update({"stamp": None, "value": ""})


# ---------- 1. 统一 item schema ----------
def test_normalize_item_keeps_every_schema_key_when_missing():
    """空条目也必须补齐 13 个 key：缺的补 null，列表补 []，meta 补 {}。"""
    item = sources.normalize_item({}, "civitai")

    assert list(item) == list(sources.ITEM_KEYS), "键序必须与契约常量一致"
    assert len(sources.ITEM_KEYS) == 13
    for key in ("id", "preview_url", "full_url", "width", "height", "prompt",
                "negative_prompt", "rating", "score", "source_url"):
        assert key in item and item[key] is None, f"{key} 缺失时应为 null 而不是省略 key"
    assert item["tags"] == []
    assert item["meta"] == {}
    assert item["source"] == "civitai"
    # 未知字段一律丢弃（前端按 key 判断能力，脏 key 只会误导）
    assert "file_ext" not in sources.normalize_item({"file_ext": "mp4"}, "civitai")


def test_normalize_item_coerces_types_and_aliases():
    """各源字段名不同：别名要认，数字要收敛成 int，非法值要变 None 而不是抛异常。"""
    item = sources.normalize_item(
        {"imageId": 12345, "nsfwLevel": "Mature", "image_width": "832", "tag_list": ["a", "b", "a"]},
        "civitai",
    )
    assert item["id"] == "12345"                      # id 统一成字符串（前端当 key 用）
    assert item["rating"] == "Mature"                 # nsfwLevel → rating
    assert item["width"] == 832                       # 字符串数字 → int
    assert item["tags"] == ["a", "b"]                 # 去重
    assert sources.normalize_item({"width": "abc"}, "civitai")["width"] is None
    assert sources.normalize_item({"preview_url": "javascript:alert(1)"}, "civitai")["preview_url"] is None
    assert sources.normalize_item(None, "")["source"] == ""


def test_civitai_item_mapping_pulls_prompt_and_meta():
    """C站条目映射：meta.prompt → prompt，采样参数 → meta（PLAN §3 阶段 1 的硬要求）。"""
    raw = {
        "id": 9173928,
        "url": "https://image.civitai.com/abc/original=true/pic.jpeg",
        "width": 832,
        "height": 1216,
        "nsfwLevel": "Soft",
        "username": "Ajuro",
        "baseModel": "SDXL 1.0",
        "postId": 1981754,
        "modelVersionIds": [9208],
        "stats": {"likeCount": 22805, "heartCount": 8489, "laughCount": 2901, "cryCount": 1855, "commentCount": 6},
        "meta": {
            "prompt": "masterpiece, 1girl", "negativePrompt": "worst quality",
            "sampler": "DPM++ 2M", "steps": 45, "cfgScale": 5, "seed": 1938345220,
            "clipSkip": 2, "Size": "832x1216", "Model": "someModel",
        },
    }
    item = civitai._civitai_to_item(raw)

    assert list(item) == list(sources.ITEM_KEYS)
    assert item["source"] == "civitai"
    assert item["id"] == "9173928"
    assert item["prompt"] == "masterpiece, 1girl"
    assert item["negative_prompt"] == "worst quality"
    assert item["rating"] == "Soft"                       # rating 直接用回包 nsfwLevel
    assert item["tags"] == []                             # C站没有标签体系
    assert item["width"] == 832 and item["height"] == 1216
    assert item["score"] == 22805 + 8489 + 2901 + 1855    # 总反应数（C站没有单一 score）
    assert item["source_url"] == "https://civitai.com/images/9173928"
    assert item["preview_url"].endswith("/width=450/pic.jpeg")
    assert item["full_url"].endswith("/original=true/pic.jpeg")
    meta = item["meta"]
    assert (meta["sampler"], meta["steps"], meta["cfgScale"], meta["seed"]) == ("DPM++ 2M", 45, 5, 1938345220)
    assert meta["model"] == "someModel" and meta["username"] == "Ajuro"


def test_civitai_item_mapping_tolerates_empty_meta():
    """没带 meta 的条目（未生成图/视频）不能让映射炸，prompt 为 null、其余字段照常。"""
    item = civitai._civitai_to_item({"id": 1, "url": "https://image.civitai.com/a/original=true/a.mp4",
                                     "meta": None, "stats": None, "width": 512})
    assert item["prompt"] is None and item["negative_prompt"] is None
    assert item["score"] is None and item["height"] is None
    assert item["meta"]["stats"] == {}


# ---------- 2. cursor 透传 + 上游参数 ----------
def test_search_params_pass_cursor_and_always_request_meta():
    """上游参数：cursor 原样透传、必带 withMeta=true（不带就永远拿不到 prompt）、不放页码。"""
    params = civitai.build_search_params(cursor="5|1719470081918", limit=9999, nsfw="x", sort="most_reactions")

    assert params["cursor"] == "5|1719470081918"
    assert params["withMeta"] == "true"
    assert "page" not in params, "分页只能靠 cursor，不许自造页码"
    assert params["limit"] == civitai.MAX_LIMIT          # 越界夹取（实测上限 200）
    assert params["nsfw"] == "X" and params["sort"] == "Most Reactions"
    assert civitai.build_search_params()["limit"] == civitai.DEFAULT_LIMIT
    assert "cursor" not in civitai.build_search_params(cursor="   ")

    with pytest.raises(ValueError):
        civitai.build_search_params(sort="Relevance")     # 实测 Relevance 是 400
    with pytest.raises(ValueError):
        civitai.build_search_params(nsfw="bogus")
    with pytest.raises(ValueError):
        civitai.build_search_params(period="Forever")


def test_search_route_returns_next_cursor_untouched(monkeypatch):
    """路由级锁：`next_cursor` 必须来自回包 `metadata.nextCursor`，且回包形状符合契约。"""
    captured: dict = {}

    def fake_page(params):
        captured.update(params)
        return {
            "items": [{"id": 42, "url": "https://image.civitai.com/x/original=true/x.jpeg", "width": 10,
                       "height": 20, "nsfwLevel": "Soft", "stats": {"likeCount": 3},
                       "meta": {"prompt": "hello", "steps": 20}}],
            "metadata": {"nextCursor": "9|1700000000000",
                         "nextPage": "https://civitai.com/api/v1/images?cursor=9%7C1700000000000"},
        }

    monkeypatch.setattr(civitai, "_civitai_images_page", fake_page)
    response = run(civitai.anima_gallery_civitai_search(
        FakeRequest(query="", cursor="8|1600000000000", limit="1", nsfw="X", sort="Newest")))
    payload = json.loads(body_of(response))

    assert response.status == 200
    assert captured["cursor"] == "8|1600000000000"        # 透传
    assert captured["withMeta"] == "true"
    assert payload["source"] == "civitai"
    assert payload["next_cursor"] == "9|1700000000000"    # 原样回传，不加工
    assert payload["total"] is None
    assert len(payload["items"]) == 1
    assert list(payload["items"][0]) == list(sources.ITEM_KEYS)
    assert payload["items"][0]["prompt"] == "hello"


def test_search_route_rejects_bad_params_without_network(monkeypatch):
    """非法 sort/nsfw 回 400 + 中文提示（不能把上游 ZodError 透传给前端）。"""
    def explode(_params):  # pragma: no cover - 只用于断言「没被打到」
        raise AssertionError("参数非法时不该发起网络请求")

    monkeypatch.setattr(civitai, "_civitai_images_page", explode)
    for params in ({"sort": "bogus"}, {"nsfw": "bogus"}, {"period": "Forever"}):
        response = run(civitai.anima_gallery_civitai_search(FakeRequest(**params)))
        assert response.status == 400
        assert "不支持" in json.loads(body_of(response))["error"]


def test_query_filters_locally_and_reports_warning(monkeypatch):
    """实测 C站忽略 query：本适配器在本页内本地过滤，并在 warnings 里如实说明（不静默假装搜到了）。"""
    def fake_page(_params):
        return {
            "items": [
                {"id": 1, "url": "https://image.civitai.com/a/original=true/a.jpeg", "meta": {"prompt": "1girl, solo"}},
                {"id": 2, "url": "https://image.civitai.com/b/original=true/b.jpeg", "meta": {"prompt": "landscape"}},
            ],
            "metadata": {"nextCursor": "2|123"},
        }

    monkeypatch.setattr(civitai, "_civitai_images_page", fake_page)
    response = run(civitai.anima_gallery_civitai_search(FakeRequest(query="1girl", limit="2")))
    payload = json.loads(body_of(response))

    assert [item["id"] for item in payload["items"]] == ["1"]
    assert any("不支持关键词搜索" in warning for warning in payload["warnings"])
    assert payload["next_cursor"] == "2|123"              # 过滤不影响翻页游标


# ---------- 3. 密钥：掩码 / 存取 / 绝不回显 ----------
def test_key_mask_only_exposes_first_and_last_four(isolated_key_store):
    key = "b45c0123456789abcdef0123456789f4d"
    masked = sources.masked_civitai_key(key)

    assert masked == f"{key[:4]}{sources.MASK_ELLIPSIS}{key[-4:]}"
    assert key[4:-4] not in masked
    assert masked.count(sources.MASK_ELLIPSIS) == 1
    # 短 key 任何切片都可能泄露有效信息 → 只回一个省略号
    assert sources.masked_civitai_key("short") == sources.MASK_ELLIPSIS
    assert sources.masked_civitai_key("") == ""
    assert sources.masked_civitai_key(None) == ""         # 未配置 → 空串


def test_key_store_roundtrip_and_env_priority(isolated_key_store, monkeypatch):
    """读取/保存/清除：文件格式带 version，落盘在 data/，界面值优先于环境变量。"""
    path = isolated_key_store
    key = "abcd0123456789abcdef0123456789wxyz"

    assert sources.load_civitai_key() == ""
    assert sources.civitai_key_configured() is False

    monkeypatch.setenv(sources.CIVITAI_KEY_ENV, "env0000000000000000000000000000env0")
    assert sources.civitai_key_configured() is True        # 环境变量兜底
    assert sources.load_civitai_key() == ""                # 但文件里没有
    assert sources.civitai_key_source() == "env"

    sources.save_civitai_key(f"Bearer {key}")              # 粘贴整行 header 是常见误操作
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["version"] == sources.CIVITAI_KEY_VERSION
    assert saved["api_key"] == key and saved["saved_at"]
    assert sources.load_civitai_key() == key
    assert sources.effective_civitai_key() == key          # 文件优先于环境变量
    assert sources.civitai_key_source() == "file"

    sources.save_civitai_key("")                           # key="" = 清除
    assert sources.load_civitai_key() == ""
    assert not path.exists()
    assert sources.effective_civitai_key().endswith("env0")  # 清除后回落到环境变量

    sources.save_civitai_key(key)
    sources.clear_civitai_key()
    assert sources.effective_civitai_key().endswith("env0")


def test_secrets_routes_never_echo_the_raw_key(isolated_key_store, monkeypatch):
    """GET 只回掩码；POST 保存/清除；test 只回中文结论 —— 三处都不得出现完整 key。"""
    key = "1234567890abcdef1234567890abcdef"
    sources.save_civitai_key(key)

    status = json.loads(body_of(run(civitai.anima_gallery_secrets_status(FakeRequest()))))
    assert status["civitai"]["configured"] is True
    assert status["civitai"]["masked"] == f"1234{sources.MASK_ELLIPSIS}cdef"
    assert "pixiv" in status                                # P站状态另走 B 的路由，这里只带一个占位
    assert key not in json.dumps(status, ensure_ascii=False)

    saved = json.loads(body_of(run(civitai.anima_gallery_secrets_save(FakeRequest(body={"source": "civitai", "key": "zzzz9999888877776666555544443333"})))))
    assert saved["ok"] is True and saved["masked"] == f"zzzz{sources.MASK_ELLIPSIS}3333"
    assert key not in json.dumps(saved, ensure_ascii=False)

    cleared = json.loads(body_of(run(civitai.anima_gallery_secrets_save(FakeRequest(body={"source": "civitai", "key": ""})))))
    assert cleared["ok"] is True and cleared["configured"] is False and cleared["masked"] == ""

    wrong_source = run(civitai.anima_gallery_secrets_save(FakeRequest(body={"source": "pixiv", "key": "x"})))
    assert wrong_source.status == 400

    no_key = json.loads(body_of(run(civitai.anima_gallery_secrets_test(FakeRequest(body={})))))
    assert no_key["ok"] is False and "尚未保存" in no_key["message"]


def test_secrets_test_uses_me_endpoint_and_hides_key(isolated_key_store, monkeypatch):
    """key 校验走 /api/v1/me（实测 images 端点对假 key 也回 200，测不出有效性）。"""
    key = "abcdefabcdefabcdefabcdefabcdefab"
    sources.save_civitai_key(key)

    calls: dict = {}

    def fake_request_json(url, params, timeout=20, *, with_key=True):
        calls["url"] = url
        calls["params"] = params
        calls["with_key"] = with_key
        return {"id": 1, "username": "tester", "email": "secret@example.com"}

    monkeypatch.setattr(civitai, "_civitai_request_json", fake_request_json)
    payload = json.loads(body_of(run(civitai.anima_gallery_secrets_test(FakeRequest(body={})))))

    assert calls["url"] == civitai.CIVITAI_API_ME_URL
    assert calls["params"] == {}                            # key 绝不能出现在查询参数里
    assert calls["with_key"] is True
    assert payload["ok"] is True and "tester" in payload["message"]
    assert key not in json.dumps(payload, ensure_ascii=False)
    assert "secret@example.com" not in json.dumps(payload, ensure_ascii=False)  # 不回显账号资料


def test_api_requests_carry_bearer_header_and_never_key_in_url(isolated_key_store, monkeypatch):
    """鉴权只走 Authorization 头：URL 与查询参数里永远没有 key（URL 会进日志/错误串）。"""
    key = "feedfacefeedfacefeedfacefeedface"
    sources.save_civitai_key(key)
    seen: dict = {}

    class FakeSession:
        """顶掉模块级 session。

        ⚠️ 必须换**模块属性**而不是 session 的方法：同 session 里别的测试文件会把
        `sys.modules["requests"]` 换成桩（`test_danbooru_meta.py`），而本模块的
        `_civitai_session` 是在收集期创建的，拿到的可能是那个桩 —— 直接在它上面 setattr
        会以「对象没有 get 属性」失败（实测）。
        """

        proxies: dict = {}

        def get(self, url, params=None, headers=None, timeout=None):
            seen["url"] = url
            seen["params"] = params
            seen["headers"] = headers
            return FakeResponse({"items": [], "metadata": {}})

    monkeypatch.setattr(civitai, "_civitai_session", FakeSession())
    civitai._civitai_request_json(civitai.CIVITAI_API_IMAGES_URL, {"limit": 1})

    assert seen["headers"]["Authorization"] == f"Bearer {key}"
    assert key not in seen["url"] and key not in json.dumps(seen["params"] or {})


# ---------- 4. 图源注册表容错 ----------
def test_registry_payload_shape_and_civitai_capabilities():
    """capabilities 是前端隐藏/禁用控件的唯一依据：契约里的键一个都不能少、C站的值钉死。

    ⚠️ 断言写成「**包含**契约键」而不是「等于某几个字面量」：2026-09-15 加第 5 键 `query` 时，
    写死四键的断言把修复挡在门外（PLAN §7 评审结论 1）——以后加键不该再卡住。
    """
    civitai_caps = civitai.SOURCE.capabilities()
    assert set(civitai_caps) >= set(sources.CAPABILITY_KEYS)
    assert civitai_caps == {"tags": False, "prompt": True, "nsfw": True, "login": False, "query": False}
    assert civitai.SOURCE.images_headers() == {}            # C站无防盗链
    assert civitai.SOURCE.source_id == "civitai"

    for entry in sources.sources_payload():
        assert set(entry) == {"id", "label", "capabilities"}
        assert set(entry["capabilities"]) >= set(sources.CAPABILITY_KEYS)
        assert list(entry["capabilities"]) == list(sources.CAPABILITY_KEYS)
        assert all(isinstance(value, bool) for value in entry["capabilities"].values())

    payload = json.loads(body_of(run(civitai.anima_gallery_sources(FakeRequest()))))
    civitai_entry = next(item for item in payload["sources"] if item["id"] == "civitai")
    assert civitai_entry["capabilities"] == civitai_caps
    # 关键：`query` 必须真的经路由发到前端（旧版本在 normalize_capabilities 被砍成 4 键）
    assert civitai_entry["capabilities"]["query"] is False


def test_normalize_capabilities_keeps_query_and_defaults_it_true():
    """`query` 是 PLAN §6 的契约补充：缺省 True（D站/未知源），显式 False 必须被保留。"""
    defaults = sources.normalize_capabilities(None)
    assert set(defaults) >= set(sources.CAPABILITY_KEYS)
    assert defaults["query"] is True                        # 缺省支持关键词检索
    assert [defaults[key] for key in ("tags", "prompt", "nsfw", "login")] == [False] * 4

    assert sources.normalize_capabilities({"query": False})["query"] is False
    assert sources.normalize_capabilities({"tags": True})["tags"] is True
    assert "bogus" not in sources.normalize_capabilities({"bogus": True})   # 多余键丢弃


def test_load_builtin_sources_survives_missing_adapter(monkeypatch):
    """对方模块**不存在**时必须只是「该图源不可用」，不能抛异常、不能拖垮 C站。"""
    real_import = sources._import_adapter_module
    # P站适配器是并行开发的：它可能已经落地（已注册），也可能还没有。
    # 这里先把注册表恢复成「没有 P站」的干净状态，确保两条世界线都测到同一条容错路径。
    existing_pixiv = sources.get_source("pixiv")
    sources.unregister("pixiv")

    def fake_import(name):
        if name == "anima_gallery_pixiv":
            raise ModuleNotFoundError(f"No module named '{name}'")
        return real_import(name)

    monkeypatch.setattr(sources, "_import_adapter_module", fake_import)
    monkeypatch.setattr(sources, "_adapter_status", {})
    try:
        status = sources.load_builtin_sources(force=True)

        assert status["anima_gallery_civitai"] == "ok"
        assert "ModuleNotFoundError" in status["anima_gallery_pixiv"]
        assert sources.get_source("civitai") is not None
        assert sources.get_source("pixiv") is None          # 没装就是没有，不伪造
    finally:
        if existing_pixiv is not None:
            sources.register(existing_pixiv, replace=True)


def test_pixiv_adapter_wires_into_the_protocol_layer_when_present():
    """集成检查（P站由另一个 agent 并行开发）：模块在就顺带锁一下它的协议形状，不在就跳过。"""
    source = sources.get_source("pixiv")
    if source is None:
        pytest.skip("P站适配器尚未落地（并行开发中）—— 容错加载已由上一个用例覆盖")

    pixiv_caps = sources.source_capabilities(source)
    assert pixiv_caps == {"tags": True, "prompt": False, "nsfw": True, "login": True, "query": True}
    headers = sources.source_images_headers(source)
    assert "pixiv.net" in headers.get("Referer", ""), "P站取图必须带 Referer，否则 i.pximg.net 403"
    assert any(entry["id"] == "pixiv" for entry in sources.sources_payload())


def test_load_builtin_sources_survives_broken_adapter(monkeypatch):
    """对方模块**导入即炸**（依赖缺失/语法错）同样只能降级，绝不能冒泡到插件加载。"""
    real_import = sources._import_adapter_module

    def fake_import(name):
        if name == "anima_gallery_broken_probe":
            raise RuntimeError("boom: 图源依赖缺失")
        return real_import(name)

    monkeypatch.setattr(sources, "_import_adapter_module", fake_import)
    monkeypatch.setattr(sources, "_adapter_status", {})
    monkeypatch.setattr(sources, "BUILTIN_ADAPTER_MODULES",
                        ("anima_gallery_civitai", "anima_gallery_broken_probe"))

    status = sources.load_builtin_sources(force=True)
    assert status["anima_gallery_civitai"] == "ok"
    assert "boom" in status["anima_gallery_broken_probe"]
    assert sources.get_source("civitai") is not None


def test_adapter_without_source_object_is_quiet_then_reported(monkeypatch):
    """约定不符的适配器：首次「没找到」只按未就绪处理（不打印、不报错），补加载时才如实报错。

    这条锁的是「宽限只有一次」：既不会因为模块正在导入中就永久静默，也不会把一次性噪音
    当成错误刷屏（ai_verify 的合成导入路径实测踩过这个坑）。
    """
    monkeypatch.setattr(sources, "_import_adapter_module", lambda name: types.ModuleType(name))
    monkeypatch.setattr(sources, "_adapter_status", {})
    monkeypatch.setattr(sources, "_adapter_attempts", {})
    # 补加载只遍历内置清单：把探测名挂进去，模拟「首次没就绪 → 路由访问时补加载」的真实路径
    monkeypatch.setattr(sources, "BUILTIN_ADAPTER_MODULES", ("anima_gallery_no_source_probe",))

    assert sources.load_adapter("anima_gallery_no_source_probe") is None
    assert sources.adapter_status()["anima_gallery_no_source_probe"] == sources.ADAPTER_IMPORTING

    status = sources.ensure_adapters_loaded()          # 补加载（路由首次访问时触发）
    assert "没有找到图源对象" in status["anima_gallery_no_source_probe"]
    assert sources.get_source("civitai") is not None   # 坏适配器不影响已注册的图源


def test_register_is_idempotent_guarded_and_wraps_module_level_search(monkeypatch):
    """注册表：重复注册要报错（防两个 agent 抢同一 id），模块级平铺 search() 用垫片接住。"""
    monkeypatch.setattr(sources, "_adapter_status", {})
    fake_module = types.ModuleType("anima_gallery_fake_probe")
    fake_module.SOURCE_ID = "fake"
    fake_module.SOURCE_LABEL = "假图源"

    def search(query="", cursor=None, **kwargs):
        return [sources.normalize_item({"id": "1", "prompt": query}, "fake")], "next-cursor"

    fake_module.search = search
    monkeypatch.setattr(sources, "_import_adapter_module",
                        lambda name: fake_module if name == "anima_gallery_fake_probe" else None)

    try:
        source = sources.load_adapter("anima_gallery_fake_probe", force=True)
        assert source is not None and sources.get_source("fake") is source
        assert sources.source_capabilities(source) == {"tags": False, "prompt": False,
                                                       "nsfw": False, "login": False, "query": True}
        items, next_cursor = run(sources.call_search(source, query="hello", limit=5))
        assert next_cursor == "next-cursor" and items[0]["prompt"] == "hello"

        with pytest.raises(ValueError):
            sources.register(source)                        # 同 id 再注册必须拦下
        assert sources.register(source, replace=True) == "fake"
    finally:
        sources.unregister("fake")


def test_call_search_adapts_the_pixiv_style_signature():
    """B 侧（P站）是 `search(query, cursor, filters, **kwargs)`：协议层必须能直接调，不用对方改代码。"""
    seen: dict = {}

    class PixivLikeSource:
        source_id = "pixiv-like"
        label = "P站风格"

        def search(self, query="", cursor=None, filters=None, **kwargs):
            seen.update({"query": query, "cursor": cursor, "filters": filters, "kwargs": kwargs})
            return [], None

    items, next_cursor = run(sources.call_search(PixivLikeSource(), query="miku", cursor="20", limit=30))
    assert (items, next_cursor) == ([], None)
    assert seen["query"] == "miku" and seen["cursor"] == "20"
    assert seen["kwargs"].get("limit") == 30


# ---------- 图片代理（复用 /anima/image 的并发与缓存约定） ----------
def test_image_route_host_allowlist_and_day_cache(monkeypatch):
    """只允许 https + civitai 自家域（SSRF 闸门）；命中就走宿主缓存，回包带日缓存头。"""
    assert civitai._is_allowed_civitai_image_url("https://image.civitai.com/a/x.jpeg")
    assert civitai._is_allowed_civitai_image_url("https://imagecache.civitai.com/a/x.jpeg")
    assert not civitai._is_allowed_civitai_image_url("http://image.civitai.com/a/x.jpeg")   # 必须 https
    assert not civitai._is_allowed_civitai_image_url("https://evilcivitai.com/a/x.jpeg")    # 后缀要带点
    assert not civitai._is_allowed_civitai_image_url("https://evil.example.com/a/x.jpeg")
    assert not civitai._is_allowed_civitai_image_url("")

    forbidden = run(civitai.anima_gallery_civitai_image(FakeRequest(url="https://evil.example.com/x.jpg")))
    assert forbidden.status == 403

    monkeypatch.setattr(civitai, "_host_cached_image", lambda url: None)
    monkeypatch.setattr(civitai, "_host_store_image", lambda url, body, ctype: None)
    monkeypatch.setattr(civitai, "_civitai_get_image", lambda url, timeout=30: (b"\xff\xd8\xff" * 64, "image/jpeg"))

    ok = run(civitai.anima_gallery_civitai_image(FakeRequest(url="https://image.civitai.com/a/x.jpeg")))
    assert ok.status == 200
    assert ok.content_type == "image/jpeg"
    assert ok.headers["Cache-Control"] == "public, max-age=86400"   # 与 D站 /anima/image 同一约定
    assert len(ok.body) == 192

    cached = run(civitai.anima_gallery_civitai_image(FakeRequest(url="https://image.civitai.com/a/x.jpeg")))
    assert cached.status in (200, 502)          # 走宿主缓存分支时不会二次下载


def test_image_proxy_concurrency_matches_the_danbooru_contract():
    """并发上限沿用 D站 `/anima/image` 的 3（值有测试锁死，别改）。"""
    assert civitai.IMAGE_PROXY_CONCURRENCY == 3
    assert hasattr(civitai, "_get_image_proxy_semaphore")


# ---------- 按 URL 找图源（节点下载路径的跨模块接缝） ----------
class _StubSource:
    """最小图源替身（只用于临时顶替注册表里的某个 id）。"""

    def __init__(self, source_id, headers, capabilities=None):
        self.source_id = source_id
        self.label = source_id
        self._headers = dict(headers)
        self._capabilities = capabilities or {}

    def capabilities(self):
        return dict(self._capabilities)

    def images_headers(self):
        return dict(self._headers)

    def search(self, query="", cursor=None, **kwargs):  # pragma: no cover - 不会被调
        return [], None


class _SourceSlot:
    """临时替换/移除注册表里的某个图源，退出时精确还原（不依赖对方模块是否已落地）。"""

    def __init__(self, source_id, source=None):
        self._source_id = source_id
        self._source = source
        self._previous = None

    def __enter__(self):
        self._previous = sources.get_source(self._source_id)
        sources.unregister(self._source_id)
        if self._source is not None:
            sources.register(self._source, replace=True)
        return self

    def __exit__(self, *_exc):
        sources.unregister(self._source_id)
        if self._previous is not None:
            sources.register(self._previous, replace=True)
        return False


class _BranchTouched(Exception):
    """哨兵异常：用来证明「走了哪条分支」，而不必真的下载 + 解码图片。"""


def test_diag_never_echoes_proxy_credentials(monkeypatch):
    """`/diag` 会回显代理解析结果，而 `HTTP_PROXY` 允许写成 `http://user:pass@host:port`：
    userinfo 必须在**回显前**掩码，前端只按键名过滤是挡不住的（与 P站 侧同做法）。"""
    # 先把所有代理环境变量清干净再设（Windows 上 os.environ 大小写不敏感，先设后删会把自己删掉）
    for name in ("CIVITAI_PROXY_CONFIG", "HTTPS_PROXY", "HTTP_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTP_PROXY", "http://proxyuser:secretpass@127.0.0.1:7890")

    class FakeSession:
        proxies = {"http": "http://sessionuser:sessionpass@10.0.0.1:8080",
                   "https": "http://10.0.0.1:8080"}   # 无 userinfo 的不能被改写

    monkeypatch.setattr(civitai, "_civitai_session", FakeSession())
    payload = json.loads(body_of(run(civitai.anima_gallery_civitai_diag(FakeRequest()))))
    text = json.dumps(payload, ensure_ascii=False)

    assert "proxyuser" not in text and "secretpass" not in text
    assert "sessionuser" not in text and "sessionpass" not in text
    assert payload["resolved_proxies"]["https"] == "http://***:***@127.0.0.1:7890"
    assert payload["session_proxies"]["http"] == "http://***:***@10.0.0.1:8080"
    assert payload["session_proxies"]["https"] == "http://10.0.0.1:8080"   # 无凭据的原样保留
    # 顺便锁住 diag 其余字段：key 只回掩码、代理端口表仍在
    assert payload["key"]["masked"] == sources.masked_civitai_key()
    assert payload["fallback_ports"] == list(civitai.FALLBACK_PROXY_PORTS)


def test_source_for_image_url_matches_domains_and_subdomains():
    """域名匹配：含子域、大小写不敏感、端口无影响；未知主机/畸形 URL/非 http(s) 一律 None。"""
    assert sources.source_for_image_url("https://image.civitai.com/x/y/original=true/a.jpeg") == "civitai"
    assert sources.source_for_image_url("https://civitai.com/images/1") == "civitai"
    assert sources.source_for_image_url("https://imagecache.civitai.com/a/b/c.jpeg") == "civitai"
    assert sources.source_for_image_url("https://i.pximg.net/img-original/img/1_p0.jpg") == "pixiv"
    assert sources.source_for_image_url("https://WWW.PIXIV.NET/artworks/1") == "pixiv"

    assert sources.source_for_image_url("https://evilcivitai.com/a.jpg") is None    # 后缀要带点
    assert sources.source_for_image_url("https://civitai.com.evil.example/a.jpg") is None
    assert sources.source_for_image_url("https://cdn.donmai.us/original/x.jpg") is None  # D站 不在这张表里
    assert sources.source_for_image_url("ftp://image.civitai.com/a.jpg") is None    # 只认 http(s)
    assert sources.source_for_image_url("http://[::1") is None                      # 畸形 URL
    assert sources.source_for_image_url("javascript:alert(1)") is None
    assert sources.source_for_image_url("") is None
    assert sources.source_for_image_url(None) is None
    # 主机表里注册的每个 id 都必须能查到（新增图源只加一行即可被下载路径认出）
    for source_id in sources.SOURCE_IMAGE_HOSTS:
        assert sources.source_for_image_url(f"https://sub.{sources.SOURCE_IMAGE_HOSTS[source_id][0]}/a.jpg") == source_id


def test_image_headers_for_url_pixiv_referer_civitai_empty_and_unknown_none():
    """三态契约：未知主机 → None（调用方维持拒绝语义）；认识但未装配 → {}；已装配 → 该源的头。"""
    assert sources.image_headers_for_url("https://evil.example.com/a.jpg") is None

    assert sources.image_headers_for_url("https://image.civitai.com/a.jpg") == {}   # C站 无防盗链

    with _SourceSlot("pixiv", _StubSource("pixiv", {"Referer": "https://www.pixiv.net/"})):
        headers = sources.image_headers_for_url("https://i.pximg.net/img-original/img/1_p0.jpg")
        assert headers is not None and "pixiv.net" in headers.get("Referer", "")

    with _SourceSlot("pixiv", None):   # 认识这个主机，但图源没装配
        assert sources.image_headers_for_url("https://i.pximg.net/img-original/img/1_p0.jpg") == {}


def test_gallery_image_headers_falls_back_when_protocol_layer_missing(monkeypatch):
    """协议层缺失时必须返回 None（= 维持加多源之前的行为），绝不抛异常。"""
    monkeypatch.setitem(sys.modules, "anima_gallery_sources", None)   # import 直接失败
    assert danbooru_gallery._gallery_image_headers("https://image.civitai.com/a.jpg") is None
    assert danbooru_gallery._gallery_image_headers("https://i.pximg.net/a.jpg") is None


def test_gallery_image_headers_returns_source_headers(monkeypatch):
    """协议层可用时：C站 → {}（dict，不是 None，下载路径据此走新分支）；未知主机/非 https → None。"""
    assert danbooru_gallery._gallery_image_headers("https://image.civitai.com/a.jpg") == {}
    assert danbooru_gallery._gallery_image_headers("https://evil.example.com/a.jpg") is None
    assert danbooru_gallery._gallery_image_headers("http://image.civitai.com/a.jpg") is None   # 必须 https
    with _SourceSlot("pixiv", _StubSource("pixiv", {"Referer": "https://www.pixiv.net/"})):
        headers = danbooru_gallery._gallery_image_headers("https://i.pximg.net/img-original/img/1_p0.jpg")
    assert headers == {"Referer": "https://www.pixiv.net/"}


def test_download_image_danbooru_branch_is_untouched(monkeypatch):
    """D站 URL：仍然只走 `_danbooru_get_image()`，一个字节都不改（新分支不得插手）。"""
    def explode(*_a, **_k):  # pragma: no cover - 只用于断言没被调用
        raise AssertionError("D站 URL 不该走多源画廊分支")

    def sentinel(_url):
        raise _BranchTouched("danbooru-branch")

    monkeypatch.setattr(danbooru_gallery, "_gallery_get_image", explode)
    monkeypatch.setattr(danbooru_gallery, "_danbooru_get_image", sentinel)
    with pytest.raises(_BranchTouched, match="danbooru-branch"):
        danbooru_gallery.DanbooruGallery._download_image("https://cdn.donmai.us/original/x.jpg")


def test_download_image_gallery_branch_passes_source_headers(monkeypatch):
    """非 D站 但属于已装配图源：走新分支，且**必须**把该源的 images_headers() 带上（P站 Referer）。"""
    captured: dict = {}

    def sentinel(url, headers=None):
        captured["url"] = url
        captured["headers"] = headers
        raise _BranchTouched("gallery-branch")

    def explode(_url):  # pragma: no cover - 只用于断言没被调用
        raise AssertionError("非 D站 URL 不该走 D站分支")

    monkeypatch.setattr(danbooru_gallery, "_danbooru_get_image", explode)
    monkeypatch.setattr(danbooru_gallery, "_gallery_get_image", sentinel)

    with _SourceSlot("pixiv", _StubSource("pixiv", {"Referer": "https://www.pixiv.net/"})):
        with pytest.raises(_BranchTouched, match="gallery-branch"):
            danbooru_gallery.DanbooruGallery._download_image("https://i.pximg.net/img-original/img/1_p0.jpg")
    assert captured["headers"] == {"Referer": "https://www.pixiv.net/"}

    # C站：走同一条新分支，但不需要额外头（实测无防盗链）
    with pytest.raises(_BranchTouched, match="gallery-branch"):
        danbooru_gallery.DanbooruGallery._download_image("https://image.civitai.com/a/original=true/a.jpeg")
    assert captured["headers"] == {}


def test_download_image_rejects_urls_outside_every_known_source(monkeypatch):
    """两边都不认 → 仍 raise，且错误信息说清「既不是 D站，也不属于已装配图源」。"""
    def explode(*_a, **_k):  # pragma: no cover - 只用于断言没被调用
        raise AssertionError("未知主机不该发起任何下载")

    monkeypatch.setattr(danbooru_gallery, "_danbooru_get_image", explode)
    monkeypatch.setattr(danbooru_gallery, "_gallery_get_image", explode)
    for url in ("https://evil.example.com/x.jpg", "https://cdn.donmai.us.evil.example/x.jpg", ""):
        with pytest.raises(ValueError) as excinfo:
            danbooru_gallery.DanbooruGallery._download_image(url)
        assert "既不是 D站" in str(excinfo.value) and "已装配图源" in str(excinfo.value)

    # 协议层缺失时，非 D站 URL 也必须维持原拒绝语义（不是崩、不是静默）
    monkeypatch.setitem(sys.modules, "anima_gallery_sources", None)
    with pytest.raises(ValueError):
        danbooru_gallery.DanbooruGallery._download_image("https://image.civitai.com/a.jpg")
