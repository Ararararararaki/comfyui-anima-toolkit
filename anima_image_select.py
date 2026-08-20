# Anima Image Select — TK 图像选择节点
# 多路 IMAGE 输入二选一/多选一透传：
#   - 固定提供 image1~image8 共 8 个可选输入（用几路接几路，2~8 任意）；
#   - 未连接（为空）的一路自动跳过、不报错；至少一路有效；
#   - 「优先使用」下拉一键切换首选来源；首选为空时按 image1→…→image8 顺序找下一个有图的；
#   - 全部为空才报错。
# 典型场景：D站画廊输出(可能为列表)接 image1、自定义图源接 image2/3…，切换生图来源时
#   只需拨动下拉或关掉对应图源，不必反复改连线。
# 输出恒为列表（OUTPUT_IS_LIST=True），与 D站画廊等列表输出、下游单输入节点兼容。

class AnimaImageSelect:
    NAME = "TK Image Select"
    CATEGORY = "TK/image"
    _IMAGE_COUNT = 8

    @classmethod
    def INPUT_TYPES(cls):
        images = {f"image{i}": ("IMAGE",) for i in range(1, cls._IMAGE_COUNT + 1)}
        return {
            "required": {
                "priority": ([f"image{i}" for i in range(1, cls._IMAGE_COUNT + 1)], {"default": "image1"}),
            },
            "optional": images,
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_IS_LIST = (True,)  # 与 D站画廊等列表输出一致；单张时自动包成[张量]
    FUNCTION = "select"
    DESCRIPTION = (
        "多路图像二选一透传（image1~image8，用几路接几路 2~8 任意；未接的自动跳过）："
        "「优先使用」下拉一键切换首选来源，首选为空时自动按 image1→image8 找下一个有图的；"
        "全部为空才报错。输出恒为列表。"
    )

    def select(self, priority="image1", **images):
        labels = [f"image{i}" for i in range(1, self._IMAGE_COUNT + 1)]
        values = {label: images.get(label) for label in labels}
        prio_idx = labels.index(priority) if priority in labels else 0

        # 选用顺序：首选优先，其余按编号从小到大兜底
        order = [prio_idx] + [i for i in range(self._IMAGE_COUNT) if i != prio_idx]

        chosen = None
        chosen_label = None
        for idx in order:
            label = labels[idx]
            if values.get(label) is not None:
                chosen = values[label]
                chosen_label = label
                break
        if chosen is None:
            raise ValueError("TK 图像选择：所有输入图像（image1~image8）均为空，请至少连接一路图像输入")

        if isinstance(chosen, list):
            if len(chosen) == 0:
                raise ValueError(f"TK 图像选择：输入 {chosen_label} 的图像列表为空")
            out = list(chosen)
        else:
            out = [chosen]

        print(f"[TK 图像选择] 输出来源：{chosen_label}（优先 {priority}），图像张数 {len(out)}")
        return (out,)


NODE_CLASS_MAPPINGS = {
    AnimaImageSelect.NAME: AnimaImageSelect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaImageSelect.NAME: "TK 图像选择",
}
