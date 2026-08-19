# Anima Toolkit · ComfyUI-Anima-Batch-LoRA — 交接文档（2026-08-03）

> 给下一位 agent 的工作交接。项目当前健康、全部已推送 GitHub。请先读本文 + 合并仓库 README，再动手。

## 最新：Outputs 正片提取修复 + Ctrl+C 冲突 + LoRA 悬浮「复制全部」删除（2026-08-20）

- **正片（正面 prompt）提取**：`20260819_1111/1108_anima_00001_.png` 等"CLIP 正片由其他节点注入"的图，Outputs「正面」按钮消失。根因：API(prompt) chunk 里 `CLIPTextEncode.inputs.text` 是**数组链接**（`["13",0]` → `Text Concatenate` → `PrimitiveStringMultiline.value`/`D站画廊 selection_data`），旧 `getNodeText` 三处不认：①类名 `Text Concatenate`(带空格)匹配不上 `TextConcat`；②拼接字段是 `text_a/text_b`（代码只读 `text1..10`）；③叶节点文字在 `value` 字段；④D站画廊的选中 prompt 在 `selection_data` JSON。已在 `src/services/outputMetadata.ts` 扩展 `getNodeText`：拼接节点按序聚合（text1..n/text_a..z/textA..）+ 叶节点 `value` + **D站画廊 `selection_data` 恢复** + 逗号归并；并在 `parseOutputMetadata` 加兜底：API 解析不到正片时回退 UI(workflow) chunk。**PARSER_VERSION 2→3** 触发 `backfillPrompts` 重跑，且 backfill 改为**只填空、不覆盖非空**（防用 UI 旧值覆盖 API 真值）。已用真实两张 PNG 验证：meta.prompt 由空 → 完整（`@dabaitu, leonid brezhnev, ...`）；tsc 通过。**重要**：API(prompt) chunk 是图实际执行的正片（比 UI workflow 存的旧选区更真），面板保持 API 优先。旧已入库条目由 PARSER_VERSION 升版回填或刷新重扫补齐。
- **重命名弹窗 Ctrl+C 被劫持**：`copy` 事件兜底处理器缺焦点守卫——重命名弹窗选中文件名按 Ctrl+C 时被改造成复制图片。已在 `src/sections/Outputs.ts` copy 处理器加守卫：焦点在 INPUT/TEXTAREA/contentEditable 时放行浏览器默认复制（keydown 侧本有守卫）。
- **LoRA 悬浮 tooltip 删「复制全部」**：`web/js/anima_batch_lora_widget.js` `_showTwTooltip` 里 `tw-copy-all` 按钮冗余（节点工具栏「全部触发词」已有）且悬浮层随鼠标离开消失点不到。已删按钮 HTML+点击处理+两条死 CSS，保留逐个触发词 chip/预览图/模型名。
- **生效**：面板重建部署到运行插件目录 `app/`（新 bundle `index-BSzBjEdo.js`，重开面板窗口/硬刷新）；widget 已同步运行目录（硬刷新 Ctrl+Shift+R）。

## 最新：TK 相机控制相对拖拽修复 + 配套「标准正向撰写」skill（2026-08-20）

- **相机拖拽 bug**：运行目录那份曾改成「双模式」——按住相机点=微调、其余位置=**absolute**（射线-球面求交，指针直接映射机位）→ 只能命中可见正前方、拖不到背面。已统一为**相对增量**：按下记录机位起点、移动叠加增量，方位周期化可连续绕 360° 穿越背面；保留相机点=微调。验证 `.scratch/verify_camera_drag.py` 7/7（真实 8188 画布，读 pos_x/pos_y 与 `_animaCam`）。改动已推送（`c6df924`），运行目录 widget 已同步生效（硬刷新 Ctrl+Shift+R）。
- **新 skill `anima-prompt-writer`（标准正向撰写·SFW 安全版）**：用用户定稿的 Master Vision Prompt Engineering 规则当唯一标准（无数据集），正向撰写合成规则——10 段标签顺序（质量→美学→时代→meta→安全→人数→角色→系列→画师@→通用）+ 空间构图句（视角+身体接触环境 ≤60 词）；并规范化「写到正确目录 + 格式」：`ComfyUI\input\prompts\`、文件名 `数字序号_描述_日期.txt`、`## 组N · 标题` 格式（解析语义对齐 `anima_prompt_parser.py`：三种标题/注释跳过/`相机:` 行不计入正片）。格式闭环已验 `.scratch/verify_skill_format.py`（真实探针解析 3 组全对）。
- **存放约定（⚠️ 保持同步的 3 处）**：本机完整版 `空目录\.dsh\skills\anima-prompt-writer\SKILL.md`（含 LOCAL ONLY 块：NSFW 指针/tagdb/服装索引）== `.zcode\skills\anima-prompt-writer\SKILL.md`；GitHub 版 `skill/anima-prompt-writer/SKILL.md`（**去掉 LOCAL ONLY 块**，SFW 安全可发布）。README 已加「TK 批量提示词节点 + 配套 skill」章节与目录结构 `skill/`。
- **NSFW 纪律**：NSFW/成人内容一律不上 GitHub；本 skill 只做标准/SFW 正向撰写，NSFW 批走本地 `anima-prompt`（大师协议）。
- 生效：skill 是纯文档，无需重启；本地已放好三处。仓库推送后 GitHub 用户 clone 即得 skill/。

