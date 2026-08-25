# TK Image Select 单测（纯节点逻辑，无需 ComfyUI）
# 运行：python tests/test_image_select.py
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import anima_image_select as ais

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

# 假张量（object 即可，逻辑不依赖 tensor）
class FakeTensor:
    def __init__(self, tag): self.tag = tag

T = {f"image{i}": FakeTensor(f"t{i}") for i in range(1, 9)}
node = ais.AnimaImageSelect()

print("== 优先顺序（默认，兼容旧行为） ==")
out, idx, name = node.select(priority="image3", **T)
check("首选 image3", name == "image3" and idx == 3, (name, idx))
srcs = {**T, "image1": None, "image3": None, "image5": None}  # 非空：2,4,6,7,8
out, idx, name = node.select(priority="image3", **srcs)
check("首选为空自动兜底 image2", name == "image2" and idx == 2, (name, idx))
out, idx, name = node.select(priority="image5", **srcs)
check("image5 空→按编号找 image2", name == "image2", name)

print("== 指定索引 ==")
out, idx, name = node.select(mode="指定索引", index=4, **T)
check("指定索引 4", name == "image4" and idx == 4, (name, idx))
try:
    node.select(mode="指定索引", index=6, **{**T, "image6": None})
    check("空索引应报错", False)
except ValueError:
    check("空索引应报错", True)

print("== 随机 / Seed 稳定 ==")
outs = set()
for _ in range(40):
    _, _, n = node.select(mode="随机", seed=0, **srcs)
    outs.add(n)
check("随机只在非空路内", outs <= {"image2", "image4", "image6", "image7", "image8"} and len(outs) > 1, outs)
froms = {}
for _ in range(5):
    _, _, n = node.select(mode="Seed 稳定", seed=42, **srcs)
    froms[n] = froms.get(n, 0) + 1
check("Seed 稳定取同一路", len(froms) == 1, froms)
s2 = set()
for _ in range(5):
    _, _, n = node.select(mode="Seed 稳定", seed=7, **srcs)
    s2.add(n)
check("不同 seed 可不同路", len(s2) == 1, s2)

print("== 轮询 ==")
r1 = [node.select(mode="轮询", **srcs)[2] for _ in range(6)]
check("轮询按编号循环覆盖全部非空路", r1 == ["image2", "image4", "image6", "image7", "image8", "image2"], r1)

print("== 全空报错 / 空列表报错 ==")
try:
    node.select(**{f"image{i}": None for i in range(1, 9)})
    check("全空报错", False)
except ValueError:
    check("全空报错", True)
try:
    node.select(**{**srcs, "image2": []})
    check("空列表报错", False)
except ValueError:
    check("空列表报错", True)

print("== IS_CHANGED 缓存键 ==")
k1 = ais.AnimaImageSelect.IS_CHANGED(mode="优先顺序", priority="image1", index=1, seed=0, image1=T["image1"], image2=None)
k2 = ais.AnimaImageSelect.IS_CHANGED(mode="优先顺序", priority="image1", index=1, seed=0, image1=T["image1"], image2=None)
check("同参同对象缓存键稳定", k1 == k2)
k3 = ais.AnimaImageSelect.IS_CHANGED(mode="优先顺序", priority="image1", index=1, seed=0, image1=FakeTensor("new"), image2=None)
check("上游对象变化键变化", k1 != k3)
k4 = ais.AnimaImageSelect.IS_CHANGED(mode="轮询", priority="image1", index=1, seed=0, image1=T["image1"])
import time
time.sleep(0.001)
k5 = ais.AnimaImageSelect.IS_CHANGED(mode="轮询", priority="image1", index=1, seed=0, image1=T["image1"])
check("轮询模式每次键变化", k4 != k5)

print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)