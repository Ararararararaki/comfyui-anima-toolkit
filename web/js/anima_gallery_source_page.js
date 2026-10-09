/** Non-D source policy returns data; controllers own commits and views. */

const POOL_CURSOR_PREFIX = "tk-pool:";

/**
 * P站 排行榜的中文标签与合法组合表。
 * ⚠️ 与后端 `anima_backend/anima_gallery_pixiv.py` 的 `PIXIV_RANKING_*` 常量**同值**：
 * 那边用同一张表回可读错误，这边用它置灰按钮 —— 两处都改才算改完。
 */
export const PIXIV_RANKING_CONTENTS = ["all", "illust", "ugoira", "manga"];
export const PIXIV_RANKING_MODES = ["daily", "weekly", "monthly", "rookie", "original", "daily_ai", "male", "female"];
export const PIXIV_RANKING_CONTENT_LABELS = { all: "综合", illust: "插画", ugoira: "动图", manga: "漫画" };
export const PIXIV_RANKING_MODE_LABELS = {
  daily: "今日", weekly: "本周", monthly: "本月", rookie: "新人",
  original: "原创", daily_ai: "AI生成", male: "受男性欢迎", female: "受女性欢迎",
};
/** mode × content 实测兼容表：实测带非法组合上游回 404（详见后端常量区注释）。 */
export const PIXIV_RANKING_CONTENT_MODES = {
  all: [...PIXIV_RANKING_MODES],
  illust: ["daily", "weekly", "monthly", "rookie"],
  ugoira: ["daily", "weekly"],
  manga: ["daily", "weekly", "monthly", "rookie"],
};

export function pixivRankingSupports(content, mode) {
  return (PIXIV_RANKING_CONTENT_MODES[content] || []).includes(mode);
}

/** 「插画今日排行榜」这类人类可读榜名（状态栏用）。 */
export function pixivRankingLabel(filters = {}) {
  const content = PIXIV_RANKING_CONTENT_LABELS[filters.rankContent] || PIXIV_RANKING_CONTENT_LABELS.illust;
  const mode = PIXIV_RANKING_MODE_LABELS[filters.rankMode] || PIXIV_RANKING_MODE_LABELS.daily;
  return `${content}${mode}排行榜`;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Gallery request aborted");
  error.name = "AbortError";
  throw error;
}

/** Request preparation is also used by the accumulating C pool. */
export function gallerySourceParameters(request) {
  const source = String(request.source || "");
  const query = String(request.query ?? "").trim();
  const filters = request.filters || {};
  const params = new URLSearchParams();
  if (request.capabilities?.page_numbers === true) {
    params.set("page", String(Math.max(1, Number(request.page) || 1)));
  } else {
    params.set("cursor", String(request.cursor ?? ""));
  }
  params.set("limit", String(source === "pixiv" ? 30 : Math.max(1, Number(request.limit) || 30)));
  if (source === "pixiv") {
    params.set("word", query);
    params.set("query", query);
    params.set("target", String(filters.target || "partial_match_for_tags"));
    params.set("sort", String(filters.sort || "date_desc"));
    // 排行榜是**无关键词浏览**：后端据此改走网页端 ranking.php，并忽略 word/target/sort。
    // `page` 在两个模式下都是同名的页码参数，但语义不同：搜索是 (page-1)*30 的 offset，
    // 排行就是上游的 p（每页 50 条）—— 那条换算只在后端搜索分支里做，这里不必区分。
    if (filters.ranking === true) {
      params.set("ranking", "1");
      params.set("rank_mode", String(filters.rankMode || "daily"));
      params.set("rank_content", String(filters.rankContent || "illust"));
      if (filters.rankDate) params.set("rank_date", String(filters.rankDate));
    }
    // 「近期热门」：只发开关，时间窗（近一个月）由后端算 —— 单一真源，前端不各算一份
    if (filters.recentPopular === true) params.set("recent_popular", "1");
  } else {
    params.set("query", query);
    if (filters.nsfw) params.set("nsfw", String(filters.nsfw));
    params.set("sort", String(filters.sort || "Newest"));
  }
  // The accumulating pool has larger tiers. Only the window fetch clamps to 600.
  if (source === "civitai" && Number(request.poolTarget) > 0) {
    params.set("pool_target", String(request.poolTarget));
  }
  return params;
}

