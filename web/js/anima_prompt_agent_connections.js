import { uiText } from "./anima_node_i18n.js";

const el = (tag, cls = "", text = "") => {
  const item = document.createElement(tag); item.className = cls; item.textContent = text; return item;
};
const field = (label, control) => {
  const wrap = el("label", "tk-pa-field"); wrap.append(el("span", "tk-pa-label", label), control); return wrap;
};

/** Connection identities stay on the host; a node stores only its selected ID. */
export class AgentConnectionEditor {
  constructor(owner) { this.owner = owner; this.id = "manual"; this.dsh = {}; }

  build() {
    const root = el("section", "tk-pa-field");
    this.picker = el("select", "tk-pa-input");
    this.picker.setAttribute("aria-label", uiText("编辑连接", "Edit connection"));
    this.picker.addEventListener("change", () => {
      if (this.pending || this.owner.busy) { this.picker.value = this.id; return; }
      this.id = this.picker.value; this.render();
    });
    this.name = el("input", "tk-pa-input");
    this.defaultModel = el("input", "tk-pa-input");
    const actions = el("div", "tk-pa-actions");
    const button = (cn, en, fn) => this.owner.button(uiText(cn, en), fn);
    this.remove = button("删除连接", "Delete connection", () => this.delete());
    actions.append(button("新建 API 连接", "New API connection", () => this.create()),
      button("复制连接", "Duplicate connection", () => this.create(true)), this.remove,
      button("刷新连接", "Refresh connections", () => this.refresh()));
    root.append(field(uiText("编辑已保存的 API 连接", "Saved API connection to edit"), this.picker), actions,
      field(uiText("连接名称", "Connection name"), this.name),
      field(uiText("连接默认模型 · 节点可单独覆盖", "Connection default model · Nodes can override it"), this.defaultModel));
    this.message = el("div", "tk-pa-note");
    this.message.setAttribute("role", "status");
    root.append(this.message);
    return root;
  }

  buildActions() {
    const actions = el("div", "tk-pa-actions");
    actions.append(this.owner.button(uiText("检测连接 / 读取模型", "Test connection / Load models"), () => this.test()),
      this.owner.button(uiText("保存并用于此节点", "Save and use on this node"), () => this.owner.saveConfig(true)));
    return actions;
  }

  buildDSH() {
    const root = el("details", "tk-pa-details"); root.open = true;
    root.append(el("summary", "", uiText("DSH 接入 · 目录、配置档与 Relay", "DSH connection · Directory, profile and Relay")),
      el("div", "tk-pa-note", uiText("填写 ComfyUI 所在机器的 DSH 目录。扫描已有模型配置；原生 Agent 还需 DSH 正在运行并安装 Harness Relay。这里不要求填写开发者的地址或账号。", "Enter the DSH directory on the ComfyUI host. Scan its configured models; native Agent execution also requires a running DSH with Harness Relay.")));
    for (const [key, label] of [["home", uiText("DSH 用户目录", "DSH home directory")], ["profile", uiText("配置档（Profile），通常为 web", "Profile, usually web")], ["descriptor", uiText("Relay 描述文件 · 留空按目录自动定位", "Relay descriptor · Blank to derive from the directory")]]) {
      this.dsh[key] = el("input", "tk-pa-input");
      root.append(field(label, this.dsh[key]));
    }
    this.profiles = el("select", "tk-pa-input");
    this.profiles.setAttribute("aria-label", uiText("发现的 DSH 配置档", "Discovered DSH profiles"));
    this.profiles.addEventListener("change", () => { if (this.profiles.value) this.dsh.profile.value = this.profiles.value; });
    root.append(this.profiles);
    this.dsh.enabled = el("input"); this.dsh.enabled.type = "checkbox";
    root.append(field(uiText("启用 DSH 接入", "Enable DSH connection"), this.dsh.enabled));
    const actions = el("div", "tk-pa-actions");
    actions.append(this.owner.button(uiText("保存并扫描 DSH", "Save and scan DSH"), () => this.saveDSH()),
      this.owner.button(uiText("检测 DSH / Relay", "Test DSH / Relay"), () => this.testDSH()));
    this.dshMessage = el("div", "tk-pa-note"); this.dshMessage.setAttribute("role", "status");
    root.append(actions, this.dshMessage);
    return root;
  }

  rows() { return [{ id: "manual", name: uiText("本机默认 API", "Default local API"), config: this.owner.meta.manual_config || this.owner.meta.config || {} }, ...(this.owner.meta.provider_presets || [])]; }

