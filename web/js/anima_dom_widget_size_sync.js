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

  let min = Math.max(120, finiteNumber(minHeight, 180));
  let max = Math.max(min, finiteNumber(maxHeight, 1600));
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
    // ⚠️ 2026-09-17：**只在值真的不同时才写**（幂等写入）。
    // 此前无条件写 8 个 style 属性 —— 每次写入都会让该子树的样式/布局失效，而本函数由
    // ResizeObserver 与 node.onResize 触发，于是「hover 引起的任何重排 → 写样式 → 再次重排 →
    // ResizeObserver 再触发」会互相放大（实测表现为节点区域反复重绘/闪现，远程串流下尤其明显）。
    const set = (prop, value) => { if (element.style[prop] !== value) element.style[prop] = value; };
    set("boxSizing", "border-box");
    set("width", "100%");
    set("height", "100%");
    set("minWidth", "0px");
    set("minHeight", "0px");
    set("maxWidth", "100%");
    set("maxHeight", "none");
    set("flex", "1 1 0%");
    const widgetGrid = element.closest?.(".lg-node-widgets");
    // 同理：同一元素上已经是目标值时不要再写（否则等于每次 sync 都让整个节点重新布局）
    if (widgetGrid) {
      if (widgetGrid.style.minHeight !== "0px") widgetGrid.style.minHeight = "0px";
      if (widgetGrid.style.alignContent !== "stretch") widgetGrid.style.alignContent = "stretch";
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
    // ⚠️ 2026-09-17：这里**只排程、不再同步 syncNow()**。
    // 在 resize 回调里同步读写 style = 强制同步布局（layout thrashing）：拖动/悬浮引发的
    // 连续 resize 会退化成每帧多次「写样式 → 立刻重排」。排到 rAF 里做，一帧只同步一次。
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

  /**
   * 把 DOM 面板的高度区间钉成 [h, h]：新前端布局器就没有「按内容重新分配节点高度」的余地了。
   * 用于尺寸**完全由用户决定**的面板（画廊）—— 图片变多不该把节点顶大。
   * 用户原话（2026-09-16）：「节点大小完全限制于我的设定，不要因为图像而改变，也不要自主变大变小」。
   */
  const setBounds = (nextMin, nextMax = nextMin) => {
    min = Math.max(120, finiteNumber(nextMin, min));
    max = Math.max(min, finiteNumber(nextMax, min));
    if (domWidget && usesNativeLayoutSizing) {
      // ⚠️ 只加**幂等值比较**，**不动时机**（调用方要求立即跟上，否则高度会回弹）：
      // 自定义属性只能走 setProperty/getPropertyValue（`style["--x"]` 不生效）。
      // 理由与上面 ensureElementFillsWidgetRow 同一套：本函数由 onResize 高频触发
      // （拖动节点时每帧），值没变时的写入会让该子树样式无谓失效。
      const minPx = `${min}px`;
      const maxPx = `${max}px`;
      if (element.style.getPropertyValue("--comfy-widget-min-height") !== minPx) {
        element.style.setProperty("--comfy-widget-min-height", minPx);
      }
      if (element.style.getPropertyValue("--comfy-widget-max-height") !== maxPx) {
        element.style.setProperty("--comfy-widget-max-height", maxPx);
      }
    }
    ensureElementFillsWidgetRow();
    return { min, max };
  };

  return {
    getContentHeight: contentHeightFromNode,
    getChromeHeight: () => chrome,
    setContentHeight,
    setBounds,
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
