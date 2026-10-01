# TK Toolkit

给 ComfyUI 用的 Anima 工作流工具包。批量挂 LoRA、管理本地模型、搜图找参考、整理提示词、翻看历史出图，都收在一个插件里，另外配一个本地管理面板。

作者时运tk（B 站同名），MIT 协议。

> 英文简介：TK Toolkit（2026-09 之前叫 Anima Toolkit，插件本身和 Registry id `anima-toolkit` 都没变）是 ComfyUI 的自定义节点包，外加一个内置网页面板。它管五件日常麻烦事：LoRA 的批量加载与本地管理（含 Civitai 元数据与下载）、提示词管理（中英对照卡片、翻译、中文标签补全）、Danbooru 工具（标签搜索、画廊、分类）、出图管理（把 output 目录做成缩略图画廊并解析 PNG 参数），以及批量出图的辅助节点（多组提示词串行、字符串路由、机位预设）。下面正文用中文写。给 AI 读的机器可读摘要放在 [`llms.txt`](llms.txt)。

<p align="center"><img src="screenshots/icon.png" width="140" alt="TK Toolkit"></p>

当前发布版本: **2.27.0**。

## 安装

ComfyUI-Manager 里搜「TK Toolkit」（节点 id 是 `anima-toolkit`），或者手动放：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ararararararaki/comfyui-anima-toolkit
```

装完重启 ComfyUI。改过 .py 就必须重启，这是 ComfyUI 的规矩。

仓库里已经带好了能直接用的 `app/` 面板构建产物，普通用户不用装 Node.js，也不用自己构建。

Registry 页面在 <https://registry.comfy.org/nodes/anima-toolkit>。依赖见 `requirements.txt`（aiohttp 和 requests），可选依赖见 `requirements-optional.txt`。装好之后节点工具栏上会有「更新」按钮，也可以走 ComfyUI-Manager 更新。

> 别和 `AnimaLoraToolkit`、`AnimaLoraAtelier` 搞混了，那两个是训练用的工具链（写 YAML 训 LoRA/LoKr）。这个项目只管推理这一侧：在 ComfyUI 里加载、管理、检索 LoRA，不做训练。

## 它能帮你做什么

| 平时的麻烦 | 这里怎么解决 |
|---|---|
| 一次要挂十几个 LoRA，权重还得一个个手改 | TK 批量 LoRA 加载器：面板里挑、批量启用，权重能拖着调，触发词自动输出 |
| 本地一堆 `.safetensors` 不知道是啥，也没预览图 | 本地 LoRA 管理：扫描目录、按 SHA256 匹配 C 站，补预览图、作者、版本和下载量，按底模和分类筛 |
| 想找参考图、找画师风格 | TK 多重画廊：六个图源（D站、C站、P站、Safebooru、yande.re、Konachan.net，后三个不要密钥），标签搜索加分级、时间、评分、收藏筛选，瀑布流，随机发现，中英联想 1 到 2 毫秒 |
| 提示词东一份西一份，中英对照看着累 | Prompt 卡片库和 Prompt 库：中英对照卡片，能翻译、能校准成 D站 规范标签，一键入库复用 |
| 出完图想不起参数，也找不到历史图 | Outputs 图片管理：缩略图直出，PNG 参数索引，一键复制提示词和 LoRA 标签 |
| 想一次跑一批不同提示词 | TK 批量提示词：多组提示词串行出图，每组可以有自己的机位 |

## 最近更新

2.27.0 给 Safebooru、yande.re 和 Konachan.net 加了各自官网的标签联想。输入标签片段后用上下键选择，Tab 或 Enter 补全，再按 Enter 搜索；多个标签用空格组合，光标放在哪个词里就补全哪个词。候选显示该图源的数量和可用分类，输入 `rating:`、`width:`、`score:` 或排序语法也有提示。

2.26.0 把画廊的连续浏览和页码定位放在一起：往下滚会继续加载，输入页码能直接跳过去，跳页后可回到刚才的位置。宽节点展开定位控件，窄节点点「定位」；设置里仍可切换独立分页模式。

画廊会自动记住每个节点、每组搜索条件下正在看的图片，重新打开或再次搜索时接着看，也可以点「从头看」。进度只保存在本机浏览器。C站按已知游标显示批次，随机发现只保留本次会话的定位。

2.24.2 修的是画廊无限滚动的一个老毛病：滚轮加载新一批图的时候整屏会闪一下黑，加载完位置还会往上跳一段。原因是追加取数的时候，取数那层自己先渲染了一次，而那一刻手里只有刚取回的新一批，于是整个网格被换掉，已经在屏幕上的图被清空重建（这就是闪），滚动位置也被浏览器夹回了 0（这就是跳）。现在追加只往网格里加新卡片，旧卡片和已经加载好的图片原样留着，滚动位置改成按视口顶部那张图重新对齐。

2.24.0 给 D站 图源加了真正的收藏读写：卡片上的收藏按钮直接写回你的 D站 账号，工具条上的「我的收藏」是个独立模式，不会占用搜索框，也不跟你自己的标签抢额度。

2.23.0 到 2.23.2 把画廊改成了无限滚动，把滚轮从画布手里要了回来，并修好了 yande.re 和 safebooru 的翻页。

更早的改动都记在 [`CHANGELOG.md`](CHANGELOG.md) 里。

## 使用

### 找到节点和面板

节点菜单里搜 `TK`，本插件的节点都放在 TK 根目录下，按用途分成 `TK/loaders`、`TK/camera`、`TK/batch`、`TK/prompt`、`TK/image`、`TK/latent`、`TK/Danbooru`、`TK/text` 几组。

顶部那个「TK Toolkit / 本地工具箱」按钮打开管理面板，也可以在 TK 批量 LoRA 加载器节点里点「面板」进去。面板设置页能换 ComfyUI 顶部的入口图标（传图片或填 URL 都行，恢复默认就回到仓库里的菲比图标），图标配置存在当前浏览器里，跟着设置导入导出一块走。

想直接开面板：`http://localhost:8188/extensions/ComfyUI-Anima-Batch-LoRA/app/`

