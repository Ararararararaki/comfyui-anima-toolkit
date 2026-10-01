/** Isolated adapter for the legacy gallery request policy. No live UI state is committed here. */
function cloneRequestState(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  let copy;
  if (Array.isArray(value)) copy = [];
  else if (value instanceof Map) copy = new Map();
  else if (value instanceof Set) copy = new Set();
  else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) copy = Object.create(Object.getPrototypeOf(value));
  else return value; // Promises and host objects are never written by the adapter.
  seen.set(value, copy);
  if (value instanceof Map) {
    for (const [key, entry] of value) copy.set(key, cloneRequestState(entry, seen));
  } else if (value instanceof Set) {
    for (const entry of value) copy.add(cloneRequestState(entry, seen));
  } else {
    for (const key of Object.keys(value)) copy[key] = cloneRequestState(value[key], seen);
  }
  return copy;
}

function abortError() {
  const error = new Error("Gallery request aborted");
  error.name = "AbortError";
  return error;
}


const POOL_CURSOR_PREFIX = "tk-pool:";

function readPoolCursor(cursor) {
  const raw = String(cursor ?? "");
  if (!raw.startsWith(POOL_CURSOR_PREFIX)) return { poolCursor: raw, offset: 0 };
  try {
    const value = JSON.parse(raw.slice(POOL_CURSOR_PREFIX.length));
    if (typeof value?.poolCursor !== "string" || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error();
    return value;
  } catch {
    throw new Error("C站池浏览位置已失效，请从头看");
  }
}

function writePoolCursor(poolCursor, offset) {
  return offset > 0 ? POOL_CURSOR_PREFIX + JSON.stringify({ poolCursor, offset }) : poolCursor;
}

/** Fetch one page using existing source/query rules on a detached UI facade. */
export async function fetchGalleryPage(ui, {
  source, query, page = 1, cursor = "", limit, force = false, allowFuzzy = false,
}, signal) {
  if (signal?.aborted) throw abortError();
  if (ui.accountReady) {
    try { await ui.accountReady; } catch { /* Legacy policy uses the last known account state. */ }
  }
  if (signal?.aborted) throw abortError();
  const facade = Object.create(Object.getPrototypeOf(ui));
  const seen = new Map();
  for (const key of Object.keys(ui)) facade[key] = cloneRequestState(ui[key], seen);
  facade.settings = cloneRequestState(ui.settings || {});
  facade.settings.source = source || ui.settings?.source;
  facade.settings.sourceQueries = { ...(facade.settings.sourceQueries || {}) };
  facade.queryWidget = { value: String(query ?? "") };
  facade.settings.lastQuery = facade.queryWidget.value;
  facade.page = Math.max(1, Number(page) || 1);
  facade.cursorStack = [String(cursor ?? "")];
  facade.cursorBatchSizes = [0];
  facade.nextCursor = null;
  facade.posts = [];
  facade.pixivPageGroups = null;
  facade.pixivDetail = null;
  facade.sourcePool = null;
  facade.requestId = 0;
  facade.accountReady = null;
  facade.disposed = false;
  facade.grid = null;
  facade.queryInput = null;
  facade.root = null;
  facade.node = null;
  facade.filterControls = { refresh() {} };
  facade.poolMode = () => false;
  const fixedLimit = Math.max(1, Number(limit) || 30);
  facade.resolveLimit = () => fixedLimit;
  facade.galleryPageLimit = () => fixedLimit;
  const poolEnabled = facade.settings.source === "civitai" && facade.settings.civitaiPool?.enabled === true;
  let poolPosition = poolEnabled ? readPoolCursor(cursor) : null;
  if (poolEnabled) {
    const legacyParams = facade.gallerySearchParams;
    const target = Math.min(600, Math.max(fixedLimit, Number(facade.settings.civitaiPool.target) || fixedLimit));
    facade.gallerySearchParams = (...args) => {
      const params = legacyParams.apply(facade, args);
      params.set("pool_target", String(target));
      return params;
    };
  }
  let status = "";
  let failed = false;
  facade.setStatus = (text, kind) => {
    status = String(text || "");
    failed = kind === "error" || kind === true;
  };
  facade.setQuery = (value) => { facade.queryWidget.value = String(value ?? ""); };
  for (const name of [
    "renderPosts", "renderPagination", "saveSettings", "saveUiState", "hideSuggestions",
    "fetchSuggestions", "syncReturnButton", "appendGridNotice", "autoMatchPixiv",
  ]) facade[name] = () => {};
  // Fuzzy correction and legacy retries recurse through this detached object.
  facade.search = (...args) => facade.legacySearch(...args);
  let controller = null;
  Object.defineProperty(facade, "controller", {
    configurable: true,
    get: () => controller,
    set: (value) => {
      controller = value;
      if (signal?.aborted) controller?.abort();
    },
  });
  const onAbort = () => controller?.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let fetchedCursor = String(cursor ?? "");
    for (let scanned = 0; scanned < (poolEnabled ? 3 : 1); scanned += 1) {
      if (signal?.aborted) throw abortError();
      failed = false;
      if (poolEnabled) {
        fetchedCursor = writePoolCursor(poolPosition.poolCursor, poolPosition.offset);
        facade.cursorStack = [poolPosition.poolCursor];
      }
      await facade.legacySearch({ resetPage: false, force, skipFuzzy: !allowFuzzy, append: true });
      if (signal?.aborted) throw abortError();
      if (failed) throw new Error(status || "Gallery search failed");
      if (!poolEnabled) break;
      const matches = facade.poolFilterPosts(facade.posts);
      const upstreamCursor = facade.nextCursor;
      facade.posts = matches.slice(poolPosition.offset, poolPosition.offset + fixedLimit);
      const nextOffset = poolPosition.offset + fixedLimit;
      facade.nextCursor = nextOffset < matches.length
        ? writePoolCursor(poolPosition.poolCursor, nextOffset)
        : upstreamCursor;
      if (facade.posts.length || !upstreamCursor || scanned === 2) break;
      poolPosition = { poolCursor: String(upstreamCursor), offset: 0 };
    }
    return {
      posts: facade.posts,
      groups: facade.pixivPageGroups,
      nextCursor: facade.nextCursor,
      cursor: fetchedCursor,
      status: poolEnabled ? `C站：本批 ${facade.posts.length} 张 · 已按池内关键词筛选` : status,
      query: facade.queryWidget.value,
      settings: facade.settings,
      account: { registered: facade.registered, tag_limit: facade.tagLimitValue },
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
