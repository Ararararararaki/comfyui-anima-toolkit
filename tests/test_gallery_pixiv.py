"""P站图源（anima_gallery_pixiv）离线测试：PKCE / token 生命周期 / 统一 item 映射 / 契约。

设计原则（与 PLAN §5.1 的纪律一致）：
- **全部离线**：网络层用 FakeSession 顶掉，不打真实 Pixiv（也没有 token 可打）。
- **契约优先**：断言 §5.2 的 item key 集合、§5.3 的 `cursor`/`next_cursor` 命名、
  §5.4 的 `Referer`，以及「未登录要有可读错误，**绝不静默返回空列表**」。
- 只跑本文件：`python -X utf8 -m pytest tests/test_gallery_pixiv.py -q`
"""

from __future__ import annotations

import asyncio
import hashlib
import base64
import json
import os
import time
from collections import OrderedDict
from urllib.parse import parse_qs, urlparse

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

import anima_gallery_pixiv as pixiv


# ── 契约常量（PLAN §5.2 item schema；缺字段一律 null / []，不省略 key） ──────────────
ITEM_KEYS = {
    "source", "id", "preview_url", "full_url", "width", "height", "tags",
    "prompt", "negative_prompt", "rating", "score", "source_url", "meta",
}
SEARCH_RESPONSE_KEYS = {"source", "items", "next_cursor", "total"}


# ── 测试替身：假响应 / 假 session ────────────────────────────────────────────────
class FakeResponse:
    """requests.Response 的最小替身（只实现被测代码用到的部分）。"""

    def __init__(self, status_code: int = 200, payload=None, headers=None, content: bytes = b""):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.content = content

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeSession:
    """记录每次请求；按顺序（或按 URL 子串）返回预设响应。"""

    def __init__(self, responses=None, raises=None):
        self.responses = list(responses or [])
        self.raises = list(raises or [])
        self.calls: list[dict] = []
        self.proxies: dict = {}
        self.headers: dict = {}
        self.mounted: dict = {}

    def request(self, method, url, params=None, data=None, headers=None, timeout=None, **kwargs):
        self.calls.append({
            "method": method, "url": url, "params": params, "data": data,
            "headers": headers or {}, "timeout": timeout,
        })
        if self.raises:
            error = self.raises.pop(0)
            if error is not None:
                raise error
        if not self.responses:
            raise AssertionError(f"FakeSession 没有更多预设响应，但收到了请求：{method} {url}")
        return self.responses.pop(0)

    def mount(self, prefix, adapter):
        self.mounted[prefix] = adapter


# ── 隔离：token 落盘位置、缓存、代理探测全部收进 tmp_path / 关掉 ────────────────────
@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(pixiv, "_token_path", tmp_path / "pixiv_token.json")
    monkeypatch.setattr(pixiv, "_token_cache", None)
    monkeypatch.setattr(pixiv, "_token_stamp", None)
    monkeypatch.setattr(pixiv, "_search_cache", OrderedDict())
    # 代理探测会真的去 TCP 连本机端口（0.5s）；离线测试一律关掉。
    monkeypatch.setattr(pixiv, "_apply_pixiv_proxy", lambda: None)
    monkeypatch.setattr(pixiv, "_fallback_proxy", lambda: None)
    yield
    pixiv._token_cache = None
    pixiv._token_stamp = None
    pixiv._search_cache.clear()
    pixiv._pending_verifiers.clear()


def install_session(monkeypatch, session: FakeSession) -> FakeSession:
    monkeypatch.setattr(pixiv, "_pixiv_session", session)
    return session


# ── 1. PKCE ────────────────────────────────────────────────────────────────────
def test_pkce_code_challenge_matches_rfc7636_appendix_b():
    """RFC 7636 附录 B 的官方测试向量（钉死 S256 的算法细节，防「看着像」的实现）。"""
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert pixiv.code_challenge_for(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_pkce_challenge_is_self_consistent_and_url_safe():
    verifier = pixiv.generate_code_verifier()
    # RFC 7636 §4.1：43~128 个 unreserved 字符
    assert 43 <= len(verifier) <= 128
    assert all(c.isalnum() or c in "-._~" for c in verifier)
    challenge = pixiv.code_challenge_for(verifier)
    # base64url(sha256) 去掉 padding = 43 字符，且不含 + / =
    assert len(challenge) == 43
    assert not set(challenge) & set("+/=")
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
    assert challenge == expected
    # 两个 verifier 不应撞车（每次授权都要新的）
    assert pixiv.generate_code_verifier() != pixiv.generate_code_verifier()


def test_auth_url_carries_s256_challenge_and_pixiv_android_client():
    """授权 URL 必须带 code_challenge / method=S256 / client=pixiv-android（公开客户端）。"""
    url = pixiv.build_auth_url("CHALLENGE_VALUE")
    assert url.startswith("https://app-api.pixiv.net/web/v1/login?")
    assert "code_challenge=CHALLENGE_VALUE" in url
    assert "code_challenge_method=S256" in url
    assert pixiv.PIXIV_CLIENT_TAG == "pixiv-android"
    assert "client=pixiv-android" in url


def _challenge_from_auth_url(url: str) -> str:
    """从授权链接里抠出真正发给 Pixiv 的 code_challenge（断言用它，别用本地重算的值代替）。"""
    return parse_qs(urlparse(url).query)["code_challenge"][0]


def test_auth_url_route_stashes_verifier_for_later_code_exchange(monkeypatch):
    """`/auth/url` 的回包必须给出「本次链接」对应的 verifier（前端据此回传，服务端另存兜底）。"""
    response = asyncio.run(pixiv.anima_gallery_pixiv_auth_url(make_mocked_request("GET", "/auth/url")))
    payload = json.loads(response.body)
    assert {"url", "verifier_hint"} <= set(payload)  # §5.3 的键都在
    assert payload["verifier_hint"] is None  # 契约字面值保持不变
    # 前端读的是 data?.verifier || data?.verifier_hint —— verifier 必须存在且与本次 URL 配对
    assert payload["verifier"]
    assert pixiv.code_challenge_for(payload["verifier"]) == _challenge_from_auth_url(payload["url"])
    # 服务端暂存也要能取到同一个（前端没回传时的兜底）
    assert pixiv._take_pending_verifier() == payload["verifier"]


def test_challenge_sent_to_pixiv_matches_the_verifier_actually_exchanged(monkeypatch):
    """🔴 核心回归（2026-09-15 真机 bug：code 新鲜但一直 `invalid_request`）。

    断言的是**这对关系本身**：`/auth/code` 实际发给 Pixiv 的 `code_verifier` 的 S256
    == `/auth/url` 实际写进授权链接的 `code_challenge`。
    两侧都**不 mock**（只在最外层拦 token 端点、并模拟前端原样回传 verifier），
    所以它能抓住"暂存/回传错位"这类 bug —— 分别 mock 两边正是当初漏掉它的原因。
    """
    session = install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(200, {"response": {"access_token": "AT", "refresh_token": "RT", "expires_in": 3600}}),
    ]))
    # ① 真实的 /auth/url
    payload = json.loads(
        asyncio.run(pixiv.anima_gallery_pixiv_auth_url(make_mocked_request("GET", "/auth/url"))).body
    )
    challenge = _challenge_from_auth_url(payload["url"])

    # ② 模拟前端：把回包里的 verifier 存下来，兑换时原样回传（widget 4263/4271 → 4296）
    response = asyncio.run(pixiv.anima_gallery_pixiv_auth_code(
        FakeJsonRequest({"code": "FRESH_CODE", "verifier": payload["verifier"]})
    ))
    assert response.status == 200, response.body

    # ③ 关系断言：真正发出去的 verifier 必须能算出那个 challenge
    sent = session.calls[0]["data"]["code_verifier"]
    assert pixiv.code_challenge_for(sent) == challenge


