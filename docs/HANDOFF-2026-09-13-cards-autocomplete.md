# 交接：TK 提示词卡片 ②区联想的中文角色名支持（v2.12.0 / v2.12.1）

> 远端 main `ffc5130e`（v2.12.1）。CI 全绿。**运行目录已同步，需用绘世启动器重启 ComfyUI 才生效。**
> 姊妹文档：`AGENTS.md`（接手必读）、`HANDOFF-2026-09-13-2.11.0.md`（上一版状态）。

## 0. 「让普通用户也能用上」——更新链漏发（2.12.1 的核心）

功能做完只算一半：**老用户点内置「更新」按钮时，能不能真的拿到词典？** 查下来是不能。

`services/github_update.py` 的发布白名单 `is_release_path()` 当时是
`anima_* / web/ / app/ + 几个根文件`，并把 `data/` 与 `services/` 一起排除。两个后果：

| # | 后果 | 严重度 |
|---|---|---|
| ① | 新词典放 `data/` → 老用户拿到新代码却拿不到词典 → 中文联想**静默失效**（不报错、只是查不到）；`check_update` 的 package_match 也看不见它，连"有更新"都判不出来 | 高（功能等于没发） |
| ② | `__init__.py` 拆分后 `from .services.github_update import …` 是硬依赖，而 `services/` 不下发 → 从 ≤2.10.0 更新的用户会 **ImportError，插件整个加载不了** | 致命 |

改法（2.12.1）：

- `services/` 整目录放行（它就是插件代码）。
- `data/` 改为**逐文件白名单** `_SHIPPED_DATA_FILES`（三个随包词典）；
  `prompt_library.json` / `batches/` / `danbooru_account.json` / 缓存等用户状态**永不覆盖**。
- **别名索引从 `data/` 移到插件根目录的 `anima_alias_index.json`** —— 因为放行规则里有
  `anima_*` 前缀，所以**连 2.11.0 的旧更新链**都能把它下发下去，绕开鸡生蛋问题。
  加载器 `_load_alias_index()` 保留 `data/` 兜底路径，旧布局不会炸。

**已实测验证**（不要只信推理）：用 `git show 253f4411:services/github_update.py` 取出**旧版**
白名单，去过滤**当前**远端 tree，结果关键文件全部在列：

```
anima_alias_index.json                 YES   中文别名词典（2.12 的核心）
anima_prompt_cards.py                  YES   联想后端
web/js/anima_prompt_cards_widget.js    YES   联想前端 + 括号转义
__init__.py / VERSION                  YES
```

结论：**2.11.0 用户点一次更新，联想就能用**。更新链本身的修复要等下一次完整安装
（Manager / Registry）落地，不影响功能。

护栏：`tests/test_update_archive.py::test_release_path_whitelist_covers_everything_the_plugin_needs_at_runtime`
把"运行时必需必须下发 / 用户状态必须挡住"钉成清单。

## 1. 一句话结论

**坏的是数据覆盖和排序，不是匹配逻辑。**

用户报「输入角色名联想补充无法找到对应角色，比如碧蓝档案的望」。实测后端 `_search_autocomplete`：

| 输入 | 修复前 | 修复后 |
|---|---|---|
| `nozomi` | ✅ 正常 | ✅ |
| `望` | ❌ `telescope`、`mochizuki (kancolle)`… | ✅ `nozomi (blue archive)` 等 |
| `希` / `橘希` | ❌ 只出别的 | ✅ |
| `日奈` / `星野` / `白子` | ❌ 只出**别作品**的同名角色 | ✅ 碧蓝档案的排第一 |
| `优香` / `未花` | ✅（巧合：直译名与官方名一致） | ✅ |

两个根因：

1. **词典的中文名是机器直译**。原 CSV 的「关键词」字段把 ノゾミ 译成「希、橘希」
   （正确是**望**／橘望），把 ミカ 译成「米卡、味园米卡」（正确是**圣园未花**）。
   `danbooru_tags_zh.json` 里也**没有「望」这个键**。D 站 59506 个角色标签里
   只有 39.1%（23288）能通过中文键命中。
2. **中文查询的优先级排在英文子串和说明字段之后**。所以「日奈」输给了 D 站帖数更高的
   `hinamori amu`；「望」更是命中了说明字段里「望**远镜**」→ `telescope`。

