# ComfyUI-Danbooru-Gallery 工程拆解报告

> 分析对象（**只读**，未修改任何文件）：
> `E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Danbooru-Gallery`
> 对比对象（**只读**）：`E:\claude program\ComfyUI-Anima-Batch-LoRA\web\js\anima_danbooru_gallery_widget.js` (3306 行) + `anima_danbooru_gallery.py` (1609 行) + `web/css/anima_danbooru_gallery.css` (661 行)
>
> ⚠️ **先说结论**：TK 自研版在多数维度上**已经领先**该插件（窗口化懒加载、取消、video 支持、结构化元数据、评分/收藏/随机排序、模糊纠错、预设、dispose 完备）。真正值得抄的不多，且集中在前端长会话与离线标签库两处。文末"建议 TK 借用清单"只列 8 条，并明确标注每条对 TK 是"新能力"还是"退步别抄"。

---

## 1. 布局 / 瀑布流（Layout / Masonry）

**结论：真·JS 瀑布流**——CSS Grid(`auto-fill` + 10px 行高) 做骨架，JS 逐卡写入 `grid-row-end: span N` 做瀑布排布。页数不是固定 N-per-page，而是**游标分页 + 滚动缓冲补货 + DOM 滑动窗口回收**。

### 1.1 CSS 骨架（唯一一处，`danbooru_gallery.js:5450`）

```css
.danbooru-image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  grid-gap: 5px; grid-auto-rows: 10px; overflow-y: auto; background-color: var(--comfy-input-bg);
  padding: 5px; border-radius: 4px; flex-grow: 1; height: 0; }
```
卡片 `img` 为 `.danbooru-image-grid img { width:100%; height:auto; display:block }`（`:5583`）。

### 1.2 常数表

| 常数 | 值 | 位置 |
|---|---|---|
| `POSTS_PER_PAGE` | `42`（每请求一页） | JS `:341` |
| `MAX_KEPT_ITEMS` | `4200`（≈100 页 × 42） | JS `:3222` |
| `preload_count`（前方缓冲目标） | 默认 `40`，clamp `[20, 200]` | JS `:3142`、`:4964` |
| 节点默认尺寸 | `this.setSize([780, 938])` | JS `:79` |
| 列宽保底 | `150`px | JS `:3197` |
| 行高 / 行距 | `10px` / `5px` | CSS `:5450` |

### 1.3 关键函数

| 函数 | 位置 | 作用 |
|---|---|---|
| `getColumnWidth()` | `:3186-3198` | 读 `gridTemplateColumns` 首列像素值，**带缓存** `cachedColumnWidth`，ResizeObserver 里置 0 失效 |
| `computeSpanFromDims(imgW, imgH)` | `:3199-3207` | `Math.ceil((colW*(imgH/imgW) + rowGap) / (rowHeight + rowGap))` |
| `resizeGrid()` | `:3165-3181` | 遍历所有子元素读 `img.clientHeight` 重写 `gridRowEnd` |
| `scheduleResizeGrid()` | `:3211-3217` | **rAF 合并**（`resizeGridTimer` 去重），注释明写"rate-limited loads fire 200ms apart; batching to one reflow per frame avoids N² layout work" |
| `maybeLoadMore()` | `:3137-3157` | 视口比例估算 `aheadBuffer = posts.length - floor(posts.length * viewedRatio)`，`< bufferTarget` 则补货 |

### 1.4 尺寸自适应

**没有 JS 列数计算**，列数完全交给 CSS `auto-fill`；JS 只做 `grid-row-end`。容器尺寸由节点 API 驱动（JS `:5061-5075`）：

```js
this.onResize = (size) => {
    const [width, height] = size;
    const contentWidth = Math.max(150, width - 24);
    container.style.width = `${contentWidth}px`;
    const controlsHeight = container.querySelector('.danbooru-controls')?.offsetHeight || 0;
    if (controlsHeight > 0) imageGrid.style.height = `${Math.max(120, height - controlsHeight - 10)}px`;
    cachedColumnWidth = 0;
    scheduleResizeGrid();
}
```

### 1.5 Resize 重排 & 回收

- **ResizeObserver**：`:4474-4478`，回调 `cachedColumnWidth = 0; resizeGrid();`（`:4475`）——注意**没有 rAF 合并、没有 disconnect**（见 §6）。
- **IntersectionObserver**：**只用于 Gelbooru 详情预取**（`:2703-2716`，`observeGelbooruPrefetch`），**不用于图片懒加载**。
- **DOM 滑动窗口回收 `recycleOldItems()`**：`:3223-3264`，`MAX_KEPT_ITEMS = 4200`，超限时从最老端 `removeChild`，**遇到视口锚点或 `.selected` 项即停**，`posts.splice(0, removed)` 同步缩短数组，再用锚点补偿 `scrollTop`：

```js
const MAX_KEPT_ITEMS = 4200; // ~100 页 @ 42/页
const gridTop = imageGrid.getBoundingClientRect().top;
// …找第一个底边进入视口的元素作为 anchorEl…
while (removed < overflow) {
    const el = imageGrid.firstElementChild;
    if (!el || el === anchorEl) break;
    if (el.classList && el.classList.contains('selected')) break;
    imageGrid.removeChild(el); removed++;
}
posts.splice(0, removed);
if (anchorEl && anchorEl.isConnected) { /* scrollTop 补偿 */ }
```

> **评价**：这是"浏览多少回收多少"，不是窗口化（不是只保留视口附近 N 张）。4200 张 DOM 节点仍在（每卡 1 wrapper + 1 img + 4 button + 每 button 一段 SVG，约 15–20 节点 → **6–8 万 DOM 节点**），只是设了上限。**真空窗口化在此插件里不存在。**

### 1.6 无虚拟化 / 无 `content-visibility`

- `content-visibility`、`contain:`、`will-change`：**全 JS 文件 0 命中**（grep `content-visibility|contain-intrinsic|contain:|will-change` → 仅命中 `backdrop-filter`/`@keyframes`）。
- 懒加载：**没有 `loading="lazy"`**（`$el("img", {src: ...})`，`:4044-4045`，创建即设 `src`）。
- 唯一"节流"是 `preload_count = 40` 的前方缓冲不让它无限加载。

> 对比 TK：TK `anima_danbooru_gallery_widget.js:386-392` 有 `IntersectionObserver({root: this.grid, rootMargin: "260px 0px"})` + `dataset.src` 真懒加载，`:1624-1626` 有意的 `loading="eager"` + 注释解释为何不能叠加原生 lazy。**这一项 TK 更强。**

---