def test_earlier_auth_url_still_pairs_after_later_auth_url_calls(monkeypatch):
    """真机失败场景复现（用户点过多次「去授权」，用的是**较早**那条链接的 code）。

    修复前：服务端"取最近一个"暂存 → 配到最新 verifier → Pixiv 回 `invalid_request`
    （用户连试三次都一样，且 code 是新鲜的 → 排查方向被带偏）。
    修复后：前端回传它自己那次的 verifier → 精确配对，后调的 `/auth/url` 不再污染。
    """
    responses = [
        FakeResponse(200, {"response": {"access_token": f"AT{n}", "refresh_token": "RT", "expires_in": 3600}})
        for n in range(4)
    ]
    session = install_session(monkeypatch, FakeSession(responses=responses))

    # 用户手上这条（第 1 次「去授权」）
    first = json.loads(
        asyncio.run(pixiv.anima_gallery_pixiv_auth_url(make_mocked_request("GET", "/auth/url"))).body
    )
    # 期间用户/排查者又点了 3 次「去授权」→ 暂存被覆盖
    for _ in range(3):
        asyncio.run(pixiv.anima_gallery_pixiv_auth_url(make_mocked_request("GET", "/auth/url")))
    latest = pixiv._take_pending_verifier()
    assert latest != first["verifier"]  # 确认暂存确实已被覆盖（否则这条测试没意义）

    response = asyncio.run(pixiv.anima_gallery_pixiv_auth_code(
        FakeJsonRequest({"code": "CODE_FROM_FIRST_LINK", "verifier": first["verifier"]})
    ))
    assert response.status == 200, response.body
    sent = session.calls[0]["data"]["code_verifier"]
    assert sent == first["verifier"]
    assert pixiv.code_challenge_for(sent) == _challenge_from_auth_url(first["url"])


def test_verifier_fallback_uses_the_most_recent_auth_url_when_frontend_sends_none(monkeypatch):
    """前端没回传 verifier 时（老前端 / 直接调 API），兜底用最近一次 `/auth/url` 的那个。

    这条**故意不读回包里的 `verifier` 字段**，只看 `url` —— 它验证的是"单次调用也能配对成功"
    这个修复前后都成立的行为（真机 bug 只在调过多次 `/auth/url` 后才暴露，见上一条）。
    """
    session = install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(200, {"response": {"access_token": "AT", "refresh_token": "RT", "expires_in": 3600}}),
    ]))
    asyncio.run(pixiv.anima_gallery_pixiv_auth_url(make_mocked_request("GET", "/auth/url")))  # 会被覆盖
    latest = json.loads(
        asyncio.run(pixiv.anima_gallery_pixiv_auth_url(make_mocked_request("GET", "/auth/url"))).body
    )
    asyncio.run(pixiv.anima_gallery_pixiv_auth_code(FakeJsonRequest({"code": "C"})))
    sent = session.calls[0]["data"]["code_verifier"]
    assert pixiv.code_challenge_for(sent) == _challenge_from_auth_url(latest["url"])


# ── 2. token 过期判定与刷新分支（mock 掉网络） ─────────────────────────────────────
def write_token(**overrides):
    record = {
        "version": 1,
        "access_token": "old-access",
        "refresh_token": "old-refresh",
        "expires_at": time.time() + 3600,
    }
    record.update(overrides)
    pixiv._token_path.parent.mkdir(parents=True, exist_ok=True)
    pixiv._token_path.write_text(json.dumps(record), encoding="utf-8")
    pixiv._token_cache = None
    return record


def test_token_expiry_boundaries():
    assert pixiv._token_expired({"access_token": "", "expires_at": time.time() + 999}) is True
    assert pixiv._token_expired({"access_token": "x", "expires_at": 0}) is True
    assert pixiv._token_expired({"access_token": "x", "expires_at": time.time() + 3600}) is False
    # 提前量：60s 内到期即视为过期（避免"刚好在用的时候失效"）
    assert pixiv._token_expired({"access_token": "x", "expires_at": time.time() + 30}) is True
    assert pixiv._token_expired({"access_token": "x", "expires_at": time.time() + 600}) is False


def test_load_token_notices_external_file_change(monkeypatch):
    """token 缓存必须按**文件指纹**失效，不能只判 `is None`。

    真机症状（评审改这里的起因）：外部写入 token（手工换号 / 另一个进程刷新过）后，
    进程内的缓存永远不失效 → `/auth/status` 恒为 `logged_in:false`、搜索回 401，
    而磁盘上的 token 文件内容完全正确 —— 只有"进程活着就只读一次盘"的缓存才会这样。
    """
    write_token(access_token="first-access")
    assert pixiv._load_token()["access_token"] == "first-access"  # 建立缓存

    # 模拟"外部"改写：内容长度不同 + 显式改 mtime（不依赖文件系统时间分辨率）
    pixiv._token_path.write_text(
        json.dumps({"access_token": "second-access-longer", "refresh_token": "r2",
                    "expires_at": time.time() + 3600}),
        encoding="utf-8",
    )
    stamp = time.time() + 10
    os.utime(pixiv._token_path, (stamp, stamp))

    assert pixiv._load_token()["access_token"] == "second-access-longer"
    assert pixiv.auth_status()["logged_in"] is True
    assert pixiv.access_token() == "second-access-longer"


