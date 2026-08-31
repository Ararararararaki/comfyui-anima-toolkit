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
    // 这里只声明内容区可接受的最小高度，不能返回当前高度；否则
    // LiteGraph 会把上一次的大高度当成最小尺寸，拖小节点时又弹回去。
    domWidget.computeSize = (width) => [
      Math.max(280, finiteNumber(width, getNodeWidth(node))),
      min,
    ];
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
      if (domWidget && domWidget.computeSize !== originalComputeSize) domWidget.computeSize = originalComputeSize;
    },
  };
}