## 2. 图片加载与缓存（Image loading & caching）

### 2.1 缩略图字段

```js
// JS :4040-4042
const previewUrl = (post.source_site === "gelbooru")
    ? post.preview_file_url
    : `${post.preview_file_url}?v=${post.md5}`;
// JS :4044-4045
const img = $el("img", {
    src: `/danbooru_gallery/image_proxy?url=${encodeURIComponent(previewUrl)}`,
    onload: scheduleResizeGrid,
    onerror: (evt) => { /* 重试一次：evt.target.src = evt.target.src; 再失败换"加载失败+刷新"按钮 */ },
});
```
- 缩略图 = **`preview_file_url`**；Danbooru 侧附加 `?v=<md5>` 做缓存失效。
- 原图 = `getBestImageUrl()`（`:2718-2723`）：`file_url` → `large_file_url` → `preview_file_url`。
- **重试仅一次**，靠 `img.dataset.retried`；再失败把 wrapper innerHTML 换成"加载失败" + 刷新按钮（`:4054-4065`，用内联 HTML 字符串，含内联 `onclick` 赋值）。

### 2.2 代理

```python
# py :1465-1527
@PromptServer.instance.routes.get("/danbooru_gallery/image_proxy")
async def image_proxy(request):
    # SSRF 防护：只允许 donmai.us / gelbooru.com
    if not any(host == s or host.endswith(f".{s}") for s in ("donmai.us", "gelbooru.com")):
        return web.Response(status=403, text="host not allowed")
    async with _get_image_proxy_semaphore():           # :1487
        resp = await asyncio.to_thread(_danbooru_request, "GET", url, headers=..., timeout=15)
    return web.Response(body=resp.content, headers={
        "Content-Type": content_type,
        "Cache-Control": "public, max-age=86400",      # :1525
    })
```
- 存在理由（注释 `:1467-1468`）：浏览器直连 `cdn.donmai.us` 会被 Cloudflare 按 cross-site `<img>` 挑战返回 403，服务端 UA 能过 CF。
- **并发上限：`asyncio.Semaphore(2)`**（`_get_image_proxy_semaphore`，`:1219-1223`）。⚠️ 42 张/页 ÷ 2 并发 × 单张 RTT ⇒ 串行化瓶颈（详见 §6）。
- `Cache-Control: public, max-age=86400` **只写给浏览器**，后端自己不消费。

### 2.3 缓存：逐项核对（这是本报告最容易误判的部分）

| 能力 | 存在？ | 证据 |
|---|---|---|
| 磁盘图片缓存 | ❌ **不存在** | 全 `py/*.py` grep `Cache-Control` 只 3 处，均为响应头 |
| 内存图片 LRU | ❌ **不存在** | 无图片字节缓存结构 |
| ETag / `If-None-Match` / 304 | ❌ **不存在** | 全仓 grep `etag\|ETag\|If-None-Match\|304\|Last-Modified` → **0 命中**（`requests.Session` 也不做条件请求） |
| 懒加载 | ❌ 无（见 §1.6） | — |
| `decoding="async"` / `fetchpriority` | ❌ 无 | grep 0 命中 |
| 占位 / blur-up | ❌ 无（只有"加载失败"占位） | `:4054` |
| 空间预留防跳 | ✅ **有**，且是亮点 | `:4017-4030` 用 `post.image_width/height` 预写 `gridRowEnd`；G 站返回 0 尺寸时按列宽估方形保底 |
| 失败重试 | ⚠️ 仅 1 次，前端；后端 429/503 也各 1 次 | `:4049-4052`；`site_clients.py:84-97` |
| **视频 / GIF** | ❌ **主动过滤掉** | `isValidImageType()` `:2444-2470`，白名单只有 `jpg/jpeg/png/webp/bmp/tiff/tif`，`file_ext` 不含则从 `file_url` 正则提取，仍不匹配就 `return false` |
| 浏览器缓存键 | `preview_file_url + "?v=" + post.md5` | `:4042` |

### 2.4 各处缓存的具体数字（后端）

| 缓存 | 键 | 容量 | TTL | 位置 |
|---|---|---|---|---|
| `DanbooruGalleryNode._post_cache` | `f"{source}:{site_opts}:{shape}:{tags}:{limit}:{page}:{rating_key}:{before_id}"` | **200** 条（超限时删**最老写入**的一条，`min(..., key=timestamp)` `:2066-2068`；键不刷新，所以**无真 LRU 热度保护**） | `max_cache_age = 3600`s | py `:2047-2068`、`:2194-2201`、`:2141` |
| `GalleryPostCache`（Gelbooru 详情，SQLite WAL） | `(source, post_id)`；source = `gelbooru:display_all` / `gelbooru:default` | 无上限 | `persistent_post_cache_age = 2592000`s（30 天） | `post_cache.py:47-165`；`py :2142` |
| `hot_tags` / `hot_tags_fts`（SQLite FTS5） | tag 主键 | **67,068** 条 | 无 | 实测 `py/shared/data/tags_cache.db` 13.5MB |
| `TagTranslationSystem._translation_cache` | en_tag | `1000` | 无 | py `:410`、`:553` |
| `TagTranslationSystem._search_cache` | `f"{query}:{limit}"` | `1000` | 无 | py `:409`、`:580-582` |
| `HotTagsCache` 查询结果 LRU | query | `500` | `300.0`s | `memory_cache.py:65-66` |
| 前端 autocomplete L1/L2 | `f"{type}:{query}:lang:{lang}:source:{s}:limit:{n}"` | `500` | `7200000`ms（2h） | `autocomplete_cache.js:23-24`、`:243-261` |

**限流 / 重试常数**（`site_clients.py`）：
```python
class DanbooruHttpClient:  __init__: self.rate_limiter = RateLimiter(0.2)      # :75
    for attempt in range(2):                                                  # :84
        if response.status_code not in (429, 503) or attempt == 1: return response
        time.sleep(_retry_delay(response))                                    # Retry-After, clamp [0.5, 10.0] :34-41
class GelbooruHttpClient:  self._limiters = {"api":0.2, "public":0.75, "hydrate":0.2, "image":0.2}  # :106-111
```
Gelbooru 的 `public` 限流 `0.75`s ≈ **1.33 req/s**，与 `GELBOORU_PUBLIC_PAGE_SIZE = 42`（py `:171`）配合——分页大小与前端 `limit` 解耦，`pid` 固定按 42 步进（`:1317-1323`）。

