import { normalizeTags, stripFilterOwnedTokens, prepareDanbooruSearch } from "./anima_danbooru_query.js";

const ORDER_LABELS = { score: "评分", favcount: "收藏", random: "随机", rank: "综合" };

/** Fetch/prepare one D page without changing the caller's draft or view state. */
export async function fetchDanbooruPage(adapter, request, {
  signal, allowFuzzy = false, random = () => Math.random(),
} = {}) {
  checkCancelled(signal);
  const snapshot = {
    ...request,
    input: normalizeTags(stripFilterOwnedTokens(request.input || "")),
    ratings: [...(request.ratings || [])],
    filters: { ...(request.filters || {}) },
    excludeTags: [...(request.excludeTags || [])],
    randomTier: request.randomTier ? { ...request.randomTier } : null,
    page: Math.max(1, Number(request.page) || 1),
    limit: Math.max(1, Number(request.limit) || 30),
  };
  let query = snapshot.input;
  let prepared = prepare(snapshot, query);
  let account = { registered: snapshot.registered, tag_limit: snapshot.tagLimit };
  if (!prepared.query) {
    return { posts: [], query, searchQuery: "", filters: prepared.filters, account, prepared,
      status: "输入 Danbooru 标签后点“搜索”。例如：1girl solo", rawCount: 0, excludedCount: 0, unavailableCount: 0 };
  }
  let data = await searchPage(adapter, snapshot, prepared, snapshot.force, signal);
  checkCancelled(signal);
  account = responseAccount(data, account);
  let rawPosts = nativePosts(data);
  // Correction belongs to this transaction: exactly one fuzzy request and at
  // most one corrected exact search, with the collection/filter scope intact.
  if (!rawPosts.length && allowFuzzy && snapshot.filters.order !== "random") {
    const ordinary = query.split(/\s+/).filter(isOrdinaryTag).join(" ");
    if (ordinary) {
      let correction;
      try {
        correction = await adapter.correctDanbooru(ordinary, { signal });
        checkCancelled(signal);
      } catch (error) {
        checkCancelled(signal);
        if (error?.name === "AbortError") throw error;
        // Correction is optional; a failed suggestion must keep the exact page.
      }
      const corrected = correctedInput(query, correction);
      if (corrected !== query) {
        const next = prepare({ ...snapshot, filters: prepared.filters,
          registered: account.registered, tagLimit: account.tag_limit }, corrected);
        checkCancelled(signal);
        const correctedData = await searchPage(adapter, snapshot, next, false, signal);
        checkCancelled(signal);
        // Commit only after the corrected response succeeds. Keep the original
        // ordering notice even though the second preparation no longer drops it.
        next.droppedOrder ||= prepared.droppedOrder;
        prepared = next;
        query = corrected;
        data = correctedData;
        account = responseAccount(data, account);
        rawPosts = nativePosts(data);
      }
    }
  }
  checkCancelled(signal);
  const excluded = new Set(snapshot.excludeTags);
  let excludedCount = 0;
  let unavailableCount = 0;
  const posts = [];
  for (const post of rawPosts) {
    checkCancelled(signal);
    if (String(post?.tag_string || "").split(" ").some(tag => excluded.has(tag))) {
      excludedCount += 1;
    } else if (post?.large_file_url || post?.file_url || post?.preview_file_url) {
      posts.push(post);
    } else {
      unavailableCount += 1;
    }
  }
  if (prepared.shufflePage) {
    for (let index = posts.length - 1; index > 0; index -= 1) {
      checkCancelled(signal);
      const target = Math.floor(random() * (index + 1));
      [posts[index], posts[target]] = [posts[target], posts[index]];
    }
  }
  const source = snapshot.diffRootId ? `差分组 parent:${snapshot.diffRootId}` : (data.cached ? "缓存" : "D站");
  const notices = Array.isArray(data.warnings) ? data.warnings.map(String) : [];
  if (snapshot.diffRootId && posts.length <= 1) notices.push("未找到该作品的可显示差分（子帖可能已删除或隐藏）");
  if (unavailableCount) notices.push(`${unavailableCount} 张原图已失效，已跳过`);
  const tagLimit = typeof account.tag_limit === "number" && account.tag_limit > 0 ? account.tag_limit : prepared.tagLimit;
  if (prepared.droppedOrder) {
    const hint = account.registered ? `登录账号当前最多 ${tagLimit} 个计数标签` : `匿名最多 ${tagLimit} 个计数标签`;
    notices.push(`已自动移除「${ORDER_LABELS[prepared.droppedOrder] || prepared.droppedOrder}」排序，按最新显示（${hint}）`);
  }
  const excludeNotice = snapshot.excludeTags.length
    ? `已排除 ${snapshot.excludeTags.map(tag => String(tag).replace(/_/g, " ")).join("、")} ${excludedCount} 张` : "";
  if (snapshot.randomTier) notices.push(`${snapshot.randomTier.label}（${snapshot.randomTier.hint}）`);
  if (prepared.shufflePage) notices.push(`本页随机：已保留全部标签（D站 当前限 ${tagLimit} 个搜索槽，随机排序另占 1 槽）`);
  const status = `${source}：${posts.length} 张 · 第 ${snapshot.page} 页`
    + (excludeNotice ? `（${excludeNotice}）` : "") + (notices.length ? `（${notices.join("；")}）` : "");
  checkCancelled(signal);
  return { posts, query, searchQuery: prepared.query, filters: { ...prepared.filters }, status, account, prepared,
    rawCount: rawPosts.length, excludedCount, unavailableCount };
}

function prepare(snapshot, input) {
  const prepared = prepareDanbooruSearch({ ...snapshot, input });
  if (prepared.error) {
    const error = new Error(prepared.error);
    error.name = "DanbooruQuotaError";
    throw error;
  }
  return prepared;
}

async function searchPage(adapter, snapshot, prepared, force, signal) {
  checkCancelled(signal);
  const parameters = new URLSearchParams({ tags: prepared.query, page: String(snapshot.page),
    limit: String(snapshot.limit), force: force ? "1" : "0" });
  const { data } = await adapter.searchPage("danbooru", parameters, { signal });
  checkCancelled(signal);
  return data;
}

function nativePosts(data) {
  return (Array.isArray(data?.items) ? data.items : []).map(item => item?.meta?.danbooru_post || {
    id: item?.id, file_url: item?.full_url, preview_file_url: item?.preview_url,
    image_width: item?.width, image_height: item?.height,
    tag_string: Array.isArray(item?.tags) ? item.tags.join(" ") : "", rating: item?.rating, score: item?.score,
  });
}

function responseAccount(data, previous) {
  return {
    registered: typeof data?.account?.registered === "boolean" ? data.account.registered : previous.registered,
    tag_limit: typeof data?.account?.tag_limit === "number" ? data.account.tag_limit : previous.tag_limit,
  };
}

function isOrdinaryTag(token) {
  return Boolean(token) && !token.includes(":") && !["or", "(", ")"].includes(token);
}

function correctedInput(input, correction) {
  if (!correction?.changed || !correction.replacements) return input;
  return normalizeTags(input.split(/\s+/).map(token => {
    if (!isOrdinaryTag(token)) return token;
    const replacement = String(correction.replacements[token] || "").trim().toLowerCase();
    return isOrdinaryTag(replacement) && !/\s/.test(replacement) ? replacement : token;
  }).join(" "));
}

function checkCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Gallery request aborted");
  error.name = "AbortError";
  throw error;
}
