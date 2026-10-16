import { installDOMWidgetSizeSync } from "./anima_dom_widget_size_sync.js";

const NODE_NAME = "TkPromptAgent";
const SESSION_OWNERS = new Map();
const API_ROOT = "/anima/prompt-agent";
const MODES = [["create", "创作"], ["modify", "修改"], ["expand", "扩写"], ["rewrite", "重写"], ["convert", "转换"], ["optimize", "优化"]];
const INPUT_NAMES = ["profile", "mode", "current_prompt", "user_instruction", "execution", "session_id", "preset", "custom_instructions", "locked_sections", "edit_scope", "approved_prompt", "agent_response", "approved_profile", "interrogation_source", "interrogation_image", "interrogation_action", "interrogation_options", "generation_strategy"];
const GENERATION_STRATEGIES = [["direct", "快速直写"], ["guided", "按流程创作"], ["native", "DSH 原生"]];
const CONNECTION_FIELDS = ["base_url", "model", "api_key", "api_key_env", "clear_api_key"];
const IMAGE_SOURCES = [["local-wd14", "本地 WD14"], ["pixai-online", "PixAI 在线"], ["toriigate-online", "ToriiGate 在线"], ["workbuddy-vision", "WorkBuddy 看图"]];

function element(tag, className = "", text = "") {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

export function parseSectionIds(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value;
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id) => typeof id === "string"))] : [];
  } catch { return []; }
}

export function parseImageDescriptor(value) {
  try {
    const item = typeof value === "string" ? JSON.parse(value || "null") : value;
    if (!item || typeof item.filename !== "string" || !item.filename) return null;
    return { filename: item.filename, subfolder: typeof item.subfolder === "string" ? item.subfolder : "", type: ["input", "temp", "output"].includes(item.type) ? item.type : "input" };
  } catch { return null; }
}

function sessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `tkpa-${Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function injectStylesheet() {
  if (document.getElementById("tk-prompt-agent-style")) return;
  const link = element("link");
  link.id = "tk-prompt-agent-style";
  link.rel = "stylesheet";
  link.href = new URL("../css/anima_prompt_agent.css?v=20261010-2", import.meta.url).href;
  document.head.appendChild(link);
}

function option(value, label) {
  const item = element("option", "", label);
  item.value = value;
  return item;
}

function field(label, control, className = "") {
  const wrap = element("label", `tk-pa-field ${className}`.trim());
  wrap.append(element("span", "tk-pa-label", label), control);
  return wrap;
}

function detail(title) {
  const item = element("details", "tk-pa-details");
  item.append(element("summary", "", title));
  return item;
}

function normalizeExecutionValue(value) {
  return value === "execute" ? "execute" : "snapshot";
}

function normalizeGenerationStrategy(value) {
  // Newly created nodes receive direct from INPUT_TYPES. Missing values from
  // old workflows retain their existing guided behavior.
  return ["direct", "native"].includes(value) ? value : "guided";
}

export class PromptAgentUI {
  constructor(node) {
    this.node = node;
    this.dom = {};
    this.revision = 0;
    this.history = [];
    this.meta = { profiles: [], presets: [], sections: [], config: {} };
    this.disposed = false;
    this.busy = false;
    this.requestVersion = 0;
    this.controllers = new Set();
    this.nativeMeta = null;
    this.nativeMetaVersion = 0;
    this.nativeSettingsDirty = false;
    this.nativeOperation = null;
    this.activeTab = node.properties?.tkPromptAgentTab === "interrogate" ? "interrogate" : "create";
    this.interrogationResult = null;
    this.claimSession();
    this.progressAPI = globalThis.comfyAPI?.api?.api || globalThis.window?.comfyAPI?.api?.api || globalThis.window?.api;
    this.interrogationProgressListener = (event) => {
      const progress = event.detail;
      if (this.disposed || progress?.session_id !== this.session) return;
      if (progress.result && typeof progress.result === "object") {
        this.interrogationResult = progress.result;
        this.renderInterrogationResult();
      }
      const labels = { preparing: "正在读取图片…", uploading: "正在上传图片到反推服务…", queued: "远端正在排队…", processing: "正在反推图片…", expanding: "正在结合原图与反推结果扩写…", completed: "反推完成。", cancelled: "反推已中断，保留原来的 Final Prompt。" };
      let message = labels[progress.stage];
      if (progress.stage === "queued" && Number.isFinite(progress.rank)) message += ` 前方 ${Math.max(0, progress.rank)} 个任务。`;
      if (progress.stage === "queued" && Number.isFinite(progress.rank_eta)) message += ` 预计 ${Math.ceil(progress.rank_eta)} 秒。`;
      if (progress.stage === "failed") message = `反推失败：${progress.message}`;
      if (progress.stage === "expansion_failed") message = `看图扩写失败：${progress.message}。已保留原始反推结果和原来的 Final Prompt。`;
      if (message) this.status(message, ["failed", "expansion_failed"].includes(progress.stage));
    };
    this.progressAPI?.addEventListener?.("tk_prompt_agent_interrogation", this.interrogationProgressListener);
  }

  widget(name) { return this.node.widgets?.find((item) => item?.name === name); }
  value(name, fallback = "") { return this.widget(name)?.value ?? fallback; }

  write(name, value) {
    const widget = this.widget(name);
    if (!widget) return;
    widget.value = value;
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  claimSession() {
    let id = String(this.value("session_id") || "").trim();
    const owner = SESSION_OWNERS.get(id);
    if (!id || (owner && owner !== this && !owner.disposed)) id = sessionId();
    if (this.session && this.session !== id) {
      this.invalidate();
      this.revision = 0;
      this.history = [];
    }
    if (this.session && this.session !== id && SESSION_OWNERS.get(this.session) === this) SESSION_OWNERS.delete(this.session);
    this.session = id;
    SESSION_OWNERS.set(id, this);
    this.write("session_id", id);
    return id;
  }

  prepareWidgets() {
    for (const name of INPUT_NAMES) {
      const widget = this.widget(name);
      if (!widget) continue;
      widget._tkPromptAgentHidden = true;
      widget.hidden = true;
      widget.options = widget.options || {};
      widget.options.hidden = true;
      widget.computeSize = () => [0, -4];
      widget.draw = () => {};
      // Keep the STRING type of the two connectable editors so ComfyUI can
      // still expose its native Convert Widget to Input action.
      if (name !== "current_prompt" && name !== "user_instruction") widget.type = "hidden";
      if (widget.element?.style) widget.element.style.display = "none";
      if (widget.inputEl?.style) widget.inputEl.style.display = "none";
      widget.serialize = true;
    }
    if (!this.value("profile")) this.write("profile", "anima");
    if (!this.value("mode")) this.write("mode", String(this.value("current_prompt")).trim() ? "modify" : "create");
    this.write("execution", normalizeExecutionValue(this.value("execution")));
    if (!this.value("interrogation_source")) this.write("interrogation_source", "local-wd14");
    if (!["none", "replace", "append"].includes(this.value("interrogation_action"))) this.write("interrogation_action", "none");
    if (!this.value("interrogation_options")) this.write("interrogation_options", "{}");
    this.write("generation_strategy", normalizeGenerationStrategy(this.value("generation_strategy")));
  }

  button(label, action, className = "") {
    const item = element("button", `tk-pa-button ${className}`.trim(), label);
    item.type = "button";
    item.addEventListener("click", action);
    return item;
  }

  select(name, choices, label) {
    const select = element("select", "tk-pa-input");
    select.setAttribute("aria-label", label);
    for (const [value, text] of choices) select.append(option(value, text));
    select.addEventListener("change", () => { this.write(name, select.value); this.invalidate(); });
    this.dom[name] = select;
    return select;
  }

  textarea(name, placeholder, rows = 3, readOnly = false) {
    const area = element("textarea", "tk-pa-input tk-pa-textarea");
    area.rows = rows;
    area.placeholder = placeholder;
    area.readOnly = readOnly;
    area.spellcheck = false;
    if (!readOnly) area.addEventListener("input", () => { this.write(name, area.value); this.invalidate(); });
    this.dom[name] = area;
    return area;
  }

  buildGenerationStrategies() {
    const group = element("div", "tk-pa-strategies");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "创作方式");
    this.dom.generationStrategies = {};
    for (const [id, label] of GENERATION_STRATEGIES) {
      const choose = () => {
        if (normalizeGenerationStrategy(this.value("generation_strategy")) === id) return;
        this.write("generation_strategy", id);
        this.invalidate();
        this.renderWorkflow();
        if (id === "native") void this.refreshNativeMeta();
      };
      const button = this.button(label, choose, "tk-pa-strategy");
      button.dataset.nativeStrategy = "true";
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const ids = GENERATION_STRATEGIES.map(([value]) => value);
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const target = event.key === "Home" ? ids[0] : event.key === "End" ? ids.at(-1)
          : ids[(ids.indexOf(id) + direction + ids.length) % ids.length];
        this.dom.generationStrategies[target].click();
        this.dom.generationStrategies[target].focus?.();
      });
      this.dom.generationStrategies[id] = button;
      group.append(button);
    }
    // A label wrapping buttons would give the first button the whole
    // group's accessible name. The group already has its own aria-label.
    const wrap = element("div", "tk-pa-field");
    wrap.append(element("span", "tk-pa-label", "创作方式"), group);
    return wrap;
  }

  build() {
    injectStylesheet();
    this.prepareWidgets();
    const root = element("div", "tk-pa-panel");
    this.root = root;
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "keyup", "contextmenu"]) {
      root.addEventListener(type, (event) => event.stopPropagation(), type === "wheel" ? { passive: true } : undefined);
    }
    const toolbar = element("div", "tk-pa-toolbar");
    toolbar.append(
      field("模型 Profile", this.select("profile", [], "模型 Profile")),
      field("操作", this.select("mode", MODES, "操作")),
      field("创作预设", this.select("preset", [["", "默认"]], "创作预设")),
    );
    this.dom.presetHint = element("div", "tk-pa-note tk-pa-preset-hint");
    this.dom.preset.addEventListener("change", () => this.updatePresetHint());
    this.dom.profile.addEventListener("change", () => {
      if (String(this.value("current_prompt")).trim()) {
        this.write("mode", "convert");
        this.dom.mode.value = "convert";
        this.status("已切换模型 Profile，请发送转换指令后使用新的 Final Prompt。");
      }
      this.interrogationResult = null;
      this.renderInterrogationResult();
      this.updateProfileHint();
      this.renderWorkflow();
    });
    const tabs = element("div", "tk-pa-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Prompt Agent 模式");
    this.dom.tabs = {};
    for (const [id, label] of [["create", "创作"], ["interrogate", "看图反推"]]) {
      const tab = this.button(label, () => this.setTab(id), "tk-pa-tab");
      tab.setAttribute("role", "tab");
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const target = event.key === "Home" ? "create" : event.key === "End" ? "interrogate" : id === "create" ? "interrogate" : "create";
        this.setTab(target);
        this.dom.tabs[target]?.focus?.();
      });
      this.dom.tabs[id] = tab;
      tabs.append(tab);
    }
    const creative = element("section", "tk-pa-tab-content");
    creative.setAttribute("role", "tabpanel");
    this.dom.creative = creative;
    const prompt = this.textarea("current_prompt", "粘贴已有 Prompt，或留空从一个想法开始", 4);
    const instruction = this.textarea("user_instruction", "例如：保留角色与服装，把背景改成雨夜车站", 3);
    instruction.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); this.edit(); }
    });
    this.dom.connectionHint = element("div", "tk-pa-note");
    this.dom.profileHint = element("div", "tk-pa-note");
    this.dom.workflowHint = element("div", "tk-pa-note tk-pa-strategy-hint");
    const actions = element("div", "tk-pa-actions");
    this.dom.send = this.button("发送编辑", () => this.edit(), "tk-pa-primary");
    this.dom.send.title = "Ctrl / Cmd + Enter";
    this.dom.undo = this.button("撤销", () => this.sessionAction("undo"));
    this.dom.retry = this.button("重试", () => this.sessionAction("retry"));
    this.dom.clear = this.button("清空会话", () => this.sessionAction("clear"));
    actions.append(this.dom.send, this.dom.undo, this.dom.retry, this.dom.clear);
    this.dom.status = element("div", "tk-pa-status", "正在加载配置…");
    this.dom.status.setAttribute("role", "status");
    this.dom.status.setAttribute("aria-live", "polite");
    const response = element("section", "tk-pa-output");
    const responseHeader = element("div", "tk-pa-output-header");
    responseHeader.append(element("span", "tk-pa-label", "Agent Response"));
    this.dom.historyCount = element("span", "tk-pa-note");
    responseHeader.append(this.dom.historyCount);
    this.dom.agent_response = element("div", "tk-pa-response");
    this.dom.agent_response.setAttribute("aria-label", "Agent Response");
    response.append(responseHeader, this.dom.agent_response);
    this.dom.workflow = detail("本轮创作流程");
    this.dom.workflow.className = "tk-pa-details tk-pa-workflow";
    this.dom.workflow.open = true;
    this.dom.workflow.hidden = true;
    this.dom.workflowSteps = element("ol", "tk-pa-workflow-steps");
    this.dom.workflowSteps.setAttribute("aria-label", "创作步骤结果");
    this.dom.workflow.append(this.dom.workflowSteps);
    response.append(this.dom.workflow);
    const history = detail("编辑记录");
    history.className = "tk-pa-details tk-pa-history";
    this.dom.historyList = element("div", "tk-pa-history-list");
    history.append(this.dom.historyList);
    response.append(history);
    const final = element("section", "tk-pa-output");
    const finalHeader = element("div", "tk-pa-output-header");
    this.dom.copy = this.button("复制", () => this.copyPrompt(), "tk-pa-copy");
    this.dom.copy.dataset.keepEnabled = "true";
    finalHeader.append(element("span", "tk-pa-label", "Final Prompt"), this.dom.copy);
    final.append(finalHeader, this.textarea("approved_prompt", "编辑成功后的 Prompt 会显示在这里", 4, true));
    const execution = element("div", "tk-pa-execution");
    execution.append(field("文字编辑行为", this.select("execution", [["snapshot", "只输出已确认 Prompt"], ["execute", "运行时执行文字指令"]], "文字编辑行为")));
    this.dom.executionHint = element("div", "tk-pa-note");
    this.dom.execution.addEventListener("change", () => this.updateExecutionHint());
    execution.append(this.dom.executionHint);
    const advanced = detail("高级设置");
    advanced.append(field("本次附加指令", this.textarea("custom_instructions", "补充画面、风格或写法要求", 2)));
    this.dom.locks = element("div", "tk-pa-chips");
    this.dom.scope = element("div", "tk-pa-chips");
    advanced.append(field("锁定部分", this.dom.locks), field("仅编辑这些部分 · 留空按指令修改，不设默认锁定", this.dom.scope), this.buildReferences(), this.buildPresetEditor(), this.buildInterrogationConfig(), this.buildConfig());
    creative.append(this.buildGenerationStrategies(), this.buildNativeSettings(), field("当前 Prompt", prompt),
      element("div", "tk-pa-note", "当前 Prompt 留空时按本次指令创作新稿；明确锁定仍保留。"),
      this.dom.connectionHint, field("你的指令", instruction), this.dom.workflowHint, actions, this.buildNativeProgress(), response);
    this.dom.mode.addEventListener("change", () => this.renderWorkflow());
    root.append(toolbar, this.dom.presetHint, this.dom.profileHint, tabs, creative, this.buildInterrogation(), this.dom.status, final, execution, advanced);
    this.restoreEditors();
    this.setTab(this.activeTab);
    this.refreshConnections();
    this.updateExecutionHint();
    this.refreshMeta();
    return root;
  }

  setTab(id) {
    this.activeTab = id === "interrogate" ? "interrogate" : "create";
    this.node.properties = { ...(this.node.properties || {}), tkPromptAgentTab: this.activeTab };
    for (const [name, tab] of Object.entries(this.dom.tabs || {})) {
      const selected = name === this.activeTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle("is-selected", selected);
    }
    if (this.dom.creative) this.dom.creative.hidden = this.activeTab !== "create";
    if (this.dom.interrogate) this.dom.interrogate.hidden = this.activeTab !== "interrogate";
    const fields = [this.dom.mode?.parentElement, this.dom.preset?.parentElement, this.dom.presetHint];
    for (const item of fields) if (item) item.hidden = this.activeTab !== "create";
    this.sizeSync?.request?.();
  }

  buildInterrogation() {
    const pane = element("section", "tk-pa-tab-content");
    pane.setAttribute("role", "tabpanel");
    this.dom.interrogate = pane;
    const drop = element("div", "tk-pa-image-drop");
    drop.tabIndex = 0;
    drop.setAttribute("aria-label", "拖入或粘贴参考图片");
    this.dom.imageDrop = drop;
    this.dom.imagePreview = element("img", "tk-pa-image-preview");
    this.dom.imagePreview.alt = "反推参考图片";
    this.dom.imageName = element("div", "tk-pa-note");
    this.dom.imageFile = element("input");
    this.dom.imageFile.type = "file";
    this.dom.imageFile.accept = "image/*";
    this.dom.imageFile.hidden = true;
    this.dom.imageFile.addEventListener("change", () => {
      const file = this.dom.imageFile.files?.[0];
      if (file) this.uploadImage(file);
      this.dom.imageFile.value = "";
    });
    const imageActions = element("div", "tk-pa-actions");
    this.dom.chooseImage = this.button("选择图片", () => this.dom.imageFile.click());
    this.dom.clearImage = this.button("移除图片", () => {
      this.write("interrogation_image", "");
      this.invalidate();
      this.interrogationResult = null;
      this.renderImage();
      this.renderInterrogationResult();
    });
    imageActions.append(this.dom.chooseImage, this.dom.clearImage);
    drop.append(this.dom.imagePreview, element("div", "tk-pa-note", "拖入图片，或点击此区域后粘贴图片"), this.dom.imageName, imageActions, this.dom.imageFile);
    drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.toggle("is-dragover", true); });
    drop.addEventListener("dragleave", () => drop.classList.toggle("is-dragover", false));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.toggle("is-dragover", false);
      const file = Array.from(event.dataTransfer?.files || []).find((item) => item.type?.startsWith("image/"));
      if (file) this.uploadImage(file);
    });
    drop.addEventListener("paste", (event) => {
      const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.kind === "file" && entry.type?.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) { event.preventDefault(); this.uploadImage(file); }
    });
    this.dom.imageConnectionHint = element("div", "tk-pa-note");
    const source = this.select("interrogation_source", IMAGE_SOURCES, "反推来源");
    source.addEventListener("change", () => {
      this.interrogationResult = null;
      this.renderInterrogationResult();
      this.updateSourceHint();
      this.restoreInterrogationOptions();
    });
    this.dom.sourceHint = element("div", "tk-pa-note");
    this.dom.interrogateButton = this.button("开始反推", () => this.interrogate(), "tk-pa-primary");
    const run = element("div", "tk-pa-actions");
    run.append(this.dom.interrogateButton);
    const raw = detail("原始反推结果");
    raw.open = true;
    this.dom.rawInterrogation = element("textarea", "tk-pa-input tk-pa-textarea");
    this.dom.rawInterrogation.readOnly = true;
    this.dom.rawInterrogation.rows = 3;
    this.dom.rawInterrogation.placeholder = "显示来源返回的标签或描述";
    raw.append(this.dom.rawInterrogation);
    const expansion = this.buildImageExpansion();
    this.dom.formattedInterrogation = element("textarea", "tk-pa-input tk-pa-textarea");
    this.dom.formattedInterrogation.readOnly = true;
    this.dom.formattedInterrogation.rows = 3;
    this.dom.formattedInterrogation.placeholder = "反推后按当前模型 Profile 整理";
    this.dom.interrogationMessage = element("div", "tk-pa-note");
    const accept = element("div", "tk-pa-actions");
    this.dom.replaceInterrogation = this.button("替换当前 Prompt", () => this.acceptInterrogation("replace"));
    this.dom.appendInterrogation = this.button("加入当前内容", () => this.acceptInterrogation("append"));
    accept.append(this.dom.replaceInterrogation, this.dom.appendInterrogation);
    const auto = this.select("interrogation_action", [["none", "继续执行文字指令"], ["replace", "反推并替换 Prompt"], ["append", "反推并加入当前内容"]], "节点运行方式");
    auto.addEventListener("change", () => this.updateExecutionHint());
    pane.append(drop, this.dom.imageConnectionHint, field("反推来源", source), this.dom.sourceHint,
      this.dom.interrogationConfig.wd14_model_field, this.dom.interrogationConfig.threshold_fieldset, run, raw, expansion,
      field("候选 Prompt · 确认后更新 Final Prompt", this.dom.formattedInterrogation), this.dom.interrogationMessage, accept,
      field("节点运行方式 · 选择反推后，排队会直接处理 IMAGE 并输出 Prompt", auto));
    return pane;
  }

  buildImageExpansion() {
    const wrap = element("div", "tk-pa-field");
    wrap.append(element("div", "tk-pa-note", "看图扩写同时读取最近反推的原图和标签；保留识别出的角色名、作品名及人物特征，K2 也会保留角色身份。图片发送给所选看图模型。"));
    this.dom.expansion = {};
    for (const [name, label, choices] of [
      ["expansion_mode", "扩写方式", [["faithful", "忠实描述 · 还原原图"], ["creative", "创作扩写 · 按指令调整"]]],
      ["vision_provider", "看图模型来源", [["current", "当前模型配置"], ["workbuddy", "WorkBuddy"], ["dsh-workbuddy", "DSH 实时 · WorkBuddy"], ["dsh-opencode", "DSH 实时 · OpenCode"]]],
    ]) {
      const control = element("select", "tk-pa-input");
      control.append(...choices.map(([id, title]) => option(id, title)));
      this.dom.expansion[name] = control;
      control.addEventListener("change", () => this.writeExpansionOption(name, control.value));
      wrap.append(field(label, control));
    }
    const instruction = element("textarea", "tk-pa-input tk-pa-textarea");
    instruction.rows = 2;
    instruction.placeholder = "可留空。例如：保留角色与动作，加强电影感。";
    this.dom.expansion.expansion_instruction = instruction;
    instruction.addEventListener("input", () => this.writeExpansionOption("expansion_instruction", instruction.value));
    wrap.append(field("扩写要求 · 可选", instruction));
    const identity = element("input");
    identity.type = "checkbox";
    this.dom.expansion.preserve_identity = identity;
    identity.addEventListener("change", () => this.writeExpansionOption("preserve_identity", identity.checked));
    wrap.append(field("保留角色名称与人物特征", identity));
    const auto = element("input");
    auto.type = "checkbox";
    this.dom.expansion.auto_expand = auto;
    auto.addEventListener("change", () => this.writeExpansionOption("auto_expand", auto.checked));
    wrap.append(field("反推后自动看图扩写（含 IMAGE 连线运行）", auto));
    const actions = element("div", "tk-pa-actions");
    this.dom.expandInterrogation = this.button("看图扩写", () => this.expandInterrogation(), "tk-pa-primary");
    actions.append(this.dom.expandInterrogation);
    wrap.append(actions);
    return wrap;
  }

  writeExpansionOption(name, value) {
    this.write("interrogation_options", JSON.stringify({ ...this.interrogationOptions(), [name]: value }));
    this.invalidate();
    // Changing expansion settings reuses the observation; it never reruns the tagger.
    this.updateActionState();
  }

  buildInterrogationConfig() {
    const wrap = detail("反推设置");
    this.dom.interrogationConfig = {};
    const thresholds = element("div", "tk-pa-thresholds");
    for (const [name, label, fallback] of [["threshold", "标签阈值", 0.35], ["character_threshold", "角色阈值", 0.85]]) {
      const control = element("input", "tk-pa-input");
      control.type = "number";
      control.min = "0"; control.max = "1"; control.step = "0.05";
      control.value = String(fallback);
      control.addEventListener("change", () => this.writeInterrogationOptions());
      this.dom.interrogationConfig[name] = control;
      thresholds.append(field(label, control));
    }
    this.dom.interrogationConfig.threshold_fieldset = thresholds;
    const model = element("select", "tk-pa-input");
    model.setAttribute("aria-label", "本地 WD14 模型");
    this.dom.interrogationConfig.wd14_model = model;
    this.dom.interrogationConfig.wd14_model_field = field("本地 WD14 模型", model);
    this.dom.interrogationConfig.wd14_model_field.hidden = true;
    model.addEventListener("change", () => this.writeInterrogationOptions());
    const caption = element("select", "tk-pa-input");
    caption.append(option("short", "简短描述"), option("min_structured_json", "结构化描述"));
    this.dom.interrogationConfig.caption_type = caption;
    caption.addEventListener("change", () => this.writeInterrogationOptions());
    const token = element("input", "tk-pa-input");
    token.type = "password"; token.autocomplete = "new-password";
    this.dom.interrogationConfig.hf_token = token;
    this.dom.hfTokenStatus = element("div", "tk-pa-note");
    const clear = element("input");
    clear.type = "checkbox";
    this.dom.interrogationConfig.clear_hf_token = clear;
    const clearLabel = element("label", "tk-pa-check", "清除本机保存的 HF Token");
    clearLabel.prepend(clear);
    const timeout = element("input", "tk-pa-input");
    timeout.type = "number"; timeout.min = "1"; timeout.max = "600"; timeout.step = "1";
    this.dom.interrogationConfig.timeout = timeout;
    this.dom.saveInterrogationConfig = this.button("保存在线反推设置", () => this.saveInterrogationConfig());
    wrap.append(field("描述形式", caption), field("在线反推等待上限（秒）", timeout), element("div", "tk-pa-note", "PixAI 免费 CPU 服务会排队，180 秒可能不够；可调高等待上限，最长 600 秒。"), field("HF Token · 可选，留空保留", token), this.dom.hfTokenStatus, clearLabel, this.dom.saveInterrogationConfig);
    return wrap;
  }

  buildPresetEditor() {
    const wrap = detail("编辑创作预设");
    const name = element("input", "tk-pa-input");
    name.type = "text";
    name.placeholder = "预设名称";
    const mode = element("select", "tk-pa-input");
    mode.append(option("append", "追加到基础创作指令"), option("replace", "替换基础创作指令"));
    const instructions = element("textarea", "tk-pa-input tk-pa-textarea");
    instructions.rows = 4;
    instructions.placeholder = "例如：强调自然光、真实材质，避免夸张修饰";
    const actions = element("div", "tk-pa-actions");
    this.dom.presetName = name;
    this.dom.presetMode = mode;
    this.dom.presetInstructions = instructions;
    this.dom.savePreset = this.button("另存为新预设", () => this.savePreset(false));
    this.dom.updatePreset = this.button("更新预设", () => this.savePreset(true));
    this.dom.deletePreset = this.button("删除预设", () => this.deletePreset());
    this.dom.preset.addEventListener("change", () => this.loadPresetEditor());
    actions.append(this.dom.savePreset, this.dom.updatePreset, this.dom.deletePreset);
    wrap.append(element("div", "tk-pa-note", "只改变基础创作指令，不能覆盖模型规则、协议或响应格式。"), field("名称", name), field("使用方式", mode), field("基础创作指令", instructions), actions);
    return wrap;
  }

  buildReferences() {
    const wrap = detail("创作资料核验");
    this.dom.referenceMode = element("select", "tk-pa-input");
    this.dom.referenceMode.setAttribute("aria-label", "创作资料核验方式");
    this.dom.referenceMode.append(option("local", "本地词库与人物库"), option("online", "本地优先 · 缺失标签联网核验"));
    this.dom.saveReferences = this.button("保存核验方式", async () => {
      const payload = await this.operation(() => this.fetch("/config", { reference_mode: this.dom.referenceMode.value }), "创作资料核验方式已保存。");
      if (payload) await this.refreshMeta({ quiet: true });
    });
    wrap.append(field("核验方式", this.dom.referenceMode), element("div", "tk-pa-note", "新创作使用 Danbooru 词库与 AnimaDex 人物库。联网仅复核本地缺失标签，不需要登录；未收录不会自动删除自然语言或自定义词。"), this.dom.saveReferences);
    return wrap;
  }

  buildNativeSettings() {
    const wrap = detail("DSH 原生设置");
    wrap.className = "tk-pa-details tk-pa-native-settings";
    this.dom.nativeSettings = wrap;
    this.dom.nativeHint = element("div", "tk-pa-note");
    this.dom.nativeConnection = this.button("选择 DSH 模型连接", () => {
      if (this.dom.providerSettings) this.dom.providerSettings.open = true;
      this.dom.providerSelect?.focus?.();
      this.status("在模型连接来源中选用 DSH 当前模型、WorkBuddy 或 OpenCode，然后点击‘使用此连接’。");
    });
    const row = element("div", "tk-pa-native-options");
    this.dom.nativeWorkspace = element("select", "tk-pa-input");
    this.dom.nativeWorkspace.setAttribute("aria-label", "DSH 工作目录");
    this.dom.nativePreset = element("select", "tk-pa-input");
    this.dom.nativePreset.setAttribute("aria-label", "DSH Agent 预设");
    this.dom.nativeSkill = element("input", "tk-pa-input");
    this.dom.nativeSkill.placeholder = "留空由 DSH 自动选用 skill";
    for (const control of [this.dom.nativeWorkspace, this.dom.nativePreset, this.dom.nativeSkill]) {
      control.addEventListener(control === this.dom.nativeSkill ? "input" : "change", () => {
        this.nativeSettingsDirty = true;
        this.invalidate();
      });
    }
    row.append(field("工作目录", this.dom.nativeWorkspace), field("Agent 预设", this.dom.nativePreset));
    this.dom.saveNative = this.button("保存原生设置", () => this.saveNativeConfig());
    wrap.append(this.dom.nativeHint, this.dom.nativeConnection, row, field("优先使用的 skill", this.dom.nativeSkill),
      element("div", "tk-pa-note", "原生会话读取该目录与 DSH 的 skill、原生配置和工具。实际工具过程可在 DSH 中查看。"), this.dom.saveNative);
    return wrap;
  }

  buildNativeProgress() {
    const wrap = element("section", "tk-pa-native-progress");
    wrap.hidden = true;
    wrap.setAttribute("aria-label", "DSH 原生执行进度");
    this.dom.nativeProgress = wrap;
    const heading = element("div", "tk-pa-native-progress-header");
    this.dom.nativeProgressLabel = element("span", "tk-pa-label", "DSH 原生");
    this.dom.cancelNative = this.button("取消本次执行", () => {
      this.invalidate();
      this.status("已请求取消本次 DSH 执行，保留已确认的 Final Prompt。");
    });
    this.dom.cancelNative.dataset.keepEnabled = "true";
    this.dom.nativeProcessLink = element("a", "tk-pa-native-link", "查看 DSH 过程");
    this.dom.nativeProcessLink.target = "_blank";
    this.dom.nativeProcessLink.rel = "noopener noreferrer";
    this.dom.nativeProcessLink.hidden = true;
    heading.append(this.dom.nativeProgressLabel, this.dom.nativeProcessLink, this.dom.cancelNative);
    this.dom.nativeProgressMessage = element("div", "tk-pa-note");
    this.dom.nativeProgressMessage.setAttribute("role", "status");
    this.dom.nativeProgressMessage.setAttribute("aria-live", "polite");
    this.dom.nativeProgressBar = element("div", "tk-pa-native-progress-bar");
    this.dom.nativeProgressBar.setAttribute("role", "progressbar");
    this.dom.nativeProgressBar.setAttribute("aria-label", "DSH 正在执行");
    this.dom.nativeProgressBar.append(element("span"));
    wrap.append(heading, this.dom.nativeProgressMessage, this.dom.nativeProgressBar);
    return wrap;
  }

  async refreshNativeMeta() {
    const version = ++this.nativeMetaVersion;
    try {
      const payload = await this.fetch("/native/meta");
      if (this.disposed || version !== this.nativeMetaVersion) return;
      this.nativeMeta = payload;
      this.renderNativeMeta();
    } catch (error) {
      if (this.disposed || version !== this.nativeMetaVersion || error.name === "AbortError") return;
      this.nativeMeta = { available: false, error: error.message };
      this.renderNativeMeta();
    }
  }

  renderNativeMeta() {
    if (!this.dom.nativeSettings) return;
    const info = this.nativeMeta;
    if (info && !this.nativeSettingsDirty) {
      const workspace = String(info.workspace || "");
      this.dom.nativeWorkspace.replaceChildren(...(info.workspaces || []).map((item) => option(item.path, item.label || item.path)));
      if (workspace && !Array.from(this.dom.nativeWorkspace.children).some((item) => item.value === workspace)) {
        this.dom.nativeWorkspace.append(option(workspace, workspace));
      }
      this.dom.nativeWorkspace.value = workspace;
      const preset = String(info.agent_preset || "");
      this.dom.nativePreset.replaceChildren(...(info.presets || []).map((item) => option(item.id, item.name || item.id)));
      if (preset && !Array.from(this.dom.nativePreset.children).some((item) => item.value === preset)) {
        this.dom.nativePreset.append(option(preset, preset));
      }
      this.dom.nativePreset.value = preset;
      this.dom.nativeSkill.value = String(info.skill || "");
    }
    const nativeSource = String(this.meta.provider_source || "manual").startsWith("dsh-");
    this.dom.nativeConnection.hidden = nativeSource;
    this.dom.nativeHint.textContent = !nativeSource
      ? "先选用一个 DSH 模型连接。原生执行使用它的模型，不会自动切换账号。"
      : !info ? "正在读取 DSH 工作目录和原生预设…"
        : info.error ? String(info.error)
          : [info.provider, info.model].filter(Boolean).join(" · ") || "使用已选 DSH 模型连接。";
    if (!nativeSource) this.dom.nativeSettings.open = true;
    this.updateActionState();
  }

  async saveNativeConfig() {
    const body = { workspace: this.dom.nativeWorkspace.value, agent_preset: this.dom.nativePreset.value, skill: this.dom.nativeSkill.value.trim() };
    const payload = await this.operation(() => this.fetch("/native/config", body), "DSH 原生设置已保存。");
    if (payload) {
      this.nativeSettingsDirty = false;
      await this.refreshNativeMeta();
    }
  }

  buildConfig() {
    const wrap = detail("模型连接与请求设置");
    this.dom.providerSettings = wrap;
    this.dom.config = {};
    const providerRow = element("div", "tk-pa-provider-row");
    this.dom.providerSelect = element("select", "tk-pa-input");
    this.dom.providerSelect.setAttribute("aria-label", "模型连接来源");
    this.dom.providerSelect.addEventListener("change", () => this.updateActionState());
    this.dom.useProvider = this.button("使用此连接", () => this.activateProvider());
    providerRow.append(field("模型连接来源", this.dom.providerSelect), this.dom.useProvider);
    this.dom.providerHint = element("div", "tk-pa-note");
    this.dom.providerError = element("div", "tk-pa-status tk-pa-provider-error");
    this.dom.providerError.setAttribute("role", "alert");
    wrap.append(providerRow, this.dom.providerHint, this.dom.providerError);
    const input = (name, label, type = "text") => {
      const control = element("input", "tk-pa-input");
      control.type = type;
      control.autocomplete = "off";
      this.dom.config[name] = control;
      wrap.append(field(label, control));
      return control;
    };
    input("base_url", "Base URL");
    input("model", "模型名称");
    const key = input("api_key", "API Key · 留空保留已有 Key", "password");
    key.autocomplete = "new-password";
    this.dom.keyStatus = element("div", "tk-pa-note");
    const clearKey = element("input");
    clearKey.type = "checkbox";
    this.dom.config.clear_api_key = clearKey;
    const clearLabel = element("label", "tk-pa-check", "清除本机保存的 API Key");
    clearLabel.prepend(clearKey);
    wrap.append(this.dom.keyStatus, clearLabel);
    const tuning = detail("请求参数");
    for (const [name, label, min, max, step] of [["temperature", "Temperature", 0, 2, 0.1], ["max_tokens", "最大输出 Token", 1, 131072, 1], ["timeout", "超时（秒）", 1, 600, 1]]) {
      const control = element("input", "tk-pa-input");
      control.type = "number";
      control.min = String(min);
      control.max = String(max);
      control.step = String(step);
      this.dom.config[name] = control;
      tuning.append(field(label, control));
    }
    const responseMode = element("select", "tk-pa-input");
    responseMode.append(option("json_schema", "JSON Schema"), option("json_object", "JSON Object"), option("text", "兼容文本"));
    this.dom.config.response_mode = responseMode;
    tuning.append(field("响应模式", responseMode));
    for (const [name, label] of [["stream", "流式传输"], ["disable_thinking", "关闭模型思考输出"]]) {
      const control = element("input");
      control.type = "checkbox";
      this.dom.config[name] = control;
      const check = element("label", "tk-pa-check", label);
      check.prepend(control);
      tuning.append(check);
    }
    for (const [name, label] of [["proxy", "代理 URL · 留空自动检测"], ["api_key_env", "API Key 环境变量名称"]]) {
      const control = element("input", "tk-pa-input");
      this.dom.config[name] = control;
      tuning.append(field(label, control));
    }
    this.dom.saveConfig = this.button("保存 API 配置", () => this.saveConfig());
    wrap.append(tuning, this.dom.saveConfig);
    return wrap;
  }

  mount(domWidget) {
    this.sizeSync = installDOMWidgetSizeSync({ node: this.node, domWidget, element: this.root, minHeight: 500, maxHeight: 1600, initialContentHeight: 760, nodeChromeHeight: 95 });
  }

  invalidate() {
    this.requestVersion++;
    if (this.nativeOperation) void this.cancelNativeRun(this.nativeOperation);
  }

  beginNativeRun(capture) {
    const operation = { id: sessionId(), session: capture.session, capture, controller: new AbortController(), timer: null, pollController: null, cancelled: false };
    this.nativeOperation = operation;
    for (const button of Object.values(this.dom.generationStrategies || {})) button.disabled = false;
    if (this.dom.nativeProcessLink) {
      this.dom.nativeProcessLink.hidden = true;
      this.dom.nativeProcessLink.removeAttribute("href");
    }
    this.renderNativeProgress({ status: "pending", message: "正在建立本次 DSH 原生会话…" }, operation);
    operation.timer = setTimeout(() => this.pollNativeRun(operation), 0);
    return operation;
  }

  async pollNativeRun(operation) {
    operation.timer = null;
    if (this.nativeOperation !== operation || operation.cancelled || !this.busy || !this.matches(operation.capture)) return;
    const controller = new AbortController();
    operation.pollController = controller;
    let terminal = false;
    try {
      const payload = await this.fetch(`/native/session/${encodeURIComponent(operation.session)}?operation_id=${encodeURIComponent(operation.id)}`, undefined, "GET", { controller });
      if (this.nativeOperation !== operation || operation.cancelled || !this.matches(operation.capture)) return;
      this.renderNativeProgress(payload, operation);
      terminal = ["completed", "complete", "failed", "cancelled", "canceled"].includes(payload.status);
    } catch (error) {
      if (error.name !== "AbortError" && this.nativeOperation === operation && !operation.cancelled && this.matches(operation.capture)) {
        this.renderNativeProgress({ status: "running", message: `暂时无法读取进度：${error.message}` }, operation);
      }
    } finally {
      if (operation.pollController === controller) operation.pollController = null;
      if (!terminal && this.nativeOperation === operation && !operation.cancelled && this.busy && this.matches(operation.capture)) {
        operation.timer = setTimeout(() => this.pollNativeRun(operation), 2000);
      }
    }
  }

  renderNativeProgress(payload, operation = this.nativeOperation) {
    if (!this.dom.nativeProgress || this.disposed) return;
    this.dom.nativeProgress.hidden = normalizeGenerationStrategy(this.value("generation_strategy")) !== "native";
    const status = String(payload.status || "pending");
    const labels = { pending: "准备中", queued: "排队中", running: "执行中", attention: "需要处理", cancelling: "取消中", completed: "已完成", complete: "已完成", failed: "执行失败", cancelled: "已取消", canceled: "已取消" };
    this.dom.nativeProgressLabel.textContent = `DSH 原生 · ${labels[status] || status}`;
    this.dom.nativeProgressMessage.textContent = String(payload.message || payload.error || "");
    const active = Boolean(operation && !operation.cancelled && ["pending", "queued", "running"].includes(status));
    this.dom.nativeProgressBar.hidden = !active;
    this.dom.nativeProgress.setAttribute("aria-busy", String(active));
    this.dom.cancelNative.hidden = !operation || ["completed", "complete", "failed", "cancelled", "canceled"].includes(status);
    this.dom.cancelNative.disabled = !operation || operation.cancelled;
    if (payload.web_url) {
      try {
        const url = new URL(String(payload.web_url));
        if (["http:", "https:"].includes(url.protocol)) {
          this.dom.nativeProcessLink.href = url.href;
          this.dom.nativeProcessLink.hidden = false;
        }
      } catch { /* Only expose actual, usable process links. */ }
    }
  }

  finishNativeRun(operation) {
    clearTimeout(operation.timer);
    operation.pollController?.abort();
    if (this.nativeOperation === operation) this.nativeOperation = null;
    if (!this.disposed && this.matches(operation.capture)) {
      this.dom.nativeProgressBar.hidden = true;
      this.dom.cancelNative.hidden = true;
      this.dom.nativeProgress.setAttribute("aria-busy", "false");
    }
  }

  async cancelNativeRun(operation) {
    if (operation.cancelled) return;
    operation.cancelled = true;
    clearTimeout(operation.timer);
    operation.pollController?.abort();
    // Cancel is independent of the edit request: disposing the node must not
    // abort the cancellation itself. The backend owns this operation id only.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const cancellation = this.fetch(`/native/session/${encodeURIComponent(operation.session)}/cancel`, { operation_id: operation.id }, "POST", { controller, track: false });
    operation.controller.abort();
    this.renderNativeProgress({ status: "cancelling", message: "已发送取消请求，保留已确认的 Final Prompt。" }, operation);
    try {
      const payload = await cancellation;
      if (!this.disposed && this.nativeOperation === operation) this.renderNativeProgress({ ...payload, status: payload.status || "cancelling", message: payload.message || "取消请求已确认。" }, operation);
    }
    catch (error) {
      if (!this.disposed) this.status(`取消请求未确认：${error.message}。请在 DSH 中查看本次执行。`, true);
    } finally { clearTimeout(timeout); }
  }

  status(message, error = false) {
    if (!this.dom.status) return;
    this.dom.status.textContent = message;
    this.dom.status.classList.toggle("is-error", error);
  }

  setBusy(value) {
    this.busy = value;
    if (this.root) for (const control of this.root.querySelectorAll("button, input, select, textarea")) {
      if (control.dataset.keepEnabled === "true") continue;
      if (value && control.dataset.nativeStrategy === "true" && normalizeGenerationStrategy(this.value("generation_strategy")) === "native") continue;
      control.disabled = value;
    }
    if (this.dom.send) this.dom.send.textContent = value ? "处理中…" : "发送编辑";
    if (this.dom.cancelNative) this.dom.cancelNative.disabled = !this.nativeOperation || this.nativeOperation.cancelled;
    if (!value) this.updateActionState();
  }

  updateActionState() {
    if (this.busy) return;
    if (this.dom.undo) this.dom.undo.disabled = this.history.length === 0;
    if (this.dom.retry) this.dom.retry.disabled = this.history.length === 0;
    const preset = this.meta.presets.find((item) => item.id === this.value("preset"));
    const editable = Boolean(preset && !preset.builtin && preset.editable !== false);
    if (this.dom.updatePreset) this.dom.updatePreset.disabled = !editable;
    if (this.dom.deletePreset) this.dom.deletePreset.disabled = !editable;
    if (this.dom.copy) this.dom.copy.disabled = !String(this.value("approved_prompt"));
    if (this.dom.providerSelect) this.dom.providerSelect.disabled = false;
    if (this.dom.useProvider) this.dom.useProvider.disabled = !this.dom.providerSelect?.value;
    if (this.dom.send && normalizeGenerationStrategy(this.value("generation_strategy")) === "native") {
      this.dom.send.disabled = !String(this.meta.provider_source || "manual").startsWith("dsh-") || this.nativeMeta?.available === false;
    } else if (this.dom.send) this.dom.send.disabled = false;
    this.updateProviderState();
    const image = parseImageDescriptor(this.value("interrogation_image"));
    if (this.dom.interrogateButton) this.dom.interrogateButton.disabled = !image;
    if (this.dom.clearImage) this.dom.clearImage.disabled = !image;
    if (this.dom.expandInterrogation) this.dom.expandInterrogation.disabled = !this.interrogationResult?.observation_id;
    const canAccept = Boolean(this.interrogationResult?.formatted_prompt?.trim());
    if (this.dom.replaceInterrogation) this.dom.replaceInterrogation.disabled = !canAccept;
    if (this.dom.appendInterrogation) this.dom.appendInterrogation.disabled = !canAccept;
  }

  updateProviderState() {
    const native = String(this.meta.provider_source || "manual").startsWith("dsh-");
    for (const name of CONNECTION_FIELDS) {
      const control = this.dom.config?.[name];
      if (!control) continue;
      control.disabled = this.busy || native;
      if (control.type !== "checkbox") control.readOnly = native;
    }
    const nativeExecution = normalizeGenerationStrategy(this.value("generation_strategy")) === "native";
    if (this.dom.providerHint) this.dom.providerHint.textContent = native
      ? nativeExecution ? "实时使用 DSH 模型连接，在原生会话中执行 skill 与工具；模型、地址与凭据由 DSH 管理。"
        : "实时读取 DSH 的模型连接；在 DSH 修改模型、地址与凭据。快速直写与按流程创作只继承连接，不执行 DSH skill、工具或 MCP。"
      : "本机独立保存模型连接；也可选择实时读取 DSH 的连接。";
    const error = String(this.meta.provider_error || "");
    if (this.dom.providerError) {
      this.dom.providerError.textContent = error;
      this.dom.providerError.hidden = !error;
    }
    if (this.dom.keyStatus) this.dom.keyStatus.textContent = native
      ? error ? "DSH 连接不可用：请修正 DSH 配置或切回本机独立设置。"
        : this.meta.config?.api_key_set ? "使用 DSH 凭据 · 不会回传到浏览器或复制到节点设置" : "DSH 尚未提供可用凭据"
      : this.meta.config?.api_key_set ? "本机已配置 Key · 不会回传到浏览器或工作流" : "尚未配置 Key · 可使用环境变量";
  }

  async fetch(path, body, method = body === undefined ? "GET" : "POST", { controller = new AbortController(), track = true } = {}) {
    const api = globalThis.comfyAPI?.api?.api || globalThis.window?.comfyAPI?.api?.api || globalThis.window?.api;
    if (!api?.fetchApi) throw new Error("ComfyUI API 尚未就绪，请刷新页面");
    if (track) this.controllers.add(controller);
    try {
      const response = await api.fetchApi(`${API_ROOT}${path}`, {
        method, cache: "no-store", signal: controller.signal,
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(String(payload.error || payload.message || `HTTP ${response.status}`));
        error.status = response.status;
        throw error;
      }
      return payload;
    } finally { this.controllers.delete(controller); }
  }

  async refreshMeta({ quiet = false } = {}) {
    try {
      const payload = await this.fetch("/meta");
      if (this.disposed) return;
      this.meta = { ...this.meta, ...payload };
      this.renderMeta();
      if (normalizeGenerationStrategy(this.value("generation_strategy")) === "native") await this.refreshNativeMeta();
      if (payload.provider_error) this.status(`模型连接不可用：${String(payload.provider_error)}`, true);
      else if (!quiet) this.status("就绪 · 编辑成功后会保存最终 Prompt");
    } catch (error) { if (!this.disposed) this.status(`无法加载 Agent 配置：${error.message}`, true); }
  }

  renderMeta() {
    const profile = String(this.value("profile", "anima"));
    if (!this.node.properties?.tkPromptAgentDefaultApplied) {
      if ((!this.value("preset") || this.value("preset") === "default") && !String(this.value("current_prompt")).trim() && !this.history.length && this.meta.default_preset
        && this.meta.presets.some((entry) => entry.id === this.meta.default_preset)) this.write("preset", this.meta.default_preset);
      this.node.properties = { ...(this.node.properties || {}), tkPromptAgentDefaultApplied: true };
    }
    const preset = String(this.value("preset"));
    this.dom.profile.replaceChildren(...this.meta.profiles.map((item) => option(item.id, item.label || item.id)));
    if (!this.meta.profiles.some((item) => item.id === profile)) this.dom.profile.append(option(profile, `${profile}（不可用）`));
    this.dom.profile.value = profile;
    const defaultPreset = this.meta.presets.find((item) => item.id === "default");
    const choices = this.meta.presets.map((item) => option(item.id, item.name || item.id));
    if (!preset && defaultPreset) {
      this.dom.preset.replaceChildren(option("", defaultPreset.name || "默认"), ...choices.filter((item) => item.value !== "default"));
    } else this.dom.preset.replaceChildren(...choices);
    if (preset && !this.meta.presets.some((item) => item.id === preset)) this.dom.preset.append(option(preset, "已保存预设（不可用）"));
    this.dom.preset.value = preset;
    if (this.dom.providerSelect) {
      const nativeChoices = (this.meta.native_providers || []).map((item) => option(item.id,
        [item.name || item.id, item.live ? "实时" : "", item.model].filter(Boolean).join(" · ")));
      this.dom.providerSelect.replaceChildren(option("manual", "本机独立设置"), ...nativeChoices,
        ...(this.meta.provider_presets || []).map((item) => option(item.id, item.name || item.id)));
      const source = this.meta.provider_source || this.meta.active_provider || "manual";
      if (!Array.from(this.dom.providerSelect.children).some((item) => item.value === source)) {
        this.dom.providerSelect.append(option(source, `${source}（当前来源不可用）`));
      }
      this.dom.providerSelect.value = source;
    }
    this.renderSections();
    this.loadPresetEditor();
    this.updatePresetHint();
    this.updateProfileHint();
    const config = this.meta.config || {};
    const failedNative = String(this.meta.provider_source || "").startsWith("dsh-") && this.meta.provider_error;
    this.dom.referenceMode.value = this.meta.reference_mode || "local";
    for (const [name, control] of Object.entries(this.dom.config || {})) {
      if (name === "api_key" || name === "clear_api_key") continue;
      if (control.type === "checkbox") control.checked = Boolean(config[name]);
      else if (failedNative && CONNECTION_FIELDS.includes(name)) control.value = "";
      else if (config[name] !== undefined && config[name] !== null) control.value = String(config[name]);
    }
    this.renderInterrogationMeta();
    this.updateActionState();
  }

  renderInterrogationMeta() {
    const info = this.meta.interrogation || {};
    const sources = info.sources || IMAGE_SOURCES.map(([id, label]) => ({ id, label }));
    const selected = this.value("interrogation_source", "local-wd14");
    this.dom.interrogation_source.replaceChildren(...sources.map((item) => option(item.id, item.label || item.id)));
    if (!sources.some((item) => item.id === selected)) this.dom.interrogation_source.append(option(selected, `${selected}（不可用）`));
    this.dom.interrogation_source.value = selected;
    const config = info.config || {};
    const models = info.models || info.wd14_models || config.wd14_models || [];
    const chosen = this.interrogationOptions().model || config.wd14_model || "";
    const model = this.dom.interrogationConfig.wd14_model;
    model.replaceChildren(...models.map((item) => option(typeof item === "string" ? item : item.id, typeof item === "string" ? item : item.label || item.id)));
    if (chosen && !models.some((item) => (typeof item === "string" ? item : item.id) === chosen)) model.append(option(chosen, chosen));
    model.value = chosen;
    this.dom.hfTokenStatus.textContent = config.hf_token_set ? "已保存 HF Token · 不会回传或写入工作流" : "未设置 HF Token · 在线来源可匿名尝试";
    this.dom.interrogationConfig.timeout.value = String(config.timeout ?? 180);
    this.updateSourceHint();
    this.restoreInterrogationOptions();
  }

  updateSourceHint() {
    const source = this.meta.interrogation?.sources?.find((item) => item.id === this.value("interrogation_source"));
    const online = source?.kind === "online" || this.value("interrogation_source").endsWith("-online") || this.value("interrogation_source") === "workbuddy-vision";
    const notice = online ? "图片会发送到所选服务。" : "在本机识别，不发送图片到在线服务。";
    if (this.dom.sourceHint) this.dom.sourceHint.textContent = [notice, source?.note].filter(Boolean).join(" ");
    if (this.dom.interrogationConfig.caption_type?.parentElement) this.dom.interrogationConfig.caption_type.parentElement.hidden = this.value("interrogation_source") !== "toriigate-online";
    if (this.dom.interrogationConfig.wd14_model?.parentElement) this.dom.interrogationConfig.wd14_model.parentElement.hidden = this.value("interrogation_source") !== "local-wd14";
    const tagger = ["local-wd14", "pixai-online"].includes(this.value("interrogation_source"));
    for (const name of ["threshold", "character_threshold"]) if (this.dom.interrogationConfig[name]?.parentElement) this.dom.interrogationConfig[name].parentElement.hidden = !tagger;
  }

  interrogationOptions() {
    try {
      const value = JSON.parse(this.value("interrogation_options", "{}") || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  restoreInterrogationOptions() {
    const options = this.interrogationOptions();
    const controls = this.dom.interrogationConfig || {};
    const pixai = this.value("interrogation_source") === "pixai-online";
    for (const [name, fallback] of [["threshold", pixai ? 0.17 : 0.35], ["character_threshold", pixai ? 0.27 : 0.85], ["caption_type", "short"]]) {
      if (controls[name]) controls[name].value = String(options[name] ?? fallback);
    }
    if (controls.wd14_model && options.model) controls.wd14_model.value = options.model;
    for (const [name, fallback] of [["expansion_mode", "faithful"], ["vision_provider", "current"], ["expansion_instruction", ""]]) {
      if (this.dom.expansion?.[name]) this.dom.expansion[name].value = String(options[name] ?? fallback);
    }
    if (this.dom.expansion?.auto_expand) this.dom.expansion.auto_expand.checked = options.auto_expand === true;
    if (this.dom.expansion?.preserve_identity) this.dom.expansion.preserve_identity.checked = options.preserve_identity !== false;
  }

  writeInterrogationOptions() {
    const controls = this.dom.interrogationConfig;
    const options = { ...this.interrogationOptions() };
    for (const name of ["threshold", "character_threshold"]) {
      const value = Number(controls[name].value);
      if (!controls[name].value.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
        this.status("反推阈值需要在 0 到 1 之间。", true); return;
      }
      options[name] = value;
    }
    if (controls.wd14_model.value) options.model = controls.wd14_model.value;
    options.caption_type = controls.caption_type.value || "short";
    this.write("interrogation_options", JSON.stringify(options));
    this.invalidate();
    this.interrogationResult = null;
    this.renderInterrogationResult();
  }

  renderImage() {
    if (!this.dom.imagePreview) return;
    const image = parseImageDescriptor(this.value("interrogation_image"));
    this.dom.imagePreview.hidden = !image;
    if (image) {
      const api = globalThis.comfyAPI?.api?.api || globalThis.window?.comfyAPI?.api?.api || globalThis.window?.api;
      const path = `/view?${new URLSearchParams(image)}`;
      this.dom.imagePreview.src = api?.apiURL ? api.apiURL(path) : path;
      this.dom.imageName.textContent = [image.subfolder, image.filename].filter(Boolean).join("/");
    } else {
      this.dom.imagePreview.removeAttribute?.("src");
      this.dom.imageName.textContent = "尚未选择图片";
    }
    this.updateActionState();
    this.updateExecutionHint();
  }

  renderInterrogationResult() {
    if (!this.dom.rawInterrogation) return;
    const result = this.interrogationResult;
    const tags = Array.isArray(result?.tags) ? result.tags.map((item) => typeof item === "string" ? item : item.tag || item.name || "").filter(Boolean).join(", ") : String(result?.tags || "");
    this.dom.rawInterrogation.value = [result?.caption, tags].filter(Boolean).join("\n\n");
    this.dom.formattedInterrogation.value = result?.formatted_prompt || "";
    this.dom.interrogationMessage.textContent = result?.expansion_error
      ? `看图扩写失败：${result.expansion_error}。原始结果已保留，Final Prompt 未改变。`
      : result ? String(result.message || "确认候选结果后才会更新 Final Prompt；可继续在创作页修改。") : "反推先生成候选结果，不会自动覆盖当前 Prompt。";
    this.updateActionState();
  }

  renderSections() {
    for (const [container, name] of [[this.dom.locks, "locked_sections"], [this.dom.scope, "edit_scope"]]) {
      if (!container) continue;
      const selected = new Set(parseSectionIds(this.value(name)));
      container.replaceChildren();
      for (const section of this.meta.sections || []) {
        const input = element("input");
        input.type = "checkbox";
        input.value = section.id;
        input.checked = selected.has(section.id);
        input.disabled = this.busy;
        input.addEventListener("change", () => {
          const ids = Array.from(container.querySelectorAll("input")).filter((item) => item.checked).map((item) => item.value);
          this.write(name, JSON.stringify(ids));
          this.invalidate();
          this.renderWorkflow();
        });
        const label = element("label", "tk-pa-chip");
        label.append(input, element("span", "", section.label || section.id));
        container.append(label);
      }
      if (!this.meta.sections.length) container.append(element("span", "tk-pa-note", "配置加载后可选择"));
    }
  }

  loadPresetEditor() {
    const preset = this.meta.presets.find((item) => item.id === (this.value("preset") || "default"));
    if (this.dom.presetName) this.dom.presetName.value = preset?.name || "";
    if (this.dom.presetMode) this.dom.presetMode.value = preset?.mode === "replace" ? "replace" : "append";
    if (this.dom.presetInstructions) this.dom.presetInstructions.value = preset?.instructions || "";
    this.updateActionState();
  }

  restoreEditors() {
    for (const name of ["profile", "mode", "preset", "current_prompt", "user_instruction", "custom_instructions", "approved_prompt", "interrogation_source", "interrogation_action"]) {
      if (this.dom[name]) this.dom[name].value = String(this.value(name));
    }
    if (this.dom.agent_response) this.dom.agent_response.textContent = String(this.value("agent_response"));
    if (this.dom.execution) this.dom.execution.value = normalizeExecutionValue(this.value("execution"));
    this.updateProfileHint();
    this.restoreInterrogationOptions();
    this.updateSourceHint();
    this.renderImage();
    this.renderInterrogationResult();
    this.renderHistory();
    this.renderWorkflow();
    this.renderSections();
    this.updateActionState();
  }

  async restore() {
    this.invalidate();
    this.interrogationResult = null;
    const id = this.claimSession();
    this.prepareWidgets();
    this.revision = 0;
    this.history = [];
    this.setTab(this.node.properties?.tkPromptAgentTab);
    this.restoreEditors();
    this.updateExecutionHint();
    this.refreshConnections();
    const version = this.requestVersion;
    try {
      const payload = await this.fetch(`/session/${encodeURIComponent(id)}`);
      if (this.disposed || this.session !== id || this.requestVersion !== version) return;
      // A workflow may hold an intentional draft differing from server state.
      // Restore conversation bookkeeping without overwriting that draft.
      this.acceptState(payload.state, { prompt: false });
    } catch (error) {
      if (!this.disposed && error.status !== 404) this.status(`会话恢复失败：${error.message}`, true);
    }
  }

  updateProfileHint() {
    const item = this.meta.profiles.find((entry) => entry.id === this.value("profile"));
    if (this.dom.profileHint) this.dom.profileHint.textContent = item?.style || "";
  }

  updateExecutionHint() {
    const action = this.value("interrogation_action", "none");
    if (!this.dom.executionHint) return;
    const hasImage = this.node.inputs?.some((input) => input.name === "image" && input.link != null)
      || parseImageDescriptor(this.value("interrogation_image"));
    if ((action === "replace" || action === "append") && hasImage) {
      this.dom.executionHint.textContent = `运行节点会识别输入图片并直接${action === "replace" ? "替换" : "加入"} Final Prompt；不需要填写当前 Prompt 或文字指令。在线来源会调用对应服务。`;
    } else {
      const textBehavior = normalizeExecutionValue(this.value("execution")) === "execute"
        ? "运行节点时会执行文字指令并调用当前 LLM。"
        : "运行节点时输出已确认的 Final Prompt；创作编辑成功后才会更新它。";
      this.dom.executionHint.textContent = (action !== "none" && !hasImage ? "未提供图片，按文字编辑行为运行。" : "") + textBehavior;
    }
  }

  updatePresetHint() {
    if (!this.dom.presetHint) return;
    const selected = this.value("preset") || "default";
    const preset = this.meta.presets.find((entry) => entry.id === selected);
    const descriptions = {
      default: "按 Anima / Krea 2 的 Profile 规则创作，不额外偏向某种内容。",
      concise: "保留少量具体有效的画面细节，不自动堆通用质量词或风格词。",
      interaction: "按你的要求补清人物与环境的空间和物理互动，并尊重锁定部分。",
      "dsh-base": "使用本机导入的 DSH 长基础提示词，替换默认创作基础。",
    };
    const description = descriptions[selected] || (preset?.mode === "replace"
      ? "用此自定义预设替换默认创作基础。" : "在默认创作规则上追加此自定义预设。");
    this.dom.presetHint.textContent = `${description}仅影响 LLM 创作编辑，不改变 Profile 格式、WD14 模型或反推来源。`;
  }

  refreshConnections() {
    const names = [];
    for (const [name, label] of [["current_prompt", "当前 Prompt"], ["user_instruction", "用户指令"]]) {
      if (this.node.inputs?.some((input) => input.name === name && input.link != null)) names.push(label);
    }
    if (this.dom.connectionHint) this.dom.connectionHint.textContent = names.length
      ? `${names.join("、")}已连接：运行节点时读取连线，聊天编辑使用上方保存的文本。` : "";
    const imageConnected = this.node.inputs?.some((input) => input.name === "image" && input.link != null);
    const imageLink = this.node.inputs?.find((input) => input.name === "image")?.link ?? null;
    if (this.imageLink !== undefined && this.imageLink !== imageLink) {
      this.invalidate();
      this.interrogationResult = null;
      this.renderInterrogationResult();
    }
    this.imageLink = imageLink;
    if (this.dom.imageConnectionHint) this.dom.imageConnectionHint.textContent = imageConnected
      ? "IMAGE 已连接。选择‘反推并替换/加入’，排队时会直接读取这张图并把 Prompt 输出到下游；无需填写文字输入。此页‘开始反推’使用上传的图片。"
      : "连接 IMAGE 后选择‘反推并替换/加入’，排队时会直接反推并把 Prompt 输出到下游。";
    this.updateExecutionHint();
  }

  capture() {
    return {
      session: String(this.value("session_id")), profile: String(this.value("profile")), mode: String(this.value("mode")),
      strategy: String(this.value("generation_strategy")),
      current: String(this.value("current_prompt")), instruction: String(this.value("user_instruction")), version: this.requestVersion,
      image: String(this.value("interrogation_image")), source: String(this.value("interrogation_source")), options: String(this.value("interrogation_options")),
    };
  }

  matches(capture) {
    return !this.disposed && capture.version === this.requestVersion && capture.session === String(this.value("session_id"))
      && capture.profile === String(this.value("profile")) && capture.mode === String(this.value("mode"))
      && capture.strategy === String(this.value("generation_strategy"))
      && capture.current === String(this.value("current_prompt")) && capture.instruction === String(this.value("user_instruction"))
      && capture.image === String(this.value("interrogation_image")) && capture.source === String(this.value("interrogation_source")) && capture.options === String(this.value("interrogation_options"));
  }

  acceptState(state, { prompt = true } = {}) {
    if (!state || (state.session_id && state.session_id !== this.session)) return;
    if (Number.isInteger(state.revision)) this.revision = state.revision;
    if (Array.isArray(state.history)) this.history = state.history;
    if (prompt && Array.isArray(state.locks)) this.write("locked_sections", JSON.stringify(state.locks));
    if (prompt && typeof state.prompt === "string") this.write("current_prompt", state.prompt);
    if (this.dom.historyCount) this.dom.historyCount.textContent = this.history.length ? `${this.history.length} 轮编辑` : "";
    this.renderHistory();
    this.renderWorkflow();
    this.renderSections();
    this.updateActionState();
  }

  renderHistory() {
    if (!this.dom.historyList) return;
    this.dom.historyList.replaceChildren();
    const first = Math.max(0, this.history.length - 12);
    for (let i = first; i < this.history.length; i++) {
      const entry = this.history[i];
      const item = element("details", "tk-pa-history-item");
      const instruction = String(entry.instruction || "编辑 Prompt");
      item.append(element("summary", "", `${i + 1}. ${instruction}`));
      if (entry.message) item.append(element("div", "tk-pa-note", String(entry.message)));
      if (entry.workflow) item.append(this.workflowList(entry.workflow));
      item.append(element("div", "tk-pa-history-prompt", String(entry.prompt || "")));
      this.dom.historyList.append(item);
    }
    if (!this.history.length) this.dom.historyList.append(element("div", "tk-pa-note", "还没有编辑记录。"));
  }

  workflowList(workflow) {
    const list = element("ol", "tk-pa-workflow-steps");
    for (const step of Array.isArray(workflow?.steps) ? workflow.steps : []) {
      const item = element("li", "tk-pa-workflow-step");
      item.append(element("div", "tk-pa-workflow-label", String(step.label || "创作步骤")),
        element("div", "tk-pa-note", String(step.summary || "")));
      list.append(item);
    }
    return list;
  }

  renderWorkflow() {
    if (!this.dom.workflow) return;
    const workflow = this.history.at(-1)?.workflow;
    this.dom.workflow.hidden = !Array.isArray(workflow?.steps) || !workflow.steps.length;
    this.dom.workflowSteps.replaceChildren(...this.workflowList(workflow).children);
    const strategy = normalizeGenerationStrategy(this.value("generation_strategy"));
    if (this.dom.nativeSettings) this.dom.nativeSettings.hidden = strategy !== "native";
    if (this.dom.nativeProgress && strategy !== "native") this.dom.nativeProgress.hidden = true;
    for (const [id, button] of Object.entries(this.dom.generationStrategies || {})) {
      const selected = id === strategy;
      button.setAttribute("aria-pressed", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle("is-selected", selected);
    }
    if (this.dom.workflowHint) {
      const hasProtection = parseSectionIds(this.value("locked_sections")).length || parseSectionIds(this.value("edit_scope")).length;
      const mode = this.value("mode");
      this.dom.workflowHint.hidden = strategy === "guided" && mode !== "create" && mode !== "optimize";
      this.dom.workflowHint.textContent = mode === "optimize"
        ? "仅做去重与格式整理，保留画面内容，不调用 LLM。"
        : strategy === "native"
          ? "由 DSH 原生会话按 skill 流程创作，并可执行检索与校对工具。实际过程在 DSH 中记录；完成后回填 Final Prompt。"
        : strategy === "direct"
          ? hasProtection
            ? "已选锁定或编辑范围：本轮使用分区编辑保留指定内容；首次可能需要额外分类。"
            : "一次模型请求直接写英文正文；不执行查词、人物查询、联网核验或 DSH 脚本。"
          : "新创作会整理需求、查询本地词条与人物资料，再生成并核对提示词；通常调用两次 LLM。高级设置可开启按需联网核验。";
    }
    this.renderNativeMeta();
    this.updateProviderState();
  }

  applyResult(payload) {
    this.acceptState(payload.state);
    if (typeof payload.state?.profile === "string" && payload.state.profile) this.write("profile", payload.state.profile);
    const prompt = payload.prompt ?? payload.state?.prompt;
    if (typeof prompt === "string") {
      this.write("current_prompt", prompt);
      this.write("approved_prompt", prompt);
      this.write("approved_profile", payload.state?.profile || this.value("profile"));
    }
    this.write("agent_response", String(payload.message || ""));
    if (this.value("mode") === "create" && typeof prompt === "string" && prompt.trim()) this.write("mode", "modify");
    this.restoreEditors();
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.map(String).filter(Boolean) : [];
    this.status(warnings.length ? warnings.join(" · ") : "已保存 Final Prompt · 可以继续提出修改");
  }

  async operation(task, successMessage = "") {
    if (this.busy || this.disposed) return;
    this.claimSession();
    const capture = this.capture();
    this.setBusy(true);
    this.status("正在处理…");
    try {
      const payload = await task(capture);
      if (!this.matches(capture)) {
        if (!this.disposed) {
          if (capture.session === this.session) this.acceptState(payload?.state, { prompt: false });
          this.status("草稿或模型已改变，未覆盖当前文本；可再次发送。", true);
        }
        return;
      }
      if (successMessage) this.status(successMessage);
      else this.applyResult(payload);
      return payload;
    } catch (error) {
      if (this.disposed || error.name === "AbortError") return;
      this.status(`操作失败：${error.message}`, true);
      if (error.status === 409 && capture.session === this.session) {
        try { const latest = await this.fetch(`/session/${encodeURIComponent(this.session)}`); if (!this.disposed) this.acceptState(latest.state, { prompt: false }); } catch { /* Preserve the original error and draft. */ }
      }
    } finally { if (!this.disposed) this.setBusy(false); }
  }

  async edit() {
    if (normalizeGenerationStrategy(this.value("generation_strategy")) === "native") {
      if (!String(this.meta.provider_source || "manual").startsWith("dsh-")) {
        this.renderNativeMeta();
        this.status("请先在模型连接来源中选用一个 DSH 连接。", true);
        return;
      }
      if (this.nativeSettingsDirty) { this.status("请先保存 DSH 原生设置，再发送指令。", true); return; }
      if (this.nativeMeta?.available === false) { this.status(`DSH 原生不可用：${this.nativeMeta.error || "请检查 DSH 是否正在运行"}`, true); return; }
    }
    if (!String(this.value("user_instruction")).trim() && !["optimize", "convert"].includes(this.value("mode"))) { this.status("请先填写你的指令。", true); return; }
    const startNew = !String(this.value("current_prompt")).trim() && !!String(this.value("user_instruction")).trim();
    if (startNew) {
      this.write("mode", "create");
      this.dom.mode.value = "create";
      this.renderWorkflow();
    }
    return this.operation(async (capture) => {
      const strategy = normalizeGenerationStrategy(this.value("generation_strategy"));
      const operation = strategy === "native" ? this.beginNativeRun(capture) : null;
      try {
        const payload = await this.fetch("/edit", {
      session_id: this.session, revision: this.revision, profile: this.value("profile"), mode: this.value("mode"),
      start_new: startNew,
      generation_strategy: strategy,
      ...(operation ? { native_operation_id: operation.id } : {}),
      current_prompt: this.value("current_prompt"), instruction: this.value("user_instruction"), preset: this.value("preset"),
      custom_instructions: this.value("custom_instructions"), locks: parseSectionIds(this.value("locked_sections")), scope: parseSectionIds(this.value("edit_scope")),
        }, "POST", operation ? { controller: operation.controller } : {});
        if (operation && !operation.cancelled && this.matches(capture)) this.renderNativeProgress({ status: "completed", message: "原生创作已完成。" }, operation);
        return payload;
      } catch (error) {
        if (operation && !operation.cancelled && this.matches(capture)) this.renderNativeProgress({ status: "failed", error: error.message }, operation);
        throw error;
      } finally { if (operation) this.finishNativeRun(operation); }
    });
  }

  async uploadImage(file) {
    if (!file || this.busy) return;
    if (file.type && !file.type.startsWith("image/")) { this.status("请选择图片文件。", true); return; }
    const payload = await this.operation(async () => {
      const api = globalThis.comfyAPI?.api?.api || globalThis.window?.comfyAPI?.api?.api || globalThis.window?.api;
      if (!api?.fetchApi) throw new Error("ComfyUI API 尚未就绪，请刷新页面");
      const form = new FormData();
      form.append("image", file, file.name || "clipboard.png");
      form.append("type", "input");
      form.append("overwrite", "false");
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const response = await api.fetchApi("/upload/image", { method: "POST", body: form, signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        const image = parseImageDescriptor({ filename: result.name || result.filename, subfolder: result.subfolder, type: result.type });
        if (!image) throw new Error("上传服务没有返回图片位置");
        return { image };
      } finally { this.controllers.delete(controller); }
    }, "图片已上传，可以开始反推。");
    if (!payload) return;
    this.write("interrogation_image", JSON.stringify(payload.image));
    this.invalidate();
    this.interrogationResult = null;
    this.renderImage();
    this.renderInterrogationResult();
  }

  async interrogate() {
    const image = parseImageDescriptor(this.value("interrogation_image"));
    if (!image) { this.status("请先上传或粘贴一张图片；IMAGE 连线在运行节点时读取。", true); return; }
    const payload = await this.operation(() => this.fetch("/interrogate", {
      session_id: this.session, profile: this.value("profile"), source: this.value("interrogation_source"), image, options: this.interrogationOptions(),
    }), "反推完成 · 确认后更新 Final Prompt。");
    if (!payload) return;
    this.interrogationResult = payload;
    this.renderInterrogationResult();
    if (payload.expansion_error) this.status(this.dom.interrogationMessage.textContent, true);
  }

  async expandInterrogation() {
    const observation = this.interrogationResult;
    if (!observation?.observation_id) {
      this.status("请先反推图片，再对最近处理的原图进行扩写。", true);
      return;
    }
    const payload = await this.operation(() => {
      this.status("正在结合原图与反推结果扩写…");
      return this.fetch("/expand-interrogation", {
        session_id: this.session, profile: this.value("profile"), observation_id: observation.observation_id,
        options: this.interrogationOptions(),
      });
    }, "看图扩写完成 · 确认候选后更新 Final Prompt。");
    if (!payload || this.interrogationResult?.observation_id !== observation.observation_id) return;
    this.interrogationResult = { ...observation, ...payload, tags: observation.tags, caption: observation.caption };
    this.renderInterrogationResult();
    if (payload.expansion_error) this.status(this.dom.interrogationMessage.textContent, true);
  }

  async acceptInterrogation(action) {
    const prompt = this.interrogationResult?.formatted_prompt;
    if (!prompt?.trim()) return;
    const payload = await this.operation(() => this.fetch("/accept-interrogation", {
      session_id: this.session, revision: this.revision, profile: this.value("profile"), prompt, action,
      locks: parseSectionIds(this.value("locked_sections")),
    }));
    if (payload) {
      this.write("mode", "modify");
      this.restoreEditors();
      this.status("反推结果已确认 · 已更新 Final Prompt，可在创作页继续修改。");
    }
  }

  async saveInterrogationConfig() {
    const controls = this.dom.interrogationConfig;
    const body = {};
    const timeout = Number(controls.timeout.value);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) { this.status("在线反推等待上限需在 1 到 600 秒之间。", true); return; }
    if (timeout !== (this.meta.interrogation?.config?.timeout ?? 180)) body.timeout = timeout;
    if (controls.hf_token.value.trim()) body.hf_token = controls.hf_token.value.trim();
    if (controls.clear_hf_token.checked) body.clear_hf_token = true;
    const payload = await this.operation(() => this.fetch("/interrogation-config", body), "在线反推配置已保存。");
    if (payload) {
      controls.hf_token.value = "";
      controls.clear_hf_token.checked = false;
      await this.refreshMeta({ quiet: true });
    }
  }

  async sessionAction(action) {
    const retryNative = action === "retry" && (normalizeGenerationStrategy(this.value("generation_strategy")) === "native" || this.history.at(-1)?.workflow?.id === "dsh-native");
    const payload = await this.operation(async (capture) => {
      const operation = retryNative ? this.beginNativeRun(capture) : null;
      try {
        const result = await this.fetch(`/session/${encodeURIComponent(this.session)}/${action}`, {
          revision: this.revision,
          ...(operation ? { native_operation_id: operation.id } : {}),
        }, "POST", operation ? { controller: operation.controller } : {});
        if (operation && !operation.cancelled && this.matches(capture)) this.renderNativeProgress({ status: "completed", message: "原生重试已完成。" }, operation);
        return result;
      } catch (error) {
        if (operation && !operation.cancelled && this.matches(capture)) this.renderNativeProgress({ status: "failed", error: error.message }, operation);
        throw error;
      } finally { if (operation) this.finishNativeRun(operation); }
    });
    if (payload && action === "clear") {
      this.write("user_instruction", "");
      this.write("mode", "create");
      this.write("approved_profile", "");
      this.restoreEditors();
      this.status("会话已清空。" );
    }
  }

  async saveConfig() {
    const controls = this.dom.config;
    const body = {};
    const native = String(this.meta.provider_source || "manual").startsWith("dsh-");
    const fields = native ? ["proxy", "response_mode"] : ["base_url", "model", "proxy", "api_key_env", "response_mode"];
    for (const name of fields) body[name] = controls[name].value.trim();
    for (const name of ["temperature", "max_tokens", "timeout"]) {
      const control = controls[name];
      const value = Number(control.value);
      if (control.value.trim() === "" || !Number.isFinite(value) || value < Number(control.min) || value > Number(control.max) || (name === "max_tokens" && !Number.isInteger(value))) {
        this.status(`请填写有效的 ${name}。`, true); return;
      }
      body[name] = value;
    }
    if (!native && controls.api_key.value.trim()) body.api_key = controls.api_key.value.trim();
    if (!native && controls.clear_api_key.checked) body.clear_api_key = true;
    body.stream = Boolean(controls.stream.checked);
    body.disable_thinking = Boolean(controls.disable_thinking.checked);
    const payload = await this.operation(() => this.fetch("/config", body), "API 配置已保存。");
    if (payload) { controls.api_key.value = ""; controls.clear_api_key.checked = false; await this.refreshMeta({ quiet: true }); }
  }

  async activateProvider() {
    const id = this.dom.providerSelect.value;
    if (!id) return;
    const payload = await this.operation(() => this.fetch("/activate-provider", { id }), "已切换 API 连接。");
    if (payload) {
      this.dom.config.api_key.value = "";
      this.dom.config.clear_api_key.checked = false;
      await this.refreshMeta({ quiet: true });
    }
  }

  async savePreset(update) {
    const name = this.dom.presetName.value.trim();
    const instructions = this.dom.presetInstructions.value.trim();
    if (!name || !instructions) { this.status("请填写预设名称和基础创作指令。", true); return; }
    const body = { name, instructions, mode: this.dom.presetMode.value === "replace" ? "replace" : "append" };
    if (update) body.id = this.value("preset");
    const payload = await this.operation(() => this.fetch("/presets", body), "创作预设已保存。");
    if (!payload) return;
    const id = payload.preset?.id || payload.id;
    if (id) this.write("preset", id);
    await this.refreshMeta({ quiet: true });
  }

  async deletePreset() {
    const id = String(this.value("preset"));
    const preset = this.meta.presets.find((item) => item.id === id);
    if (!preset || preset.builtin || preset.editable === false) return;
    const payload = await this.operation(() => this.fetch(`/presets/${encodeURIComponent(id)}`, undefined, "DELETE"), "创作预设已删除。");
    if (payload) { this.write("preset", ""); await this.refreshMeta({ quiet: true }); }
  }

  async copyPrompt() {
    const prompt = String(this.value("approved_prompt"));
    if (!prompt) return;
    try { await navigator.clipboard.writeText(prompt); if (!this.disposed) this.status("Final Prompt 已复制。"); }
    catch { if (!this.disposed) this.status("复制失败，请选中 Final Prompt 手动复制。", true); }
  }

  applyExecutionResult(message) {
    if (this.disposed || this.busy) return;
    const unwrap = (value) => Array.isArray(value) ? value[0] : value;
    const prompt = unwrap(message?.prompt ?? message?.final_prompt);
    const response = unwrap(message?.message ?? message?.agent_response);
    const state = unwrap(message?.state);
    const interrogation = unwrap(message?.interrogation);
    if (interrogation && typeof interrogation === "object") {
      this.interrogationResult = interrogation;
      this.renderInterrogationResult();
    }
    if (normalizeExecutionValue(this.value("execution")) === "snapshot") {
      if (typeof prompt === "string") {
        this.write("approved_prompt", prompt);
        this.write("approved_profile", state?.profile || this.value("profile"));
      }
      if (typeof response === "string") this.write("agent_response", response);
      this.restoreEditors();
      this.status("已输出保存的 Final Prompt。");
      return;
    }
    if (typeof prompt === "string") this.applyResult({ prompt, message: typeof response === "string" ? response : "", state, warnings: unwrap(message?.warnings) || [] });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.progressAPI?.removeEventListener?.("tk_prompt_agent_interrogation", this.interrogationProgressListener);
    this.invalidate();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    if (SESSION_OWNERS.get(this.session) === this) SESSION_OWNERS.delete(this.session);
    this.sizeSync?.dispose();
    this.root?.remove();
  }
}

export function registerPromptAgent(app) {
  app.registerExtension({
    name: "TK.PromptAgent.Widget",
    beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_NAME || nodeType.prototype._tkPromptAgentRegistered) return;
      nodeType.prototype._tkPromptAgentRegistered = true;
      const originalCreated = nodeType.prototype.onNodeCreated;
      const originalConfigure = nodeType.prototype.onConfigure;
      const originalRemoved = nodeType.prototype.onRemoved;
      const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
      const originalExecuted = nodeType.prototype.onExecuted;
      nodeType.prototype.onNodeCreated = function () {
        const result = originalCreated?.apply(this, arguments);
        if (this._tkPromptAgentUI) return result;
        const ui = new PromptAgentUI(this);
        this._tkPromptAgentUI = ui;
        const root = ui.build();
        const widget = this.addDOMWidget?.("tk_prompt_agent", "custom", root, { serialize: false, hideOnZoom: false });
        if (widget) widget.serialize = false;
        ui.mount(widget);
        if (!this.properties?.tkPromptAgentInitialized) {
          this.setSize?.([Math.max(460, this.size?.[0] || 0), 860]);
          this.properties = { ...(this.properties || {}), tkPromptAgentInitialized: true };
        }
        return result;
      };
      nodeType.prototype.onConfigure = function () {
        const result = originalConfigure?.apply(this, arguments);
        const savedValues = arguments[0]?.widgets_values;
        // LiteGraph leaves new widgets at their creation default when restoring
        // a shorter legacy array. Detect the saved contract, not that default.
        if (Array.isArray(savedValues) && savedValues.length <= INPUT_NAMES.indexOf("generation_strategy")) {
          this._tkPromptAgentUI?.write("generation_strategy", "guided");
          this._tkPromptAgentUI?.invalidate();
        }
        setTimeout(() => this._tkPromptAgentUI?.restore(), 0);
        return result;
      };
      nodeType.prototype.onConnectionsChange = function () {
        const result = originalConnectionsChange?.apply(this, arguments);
        this._tkPromptAgentUI?.refreshConnections();
        return result;
      };
      nodeType.prototype.onExecuted = function (message) {
        const result = originalExecuted?.apply(this, arguments);
        this._tkPromptAgentUI?.applyExecutionResult(message);
        return result;
      };
      nodeType.prototype.onRemoved = function () {
        this._tkPromptAgentUI?.dispose();
        return originalRemoved?.apply(this, arguments);
      };
    },
  });
}

function init() {
  const app = globalThis.window?.comfyAPI?.app?.app;
  if (!app?.registerExtension) { setTimeout(init, 500); return; }
  registerPromptAgent(app);
}

if (typeof window !== "undefined") init();