### LoRA 管理的一般流程

1. 在 `TK/loaders` 里加一个 TK 批量 LoRA 加载器，接上 MODEL（需要输出 CLIP 的话再接 CLIP）。
2. 节点上点「本地 LoRA」打开浏览窗，或者从面板进本地 LoRA 管理。
3. 点「扫描文件夹（含子目录）」选 LoRA 根目录。扫描会保留相对路径，比如 `anima base/style.safetensors`。
4. 点「子目录建分类」，按一级子目录名自动建分类并把 LoRA 归进去。更深层的目录按它的一级目录归类，直接放在根目录的文件不归类。
5. 想要 C 站信息就点「全部匹配」，之后能看触发词、预览图、返图、分类和权重，也能发回 ComfyUI。

节点中 LoRA 名称右侧的铅笔可以编辑触发词。每行填一段提示词，保存后，点击名称复制、工具栏「全部触发词」和节点的 `trigger_words` 输出都会使用自定义词；同一个本地 LoRA 在其他节点也会同步使用。保存空白可停用该 LoRA 的触发词，「恢复自动」重新使用自动提取结果。编辑框支持 `Ctrl+Enter` 保存和 `Esc` 取消。

浏览器不支持目录权限 API 的时候，工具箱会自动退回文件夹选择的方式。用 Chrome 或 Edge 从 localhost 访问体验最完整。

## 节点一览

都挂在 ComfyUI 的 TK 根目录下：

- `TK/loaders`：TK 批量 LoRA 加载器、TK 触发词。前者批量加载 `<lora:name:weight>` 标签，后者提取和整理触发词。
- `TK/camera`：TK 可动素体相机。用可动空壳素体当角度参照，摆好姿势直接出机位词（旧的 TK 相机控制节点已退役）。
- `TK/batch`：TK 批量提示词注入。按提示词文件分组批量出图，支持独立机位和批次控制。
- `TK/prompt`：TK Prompt Cards、TK Prompt Saver。管提示词卡片、翻译和保存。
- `TK/image`：TK 图像选择。多路图像输入之间按策略选一个输出，并给出来源信息。
- `TK/latent`：TK 空 Latent 图像。生成 Anima/Cosmos 的 5D 空 latent，支持宽高整体缩放、常用宽高比悬浮选择，也能按 1536px 标准长边算具体尺寸。
- `TK/Danbooru`：TK 多重画廊。一个节点带六个图源，按标签或关键词搜索、筛选、下载，输出图片和元数据；工具条上还有 AnimaDex 角色浮窗。
- `TK/text`：TK 文本合并、TK String Router、TK Danbooru Tag Getter。合并文本、切换字符串输入、筛选 Danbooru 分类。