def test_load_token_notices_external_deletion(monkeypatch):
    """外部删掉 token 文件后（例如用户手工清理），状态要能立刻回落到未登录。"""
    write_token()
    assert pixiv.logged_in() is True
    pixiv._token_path.unlink()
    assert pixiv.logged_in() is False
    assert pixiv.auth_status()["expires_at"] is None


def test_valid_token_is_reused_without_any_network_call(monkeypatch):
    write_token()
    session = install_session(monkeypatch, FakeSession())
    monkeypatch.setattr(pixiv, "_token_request", lambda payload: pytest.fail("未过期不应刷新 token"))
    assert pixiv.access_token() == "old-access"
    assert session.calls == []


def test_expired_token_triggers_refresh_and_persists_new_token(monkeypatch):
    write_token(expires_at=time.time() - 10)
    calls: list[dict] = []

    def fake_token_request(payload):
        calls.append(payload)
        return {
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 3600,
            "user": {"id": 42, "name": "tester"},
        }

    monkeypatch.setattr(pixiv, "_token_request", fake_token_request)
    assert pixiv.access_token() == "new-access"
    assert len(calls) == 1
    assert calls[0]["grant_type"] == "refresh_token"
    assert calls[0]["refresh_token"] == "old-refresh"
    assert calls[0]["client_id"] == pixiv.PIXIV_CLIENT_ID

    stored = json.loads(pixiv._token_path.read_text(encoding="utf-8"))
    assert stored["access_token"] == "new-access"
    assert stored["refresh_token"] == "new-refresh"  # 一次性 refresh_token 必须覆盖旧的
    assert stored["expires_at"] > time.time() + 3000
    assert stored["user_name"] == "tester"


def test_refresh_failure_is_explicit_and_never_leaks_the_refresh_token(monkeypatch):
    """刷新失败要显式抛错；且错误信息里**不得出现** refresh_token 明文。"""
    write_token(expires_at=time.time() - 10, refresh_token="SUPER-SECRET-REFRESH")
    session = install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(400, {"error": "invalid_grant"}),
    ]))
    with pytest.raises(pixiv.PixivError) as excinfo:
        pixiv.access_token()
    message = str(excinfo.value)
    assert "HTTP 400" in message and "invalid_grant" in message
    assert "SUPER-SECRET-REFRESH" not in message
    assert session.calls[0]["data"]["refresh_token"] == "SUPER-SECRET-REFRESH"  # 确实发出去了
    # 请求体也绝不能进日志：错误信息里不含任何请求体的键值拼接
    assert "refresh_token=" not in message


def test_missing_token_raises_readable_auth_error_instead_of_empty_result(monkeypatch):
    install_session(monkeypatch, FakeSession())
    assert pixiv.logged_in() is False
    with pytest.raises(pixiv.PixivAuthRequired) as excinfo:
        pixiv.access_token()
    message = str(excinfo.value)
    assert "未登录" in message and "auth/url" in message and "auth/code" in message
    status = pixiv.auth_status()
    assert status["logged_in"] is False and status["expires_at"] is None


def test_auth_status_never_exposes_plaintext_token():
    write_token(access_token="abcdefghijklmnop", refresh_token="zyxwvutsrqponmlk")
    status = pixiv.auth_status()
    assert status["logged_in"] is True
    assert status["access_token_masked"] == "abcd…mnop"
    assert "abcdefghijklmnop" not in json.dumps(status)
    assert "zyxwvutsrqponmlk" not in json.dumps(status)


class FakeJsonRequest:
    """只实现 handler 用到的 `.json()`（避免为构造 aiohttp body 写一堆样板）。"""

    def __init__(self, body):
        self._body = body

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def test_exchange_auth_code_sends_pkce_params_and_persists_token(monkeypatch):
    """授权码换 token：grant_type / code_verifier / redirect_uri 一个都不能错。"""
    session = install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(200, {"response": {
            "access_token": "AT", "refresh_token": "RT", "expires_in": 3600,
            "user": {"id": 1, "name": "あーと"},
        }}),
    ]))
    pixiv.exchange_auth_code("THE_CODE", "THE_VERIFIER")

    sent = session.calls[0]["data"]
    assert session.calls[0]["url"] == pixiv.PIXIV_TOKEN_URL
    assert sent["grant_type"] == "authorization_code"
    assert sent["code"] == "THE_CODE"
    assert sent["code_verifier"] == "THE_VERIFIER"
    assert sent["redirect_uri"] == "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback"
    assert sent["client_id"] == pixiv.PIXIV_CLIENT_ID
    assert pixiv.auth_status()["logged_in"] is True
    assert pixiv.auth_status()["user_name"] == "あーと"


def test_exchange_auth_code_accepts_a_pasted_callback_url(monkeypatch):
    """用户很可能直接把地址栏整段粘进来 → 必须能从 URL 里把 code 抠出来。"""
    session = install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(200, {"response": {"access_token": "AT", "refresh_token": "RT", "expires_in": 3600}}),
    ]))
    pasted = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?code=ABC123&state=xyz"
    pixiv.exchange_auth_code(pasted, "V")
    assert session.calls[0]["data"]["code"] == "ABC123"


def test_auth_code_route_uses_server_side_verifier_and_reports_success(monkeypatch):
    """`/auth/code` 不带 verifier 时用 `/auth/url` 暂存的那个（用户只要贴 code）。"""
    install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(200, {"response": {"access_token": "AT", "refresh_token": "RT", "expires_in": 3600,
                                        "user": {"id": 5, "name": "me"}}}),
    ]))
    asyncio.run(pixiv.anima_gallery_pixiv_auth_url(make_mocked_request("GET", "/auth/url")))
    stashed = pixiv._take_pending_verifier()
    assert stashed

    response = asyncio.run(pixiv.anima_gallery_pixiv_auth_code(FakeJsonRequest({"code": "C"})))
    payload = json.loads(response.body)
    assert response.status == 200
    assert payload["ok"] is True and "me" in payload["message"]

    status = json.loads(asyncio.run(pixiv.anima_gallery_pixiv_auth_status(make_mocked_request("GET", "/s"))).body)
    assert status["logged_in"] is True and status["expires_at"] > time.time()
    assert "access_token" not in status  # 状态回包不得带 token


def test_auth_code_route_rejects_bad_body_with_readable_message():
    for body in (ValueError("not json"), ["not", "a", "dict"], {}):
        response = asyncio.run(pixiv.anima_gallery_pixiv_auth_code(FakeJsonRequest(body)))
        payload = json.loads(response.body)
        assert response.status == 400
        assert payload["ok"] is False and payload["message"]
        assert "Traceback" not in payload["message"]


