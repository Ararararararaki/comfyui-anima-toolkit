# TK Prompt Agent

TK Toolkit 的提示词创作与图片反推节点。支持 Anima / Krea 2，以及 MOSS Layout 编译与扩写；用中文描述需求，独立输出可直接供生图使用的 Prompt。2.37.0 补齐前台 API / DSH 连接管理。

## 第一次使用

1. 更新 Toolkit，重启 ComfyUI 并刷新浏览器，在节点菜单搜索 `TK Prompt Agent`（`TK/prompt`）。
2. 打开“配置 → 本节点模型 → 管理连接与请求参数”，点击“新建 API 连接”，填写名称、默认模型、Base URL 和自己的 Key，点击“保存并用于此节点”。URL 通常填到 `/v1`，不要重复写 `/chat/completions`。本机兼容模型服务器也可使用。
3. 选择 Anima 或 Krea 2。当前 Prompt 留空，输入“普通红狐狸在雪地里，晨光，低机位近景”，点击“发送编辑”或 Ctrl+Enter。
4. 继续输入“改成黄昏，角色不要动”等修改要求；Final Prompt 独立显示。第二路 `final_prompt` STRING 输出连接 CLIP Text Encode 等编码节点。

新节点默认“快速直写”，一次请求生成英文正文；“按流程创作”先规划再生成，并验证分区结果。旧工作流未保存创作方式时保留旧行为，可手动切换。执行失败保留上一稿，不把错误说明作为 Prompt 输出。

## 修改、确认与运行

可以限定编辑范围、锁定人物/服装/画师等已有分区，逐步修改并撤销。锁定和编辑范围由用户明确选择；未锁定时允许按指令换人或改写。复制只包含最终 Prompt，不包含聊天说明。

默认“使用已确认 Prompt”：排队生图只读快照，不重复调用模型。若需要执行工作流时处理上游 Prompt/指令，选择“运行节点时调用 Agent”，并将原生 widget 转成输入连接。此方式会调用已配置服务并推进会话，请按自己的 API 计费与额度使用。

## 图片反推与扩写

切到“看图反推”，选择、拖入或粘贴单张图片，选来源后开始；原始标签、描述、分数和候选分开显示。点击“替换当前 Prompt”或“加入当前内容”才确认，随后可以继续文字修改。

| 来源 | 条件 |
|---|---|
| WD14 本地 | 已安装成套 ONNX+CSV，可选择模型与普通/角色阈值，默认 CPU；不自动下载 |
| PixAI 在线 | 通过官方 Hugging Face Space，受其服务状态与排队限制 |
| ToriiGate 在线 | 官方 Space 可能要求相应 Hugging Face 账户等级/Token；额度错误需由账户条件解决 |
| 视觉模型连接 | 配置支持图片的兼容服务；沿用所选连接、输出上限、思考等参数 |

每次只请求选择的来源，不自动切站。反推结果仍需确认；看图扩写将原图和标签交给视觉连接，默认保留角色/作品信息。图片可由工作流可选 IMAGE 输入提供，每次仅一张；反推替换/追加行为需明确选择。

## 模型连接

“管理连接与请求参数”提供前台新建、编辑、复制、删除、刷新和检测。先在“编辑已保存的 API 连接”选择要改的连接；普通保存只更新该连接，“保存并用于此节点”还会设置当前节点的连接并清除旧模型覆盖。修改同一连接会影响引用它的节点；删除后这些节点需要重新选择，不会自动换用其他账号。默认本机连接可编辑，不能删除。

“连接默认模型”属于连接资料；“本节点模型”的模型 ID 属于当前节点，留空跟随连接默认值。每个 API 连接保留自己的请求参数，更改后下一次请求生效，无需重启 ComfyUI。

“检测连接 / 读取模型”只调用模型列表接口，不提交生成请求。列表接口成功不等于生成或图片能力已验证；不提供模型列表的服务仍可填写服务文档中的模型 ID。

普通模式使用兼容 Chat Completions API，不需要 DSH 或 LLM SDK。支持 JSON Schema、JSON object 或文本响应模式，需按服务实际能力选择；快速直写直接接收正文。代理、温度、超时、输出上限、SSE 和思考模式均可在高级设置调整。

默认外网代理为 `http://127.0.0.1:7890`，请按自己的环境设置；本机 loopback 服务直连。Key 保存在 ComfyUI 所在本机的用户配置，不嵌入工作流；留空保存保留旧 Key，只有明确清除才删除。外部服务请使用 HTTPS。

## 可选 DSH 能力