## 最新：TK D站画廊 500 搜索失败根治 + 筛选/分级冲突优化（2026-08-19 晚）

- **根因（已用真实 D站 API 复现）**：`order:score`（及 `order:favcount`、`order:random`）在**无时间窗**时会对全库排序，Danbooru 数据库超时返回 **500**（`ActiveRecord::QueryCanceled: The database timed out`）——裸 `order:score` 或 `1girl order:score` 必现，这正是「搜索失败:Danbooru请求失败：500 Server Error for url: .../posts.json?tags=order%3Ascore...」的来源。实测：`order:rank` 恒 200；`order:score + score:>500` 也可救（全时段 top）；任意 `age:*` 时间窗必救。
- **修复① 慢排序自动附加时间窗**（前端 `currentQuery()` 与后端 `/anima/danbooru/posts` 双保险，常量前后端一致：`SLOW_ORDERS={score,favcount,random}`、`DEFAULT_SLOW_ORDER_WINDOW=1week`）：评分/收藏/随机排序若没有 `age:` 自动补 `age:1week`（age 是免费 metatag，不占计数槽）；用户显式设了时间则尊重。后端补窗时在响应 `warnings` 里提示。原报错 URL `tags=order:score` 现返回 200 + 图片。
- **修复② 筛选/分级冲突不再死路**：D站 匿名搜索最多 2 个计数标签（普通标签与 `order:` 各占 1；`rating:`/`age:`/`score:`/`favcount:` 免费）。之前超限直接红字拦截；现在**超限且已设排序时自动降级排序**（保留内容标签/分级/筛选，改用默认最新），状态栏提示「已自动移除「…」排序，按最新显示（匿名最多 2 个计数标签）」；仅当无法降级（3+ 普通标签）才本地拦截并给中文说明。
- **修复③ 友好报错**：`_friendly_danbooru_error` 解析 D站 JSON 错误体 → 中文说明（数据库超时/标签限制/原 message），不再透传难懂的 `500 Server Error: ...`；`lastQuery` 改只存搜索框原文（修掉把分级/排序混进搜索框的隐患）。
- **文件**：`anima_danbooru_gallery.py`（改）、`web/js/anima_danbooru_gallery_widget.js`（改）、`tests/verify_danbooru_dropdown.py`（改动：超限断言改为「自动降级」；新增「慢排序自动附加时间窗」「无法降级仍拦截」两项）。
- **验证**：`node --check` + `python -m py_compile` 通过；`tests/verify_danbooru_dropdown.py` 全绿（24 项）；ComfyUI 已重启（py 生效），实机 `/anima/danbooru/posts?tags=order%3Ascore` → 200+6图+warnings，`tags=1girl%20solo%20order:score` → 400 中文限制提示。发布源与运行目录 SHA 一致。
- **生效**：py 已随重启生效；JS 需硬刷新 `Ctrl+Shift+R`。

