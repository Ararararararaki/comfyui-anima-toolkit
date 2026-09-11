# Anima Toolkit · ComfyUI-Anima-Batch-LoRA

一个 ComfyUI 自定义节点 + 配套本地管理面板:批量挂 LoRA、可视化管理模型、解析返图参数、整理提示词。

当前发布版本: **2.7.1**。Outputs 列表、预览图、元数据摘要全部由本地后端直出：秒开、按钮随卡片同现、不再模糊。

## 最近更新（2026-09-11 · 2.7.x）

- **Outputs · 元数据后端化（2.7.0）**：左侧列表与「复制 Prompt / 复制 LoRA 标签」等按钮所需的元数据摘要改由后端索引（`/anima/gallery/manifest`）直出，打开页面即全部就位，点击即用；完整工作流/Prompt 点击时按需获取。首次打开自动建索引（约十几秒，仅一次），之后永久秒开。正向提示词提取覆盖 UI/API 双格式工作流（实测 99.7%）。
- **Outputs · 左侧目录树消失修复（2.7.1）**：2.7.0 曾导致刷新后左侧文件夹树消失、需重新「选择目录」。现已修复：历史授权自动恢复、树照常显示；无授权时目录树由索引路径直接生成（无需重新授权）。
- **Outputs · 预览图秒开 + 高清（2.6.0）**：卡片图片改由后端 `/anima/thumb` 直出 512px 高质量 WebP（落盘长期复用），单张从约 1.4MB 原图降为 30KB 级小图，滚动到哪立即加载；后端不可用时自动回退旧管线。
- **Outputs · 浏览时点击无响应修复（2.6.0）**：元数据到位后改为逐卡增量同步，滚动浏览期间点击目录树、切换栏目即时响应（实测点击延迟 6ms、长任务 0 个）。

- **TK D站画廊**：搜索预设会根据 Danbooru 标签自动生成中文备注，并在预设下拉框与管理器中显示；同一工作流里多个画廊节点的页数、分类、搜索和筛选设置保持独立。Prompt 悬停预览按输出类别分组，预览图操作继续保留。
- **TK Danbooru Tag Getter**：`natural_language`（前端显示「统一 Prompt」）可直接接普通 Prompt 或 Packer `ALL_TAGS`，自动识别已知 Tag 并分类；每一类可独立调整 0.05–2.0 权重，1.0 保持原样；旧工作流恢复出的 0 权重会自动修正为 1.0；支持“保留自然语言”开关；`tag_bundle` 仍兼容旧的分类包接法，正则/精准排除可单独作用于自然语言。
- **TK 服装抽卡**：服装库读取改为会话级轻量快照，预览图采用并发限流和小型缓存；工作流快照升级为 v2，仅保存当前抽卡结果和必要元数据，避免把整库或图片 Blob 塞进工作流，同时兼容旧 v1 快照。
- **TK Prompt Cards**：①区已选具体分类时，「存入 prompt 库」直接写入该分类；隐藏卡片状态和整段 Prompt 的分段行为继续保持，避免刷新或入库时丢失用户的分组意图。
- **Prompt 库持久化**：Prompt 库继续使用 IndexedDB 提供快速读取，同时自动合并写入插件目录 `data/prompt_library.json`（并保留 `.bak` 回滚副本）。面板、TK Prompt Cards、TK Prompt Saver 共用这份镜像；清理浏览器站点数据、切换 `localhost/127.0.0.1` 或更新插件后，启动会自动恢复缺失条目。设置中的「导出全部数据」也包含 Prompt 库，导入按 ID 合并，不会用旧备份覆盖新条目。

这组改动需要将插件目录更新到最新提交；其中 Python 节点输入 schema 的变化需要重启 ComfyUI，纯前端样式/脚本变化刷新浏览器即可。

## 目录