def test_auth_failure_responses_expose_an_error_key_for_the_frontend(monkeypatch):
    """🔴 评审发现（2026-09-15）：前端 `web/js/anima_danbooru_gallery_widget.js` **只读 `data.error`**。

    只回 `message` 的后果：用户界面上只剩「HTTP 400 / 502」，我们写的中文原因
    （"缺少 code_verifier：请先调用 GET /anima/gallery/pixiv/auth/url"）全部丢失，
    用户完全不知道下一步该干什么。所以 `error` 与 `message` 必须同值都给。
    """
    cases = [
        FakeJsonRequest(ValueError("not json")),          # body 不是 JSON
        FakeJsonRequest(["not", "a", "dict"]),            # body 不是对象
        FakeJsonRequest({}),                              # 缺 code
        FakeJsonRequest({"code": "C", "verifier": "V"}),  # token 交换失败（下一行给响应）
    ]
    for index, request_body in enumerate(cases):
        responses = [] if index < len(cases) - 1 else [FakeResponse(400, {"error": "invalid_grant"})]
        install_session(monkeypatch, FakeSession(responses=responses))
        response = asyncio.run(pixiv.anima_gallery_pixiv_auth_code(request_body))
        payload = json.loads(response.body)
        assert payload["ok"] is False
        assert payload.get("error"), f"授权失败回包缺 error 键，前端拿不到原因：{payload}"
        assert payload["error"] == payload["message"]
        assert "Traceback" not in payload["error"]


def test_auth_code_route_reports_token_exchange_failure_without_crashing(monkeypatch):
    install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(400, {"error": "invalid_grant", "error_description": "code expired"}),
    ]))
    response = asyncio.run(pixiv.anima_gallery_pixiv_auth_code(
        FakeJsonRequest({"code": "C", "verifier": "V"})
    ))
    payload = json.loads(response.body)
    assert response.status == 400
    assert payload["ok"] is False
    assert "invalid_grant" in payload["message"] and "去授权" in payload["message"]
    assert payload["error"] == payload["message"]


def test_exchange_auth_code_without_verifier_says_what_to_do(monkeypatch):
    install_session(monkeypatch, FakeSession())
    with pytest.raises(pixiv.PixivError) as excinfo:
        pixiv.exchange_auth_code("CODE", "")
    assert "verifier" in str(excinfo.value) and "auth/url" in str(excinfo.value)


def test_logout_route_clears_token(monkeypatch):
    write_token()
    assert pixiv.logged_in() is True
    response = asyncio.run(pixiv.anima_gallery_pixiv_logout(make_mocked_request("POST", "/logout")))
    assert json.loads(response.body)["logged_in"] is False
    assert pixiv.logged_in() is False
    assert not pixiv._token_path.exists()


# ── 3. search 回包 → 统一 item 的映射 ────────────────────────────────────────────
ILLUST = {
    "id": 98765432,
    "title": "サンプル",
    "type": "illust",
    "image_urls": {
        "square_medium": "https://i.pximg.net/c/360x360_70/img-master/img/2024/01/02/03/04/05/98765432_p0_square1200.jpg",
        "medium": "https://i.pximg.net/c/540x540_70/img-master/img/2024/01/02/03/04/05/98765432_p0_master1200.jpg",
        "large": "https://i.pximg.net/c/600x1200_90/img-master/img/2024/01/02/03/04/05/98765432_p0_master1200.jpg",
    },
    "caption": "サンプル説明",
    "user": {"id": 12345, "name": "作者名", "account": "artist_account"},
    "tags": [
        {"name": "初音ミク", "translated_name": "初音未来"},
        {"name": "オリジナル", "translated_name": None},
        {"name": "オリジナル", "translated_name": None},
    ],
    "create_date": "2024-01-02T03:04:05+09:00",
    "page_count": 2,
    "width": 1200,
    "height": 1600,
    "sanity_level": 4,
    "x_restrict": 1,
    "meta_single_page": {},
    "meta_pages": [
        {"image_urls": {"original": "https://i.pximg.net/img-original/img/2024/01/02/03/04/05/98765432_p0.jpg"}},
        {"image_urls": {"original": "https://i.pximg.net/img-original/img/2024/01/02/03/04/05/98765432_p1.jpg"}},
    ],
    "total_bookmarks": 4321,
    "total_view": 98765,
    "is_manga": False,
}

NEXT_URL = (
    "https://app-api.pixiv.net/v1/search/illust?word=%E5%88%9D%E9%9F%B3%E3%83%9F%E3%82%AF"
    "&search_target=partial_match_for_tags&sort=date_desc&filter=for_android&offset=30"
)


def search_response(illusts=None, next_url=NEXT_URL):
    return FakeResponse(200, {"illusts": illusts if illusts is not None else [ILLUST], "next_url": next_url})


def test_search_maps_pixiv_payload_to_unified_items(monkeypatch):
    write_token()
    session = install_session(monkeypatch, FakeSession(responses=[search_response()]))

    items, next_cursor = pixiv.search_illusts(word="初音ミク", cursor=None, limit=30)

    assert len(items) == 1
    item = items[0]
    # §5.2：契约 key 一个都不能少
    assert ITEM_KEYS <= set(item)
    assert item["source"] == "pixiv"
    assert item["id"] == "98765432"
    # §5.3 preview=medium / full=original（有 meta_pages 时拿真原图）
    assert item["preview_url"] == ILLUST["image_urls"]["medium"]
    assert item["full_url"] == "https://i.pximg.net/img-original/img/2024/01/02/03/04/05/98765432_p0.jpg"
    assert item["meta"]["full_is_original"] is True
    assert (item["width"], item["height"]) == (1200, 1600)
    # tags = name + translated_name（去重、保序）
    assert item["tags"] == ["初音ミク", "初音未来", "オリジナル"]
    assert item["meta"]["tag_details"][0] == {"name": "初音ミク", "translated_name": "初音未来"}
    # P站没有生成参数（PLAN §1）→ 恒为 null，前端据此隐藏 prompt 相关 UI
    assert item["prompt"] is None and item["negative_prompt"] is None
    assert item["rating"] == "r18"  # x_restrict=1
    assert item["score"] == 4321  # 收藏数
    assert item["source_url"] == "https://www.pixiv.net/artworks/98765432"
    assert item["meta"]["author"] == "作者名"
    assert item["meta"]["author_id"] == "12345"
    assert item["meta"]["page_count"] == 2
    assert item["meta"]["bookmarks"] == 4321

    # next_url → next_cursor（§5.3 钉死的字段名）
    assert next_cursor == "30"

    # 请求侧：Bearer + Referer + P站固定参数
    call = session.calls[0]
    assert call["url"] == pixiv.PIXIV_SEARCH_ILLUST_URL
    assert call["params"]["word"] == "初音ミク"
    assert call["params"]["search_target"] == "partial_match_for_tags"
    assert call["params"]["sort"] == "date_desc"
    assert call["params"]["filter"] == "for_android"
    assert call["params"]["offset"] == 0
    assert call["headers"]["Authorization"] == "Bearer old-access"
    assert call["headers"]["Referer"] == "https://www.pixiv.net/"


