"""多源画廊（D站 / C站 / P站）前端契约锁。

锁的是四件事（PLAN docs/PLAN-2026-09-15-P站C站画廊接入.md §5.3/§5.4/§5.5/§5.6）：
  ① 源切换存在，且 **D站 分支一个字节都没改**（老路由 /anima/danbooru/posts + page 分页）；
  ② capabilities 驱动隐藏/禁用（C站 tags=false、P站 prompt=false/login=true）——
     不适用就当死控件的做法被禁止；
  ③ C站/P站 走 cursor + next_cursor，D站 保持 page 分页；
  ④ 图片一律经 /anima/gallery/{source}/image（前端不许直连第三方 CDN）；
  ⑤ 选中态**不再有发光 box-shadow**（用户 2026-09-15：现代、去 AI 感、不发光）。

这些都是**静态回归锁**（源码切片断言），不需要浏览器/后端。

⚠️ 新增测试文件后必须重新生成分层清单，否则 tests/test_layer_manifest.py 会 FAIL：
    python -X utf8 tests/tools/classify_tests.py
（由协调者统一执行 —— 本轮的 agent 被明确禁止跑它，避免三方互相覆盖。）
"""
from pathlib import Path

import re


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "js" / "anima_danbooru_gallery_widget.js"
STYLES = ROOT / "web" / "css" / "anima_danbooru_gallery.css"


def _js() -> str:
    return SOURCE.read_text(encoding="utf-8")


def _css() -> str:
    return STYLES.read_text(encoding="utf-8")


def _css_code() -> str:
    """去掉注释后的 CSS 正文。

    「发光必须死」的断言只看**生效的声明**：注释里引述旧值（`0 0 22px rgba(125,92,255,…)`）
    恰恰是要留下的证据，不该把注释本身当成复活。
    """
    return re.sub(r"/\*.*?\*/", "", _css(), flags=re.S)


def _rule(css: str, selector: str) -> str:
    """取出某条规则（到第一个右花括号）的正文，便于只对该规则做断言。"""
    start = css.index(selector)
    return css[start:css.index("}", start)]


# ────────────────────────── ① 源切换 + D站 分支未动 ──────────────────────────

def test_source_switcher_exists_and_danbooru_search_branch_is_untouched():
    js = _js()
    # 源清单与切换入口
    assert 'const DANBOORU_SOURCE_ID = "danbooru";' in js
    assert 'GALLERY_SOURCE_ORDER = Object.freeze([DANBOORU_SOURCE_ID, "civitai", "pixiv"])' in js
    assert "async switchGallerySource(nextId)" in js
    assert "this.switchGallerySource(select.value)" in js
    # 工具条里确实有一个「图源」下拉（label + select，且用新类名，不占 .adg-toolbar-group）
    assert 'select.setAttribute("aria-label", "图源")' in js
    assert 'picker.className = "adg-source-picker"' in js
    assert "mainGroup.append(picker)" in js
    # 新容器**不能**用 adg-toolbar-group：verify_tk_prompt_output.py 断言分组数恰为 4
    assert 'className = "adg-toolbar-group adg-source-picker"' not in js

    # D站 搜索体：从「多源分流」到 applyActiveCategory 之间必须保持原实现
    branch = js.index("if (!this.isDanbooruSource()) return this.searchGallerySource")
    danbooru_body = js[branch:js.index("async applyActiveCategory", branch)]
    assert "`/anima/danbooru/posts?${parameters}`" in danbooru_body, "D站 仍须走老路由"
    assert "tags: query," in danbooru_body
    assert "page: String(this.page)," in danbooru_body, "D站 仍是 page 分页"
    assert "force: force ? \"1\" : \"0\"," in danbooru_body
    assert "countedSearchTerms(query)" in danbooru_body, "D站 的计数标签上限逻辑不能丢"
    assert "this.fuzzyRetry(query)" in danbooru_body, "D站 的模糊纠错不能丢"
    # D站 的图片代理仍是老路由
    assert "return `/anima/danbooru/image?url=${encodeURIComponent(source)}`;" in js
    # 分流必须是「非 D站 才换路」，且 isDanbooruSource 只认 danbooru
    assert "isDanbooruSource() {\n      return this.activeSourceId() === DANBOORU_SOURCE_ID;" in js
    assert 'GALLERY_SOURCE_ORDER.includes(id) ? id : DANBOORU_SOURCE_ID' in js