**前端 Gelbooru 详情预取**（`:2653-2716`）：`GELBOORU_PREFETCH_QUEUE_LIMIT = 8`、`GELBOORU_PREFETCH_DELAY_MS = 250`、`navigator.connection?.saveData` 时禁用、`document.hidden` 时跳过、`generation` 号做代际取消。

---

## 3. 随机 / 发现式搜索（Random / discovery）

### 3.1 有没有 `order:random`？

**没有专门的"随机/惊喜"功能**。全 JS/py grep `random|surprise|discover|shuffle` 的结果里，与搜索有关的只有：

- **`order:rank` 排行榜按钮**：`updateRankingButtonState()` `:4520-4529`，点击 handler `:4532-4561`：
```js
const hasRanking = currentValue.includes('order:rank');
if (hasRanking) {
    let newValue = currentValue.replace(/\s*order:rank\s*/g, '');
    newValue = newValue.replace(/,\s*,/g, ',').replace(/,\s*$/g, '').replace(/^\s*,/g, '').replace(/\s+/g, ' ').trim();
    searchInput.value = newValue;
} else {
    const separator = hasTrailingComma ? ' ' : ', ';
    newValue = currentValue ? `${currentValue}${separator}order:rank` : 'order:rank';
}
```
- **收藏夹按钮**同样只是往搜索框塞/删 `ordfav:<user>`（`currentFavoriteTag()` `:429`，按钮 handler `:4604-4641`）。
- `order:random` **只能靠用户手打**。而手打会被后端**主动破坏**：
```python
# py :2154-2155
if before_id and re.search(r'(?:^|\s)(?:order|ordfav|sort):', tags or ''):
    before_id = ""          # ← 带任何 order: 就禁掉游标分页
```
  即：输入 `order:random` 后，游标失效，退化成页码分页，而 `page` 参数在 D 站 `order:random` 下语义混乱 → **实际不可用**。

### 3.2 有没有质量地板（score / favcount / tagcount / rating 过滤）？

**后端完全没有**。全 py grep `score|favcount|tagcount` → 仅命中 `site_adapters.py:545` 的**清理**逻辑：
```python
# site_adapters.py:545
value = re.sub(r"\b(?:score|rating|size|user):[^\s]+", "", value)
```
即把 `score:` / `rating:` / `size:` / `user:` 元标签从 Gelbooru 公开页 tags 里**剥掉**（因为 Gelbooru 公开页不认）。

**前端只有一个 rating 多选**（`RATING_VALUES = ["general","sensitive","questionable","explicit"]`，`:805`），拼成查询的代码（py `:2243-2253`）：
```python
rating_query = ""
if adapter.key == "danbooru" and rating and rating.lower() != 'all':
    allowed = {'general','sensitive','questionable','explicit','g','s','q','e'}
    rating_values = [r for r in rating.split(',') if r.strip() in allowed]
    if len(rating_values) == 1: rating_query = f"rating:{rating_values[0]}"
    elif len(rating_values) > 1: rating_query = ' '.join(f"~rating:{r}" for r in rating_values)
```
> 注意：D 站默认屏蔽 `questionable/explicit` 是**账号级设置**，插件没有"显示全部"开关——只换 `rating:` 标签。

**没有任何** score 下限、favcount 下限、tag 数量下限、"has notes"、AI 过滤、画师白名单。唯一"排除"是 **filter_tags 黑名单**（本地后过滤，非查询层面）：
```js
// JS :2498-2506
const isPostFiltered = (post) => {
    if (!isValidImageType(post)) return true;   // 顺便把视频/GIF 也过滤了
    return isPostBlacklisted(post);
};
// isPostBlacklisted :2473-2495 —— 取 6 个 tag_string_* 合并成 allTags，逐个全等比较
```

### 3.3 有没有对已展示帖子的去重？

**有，但只在游标模式下生效**，且不是"防重复看"，而是"防翻页重叠"：
```js
// JS :3013-3024
const isGelbooruDedupOff = src === "gelbooru" && dedup === "off";
if (isGelbooruDedupOff) { freshRaw = normalRaw; }
else {
    freshRaw = normalRaw.filter(p => !seenPostIds.has(String(p.id)));
    freshRaw.forEach(p => seenPostIds.add(String(p.id)));
}
```
`seenPostIds` 是**无上限 `Set`**（`:346`），且 `reset` 时清空（`:2876`）。还有"去重陷阱"守卫（`:3075-3079`）：若 `freshRaw=0` 而 `normalRaw>0`，判定到底。

### 3.4 完整查询构造（前端）

```js
// JS :2913-2968
const searchValue = searchInput.value.trim();
const tags = searchValue.split(',').filter(tag => tag.trim() !== '');
let apiFormattedTags = convertTagsToApiFormat(searchValue);        // :2802-2822
if (filterState.startTime || filterState.endTime) {                // 日期筛选
    apiFormattedTags += ` date:${start}..${end}`;
}
const ratingForServer = sendAll ? "" : selectedRatings.join(",");
const useCursor = src === "danbooru" || (src === "gelbooru" && dedup !== "off");
const params = new URLSearchParams({
    "source": src,
    "gelbooru_display_all_site_content": uiSettings.gelbooru_display_all_site_content ? "1" : "0",
    "gelbooru_dedup_mode": dedup,
    "search[tags]": apiFormattedTags.trim(),
    "search[rating]": ratingForServer,
    limit: String(loadLimit),                                      // = POSTS_PER_PAGE = 42
    page: String(apiPage),
});
if (hasCursor) params.set("before_id", lastPostId);
```
`convertTagsToApiFormat` 的规则（`:2802-2822`）：按**逗号**分割 → 反转义 `\(`→`(` → **不含 `:` 的 tag 把空格换下划线** → 用空格拼回。后端 `build_posts_params`（`site_adapters.py:61-72`）把 rating 拼进 `tags`，游标换成 `params["page"] = f"b{before_id}"`（py `:2328-2329`）。

**后端最多只取 2 个 tag**（Gelbooru 游标模式取 1）：
```python
# py :2227-2236
if adapter.key == "gelbooru" and gelbooru_dedup_mode in ("on", "on_auth"):
    max_tags = 10 if (gelbooru_dedup_mode == "on_auth" and has_gelbooru_creds) else 1
else:
    max_tags = 2
if len(other_tags) > max_tags: other_tags = other_tags[:max_tags]
```
前端只给**提示**（`showTagHint('搜索只考虑前两个tag，第三个及后续tag将被忽略')` `:2921-2922`），**静默截断**。

---

## 4. 值得借鉴的搜索质量特性（Search quality）

### 4.1 标签库（数据源是核心差异）

