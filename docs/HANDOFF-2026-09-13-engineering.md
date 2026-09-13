# 工程化收尾交接（2026-09-13 · 会话二）

> 承接 `docs/HANDOFF-2026-09-13.md`（画廊瀑布流 / outputs 自动更新 / 版本真源化）。
> 本文件覆盖其后完成的 **P0–P3 全部工程化**：CI、测试分层、Registry、Release、`__init__.py` 拆分。
> 审计依据：`docs/工程化审计-2026-09-13.md`。

## 0. 一句话现状

**P0–P3 全部落地并通过验证**（离线层 **81 用例** + `run_tests.py` **5/5** + 真实 ComfyUI 运行时导入 **14 节点**）。
**GitHub Release `v2.10.0` 已发布**（仓库此前 **0 个 release、0 个 tag**）。
**repo description + 10 个 topics 已设置**（此前均为空）。
**`__init__.py` 2657 → 2448 行**，第一阶段拆分完成。
**运行目录已同步，但运行中的 ComfyUI 未重启** —— 需你用**绘世启动器**重启（见 §6）。

## 1. P0：CI + 测试分层

### 1.1 只读验证 CI（`.github/workflows/ci.yml`，新增）

`contents: read`、不做任何提交、**与负责提交 `app/` 的 `build-app.yml` 完全分开**。
步骤即失败环节，一眼可见：

```
ci: python-compile            →  py_compile __init__.py anima_*.py
ci: ai-verify                 →  节点注册 / README 图片与链接 / 版本一致性 / Registry 元数据
ci: pytest (离线层)            →  python -m pytest tests -q
ci: js-tests (Node)           →  tests/run_tests.py --js
ci: panel-typecheck           →  npm ci && npx tsc --noEmit
ci: panel-build               →  npm run build:comfyui:ci（只验可构建，产物不提交）
```

- **不会形成循环**：验证 job 无写权限（结构性保证）+ `build-app.yml` 只在 `panel/**` 变化时跑且识别 bot 提交；
- **减少重复安装**：`setup-python` 的 `cache: pip`（`cache-dependency-path: requirements-dev.txt`）+
  `setup-node` 的 `cache: npm`（`panel/package-lock.json`）；
- **push 到 main 与 PR 都跑**；`app/**`、`screenshots/**` 变化被 `paths-ignore` 跳过；
  同分支旧跑动 `concurrency` 自动取消。
- **故意不跑 integration**：那些脚本要真实浏览器（本机 Chrome/Edge 绝对路径）+ 真实 ComfyUI(`:8188`)，
  GitHub runner 上不可能满足，硬跑只会假红→CI 被忽略。本机：`python tests/run_tests.py --integration`。

### 1.2 一键入口 `tests/run_tests.py`（新增）

本地跑的**就是** CI 跑的那一套（编译 / 离线 pytest / ai_verify / JS / panel tsc），
缺依赖时优雅 SKIP 而不是假红（没有 `node` → SKIP JS；没有 `panel/node_modules` → SKIP tsc）。

### 1.3 测试分层（`tests/README.md` + `tests/layer-manifest.json`）

`tests/` 有 **105 个文件**，按「依赖什么」分成 7 层（清单由 `tests/tools/classify_tests.py` 生成）：

| 层 | 位置 | 数量 | CI |
|---|---|---|---|
| unit | `tests/*.py` | 23 | ✅ |
| js | `tests/js/` + 顶层 `*.mjs` | 3 | ✅ |
| integration | `tests/integration/` | 57 | ❌ |
| smoke | `tests/smoke_*.py` | 4 | ❌ |
| repro | `tests/repro/` | 12 | ❌ |
| tools | `tests/tools/` | 5 | 单独调用 |
| fixture | `clothing_draw_ui_harness.html` | 1 | — |

`tests/test_layer_manifest.py` 在**清单过期**或**离线层混入浏览器/:8188 依赖**时 FAIL（两条守卫）。

### 1.4 ⭐ 途中挖出并修掉的 5 类真问题（都不是"顺手改"

1. **11 个"脚本式"测试根本没在跑**：模块顶层写 `assert` / `sys.exit()` →
   pytest 要么收集期 `INTERNALERROR`，要么**导入时执行且失败不报告（静默假绿）**。
   已修：7 个加 `__main__` 守卫、4 个把断言搬进 `def test_*`。
   其中包括 `test_update_archive.py`（安全更新 ZIP 的回归）——**它此前从未被 pytest 跑过**。
