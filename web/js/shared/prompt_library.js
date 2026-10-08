// Shared durable Prompt-library policy. Browser storage is an adapter; short phrase cards use a separate library.
const ENDPOINT = '/anima/prompt-library';
const PENDING_KEY = 'tk_prompt_library_pending_deletes_v1';
const DELETED_KEY = 'tk_prompt_library_deleted_ids_v1';
const cleanIds = ids => [...new Set((ids || []).map(id => String(id).trim()).filter(Boolean))];
const recordTime = row => Number(row.updatedAt || row.createdAt || 0);
const empty = () => ({ schemaVersion: 1, updatedAt: 0, categories: [], prompts: [] });

function mergeRecords(remote, local, newer) {
  const records = new Map((remote || []).filter(row => row?.id).map(row => [String(row.id), row]));
  for (const row of local || []) {
    if (!row?.id) continue;
    const old = records.get(String(row.id));
    if (!old || !newer || recordTime(row) >= recordTime(old)) records.set(String(row.id), row);
  }
  return [...records.values()];
}

export class PromptLibrary {
  constructor({ store, request = (...args) => fetch(...args), pendingStorage = null,
    now = Date.now, timers = { setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: id => clearTimeout(id) }, maxSnapshotBytes = 60 * 1024 * 1024 }) {
    this.store = store;
    this.request = request;
    this.pendingStorage = pendingStorage;
    this.now = now;
    this.timers = timers;
    this.maxSnapshotBytes = maxSnapshotBytes;
    this.listeners = new Set();
    this.localQueue = Promise.resolve();
    this.pendingDeletes = new Set();
    try { this.pendingDeletes = new Set(cleanIds(JSON.parse(pendingStorage?.getItem(PENDING_KEY) || '[]'))); }
    catch { /* Private browsing can still use the in-memory pending set. */ }
    this.deletedIds = new Set(this.pendingDeletes);
    this.revision = 0;
    this.loaded = false;
    this.loading = null;
    this.syncing = null;
    this.syncTimer = null;
    this.state = { status: 'idle', dirty: false, error: null, pendingDeletes: [...this.pendingDeletes], snapshot: null };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  _publish(change) {
    this.state = { ...this.state, ...change, pendingDeletes: [...this.pendingDeletes] };
    for (const listener of this.listeners) listener(this.state);
  }

  _local(operation) {
    const task = this.localQueue.then(operation);
    this.localQueue = task.catch(() => {});
    return task;
  }

  _savePending(acknowledged = []) {
    // Panel and node instances share storage. Acknowledging our request must not erase a later deletion from another view.
    let persisted = new Set();
    try { persisted = new Set(cleanIds(JSON.parse(this.pendingStorage?.getItem(PENDING_KEY) || '[]'))); }
    catch { /* An unreadable pending cache does not hide the in-memory intents. */ }
    for (const id of acknowledged) persisted.delete(id);
    for (const id of persisted) { this.pendingDeletes.add(id); this.deletedIds.add(id); }
    this.pendingStorage?.setItem(PENDING_KEY, JSON.stringify([...this.pendingDeletes]));
    // Acknowledgement clears retry work, not deletion history: another view may still hold an older GET response.
    try {
      for (const id of cleanIds(JSON.parse(this.pendingStorage?.getItem(DELETED_KEY) || '[]'))) this.deletedIds.add(id);
    } catch { /* Preserve the in-memory tombstones if the shared history cannot be read. */ }
    this.pendingStorage?.setItem(DELETED_KEY, JSON.stringify([...this.deletedIds]));
  }

  _withoutDeleted(snapshot) {
    return {
      ...snapshot,
      categories: snapshot.categories?.filter(row => !this.deletedIds.has(String(row.id))),
      prompts: snapshot.prompts?.filter(row => !this.deletedIds.has(String(row.id)))
        .map(row => this.deletedIds.has(String(row.categoryId)) ? { ...row, categoryId: 'uncategorized' } : row),
    };
  }

  async _reconcileLocal() {
    let snapshot = await this.store.read();
    for (;;) {
      // Storage operations yield. Check the shared history again after each write so a concurrent deletion wins.
      this._savePending();
      const moved = snapshot.prompts.filter(row => !this.deletedIds.has(String(row.id)) && this.deletedIds.has(String(row.categoryId)))
        .map(row => ({ ...row, categoryId: 'uncategorized' }));
      const removed = [...snapshot.categories, ...snapshot.prompts].some(row => this.deletedIds.has(String(row.id)));
      if (!removed && !moved.length) return snapshot;
      if (moved.length) await this.store.write({ prompts: moved });
      if (removed) await this.store.remove([...this.deletedIds]);
      snapshot = await this.store.read();
    }
  }

  _schedule() {
    if (this.syncTimer !== null) this.timers.clearTimeout(this.syncTimer);
    this.syncTimer = this.timers.setTimeout(() => {
      this.syncTimer = null;
      void this._sync();
    }, 800);
  }

  async _json(path, options) {
    const response = await this.request(path, options);
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    return payload;
  }

  async load({ refresh = false } = {}) {
    if (this.loading) return this.loading;
    if (this.loaded && !refresh) return this._local(() => this._reconcileLocal());
    this._publish({ status: 'loading', error: null });
    const task = (async () => {
      try {
        this._savePending();
        const payload = await this._json(ENDPOINT, { cache: 'no-store' });
        const remote = payload.snapshot || empty();
        const deleted = Array.isArray(remote.deletedIds) ? remote.deletedIds
          : (await this._json(ENDPOINT + '/deleted', { cache: 'no-store' })).deletedIds || [];
        for (const id of cleanIds(deleted)) this.deletedIds.add(id);
        const snapshot = await this._local(async () => {
          // Read after the remote request: edits made during hydration must participate in the merge.
          const local = await this.store.read();
          this._savePending();
          const merged = this._withoutDeleted({
            schemaVersion: 1,
            updatedAt: Math.max(remote.updatedAt || 0, local.updatedAt || 0, this.now()),
            categories: mergeRecords(remote.categories, local.categories, false),
            prompts: mergeRecords(remote.prompts, local.prompts, true),
          });
          await this.store.write(merged);
          return this._reconcileLocal();
        });
        this.loaded = true;
        this.revision++;
        this._publish({ status: 'idle', dirty: true, error: null, snapshot });
        this._schedule();
        return snapshot;
      } catch (error) {
        this.loaded = false;
        const snapshot = await this._local(() => this.store.read());
        this._publish({ status: 'offline', error: `Prompt 库镜像读取失败：${error.message}`, snapshot });
        return snapshot;
      }
    })();
    this.loading = task;
    try { return await task; } finally { if (this.loading === task) this.loading = null; }
  }

  async upsert(changes = {}, { flush = false } = {}) {
    await this._local(async () => {
      this._savePending();
      await this.store.write(this._withoutDeleted(changes));
      this.revision++;
      this._publish({ dirty: true, snapshot: await this._reconcileLocal() });
    });
    if (flush) return this._sync();
    this._schedule();
    return true;
  }

  async remove(selection) {
    const changes = Array.isArray(selection) ? { prompts: selection } : selection;
    const categories = cleanIds(changes.categories);
    const ids = cleanIds([...(changes.prompts || []), ...categories]);
    if (!ids.length) return true;
    await this._local(async () => {
      for (const id of ids) { this.pendingDeletes.add(id); this.deletedIds.add(id); }
      // Save intent before deleting locally, so a failed remote request can be retried after reload.
      this._savePending();
      const local = await this.store.read();
      const affected = local.prompts.filter(row => categories.includes(String(row.categoryId)))
        .map(row => ({ ...row, categoryId: 'uncategorized' }));
      if (affected.length) await this.store.write({ prompts: affected });
      await this.store.remove(ids);
      this.revision++;
      this._publish({ dirty: true, snapshot: await this._reconcileLocal() });
    });
    return this._sync();
  }

  async _sync() {
    if (this.syncing) return this.syncing;
    const task = (async () => {
      if (!this.loaded) await this.load();
      if (this.syncTimer !== null) { this.timers.clearTimeout(this.syncTimer); this.syncTimer = null; }
      if (!this.loaded) return false;
      try {
        do {
          this._publish({ status: 'syncing', error: null });
          this._savePending();
          const revision = this.revision;
          const deletes = [...this.pendingDeletes];
          if (deletes.length) {
            await this._json(ENDPOINT + '/delete', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: deletes }),
            });
            for (const id of deletes) this.pendingDeletes.delete(id);
            this._savePending(deletes);
          }
          const snapshot = await this._local(() => this._reconcileLocal());
          const deletedCount = this.deletedIds.size;
          const body = JSON.stringify({ ...snapshot, schemaVersion: 1, deletedIds: [...this.deletedIds] });
          if (new TextEncoder().encode(body).byteLength > this.maxSnapshotBytes) {
            throw new Error('Prompt 库体积超过镜像上限，本地更改已保留；缩小后可重试同步');
          }
          // Ordinary fetch is required: keepalive rejects bodies above 64 KB in Chromium.
          await this._json(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          this._savePending();
          if (deletedCount !== this.deletedIds.size || this.pendingDeletes.size) this._publish({ dirty: true });
          else if (revision === this.revision) this._publish({ status: 'synced', dirty: false, error: null, snapshot });
        } while (this.state.dirty);
        return true;
      } catch (error) {
        this._publish({ status: 'offline', dirty: true, error: `Prompt 库镜像同步失败：${error.message}` });
        return false;
      }
    })();
    this.syncing = task;
    try { return await task; } finally { if (this.syncing === task) this.syncing = null; }
  }
}