- **⚠️ 追加修复（2026-08-19 深夜）：搜索全部“请求超时”根治 = Danbooru 请求统一走系统代理**。后端之前用裸 `requests.get` 直连——`requests` 只读 env 代理、不读系统代理；本机直连 danbooru 时通时断（走 Clash 127.0.0.1:7890 即稳定，启动器也注明直连不推荐）。新增 `_resolve_danbooru_proxies()`（与源插件 `PROXY_CONFIG="auto"` 同约定）：显式 `DANBOORU_PROXY_CONFIG`/`PROXY_CONFIG` > env `HTTPS/HTTP_PROXY` > 系统代理（`urllib.request.getproxies()` 读 WinINET）> 直连兜底；`posts`/`image`/`suggest`/节点图片下载 `_download_image` 全部统一走共享 `_danbooru_session`（已附 headers+proxies）。实测 `1girl` 从 15s→504 变为 0.4s→200；Playwright 24/24 仍绿。改代理（含 Clash 开关）后需重启 ComfyUI 生效（同启动器约定）。

## 最新：TK D站画廊下拉控件重构（2026-08-19）

- **交互**：分级、筛选、分类统一为选择框外观的 portal 下拉；菜单挂到 `document.body`，不会再被节点 `overflow:hidden` 裁切。
- **分级**：支持普通/敏感/可疑/明确多选，触发器显示数量；旧字符串 `"g"` / `"g,s"` 自动迁移为数组，重开节点不会丢多选。
- **筛选**：时间、最低评分、最低收藏、排序使用二级级联菜单；悬浮 150ms 展开，点击可固定，支持方向键与 Esc；多个条件只在“应用筛选”时请求一次。
- **排序**：独立“排行”按钮和旧 `toggleRanking()` 已删除；唯一 owner 为 `settings.filters.order`。搜索框内手写 `order:*` 会被规范化移除，避免重复 order 导致 422。
- **分类**：沿用同一菜单壳的平面单选；空值文案由误导性的“无分类”改为准确的“全部分类”；卡片上的“分类”仍表示给单张图片归类。
- **D站限制**：匿名/Member 搜索最多 2 个计数标签，`order` 会占 1 个；前端超限时不发请求并显示中文说明，后端 `/anima/danbooru/posts` 同步返回清晰 400，不再透传 D站 422。
- **新 owner**：`web/js/anima_dropdown_menu.js` 管 portal/定位/外部关闭/键盘/级联；`web/js/anima_danbooru_filter_controls.js` 管分级、筛选、分类状态与菜单内容；`web/css/anima_danbooru_gallery.css` 是画廊唯一样式 owner。
- **复杂度**：主 widget 从原 786 行降到约 680 行；已删除未被调用的 `openControlDock/openGallery/openFilter`、旧 `<details>` 菜单、内联 CSS 和独立排行路径。
- **验证**：`tests/verify_danbooru_dropdown.py` 真实启动 headless ComfyUI 节点，覆盖 portal 不裁切、多选持久化、悬浮/点击级联、单次请求、重置、分类、键盘、排序单 owner、标签限制与零运行时异常。
- **生效**：JS/CSS 硬刷新即可；本批后端校验修改了 `anima_danbooru_gallery.py`，首次部署需要重启 ComfyUI。

## 最新：TK D站画廊（2026-08-19）

- 新节点稳定 ID：`DanbooruGallery`；显示名：**TK D站画廊**；分类：`TK/Danbooru`。
- 文件：`anima_danbooru_gallery.py`、`web/js/anima_danbooru_gallery_widget.js`、`data/danbooru_tags_zh.json`。根 `__init__.py` 只负责 mappings 接线。
- 功能：固定/可调画廊高度、瀑布流完整比例预览、单选图片输出 IMAGE/STRING、完整双语 tag 悬浮预览、图片下载/大图/Prompt/分类/入 Prompt 库（Data URL 预览图）。
- 搜索：自动加载上次 query；Danbooru 缓存与强制刷新；中文多选分级；节点内高级筛选（时间、最低评分、最低收藏、唯一排序）；本地分类、搜索预设、五页码/输入跳页/前后翻页；补全、无结果纠错与可见扩展建议。
- 重要：排序只经 `settings.filters.order` 维护，禁止把 `order:rank` 追加进搜索框；否则会和 `order:score` 冲突导致 Danbooru 422。
- 验证：`node --check web/js/anima_danbooru_gallery_widget.js`、`python -m py_compile anima_danbooru_gallery.py`、`/object_info/DanbooruGallery`、`/anima/danbooru/suggest?q=1gir`。
- 发布：Python/数据修改需重启 ComfyUI；JS 修改需 `Ctrl+Shift+R`。发布源与运行目录的本节点文件必须 SHA256 相同。

