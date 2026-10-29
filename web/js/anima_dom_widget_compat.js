// Toolkit DOM panels share one recovery observer. ComfyUI's modern WidgetDOM
// mounts only once: during a subgraph transition its lookup can still see the
// previous graph, leaving the new (otherwise valid) widget row empty.
const entries = new Map();
const elementOwners = new WeakMap();
let observer;
let frame = 0;
let app;
const SIZE_PROPERTY = "tkWidgetTextareaSizes";

function textareaEntries(widget) {
  return [...widget.element.querySelectorAll("textarea")].map((area, index) => [
    area.dataset.tkResizeKey || area.name || `textarea-${index}`, area,
  ]);
}

export function restoreTextareaSizes(node, widgets) {
  for (const widget of widgets) {
    const saved = node.properties?.[SIZE_PROPERTY]?.[widget.name];
    if (!saved) continue;
    for (const [key, area] of textareaEntries(widget)) {
      const height = Number(saved[key]);
      if (!Number.isFinite(height) || height <= 0) continue;
      area.style.height = `${height}px`;
      area.style.flexShrink = "0";
    }
  }
}

export function captureTextareaSizes(node, widgets) {
  let changed = false;
  for (const widget of widgets) {
    for (const [key, area] of textareaEntries(widget)) {
      // Native textarea resizing writes an unscaled CSS height. Bounding rects
      // include canvas zoom and must never be serialized as an editor size.
      const height = Number.parseFloat(area.style.height);
      if (!(height > 0) || !Number.isFinite(height)) continue;
      node.properties ||= {};
      const sizes = node.properties[SIZE_PROPERTY] ||= {};
      const saved = sizes[widget.name] ||= {};
      if (saved[key] === height) continue;
      saved[key] = height;
      area.style.flexShrink = "0";
      changed = true;
    }
  }
  return changed;
}

export function recoverModernWidgetMounts(node, widgets, host) {
  if (!host) return 0;
  const rows = [...host.querySelectorAll(":scope > [data-testid='node-widget']")];
  const visible = node.widgets.filter(widget => node.isWidgetVisible(widget));
  let recovered = 0;
  for (const widget of widgets) {
    // A gallery intentionally moved to its floating window must stay there.
    if (widget.element.isConnected) continue;
    const row = rows[visible.indexOf(widget)];
    const target = row?.querySelector(":scope > .col-span-2");
    if (!target) continue;
    // The modern renderer may also reuse a row containing the previous graph's
    // Toolkit panel. Replace only content positively owned by an old Toolkit
    // node instance, never arbitrary native controls or another active panel.
    if (target.childNodes.length && ![...target.childNodes].every(child =>
      elementOwners.has(child) && elementOwners.get(child) !== node)) continue;
    target.replaceChildren(widget.element);
    recovered++;
  }
  return recovered;
}

function scheduleRecovery() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const graph = app?.canvas?.graph;
    if (!graph) return;
    const hosts = new Map([...document.querySelectorAll(".lg-node-widgets[data-widgets-grid-node-id]")]
      .map(host => [host.dataset.widgetsGridNodeId, host]));
    for (const [node, entry] of entries) {
      // Node IDs can repeat across workflow/subgraph instances.
      if (node.graph !== graph || graph.getNodeById(node.id) !== node) continue;
      recoverModernWidgetMounts(node, entry.widgets, hosts.get(String(node.id)));
    }
  });
}

export function installWidgetCompatibility(node) {
  if (entries.has(node)) return;
  const widgets = (node.widgets || []).filter(widget => /^(tk_|anima_)/.test(widget.name)
    && widget.element?.querySelectorAll);
  if (!widgets.length) return;
  const removers = [];
  const save = () => captureTextareaSizes(node, widgets);
  const restore = () => restoreTextareaSizes(node, widgets);
  const commit = () => { if (save()) node.graph?.change?.(); };
  for (const widget of widgets) {
    elementOwners.set(widget.element, node);
    widget.element.addEventListener("pointerup", commit);
    // Textarea resize handles can swallow pointer events in Chromium. Observe
    // their inline height mutation too, coalescing changes until the next frame.
    const sizes = new MutationObserver(records => {
      if (!records.some(record => record.target.tagName === "TEXTAREA")) return;
      commit();
    });
    sizes.observe(widget.element, { subtree: true, attributes: true, attributeFilter: ["style"] });
    removers.push(() => { sizes.disconnect(); widget.element.removeEventListener("pointerup", commit); });
  }
  const originalSerialize = node.onSerialize;
  const originalConfigure = node.onConfigure;
  const originalRemoved = node.onRemoved;
  node.onSerialize = function (data) {
    save();
    const result = originalSerialize?.apply(this, arguments);
    if (this.properties?.[SIZE_PROPERTY]) {
      data.properties ||= {};
      // Modern ComfyUI properties are reactive proxies, not structured-cloneable.
      data.properties[SIZE_PROPERTY] = JSON.parse(JSON.stringify(this.properties[SIZE_PROPERTY]));
    }
    return result;
  };
  node.onConfigure = function () {
    const result = originalConfigure?.apply(this, arguments);
    // onConfigure has already restored node.properties at this point.
    restore();
    scheduleRecovery();
    return result;
  };
  node.onRemoved = function () {
    for (const remove of removers) remove();
    entries.delete(this);
    if (!entries.size) {
      observer?.disconnect();
      observer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
    return originalRemoved?.apply(this, arguments);
  };
  entries.set(node, { widgets });
  restore();
  if (!observer) {
    observer = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(item =>
        item.nodeType === 1 && (item.matches?.(".lg-node, .lg-node-widgets, .lg-node-widget")
          || item.querySelector?.(".lg-node, .lg-node-widgets, .lg-node-widget"))))) scheduleRecovery();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  scheduleRecovery();
}

export function registerWidgetCompatibility(hostApp) {
  app = hostApp;
  hostApp.registerExtension({
    name: "TK.DOMWidget.Compatibility",
    nodeCreated(node) {
      // Core invokes nodeCreated inside the constructor, before LiteGraph's
      // onNodeCreated wrappers have installed the custom DOM panels.
      queueMicrotask(() => { if (node.graph) installWidgetCompatibility(node); });
    },
    afterConfigureGraph() { scheduleRecovery(); },
  });
}

function init() {
  const hostApp = window.comfyAPI?.app?.app;
  if (!hostApp?.registerExtension) { setTimeout(init, 500); return; }
  registerWidgetCompatibility(hostApp);
}
if (typeof window !== "undefined") init();
