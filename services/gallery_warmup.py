"""TK Toolkit —— Outputs 常驻预热器（后端侧，**不依赖浏览器**）。

动机（用户需求）：
    「生完图 → 打开面板 → 切到 Outputs 栏目 → 新图已经在那儿了」。
现状根因：所有"预备"动作都挂在**浏览器**上（面板的 ``executed`` 事件监听 +
轮询 ``/anima/gallery/fresh``）。用户没开面板时后端什么都不做，于是每次打开面板
都要现等一次全量重建（实测 3571 张 ≈ 12.9s）。

本模块提供一个与浏览器无关的**常驻 daemon 线程**：自己低频探测输出目录，发现变化就把
索引（``anima_gallery.update_index_incremental``）与缩略图（``anima_thumbs.ensure_thumbnail``）
预备好；面板打开时直接命中。

**探测必须是廉价的**（这是本模块最关键的性能约束）：真机实测
``anima_gallery.scan_output_files()`` 对 4100 个文件要 **~8.9s**（逐个 ``os.stat``，
Windows 上 stat 极贵）。所以本模块的轮询**不调用它** —— 自己做一次
「只枚举目录、一个文件都不 stat」的走查（见 ``_probe``），实测量级 **~10ms**
（2000 文件平铺 / 4000 文件两层嵌套，见 ``.scratch/check_gallery_warmup.py`` 的实测表）。
昂贵的全量扫描只在**签名真的变了**时才发生，且那一步在 ``anima_gallery`` 内部（增量复用）。

设计纪律（改这个文件前先读）：
  · **import 期零 IO**：不在插件加载的关键路径上扫目录 / 读索引 / 起线程。线程首轮有
    ``_FIRST_DELAY_SEC`` 启动延迟，不跟 ComfyUI 启动抢 IO。
  · **任何异常都不能让线程退出**：外层 while + try/except 全包，只 print + 记 ``lastError``。
  · **绝不抢占生图资源**：缩略图并发 ≤2，且同一时刻只跑一批、单批有上限。
  · ``status`` 只存内存；``warmup_status()`` 返回**深拷贝**，绝不泄露内部对象。

对外契约（``__init__.py`` 挂载与读状态用，签名逐字一致）::

    install_gallery_warmup(*, output_root_getter, index_path_getter,
                           interval_sec=20, debounce_sec=1.5) -> dict
    warmup_status() -> dict
    request_warmup(reason="") -> bool

附加只读辅助（**非契约**，供诊断端点/排查用）：``warmup_diagnostics()``。
"""

from __future__ import annotations

import copy
import functools
import importlib
import os
import threading
import time

# ── 常量 ────────────────────────────────────────────────────────────────────

_FIRST_DELAY_SEC = 10.0   # 首轮启动延迟：错开 ComfyUI 自身的启动 IO
_MIN_GAP_SEC = 0.5        # 单轮超时后的最小间隔，防热循环
_PROBE_MAX_DIRS = 4000    # 探测时最多枚举多少个目录（防御异常深的树）
_IMAGE_EXTS = (".png", ".webp", ".jpg", ".jpeg")  # 与 anima_gallery.scan_output_files 对齐
_BACKOFF_AFTER = 2        # 连续 N 轮无变化后开始退避
_MAX_INTERVAL_SEC = 120.0  # 退避上限
_THUMB_WORKERS = 2        # 缩略图预热并发上限（生图优先，绝不抢）
_THUMB_MAX_PER_BATCH = 200  # 单批预热上限：防止"首次全库"把 CPU 占满
_THUMB_WIDTHS = (512,)    # 只预热列表档；768 详情档仍按需生成
_EXEC_EVENTS = ("executed", "execution_success", "execution_error")  # "新图可能已落盘"
_THROTTLED_EVENTS = ("executed",)  # 每个节点都发，噪音极大 → 单独加时间窗节流
_EXEC_THROTTLE_SEC = 5.0          # executed 的最小触发间隔（execution_success 不受限）
_PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 内存状态（唯一真源，全部在 _STATUS_LOCK 下读写）────────────────────────

_STATUS_LOCK = threading.RLock()
_STATUS = {
    "installed": False,
    "running": False,
    "intervalSec": 20,
    "lastRunAt": 0.0,
    "lastDurationMs": 0,
    "lastResult": None,
    "lastError": None,
    "runs": 0,
    "pending": False,
}

_CFG = {"output_root_getter": None, "index_path_getter": None,
        "interval_sec": 20, "debounce_sec": 1.5}

