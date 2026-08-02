# Anima Toolkit · ComfyUI-Anima-Batch-LoRA

一个 ComfyUI 自定义节点，带一个配套的本地管理面板。用来方便地管理 LoRA、查看图片参数、整理提示词。

## 功能

### LoRA 加载节点

把 LoRA 批量挂到节点上，配合可视化操作：

- 点 LoRA 名字能复制它的触发词
- 点「本地 LoRA」按钮打开浏览窗，能看到本地 LoRA 的 C 站预览图，点图就能加入节点，还能分类、置顶、收藏
- 每个 LoRA 有一个开关，关掉的不参与生成但还留在列表里，方便以后重新打开
- 每个 LoRA 能单独调权重、拖拽排序、删除
- 「验证标签」会检查输入里的 LoRA 本地有没有，缺的可以一键复制名称去 C 站搜
- 「组」可以把常用的 LoRA 组合存起来，一键切换
- 点「面板」按钮进入本地管理面板

### 本地管理面板

打开方式：ComfyUI 顶部菜单会有一个菲比图标按钮，点它就能进；或者从节点的「面板」按钮进。

- Outputs 图片管理：浏览 ComfyUI 输出目录的图片，可以收藏、置顶、打分、重命名、删除、复制 prompt / LoRA 标签 / 工作流，支持拖拽框选批量操作和快捷键
- 图片解析：拖入一张带元数据的图（ComfyUI 生成的原图），能解析出正负面 prompt、参数、生图模型、LoRA 标签、工作流，可以翻译、复制，还能一键存进 Prompt 库
- Prompt 库：存提示词，可以分类
- 本地 LoRA 管理：Steam 风格界面，扫描本地 LoRA，自动匹配 C 站信息，看预览图、复制触发词、从 Outputs 返图
- 画师系列：管理画师风格标签，组合成画师串复制（待优化）
- LoRA 探索：浏览 C 站 LoRA，手动用 URL 添加、分类、检测本地是否已有，可以在卡片上直接下载（待优化）

## 部署

把仓库克隆到 ComfyUI 的 custom_nodes 目录：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ararararararaki/comfyui-anima-toolkit.git
```

然后重启 ComfyUI。app 目录已经预先构建好，不用装依赖也不用重新构建，克隆完就能用。

## 开发者：从源码重建面板

app 目录是构建产物，日常使用不用管它。改面板源码后需要重建：

```bash
cd panel
npm install
npm run build:comfyui   # 类型检查 → 打包 → 部署到 ../app
```

开发模式用 `cd panel && npm run dev`（Vite 热更新，接口代理到本地 ComfyUI）。推送到 panel 目录的改动由 GitHub Actions 自动重建 app。

## 目录结构

```
ComfyUI-Anima-Batch-LoRA/
├── __init__.py           # 后端接口（/anima/*，存元数据）
├── anima_batch_lora.py   # 节点逻辑
├── web/js/               # 节点前端（不用构建）
├── app/                  # 面板构建产物（克隆即用，别手改）
├── panel/                # 面板源码（Vite + TypeScript）
├── screenshots/          # 截图
└── .github/workflows/    # 自动构建 app
```

## 依赖

- ComfyUI（2024 年之后的版本）
- 只有重建面板时才需要 Node 18+

觉得好用的话点个 star 支持一下，后续还会继续优化。