| 层 | 数据源 | 规模 | 位置 |
|---|---|---|---|
| L1 热标签 SQLite + **FTS5** | `py/shared/data/tags_cache.db` | **67,068 tags**，FTS5 索引 67,068 行 | 实测；schema `db_manager.py:52-116` |
| L2 离线翻译 CSV/JSON | `zh_cn/all_tags_cn.json` (392KB) / `danbooru.csv` (10,673 行) / `wai_characters.csv` (5,216 行) | 加载成 `en_to_cn` / `cn_to_en` 双向 dict | py `:412-514` |
| L3 远端 fallback | `tags.json` | — | py `:1617-1630` |

**三层查询顺序**（`get_autocomplete`，py `:1576-1615`；`get_autocomplete_with_translation`，`:1924-1990`）：
```
① SQLite FTS5 前缀查询（~2–5ms，注释 py:1877 自称"10-50ms → 2-5ms"）
② 失败/无结果 → 远端 Danbooru API（timeout = remote_timeout_ms/1000 = 2.0s）
③ 再失败 → 空结果
```
FTS5 schema（`db_manager.py:80-88`）：`content='hot_tags'` 外部内容表 + `tokenize='unicode61'` + 三个 AI/AU/AD 触发器同步。

⚠️ **实测本机该层是坏的**：
```
$ python tools/benchmark_gallery_fast_paths.py
[DanbooruGallery.shared] Warning: db_manager import failed: No module named 'aiosqlite'
[Autocomplete] 无法导入数据库管理器，将仅使用远程API模式: No module named 'aiosqlite'
```
`aiosqlite` 在 `requirements.txt:3` 有声明，但**不在 `pyproject.toml` 的 `dependencies` 里**（`pyproject.toml` 只列 requests/aiohttp/Pillow/torch/numpy），ComfyUI 按 `requirements.txt` 装时通常已被 torch 等满足而跳过。结果：**13.5MB 的 tags_cache.db 完全不被使用，英文补全全部走网络**（且每次都要过 FTS→API 的下行路径）。

### 4.2 中文翻译

- 翻译**在线程外预加载**：`preload_translation_data()` `:647-657`，模块导入即调（`:657`）。
- 四级中文匹配权重（`search_chinese_tags`，`:570-620`）：精确 `10` / 前缀 `8` / 索引 `6` / 包含 `4` / 50% 字符集模糊 `2` / 单字符 `1`。
- ⚠️ 这是**纯线性扫 dict**，对 285k 条目 × 每次键入 = 明显卡顿；FTS5 路径（`:1878-1901`）才是快路径，而它当前不可用。
- 前端中文/英文分流在 `autocomplete_ui.js:231-245`：`/[\u4e00-\u9fff]/.test(query)` → `getChineseSearchSuggestions` 否则 `getAutocompleteSuggestions`。

### 4.3 特性清单核对

| 特性 | 有？ | 证据 / 说明 |
|---|---|---|
| 标签自动补全 | ✅ | `AutocompleteUI`，`debounceDelay = 200`ms、`minQueryLength = 2`（`autocomplete_ui.js:22-23`） |
| 请求去重（in-flight 合并） | ✅ **亮点** | `pendingRequests` Map 共享 Promise，`autocomplete_cache.js:294-309` |
| 过期响应丢弃 | ✅ | `querySequence` 序号守卫，`autocomplete_ui.js:217-251` |
| 超时 | ✅ | `AbortSignal.timeout(5000)` `autocomplete_cache.js:335/460` |
| 中文翻译 | ✅ | §4.2 |
| 标签分类颜色 | ✅ | `className: 'danbooru-tooltip-tag tag-category-${category}'` `:4162` |
| Tooltip | ✅ 但**昂贵** | `:4168-4308`，见 §6 |
| "Did you mean" / 模糊纠错 | ❌ | grep `did.?you.?mean\|fuzzy\|levenshtein\|edit_distance` → **0 命中** |
| 保存搜索 / 预设 | ❌ | 但有**设置导入导出** JSON（`exportSettings` `:1073-1104` / `importSettings` `:1106-1159`） |
| 收藏 | ✅ 服务端 | `favorites/add`、`favorites/remove`；D 站用 `ordfav:<user>` 标签查询（`currentFavoriteTag()` `:429`） |
| 排除 / 黑名单 | ✅ 本地后过滤 | `blacklist`（完全隐藏）+ `filter_tags`（只从 prompt 里剔除，仍显示）—— 两套语义，py `:348-369` |
| 评分过滤 | ✅ 4 选多 | `:805-923` |
| 分页 / 无限滚动 | ✅ 游标 + 页码跳转 | `jumpToPage()` `:5024`，底部 `‹ [n] › 跳转` 状态栏 `:4740-4782` |
| 帖子元数据显示 | ✅ | Tooltip 里 `created_at` + `image_width×height`（`:4187-4194`） |
| 直接下载 | ✅ | `:4106-4148`，**经代理 fetch → Blob → objectURL → revoke** |
| 发到工作流 | ✅ | `selection_data` 隐藏 widget（`:88-98`，`computeSize=()=>[0,-4]`）+ `prepareSelectionForQueue` 入队钩子（`:3858`，替换 `app.queuePrompt` JS `:21-32`） |
| 标签点击 → 加入搜索 | ✅ | 编辑面板 tag 右键菜单 `:3552-3620`（搜索此 tag / 从该分类删除） |
| **视频 / GIF** | ❌ 主动过滤 | `:2444-2470` |

---

## 5. 后端架构（Backend architecture）

### 5.1 全部 HTTP 路由（`py/danbooru_gallery/danbooru_gallery.py`）

