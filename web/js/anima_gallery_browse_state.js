// Pure navigation state: no DOM, network calls, or workflow output mutations.
const positiveInteger = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const pageNumber = (value) => positiveInteger(value, null);

export class GalleryBrowseState {
  constructor({ pageLimit = 30, pageNumbers = true, cachePageLimit = 12, cachePostLimit = 600, domPostLimit = 300 } = {}) {
    this.pageLimit = positiveInteger(pageLimit, 30);
    this.pageNumbers = Boolean(pageNumbers);
    this.cachePageLimit = positiveInteger(cachePageLimit, 12);
    this.cachePostLimit = positiveInteger(cachePostLimit, 600);
    this.domPostLimit = positiveInteger(domPostLimit, 300);
    this.generation = 0;
    this.navigation = 0;
    this.key = '';
    this.visiblePage = 1;
    this.returnLocation = null;
    this.pages = new Map();
    this.cursors = new Map([[1, '']]);
  }

  reset({ key = '', pageLimit = this.pageLimit, pageNumbers = this.pageNumbers } = {}) {
    this.key = String(key);
    this.pageLimit = positiveInteger(pageLimit, this.pageLimit);
    this.pageNumbers = Boolean(pageNumbers);
    this.generation += 1;
    this.navigation += 1;
    this.visiblePage = 1;
    this.returnLocation = null;
    this.pages.clear();
    this.cursors.clear();
    this.cursors.set(1, '');
    return this.token();
  }

  beginNavigation() {
    this.navigation += 1;
    return this.token();
  }

  token() {
    return { generation: this.generation, navigation: this.navigation };
  }

  isCurrent(token) {
    return Boolean(token && token.generation === this.generation && token.navigation === this.navigation);
  }

  _rememberCursor(page, cursor) {
    if (!pageNumber(page) || typeof cursor !== 'string') return;
    this.cursors.delete(page);
    this.cursors.set(page, cursor);
    while (this.cursors.size > 1000) {
      const victim = [...this.cursors.keys()].find((number) => number !== 1 && number !== this.visiblePage);
      if (victim === undefined) break;
      this.cursors.delete(victim);
    }
  }

  putPage(page, { posts, groups = null, cursor = '', nextCursor = null, exhausted = false }) {
    page = pageNumber(page);
    if (!page || !Array.isArray(posts)) return null;
    const visible = page !== this.visiblePage ? this.pages.get(this.visiblePage) : null;
    // Keep pages whole. Reject malformed oversized responses rather than evicting
    // the visible page or breaking the memory bound to install a navigation target.
    if (posts.length + (visible?.posts.length || 0) > this.cachePostLimit || (visible && this.cachePageLimit < 2)) return null;
    const entry = { page, posts: posts.slice(), groups: groups instanceof Map ? new Map(groups) : null,
      cursor: typeof cursor === 'string' ? cursor : '', nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
      exhausted: Boolean(exhausted) };
    this.pages.delete(page);
    this.pages.set(page, entry);
    this._rememberCursor(page, entry.cursor);
    if (entry.nextCursor !== null) this._rememberCursor(page + 1, entry.nextCursor);
    let count = [...this.pages.values()].reduce((total, item) => total + item.posts.length, 0);
    while (this.pages.size > this.cachePageLimit || count > this.cachePostLimit) {
      const victim = [...this.pages.keys()].find((number) => number !== page && number !== this.visiblePage);
      if (victim === undefined) break;
      count -= this.pages.get(victim).posts.length;
      this.pages.delete(victim);
    }
    return entry;
  }

  getPage(page) {
    page = pageNumber(page);
    const entry = this.pages.get(page);
    if (!entry) return null;
    this.pages.delete(page);
    this.pages.set(page, entry);
    return entry;
  }

  hasPage(page) {
    return this.pages.has(pageNumber(page));
  }

  cursorFor(page) {
    page = pageNumber(page);
    if (!page) return undefined;
    const cursor = page === 1 ? '' : this.cursors.has(page) ? this.cursors.get(page) : this.pages.get(page)?.cursor;
    if (cursor !== undefined) this._rememberCursor(page, cursor);
    return cursor;
  }