def test_search_cursor_round_trip_and_next_url_tolerance(monkeypatch):
    """cursor → offset 必须能往返；完整 next_url 也应被认。"""
    write_token()
    session = install_session(monkeypatch, FakeSession(responses=[
        search_response(next_url="https://app-api.pixiv.net/v1/search/illust?word=a&offset=60"),
        search_response(illusts=[], next_url=None),
        search_response(illusts=[], next_url=None),
    ]))
    _items, cursor2 = pixiv.search_illusts(word="a", cursor="30")
    assert cursor2 == "60"
    assert session.calls[0]["params"]["offset"] == 30

    pixiv.search_illusts(word="b", cursor=NEXT_URL)  # 整个 next_url 当 cursor
    assert session.calls[1]["params"]["offset"] == 30

    pixiv.search_illusts(word="c", page=3)  # 兼容页码写法：P站每页 30 条
    assert session.calls[2]["params"]["offset"] == 60

    with pytest.raises(pixiv.PixivError):
        pixiv.search_illusts(word="a", cursor="not-a-cursor")


def test_repeated_identical_search_hits_the_30s_cache(monkeypatch):
    """与 D 站同约定：同一查询 30s 内不发第二次请求。"""
    write_token()
    session = install_session(monkeypatch, FakeSession(responses=[search_response(next_url=None)]))
    first, _ = pixiv.search_illusts(word="x")
    second, _ = pixiv.search_illusts(word="x")
    assert len(session.calls) == 1
    assert first == second


def test_search_falls_back_to_large_when_no_original_available(monkeypatch):
    """§5.7：原图优先、退回 large —— 拿不到原图时必须标 full_is_original=false。"""
    write_token()
    single = {**ILLUST, "meta_pages": [], "meta_single_page": {}}
    install_session(monkeypatch, FakeSession(responses=[search_response([single])]))
    items, _ = pixiv.search_illusts(word="x")
    assert items[0]["full_url"] == ILLUST["image_urls"]["large"]
    assert items[0]["meta"]["full_is_original"] is False


def test_search_prefers_single_page_original(monkeypatch):
    write_token()
    original = "https://i.pximg.net/img-original/img/2024/01/02/03/04/05/98765432_p0.png"
    single = {**ILLUST, "meta_pages": [], "meta_single_page": {"original_image_url": original}}
    install_session(monkeypatch, FakeSession(responses=[search_response([single])]))
    items, _ = pixiv.search_illusts(word="x")
    assert items[0]["full_url"] == original
    assert items[0]["meta"]["full_is_original"] is True


def test_search_client_side_filters_bookmark_and_nsfw(monkeypatch):
    """P站 API 没有收藏数/NSFW 过滤参数，只能在本地按页过滤（要如实标注为客户端过滤）。"""
    write_token()
    safe = {**ILLUST, "id": 1, "x_restrict": 0, "total_bookmarks": 10, "meta_pages": []}
    popular_r18 = {**ILLUST, "id": 2, "x_restrict": 1, "total_bookmarks": 5000, "meta_pages": []}
    install_session(monkeypatch, FakeSession(responses=[
        search_response([safe, popular_r18], next_url=None),
        search_response([safe, popular_r18], next_url=None),
    ]))
    items, _ = pixiv.search_illusts(word="x", min_bookmark=100)
    assert [item["id"] for item in items] == ["2"]
    items, _ = pixiv.search_illusts(word="x", nsfw="safe")
    assert [item["id"] for item in items] == ["1"]


def test_search_limit_is_applied_client_side(monkeypatch):
    write_token()
    many = [{**ILLUST, "id": index, "meta_pages": []} for index in range(5)]
    install_session(monkeypatch, FakeSession(responses=[search_response(many, next_url=None)]))
    items, _ = pixiv.search_illusts(word="x", limit=2)
    assert len(items) == 2


def test_search_401_triggers_one_refresh_then_succeeds(monkeypatch):
    """服务端拒绝（401）→ 自动续期一次 → 重试成功。顺带验证 token 端点回包的真实形状解析。"""
    write_token()
    session = install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(401, {"error": "invalid_token"}),
        FakeResponse(200, {"response": {
            "access_token": "fresh-access", "refresh_token": "fresh-refresh",
            "expires_in": 3600, "user": {"id": 99, "name": "tester"},
        }}),
        search_response(next_url=None),
    ]))
    items, _ = pixiv.search_illusts(word="x")

    assert len(items) == 1
    assert [call["url"] for call in session.calls] == [
        pixiv.PIXIV_SEARCH_ILLUST_URL, pixiv.PIXIV_TOKEN_URL, pixiv.PIXIV_SEARCH_ILLUST_URL,
    ]
    assert session.calls[1]["data"]["grant_type"] == "refresh_token"
    assert session.calls[2]["headers"]["Authorization"] == "Bearer fresh-access"
    stored = json.loads(pixiv._token_path.read_text(encoding="utf-8"))
    assert stored["access_token"] == "fresh-access" and stored["refresh_token"] == "fresh-refresh"


def test_search_auth_failure_after_refresh_is_reported_as_readable_error(monkeypatch):
    """续期后仍被拒 → 抛可读的授权错误（不空列表、不静默）。"""
    write_token()
    install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(401, {"error": "invalid_token"}),
        FakeResponse(200, {"response": {"access_token": "fresh", "refresh_token": "r2", "expires_in": 3600}}),
        FakeResponse(401, {"error": "invalid_token"}),
    ]))
    with pytest.raises(pixiv.PixivAuthRequired) as excinfo:
        pixiv.search_illusts(word="x")
    assert "401" in str(excinfo.value) and "auth/url" in str(excinfo.value)


def test_search_400_mentions_premium_for_popular_desc(monkeypatch):
    write_token()
    install_session(monkeypatch, FakeSession(responses=[FakeResponse(400, {"error": "invalid sort"})]))
    with pytest.raises(pixiv.PixivError) as excinfo:
        pixiv.search_illusts(word="x", sort="popular_desc")
    assert "Premium" in str(excinfo.value)