| # | 方法 + 路径 | 行 | 用途 |
|---|---|---|---|
| 1 | GET `/danbooru_gallery/image_proxy` | 1465 | 图片反代（SSRF 白名单 + `Semaphore(2)`） |
| 2 | GET `/danbooru_gallery/posts` | 1530 | 帖子列表（`run_in_executor` 卸载） |
| 3 | GET `/danbooru_gallery/autocomplete` | 1576 | 三层补全（DB→API→空） |
| 4 | GET `/danbooru_gallery/autocomplete_with_translation` | 1924 | 同上 + 翻译 |
| 5 | GET `/danbooru_gallery/search_chinese` | 1862 | 中文搜（FTS5 → 线性 fallback） |
| 6 | GET `/danbooru_gallery/translate_tag` | 1825 | 单词翻译 |
| 7 | POST `/danbooru_gallery/translate_tags_batch` | 1843 | 批量翻译 |
| 8 | GET `/danbooru_gallery/check_network` | 1168 | 连通性探测 |
| 9 | POST `/danbooru_gallery/verify_auth` | 1193 | 凭证校验 |
| 10 | GET/POST `/danbooru_gallery/user_auth` | 1066 / 1151 | 读/写 D 站凭证 |
| 11 | GET `/danbooru_gallery/favorites` | 1086 | 收藏列表（`ordfav:` 查询） |
| 12 | POST `/danbooru_gallery/favorites/add` | 837 | 加收藏 |
| 13 | POST `/danbooru_gallery/favorites/remove` | 951 | 删收藏 |
| 14 | GET/POST `/danbooru_gallery/blacklist` | 1690 / 1695 | 黑名单 |
| 15 | GET/POST `/danbooru_gallery/filter_tags` | 1722 / 1727 | prompt 过滤标签 |
| 16 | GET/POST `/danbooru_gallery/language` | 1706 / 1711 | 界面语言 |
| 17 | GET/POST `/danbooru_gallery/ui_settings` | 1739 / 1751 | UI 设置 |
| 18 | POST `/danbooru_gallery/selection_queue_push` | 1770 | 入队数据准备 |
| 19 | POST `/danbooru_gallery/selection_queue_pop` | 1781 | — |
| 20 | POST `/danbooru/logs/batch` | 1798 | **前端日志批量回传** |

### 5.2 从点击到出图的请求流

```
点击卡片 → prepareSelectionForQueue()  (JS :3858)
  └─ hydrateGelbooruPost()  (JS :2595-2634)  ← 仅 G 站；postHydrationRequests Map 去重
       └─ GET /danbooru_gallery/posts?search[tags]=id:<X>&force_public_detail=1
            └─ get_posts_for_front (py :1531)
                 └─ loop.run_in_executor(None, partial(DanbooruGalleryNode.get_posts_internal, ...))  (py :1549-1563)
                      └─ _get_cached_posts(cache_key, 3600)  ← 命中直接返回              (py :2208)
                      └─ (G站命中) GalleryPostCache.get_posts(persistent_source, ids, 2592000)  (py :2275)
                      └─ adapter.build_posts_params() → session.request()  ← 阻塞线程池     (py :2325-2335)
                      └─ _cache_posts(cache_key, result_text)                          (py :2351)
  └─ getSelectedData → selection_data widget → 节点 get_selected_data()  (py :2098)
       └─ _fetch_supported_media(image_url)  ← 同步阻塞，无并发池                      (py :1243-1276)
            └─ Image.open(io.BytesIO(...)) → np.array → torch.from_numpy              (py :2118-2121)
```
`selection_data` 的入队时序由**替换 `app.queuePrompt`** 保证（JS `:21-32`，`galleryQueueChain` 串行化所有节点的 preparer）。

### 5.3 异步模型

- **所有同步 HTTP 都经 `run_in_executor` 卸载**（py `:1549-1563` 主路径；`_run_http_request` `:190-193` 辅助），注释明写"Keep them off aiohttp's event loop"（`:1545-1547`）。
- 线程池是**默认 executor**（无上限指定）。Gelbooru 详情 hydrate 用局部 `ThreadPoolExecutor(max_workers=2)` 且**按对串行等待**（`:1392-1397`）。
- 单例 session：`_danbooru_client = DanbooruHttpClient()` / `_gelbooru_client = GelbooruHttpClient()`（`:167-168`），均持 `requests.Session`。
- ⚠️ Gelbooru 有 4 个独立令牌桶（api/public/hydrate/image），Danbooru 只有 1 个 `0.2s`。
- ⚠️ 图片代理的 `Semaphore(2)` 与 `asyncio.to_thread` 组合（`:1487-1507`）：**信号量在 await 期间持有**，即同时只有 2 个上游字节流在飞。

### 5.4 设置 / 收藏存储

**全部塞进一个 JSON 文件**：`py/danbooru_gallery/settings.json`（34 行，`SETTINGS_FILE` py `:198`）。

```json
{ "language": "zh", "blacklist": [], "filter_tags": ["watermark","sample_watermark", …],
  "filter_enabled": true, "danbooru_username": "", "danbooru_api_key": "",
  "gelbooru_user_id": "", "gelbooru_api_key": "", "gelbooru_display_all_site_content": false,
  "favorites": [], "debug_mode": false, "cache_enabled": true, "max_cache_age": 3600,
  "persistent_post_cache_age": 2592000, "default_page_size": 20,
  "autocomplete_enabled": true, "tooltip_enabled": true, "autocomplete_max_results": 20,
  "selected_categories": ["artist","copyright","character","general"], "multi_select_enabled": false }
```
- `load_settings()`（`:200-239`）每次读盘 + 逐 key 补默认值；**无锁、无原子写**（`save_settings` `:279-287` 直接 `open(...,'w')`）。
- **API Key 明文入库**（`danbooru_api_key` / `gelbooru_api_key`）。
- 每个 `load_*()` 都调一次 `load_settings()` → **每请求多次读盘**（如 `/favorites` 会经 `load_favorites` → `load_settings`）。
- 前端另有一套 `localStorage`（`saveToLocalStorage` / `loadFromLocalStorage` `:41-58`，前缀 `danbooru_gallery_`），与后端设置**双写且不同步**（`ui_settings` 走后端，`searchValue` / `preload_count` 走 localStorage）。

### 5.5 `benchmark_gallery_fast_paths.py` 到底测什么 / 实测结果

**设计意图**（docstring `:1-9`）：离线基准，用假 session 对比两种 Gelbooru 公开页取数形态：

| 变体 | 参数 | 预期 HTTP 调用数 |
|---|---|---|
| `baseline-eager-detail` | `hydrate_details=True` | `count + 1` = **43**（1 次列表 + 42 次详情） |
| `fast-list-tags` | `hydrate_details=False` | **1**（只抓列表页，tag 从列表页 `<img title=...>` 取） |

断言（`:138-140`）：`assert baseline[2] == count + 1`、`assert optimized[2] == 1`、`assert optimized[1] < baseline[1]`，并打印 `speedup | {speedup:.1f}x`。另测 `GalleryPostCache.classify_posts` 与 `merge_cached_posts` 的零上游调用（`:152-175`）。