## 2. 数据（全可验证，无 LLM 编造）

用户明确选择「从 Civitai LoRA 元数据自动抓中文名（零幻觉）」。最终做了三层：

| 来源 | 规模 | 可信度 | 怎么来的 |
|---|---|---|---|
| **Civitai LoRA 元数据** | 2638 条配对 | 高（真实配对 + 证据） | 中文作者把中文名写在标题、danbooru 标签写在 `trainedWords`，脚本挖出来 |
| 社区词典 `danbooru_tags_zh.json` | 144694 条 | 中（角色全名常正确） | 已在仓库里，本次把**括号里的作品名拆出来**当独立别名 |
| 原 CSV「关键词」字段 | 45199 条 | 低（直译，会错） | 已过滤混排/日文汉字/作品名拼接等artifact，**排最后** |
| **AnimaDex 角色表** | 36480 角色 / 3702 作品 | 高 | `https://animadex.net/api/characters/search`（公开 API，1014 页） |

Civitai 那层的提取规则（`tools/harvest_civitai_zh_aliases.py` + `build_tag_alias_index.py`）：

- 只允许**角色标签**与中文令牌配对。早期版本把 `trainedWords` 里所有标签都算进去，
  于是 `龙华妃咲` 的 distinct 计数爆表被整条丢掉 —— 这是「一条都没挖到」的真凶。
- 令牌含**假名**就丢弃：否则 `竜華キサキ` 会剩下裸姓「竜華」。
- 丢弃已知作品中文名、格式词（风格/泳装/全角色…）、日文专用汉字（竜沢絵嬢獣剣鉄駅）。
- 单条证据（support=1）只在令牌像名字（2-4 字）时才接受。

产物：**`anima_alias_index.json`（8.9MB，随包发布）**。

## 3. 匹配与排序（`anima_prompt_cards.py`）

中文查询改为分级，**不再扫描 20 万条英文说明**：

```
0 标签精确    1 别名精确    2 别名尾缀（1-4 字）    3 别名前缀（二分）    3b 作品中文名→列角色
5 别名包含    6 标签包含    7 作品包含              8 说明兜底            9 子序列
```

**「尾缀」是关键**：中文用户打的是**名**不是姓，而词典里存的是全名。
`橘望`→`望`、`小鸟游星野`→`星野`、`空崎日奈`→`日奈`、`砂狼白子`→`白子`
全部靠尾缀表 O(1) 命中，不需要猜怎么切姓。

英文查询走另一套（标签精确/前缀/包含 → 别名精确/前缀 → 作品 → 兜底），
且**标签扫描与别名查找分开执行** —— 以前把别名判断塞进同一个循环，
每个条目都要比 4 个别名，实测 350ms；现在 60ms。

## 4. 输出格式（Anima 写法）

用户给的例子是 `kisaki \(blue archive\),`。查证结论：

- **Anima 官方文档与 AnimaDex 都写裸括号**（`nozomi (blue archive), blue archive`），
  Anima 官方文档里 **0 处** 转义括号。
- **但 ComfyUI 把裸括号当权重语法**（官方文档原话：`(chibi:2)` 生效），
  所以要拿到**字面标签**必须转义 —— 这也正是本插件 D 站画廊早已有
  「转义括号（(tag) → \\(tag\\)）」选项的原因，Civitai 的 `trainedWords` 也是 `kei \(blue archive\)`。
- 所以**用户是对的**（在 ComfyUI 语境下）。实现取与画廊同一套语义：
  `web/js/anima_prompt_cards_widget.js` 的 `escapeAnimaBrackets()` —— **先反转义再转义**，
  重复插入安全（`tests/repro/repro_bracket_escape.py` 就是钉这个不变量的）。
- 落点在 `cardToText()`：`formatWeightedPromptText(applyPromptFormat(en), weight)` ——
  **必须先转义再套权重**，否则 `(tag:1.2)` 的括号会被一起转义。
- 默认**开**，②区工具栏新增 `括号转义 开/关` 按钮，状态存 localStorage（`anima_tk_cards_ui_v1`）。
- 下划线→空格是 Anima 官方写法，原本就已实现（`_autocomplete_prompt_text` 与 `danbooruTagToPrompt`），
  用户对此的担心是多余的。

## 5. 性能

