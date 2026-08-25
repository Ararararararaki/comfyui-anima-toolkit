# Anima Image Select — TK 图像选择节点
# 多路 IMAGE 输入 n 选一路由：
#   - 固定提供 image1~image8 共 8 个可选输入（用几路接几路，2~8 任意）；
#   - 未连接（为空）的一路自动跳过、不报错；至少一路有效；
#   - 路由模式（2026-08-24 扩展）：
#       优先顺序（默认，兼容旧节点）：按 priority 首选 → 其余按编号从小到大兜底
#       指定索引      ：取 image<index>（该路为空则报错，避免静默错选）
#       随机          ：从非空路中随机取一路（每次执行随机）
#       Seed 稳定     ：同一 seed 稳定取同一路（跨执行可复现）
#       轮询          ：按非空路循环轮换（IS_CHANGED 强制每次执行）
#   - 输出：IMAGE（恒列表，槽位 0 兼容旧连线）+ source_index（INT，1~8 来源编号）
#     + source_name（STRING，imageN）
# 典型场景：D站画廊输出(可能为列表)接 image1、自定义图源接 image2/3…，切换生图来源时
#   只需拨动下拉或关掉对应图源，不必反复改连线。

import random
import time
import json


class AnimaImageSelect:
    NAME = "TK Image Select"
    CATEGORY = "TK/image"
    _IMAGE_COUNT = 8
    MODES = ["优先顺序", "指定索引", "随机", "Seed 稳定", "轮询"]

    @classmethod
    def INPUT_TYPES(cls):
        images = {f"image{i}": ("IMAGE",) for i in range(1, cls._IMAGE_COUNT + 1)}
        return {
            "required": {
                "mode": (cls.MODES, {"default": "优先顺序", "label": "路由模式"}),
                "priority": ([f"image{i}" for i in range(1, cls._IMAGE_COUNT + 1)], {"default": "image1"}),
                "index": ("INT", {"default": 1, "min": 1, "max": 8, "step": 1, "label": "指定索引"}),
                "seed": ("INT", {"default": 0, "min": -2**63, "max": 2**63 - 1, "step": 1, "label": "随机种子"}),
            },
            "optional": images,
        }

    RETURN_TYPES = ("IMAGE", "INT", "STRING")
    RETURN_NAMES = ("image", "source_index", "source_name")
    # 槽位 0 恒列表（与 D站画廊等列表输出一致；单张时自动包成[张量]）；INT/STRING 为标量
    OUTPUT_IS_LIST = (True, False, False)
    FUNCTION = "select"
    DESCRIPTION = (
        "多路图像路由（image1~image8，用几路接几路 2~8 任意；未接的自动跳过）："
        "路由模式：优先顺序（首选为空自动按 image1→image8 找下一路）/ 指定索引 / 随机 / Seed 稳定 / 轮询；"
        "输出 来源编号(source_index 1~8) + 来源名称(source_name imageN)，全部为空才报错。"
    )

    def select(self, mode="优先顺序", priority="image1", index=1, seed=0, **images):
        labels = [f"image{i}" for i in range(1, self._IMAGE_COUNT + 1)]
        values = {label: images.get(label) for label in labels}
        present = [label for label in labels if values[label] is not None]
        if not present:
            raise ValueError("TK 图像选择：所有输入图像（image1~image8）均为空，请至少连接一路图像输入")

        if mode == "指定索引":
            label = f"image{max(1, min(self._IMAGE_COUNT, int(index)))}"
            if values.get(label) is None:
                raise ValueError(f"TK 图像选择：指定索引 {index} 对应 {label} 未连接（可用：{', '.join(present)}）")
        elif mode == "随机":
            label = random.choice(present)
        elif mode == "Seed 稳定":
            rng = random.Random(int(seed))
            label = present[rng.randrange(len(present))]
        elif mode == "轮询":
            counter = getattr(self, "_rr_counter", 0)
            self._rr_counter = counter + 1
            label = present[counter % len(present)]
        else:  # 优先顺序（默认）：首选优先，其余按编号从小到大兜底
            prio_idx = labels.index(priority) if priority in labels else 0
            order = [prio_idx] + [i for i in range(self._IMAGE_COUNT) if i != prio_idx]
            label = None
            for idx in order:
                if values[labels[idx]] is not None:
                    label = labels[idx]
                    break
            if label is None:  # 理论不可达（present 非空）
                label = present[0]

        chosen = values[label]
        if isinstance(chosen, list):
            if len(chosen) == 0:
                raise ValueError(f"TK 图像选择：输入 {label} 的图像列表为空")
            out = list(chosen)
        else:
            out = [chosen]

        print(f"[TK 图像选择] 模式 {mode} 输出来源：{label}（编号 {label[-1]}），图像张数 {len(out)}")
        return (out, int(label[-1]), label)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """轮询模式每次执行都变化；其余模式用参数 + 上游张量对象指纹（上游变化才重跑）。"""
        mode = kwargs.get("mode", "优先顺序")
        if mode == "轮询":
            return time.time_ns()
        sig = {
            "m": mode,
            "p": kwargs.get("priority"),
            "i": kwargs.get("index"),
            "s": kwargs.get("seed"),
        }
        for k in range(1, cls._IMAGE_COUNT + 1):
            v = kwargs.get(f"image{k}")
            if v is not None:
                if isinstance(v, list):
                    sig[f"i{k}"] = [id(x) for x in v]
                else:
                    sig[f"i{k}"] = id(v)
        try:
            return json.dumps(sig, sort_keys=True, ensure_ascii=False)[:4000]
        except Exception:
            return str(sig)


NODE_CLASS_MAPPINGS = {
    AnimaImageSelect.NAME: AnimaImageSelect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaImageSelect.NAME: "TK 图像选择",
}