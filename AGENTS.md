# AGENTS.md — Tk Toolkit（ComfyUI-Anima-Batch-LoRA）

> **接手第一步**：读 `docs/HANDOFF-2026-09-13-cards-autocomplete.md`（**当前版本 v2.12.0**：
> ②区联想的中文角色名支持 —— 数据来源、匹配分级、Anima 括号转义、性能、踩过的坑）。
> 上一版状态读 `docs/HANDOFF-2026-09-13-2.11.0.md`（版本谱系「为什么是 2.11 而不是 2.9」）。
> 需要改动细节时再往下读 `docs/HANDOFF-2026-09-13.md`（画廊/outputs）与
> `docs/HANDOFF-2026-09-13-engineering.md`（CI 连红 5 次排查 + Registry 全过程）。
> 审计结论见 `docs/工程化审计-2026-09-13.md`。

## 0. 当前状态（2026-09-13 · v2.12.1）

| 项 | 值 |
|---|---|
| **版本** | **2.12.1**（`VERSION` 唯一真源；`__init__.py` 运行时读它） |
| 远端 main | `ffc5130e`（本地 == 远端） |
| **CI** | 只读验证 CI，**连续多次全绿**（`.github/workflows/ci.yml`） |
| GitHub Release | `v2.10.0`、`v2.11.0`、`v2.12.0`、`v2.12.1` |
| **ComfyUI Registry** | ✅ **`anima-toolkit` @ `toki`**：2.11.0 / 2.12.0 / **2.12.1** 均已上传待审 |
| 离线测试 | **129 passed** |
| `__init__.py` | 2657 → **2448 行**（更新链已拆到 `services/github_update.py`） |
| ⚠️ **运行目录** | py/js/data 已同步到 2.12.1，但 **ComfyUI 未重启**（需用**绘世启动器**重启） |

### 本轮（2.12.0 → 2.12.1）= ②区联想的中文角色名支持 + 更新链漏发修复

**中文角色名**（2.12.0）。核心结论：**坏的是数据覆盖与排序，不是匹配逻辑**。

- 中文角色名走 **`anima_alias_index.json`（插件根目录，8.9MB，随包发布）**，由
  `tools/build_tag_alias_index.py` 从三个**可验证**来源合成：AnimaDex 角色表
  （`tools/harvest_animadex.py`，36488 角色 / 3702 作品）、Civitai LoRA 元数据挖出的
  中文名↔danbooru 标签配对（`tools/harvest_civitai_zh_aliases.py`，2638 条带证据）、
  社区词典 + 原 CSV「关键词」字段。**没有任何 LLM 编造的中文名。**
- harvest 原始数据在 `data/_sources/`（48MB，**已 gitignore**，运行时不读）。刷新词典顺序：
  `harvest_animadex.py` → `harvest_civitai_zh_aliases.py` → `build_tag_alias_index.py` → 跑测试 → 提交。
  只换词典不改代码时按 mtime 指纹热重载，**不必重启 ComfyUI**。
- 中文查询**不再扫描 20 万条英文说明**（插件加载时后台线程预热）；英文查询 350ms → 60ms。
- **索引必须在插件根目录**，理由见下方坑 7。

**更新链漏发**（2.12.1）：见坑 7 —— 这是"老用户能不能真的用上"的关键。

**运行中的 ComfyUI 仍是旧加载状态**（本轮改了 py，必须重启才会生效）。

## 1. ⭐ 改完代码先跑这一条

```bash
cd "E:\claude program\ComfyUI-Anima-Batch-LoRA"
python tests/run_tests.py          # = CI 会跑的那一套（6 个环节）
```

涵盖：Python 编译 / 离线 pytest / **离线 pytest（模拟 CI 干净环境）** / `ai_verify` /
JS 测试 / panel `tsc`。**发布前必跑**，`0` = 全过。

单项用：

```bash
python -m pytest tests -q          # ⚠️ 必须传 tests 目录（配置在 tests/pytest.ini）
python tests/tools/ai_verify.py    # 节点注册 / README 图片与链接 / 版本一致性 / Registry 元数据
python tests/run_tests.py --integration   # 需要真实浏览器 + ComfyUI(:8188)，仅本机
```

**测试分层**（`tests/README.md` 是权威说明，`tests/layer-manifest.json` 是权威清单）：

| 层 | 位置 | CI |
|---|---|---|
| unit（25） | `tests/*.py` | ✅ |
| js（3） | `tests/js/` + 顶层 `*.mjs`/`*.js` | ✅ |
| integration（57） | `tests/integration/` | ❌ 要真实浏览器 + ComfyUI |
| smoke（4） / repro（12） | `tests/smoke_*.py` / `tests/repro/` | ❌ |
| tools（5） / fixture（1） | `tests/tools/` / `clothing_draw_ui_harness.html` | 单独调用 |

