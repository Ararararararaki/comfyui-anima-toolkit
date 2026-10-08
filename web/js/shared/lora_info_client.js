/** Metadata policy shared by the filename and configured Civitai adapters. */
export function normalizeLoraInfo(value) {
  if (!value || typeof value !== "object") return null;
  const images = (value.images || []).filter(url => typeof url === "string" && url.startsWith("http"));
  return {
    ...value,
    modelName: value.modelName || "",
    trainedWords: (value.trainedWords || []).filter(word => typeof word === "string" && word.trim()),
    tags: (value.tags || []).filter(tag => typeof tag === "string"),
    images,
    previewUrl: value.previewUrl || images[0] || null,
  };
}

function aborted(signal) {
  return signal?.reason || new DOMException("Query cancelled", "AbortError");
}

export class LoraInfoClient {
  constructor(lookup, { key = ref => JSON.stringify(ref), ttl = 300000, clock = Date.now } = {}) {
    this.lookup = lookup;
    this.key = key;
    this.ttl = ttl;
    this.clock = clock;
    this.cache = new Map();
    this.jobs = new Map();
  }
  peek(ref) {
    const key = this.key(ref), entry = this.cache.get(key);
    if (entry && entry.expires > this.clock()) return entry.value;
    this.cache.delete(key);
    return null;
  }
  get(ref, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    const key = this.key(ref), cached = this.peek(ref);
    if (cached) return Promise.resolve(cached);
    let job = this.jobs.get(key);
    if (!job) {
      job = { controller: new AbortController(), users: 0, promise: null };
      job.promise = Promise.resolve().then(() => {
        if (job.controller.signal.aborted) throw aborted(job.controller.signal);
        return this.lookup(ref, { signal: job.controller.signal });
      })
        .then(normalizeLoraInfo).then(value => {
          if (!job.controller.signal.aborted && value &&
              ["civitai", "civitaiarchive", "not_on_civitai"].includes(value.source)) {
            for (const [entryKey, entry] of this.cache) if (entry.expires <= this.clock()) this.cache.delete(entryKey);
            this.cache.set(key, { value, expires: this.clock() + this.ttl });
          }
          return value;
        });
      this.jobs.set(key, job);
      const finish = () => { if (this.jobs.get(key) === job) this.jobs.delete(key); };
      job.promise.then(finish, finish);
    }
    job.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        job.users--;
        callback(value);
      };
      const cancel = () => {
        finish(reject, aborted(signal));
        if (!job.users) {
          job.controller.abort();
          if (this.jobs.get(key) === job) this.jobs.delete(key);
        }
      };
      signal?.addEventListener("abort", cancel, { once: true });
      job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
}

export function filenameLookup(fetchFn = (...args) => fetch(...args), timeout = 35000) {
  return async ({ name }, { signal }) => {
    const response = await fetchFn("/anima/lora/info?name=" + encodeURIComponent(name), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    if (info.error || /^(http_|error_)/.test(info.source || "")) throw new Error(info.error || info.source);
    return info;
  };
}

/** A node or dialog owns this queue; disposing it releases every subscriber. */
export class LoraLookupSession {
  constructor(client, limit = 4) {
    this.client = client;
    this.limit = limit;
    this.controller = new AbortController();
    this.active = 0;
    this.queue = [];
    this.pending = new Map();
  }
  get(ref) {
    if (this.controller.signal.aborted) return Promise.reject(aborted(this.controller.signal));
    const key = this.client.key(ref);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ ref, resolve, reject });
    });
    this.pending.set(key, promise);
    const finish = () => this.pending.delete(key);
    promise.then(finish, finish);
    this._drain();
    return promise;
  }
  _drain() {
    while (!this.controller.signal.aborted && this.active < this.limit && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      const finish = () => { this.active--; this._drain(); };
      this.client.get(job.ref, { signal: this.controller.signal }).then(job.resolve, job.reject).then(finish, finish);
    }
  }
  dispose() {
    this.controller.abort();
    for (const job of this.queue.splice(0)) job.reject(aborted(this.controller.signal));
    this.pending.clear();
  }
}