## 一、项目是什么

ComfyUI 自定义节点（批量 LoRA 加载器）+ 内嵌的「本地管理面板」（Anima Toolkit），解决 ComfyUI 下 LoRA/Prompt/出图管理的便利性。GitHub 一键包，clone 到 `custom_nodes` 即用（`app/` 预构建、相对路径）。

- **GitHub**: `https://github.com/Ararararararaki/comfyui-anima-toolkit`（2026-08 从 `comfyui-local-manager` 改名，旧 URL 自动重定向）
- **品牌**：Anima Toolkit · 本地工具箱；顶部按钮用「菲比」角色图标

## 二、三个目录（务必分清）

| 目录 | 角色 | git |
|------|------|-----|
| `E:\claude program\civitai` | **面板开发目录**（src/ 在根） | 历史独立，**不推 GitHub** |
| `E:\claude program\ComfyUI-Anima-Batch-LoRA` | **合并发布仓库**（面板在 panel/ + 插件 + app + screenshots） | 推 GitHub 的是这个 |
| `E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA` | **ComfyUI 实际运行插件目录** | 非 git |

⚠️ 历史上 civitai 的 remote 也指向 GitHub，但**不要从 civitai 直接 push**（结构/历史不兼容）。发布一律走合并仓库。

## 三、开发 → 发布流程（重要）

### 面板改动（前端 UI）
1. 改 `civitai\src\...`
2. `cd "E:\claude program\civitai" && npm run build:comfyui` → 构建 + 部署 app/ 到 ComfyUI 插件目录
3. 复制改动的文件到合并仓库对应 `panel\src\...`
4. 在合并仓库 `git add + commit + push`（GitHub Actions 自动重建 app/）

### 插件改动（节点/后端）
- 后端：合并仓库 `__init__.py`、`anima_batch_lora.py`
- 前端：合并仓库 `web/js/anima_batch_lora_widget.js`
- 改完复制到 ComfyUI 插件目录（`web/js/`、根目录 py）
- 生效：**widget.js 硬刷新 ComfyUI 页面（Ctrl+Shift+R）**；**`__init__.py`/py 需重启 ComfyUI**

### 面板本地验证
- `npx tsc --noEmit` / `npm run build`
- CDP headless 冒烟：临时脚本在 `/tmp/cdp_*.cjs`（静态服务器 + headless Chrome 访问面板/ComfyUI 8188）

## 四、功能清单（当前全部可用）

### LoRA 加载节点（web/js/anima_batch_lora_widget.js，60KB+ 大文件）
- 批量 `<lora:name:weight>` 语法、`lora_syntax` 多行输入、触发词悬停/点击复制
- 📂 本地 LoRA 浏览弹窗：网格/列表、虚拟滚动、C 站图（走后端代理）、拖拽框选批量分类、右键分类/收藏/置顶、**已添加置顶**
- 📩 面板同步（自动轮询，面板「发送到 ComfyUI」后 ≤5s 自动添加）
- **⚙️ LoRA 启用/禁用开关**：关闭的不参与生成但保留在列表（随工作流持久化）
- **💾 组功能**：保存当前列表为新组 / 一键切换 / 删除（合并原「保存组」+「组」按钮），存后端 anima_meta.json
- **📥 URL 下载**：从 C 站链接下载 LoRA 到本地——带/不带 modelVersionId 均可（无则取默认版本）、批量（每行一个链接）、实时进度条、下载中可取消（自动删部分文件）、需登录模型用 C 站 API Key（设置页统一管理）+ Cookie 容错、自动用 model-versions API 拿正确文件名
- **🔄 检查更新**：本地版本落后时工具栏高亮「🔄 有新版本」，点击弹窗显示更新指引（git pull / ZIP 覆盖 + 前往 GitHub）；版本对比靠根目录 VERSION 文件 vs 后端 __init__.py 返回的 latest
- **一键复制已启用 LoRA 的触发词**（英文逗号连接）+ 句末带逗号
- **常用次数排序**（添加到节点时 count+1）+ 节点行显示分类/次数
- 🔍 验证标签 / ↻ 刷新列表 / 📥 提取触发词 / ✕ 清空列表 / 🌐 面板
- 权重调节：尖括号 scrubbing（按住 `<`/`>` 水平拖动连续调，4px=0.05；单击步进 0.05）