改了 `tests/` 结构后**必须**跑 `python tests/tools/classify_tests.py` 重新生成清单，
否则 `test_layer_manifest.py` 会 FAIL。

## 2. 三目录与发布链

| 目录 | 角色 | 推 GitHub |
|---|---|---|
| `E:\claude program\civitai` | 面板开发目录（`src/`） | ❌ 与远端 main **无共同祖先**；`.git/hooks/pre-push` 会**硬拦**（`TK_ALLOW_CIVITAI_PUSH=1` 可强行放行，后果自担） |
| `E:\claude program\ComfyUI-Anima-Batch-LoRA` | **合并发布仓库**（插件 + `panel/` + `web/js`） | ✅ **唯一发布出口** |
| `E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA` | 实际运行目录（非 git） | ❌ 手动同步 |

发布链：`civitai/src` → `npm run build:comfyui` → 运行目录 `app/`；同时同步到本仓库 `panel/src` → 推送 → Actions 重建 `app/`。

**改完 py 必须手动同步到运行目录并重启 ComfyUI**；纯前端（`web/js`、`web/css`）刷新浏览器即可。

## 3. 推送协议（硬约束，违反会静默丢文件）

**只用守卫脚本推送**，永不 `git push`、永不 force：

```bash
python .scratch/api_push_guard.py --dry-run    # 先看计划
python .scratch/api_push_guard.py              # 推送（遇删除默认中止）
python .scratch/api_push_guard.py --allow-delete   # 确认要删才加
```

规则（详见 `.scratch/PUSH_PROTOCOL.md`）：
- 基线取**远端 head 的 tree**（纯 API，不用本地 refs —— 本地谱系可能陈旧）
- 默认**只做加法**；「远端有、本地没有」一律中止（并发环境下几乎都是误伤）
- 推送前二次复查 head，`force:false`
- `app/` 由 CI 重建，守卫默认排除
- 推完用 `git fetch origin main && git reset --soft FETCH_HEAD` 对齐（**`origin/main` 跟踪引用解析异常，必须用 `FETCH_HEAD`**）
- **提交前 `git add` 之后要排除**：`test_gallery.py`（游离脚本，内含硬编码绝对路径）、
  `data/batches/bworker.json`（运行时状态，改一次就脏）

## 4. ⚠️ 接手必读的十个坑（都踩过，已固化防御）

1. **`pytest.ini` 必须在 `tests/` 里，不能放仓库根。**
   仓库根**就是** ComfyUI 插件的 `__init__.py`，pytest 会向上找包边界并把它当包导入 →
   全部用例 setup ERROR。**实测无效、别再试**：`import-mode=importlib`（pytest 9 的 ini 没这选项）、
   `pythonpath = .`、`collect_ignore`、`tests/__init__.py`、`--import-mode=append`、`--rootdir` 覆盖。
   `tests/conftest.py` 负责 stub ComfyUI 运行时（`folder_paths` / `server`）。

2. **测试里 stub 模块必须"看着像包"**：`m.__path__ = []`，子模块挂到父模块属性上，
   否则 `from PIL import Image` 会在 import 机制里炸。**且只在真的缺失时 stub** ——
   用空模块覆盖真 `aiohttp` 不还原会污染同 session 后续测试
   （`conftest.py` 已有守卫，会直接点名是哪个测试干的）。

3. **comfy-cli 在中文 Windows 上 GBK 崩溃**：`'gbk' codec can't decode byte 0xae`。
   必须 `python -X utf8`。**且崩溃发生在"上传之后"** → 会以为失败其实已发布成功
   （重试报 `The node version already exists` 即证）。

4. **`comfy node publish` 报 `Failed to validate token` 有两个完全不同的原因**：
   ① PAT 是在"未登录账号"下生成的（registry 里查不到 user）；
   ② `PublisherId` 含大写（registry 只接受全小写）。
   别急换 PAT，先 `python tools/registry_setup.py --token <PAT> --check` 区分。

5. **测试可能把假数据写进真实工作树。** 曾发生 `test_update_archive.py` 覆盖了仓库根的
   `__init__.py`（变成 `"new init"`）、`VERSION`（`9.9.9`）、`app/index.html`。
   根因：测试重定向了 `PLUGIN_DIR`，但写盘的是**另一个模块**的同名全局（拆分后委托关系变了），
   于是 `shutil.copy2` 打到了真实文件上。**任何会写文件的测试都必须**：
   ① 断言"重定向真的生效"；② 跑前后对真实文件做快照比对。
   （该测试现已具备这两道防线；`conftest.py` 另有 `sys.modules` 污染守卫。）