# ⚠️ 下面这个 400 回包是 **2026-09-15 真实探针抓到的原样结构**（假 token 打 search/illust）：
#    P站把「token 失效」塞在 HTTP **400** 里，且 error 是嵌套对象而不是字符串。
PIXIV_OAUTH_400 = {
    "error": {
        "user_message": "",
        "message": "Error occurred at the OAuth process. Please check your Access Token to fix this. "
                   "Error Message: invalid_grant",
        "reason": "",
        "user_message_details": {},
    }
}


def test_real_pixiv_400_oauth_error_is_reported_as_auth_failure_not_bad_params(monkeypatch):
    """实测回归：token 失效时 P站回的是 400 + OAuth 嵌套错误体。

    若按「HTTP 400 = 参数被拒」处理，用户会去改排序/关键词，方向完全错 —— 必须识别成授权失效。
    """
    write_token()
    install_session(monkeypatch, FakeSession(responses=[FakeResponse(400, PIXIV_OAUTH_400)]))
    with pytest.raises(pixiv.PixivAuthRequired) as excinfo:
        pixiv.search_illusts(word="x", token="explicit-token-from-protocol-layer")
    message = str(excinfo.value)
    assert "invalid_grant" in message  # 上游原因要带出来，但要是人话而不是整个 dict
    assert "auth/url" in message
    assert "参数被拒绝" not in message
    assert "{'user_message'" not in message  # 不能把整个错误 dict 原样打出来


def test_stale_server_side_token_triggers_exactly_one_forced_refresh(monkeypatch):
    """本地记录说 token 没过期、服务端却拒绝 → 强制续期一次再试（只一次）。"""
    write_token()  # 本地：expires_at 还有 1 小时
    session = install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(400, PIXIV_OAUTH_400),  # 第一次：服务端拒绝
        search_response(),                    # 续期后的重试：成功
    ]))
    refresh_calls: list[dict] = []

    def fake_token_request(payload):
        refresh_calls.append(payload)
        return {"access_token": "fresh", "refresh_token": "r2", "expires_in": 3600, "user": {"id": 7, "name": "n"}}

    monkeypatch.setattr(pixiv, "_token_request", fake_token_request)
    items, _ = pixiv.search_illusts(word="x")

    assert len(items) == 1
    assert len(refresh_calls) == 1  # 只续期一次
    assert session.calls[0]["headers"]["Authorization"] == "Bearer old-access"
    assert session.calls[1]["headers"]["Authorization"] == "Bearer fresh"


def test_explicit_token_from_protocol_layer_is_never_auto_refreshed(monkeypatch):
    """协议层显式传 token 时，不擅自拿本地 refresh_token 去覆盖别人的凭据。"""
    write_token()
    install_session(monkeypatch, FakeSession(responses=[FakeResponse(400, PIXIV_OAUTH_400)]))
    monkeypatch.setattr(pixiv, "_token_request", lambda payload: pytest.fail("不应触发刷新"))
    with pytest.raises(pixiv.PixivAuthRequired):
        pixiv.search_illusts(word="x", token="someone-elses-token")


def test_network_failure_raises_instead_of_silently_returning_empty(monkeypatch):
    """⚠️ 硬要求：网络不通必须显式报错，**不允许**降级成空列表来让调用方"看起来正常"。"""
    write_token()
    install_session(monkeypatch, FakeSession(raises=[
        pixiv.requests.ConnectionError("boom"), pixiv.requests.ConnectionError("boom"),
    ]))
    monkeypatch.setattr(pixiv, "_sni_mode", lambda: "off")
    with pytest.raises(pixiv.PixivError):
        pixiv.search_illusts(word="x")


def test_search_without_word_or_user_returns_empty_without_request(monkeypatch):
    """没给任何条件时不发请求（这是"没输入"，不是"搜不到"）。"""
    session = install_session(monkeypatch, FakeSession())
    assert pixiv.search_illusts(word="") == ([], None)
    assert session.calls == []


# ── 4. 取图：Referer 是硬要求 ────────────────────────────────────────────────────
def test_images_headers_always_contains_pixiv_referer():
    headers = pixiv.PixivSource().images_headers()
    assert headers == {"Referer": "https://www.pixiv.net/"}
    # 协议层可能按类调 / 显式传实例调 —— 三种写法都必须成立
    assert pixiv.PixivSource.images_headers()["Referer"] == "https://www.pixiv.net/"
    assert pixiv.PixivSource.images_headers(pixiv.SOURCE)["Referer"] == "https://www.pixiv.net/"


def test_image_fetch_sends_referer_header(monkeypatch):
    session = install_session(monkeypatch, FakeSession(responses=[
        FakeResponse(200, content=b"\xff\xd8\xff", headers={"Content-Type": "image/jpeg"}),
    ]))
    url = "https://i.pximg.net/img-original/img/2024/01/02/03/04/05/98765432_p0.jpg"
    data, content_type = pixiv.fetch_image_bytes(url)
    assert data.startswith(b"\xff\xd8\xff") and content_type == "image/jpeg"
    assert session.calls[0]["headers"]["Referer"] == "https://www.pixiv.net/"


def test_image_url_whitelist_blocks_non_pixiv_hosts():
    assert pixiv.is_allowed_pixiv_image_url("https://i.pximg.net/img-original/x.jpg") is True
    assert pixiv.is_allowed_pixiv_image_url("http://i.pximg.net/x.jpg") is False
    assert pixiv.is_allowed_pixiv_image_url("https://evil.example.com/i.pximg.net/x.jpg") is False
    assert pixiv.is_allowed_pixiv_image_url("https://i.pximg.net.evil.com/x.jpg") is False
    assert pixiv.is_allowed_pixiv_image_url("") is False


def test_image_403_is_explained_as_hotlink_protection(monkeypatch):
    install_session(monkeypatch, FakeSession(responses=[FakeResponse(403, None)]))
    with pytest.raises(pixiv.PixivError) as excinfo:
        pixiv.fetch_image_bytes("https://i.pximg.net/x.jpg")
    assert "403" in str(excinfo.value) and "Referer" in str(excinfo.value)


# ── 5. 未登录时 search 必须回可读错误（HTTP 层） ─────────────────────────────────────
def test_search_route_returns_readable_401_when_not_logged_in(monkeypatch):
    install_session(monkeypatch, FakeSession())

    def not_logged_in(**kwargs):
        raise pixiv.PixivAuthRequired(pixiv.PIXIV_NOT_LOGGED_IN)

    monkeypatch.setattr(pixiv, "search_illusts", not_logged_in)
    request = make_mocked_request("GET", "/anima/gallery/pixiv/search?word=%E5%88%9D%E9%9F%B3")
    response = asyncio.run(pixiv.anima_gallery_pixiv_search(request))
    payload = json.loads(response.body)

    assert response.status == 401
    assert payload["logged_in"] is False
    assert "未登录" in payload["error"]
    assert "auth/url" in payload["error"]  # 直接告诉用户下一步怎么做
    assert "items" not in payload  # 不能回一个空列表冒充"搜不到"