  render() {
    const rows = this.rows();
    this.picker.replaceChildren(...rows.map(row => { const o = el("option", "", row.name); o.value = row.id; return o; }));
    if (!this.id) { const o = el("option", "", uiText("新连接 · 尚未保存", "New connection · Not saved")); o.value = ""; this.picker.append(o); }
    this.picker.value = this.id;
    const row = rows.find(item => item.id === this.id);
    if (row) {
      this.name.value = row.name;
      this.defaultModel.value = row.config.model || "";
      for (const [key, control] of Object.entries(this.owner.dom.config || {})) {
        if (key === "api_key") control.value = "";
        else if (key === "clear_api_key") control.checked = false;
        else if (control.type === "checkbox") control.checked = Boolean(row.config[key]);
        else if (row.config[key] !== undefined) control.value = String(row.config[key]);
      }
      this.owner.dom.keyStatus.textContent = row.config.api_key_set
        ? uiText("此连接已保存 Key；留空保留。", "This connection has a saved key; blank keeps it.")
        : uiText("此连接尚未保存 Key。", "This connection has no saved key.");
    }
    this.name.disabled = this.id === "manual";
    this.remove.disabled = !this.id || this.id === "manual";
    this.remove.textContent = uiText("删除连接", "Delete connection");
    this.deleteArmed = false;
    const settings = this.owner.meta.dsh_connection;
    if (settings && this.dsh.home) {
      for (const key of ["home", "profile", "descriptor"]) this.dsh[key].value = settings[key] || "";
      this.dsh.enabled.checked = settings.enabled !== false;
      const placeholder = el("option", "", uiText("发现的配置档", "Discovered profiles")); placeholder.value = "";
      this.profiles.replaceChildren(placeholder, ...(settings.profiles || []).map(name => { const o = el("option", "", name); o.value = name; return o; }));
      this.dshMessage.textContent = settings.enabled === false ? uiText("DSH 接入已停用。", "DSH connection is disabled.") : settings.error || uiText(`已发现 ${settings.sources?.length || 0} 个 DSH 实时来源。`, `${settings.sources?.length || 0} live DSH sources discovered.`);
    }
  }

  create(copy = false) {
    if (this.pending || this.owner.busy) return;
    const values = Object.fromEntries(Object.entries(this.owner.dom.config).map(([key, c]) => [key, c.type === "checkbox" ? c.checked : c.value]));
    this.id = ""; this.render();
    if (!copy) { this.owner.dom.config.base_url.value = ""; this.defaultModel.value = ""; }
    else for (const [key, control] of Object.entries(this.owner.dom.config)) { if (control.type === "checkbox") control.checked = values[key]; else control.value = values[key]; }
    this.name.value = copy ? this.name.value + uiText(" 副本", " copy") : "";
    // Copy public settings, never another connection's key/environment reference.
    this.owner.dom.config.api_key.value = ""; this.owner.dom.config.api_key_env.value = "";
    this.owner.dom.config.clear_api_key.checked = false;
    this.owner.dom.keyStatus.textContent = uiText("新连接需要填写自己的 Key（无鉴权的本地服务可留空）。", "Enter a key for this new connection, or leave blank for a local server without authentication.");
    this.message.textContent = "";
    this.name.focus();
  }

  async run(fn, target = this.message) {
    if (this.pending) return;
    this.pending = true; target.textContent = uiText("正在处理…", "Working…");
    try { return await fn(); }
    catch (error) { if (!this.owner.disposed) target.textContent = error.message; }
    finally { this.pending = false; }
  }

  async refresh() {
    return this.run(async () => { await this.owner.refreshMeta({ quiet: true }); this.render(); this.message.textContent = uiText("连接列表已刷新。", "Connections refreshed."); });
  }

  async test() {
    return this.run(async () => {
      const config = this.owner.connectionConfig(); if (!config) throw new Error(uiText("请检查配置字段。", "Check the connection fields."));
      const result = await this.owner.fetch("/connections/test", { id: this.id, config });
      this.message.textContent = uiText(`模型列表可用，共 ${result.models.length} 个；尚未验证生成。`, `Model catalog is available (${result.models.length} models); generation has not been tested.`);
    });
  }

  async delete() {
    if (!this.id || this.id === "manual") return;
    if (!this.deleteArmed) { this.deleteArmed = true; this.remove.textContent = uiText("再次点击确认删除", "Click again to delete"); return; }
    return this.run(async () => { await this.owner.fetch(`/connections/${encodeURIComponent(this.id)}`, {}, "DELETE"); this.id = "manual"; await this.owner.refreshMeta({ quiet: true }); this.render(); this.message.textContent = uiText("连接已删除。引用它的节点需重新选择连接。", "Connection deleted. Nodes referencing it need another connection."); });
  }

  dshConfig() { return { home: this.dsh.home.value.trim(), profile: this.dsh.profile.value.trim(), descriptor: this.dsh.descriptor.value.trim(), enabled: this.dsh.enabled.checked }; }

  async saveDSH() {
    return this.run(async () => { await this.owner.fetch("/dsh-connection", this.dshConfig()); await this.owner.refreshMeta({ quiet: true }); this.render(); }, this.dshMessage);
  }

  async testDSH() {
    return this.run(async () => {
      const result = await this.owner.fetch("/dsh-connection/test", this.dshConfig());
      this.dshMessage.textContent = uiText(`静态 API 来源：${result.sources.length} 个。Relay：`, `Static API sources: ${result.sources.length}. Relay: `)
        + (result.relay.available ? uiText("已连接，原生 Agent 可接入。", "Connected; native Agent integration is available.") : result.relay.error);
    }, this.dshMessage);
  }
}
