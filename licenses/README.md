# 许可证与第三方来源

包含 MOSS Layout Studio 的组合发行版按根目录 GPL-3.0 许可证发布。代码及相应构建源码均随仓库提供。旧版本已经授予的 MIT 权利不会因后续更换许可证而撤销；原有代码的 MIT 声明保存在 `licenses/Toolkit-original-MIT.txt`。

本次集成 ComfyUI-MOSSLayout：`0Printemps0/ComfyUI-MOSSLayout`，固定提交 `f23d29be2eb59ae1840dfa9e92b3612db78c638a`，GPL-3.0，原作基于 Henry Lee / nynxz 的 ComfyUI-IdeogramHelper。修改后的完整前端源码、许可证、原 README、构建锁文件与说明位于 `third_party/moss_layout_studio/`；原叠框渲染器位于 `services/prompt_agent/layout_overlay.py`。

前端使用 Vue（MIT）及 `@mdi/js` 7.4.47 的 SVG 图标（Apache-2.0）。图标只打包实际使用的子集；对应许可证见 `third_party/moss_layout_studio/MDI-LICENSE`。构建过程与固定来源见该目录 `NOTICE.md`。

本变更不宣称取得其他作者代码的独占权，也不删除原作署名。后续迁入代码必须逐项核对来源、版本和许可证。

旧版一键更新器只接收固定目录；因此构建源码、锁文件和上述许可证也打包为 `web/licenses/moss-layout-studio-source.zip` 随更新提供。该归档由 `third_party/moss_layout_studio/package_source.py` 生成，不是另一份开发源码。修改编辑器后必须重新构建并生成归档。
