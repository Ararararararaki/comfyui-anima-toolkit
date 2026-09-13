# -*- coding: utf-8 -*-
"""追加 TK Prompt Cards 交接条目到 HANDOFF.md（GBK 编码保持）。"""
import io, os

path = r"E:\claude program\civitai\HANDOFF.md"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

section = """

---

## ⭐ 最新交接（2026-08-17 · TK Prompt Cards 节点 + 批生成注入目标修复）

### A. 本日修复：TK Prompt Batch 注入目标失效导致批生成异常（commit 2ee95d6）
- **症状**：添加二采工作流后批量生成只第一组正常，其余 ~1s 内中断；历史里 6 个任务提示词完全相同（注入未生效）
- **根因**：正向注入目标被清空/失效 → 注入静默失败 → 相同提示词重复入队 + 自动重排反复提交
- **修复**：队列前强制校验正向/负向注入目标（缺失/失效**阻止批次**并在节点 UI 红字报错）；逐任务注入失败立即中止并列出可用 widget；`_fillTargets` 不再静默清空已选目标（保留「已保存」选项）；目标选择按 workflow id+node id 持久化 localStorage；新增目标状态行；auto_queue 永不展开批量（防 instant/change 模式把同一批反复重提交）
- **用户需知**：刷新浏览器后重新选择正向目标（状态行变绿）

### B. 新节点 TK Prompt Cards（commit 5edc8fb，方案与用户逐项确认后实现）
- **定位**：独立新节点，tag 粒度英中对照卡片库；与 TK Prompt Batch 并存（批量编排 vs 单次编辑）
- **后端** `anima_prompt_cards.py`：节点三输出 STRING+CONDITIONING(可选clip)+lora_syntax；可选 opt_text 并入
  - `/anima/cards` CRUD → `input/prompt_cards/cards.json`（一级分类+预置：角色/服饰/姿势/场景/画风/质量词/LoRA触发词）
  - `/anima/cards/export` 导出批文件（分类=组、卡片逗号拼接、含中文注释行）
  - `/anima/cards/image` PNG 元数据解析（PIL；正片优先 CLIP 类 longest）
  - `/anima/cards/lora-triggers` 触发词（bridge→Civitai trainedWords→空，缓存 10min）
  - 翻译**复用现有 `/api/translate`**（local/deeplx/mymemory/google/dashscope 回退），未重复实现
- **前端** `web/js/anima_prompt_cards_widget.js`：三区（①批文件组浏览+悬浮预览+一键切换+组内翻页 ②当前提示词 textarea+逗号拆卡 chips+剪切板导入+PNG 解析+草稿自动暂存/恢复+整段存组合卡 ③卡片库分类页签+点击追加智能去重+双击就地编辑+右键软删除撤销+星标置顶+批量补翻+浏览LoRA存触发词卡+追加触发词同步 lora_syntax+导出）
- **测试** `tests/cards_widget_logic.test.js`：18 用例（拆分/去重/删除/语言检测）VM 内全过
- **视觉验证** `tests/verify_cards_node.py`：Playwright 添加节点+三区断言+截图（需 ComfyUI 重启后跑）
- **关键交互**：切组前自动存草稿；长句(>60 含英文逗号)整保留不拆；中文分隔符优先切；双向语言检测翻译（zh→en / en→zh）

### C. 待办/后续
1. TODO：TK Prompt Batch 节点 UI 交互优化已完成（摘要行/悬浮预览/拖拽排序，commit cc09616）
2. **2026-08-18 重要澄清**：用户所指「本地提示词库」= **TK Toolkit（civitai 面板）的 prompt 库**（IndexedDB `anima-lora`，与面板同源共享）！
   已把 TK Prompt Cards 存储层切换为直接读写该库（commit c279ff5）：
   - ①区=工具箱库浏览（分类/搜索/点击切换），「批文件导入」整组导入为 kind=prompt 条目
   - ③区=kind=card 卡片（notes=中文注释、isFavorite=星标、扩展 weight/lora/multi）
   - 面板零改动兼容（IndexedDB 无 schema 约束）；空库自动初始化默认分类
   - 验证：Playwright 端到端全过（存卡自动翻译→IndexedDB→①区同步/追加去重）
3. 可选二期：卡片库 PNG 批量导入、组合卡展开拆 tag、拖拽排序、LoRA 完整集成（二期）
4. 发新版本时：VERSION + __init__ __version__ + CHANGELOG 同步递增
"""

with open(path, "w", encoding="utf-8") as f:
    f.write(content + section)
print("HANDOFF.md updated, size:", os.path.getsize(path))