节点数量以实际注册为准，`python tests/tools/ai_verify.py` 会打印真实清单，所以这里不写死数字（以前删过节点，标题和正文的数字就对不上了）。

### 六个图源

| 图源 | 密钥 | 说明 |
|---|---|---|
| D站（Danbooru） | 不要 | 标签搜索加分级、时间、评分、收藏筛选。被 Cloudflare 拦的时候会自动拉起本机浏览器网关（需要 playwright） |
| C站（Civitai） | API key，只用于账号校验，不影响取图 | cursor 分页，排序、NSFW 档位、时间窗、作者、模型浏览 |
| P站（Pixiv） | OAuth 2.0 + PKCE 授权 | 关键词搜索。不给提示词，定位是素材，可以送去 WD14 反推 |
| Safebooru | 不要 | gelbooru-dapi 系公开 API |
| yande.re | 不要 | moebooru 骨架，走 post.json |
| Konachan.net | 不要 | 和 yande.re 同一套骨架（全年龄镜像；konachan.com 被 Cloudflare 拦，没有纳入） |

图源下拉是后端能力表驱动的，前端只留排序偏好，所以后端注册了新图源就会自动出现在界面里，加图源不用动前端代码。

### AnimaDex 角色浮窗

这是本地角色库，不是图源。画廊工具条点「角色」打开，里面是 36,488 个本地角色（随包数据，都有触发词和预览图），支持中英双语联想、收藏和最近两个页签、作品搜索筛选（3,702 个作品），键盘也能操作。点一个角色，它的基础提示词就写进节点的 Prompt 输出；把 `prompt_settings` 里原有的角色类别关掉，就等于换人。整个过程是本地选词拼接，不调用 LLM，离线、确定、毫秒级。

## 面板

本地管理面板有八个栏目：LoRA 管理、LoRA 探索、画师系列、Prompt 库、图片解析、Outputs 图片管理、服装库、设置。节点那边另有画廊、批量提示词、图像选择、文本类节点。

<p align="center">
  <img src="screenshots/panel-lora-grid.png" width="31%" alt="本地 LoRA 管理">
  <img src="screenshots/panel-outputs.png" width="31%" alt="Outputs 图片管理">
  <img src="screenshots/tk-danbooru-gallery.png" width="31%" alt="TK 多重画廊">
</p>

逐项功能、参数范围和操作细节写在 [`docs/FEATURES.md`](docs/FEATURES.md) 里，包括各个 LoRA 节点、本地 LoRA 管理、LoRA 探索、画师系列、Prompt 库、图片解析、Outputs、设置，TK 作图节点（多重画廊、批量提示词注入、图像选择），TK 文本与提示词节点（Prompt Cards、Prompt Saver、Text Join、String Router、Danbooru Tag Getter、空 Latent），还有一份数据持久化说明：哪些数据存在哪、更新插件会不会丢。

## 批量提示词节点和配套的 AI 撰写 skill

![TK 批量提示词注入](screenshots/tk-prompt-batch.png)

TK Prompt Batch（批量提示词注入）读本地提示词文件，按组批量出图。一组就是一张图，批量任务由服务端控制器按组顺序执行，一组跑完才排下一组，不依赖浏览器一直开着。提示词文件放在 ComfyUI 的 `input/prompts/` 目录里，格式长这样：

```txt
## 组1 · 单人日常 · 教室窗前
masterpiece, best quality, score_9, year 2025, highres, safe, 1girl, [角色], [系列], [通用标签...]
相机: from the side, low angle        # 可选:该组的机位

## 组2 · 双人 · 海边黄昏
masterpiece, best quality, score_9, year 2025, highres, safe, 2girls, [角色A], [角色B], [系列], [通用标签...]
```

标题行支持 `## 组N · 标题`、`【N】标题`、`01 序号` 三种写法，`#` 开头是注释，组内可以写 `相机:` 行（不计入提示词）。节点上点「选择文件…」或「最新」加载，勾了「自动用最新文件」以后每次队列都会自动用最新的 txt。

