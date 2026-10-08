/** Capture host inputs once; request modules return data and never commit UI. */
import { fetchDanbooruPage } from "./anima_danbooru_search.js";
import { fetchGallerySourcePage } from "./anima_gallery_source_page.js";

/** UI adapter: only submitted source conditions cross into the request module. */
export function gallerySourceRequestSnapshot(ui, options = {}) {
  const source = String(options.source || ui.settings?.source || "danbooru");
  const entry = ui.sourceEntry?.(source);
  const capabilities = ui.sourceCapabilities?.(source) || entry?.capabilities || {};
  const extra = options.extra || {};
  const pool = Object.hasOwn(extra, "pool") ? extra.pool : ui.settings?.civitaiPool;
  return {
    source,
    label: String(ui.sourceLabel?.(source) || entry?.label || source),
    capabilities: { ...capabilities },
    query: String(options.query ?? ui.queryWidget?.value ?? ui.settings?.lastQuery ?? "").trim(),
    filters: { ...(options.filters ?? ui.settings?.sourceFilters?.[source] ?? {}) },
    excludeTags: [...(extra.excluded ?? ui.settings?.excludeTags ?? [])],
    page: options.page ?? 1,
    cursor: String(options.cursor ?? ""),
    limit: options.limit ?? 30,
    batch: options.batch ?? 1,
    poolTarget: source === "civitai" && pool?.enabled === true ? pool.target : null,
  };
}

function abortError() {
  const error = new Error("Gallery request aborted");
  error.name = "AbortError";
  return error;
}

/** Account initialization belongs to the widget, but page waiters are cancellable. */
async function waitForAccount(task, signal) {
  if (!task) return;
  if (signal?.aborted) throw abortError();
  await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    // Account failure uses the last known capability, as before.
    Promise.resolve(task).then(() => finish(resolve), () => finish(resolve));
  });
}

/** All sources use plain request snapshots, without a detached widget facade. */
export async function fetchGalleryPage(ui, options, signal) {
  if (signal?.aborted) throw abortError();
  const { source, query, page = 1, limit, force = false, allowFuzzy = false } = options;
  const sourceId = source || ui.settings?.source || "danbooru";
  const request = sourceId === "danbooru"
    ? ui.danbooruSearchSnapshot()
    : gallerySourceRequestSnapshot(ui, { ...options, source: sourceId });
  await waitForAccount(ui.accountReady, signal);
  if (signal?.aborted) throw abortError();
  const adapter = ui.sourceAdapter || ui.galleryController?.sourceAdapter;
  if (sourceId !== "danbooru") return fetchGallerySourcePage(adapter, request, { signal });
  const result = await fetchDanbooruPage(adapter, {
    ...request, input: String(query ?? ""), page, limit, force,
    registered: ui.registered, tagLimit: ui.tagLimitValue,
  }, { signal, allowFuzzy });
  if (signal?.aborted) throw abortError();
  return {
    posts: result.posts, groups: null, nextCursor: null, cursor: "",
    status: result.status, query: result.query, searchQuery: result.searchQuery,
    settings: { filters: result.filters }, account: result.account,
  };
}