### 本地管理面板（civitai/src）
- **本地 LoRA 管理**（LocalManager）：Steam 风格、C 站匹配、返图、右键分类、发送到 ComfyUI、**扫描浏览器回退**（showDirectoryPicker 不可用——Firefox/夸克旧版/局域网 IP 访问时自动改用 `<input webkitdirectory>` 文件选择）
- **Outputs**（Outputs.ts）：元数据解析、拖拽框选（可卡片起手）、快捷键、**自定义分类**（单分类：徽章/筛选/右键/管理）、**复制 LoRA 标签**（统一提取，兼容 UI/API/LoraManager 格式）、**目录选择兼容提示**、**刷新按钮走增量扫描 + 有无新图提示**、**卡片显示创建日期**、**复制工作流已改为下载工作流 .json**（替代复制，画布 Ctrl+V 不导入易误导）、**预览图片编辑**（lightbox 内旋转/翻转/框选裁剪/保存副本 `原名_edited.扩展名`，不覆盖原图；canvas 处理，裁剪层需编辑画布显示，主题色为白时按钮用固定紫）
- **图片解析**（PromptFreq，原「图片 Prompt 解析」）：PNG 元数据解析、预览放大、翻译、保存到 Prompt 库、**发送到 Outputs**（选分类+保存文件）、**LoRA `<lora:名:权重>` 标签**（点击复制/一键复制全部）、**下载工作流 .json**（拖入 ComfyUI 导入；已移除「复制工作流」按钮——画布 Ctrl+V 不导入易误导）、**生图模型提取**（UNETLoader 等）、**卡片切 tab 常驻**、**完整 lora 名悬浮预览**
- **Prompt 库**（PromptLibrary）：分类/搜索/收藏、编辑（去 weight 加 loras）、删除/收藏立即刷新
- **画师系列**（ArtistSeries）、**LoRA 探索**（LoraExplorer）：待优化
- **设置页**（Settings.ts）：**C 站 API Key 统一管理**（下载弹窗自动带出；「生成 API Key」按钮直接打开 C 站 `/user/settings/api-keys`）、**背景图改 IndexedDB 存储**（修复大图 localStorage 超限静默失败）
- 顶部「菲比」图标按钮：已接入 **ComfyUI 标准菜单 API（app.menu）**，不再依赖注入容器；点击进面板

## 五、核心解析逻辑（outputMetadata.ts，最近大改）

- **prompt chunk（API）优先**，workflow chunk（UI）兜底 —— API 是图实际执行的提示词，UI 多采样器会选错（曾导致「提示词不对图」）
- `safeParseJSON`：清洗 `[NaN]`/`[NaN]`/Infinity（ComfyUI `is_changed:[NaN]` 是非法 JSON）
- `parseComfyUIWorkflow`：nodeMap 双键（string/number）、数组链接递归（CLIPTextEncode text:["676",0]）、权威引用守卫（KSampler 链路优先，防旁路文本）
- `extractLorasFromWorkflow`：名称数组（7 处调用点依赖裸名，勿改返回值）
- `extractLoraTagsFromWorkflow`：`<lora:name:weight>`（含权重，供 PromptFreq/节点）
- `parseOutputMetadata`：PNG chunks → 上述逻辑 → OutputMetadata

## 六、最近改动（GitHub 最新提交 634200a，版本 2.0.0）

### 2026-08-12 之后（本轮未发布批次：节点 UI 重构 + 新节点 + 安全修复）