想省事可以让 AI 帮你写这种文件，仓库里带了配套 skill：[`skill/anima-prompt-writer/SKILL.md`](skill/anima-prompt-writer/SKILL.md)（标准正向撰写，SFW 安全版）。它按固定顺序排标签（质量、美学、时代、meta、安全、人数、角色、系列、画师、通用），再补一句空间构图，最后落到 `input/prompts/` 下正确的目录和格式。没有数据集，规则就是唯一标准。

装法是把 `skill/anima-prompt-writer` 复制到你用的 AI 的 skills 目录（比如 Claude Code 的 `~/.claude/skills/` 或 DSH 的 `~/.dsh/skills/`），之后跟它说「写提示词」就行。

## 部署与更新

### 翻译源

Prompt Cards 的「翻译状态」里能选翻译源，目前支持本地词典、DeepLX、百度翻译、MyMemory、Google 和通义。所有需要联网翻译的入口（包括 Outputs 里的 PNG 提示词翻译）都走同一个 `/api/translate` 路由。

百度翻译在 Prompt Cards 的「翻译状态 → 百度设置」里配，要百度开发者信息里的 APPID 和 API Key，可以选机器翻译（`nmt`）或大模型翻译（`llm`），也能加术语库。百度配置只写在本机 `data/translation_providers.json`，这个文件已经进了 Git 忽略，不会随仓库提交。接口细节看[百度大模型文本翻译 API 文档](https://fanyi-api.baidu.com/doc/21)。

### 插件更新

TK 批量 LoRA 加载器上的「更新」按钮会在节点加载后检查一次，之后每 5 分钟再看一次。手动点会立刻强制检查。检查的不只是 `VERSION`，还会比 GitHub `main` 的提交和发布文件指纹，所以同一个版本号下的代码推送也能发现。

发现有更新就点「一键更新」，后端会从 GitHub 下更新 ZIP，完整下完并校验目录结构之后，只覆盖插件的发布文件（`__init__.py`、`anima_*.py`、`web/`、`app/` 这些）。`data/`（包括 Prompt 库镜像和它的 `.bak`）、模型、`input/`、`outputs/`、凭据和用户配置都不会被删或覆盖；校验没过也不会替换现有文件。

更新完要用绘世启动器重启 ComfyUI，然后在浏览器按 `Ctrl + Shift + R` 强刷。关掉节点窗口或浏览器不影响更新请求，但结束 ComfyUI 进程会中断正在下载的包。

「一键更新」因为网络、权限或者运行目录不可写而失败的话，可以手动来：

```text
Git 安装: 在 custom_nodes/ComfyUI-Anima-Batch-LoRA 目录执行 git pull
ZIP 安装: 下载 GitHub → Code → Download ZIP,将 ZIP 内层的仓库内容覆盖到
          ComfyUI/custom_nodes/ComfyUI-Anima-Batch-LoRA
```

ZIP 装完要确认 `custom_nodes/ComfyUI-Anima-Batch-LoRA/__init__.py` 就在这一层，不能多套一层 `仓库名-main/`。不管走哪种方式，最后都要用绘世启动器重启 ComfyUI。

完整改动记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 从源码重建面板

`app/` 是构建产物，日常用不着管它。改了面板源码才需要重建：

```bash
cd panel
npm install
npm run build:comfyui   # 类型检查 → 打包 → 部署到 ../app
```

开发的时候用 `cd panel && npm run dev`（Vite 热更新，接口代理到本地 ComfyUI）。推到 panel 目录的改动会由 GitHub Actions 自动重建 app。

## 目录结构

```
ComfyUI-Anima-Batch-LoRA/
├── __init__.py           # 后端接口（/anima/*，存元数据）
├── anima_batch_lora.py   # 节点逻辑
├── web/js/               # 节点前端（不用构建）
├── app/                  # 面板构建产物（克隆即用，别手改）
├── panel/                # 面板源码（Vite + TypeScript）
├── skill/                # 配套 AI skill（anima-prompt-writer）
├── screenshots/          # 截图
└── .github/workflows/    # 自动构建 app
```

## 依赖

- ComfyUI（2024 年之后的版本都行）
- 只有重建面板时才需要 Node 18+
