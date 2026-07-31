# ComfyUI-Anima-Batch-LoRA

ComfyUI 自定义节点：**批量 LoRA 加载器** + 内嵌的 **Anima 本地 LoRA 管理面板**（一键包，clone 即用）。

## ✨ 功能

**Anima Batch LoRA Loader 节点**
- 支持 `<lora:name:weight>` 批量语法，一次加载多个 LoRA
- 可视化编辑器：权重滑块、拖拽排序、触发词提取/复制、验证标签
- 分类 / 收藏 / 置顶（元数据存插件目录 `anima_meta.json`，重启不丢）
- 本地 LoRA 浏览弹窗：列表 / 大图网格切换、虚拟滚动、C 站预览图懒加载、搜索、排序、批量添加

**本地 LoRA 管理面板**（构建产物在 `app/`，浏览器打开即用）
- File System Access API 扫描本地 LoRA 目录，SHA-256 匹配 Civitai，展示 C 站信息
- 本地 LoRA 管理、Outputs 图片元数据解析、Prompt 高频词统计等

## 📦 安装（一键）

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ararararararaki/comfyui-local-manager.git
```

然后**重启 ComfyUI**。

> 💡 面板使用**相对路径**加载资源，clone 后**目录名可任意**，ComfyUI 会自动识别该自定义节点。

## 🚀 使用

- **节点**：ComfyUI 中搜索 `Anima Batch LoRA Loader`，粘贴 `<lora:name:weight>` 标签或点「📂 本地」从列表添加
- **面板**：**无需单独启动**——面板由 ComfyUI 直接提供。ComfyUI 启动后，点菜单栏的「🎨 Anima」按钮即在新标签页打开；也可直接访问 `http://localhost:8188/extensions/<目录名>/app/`（`<目录名>` 为你在 custom_nodes 下的 clone 目录名，端口非 8188 请替换）

## 🔧 从源码重建面板

`app/` 是已构建产物，日常使用无需构建。修改面板源码后重建：

```bash
cd panel
npm install
npm run build:comfyui   # 类型检查 → vite build → 部署到 ../app
```

- **开发模式**：`cd panel && npm run dev`（Vite 热更新，API 经代理到 `http://localhost:8188`）
- **CI**：push 到 `panel/` 的改动会由 GitHub Actions 自动重建并提交 `app/`

## 📁 目录结构

```
ComfyUI-Anima-Batch-LoRA/
├── __init__.py           # 后端路由（/anima/* API、元数据持久化）
├── anima_batch_lora.py   # 节点逻辑 + LoRA 列表/桥接 API
├── web/js/               # 节点前端 widget（无需构建）
├── app/                  # 面板构建产物（clone 即用，勿手改）
├── panel/                # 面板源码（Vite + TypeScript）
└── .github/workflows/    # 自动构建 app/ 的 CI
```

## 依赖

- ComfyUI（2024 之后版本，含 `folder_paths`、`PromptServer`）
- 面板构建仅需 Node 18+（仅开发/重建时需要）

## License

MIT
