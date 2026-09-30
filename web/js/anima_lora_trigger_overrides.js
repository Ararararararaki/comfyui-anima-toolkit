// Shared per-file manual words. Automatic Civitai metadata remains a separate source.
const normalize = name => String(name).trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
export class TriggerOverrideClient {
  constructor(request = (...args) => fetch(...args)) {
    this.request = request;
    this.entries = new Map();
    this.names = new Map();
    this.pending = new Map();
    this.listeners = new Set();
    this.generation = 0;
  }
  entry(name) { return this.entries.get(normalize(name)); }
  words(name, automatic) {
    const entry = this.entry(name);
    return entry?.hasOverride ? entry.words : automatic;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async _request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("请求超时，请稍后重试")), 15000);
    try {
      const response = await this.request(url, {...options, signal: controller.signal});
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || `请求失败 (${response.status})`);
      return data;
    } finally { clearTimeout(timer); }
  }
  _apply(data) {
    const changed = [];
    for (const [name, value] of Object.entries(data.loras || {})) {
      const key = normalize(name);
      if (JSON.stringify(this.entries.get(key)) !== JSON.stringify(value)) changed.push(key);
      this.entries.set(key, value);
    }
    if (changed.length) for (const listener of this.listeners) listener(changed);
  }
  async load(names, refresh = false) {
    const needed = [...new Set(names)].filter(name => {
      const key = normalize(name); this.names.set(key, name);
      return refresh || !this.entries.has(key);
    });
    if (!needed.length) return;
    // Keep requests short enough for servers with an 8 KB URL limit.
    const chunks = [];
    let chunk = [], length = 0;
    for (const name of needed) {
      const size = encodeURIComponent(JSON.stringify(name)).length + 3;
      if (chunk.length && length + size > 4500) { chunks.push(chunk); chunk = []; length = 0; }
      chunk.push(name); length += size;
    }
    if (chunk.length) chunks.push(chunk);
    await Promise.all(chunks.map(async names => {
      const url = "/anima/lora_trigger_overrides?names=" + encodeURIComponent(JSON.stringify(names));
      if (this.pending.has(url)) return this.pending.get(url);
      const generation = this.generation;
      const promise = this._request(url).then(async data => {
        // A slow read started before a save must not overwrite its confirmed result.
        if (generation === this.generation) this._apply(data);
        else {
          this.pending.delete(url);
          await this.load(names, true);
        }
      }).finally(() => { if (this.pending.get(url) === promise) this.pending.delete(url); });
      this.pending.set(url, promise);
      return promise;
    }));
    if (needed.some(name => !this.entries.has(normalize(name)))) throw new Error("自定义触发词响应不完整");
  }
  async save(name, words, reset = false) {
    const data = await this._request("/anima/lora_trigger_overrides", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({name, words, action: reset ? "reset" : "save"}),
    });
    this.generation++;
    this._apply(data);
    return data;
  }
}

export const triggerOverrides = new TriggerOverrideClient();
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("tk-lora-trigger-overrides") : null;
const refresh = () => triggerOverrides.load([...triggerOverrides.names.values()], true).catch(error => console.warn("[TK] 自定义触发词刷新失败", error));
if (typeof window !== "undefined") window.addEventListener("focus", refresh);
if (channel) channel.onmessage = refresh;
export async function saveTriggerOverride(name, words, reset) {
  await triggerOverrides.save(name, words, reset);
  channel?.postMessage({changed: true});
}