_INSTALL_LOCK = threading.Lock()
_INSTALL_SNAPSHOT: "dict | None" = None
_THREAD: "threading.Thread | None" = None
_WAKE = threading.Event()   # 事件加速：request_warmup 唤醒驱动循环
_STOP = threading.Event()   # 仅供测试/卸载时优雅停线程

_LAST_RELS: set = set()            # 上一轮探测到的图片相对路径集合（变化判据 + 推导新增）
_LAST_ROOT_MTIME_NS = 0            # 输出目录自身的 mtime（扁平结构下新增文件会改它）
_RUNTIME = {"idlePolls": 0, "intervalSec": 0.0}
_LAST_ACCEPT_AT = 0.0
_REQ_STATS = {"accepted": 0, "rejected": 0, "lastReason": "", "lastAt": 0.0}
_EVENT_STATS = {"fired": 0, "throttled": 0}   # 钩子侧计数（含被时间窗丢掉的噪音）
_LAST_EVENT_AT = 0.0
_MODULE_CACHE: dict = {}
_WARNED: set = set()
_HOOK_STATE = {"installed": False, "target": "", "note": "尚未尝试"}
_THUMB_STATE = {"batches": 0, "done": 0, "failed": 0, "lastError": None, "lastAt": 0.0}
_THUMB_BATCH_LOCK = threading.Lock()


# ── 小工具 ─────────────────────────────────────────────────────────────────

def _warn_once(key: str, message: str) -> None:
    """同类告警只打印一次（轮询每 20s 一轮，重复 print 会刷爆控制台）。"""
    if key in _WARNED:
        return
    _WARNED.add(key)
    print(f"[gallery_warmup] {message}")


def _event_allowed(event: str) -> bool:
    """钩子侧时间窗节流：``executed`` 是**每个节点**都发的，噪音极大。

    ``execution_success`` / ``execution_error``（一批的收尾）不受限。这里只读改写一个 float，
    GIL 下是原子的，因此执行线程上不加锁、不阻塞。
    """
    global _LAST_EVENT_AT
    if event not in _THROTTLED_EVENTS:
        _EVENT_STATS["fired"] += 1
        return True
    now = time.time()
    if now - _LAST_EVENT_AT < _EXEC_THROTTLE_SEC:
        _EVENT_STATS["throttled"] += 1
        return False
    _LAST_EVENT_AT = now
    _EVENT_STATS["fired"] += 1
    return True


def _import_plugin_module(name: str):
    """导入插件根目录下的模块（``anima_gallery`` / ``anima_thumbs``）。

    ComfyUI 把插件目录当包加载（``__init__.py`` 用 ``from .services import ...``），
    此时正确写法是相对导入 ``..name``；独立导入（测试把仓库根塞进 sys.path）时
    相对导入会失败，退回顶层绝对导入。两条路都试，失败返回 None。
    """
    pkg = __package__ or ""
    if "." in pkg:  # 包内加载：<plugin>.services → 上一级就是插件根
        try:
            return importlib.import_module(f"..{name}", pkg)
        except Exception:
            pass
    return importlib.import_module(name)


def _plugin_module(name: str):
    """带缓存的模块解析；失败不缓存（便于 anima_gallery 热更后被重新拾起）。"""
    mod = _MODULE_CACHE.get(name)
    if mod is not None:
        return mod
    try:
        mod = _import_plugin_module(name)
    except Exception as exc:
        _warn_once(f"import:{name}", f"无法导入 {name}（{exc}）；相关预热降级")
        return None
    _MODULE_CACHE[name] = mod
    return mod


def _safe_call(fn, label: str) -> str:
    """调用注入的路径 getter；抛异常/返回 None 一律折算成空串（不算致命）。"""
    if not callable(fn):
        return ""
    try:
        value = fn()
    except Exception as exc:
        _warn_once(f"getter:{label}", f"{label}() 抛异常：{exc}")
        return ""
    return "" if value is None else str(value)