def test_danbooru_only_chrome_is_hidden_for_other_sources():
    """随机发现（order:random）、D站 筛选、分类浏览都是 D站 语义 → 换源必须收起。"""
    js = _js()
    body = js[js.index("applySourceCapabilities() {"):js.index("buildSourceFilterControls() {")]
    # 分级/筛选是 Danbooru metatag：P站 的 tags=true 是日文标签体系，照样吃不下 rating:/score:
    assert "const tagFiltersApplicable = isDanbooru && caps.tags;" in body
    assert "this.filterControls.ratingDropdown.element.hidden = !tagFiltersApplicable" in body
    assert "this.filterControls.filterDropdown.element.hidden = !tagFiltersApplicable" in body
    assert "this.filterControls.categoryDropdown.element.hidden = !isDanbooru" in body
    assert "for (const button of this.randomTierButtonList || []) button.hidden = !isDanbooru" in body
    assert "this.randomReshuffleBtn.hidden = !isDanbooru" in body
    # D站 的 Danbooru tag 联想（/anima/danbooru/suggest）不该对着 C站/P站 弹
    assert "if (!this.isDanbooruSource()) {\n        this.hideSuggestions();\n        return;\n      }" in js


# ────────────────────────── ② capabilities 驱动 ──────────────────────────

def test_capabilities_are_the_only_switch_for_control_visibility():
    js = _js()
    # 兜底表数值 = 契约钉死的值（含协调者 2026-09-15 拍板新增的第 5 键 query）
    assert "civitai: { id: \"civitai\", label: \"C站\", capabilities: { tags: false, prompt: true, nsfw: true, login: false, query: false } }" in js
    assert "pixiv: { id: \"pixiv\", label: \"P站\", capabilities: { tags: true, prompt: false, nsfw: false, login: true, query: true } }" in js
    assert "login: false, query: true } }" in js, "D站 兜底也要声明 query:true"
    # 能力表来自契约路由 /anima/gallery/sources
    assert 'fetch("/anima/gallery/sources")' in js
    assert "loadGallerySources()" in js
    # prompt=false（P站）→ 卡片上的 Prompt / 入库 两个动作与工具条 Prompt 控件一起收起
    assert "const promptActionsApplicable = postCaps.prompt || !isGallerySource;" in js
    assert "promptAction.hidden = true;" in js and "libraryAction.hidden = true;" in js
    assert "this.promptSettingsBtn.hidden = !promptApplicable" in js
    assert "this.promptOutputBtn.hidden = !promptApplicable" in js
    # tags=false（C站）→ 排除标签输入框禁用，而不是留个填了没用的框
    assert "const excludeApplicable = this.isDanbooruSource();" in js
    assert "exclInput.disabled = true;" in js and "exclAdd.disabled = true;" in js


def test_query_capability_drives_the_search_hint_not_the_source_name():
    """协调者 2026-09-15：C站 上游 /api/v1/images **忽略全部关键词参数**（实测 7 个参数名），
    后端只在当页内本地过滤 —— 前端必须如实说明，且判断依据是 capabilities.query，不是源名。"""
    js = _js()
    caps = js[js.index("sourceCapabilities(sourceId = null) {"):js.index("async loadGallerySources() {")]
    assert "query: caps.query !== false," in caps
    body = js[js.index("applySourceCapabilities() {"):js.index("buildSourceFilterControls() {")]
    assert "this.queryInput.placeholder = caps.query" in body, "文案必须由 caps.query 决定"
    assert "GALLERY_LOCAL_QUERY_PLACEHOLDER" in body
    assert 'civitai' not in body.split("this.queryInput.placeholder")[1].split(";")[0], "不许按源名硬编码"
    assert 'this.queryInput.dataset.queryMode = caps.query ? "server" : "local";' in body
    # 筛选条尾部的说明行
    assert "hint.hidden = caps.query;" in js
    assert "GALLERY_LOCAL_QUERY_HINT" in js
    assert "上游接口不支持关键词检索" in js