2. **`test_prompt_library_persistence.py` 的断言引用了一个不存在的变量**
   （`PROMPT_LIBRARY_BACKUP_PATH`，真实名字是 `..._LEGACY_BACKUP_PATH`）→ 从来没绿过。
3. **`test_batch_lora_sorting.py` 断言整串 HTML**，而真实 HTML 带 `selected` 与后缀 → 从来没绿过。
   已改为语义级正则（只锁"排序键存在"，不锁 HTML 细节）。
4. **`test_lora_subdir.py` / `test_prompt_library_persistence.py` 用 importlib 按路径加载**，
   模块内相对导入必炸；已改为「合成包 + stub 运行时」。
5. **`ai_verify.py` 用 `❌`/`⚠️`** → GBK 控制台下**只在有 FAIL 时崩溃**（会话一已修，此处记录）。

### 1.5 ⭐ 两个必须知道的测试坑（已写进 `tests/README.md`）

- **`pytest.ini` 必须在 `tests/` 里，不能放仓库根**：本仓库根**就是** `__init__.py`（ComfyUI 插件入口，
  且用相对导入）。pytest 会为测试模块向上一级找包边界并导入它 → 必然
  `ImportError: attempted relative import with no known parent package` → 全部 setup ERROR。
  `rootdir` 由**配置文件所在目录**决定，所以配置放 `tests/` 即可。
  **实测无效、别再试**：`import-mode=importlib`（pytest 9 的 ini 没这个选项）、`pythonpath = .`、
  `conftest` 里的 `collect_ignore`、`tests/__init__.py`、`--import-mode=append`、`--rootdir` 覆盖。
- **`tests/conftest.py` 必须 stub ComfyUI 运行时**（`folder_paths` / `server.PromptServer`）：
  它在收集测试模块**之前**导入，是唯一能先补占位的位置；真实安装里是 no-op。

## 2. P0：版本真源化（会话一完成，此处补 Registry 一环）

| 位置 | 约束 |
|---|---|
| `VERSION` | **唯一真源** |
| `__init__.py::__version__` | 运行时读 `VERSION`（`_FALLBACK_VERSION` 兜底） |
| `README.md`「当前发布版本」 | 必须一致 |
| `CHANGELOG.md` 最新条目 | 必须一致 |
| `pyproject.toml` `[project].version` | 必须一致（**发布给 Registry 的版本号，发过就不能重发**） |
| `docs/FEATURES.md` | 不写死版本号（已清掉残留的 v0.4） |

`ai_verify.py` 现有 **9 项**检查，其中版本相关 3 项（一致性 / 文档过期引用 / Registry 元数据）。
`tests/test_ci_config.py` 另加 2 条 pytest 级守卫（pyproject 版本一致、requirements 最小化）。
**负向测试通过**：把 README 改回 2.9.0 → 两处 FAIL；还原 → 全绿。

## 3. P1：Release / 元数据 / Registry

### 3.1 GitHub Release `v2.10.0` ✅ 已发布

https://github.com/Ararararararaki/comfyui-anima-toolkit/releases/tag/v2.10.0

- notes **从 CHANGELOG 提炼**（未添加原文没有的条目），**Breaking Change 已醒目标注**：
  `TK 相机控制` 退役 → 用 `TK 可动素体相机`（参数/端口一一对应、预设与权重算法同一套，换节点即可）；
  并提示**升级后需重启 ComfyUI**。
- **发布前判断**：`VERSION`/`README`/`CHANGELOG` 三者一致且都等于 2.10.0、远端 main = `184760e4`
  确实就是 2.10.0 的内容 → 因此 `v2.10.0` 打在**当前 main**（而不是把未提交的新改动混进 2.10.0）。

### 3.2 repo description / topics ✅ 已设置（此前都是空）

```
description: Anima Toolkit for ComfyUI — all-in-one LoRA manager (batch apply, Civitai metadata &
             downloads), Danbooru search/gallery, prompt management, output gallery over
             ComfyUI/output, and batch workflow utilities.
topics:      anima, civitai, comfyui, comfyui-custom-nodes, comfyui-nodes, danbooru,
             generative-ai, lora, lora-manager, prompt-manager
```