def _probe(root: str):
    """廉价签名探测 —— **只枚举目录，一个文件都不 stat**。

    返回 ``(rels, root_mtime_ns)``：

    * ``rels`` = 输出目录下所有图片的相对路径集合（过滤规则与
      ``anima_gallery.scan_output_files`` 一致：跳过隐藏项、只看图片扩展名）；
    * ``root_mtime_ns`` = 输出目录**自身**的 ``st_mtime_ns``（扁平结构下新增/删除文件会改它）。

    为什么这样够用又便宜：
      · 变化判据用**集合直接比较**（精确捕捉任意深度下的新增/删除/改名，代价约 0.3ms），
        root mtime 只是额外辅助信号，不作为唯一依据；
      · 目录枚举一次就能拿到条目名与 ``is_dir()``（Windows 上 ``is_dir()`` 直接吃目录项里
        缓存的 ``dwFileAttributes``，**不额外 stat**），所以整棵树的代价 ≈ 「打开每个目录一次
        + 遍历一遍条目名」；
      · **故意不 stat 文件** —— 真机上一个 ``os.stat`` 约 2.2ms，4100 个文件就是 8.9s。
        代价是"同名文件被原地覆盖"这类变化看不出来；那类变化由显式请求兜底（见
        ``_should_run``：``event:*`` 之外的理由一律强制跑一轮增量）。
    """
    rels = set()
    stack = [(root, "")]  # (绝对路径, 相对前缀) —— 自己拼相对路径，省掉逐文件 relpath
    dirs = 0
    while stack:
        cur, prefix = stack.pop()
        try:
            with os.scandir(cur) as it:
                for entry in it:
                    name = entry.name
                    if name.startswith("."):
                        continue  # scan_output_files 同样跳过隐藏文件/目录
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            dirs += 1
                            if dirs <= _PROBE_MAX_DIRS:
                                stack.append((entry.path, prefix + name + "/"))
                            continue
                    except OSError:
                        continue
                    if os.path.splitext(name)[1].lower() in _IMAGE_EXTS:
                        rels.add(prefix + name)
        except OSError:
            continue
    try:
        root_mtime_ns = os.stat(root).st_mtime_ns
    except OSError:
        root_mtime_ns = 0
    return rels, root_mtime_ns


def _should_run(reason: str, rels: set, root_mtime_ns: int) -> bool:
    """要不要真跑一轮增量。

    * ``poll`` / ``event:*``：**没变化就不跑** —— 事件只是提示，不该为此烧掉一次 8.9s 全量扫描；
    * 其它（``request`` / ``manual`` / 空串 = 直接调用 run_once）：无条件跑（显式请求优先）。
    """
    if reason == "poll" or reason.startswith("event:"):
        return rels != _LAST_RELS or root_mtime_ns != _LAST_ROOT_MTIME_NS
    return True


def _normalize_added(updater_result) -> list:
    """从增量结果里取出"新增文件"的相对路径列表。

    契约上 ``added`` 是路径列表，但为兼容实现差异，这里同时接受
    ``["a/b.png", ...]`` 与 ``[{"path"|"rel"|"relPath": "a/b.png"}, ...]``。
    返回空列表 = "这份结果里拿不到路径"，由调用方决定是否自行推导
    （实测当前 ``anima_gallery.update_index_incremental`` 的 ``added`` 就是 **int 计数**，
    所以调用方确实要推导 —— 见 ``_run_once_inner``）。纯计数时这里**不猜**路径。
    """
    if not isinstance(updater_result, dict):
        return []
    added = updater_result.get("added")
    if isinstance(added, (str, bytes)) or not isinstance(added, (list, tuple)):
        return []
    out = []
    for item in added:
        if isinstance(item, str) and item:
            out.append(item)
        elif isinstance(item, dict):
            rel = item.get("path") or item.get("rel") or item.get("relPath")
            if isinstance(rel, str) and rel:
                out.append(rel)
    return out


# ── 缩略图预热（可选，优先级低于索引）──────────────────────────────────────

def _spawn_thumb_prewarm(root: str, added_rels: list, source: str, payload: dict) -> None:
    """对"新增"的那批文件后台预热缩略图。任何异常都只记 lastError，绝不影响索引结果。"""
    rels = list(added_rels)[:_THUMB_MAX_PER_BATCH]
    if not rels:
        payload["thumbs"] = {"requested": 0, "source": source,
                             "note": "无新增文件（或增量结果没给出可解析的路径）"}
        return
    if not _THUMB_BATCH_LOCK.acquire(blocking=False):
        payload["thumbs"] = {"requested": len(rels), "source": source,
                             "note": "上一批预热仍在跑，跳过"}
        return
    try:
        threading.Thread(target=_thumb_batch_worker, args=(root, rels),
                         name="anima-gallery-thumbs", daemon=True).start()
    except Exception as exc:  # 起线程失败要还锁，否则永久跳过预热
        _THUMB_BATCH_LOCK.release()
        payload["thumbs"] = {"requested": len(rels), "source": source, "error": f"起线程失败: {exc}"}
        return
    payload["thumbs"] = {"requested": len(rels), "source": source, "queued": True,
                         "widths": list(_THUMB_WIDTHS), "workers": _THUMB_WORKERS}