def test_backend_warnings_are_surfaced_to_the_user():
    """后端回包的 warnings 是"必须让用户看见"的通道（例如 C站 关键词没生效）——
    只写状态栏还不够，空结果时网格里也要写一格，否则用户以为搜了没反应。"""
    js = _js()
    search = js[js.index("async searchGallerySource("):js.index("async stepGalleryCursor(")]
    assert "Array.isArray(data?.warnings)" in search
    assert "const notices = [...warnings];" in search, "warnings 要排在其他提示前面"
    assert "this.appendGridNotice(warnings.join" in search


def test_pixiv_availability_is_distinct_from_login_state_and_diag_entry_exists():
    """secrets 回包：pixiv.available=false = 模块没装；true+logged_in=false = 装了没登录。
    两种文案必须分开，且"去授权"在没装时要禁用（不留点了报错的按钮）。"""
    js = _js()
    section = js[js.index("refreshGallerySecretState() {"):js.index("openSettings() {")]
    assert "state.pixiv.available = data.pixiv.available !== false;" in section
    status = js[js.index("pixivStatusText(info = {}) {"):js.index("async renderCivitaiDiag(")]
    assert "后端未安装 P站 模块" in status
    assert "未授权：P站 没有匿名搜索" in status
    assert "pixivAuth.disabled = !available;" in section
    # 没装时不发必然失败的搜索
    switch = js[js.index("async switchGallerySource(nextId) {"):js.index("applySourceCapabilities() {")]
    assert "this.gallerySecretState?.pixiv?.available === false" in switch
    # C站 诊断入口
    assert 'fetch("/anima/gallery/civitai/diag")' in js
    diag = js[js.index("async renderCivitaiDiag(target) {"):js.index("makeSecretStatusRow(label) {")]
    assert "token|secret|verifier|password" in diag, "诊断输出必须过滤敏感键名"
    assert "已隐藏" in diag


def test_gallery_items_carry_file_ext_so_mp4_gets_the_video_badge():
    """C站 会返回 type:"video" 的 mp4 条目：按 D站 同样的方式处理（原样代理 + 「视频」角标）。"""
    js = _js()
    assert "function galleryFileExt(url, fallback = \"jpg\")" in js
    mapper = js[js.index("galleryItemToPost(item, sourceId) {"):js.index("async searchGallerySource(")]
    assert "file_ext: galleryFileExt(full || preview)," in mapper
    # isVideoPost 认 file_ext=mp4 与 .mp4 结尾的 URL（D站 原逻辑，未改）
    assert "return String(post.file_ext || \"\").toLowerCase() === \"mp4\"" in js
    assert "isVid ? \" · MP4\" : \"\"" in js and 'badge.textContent = "视频"' in js


# ────────────────────────── ③ 分页：cursor vs page ──────────────────────────

def test_cursor_pagination_for_new_sources_and_page_pagination_for_danbooru():
    js = _js()
    params = js[js.index("gallerySearchParams(sourceId, query) {"):js.index("readGalleryResponse(response) {")]
    assert 'params.set("cursor",' in params, "C站/P站 用 cursor"
    assert "page" not in params, "新源不能混进 page 参数（契约：分页一律 cursor）"
    search = js[js.index("async searchGallerySource("):js.index("async stepGalleryCursor(")]
    assert "/anima/gallery/${encodeURIComponent(sourceId)}/search?${parameters}" in search
    assert "data?.next_cursor" in search, "回包字段是 next_cursor"
    assert "this.nextCursor = null" in js and "this.cursorStack" in js
    assert "async stepGalleryCursor(delta)" in js
    # D站 的分页渲染仍是页码窗口 + 页码输入框
    pagination = js[js.index("renderPagination() {"):js.index("async choosePromptSaveOptions(")]
    assert "for (const page of this.pageWindow())" in pagination
    assert 'input.type = "number"; input.min = "1"; input.value = String(this.page);' in pagination
    # 新源只给上一批/下一批，不给页码输入
    cursor_ui = pagination[:pagination.index("for (const page of this.pageWindow())")]
    assert "第 ${batch} 批" in cursor_ui
    assert "type = \"number\"" not in cursor_ui
    # 游标按钮要躲开 .adg-pagination button 的固定 24px 宽（否则文字被挤成竖排）
    assert 'previous.className = "adg-cursor-step"' in cursor_ui
    assert 'next.className = "adg-cursor-step"' in cursor_ui
    assert ".adg-pagination button.adg-cursor-step { width: auto" in _css_code()