- [使用插件](#使用插件)
- [TK 节点目录](#tk-节点目录)
- [功能总览](#功能总览)
- [TK 批量提示词节点](#tk-批量提示词节点--配套-ai-撰写-skill)
- [部署与更新](#部署与更新)
- [更新日志](#更新日志)
- [开发者:从源码重建面板](#开发者从源码重建面板)
- [目录结构](#目录结构)

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
- `TK/camera`: **TK 相机控制**、**TK 可动素体相机**。前者保留原有机位控制；后者用极简可动空壳素体作为角度参照。
- `TK/batch`: **TK 批量提示词注入**。按提示词文件分组批量出图,支持独立机位和批次控制。
- `TK/prompt`: **TK Prompt Cards**、**TK Prompt Saver**、**TK 光影提示词**。管理提示词卡片、翻译与保存，并通过单一下拉框输出 Anima Base 光影预设。
- `TK/image`: **TK 图像选择**。在多路图像输入之间按策略选择并输出来源信息。
- `TK/latent`: **TK 空Latent 图像**。生成 Anima/Cosmos 5D 空 latent，支持宽高整体缩放、常用宽高比悬浮选择，以及以 1536px 标准长边生成具体尺寸。
- `TK/Danbooru`: **TK D站画廊**。按标签搜索、筛选、下载和输出 Danbooru 图片及元数据。
- `TK/text`: **TK 文本合并**、**TK String Router**、**TK Danbooru Tag Getter**。合并文本、切换字符串输入、选择和筛选 Danbooru 分类。

## 功能总览

> 每个模块的完整功能清单与操作细节见 [功能详解文档](docs/FEATURES.md)

### 1. LoRA 加载节点(Anima Batch LoRA Loader)

![LoRA 加载节点](screenshots/node-lora-loader.png)

批量把 LoRA 挂到节点上,全程可视化操作:

- 直接粘贴标签即可读取:把 `<lora:xxx:0.8>` 标签(触发词组合)复制粘贴进 `lora_syntax` 文本框,立刻解析成列表,不需要在面板里逐个挑选
- 一键复制触发词:点 LoRA 名字即可复制它的触发词,方便写提示词
- 「本地 LoRA」可视化浏览窗:递归显示 LoRA 根目录及子目录中的文件,看得到 C 站预览图,点图就加入节点,支持分类、置顶、收藏
- 每个 LoRA 独立控制:开关(关掉的不参与生成但保留在列表)、权重调整(-2 到 2,支持负值)、拖拽排序、删除
- 「验证标签」:检查输入里的 LoRA 本地有没有,缺的可以一键复制名称去 C 站搜
- 「提取触发词 / 全部触发词」:从当前标签里快速取用触发词
- 「组」:把常用的 LoRA 组合存起来,一键切换
- 「面板」按钮:直达本地管理面板
- 「更新」按钮:自动检查版本号、Git 提交和发布文件指纹;发现更新后可安全一键更新
- URL 下载:支持后台下载、断线重试和 `.part` 断点续传;重新提交同一 URL 会从已有部分继续

### TK 可动素体相机

这是一个新建的独立相机节点,旧的 **TK 相机控制** 节点和已有工作流不受影响。

- 素体由低面数球体、圆柱和体块程序化组成,没有 GLB、纹理、贴图、衣服或外部模型下载
- 关节按层级组成基础 FK 骨架,保留头部、颈部、胸腔、腰部、肩、肘、髋、膝等主要控制点,手腕和脚踝只保留为末端轮廓
- 点击关节后拖拽可修改 X/Y 旋转,也可直接编辑 XYZ;支持 A-Pose、T-Pose、重置、姿势保存和恢复
- 鼠标拖拽画布环绕观察,滚轮调整距离;支持正面 / 侧面 / 背面 / 俯视 / 仰视快捷机位,并可调整倾斜角与 FOV
- 输出继续复用 `TK 相机控制` 的 `CameraControlCore` 提示词算法;`camera_meta` 额外带 yaw、pitch、distance、roll、FOV 和完整姿势 JSON
- 提示词参数面板提供左右方位、上下方位、距离方位、倾斜角四项权重;距离按远景/中景/近景/全身/特写五档识别,档内权重随距离滑块连续变化;支持滑块与数字输入,步进 0.1,当前相机 Prompt 会实时预览
- 空闲时只在状态变化或尺寸变化后渲染一帧,节点删除时清理 Three.js 几何体、材质、监听器和渲染资源

### 2. 本地 LoRA 管理(面板)

![网格视图](screenshots/panel-lora-grid.png) · ![详情视图](screenshots/panel-lora-detail.png)

Steam 风格界面,管理全部本地 LoRA:

- 扫描 + 自动匹配 C 站信息:递归扫描选定目录及其子目录,保留相对路径,文件大小、SHA256、基础模型、版本、下载数、点赞数自动对上
- 「子目录建分类」:按一级子目录名称自动创建/复用分类,并把对应 LoRA 归入分类
- 网格 / 列表视图 + 搜索 + 排序(按名称、大小、时间);网格卡片参考 LoRA Manager,显示大预览、版本、下载/点赞数和分类标签
- 自定义预览图:卡片或详情页可上传图片、设置图片 URL、恢复 C 站图片;上传图压缩后保存在浏览器 IndexedDB,不会塞进扫描缓存
- 分类管理:人物 / 风格 / 背景 / 姿势 / 光影…支持拖拽归类、批量分类、自定义分类
- 大库流畅性:列表分片渲染(首屏 150 张、滚动到底自动追加)+ 扫描/匹配进度节流,数千 LoRA 下切页、弹窗、滚动不卡顿
- 详情面板:文件信息、「我的备注」(写使用心得、推荐搭配)、触发词编辑、LoRA 强度滑块、分类标签
- 一键操作:CIVITAI(打开 C 站原页)、COMFYUI(直接加入工作流)、复制标签、删除文件
- 「关联出图」:看这个 LoRA 用过的返图,右下角一键跳进 Outputs

### 3. 图片解析(面板)

![图片解析](screenshots/panel-metadata.png)

- 拖拽 / 点击上传一张 ComfyUI 生成的原图 PNG
- 自动解析出:正面 prompt、负面 prompt、模型、采样器、步数、CFG、种子、工作流
- 一键复制 prompt、翻译、复制 LoRA 标签
- 「发送到 Outputs」把图送进图片管理 / 「保存到 Prompt 库」归档复用
- 「下载工作流 .json」一键复现生成参数
- 高频词统计:基于最近 N 张返图统计常用 tag,辅助写提示词

### 4. Outputs 图片管理(面板)

![Outputs](screenshots/panel-outputs.png)

- 浏览 ComfyUI 输出目录,按日期 / 文件夹组织
- 收藏、置顶、打分、重命名、删除、复制 prompt / LoRA 标签 / 工作流
- 拖拽框选批量操作 + 快捷键(全部/收藏/评分筛选)
- 目录选择、刷新、重解析、高级筛选;搜索文件名/模型/提示词
- 点开任意图片查看元数据、下载工作流

### 5. Prompt 库(面板)

![Prompt 库](screenshots/panel-promptlib.png)

- 保存提示词,可带关联图片(从图片解析一键存进来)
- 分类管理:人物 / 画师风格 / 背景环境 / 光影氛围 / 细节增强 / 常用 / 自定义
- 搜索、收藏、复制 PROMPT、编辑、删除

### 6. 画师系列(面板)

管理画师风格标签:
- 搜索画师名/Tag/描述;工具栏:+ 添加、提取、默认、批量、导入、导出、DANBOORU 更新(从 Danbooru 同步)
- NAI / WebUI 画师串:点卡片组合 → 复制 / 粘贴画师串一键导入 / 解析导入
- 保存预设 / 我的预设:常用组合一键复用

### 7. LoRA 探索(面板)

浏览 C 站 LoRA(Anima 生态,下载量 > 250、赞/下载比 > 5%):

- 多维筛选:下载量排序、模型类型、时间范围(全部/本月/本周)、搜索名称/描述/标签/作者
- 抓取全部 / 自动翻页批量加载、选择多选模式、手动添加(URL 添加)
- 分类 tab:全部 / 画师风格 / 人物角色 / 美学优化 / 背景环境 / 其他 / 收藏 / 已隐藏
- 检测本地是否已有,卡片上直接下载

### 8. TK 节点系列(十二个配合作画节点)

![TK 相机控制(3D 画布)](screenshots/tk-camera-control.png) · ![TK 批量提示词注入](screenshots/tk-prompt-batch.png) · ![TK D站画廊](screenshots/tk-danbooru-gallery.png)

十二个配合作画的新节点(批量 LoRA 加载器见上面第 1 节):

- TK 相机控制:3D 画布上直接拖拽机位(相对滑动,可连续绕到背面/俯仰),景别(距离)、倾斜角、最大/最小权重;支持 19 个预设,一键出相机词并联动批量提示词节点
- TK 批量提示词注入:读取 `input/prompts/` 提示词文件按组批量出图(一组 = 一张图);支持每页一组独立机位(`相机:` 行)、子目录分组、整批统一机位
  - 批任务控制器(2026-08-24):批量由服务端逐条链式执行(不再依赖浏览器劫持队列),每条任务有稳定状态(排队/执行/成功/失败/跳过/中断)与自铸造 `prompt_id` 精确追踪;节点面板实时显示进度,支持暂停 / 继续 / 失败重试 / 跳过单条 / 取消,绿对号直接看到每组产物文件名;批次清单持久化在 `data/batches/`,刷新页面或重启 ComfyUI 后可在节点上恢复未完成批次并重跑中断任务;点 ComfyUI 的 Queue 按钮或节点「开始批次」均可发起
- TK D站画廊:按标签搜索 Danbooru(Novelu&Danbooru 图库)图片,多选输出 IMAGE + Prompt + metadata_json(结构化元数据:Danbooru ID / 原始标签数组 / Prompt 分组 / 输出设置 / rating / score / 收藏数 / 尺寸 / 文件类型 / 视频标记 / 原图 URL / 失败原因),下游可直接筛选与复现;内置分级/时间/评分/收藏筛选、Prompt 类别/格式控制、双语 tag 预览、下载、入 Prompt 库
  - D站风控自救:当 Danbooru 的 Cloudflare 把出口节点 IP 拦成「Just a moment」人机校验页时(表现为搜索失败/一直转圈/请求超时),节点会自动隐形式拉起本机 Edge/Chrome 作为内置浏览器网关继续搜索与下载,无需手动换节点;偶发仍被拦请到 Clash Verge 换一个节点/地区。
  - 依赖:云风控自救需 ComfyUI 的 Python 环境装有 `playwright`(`pip install playwright`);未装时自动降级为直接请求并给出提示。
  - 中英文联想搜索 + 回车直搜:输入英文或中文片段时,搜索框下方会浮出双语候选、英文标签和 D 站帖数,候选支持模糊匹配且不占节点布局空间;点击候选即可替换当前词。输入近似词/拼写错误(如 `standin`)精确搜不到时会自动纠错成真实标签(如 `standing`)并重搜出图,搜索框直接按 回车 即可搜索,无需点「搜索」按钮。
  - Prompt 输出独立开关:关闭 Prompt 输出只让 Prompt 端口返回空字符串,图片和 metadata 仍按已选图片正常输出;旧工作流继续兼容。
- TK 批量 LoRA 加载器:见第 1 节——批量挂 LoRA、触发词/全部触发词一键复制、本地 LoRA 可视化浏览、权重滑块、分组保存
- TK 图像选择:多路图像路由(image1~image8,用几路接几路 2~8 任意;未接的自动跳过、至少一路有效)。五种路由模式:优先顺序(默认,首选为空自动按 image1→image8 兜底)/ 指定索引 / 随机 / Seed 稳定(同 seed 可复现) / 轮询(循环换源);另输出 source_index(来源编号 1~8)+ source_name(imageN),下游可精确知道图源。典型场景:D站画廊图源接 image1、自定义图源接 image2/3…,生图来源一键切换,不必改连线;输出恒为列表,兼容 D站画廊列表输出与下游单输入节点
- TK Prompt Cards(提示词卡片库编辑器):英中对照 tag 卡片拼/存提示词、②区支持逐片段隐藏/恢复（隐藏片段保留在卡片区但不进入上方 Prompt 输出）、“翻译未翻译片段”会跳过已有卡片中文注释和已完成译文；中文片段可选择翻译源并校准为 Danbooru 规范标签（支持单条翻译/自然语言语义解析；自动回退含本地 Argos，DeepLX 按需启动；支持百度翻译 APPID + API Key，设置位于翻译状态中的“百度设置”，接口参考[百度官方文档](https://fanyi-api.baidu.com/doc/21)）、批文件一键切换、工具箱 Prompt 库条目双击弹窗编辑保存、①区库面板高度可拖拽调整、可选 CLIP 直接编码输出 CONDITIONING、`lora_syntax` 直连批量 LoRA 节点、LLM 自动分类、PNG 解析、导出批词文件；②区输入联想使用 `data/danbooru_tags_with_description_v3_modified.csv`，支持英文、中文说明和模糊匹配，结果按标签匹配级别与 D 站帖数排序
- TK Prompt Saver(提示词保存):6 路 STRING 输入,支持单选/多选和每路名称;节点执行时自动将开启且非空的提示词写入 TK Toolkit 与 TK Prompt Cards 共用的 Prompt 库,对应 `image_1` 到 `image_6` 可作为预览图保存
- TK 光影提示词:一个“分类｜预设”下拉框切换 Anima Base 光影组合,默认“通用｜平衡柔光”不限定昼夜、室内外或主光方向;可选启用 `custom_tags` 追加自定义光影标签,输出固定为带末尾英文逗号的 `lighting_prompt` STRING
- TK Trigger Words(触发词):从 `<lora:name:weight>` 提取触发词(bridge 触发词优先,无记录时文件名兜底),支持手动追加、卡片编辑、一键复制
- TK Text Join(文本合并):按逗号/空格/换行合并 4 路文本,自动清理连续逗号
- TK String Router(字符串路由):6 路 STRING 输入,支持单选/多选放行、拖拽交换输出顺序、自动读取连线源节点/输出名称、接口别名和工作流保存
- TK Danbooru Tag Getter(Danbooru 分类提取):单一 Prompt 输入即可自动识别并分类 Danbooru Tag,每类可单独设置 0.0–2.0 权重,可选保留自然语言;兼容 `TAG_BUNDLE`,支持正则排除和精准 Tag 排除,输出清理去重后的 `Tag String`
- TK 空Latent(预设空 Latent):Anima/Cosmos 5D 单帧空 latent;节点内支持宽高整体乘以 0.5 到 0.9 及 1.1 到 1.5,缩小/放大倍率分左右两列竖排显示;比例菜单按 1536px 标准长边列出竖向具体分辨率和倍率,尺寸自动取整为 16 的倍数

#### TK Danbooru Tag Getter

> 兼容性说明：权重控件的有效范围为 `0.05–2.0`；旧工作流若恢复出初始 `0`，会自动按中性权重 `1.0` 处理，不会生成 `(tag:0)`。

节点前端显示的「统一 Prompt」输入可直接接普通 Prompt、Packer 的 `ALL_TAGS` 或其他 STRING。勾选任一具体分类后,节点会按本机 Danbooru 数据库识别已知 Tag 并归类;未识别的句子由「保留自然语言」控制。分类按固定顺序合并,不需要填写 `category_name`。

每个分类行右侧的 `×` 数值是该分类的 Tag 权重,范围 `0.05–2.0`,步进 `0.05`;默认 `1.0` 时输出原始 Tag,例如设置「角色表情词」为 `0.8` 会输出 `(smile:0.8)`.输入本身已经带权重时会与分类权重相乘,例如 `(smile:1.2)` × `0.5` 输出 `(smile:0.6)`.自然语言句子不会被分类权重包裹。旧工作流若把新增权重控件恢复成 `0`,节点会在加载/执行时按中性权重 `1.0` 处理,不会生成 `(tag:0)`。

如果上游已经提供 Packer 的「分类数据包」 (`TAG_BUNDLE`),仍可将其连接到兼容输入并直接按分类提取;旧工作流的双输入语义保持不变。新的单输入模式不需要同时连接两条线。

节点底部的「正则排除」使用不区分大小写的正则匹配;「精准排除」支持逗号或换行分隔,按不区分大小写的完整 Tag 匹配。筛选只作用于本节点输出,不会修改上游 `TAG_BUNDLE`。

节点的 `tag_bundle` 和 `natural_language` 都是可选输入。单输入时只需把普通 Prompt 或 `ALL_TAGS` 接到 `natural_language`(前端显示「统一 Prompt」);勾选具体分类启用自动分类,「保留自然语言」决定未知句子是否附在分类结果后。默认应用正则/精准排除,并可单独关闭「过滤自然语言」。

#### TK 光影提示词

在 `TK/prompt` 中添加 **TK 光影提示词**，平时只需切换一个“分类｜预设”下拉框，再把 `lighting_prompt` 接到 **TK 文本合并**、CLIP 文本编码或其他正向提示词流程。默认“通用｜平衡柔光”用于亮/暗、室内/室外和图生图场景，不指定太阳、月亮、窗户、霓虹或主光方向。

节点提供 4 个完全通用预设，以及室内、室外、时段、夜景、方向和氛围专用预设。高级用法可打开“启用追加”并在 `custom_tags` 中写入逗号或换行分隔的额外光影 tag；节点会去空、去重并统一输出成 `tag1, tag2, tag3,`，不会附加预设名称、质量词或画风词。为避免给 Anima 制造无效权重语法，本节点不提供数值强度滑块，强弱差异由经过审视的预设本身表达。

#### TK Prompt Saver

将其他 STRING 节点连接到 `prompt_1` 到 `prompt_6`,将对应预览图连接到 `image_1` 到 `image_6`,在节点内选择单选或多选、设置每路显示名称和 Prompt 库分类。节点执行时会自动保存已开启且非空的输入;多选时每路保存为一条独立 Prompt,对应图像会作为该条 Prompt 的预览图,不需要额外保存按钮。保存内容使用 TK Toolkit 与 TK Prompt Cards 共用的 `anima-lora` Prompt 库,可在工具箱查看,也可在 TK Prompt Cards 的①区读取并调用。

#### TK String Router

节点内每一行对应一个固定输入接口。多选模式下,拖动行左侧的 `⠿` 把手到另一行即可交换**输出顺序**,不需要拆线或重新连接;顺序保存在工作流的隐藏配置中,旧工作流默认使用 `1 → 6` 的原顺序。单选模式的选中接口仍按原输入编号保存,不会因重排而改变。

每行下方会显示当前连线源节点的标题和输出名称(例如 `TK Text Join · text`),连接或断开后自动刷新。默认优先读取画布上显示的自定义节点名,也可在“名称”下拉框切换为原始节点名；名称框留空时使用该动态标签作为提示,填写后则作为本节点内的自定义别名。拖拽中会显示占位高亮和短过渡动画,用于确认落点。

### 9. 服装库(面板)

![服装库](screenshots/panel-clothing.png)

- 服装卡片库,平铺分类(裙装/泳装/制服/袜类…)自定义分组
- AI 抽卡:随机抽 N 套服装串复制合并,写词即"已抽卡"
- 导入(合并不删旧卡)/导出,支持逐张勾选预览
- 任何增删改自动同步 AI 检索索引,写词时自动按分类可用

#### TK 服装抽卡

新增 `TK 服装抽卡` 节点直接读取同一浏览器中的 `clothing-db` 服装库。节点支持按全部/收藏/分类随机抽取一张服装卡,也可打开类似 LoRA 浏览器的图片网格手动选择。节点内显示服装图片、名称、分类和完整提示词,输出 `服装提示词`、`服装名称`、`服装分类` 与 `服装数据` 四路 STRING。

服装名称复用卡片库已有的 `name` 字段,节点内重命名会同步写回工具箱。图片仅作为节点和选择弹窗预览,不会默认编码进工作流或输出为 IMAGE,以避免本地图片 Blob 让工作流膨胀。随机抽取使用种子稳定复现;修改工具箱服装后在节点点击「刷新库」。工具箱与 ComfyUI 必须使用同一个浏览器配置和同一个地址/端口打开,否则浏览器会把 IndexedDB 视为不同数据源。

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

把仓库克隆到 ComfyUI 的 custom_nodes 目录:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ararararararaki/comfyui-anima-toolkit.git
```

然后通过绘世启动器重启 ComfyUI。app 目录已经预先构建好,不用装依赖也不用重新构建,克隆完就能用。

### 翻译源配置

Prompt Cards 的「翻译状态」中可以选择翻译源,当前统一支持本地词典、DeepLX、百度翻译、MyMemory、Google 和通义。需要联网翻译的入口(包括 Outputs 的 PNG Prompt 翻译)复用同一套 `/api/translate` 路由。

百度翻译在 Prompt Cards 的「翻译状态 → 百度设置」中配置,需要百度开发者信息中的 APPID + API Key,并可选择机器翻译(`nmt`)或大模型翻译(`llm`),以及术语库干预。百度配置仅保存到本机 `data/translation_providers.json`,该文件已加入 Git 忽略,不会随仓库提交;官方接口细节见[百度大模型文本翻译 API 文档](https://fanyi-api.baidu.com/doc/21)。

### 插件更新

TK 批量 LoRA 加载器的「更新」按钮会在节点加载后检查一次,之后每 5 分钟复查一次。手动点击「更新」会立即强制检查;检查的不只是 `VERSION`,还包括 GitHub `main` 的提交和发布文件指纹,因此同一版本号下的代码推送也能被发现。

发现更新后点击「一键更新」,后端会从 GitHub 下载更新 ZIP,完整下载并校验目录结构后,只覆盖插件发布文件(`__init__.py`、`anima_*.py`、`web/`、`app/` 等)。更新过程不会删除或覆盖 `data/`（包括 Prompt 库镜像及其 `.bak`）、模型、`input/`、`outputs/`、凭据和用户配置;校验失败也不会替换现有文件。

更新完成后必须使用绘世启动器重启 ComfyUI,再在浏览器按 `Ctrl + Shift + R` 强制刷新。关闭节点窗口或浏览器不会影响更新请求,但结束 ComfyUI 进程会中断正在下载的更新包。

如果「一键更新」因网络、权限或运行目录不可写而失败,可使用下面的手动方式:

```text
Git 安装: 在 custom_nodes/ComfyUI-Anima-Batch-LoRA 目录执行 git pull
ZIP 安装: 下载 GitHub → Code → Download ZIP,将 ZIP 内层的仓库内容覆盖到
          ComfyUI/custom_nodes/ComfyUI-Anima-Batch-LoRA
```

ZIP 安装后必须确认 `custom_nodes/ComfyUI-Anima-Batch-LoRA/__init__.py` 直接存在,不能多套一层 `仓库名-main/` 目录。更新和手动覆盖都完成后,仍需通过绘世启动器重启 ComfyUI。

## 更新日志

完整版本记录见 [CHANGELOG.md](CHANGELOG.md)。最近的 2.3.0 推送主要包含:

- `f83d00e`: LoRA 浏览和面板扫描递归读取子目录,并保留相对路径,避免不同目录下的同名 LoRA 混淆。
- `ad3b2b8`: 本地工具箱新增「子目录建分类」,按一级目录名称创建/复用分类并批量归类对应 LoRA。
- 节点浏览接口统一使用跨平台的 `/` 相对路径,Windows 和 Linux 工作流命名保持一致。

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