**实测（本机，2026-xx）：脚本本身已失效，跑不完。**
```
$ python tools/benchmark_gallery_fast_paths.py
[DanbooruGallery.shared] Warning: db_manager import failed: No module named 'aiosqlite'
[Autocomplete] 无法导入数据库管理器，将仅使用远程API模式: No module named 'aiosqlite'
Traceback (most recent call last):
  File "tools\benchmark_gallery_fast_paths.py", line 179, in <module>
    main()
  File "tools\benchmark_gallery_fast_paths.py", line 115, in main
    gallery._gelbooru_public_throttle._last_ts = 0.0
AttributeError: module 'gallery_benchmark.danbooru_gallery.danbooru_gallery' has no attribute '_gelbooru_public_throttle'
[exit code: 1]
```
→ **无法给出真实 speedup 数字**。`_gelbooru_public_throttle` / `_gelbooru_hydrate_throttle`（脚本 `:115-116`）在限流重构进 `site_clients.GelbooruHttpClient._limiters` 后已不存在。**该基准从重构那天起就再也没跑过，其声称的 43×→1× 减少（结构性事实，代码可证）从未被回归验证。**

---

## 6. 明确的 BUG / 反模式（TK 不要抄）

### 6.1 内存 / 定时器泄漏

**① 2 秒轮询 `setInterval` 永不清除 —— 最严重**
```js
// JS :3159-3163
// 2 秒定时轮询检查前方缓冲，不够就自动补货
setInterval(() => {
    logger.debug(`[setInterval] tick`);
    maybeLoadMore();
}, 2000);
```
ID 未保存，`onRemoved` 也没清（`onRemoved` 全文 `:5078-5089`，只做 `galleryQueuePreparers.delete` + 删 5 类全局 DOM）：
```js
nodeType.prototype.onRemoved = function () {
    galleryQueuePreparers.delete(this);
    document.querySelectorAll(".danbooru-settings-dialog, .danbooru-edit-panel, .danbooru-tag-tooltip, .danbooru-tag-context-menu, .danbooru-toast").forEach(el => el.remove());
    onRemoved?.apply(this, arguments);
};
```
→ **删掉节点后定时器仍在跑**，闭包持有整个 `posts` 数组 / `imageGrid` / 所有卡片。`maybeLoadMore` 会继续 `fetchAndRender` 往一个已脱离 DOM 的网格里 `appendChild`。全文件 grep `clearInterval` → **0 命中**。

**② `ResizeObserver` 不 disconnect**
```js
// JS :4474-4478
const observer = new ResizeObserver(() => { cachedColumnWidth = 0; resizeGrid(); });
observer.observe(imageGrid);
```
无引用保存、无 disconnect，且回调**未做 rAF 合并**（与 `scheduleResizeGrid` 的处理不对称）。

**③ `imageGrid` 的 `scroll` 监听器不解绑**（`:4481`），闭包同样钉住整个 set。

**④ 模块级全局 tooltip 从不销毁**（`:4152-4156` 挂到 `document.body`），只在 `onRemoved` 里按 class 删——**多节点时删一个会连带删掉另一个正在用的 tooltip**。

### 6.2 布局抖动 / 强制回流

**⑤ `mousemove` 里 `getBoundingClientRect()` —— tooltip 跟随时每帧强制布局**
```js
// JS :4299-4308
wrapper.addEventListener("mousemove", (e) => {
    if (globalTooltip.style.display !== 'block') return;
    const rect = globalTooltip.getBoundingClientRect();   // ← 每 mousemove 强制 reflow
    …
});
```
而且 `mouseenter` handler 是 `async`（`:4168`）且**未节流**：快速划过 N 张卡会并发发出 N 个 `hydrateGelbooruTooltipPost` + N 个 `translate_tags_batch` POST（`:4231-4235`）。只靠 `currentTooltipId` 丢弃结果（`:4172/:4180/:4247`），**请求本身不取消**。

**⑥ `resizeGrid()` 逐元素读 `img.clientHeight`**（`:3171-3177`）— 读写交替，典型 layout thrash。虽有 rAF 合并，但 ResizeObserver 路径绕过了合并。

**⑦ `onResize` 里读 `offsetHeight`**（`:5068`）后马上写 `style.height` — 每次节点缩放一次强制同步布局。

### 6.3 渲染 / DOM 反模式

**⑧ 每卡约 15–20 个 DOM 节点 + 内联 SVG**
每张卡 = `div.danbooru-image-wrapper` + `img` + `div.danbooru-image-buttons` + **4 个 button，每个内联一段 `<svg>`**（`:4107-4111`, `:4364-4367`, `:4388`, `:4321-4323`）。4200 张上限 ⇒ **≈6–8 万 DOM 节点**。同时 4 个 handler 闭包/卡 ⇒ 1.7 万个函数对象。

**⑨ 网格容器没有渲染隔离**
无 `content-visibility: auto`、无 `contain`、无 `will-change`（grep 0 命中）。而 `.danbooru-image-wrapper:hover { transform: scale(1.05); box-shadow: 0 0 15px …; z-index: 10 }`（`:5460-5465`）+ 一堆 `backdrop-filter: blur(5px)`（`:5283/5341/5530/5605`）都在滚动容器内 —— hover 会触发大范围重绘。

**⑩ 图片失败后重建 DOM 用字符串拼 HTML**
```js
// JS :4054-4057
wrapper.innerHTML = `<div style="...">
    <span style="color:#ff4444;font-size:11px;">加载失败</span>
    <button style="...">刷新</button></div>`;
wrapper.querySelector('button').onclick = () => { … };
```
同一模式在 `:3997`、`:5410+` 反复出现 —— 与文件其余部分用 `$el()` 的风格自相矛盾。

### 6.4 网络 / 并发反模式

**⑪ 图片代理 `Semaphore(2)` 是明确瓶颈**
42 张缩略图/页，需经 `/danbooru_gallery/image_proxy` 串行 2 路。以单张 RTT 300ms 估算：`42/2 × 0.3s ≈ 6.3s` 才能点亮一页。**无批量端点、无 HTTP/2 复用收益**，且响应体全量驻留内存（`resp.content`）。

**⑫ 三套并发控制彼此不知道彼此**
- 前端：无图片并发限制（浏览器 6 conn/host 隐式兜底）
- 后端图片代理：`Semaphore(2)`
- 后端 Gelbooru 公开页：令牌桶 `0.75s`
- 后端 Gelbooru 详情预取：前端队列 8 + 250ms 延迟
→ 一次"搜 G 站 + 滚到底"会同时压三条路径到同一 IP。

**⑬ 依赖幽灵 / 静默降级**
`aiosqlite` 在 `requirements.txt` 有、在 `pyproject.toml` **没有** → 本机实测 `ImportError` 被 `try/except` 吞成一条 warning（py `:32-36`），整个本地标签库（67k tags + FTS5 + 13.5MB DB）静默失效。**用户看不到任何 UI 提示**。

**⑭ `settings.json` 明文存 API Key + 无锁读改写**（§5.4）。