# ────────────────────────── ④ 图片一律走后端代理 ──────────────────────────

def test_every_gallery_image_goes_through_the_source_proxy():
    js = _js()
    assert "`/anima/gallery/${encodeURIComponent(active)}/image?url=${encodeURIComponent(gallerySource)}`" in js
    # 预览图（缩略图）也走代理，且按卡片自己的源路由
    assert "preview.dataset.src = this.imageProxyUrl(previewUrl, post.md5, postSourceId);" in js
    # 大图预览与保存到 Prompt 库的缩略图同样是代理
    preview = js[js.index("openImagePreview(post) {"):js.index("async openPromptEditor(")]
    assert "image.src = this.imageProxyUrl(imageUrl, \"\", sourceId);" in preview
    assert "image.src = `/anima/danbooru/image" not in preview
    library = js[js.index("async saveToPromptLibrary(post,"):js.index("async showPromptTooltip(")]
    assert "this.imageProxyUrl(imageUrl, \"\", this.postSourceId(post))" in library


def test_pixiv_download_prefers_full_url_for_wd14_reverse_lookup():
    """P站 图是素材输入：下载必须拿 original（full_url），不是缩略图。"""
    js = _js()
    download = js[js.index("async downloadPost(post) {"):js.index("isVideoPost(post) {")]
    assert "post.full_url || post.large_file_url || post.file_url || post.preview_url || post.preview_file_url" in download
    assert "const prefix = isGallerySource ? sourceId : \"danbooru\";" in download
    assert "this.imageProxyUrl(imageUrl, \"\", sourceId)" in download
    # item schema（PLAN §5.2）→ 内部 post 的映射必须带上 full_url 与 prompt/negative_prompt
    mapper = js[js.index("galleryItemToPost(item, sourceId) {"):js.index("async searchGallerySource(")]
    for key in ("preview_url", "full_url", "tags", "prompt", "negative_prompt", "source_url", "meta"):
        assert f"item?.{key}" in mapper or f"item.{key}" in mapper, f"item schema 缺 {key}"
    assert "full_url: full," in mapper


# ────────────────────────── ⑤ 视觉：发光必须死 ──────────────────────────

def test_selected_card_has_no_glow_anywhere():
    css = _css()
    code = _css_code()   # 只看生效声明（注释里引述旧发光值是有意留下的证据）
    selected = _rule(code, ".adg-card.is-selected {")
    assert "box-shadow: none" in selected, "选中态必须显式 box-shadow: none"
    assert "border-width: 2px" in selected, "选中 = 边框加粗（实边框 + 底色差）"
    assert "color-mix" in selected, "底色加深走主题变量"
    # 被点名干掉的那两条发光值不许复活（生效声明层面）
    assert "0 0 22px" not in code, "紫色光晕（0 0 22px rgba(125,92,255,…)）必须已被删掉"
    assert "rgba(125,92,255" not in code
    assert "rgba(94,106,210" not in code, "弹层里的彩色 glow 也要清掉"
    assert "0 0 32px" not in code and "0 0 46px" not in code
    # 卡片基座：1px 边框 + 主题变量（不是 2px + 硬编码 + 阴影）
    card = _rule(code, ".adg-card {")
    assert "border: 1px solid var(--adg-line" in card
    assert "box-shadow" not in card
    # 工具条 hover 不许再带投影/发光（只做底色微亮 + ≤2px 位移）
    hover = _rule(code, ".adg-toolbar button:hover,")
    assert "box-shadow" not in hover
    assert "translateY(-1px)" in hover
    # 主题变量桥接必须存在（浅色主题下硬编码灰阶不可读）
    container = _rule(code, ".anima-danbooru-gallery {")
    for var in ("--fg-color", "--descrip-text", "--border-color", "--comfy-input-bg", "--p-primary-color"):
        assert var in container, f"缺少主题变量桥接 {var}"
    # 圆角统一到 6/8
    assert "border-radius: 12px" not in code, "圆角统一 6–8px，弹窗不该留 12px"
    # 内联 SVG 图标（禁 emoji）：图标工厂用 createElementNS，不塞 emoji
    assert 'const ns = "http://www.w3.org/2000/svg";' in _js()
    assert "galleryIcon(" in _js()


