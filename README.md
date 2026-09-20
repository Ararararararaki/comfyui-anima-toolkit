# TK Toolkit · ComfyUI-Anima-Batch-LoRA

**An all-in-one toolkit for [Anima](https://huggingface.co/circlestone-labs/Anima) workflows in ComfyUI** —
batch LoRA loading, a Civitai-integrated local model manager, Danbooru search, prompt management,
an output gallery, and batch-workflow utilities.

> 🇬🇧 English TL;DR — *TK Toolkit* (**formerly "Anima Toolkit"** — renamed 2026-09; same plugin, same
> registry id `anima-toolkit`, publisher 时运tk / `toki`) is a ComfyUI
> custom-node pack plus a built-in web panel. It solves five everyday Anima/SD chores:
> **LoRA management** (batch apply, thumbnails, categorization, Civitai metadata & downloads),
> **Civitai integration** (match local files to models by SHA256, browse/explore, one-click download),
> **prompt management** (bilingual tag cards, translation, prompt library, **Chinese tag autocomplete**),
> **Danbooru tools** (tag search with filters, gallery, tag classifier), and **output management**
> (thumbnail gallery over your `ComfyUI/output`, PNG metadata parsing), on top of
> **batch workflow utilities** (chained multi-prompt generation, string routing, camera/pose presets).
> Keywords: `comfyui` · `comfyui-custom-nodes` · `comfyui-manager` · `anima` · `lora` · `lora-manager` ·
> `civitai` · `danbooru` · `prompt-manager` · `tag-autocomplete` · `chinese-tag-autocomplete` ·
> `stable-diffusion` · `generative-ai` · `workflow-automation`.
> The full documentation below is in Chinese (the primary author's language).
> Machine-readable summary for AI agents: [`llms.txt`](llms.txt).

<p align="center"><img src="screenshots/icon.png" width="140" alt="TK Toolkit"></p>

## Installation / 安装

```bash
# 方式一：ComfyUI-Manager 里搜索 “TK Toolkit”（节点 id anima-toolkit）
# 方式二：手动
cd ComfyUI/custom_nodes
git clone https://github.com/Ararararararaki/comfyui-anima-toolkit
# 然后重启 ComfyUI（改了 .py 必须重启）
```

- **ComfyUI Registry**: <https://registry.comfy.org/nodes/anima-toolkit>（`anima-toolkit` @ `toki`，显示名 **TK Toolkit**）
- 依赖：见 `requirements.txt`（`aiohttp` / `requests`）；可选依赖见 `requirements-optional.txt`。
- 装好后节点工具栏有「🔄 更新」，也可以走 ComfyUI-Manager 更新。
- 作者：**时运tk**（B 站同名）· 协议 MIT。

> **Not to be confused with / 别认错**：`AnimaLoraToolkit`、`AnimaLoraAtelier` 是 **训练** 工具链
> （YAML 配置训 LoRA/LoKr）。本项目 **TK Toolkit** 是 **推理侧** 工具包 —— 在 ComfyUI 里加载 /
> 管理 / 检索 LoRA，**不做训练**。

一个 ComfyUI 自定义节点 + 配套本地管理面板:批量挂 LoRA、可视化管理模型、解析返图参数、整理提示词。

当前发布版本: **2.16.0**。

## 这个项目解决什么（10 秒版）

| 你常遇到的麻烦 | 本项目的解法 |
|---|---|
| 一次挂十几个 LoRA，手动改权重 | **TK 批量 LoRA 加载器**：面板挑/批量启用、权重 scrubbing、触发词自动输出 |
| 本地一堆 `.safetensors` 不知道是什么、缺预览图 | **本地 LoRA 管理**：扫描 + SHA256 匹配 C 站，补预览图/作者/版本/下载，按底模与分类筛选 |
| 想找参考图、找画师风格 | **TK 多重画廊**：Danbooru 标签搜索 + 分级/时间/评分/收藏筛选 + 瀑布流 + 随机发现 |
| 提示词散落各处、中英对照费劲 | **Prompt 卡片库 / Prompt 库**：中英对照卡片、翻译与校准为 D站规范标签、一键入库复用 |
| 出图后不知道参数、找不到历史图 | **Outputs 图片管理**：后端缩略图直出、PNG 参数索引、一键复制 Prompt / LoRA 标签 |
| 想一次跑一批不同提示词 | **TK 批量提示词**：多组提示词串行出图 + 每组独立机位 |

## 最近更新（2026-09-16 · 2.14.0）

- **多源画廊（D站 / C站 / P站）**：`TK 多重画廊` 节点新增**图源下拉**，同一个节点切换三个图源；前端由后端声明的 **capabilities 驱动控件显隐**，不再出现"点了没反应的开关"。
- **C站 / P站 图源**：C站 支持排序 / NSFW 档位 / 时间窗 / 作者 / 模型浏览并取回完整 Prompt 与采样参数；P站 走 OAuth 2.0 + PKCE 授权后可关键词搜索，定位是**素材**（不提供 Prompt，选中后送 WD14 反推）。
- **图源密钥面板**：C站 API key 与 P站 授权分开管理（**只回显掩码**），各自落盘在 `data/` 下，不进仓库。
- **画廊视觉重做 + 一批交互修复**：去掉发光与彩色 glow；修掉操作条隐形吃点击、悬停 Prompt 浮层被裁切、节点"慢慢变小"的正反馈、纵向拉大不加载更多图。
- **Prompt Cards 联想键盘**：`Tab` 接受候选、`Enter` 还给换行、输入法组字期间不拦截按键。

更早版本的完整改动记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 目录

- [安装](#installation--安装)
- [这个项目解决什么](#这个项目解决什么10-秒版)
- [使用插件](#使用插件)
- [TK 节点目录](#tk-节点目录)
- [面板功能](#面板功能)
- [TK 批量提示词节点 + 配套 AI 撰写 skill](#tk-批量提示词节点--配套-ai-撰写-skill)
- [部署与更新](#部署与更新)
- [开发者:从源码重建面板](#开发者从源码重建面板)
- [目录结构](#目录结构)
- [依赖](#依赖)

> 📖 **完整功能手册**（每个模块的逐项说明、参数范围、操作细节）见 **[`docs/FEATURES.md`](docs/FEATURES.md)**。

## 使用插件

### 安装

把仓库放到 ComfyUI 的 `custom_nodes` 目录中:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ararararararaki/comfyui-anima-toolkit.git
```

然后通过绘世启动器重启 ComfyUI。仓库已经包含可直接使用的 `app/` 面板构建产物,普通用户不需要安装 Node.js 或重新构建。

### 进入节点和工具箱

- ComfyUI 节点菜单中搜索 `TK`,所有本插件节点都放在 **TK** 根目录下,按用途分在 `TK/loaders`、`TK/camera`、`TK/batch`、`TK/prompt`、`TK/image`、`TK/latent`、`TK/Danbooru` 和 `TK/text`。
- 顶部的 **TK Toolkit / 本地工具箱** 按钮可以打开管理面板;也可以在 **TK 批量 LoRA 加载器** 节点中点击「面板」。
- 工具箱设置页可以上传图片或填写 URL,自定义 ComfyUI 顶部的入口图标;恢复默认即可使用仓库内的菲比图标。图标配置保存在当前浏览器,与设置导入/导出一起保存。
- 直接访问面板: `http://localhost:8188/extensions/ComfyUI-Anima-Batch-LoRA/app/`

### LoRA 管理推荐流程

1. 在节点菜单的 `TK/loaders` 中添加 **TK 批量 LoRA 加载器**,连接 `MODEL`,需要输出 CLIP 时再连接 `CLIP`。
2. 在节点中点击「本地 LoRA」打开浏览窗,或从面板进入本地 LoRA 管理。
3. 点击「扫描文件夹（含子目录）」,选择 LoRA 根目录。扫描会保留相对路径,例如 `anima base/style.safetensors`。
4. 点击「子目录建分类」,按一级子目录名称自动创建/复用分类,并将对应 LoRA 归入分类。更深层目录按其一级目录归类,根目录直接放置的文件不归类。
5. 需要 C 站信息时点击「全部匹配」;之后可以查看触发词、预览图、返图、分类和权重,或发送回 ComfyUI。

浏览器不支持目录权限 API 时,工具箱会自动使用文件夹文件选择回退;Chrome/Edge 通过 localhost 访问时体验最完整。

## TK 节点目录

所有节点都位于 ComfyUI 的 **TK** 根目录下:

- `TK/loaders`: **TK 批量 LoRA 加载器**、**TK 触发词**。前者批量加载 `<lora:name:weight>` 标签,后者提取和整理触发词。
- `TK/camera`: **TK 可动素体相机**。用极简可动空壳素体作为角度参照,直接摆姿势出机位词(旧的 `TK 相机控制` 节点已退役)。
- `TK/batch`: **TK 批量提示词注入**。按提示词文件分组批量出图,支持独立机位和批次控制。
- `TK/prompt`: **TK Prompt Cards**、**TK Prompt Saver**、**TK 光影提示词**。管理提示词卡片、翻译与保存，并通过单一下拉框输出 Anima Base 光影预设。
- `TK/image`: **TK 图像选择**。在多路图像输入之间按策略选择并输出来源信息。
- `TK/latent`: **TK 空Latent 图像**。生成 Anima/Cosmos 5D 空 latent，支持宽高整体缩放、常用宽高比悬浮选择，以及以 1536px 标准长边生成具体尺寸。
- `TK/Danbooru`: **TK 多重画廊**。一个节点三个图源（D站 / C站 / P站），按标签或关键词搜索、筛选、下载并输出图片及元数据。
- `TK/text`: **TK 文本合并**、**TK String Router**、**TK Danbooru Tag Getter**。合并文本、切换字符串输入、选择和筛选 Danbooru 分类。

> 节点数量以实际注册为准：`python tests/tools/ai_verify.py` 会打印真实节点清单 —— 这里刻意不写死数字（历史上删节点后就出现过标题与正文数字不一致）。

## 面板功能

本地管理面板覆盖 **LoRA 管理**、**LoRA 探索**、**画师系列**、**Prompt 库**、**图片解析**、**Outputs 图片管理**、**服装库** 与**设置**八个栏目；节点侧另有画廊、批量提示词、图像选择、文本类节点等。

<p align="center">
  <img src="screenshots/panel-lora-grid.png" width="31%" alt="本地 LoRA 管理">
  <img src="screenshots/panel-outputs.png" width="31%" alt="Outputs 图片管理">
  <img src="screenshots/tk-danbooru-gallery.png" width="31%" alt="TK 多重画廊">
</p>

**逐项功能、参数范围与操作细节见 [`docs/FEATURES.md`](docs/FEATURES.md)**，其中包括：

- LoRA 加载节点 / 本地 LoRA 管理 / LoRA 探索 / 画师系列 / Prompt 库 / 图片解析 / Outputs / 设置
- TK 作图节点：**多重画廊**（含 D站风控自救、中英文联想搜索）· **批量提示词注入** · **图像选择**
- TK 文本与提示词节点：**Prompt Cards** · **Prompt Saver** · **光影提示词** · **Text Join** · **String Router** · **Danbooru Tag Getter** · **空 Latent**
- **数据持久化**一览（哪些数据存在哪、更新插件时会不会丢）

## TK 批量提示词节点 + 配套 AI 撰写 skill

![TK 批量提示词注入](screenshots/tk-prompt-batch.png)

TK Prompt Batch(批量提示词注入) 读本地提示词文件按组批量出图:一组 = 一张图,批量由服务端批任务控制器按组顺序执行(一组跑完才入队下一组),不依赖浏览器常驻。提示词文件放 ComfyUI 的 `input/prompts/` 目录,格式:

```txt
## 组1 · 单人日常 · 教室窗前
masterpiece, best quality, score_9, year 2025, highres, safe, 1girl, [角色], [系列], [通用标签...]
相机: from the side, low angle        # 可选:该组的机位

## 组2 · 双人 · 海边黄昏
masterpiece, best quality, score_9, year 2025, highres, safe, 2girls, [角色A], [角色B], [系列], [通用标签...]
```

- 标题行支持 `## 组N · 标题` / `【N】标题` / `01 序号` 三种;`#` 开头是注释;组内可写 `相机:` 行(不计入提示词)。
- 节点上点「选择文件…」或「最新」即可加载;勾选「自动用最新文件」后每次队列自动用最新 txt。

让 AI 帮你写这种文件:仓库自带配套 skill [`skill/anima-prompt-writer/SKILL.md`](skill/anima-prompt-writer/SKILL.md)(标准正向撰写,SFW 安全版)。它按固定标签顺序(质量→美学→时代→meta→安全→人数→角色→系列→画师@→通用)+ 一段空间构图句写正片,并自动落到 `input/prompts/` 的正确目录与格式——没有数据集,以规则为唯一标准。

安装:把 `skill/anima-prompt-writer` 目录复制到你所用 AI 的 skills 目录(如 Claude Code 的 `~/.claude/skills/` 或 DSH 的 `~/.dsh/skills/`),之后让 AI「写提示词」即可。

## 部署与更新

### 翻译源配置

Prompt Cards 的「翻译状态」中可以选择翻译源,当前统一支持本地词典、DeepLX、百度翻译、MyMemory、Google 和通义。需要联网翻译的入口(包括 Outputs 的 PNG Prompt 翻译)复用同一套 `/api/translate` 路由。

百度翻译在 Prompt Cards 的「翻译状态 → 百度设置」中配置,需要百度开发者信息中的 APPID + API Key,并可选择机器翻译(`nmt`)或大模型翻译(`llm`),以及术语库干预。百度配置仅保存到本机 `data/translation_providers.json`,该文件已加入 Git 忽略,不会随仓库提交;官方接口细节见[百度大模型文本翻译 API 文档](https://fanyi-api.baidu.com/doc/21)。

### 插件更新

TK 批量 LoRA 加载器的「更新」按钮会在节点加载后检查一次,之后每 5 分钟复查一次。手动点击「更新」会立即强制检查;检查的不只是 `VERSION`,还包括 GitHub `main` 的提交和发布文件指纹,因此同一版本号下的代码推送也能被发现。

发现更新后点击「一键更新」,后端会从 GitHub 下载更新 ZIP,完整下载并校验目录结构后,只覆盖插件发布文件(`__init__.py`、`anima_*.py`、`web/`、`app/` 等)。更新过程不会删除或覆盖 `data/`（包括 Prompt 库镜像及其 `.bak`）、模型、`input/`、`outputs/`、凭据和用户配置;校验失败也不会替换现有文件。

更新完成后必须使用绘世启动器重启 ComfyUI,再在浏览器按 `Ctrl + Shift + R` 强制刷新。关闭节点窗口或浏览器不会影响更新请求,但结束 ComfyUI 进程会中断正在下载的更新包。

如果「一键更新」因网络、权限或运行目录不可写而失败,可使用手动方式:

```text
Git 安装: 在 custom_nodes/ComfyUI-Anima-Batch-LoRA 目录执行 git pull
ZIP 安装: 下载 GitHub → Code → Download ZIP,将 ZIP 内层的仓库内容覆盖到
          ComfyUI/custom_nodes/ComfyUI-Anima-Batch-LoRA
```

ZIP 安装后必须确认 `custom_nodes/ComfyUI-Anima-Batch-LoRA/__init__.py` 直接存在,不能多套一层 `仓库名-main/` 目录。更新和手动覆盖都完成后,仍需通过绘世启动器重启 ComfyUI。

完整的版本改动记录见 [`CHANGELOG.md`](CHANGELOG.md)（当前 **2.14.0**）。

## 开发者:从源码重建面板

app 目录是构建产物,日常使用不用管它。改面板源码后需要重建:

```bash
cd panel
npm install
npm run build:comfyui   # 类型检查 → 打包 → 部署到 ../app
```

开发模式用 `cd panel && npm run dev`(Vite 热更新,接口代理到本地 ComfyUI)。推送到 panel 目录的改动由 GitHub Actions 自动重建 app。

## 目录结构

```
ComfyUI-Anima-Batch-LoRA/
├── __init__.py           # 后端接口（/anima/*，存元数据）
├── anima_batch_lora.py   # 节点逻辑
├── web/js/               # 节点前端（不用构建）
├── app/                  # 面板构建产物（克隆即用，别手改）
├── panel/                # 面板源码（Vite + TypeScript）
├── skill/                # 配套 AI skill（anima-prompt-writer 标准正向撰写）
├── screenshots/          # 截图
└── .github/workflows/    # 自动构建 app
```

## 依赖

- ComfyUI(2024 年之后的版本)
- 只有重建面板时才需要 Node 18+
