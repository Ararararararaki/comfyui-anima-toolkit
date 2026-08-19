# TK D站画廊下拉控件与局部重构计划

## 目标

将“分级、筛选、分类”统一为紧凑的选择框外观；分级支持持久化多选，筛选支持悬浮与点击都可用的级联子菜单，并把重复的“排行”入口收归排序的唯一状态源。

## 需求与基线

- 用户已批准“混合式智能下拉 + 针对性重构”。
- 保留后端 `/anima/danbooru/*`、搜索标签、图片卡片、Prompt 入库、下载和输出契约。
- 前端交互 owner 仍是 `web/js/anima_danbooru_gallery_widget.js`；新增菜单模块只负责弹层生命周期、定位、级联和键盘交互。
- 当前分级 UI 写入逗号多值，但 `loadSettings()` 只接受单值；本次统一为规范化数组并兼容旧字符串。

## TDD Route

- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Test posture: post-change browser regression
- Reason: 用户未要求严格 TDD；真实 ComfyUI DOM、鼠标悬浮、点击、键盘和请求计数专项检查更能覆盖风险。
- Verification: JS 语法检查、真实端点、CDP 下拉专项、运行目录 SHA256、GitHub Actions。

## Change Necessity

- User-visible need: 当前 `<details>` 不像分类下拉，缺少完整样式，展开内容会被节点裁切。
- No-change / non-code option: CSS 微调无法修复多选持久化、排行双 owner 和每次变更立即请求。
- Why code change is necessary: 必须统一状态、弹层生命周期和应用时机。
- Minimum change boundary: 画廊 widget、菜单模块、画廊样式、专项验证和交接文档。
- Decision: code-change。

## 模块与文件

- `web/js/anima_dropdown_menu.js`：深模块；小接口负责 portal、定位、外部点击、Esc、级联悬浮延迟和点击固定。
- `web/css/anima_danbooru_gallery.css`：画廊唯一样式 owner，替代 widget 内联 CSS。
- `web/js/anima_danbooru_gallery_widget.js`：搜索/卡片/设置编排；规范化分级与筛选状态，组装三类菜单。
- `tests/verify_danbooru_dropdown.mjs`：真实 ComfyUI 浏览器回归。
- `docs/HANDOFF.md`：记录交互、owner、验证和发布状态。

## 实施任务

1. 新建 portal 下拉模块，支持一个菜单同时打开、视口夹紧、外部点击/Esc、级联悬浮 150ms、点击固定和方向键。
2. 抽出画廊 CSS，补充统一触发器、菜单、子菜单、复选项、当前值、应用/重置按钮和焦点样式。
3. 将分级状态迁移为数组；兼容旧 `"g"` 与 `"g,s"`，搜索仍生成 Danbooru 接受的 `rating:g,s`。
4. 分级菜单使用多选草稿 + 重置/应用；触发器显示 `分级 · N`。
5. 筛选菜单提供时间、最低评分、最低收藏、排序四个级联子菜单；一次应用只触发一次搜索。
6. 分类改用同一菜单壳的平面单选列表；保留“＋类”。
7. 删除独立“排行”按钮和旧 `<details>` 路径；`settings.filters.order` 继续作为唯一排序 owner。
8. 验证菜单不被节点裁切、悬浮/点击/键盘可用、旧设置迁移、多选重载、请求次数、搜索结果和其余卡片操作。
9. 真实组合筛选若超过 D站匿名搜索的 2 个计数标签限制，在前端阻止请求并由后端返回清晰 400；不再透传难懂的 422。
10. 同步运行插件目录，比较 SHA256，推送 GitHub，等待 Actions 成功并更新交接。

## 兼容与非目标

- 不修改节点稳定 ID、Python、HTTP 路由、工作流输入输出、IndexedDB Prompt 库结构。
- 旧 localStorage 继续读取；保存时写规范化新形态。
- 不重写搜索、瀑布流、图片代理或 Prompt 编辑器。

## 复杂度与退休

- 当前 widget 786 行且混合样式与菜单机制；抽离菜单和 CSS 后预计明显缩小，复杂度为 `exceeded-and-governed`。
- 退休：旧 `<details class="adg-dropdown">`、静态 `.adg-menu`、独立排行按钮、内联 `injectStyles()`。
- 不保留兼容分支；旧持久化数据只在读取边界做一次规范化。

## 完成证据

- `node --check` 全部前端脚本退出 0。
- `python -m py_compile anima_danbooru_gallery.py __init__.py` 退出 0。
- 专项 CDP 所有断言通过且无运行时异常。
- 发布源与运行目录相关文件 SHA256 相同。
- GitHub `Build panel app` / Pages 成功，仓库只剩任务开始前已有的未跟踪状态。