**LoRA 节点（web/js/anima_batch_lora_widget.js）**
- **权重滑块 → 尖括号 scrubbing**：删除 `input[type=range]`，改为「< 数字 >」三段结构；按住 `<`/`>` 水平拖动连续调权重（4px=0.05），单击步进 0.05，松开 commit。拖动与单击各恰好 commit 一次（`__scrubbed` 标志抑制双重 commit，2 秒超时自动重置防残留）
- **LoRA 名称放宽**：去掉 16 字符截断，弹性占满（CSS ellipsis 兜底）
- **行内图标 SVG 化**（lucide stroke 风格与面板统一）：拖拽 ⠿→grip、删除 ×→x、分类 🏷→tag、权重 < >→chevronLeft/Right；toolbar 8 按钮 emoji→SVG（新增 11 个 lucide 图标）
- **卡片不再显示使用次数与触发词小字**（用户要求；hover 预览图弹窗保留）
- **悬浮预览图**：hover 触发词弹窗顶部显示预览图（经 `/anima/image` 代理 400px）+ 模型名/作者（`loraInfoMap` 缓存，onerror 回退占位）
- **关键修复**：`_render` 里 `esc` 未定义导致的 ReferenceError（有分类标签的卡片行渲染失败被跳过 → 拖拽后只剩前 2 行）——已补类级 `esc`/`escAttr`（332-334 行）
- **安全修复**：分类选择器/右键菜单分类名 escAttr+esc 转义（存储型 XSS）；imgProxy 非白名单 URL 返回空串（防 javascript:/data: 注入）；`_imgProxy` 提升为类级方法（原 `_browseModal` 局部 const 导致 `_showTwTooltip` 引用会 ReferenceError）

**触发词管理节点（新增）**
- 后端 `anima_trigger_words.py`：`Anima Trigger Words` 节点（INPUT lora_syntax + 手动 trigger_words，从 bridge 查找表提取触发词，去重保序）
- 前端 `web/js/anima_trigger_words_widget.js`：卡片列表（每个 LoRA 一张卡，触发词可编辑/删除）+ 提取触发词 / 复制全部
- **残留 bug 修复**：`_syncFromSyntax` 原为"只增不删"（语法删掉的 LoRA 卡片残留）→ 改为以语法为准全量对齐（移除已删 LoRA + 清 twMap + 补 `_commit()` 重算输出）；`_syncFromBridge` 同步做减法（bridge ∪ 语法并集过滤）；`_commit` twMap 查找 lowercase 兜底（大小写变更不丢触发词）

**后端（__init__.py / anima_batch_lora.py）**
- **bridge 持久化**：`/anima/bridge/update` 落盘 `anima_bridge.json`（ComfyUI 重启不丢 LoRA 组合）；`bridge_clear`（DELETE）同步删除持久化文件（否则重启后文件兜底恢复旧数据）
- **LoRA SHA256 缓存**：`_sha256_file` 加 path→(mtime,size,sha256) 缓存，避免重复全文件哈希
- **`/anima/models` 端点**：列出模型文件（分组）
- **serve_asset 路径防护**：`startswith` → `os.path.commonpath` 严格比较（防 `app2/` 同前缀兄弟目录绕过）
- **`_normalize_meta_keys` 修复**：函数体被 `_strip_model_ext` 截断导致归一化死代码（面板扩展名 key 与节点去扩展名 key 的分类/收藏/次数不同步）——已把 `_merge`+遍历+写回移回函数体

**面板（civitai/src，随合并仓库 panel/）**
- 命令面板 Cmd/Ctrl+K（9 条命令：6 tab + 设置 + 主题切换）
- 4 个栏目搜索框加清除 ✕ 按钮（ArtistSeries/PromptLibrary/Outputs/LocalManager，`attachSearchClear` 通用辅助）
- 各栏目 emoji 按钮 → `icon()` SVG 统一（icon.ts 补 mousePointer 等）
- 空状态统一为 SVG 图标结构

> ⚠️ **上述 2026-08-12 批次尚未推送 GitHub**（需先同步 panel/ 到合并仓库 → commit → push；Actions 自动重建 app/）。功能已验证（node --check + CDP 实测 + review/security_review 通过）。

近期发布集中在 **URL 下载、检查更新、LoRA 开关、组功能、API Key 管理、浏览器回退** 等，摘要见合并仓库 `CHANGELOG.md` 的 `## [2.0.0]`。关键 commit：

