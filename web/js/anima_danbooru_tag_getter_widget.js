// TK Danbooru Tag Getter：用 ComfyUI 原生风格整理分类开关、场景预设与主题剔除。
(function () {
  const NODE_NAME = "AnimaTKDanbooruTagGetter";
  // 前 12 项 = 旧行为基线；后 8 项为新增，顺序必须与后端 CATEGORY_NAMES 一致。
  const CATEGORY_NAMES = [
    "画师词",
    "背景词",
    "人物对象词",
    "角色特征词",
    "角色五官词",
    "角色部位词",
    "性征部位词",
    "服饰词",
    "动作词",
    "角色表情词",
    "镜头词",
    "未归类词",
    "角色身份词",
    "作品版权词",
    "发色发型词",
    "亚人特征词",
    "审查遮挡词",
    "文字水印词",
    "质量元词",
    "物件道具词",
  ];
  const LEGACY_CATEGORY_COUNT = 12;
  const PRESET_NONE = "自定义（不用预设）";
  // 新增分类里默认**关闭**的两类（负面词类）。与后端 DEFAULT_OFF_CATEGORIES 一致，
  // 一致性由 tests/test_danbooru_tag_getter.py 的 fallback 锁保证。
  const DEFAULT_OFF_CATEGORIES = ["审查遮挡词", "文字水印词"];
  // ⚠️ 内置场景预设已按用户要求（2026-09-14）**全部移除**：预设只留"不用预设"，
  // 其余一律走后端自定义预设库（data/tag_presets.json），由 refreshPresetOptions()
  // 拉进下拉、applyPreset() 从缓存还原开关与权重，面板上可存可删。
  // 原来那 6 条 off/only 规则的原文备份在
  // docs/HANDOFF-2026-09-14-二采CN升级与ACN接入.md。
  const PRESETS = {
    [PRESET_NONE]: {},
  };


  function injectStyles() {
    const styleId = "tk-danbooru-tag-getter-style";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .tk-dtb-panel { box-sizing:border-box; width:100%; max-height:100%; overflow-y:auto; padding:3px 5px 4px; color:#b8b8b8; font:12px/1.25 Arial, sans-serif; scrollbar-width:thin; }
      .tk-dtb-panel * { box-sizing:border-box; }
      .tk-dtb-header { display:flex; align-items:center; gap:8px; min-height:22px; padding:0 1px 3px; border-bottom:1px solid rgba(255,255,255,.10); }
      .tk-dtb-title { color:#bdbdbd; font-weight:normal; }
      .tk-dtb-count { margin-left:auto; color:#858585; font-size:11px; font-variant-numeric:tabular-nums; }
      /* 批量操作：20 个开关手点太累，压成一行低对比文字按钮，hover 才显形 */
      .tk-dtb-actions { display:flex; align-items:center; gap:2px; }
      .tk-dtb-action { padding:1px 4px; color:#7d7d7d; font-size:10px; line-height:14px; border-radius:2px; cursor:pointer; user-select:none; white-space:nowrap; }
      .tk-dtb-action:hover { color:#e1e1e1; background:rgba(255,255,255,.08); }
      .tk-dtb-action:active { background:rgba(255,255,255,.15); }
      .tk-dtb-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:2px 5px; padding-top:4px; }
      /* 三列固定：开关 / 分类名 / 权重。权重列定宽，20 行的权重框才右对齐成一列 */
      .tk-dtb-row { display:grid; grid-template-columns:13px minmax(0,1fr) 40px; align-items:center; gap:5px; min-width:0; min-height:22px; padding:2px 4px; border:1px solid transparent; border-radius:2px; background:rgba(0,0,0,.13); cursor:pointer; }
      .tk-dtb-row:hover { background:rgba(255,255,255,.055); }
      .tk-dtb-row:active { background:rgba(255,255,255,.10); }
      .tk-dtb-row.is-selected { color:#e1e1e1; border-color:rgba(255,255,255,.13); background:rgba(255,255,255,.08); }
      .tk-dtb-toggle { width:12px; height:12px; margin:0; accent-color:#bcbcbc; cursor:pointer; }
      .tk-dtb-label { min-width:0; overflow:hidden; color:#9f9f9f; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
      .tk-dtb-row.is-selected .tk-dtb-label { color:#dedede; }
      .tk-dtb-weight-control { display:flex; align-items:center; justify-content:flex-end; gap:2px; color:#777; cursor:default; }
      .tk-dtb-weight-prefix { font-size:10px; line-height:16px; }
      .tk-dtb-weight-input { box-sizing:border-box; width:36px; height:17px; padding:1px 2px; color:#d7d7d7; background:#292929; border:1px solid #4a4a4a; border-radius:2px; outline:none; font:10px/1 Arial,sans-serif; text-align:right; font-variant-numeric:tabular-nums; }
      .tk-dtb-weight-input:focus { border-color:#999; }
      /* 键盘可达性：上面把 outline 清掉了，这里给键盘焦点补回来 */
      .tk-dtb-panel input:focus-visible, .tk-dtb-panel select:focus-visible, .tk-dtb-panel textarea:focus-visible { outline:1px solid #9a9a9a; outline-offset:0; }
      .tk-dtb-filters { margin-top:5px; padding-top:5px; border-top:1px solid rgba(255,255,255,.10); }
      .tk-dtb-filter-title { color:#bdbdbd; font-size:11px; }
      .tk-dtb-filter-row { display:flex; align-items:flex-start; gap:5px; margin-top:4px; }
      .tk-dtb-filter-row .tk-dtb-action { margin-top:3px; }
      .tk-dtb-filter-label { flex:0 0 52px; padding-top:4px; color:#929292; font-size:10px; white-space:nowrap; }
      .tk-dtb-filter-input { min-width:0; width:100%; flex:1; padding:4px 5px; color:#dedede; background:#343434; border:1px solid #505050; border-radius:2px; outline:none; font:11px/1.35 Arial,sans-serif; resize:vertical; }
      .tk-dtb-filter-input:focus { border-color:#999; }
      .tk-dtb-filter-input::placeholder { color:#777; }
      textarea.tk-dtb-filter-input { min-height:39px; max-height:82px; }
      /* 场景预设 */
      .tk-dtb-preset-row { display:flex; align-items:center; gap:5px; margin-top:5px; }
      .tk-dtb-preset-label { flex:0 0 auto; color:#929292; font-size:10px; white-space:nowrap; }
      .tk-dtb-preset { box-sizing:border-box; min-width:0; flex:1; height:20px; padding:0 4px; color:#d7d7d7; background:#292929; border:1px solid #4a4a4a; border-radius:2px; outline:none; font:11px/1 Arial,sans-serif; }
      .tk-dtb-preset:focus { border-color:#999; }
      /* 预设管理：命名输入 + 保存 / 删除 */
      .tk-dtb-preset-manage { display:flex; align-items:center; gap:4px; margin-top:3px; }
      .tk-dtb-preset-name { min-width:0; flex:1; height:20px; padding:0 5px; color:#d7d7d7; background:#292929; border:1px solid #4a4a4a; border-radius:2px; outline:none; font:11px/1 Arial,sans-serif; }
      .tk-dtb-preset-name:focus { border-color:#999; }
      .tk-dtb-preset-name::placeholder { color:#777; }
      .tk-dtb-preset-hint { margin-top:3px; min-height:0; color:#8a8a8a; font-size:10px; line-height:1.35; }
      /* 过滤诊断底栏：把"哪些词被保留、哪些因为什么被丢"摆出来，避免过滤黑箱 */
      .tk-dtb-report { margin-top:5px; padding-top:4px; border-top:1px solid rgba(255,255,255,.10); }
      .tk-dtb-report-head { display:flex; align-items:baseline; gap:6px; }
      .tk-dtb-report-title { color:#bdbdbd; font-size:11px; }
      .tk-dtb-report-hint { color:#7d7d7d; font-size:10px; }
      .tk-dtb-report-body { margin-top:3px; max-height:150px; overflow-y:auto; scrollbar-width:thin; }
      .tk-dtb-report-empty { color:#7d7d7d; font-size:10px; line-height:1.4; }
      .tk-dtb-report-warn { margin:2px 0; padding:2px 4px; color:#e0b070; background:rgba(224,176,112,.10); border-radius:2px; font-size:10px; line-height:1.4; }
      .tk-dtb-report-section { margin-top:4px; color:#8f8f8f; font-size:10px; }
      .tk-dtb-report-section.is-kept { color:#7fae86; }
      .tk-dtb-report-section.is-dropped { color:#c98a8a; }
      .tk-dtb-report-section.is-unknown { color:#c0a86a; }
      .tk-dtb-report-row { display:flex; gap:5px; padding:1px 0; font-size:10px; line-height:1.35; }
      .tk-dtb-report-cat { flex:0 0 auto; max-width:46%; color:#9a9a9a; cursor:pointer; text-decoration:underline dotted; }
      .tk-dtb-report-cat:hover { color:#e1e1e1; }
      .tk-dtb-report-row.is-kept .tk-dtb-report-cat { color:#8fbf95; }
      .tk-dtb-report-row.is-dropped .tk-dtb-report-cat { color:#d09a9a; }
      .tk-dtb-report-words { flex:1 1 auto; min-width:0; color:#a8a8a8; word-break:break-word; }
      .tk-dtb-preset-hint:empty { display:none; }
      /* 主题剔除 chips */
      .tk-dtb-section { margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,.10); }
      .tk-dtb-section-head { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
      .tk-dtb-section-title { color:#bdbdbd; font-size:11px; }
      .tk-dtb-section-hint { margin-left:auto; color:#7d7d7d; font-size:10px; }
      .tk-dtb-chips { display:flex; flex-wrap:wrap; gap:3px; }
      .tk-dtb-chip { padding:2px 6px; color:#9f9f9f; background:rgba(0,0,0,.18); border:1px solid rgba(255,255,255,.10); border-radius:9px; font-size:10px; line-height:14px; cursor:pointer; user-select:none; white-space:nowrap; }
      .tk-dtb-chip:hover { color:#dedede; background:rgba(255,255,255,.06); }
      .tk-dtb-chip.is-on { color:#f2d2d2; background:rgba(186,72,72,.24); border-color:rgba(220,112,112,.48); }
      .tk-dtb-chip.is-more { color:#8a8a8a; border-style:dashed; }
      /* 新增分类与旧分类做视觉区分，避免误以为节点突然变复杂 */
      .tk-dtb-row.is-new { background:rgba(255,255,255,.04); }
      .tk-dtb-divider { grid-column:1 / -1; margin:3px 0 1px; padding-top:3px; border-top:1px solid rgba(255,255,255,.10); color:#7d7d7d; font-size:10px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .tk-dtb-divider-actions { display:flex; align-items:center; gap:2px; }
    `;
    document.head.appendChild(style);
  }

  class DanbooruTagGetterUI {
    constructor(node) {
      this.node = node;
      this.panel = null;
      this.count = null;
      this.controls = new Map();
      this.filterControls = new Map();
      this.weightControls = new Map();
      this.presetSelect = null;
      this.presetNameInput = null;
      this.presetStatus = null;
      this.presetHint = null;
      // 后端 data/tag_presets.json 里的自定义预设 {名称: {flags, weights}}，
      // 由 refreshPresetOptions() 拉取缓存 —— applyPreset 靠它还原开关（内置表里没有）。
      this.customPresets = {};
    }

    widgetFor(category) {
      return this.node.widgets?.find((widget) => widget.name === category) || null;
    }

    weightWidgetFor(category) {
      return this.node.widgets?.find((widget) => widget.name === `${category}_weight`) || null;
    }

    normaliseWeightValue(value) {
      // 空值 / 非数字 / 0（含负数）一律归一到中性 1.0：
      // 权重字段是后加的，旧工作流里没有它，ComfyUI 会把新 widget 恢复成 0；
      // 若原样保留，节点会按 (tag:0) 执行 —— 该分类的 Tag 被静默丢弃。
      // 滑块下限是 0.05，所以 0 不可能是用户有意设置的值。
      if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return 1;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return 1;
      const clamped = Math.max(0.05, Math.min(2, Math.round(numeric / 0.05) * 0.05));
      return Number(clamped.toFixed(2));
    }

    formatWeight(value) {
      const numeric = this.normaliseWeightValue(value);
      return numeric.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") || "0";
    }

    normaliseWeightWidget(category) {
      const widget = this.weightWidgetFor(category);
      if (!widget) return 1;
      const next = this.normaliseWeightValue(widget.value);
      if (widget.value !== next) {
        widget.value = next;
        // 写回 1.0 并标记工作流已变更，避免节点执行得到 (tag:0)
        if (typeof widget.callback === "function") widget.callback(next);
        this.node.graph?.change();
      }
      return next;
    }

    updateCount() {
      if (!this.count) return;
      const selected = CATEGORY_NAMES.reduce((total, category) => {
        const widget = this.widgetFor(category);
        return total + (widget?.value ? 1 : 0);
      }, 0);
      this.count.textContent = `${selected} / ${CATEGORY_NAMES.length}`;
    }

    setWidgetValue(category, value) {
      const widget = this.widgetFor(category);
      if (!widget) return;
      widget.value = Boolean(value);
      if (typeof widget.callback === "function") widget.callback(widget.value);
      this.node.graph?.change();
      this.updateCount();
      const control = this.controls.get(category);
      // ⚠️ 必须同时同步复选框本身 —— 旧代码只改了整行样式，
      // 于是"选了预设之后底下的开关看起来一个都没变"（值其实变了）。
      if (control && control.toggle) control.toggle.checked = widget.value;
      if (control && control.row) control.row.classList.toggle("is-selected", widget.value);
      // ★ 用户**手动**改开关 = 离开任何命名预设 —— 见 releasePresetOnManualEdit。
      // applyPreset() 自己批量写值时会用 _applyingPreset 跳过本逻辑。
      if (!this._applyingPreset) this.releasePresetOnManualEdit(category);
    }

    /**
     * 手动改开关 → 把预设切回「自定义（不用预设）」。
     *
     * 为什么必须在**前端**解除：后端 `get_tags` 执行时会调
     * `_apply_preset(preset, category_flags)`，而自定义预设存的是**完整开关快照**
     * （`_apply_custom_preset` 对 `CATEGORY_NAMES` 无差别覆盖），于是用户在这次执行前
     * 改过的开关会被预设快照盖回去 —— **UI 显示 false、提交值也是 false，实际生效却是 true**，
     * 面板上完全看不出来。
     *
     * 用户 2026-09-20 实报："图一明明关闭了背景词却输出了 simple background"。
     * 实测复现：preset="普通过滤"（data/tag_presets.json 里 `背景词: true`）时，
     * `_apply_preset` 把提交的 `背景词=false` 展开成 `true`，输出含 simple background、
     * dropped=0；换成"不用预设"则正确丢弃 25 个词。
     *
     * 把预设名切回"不用预设"是最诚实的表达：**开关值才是真实状态**，
     * 名字不该继续宣称"我还在用那套预设"。预设本身仍然可用 —— 从下拉里选它即可套用。
     */
    releasePresetOnManualEdit(category) {
      const widget = this.widgetFor("preset");
      const current = String(this.presetSelect?.value ?? widget?.value ?? PRESET_NONE);
      if (!current || current === PRESET_NONE) return;
      if (this.presetSelect) this.presetSelect.value = PRESET_NONE;
      if (widget) {
        widget.value = PRESET_NONE;
        if (typeof widget.callback === "function") widget.callback(PRESET_NONE);
      }
      this.updatePresetHint(PRESET_NONE);
      this.setPresetStatus(
        `开关已手动改动 → 切到「自定义（不用预设）」，改的「${category}」现在生效；`
        + `预设「${current}」只在你从下拉里选它时才套用`);
    }

    setFilterValue(name, value) {
      const widget = this.widgetFor(name);
      if (!widget) return;
      widget.value = String(value ?? "");
      if (typeof widget.callback === "function") widget.callback(widget.value);
      this.node.graph?.change();
    }

    setWeightValue(category, value) {
      const widget = this.weightWidgetFor(category);
      if (!widget) return;
      const next = this.normaliseWeightValue(value);
      widget.value = next;
      if (typeof widget.callback === "function") widget.callback(widget.value);
      this.node.graph?.change();
      const control = this.weightControls.get(category);
      if (control && control.value !== this.formatWeight(widget.value)) control.value = this.formatWeight(widget.value);
      // 与开关对称：手动改权重同样算"离开预设"。
      // （后端 `_apply_preset` 已改为"显式传参优先"，所以行为上本来就不会被覆盖；
      //   这里是为了让面板名实一致，并给用户一句解释。）
      if (!this._applyingPreset) this.releasePresetOnManualEdit(`${category}权重`);
    }

    hideNativeWidget(widget) {
      if (!widget) return;
      widget.hidden = true;
      widget.options = widget.options || {};
      widget.options.hidden = true;
      widget.computeSize = () => [0, -4];
      widget.draw = () => {};
      if (widget.element) widget.element.style.display = "none";
    }

    build() {
      injectStyles();
      const panel = document.createElement("div");
      panel.className = "tk-dtb-panel";
      this.panel = panel;

      const header = document.createElement("div");
      header.className = "tk-dtb-header";
      const title = document.createElement("span");
      title.className = "tk-dtb-title";
      title.textContent = "分类";
      // 批量开关：20 个分类手点一遍太累，常用动作压成一行文字按钮
      const actions = document.createElement("div");
      actions.className = "tk-dtb-actions";
      const makeAction = (labelText, hintText, handler) => {
        const button = document.createElement("span");
        button.className = "tk-dtb-action";
        button.textContent = labelText;
        button.title = hintText;
        button.addEventListener("click", handler);
        return button;
      };
      actions.append(
        makeAction("全开", `打开全部 ${CATEGORY_NAMES.length} 个分类`, () => this.setAllCategories(true)),
        makeAction("全关", `关闭全部 ${CATEGORY_NAMES.length} 个分类`, () => this.setAllCategories(false)),
        makeAction("反选", "已开的关掉、未开的打开", () => this.invertCategories()),
        makeAction("权重归 1", "把所有分类权重恢复成中性 1.0", () => this.resetWeights())
      );
      this.count = document.createElement("span");
      this.count.className = "tk-dtb-count";
      header.append(title, actions, this.count);

      const grid = document.createElement("div");
      grid.className = "tk-dtb-grid";
      CATEGORY_NAMES.forEach((category, index) => {
        const widget = this.widgetFor(category);
        if (!widget) return;
        if (index === LEGACY_CATEGORY_COUNT) {
          // 视觉上把「新增 8 类」与旧 12 类分开，避免用户误以为节点逻辑变了
          const divider = document.createElement("div");
          divider.className = "tk-dtb-divider";
          const dividerLabel = document.createElement("span");
          dividerLabel.textContent = "扩展分类（新增 · 默认开启）";
          // 2026-09-16 用户真机反馈：旧工作流里这几类存的是**旧版默认 true**，
          // 后来代码改成「负面词类（审查遮挡词/文字水印词）默认关」也盖不过已保存的值 ⇒
          // 每次加载又是勾选的。顶栏「全关」会把旧 12 类一起关掉，所以这里单独给一对按钮。
          const dividerActions = document.createElement("span");
          dividerActions.className = "tk-dtb-divider-actions";
          dividerActions.append(
            makeAction("全开", `打开全部 ${CATEGORY_NAMES.length - LEGACY_CATEGORY_COUNT} 个扩展分类`, () => this.setNewCategories(true)),
            makeAction("全关", `关闭全部 ${CATEGORY_NAMES.length - LEGACY_CATEGORY_COUNT} 个扩展分类（旧 12 类不动）`, () => this.setNewCategories(false))
          );
          divider.append(dividerLabel, dividerActions);
          grid.appendChild(divider);
        }
        const row = document.createElement("div");
        row.className = index >= LEGACY_CATEGORY_COUNT ? "tk-dtb-row is-new" : "tk-dtb-row";
        const toggle = document.createElement("input");
        toggle.className = "tk-dtb-toggle";
        toggle.type = "checkbox";
        toggle.checked = Boolean(widget.value);
        toggle.setAttribute("aria-label", category);
        toggle.addEventListener("change", () => this.setWidgetValue(category, toggle.checked));
        const label = document.createElement("span");
        label.className = "tk-dtb-label";
        label.textContent = category;
        const weightWidget = this.weightWidgetFor(category);
        let weightInput = null;
        if (weightWidget) {
          const normalisedWeight = this.normaliseWeightWidget(category);
          const weightControl = document.createElement("span");
          weightControl.className = "tk-dtb-weight-control";
          weightControl.title = `${category} Tag 权重（0.0–2.0；1.0 保持原样）`;
          const prefix = document.createElement("span");
          prefix.className = "tk-dtb-weight-prefix";
          prefix.textContent = "×";
          weightInput = document.createElement("input");
          weightInput.className = "tk-dtb-weight-input";
          weightInput.type = "number";
          weightInput.min = "0";
          weightInput.max = "2";
          weightInput.step = "0.05";
          weightInput.inputMode = "decimal";
          weightInput.value = this.formatWeight(normalisedWeight);
          weightInput.setAttribute("aria-label", `${category} Tag 权重`);
          weightInput.addEventListener("click", (event) => event.stopPropagation());
          weightInput.addEventListener("mousedown", (event) => event.stopPropagation());
          weightInput.addEventListener("change", () => this.setWeightValue(category, weightInput.value));
          // 双击归 1.0：改过权重后想恢复中性值，不用手输
          weightInput.addEventListener("dblclick", (event) => {
            event.stopPropagation();
            weightInput.value = "1";
            this.setWeightValue(category, 1);
          });
          weightInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); weightInput.blur(); }
          });
          weightControl.append(prefix, weightInput);
          row.append(toggle, label, weightControl);
          this.weightControls.set(category, weightInput);
          this.hideNativeWidget(weightWidget);
        } else {
          row.append(toggle, label);
        }
        row.addEventListener("click", (event) => {
          if (event.target === toggle || event.target.closest?.(".tk-dtb-weight-control")) return;
          toggle.checked = !toggle.checked;
          this.setWidgetValue(category, toggle.checked);
        });
        row.classList.toggle("is-selected", Boolean(widget.value));
        grid.appendChild(row);
        this.controls.set(category, { row, toggle });
        this.hideNativeWidget(widget);
      });

      const filters = document.createElement("div");
      filters.className = "tk-dtb-filters";
      const filterTitle = document.createElement("div");
      filterTitle.className = "tk-dtb-filter-title";
      filterTitle.textContent = "排除";
      filters.appendChild(filterTitle);

      const makeFilter = (name, labelText, placeholder, multiline) => {
        const widget = this.widgetFor(name);
        if (!widget) return;
        const row = document.createElement("div");
        row.className = "tk-dtb-filter-row";
        const label = document.createElement("span");
        label.className = "tk-dtb-filter-label";
        label.textContent = labelText;
        const field = document.createElement(multiline ? "textarea" : "input");
        field.className = "tk-dtb-filter-input";
        field.value = String(widget.value || "");
        field.placeholder = placeholder;
        field.title = name;
        if (multiline) {
          field.rows = 2;
          field.spellcheck = false;
        }
        field.addEventListener("input", () => this.setFilterValue(name, field.value));
        const clear = document.createElement("span");
        clear.className = "tk-dtb-action";
        clear.textContent = "清空";
        clear.title = `清空「${labelText}」`;
        clear.addEventListener("click", (event) => {
          event.stopPropagation();
          field.value = "";
          this.setFilterValue(name, "");
        });
        row.append(label, field, clear);
        filters.appendChild(row);
        this.hideNativeWidget(widget);
        this.filterControls.set(name, field);
      };
      makeFilter("regex_blacklist", "正则排除", "censor|watermark", false);
      makeFilter("tag_blacklist", "精准排除", "每行一个 Tag，也可用逗号分隔", true);

      // 自然语言：**整块 UI 已按用户要求移除**（2026-09-13）。
      // 历史包袱：原先「保留自然语言 / 过滤自然语言」两个开关语义互相打架
      // （都开会拿标签用的 regex_blacklist 去删自然语言句子，句子含 hair /
      // background 就整段消失 → 下游提示词为空），随后又叠了一个下拉来"收敛"，
      // 等于同一件事摆三个控件。现在后端固定为「保留（不过滤）」。
      // 这三个控件仍在 INPUT_TYPES 里占位（删掉会让旧工作流 widgets_values
      // 错位/超长，部分前端版本会直接抛异常），所以必须把它们藏起来，
      // 否则会以原生控件形态冒出来。
      for (const name of ["natural_mode", "include_natural_language", "filter_natural_language"]) {
        this.hideNativeWidget(this.widgetFor(name));
      }

      // 场景预设放在最上面：一键切换整套开关，改动后各开关会同步显示，不会"黑箱"
      const presetRow = document.createElement("div");
      presetRow.className = "tk-dtb-preset-row";
      const presetLabel = document.createElement("span");
      presetLabel.className = "tk-dtb-preset-label";
      presetLabel.textContent = "场景预设";
      const presetSelect = document.createElement("select");
      presetSelect.className = "tk-dtb-preset";
      const presetWidget = this.widgetFor("preset");
      if (presetWidget) {
        const values = Array.isArray(presetWidget.options?.values)
          ? presetWidget.options.values
          : Object.keys(PRESETS);
        values.forEach((item) => {
          const option = document.createElement("option");
          option.value = String(item);
          option.textContent = String(item);
          presetSelect.appendChild(option);
        });
        presetSelect.value = String(presetWidget.value || PRESET_NONE);
        presetSelect.addEventListener("change", () => this.applyPreset(presetSelect.value));
        this.hideNativeWidget(presetWidget);
        this.presetSelect = presetSelect;
      }
      presetRow.append(presetLabel, presetSelect);

      // 预设管理：保存当前开关快照为命名预设 / 删除自定义预设（存在后端 data/tag_presets.json）
      const presetManage = document.createElement("div");
      presetManage.className = "tk-dtb-preset-manage";
      const presetNameInput = document.createElement("input");
      presetNameInput.className = "tk-dtb-preset-name";
      presetNameInput.type = "text";
      presetNameInput.placeholder = "预设名…";
      presetNameInput.spellcheck = false;
      presetNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); this.savePreset(); }
        event.stopPropagation();
      });
      this.presetNameInput = presetNameInput;
      const saveButton = document.createElement("span");
      saveButton.className = "tk-dtb-action";
      saveButton.textContent = "保存";
      saveButton.title = "把当前 20 个开关 + 权重存成一个命名预设";
      saveButton.addEventListener("click", () => this.savePreset());
      const deleteButton = document.createElement("span");
      deleteButton.className = "tk-dtb-action";
      deleteButton.textContent = "删除";
      deleteButton.title = "删除下拉里当前选中的自定义预设";
      deleteButton.addEventListener("click", () => this.deletePreset());
      presetManage.append(presetNameInput, saveButton, deleteButton);

      const presetStatus = document.createElement("div");
      presetStatus.className = "tk-dtb-preset-hint";
      this.presetStatus = presetStatus;

      // 预设影响说明：选了预设后直接告诉用户它动了哪些分类，不用去逐个比对开关
      const presetHint = document.createElement("div");
      presetHint.className = "tk-dtb-preset-hint";
      this.presetHint = presetHint;

      // 主题剔除：**整块已按用户要求移除**（2026-09-14）。
      // 两个控件（exclude_groups / exclude_groups_custom）仍在 INPUT_TYPES 里占位
      // （删掉会让旧工作流 widgets_values 错位），所以必须藏起来，否则会冒出来。
      this.hideNativeWidget(this.widgetFor("exclude_groups"));
      this.hideNativeWidget(this.widgetFor("exclude_groups_custom"));

      panel.append(header, presetRow, presetManage, presetStatus, presetHint, grid, filters,
                   this.buildFilterReportBar());
      this.refreshPresetOptions();
      this.watchFilterReport();
      this.updateCount();
      return panel;
    }

    // ── 批量操作（面板顶栏那四个文字按钮） ──

    setAllCategories(value) {
      CATEGORY_NAMES.forEach((category) => this.setWidgetValue(category, value));
      this.node.graph?.change();
    }

    /**
     * 只作用于「扩展分类」那 8 类。
     * 2026-09-16 用户真机反馈：旧工作流里这些分类存的是**旧版默认 true**，
     * 后来代码把它们改成「负面词类默认关」也盖不过已保存的值 ⇒ 每次加载又是勾选的，
     * 而顶栏的「全关」会把旧 12 类一起关掉（粒度太粗，用户要重开 12 次）。
     */
    setNewCategories(value) {
      CATEGORY_NAMES.slice(LEGACY_CATEGORY_COUNT).forEach((category) => this.setWidgetValue(category, value));
      this.node.graph?.change();
    }

    invertCategories() {
      CATEGORY_NAMES.forEach((category) => {
        this.setWidgetValue(category, !this.widgetFor(category)?.value);
      });
      this.node.graph?.change();
    }

    resetWeights() {
      CATEGORY_NAMES.forEach((category) => {
        if (this.weightWidgetFor(category)) this.setWeightValue(category, 1);
      });
    }

    // ── 场景预设 ──

    applyPreset(name) {
      // 套用期间屏蔽 setWidgetValue 里的"手动改动即脱离预设"：
      // 否则这里刚写下去的第一个开关就会把预设名清成「不用预设」，
      // 剩下的开关没人套用（"选了预设没反应"的历史 bug 会以新形态复发）。
      const previousApplying = this._applyingPreset;
      this._applyingPreset = true;
      try {
        const spec = PRESETS[name];
        // 自定义预设（后端 data/tag_presets.json）存的是**完整开关快照 + 权重**，
        // 不在前端这张内置表里 —— 只查 PRESETS 会给自定义预设拿到空 spec，
        // 结果 20 个开关一个都不动（"选了没反应"）。
        const custom = spec ? null : (this.customPresets || {})[name];
        if (spec) {
          CATEGORY_NAMES.forEach((category) => {
            let next = Boolean(this.widgetFor(category)?.value);
            if (spec.only) next = spec.only.includes(category);
            if (spec.off && spec.off.includes(category)) next = false;
            this.setWidgetValue(category, next);
          });
        } else if (custom) {
          const flags = custom.flags || {};
          CATEGORY_NAMES.forEach((category) => {
            if (category in flags) this.setWidgetValue(category, Boolean(flags[category]));
          });
          Object.entries(custom.weights || {}).forEach(([category, value]) => {
            if (typeof value === "number" && Number.isFinite(value)) {
              this.setWeightValue(category, value);
            }
          });
        }
        const widget = this.widgetFor("preset");
        if (widget) {
          widget.value = name;
          if (typeof widget.callback === "function") widget.callback(name);
        }
        this.node.graph?.change();
        this.updateCount();
        this.updatePresetHint(name);
      } finally {
        this._applyingPreset = previousApplying;
      }
    }

    updatePresetHint(name) {
      if (!this.presetHint) return;
      const spec = PRESETS[name];
      if (spec?.only) {
        this.presetHint.textContent = `只开：${spec.only.join("、")}；其余全部关闭`;
      } else if (spec?.off && spec.off.length) {
        this.presetHint.textContent = `已关闭：${spec.off.join("、")}`;
      } else if (!spec && (this.customPresets || {})[name]) {
        this.presetHint.textContent = "自定义预设：已还原保存时的开关与权重";
      } else {
        this.presetHint.textContent = "";
      }
    }

    // ── 自定义预设（保存 / 删除当前开关快照）──

    /** 当前 20 类的开关状态（保存预设用）。 */
    currentFlags() {
      const flags = {};
      CATEGORY_NAMES.forEach((category) => {
        flags[category] = Boolean(this.widgetFor(category)?.value);
      });
      return flags;
    }

    /** 当前 20 类的权重（保存预设用）。 */
    currentWeights() {
      const weights = {};
      CATEGORY_NAMES.forEach((category) => {
        const widget = this.weightWidgetFor(category);
        if (widget) weights[category] = this.normaliseWeightValue(widget.value);
      });
      return weights;
    }

    setPresetStatus(text) {
      if (this.presetStatus) this.presetStatus.textContent = text || "";
    }

    /** 拉一次自定义预设库，把名字补进下拉（失败静默：内置预设照常用）。 */
    async refreshPresetOptions() {
      try {
        const response = await fetch("/anima/tag_presets");
        const data = await response.json();
        // 缓存整份快照：applyPreset 需要用它还原自定义预设的开关与权重
        this.customPresets = (data && typeof data.presets === "object" && data.presets) || {};
        (data?.names || []).forEach((name) => this.appendPresetOption(name));
      } catch (error) {
        // 不静默：拉不到自定义预设时，`presetExpectedFlags` 无法判断期望值 ⇒ 载入对账退化为
        // "不摘预设"。留一条 warn，免得以后又把"对账没生效"误判成"对账逻辑写错了"。
        console.warn("[TK Tag Getter] 拉取 /anima/tag_presets 失败，载入对账可能无法生效：", error);
      }
      // 自定义预设拉齐之后再对账 —— 否则会误判成"不认识的预设名"而放过。
      this.reconcilePresetWithSwitches();
    }

    /**
     * 载入时对账：**开关值才是真实状态**，预设名只是标签。
     *
     * 后端 `get_tags` 执行时会调 `_apply_preset(preset, flags)`，自定义预设存的是
     * **完整开关快照**（`_apply_custom_preset` 对 CATEGORY_NAMES 无差别覆盖），
     * 所以只要 preset 名还挂着，运行期就会把开关盖回快照值 —— UI 与提交值都是
     * false、实际生效 true，面板上完全看不出来。
     *
     * 用户 2026-09-20 实报的工作流正是这个状态：preset="普通过滤"
     * （`data/tag_presets.json` 里 `背景词: true`）但「背景词」开关已关。
     * 只靠"手动改开关才摘预设"救不了这份**已保存**的工作流（用户不动开关就还是错的），
     * 所以载入后立刻比对一次：**只要开关与预设快照不一致，就把预设名摘成
     * 「自定义（不用预设）」**，让面板显示与运行期行为重新一致。
     *
     * 正常情况（选了预设后没手动改过）两者一致 ⇒ 不会被摘，预设照常可用。
     */
    reconcilePresetWithSwitches() {
      const widget = this.widgetFor("preset");
      const name = String(this.presetSelect?.value ?? widget?.value ?? PRESET_NONE);
      if (!name || name === PRESET_NONE) return;

      const expected = this.presetExpectedFlags(name);
      if (!expected) return;                       // 不认识的预设名：不动，交给后端旧语义
      const mismatched = CATEGORY_NAMES.filter((category) => {
        if (!(category in expected)) return false;
        return Boolean(this.widgetFor(category)?.value) !== Boolean(expected[category]);
      });
      if (!mismatched.length) return;

      if (this.presetSelect) this.presetSelect.value = PRESET_NONE;
      if (widget) {
        widget.value = PRESET_NONE;
        if (typeof widget.callback === "function") widget.callback(PRESET_NONE);
      }
      this.updatePresetHint(PRESET_NONE);
      this.setPresetStatus(
        `此工作流保存时用的预设「${name}」与实际开关不一致（${mismatched.join("、")}），`
        + `已自动切到「自定义（不用预设）」—— 现在按面板上的开关执行，不会再被预设覆盖`);
    }

    /** 预设对每个分类的期望开关值；内置预设按 only/off 规则推，自定义预设用其快照。 */
    presetExpectedFlags(name) {
      const spec = PRESETS[name];
      const custom = spec ? null : (this.customPresets || {})[name];
      if (!spec && !custom) return null;
      const expected = {};
      CATEGORY_NAMES.forEach((category) => {
        if (custom) {
          const flags = custom.flags || {};
          if (category in flags) expected[category] = Boolean(flags[category]);
          return;
        }
        // 与后端 `_apply_preset` 的优先级**逐条对齐**：先 only、后 off（off 覆盖 only）。
        // 写成 `else if` 会在 `{only:[…], off:[…]}` 并存时推出错误的期望值 ⇒ 误摘预设。
        // 当前内置预设只剩「不用预设」（本分支是死代码），但一旦恢复规则型预设就会咬人。
        if (spec.only) {
          expected[category] = spec.only.includes(category);
        }
        if (spec.off && spec.off.includes(category)) {
          expected[category] = false;
        }
      });
      return expected;
    }

    /** 把自定义预设名加进下拉（已存在则不动）。 */
    appendPresetOption(name) {
      if (!this.presetSelect) return;
      const exists = [...this.presetSelect.options].some((option) => option.value === name);
      if (exists) return;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      this.presetSelect.appendChild(option);
    }

    async presetRequest(payload) {
      const response = await fetch("/anima/tag_presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      return data || {};
    }

    async savePreset() {
      const name = String(this.presetNameInput?.value || "").trim();
      if (!name) {
        this.setPresetStatus("先填预设名");
        return;
      }
      try {
        const data = await this.presetRequest({
          action: "save", name, flags: this.currentFlags(), weights: this.currentWeights(),
        });
        this.setPresetStatus(data.message || (data.ok ? "已保存" : "保存失败"));
        if (data.ok) {
          this.appendPresetOption(name);
          // 立刻进缓存，免得"刚保存就切换"要等下一次 refresh 才生效
          this.customPresets[name] = {
            flags: this.currentFlags(), weights: this.currentWeights(),
          };
          if (this.presetNameInput) this.presetNameInput.value = "";
        }
      } catch (error) {
        this.setPresetStatus(`保存失败：${error}`);
      }
    }

    async deletePreset() {
      const name = String(this.presetSelect?.value || "");
      if (!name || name === PRESET_NONE) {
        this.setPresetStatus("「自定义（不用预设）」不能删");
        return;
      }
      try {
        const data = await this.presetRequest({ action: "delete", name });
        this.setPresetStatus(data.message || (data.ok ? "已删除" : "删除失败"));
        if (data.ok) {
          delete this.customPresets[name];
          [...(this.presetSelect?.options || [])]
            .filter((option) => option.value === name)
            .forEach((option) => option.remove());
          if (this.presetSelect) this.presetSelect.value = PRESET_NONE;
        }
      } catch (error) {
        this.setPresetStatus(`删除失败：${error}`);
      }
    }

    // ── 过滤诊断底栏 ──
    //
    // 数据来源：后端 get_tags 通过 ComfyUI 的 ui 通道回传 tk_filter_report
    // （保留 / 各类别被丢 / 黑名单丢 / 正则丢 / 未归类）。前端在 executed 事件里
    // 取到它渲染成底栏 —— 之前过滤是黑箱：关错类别看不到丢了什么，只能靠猜。
    // 点类别名可直接开关该类，并就地重算，不必等下一次执行。

    buildFilterReportBar() {
      const wrap = document.createElement("div");
      wrap.className = "tk-dtb-report";
      const head = document.createElement("div");
      head.className = "tk-dtb-report-head";
      const title = document.createElement("span");
      title.className = "tk-dtb-report-title";
      title.textContent = "过滤诊断";
      const hint = document.createElement("span");
      hint.className = "tk-dtb-report-hint";
      hint.textContent = "跑一次图后显示 · 点类别名可直接开关";
      head.append(title, hint);
      const body = document.createElement("div");
      body.className = "tk-dtb-report-body";
      const placeholder = document.createElement("div");
      placeholder.className = "tk-dtb-report-empty";
      placeholder.textContent = "尚未执行。执行一次工作流后，这里显示保留了哪些词、哪些词因为什么被丢掉。";
      body.append(placeholder);
      wrap.append(head, body);
      this.reportBody = body;
      this.reportData = null;
      return wrap;
    }

    async watchFilterReport() {
      if (this.reportListener) return;
      let api = globalThis.comfyAPI?.api?.api || globalThis.comfyAPI?.api || null;
      if (!api?.addEventListener) {
        try {
          api = (await import("/scripts/api.js")).api;      // IIFE 里只能用动态 import
        } catch (error) {
          console.warn("[TK Tag Getter] 拿不到 ComfyUI api，过滤底栏不可用：", error);
          return;
        }
      }
      if (!api?.addEventListener) return;
      this.reportListener = ({ detail }) => {
        const nodeId = String(this.node?.id ?? "");
        if (!nodeId || String(detail?.node ?? "") !== nodeId) return;
        // ComfyUI 的 ui 通道约定「每个值都是 list」（execution.py 用
        // `[y for x in uis for y in x[k]]` 展平）。后端因此回传 `[报告]`；
        // 这里同时容忍历史上的单 dict 形态，避免旧缓存/旧版本回放时又瞎一次。
        const raw = detail?.output?.tk_filter_report;
        const report = Array.isArray(raw) ? raw[0] : raw;
        if (!report || typeof report !== "object") return;    // 不是本节点的执行结果
        this.reportData = report;
        this.renderFilterReport(report);
      };
      api.addEventListener("executed", this.reportListener);
    }

    /** 点底栏里的类别名 = 切换该类别开关，然后就地重算报告。 */
    toggleCategoryFromReport(category) {
      const widget = this.widgetFor(category);
      if (!widget) return;
      this.setWidgetValue(category, !Boolean(widget.value));
      this.node.graph?.change();
      this.updateCount();
      if (this.reportData) {
        this.rescaleReport(this.reportData);
      }
    }

    /**
     * 切换开关后**就地重算**已有报告（不重跑工作流）：
     * 只搬动"类别开关"这一层的词（保留 ↔ 类别关闭），黑名单/正则/未归类与开关无关。
     */
    rescaleReport(report) {
      const kept = report.kept || (report.kept = {});
      const dropped = report.dropped_by_category || (report.dropped_by_category = {});
      for (const category of CATEGORY_NAMES) {
        const open = Boolean(this.widgetFor(category)?.value);
        if (open && dropped[category]?.length) {
          kept[category] = (kept[category] || []).concat(dropped[category]);
          delete dropped[category];
        } else if (!open && kept[category]?.length) {
          dropped[category] = (dropped[category] || []).concat(kept[category]);
          delete kept[category];
        }
      }
      const sum = (object) => Object.values(object || {})
        .reduce((total, list) => total + (list?.length || 0), 0);
      report.counts = {
        kept: sum(kept),
        dropped: sum(dropped) + (report.dropped_by_blacklist?.length || 0)
          + (report.dropped_by_regex?.length || 0),
        unclassified: report.unclassified?.length || 0,
      };
      this.renderFilterReport(report);
    }

    renderFilterReport(report) {
      if (!this.reportBody) return;
      this.reportBody.textContent = "";
      const section = (text, className) => {
        const bar = document.createElement("div");
        bar.className = `tk-dtb-report-section ${className || ""}`.trim();
        bar.textContent = text;
        return bar;
      };
      const makeRow = (label, tags, className, toggleTarget) => {
        if (!Array.isArray(tags) || !tags.length) return null;
        const row = document.createElement("div");
        row.className = `tk-dtb-report-row ${className || ""}`.trim();
        const name = document.createElement("span");
        name.className = "tk-dtb-report-cat";
        name.textContent = label;
        if (toggleTarget) {
          name.title = `点击开/关「${toggleTarget}」这一类`;
          name.addEventListener("click", (event) => {
            event.stopPropagation();
            this.toggleCategoryFromReport(toggleTarget);
          });
        }
        const words = document.createElement("span");
        words.className = "tk-dtb-report-words";
        words.textContent = tags.join(", ");
        row.append(name, words);
        return row;
      };

      if (report.auto_classify === false) {
        const warn = document.createElement("div");
        warn.className = "tk-dtb-report-warn";
        warn.textContent = "⚠️ 未启用自动分类：旧 12 类全关时整段原样输出，不会过滤任何词。至少要留一个旧类开着。";
        this.reportBody.append(warn);
      }

      const keptEntries = Object.entries(report.kept || {}).filter(([, v]) => v?.length);
      if (keptEntries.length) {
        this.reportBody.append(section(`✅ 保留 ${report.counts?.kept ?? ""}`, "is-kept"));
        for (const [category, tags] of keptEntries) {
          const row = makeRow(category, tags, "is-kept", category);
          if (row) this.reportBody.append(row);
        }
      }

      const droppedEntries = Object.entries(report.dropped_by_category || {})
        .filter(([, v]) => v?.length);
      const otherDropped = (report.dropped_by_blacklist?.length || 0)
        || (report.dropped_by_regex?.length || 0);
      if (droppedEntries.length || otherDropped) {
        this.reportBody.append(section(`❌ 被排除 ${report.counts?.dropped ?? ""}`, "is-dropped"));
        for (const [category, tags] of droppedEntries) {
          const row = makeRow(`${category}（类别关闭）`, tags, "is-dropped", category);
          if (row) this.reportBody.append(row);
        }
        const black = makeRow("tag_blacklist 命中", report.dropped_by_blacklist, "is-dropped");
        if (black) this.reportBody.append(black);
        const regex = makeRow("regex_blacklist 命中", report.dropped_by_regex, "is-dropped");
        if (regex) this.reportBody.append(regex);
      }

      if (report.unclassified?.length) {
        this.reportBody.append(section(`⚠️ 未归类 ${report.counts?.unclassified ?? ""}`, "is-unknown"));
        const row = makeRow("原样进自然语言", report.unclassified, "is-unknown");
        if (row) this.reportBody.append(row);
      }

      if (!this.reportBody.childNodes.length) {
        const empty = document.createElement("div");
        empty.className = "tk-dtb-report-empty";
        empty.textContent = "本次执行没有被过滤或未归类的词。";
        this.reportBody.append(empty);
      }
    }

    load() {
      // 旧工作流没有「扩展分类」这些控件，ComfyUI 会用空字符串补足缺失的
      // widgets_values。对 BOOLEAN 来说 "" 会退化成 false，让"新增分类默认开启"
      // 的设计失效（角色名/版权词会静默消失）—— 这里把空值显式修正回**该分类的默认值**。
      // 例外：审查遮挡词 / 文字水印词默认关闭（负面词类），空值补 false。
      const defaultOff = new Set(DEFAULT_OFF_CATEGORIES);
      CATEGORY_NAMES.slice(LEGACY_CATEGORY_COUNT).forEach((category) => {
        const widget = this.widgetFor(category);
        if (widget && (widget.value === "" || widget.value === null || widget.value === undefined)) {
          const next = !defaultOff.has(category);
          widget.value = next;
          if (typeof widget.callback === "function") widget.callback(next);
        }
      });
      // 新增的权重是 FLOAT，而 float("") 校验必然失败 —— 这正是节点报
      // "部分输入值不适用于该节点" 的第二个来源（第一个是 COMBO 的空值）。
      // 空值/非数值一律补回中性 1.0。
      CATEGORY_NAMES.slice(LEGACY_CATEGORY_COUNT).forEach((category) => {
        const widget = this.weightWidgetFor(category);
        if (!widget) return;
        const numeric = Number(widget.value);
        if (widget.value === "" || widget.value === null || widget.value === undefined
            || !Number.isFinite(numeric)) {
          widget.value = 1.0;
          if (typeof widget.callback === "function") widget.callback(1.0);
        }
      });
      for (const category of CATEGORY_NAMES) {
        const control = this.controls.get(category);
        const widget = this.widgetFor(category);
        if (!control || !widget) continue;
        control.toggle.checked = Boolean(widget.value);
        control.row.classList.toggle("is-selected", Boolean(widget.value));
        const weightWidget = this.weightWidgetFor(category);
        const weightControl = this.weightControls.get(category);
        if (weightWidget && weightControl) {
          const normalisedWeight = this.normaliseWeightWidget(category);
          weightControl.value = this.formatWeight(normalisedWeight);
        }
      }
      for (const name of ["regex_blacklist", "tag_blacklist"]) {
        const widget = this.widgetFor(name);
        const field = this.filterControls.get(name);
        if (widget && field && field.value !== String(widget.value || "")) field.value = String(widget.value || "");
      }
      // 预设下拉（工作流加载后必须反映已保存的状态）
      const presetWidget = this.widgetFor("preset");
      if (presetWidget && this.presetSelect) {
        this.appendPresetOption(String(presetWidget.value || ""));
        this.presetSelect.value = String(presetWidget.value || PRESET_NONE);
      }
      this.updatePresetHint(String(presetWidget?.value || PRESET_NONE));
      this.updateCount();
      // ★ 载入收尾再对账一次（幂等）。`refreshPresetOptions()` 是**唯一**触发对账的地方，
      // 而它只被 build() 调用 —— 于是两类路径会漏掉对账：
      //   ① 只走 configure 不重新 build（复制粘贴节点 / 部分加载）；
      //   ② 那次 fetch 失败被 catch 吞掉时（此时 customPresets 为空、对账无从判断）。
      // 在 load() 末尾补一次，配合下面 catch 里的 warn，把这两条静默失效路径堵掉。
      this.reconcilePresetWithSwitches();
    }
  }

  // ── 历史脏值修复（2026-09-16 真机复现）────────────────────────────────────
  //
  // 症状：场景预设选了之后，**刷新页面（F5）或重新打开工作流就变回「自定义（不用预设）」**，
  //       每次都得手动重选；同时「质量元词」等扩展分类会莫名被勾上。
  //
  // 根因（真机 + 浏览器实测确认，两条缺陷叠加）：
  //   ① `addDOMWidget(..., { serialize: false })` 把开关写进了 widget.options，
  //      而 ComfyUI 的 `LGraphNode.serialize()` 判断的是 **`widget.serialize === false`**
  //      ⇒ DOM widget 照样被序列化，每次 Ctrl+S 都让本节点的 widgets_values
  //      比原生控件多出一项（实测：48 个原生控件 → 存成 49 项）。
  //   ② `ComfyNode.configure()` 在 super.configure 之前会调用前端的 `migrateWidgetsValues()`：
  //        i = [name 命中控件表的 input] + [forceInput 的 input]   // 本节点 = 48 + 1 = 49
  //        if (i.length === widgets_values.length) 剔除 forceInput 所在位
  //      它本是用来兼容「旧工作流里 forceInput 也占了一个值」的格式，
  //      而多出的第 49 项恰好让长度相等 ⇒ 前端误判 ⇒ 按 natural_language 的位置剔掉一位
  //      ⇒ **整份 widgets_values 左移一位**。
  //      后果：preset 读到的是下一格（空字符串）→ 显示「自定义（不用预设）」；
  //      而真正的预设名落进 `物件道具词_weight`（FLOAT），随后被权重归一化清洗成 1.0 —— 静默丢失。
  //
  // 修法：① 在 widget 自身上设 `serialize = false`（见 onNodeCreated）；
  //      ② 加载时先把多出的尾巴裁掉，让长度回到「原生控件数」，前端便不再误判。
  //      两条都要有：① 管新保存的工作流，② 管用户机器上已经存坏的那些。
  const DOM_WIDGET_NAME = "tk_danbooru_tag_getter";

  /**
   * 裁掉历史工作流里 DOM widget 多写的那一项（只裁「长度恰好多 1」的情形）。
   *
   * 长度不足（更旧的工作流，控件更少）不在这里处理 —— 交给 ComfyUI 自己补默认值。
   * 用 DOM widget 的**名字**定位而不是写死数字，这样将来再多加控件也不会误裁。
   */
  function trimLegacyDomWidgetValue(node, info) {
    const values = info?.widgets_values;
    if (!Array.isArray(values)) return info;
    const widgets = node?.widgets ?? [];
    if (!widgets.some((widget) => widget.name === DOM_WIDGET_NAME)) return info;
    const nativeCount = widgets.length - 1; // 除 DOM widget 之外的原生控件数
    if (values.length === nativeCount + 1) {
      return { ...info, widgets_values: values.slice(0, nativeCount) };
    }
    return info;
  }

  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);
    api.registerExtension({
      name: "TK.DanbooruTagGetter.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalConfigure = nodeType.prototype.onConfigure;
        // ⚠️ 必须包在 ComfyUI 自己的 configure **外层**：它内部会先跑前端的
        // widgets_values 迁移（migrateWidgetsValues），错位就是那一步造成的，
        // 等 onConfigure 再补救已经晚了（原值已被权重归一化清洗掉）。
        const originalConfigureRaw = nodeType.prototype.configure;
        if (typeof originalConfigureRaw === "function") {
          nodeType.prototype.configure = function (info) {
            return originalConfigureRaw.apply(this, [trimLegacyDomWidgetValue(this, info)]);
          };
        }
        nodeType.prototype.onNodeCreated = function () {
          const result = originalCreated?.apply(this, arguments);
          if (this._tkDanbooruTagGetterUI) return result;
          const ui = new DanbooruTagGetterUI(this);
          this._tkDanbooruTagGetterUI = ui;
          const unifiedInput = this.inputs?.find((input) => input.name === "natural_language");
          if (unifiedInput) {
            unifiedInput.label = "统一 Prompt";
            unifiedInput.tooltip = "普通 Prompt 或 Packer ALL_TAGS；已知 Danbooru Tag 自动分类，未知段落原样保留";
          }
          const legacyInput = this.inputs?.find((input) => input.name === "tag_bundle");
          if (legacyInput) legacyInput.label = "兼容·分类包";
          const element = ui.build();
          const domWidget = this.addDOMWidget?.("tk_danbooru_tag_getter", "custom", element, { serialize: false, hideOnZoom: false });
          if (domWidget) {
            // ⚠️ 这一行是「预设刷新后丢失」的根因修复：必须设在 widget **自身** 上。
            // ComfyUI 的 LGraphNode.serialize() 判断的是 `widget.serialize === false`，
            // 只传进 options（`{ serialize: false }`）不会阻止序列化 ——
            // DOM widget 的值会被塞进 widgets_values 末尾，让数组长度恰好撞上
            // 前端 migrateWidgetsValues 的误判条件，导致整份值左移一位。
            // 详见文件末尾 trimLegacyDomWidgetValue() 的注释。
            domWidget.serialize = false;
            // 20 个分类（两列 10 行）+ 预设行 + 主题 chips（折叠后约 4 行）+ 排除区
            // （自然语言区块已移除，高度比原来少约 60px）
            domWidget.computeSize = () => [0, 500];
            this.setSize?.([Math.max(340, this.size?.[0] || 340), 560]);
          }
          return result;
        };
        nodeType.prototype.onConfigure = function () {
          const result = originalConfigure?.apply(this, arguments);
          this._tkDanbooruTagGetterUI?.load();
          return result;
        };
      },
    });
  }

  init();
})();
