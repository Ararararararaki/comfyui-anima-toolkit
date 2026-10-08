// D search rules shared by query composition, quota preparation and preset notes.
// Filters and ratings are normalized by their owning controls before calling here.
const MAX_TAGS = 8;
const FREE_METATAGS = new Set([
  "rating", "status", "is", "age", "date", "id", "limit", "score", "downvotes", "favcount",
  "width", "height", "ratio", "mpixels", "filesize", "filetype", "duration", "md5",
  "pixiv_id", "pixiv", "parent", "child", "upvote", "embedded", "tagcount", "order",
]);
const COUNTED_METATAGS = new Set(["order", "ordfav"]);
const FILTER_OWNED_PREFIXES = new Set([
  "rating", "age", "score", "favcount", "mpixels", "ratio", "filetype", "order",
  "limit", "status", "is", "date", "id",
]);
const RATIO_TOKENS = {
  wide: "ratio:>1", tall: "ratio:<1", square: "ratio:>=0.9 ratio:<=1.1", ultrawide: "ratio:>=1.5",
};
const FILETYPE_TOKENS = {
  static: "-filetype:gif -filetype:mp4 -filetype:webm", gif: "filetype:gif", video: "filetype:mp4",
};

/** Preset notes distinguish filter metadata from content tags, separately from quota. */
export function isDanbooruMetaTag(prefix) {
  return FREE_METATAGS.has(String(prefix).toLowerCase());
}

export function normalizeTags(rawValue) {
  const seen = new Set();
  const tokens = [];
  for (const rawToken of String(rawValue ?? "").trim().split(/\s+/)) {
    const token = rawToken.trim().toLowerCase();
    // The filter owns sorting; typed order tokens must not create a second owner.
    if (!token || token.startsWith("order:") || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= MAX_TAGS) break;
  }
  return tokens.join(" ");
}

export function stripFilterOwnedTokens(rawValue) {
  return String(rawValue ?? "").trim().split(/\s+/).filter(Boolean).filter((token) => {
    const body = token.replace(/^[-~]+/, "").toLowerCase();
    const colon = body.indexOf(":");
    return colon < 0 || !FILTER_OWNED_PREFIXES.has(body.slice(0, colon));
  }).join(" ");
}

export function countedSearchTerms(query) {
  return String(query || "").split(/\s+/).filter(Boolean).filter((rawToken) => {
    const token = rawToken.replace(/^[-~]+/, "").toLowerCase();
    if (token === "or" || token === "(" || token === ")") return false;
    const colon = token.indexOf(":");
    if (colon < 0) return true;
    const prefix = token.slice(0, colon);
    return COUNTED_METATAGS.has(prefix) || !FREE_METATAGS.has(prefix);
  }).length;
}

export function effectiveDanbooruTagLimit(value) {
  return typeof value === "number" && value > 0 ? value : 2;
}

export function composeDanbooruQuery({ input = "", ratings = [], filters = {} } = {}) {
  const age = filters.age || (filters.ageDays ? `${filters.ageDays}days` : "");
  const parts = [
    normalizeTags(stripFilterOwnedTokens(input)),
    ratings.length ? `rating:${ratings.join(",")}` : "",
    age ? `age:<${age}` : "",
    filters.minScore ? `score:>${filters.minScore}` : "",
    filters.minFavs ? `favcount:>${filters.minFavs}` : "",
    filters.minMpixels ? `mpixels:>=${filters.minMpixels}` : "",
    RATIO_TOKENS[filters.ratio] || "",
    FILETYPE_TOKENS[filters.filetype] || "",
    filters.order ? `order:${filters.order}` : "",
  ];
  const seen = new Set();
  return parts.filter((part) => {
    if (!part) return false;
    const key = String(part).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(" ");
}

/** Produce a request snapshot; sorting may degrade, content and collection scope may not. */
export function prepareDanbooruSearch({
  input = "", ratings = [], filters = {}, favoritesOnly = false,
  favoriteQuery = "", registered = false, tagLimit,
} = {}) {
  const preparedFilters = { ...filters };
  const limit = effectiveDanbooruTagLimit(tagLimit);
  const favoriteTag = favoritesOnly ? String(favoriteQuery || "") : "";
  const compose = () => {
    const query = composeDanbooruQuery({ input, ratings, filters: preparedFilters });
    return favoriteTag ? (query ? `${favoriteTag} ${query}` : favoriteTag) : query;
  };
  let query = compose();
  let droppedOrder = false;
  let shufflePage = false;
  let counted = countedSearchTerms(query);
  if (counted > limit && preparedFilters.order === "random") {
    shufflePage = true;
    query = query.split(/\s+/).filter((token) => !/^order:random$/i.test(token)).join(" ");
    counted = countedSearchTerms(query);
  }
  if (counted > limit && preparedFilters.order && !shufflePage) {
    droppedOrder = preparedFilters.order;
    preparedFilters.order = "";
    // Rebuilding must retain ordfav; losing it would broaden a collection query.
    query = compose();
    counted = countedSearchTerms(query);
  }
  const error = counted > limit
    ? (registered
      ? `D站 登录账号当前最多 ${limit} 个计数标签（按等级：Member=2，Gold=6）。请减少普通标签，或改用评级/时间/评分/收藏筛选。`
      : `D站 匿名搜索最多 ${limit} 个计数标签（普通标签与排序各占 1 个）。登录后上限按账号等级提升：Member 仍为 2，Gold 为 6。`)
    : null;
  return { query, filters: preparedFilters, droppedOrder, shufflePage, error, tagLimit: limit };
}