6. **`web/` 是会被 ComfyUI 服务出去的目录** —— 任何 `.js` 备份都不能放里面，
   否则浏览器把它当第二个扩展加载、`registerExtension` 跑两次（UI 重复注册，表现为按钮成对出现）。
   备份放插件根目录（`.gitignore` 已忽略 `.workbuddy-bak-*/`、`_bak_*/`）。

7. **`AUTOCOMPLETE_LOCK` 必须是 `RLock`，不能是 `Lock`。**
   `_build_autocomplete_alias_tables()` 持锁期间会再调 `_load_autocomplete_entries()`，
   而后者也要拿同一把锁 → **同线程自死锁**。症状极具误导性：
   **不报错、不退出，只是永远卡住**（预热线程和首次查询一起挂），
   探针看起来像"导入很慢"。凡是"持锁期间调用另一个也加锁的函数"，
   一律用可重入锁或把内层调用挪到锁外。

8. **别在报告失败的分支里 print emoji。** Windows 控制台是 GBK，
   `print("❌ ...")` 会 `UnicodeEncodeError`，**把真正的报错盖掉**（`ai_verify.py`
   和 `tests/tools/run_offline_like_ci.py` 都踩过，都只在"失败时"才炸）。
   脚本输出一律用 `[X]` / `[OK]` / `[!]`。

9. **新增文件前先问一句：内置更新链下不发得下去？** 更新链的发布白名单只看
   `is_release_path()`（`services/github_update.py`）：`anima_*` 前缀 / `services/` / `web/` / `app/`
   + 几个根文件；**`data/` 只逐文件放行 `_SHIPPED_DATA_FILES` 里的随包词典**。
   踩过两次：
   - 随包词典放进 `data/` → 老用户点「更新」拿到新代码却拿不到词典，功能**静默失效**
     （不报错、只是查不到）；而且 `check_update` 的 package_match 也看不见它，连"有更新"都判不出来；
   - `__init__.py` 拆分后没放行 `services/` → 老用户点更新会 ImportError、**插件整个加载不了**。
   所以：**随包数据一律放根目录并起 `anima_` 前缀**（新词典就是这么放的）；
   `services/` 已整目录放行，往里加模块不用管。
   护栏：`tests/test_update_archive.py::test_release_path_whitelist_covers_everything_the_plugin_needs_at_runtime`。
   发版前可跑一次"老用户模拟"：取旧发布 commit 的 `services/github_update.py`，
   用它的 `is_release_path` 过滤当前远端 tree，看关键文件是否在列。

10. **别在 PowerShell 里用"数组套数组"做多文件字符串替换。** 实测踩过一次真事故：
    用 `@{file = @(@("old","new"))}` 的哈希表遍历时，**单元素数组会被 PowerShell 展平成字符串**，
    于是 `$pair[0]` 变成了**单个字符**（而不是整条字符串），`String.Replace(char, char)` 把
    **所有**该字符替换掉 —— `#` 全变成空格，`AGENTS.md` 的标题、`anima_gallery.py`/`anima_thumbs.py`
    的注释全毁，**Python 直接语法错误**；`CLAUDE.md` 是 gitignore 的，**git 都救不回来**。
    规矩：① 改文件一律用 `edit` 工具（精确整串匹配，逐个改）；
    ② 非要用脚本，也必须是"每条 `(old,new)` 显式配对"，并**先 `Copy-Item` 备份**；
    ③ 批量改完立刻 `python -m py_compile` + `git diff --stat` 核对，别等到跑测试才发现。

## 5. 版本号纪律（`VERSION` 是唯一真源）

改版本**只跑这一条**，它会一处改五处同步：

```bash
python tools/bump_version.py 2.12.0     # VERSION / __init__ / README / pyproject / CHANGELOG 骨架
```

五处必须一致，任一漂移 `ai_verify` 即 FAIL：`VERSION` / `__init__.py::__version__`（运行时读 VERSION）/
`README.md`「当前发布版本」/ `CHANGELOG.md` 最新条目 / `pyproject.toml` `[project].version`。

**版本号三个口径不要混**（易错点）：

| 口径 | 当前值 | 说明 |
|---|---|---|
| 仓库版本 | **2.11.0** | `VERSION` 唯一真源 |
| GitHub tag/Release | `v2.10.0`、`v2.11.0` | **2.9 及更早从未打 tag**（v2.10.0 是 2026-09-13 补建） |
| Registry 版本 | 2.11.0 | `Pending` 待审核 |

