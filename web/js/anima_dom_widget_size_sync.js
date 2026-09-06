const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(finiteNumber(value, min))));

const getNodeHeight = (node) => finiteNumber(node?.size?.[1], 0);

const getNodeWidth = (node, fallback = 360) => Math.max(280, finiteNumber(node?.size?.[0], fallback));

/**
 * Make a LiteGraph DOM widget follow the node's outer size.
 * The node is the only runtime size owner. The DOM element only fills the
 * widget row; its measured height is never fed back into node.setSize().
 */
export function installDOMWidgetSizeSync({
  node,
  domWidget,
  element,
  minHeight = 180,
  maxHeight = 1600,
  initialContentHeight = 420,
  nodeChromeHeight = 0,
  onContentHeight = null,
} = {}) {
  if (!node || !element) return null;

  const min = Math.max(120, finiteNumber(minHeight, 180));
  const max = Math.max(min, finiteNumber(maxHeight, 1600));
  const chrome = Math.max(0, finiteNumber(nodeChromeHeight, 0));
  let disposed = false;
  let frame = 0;
  const originalOnResize = node.onResize;
  const originalComputeSize = domWidget?.computeSize;
  // ComfyUI 新前端的 DOMWidget 用 computeLayoutSize() 读取元素上的 CSS
  // 变量；旧版 LiteGraph 没有这个接口，只认 computeSize()。两套前端
  // 不能同时把同一个最小高度写成两个 owner，否则拖动时会互相回弹。
  const usesNativeLayoutSizing = typeof domWidget?.computeLayoutSize === "function";
  const originalMinHeightVar = element.style.getPropertyValue("--comfy-widget-min-height");
  const originalMaxHeightVar = element.style.getPropertyValue("--comfy-widget-max-height");

  const contentHeightFromNode = () => clamp(getNodeHeight(node) - chrome, min, max);

  const notifyContentHeight = (commit = false) => {
    onContentHeight?.(contentHeightFromNode(), { commit });
  };

  const ensureElementFillsWidgetRow = () => {
    if (disposed) return;
    element.style.boxSizing = "border-box";
    element.style.width = "100%";
    element.style.height = "100%";
    element.style.minWidth = "0px";
    element.style.minHeight = "0px";
    element.style.maxWidth = "100%";
    element.style.maxHeight = "none";
    element.style.flex = "1 1 0%";
    const widgetGrid = element.closest?.(".lg-node-widgets");
    if (widgetGrid) {
      widgetGrid.style.minHeight = "0px";
      widgetGrid.style.alignContent = "stretch";
    }
  };

  const syncNow = () => {
    ensureElementFillsWidgetRow();
    notifyContentHeight(false);
  };

  const scheduleSync = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      syncNow();
    });
  };

  const setContentHeight = (height, { commit = false } = {}) => {
    const contentHeight = clamp(height, min, max);
    node.setSize?.([getNodeWidth(node), contentHeight + chrome]);
    ensureElementFillsWidgetRow();
    onContentHeight?.(contentHeight, { commit });
    node.graph?.setDirtyCanvas?.(true, true);
    return contentHeight;
  };

  const host = () => element.closest?.(".lg-node-widgets") || domWidget?.element?.parentElement || element.parentElement;
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => scheduleSync()) : null;
  observer?.observe(host() || element);

  node.onResize = function (...args) {
    const result = originalOnResize?.apply(this, args);
    // 立即只调整 DOM 的填充约束；绝不把 DOM 高度写回节点，避免尺寸正反馈。
    syncNow();
    scheduleSync();
    return result;
  };

  if (domWidget) {
    if (usesNativeLayoutSizing) {
      // 新前端的布局器会读取这两个变量并把节点剩余空间分给 DOM 面板。
      // 不再覆盖 computeSize，避免旧的 LiteGraph 尺寸钉子干扰 2.0 布局。
      element.style.setProperty("--comfy-widget-min-height", `${min}px`);
      element.style.setProperty("--comfy-widget-max-height", `${max}px`);
    } else {
      // 旧版 LiteGraph 这里只声明内容区可接受的最小高度，不能返回当前
      // 高度；否则 LiteGraph 会把上一次的大高度当成最小尺寸并拖动回弹。
      domWidget.computeSize = (width) => [
        Math.max(280, finiteNumber(width, getNodeWidth(node))),
        min,
      ];
    }
  }

  const initialHeight = clamp(initialContentHeight, min, max);
  if (getNodeHeight(node) < initialHeight + chrome) {
    node.setSize?.([getNodeWidth(node), initialHeight + chrome]);
  }
  ensureElementFillsWidgetRow();
  scheduleSync();

  return {
    getContentHeight: contentHeightFromNode,
    getChromeHeight: () => chrome,
    setContentHeight,
    sync: scheduleSync,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      if (node.onResize === originalOnResize || !originalOnResize) node.onResize = originalOnResize;
      if (usesNativeLayoutSizing) {
        if (originalMinHeightVar) element.style.setProperty("--comfy-widget-min-height", originalMinHeightVar);
        else element.style.removeProperty("--comfy-widget-min-height");
        if (originalMaxHeightVar) element.style.setProperty("--comfy-widget-max-height", originalMaxHeightVar);
        else element.style.removeProperty("--comfy-widget-max-height");
      } else if (domWidget && domWidget.computeSize !== originalComputeSize) {
        domWidget.computeSize = originalComputeSize;
      }
    },
  };
}