- `634200a` 节点发现新版本时显示更新指引弹窗（git pull / ZIP 覆盖 + 前往 GitHub）
- `e49fff8` 背景图改 IndexedDB 存储（修复大图超限静默失败）+ 设置页加 C 站 API Key
- `32a76e3` 顶栏菲比图标不显示——ICON_URL 路径漏了 web/（图片实际在 web/img/）
- `107375f` 检查更新功能——落后时节点工具栏高亮提示
- `e69864a` 下载弹窗只用 API Key + 修复遮罩误关 + 下载中可取消
- `79dc754` / `f3990b5` URL 下载支持 C 站 API Key（推荐）+ Cookie 容错
- `ab0b9ed` URL 下载文件名错误——改用 model-versions API 的 files[0].name
- `6a19cd0` C 站下载 401——改用浏览器 UA（Cloudflare 拒非浏览器 UA）
- `a1bd3b8` Outputs 图片闪烁——diffManifest mtime 加 1s 容差
- `dd388cd` URL 下载支持无 modelVersionId 链接 + 批量下载（每行一个链接）

### 版本管理 / 更新日志（新增约定）

发布新版本时（合并仓库）：递增根目录 `VERSION` → 同步 `__init__.py` 的 `__version__` → 在 `CHANGELOG.md` 顶部添加 `## [新版本号] - 日期`。用户可在节点工具栏「🔄 更新」检查到新版本。

## 七、已知问题 / 待办

- ~~Outputs 复制 LoRA 标签待修复~~（已修复：改用 `extractLoraTagsFromWorkflow` 统一提取，兼容 UI/API/LoraManager）
- ~~顶栏菲比图标加载失败（404）~~（已修复 2026-08-03：**ComfyUI 0.30+ 把 `/extensions/{name}/` 映射到插件 `web/` 目录**，此前 `ICON_URL` 带的 `web/` 前缀变成 `web/web/` 导致 404。已改为不带 `web/` 前缀，并用 `img.onerror` 回退到旧路径，兼容新旧 ComfyUI。改动在 `web/js/anima_batch_lora_widget.js` 的 `setAnimaIcon`；改后**硬刷新 ComfyUI 页面**即可，无需重启）
- 画师系列、LoRA 探索（待优化）
- 别人发的图若**无元数据**（微信/QQ/压缩会清），解析显示「该图无元数据」——正常现象，非 bug
- LoRA 探索里下载模型（C 站）若仍走旧路径，需确认是否与新 URL 下载弹窗统一
- **图片编辑功能已增强（2026-08-03）**：① **修复「确认裁剪」不生效的根因 bug**——确认/取消按钮位于裁剪层 `.lb-crop-layer` 内部，点按钮时 mousedown 冒泡到裁剪层 handler 会把已拖好的选框重置为 0，confirmCrop 读到空框而失效（真实鼠标必现，JS `click()` 会绕过 mousedown 故之前测试没发现）；已改为裁剪层 mousedown 忽略按钮事件。交互保持「拖框 → 确认」两步（有容错），保存时也自动应用未确认的选框；② **保存副本时保留原 PNG 的 prompt/workflow 元数据**（新增 `src/services/pngChunks.ts`，把原图 tEXt chunks 注入导出 PNG，ComfyUI 仍能回导）；③ 保存后网格即时出现副本（手动入库，不依赖增量扫描）+ 预览自动切换到新副本；④ 修复 jpg 保存失败（`image/jpg` → `image/jpeg`）；⑤ 编辑状态机重构为「基准画布」模型，消除旋转+裁剪组合的坐标错位，裁剪坐标 clamp 到画布边界，加 _saving 保存锁。已 CDP 真实鼠标事件验证通过（含大图缩放像素级验证）、已部署 ComfyUI（build:comfyui）、合并仓库 panel/ 已同步但**未 push GitHub**
- **Outputs 元数据展示统一（2026-08-03）**：预览图片后**不再自动弹出**右侧元数据面板（已移除 `outputs-metadata-panel` 的 HTML/CSS/全局事件与 `showMetadataPanel`），元数据统一由卡片「ℹ️ 元数据」按钮弹出独立窗口（`openMetaPanel`，含模型/提示词/节点/下载工作流）。已 CDP 验证、已部署 ComfyUI、合并仓库 panel/ 已同步但**未 push GitHub**
- **图片编辑候选功能待探讨/开发**（用户认可的方向）：① 调色（亮度/对比度/饱和度/色温/锐化）② 尺寸缩放 ③ 批量编辑 ④ 预设滤镜
- 编辑裁剪层依赖编辑画布显示（`lbEditWrap`），主题色 `--accent` 在白/黑主题下会变白/黑——按钮/选框改用固定紫色（已处理）

## 八、给下一位 agent 的提示