**⑮ 前端日志全开**
```js
// JS :12-13
// 打开全局日志，所有级别打到 ComfyUI 终端
loggerClient.setConsoleOutput(true);
```
`fetchAndRender` 一条路径就有 **6 条 `logger.info`、4 条 `logger.warn`、2 条 `logger.debug`**（`:2827-2845`），`maybeLoadMore` 每次 tick 打一条（`:3150`，**每 2 秒一次**）。虽然 `docs/LOGGING.md` 宣称 `QueueHandler + QueueListener` 异步 + 1000 条缓冲，但热路径上的字符串拼接 + 批量回传 `/danbooru/logs/batch` 是无谓开销。

**⑯ `seenPostIds` 无上限**（`:346`），长会话跨多轮搜索累积。

**⑰ 搜索静默截断到 2 个 tag**（py `:2235-2236`）——只给一次 toast 提示，用户很容易漏看。

---

## 对比基线：TK 自研版已经有的（不要重复抄）

| 能力 | TK 现状 | 竞品 |
|---|---|---|
| 窗口化懒加载 | ✅ `IntersectionObserver{root:this.grid, rootMargin:"260px 0px"}` `widget.js:386-392` + `dataset.src` | ❌ 创建即 `src` |
| 意图性禁用原生 lazy（防空卡） | ✅ `preview.loading="eager"` + 注释 `:1624-1626` | ❌ 无 |
| 宽高比预占位 | ✅ `preview.style.aspectRatio` `:1632-1638` | ✅ 也有（`:4017-4030`） |
| 请求取消 | ✅ `AbortController` + `requestId` 守卫 `:655-657`, `:824-829` | ⚠️ 仅 posts 有；tooltip/翻译无 |
| **dispose 完备** | ✅ `dispose()` `:3208-3237` 清 observers / rAF / listeners | ❌ `setInterval` + ResizeObserver 泄漏 |
| 图片代理并发 | ✅ `IMAGE_PROXY_CONCURRENCY = 3` | ⚠️ `Semaphore(2)` |
| 评分/收藏下限 | ✅ `score:>N` / `favcount:>N` `:571-572` | ❌ 无 |
| `order:random` | ✅ `ORDER_OPTIONS` 含 random | ⚠️ 只能手打且被后端禁用 |
| 模糊纠错 | ✅ Levenshtein + `/anima/danbooru/fuzzy` `py:739-790,1403` | ❌ 无 |
| 搜索预设 | ✅ `settings.presets` + 管理器 `:2677-2797` | ❌ 无（只有设置导入导出） |
| 离线中文词典 | ✅ `data/danbooru_tags_zh.json` 17.9MB / ~285k 条 | ⚠️ CSV/JSON 小得多（10.7k + 5.2k 行） |
| 视频 / MP4 | ✅ `isVideoPost` + 徽标 + `metadata_json` | ❌ 主动过滤 |
| 已展示去重 | ❌ 无 | ✅ `seenPostIds` |
| DOM 滑动窗口回收 | ❌ 无 | ⚠️ 有但阈值 4200 |
| 离线标签索引（英文补全不联网） | ❌ 每次键入打远端 `tags.json` `py:1353-1355` | ✅ SQLite FTS5（但当前因 `aiosqlite` 缺失而失效） |
| per-category 标签颜色 | ❌ 只有固定色 `css:658-659` | ✅ `tag-category-${category}` |
| 结构化错误 payload | ⚠️ 纯字符串错误 | ✅ `{title,summary,causes[],suggestions[],details}` |

---

## 建议 TK 借用清单

按 **(性能/UX 收益) ÷ (实现成本)** 降序。每条注明参考代码位置与"TK 当前状态"。

| # | 借用项 | 收益 | 成本 | 参考位置 | 一句话理由 |
|---|---|---|---|---|---|
| **1** | **长会话 DOM 滑动窗口回收** | **高**（内存/GC/滚动帧率，长翻页必现） | **低**（~40 行纯前端，无后端改动） | `danbooru_gallery.js:3219-3264` `recycleOldItems()` + `MAX_KEPT_ITEMS=4200` + `posts.splice(0, removed)` 同步 | TK 无上限累积卡片（每页 ≤48 但仍无回收），照抄时**把 4200 降到 ~600–900**（TK 卡片 DOM 更重：`dataset` 里塞了 6 个 JSON），并改用 `IntersectionObserver` 判定锚点而非 `getBoundingClientRect` 循环。 |
| **2** | **离线优先的标签补全（本地 SQLite + FTS5 兜底远端）** | **高**（消除每次键入的网络依赖与延迟） | **中**（TK 已有 20.6MB CSV + 17.9MB zh JSON，需建库一次） | py `:1576-1615` 三层机制；schema `py/shared/db/db_manager.py:52-116`；数据 `py/shared/data/tags_cache.db` (67,068 tags, FTS5) | TK 英文补全**每次都打远端** `tags.json`（`py:1353-1355`）；本地库能把这步变 0 网络。**注意逆向教训**：该插件的这一层因 `aiosqlite` 未装而静默失效——TK 建库请用标准库 `sqlite3` + `check_same_thread=False`，别引入可选依赖。 |
| **3** | **结构化错误 payload + 网格内错误格（含同类合并）** | **高**（可诊断性 UX，直接减少你的"全部超时"类 issue） | **低**（约定一个 dict schema + 前端渲染器） | `{title, summary, causes[], suggestions[], details{}}` JS `:160-241`；错误格合并 `errorCellsBySignature` `:4431-4472`；构造器 py `:102-172` | TK 后端现在返回纯中文字符串（`py:1173-1181`），前端只能整块红字。借这套后：失败**不销毁已有网格**（`:3109-3116` "保留已有内容+加错误格"），且同类错误折叠成"×N"。 |
| **4** | **前端请求代际取消 + pending 去重（补 TK 的两处缺口）** | 中高（消除过期写回 / 重复请求） | 低 | in-flight 合并 `autocomplete_cache.js:294-309`；代际守卫 `autocomplete_ui.js:217-251`；后端游标推进 `postsRequestGeneration` `:2841,2888,3093` | TK 的 `ensureTagTranslations()` (`:1332`) 和 `applyActiveCategory()` (`:793`) **都没有 AbortController**——晚到的响应会写进已关闭的对话框。直接补 signal + `requestId` 比对即可。 |
| **5** | **游标分页 + "去重陷阱"守卫** | 中（翻页不重叠、无丢图） | 中（前后端各改一处） | 前端 `useCursor`/`before_id` `:2942-2960`；`seenPostIds` `:3013-3024`；陷阱守卫 `:3075-3079`；后端 D 站 `params["page"]=f"b{id}"` py `:2328-2329`；`order:` 时禁游标 py `:2154-2155` | TK 用纯页码分页，D 站翻页时会重复。**只抄游标这一半**——同时抄它 `seenPostIds` 无上限的毛病就是净负。 |
| **6** | **per-category 标签着色** | 中（信息密度/扫读速度，纯观感） | 极低（一个 class 映射 + 5 条 CSS） | `className: 'danbooru-tooltip-tag tag-category-${category}'` `:4162`；分类序 `TAG_CATEGORY_ORDER` `:806` | TK tooltip 已是分类分组渲染（`:2235-2287`），只差给每组上色；用现有 `PROMPT_CATEGORY_LABELS`(`:45-52`) 直接映射即可。**注意**：该插件的 5 色在暗底上对比度偏低，别照抄色值。 |
| **7** | **`rAF` 合并 + 尺寸预占位的瀑布流稳定性** | 中（消除加载时抖动 / N² 布局） | 低 | `scheduleResizeGrid()` `:3211-3217`（注释解释 N² 起因）；`computeSpanFromDims` `:3199-3207`；`getColumnWidth` 带缓存 `:3186-3198` | TK 已有 rAF 合并（`scheduleMasonryLayout` `:358-364`）与 aspect-ratio 预占—— **真正缺的是 `getColumnWidth()` 那种"列宽缓存 + ResizeObserver 失效"**，可省掉每次瀑布遍历里的 `getComputedStyle`。 |
| **8** | **可选的本地 `GalleryPostCache`（SQLite，按 `(source, post_id)` 缓存帖子详情）** | 中（重复访问/重新搜索时 0 上游调用） | 中（新增一个 SQLite + 淘汰策略） | `py/danbooru_gallery/post_cache.py:47-171`；TTL `persistent_post_cache_age = 2592000`(30d) py `:2142`；接入点 py `:2273-2306` | TK 搜索缓存只有 `CACHE_TTL_SECONDS = 30` / `CACHE_MAX_ENTRIES = 64`（内存），30 秒后同一次搜索要重新打 D 站。**只借"缓存帖子详情"这一用途**；不要连它的 `settings.json` 明文存 Key + 无锁读改写（py `:279-287`）一起抄。 |