| 项 | 之前 | 现在 |
|---|---|---|
| 首次中文查询 | 数秒（要给 20 万条说明做 `key()`） | 毫秒级（查预建表） |
| 英文查询（未缓存） | ~350ms | ~60ms |
| 重复查询 | 命中 128 条 LRU | 0ms |
| 建表开销 | — | 插件加载时**后台守护线程**预热，不占用户时间 |

预热入口在模块尾部 `_warm_autocomplete_async()`；顺带把说明兜底索引也在后台建好
（它本身要 1 秒多，以前是**首次中文查询**在等）。

## 6. 踩过的坑（都已固化）

1. **`AUTOCOMPLETE_LOCK` 原本是 `threading.Lock` → 同线程自死锁**。
   `_build_autocomplete_alias_tables()` 持锁时调用 `_load_autocomplete_entries()`，
   后者也要拿同一把锁。症状是**不报错、不退出、永远卡住**，探针看起来像"导入慢"。
   已换成 `RLock`（护栏 + 注释都写在代码里）。
2. **尾缀表用 list 去重是 O(n²)**：`if tag_key not in group` 在「望」这种大桶里退化成
   线性扫描，建表直接卡死。改用 dict 去重。
3. **前缀冗余规则会误杀正确结果**：一开始把「是另一个别名的前缀」的令牌丢掉，
   结果「星野」被「星野高梨」、「橘望」被「橘望 (蔚蓝档案)」连带删掉 ——
   而这俩恰恰是用户要打的字。已撤销；显示顺序改由**来源可信度**决定
   （社区词典 → Civitai → CSV 直译），搜索对所有别名一视同仁。
4. **别在失败分支 print emoji**：`tests/tools/run_offline_like_ci.py` 的 ❌ 在 GBK 控制台
   `UnicodeEncodeError`，把真正的 pytest 报错盖掉（`ai_verify.py` 同一个坑）。已改纯 ASCII。

## 7. 怎么刷新词典

```bash
cd "E:\claude program\ComfyUI-Anima-Batch-LoRA"
python tools/harvest_animadex.py                    # ~20 分钟（1014 页）
python tools/harvest_civitai_zh_aliases.py --mode both --max-pages 500   # ~25 分钟，可续跑
python tools/build_tag_alias_index.py --report       # 纯离线合成 + 抽查
python tests/run_tests.py                            # 必须过
# 提交 anima_alias_index.json（_sources/ 已 gitignore）
```

- harvest 脚本都**可续跑**（`data/_sources/*state*.json` 记进度）；
  Civitai 会 429，脚本内已退避重试，失败的查询不写进 done，重跑即补。
- **只换词典不改代码时，插件按 mtime+size 指纹热重载索引，不必重启 ComfyUI。**
- 改了 `.py` 就必须重启（绘世启动器）。

## 8. 测试

新增 `tests/test_prompt_cards_autocomplete.py`（33 条，离线）：

- 17 条中文角色名（含用户报的每一个：望/橘望/妃咲/龙华妃咲/日奈/空崎日奈/星野/小鸟游星野/
  白子/砂狼白子/优香/早濑优香/未花/圣园未花/雷电将军/甘雨/初音未来）
- 1 条「作品名带出角色」、1 条「中文查询不得回退到说明噪声（`望` 不得出 `telescope`）」
- 6 条英文回归（防止中文改动把英文查询搞坏）
- 4 条 Anima 格式（下划线转空格 / 转义 / **幂等** / 普通标签不受影响）
- 2 条数据完整性（索引存在且规模合理、表间一致）
- 1 条性能（未预热的中文查询 < 1s）

`python tests/run_tests.py` → **6/6 通过，离线 pytest 128 条**。

## 9. 遗留

- 别名词典仍有噪声（「万岁伸展」「味园米卡」「聖園」），**排在可信来源之后，不会抢结果**，
  但会出现在下拉副标题里。要再干净需人工校对表，或接萌娘百科/Bangumi 的中文名
  —— 后者要先把日文名匹配到 danbooru 罗马字，工作量大。
- `anima_alias_index.json` 8.9MB。嫌大可改 gzip（~2MB），需同步改
  `_load_alias_index()`。
- 未做：ComfyUI Registry 发布 2.12.0、GitHub Release v2.12.0（v2.10.0/v2.11.0 已有）。