1. **先读合并仓库 README.md**（用户重写版）+ 本文件 + `CHANGELOG.md`，再动手
2. 用户偏好：**中文回复**、research-first（先探索给方案，可给多方案让用户选）、频繁微调 UI 位置/尺寸
3. **用户要求：开发后必须自己验证测试通过，不要推给用户去点**。用 CDP headless 冒烟（模板：`C:\Users\Toki\AppData\Local\Temp\cdp_verify_edit.cjs`）——启动静态服务器 + Chrome `--headless=new --remote-debugging-port` + Node 内置 WebSocket 连 CDP，检查 JS 报错、DOM、核心算法。注意静态服务器要映射 `/extensions/ComfyUI-Anima-Batch-LoRA/app/` 前缀到 dist，否则 JS 404
4. 改解析/核心逻辑时，**用真实 PNG 验证**（output 目录 `E:\1AI\...\output\` 有 100+ 张可测）
5. 大功能先 EnterPlanMode 规划，涉及多文件的用 Explore 子代理探索
6. 所有改动最终要：合并仓库 commit + push（Actions 自动重建 app/）+ 复制到 ComfyUI 插件目录。**注意合并仓库与 civitai 的 src 需保持逐文件一致**（比对其余文件行尾 CRLF/LF 会假性差异，用 `diff --strip-trailing-cr`）
7. **push 被拒时先 `git pull --rebase`**：GitHub Actions 每次重建 app/ 会生成新的 `chore: rebuild panel app` 提交，下次 push 前远程常有领先提交；rebase 即可，不要 force push
8. 本地 `civitai` 的 git 状态混乱（历史不推 GitHub），改文件直接用工作区即可，无需处理 git
9. 面板数据存在浏览器 IndexedDB（`outputs-db`）+ 插件目录 `anima_meta.json`，换浏览器会重置分类等
10. **发新版本**：递增 `VERSION` → 同步 `__init__.py` `__version__` → 更新 `CHANGELOG.md` 顶部（节点「🔄 更新」靠版本号对比提示）

## 九、关键教训：PNG 元数据可能被 ComfyUI 覆盖（勿误判解析 bug）

用户若反馈「图片解析提取的提示词/工作流与画面不符」，**先查 PNG 内嵌元数据本身**，而不是改解析逻辑：

- **用独立工具复核 PNG 元数据**：`python -c "from PIL import Image; im=Image.open(路径); print(im.info.keys()); print(im.info.get('workflow','')[:200])"`（PIL 直接读 PNG 文本 chunk，与 node 脚本结果一致即为事实）
- 若 PNG 内嵌的 workflow UUID 是**用户自己的工作流**（如 `a585215a-...`），说明该图曾**在 ComfyUI 里被打开/导出/重绘过**——ComfyUI 保存图片时会写入**当前画布工作流**的元数据，覆盖原始生成参数（画面与元数据因此不符）
- 若节点（如 DanbooruTextPassthrough / PreviewAny）**有多个预设提示词**（widgets_values 多组），API prompt chunk 里 `prompt_text` 记录的是**实际执行的那组**；解析取它是对的，不要改成取「画面匹配的那组」（无数据来源）
- 结论：图片解析是**如实读取 PNG 字节**。元数据被覆盖时，原始参数已不在文件里，解析器无法还原，只能提示「无元数据」或显示被覆盖的版本
- 验证：用 ComfyUI output 里**刚生成的图**（非被处理过的）拖入图片解析，提示词/工作流/画面应一致

**补充案例（2026-08 排查）**：QQ/微信收到的**原图**（`Pic\...\Ori\` 目录）也可能内嵌**完整 UI 工作流 + LoraManager 自动补全痕迹**（`__lm_autocomplete_meta_text` 字段）。面板复制工作流是逐字节复制 PNG 的 `workflow` chunk，不会替换成别的。

⚠️ **「复制工作流后画布显示的还是自己旧工作流」通常是导入方式误判，不是解析 bug**：ComfyUI **画布 Ctrl+V 不导入**工作流 JSON（只粘贴图片/文本），画布保持当前打开的工作流，看起来像"复制出旧工作流"。面板已移除「复制工作流」按钮，改用**「下载工作流 .json」→ 拖入 ComfyUI 画布**（或菜单 Load）导入，最稳妥。


