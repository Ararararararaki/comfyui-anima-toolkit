import { uiText } from "./anima_node_i18n.js";
import { installDOMWidgetSizeSync } from "./anima_dom_widget_size_sync.js";

const NODE_NAME = "TkPromptAgent";
const SESSION_OWNERS = new Map();
const API_ROOT = "/anima/prompt-agent";
const MODES = () => [["create", uiText("创作", "Create")], ["modify", uiText("修改", "Modify")], ["expand", uiText("扩写", "Expand")], ["rewrite", uiText("重写", "Rewrite")], ["convert", uiText("转换", "Convert")], ["optimize", uiText("优化", "Optimize")]];
// 扩写 skill 下拉里固定追加的「管理」哨兵值，选中它不写节点值、只打开管理面板
const MANAGE_SKILLS_VALUE = "__manage__";
const INPUT_NAMES = ["profile", "mode", "current_prompt", "user_instruction", "execution", "session_id", "preset", "custom_instructions", "locked_sections", "edit_scope", "approved_prompt", "agent_response", "approved_profile", "interrogation_source", "interrogation_image", "interrogation_action", "interrogation_options", "generation_strategy"];
const GENERATION_STRATEGIES = () => [["direct", uiText("快速直写", "Direct writing")], ["guided", uiText("按流程创作", "Guided creation")], ["native", uiText("DSH 原生", "DSH native")]];
const CONNECTION_FIELDS = ["base_url", "model", "api_key", "api_key_env", "clear_api_key"];
const IMAGE_SOURCES = () => [["local-wd14", uiText("本地 WD14", "Local WD14")], ["pixai-online", uiText("PixAI 在线", "PixAI online")], ["toriigate-online", uiText("ToriiGate 在线", "ToriiGate online")], ["workbuddy-vision", uiText("WorkBuddy 看图", "WorkBuddy vision")]];