def _thumb_batch_worker(root: str, rels: list) -> None:
    """后台批量生成缩略图（并发 ≤2，全部走 anima_thumbs.ensure_thumbnail 复用缓存键）。"""
    done = failed = 0
    error = None
    try:
        thumbs = _plugin_module("anima_thumbs")
        if thumbs is None or not hasattr(thumbs, "ensure_thumbnail"):
            error = "anima_thumbs 不可用（缺 PIL 或导入失败），跳过缩略图预热"
        else:
            from concurrent.futures import ThreadPoolExecutor, as_completed
            width = _THUMB_WIDTHS[0]
            cache_root = thumbs.plugin_cache_root(_PLUGIN_DIR, width)
            futures = []
            with ThreadPoolExecutor(max_workers=_THUMB_WORKERS,
                                    thread_name_prefix="anima-thumb") as pool:
                for rel in rels:
                    abs_path = os.path.join(root, rel)
                    if not os.path.isfile(abs_path):
                        continue
                    futures.append(pool.submit(thumbs.ensure_thumbnail, abs_path, width, cache_root))
                for fut in as_completed(futures):
                    try:
                        fut.result()
                        done += 1
                    except Exception:
                        failed += 1
    except Exception as exc:  # 整批级异常（如 PIL 缺依赖、缓存目录不可写）
        error = f"缩略图预热失败: {exc}"
    finally:
        with _STATUS_LOCK:
            _THUMB_STATE["batches"] += 1
            _THUMB_STATE["done"] += done
            _THUMB_STATE["failed"] += failed
            _THUMB_STATE["lastAt"] = time.time()
            if error:
                _THUMB_STATE["lastError"] = error
                # 只在索引本身没出错时上报，避免缩略图问题盖掉索引结果
                if _STATUS["lastError"] is None:
                    _STATUS["lastError"] = error
        _THUMB_BATCH_LOCK.release()


# ── 一轮运行（可独立调用，不需要起线程）────────────────────────────────────

def run_once(reason: str = "") -> dict:
    """跑一轮预热。**本函数不抛异常**，一切结果都写进 status。

    reason 语义：``"poll"`` = 周期轮询（签名没变就跳过）；其它值（如 ``"request"`` /
    ``"event:executed"``）视为显式请求，**强制**跑一次增量，不管签名是否变化。
    """
    started = time.time()
    with _STATUS_LOCK:
        _STATUS["pending"] = False  # 本轮满足掉挂起的请求（运行中来的新请求会重新置位）

    error = None
    try:
        result, error = _run_once_inner(reason)
    except Exception as exc:  # 兜底：单轮异常绝不能让线程退出
        result = {"skipped": True, "reason": "internal-error", "mode": "error", "error": str(exc)}
        error = f"预热内部错误: {exc}"

    result.setdefault("reason", reason or "poll")
    result["durationMs"] = int((time.time() - started) * 1000)

    with _STATUS_LOCK:
        _STATUS["lastRunAt"] = started
        _STATUS["lastDurationMs"] = result["durationMs"]
        _STATUS["lastResult"] = copy.deepcopy(result)
        _STATUS["runs"] += 1
        if error:
            _STATUS["lastError"] = error
        elif not result.get("skipped"):
            _STATUS["lastError"] = None  # 真跑成功了才清错
    return copy.deepcopy(result)


