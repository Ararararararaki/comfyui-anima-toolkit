"""TK Latent 选择/合成 —— 一个节点里切换「六路选一」与「背景 + 主体叠加」。

用途：文生图 / 图生图 / 多参考图合成 放在同一条链路里切换，**denoise 跟着一起变**，
不用改接线、也不用去开关组。

* **选择模式**：六路 latent 选一路输出，同时输出该路配套的 ``denoise`` 值
  （接 KSampler 的 ``denoise``，需先 Convert widget to input）。
  典型配置：第 1 路接空 latent（denoise 1.0 = 文生图），第 2 路接 VAEEncode（denoise 0.6 = 图生图）。
* **合成模式**：指定一路当背景，其余**已连接**的路依次叠加上去（含 feather 羽化）；
  没在 ``layout`` 里写偏移的层默认**居中**，所以"一张背景 + 一张主体"零配置就能用。

两种模式由节点内的 ``mode`` 下拉切换。

⚠️ 三个已知边界：

1. **不能用 ComfyUI 原生的 ``LatentComposite``** —— 它把 ``shape[2]/shape[3]`` 当高宽，
   而 Anima/Cosmos 的 latent 是 **5D** ``[B, C, T, H, W]``（T=1），于是它会拿帧维当高度维，
   切片直接错位/报 shape 不匹配。本节点因此自己实现 paste，**按最后两维当高宽**，
   4D（SD/SDXL）与 5D（Anima）都能用。
2. 本节点**不实现 lazy 求值** —— 所有已连接的 latent 源都会被执行。昂贵分支（例如某一路
   来自另一个 KSampler）请用 ComfyUI 的组开关（Ctrl+B / 组静音）控制，或临时断开连线。
3. 被选中的那一路若没接线，会**回落到第一个已连接的**（并在 ``summary`` 里说明），
   六路全空才报错。
"""

import torch

LATENT_SLOTS = 6

MODE_PICK = "选择一路"
MODE_COMPOSITE = "合成叠加"

#: 六路 denoise 的默认值：第 1 路 = 文生图（空 latent），第 2 路 = 图生图（图片编码）
DEFAULT_DENOISE = (1.0, 0.6, 1.0, 1.0, 1.0, 1.0)


