// TK host integration. Bundled editor: GPL-3.0, third_party/moss_layout_studio/NOTICE.md.
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

let floating = null;
const clone = value => JSON.parse(JSON.stringify(value));
export function studioPayload(raw) {
  const state = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!state || state.version !== 1) throw new Error("不支持的布局状态版本，原始数据仍保留。");
  if (state.draft) return { draft: clone(state.draft), ...(state.studio ? { studio: clone(state.studio) } : {}) };
  return { draft: { width: state.width, height: state.height, summary: { caption: state.summary || "" },
    items: clone(state.items || []).map(item => { delete item.id; return item; }), bbox_coord_space: "abs", bbox_format: "xyxy" } };
}
export function draftFingerprint(draft) { return JSON.stringify(draft); }
function el(tag, text = "", cls = "") { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; }
function button(parent, label, action) { const b = el("button", label); b.type = "button"; b.onclick = action; parent.append(b); return b; }
function installStyle() {
  if (document.getElementById("tk-layout-host-style")) return;
  const s = el("style"); s.id = "tk-layout-host-style";
  s.textContent = `
  .tk-layout-host{display:flex;flex-direction:column;gap:8px;width:100%;height:100%;min-width:0;min-height:0;padding:8px;box-sizing:border-box;color:var(--fg-color,#eee);background:var(--comfy-menu-bg,#242428);font:13px/1.4 system-ui;overflow:hidden;container-type:inline-size}
  .tk-layout-host *{box-sizing:border-box}.tk-layout-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex:none}
  .tk-layout-host :is(button,input,select,textarea),.tk-layout-window button{font:inherit;color:var(--input-text,var(--fg-color,#eee));background:var(--comfy-input-bg,#303036);border:1px solid var(--border-color,#666);border-radius:5px;padding:6px 9px;min-height:32px}
  .tk-layout-host button,.tk-layout-window button{cursor:pointer}.tk-layout-host button:hover:not(:disabled){border-color:var(--p-primary-color,#60a5fa)}.tk-layout-host button:disabled{opacity:.45;cursor:default}
  .tk-layout-host :focus-visible{outline:2px solid var(--p-primary-color,#60a5fa);outline-offset:2px}.tk-layout-host select{max-width:240px}.tk-layout-instruction{flex:1;min-width:180px}
  .tk-layout-mount{flex:1;min-height:280px;overflow:hidden;position:relative}.tk-layout-status{font-size:12px;color:var(--descrip-text,#aaa);white-space:pre-wrap}.tk-layout-status[data-error=true]{color:#ef7b7b}
  .tk-layout-output{flex:none}.tk-layout-output textarea{display:block;width:100%;min-height:84px;max-height:180px;resize:vertical;margin-top:6px}.tk-layout-output summary{cursor:pointer}
  .tk-layout-window{position:fixed;z-index:8500;display:flex;flex-direction:column;resize:both;overflow:hidden;min-width:min(480px,96vw);min-height:180px;max-width:100vw;max-height:100dvh;border:1px solid var(--border-color,#666);border-radius:8px;background:var(--comfy-menu-bg,#242428);color:var(--fg-color,#eee);box-shadow:0 14px 50px #0006}
  .tk-layout-window header{display:flex;gap:6px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--border-color,#666);cursor:move;touch-action:none;font:13px system-ui}.tk-layout-window header strong{flex:1}.tk-layout-window .tk-layout-host{flex:1}.tk-layout-window[data-minimized=true]{resize:none;min-height:0!important;height:auto!important}.tk-layout-window[data-minimized=true]>.tk-layout-host{display:none}
  .tk-layout-window{box-sizing:border-box;z-index:10000}
  .tk-layout-placeholder{padding:16px;font:13px system-ui;color:var(--fg-color,#eee)}
  .tk-layout-host [hidden]{display:none!important}
  @container(max-width:650px){.tk-layout-tools{gap:4px}.tk-layout-host :is(button,select){padding:5px 6px}.tk-layout-mount{min-height:300px}}
  `;
  document.head.append(s);
}