function galleryFileExt(url, fallback = "jpg") {
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url || "").split("?")[0]);
  return match ? match[1].toLowerCase() : fallback;
}

/** Common gallery item -> the existing post schema used by cards/downloads. */
export function galleryItemToPost(item, sourceId) {
  const full = String(item?.full_url || item?.preview_url || "");
  const preview = String(item?.preview_url || full || "");
  const tags = Array.isArray(item?.tags) ? item.tags.map(tag => String(tag || "").trim()).filter(Boolean) : [];
  const width = Number(item?.width);
  const height = Number(item?.height);
  return {
    id: item?.id == null ? "" : String(item.id), source: sourceId,
    preview_file_url: preview, large_file_url: full, file_url: full,
    full_url: full, preview_url: preview,
    image_width: Number.isFinite(width) && width > 0 ? width : 0,
    image_height: Number.isFinite(height) && height > 0 ? height : 0,
    file_ext: galleryFileExt(full || preview),
    rating: item?.rating == null ? "" : String(item.rating),
    score: item?.score == null ? null : Number(item.score),
    fav_count: item?.meta?.fav_count ?? item?.meta?.bookmarks ?? null,
    tag_string: tags.join(" "), tags,
    prompt: item?.prompt == null ? "" : String(item.prompt),
    negative_prompt: item?.negative_prompt == null ? "" : String(item.negative_prompt),
    source_url: item?.source_url == null ? "" : String(item.source_url),
    meta: item?.meta && typeof item.meta === "object" ? item.meta : {},
  };
}

/** Preserve first-card order and all pages without writing widget detail state. */
export function foldGalleryPosts(posts) {
  const groups = new Map();
  for (const post of posts) {
    const illustId = String(post?.meta?.illust_id || "");
    if (!illustId) continue;
    const bucket = groups.get(illustId);
    if (bucket) bucket.push(post);
    else groups.set(illustId, [post]);
  }
  if (!groups.size) return { posts, groups: null };
  const seen = new Set();
  const cards = posts.filter(post => {
    const illustId = String(post?.meta?.illust_id || "");
    if (!illustId) return true;
    if (seen.has(illustId)) return false;
    seen.add(illustId);
    return true;
  });
  return { posts: cards, groups };
}

