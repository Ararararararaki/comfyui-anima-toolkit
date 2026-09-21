// TK 画布性能（节点级渲染裁剪）
//
// 目的：ComfyUI 1.48 新前端把节点渲染成 DOM（.lg-node）并放在一个被 transform
// 平移的图层容器（[data-testid="transform-pane"]）里。画布平移时，整棵节点 DOM
// 子树逐帧参与布局 / 样式 / 合成，且**视口外的节点内容同样被绘制**（实测 66 节点
// 的工作流里同时只有 ~9 个在视口内）。Chrome Tracing 实测每帧 Layerize≈5ms、
// 整文档 Paint≈1ms，是拖动掉帧的主因。
//
// 做法（不改变任何节点尺寸、不裁掉可见内容——已用截图逐像素比对验证，差异 0.1%）：
//   1) 给每个节点写一条精确的 content-visibility:auto + contain-intrinsic-size:
//      auto <该节点真实宽> <该节点真实高>。视口外节点直接跳过渲染；因为 intrinsic
//      尺寸取自节点真实 size（不是猜测值），节点外框、前端 DOM 测量、工作流读写
//      全部保持不变。
//   2) ~~.lg-node 提升为合成层（will-change:transform）~~ —— **2026-09-17 已移除**：
//      它给每个节点建独立合成层，导致「鼠标悬浮到按钮上时节点浮到最上层、盖住设置面板并反复
//      出现/消失」（远程串流下表现为闪）。且实测该条单独收益为 0，收益全部来自 content-visibility。
//
// 注意（踩坑记录）：绝不要把 contain:paint 加在 [data-testid="transform-pane"] 上
// —— 该元素自身带 translate 变换，paint containment 会把裁剪框一起平移，实测会
// 让 42% 的可见内容消失（"性能提升 57%" 是假收益）。
//
// 关闭方式：localStorage.setItem("tk_canvas_perf", "0") 后刷新；
// 运行期开关：window.__tkCanvasPerf.setEnabled(false)。
//
// 兜底轮询门控（2026-09-21）：setInterval 那一拍只在「页面可见 且 距上次画布活动 >= IDLE_MS」
// 时执行（pollTick）。尺寸变化本来就由 onResize 钩子 + nodeCreated/loadedGraphNode 覆盖，
// 轮询只是兜底；门控让它不再在拖动帧里插入强制同步布局。force / 事件路径不受门控。
(function () {
  const STYLE_ID = "tk-canvas-perf-style";
  const FLAG_KEY = "tk_canvas_perf";
  const POLL_MS = 4000;      // 兜底扫描：节点增删/改尺寸（有签名比对，不变就不写样式）
  const DEBOUNCE_MS = 250;   // 事件触发的合并窗口
  const MAX_NODES = 2000;    // 超大图直接放弃裁剪（避免撑爆样式表）
  const IDLE_MS = 2000;      // 距上次画布活动不足此时长 ⇒ 跳过这一拍兜底轮询（见 pollTick）

  let styleEl = null;
  let signature = "";
  let debounceTimer = 0;
  let pollTimer = 0;
  // 最近一次「画布活动」（节点增删/改尺寸等事件）的时间戳，只被 scheduleRefresh() 记账，
  // 只被 pollTick() 读取 —— 用于让兜底轮询避开正在发生的画布操作。
  let lastActivityAt = 0;
  // enabled = 「裁剪样式当前是否真的生效」（不是「用户是否想要」）。初始 false，
  // 只有 enable() 成功注入样式后才为 true，这样 isEnabled() 不会误报。
  let enabled = false;

  const api = () => window.comfyAPI?.app?.app || window.app || null;

  function flagAllows() {
    try { return window.localStorage.getItem(FLAG_KEY) !== "0"; } catch (_) { return true; }
  }

  // 新前端（DOM 节点）才需要这套；旧版画布渲染没有 .lg-node DOM，切勿启用。
  function supported() {
    return typeof document !== "undefined"
      && !!document.querySelector('.lg-node[data-node-id], [data-testid="transform-pane"]');
  }

  // LiteGraph 的 node.size[1] 是「节点体」高度，DOM 的 .lg-node 还含标题栏
  // （前端自己做 removeNodeTitleHeight 换算）。intrinsic 尺寸必须用 DOM 盒尺寸，
  // 否则被跳过的节点会矮 30px，进而干扰前端基于 DOM 的尺寸测量。
  function titleHeight() {
    const v = Number(window.LiteGraph?.NODE_TITLE_HEIGHT);
    return Number.isFinite(v) && v > 0 ? v : 30;
  }

  function collectNodes() {
    const app = api();
    const root = app?.rootGraph || app?.graph;
    const out = [];
    const seenGraphs = new Set();
    const chrome = titleHeight();
    const visit = (graph) => {
      if (!graph || seenGraphs.has(graph)) return;
      seenGraphs.add(graph);
      const list = graph._nodes || graph.nodes || [];
      for (const node of list) {
        if (!node || node.id === undefined || node.id === null) continue;
        const size = node.size;
        if (!size || !Number.isFinite(size[0]) || !Number.isFinite(size[1])) continue;
        const w = Math.round(size[0]);
        const h = Math.round(size[1]) + chrome; // DOM 盒高 = 节点体高 + 标题栏
        if (w < 1 || h < 1) continue;
        out.push({ id: node.id, w, h });
      }
      // 子图（新前端的 subgraph 节点内部图）；接口缺失时静默跳过。
      const subs = graph.subgraphs;
      try {
        if (subs instanceof Map) for (const g of subs.values()) visit(g);
        else if (subs instanceof Set) for (const g of subs) visit(g);
        else if (Array.isArray(subs)) for (const g of subs) visit(g);
      } catch (_) {}
    };
    visit(root);
    return out;
  }

  // 尺寸一致性守卫：content-visibility 的 contain-intrinsic-size 会成为「离屏节点」的
  // 布局尺寸。若某节点 DOM 的真实尺寸与图内 size 不一致（内容撑开、第三方节点自测量），
  // 给它加裁剪会把前端基于 DOM 的尺寸测量钉在旧值上（实测某节点 310→480 的迟滞）。
  // 因此只对「DOM 实测尺寸 == 图内 size」的节点启用裁剪；不一致的节点跳过，
  // 等它被前端重新测量并回到一致后，下一轮刷新自动纳入。
  const SIZE_TOLERANCE = 2;
  function collectMeasuredSizes() {
    const map = new Map();
    let els;
    try { els = document.querySelectorAll(".lg-node[data-node-id]"); } catch (_) { return map; }
    for (const el of els) {
      // offsetWidth/Height = 布局尺寸（不受画布缩放 transform 影响）
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 1 && h > 1) map.set(String(el.dataset.nodeId), [w, h]);
    }
    return map;
  }

  function buildCss(nodes, totalCount = nodes.length) {
    // ⚠️ 2026-09-17：**不再给 .lg-node 加 will-change:transform**（原来是 totalCount<=300 时加）。
    // 它把**每个节点**提升为独立合成层（93 节点 = 93 层），实测在「鼠标悬浮到可交互按钮上」时
    // 会出现：所有节点浮到最上层、盖住设置面板（fixed z-index 1804）、并反复出现又消失 ——
    // 远程串流下被放大成明显的闪。而本文件最初的实测结论本就是
    // 「will-change 单独使用收益为 0，收益来自 content-visibility」⇒ 零收益 + 高风险，直接去掉。
    // 若将来真需要图层提升，应只在**拖动/缩放期间**临时加、松手即撤，不能常驻。
    if (nodes.length > MAX_NODES) return ""; // 节点过多：不做裁剪（避免撑爆样式表）
    if (!nodes.length) return "";
    const rules = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      rules[i] = `.lg-node[data-node-id="${n.id}"]{content-visibility:auto;contain-intrinsic-size:auto ${n.w}px ${n.h}px}`;
    }
    return rules.join("\n");
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return styleEl;
    styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(styleEl);
    }
    return styleEl;
  }

  function refresh(force = false) {
    if (!enabled) return false;
    const all = collectNodes();
    if (!all.length) return false;
    // 规模较大时跳过 DOM 实测（每次刷新一次布局 flush 不划算），直接信任图内 size
    // 门限 200（2026-09-21 由 500 下调）：DOM 实测只是「尺寸一致性守卫」，不是主力来源，
    // 节点一多就该退回图内 size，避免为兜底路径付出一次强制同步布局。
    const measured = all.length <= 200 ? collectMeasuredSizes() : null;
    const nodes = measured
      ? all.filter((n) => {
        const m = measured.get(String(n.id));
        return !m || (Math.abs(m[0] - n.w) <= SIZE_TOLERANCE && Math.abs(m[1] - n.h) <= SIZE_TOLERANCE);
      })
      : all;
    // 签名必须包含「实际生效的规则数」：否则某次刷新在节点尚未稳定时只拿到小部分
    // 规则，之后即使更多节点变得可裁剪也会被判为「无变化」而永远不再更新（自锁）。
    const sig = `${all.length}|${nodes.length}|${measured ? measured.size : "-"}|${nodes.map((n) => `${n.id}:${n.w}x${n.h}`).join(",")}`;
    if (!force && sig === signature) return false;
    signature = sig;
    ensureStyle().textContent = buildCss(nodes, all.length);
    return true;
  }

  // 兜底轮询的门控 —— **只作用于定时器路径**，这是本文件唯一会被门控挡住的入口：
  //   · force=true 路径（enable() 初次 refresh(true)、__tkCanvasPerf.refresh()）不经此处；
  //   · 事件路径（scheduleRefresh → 防抖 → refresh()）也不经此处。
  // 于是「尺寸同步」永远由事件驱动保证，门控只用来避免在拖动/缩放进行中插入一次
  // querySelectorAll + offsetWidth/Height 造成的强制同步布局（拖动掉帧的嫌疑源）。
  function pollTick() {
    if (document.hidden) return false;                        // 页面切后台：不扫
    if (Date.now() - lastActivityAt < IDLE_MS) return false;  // 刚有画布活动：交给事件路径，本拍跳过
    refresh();
    return true;
  }

  function scheduleRefresh() {
    // 记账必须放在提前返回之前：事件被防抖窗口合并时，「最后活动时刻」仍要往后推，
    // 否则拖动过程中的连续 onResize 只会记录第一拍，门控会在拖动中途放行。
    lastActivityAt = Date.now();
    if (!enabled || debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = 0; refresh(); }, DEBOUNCE_MS);
  }

  function enable() {
    enabled = true;
    refresh(true);
    if (!pollTimer) pollTimer = setInterval(pollTick, POLL_MS);
  }
  function disable() {
    enabled = false;
    signature = "";
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = 0; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
    document.getElementById(STYLE_ID)?.remove();
    styleEl = null;
  }

  // 节点改尺寸/新增时尽快同步（尺寸是 contain-intrinsic-size 的真源）。
  function hookNodeResize(nodeType) {
    const proto = nodeType?.prototype;
    if (!proto || proto.__tkCanvasPerfHooked) return;
    proto.__tkCanvasPerfHooked = true;
    const originalOnResize = proto.onResize;
    proto.onResize = function () {
      const r = typeof originalOnResize === "function" ? originalOnResize.apply(this, arguments) : undefined;
      scheduleRefresh();
      return r;
    };
  }

  function init() {
    const app = api();
    if (!app?.registerExtension) return setTimeout(init, 500);
    app.registerExtension({
      name: "TK.CanvasPerf",
      async setup() {
        if (!flagAllows()) return;
        // 等前端把节点 DOM 建起来再判断是否支持。
        const waitDom = (tries) => {
          if (supported()) { enable(); return; }
          if (tries > 40) return;
          setTimeout(() => waitDom(tries + 1), 250);
        };
        waitDom(0);
      },
      async beforeRegisterNodeDef(nodeType) {
        if (!flagAllows()) return;
        try { hookNodeResize(nodeType); } catch (_) {}
      },
      nodeCreated() { scheduleRefresh(); },
      loadedGraphNode() { scheduleRefresh(); },
    });
    // 运行期开关（供探针/排障使用）
    window.__tkCanvasPerf = {
      setEnabled(v) { if (v) { window.localStorage.removeItem(FLAG_KEY); enable(); } else { try { window.localStorage.setItem(FLAG_KEY, "0"); } catch (_) {} disable(); } return enabled; },
      isEnabled: () => enabled,
      refresh: (f = true) => refresh(f),
      stats: () => ({ enabled, nodes: collectNodes().length, cssLen: styleEl?.textContent?.length || 0 }),
    };
  }

  init();
})();
