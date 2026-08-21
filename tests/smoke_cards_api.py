# -*- coding: utf-8 -*-
"""/anima/cards 路由冒烟测试：CRUD / lora-triggers / export / image。"""
import json, urllib.request, os, glob

BASE = "http://127.0.0.1:8188"

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                                headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

ok = 0
def check(name, cond, detail=""):
    global ok
    if cond:
        ok += 1
        print(f"  [OK] {name} {detail}")
    else:
        print(f"  [FAIL] {name} {detail}")

# 1. GET 空库（应带预置分类）
st, d = req("GET", "/anima/cards")
check("GET /anima/cards", st == 200 and "角色" in d.get("categories", []), f"cats={d.get('categories')}")

# 2. POST 保存一张卡
lib = {"categories": ["角色", "LoRA 触发词"],
       "cards": {"角色": [{"en": "pranara", "zh": "普拉娜", "weight": "", "star": True, "lora": "", "src": "test", "ts": 1}],
                 "LoRA 触发词": []}}
st, d = req("POST", "/anima/cards", lib)
check("POST /anima/cards", st == 200 and d.get("count") == 1, str(d))

# 3. GET 回读
st, d = req("GET", "/anima/cards")
cards = d.get("cards", {}).get("角色", [])
check("回读含新卡", st == 200 and any(c.get("en") == "pranara" and c.get("star") for c in cards), str(cards)[:120])

# 4. lora-triggers（用磁盘上真实 LoRA 名，bridge 无则走 civitai/空；只验证不报错）
loras_dir = r"E:\1AI\ComfyUI-aki-v3\ComfyUI\models\loras"
names = [os.path.basename(p) for p in glob.glob(os.path.join(loras_dir, "*.safetensors"))[:3]]
if names:
    st, d = req("GET", "/anima/cards/lora-triggers?name=" + urllib.parse.quote(names[0]))
    check("lora-triggers", st == 200 and "triggerWords" in d, f"{names[0]} -> {d.get('triggerWords')}")
else:
    print("  - 无 LoRA 文件，跳过 lora-triggers")

# 5. export 批文件
st, d = req("POST", "/anima/cards/export",
            {"name": "smoke_test_export",
             "groups": [{"name": "角色", "cards": [{"en": "pranara", "zh": "普拉娜", "weight": "1.1"}]}]})
check("export", st == 200 and d.get("ok") and d.get("path"), str(d.get("path")))

# 6. image 解析（用 output 里最新 PNG）
output_dir = r"E:\1AI\ComfyUI-aki-v3\ComfyUI\output"
pngs = sorted(glob.glob(os.path.join(output_dir, "**", "*.png"), recursive=True), key=os.path.getmtime, reverse=True)
if pngs:
    st, d = req("POST", "/anima/cards/image", {"path": pngs[0]})
    if st == 200 and d.get("ok"):
        check("image 解析", bool(d.get("positive")), f"filename={d.get('filename')} positive_len={len(d.get('positive',''))}")
        print(f"        positive 前 80: {d.get('positive','')[:80]!r}")
    else:
        check("image 解析", False, f"{st} {d}")
else:
    print("  - output 无 PNG，跳过 image")

# 7. 清理：删掉测试卡 + 测试导出文件
lib["cards"]["角色"] = []
st, d = req("POST", "/anima/cards", lib)
check("清理测试卡", st == 200 and d.get("count") == 0)
try:
    os.remove(os.path.join(r"E:\1AI\ComfyUI-aki-v3\ComfyUI\input\prompts", "smoke_test_export.txt"))
    print("  - 测试导出文件已清理")
except OSError:
    pass

print(f"\n{ok} checks passed" if ok else "\nALL FAILED")