def test_card_actions_hidden_state_still_swallows_no_clicks():
    """误触回归锁的邻接检查：这次视觉改动不许碰 pointer-events / focus-within / 触摸屏兜底。"""
    css = _css()
    actions_css = css[css.index(".adg-card-actions"):css.index(".adg-prompt-tooltip")]
    assert "pointer-events: none" in actions_css
    assert "pointer-events: auto" in actions_css
    assert ":focus-within" in actions_css
    assert "@media (hover: none)" in actions_css
    assert "flex-wrap: wrap" in actions_css and "max-width" in actions_css


def test_hidden_attribute_actually_hides_toolbar_controls():
    """⚠️ 2026-09-15 浏览器实测踩到的坑：capabilities 驱动的"隐藏"必须真的不显示。

    `.adg-dropdown-trigger { display: inline-flex }`（类选择器）会盖掉 UA 的
    `[hidden] { display: none }`（属性选择器）—— JS 里 `el.hidden = true` 成立、
    视觉上控件还在工具条上（截图里 C站 仍能看到 D站 的「分级 / 筛选」下拉）。
    这条守卫删掉即回归。
    """
    css = _css_code()
    assert ".adg-toolbar [hidden]," in css
    assert ".adg-source-filters [hidden]" in css
    guard = css[css.index(".adg-toolbar [hidden],"):]
    assert "display: none;" in guard[:200]
    # 触发器确实会跟 [hidden] 抢 display，所以守卫不能省
    assert "display: inline-flex" in _rule(css, ".adg-dropdown-trigger {")


# ────────────────────────── 密钥 UI（PLAN §5.5）──────────────────────────

def test_source_secret_section_uses_contract_routes_and_never_echoes_plaintext():
    js = _js()
    # 状态读取与区块渲染合起来看（refreshGallerySecretState 是区块的数据源）
    section = js[js.index("refreshGallerySecretState() {"):js.index("openSettings() {")]
    assert 'fetch("/anima/gallery/secrets")' in section, "GET 读掩码"
    assert 'fetch("/anima/gallery/secrets", {' in section and 'method: "POST"' in section
    assert 'body: JSON.stringify({ source: "civitai", key: String(key || "") })' in section
    assert 'fetch("/anima/gallery/secrets/test", {' in section, "测试按钮"
    assert 'fetch("/anima/gallery/pixiv/auth/url")' in section
    assert 'fetch("/anima/gallery/pixiv/auth/code", {' in section
    assert "body: JSON.stringify({ code, verifier: this.pixivVerifier || \"\" })" in section
    assert 'fetch("/anima/gallery/pixiv/auth/status")' in section
    # 只显示掩码：掩码来自后端字段，保存后立刻清空输入框
    assert "state.civitai.masked = String(data?.civitai?.masked || \"\")" in js
    assert "civitaiInput.value = \"\";" in section
    assert "civitaiInput.type = \"password\"" in section
    # 明文不许被写进任何 dataset / title / 日志
    assert "dataset.civitaiKey" not in js and "dataset.apiKey" not in js
    assert "console.log" not in section
    # 状态点用 SVG/边框，不用 emoji 字符
    assert "adg-secret-dot" in section
    for emoji in ("🔑", "✅", "❌", "🔒", "🎨", "🖼"):
        assert emoji not in section, f"禁 emoji：{emoji}"


