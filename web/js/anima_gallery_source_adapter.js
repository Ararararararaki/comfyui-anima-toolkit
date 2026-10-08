/** Source transport returns the common gallery protocol; source policy stays separate. */
export class GallerySourceAdapter {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args), timers = globalThis } = {}) {
    // Call injected functions directly; bound host dependencies retain their receiver.
    this.fetch = (...args) => fetchImpl(...args);
    // Browser timers need their Window receiver; injected timers keep their own.
    this.timers = timers;
  }

  capabilities(source, declared = {}) {
    return {
      ...declared,
      page_numbers: source === "danbooru" || declared.page_numbers === true,
      account: source === "danbooru",
    };
  }

  async search(source, parameters, { signal } = {}) {
    throwIfAborted(signal);
    const endpoint = source === "danbooru" ? "/anima/danbooru/posts" : `/anima/gallery/${encodeURIComponent(source)}/search`;
    const response = await this.fetch(`${endpoint}?${parameters}`, { signal });
    throwIfAborted(signal);
    let data;
    if (source === "danbooru") {
      const body = (await response.text()).replace(/^\uFEFF/, "").trim();
      throwIfAborted(signal);
      try {
        data = JSON.parse(body);
      } catch {
        const error = new Error("D站接口返回了无效的 JSON 响应");
        error.name = "InvalidJSONResponseError";
        error.httpStatus = response.status;
        error.contentType = response.headers?.get?.("content-type") || "";
        throw error;
      }
      data = {
        ...data,
        items: (Array.isArray(data.posts) ? data.posts : []).map(danbooruGalleryItem),
        next_cursor: null,
        account: { registered: data.registered, tag_limit: data.tag_limit },
      };
      delete data.posts;
    } else {
      data = await response.json().catch(() => null);
      throwIfAborted(signal);
    }
    return { response, data };
  }

  /** One page transaction. Retries retain exactly the same query/page/force. */
  async searchPage(source, parameters, { signal } = {}) {
    const query = String(parameters);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await this.withDeadline(async (requestSignal) => {
          const result = await this.search(source, query, { signal: requestSignal });
          throwIfAborted(requestSignal);
          if (!result.response.ok) {
            const error = new Error(result.data?.error || `HTTP ${result.response.status}`);
            error.name = "GallerySearchHTTPError";
            error.httpStatus = result.response.status;
            error.account = result.data?.account;
            throw error;
          }
          return result;
        }, signal, source);
      } catch (error) {
        throwIfAborted(signal);
        if (attempt === 2 || !retryable(error)) throw error;
        await this.wait(attempt === 0 ? 250 : 750, signal);
      }
    }
  }

  /** Fuzzy correction is a single bounded request, never another retry policy. */
  async correctDanbooru(query, { signal } = {}) {
    return this.withDeadline(async (requestSignal) => {
      const response = await this.fetch(`/anima/danbooru/fuzzy?tags=${encodeURIComponent(query)}`, { signal: requestSignal });
      throwIfAborted(requestSignal);
      const data = await response.json();
      throwIfAborted(requestSignal);
      if (!response.ok) {
        const error = new Error(data?.error || `HTTP ${response.status}`);
        error.name = "GallerySearchHTTPError";
        error.httpStatus = response.status;
        throw error;
      }
      return data;
    }, signal, "danbooru");
  }

  async withDeadline(operation, signal, source) {
    throwIfAborted(signal);
    const controller = new AbortController();
    let timer;
    let onAbort;
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => { reject(abortError()); controller.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = this.timers.setTimeout(() => {
        const error = new Error(`搜索超时（45 秒）：${source === "danbooru" ? "D站" : "图源"} 或代理网络不稳定，请检查 Clash 节点后重试`);
        error.name = "GallerySearchTimeoutError";
        reject(error);
        controller.abort();
      }, 45000);
    });
    try {
      // A fetch implementation or response body may ignore AbortSignal. The
      // race still releases the caller promptly, and a late result cannot win.
      const result = await Promise.race([operation(controller.signal), interrupted]);
      throwIfAborted(signal);
      throwIfAborted(controller.signal);
      return result;
    } finally {
      this.timers.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async wait(milliseconds, signal) {
    throwIfAborted(signal);
    let timer;
    let onAbort;
    try {
      await new Promise((resolve, reject) => {
        onAbort = () => reject(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = this.timers.setTimeout(resolve, milliseconds);
      });
      throwIfAborted(signal);
    } finally {
      this.timers.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function abortError() {
  const error = new Error("Gallery request aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function retryable(error) {
  const status = Number(error?.httpStatus);
  if (status >= 400 && status < 500) return false;
  return error?.name === "TypeError" || error?.name === "InvalidJSONResponseError" || [502, 503, 504].includes(status);
}

/** Native tag groups/parent ids remain available to prompt and difference views. */
export function danbooruGalleryItem(post) {
  const full = String(post?.file_url || post?.large_file_url || post?.preview_file_url || "");
  return {
    source: "danbooru", id: post?.id == null ? "" : String(post.id),
    preview_url: String(post?.preview_file_url || post?.large_file_url || full), full_url: full,
    width: post?.image_width ?? null, height: post?.image_height ?? null,
    tags: String(post?.tag_string || "").split(/\s+/).filter(Boolean),
    prompt: null, negative_prompt: null, rating: post?.rating ?? null, score: post?.score ?? null,
    source_url: post?.id == null ? "" : `https://danbooru.donmai.us/posts/${post.id}`,
    meta: { fav_count: post?.fav_count ?? null, danbooru_post: post },
  };
}
