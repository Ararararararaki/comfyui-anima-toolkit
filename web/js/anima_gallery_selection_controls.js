// Selection toolbar only: workflow output, ordering and queue execution stay with the gallery.
export class GallerySelectionControls {
  constructor({ onSelectAll, onClear, onQueue, categoryAction }) {
    this.multiple = false;
    this.selectedCount = 0;
    this.element = document.createElement("div");
    this.element.className = "adg-selection-bar";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "图片选择操作");
    this.element.title = "图片的预览、下载和分类操作在卡片悬浮工具条";
    this.modeButton = this.createButton("多选", "开启后，直接点击图片即可连续多选", () => {
      this.multiple = !this.multiple;
      this.renderMode();
    });
    this.modeButton.className = "adg-selection-mode";
    this.summary = document.createElement("span");
    this.summary.className = "adg-selection-summary";
    this.summary.setAttribute("aria-live", "polite");
    this.actions = document.createElement("div");
    this.actions.className = "adg-selection-actions";
    this.selectAllButton = this.createButton("全选已加载", "选择当前已加载的图片；不自动加载其他页", onSelectAll);
    this.clearButton = this.createButton("清除", "清除当前图片选择", onClear);
    this.queueButton = this.createButton("批量入队", "按点击顺序逐张执行选中的图片", onQueue);
    this.queueButton.className = "adg-selection-queue";
    this.categoryAction = categoryAction;
    this.actions.append(this.selectAllButton, this.clearButton, categoryAction, this.queueButton);
    this.element.append(this.modeButton, this.summary, this.actions);
    this.update({ selectedCount: 0, loadedCount: 0, queueDisabled: true });
  }

  createButton(label, title, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => { event.stopPropagation(); action(); });
    return button;
  }

  update({ selectedCount, loadedCount, queueDisabled, queueTitle }) {
    this.selectedCount = selectedCount;
    this.selectAllButton.disabled = loadedCount === 0;
    this.queueButton.disabled = queueDisabled;
    this.queueButton.title = queueTitle || "按点击顺序逐张执行选中的图片";
    this.queueButton.textContent = `批量入队 ${selectedCount}`;
    this.renderMode();
  }

  renderMode() {
    const count = this.selectedCount;
    this.modeButton.setAttribute("aria-pressed", String(this.multiple));
    this.modeButton.textContent = this.multiple ? "多选中" : "多选";
    this.element.classList.toggle("is-multiple", this.multiple);
    this.summary.textContent = count ? `已选 ${count} 张` : this.multiple ? "点击图片连续选择" : "点图选择 · Ctrl / Shift 多选";
    this.actions.hidden = !this.multiple && count === 0;
    this.selectAllButton.hidden = !this.multiple;
    this.clearButton.hidden = count === 0;
    this.categoryAction.hidden = count < 2;
    this.queueButton.hidden = count < 2;
  }
}