def test_search_route_returns_contract_payload_on_success(monkeypatch):
    write_token()
    install_session(monkeypatch, FakeSession(responses=[search_response()]))
    request = make_mocked_request("GET", "/anima/gallery/pixiv/search?word=x&sort=date_desc&cursor=30")
    response = asyncio.run(pixiv.anima_gallery_pixiv_search(request))
    payload = json.loads(response.body)

    assert response.status == 200
    assert SEARCH_RESPONSE_KEYS <= set(payload)  # §5.3 的回包字段
    assert payload["source"] == "pixiv"
    assert payload["total"] is None
    assert len(payload["items"]) == 1
    assert payload["next_cursor"] == "30"


def test_image_route_rejects_foreign_hosts(monkeypatch):
    request = make_mocked_request("GET", "/anima/gallery/pixiv/image?url=https://evil.com/x.jpg")
    response = asyncio.run(pixiv.anima_gallery_pixiv_image(request))
    assert response.status == 400
    assert "pximg.net" in json.loads(response.body)["error"]


# ── 6. 协议层契约（duck typing：search / capabilities / id） ──────────────────────
def test_source_capabilities_match_plan_and_support_both_read_styles():
    source = pixiv.PixivSource()
    expected = {"tags": True, "prompt": False, "nsfw": True, "login": True}
    assert dict(source.capabilities) == expected  # 属性读法
    assert source.capabilities() == expected  # 方法读法（协议层两种写法都可能）
    assert source.id == "pixiv" and source.label == "P站"
    assert pixiv.SOURCE_ID == "pixiv"


def test_source_search_signature_tolerates_the_documented_call_shapes(monkeypatch):
    """§3 的 `search(query, cursor/page, filters) -> (items, next_cursor)` 有若干合理写法，
    适配器必须全都接住（协议层不接受"你只能按我想的方式调"）。"""
    write_token()
    session = install_session(monkeypatch, FakeSession(responses=[search_response(next_url=None)] * 5))
    source = pixiv.PixivSource()

    items, cursor = source.search("初音ミク")
    assert items and cursor is None
    assert session.calls[-1]["params"]["word"] == "初音ミク"

    source.search("初音ミク", "30")
    assert session.calls[-1]["params"]["offset"] == 30

    source.search("初音ミク", cursor="30", filters={"sort": "date_asc", "limit": 10})
    assert session.calls[-1]["params"]["offset"] == 30
    assert session.calls[-1]["params"]["sort"] == "date_asc"

    source.search(query="初音ミク", word="", page=2, target="exact_match_for_tags")
    assert session.calls[-1]["params"]["offset"] == 30
    assert session.calls[-1]["params"]["search_target"] == "exact_match_for_tags"

    source.search(word="初音ミク", filters={"user_id": "12345"})
    assert session.calls[-1]["url"] == pixiv.PIXIV_USER_ILLUSTS_URL
    assert session.calls[-1]["params"]["user_id"] == "12345"


def test_user_illusts_endpoint_supports_artist_filter(monkeypatch):
    """§5.7：按画师过滤要走 /v1/user/illusts（search 不支持画师条件）。"""
    write_token()
    session = install_session(monkeypatch, FakeSession(responses=[search_response(next_url=None)]))
    items, _ = pixiv.search_illusts(user_id="12345")
    assert len(items) == 1
    assert session.calls[0]["url"] == pixiv.PIXIV_USER_ILLUSTS_URL


def test_get_source_entry_points():
    assert isinstance(pixiv.get_source(), pixiv.PixivSource)
    assert pixiv.SOURCE.id == "pixiv"
    assert pixiv.CAPABILITIES["login"] is True


def test_diag_masks_proxy_credentials_before_returning_to_frontend(monkeypatch):
    """🟡 评审发现（安全问题）：`/diag` 回显代理解析结果时，若 `HTTP_PROXY` 带 userinfo
    （`http://user:pass@host:port`），凭据会直达前端 —— 前端只按 key 名过滤，挡不住 URL 里的 userinfo。
    必须在回显前掩码，不依赖前端自觉。"""
    monkeypatch.delenv("PIXIV_PROXY_CONFIG", raising=False)
    # ⚠️ Windows 的 os.environ 大小写不敏感：setenv("HTTPS_PROXY") 之后若再 delenv("https_proxy")，
    # 会把刚设的那个删掉。所以先清、后设，小写形式不要再动。
    monkeypatch.setenv("HTTP_PROXY", "http://alice:s3cr3t@127.0.0.1:7890")
    monkeypatch.setenv("HTTPS_PROXY", "http://bob:hunter2@127.0.0.1:7890")

    response = asyncio.run(pixiv.anima_gallery_pixiv_diag(make_mocked_request("GET", "/diag")))
    raw = response.body.decode("utf-8")
    assert response.status == 200
    for secret in ("alice", "s3cr3t", "bob", "hunter2"):
        assert secret not in raw, f"diag 回包泄露了代理凭据：{secret}"
    assert "***:***@127.0.0.1:7890" in raw  # 掩码生效（host:port 仍可用于排查）
    payload = json.loads(raw)
    assert payload["resolved_proxies"]["https"].endswith("@127.0.0.1:7890")
    assert all("@" not in str(candidate["https"]).split("//")[0] for candidate in payload["proxy_candidates"])


def test_mask_proxy_url_hides_userinfo_but_keeps_host():
    assert pixiv._mask_proxy_url("http://user:pass@127.0.0.1:7890") == "http://***:***@127.0.0.1:7890"
    assert pixiv._mask_proxy_url("socks5://u:p@proxy.local:1080") == "socks5://***:***@proxy.local:1080"
    assert pixiv._mask_proxy_url("user:pass@127.0.0.1:7890") == "***:***@127.0.0.1:7890"
    # 无凭据的代理 URL 原样保留（不能把正常排查信息也抹掉）
    assert pixiv._mask_proxy_url("http://127.0.0.1:7890") == "http://127.0.0.1:7890"
    assert pixiv._mask_proxy_url("") == ""
    assert pixiv._mask_proxy_url(None) is None