export function openTriggerWordEditor(anchor, name, automaticWords, {onClose} = {}) {
  installStyles();
  const editor = document.createElement("div");
  editor.className = "tk-trigger-editor";
  editor.setAttribute("role", "dialog"); editor.setAttribute("aria-label", "编辑 LoRA 触发词");
  const heading = document.createElement("strong"); heading.textContent = "编辑触发词";
  const filename = document.createElement("div"); filename.className = "tk-trigger-filename"; filename.textContent = name;
  const hint = document.createElement("p"); hint.textContent = "此 LoRA 在本机的所有节点共用。每行一段；保存空白可停用触发词。";
  const input = document.createElement("textarea"); input.setAttribute("aria-label", "自定义触发词"); input.maxLength = 20000; input.rows = 5; input.disabled = true;
  input.placeholder = "例如：character name\n(style:1.2), detailed background";
  const details = document.createElement("details");
  const summary = document.createElement("summary"); summary.textContent = "查看自动提取的触发词";
  const auto = document.createElement("pre"); auto.textContent = "读取中…";
  const fill = document.createElement("button"); fill.type = "button"; fill.textContent = "填入自动词";
  details.append(summary, auto, fill);
  const status = document.createElement("div"); status.className = "tk-trigger-status"; status.setAttribute("role", "status");
  const actions = document.createElement("div"); actions.className = "tk-trigger-actions";
  const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "恢复自动";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消";
  const save = document.createElement("button"); save.type = "button"; save.textContent = "保存"; save.className = "tk-trigger-save";
  actions.append(reset, cancel, save); editor.append(heading, filename, hint, input, details, status, actions);
  const buttons = [reset, save, fill];
  let closed = false, busy = false, automatic = [], loaded = false;
  const position = () => {
    const rect = anchor.getBoundingClientRect();
    editor.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - editor.offsetWidth - 8)) + "px";
    editor.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - editor.offsetHeight - 8)) + "px";
  };
  const resizeObserver = new ResizeObserver(position);
  const close = (force = false) => {
    if ((!force && busy) || closed) return;
    closed = true; editor.remove();
    resizeObserver.disconnect();
    window.removeEventListener("resize", position);
    document.removeEventListener("scroll", position, true);
    document.removeEventListener("pointerdown", outside, true);
    onClose?.(); if (anchor.isConnected) anchor.focus();
  };
  const outside = event => { if (!editor.contains(event.target) && event.target !== anchor) close(); };
  cancel.onclick = () => close();
  fill.onclick = () => { input.value = automatic.join("\n"); input.focus(); };
  const persist = async restore => {
    if (!loaded || busy) return;
    busy = true; [...buttons, cancel].forEach(button => button.disabled = true); input.disabled = true;
    status.textContent = "保存中…";
    try {
      await saveTriggerOverride(name, input.value, restore);
      busy = false; close();
    } catch (error) {
      busy = false; [...buttons, cancel].forEach(button => button.disabled = false); input.disabled = false;
      status.textContent = error.message; input.focus();
    }
  };
  save.onclick = () => persist(false); reset.onclick = () => persist(true);
  editor.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); persist(false); }
    if (event.key === "Tab") {
      const focusable = [...editor.querySelectorAll("textarea, summary, button")].filter(el => !el.disabled && el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  document.body.appendChild(editor); position(); resizeObserver.observe(editor); cancel.focus();
  window.addEventListener("resize", position); document.addEventListener("scroll", position, true);
  document.addEventListener("pointerdown", outside, true);
  buttons.forEach(button => button.disabled = true); status.textContent = "读取中…";
  triggerOverrides.load([name], true).then(async () => {
    if (closed) return;
    const entry = triggerOverrides.entry(name);
    if (!entry?.editable) throw new Error("无法唯一匹配本地 LoRA，请使用完整相对路径及扩展名");
    automatic = entry.automaticWords || [];
    input.value = (entry.hasOverride ? entry.words : automatic).join("\n");
    loaded = true; input.disabled = false; buttons.forEach(button => button.disabled = false);
    status.textContent = entry.hasOverride ? "当前使用自定义词 · Ctrl+Enter 保存" : "当前使用自动词 · Ctrl+Enter 保存";
    auto.textContent = automatic.length ? automatic.join("\n") : "自动提取结果为空，可在上方手动填写。";
    input.focus(); position();
    // Fetch missing automatic metadata only for the reference, never replace a draft.
    const fetched = await automaticWords();
    if (closed) return;
    if (Array.isArray(fetched)) { automatic = fetched; auto.textContent = automatic.join("\n") || "自动提取结果为空"; }
  }).catch(error => { if (!closed) status.textContent = error.message; });
  return {close};
}

function installStyles() {
  if (document.getElementById("tk-trigger-editor-style")) return;
  const style = document.createElement("style"); style.id = "tk-trigger-editor-style";
  style.textContent = `
    .tk-trigger-editor { position:fixed; z-index:10020; width:min(360px,calc(100vw - 32px)); max-height:calc(100vh - 16px); overflow:auto; box-sizing:border-box; padding:16px; border:1px solid var(--border-color); border-radius:12px; background:var(--comfy-menu-bg,var(--comfy-input-bg)); color:var(--fg-color); box-shadow:0 10px 32px #0004; font:12px/1.5 system-ui,sans-serif; }
    .tk-trigger-editor strong {font-size:14px;} .tk-trigger-filename {margin-top:5px; overflow-wrap:anywhere; color:var(--descrip-text);}
    .tk-trigger-editor p { margin:12px 0 8px; color:var(--descrip-text); }
    .tk-trigger-editor textarea {width:100%; box-sizing:border-box; resize:vertical; min-height:90px; padding:10px; color:var(--fg-color); background:var(--comfy-input-bg); border:1px solid var(--border-color); border-radius:7px; font:12px/1.5 system-ui;}
    .tk-trigger-editor details {margin:10px 0;} .tk-trigger-editor summary {cursor:pointer; color:var(--descrip-text);}
    .tk-trigger-editor pre {white-space:pre-wrap; overflow-wrap:anywhere; color:var(--descrip-text); font:inherit;}
    .tk-trigger-editor button {padding:6px 10px; border:1px solid var(--border-color); border-radius:7px; background:var(--comfy-input-bg); color:var(--fg-color); cursor:pointer; font:inherit;}
    .tk-trigger-editor button:disabled {opacity:.45; cursor:default;} .tk-trigger-status {min-height:18px; color:var(--descrip-text);}
    .tk-trigger-actions {display:flex; gap:8px; margin-top:12px;} .tk-trigger-actions button:first-child {margin-right:auto;}
    .tk-trigger-editor .tk-trigger-save {border-color:var(--p-primary-color); color:var(--p-primary-color);}
    .tk-trigger-editor :focus-visible {outline:2px solid var(--p-primary-color); outline-offset:2px;}
  `;
  document.head.appendChild(style);
}
