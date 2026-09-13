# tests/ 分层说明

> 本目录有 **105 个文件**，其中只有一部分是「正式回归」。混着跑会导致
> **本地绿 / CI 红**（或反过来），两边都失去意义。这份文档把边界钉死。

## 一句话规则

| 你想做什么 | 跑什么 |
|---|---|
| **提交前自检（= CI 会跑的）** | `python tests/run_tests.py` |
| 只想跑离线用例 | `python -m pytest tests -q` |
| 跑需要真实 ComfyUI 的验证 | `python tests/run_tests.py --integration` |
| 只跑 JS | `python tests/run_tests.py --js` |
| 节点注册 / README / 版本一致性 | `python tests/tools/ai_verify.py` |

## 分层（`tests/layer-manifest.json` 是权威清单）

| 层 | 位置 | 数量 | 需要什么 | CI |
|---|---|---|---|---|
| **unit** | `tests/*.py`（顶层） | 23 | 纯离线 | ✅ 必跑 |
| **js** | `tests/js/` + 顶层 `*.mjs` / `*.test.js` | 3 | Node | ✅ 必跑 |
| **integration** | `tests/integration/*.py` | 57 | 真实浏览器 + ComfyUI(:8188) | ❌ 永不跑 |
| **smoke** | `tests/smoke_*.py` | 4 | 真实后端/工作流 | ❌ |
| **repro** | `tests/repro/` | 12 | 一次性复现/诊断 | ❌ 不进 CI |
| **tools** | `tests/tools/` | 5 | 开发自检工具 | 单独调用 |
| **fixture** | `tests/clothing_draw_ui_harness.html` | 1 | 被两个 verify 引用的共享页面壳 | — |

清单由 `python tests/tools/classify_tests.py` **生成**；`tests/test_layer_manifest.py`
会在清单过期时 FAIL（并告诉你重新生成）。**别手改清单。**

## ⚠️ 三个必须知道的坑

### 1. 为什么 `pytest.ini` 在 `tests/` 里而不是仓库根

本仓库是 ComfyUI 插件，**仓库根目录本身就是 `__init__.py`**（插件入口，且用了
`from .anima_x import ...` 相对导入）。pytest 会为测试模块向上一级寻找包边界，把那个
`__init__.py` 当「包的作用域模块」导入 → 它只能作为包内模块导入 → 必然
`ImportError: attempted relative import with no known parent package` → 全部用例 setup ERROR。

`rootdir` 由**配置文件所在目录**决定，所以把 `pytest.ini` 放进 `tests/` 即可让 rootpath = `tests/`，
pytest 不再向上找仓库根。

**以下方案全部实测无效，别再试**（pytest 9.1.1）：

- ✗ `import-mode = importlib`（pytest 9 的 ini 里**没有**这个选项，只有 CLI 的 `--import-mode`）
- ✗ `pythonpath = .`
- ✗ `conftest.py` 里的 `collect_ignore`（拦不住 `Module.setup()` 那条包导入路径）
- ✗ `tests/__init__.py`
- ✗ `--import-mode=append`
- ✗ `--rootdir` 覆盖（配置文件仍在仓库根时无效）

### 2. 为什么 `tests/conftest.py` 必须 stub ComfyUI 运行时

`conftest.py` 在收集测试模块**之前**导入，是唯一能先把 `folder_paths` / `server.PromptServer`
stub 掉的位置。没有它，CI（无 ComfyUI）里根模块导入失败会连带所有用例 setup ERROR。
真实安装里这是 no-op（真模块已存在）。

### 3. 别往离线层塞需要真实环境的测试

`tests/test_layer_manifest.py::test_ci_layer_has_no_browser_or_comfy_dependency`
会扫顶层 `unit` 层，发现 `playwright` / `chrome.exe` / `:8188` 就 FAIL。
这是**故意的**：CI 一旦开始假红就会被忽略，那时 CI 就白设了。
确实需要真实环境的，移到 `tests/integration/`。

## 给新增测试的模板

```python
"""一句话说明测什么 + 为什么值得长期保留。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent          # 顶层文件用 .parent
# 在 tests/ 子目录里则用 .parents[1]（见下方「移动文件须知」）


def test_something_specific():
    """具体到「哪种坏掉会让它红」，别写 test_works()。"""
    assert ...


if __name__ == "__main__":
    # 保留直跑能力：调试时不用起 pytest
    test_something_specific()
    print("PASS: ...")
```

**要求**：

- 断言必须**锚定定义/签名**，不要用裸子串。踩过的坑：`js.index('saveSettings()')` 命中了
  调用点而不是方法定义；`'<option value="date">按日期</option>'` 因为真实 HTML 带
  `selected` 与后缀而**从来没通过过**。用正则或 `"\n    saveSettings() {"` 这种带边界的锚点。
- **不要在模块顶层写 `assert` 或 `sys.exit()`**：pytest 导入时执行 → 失败**不会被报告**（静默假绿），
  或直接让整个收集 INTERNALERROR（本项目修过 11 个这样的文件）。
  顶层只留 import/常量，逻辑放进 `def test_*`。
- 需要隔离文件系统时，重定向**所有**派生路径常量 —— 只改主路径会让派生路径仍在真实
  `data/` 里读写（本项目踩过：测试把备份写进了安装目录的 `data/`）。

## 移动文件须知（会破坏路径）

包内有 37 个文件用 `Path(__file__).resolve().parents[1]` 指向仓库根。
**移到 `tests/` 子目录后，必须把 `parents[1]` 改成 `parents[2]`**，否则路径会指到 `tests/`。
移动后务必：

```bash
python tests/tools/classify_tests.py     # 重新生成分层清单
python tests/run_tests.py                # 全量离线回归必须仍全绿
```