def _run_once_inner(reason: str):
    """返回 ``(result_dict, error_or_None)``。"""
    global _LAST_RELS, _LAST_ROOT_MTIME_NS

    root = _safe_call(_CFG["output_root_getter"], "output_root_getter")
    index_path = _safe_call(_CFG["index_path_getter"], "index_path_getter")
    if not root:
        return ({"skipped": True, "mode": "idle", "reason": "no-output-root"},
                "输出目录不可用（output_root_getter 返回空）")
    if not os.path.isdir(root):
        return ({"skipped": True, "mode": "idle", "reason": "output-missing", "root": root},
                f"输出目录不存在: {root}")

    # ① 廉价探测（只枚举目录，不 stat 文件）—— 这一步每轮都跑，必须便宜
    try:
        rels, root_mtime_ns = _probe(root)
    except Exception as exc:
        return ({"skipped": True, "mode": "error", "reason": "probe-failed", "error": str(exc)},
                f"探测输出目录失败: {exc}")

    if not rels:
        # 空目录**不动索引**：真实场景里"输出目录暂时为空"更可能是路径没就绪（盘符未挂载 /
        # 用户还没出图），此时跑增量只会把一份好索引清空 —— 放过一次删除同步，代价远小于静默清库。
        with _STATUS_LOCK:
            _LAST_RELS = set()
            _LAST_ROOT_MTIME_NS = root_mtime_ns
        return ({"skipped": True, "mode": "idle", "reason": "empty-output",
                 "scanned": 0, "signature": [0, root_mtime_ns]}, None)

    if not _should_run(reason, rels, root_mtime_ns):
        return ({"skipped": True, "mode": "idle", "reason": "unchanged",
                 "scanned": len(rels), "signature": [len(rels), root_mtime_ns]}, None)

    gallery = _plugin_module("anima_gallery")
    if gallery is None or not hasattr(gallery, "scan_output_files"):
        # 探测不依赖 anima_gallery（自己枚举目录），这里只是"这个模块是不是我们要的那个"的体检
        return ({"skipped": True, "mode": "degraded", "reason": "gallery-module-missing",
                 "root": root, "scanned": len(rels),
                 "signature": [len(rels), root_mtime_ns]},
                "anima_gallery 不可用，预热降级为仅更新状态")

    # ② 贵的那一步（anima_gallery 内部全量 stat + 增量解析）只在探测到变化/显式请求时发生
    updater = getattr(gallery, "update_index_incremental", None)
    if not callable(updater) or not index_path:
        # 故意**不**更新 _LAST_RELS/_LAST_ROOT_MTIME_NS：将来增量接口可用时，还能把这段积压
        # 推导成"新增"去预热缩略图。
        return ({"skipped": True, "mode": "degraded", "reason": "incremental-api-missing",
                 "scanned": len(rels), "signature": [len(rels), root_mtime_ns], "root": root,
                 "indexPath": index_path},
                "anima_gallery.update_index_incremental 尚不可用（降级：只更新状态，不做索引）")

    with _STATUS_LOCK:
        prev_rels = _LAST_RELS
    try:
        updated = updater(root, index_path)
    except Exception as exc:
        return ({"skipped": True, "mode": "error", "reason": "incremental-failed",
                 "scanned": len(rels), "signature": [len(rels), root_mtime_ns],
                 "error": str(exc)},
                f"增量更新失败: {exc}")

    with _STATUS_LOCK:
        _LAST_RELS = rels
        _LAST_ROOT_MTIME_NS = root_mtime_ns
    payload = {"mode": "incremental", "reason": reason or "poll",
               "scanned": len(rels), "signature": [len(rels), root_mtime_ns],
               "indexPath": index_path}
    if isinstance(updated, dict):
        payload.update(updated)
    else:
        payload["updaterResult"] = updated

    # ③ 取"新增文件"：优先用增量结果给的路径列表；**实测** anima_gallery.update_index_incremental
    # 的 ``added`` 是**计数（int）**而不是路径列表，所以退一步用探测集合自己推导。
    # 没有逐文件 mtime 可排（那正是我们要避开的代价），超上限时按文件名倒序近似"最新"——
    # ComfyUI 的 SaveImage 命名带递增计数，名字序 ≈ 生成序。
    added_rels = _normalize_added(updated)
    source = "updater"
    if not added_rels:
        source = "derived"
        count = updated.get("added") if isinstance(updated, dict) else None
        if isinstance(count, int) and count > 0:
            added_rels = sorted(rels - prev_rels, reverse=True)
    _spawn_thumb_prewarm(root, added_rels, source if added_rels else "none", payload)
    return payload, None


# ── 事件加速（尽力而为；失败一律降级到轮询）────────────────────────────────