def test_civitai_sort_options_only_use_upstream_legal_values():
    """PLAN §6 实测：C站 `sort` 合法值只有
    `Most Reactions / Most Comments / Most Collected / Newest / Oldest / Random`，
    其它（如 `Relevance` / `Most Recent`）上游回 400 ZodError —— 下拉里绝不能出现非法值。"""
    js = _js()
    options = js[js.index("const CIVITAI_SORT_OPTIONS"):js.index("const PIXIV_TARGET_OPTIONS")]
    legal = {"Newest", "Oldest", "Most Reactions", "Most Comments", "Most Collected", "Random"}
    found = re.findall(r'\["([^"]+)", "', options)
    assert set(found) == legal, f"C站排序值超出上游合法集：{sorted(set(found) ^ legal)}"
    for illegal in ("Most Recent", "Relevance"):
        assert f'["{illegal}"' not in js
    # 默认值与回填都必须落在合法集内
    assert 'sort: pick(CIVITAI_SORT_OPTIONS, civitai.sort, "Newest")' in js
    assert 'params.set("sort", String(f.sort || "Newest"));' in js
    assert 'civitaiSort.value = f.sort || "Newest";' in js


def test_civitai_meta_uses_base_model_and_key_is_not_an_nsfw_switch():
    """PLAN §6：① `meta.Model` 不存在 → 只显示条目级 `baseModel`；
    ② C站 key 对 /images 无影响（匿名也能读 Mature/X）→ 文案不能说"不带 key 只能看 Soft"。"""
    js = _js()
    extra = js[js.index("buildGalleryTooltipExtra(card) {"):js.index("async downloadPost(post) {")]
    assert "meta.baseModel" in extra
    # 只看**代码形态**：注释里引述作废字段名是有意留下的证据，不该当成复活
    assert 'push("底模", meta.baseModel || meta.model);' in extra
    assert "|| meta.Model" not in extra and "meta.Model ??" not in extra
    assert "Mature/X 需要 API Key" not in js
    assert "不带 C站 key 只能看 None / Soft 两档" not in js
    section = js[js.index("buildSourceSecretsSection() {"):js.index("openSettings() {")]
    assert "账号校验" in section and "/api/v1/me" in section


def test_taller_resize_fetches_more_only_when_underfilled_and_more_exists():
    """2026-09-15 用户真机反馈：「画廊底部拖拽但是没有加载新的图片挤进来」。

    根因：纵向拉大不改变列数，而旧 handleGridResize 只在 `cols !== lastCols` 时重取 ⇒ 拉高永不补图。
    修法要同时满足四条克制条件：① 只在自适应张数模式；② 只在明显填不满；③ 450ms 防抖；
    ④ 末批（无 more）不再打接口。任何一条丢了都会变成"拖一下打一堆请求"。
    """
    js = _js()
    resize = js[js.index("handleGridResize() {"):js.index("noteTallerResize() {")]
    # 列数变化仍走原路（重取一页），纵向拉大走补图
    assert "const changed = this.lastCols && cols !== this.lastCols;" in resize
    assert "const grewTaller = this.noteTallerResize();" in resize
    assert "if (!changed && !grewTaller) return;" in resize
    assert "if (!this.autoLimit()) return;" in resize, "固定张数模式不得打扰用户"
    assert "if (this.resizeSearchTimer) clearTimeout(this.resizeSearchTimer);" in resize, "复用 450ms 防抖"
    assert "}, 450);" in resize
    assert "this.search({ resetPage: true });" in resize, "列数变化：原行为（重取一页）"
    assert "void this.fillMoreForHeight();" in resize, "纵向拉大：补图填满"

    fill = js[js.index("async fillMoreForHeight() {"):js.index("autoLimit() {")]
    assert "if (this.disposed || this.fillMoreBusy || this.fillMoreExhausted) return;" in fill
    assert "if (!this.autoLimit()) return;" in fill, "固定张数模式不取"
    assert "if (!this.gridUnderfilled()) return;" in fill, "填满了就不取"
    assert "if (!this.isDanbooruSource() && !this.nextCursor)" in fill, "末批：无 next_cursor 就别取"
    assert "this.fillMoreExhausted = true;" in fill
    assert "this.page += 1;" in fill, "D站：page 前进（老路由未动）"
    assert "await this.stepGalleryCursor(1);" in fill, "C站/P站：cursor 前进"
    assert "const merged = [...before, ...fetched.filter" in fill, "结果追加，不重置用户翻到的位置"

    under = js[js.index("gridUnderfilled(targetHeight = 0) {"):js.index("async fillMoreForHeight() {")]
    assert "this._layoutTotal" in under and "this.grid?.clientHeight" in under
    assert "DG_UNDERFILL_RATIO" in under
    # 分母必须是网格自己的视口，不能是 root（root 还含 toolbar/status 等固定 chrome，会恒判填不满）
    assert "root.clientHeight" not in under
    assert "const DG_UNDERFILL_RATIO = 0.9;" in js

    taller = js[js.index("noteTallerResize() {"):js.index("gridUnderfilled(targetHeight = 0) {")]
    assert "DG_TALLER_MIN_DELTA" in taller and "DG_TALLER_MIN_RATIO" in taller
    assert "this.lastVisibleHeight = visible;" in taller
    # 新结果集要重新允许补图与自动补满（否则上次到底会把后续搜索也锁死）
    assert js.count("this.autoFillRounds = 0;\n        this._autoFillTarget = 0;") == 2, (
        "D站 与画廊源两条搜索入口都要重置补图状态"
    )