版本谱系：2.4.0 → 2.5.x → 2.6.0 → 2.7.x → 2.8.x → **2.9.0**（`357bf1e`）→
**2.10.0**（`6d9ec25`，破坏性：相机控制退役）→ **2.11.0**（`2e071ba`）。
> 注意：2.10.0 那次升级了 `VERSION` 却漏改 README，造成过真实漂移 —— 所以现在有强制校验。

## 6. 发布到 ComfyUI Registry

```bash
python -X utf8 tools/registry_setup.py --token <PAT>          # 体检 + 发布
python -X utf8 tools/registry_setup.py --token <PAT> --check   # 只体检
```

- node id **`anima-toolkit`**、publisher **`toki`**（**均创建后不可改**）
- `PublisherId` 必须**全小写**（`ai_verify` + `test_ci_config` 已强制）
- `requirements.txt` 只放**必需**依赖；`playwright` / `llama-cpp-python` 在 `requirements-optional.txt`；
  **不要**声明 `torch` / `numpy` / `PIL`（ComfyUI 自带，重复声明会版本冲突）
- Registry 与 Manager 收录以此为准，**无需**单独提交 Manager

## 7. UI 规范

按钮/面板图标一律用 `src/utils/icon.ts` 的 `icon('name', size, cls)` 内联 SVG
（24×24、`stroke=currentColor`），**禁 emoji**；缺图标从 lucide 官方 path 补进 `PATHS`
（保持 24×24），不引入新依赖。此规范适用于面板 `panel/src/`。

## 8. 结构速查

```
__init__.py            插件入口：节点注册 + 全部 /anima/* 路由（薄适配层）
services/github_update.py   GitHub 自动更新链（2026-09-13 拆出）
anima_*.py             各节点后端（gallery / prompt_batch / batch_lora / …）
web/js/*.js            节点侧前端 widget（**无 TS 注解**，见下）
web/css/*.css          节点侧样式
panel/src/             Vite + TS 面板源码
anima_alias_index.json 中文别名/角色/作品索引（**必须在根目录** —— 只有 anima_* 前缀才会被更新链下发）
data/                  随包发布的词典（danbooru CSV / 中文词典）+ 用户状态（**更新链只逐文件放行词典**）
data/_sources/         harvest 原始数据（**已 gitignore**，构建输入，运行时不读）
tests/                 分层测试（见 tests/README.md）
tools/                 bump_version.py / registry_setup.py
tools/harvest_animadex.py            抓 AnimaDex 全量角色表
tools/harvest_civitai_zh_aliases.py  抓 Civitai LoRA 中文名证据
tools/build_tag_alias_index.py       合成 anima_alias_index.json
docs/                  交接与审计文档
pyproject.toml         ComfyUI Registry 元数据
requirements*.txt      运行 / 可选 / CI 依赖
```

**铁律：`web/js/*_widget.js` 里禁止任何 TS 类型注解。** Node 24+ 会剥离 TS 所以
`node --check` 会骗你通过，但浏览器 V8 直接抛整个文件的 SyntaxError → 节点 UI 静默不挂载。
改完 widget 必须在真实浏览器里确认节点能挂载。

## 9. 遗留（不影响使用）

- `__init__.py` 只拆了第一阶段；剩余最大的是**翻译路由（约 800 行）**，但与 `_detect_proxy` /
  DeepLX 管理器耦合，需先理清再动。
- integration 层（57 个脚本）**CI 永不跑**（要真实浏览器 + ComfyUI），仅 `--integration` 本机跑。
- `verify_danbooru_gallery_batch.py` 有确定性失败未修。
- `screenshots/tk-danbooru-gallery.png` 仍是旧 UI（布局已换，建议重截）。
- `CONTRIBUTING.md` 缺。
- 运行目录 `tests/` 只有 7 个文件，**跑不了完整回归**（请用发布仓库）。
- 待拍板：`git rm --cached data/batches/bworker.json`（会影响已有部署，**需用户确认**）。
- **中文别名词典仍有噪声**：CSV 的「关键词」字段是机器直译，会产出「万岁伸展」「味园米卡」
  这类错译，以及 `聖園`（日文汉字形）这类片段。它们排在可信来源之后，**不会抢走正确结果**，
  但会出现在下拉副标题里。要再提升就得引入人工校对表或萌娘百科/Bangumi 的日文名 join
  （工程量大，需先解决日文名→罗马字匹配）。
- **`anima_alias_index.json` 有 8.9MB**（已随包发布）。若嫌大，可改存 gzip
  （`json.load(gzip.open(...))`）压到 ~2MB，但要同步改运行时的 `_load_alias_index()`。