def _install_event_hook() -> str:
    """探测并挂 ComfyUI 的"执行完成"通知，返回一行结论（用于日志/诊断）。

    实测探测结论（本机 ``E:\\1AI\\ComfyUI-aki-v3\\ComfyUI``，2026-09-14）：
      · ``PromptServer.add_on_prompt_handler(handler)`` **存在但不用** —— 它是"入队前"的钩子
        （``trigger_on_prompt``），时机不对（图还没落盘）；更危险的是
        ``trigger_on_prompt`` 会把 handler 的返回值当作新的 json_data，
        不 ``return json_data`` 就把提示词变成 ``None``、**直接搞坏出图**。
      · ``PromptServer.instance.send_sync(event, data, sid=None)`` 是执行线程 → 前端消息队列的
        **唯一入口**（内部只是 ``loop.call_soon_threadsafe(队列.put_nowait, ...)``）。
        ``execution.py`` 在 SaveImage 落盘后调用 ``send_sync("executed", ...)``（L436/L578），
        收尾经 ``PromptQueue.add_message("execution_success", ...)``（L824）同样落在这里。
        所以包装 ``send_sync`` 就能拿到「图已落盘」信号。
      · ⚠️ 两条 emit 路径都有 ``if server.client_id is not None`` 前置条件：**无 client_id 的
        API 直跑不发这些事件**。所以轮询是主驱动，事件只是加速 —— 这是本模块的设计前提。
    """
    try:
        from server import PromptServer  # type: ignore
    except Exception as exc:
        return f"未挂（server 模块不可用：{exc}）—— 只用轮询"
    try:
        server = getattr(PromptServer, "instance", None)
    except Exception as exc:
        return f"未挂（读 PromptServer.instance 失败：{exc}）—— 只用轮询"
    if server is None:
        return "未挂（PromptServer.instance 为空，服务端尚未启动）—— 只用轮询"

    if not callable(getattr(server, "add_on_prompt_handler", None)):
        note = "（无 add_on_prompt_handler）"
    else:
        note = "（add_on_prompt_handler 存在但按设计不用：入队前触发且返回值会污染 json_data）"

    orig = getattr(server, "send_sync", None)
    if not callable(orig):
        return f"未挂（instance 上没有可用的 send_sync）{note} —— 只用轮询"
    if getattr(orig, "_anima_warmup_hook", False):
        return f"已挂（send_sync 包装，重复 install 跳过）{note}"

    @functools.wraps(orig)
    def _wrapped(*args, **kwargs):
        # 这里跑在**执行线程**上：只允许置标志 + set Event，绝不碰磁盘。
        # 结构上保证：无论通知逻辑出什么事，原函数都会被原样调用（生图不受影响）。
        try:
            event = args[0] if args else kwargs.get("event")
            if event in _EXEC_EVENTS and _event_allowed(event):
                request_warmup(f"event:{event}")
        except BaseException:  # noqa: BLE001 —— 通知纯属尽力而为，吞掉一切
            pass
        return orig(*args, **kwargs)

    _wrapped._anima_warmup_hook = True  # type: ignore[attr-defined]
    try:
        setattr(server, "send_sync", _wrapped)
    except Exception as exc:
        return f"未挂（写 instance.send_sync 失败：{exc}）{note} —— 只用轮询"
    return f"已挂（包装 instance.send_sync，监听 {' / '.join(_EXEC_EVENTS)}）{note}"


# ── 驱动线程 ───────────────────────────────────────────────────────────────

def _driver_loop() -> None:
    """常驻轮询循环：先做廉价探测，只有变了才跑增量。全循环 try/except，绝不退出。

    间隔策略：基准 ``interval_sec``（默认 60s）；连续 ``_BACKOFF_AFTER`` 轮探测到"无变化"
    就翻倍退避到 ``_MAX_INTERVAL_SEC``（120s）—— 没人出图时几乎不占资源，一旦有事件或变化
    立刻回到基准间隔。
    """
    idle = 0
    first_round = True
    try:
        # 启动延迟（可被 request_warmup 提前唤醒：那时已经"生完图"，启动期早过了）
        if _WAKE.wait(_FIRST_DELAY_SEC):
            _WAKE.clear()
        while not _STOP.is_set():
            started = time.time()
            with _STATUS_LOCK:
                pending = bool(_STATUS["pending"])
                # 带上触发来源（"event:executed" / "request"），既做诊断标签也决定"要不要强制跑"
                reason = (_REQ_STATS["lastReason"] or "request") if pending else "poll"
            # ⚠️ **首轮强制跑一次**（2026-09-17）：解析器换代（``anima_gallery.PARSER_VERSION`` 变了）
            #    时磁盘上一点变化都没有 —— poll 的签名判据会说 "unchanged" 直接跳过，
            #    于是老图永远停在旧语义上（用户视角：重启了，提示词还是老样子）。
            #    首轮用一个非 poll 的理由强制走一次增量；``update_index_incremental`` 内部
            #    发现索引里的 parserVersion 与代码不一致时会**全量重解析**（本机 4070 张 ≈ 13s）。
            #    代价：每次启动多一次扫盘 + 逐条 mtime/size 比对（约 0.2~1s），仅换代那次是十几秒。
            if first_round:
                reason = "startup"
                first_round = False
            if pending:
                _debounce_sleep()
            try:
                result = run_once(reason)
            except Exception as exc:  # run_once 自带兜底，这里只是双保险
                print(f"[gallery_warmup] 单轮预热未捕获异常（已忽略）: {exc}")
                result = {}

            idle = idle + 1 if isinstance(result, dict) and result.get("reason") == "unchanged" else 0
            base = max(1.0, float(_CFG["interval_sec"] or 20))
            interval = base
            if idle >= _BACKOFF_AFTER:
                interval = min(_MAX_INTERVAL_SEC, base * (2 ** min(idle - _BACKOFF_AFTER + 1, 3)))
            with _STATUS_LOCK:
                _RUNTIME["idlePolls"] = idle
                _RUNTIME["intervalSec"] = interval

            # 顺延：下一轮对齐到本轮开始 + interval；单轮跑超时也不补跑、不并发，
            # 只留一个最小间隔防热循环。
            wait = started + interval - time.time()
            if wait < _MIN_GAP_SEC:
                wait = _MIN_GAP_SEC
            if _WAKE.wait(wait):
                _WAKE.clear()
    except Exception as exc:  # 理论上到不了这里
        print(f"[gallery_warmup] 预热线程异常退出: {exc}")
    finally:
        with _STATUS_LOCK:
            _STATUS["running"] = False