工具：`.workbuddy/tmp/gh_meta.py`（token 从 `~/.my-credentials` 读，**不打印**）。

### 3.3 ComfyUI Registry（代码侧完成，需你人工 2 步）

新增 `pyproject.toml`（按**当前**规范 https://docs.comfy.org/registry/specifications 写，
不是旧教程）：

- `[project]` name `anima-toolkit` / description / version `2.10.0` / license /
  `dynamic = ["dependencies"]` ← 由 `requirements.txt` 提供；
- `[tool.comfy]` `PublisherId = "Ararararararaki"` / `DisplayName` / `Icon = ""`（留空，比放错 URL 好）/
  `requires-comfyui = ">=0.3.0"`（本机实测 ComfyUI 0.33.1，取保守下限）。

依赖拆成两份，避免给所有用户强拉重包：

- `requirements.txt`（**必需**，Registry 会装）：`aiohttp`、`requests`；
- `requirements-optional.txt`（可选）：`playwright`（D站风控自救）、`llama-cpp-python`（本地 LLM 翻译）。
- **刻意不声明** `torch` / `numpy` / `PIL`：ComfyUI 自带，重复声明会引发版本冲突。

**需要你人工完成的最后两步**：
1. 到 https://registry.comfy.org 创建 publisher，**核对 id 就是 `Ararararararaki`**（创建后不可改）；
   若不同，改 `pyproject.toml` 的 `PublisherId`。
2. `pip install comfy-cli` → `comfy node publish`（首次会要 Registry API Key）。
   （可选）补一个方形 ≤400×400 的图标后把 `Icon` 填成可公网访问的直链。

## 4. P2：`__init__.py` 拆分第一阶段

**2657 → 2448 行**；新增 `services/github_update.py`（约 420 行）+ `services/__init__.py`。

- 拆的是 **GitHub 自动更新链**（版本比较 / 发布文件白名单 / 遍历 / git blob sha /
  检查更新 / 下载 ZIP / 校验暂存 / 应用+回滚 / 状态落盘）。
  实测它只依赖「一个 aiohttp session」与「插件目录路径」，其余自洽 —— **边界最清晰的一块**。
- **`__init__.py` 保留薄适配层**（`_version_tuple` / `_get_update_info` / `_stage_update_archive` …），
  外部与测试无需改动；**两条路由也留在 `__init__.py`**（所有 `/anima/*` 的唯一入口要集中）。
- 会话目录用**显式注入** `configure(plugin_dir=, session_getter=, apply_lock=, check_lock=)`，
  不用 import 回 `__init__`，避免循环导入。
- **安全防护逐行照搬**（未"顺手简化"）：路径穿越校验（`..` / 绝对路径 / `commonpath` 越界）
  + 应用失败时的**逐文件回滚**。新模块 docstring 里写明了"改之前先读对应断言"。

**验证**：

- 离线层 81 用例全绿（含刚转正的更新 ZIP 回归）；
- **用 ComfyUI 自带 python 真实导入**：`__version__=2.10.0`、**14 个节点全在**、
  注入全部生效（`_PLUGIN_DIR` / `session_getter` / `apply_lock` / `check_lock`）、
  `_version_tuple("2.10.0")==(2,10,0)`、`is_release_path("web/js/x.js")=True` / `("data/secret.json")=False`。

### ⚠️ 4.1 拆分过程中的一次真实事故（已恢复，务必读）

`test_update_archive.py` **把测试假内容写进了真实仓库**：覆盖了根 `__init__.py`（变成 `"new init"`）、
`VERSION`（变成 `9.9.9`）、`app/index.html`，还新造了 `web/js/update.js`。

**两个独立成因**：

1. 该测试**拆分前就有隐患**：它把 `PLUGIN_DIR` 指向临时目录，但 `_stage_update_archive` 的第二个参数
   写成 `str(temp_path / "invalid-stage")`（作者本意应是临时根）——写错了变量；
   而旧断言只查 `module.PLUGIN_DIR`（被改过的那个），**没查被 `shutil.copy2` 动过的真实文件**。
2. 拆分让它立刻爆炸：委托之后改 `__init__.PLUGIN_DIR` 不再影响真正写盘的模块。