- 在“管理连接与请求参数 → DSH 接入”填写 **ComfyUI 所在机器**的 DSH 用户目录（通常为该用户的 `~/.dsh`），Profile 通常为 `web`。点击“保存并扫描 DSH”；可从已发现的 Profile 中选择。Relay 描述文件留空时按目录和 Profile 自动定位，也可手动指定。路径、账号和凭据不会随工作流分享。
- 点击“检测 DSH / Relay”，分别查看静态 API 来源与 Relay 状态。扫描可在 DSH 未运行时读取已存配置；原生执行必须保持 DSH 和 Relay 在线。这里只读接入现有 DSH，不修改其模型列表或凭据；模型与账号在各自的 DSH 中配置。
- **DSH 实时连接**：在“本节点模型 → 连接来源”选择扫描到的 DSH 当前模型或来源。读取 WorkBuddy 和兼容的 `llm-pi-ai` Chat Completions 静态配置，需要对应 DSH 配置与可选 PyYAML/python-dotenv。非当前来源有多个模型时必须明确选择。只读取连接并不自动继承其 system prompt、skills 或工具。
- **DSH 原生执行**：通过本机 Harness Relay 使用对应 Agent 会话与工具，需要用户自己的 Harness/DSH 和可选 `mcp` 依赖；普通 API 模式不受其缺失影响。
- 原生执行选择“DSH 当前模型”时直接使用 Relay 的模型信息，不强制要求能读取 Chat Completions 静态配置。返回原生 Agent 配置选择工作目录、预设和 Skill 后使用。仅检测成功尚未验证模型生成质量。
- API 连接在来源列表加 `API ·` 前缀，与 DSH 实时来源分开；名称含有 DSH 不会使普通 API 连接拥有 DSH 工具能力。可在 DSH 接入中停用扫描，已有配置保留。
- 插件不附带任何个人 WorkBuddy/OpenCode 连接、Key、模型账户或导入预设；设置不会自动切到开发者的环境。

本次连接管理升级新增后端接口，安装后需重启一次 ComfyUI 并刷新浏览器；之后修改 API/DSH 配置即时保存、下次请求生效。

## 布局与角色资料

`TK MOSS Layout Editor` 的 `layout` 可连接 Agent 的可选 `layout` 输入，`final_prompt` 再接提示词编码。画布的“扩写选区 / 扩写全部”复用关联 Agent 的模型和辅助 Skill；位置与可见文字由画布持有。直接使用编辑器 `prompt`，或关闭 `llm_expand`，可只编译、不调用模型。[布局操作与示例](../../docs/FEATURES.md#moss-layout)。

“源角色查库”是常驻选项，默认开启，在看图扩写前提供 WD14 角色的本地资料；查询失败不阻断。它提供参考，不能保证模型把多人特征全部对应正确。自动更新在“配置 → 创作资料核验 → 角色库自动更新”中：先查看更新状态，再选择每日空闲补充、缺失角色在线补查并保存。更新保留底库与用户别名，失败继续使用旧资料；收录新角色不代表模型训练过该角色。

<a id="english-setup"></a>

## Setup in English

1. Update Toolkit, restart ComfyUI once and hard-refresh the browser. Open **Prompt Agent → Configuration → This node's model → Manage connections and request settings**.
2. Choose **New API connection**, enter a name, Base URL (usually ending in `/v1`), default model and your own API key. **Save and use on this node** selects it and clears the previous node model override. Ordinary **Save** only updates that connection. Each connection keeps its own request settings.
3. **Test connection / Read models** reads the model catalog only; it does not submit a paid generation or verify vision capability. Enter the provider's documented model ID manually if it offers no catalog.
4. For DSH, open **DSH connection**, enter the DSH user directory on the machine running ComfyUI, select its profile (usually `web`) and **Save and scan DSH**. Leave the Relay descriptor blank for automatic discovery or specify its file. **Test DSH / Relay** reports static API sources and Relay separately.
5. Select a discovered source under **Connection source**. Static DSH API access only reads connection settings; native execution requires your own running DSH and Harness Relay, plus optional MCP dependencies. Multi-model sources require an explicit model choice. DSH tools and skills are available through native execution, not automatically through an API preset named “DSH”.

Keys stay in the ComfyUI host's user configuration, not in the workflow. Leave a key field blank to retain its saved key; clear it explicitly to remove it. Connection/model changes take effect on the next request without restarting. Deleting a connection does not silently select another account. Configure the proxy for your own machine; loopback services connect directly. Detection is not proof that a generation will succeed.

## 数据与限制

会话、撤销、配置与上传图片保存在本机 ComfyUI 用户目录中，更新保留。在线反推、视觉扩写和模型 API 会把所选内容发送到用户选择的服务。

复杂多人关系、同义词改写与语义分区依赖模型能力，不能保证每次理解都准确。程序校验和用户锁定保护可检测格式或范围问题，模型截断、认证、限流或无效输出不会覆盖已确认 Prompt。

QQ 交流群：**758086740**。完整功能见 [功能手册](../../docs/FEATURES.md)。