def _debounce_sleep() -> None:
    """去抖窗口：把这一小段时间里到的请求合并进同一次运行。"""
    debounce = max(0.0, float(_CFG["debounce_sec"] or 0))
    if debounce <= 0:
        return
    deadline = time.time() + debounce
    while not _STOP.is_set():
        remain = deadline - time.time()
        if remain <= 0:
            return
        time.sleep(min(0.1, remain))


# ── 对外契约 ───────────────────────────────────────────────────────────────

def install_gallery_warmup(*, output_root_getter, index_path_getter,
                           interval_sec: int = 60, debounce_sec: float = 1.5) -> dict:
    """启动常驻预热线程。**幂等**：重复调用只生效一次，返回同一个 status 容器。

    :param output_root_getter: 无参可调用，返回 ComfyUI output 目录绝对路径
                               （一般传 ``folder_paths.get_output_directory``）。
    :param index_path_getter:  无参可调用，返回画廊索引 json 的绝对路径
                               （与 ``anima_batch_lora._gallery_index_path`` 同一个）。
    :param interval_sec: 轮询基准间隔（秒），下限 1。默认 **60**：真实生图场景由
                         ``send_sync`` 事件通道即时触发，轮询只是兜底；连续无变化还会
                         自动退避到 120s。想要更灵敏就传更小的值（探测只要 ~10ms）。
    :param debounce_sec: 请求去抖窗口（秒）；窗口内的多次请求合并成一次运行。

    :return: status 快照（``warmup_status()`` 的内容）。重复调用返回**同一个对象**，
             每次 install 时原地刷新；调用方**不要改写**它。
    """
    global _THREAD, _LAST_ACCEPT_AT
    with _INSTALL_LOCK:
        if _STATUS["installed"] and _THREAD is not None and _THREAD.is_alive():
            return _refresh_snapshot()  # 幂等：第一个 install 说了算，配置不再变

        # 新一次 install = 干净起点：别让 install 之前残留的去抖时间戳吃掉第一个真实请求
        _LAST_ACCEPT_AT = 0.0
        _CFG["output_root_getter"] = output_root_getter if callable(output_root_getter) else None
        _CFG["index_path_getter"] = index_path_getter if callable(index_path_getter) else None
        _CFG["interval_sec"] = max(1, int(interval_sec)) if interval_sec else 20
        try:
            _CFG["debounce_sec"] = max(0.0, float(debounce_sec))
        except (TypeError, ValueError):
            _CFG["debounce_sec"] = 1.5
        with _STATUS_LOCK:
            _STATUS["installed"] = True
            _STATUS["running"] = True
            _STATUS["intervalSec"] = _CFG["interval_sec"]
            _STATUS["lastError"] = None

        _STOP.clear()
        _WAKE.clear()
        _THREAD = threading.Thread(target=_driver_loop, name="anima-gallery-warmup", daemon=True)
        _THREAD.start()

    # 事件加速：整段包住，失败只 print 一行并降级到轮询，绝不影响插件加载/生图。
    note = None
    try:
        note = _install_event_hook()
    except Exception as exc:  # 探测本身出任何岔子都不能外溢
        note = f"未挂（探测抛异常：{exc}）—— 只用轮询"
    with _STATUS_LOCK:
        _HOOK_STATE["installed"] = bool(note and note.startswith("已挂"))
        _HOOK_STATE["target"] = "PromptServer.instance.send_sync"
        _HOOK_STATE["note"] = note or ""
        hook_note = _HOOK_STATE["note"]
    print(f"[gallery_warmup] 常驻预热已启动：interval={_CFG['interval_sec']}s "
          f"debounce={_CFG['debounce_sec']}s 首轮延迟={_FIRST_DELAY_SEC}s；事件钩子：{hook_note}")

    with _INSTALL_LOCK:
        return _refresh_snapshot()