  knownPages() {
    return [...new Set([...this.cursors.keys(), ...this.pages.keys()])].sort((a, b) => a - b);
  }

  setVisiblePage(page) {
    page = pageNumber(page);
    if (!page) return;
    this.visiblePage = page;
    const cursor = this.cursorFor(page);
    if (cursor !== undefined) this._rememberCursor(page, cursor);
  }

  windowPages(page, { continuous = true } = {}) {
    page = pageNumber(page);
    const target = this.getPage(page);
    if (!target || target.posts.length > this.domPostLimit) return [];
    if (!continuous) return [target];
    const result = [target];
    let count = target.posts.length;
    // Never join disconnected cached segments. Favor the next page, which is
    // where continuous browsing is headed, before filling space above it.
    for (let number = page + 1; this.pages.has(number); number += 1) {
      const entry = this.pages.get(number);
      if (count + entry.posts.length > this.domPostLimit) break;
      count += entry.posts.length;
      result.push(this.getPage(number));
    }
    for (let number = page - 1; this.pages.has(number); number -= 1) {
      const entry = this.pages.get(number);
      if (count + entry.posts.length > this.domPostLimit) break;
      count += entry.posts.length;
      result.unshift(this.getPage(number));
    }
    return result;
  }
}

function progressRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const page = pageNumber(value.page);
  const pageLimit = positiveInteger(value.pageLimit, null);
  if (!page || !pageLimit) return null;
  const record = { page, pageLimit, updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now() };
  if (value.anchor && typeof value.anchor.key === 'string' && value.anchor.key && Number.isFinite(Number(value.anchor.offset))) {
    record.anchor = { key: value.anchor.key, offset: Number(value.anchor.offset) };
  } else record.anchor = null;
  record.cursor = typeof value.cursor === 'string' ? value.cursor : null;
  const records = Array.isArray(value.records) ? value.records : [];
  const cursors = new Map();
  for (const item of records) {
    const number = pageNumber(item?.page);
    if (number && typeof item?.cursor === 'string') {
      cursors.delete(number);
      cursors.set(number, { page: number, cursor: item.cursor });
    }
  }
  record.records = [...cursors.values()].slice(-12);
  return record;
}

// Browser storage can be blocked, full, or corrupt. Navigation remains usable
// through the in-memory copy; only metadata is ever serialized.
export class GalleryProgressStore {
  constructor({ storage, namespace = 'anima.gallery.progress', limit = 12 } = {}) {
    this.storage = storage;
    this.namespace = String(namespace);
    this.limit = positiveInteger(limit, 12);
    this.records = new Map();
    try {
      const raw = storage?.getItem(this.namespace);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.records)) return;
      for (const item of data.records) {
        const record = progressRecord(item?.record);
        if (typeof item?.key === 'string' && record) this.records.set(item.key, record);
      }
      this._trim();
    } catch {
      this.storage = null;
    }
  }

  _trim() {
    while (this.records.size > this.limit) this.records.delete(this.records.keys().next().value);
  }

  _persist() {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.namespace, JSON.stringify({ version: 1, records: [...this.records].map(([key, record]) => ({ key, record })) }));
    } catch {
      this.storage = null;
    }
  }

  load(key) {
    key = String(key);
    const record = this.records.get(key);
    if (!record) return null;
    this.records.delete(key);
    this.records.set(key, record);
    this._persist();
    return progressRecord(record);
  }

  save(key, value) {
    const record = progressRecord(value);
    if (!record) return false;
    key = String(key);
    this.records.delete(key);
    this.records.set(key, record);
    this._trim();
    this._persist();
    return true;
  }

  remove(key) {
    this.records.delete(String(key));
    this._persist();
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function galleryBrowseKey({ source, query, filters, limit, extra } = {}) {
  return JSON.stringify(stableValue({ source: String(source || ''), query: String(query || '').trim(), filters: filters || {}, limit, extra: extra || {} }));
}

export function currentGalleryWorkflowId(app, node = null) {
  const active = app?.extensionManager?.workflow?.activeWorkflow;
  for (const value of [node?.graph?.id, active?.activeState?.id, active?.path, active?.key, app?.workflow?.id, app?.activeWorkflow?.id, app?.workflow?.name, app?.activeWorkflow?.name]) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return 'default';
}