**修法（三条一起做才有效）**：

- 目标目录改成真正的临时目录；
- `_set_update_module_plugin_dir()` **设置后立刻断言"生效了"**，不生效就直接失败（宁可不跑）；
- `_snapshot_guarded_files()` / `_assert_guarded_files_unchanged()`：跑前后快照比对
  `__init__.py` / `VERSION` / `app/index.html`，被改就报「测试污染真实工作树」。

**恢复方式**：`git checkout -- VERSION app/index.html` + 从
`.workbuddy-bak-tests-20260913/__init__.py.pre-split` 恢复 `__init__.py` 并重跑确定性拆分脚本
+ 删除测试新造的文件。**已全部恢复并复验。**

## 5. P3：Pages / SEO

`https://ararararararaki.github.io/comfyui-anima-toolkit/` 由 **Jekyll 渲染 README**（`github-pages` 默认主题），
所以"更新主页"= 更新 README —— 本轮 README 第一屏已重写：

- H1 带英文关键词；首段英文一句话定位（"all-in-one toolkit for Anima workflows in ComfyUI"）；
- 引用块英文 TL;DR 列出解决的 5 件事（LoRA 管理 / Civitai 集成 / 提示词管理 / Danbooru 工具 / 出图管理）
  + 关键词行；
- 新增「这个项目解决什么（10 秒版）」表格；
- **中文仍是主体**，详细文档全部保留。

**没做也不建议做的**：给 README 加 Jekyll front matter。加 `---` 会让 **GitHub 仓库页面上的 README
也走 Jekyll 渲染**（可能不再正常显示），为了一个 meta description 冒这个风险不值得。
Pages 内容当前是旧的，只是**因为改动还没推送**——推送后 Jekyll 会自动重建。

顺带修掉一处文档漂移：README 第 8 节标题写「十一个」、正文写「十二个」
（删除 `TK 相机控制` 后遗留）。**已改为不写死数量**并注明"以实际注册为准"。

## 6. ⚠️ 需要你做的事

### 6.1 用绘世启动器重启 ComfyUI（必须）

运行目录的 py **已同步**（`__init__.py` / `anima_batch_lora.py` / `anima_prompt_library.py` /
`services/`），但**运行中的实例仍是旧加载状态**。实测当前 `/anima/version` 仍返回 `2.9.0`，
`/anima/gallery/fresh` 仍 404 —— 都是"未重启"的正常表现。

**请用绘世启动器重启**（你明确要求过：命令行重启会丢启动参数、出图变慢）。重启后确认：

- `/anima/version` 返回 `2.10.0`；
- `/anima/gallery/fresh` 返回 JSON（新端点生效）；
- 节点菜单里有 `TK 可动素体相机`、**没有** `TK 相机控制`；
- 画廊工具栏有「热门随机 / 优质随机 / 高收藏随机 / 换一批」。

### 6.2 ComfyUI Registry 人工步骤

见 §3.3：创建 publisher（核 id）+ `comfy node publish`。

### 6.3 发布（推送）决策

**本轮改动尚未推送，也尚未为它们定版本号。** 当前状态：

- 远端 main = `184760e4`，`v2.10.0` release 已指向它；
- 本地有一批未提交改动（画廊瀑布流 / outputs 自动更新 / CI / 测试分层 / Registry / `__init__` 拆分）。

建议：把本地这批作为 **2.11.0** 发布（改 `VERSION` + `__init__._FALLBACK_VERSION` + `CHANGELOG`
+ `README` + `pyproject.toml` 五处，`ai_verify` 会替你守住一致性），
走既有发布链：合并仓库 commit → `.scratch/api_push_guard.py`（先 `--dry-run`）→ CI → `reset --hard FETCH_HEAD`。
**注意 AGENTS.md 的硬约束**：禁止外部直推 main，只用 `api_push_guard.py`；推送后本地对齐用 `FETCH_HEAD`。

## 7. 本轮验证汇总（全部通过）