def parse_layout(raw):
    """解析合成模式的偏移表：每行 ``层号 = x, y, feather``（像素，与原生 LatentComposite 同单位）。

    没写的层 → 返回里没有该键 → 调用方按「居中」处理。
    """
    result = {}
    for line in str(raw or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        head, _sep, tail = line.partition("=")
        try:
            index = int(head.strip())
        except ValueError:
            continue
        if not 1 <= index <= LATENT_SLOTS:
            continue
        numbers = []
        for part in tail.replace("，", ",").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                numbers.append(int(round(float(part))))
            except ValueError:
                continue
        result[index] = (
            numbers[0] if len(numbers) > 0 else 0,
            numbers[1] if len(numbers) > 1 else 0,
            numbers[2] if len(numbers) > 2 else 0,
        )
    return result


def centered_offset(background, layer):
    """把 layer 居中放到 background 上，返回像素单位的 (x, y, feather)。

    **用最后两维当高宽** —— Anima 的 latent 是 5D ``[B, C, T, H, W]``，
    照抄原生 LatentComposite 的 ``shape[2]/[3]`` 会拿帧维当高度。
    """
    y = max(0, (background.shape[-2] - layer.shape[-2]) // 2) * 8
    x = max(0, (background.shape[-1] - layer.shape[-1]) // 2) * 8
    return x, y, 0


def feather_mask(height, width, feather, reference):
    """生成边缘线性羽化的权重图（1 = 完全用层，0 = 完全用背景）。"""
    mask = torch.ones(height, width, dtype=reference.dtype, device=reference.device)
    steps = min(feather, max(1, height // 2), max(1, width // 2))
    if steps <= 0:
        return mask
    ramp = torch.linspace(0.0, 1.0, steps + 2, dtype=reference.dtype,
                          device=reference.device)[1:-1]
    mask[:steps, :] *= ramp.view(-1, 1)
    mask[height - steps:, :] *= ramp.flip(0).view(-1, 1)
    mask[:, :steps] *= ramp.view(1, -1)
    mask[:, width - steps:] *= ramp.flip(0).view(1, -1)
    return mask


def paste_latent(background, layer, x, y, feather=0):
    """把 layer 贴到 background 的 (x, y)（像素单位，可为负 / 越界，自动裁剪）。

    与原生 LatentComposite 的差别：按**最后两维**做空间切片，因此 4D 与 5D latent 都正确；
    羽化用「层 × mask + 背景 × (1-mask)」，而不是逐像素循环。
    """
    x //= 8
    y //= 8
    feather //= 8
    out = background.clone()
    height, width = out.shape[-2], out.shape[-1]
    layer_height, layer_width = layer.shape[-2], layer.shape[-1]

    src_x = max(0, -x)
    src_y = max(0, -y)
    dst_x = max(0, x)
    dst_y = max(0, y)
    copy_w = min(layer_width - src_x, width - dst_x)
    copy_h = min(layer_height - src_y, height - dst_y)
    if copy_w <= 0 or copy_h <= 0:
        return out                      # 完全在画面外：原样返回

    source = layer[..., src_y:src_y + copy_h, src_x:src_x + copy_w]
    target = out[..., dst_y:dst_y + copy_h, dst_x:dst_x + copy_w]
    if feather > 0:
        mask = feather_mask(copy_h, copy_w, feather, out)
        out[..., dst_y:dst_y + copy_h, dst_x:dst_x + copy_w] = source * mask + target * (1 - mask)
    else:
        out[..., dst_y:dst_y + copy_h, dst_x:dst_x + copy_w] = source
    return out


def match_batch(samples, batch):
    """把 batch 对齐到背景的 batch：单张重复，多张截断/循环。"""
    current = samples.shape[0]
    if current == batch:
        return samples
    if current == 1:
        return samples.repeat(batch, 1, 1, 1, 1)
    if current > batch:
        return samples[:batch]
    repeat = batch // current + 1
    return samples.repeat(repeat, 1, 1, 1, 1)[:batch]


class AnimaTKLatentSwitch:
    """六路 latent 的选择/合成节点（含配套 denoise 输出）。"""

    NODE_ID = "AnimaTKLatentSwitch"
    DISPLAY_NAME = "TK Latent 选择/合成"
    CATEGORY = "TK/latent"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (
                    [MODE_PICK, MODE_COMPOSITE],
                    {
                        "default": MODE_PICK,
                        "tooltip": "选择一路：六路选一输出；合成叠加：以 base 为背景，其余已连接的路叠上去。",
                    },
                ),
                "select": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": LATENT_SLOTS,
                        "step": 1,
                        "tooltip": "选择模式：输出第几路 latent（该路没接线时回落到第一个已连接的）。",
                    },
                ),
                "base": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": LATENT_SLOTS,
                        "step": 1,
                        "tooltip": "合成模式：第几路当背景（其余已连接的路叠在它上面）。",
                    },
                ),
                "layout": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "placeholder": "每行一层：层号 = x, y, feather（像素）。留空 = 全部居中。",
                        "tooltip": "合成模式的层偏移，例如 `2 = 0, -128, 8`。没写的层居中叠加。",
                    },
                ),
            },
            "optional": {
                **{
                    f"latent_{index}": ("LATENT", {
                        "tooltip": f"第 {index} 路 latent（可留空）。",
                    })
                    for index in range(1, LATENT_SLOTS + 1)
                },
                **{
                    f"denoise_{index}": ("FLOAT", {
                        "default": DEFAULT_DENOISE[index - 1],
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "round": 0.05,
                        "tooltip": f"选中/作为背景的是第 {index} 路时，denoise 输出这个值。",
                    })
                    for index in range(1, LATENT_SLOTS + 1)
                },
            },
        }

    RETURN_TYPES = ("LATENT", "FLOAT", "INT", "STRING")
    RETURN_NAMES = ("latent", "denoise", "index", "summary")
    FUNCTION = "apply"
    DESCRIPTION = ("六路 Latent 选一路输出（denoise 联动）或以一路为背景叠加其余路；"
                   "模式在节点内切换，适合文生图/图生图/多参考合成共用一条链路。")
    SEARCH_ALIASES = ["latent switch", "latent select", "latent composite", "multi latent"]

    # ── 内部工具 ──

    @staticmethod
    def _connected(kwargs):
        """已连接且形态合法的路号（按从小到大）。"""
        found = []
        for index in range(1, LATENT_SLOTS + 1):
            value = kwargs.get(f"latent_{index}")
            if isinstance(value, dict) and value.get("samples") is not None:
                found.append(index)
        return found

    @staticmethod
    def _denoise_of(kwargs, index):
        raw = kwargs.get(f"denoise_{index}", DEFAULT_DENOISE[index - 1])
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return DEFAULT_DENOISE[index - 1]
        return max(0.0, min(1.0, value))

    def apply(self, mode, select, base, layout, **kwargs):
        connected = self._connected(kwargs)
        if not connected:
            raise ValueError("TK Latent 选择/合成：六路 latent 一个都没接。")

        if mode == MODE_COMPOSITE:
            return self._composite(connected, base, layout, kwargs)
        return self._pick(connected, select, kwargs)

    def _pick(self, connected, select, kwargs):
        note = ""
        index = int(select) if 1 <= int(select) <= LATENT_SLOTS else connected[0]
        if index not in connected:
            note = f"（第 {index} 路没接线，已回落到第 {connected[0]} 路）"
            index = connected[0]
        samples = kwargs[f"latent_{index}"]["samples"]
        denoise = self._denoise_of(kwargs, index)
        summary = f"选择：第 {index} 路 → denoise {denoise:g}{note}"
        return ({"samples": samples}, denoise, index, summary)

    def _composite(self, connected, base, layout, kwargs):
        base_index = int(base) if 1 <= int(base) <= LATENT_SLOTS else connected[0]
        note = ""
        if base_index not in connected:
            note = f"（背景指定的第 {base_index} 路没接线，已改用第 {connected[0]} 路）"
            base_index = connected[0]

        background = kwargs[f"latent_{base_index}"]["samples"]
        offsets = parse_layout(layout)
        result = background
        used = []
        for index in connected:
            if index == base_index:
                continue
            layer = match_batch(kwargs[f"latent_{index}"]["samples"], background.shape[0])
            if index in offsets:
                x, y, feather = offsets[index]
            else:
                x, y, feather = centered_offset(background, layer)
            result = paste_latent(result, layer, x, y, feather)
            used.append(f"{index}(x{x},y{y},f{feather})")

        denoise = self._denoise_of(kwargs, base_index)
        layers = "、".join(used) if used else "无（只有背景）"
        summary = (f"合成：背景 第 {base_index} 路 → denoise {denoise:g}；"
                   f"叠加 {layers}{note}")
        return ({"samples": result}, denoise, base_index, summary)


NODE_CLASS_MAPPINGS = {
    "AnimaTKLatentSwitch": AnimaTKLatentSwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AnimaTKLatentSwitch": "TK Latent 选择/合成",
}