def test_render_schedules_autofill_until_grid_is_filled():
    """2026-09-16 用户真机反馈：「还是填充不满节点，用一半以上的空位」。

    根因：补图原先只在 handleGridResize（列数变化 / 纵向拉大）里触发，首屏与翻页后
    即便明显没填满也无人过问。现在 renderPosts 收尾会调度一次自动补满，并链式补到
    填满 / 取空 / 达到轮次上限；「填满」的判据改用**最矮列**（只看最高列会掩盖列间参差）。
    """
    js = _js()
    render = js[js.index("renderPosts() {"):js.index("pageWindow() {")]
    assert "this.scheduleAutoFill();" in render, "渲染完必须检查一次填满没有"

    auto = js[js.index("scheduleAutoFill() {"):js.index("autoLimit() {")]
    assert "}, 80);" in auto, "等一拍再判：applyMasonryLayout 由 rAF 调度"
    assert "async autoFillIfUnderfilled() {" in auto
    assert "if (!this.autoLimit() || !this.posts.length) return;" in auto
    assert "if (this.autoFillRounds >= DG_AUTO_FILL_MAX_ROUNDS) return;" in auto, (
        "轮次上限：图池取不空时也不能无限打接口"
    )
    assert "if (!this.gridUnderfilled(target)) return;" in auto, "填满了就不补（判据用锁定的目标高度）"
    assert "await this.fillMoreForHeight();" in auto, "复用既有补图路径（D站 page+1 / C站P站 cursor 前进）"
    assert "const DG_AUTO_FILL_MAX_ROUNDS = 1;" in js, "渲染后最多补一批，杜绝「一直扩充」"
    # 防「无限变大、一直扩充」（2026-09-16 用户真机实测）：
    # 目标高度锁死（不用会被内容拉扯的 clientHeight）+ 时间窗限流（不受重置影响）+ 补完钉回尺寸
    assert "autoFillTargetHeight() {" in js
    assert "const target = this.autoFillTargetHeight();" in auto
    assert "if (this._autoFillWindowCount >= DG_AUTO_FILL_MAX_PER_WINDOW) return;" in auto
    # ⚠️ 补图**绝不能**用 setSize 把尺寸钉回去：那会和用户的拖动打架
    #    （2026-09-16 实测："我一要缩小节点，就放大多次"）
    assert "this.setGridHeight(target)" not in auto
    assert "if (this.userResizedAt && now - this.userResizedAt < DG_USER_RESIZE_GRACE_MS) return;" in auto, (
        "用户刚动过尺寸时要静默，不抢尺寸"
    )

    resize = js[js.index("handleGridResize() {"):js.index("noteTallerResize() {")]
    assert "const keepRounds = this.autoFillRounds;" in resize, (
        "列数变化是尺寸引起的，不能借它重置补图预算（否则「撑大→列数变→重置→再补」死循环）"
    )

    note = js[js.index("noteExternalResize() {"):js.index("handleGridResize() {")]
    assert "this._autoFillTarget = 0;" in note, "用户改尺寸 = 新目标，要解锁（否则缩小后又被钉回旧尺寸）"

    under = js[js.index("gridUnderfilled(targetHeight = 0) {"):js.index("async fillMoreForHeight() {")]
    assert "this._layoutMinCol" in under, "判据取最矮列，不是最高列"
    assert "Math.min(total, minCol)" in under

    layout = js[js.index("applyMasonryLayout() {"):js.index("shrinkGridToContent(total) {")]
    assert "this._layoutMinCol = " in layout and "this._measuredAvgCardH = " in layout

    shrink = js[js.index("shrinkGridToContent(total) {"):js.index("setGridHeight(height) {")]
    assert "if (this.autoLimit() && !this.fillMoreExhausted" in shrink, (
        "自适应模式下还能补图时，不要用缩小节点来消灭空白 —— 要先补满（用户要的是图片适配节点）"
    )

    dispose = js[js.index("dispose() {"):]
    assert "clearTimeout(this.autoFillTimer);" in dispose, "销毁后不能再排补图请求"


