# 卡片库 v2 信封后端逻辑测试（不依赖运行中 ComfyUI）
# 运行：python tests/test_cards_v2.py
import os
import sys
import json
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_folder = types.ModuleType("folder_paths")
_folder.get_input_directory = lambda: tempfile.mkdtemp(prefix="cards_v2_in_")
sys.modules["folder_paths"] = _folder

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

# anima_prompt_cards → anima_batch_lora 需要 comfy.* stub
_comfy = types.ModuleType("comfy")
_comfy.__path__ = []
sys.modules["comfy"] = _comfy
for _sub in ("sd", "utils"):
    m = types.ModuleType("comfy." + _sub)
    sys.modules["comfy." + _sub] = m

_pkg = types.ModuleType("anima_tk_batch")
_pkg.__path__ = [os.path.dirname(os.path.dirname(os.path.abspath(__file__)))]
_pkg.__package__ = "anima_tk_batch"
sys.modules["anima_tk_batch"] = _pkg

import anima_tk_batch.anima_prompt_batch as apb  # noqa: F401（路由注册副作用）
import anima_tk_batch.anima_prompt_cards as apc

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

# 用临时 input 目录（_folder.get_input_directory 已指向 tempfile）
import shutil
tmp_in = _folder.get_input_directory()

print("== v2 空库 ==")
blank = apc._load_cards()
check("空库是 v2 信封", blank.get("version") == 2 and isinstance(blank.get("cards"), list), json.dumps(blank, ensure_ascii=False)[:160])
check("默认分类完整", len(blank.get("categories")) == 7, json.dumps(blank, ensure_ascii=False)[:200])

print("== v2 round-trip ==")
v2 = {
    "version": 2, "updated": 1,
    "categories": [{"id": "a", "name": "角色", "icon": "", "sortOrder": 0},
                   {"id": "b", "name": "画风", "icon": "", "sortOrder": 1}],
    "cards": [{"id": "c1", "en": "skadi (arknights)", "zh": "斯卡蒂", "weight": "1.2",
               "star": True, "lora": "skadi_v1", "src": "px", "ts": 1, "multi": False,
               "categories": ["a"]},
              {"id": "c2", "en": "masterpiece", "zh": "", "weight": "", "star": False,
               "lora": "", "src": "", "ts": 2, "multi": False, "categories": ["b", "a"]}],
}
apc._save_cards(v2)
loaded = apc._load_cards()
check("v2 原样读回", loaded["version"] == 2 and len(loaded["cards"]) == 2 and loaded["cards"][0]["en"] == "skadi (arknights)",
      json.dumps(loaded, ensure_ascii=False)[:200])
check("多分类保留", loaded["cards"][1]["categories"] == ["b", "a"], str(loaded["cards"][1]["categories"]))

print("== 旧格式迁移 ==")
legacy = {
    "categories": ["角色", "画风"],
    "cards": {
        "角色": [{"en": "skadi (arknights)", "zh": "斯卡蒂", "weight": "1.2", "star": True, "lora": "x", "src": "s", "ts": 3}],
        "画风": [{"en": "masterpiece", "zh": "", "weight": "", "star": False, "lora": "", "src": "", "ts": 4}],
    },
}
mig = apc._migrate_legacy(legacy)
check("迁移为 v2", mig["version"] == 2 and len(mig["cards"]) == 2 and isinstance(mig["categories"], list), json.dumps(mig, ensure_ascii=False)[:200])
check("卡片有 id", all(c.get("id") for c in mig["cards"]), str(mig["cards"])[:200])
check("分类对象化且归属正确", mig["cards"][0]["categories"] and mig["cards"][0]["categories"][0] == mig["categories"][0]["id"],
      json.dumps(mig, ensure_ascii=False)[:200])

print("== 落盘迁移（旧文件 → 读回 v2 & 写回） ==")
os.makedirs(apc.CARDS_DIR, exist_ok=True)
with open(apc.CARDS_PATH, "w", encoding="utf-8") as f:
    json.dump(legacy, f, ensure_ascii=False)
re = apc._load_cards()
check("旧文件读回即 v2", re["version"] == 2 and len(re["cards"]) == 2, json.dumps(re, ensure_ascii=False)[:200])
with open(apc.CARDS_PATH, "r", encoding="utf-8") as f:
    on_disk = json.load(f)
check("迁移结果已写盘", on_disk.get("version") == 2, json.dumps(on_disk, ensure_ascii=False)[:120])

print("== 保存接口归一化（旧 body / 坏数据兜底） ==")
from aiohttp import web
import asyncio

class FakeReq:
    def __init__(self, body):
        self._body = body
    async def json(self):
        return self._body

async def _t():
    # v2 body
    r = await apc.cards_save(FakeReq({
        "version": 2,
        "categories": [{"id": "a", "name": "A", "icon": "", "sortOrder": 0}],
        "cards": [{"id": "x", "en": "hello", "categories": ["a"]},
                  {"id": "x", "en": "world", "categories": []},   # 重复 id
                  {"en": "no id"}]                                 # 无 id
    }))
    payload = json.loads(r.body.decode()) if isinstance(r.body, bytes) else r.body
    check("v2 保存 count=3", payload.get("count") == 3, str(payload))
    saved = apc._load_cards()
    check("重复 id 已消歧", len({c["id"] for c in saved["cards"]}) == 3, str([c["id"] for c in saved["cards"]]))
    # 旧 body
    r2 = await apc.cards_save(FakeReq(legacy))
    check("旧 body 保存 v2", json.loads(r2.body.decode()).get("version") == 2, str(r2.body)[:120])
    # 坏 body
    r3 = await apc.cards_save(FakeReq([]))
    check("非对象 body 拒绝", r3.status == 400, str(r3.status))

asyncio.run(_t())

print("== 类别默认兜底（categories 为空时保留默认） ==")
apc._save_cards({"version": 2, "updated": 0, "categories": [], "cards": []})
r = apc._load_cards()
check("空 categories 读回默认", len(r["categories"]) == 7, json.dumps(r, ensure_ascii=False)[:120])

shutil.rmtree(tmp_in, ignore_errors=True)
print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)