### 明确**不要**抄的（负价值）

| 反模式 | 位置 | 原因 |
|---|---|---|
| `setInterval(…, 2000)` 补货轮询且不清除 | JS `:3159-3163`；`onRemoved` `:5078-5089` | 节点删除后永久泄漏 + 向孤儿网格继续 fetch |
| `Semaphore(2)` 图片代理 | py `:1219-1223` | TK 的 `IMAGE_PROXY_CONCURRENCY = 3` 已更好；42 张/页下 2 路串行太慢 |
| `mousemove` 里 `getBoundingClientRect()` | JS `:4299-4308` | 每帧强制回流；TK 的 `positionTooltip` 一次性定位更优 |
| 主动过滤视频/GIF | `isValidImageType` JS `:2444-2470` | TK 已支持 MP4 + 徽标 + `metadata_json`，这是 TK 的优势项 |
| 每卡 4 个内联 SVG button | JS `:4107-4111`, `:4364-4367`, `:4388`, `:4321-4323` | 6–8 万 DOM 节点；TK 单 `selectButton` 结构更省 |
| 三套库互不知情的并发控制 | py `:1222`, `site_clients.py:106-111`, JS `:2653-2654` | 同一 IP 被三条路径叠加压；TK 单一 `IMAGE_PROXY_CONCURRENCY` + `_rate_limiter` 更清晰 |
| `pyproject.toml` 与 `requirements.txt` 依赖不一致导致静默降级 | `pyproject.toml:8-14` vs `requirements.txt:3` | 实测已失效的 `aiosqlite` 路径；TK 新增依赖务必两处同步 + 失败要**显式报错**而非 warning |
| 明文 API Key + 无锁 `settings.json` 读改写 | py `:279-311`, `settings.json:18` | TK 用 `data/danbooru_account.json` 且**不在工作流里序列化**，已更安全；保持 |
| 热路径全开日志 | JS `:12-13`, `:2827-2845`, `:3150` | 每 2 秒一条 info + 每请求 12 条；TK 的 `dispose` 清理纪律更好，别把噪音引进来 |
| 失效的基准脚本 | `tools/benchmark_gallery_fast_paths.py:115-116` | 引用已删除的 `_gelbooru_public_throttle`，从限流重构起就再也跑不起来（实测 `AttributeError`，exit 1） |

---

## 附：本报告的可复现命令

```powershell
# 失效基准（实测 AttributeError，exit 1）
python "E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Danbooru-Gallery\tools\benchmark_gallery_fast_paths.py"

# 确认 aiosqlite 缺失 → 本地标签库静默失效
python -c "import importlib.util as u; print(u.find_spec('aiosqlite') is not None)"   # → False
```
```python
# tags_cache.db 实测规模
import sqlite3
c = sqlite3.connect(r"...\py\shared\data\tags_cache.db")
print(c.execute("select count(*) from hot_tags").fetchone())      # (67068,)
print(c.execute("select count(*) from hot_tags_fts").fetchone())  # (67068,)
# 列: tag, category, post_count, translation_cn, last_updated, aliases
```

## 附：版本一致性提醒（影响第 5 节结论的时效性）

TK 侧存在三份副本，经 MD5 比对：

| 文件 | 发布仓库 `E:\claude program\ComfyUI-Anima-Batch-LoRA` | 运行目录 `E:\1AI\...\custom_nodes\ComfyUI-Anima-Batch-LoRA` |
|---|---|---|
| `web/js/anima_danbooru_gallery_widget.js` | 162,789 B | **一致**（`501CFC1B934F9370D1AD23EF53FAD5CE`） |
| `anima_danbooru_gallery.py` | 71,057 B | 70,519 B ← **落后** |
| `web/css/anima_danbooru_gallery.css` | 40,724 B | 40,675 B ← **落后** |
| `web/js/anima_danbooru_filter_controls.js` | 18,349 B | 17,948 B ← **落后** |
| `web/js/anima_dom_widget_size_sync.js` | 5,689 B | 5,545 B ← **落后** |

→ 本报告的 TK 侧结论**基于发布仓库（source of truth）**。若按运行目录的实际行为推理代理/重试链与 CSS 细节，可能与该插件在运行时的真实表现有细微出入；前端 widget 两者一致，故 §1/§2/§6 的对比结论不受影响。
