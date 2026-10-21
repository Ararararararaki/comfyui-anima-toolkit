import { uiText } from "./anima_node_i18n.js";
// Selection toolbar only: workflow output, ordering and queue execution stay with the gallery.
export class GallerySelectionControls {
  constructor({ onSelectAll, onClear, onQueue, categoryAction }) {
    this.multiple = false;
    this.selectedCount = 0;
    this.element = document.createElement("div");
    this.element.className = "adg-selection-bar";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", uiText("图片选择操作", "Image selection actions"));
    this.element.title = uiText("图片的预览、下载和分类操作在卡片悬浮工具条", "Preview, download and category actions appear when hovering over a card");
    this.modeButton = this.createButton(uiText("多选", "Multi-select"), uiText("开启后，直接点击图片即可连续多选", "When enabled, click images to select multiple items"), () => {
      this.multiple = !this.multiple;
      this.renderMode();
    });
    this.modeButton.className = "adg-selection-mode";
    this.summary = document.createElement("span");
    this.summary.className = "adg-selection-summary";
    this.summary.setAttribute("aria-live", "polite");
    this.actions = document.createElement("div");
    this.actions.className = "adg-selection-actions";
    this.selectAllButton = this.createButton(uiText("全选已加载", "Select loaded"), uiText("选择当前已加载的图片；不自动加载其他页", "Select loaded images without loading more pages"), onSelectAll);
    this.clearButton = this.createButton(uiText("清除", "Clear"), uiText("清除当前图片选择", "Clear the image selection"), onClear);
    this.queueButton = this.createButton(uiText("批量入队", "Queue batch"), uiText("按点击顺序逐张执行选中的图片", "Run selected images in selection order"), onQueue);
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
    this.queueButton.title = queueTitle || uiText("按点击顺序逐张执行选中的图片", "Run selected images in selection order");
    this.queueButton.textContent = uiText(`批量入队 ${selectedCount}`, `Queue ${selectedCount}`);
    this.renderMode();
  }

  renderMode() {
    const count = this.selectedCount;
    this.modeButton.setAttribute("aria-pressed", String(this.multiple));
    this.modeButton.textContent = this.multiple ? uiText("多选中", "Multi-select on") : uiText("多选", "Multi-select");
    this.element.classList.toggle("is-multiple", this.multiple);
    this.summary.textContent = count ? uiText(`已选 ${count} 张`, `${count} selected`) : this.multiple ? uiText("点击图片连续选择", "Click images to select multiple items") : uiText("点图选择 · Ctrl / Shift 多选", "Click to select · Ctrl / Shift for multiple");
    this.actions.hidden = !this.multiple && count === 0;
    this.selectAllButton.hidden = !this.multiple;
    this.clearButton.hidden = count === 0;
    this.categoryAction.hidden = count < 2;
    this.queueButton.hidden = count < 2;
  }
}