# ── 7. SNI 绕行（离线验证改写逻辑；真实握手需要网络，属"未验证部分"） ──────────────
def test_sni_rewrite_connects_to_ip_but_keeps_host_and_sni():
    adapter = pixiv._SNIHostAdapter({"app-api.pixiv.net": "1.2.3.4"})
    request = pixiv.requests.Request(
        "GET", "https://app-api.pixiv.net/v1/search/illust?word=x", headers={"Referer": pixiv.PIXIV_REFERER}
    ).prepare()

    assert pixiv.apply_sni_rewrite(adapter, request) is True
    assert request.url.startswith("https://1.2.3.4/")  # TCP 连 IP
    assert request.headers["Host"] == "app-api.pixiv.net"  # Host 仍是域名
    # 连接池默认参数注入 → urllib3 用它做 TLS SNI 与证书校验
    pool_kwargs = adapter.poolmanager.connection_pool_kw
    assert pool_kwargs["server_hostname"] == "app-api.pixiv.net"
    assert pool_kwargs["assert_hostname"] == "app-api.pixiv.net"


def test_sni_rewrite_leaves_unknown_hosts_untouched():
    adapter = pixiv._SNIHostAdapter({"app-api.pixiv.net": "1.2.3.4"})
    request = pixiv.requests.Request("GET", "https://example.com/x").prepare()
    assert pixiv.apply_sni_rewrite(adapter, request) is False
    assert request.url == "https://example.com/x"
    assert "server_hostname" not in adapter.poolmanager.connection_pool_kw


def test_sni_mode_reads_env_switch(monkeypatch):
    monkeypatch.delenv("PIXIV_SNI_BYPASS", raising=False)
    assert pixiv._sni_mode() == "auto"
    for raw, expected in (("off", "off"), ("0", "off"), ("on", "on"), ("1", "on"), ("auto", "auto")):
        monkeypatch.setenv("PIXIV_SNI_BYPASS", raw)
        assert pixiv._sni_mode() == expected


def test_sni_bypass_reports_failure_loudly_when_no_ip_resolves(monkeypatch, capsys):
    """解析不到 IP 时必须打清晰日志并返回 False（**不能**静默直连装作没事）。"""
    monkeypatch.setattr(pixiv, "_resolve_host_ip", lambda host: "")
    monkeypatch.setattr(pixiv, "_sni_installed_hosts", set())
    assert pixiv._install_sni_bypass("测试触发") is False
    printed = capsys.readouterr().out
    assert "[P站画廊·SNI]" in printed and "PIXIV_SNI_IPS" in printed


# ── 8. 路由注册（事实：协议层不注册路由，各源各自注册具体路径 + 注册前让路去重） ──────
def fake_server(routes):
    """把模块看到的 PromptServer 换成持有给定路由表的假 server。"""
    instance = type("Instance", (), {"routes": routes})()
    return type("Server", (), {"instance": instance})()


def test_own_specific_routes_load_cleanly_alongside_an_unrelated_wildcard(monkeypatch):
    """本模块 7 条**具体路径**路由能安全加入真实 aiohttp app
    （协议层 `anima_gallery_sources.py` 不注册路由，所以这些具体路由就是正常注册路径，不是兜底）。

    顺带证明：即便将来别处加了一条 `{source}` 通配路由，它与具体路径是两个不同 resource，
    共存不冲突。⚠️ 关键防线是：`RouteTableDef` 装饰器阶段**不去重**，重复条目要到
    `app.add_routes()` 才抛 `RuntimeError: Added route will never be executed...` ——
    那一刻模块早已加载完，兜不住，表现就是 ComfyUI 启动直接崩。
    """
    routes = web.RouteTableDef()

    @routes.get("/anima/gallery/{source}/search")
    async def unrelated_wildcard(request):  # noqa: ARG001
        return web.json_response({})

    monkeypatch.setattr(pixiv, "PromptServer", fake_server(routes))
    registered = pixiv.register_routes()
    assert len(registered) == 7

    app = web.Application()
    app.add_routes(routes)  # 有重复 method+path 的话这里会炸
    assert len(routes) == 8


def test_duplicate_specific_route_is_skipped_instead_of_duplicated(monkeypatch, capsys):
    """同一具体路径被注册两次时必须让路（跳过而不是再加一条）。"""
    routes = web.RouteTableDef()

    @routes.get("/anima/gallery/pixiv/search")
    async def already_registered(request):  # noqa: ARG001
        return web.json_response({})

    monkeypatch.setattr(pixiv, "PromptServer", fake_server(routes))
    assert pixiv._register_route("get", "/anima/gallery/pixiv/search", pixiv.anima_gallery_pixiv_search) is False
    assert len(routes) == 1
    web.Application().add_routes(routes)  # 没有重复 → 仍可安全加入
    assert "跳过重复注册" in capsys.readouterr().out


def test_route_registration_swallows_runtime_errors(monkeypatch, capsys):
    """路由表实现若在装饰器阶段就抛 RuntimeError，也必须被吃掉（插件加载不许失败）。"""
    class BoomRoutes:
        def get(self, path):
            raise RuntimeError("Added route will never be executed, method GET is already registered")

        post = get

    monkeypatch.setattr(pixiv, "PromptServer", fake_server(BoomRoutes()))
    assert pixiv._register_route("get", "/anima/gallery/pixiv/search", pixiv.anima_gallery_pixiv_search) is False
    assert "未注册" in capsys.readouterr().out


def test_route_registration_survives_missing_prompt_server(monkeypatch, capsys):
    """PromptServer.instance 尚不可用（加载顺序问题）时也不能抛。"""
    monkeypatch.setattr(pixiv, "PromptServer", type("Server", (), {"instance": None})())
    assert pixiv._register_route("get", "/anima/gallery/pixiv/search", pixiv.anima_gallery_pixiv_search) is False
    assert "跳过" in capsys.readouterr().out


def test_registered_routes_cover_the_plan_contract(monkeypatch):
    registered: list[tuple[str, str]] = []

    class RecordingRoutes:
        def _record(self, method, path):
            registered.append((method, path))
            return lambda fn: fn

        def get(self, path):
            return self._record("get", path)

        def post(self, path):
            return self._record("post", path)

    class RecordingServer:
        instance = type("S", (), {"routes": RecordingRoutes()})()

    monkeypatch.setattr(pixiv, "PromptServer", RecordingServer)
    paths = pixiv.register_routes()
    assert "/anima/gallery/pixiv/auth/url" in paths
    assert "/anima/gallery/pixiv/auth/code" in paths
    assert "/anima/gallery/pixiv/auth/status" in paths
    assert "/anima/gallery/pixiv/search" in paths
    assert "/anima/gallery/pixiv/image" in paths
    assert ("post", "/anima/gallery/pixiv/auth/code") in registered


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
