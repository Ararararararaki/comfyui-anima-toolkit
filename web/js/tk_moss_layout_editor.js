// TK node binding. Editor source and GPL notices: third_party/moss_layout_studio/NOTICE.md.
import { app } from "/scripts/app.js";
import { createStudioEditor } from "./tk_moss_layout_studio.js";

function attach(node) {
  if (node.comfyClass !== "TkMossLayoutEditor" || node._mossEditor) return;
  const stateWidget = node.widgets?.find(widget => widget.name === "layout_state");
  if (!stateWidget || !node.addDOMWidget) return;
  stateWidget.type = "converted-widget";
  stateWidget.hidden = true;
  stateWidget.computeSize = () => [0, -4];
  const editor = createStudioEditor(stateWidget.value, (value) => {
    stateWidget.value = value;
    const index = node.widgets.indexOf(stateWidget);
    if (Array.isArray(node.widgets_values) && index >= 0) node.widgets_values[index] = value;
    node.setDirtyCanvas?.(true, true);
    app.graph?.change?.();
  }, node);
  stateWidget.serializeValue = () => editor.serialize();
  node._mossEditor = editor;
  const panel = node.addDOMWidget("moss_layout_canvas", "div", editor.element, {
    serialize: false, hideOnZoom: false,
    getMinHeight: () => 400, getMaxHeight: () => Number.POSITIVE_INFINITY,
  });
  // Modern ComfyUI distributes remaining node height through this flexible range.
  panel.computeLayoutSize = () => ({ minWidth: 700, minHeight: 400, maxHeight: Number.POSITIVE_INFINITY });
  node.size = [Math.max(node.size?.[0] || 0, 1040), Math.max(node.size?.[1] || 0, 780)];
  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigure?.apply(this, args);
    this.size = [Math.max(this.size[0], 720), Math.max(this.size[1], 480)];
    editor.load(stateWidget.value);
    return result;
  };
  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) { editor.destroy(); return originalRemoved?.apply(this, args); };
}

app.registerExtension({
  name: "TK.MossLayoutEditor",
  nodeCreated: attach,
  loadedGraphNode(node) { attach(node); node._mossEditor?.load(node.widgets.find(widget => widget.name === "layout_state").value); },
});