/** C pool queries use AND across prompt, negative prompt and creator. */
export function filterCivitaiPoolPosts(posts, query) {
  const terms = String(query || "").toLowerCase().replace(/，/g, " ").split(/\s+/).filter(Boolean);
  if (!terms.length) return posts;
  return posts.filter(post => {
    const meta = post?.meta && typeof post.meta === "object" ? post.meta : {};
    const haystack = [post?.prompt, post?.negative_prompt, meta.username]
      .map(value => String(value || "")).join(" ").toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

function readPoolCursor(cursor) {
  if (!cursor.startsWith(POOL_CURSOR_PREFIX)) return { poolCursor: cursor, offset: 0 };
  try {
    const value = JSON.parse(cursor.slice(POOL_CURSOR_PREFIX.length));
    if (typeof value?.poolCursor !== "string" || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error();
    return { poolCursor: value.poolCursor, offset: value.offset };
  } catch {
    throw new Error("C站池浏览位置已失效，请从头看");
  }
}

function writePoolCursor(poolCursor, offset) {
  return offset > 0 ? POOL_CURSOR_PREFIX + JSON.stringify({ poolCursor, offset }) : poolCursor;
}

/** One source page or C pool window. No request result commits live state. */
export async function fetchGallerySourcePage(adapter, input, { signal } = {}) {
  throwIfAborted(signal);
  const request = {
    ...input, source: String(input.source || ""), label: String(input.label || input.source || ""),
    query: String(input.query ?? "").trim(), cursor: String(input.cursor ?? ""),
    page: Math.max(1, Number(input.page) || 1), limit: Math.max(1, Number(input.limit) || 30),
    capabilities: { ...(input.capabilities || {}) }, filters: { ...(input.filters || {}) },
    excludeTags: [...(input.excludeTags || [])],
  };
  const empty = {
    posts: [], groups: null, nextCursor: null, cursor: request.cursor,
    query: request.query, warnings: [], settings: {}, account: {},
  };
  // 排行榜是无关键词浏览 —— 它和关键词搜索是两条互斥的路，别让「请输入关键词」把它拦住
  const rankingMode = request.source === "pixiv" && request.filters.ranking === true;
  if (request.source === "pixiv" && !request.query && !rankingMode) {
    return { ...empty, status: "P站：请输入关键词后回车搜索（日文 / 英文均可）" };
  }
  const poolEnabled = request.source === "civitai" && Number(request.poolTarget) > 0;
  let position = poolEnabled ? readPoolCursor(request.cursor) : null;
  if (poolEnabled) request.poolTarget = Math.min(600, Math.max(request.limit, Number(request.poolTarget)));
  let result;
  for (let scanned = 0; scanned < (poolEnabled ? 3 : 1); scanned += 1) {
    throwIfAborted(signal);
    const cursor = poolEnabled ? writePoolCursor(position.poolCursor, position.offset) : request.cursor;
    const parameters = gallerySourceParameters({ ...request, cursor: poolEnabled ? position.poolCursor : request.cursor });
    const { data } = await adapter.searchPage(request.source, parameters, { signal });
    throwIfAborted(signal);
    const items = Array.isArray(data?.items) ? data.items : [];
    const warnings = Array.isArray(data?.warnings) ? data.warnings.map(value => String(value || "").trim()).filter(Boolean) : [];
    const nextCursor = data?.next_cursor == null || data.next_cursor === "" ? null : String(data.next_cursor);
    const incoming = items.map(item => galleryItemToPost(item, request.source));
    const available = incoming.filter(post => post.preview_file_url || post.large_file_url);
    if (poolEnabled) {
      const matches = filterCivitaiPoolPosts(available, request.query);
      const posts = matches.slice(position.offset, position.offset + request.limit);
      const nextOffset = position.offset + request.limit;
      result = {
        ...empty, posts, warnings, cursor,
        nextCursor: nextOffset < matches.length ? writePoolCursor(position.poolCursor, nextOffset) : nextCursor,
        status: `C站：本批 ${posts.length} 张 · 已按池内关键词筛选`,
      };
      if (posts.length || !nextCursor || scanned === 2) break;
      position = { poolCursor: nextCursor, offset: 0 };
      continue;
    }
    const excludeTags = request.capabilities.tags === true ? request.excludeTags : [];
    const tagSet = new Set(excludeTags);
    const filtered = excludeTags.length
      ? available.filter(post => !post.tag_string.split(" ").some(tag => tagSet.has(tag))) : available;
    const excludedCount = available.length - filtered.length;
    const unavailableCount = incoming.length - available.length;
    const { posts, groups } = foldGalleryPosts(filtered);
    const notices = [...warnings];
    if (excludedCount) notices.push(`已排除 ${excludedCount} 张（${excludeTags.join("、")}）`);
    if (unavailableCount) notices.push(`${unavailableCount} 张缺图已跳过`);
    if (filtered.length > posts.length) notices.push(`已折叠 ${filtered.length - posts.length} 页多页作品（点卡片「全部页」展开）`);
    const pageMode = request.capabilities.page_numbers === true;
    // 排行榜也是页码分页，但页数由上游榜单长度决定（最长 10 页 / 500 条）——
    // 翻过末页会拿到空集，这里补一句说明，免得看着像"搜索失败"
    if (rankingMode && !items.length) notices.push("已到末页（上游榜单只到这一页）");
    else if (rankingMode && !posts.length && excludedCount) notices.push("本页作品已被排除标签隐藏");
    else if (!pageMode && !nextCursor) notices.push("已到末页");
    if (request.capabilities.login === true && request.source === "pixiv" && !rankingMode) notices.push("P站标签与 Danbooru 词库不通用");
    if (request.capabilities.prompt === false && request.source === "pixiv") notices.push("P站无提示词，可下载原图喂 WD14 反推");
    const batch = rankingMode
      ? pixivRankingLabel(request.filters)
      : (pageMode ? `第 ${request.page} 页` : `第 ${Math.max(1, Number(request.batch) || 1)} 批`);
    result = {
      ...empty, posts, groups, nextCursor, warnings,
      ...(rankingMode ? { exhausted: items.length === 0 } : {}),
      status: `${request.label}：${posts.length} 张 · ${batch}` + (notices.length ? `（${notices.join("；")}）` : ""),
    };
  }
  throwIfAborted(signal);
  return result;
}