export function createStudioEditor(raw, onChange, node = null) {
  installStyle();
  const root = el("div", "", "tk-layout-host"), tools = el("div", "", "tk-layout-tools"), mount = el("div", "", "tk-layout-mount");
  root.dataset.captureWheel = "true";
  const status = el("div", "正在载入完整布局编辑器…", "tk-layout-status"); status.setAttribute("role", "status");
  const instruction = el("input", "", "tk-layout-instruction"); instruction.placeholder = "扩写要求（可选）；区域内只需写简单描述"; instruction.setAttribute("aria-label", "布局扩写要求");
  const agentChoice = el("select"); agentChoice.setAttribute("aria-label", "关联的 Agent");
  const selected = button(tools, "扩写选区", () => expand(true)); selected.dataset.action = "expand-selection";
  const all = button(tools, "扩写全部", () => expand(false)); all.dataset.action = "expand-all";
  const direct = button(tools, "直接输出", () => publish()); direct.dataset.action = "direct";
  const cancel = button(tools, "取消", () => { activeAbort?.abort(); if(activeAgent?.activeTask) activeAgent.cancelTask(activeAgent.activeTask); }); cancel.hidden = true;
  tools.append(instruction, agentChoice);
  const floatButton = button(tools, "展开画布", () => openWindow());
  const io = el("details"); io.append(el("summary", "布局文件"));
  button(io, "导出布局", () => download());
  button(io, "导入布局", () => file.click());
  const file = el("input"); file.type = "file"; file.accept = ".json,application/json"; file.hidden = true;
  file.onchange = async () => { const f = file.files?.[0]; if (!f) return; try { const v = JSON.parse(await f.text()); editor.load(v.version === 1 ? studioPayload(v) : v.draft ? v : { draft: v }); message("布局已导入，可继续编辑。"); } catch (e) { message(e.message, true); } finally { file.value = ""; } };
  io.append(file); tools.append(io);
  const output = el("details", "", "tk-layout-output"); output.open = true;
  output.append(el("summary", "最终提示词 · 随画布自动更新"));
  const prompt = el("textarea"); prompt.readOnly = true; prompt.setAttribute("aria-label", "布局最终提示词"); output.append(prompt);
  button(output, "复制提示词", async () => { try { await navigator.clipboard.writeText(prompt.value); message("提示词已复制。"); } catch { prompt.focus(); prompt.select(); message("已选中提示词，按 Ctrl+C 复制。"); } });
  root.append(tools, mount, status, output);
  let editor = null, disposed = false, queuedRaw = raw, busy = false, activeAgent = null, changedFrame = 0, windowEl = null, hostParent = null;
  const controller = new AbortController();
  let previewURL = null, executing = [], watched = new Set();
  let uploadedReference = null, activeAbort = null;
  async function referenceDescriptor(source, signal) {
    if (!source) return null;
    if (uploadedReference?.source === source) return uploadedReference.descriptor;
    if (!source.startsWith('data:image/') && !source.startsWith('blob:') && new URL(source, location.href).origin !== location.origin)
      throw new Error("请使用本机载入的参考图。");
    const response = await fetch(source, {signal});
    if (!response.ok) throw new Error("参考图读取失败，请重新载入。");
    const blob = await response.blob();
    const form = new FormData(); form.append('image', blob, blob.type === 'image/jpeg' ? 'tk-layout-reference.jpg' : 'tk-layout-reference.png'); form.append('type', 'temp');
    const upload = await api.fetchApi('/upload/image', {method:'POST',body:form,signal});
    if (!upload.ok) throw new Error("参考图上传失败，请重试。");
    const image = await upload.json();
    const descriptor = {filename:image.name,subfolder:image.subfolder || '',type:image.type || 'temp'};
    uploadedReference = {source,descriptor}; return descriptor;
  }
  const unlinkPreview = () => { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = null; editor?.reference(null, true); };
  function watchPreviewSources() {
    watched = new Set(); const graph = node?.graph;
    const targets = (graph?._nodes || []).filter(n => n.comfyClass === "TkMossLayoutPreview" && n.inputs?.some(input => {
      const l = graph.links?.get?.(input.link) || graph.links?.[input.link]; return input.name === "layout" && String(l?.origin_id) === String(node.id);
    }));
    const stack = [...targets];
    while (stack.length) { const n = stack.pop(); if (!n || watched.has(String(n.id))) continue; watched.add(String(n.id)); for (const input of n.inputs || []) { const l = graph.links?.get?.(input.link) || graph.links?.[input.link]; if (l) stack.push(graph.getNodeById(l.origin_id)); } }
  }
  api.addEventListener("execution_start", watchPreviewSources, { signal: controller.signal });
  api.addEventListener("executing", event => { const d = event.detail; executing = typeof d === "string" ? [d] : d ? [d.node,d.display_node].filter(Boolean).map(String) : []; }, { signal: controller.signal });
  api.addEventListener("b_preview", event => {
    if (!editor || !editor.payload().studio?.ui?.livePreview || !(event.detail instanceof Blob)) return;
    if (!watched.size) watchPreviewSources();
    if (!executing.some(id => watched.has(id))) return;
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(event.detail); editor.reference(previewURL, true);
  }, { signal: controller.signal });
  api.addEventListener("tk-moss-layout-preview", event => {
    const data = event.detail;
    if (!editor || String(data?.editor_node) !== String(node?.id) || !editor.payload().studio?.ui?.sync) return;
    const current = clone(editor.payload().draft), incoming = clone(data.draft);
    // Normalization may drop empty auxiliary fields, but never ignore geometry or copy.
    const geometry = d => JSON.stringify([d.width,d.height,d.items.map(i => [i.label,i.bbox,i.text || ""])]);
    if (geometry(current) !== geometry(incoming)) return;
    const image = data.images?.[0]; if (!image?.filename) return;
    unlinkPreview(); editor.reference(`/view?${new URLSearchParams({ filename:image.filename,subfolder:image.subfolder || "",type:image.type || "temp" })}`);
  }, { signal: controller.signal });
  function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  function serialized() { return editor ? JSON.stringify({ version: 1, ...editor.payload() }) : queuedRaw; }
  function changed() {
    if (disposed) return;
    if (!changedFrame) changedFrame = requestAnimationFrame(() => { changedFrame = 0; onChange(serialized()); updatePrompt(); });
  }
  function updatePrompt() { if (!editor) return; try { const v = editor.compiled(); prompt.value = v.prompt; } catch (e) { message(e.message, true); } }
  function connectedAgent() {
    const graph = node?.graph;
    for (const id of node?.outputs?.[0]?.links || []) {
      const link = graph?.links?.get?.(id) || graph?.links?.[id];
      const candidate = graph?.getNodeById?.(link?.target_id);
      if (candidate?.comfyClass === "TkPromptAgent") return candidate;
    }
    return null;
  }
  function refreshAgents() {
    const old = agentChoice.value, wired = connectedAgent();
    agentChoice.replaceChildren();
    const candidates = (node?.graph?._nodes || []).filter(n => n.comfyClass === "TkPromptAgent");
    const opt = el("option", candidates.length ? "选择 Agent" : "自动创建并连接 Agent"); opt.value = ""; agentChoice.append(opt);
    for (const n of candidates) { const o = el("option", `${n.title || "TK Prompt Agent"} #${n.id}`); o.value = String(n.id); agentChoice.append(o); }
    agentChoice.value = candidates.some(n => String(n.id) === old) ? old : wired ? String(wired.id) : candidates.length === 1 ? String(candidates[0].id) : "";
  }
  agentChoice.onfocus = refreshAgents;
  function agent(create = false) {
    const graph = node?.graph;
    if (!graph) throw new Error("请先将布局节点加入工作流。");
    refreshAgents();
    let target = graph.getNodeById?.(agentChoice.value);
    if (!target && create) {
      if ((graph._nodes || []).filter(n => n.comfyClass === "TkPromptAgent").length > 1) throw new Error("请选择接收结果的 Agent。");
      target = globalThis.LiteGraph?.createNode?.("TkPromptAgent");
      if (!target) throw new Error("Agent 尚未注册，请刷新页面后重试。");
      target.pos = [(node.pos?.[0] || 0) + (node.size?.[0] || 800) + 80, node.pos?.[1] || 0]; graph.add(target);
    }
    if (!target?._tkPromptAgentUI) throw new Error("请选择一个就绪的 Agent。");
    const slot = target.inputs?.findIndex(input => input.name === "layout");
    if (slot >= 0) {
      const linkId = target.inputs[slot].link;
      const existing = graph.links?.get?.(linkId) || graph.links?.[linkId];
      if (linkId != null && String(existing?.origin_id) !== String(node.id)) throw new Error("这个 Agent 已连接其他布局，请选择另一个 Agent。");
      if (linkId == null) node.connect(0, target, slot);
    }
    return target._tkPromptAgentUI;
  }
  async function expand(selectionOnly) {
    if (!editor || busy) return;
    const snapshot = editor.payload(), indices = selectionOnly ? editor.selection() : null;
    if (selectionOnly && !indices.length) { message("点击或框选需要扩写的区域，再点“扩写选区”。"); return; }
    const fingerprint = draftFingerprint(snapshot.draft), graph = node?.graph, reference = snapshot.studio?.ui?.referenceImage || null;
    try {
      const ui = agent(true); activeAgent = ui;
      activeAbort = new AbortController();
      busy = true; selected.disabled = all.disabled = direct.disabled = true; cancel.hidden = false;
      message(selectionOnly ? `正在扩写 ${indices.length} 个区域，其他区域保持原样…` : "正在扩写全部区域，保留框的位置与可见文字…");
      const current = () => !disposed && node?.graph === graph && graph?.getNodeById?.(node.id) === node && fingerprint === draftFingerprint(editor.payload().draft) && reference === (editor.payload().studio?.ui?.referenceImage || null);
      const image = await referenceDescriptor(reference, activeAbort.signal);
      if (activeAbort.signal.aborted) { message("本轮已取消，原布局已保留。"); return; }
      if (!current()) { message("画布或参考图已改变，请重新扩写当前内容。"); return; }
      const result = await ui.expandVisualLayout(snapshot.draft, indices, instruction.value, current, image,
        committing => { mount.inert = committing; });
      if (!result) { message(activeAbort.signal.aborted ? "本轮已取消，原布局已保留。" : "本轮没有更新画布，请查看 Agent 的任务状态。", !activeAbort.signal.aborted); return; }
      if (!current()) { message("等待期间画布已修改，当前编辑已保留；本轮结果未覆盖画布。", true); return; }
      editor.captions(result.draft); changed(); message("扩写已回到原区域，最终提示词已更新；可继续修改或撤销。");
    } catch (e) { message(e.name === "AbortError" ? "本轮已取消，原布局已保留。" : e.message, e.name !== "AbortError"); }
    finally { busy = false; activeAgent = null; activeAbort = null; mount.inert = false; selected.disabled = all.disabled = direct.disabled = false; cancel.hidden = true; }
  }
  async function publish() {
    if (!editor || busy) return;
    updatePrompt(); onChange(serialized());
    if (!connectedAgent() && !agentChoice.value) { message("直接提示词已就绪，连接本节点 prompt 输出即可生图；没有调用模型。"); return; }
    try { const ui = agent(); const result = await ui.publishVisualLayout(editor.payload().draft); message(result ? "最终提示词已送入 Agent；没有调用模型。" : "本轮未更新 Agent，请查看 Agent 的任务状态。", !result); } catch (e) { message(e.message, true); }
  }
  function download() {
    if (!editor) return;
    const url = URL.createObjectURL(new Blob([serialized()], { type: "application/json" }));
    const a = el("a"); a.href = url; a.download = "moss-layout.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function closeWindow() {
    if (!windowEl) return;
    saveWindow();
    hostParent?.replaceChildren(root); windowEl.remove(); windowEl = null; floatButton.textContent = "展开画布";
    if (floating === closeWindow) floating = null;
  }
  function openWindow() {
    if (windowEl) { closeWindow(); return; }
    floating?.(); floating = closeWindow; hostParent = root.parentNode;
    if (!hostParent) return;
    windowEl = el("section", "", "tk-layout-window"); windowEl.setAttribute("aria-label", "MOSS 布局编辑窗口");
    let rect; try { rect = JSON.parse(localStorage.getItem("tkMossLayoutWindowRect") || "null"); } catch { /* default */ }
    Object.assign(windowEl.style, { left: `${Math.max(0, Math.min(rect?.x || 30, innerWidth - 480))}px`, top: `${Math.max(0, Math.min(rect?.y || 40, innerHeight - 180))}px`, width: `${Math.min(rect?.w || 1200, innerWidth - 20)}px`, height: `${Math.min(rect?.h || 850, innerHeight - 30)}px` });
    const head = el("header"); head.append(el("strong", `${node?.title || "MOSS 布局"} #${node?.id ?? ""}`));
    let restoreRect = null;
    const minimize = button(head, "最小化", () => { windowEl.dataset.minimized = windowEl.dataset.minimized !== "true" ? "true" : "false"; minimize.textContent = windowEl.dataset.minimized === "true" ? "恢复" : "最小化"; });
    const maximize = button(head, "最大化", () => {
      if (restoreRect) { Object.assign(windowEl.style, restoreRect); restoreRect = null; maximize.textContent = "最大化"; }
      else { restoreRect = {left:windowEl.style.left,top:windowEl.style.top,width:windowEl.style.width,height:windowEl.style.height}; Object.assign(windowEl.style, { left:"0px",top:"0px",width:`${innerWidth}px`,height:`${innerHeight}px` }); maximize.textContent = "还原"; }
      windowEl.dataset.minimized = "false"; minimize.textContent = "最小化";
    });
    button(head, "返回节点", closeWindow); windowEl.append(head, root); document.body.append(windowEl);
    const placeholder = el("div", "画布已展开，编辑和输出仍属于本节点。", "tk-layout-placeholder"); button(placeholder, "返回节点", closeWindow); hostParent.replaceChildren(placeholder);
    floatButton.textContent = "返回节点";
    let drag = null;
    head.onpointerdown = e => { if (e.target.closest("button")) return; const r = windowEl.getBoundingClientRect(); drag = { x:e.clientX-r.x,y:e.clientY-r.y }; head.setPointerCapture(e.pointerId); };
    head.onpointermove = e => { if (!drag) return; windowEl.style.left = `${Math.max(0,Math.min(innerWidth-windowEl.offsetWidth,e.clientX-drag.x))}px`; windowEl.style.top = `${Math.max(0,Math.min(innerHeight-40,e.clientY-drag.y))}px`; };
    head.onpointerup = () => { drag = null; saveWindow(); };
    windowEl.addEventListener("pointerup", saveWindow);
  }
  function saveWindow() { if (!windowEl || windowEl.dataset.minimized === "true") return; const r=windowEl.getBoundingClientRect(); try { localStorage.setItem("tkMossLayoutWindowRect", JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})); } catch { /* local storage unavailable */ } }
  window.addEventListener("resize", () => {
    if (!windowEl) return;
    const r=windowEl.getBoundingClientRect();
    Object.assign(windowEl.style,{left:`${Math.max(0,Math.min(r.x,innerWidth-Math.min(r.width,innerWidth)))}px`,top:`${Math.max(0,Math.min(r.y,innerHeight-40))}px`,width:`${Math.min(r.width,innerWidth)}px`,height:`${Math.min(r.height,innerHeight)}px`});
  }, {signal:controller.signal});
  root.addEventListener("keydown", e => { e.stopPropagation(); if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); expand(editor?.selection().length > 0); } });
  for (const name of ["pointerdown","mousedown","dblclick","wheel","keyup"]) root.addEventListener(name, e => e.stopPropagation());
  const ready = import("./vendor/moss_layout_studio/studio.js").then(async ({ mountStudio }) => {
    if (disposed) return;
    const payload = studioPayload(queuedRaw);
    editor = mountStudio(mount, payload, changed, async source => {
      const descriptor = await referenceDescriptor(source, controller.signal);
      const url = `/view?${new URLSearchParams(descriptor)}`;
      uploadedReference = {source:url,descriptor};
      return url;
    }); await editor.ready;
    if (disposed) { editor.destroy(); return; }
    refreshAgents(); updatePrompt(); message("画框后直接输入描述 · B 画框 / V 选择 · Ctrl+Enter 扩写 · Ctrl+Z 撤销");
  }).catch(e => { message(`布局载入失败：${e.message} 原始数据仍保留。`, true); });
  return { element:root, ready, serialize:serialized,
    load(value) { queuedRaw=value; if (editor) { try { editor.load(studioPayload(value)); updatePrompt(); } catch(e) { message(e.message,true); } } },
    destroy() { disposed=true; controller.abort(); activeAbort?.abort(); unlinkPreview(); if (activeAgent?.activeTask) activeAgent.cancelTask(activeAgent.activeTask); cancelAnimationFrame(changedFrame); closeWindow(); editor?.destroy(); },
  };
}