function presetDisplayName(item) {
  const entries = {default:['默认创作助手','Default creation assistant'], concise:['精简有效','Concise and effective'], interaction:['人物与环境互动','Character and environment interaction']};
  const pair = item?.builtin && entries[item.id];
  return pair && item.name === pair[0] ? uiText(...pair) : item?.name || item?.id || '';
}
const SECTION_DISPLAY = {
  subject:['主体','Subject'], character_identity:['角色身份','Character identity'], appearance:['人物特征','Appearance'],
  clothing:['服装','Clothing'], expression:['表情','Expression'], pose:['动作','Pose'], interaction:['互动','Interaction'],
  camera:['镜头','Camera'], composition:['构图','Composition'], environment:['环境','Environment'], lighting:['光照','Lighting'],
  effects:['效果','Effects'], special_constraints:['特殊约束','Special constraints'],
};
function sectionDisplayName(section) {
  const pair = SECTION_DISPLAY[section.id];
  return pair && section.label === pair[0] ? uiText(...pair) : section.label || section.id;
}

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
  link.href = new URL("../css/anima_prompt_agent.css?v=20261020-optional-characters", import.meta.url).href;
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
    // 已添加的 DSH skill：默认只内置两个基础 skill，其余由用户自己挑，
    // 否则本机上百个 skill 全塞进下拉根本没法用。存本机偏好（换工作流仍生效）。
    this.addedSkills = this.loadAddedSkills();
    this.disposed = false;
    this.busy = false;
    this.requestVersion = 0;
    this.controllers = new Set();
    this.nativeMeta = null;
    this.nativeMetaVersion = 0;
    this.nativeSettingsDirty = false;
    this.nativeOperation = null;
    this.activeTask = null;
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
      const labels = { preparing: uiText("正在读取图片…", "Reading image…"), uploading: uiText("正在上传图片到反推服务…", "Uploading image to caption service…"), queued: uiText("远端正在排队…", "Queued by remote service…"), processing: uiText("正在反推图片…", "Captioning image…"), expanding: uiText("正在结合原图与反推结果扩写…", "Expanding from the image and its caption / tags…"), completed: uiText("反推完成。", "Captioning complete."), cancelled: uiText("反推已中断，保留原来的 Final Prompt。", "Captioning interrupted; the previous Final Prompt is preserved.") };
      let message = labels[progress.stage];
      if (progress.stage === "queued" && Number.isFinite(progress.rank)) message += uiText(` 前方 ${Math.max(0, progress.rank)} 个任务。`, ` Ahead: ${Math.max(0, progress.rank)} tasks.`);
      if (progress.stage === "queued" && Number.isFinite(progress.rank_eta)) message += uiText(` 预计 ${Math.ceil(progress.rank_eta)} 秒。`, ` Estimated: ${Math.ceil(progress.rank_eta)} seconds.`);
      if (progress.stage === "llm_waiting") message = uiText(`正在请求 ${progress.model} · ${progress.protocol}，等待模型回复…`, `Requesting ${progress.model} · ${progress.protocol}; waiting for model response…`);
      if (progress.stage === "llm_receiving") message = uiText(`${progress.model} · ${progress.protocol} 正在返回内容，已收 ${Math.ceil((progress.received_bytes || 0) / 1024)} KiB，等待完整结果…`, `${progress.model} · ${progress.protocol} is streaming; received ${Math.ceil((progress.received_bytes || 0) / 1024)} KiB; waiting for the complete result…`);
      if (progress.stage === "failed") message = uiText(`反推失败：${progress.message}`, `Captioning failed: ${progress.message}`);
      if (progress.stage === "expansion_failed") message = uiText(`看图扩写失败：${progress.message}。已保留原始反推结果和原来的 Final Prompt。`, `Image expansion failed: ${progress.message}. Original caption and previous Final Prompt preserved.`);
      if (message) this.status(message, ["failed", "expansion_failed"].includes(progress.stage));
    };
    this.progressAPI?.addEventListener?.("tk_prompt_agent_interrogation", this.interrogationProgressListener);
    this.graphExecutionActive = false;
    this.graphPromptId = null;
    this.graphListeners = {
      executing: (event) => {
        // ComfyApi emits only the node id; older hosts expose the socket envelope.
        const detail = event.detail;
        const data = detail !== null && typeof detail === "object" ? detail : { node: detail };
        if (this.disposed) return;
        if (this.node.id != null && data.node != null && String(data.node) === String(this.node.id)) {
          this.graphExecutionActive = true;
          this.graphPromptId = data.prompt_id || null;
          const selected = this.interrogationOptions().vision_model || uiText("连接默认模型", "Connection default model");
          this.markFinalPromptState(uiText("本轮正在执行；下方是上次保存的结果，新结果尚未返回。", "Running this request. The result below is from the previous run."));
          this.status(uiText("节点正在执行 · 本节点模型：", "Running · Node model: ") + selected + uiText("，等待本轮结果…", "; waiting for this run’s result…"));
        } else if (data.node == null && this.graphExecutionActive && this.matchesGraphPrompt(data)) {
          this.finishGraphExecution(uiText("本轮执行已结束，未收到新的 Prompt。", "The run ended without a new prompt."), true);
        }
      },
      execution_error: (event) => {
        const data = event.detail || {};
        if (this.disposed || this.node.id == null || String(data.node_id) !== String(this.node.id) || !this.matchesGraphPrompt(data)) return;
        this.finishGraphExecution(uiText("本轮执行失败：", "This run failed: ") + String(data.exception_message || uiText("请查看 ComfyUI 错误报告。", "See the ComfyUI error report.")).slice(0, 2000), true);
      },
      execution_interrupted: (event) => {
        if (!this.disposed && this.graphExecutionActive && this.matchesGraphPrompt(event.detail || {})) this.finishGraphExecution(uiText("本轮执行已中断。", "This run was interrupted."), true);
      },
    };
    for (const [type, listener] of Object.entries(this.graphListeners)) this.progressAPI?.addEventListener?.(type, listener);
  }

  matchesGraphPrompt(data) {
    return !this.graphPromptId || !data.prompt_id || data.prompt_id === this.graphPromptId;
  }

  markFinalPromptState(message = "") {
    if (!this.dom.finalPromptState) return;
    this.dom.finalPromptState.textContent = message;
    this.dom.finalPromptState.hidden = !message;
  }

  finishGraphExecution(message, error) {
    this.graphExecutionActive = false;
    this.status(message, error);
    this.markFinalPromptState(error ? uiText("本轮执行失败或中断；下方仍是上次保存的结果，并非本轮输出。", "This run failed or was interrupted. The result below is the previously saved output.") : "");
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
    select.addEventListener("change", () => {
      // profile 是 COMBO 输入，只能取后端声明的 anima/krea2；skill id 不能直接写进去，
      // 统一由 writeSelectedSkill 处理（写 interrogation_options + 推导合法 profile）。
      if (name !== "profile") this.write(name, select.value);
      this.invalidate();
    });
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
    group.setAttribute("aria-label", uiText("创作方式", "Creation strategy"));
    this.dom.generationStrategies = {};
    for (const [id, label] of GENERATION_STRATEGIES()) {
      const choose = () => {
        if (normalizeGenerationStrategy(this.value("generation_strategy")) === id) return;
        this.write("generation_strategy", id);
        this.invalidate();
        this.loadPresetEditor();
        this.renderWorkflow();
        if (id === "native") void this.refreshNativeMeta();
      };
      const button = this.button(label, choose, "tk-pa-strategy");
      button.dataset.nativeStrategy = "true";
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const ids = GENERATION_STRATEGIES().map(([value]) => value);
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
    wrap.append(element("span", "tk-pa-label", uiText("创作方式", "Creation strategy")), group);
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
    this.dom.imageSettings = element("div", "tk-pa-settings-section");
    const toolbar = element("div", "tk-pa-toolbar");
    toolbar.append(
      field(uiText("扩写 Skill", "Expansion Skill"), this.select("profile", [], uiText("扩写 Skill", "Expansion Skill"))),

    );
    const creationOptions = element("div", "tk-pa-toolbar");
    creationOptions.append(field(uiText("操作", "Action"), this.select("mode", MODES(), uiText("操作", "Action"))),
      field(uiText("创作预设", "Creation preset"), this.select("preset", [["", uiText("默认", "Default")]], uiText("创作预设", "Creation preset"))));
    this.dom.editPreset = this.button(uiText("查看／编辑规则", "View / edit rules"), () => this.openPresetEditor());
    creationOptions.append(this.dom.editPreset);
    this.dom.presetHint = element("div", "tk-pa-note tk-pa-preset-hint");
    this.dom.preset.addEventListener("change", () => this.updatePresetHint());
    this.dom.profile.addEventListener("change", () => {
      const picked = this.dom.profile.value;
      if (picked === MANAGE_SKILLS_VALUE) {
        // 哨兵选项：不写节点值，只打开管理面板
        this.dom.profile.value = this.selectedSkillId() || "";
        this.openSkillManager();
        return;
      }
      this.writeSelectedSkill(picked);
      if (String(this.value("current_prompt")).trim()) {
        this.write("mode", "convert");
        this.dom.mode.value = "convert";
        this.status(uiText("已切换扩写 Skill，请发送转换指令后使用新的 Final Prompt。", "Expansion Skill changed. Send a conversion request to generate a new Final Prompt."));
      }
      this.interrogationResult = null;
      this.renderInterrogationResult();
      this.updateProfileHint();
      this.loadPresetEditor();
      this.renderWorkflow();
    });
    const tabs = element("div", "tk-pa-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", uiText("Prompt Agent 模式", "Prompt Agent mode"));
    this.dom.tabs = {};
    for (const [id, label] of [["create", uiText("创作", "Create")], ["interrogate", uiText("看图反推", "Image caption")]]) {
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
    const prompt = this.textarea("current_prompt", uiText("粘贴已有 Prompt，或留空从一个想法开始", "Paste a prompt, or leave blank to start with an idea"), 4);
    const instruction = this.textarea("user_instruction", uiText("例如：保留角色与服装，把背景改成雨夜车站", "Example: keep the character and outfit; change the background to a rainy station at night"), 3);
    instruction.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); this.edit(); }
    });
    this.dom.connectionHint = element("div", "tk-pa-note");
    this.dom.profileHint = element("div", "tk-pa-note");
    this.dom.workflowHint = element("div", "tk-pa-note tk-pa-strategy-hint");
    const actions = element("div", "tk-pa-actions");
    this.dom.send = this.button(uiText("发送编辑", "Send edit"), () => this.edit(), "tk-pa-primary");
    this.dom.send.title = "Ctrl / Cmd + Enter";
    this.dom.undo = this.button(uiText("撤销", "Undo"), () => this.sessionAction("undo"));
    this.dom.retry = this.button(uiText("重试", "Retry"), () => this.sessionAction("retry"));
    this.dom.clear = this.button(uiText("清空会话", "Clear session"), () => this.sessionAction("clear"));
    actions.append(this.dom.send, this.dom.undo, this.dom.retry, this.dom.clear);
    this.dom.status = element("div", "tk-pa-status", uiText("正在加载配置…", "Loading settings…"));
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
    this.dom.workflow = detail(uiText("本轮创作流程", "Current creation process"));
    this.dom.workflow.className = "tk-pa-details tk-pa-workflow";
    this.dom.workflow.open = true;
    this.dom.workflow.hidden = true;
    this.dom.workflowSteps = element("ol", "tk-pa-workflow-steps");
    this.dom.workflowSteps.setAttribute("aria-label", uiText("创作步骤结果", "Creation step results"));
    this.dom.workflow.append(this.dom.workflowSteps);
    response.append(this.dom.workflow);
    const history = detail(uiText("编辑记录", "Edit history"));
    history.className = "tk-pa-details tk-pa-history";
    this.dom.historyList = element("div", "tk-pa-history-list");
    history.append(this.dom.historyList);
    response.append(history);
    const final = element("section", "tk-pa-output");
    const finalHeader = element("div", "tk-pa-output-header");
    this.dom.copy = this.button(uiText("复制", "Copy"), () => this.copyPrompt(), "tk-pa-copy");
    this.dom.copy.dataset.keepEnabled = "true";
    finalHeader.append(element("span", "tk-pa-label", "Final Prompt"), this.dom.copy);
    this.dom.finalPromptState = element("div", "tk-pa-note");
    this.dom.finalPromptState.setAttribute("role", "status");
    this.dom.finalPromptState.hidden = true;
    final.append(finalHeader, this.dom.finalPromptState, this.textarea("approved_prompt", uiText("编辑成功后的 Prompt 会显示在这里", "Your edited prompt will appear here"), 4, true));
    const execution = element("div", "tk-pa-execution");
    execution.append(field(uiText("文字编辑行为", "Text editing behavior"), this.select("execution", [["snapshot", uiText("只输出已确认 Prompt", "Output confirmed prompt only")], ["execute", uiText("运行时执行文字指令", "Execute text instruction on run")]], uiText("文字编辑行为", "Text editing behavior"))));
    this.dom.executionHint = element("div", "tk-pa-note");
    this.dom.execution.addEventListener("change", () => this.updateExecutionHint());
    execution.append(this.dom.executionHint);
    const advanced = detail(uiText("高级设置", "Advanced settings"));
    advanced.append(field(uiText("本次附加指令", "Additional instructions"), this.textarea("custom_instructions", uiText("补充画面、风格或写法要求", "Additional composition, style or writing requirements"), 2)));
    this.dom.locks = element("div", "tk-pa-chips");
    this.dom.scope = element("div", "tk-pa-chips");
    advanced.append(field(uiText("锁定部分", "Locked sections"), this.dom.locks), field(uiText("仅编辑这些部分 · 留空按指令修改，不设默认锁定", "Edit only these sections; leave blank to follow the instruction without default locks"), this.dom.scope), this.buildReferences(), this.buildInterrogationConfig());
    this.buildConfig();
    creative.append(creationOptions, this.dom.presetHint, this.buildGenerationStrategies(), this.buildNativeSettings(), field(uiText("当前 Prompt", "Current prompt"), prompt),
      element("div", "tk-pa-note", uiText("当前 Prompt 留空时按本次指令创作新稿；明确锁定仍保留。", "Leave the current prompt blank to create a new draft. Explicit locks still apply.")),
      this.dom.connectionHint, field(uiText("你的指令", "Your instruction"), instruction), this.dom.workflowHint, actions, this.buildNativeProgress(), response);
    this.dom.mode.addEventListener("change", () => this.renderWorkflow());
    const presetEditor = this.buildPresetEditor();
    const imagePane = this.buildInterrogation();
    this.dom.settingsContent = element("div", "tk-pa-settings-content");
    this.dom.settingsContent.append(toolbar, this.dom.profileHint,
      this.dom.modelSettings, this.buildAuxiliarySkills(), this.dom.imageSettings, execution, advanced);
    const tools = element("div", "tk-pa-actions");
    this.dom.settingsButton = this.button(uiText("配置", "Settings"), () => this.openSettings());
    this.dom.settingsSummary = element("span", "tk-pa-note", uiText("模型、Skill、反推与过滤", "Model, Skills, captioning and filters"));
    tools.append(this.dom.settingsButton, this.dom.settingsSummary);
    this.dom.modelUsage = element("div", "tk-pa-note");
    root.append(tabs, tools, this.dom.modelUsage, creative, imagePane, this.dom.status, this.dom.rawInterrogationPanel, final);
    this.restoreEditors();
    this.setTab(this.activeTab);
    this.refreshConnections();
    this.updateExecutionHint();
    this.refreshMeta();
    return root;
  }

  openSettings() {
    if (!this.dom.settingsDialog) {
      const dialog = element("dialog", "tk-pa-dialog tk-pa-settings-dialog");
      dialog.setAttribute("aria-label", uiText("Prompt Agent 配置", "Prompt Agent settings"));
      const head = element("div", "tk-pa-dialog-head");
      head.append(element("b", "", uiText("Prompt Agent 配置", "Prompt Agent settings")), this.button(uiText("完成", "Done"), () => dialog.close()));
      dialog.append(head, this.dom.settingsContent);
      dialog.addEventListener("close", () => this.dom.settingsButton.focus?.());
      for (const type of ["pointerdown", "click", "wheel", "keydown"]) dialog.addEventListener(type, event => event.stopPropagation());
      document.body.append(dialog);
      this.dom.settingsDialog = dialog;
    }
    this.renderAuxiliarySkills();
    this.dom.settingsDialog.showModal();
  }

  openConnectionManager() {
    if (!this.dom.connectionDialog) {
      const dialog = element("dialog", "tk-pa-dialog tk-pa-settings-dialog");
      dialog.setAttribute("aria-label", uiText("连接管理", "Connections"));
      const head = element("div", "tk-pa-dialog-head");
      head.append(element("strong", "", uiText("连接管理", "Connections")), this.button(uiText("完成", "Done"), () => dialog.close()));
      const content = element("div", "tk-pa-settings-content");
      content.append(this.dom.providerSettings);
      dialog.append(head, content);
      for (const type of ["pointerdown", "click", "wheel", "keydown"]) dialog.addEventListener(type, event => event.stopPropagation());
      dialog.addEventListener("close", () => this.dom.manageConnection?.focus?.());
      document.body.append(dialog);
      this.dom.connectionDialog = dialog;
    }
    this.dom.providerSettings.open = true;
    if (!this.dom.connectionDialog.open) this.dom.connectionDialog.showModal();
  }

  openPresetEditor() {
    if (!this.dom.presetDialog) {
      const dialog = element("dialog", "tk-pa-dialog tk-pa-settings-dialog");
      const head = element("div", "tk-pa-dialog-head");
      head.append(element("strong", "", uiText("创作预设 · 查看与编辑", "Creation presets · View and edit")), this.button(uiText("完成", "Done"), () => dialog.close()));
      const content = element("div", "tk-pa-settings-content");
      content.append(this.dom.presetEditor);
      dialog.append(head, content);
      for (const type of ["pointerdown", "pointerup", "click", "dblclick", "wheel", "keydown"]) dialog.addEventListener(type, event => event.stopPropagation());
      dialog.addEventListener("close", () => this.dom.editPreset?.focus?.());
      document.body.append(dialog);
      this.dom.presetDialog = dialog;
    }
    this.loadPresetEditor();
    this.dom.presetEditor.hidden = false;
    this.dom.presetEditor.open = true;
    if (!this.dom.presetDialog.open) this.dom.presetDialog.showModal();
  }

  buildTagFilters() {
    const wrap = detail(uiText("标签过滤与角色检索", "Tag filters and character lookup"));
    this.dom.filters = {};
    for (const [key, title, fallback] of [["watermarks", uiText("过滤水印与署名", "Remove watermarks and signatures"), true], ["text", uiText("过滤画面文字（关闭则保留文字）", "Remove image text (disable to preserve it)"), false], ["quality", uiText("过滤质量元词", "Remove quality tags"), false], ["artist", uiText("过滤画师标签", "Remove artist tags"), false]]) {
      const input = element("input"); input.type = "checkbox";
      input.checked = this.interrogationOptions().tag_filters?.[key] ?? fallback;
      this.dom.filters[key] = input;
      input.addEventListener("change", () => this.writeExpansionOption("tag_filters", {
        ...this.interrogationOptions().tag_filters, [key]: input.checked,
      }));
      wrap.append(field(title, input));
    }
    wrap.append(element("div", "tk-pa-note", uiText("角色替换可选：直接在扩写要求写出换谁／加入谁，LLM 会自动查询本地词库与 AnimaDex；未要求就不替换，无需在设置里填写。", "Character replacement is optional. Specify who to replace or add in the expansion instruction; the LLM looks them up in the local tag library and AnimaDex. No replacement is made unless requested.")));
    return wrap;
  }

  buildAuxiliarySkills() {
    const wrap = detail(uiText("辅助 Skill · 可多选", "Additional Skills · Multiple selection"));
    wrap.append(element("div", "tk-pa-note", uiText("上方主 Skill 决定输出格式；最多叠加 4 个辅助 Skill。辅助规则不能改变主格式。", "The primary Skill determines the output format. Add up to four supporting Skills without changing that format.")));
    this.dom.auxiliarySkills = element("div", "tk-pa-dialog-list");
    wrap.append(this.dom.auxiliarySkills);
    return wrap;
  }

  renderAuxiliarySkills() {
    if (!this.dom.auxiliarySkills) return;
    const picked = new Set(this.interrogationOptions().auxiliary_skills || []);
    this.dom.auxiliarySkills.replaceChildren();
    for (const item of this.meta.skills || []) {
      if (item.source === "builtin" || item.id === this.selectedSkillId() || item.id === "dsh:moss-image-prompt-enhancer") continue;
      const input = element("input"); input.type = "checkbox"; input.checked = picked.has(item.id);
      input.addEventListener("change", () => {
        if (input.checked && picked.size >= 4) { input.checked = false; this.status(uiText("最多选择 4 个辅助 Skill。", "Select up to four additional Skills."), true); return; }
        if (input.checked) picked.add(item.id); else picked.delete(item.id);
        this.writeExpansionOption("auxiliary_skills", [...picked]);
      });
      const row = element("label", "tk-pa-skill-row");
      row.append(input, element("span", "tk-pa-skill-name", item.label || item.id));
      this.dom.auxiliarySkills.append(row);
    }
  }

  async loadVisionModels() {
    const source = this.dom.expansion.vision_provider.value;
    const payload = await this.operation(() => this.fetch("/vision-models", { source }), uiText("模型列表已读取；未知能力的模型需要自行确认是否支持图片。", "Model list loaded. Check image support for models with unknown capabilities."));
    if (!payload || source !== this.dom.expansion.vision_provider.value) return;
    this.dom.visionModels.replaceChildren(option("", uiText("选择模型（留空跟随默认）", "Choose a model (blank uses default)")), ...payload.models.map(item => option(item.id, item.id + (item.vision === true ? uiText(" · 支持图片", " · Image input") : item.vision === false ? uiText(" · 仅文字", " · Text only") : uiText(" · 图片能力未知", " · Image support unknown")))));
    // Text-only models remain selectable for creation; catalog labels disclose image capability.
    this.updateModelHint();
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
    const fields = [this.dom.mode?.parentElement, this.dom.preset?.parentElement, this.dom.presetHint, this.dom.presetEditor];
    for (const item of fields) if (item) item.hidden = this.activeTab !== "create";
    this.sizeSync?.request?.();
  }

  buildInterrogation() {
    const pane = element("section", "tk-pa-tab-content");
    pane.setAttribute("role", "tabpanel");
    this.dom.interrogate = pane;
    const drop = element("div", "tk-pa-image-drop");
    drop.tabIndex = 0;
    drop.setAttribute("aria-label", uiText("拖入或粘贴参考图片", "Drop or paste a reference image"));
    this.dom.imageDrop = drop;
    this.dom.imagePreview = element("img", "tk-pa-image-preview");
    this.dom.imagePreview.alt = uiText("反推参考图片", "Caption reference image");
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
    this.dom.chooseImage = this.button(uiText("选择图片", "Choose image"), () => this.dom.imageFile.click());
    this.dom.clearImage = this.button(uiText("移除图片", "Remove image"), () => {
      this.write("interrogation_image", "");
      this.invalidate();
      this.interrogationResult = null;
      this.renderImage();
      this.renderInterrogationResult();
    });
    imageActions.append(this.dom.chooseImage, this.dom.clearImage);
    drop.append(this.dom.imagePreview, element("div", "tk-pa-note", uiText("拖入图片，或点击此区域后粘贴图片", "Drop an image, or click here and paste")), this.dom.imageName, imageActions, this.dom.imageFile);
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
    const source = this.select("interrogation_source", IMAGE_SOURCES(), uiText("反推来源", "Caption source"));
    source.addEventListener("change", () => {
      this.interrogationResult = null;
      this.renderInterrogationResult();
      this.updateSourceHint();
      this.restoreInterrogationOptions();
    });
    this.dom.sourceHint = element("div", "tk-pa-note");
    this.dom.interrogateButton = this.button(uiText("开始反推", "Start captioning"), () => this.interrogate(), "tk-pa-primary");
    const run = element("div", "tk-pa-actions");
    run.append(this.dom.interrogateButton);
    const raw = detail(uiText("原始反推结果", "Original caption / tags"));
    raw.open = true;
    this.dom.rawInterrogationPanel = raw;
    this.dom.rawInterrogation = element("textarea", "tk-pa-input tk-pa-textarea");
    this.dom.rawInterrogation.readOnly = true;
    this.dom.rawInterrogation.rows = 3;
    this.dom.rawInterrogation.placeholder = uiText("显示来源返回的标签或描述", "Original tags or description returned by the source");
    raw.append(this.dom.rawInterrogation);
    const expansion = this.buildImageExpansion();
    this.dom.formattedInterrogation = element("textarea", "tk-pa-input tk-pa-textarea");
    this.dom.formattedInterrogation.readOnly = true;
    this.dom.formattedInterrogation.rows = 3;
    this.dom.formattedInterrogation.placeholder = uiText("反推后按当前模型 Profile 整理", "Format the caption using the current model Profile");
    this.dom.interrogationMessage = element("div", "tk-pa-note");
    this.dom.filterReport = element("div", "tk-pa-note");
    const accept = element("div", "tk-pa-actions");
    this.dom.replaceInterrogation = this.button(uiText("替换当前 Prompt", "Replace current prompt"), () => this.acceptInterrogation("replace"));
    this.dom.appendInterrogation = this.button(uiText("加入当前内容", "Append to current content"), () => this.acceptInterrogation("append"));
    accept.append(this.dom.replaceInterrogation, this.dom.appendInterrogation);
    const auto = this.select("interrogation_action", [["none", uiText("继续执行文字指令", "Continue with text instruction")], ["replace", uiText("反推并替换 Prompt", "Caption and replace prompt")], ["append", uiText("反推并加入当前内容", "Caption and append")]], uiText("节点运行方式", "Node run behavior"));
    auto.addEventListener("change", () => { this.node.properties.tkPromptAgentImageConfigured = true; this.updateExecutionHint(); });
    const upload = detail(uiText("手动上传参考图片", "Upload a reference image manually"));
    upload.append(drop, this.dom.imageConnectionHint);
    const debug = detail(uiText("手动调试与原始结果", "Manual testing and original result"));
    debug.append(run, this.dom.filterReport, field(uiText("候选 Prompt · 确认后更新 Final Prompt", "Candidate prompt · Confirm to update Final Prompt"), this.dom.formattedInterrogation), this.dom.interrogationMessage, accept);
    this.dom.imageSettings.append(upload, field(uiText("反推来源", "Caption source"), source), this.dom.sourceHint,
      this.dom.interrogationConfig.wd14_model_field, this.dom.interrogationConfig.threshold_fieldset,
      field(uiText("节点运行方式", "Node run behavior"), auto), this.buildTagFilters(), debug);
    pane.append(expansion);
    return pane;
  }

  buildImageExpansion() {
    const wrap = element("div", "tk-pa-field");
    this.dom.imageSettings.append(element("div", "tk-pa-note", uiText("看图扩写读取原图与过滤后的标签。图片发送给所选模型；配置即时保存到工作流。", "Image expansion uses the original image and filtered tags. The image is sent to the selected model; settings are saved to the workflow immediately.")));
    this.dom.expansion = {};
    this.dom.modelSettings = element("section", "tk-pa-field");
    this.dom.modelSettings.append(element("div", "tk-pa-label", uiText("本节点模型", "Node model")), element("div", "tk-pa-note", uiText("创作、角色指令解析和看图扩写共用此连接与模型。更改即时保存，下次请求生效；不会修改其他节点。", "Creation, character instruction parsing and image expansion share this connection and model. Changes apply to the next request and affect only this node.")));
    for (const [name, label, choices] of [
      ["expansion_mode", uiText("扩写方式", "Expansion mode"), [["faithful", uiText("忠实描述 · 还原原图", "Faithful description · Reproduce the image")], ["creative", uiText("创作扩写 · 按指令调整", "Creative expansion · Follow instructions")]]],
      ["vision_provider", uiText("连接来源", "Connection source"), [["current", uiText("已保存的默认连接", "Saved default connection")], ["manual", uiText("本机独立连接", "Local connection")], ["workbuddy", "WorkBuddy"], ["dsh-active", uiText("DSH 当前连接", "Current DSH connection")], ["dsh-workbuddy", uiText("DSH 实时 · WorkBuddy", "Live DSH · WorkBuddy")], ["dsh-opencode", uiText("DSH 实时 · OpenCode", "Live DSH · OpenCode")]]],
    ]) {
      const control = element("select", "tk-pa-input");
      control.append(...choices.map(([id, title]) => option(id, title)));
      this.dom.expansion[name] = control;
      control.addEventListener("change", () => {
        this.writeExpansionOption(name, control.value);
        if (name === "vision_provider") {
          this.writeExpansionOption("vision_model", "");
          if (this.dom.expansion.vision_model) this.dom.expansion.vision_model.value = "";
          this.dom.visionModels?.replaceChildren(option("", uiText("读取该连接的模型列表", "Load models from this connection")));
        }
      });
      (name === "vision_provider" ? this.dom.modelSettings : this.dom.imageSettings).append(field(label, control));
    }
    const model = element("input", "tk-pa-input");
    model.placeholder = uiText("留空跟随连接默认模型；也可填写模型 ID", "Leave blank for the connection default, or enter a model ID");
    this.dom.expansion.vision_model = model;
    for (const event of ["input", "change"]) model.addEventListener(event, () => this.writeExpansionOption("vision_model", model.value.trim()));
    const models = element("select", "tk-pa-input");
    models.append(option("", uiText("读取模型列表后选择", "Load models to choose one")));
    this.dom.visionModels = models;
    models.addEventListener("change", () => { model.value = models.value; this.writeExpansionOption("vision_model", model.value); });
    this.dom.loadVisionModels = this.button(uiText("读取该连接的模型", "Load models"), () => this.loadVisionModels());
    this.dom.modelHint = element("div", "tk-pa-note");
    this.dom.manageConnection = this.button(uiText("管理连接与请求参数", "Manage connections and request parameters"), () => this.openConnectionManager());
    this.dom.modelSettings.append(field(uiText("模型 ID · 留空使用连接默认模型", "Model ID · Blank uses the connection default"), model), models, this.dom.loadVisionModels, this.dom.modelHint, this.dom.manageConnection);
    const instruction = element("textarea", "tk-pa-input tk-pa-textarea");
    instruction.rows = 3;
    instruction.placeholder = uiText("可留空。例如：保留角色与动作，加强电影感。", "Optional. Example: keep the character and action; add cinematic lighting.");
    this.dom.expansion.expansion_instruction = instruction;
    instruction.addEventListener("input", () => this.writeExpansionOption("expansion_instruction", instruction.value));
    wrap.append(field(uiText("扩写要求 · 可选", "Expansion instruction · Optional"), instruction));
    const outputLimit = element("input", "tk-pa-input");
    outputLimit.type = "number";
    outputLimit.min = "0";
    outputLimit.step = "1";
    this.dom.expansion.output_char_limit = outputLimit;
    outputLimit.addEventListener("change", () => {
      const value = Number(outputLimit.value);
      if (!Number.isSafeInteger(value) || value < 0) {
        this.status(uiText("输出长度提醒须为非负整数，0 表示不提醒。", "Output length warning must be a non-negative integer. 0 disables it."), true); return;
      }
      this.writeExpansionOption("output_char_limit", value);
    });
    this.dom.imageSettings.append(field(uiText("输出提示词长度提醒 · 字符数", "Output prompt length warning · Characters"), outputLimit),
      element("div", "tk-pa-note", uiText("默认 4000，0 表示不提醒。仅统计输出提示词，超长仍保留完整结果，不截断、不阻止出图；扩写要求不受此值限制。", "Default: 4000; 0 disables the warning. Only output characters are counted. Long outputs stay complete and do not block generation. Instructions have no character limit.")));
    const identity = element("input");
    identity.type = "checkbox";
    this.dom.expansion.preserve_identity = identity;
    identity.addEventListener("change", () => this.writeExpansionOption("preserve_identity", identity.checked));
    wrap.append(field(uiText("保留角色名称与人物特征", "Preserve character names and traits"), identity));
    const auto = element("input");
    auto.type = "checkbox";
    this.dom.expansion.auto_expand = auto;
    auto.addEventListener("change", () => this.writeExpansionOption("auto_expand", auto.checked));
    wrap.append(field(uiText("反推后自动看图扩写（含 IMAGE 连线运行）", "Expand automatically after captioning (including IMAGE input runs)"), auto));
    const actions = element("div", "tk-pa-actions");
    this.dom.expandInterrogation = this.button(uiText("看图扩写", "Expand from image"), () => this.expandInterrogation(), "tk-pa-primary");
    actions.append(this.dom.expandInterrogation);
    this.dom.imageSettings.append(actions);
    return wrap;
  }

  writeExpansionOption(name, value) {
    const previous = this.interrogationOptions()[name];
    this.write("interrogation_options", JSON.stringify({ ...this.interrogationOptions(), [name]: value }));
    this.invalidate();
    // Changing expansion settings reuses the observation; it never reruns the tagger.
    if (name === "vision_model" || name === "vision_provider") {
      this.renderInterrogationResult();
      this.updateModelHint();
      if (normalizeGenerationStrategy(this.value("generation_strategy")) === "native") this.renderNativeMeta();
      if (previous !== value) {
        this.markFinalPromptState(uiText("模型设置已切换；下方是上次保存的结果，尚未生成新结果。请重新运行节点。", "Model changed. The result below is from the previous run; run the node again for a new result."));
        this.status(this.graphExecutionActive ? uiText("模型设置已改变；正在执行的请求仍使用原设置，下次执行生效。", "Model settings changed. The running request keeps its original settings; changes apply to the next run.") : uiText("模型设置已切换，重新运行节点后生成新结果。", "Model changed. Run the node again for a new result."));
      }
    }
    this.updateActionState();
  }

  buildInterrogationConfig() {
    const wrap = detail(uiText("反推设置", "Captioning settings"));
    this.dom.interrogationConfig = {};
    const thresholds = element("div", "tk-pa-thresholds");
    for (const [name, label, fallback] of [["threshold", uiText("标签阈值", "Tag threshold"), 0.35], ["character_threshold", uiText("角色阈值", "Character threshold"), 0.85]]) {
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
    model.setAttribute("aria-label", uiText("本地 WD14 模型", "Local WD14 model"));
    this.dom.interrogationConfig.wd14_model = model;
    this.dom.interrogationConfig.wd14_model_field = field(uiText("本地 WD14 模型", "Local WD14 model"), model);
    this.dom.interrogationConfig.wd14_model_field.hidden = true;
    model.addEventListener("change", () => this.writeInterrogationOptions());
    const caption = element("select", "tk-pa-input");
    caption.append(option("short", uiText("简短描述", "Short caption")), option("min_structured_json", uiText("结构化描述", "Structured caption")));
    this.dom.interrogationConfig.caption_type = caption;
    caption.addEventListener("change", () => this.writeInterrogationOptions());
    const token = element("input", "tk-pa-input");
    token.type = "password"; token.autocomplete = "new-password";
    this.dom.interrogationConfig.hf_token = token;
    this.dom.hfTokenStatus = element("div", "tk-pa-note");
    const clear = element("input");
    clear.type = "checkbox";
    this.dom.interrogationConfig.clear_hf_token = clear;
    const clearLabel = element("label", "tk-pa-check", uiText("清除本机保存的 HF Token", "Clear saved HF Token"));
    clearLabel.prepend(clear);
    const timeout = element("input", "tk-pa-input");
    timeout.type = "number"; timeout.min = "1"; timeout.max = "600"; timeout.step = "1";
    this.dom.interrogationConfig.timeout = timeout;
    this.dom.saveInterrogationConfig = this.button(uiText("保存在线反推设置", "Save online caption settings"), () => this.saveInterrogationConfig());
    wrap.append(field(uiText("描述形式", "Caption format"), caption), field(uiText("在线反推等待上限（秒）", "Online caption timeout (seconds)"), timeout), element("div", "tk-pa-note", uiText("PixAI 免费 CPU 服务会排队，180 秒可能不够；可调高等待上限，最长 600 秒。", "PixAI’s free CPU service may queue requests. Increase the timeout if 180 seconds is insufficient; maximum: 600 seconds.")), field(uiText("HF Token · 可选，留空保留", "HF Token · Optional; blank keeps the saved token"), token), this.dom.hfTokenStatus, clearLabel, this.dom.saveInterrogationConfig);
    return wrap;
  }

  buildPresetEditor() {
    const wrap = detail(uiText("创作预设 · 查看与修改", "Creation presets · View and modify"));
    this.dom.presetEditor = wrap;
    this.dom.presetEditorNote = element("div", "tk-pa-note");
    this.dom.presetEffective = element("textarea", "tk-pa-input tk-pa-textarea");
    this.dom.presetEffective.rows = 5;
    this.dom.presetEffective.readOnly = true;
    this.dom.presetEffective.setAttribute("aria-label", uiText("当前生效的基础创作规则", "Active base creation rules"));
    const name = element("input", "tk-pa-input");
    name.type = "text";
    name.placeholder = uiText("预设名称", "Preset name");
    const mode = element("select", "tk-pa-input");
    mode.append(option("append", uiText("追加到基础创作指令", "Append to base instructions")), option("replace", uiText("替换基础创作指令", "Replace base instructions")));
    const instructions = element("textarea", "tk-pa-input tk-pa-textarea");
    instructions.rows = 4;
    instructions.placeholder = uiText("例如：强调自然光、真实材质，避免夸张修饰", "Example: emphasize natural light and realistic materials; avoid exaggerated effects");
    const actions = element("div", "tk-pa-actions");
    this.dom.presetName = name;
    this.dom.presetMode = mode;
    this.dom.presetInstructions = instructions;
    this.dom.savePreset = this.button(uiText("另存为新预设", "Save as new preset"), () => this.savePreset(false));
    this.dom.updatePreset = this.button(uiText("更新预设", "Update preset"), () => this.savePreset(true));
    this.dom.deletePreset = this.button(uiText("删除预设", "Delete preset"), () => this.deletePreset());
    this.dom.preset.addEventListener("change", () => this.loadPresetEditor());
    actions.append(this.dom.savePreset, this.dom.updatePreset, this.dom.deletePreset);
    wrap.append(this.dom.presetEditorNote, field(uiText("当前生效的基础创作规则 · 只读", "Active base creation rules · Read-only"), this.dom.presetEffective), field(uiText("我的预设名称", "My preset name"), name), field(uiText("规则如何生效", "How rules apply"), mode), field(uiText("编辑预设规则 · 保存后生效", "Edit preset rules · Save to apply"), instructions), actions);
    return wrap;
  }

  buildReferences() {
    const wrap = detail(uiText("创作资料核验", "Creation reference verification"));
    this.dom.referenceMode = element("select", "tk-pa-input");
    this.dom.referenceMode.setAttribute("aria-label", uiText("创作资料核验方式", "Reference verification mode"));
    this.dom.referenceMode.append(option("local", uiText("本地词库与人物库", "Local tag and character libraries")), option("online", uiText("本地优先 · 缺失标签联网核验", "Local first · Verify missing tags online")));
    this.dom.saveReferences = this.button(uiText("保存核验方式", "Save verification mode"), async () => {
      const payload = await this.operation(() => this.fetch("/config", { reference_mode: this.dom.referenceMode.value }), uiText("创作资料核验方式已保存。", "Reference verification mode saved."));
      if (payload) await this.refreshMeta({ quiet: true });
    });
    wrap.append(field(uiText("核验方式", "Verification mode"), this.dom.referenceMode), element("div", "tk-pa-note", uiText("新创作使用 Danbooru 词库与 AnimaDex 人物库。联网仅复核本地缺失标签，不需要登录；未收录不会自动删除自然语言或自定义词。", "New creations use the Danbooru tag library and AnimaDex character library. Online verification only checks missing local tags and needs no login. Unlisted prose and custom tags are preserved.")), this.dom.saveReferences);
    return wrap;
  }

  buildNativeSettings() {
    const wrap = detail(uiText("DSH 原生设置", "DSH native settings"));
    wrap.className = "tk-pa-details tk-pa-native-settings";
    this.dom.nativeSettings = wrap;
    this.dom.nativeHint = element("div", "tk-pa-note");
    this.dom.nativeConnection = this.button(uiText("选择 DSH 模型连接", "Choose a DSH model connection"), () => {
      if (!this.dom.settingsDialog?.open) this.openSettings();
      this.dom.expansion?.vision_provider?.focus?.();
      this.status(uiText("在‘本节点模型’中选择 DSH 当前连接、WorkBuddy 或 OpenCode，即时生效于下次请求。", "Choose current DSH, WorkBuddy or OpenCode under Node model. Changes apply to the next request."));
    });
    const row = element("div", "tk-pa-native-options");
    this.dom.nativeWorkspace = element("select", "tk-pa-input");
    this.dom.nativeWorkspace.setAttribute("aria-label", uiText("DSH 工作目录", "DSH working directory"));
    this.dom.nativePreset = element("select", "tk-pa-input");
    this.dom.nativePreset.setAttribute("aria-label", uiText("DSH Agent 预设", "DSH Agent preset"));
    this.dom.nativeSkill = element("input", "tk-pa-input");
    this.dom.nativeSkill.placeholder = uiText("留空由 DSH 自动选用 skill", "Leave blank for DSH to choose a Skill");
    for (const control of [this.dom.nativeWorkspace, this.dom.nativePreset, this.dom.nativeSkill]) {
      control.addEventListener(control === this.dom.nativeSkill ? "input" : "change", () => {
        this.nativeSettingsDirty = true;
        this.invalidate();
      });
    }
    row.append(field(uiText("工作目录", "Working directory"), this.dom.nativeWorkspace), field(uiText("Agent 预设", "Agent preset"), this.dom.nativePreset));
    this.dom.saveNative = this.button(uiText("保存原生设置", "Save native settings"), () => this.saveNativeConfig());
    wrap.append(this.dom.nativeHint, this.dom.nativeConnection, row, field(uiText("优先使用的 skill", "Preferred Skill"), this.dom.nativeSkill),
      element("div", "tk-pa-note", uiText("原生会话读取该目录与 DSH 的 skill、原生配置和工具。实际工具过程可在 DSH 中查看。", "Native sessions use this directory together with DSH Skills, settings and tools. View tool activity in DSH.")), this.dom.saveNative);
    return wrap;
  }

  buildNativeProgress() {
    const wrap = element("section", "tk-pa-native-progress");
    wrap.hidden = true;
    wrap.setAttribute("aria-label", uiText("DSH 原生执行进度", "DSH native progress"));
    this.dom.nativeProgress = wrap;
    const heading = element("div", "tk-pa-native-progress-header");
    this.dom.nativeProgressLabel = element("span", "tk-pa-label", uiText("DSH 原生", "DSH native"));
    this.dom.cancelNative = this.button(uiText("取消本次执行", "Cancel this run"), () => {
      this.invalidate();
      this.status(uiText("已请求取消本次执行，保留已确认的 Final Prompt。", "Cancellation requested. The confirmed Final Prompt is preserved."));
    });
    this.dom.cancelNative.dataset.keepEnabled = "true";
    this.dom.nativeProcessLink = element("a", "tk-pa-native-link", uiText("查看 DSH 过程", "View DSH activity"));
    this.dom.nativeProcessLink.target = "_blank";
    this.dom.nativeProcessLink.rel = "noopener noreferrer";
    this.dom.nativeProcessLink.hidden = true;
    heading.append(this.dom.nativeProgressLabel, this.dom.nativeProcessLink, this.dom.cancelNative);
    this.dom.nativeProgressMessage = element("div", "tk-pa-note");
    this.dom.nativeProgressMessage.setAttribute("role", "status");
    this.dom.nativeProgressMessage.setAttribute("aria-live", "polite");
    this.dom.nativeProgressBar = element("div", "tk-pa-native-progress-bar");
    this.dom.nativeProgressBar.setAttribute("role", "progressbar");
    this.dom.nativeProgressBar.setAttribute("aria-label", uiText("DSH 正在执行", "DSH is running"));
    this.dom.nativeProgressBar.append(element("span"));
    wrap.append(heading, this.dom.nativeProgressMessage, this.dom.nativeProgressBar);
    return wrap;
  }

  async refreshNativeMeta() {
    const version = ++this.nativeMetaVersion;
    try {
      const payload = await this.fetch("/native/meta?source=" + encodeURIComponent(this.selectedProviderSource()));
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
    const nativeSource = this.selectedProviderSource().startsWith("dsh-");
    this.dom.nativeConnection.hidden = nativeSource;
    this.dom.nativeHint.textContent = !nativeSource
      ? uiText("先选用一个 DSH 模型连接。原生执行使用它的模型，不会自动切换账号。", "Choose a DSH model connection first. Native runs use its model without switching accounts.")
      : !info ? uiText("正在读取 DSH 工作目录和原生预设…", "Loading DSH directories and native presets…")
        : info.error ? String(info.error)
          : [this.selectedProviderSource(), this.modelSelection().model || uiText("连接默认模型", "Connection default model")].join(" · ");
    if (!nativeSource) this.dom.nativeSettings.open = true;
    this.updateActionState();
  }

  async saveNativeConfig() {
    const body = { workspace: this.dom.nativeWorkspace.value, agent_preset: this.dom.nativePreset.value, skill: this.dom.nativeSkill.value.trim() };
    const payload = await this.operation(() => this.fetch("/native/config", body), uiText("DSH 原生设置已保存。", "DSH native settings saved."));
    if (payload) {
      this.nativeSettingsDirty = false;
      await this.refreshNativeMeta();
    }
  }

  buildConfig() {
    const wrap = detail(uiText("连接管理 · 地址、凭据与请求参数", "Connections · URLs, credentials and request parameters"));
    this.dom.providerSettings = wrap;
    this.dom.config = {};
    wrap.append(element("div", "tk-pa-note", uiText("这里维护本机独立连接的地址与凭据。DSH 连接由 DSH 管理；当前使用的连接和模型只在上方‘本节点模型’选择。请求参数适用于本机 API 调用。", "Manage local connection URLs and credentials here. DSH manages its own connections. Choose the active connection and model under Node model. These request parameters apply to local API calls.")));
    this.dom.providerHint = element("div", "tk-pa-note");
    this.dom.providerError = element("div", "tk-pa-status tk-pa-provider-error");
    this.dom.providerError.setAttribute("role", "alert");
    wrap.append(this.dom.providerHint, this.dom.providerError);
    const input = (name, label, type = "text") => {
      const control = element("input", "tk-pa-input");
      control.type = type;
      control.autocomplete = "off";
      this.dom.config[name] = control;
      wrap.append(field(label, control));
      return control;
    };
    input("base_url", "Base URL");

    const key = input("api_key", uiText("API Key · 留空保留已有 Key", "API Key · Blank keeps the saved key"), "password");
    key.autocomplete = "new-password";
    this.dom.keyStatus = element("div", "tk-pa-note");
    const clearKey = element("input");
    clearKey.type = "checkbox";
    this.dom.config.clear_api_key = clearKey;
    const clearLabel = element("label", "tk-pa-check", uiText("清除本机保存的 API Key", "Clear saved API Key"));
    clearLabel.prepend(clearKey);
    wrap.append(this.dom.keyStatus, clearLabel);
    const tuning = detail(uiText("请求参数", "Request parameters"));
    for (const [name, label, min, max, step] of [["temperature", "Temperature", 0, 2, 0.1], ["max_tokens", uiText("最大输出 Token", "Maximum output tokens"), 1, 131072, 1], ["timeout", uiText("超时（秒）", "Timeout (seconds)"), 1, 600, 1]]) {
      const control = element("input", "tk-pa-input");
      control.type = "number";
      control.min = String(min);
      control.max = String(max);
      control.step = String(step);
      this.dom.config[name] = control;
      tuning.append(field(label, control));
    }
    const responseMode = element("select", "tk-pa-input");
    responseMode.append(option("json_schema", "JSON Schema"), option("json_object", "JSON Object"), option("text", uiText("兼容文本", "Compatible text")));
    this.dom.config.response_mode = responseMode;
    tuning.append(field(uiText("响应模式", "Response mode"), responseMode));
    for (const [name, label] of [["stream", uiText("流式传输", "Streaming")], ["disable_thinking", uiText("减少模型思考（支持时关闭）", "Reduce reasoning (disable where supported)")]]) {
      const control = element("input");
      control.type = "checkbox";
      this.dom.config[name] = control;
      const check = element("label", "tk-pa-check", label);
      check.prepend(control);
      tuning.append(check);
    }
    tuning.append(element("div", "tk-pa-note", uiText("Grok 4.5／4.6／4.7 不能完全关闭思考；勾选后使用低强度，未勾选跟随服务默认。", "Grok 4.5 / 4.6 / 4.7 cannot fully disable reasoning. Enable this for low effort, or leave disabled for the service default.")));
    for (const [name, label] of [["proxy", uiText("代理 URL · 留空自动检测", "Proxy URL · Blank auto-detects")], ["api_key_env", uiText("API Key 环境变量名称", "API Key environment variable")]]) {
      const control = element("input", "tk-pa-input");
      this.dom.config[name] = control;
      tuning.append(field(label, control));
    }
    this.dom.saveConfig = this.button(uiText("保存连接与请求参数", "Save connection and request parameters"), () => this.saveConfig());
    wrap.append(tuning, this.dom.saveConfig);
    return wrap;
  }

  mount(domWidget) {
    this.sizeSync = installDOMWidgetSizeSync({ node: this.node, domWidget, element: this.root, minHeight: 500, maxHeight: 1600, initialContentHeight: 760, nodeChromeHeight: 95 });
  }

  invalidate() {
    this.requestVersion++;
    if (this.activeTask) void this.cancelTask(this.activeTask);
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
    this.renderNativeProgress({ status: "pending", message: uiText("正在建立本次 DSH 原生会话…", "Starting a DSH native session…") }, operation);
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
        this.renderNativeProgress({ status: "running", message: uiText(`暂时无法读取进度：${error.message}`, `Progress temporarily unavailable: ${error.message}`) }, operation);
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
    const labels = { pending: uiText("准备中", "Preparing"), queued: uiText("排队中", "Queued"), running: uiText("执行中", "Running"), attention: uiText("需要处理", "Needs attention"), cancelling: uiText("取消中", "Cancelling"), completed: uiText("已完成", "Completed"), complete: uiText("已完成", "Completed"), failed: uiText("执行失败", "Failed"), cancelled: uiText("已取消", "Cancelled"), canceled: uiText("已取消", "Cancelled") };
    this.dom.nativeProgressLabel.textContent = uiText(`DSH 原生 · ${labels[status] || status}`, `DSH native · ${labels[status] || status}`);
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
    this.renderNativeProgress({ status: "cancelling", message: uiText("已发送取消请求，保留已确认的 Final Prompt。", "Cancellation sent. The confirmed Final Prompt is preserved.") }, operation);
    try {
      const payload = await cancellation;
      if (!this.disposed && this.nativeOperation === operation) this.renderNativeProgress({ ...payload, status: payload.status || "cancelling", message: payload.message || uiText("取消请求已确认。", "Cancellation confirmed.") }, operation);
    }
    catch (error) {
      if (!this.disposed) this.status(uiText(`取消请求未确认：${error.message}。请在 DSH 中查看本次执行。`, `Cancellation not confirmed: ${error.message}. Check this run in DSH.`), true);
    } finally { clearTimeout(timeout); }
  }

  status(message, error = false) {
    if (!this.dom.status) return;
    this.dom.status.textContent = message;
    this.dom.status.classList.toggle("is-error", error);
  }

  setBusy(value) {
    this.busy = value;
    if (this.root) for (const control of [...this.root.querySelectorAll("button, input, select, textarea"), ...(this.dom.settingsContent?.querySelectorAll("button, input, select, textarea") || []), ...(this.dom.presetDialog?.querySelectorAll("button, input, select, textarea") || []), ...(this.dom.connectionDialog?.querySelectorAll("button, input, select, textarea") || [])]) {
      if (control.dataset.keepEnabled === "true") continue;
      if (value && control.dataset.nativeStrategy === "true" && normalizeGenerationStrategy(this.value("generation_strategy")) === "native") continue;
      control.disabled = value;
    }
    if (this.dom.send) this.dom.send.textContent = value ? uiText("处理中…", "Processing…") : uiText("发送编辑", "Send edit");
    if (this.dom.cancelNative) this.dom.cancelNative.disabled = !this.activeTask && (!this.nativeOperation || this.nativeOperation.cancelled);
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
    if (this.dom.send && normalizeGenerationStrategy(this.value("generation_strategy")) === "native") {
      this.dom.send.disabled = !this.selectedProviderSource().startsWith("dsh-") || this.nativeMeta?.available === false;
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
    for (const name of CONNECTION_FIELDS) {
      const control = this.dom.config?.[name];
      if (!control) continue;
      control.disabled = this.busy;
      if (control.type !== "checkbox") control.readOnly = false;
    }
    if (this.dom.providerHint) this.dom.providerHint.textContent = uiText("本机连接的修改会影响使用此连接的节点。DSH 地址和 Key 请在 DSH 管理。", "Local connection changes affect nodes using that connection. Manage DSH URLs and keys in DSH.");
    const error = this.modelSelection().source === "current" ? String(this.meta.provider_error || "") : "";
    if (this.dom.providerError) {
      this.dom.providerError.textContent = error;
      this.dom.providerError.hidden = !error;
    }
    if (this.dom.keyStatus) this.dom.keyStatus.textContent = (this.meta.manual_config || this.meta.config)?.api_key_set
      ? uiText("本机已配置 Key · 不会回传到浏览器或工作流", "Key saved locally · Never returned to the browser or workflow") : uiText("本机尚未配置 Key · 可使用环境变量", "No local key saved · Environment variables are supported");
  }

  async fetch(path, body, method = body === undefined ? "GET" : "POST", { controller = new AbortController(), track = true } = {}) {
    const api = globalThis.comfyAPI?.api?.api || globalThis.window?.comfyAPI?.api?.api || globalThis.window?.api;
    if (!api?.fetchApi) throw new Error(uiText("ComfyUI API 尚未就绪，请刷新页面", "ComfyUI API is not ready. Refresh the page."));
    if (track) this.controllers.add(controller);
    try {
      const response = await api.fetchApi(`${API_ROOT}${path}`, {
        method, cache: "no-store", signal: controller.signal,
        // Generation already has a bounded provider/native deadline. The host
        // defaults to 60s and would abort the browser while paid work continues.
        ...((method !== "GET" && (["/edit", "/interrogate", "/expand-interrogation"].includes(path) || /^\/session\/[^/]+\/retry$/.test(path))) ? { timeoutMs: null } : {}),
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(String(payload.error || payload.message || `HTTP ${response.status}`));
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "TimeoutError" || error.message === "Fetch timeout") {
        throw new Error(uiText("等待 ComfyUI 本机接口响应超时；不能据此判断模型请求是否失败。未自动重发，请先检查工作流队列状态。", "Timed out waiting for the local ComfyUI API. The model request may still be running. No retry was sent; check the workflow queue first."), { cause: error });
      }
      throw error;
    } finally { this.controllers.delete(controller); }
  }

  async cancelTask(task) {
    if (task.cancelled) return;
    task.cancelled = true;
    task.controller.abort();
    try { await this.fetch(`/tasks/${encodeURIComponent(task.id)}/cancel`, { session_id: task.session }, "POST", { track: false }); }
    catch (error) { if (!this.disposed) this.status(uiText(`取消请求未确认：${error.message}；请检查任务状态，勿重复提交。`, `Cancellation not confirmed: ${error.message}; check task status before submitting again.`), true); }
  }

  async runTask(path, body, { controller = new AbortController() } = {}) {
    const retry = /^\/session\/[^/]+\/retry$/.test(path);
    const request = retry ? { ...body, session_id: this.session } : body;
    const ticket = await this.fetch("/tasks", { kind: retry ? "retry" : path.slice(1), request }, "POST", { controller });
    if (!ticket.task_id) throw new Error(uiText("服务未返回任务编号；未自动重发，请刷新后检查服务版本。", "The service returned no task ID. No retry was sent; refresh and check the service version."));
    const task = { id: ticket.task_id, session: ticket.session_id, controller, cancelled: false };
    this.activeTask = task;
    this.dom.nativeProgress.hidden = false;
    this.dom.nativeProgressLabel.textContent = uiText("本轮任务 ", "Current task ") + task.id.slice(0, 8);
    this.dom.cancelNative.hidden = false;
    this.dom.cancelNative.disabled = false;
    try {
      while (true) {
        if (controller.signal.aborted || task.cancelled) throw new DOMException("Cancelled", "AbortError");
        const state = await this.fetch(`/tasks/${encodeURIComponent(task.id)}?session_id=${encodeURIComponent(task.session)}`, undefined, "GET", { controller });
        if (controller.signal.aborted || task.cancelled) throw new DOMException("Cancelled", "AbortError");
        this.dom.nativeProgressMessage.textContent = uiText(`模型：${state.model || "—"} · 阶段：${state.phase || state.status} · ${state.elapsed || 0} 秒`, `Model: ${state.model || "—"} · Stage: ${state.phase || state.status} · ${state.elapsed || 0} seconds`);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") {
          const error = new Error(state.error || uiText("本轮任务失败，未确认结果。", "This task failed; no result was confirmed."));
          error.status = state.error_status; throw error;
        }
        if (state.status === "cancelled") throw new DOMException("Cancelled", "AbortError");
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 500);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
    } finally {
      if (this.activeTask === task) this.activeTask = null;
      if (!this.nativeOperation) { this.dom.nativeProgress.hidden = true; this.dom.cancelNative.hidden = true; }
    }
  }

  async refreshMeta({ quiet = false } = {}) {
    try {
      const payload = await this.fetch("/meta");
      if (this.disposed) return;
      this.meta = { ...this.meta, ...payload };
      this.renderMeta();
      if (normalizeGenerationStrategy(this.value("generation_strategy")) === "native") await this.refreshNativeMeta();
      if (payload.provider_error) this.status(uiText(`模型连接不可用：${String(payload.provider_error)}`, `Model connection unavailable: ${String(payload.provider_error)}`), true);
      else if (!quiet) this.status(uiText("就绪 · 编辑成功后会保存最终 Prompt", "Ready · Successful edits save the Final Prompt"));
    } catch (error) { if (!this.disposed) this.status(uiText(`无法加载 Agent 配置：${error.message}`, `Could not load Agent settings: ${error.message}`), true); }
  }

  loadAddedSkills() {
    try {
      const raw = localStorage.getItem("tkPromptAgentAddedSkills");
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((id) => typeof id === "string" && id) : [];
    } catch { return []; }
  }

  saveAddedSkills(ids) {
    this.addedSkills = [...new Set(ids.filter((id) => typeof id === "string" && id))];
    try { localStorage.setItem("tkPromptAgentAddedSkills", JSON.stringify(this.addedSkills)); } catch { /* 隐私模式下不可写，本次会话内仍生效 */ }
  }

  /** 当前下拉应显示的 skill：内置始终在，DSH 的只显示已添加的；当前值永远保留。 */
  visibleSkills() {
    const all = Array.isArray(this.meta.skills) ? this.meta.skills : [];
    const builtin = all.filter((item) => item.source === "builtin");
    const added = all.filter((item) => item.source !== "builtin" && this.addedSkills.includes(item.id));
    const visible = [...builtin, ...added];
    const current = this.selectedSkillId() || String(this.value("profile", "") || "").trim();
    const resolved = current && !current.includes(":") ? `builtin:${current}` : current;
    if (resolved && !visible.some((item) => item.id === resolved)) {
      const found = all.find((item) => item.id === resolved);
      if (found) visible.push(found);
    }
    return visible;
  }

  /**
   * 扩写 skill 存在 interrogation_options.expansion_skill 里。
   * 它是自由 STRING，不像 profile 那样受 COMBO 校验 —— 把 dsh:xxx 写进 profile
   * 会让 ComfyUI 直接判「输入值不可用」并拒绝运行工作流（实测踩过）。
   */
  selectedSkillId() {
    const id = this.interrogationOptions().expansion_skill;
    return typeof id === "string" ? id.trim() : "";
  }

  writeSelectedSkill(id) {
    // Older servers expose profiles only; keep their legal combo values.
    if (!Array.isArray(this.meta.skills) && !String(id).includes(":")) {
      this.write("profile", id);
      return;
    }
    const skill = (this.meta.skills || []).find((item) => item.id === id);
    const options = { ...this.interrogationOptions(), expansion_skill: id || "" };
    this.write("interrogation_options", JSON.stringify(options));
    // profile 由 skill 的 style 推导：标签串 → anima，自然语言 → krea2，始终是合法 COMBO 值
    const profileId = skill ? (skill.style === "tags" ? "anima" : "krea2") : "";
    if (profileId && this.value("profile") !== profileId) this.write("profile", profileId);
  }

  /** 管理面板：内置 skill 恒可用，DSH 的勾选后才进下拉（否则上百个 skill 会撑爆下拉）。 */
  openSkillManager() {
    const all = (Array.isArray(this.meta.skills) ? this.meta.skills : []).filter((item) => item.source !== "builtin");
    const picked = new Set(this.addedSkills);
    const dialog = document.createElement("dialog");
    dialog.className = "tk-pa-dialog";

    const head = element("div", "tk-pa-dialog-head");
    head.append(element("b", "", uiText(`选择要添加的 Skill（共 ${all.length} 个）`, `Choose Skills to add (${all.length} total)`)), element("span", "", uiText("内置基础 skill 始终可用", "Built-in base Skills are always available")));
    const search = element("input", "tk-pa-dialog-search");
    search.placeholder = uiText("搜索名称或描述，例如 moss", "Search names or descriptions, e.g. moss");
    const list = element("div", "tk-pa-dialog-list");
    const actions = element("div", "tk-pa-dialog-actions");
    const cancel = element("button", "tk-pa-button", uiText("取消", "Cancel"));
    cancel.type = "button";
    const save = element("button", "tk-pa-button tk-pa-dialog-save", uiText("保存", "Save"));
    save.type = "button";
    actions.append(cancel, save);
    dialog.append(head, search, list, actions);

    const renderList = (keyword = "") => {
      const key = keyword.trim().toLowerCase();
      const rows = all.filter((item) => !key || `${item.id} ${item.label} ${item.description || ""}`.toLowerCase().includes(key));
      list.replaceChildren();
      if (!rows.length) { list.append(element("div", "tk-pa-note", uiText("没有匹配的 skill", "No matching Skills"))); return; }
      for (const item of rows) {
        const row = element("label", "tk-pa-skill-row");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = picked.has(item.id);
        box.addEventListener("change", () => { if (box.checked) picked.add(item.id); else picked.delete(item.id); });
        const text = element("span", "tk-pa-skill-name", item.label || item.id);
        text.title = item.description || item.id;
        row.append(box, text);
        list.append(row);
      }
    };
    renderList();
    search.addEventListener("input", () => renderList(search.value));
    cancel.addEventListener("click", () => dialog.close());
    save.addEventListener("click", () => {
      this.saveAddedSkills([...picked]);
      dialog.close();
      this.renderMeta();
      this.status(uiText(`已添加 ${picked.size} 个 Skill`, `Added ${picked.size} Skills`));
    });
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    search.focus();
  }

  restoreSkillSelection() {
    if (!this.dom.profile) return;
    if (!Array.isArray(this.meta.skills)) {
      this.dom.profile.replaceChildren(...(this.meta.profiles || []).map(item => option(item.id, item.label || item.id)));
      this.dom.profile.value = String(this.value("profile"));
      return;
    }
    const skills = this.visibleSkills();
    const stored = this.selectedSkillId();
    const profile = String(this.value("profile", "") || "").trim();
    const legacy = profile.includes(":") ? profile : `builtin:${profile}`;
    const active = stored || (skills.some(item => item.id === legacy) ? legacy : (skills[0]?.id || ""));
    this.dom.profile.replaceChildren(...skills.map(item => option(item.id, item.label || item.id)));
    if (active && !skills.some(item => item.id === active)) this.dom.profile.append(option(active, uiText(`${active}（不可用）`, `${active} (unavailable)`)));
    this.dom.profile.append(option(MANAGE_SKILLS_VALUE, uiText("＋ 管理 Skill…", "＋ Manage Skills…")));
    this.dom.profile.value = active;
    if (active && !stored) this.writeSelectedSkill(active);
  }

  renderMeta() {
    if (!this.node.properties?.tkPromptAgentDefaultApplied) {
      if ((!this.value("preset") || this.value("preset") === "default") && !String(this.value("current_prompt")).trim() && !this.history.length && this.meta.default_preset
        && this.meta.presets.some((entry) => entry.id === this.meta.default_preset)) this.write("preset", this.meta.default_preset);
      this.node.properties = { ...(this.node.properties || {}), tkPromptAgentDefaultApplied: true };
    }
    const preset = String(this.value("preset"));
    this.restoreSkillSelection();
    this.renderAuxiliarySkills();
    const defaultPreset = this.meta.presets.find((item) => item.id === "default");
    const choices = this.meta.presets.map((item) => option(item.id, presetDisplayName(item)));
    if (!preset && defaultPreset) {
      this.dom.preset.replaceChildren(option("", defaultPreset.name || uiText("默认", "Default")), ...choices.filter((item) => item.value !== "default"));
    } else this.dom.preset.replaceChildren(...choices);
    if (preset && !this.meta.presets.some((item) => item.id === preset)) this.dom.preset.append(option(preset, uiText("已保存预设（不可用）", "Saved preset (unavailable)")));
    this.dom.preset.value = preset;
    const picker = this.dom.expansion?.vision_provider;
    if (picker) {
      const selected = this.interrogationOptions().vision_provider || "current";
      const nativeChoices = (this.meta.native_providers || []).map(item => option(item.id, [item.name || item.id, item.model].filter(Boolean).join(" · ")));
      picker.replaceChildren(option("current", uiText("已保存的默认连接 · ", "Saved default connection · ") + (this.meta.provider_source || "manual") + " · " + (this.meta.config?.model || uiText("未配置", "Not configured"))), option("manual", uiText("本机独立连接", "Local connection")), ...nativeChoices,
        ...(this.meta.provider_presets || []).map(item => option(item.id, item.name || item.id)));
      if (!Array.from(picker.children).some(item => item.value === selected)) picker.append(option(selected, selected + uiText("（当前连接不可用）", " (current connection unavailable)")));
      picker.value = selected;
    }
    this.updateModelHint();
    this.renderSections();
    this.loadPresetEditor();
    this.updatePresetHint();
    this.updateProfileHint();
    const config = this.meta.manual_config || this.meta.config || {};
    const failedNative = false;
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
    const sourceLabels = new Map(IMAGE_SOURCES());
    const sources = (info.sources || IMAGE_SOURCES().map(([id, label]) => ({ id, label })))
      .map(source => ({ ...source, label: sourceLabels.get(source.id) || source.label }));
    const selected = this.value("interrogation_source", "local-wd14");
    this.dom.interrogation_source.replaceChildren(...sources.map((item) => option(item.id, item.label || item.id)));
    if (!sources.some((item) => item.id === selected)) this.dom.interrogation_source.append(option(selected, uiText(`${selected}（不可用）`, `${selected} (unavailable)`)));
    this.dom.interrogation_source.value = selected;
    const config = info.config || {};
    const models = info.models || info.wd14_models || config.wd14_models || [];
    const chosen = this.interrogationOptions().model || config.wd14_model || "";
    const model = this.dom.interrogationConfig.wd14_model;
    model.replaceChildren(...models.map((item) => option(typeof item === "string" ? item : item.id, typeof item === "string" ? item : item.label || item.id)));
    if (chosen && !models.some((item) => (typeof item === "string" ? item : item.id) === chosen)) model.append(option(chosen, chosen));
    model.value = chosen;
    this.dom.hfTokenStatus.textContent = config.hf_token_set ? uiText("已保存 HF Token · 不会回传或写入工作流", "HF Token saved · Never returned or stored in workflows") : uiText("未设置 HF Token · 在线来源可匿名尝试", "No HF Token · Online sources can try anonymous access");
    this.dom.interrogationConfig.timeout.value = String(config.timeout ?? 180);
    this.updateSourceHint();
    this.restoreInterrogationOptions();
  }

  updateSourceHint() {
    const source = this.meta.interrogation?.sources?.find((item) => item.id === this.value("interrogation_source"));
    const online = source?.kind === "online" || this.value("interrogation_source").endsWith("-online") || this.value("interrogation_source") === "workbuddy-vision";
    const notice = online ? uiText("图片会发送到所选服务。", "Images are sent to the selected service.") : uiText("在本机识别，不发送图片到在线服务。", "Processed locally without sending images to an online service.");
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
    for (const [name, fallback] of [["expansion_mode", "faithful"], ["vision_provider", "current"], ["expansion_instruction", ""], ["vision_model", ""], ["output_char_limit", 4000]]) {
      if (this.dom.expansion?.[name]) this.dom.expansion[name].value = String(options[name] ?? fallback);
    }
    if (this.dom.expansion?.auto_expand) this.dom.expansion.auto_expand.checked = options.auto_expand === true;
    for (const [key, control] of Object.entries(this.dom.filters || {})) control.checked = options.tag_filters?.[key] ?? (key === "watermarks");
    if (this.dom.characterQuery) this.dom.characterQuery.value = options.character_query || "";
    if (this.dom.expansion?.preserve_identity) this.dom.expansion.preserve_identity.checked = options.preserve_identity !== false;
  }

  writeInterrogationOptions() {
    const controls = this.dom.interrogationConfig;
    const options = { ...this.interrogationOptions() };
    for (const name of ["threshold", "character_threshold"]) {
      const value = Number(controls[name].value);
      if (!controls[name].value.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
        this.status(uiText("反推阈值需要在 0 到 1 之间。", "Caption thresholds must be between 0 and 1."), true); return;
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
      this.dom.imageName.textContent = uiText("尚未选择图片", "No image selected");
    }
    this.updateActionState();
    this.updateExecutionHint();
  }

  renderInterrogationResult() {
    if (!this.dom.rawInterrogation) return;
    const result = this.interrogationResult;
    if (this.dom.modelUsage) {
      const usage = result?.model_usage;
      const options = this.interrogationOptions();
      const changed = usage && ((options.vision_model && options.vision_model !== usage.requested) ||
        (usage.source && usage.source !== (options.vision_provider || "current")));
      const completed = Number.isFinite(usage?.completed_at) ? new Date(usage.completed_at * 1000).toLocaleString() : uiText("时间未记录", "Time not recorded");
      this.dom.modelUsage.textContent = usage ? uiText(`看图设置：${options.vision_model || uiText("跟随所选连接默认模型", "Use connection default model")}。${changed ? uiText("设置已更改，需重新运行才生效。", "Settings changed; run again to apply.") : ""}上次完成：${completed} · 最近一次请求：${usage.requested} · 服务返回：${usage.reported || uiText("未提供模型名", "Model name not reported")}${usage.protocol ? uiText(" · 接口：", " · Protocol: ") + usage.protocol : ""}${usage.reasoning_effort === "low" ? uiText(" · 思考：低强度", " · Reasoning: low") : ""}${usage.reported && usage.reported !== usage.requested ? uiText("（名称不同，请核对中转映射）", " (names differ; check proxy model mapping)") : ""}`, `Image model: ${options.vision_model || uiText("跟随所选连接默认模型", "Use connection default model")}.${changed ? uiText("设置已更改，需重新运行才生效。", "Settings changed; run again to apply.") : ""}Last completed: ${completed} · Last requested: ${usage.requested} · Reported: ${usage.reported || uiText("未提供模型名", "Model name not reported")}${usage.protocol ? uiText(" · 接口：", " · Protocol: ") + usage.protocol : ""}${usage.reasoning_effort === "low" ? uiText(" · 思考：低强度", " · Reasoning: low") : ""}${usage.reported && usage.reported !== usage.requested ? uiText("（名称不同，请核对中转映射）", " (names differ; check proxy model mapping)") : ""}`) : uiText(`本节点模型：${options.vision_model || uiText("跟随所选连接默认模型", "Use connection default model")} · ${options.vision_provider || uiText("默认连接", "Default connection")}`, `Node model: ${options.vision_model || uiText("跟随所选连接默认模型", "Use connection default model")} · ${options.vision_provider || uiText("默认连接", "Default connection")}`);
    }
    const tags = Array.isArray(result?.tags) ? result.tags.map((item) => typeof item === "string" ? item : item.tag || item.name || "").filter(Boolean).join(", ") : String(result?.tags || "");
    this.dom.rawInterrogation.value = [result?.caption, tags].filter(Boolean).join("\n\n");
    this.dom.formattedInterrogation.value = result?.formatted_prompt || "";
    if (this.dom.filterReport) {
      const report = result?.filter_report;
      const references = result?.reference_evidence?.characters || [];
      this.dom.filterReport.textContent = report ? uiText("过滤后保留 ", "Kept after filtering: ") + report.kept.length + uiText(" 个标签；移除：", " tags; removed: ") + (report.removed.map(item => item.tag + "（" + item.reason + "）").join("、") || uiText("无", "None")) +
        (references.length ? uiText("；角色资料：", "; character reference: ") + references.map(item => item.query + " · " + item.source).join("、") : "") : "";
    }
    const dimensions = Number.isInteger(result?.layout_width) && Number.isInteger(result?.layout_height)
      ? uiText(` Layout 画布：${result.layout_width}×${result.layout_height}；下游图像尺寸需一致。`, ` Layout canvas: ${result.layout_width}×${result.layout_height}; downstream image dimensions must match.`) : "";
    this.dom.interrogationMessage.textContent = result?.expansion_error
      ? uiText(`看图扩写失败：${result.expansion_error}。原始结果已保留，Final Prompt 未改变。`, `Image expansion failed: ${result.expansion_error}. Original result preserved; Final Prompt unchanged.`)
      : result ? String(result.message || uiText("确认候选结果后才会更新 Final Prompt；可继续在创作页修改。", "Confirm the candidate to update Final Prompt. You can continue editing in Create.")) + dimensions : uiText("反推先生成候选结果，不会自动覆盖当前 Prompt。", "Captioning produces a candidate first and does not overwrite the current prompt.");
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
        label.append(input, element("span", "", sectionDisplayName(section)));
        container.append(label);
      }
      if (!this.meta.sections.length) container.append(element("span", "tk-pa-note", uiText("配置加载后可选择", "Available after settings load")));
    }
  }

  loadPresetEditor() {
    const preset = this.meta.presets.find(item => item.id === (this.value("preset") || "default"));
    const profile = (this.meta.profiles || []).find(item => item.id === this.value("profile"));
    const strategy = normalizeGenerationStrategy(this.value("generation_strategy"));
    const base = strategy === "native" ? "" : strategy === "direct" ? profile?.direct_base_agent_prompt || "" : profile?.base_agent_prompt || "";
    const isDefault = preset?.id === "default";
    if (this.dom.presetName) this.dom.presetName.value = preset?.builtin ? uiText(`${preset.name || uiText("默认", "Default")} · 我的副本`, `${preset.name || uiText("默认", "Default")} · My copy`) : preset?.name || "";
    if (this.dom.presetMode) this.dom.presetMode.value = isDefault || preset?.mode === "replace" ? "replace" : "append";
    if (this.dom.presetInstructions) this.dom.presetInstructions.value = isDefault ? base : preset?.instructions || "";
    if (this.dom.savePreset) this.dom.savePreset.textContent = preset?.builtin ? uiText("保存为我的预设", "Save as my preset") : uiText("另存为新预设", "Save as new preset");
    this.updatePresetHint();
    this.updateActionState();
  }

  restoreEditors() {
    this.restoreSkillSelection();
    for (const name of ["mode", "preset", "current_prompt", "user_instruction", "custom_instructions", "approved_prompt", "interrogation_source", "interrogation_action"]) {
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
      if (!this.disposed && error.status !== 404) this.status(uiText(`会话恢复失败：${error.message}`, `Session restore failed: ${error.message}`), true);
    }
  }

  updateProfileHint() {
    // 提示改成「这个 skill 来自哪、做什么」，不再显示标签/自然语言这种模型侧术语
    const skills = Array.isArray(this.meta.skills) ? this.meta.skills : [];
    const item = skills.find((entry) => entry.id === this.selectedSkillId())
      || (this.meta.profiles || []).find((entry) => entry.id === this.value("profile"));
    if (this.dom.profile) this.dom.profile.title = item?.label || this.selectedSkillId() || uiText("扩写 Skill", "Expansion Skill");
    if (!this.dom.profileHint) return;
    if (!item) { this.dom.profileHint.textContent = ""; return; }
    const source = item.source === "dsh" ? "DSH skill" : item.source === "builtin" ? uiText("内置", "Built-in") : "";
    this.dom.profileHint.textContent = [item.description || item.style || "", source].filter(Boolean).join(" · ");
  }

  updateExecutionHint() {
    const action = this.value("interrogation_action", "none");
    if (!this.dom.executionHint) return;
    const hasImage = this.node.inputs?.some((input) => input.name === "image" && input.link != null)
      || parseImageDescriptor(this.value("interrogation_image"));
    if ((action === "replace" || action === "append") && hasImage) {
      this.dom.executionHint.textContent = uiText(`运行节点会识别输入图片并直接${action === "replace" ? "替换" : "加入"} Final Prompt；不需要填写当前 Prompt 或文字指令。在线来源会调用对应服务。`, `Running captions the input image and directly ${action === "replace" ? "替换" : "加入"} Final Prompt. No current prompt or text instruction is required. Online sources call their corresponding services.`);
    } else {
      const textBehavior = normalizeExecutionValue(this.value("execution")) === "execute"
        ? uiText("运行节点时会执行文字指令并调用当前 LLM。", "Running the node executes the text instruction using the current LLM.")
        : uiText("运行节点时输出已确认的 Final Prompt；创作编辑成功后才会更新它。", "Running outputs the confirmed Final Prompt. Successful creation edits update it.");
      this.dom.executionHint.textContent = (action !== "none" && !hasImage ? uiText("未提供图片，按文字编辑行为运行。", "No image supplied; using text editing behavior.") : "") + textBehavior;
    }
  }

  updatePresetHint() {
    if (!this.dom.presetHint) return;
    const selected = this.value("preset") || "default";
    const preset = this.meta.presets.find((entry) => entry.id === selected);
    const descriptions = {
      default: uiText("按 Anima / Krea 2 的 Profile 规则创作，不额外偏向某种内容。", "Create using the Anima / Krea 2 Profile rules without adding a content preference."),
      concise: uiText("保留少量具体有效的画面细节，不自动堆通用质量词或风格词。", "Use a few concrete visual details without padding with generic quality or style tags."),
      interaction: uiText("按你的要求补清人物与环境的空间和物理互动，并尊重锁定部分。", "Clarify spatial and physical interactions between characters and their environment, respecting locked sections."),
      "dsh-base": uiText("使用本机导入的 DSH 长基础提示词，替换默认创作基础。", "Replace the default creation base with the locally imported DSH base prompt."),
    };
    const description = descriptions[selected] || (preset?.mode === "replace"
      ? uiText("用此自定义预设替换默认创作基础。", "Replace the default creation base with this custom preset.") : uiText("在默认创作规则上追加此自定义预设。", "Append this custom preset to the default creation rules."));
    const native = normalizeGenerationStrategy(this.value("generation_strategy")) === "native";
    this.dom.presetHint.textContent = native ? uiText(`${description}DSH 原生会话会收到预设正文；规则合并由 DSH Agent 与 Skill 决定。点击“查看／编辑规则”调整。`, `${description}DSH native sessions receive the preset text; DSH Agent and Skills control rule merging. Use View / edit rules to adjust it.`) : uiText(`${description}仅影响文字创作，不改变 WD14 或看图扩写。点击“查看／编辑规则”可查看全文、调整并保存。`, `${description}Affects text creation only, not WD14 or image expansion. Use View / edit rules to inspect, edit and save.`);
    const profile = (this.meta.profiles || []).find(item => item.id === this.value("profile"));
    const base = normalizeGenerationStrategy(this.value("generation_strategy")) === "direct" ? profile?.direct_base_agent_prompt || "" : profile?.base_agent_prompt || "";
    const instructions = preset?.instructions || "";
    if (this.dom.presetEffective) this.dom.presetEffective.value = native ? instructions || uiText("默认预设没有附加正文；基础规则由 DSH Agent 与 Skill 提供。", "The default preset adds no text. DSH Agent and Skills provide the base rules.")
      : (preset?.mode === "replace" ? instructions : [base, instructions].filter(Boolean).join("\n\n")) || uiText("当前服务未提供规则正文，请刷新或更新服务。", "The service supplied no rule text. Refresh or update the service.");
    if (this.dom.presetEditorNote) this.dom.presetEditorNote.textContent = native
      ? uiText("原生会话会收到下方预设正文；此处的追加/替换选项不控制 DSH 的规则合并。修改后保存为自己的预设即可选用。", "Native sessions receive the preset text below. Append / replace here does not control DSH rule merging. Save changes as your own preset to use them.")
      : preset?.builtin
      ? uiText("内置预设可查看、修改后保存为自己的副本；保存后会自动选用。这里显示基础创作规则，Skill、格式及本次指令另行生效。", "View built-in presets and save changes as your own copy; the saved copy is selected automatically. These are base creation rules; Skills, format and the current instruction apply separately.")
      : uiText("修改后点击“更新预设”生效，也可另存副本。这里显示基础创作规则，Skill、格式及本次指令另行生效。", "Click Update preset to apply changes, or save a copy. These are base creation rules; Skills, format and the current instruction apply separately.");
  }

  refreshConnections() {
    const names = [];
    for (const [name, label] of [["current_prompt", uiText("当前 Prompt", "Current prompt")], ["user_instruction", uiText("用户指令", "User instruction")]]) {
      if (this.node.inputs?.some((input) => input.name === name && input.link != null)) names.push(label);
    }
    if (this.dom.connectionHint) this.dom.connectionHint.textContent = names.length
      ? uiText(`${names.join("、")}已连接：运行节点时读取连线，聊天编辑使用上方保存的文本。`, `${names.join("、")} connected: running reads connected inputs; chat edits use the saved text above.`) : "";
    const imageConnected = this.node.inputs?.some((input) => input.name === "image" && input.link != null);
    const imageLink = this.node.inputs?.find((input) => input.name === "image")?.link ?? null;
    if (this.imageLink !== undefined && this.imageLink !== imageLink) {
      this.invalidate();
      this.interrogationResult = null;
      this.renderInterrogationResult();
    }
    this.imageLink = imageLink;
    if (imageConnected && !this.node.properties?.tkPromptAgentImageConfigured) {
      this.node.properties = { ...this.node.properties, tkPromptAgentImageConfigured: true };
      if (this.value("interrogation_action") === "none") this.write("interrogation_action", "replace");
      if (this.interrogationOptions().auto_expand === undefined) this.writeExpansionOption("auto_expand", true);
      this.setTab("interrogate");
      this.restoreEditors();
    }
    if (this.dom.imageConnectionHint) this.dom.imageConnectionHint.textContent = imageConnected
      ? uiText("IMAGE 已连接。选择‘反推并替换/加入’，排队时会直接读取这张图并把 Prompt 输出到下游；无需填写文字输入。此页‘开始反推’使用上传的图片。", "IMAGE connected. Choose Caption and replace / append to process the connected image and output its prompt when queued. No text input is required. Start captioning on this page uses the uploaded image.")
      : uiText("连接 IMAGE 后选择‘反推并替换/加入’，排队时会直接反推并把 Prompt 输出到下游。", "Connect IMAGE and choose Caption and replace / append to caption it and output its prompt when queued.");
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
    if (this.dom.historyCount) this.dom.historyCount.textContent = this.history.length ? uiText(`${this.history.length} 轮编辑`, `${this.history.length} edits`) : "";
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
      const instruction = String(entry.instruction || uiText("编辑 Prompt", "Edit prompt"));
      item.append(element("summary", "", `${i + 1}. ${instruction}`));
      if (entry.message) item.append(element("div", "tk-pa-note", String(entry.message)));
      if (entry.workflow) item.append(this.workflowList(entry.workflow));
      item.append(element("div", "tk-pa-history-prompt", String(entry.prompt || "")));
      this.dom.historyList.append(item);
    }
    if (!this.history.length) this.dom.historyList.append(element("div", "tk-pa-note", uiText("还没有编辑记录。", "No edit history yet.")));
  }

  workflowList(workflow) {
    const list = element("ol", "tk-pa-workflow-steps");
    for (const step of Array.isArray(workflow?.steps) ? workflow.steps : []) {
      const item = element("li", "tk-pa-workflow-step");
      item.append(element("div", "tk-pa-workflow-label", String(step.label || uiText("创作步骤", "Creation steps"))),
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
        ? uiText("仅做去重与格式整理，保留画面内容，不调用 LLM。", "Deduplicate and format only, preserving visual content without an LLM call.")
        : strategy === "native"
          ? uiText("由 DSH 原生会话按 skill 流程创作，并可执行检索与校对工具。实际过程在 DSH 中记录；完成后回填 Final Prompt。", "A DSH native session follows the Skill process and can use lookup and checking tools. DSH records the activity; the completed result fills Final Prompt.")
        : strategy === "direct"
          ? hasProtection
            ? uiText("已选锁定或编辑范围：本轮使用分区编辑保留指定内容；首次可能需要额外分类。", "Locks or edit scope selected: section editing preserves the specified content. The first request may need extra classification.")
            : uiText("一次模型请求直接写英文正文；不执行查词、人物查询、联网核验或 DSH 脚本。", "One model request writes the English prompt directly, without tag lookup, character lookup, online verification or DSH scripts.")
          : uiText("新创作会整理需求、查询本地词条与人物资料，再生成并核对提示词；通常调用两次 LLM。高级设置可开启按需联网核验。", "New creation organizes requirements, looks up local tags and characters, then generates and checks the prompt, usually with two LLM calls. Advanced settings can enable online verification when needed.");
    }
    this.renderNativeMeta();
    this.updateProviderState();
  }

  applyResult(payload) {
    if (typeof (payload.prompt ?? payload.state?.prompt) === "string") this.markFinalPromptState();
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
    this.status(warnings.length ? warnings.join(" · ") : uiText("已保存 Final Prompt · 可以继续提出修改", "Final Prompt saved · You can continue editing"));
  }

  async operation(task, successMessage = "") {
    if (this.busy || this.disposed) return;
    this.claimSession();
    const capture = this.capture();
    this.setBusy(true);
    this.status(uiText("正在处理…", "Processing…"));
    try {
      const payload = await task(capture);
      if (!this.matches(capture)) {
        if (!this.disposed) {
          if (capture.session === this.session) this.acceptState(payload?.state, { prompt: false });
          this.status(uiText("草稿或模型已改变，未覆盖当前文本；可再次发送。", "The draft or model changed, so current text was preserved. Send again if needed."), true);
        }
        return;
      }
      if (successMessage) this.status(successMessage);
      else this.applyResult(payload);
      return payload;
    } catch (error) {
      if (this.disposed || error.name === "AbortError") return;
      this.status(uiText(`操作失败：${error.message}`, `Operation failed: ${error.message}`), true);
      if (error.status === 409 && capture.session === this.session) {
        try { const latest = await this.fetch(`/session/${encodeURIComponent(this.session)}`); if (!this.disposed) this.acceptState(latest.state, { prompt: false }); } catch { /* Preserve the original error and draft. */ }
      }
    } finally { if (!this.disposed) this.setBusy(false); }
  }

  updateModelHint() {
    if (!this.dom.modelHint) return;
    const selection = this.modelSelection();
    const connection = selection.source === "current" ? this.meta.config
      : selection.source === "manual" ? this.meta.manual_config || this.meta.config
      : (this.meta.native_providers || []).find(item => item.id === selection.source)
        || (this.meta.provider_presets || []).find(item => item.id === selection.source)?.config;
    const model = selection.model || connection?.model;
    this.dom.modelHint.textContent = uiText("生效模型：", "Active model: ") + (model || uiText("连接未提供默认模型，请填写模型 ID", "No connection default model; enter a model ID")) + uiText("。仅影响本节点，下次请求使用；图片任务需要模型支持图片输入。", ". Applies only to this node’s next request. Image tasks require image input support.");
    if (this.dom.expansion?.vision_model) this.dom.expansion.vision_model.placeholder = connection?.model ? uiText("默认：", "Default: ") + connection.model : uiText("填写该连接的模型 ID", "Enter a model ID for this connection");
  }

  modelSelection() {
    const options = this.interrogationOptions();
    return { source: options.vision_provider || "current", model: options.vision_model || "" };
  }

  selectedProviderSource() {
    const source = this.modelSelection().source;
    return source === "current" ? this.meta.provider_source || "manual" : source;
  }

  async edit() {
    if (normalizeGenerationStrategy(this.value("generation_strategy")) === "native") {
      if (!this.selectedProviderSource().startsWith("dsh-")) {
        this.renderNativeMeta();
        this.status(uiText("请先在模型连接来源中选用一个 DSH 连接。", "Choose a DSH connection first."), true);
        return;
      }
      if (this.nativeSettingsDirty) { this.status(uiText("请先保存 DSH 原生设置，再发送指令。", "Save DSH native settings before sending an instruction."), true); return; }
      if (this.nativeMeta?.available === false) { this.status(uiText(`DSH 原生不可用：${this.nativeMeta.error || uiText("请检查 DSH 是否正在运行", "Check that DSH is running")}`, `DSH native unavailable: ${this.nativeMeta.error || uiText("请检查 DSH 是否正在运行", "Check that DSH is running")}`), true); return; }
    }
    if (!String(this.value("user_instruction")).trim() && !["optimize", "convert"].includes(this.value("mode"))) { this.status(uiText("请先填写你的指令。", "Enter an instruction first."), true); return; }
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
        const payload = await this.runTask("/edit", {
      session_id: this.session, revision: this.revision, profile: this.value("profile"), mode: this.value("mode"),
      start_new: startNew,
      generation_strategy: strategy,
      model_selection: this.modelSelection(),
      ...(operation ? { native_operation_id: operation.id } : {}),
      current_prompt: this.value("current_prompt"), instruction: this.value("user_instruction"), preset: this.value("preset"),
      custom_instructions: this.value("custom_instructions"), locks: parseSectionIds(this.value("locked_sections")), scope: parseSectionIds(this.value("edit_scope")),
        }, operation ? { controller: operation.controller } : {});
        if (operation && !operation.cancelled && this.matches(capture)) this.renderNativeProgress({ status: "completed", message: uiText("原生创作已完成。", "Native creation complete.") }, operation);
        return payload;
      } catch (error) {
        if (operation && !operation.cancelled && this.matches(capture)) this.renderNativeProgress({ status: "failed", error: error.message }, operation);
        throw error;
      } finally { if (operation) this.finishNativeRun(operation); }
    });
  }

  async uploadImage(file) {
    if (!file || this.busy) return;
    if (file.type && !file.type.startsWith("image/")) { this.status(uiText("请选择图片文件。", "Choose an image file."), true); return; }
    const payload = await this.operation(async () => {
      const api = globalThis.comfyAPI?.api?.api || globalThis.window?.comfyAPI?.api?.api || globalThis.window?.api;
      if (!api?.fetchApi) throw new Error(uiText("ComfyUI API 尚未就绪，请刷新页面", "ComfyUI API is not ready. Refresh the page."));
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
        if (!image) throw new Error(uiText("上传服务没有返回图片位置", "The upload service returned no image location"));
        return { image };
      } finally { this.controllers.delete(controller); }
    }, uiText("图片已上传，可以开始反推。", "Image uploaded. Ready to caption."));
    if (!payload) return;
    this.write("interrogation_image", JSON.stringify(payload.image));
    this.invalidate();
    this.interrogationResult = null;
    this.renderImage();
    this.renderInterrogationResult();
  }

  async interrogate() {
    const image = parseImageDescriptor(this.value("interrogation_image"));
    if (!image) { this.status(uiText("请先上传或粘贴一张图片；IMAGE 连线在运行节点时读取。", "Upload or paste an image first. The IMAGE connection is read when the node runs."), true); return; }
    const payload = await this.operation(() => this.runTask("/interrogate", {
      session_id: this.session, profile: this.value("profile"), source: this.value("interrogation_source"), image, options: this.interrogationOptions(),
    }), uiText("反推完成 · 确认后更新 Final Prompt。", "Captioning complete · Confirm to update Final Prompt."));
    if (!payload) return;
    this.interrogationResult = payload;
    this.renderInterrogationResult();
    if (payload.expansion_error) this.status(this.dom.interrogationMessage.textContent, true);
  }

  async expandInterrogation() {
    const observation = this.interrogationResult;
    if (!observation?.observation_id) {
      this.status(uiText("请先反推图片，再对最近处理的原图进行扩写。", "Caption an image first, then expand from that image."), true);
      return;
    }
    const payload = await this.operation(() => {
      this.status(uiText("正在结合原图与反推结果扩写…", "Expanding from the image and its caption / tags…"));
      return this.runTask("/expand-interrogation", {
        session_id: this.session, profile: this.value("profile"), observation_id: observation.observation_id,
        options: this.interrogationOptions(),
      });
    }, uiText("看图扩写完成 · 确认候选后更新 Final Prompt。", "Image expansion complete · Confirm the candidate to update Final Prompt."));
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
      ...(this.selectedSkillId() ? { expansion_skill: this.selectedSkillId() } : {}),
      locks: parseSectionIds(this.value("locked_sections")),
    }));
    if (payload) {
      this.write("mode", "modify");
      this.restoreEditors();
      this.status(uiText("反推结果已确认 · 已更新 Final Prompt，可在创作页继续修改。", "Caption confirmed · Final Prompt updated. Continue editing in Create."));
    }
  }

  async saveInterrogationConfig() {
    const controls = this.dom.interrogationConfig;
    const body = {};
    const timeout = Number(controls.timeout.value);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) { this.status(uiText("在线反推等待上限需在 1 到 600 秒之间。", "Online caption timeout must be between 1 and 600 seconds."), true); return; }
    if (timeout !== (this.meta.interrogation?.config?.timeout ?? 180)) body.timeout = timeout;
    if (controls.hf_token.value.trim()) body.hf_token = controls.hf_token.value.trim();
    if (controls.clear_hf_token.checked) body.clear_hf_token = true;
    const payload = await this.operation(() => this.fetch("/interrogation-config", body), uiText("在线反推配置已保存。", "Online caption settings saved."));
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
        const run = action === "retry" ? this.runTask.bind(this) : this.fetch.bind(this);
        const result = await run(`/session/${encodeURIComponent(this.session)}/${action}`, {
          revision: this.revision,
          ...(action === "retry" ? { model_selection: this.modelSelection() } : {}),
          ...(operation ? { native_operation_id: operation.id } : {}),
        }, "POST", operation ? { controller: operation.controller } : {});
        if (operation && !operation.cancelled && this.matches(capture)) this.renderNativeProgress({ status: "completed", message: uiText("原生重试已完成。", "Native retry complete.") }, operation);
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
      this.status(uiText("会话已清空。", "Session cleared.") );
    }
  }

  async saveConfig() {
    const controls = this.dom.config;
    const body = {};
    body.connection_scope = "manual";
    const fields = ["base_url", "proxy", "api_key_env", "response_mode"];
    for (const name of fields) body[name] = controls[name].value.trim();
    for (const name of ["temperature", "max_tokens", "timeout"]) {
      const control = controls[name];
      const value = Number(control.value);
      if (control.value.trim() === "" || !Number.isFinite(value) || value < Number(control.min) || value > Number(control.max) || (name === "max_tokens" && !Number.isInteger(value))) {
        this.status(uiText(`请填写有效的 ${name}。`, `Enter a valid ${name}.`), true); return;
      }
      body[name] = value;
    }
    if (controls.api_key.value.trim()) body.api_key = controls.api_key.value.trim();
    if (controls.clear_api_key.checked) body.clear_api_key = true;
    body.stream = Boolean(controls.stream.checked);
    body.disable_thinking = Boolean(controls.disable_thinking.checked);
    const payload = await this.operation(() => this.fetch("/config", body), uiText("API 配置已保存。", "API settings saved."));
    if (payload) { controls.api_key.value = ""; controls.clear_api_key.checked = false; await this.refreshMeta({ quiet: true }); }
  }

  async savePreset(update) {
    const name = this.dom.presetName.value.trim();
    const instructions = this.dom.presetInstructions.value.trim();
    if (!name || !instructions) { this.status(uiText("请填写预设名称和基础创作指令。", "Enter a preset name and base instructions."), true); return; }
    const body = { name, instructions, mode: this.dom.presetMode.value === "replace" ? "replace" : "append" };
    if (update) body.id = this.value("preset");
    const payload = await this.operation(() => this.fetch("/presets", body), uiText("创作预设已保存。", "Creation preset saved."));
    if (!payload) return;
    const id = payload.preset?.id || payload.id;
    if (id) this.write("preset", id);
    await this.refreshMeta({ quiet: true });
  }

  async deletePreset() {
    const id = String(this.value("preset"));
    const preset = this.meta.presets.find((item) => item.id === id);
    if (!preset || preset.builtin || preset.editable === false) return;
    const payload = await this.operation(() => this.fetch(`/presets/${encodeURIComponent(id)}`, undefined, "DELETE"), uiText("创作预设已删除。", "Creation preset deleted."));
    if (payload) { this.write("preset", ""); await this.refreshMeta({ quiet: true }); }
  }

  async copyPrompt() {
    const prompt = String(this.value("approved_prompt"));
    if (!prompt) return;
    try { await navigator.clipboard.writeText(prompt); if (!this.disposed) this.status(uiText("Final Prompt 已复制。", "Final Prompt copied.")); }
    catch { if (!this.disposed) this.status(uiText("复制失败，请选中 Final Prompt 手动复制。", "Copy failed. Select Final Prompt and copy it manually."), true); }
  }

  applyExecutionResult(message) {
    if (this.disposed || this.busy) return;
    const unwrap = (value) => Array.isArray(value) ? value[0] : value;
    const prompt = unwrap(message?.prompt ?? message?.final_prompt);
    if (typeof prompt === "string") {
      this.graphExecutionActive = false;
      this.markFinalPromptState();
    }
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
      this.status(uiText("已输出保存的 Final Prompt。", "Saved Final Prompt output."));
      return;
    }
    if (typeof prompt === "string") this.applyResult({ prompt, message: typeof response === "string" ? response : "", state, warnings: unwrap(message?.warnings) || [] });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.progressAPI?.removeEventListener?.("tk_prompt_agent_interrogation", this.interrogationProgressListener);
    for (const [type, listener] of Object.entries(this.graphListeners || {})) this.progressAPI?.removeEventListener?.(type, listener);
    this.invalidate();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    if (SESSION_OWNERS.get(this.session) === this) SESSION_OWNERS.delete(this.session);
    this.sizeSync?.dispose();
    this.dom.settingsDialog?.remove();
    this.dom.presetDialog?.remove();
    this.dom.connectionDialog?.remove();
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
