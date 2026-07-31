# Civitai Anima LoRA Explorer

浏览、搜索和收藏 Civitai 上的 Anima LoRA 模型。支持本地文件管理、ComfyUI 批量加载集成。


## 功能

- **LoRA 探索** — 浏览 Civitai Anima 生态 LoRA，按下载量/点赞/分类筛选，可检测本地是否已有，可以选版本号，可以直接在页面下载
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-1.png)
- **本地LORA管理** — 扫描本地 LoRA 文件，Civitai 自动匹配，权重调节，一键复制标签，首页可读取outputs图片的常用lora，可点击跳转
本栏目参考了https://github.com/hanbinhsh/SD-LoRA-Manager 项目的设计，给大佬点点star谢谢喵
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-2.png)
在lora详细页面可以看到c站的预览图以及本地文件名，版本号等数据，可以进行备注以及查看从outputs中的返图，可以点击直接跳转到outputs的对应图片位置
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-5.png)
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-4.png)
- **画师系列** — 画师风格标签管理与组合，Danbooru 数据集成
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-6.png)
- **Prompt 库** — 分类管理提示词，提取 LoRA 触发词
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-7.png)
- **Outputs 管理** — ComfyUI 输出目录浏览，元数据提取，批量操作，可以从图片直接复制正面prompt，点击预览后可以看到元数据包含正负面prompt等信息
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-8.png)
可进行拖拽复制
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-11.png)
快捷键
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-12.png)
高频prompt栏目 从outputs最近的图片中提取出高频词，可点击复制
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-13.png)
可通过上传带有元数据的png图片获取prompt并可翻译（一般comfyui生成的图都带有元数据）
![alt text](https://raw.githubusercontent.com/Ararararararaki/comfyui-local-manager/main/screenshots/image-14.png)



## 快速启动

```sh
npm install
npm run dev          # 开发模式 (http://localhost:5173)
npm run build        # 生产构建 → dist/
npm run preview      # 预览构建产物
```

Windows 用户也可双击 `start.bat`。

### ComfyUI 插件模式

1. 确保 ComfyUI 已安装插件 `ComfyUI-Anima-Batch-LoRA`
2. 构建并部署：
   ```sh
   npm run build
   npm run build:comfyui -- --path /path/to/ComfyUI/custom_nodes/ComfyUI-Anima-Batch-LoRA
   ```
3. 重启 ComfyUI
4. 访问 `http://localhost:8188/extensions/ComfyUI-Anima-Batch-LoRA/app/`
5. 工作流中使用 `Anima Batch LoRA Loader` 节点

## 技术栈

| 技术 | 用途 |
|------|------|
| Vite 5 | 构建工具 |
| TypeScript 5 | 语言 |
| Zustand 4 | 状态管理 |
| Dexie 4 | IndexedDB 持久化 |
| Vanilla JS | 无框架，直接 DOM 操作 |

## 目录结构

```
├── src/
│   ├── api/           # Civitai/Danbooru API 封装
│   ├── store/         # Zustand 状态管理
│   ├── sections/      # 页面面板 (8 个)
│   ├── components/    # 可复用组件
│   ├── renderers/     # 纯函数渲染器
│   ├── services/      # 服务层
│   ├── styles/        # 全局样式
│   ├── types/         # 类型定义
│   └── utils/         # 工具函数
├── scripts/           # 部署脚本
└── dist/              # 构建产物
```

## 代理配置

部分 API 需要科学上网。通过环境变量设置代理：

```sh
set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890
npm run dev
```

或修改 `start.bat` 中的代理地址。

## 许可

MIT