def test_source_without_prompt_never_falls_back_to_tags():
    """2026-09-16 用户真机反馈：「这个 p 站会输出 prompt，而不是不输出，会输出这些标签」。

    P站 的 item.prompt 是 None（后端 capabilities.prompt=false），但前端 rawPromptGroups
    会回退到 tag_string 拼 general ⇒ 把 Pixiv 用户自由打的**日文/多语言标签**
    （实测同一张图同时有 初音ミク / 初音未来 / hatsunemiku）当提示词吐给下游。
    UI 早就按 capabilities 隐藏了 Prompt/入库 按钮，输出端口也必须短路。
    """
    js = _js()
    assert "postHasPrompt(post) {" in js
    # 用「明确声明 false 才禁用」的语义：capabilities 未拉到时不能误伤 C站（prompt=true）
    assert "return this.sourceCapabilities(sourceId)?.prompt !== false;" in js

    build = js[js.index('buildPromptForPost(post, promptOutput = null, excludePattern = "") {'):js.index("postTags(post) {")]
    assert "if (!this.postHasPrompt(post)) {" in build, "没有提示词的图源必须短路，不能回退到 tags"
    assert 'prompt: "",' in build and "tags: []," in build


if __name__ == "__main__":
    test_source_switcher_exists_and_danbooru_search_branch_is_untouched()
    test_danbooru_only_chrome_is_hidden_for_other_sources()
    test_capabilities_are_the_only_switch_for_control_visibility()
    test_query_capability_drives_the_search_hint_not_the_source_name()
    test_backend_warnings_are_surfaced_to_the_user()
    test_pixiv_availability_is_distinct_from_login_state_and_diag_entry_exists()
    test_gallery_items_carry_file_ext_so_mp4_gets_the_video_badge()
    test_cursor_pagination_for_new_sources_and_page_pagination_for_danbooru()
    test_every_gallery_image_goes_through_the_source_proxy()
    test_pixiv_download_prefers_full_url_for_wd14_reverse_lookup()
    test_selected_card_has_no_glow_anywhere()
    test_card_actions_hidden_state_still_swallows_no_clicks()
    test_hidden_attribute_actually_hides_toolbar_controls()
    test_source_secret_section_uses_contract_routes_and_never_echoes_plaintext()
    test_civitai_sort_options_only_use_upstream_legal_values()
    test_civitai_meta_uses_base_model_and_key_is_not_an_nsfw_switch()
    test_taller_resize_fetches_more_only_when_underfilled_and_more_exists()
    print("PASS: multi-source gallery UI contract (D站 / C站 / P站)")