def warmup_status() -> dict:
    """返回当前状态副本（**纯读内存，绝不做 IO**）。改返回值不影响内部状态。"""
    with _STATUS_LOCK:
        try:
            snap = copy.deepcopy(_STATUS)
        except Exception:  # lastResult 里混进不可深拷贝对象时的兜底
            snap = dict(_STATUS)
    thread = _THREAD
    snap["running"] = bool(snap["running"]) and thread is not None and thread.is_alive()
    return snap


def request_warmup(reason: str = "") -> bool:
    """请求尽快跑一次预热。**去抖**：``debounce_sec`` 内的多次请求合并为一次运行。

    返回是否"被接受"（True = 第一个触发者；False = 与已有请求/正在跑的那轮合并）。
    注意：被合并**不等于**请求丢失 —— 标志位一直留着，下一轮一定会看到最新文件。

    本函数只碰内存（置标志 + ``Event.set()``），可安全地从 ComfyUI 执行线程调用。
    """
    global _LAST_ACCEPT_AT
    now = time.time()
    debounce = max(0.0, float(_CFG["debounce_sec"] or 0))
    with _STATUS_LOCK:
        coalesced = bool(_STATUS["pending"]) or (now - _LAST_ACCEPT_AT) < debounce
        _STATUS["pending"] = True
        if coalesced:
            _REQ_STATS["rejected"] += 1
            accepted = False
        else:
            _LAST_ACCEPT_AT = now
            _REQ_STATS["accepted"] += 1
            accepted = True
        _REQ_STATS["lastReason"] = str(reason or "")
        _REQ_STATS["lastAt"] = now
    _WAKE.set()
    return accepted


def warmup_diagnostics() -> dict:
    """诊断快照（**非契约**，给排查/端点用）：钩子探测结论、缩略图统计、请求计数。"""
    thread = _THREAD
    with _STATUS_LOCK:
        return {
            "hook": dict(_HOOK_STATE),
            "thumbs": dict(_THUMB_STATE),
            "requests": dict(_REQ_STATS),
            "events": dict(_EVENT_STATS),
            "config": {"intervalSec": _CFG["interval_sec"], "debounceSec": _CFG["debounce_sec"],
                       "firstDelaySec": _FIRST_DELAY_SEC, "thumbWorkers": _THUMB_WORKERS,
                       "thumbMaxPerBatch": _THUMB_MAX_PER_BATCH,
                       "maxIntervalSec": _MAX_INTERVAL_SEC, "backoffAfter": _BACKOFF_AFTER},
            "runtime": dict(_RUNTIME),
            "signature": [len(_LAST_RELS), _LAST_ROOT_MTIME_NS],
            "trackedRels": len(_LAST_RELS),
            "thread": {"name": thread.name if thread else "", "alive": bool(thread and thread.is_alive())},
        }


# ── 内部辅助 ───────────────────────────────────────────────────────────────

def _refresh_snapshot() -> dict:
    """刷新并返回**同一份** install 快照对象（调用方请勿改写）。需持有 _INSTALL_LOCK。"""
    global _INSTALL_SNAPSHOT
    if _INSTALL_SNAPSHOT is None:
        _INSTALL_SNAPSHOT = {}
    _INSTALL_SNAPSHOT.clear()
    _INSTALL_SNAPSHOT.update(warmup_status())
    return _INSTALL_SNAPSHOT


def _shutdown_for_tests(timeout: float = 2.0) -> None:
    """仅供测试：停掉驱动线程（生产不需要 —— 线程是 daemon，随进程退出）。"""
    _STOP.set()
    _WAKE.set()
    thread = _THREAD
    if thread is not None:
        thread.join(timeout)
    with _STATUS_LOCK:
        _STATUS["running"] = False