| 项目 | 结果 |
|---|---|
| `python tests/run_tests.py` | **5/5**（编译 / 离线 pytest / ai_verify / JS / panel tsc） |
| `python -m pytest tests -q` | **81 passed** |
| `python tests/tools/ai_verify.py -q` | **9/9** |
| 真实 ComfyUI 运行时导入 | **14 节点全注册**、版本 2.10.0、注入生效 |
| 版本漂移负向测试 | 注入 README=2.9.0 → **FAIL**；还原 → **PASS** |
| worktree 污染守卫 | 跑完 `test_update_archive.py` 后 `__init__.py`/`VERSION`/`app/index.html` **字节不变** |

## 8. 遗留 / 未做（诚实清单）

- **`__init__.py` 只拆了第一阶段**（更新链）。剩余仍很大：DeepLXManager、Civitai 图片代理与
  LoRA 下载、翻译路由（约 800 行，占最大块）、bridge、服装库索引、内置 app 静态服务、LoRA meta。
  **建议下一个拆翻译路由**，但它与 `_detect_proxy` / DeepLX 管理器耦合，需先理清再动。
- **`data/batches/bworker.json` 是运行时状态却被 git 跟踪**（非本轮引入）。建议加 `.gitignore`；
  `git rm --cached` 会影响已有部署，**需你确认**。
- **integration 层（57 个脚本）只能在有 ComfyUI + 浏览器的机器上跑**，CI 永远不跑。
- `verify_danbooru_gallery_batch.py` 的确定性失败仍未修（会话一记录）。
- `screenshots/tk-danbooru-gallery.png` 仍是旧 UI（布局已换，建议重截）。
- `CONTRIBUTING.md` 仍缺。
- 运行目录 `tests/` 只有 7 个文件，**跑不了完整回归**（要跑请用发布仓库）。
- ComfyUI Manager 收录：一般以 Registry 发布为前提，故先做 Registry；Registry 上线后再按其规范提交。

## 9. 本轮新增/修改文件速查

**新增**：`.github/workflows/ci.yml`、`tests/pytest.ini`、`tests/conftest.py`、`tests/run_tests.py`、
`tests/README.md`、`tests/layer-manifest.json`、`tests/tools/classify_tests.py`、
`tests/tools/list_path_exprs.py`、`tests/tools/fix_script_style_tests.py`、
`tests/test_ci_config.py`、`tests/test_layer_manifest.py`、`services/__init__.py`、
`services/github_update.py`、`requirements.txt`、`requirements-optional.txt`、`pyproject.toml`、
`docs/工程化审计-2026-09-13.md`、`docs/HANDOFF-2026-09-13.md`、`docs/HANDOFF-2026-09-13-engineering.md`（本文件）。

**移动**：12 个一次性脚本 → `tests/repro/`；`ai_verify.py` / `update_handoff.py` → `tests/tools/`；
4 个浏览器型 `test_*.py` → `tests/integration/`。

**修改**：`__init__.py`（拆分）、`anima_batch_lora.py`（`/anima/gallery/fresh`）、
`anima_prompt_library.py`（备份路径派生改为现算 —— 见下）、`web/js/anima_danbooru_gallery_widget.js`、
`web/css/anima_danbooru_gallery.css`、`README.md`、`docs/FEATURES.md`、`tests/tools/ai_verify.py`、
`tests/test_danbooru_gallery_image_efficiency.py`、`tests/test_danbooru_gallery_settings_scope.py`、
`tests/test_batch_lora_sorting.py`、`tests/test_update_archive.py`、`tests/test_lora_subdir.py`、
`tests/test_prompt_library_persistence.py`、5 个加 `__main__` 守卫的测试。

### 附带修掉的一个真 bug（`anima_prompt_library.py`）

`PROMPT_LIBRARY_BACKUP_PATHS` / `PROMPT_LIBRARY_LEGACY_BACKUP_PATH` 在**导入时**从 `PROMPT_LIBRARY_PATH`
派生并固化成常量，而 `save_snapshot` 用的是**当前**`PROMPT_LIBRARY_PATH`。
后果：`DATA_DIR` / `PROMPT_LIBRARY_PATH` 一旦被改（测试隔离必做），**主文件写新位置、备份写旧位置**，
而 `load_snapshot` 又去新位置找备份 → 备份链整体失效；实测还把测试数据写进了仓库 `data/`。
现已改为 `_backup_paths()` / `_legacy_backup_path()` **现算**（保留旧常量名兼容），
并清掉了被污染的 3 个 `.bak.*`。
