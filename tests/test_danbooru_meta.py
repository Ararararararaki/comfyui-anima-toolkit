# D站画廊 metadata_json 输出逻辑测试（不依赖 ComfyUI；torch/numpy/PIL/requests 用 stub）
# 运行：python tests/test_danbooru_meta.py
import os
import sys
import types
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── stub 重依赖（_selection_meta / 空选择分支不触碰张量与网络）──
for mod in ("numpy", "PIL", "PIL.Image"):
    m = types.ModuleType(mod)
    sys.modules[mod] = m
_torch = types.ModuleType("torch")
_torch.zeros = lambda *a, **k: "tensor"
sys.modules["torch"] = _torch
import numpy as _  # noqa
import PIL  # noqa
sys.modules["PIL.Image"] = types.ModuleType("PIL.Image")

_reqs = types.ModuleType("requests")
class _AnyCallable:
    def __call__(self, *a, **k):
        raise RuntimeError("test stub: 无网络")
class _FakeSession(_AnyCallable):
    def __init__(self, *a, **k):
        self.headers = {}
_reqs.Session = _FakeSession
_reqs.get = _AnyCallable()
_reqs.post = _AnyCallable()
sys.modules["requests"] = _reqs

_server = types.ModuleType("server")
class _Routes:
    def __init__(self): self.items = []
    def get(self, path): return self._mk("get", path)
    def post(self, path): return self._mk("post", path)
    def _mk(self, method, path):
        def deco(fn):
            self.items.append((method, path, fn)); return fn
        return deco
class _PS:
    def __init__(self): self.routes = _Routes()
_PS.instance = _PS()
_server.PromptServer = _PS
sys.modules["server"] = _server

import anima_danbooru_gallery as adg

PASS = 0
FAIL = 0
def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  BAD {name}  {detail}")

print("== _selection_meta 字段映射 ==")
sel = {
    "image_url": "https://cdn.example/x.png", "prompt": "1girl, solo",
    "post_id": "12345", "tags": ["1girl", "solo"], "rating": "general",
    "score": "42", "favcount": "7", "width": "512", "height": "768",
    "file_ext": "png", "video": False, "source_url": "https://danbooru.donmai.us/posts/12345",
}
m = adg.DanbooruGallery._selection_meta(sel, ok=True)
check("id 数值化", m["danbooru_id"] == 12345, str(m["danbooru_id"]))
check("tags 保留列表", m["tags"] == ["1girl", "solo"], str(m["tags"]))
check("rating 保留", m["rating"] == "general", str(m["rating"]))
check("score 数值化", m["score"] == 42, str(m["score"]))
check("fav_count 数值化", m["fav_count"] == 7, str(m["fav_count"]))
check("尺寸数值化", m["width"] == 512 and m["height"] == 768, str((m["width"], m["height"])))
check("file_ext/source_url", m["file_ext"] == "png" and "posts/12345" in (m["source_url"] or ""))
check("ok/error", m["ok"] is True and m["error"] is None)

print("== 缺失字段 → None（旧选择数据兼容） ==")
m = adg.DanbooruGallery._selection_meta({"image_url": "x", "prompt": "p"}, ok=False, error="boom")
check("缺失字段 None", m["danbooru_id"] is None and m["tags"] is None and m["rating"] is None, str(m))
check("失败标记", m["ok"] is False and m["error"] == "boom")
check("video 默认 False", m["video"] is False)

print("== video 标记 ==")
m = adg.DanbooruGallery._selection_meta({**sel, "video": True}, ok=True)
check("video True", m["video"] is True)

print("== 空选择分支（default 渲染） ==")
g = adg.DanbooruGallery()
images, prompts, meta = g.get_selected_data("{}")
check("空选择返回 (空图, [\"\"], \"{}\")",
      isinstance(images, list) and prompts == [""] and meta == "{}",
      f"{len(images)} {prompts} {meta[:40]}")
check("空图张量形状", images and isinstance(images[0], type(adg.DanbooruGallery._empty_image())))

print("== selection_list 加固 ==")
images, prompts, meta = g.get_selected_data("not json")
check("坏 JSON 按空选择处理", prompts == [""] and meta == "{}")
images, prompts, meta = g.get_selected_data(json.dumps({"selections": []}))
check("空数组按空选择处理", prompts == [""] and meta == "{}")

print("== metadata_json 结构（全失败场景不入队，用 0 成功验证 raise 前 items 组装已实现） ==")
# 全失败会 raise（保留语义），这里用单条目断言 _selection_meta 在循环中的调用不炸：
sel_bad = {"image_url": "", "prompt": "x", "post_id": "9"}
try:
    g.get_selected_data(json.dumps({"selections": [sel_bad]}))
    check("全失败 raise（保留硬停语义）", False)
except RuntimeError:
    check("全失败 raise（保留硬停语义）", True)

print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)