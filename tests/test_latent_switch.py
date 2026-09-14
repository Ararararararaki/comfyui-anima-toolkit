"""TK Latent 选择/合成节点的行为测试。

合成部分**直接验证张量内容**（背景哪个区域被层覆盖、羽化是否生效、4D/5D 是否都对），
而不是去 mock ComfyUI 的节点 —— 本节点自己实现了 paste，必须测真东西。
"""

import pytest

torch = pytest.importorskip("torch")
if getattr(torch, "__file__", None) is None:
    # conftest 在「没装 torch」时注入的 permissive 占位（没有 __file__）：
    # 合成模式要真张量才算得对，明确跳过而不是假装通过。
    pytest.skip("torch 不可用（干净 CI 环境）", allow_module_level=True)

from anima_latent_switch import (  # noqa: E402
    AnimaTKLatentSwitch,
    MODE_COMPOSITE,
    MODE_PICK,
    centered_offset,
    match_batch,
    parse_layout,
    paste_latent,
)


def latent(batch=1, height=8, width=8, fill=0.0, frames=True):
    """造 latent：frames=True → Anima 的 5D ``[B,16,1,H,W]``；False → SD 的 4D ``[B,16,H,W]``。"""
    shape = (batch, 16, 1, height, width) if frames else (batch, 16, height, width)
    return {"samples": torch.full(shape, float(fill))}


def value_at(samples, y, x):
    return float(samples[..., y, x].flatten()[0])


def make_node():
    return AnimaTKLatentSwitch()


# ── layout 解析 ──

def test_parse_layout_reads_offsets_and_ignores_junk():
    parsed = parse_layout("2 = 0, -128, 8\n3 = 64，32\n乱写\n9 = 1,1,1\n\n")
    assert parsed[2] == (0, -128, 8)
    assert parsed[3] == (64, 32, 0)          # 中文逗号 + 缺 feather
    assert 9 not in parsed                   # 超出六路
    assert len(parsed) == 2


def test_parse_layout_empty_means_centered():
    assert parse_layout("") == {}
    assert parse_layout(None) == {}


# ── 选择模式 ──

def test_pick_returns_selected_latent_with_its_denoise():
    result = make_node().apply(
        MODE_PICK, 3, 1, "",
        latent_1=latent(fill=1.0), latent_3=latent(fill=3.0),
        denoise_1=1.0, denoise_3=0.75,
    )
    samples, denoise, index, summary = result
    assert value_at(samples["samples"], 0, 0) == 3.0
    assert denoise == 0.75
    assert index == 3
    assert "第 3 路" in summary and "0.75" in summary


def test_pick_falls_back_to_first_connected_slot():
    _samples, denoise, index, summary = make_node().apply(
        MODE_PICK, 5, 1, "",                 # 第 5 路没接
        latent_2=latent(fill=2.0), denoise_2=0.6,
    )
    assert index == 2
    assert denoise == 0.6
    assert "回落到第 2 路" in summary


def test_pick_raises_when_nothing_connected():
    with pytest.raises(ValueError):
        make_node().apply(MODE_PICK, 1, 1, "", denoise_1=1.0)


def test_pick_defaults_denoise_when_widget_missing():
    _samples, denoise, index, _summary = make_node().apply(
        MODE_PICK, 2, 1, "", latent_2=latent())
    assert index == 2
    assert denoise == 0.6                    # DEFAULT_DENOISE 第 2 路 = 图生图 0.6


def test_pick_clamps_out_of_range_denoise():
    _samples, denoise, _index, _summary = make_node().apply(
        MODE_PICK, 1, 1, "", latent_1=latent(), denoise_1=7.5)
    assert denoise == 1.0


# ── 合成模式（验张量） ──

def test_composite_centers_unspecified_layers():
    samples, denoise, index, summary = make_node().apply(
        MODE_COMPOSITE, 1, 1, "",
        latent_1=latent(height=16, width=16),          # 背景全 0
        latent_2=latent(height=8, width=8, fill=5.0),  # 层全 5
        denoise_1=0.6,
    )
    out = samples["samples"]
    assert index == 1 and denoise == 0.6
    assert value_at(out, 8, 8) == 5.0                  # 中心：被层覆盖
    assert value_at(out, 0, 0) == 0.0                  # 角落：仍是背景
    assert value_at(out, 4, 4) == 5.0                  # 居中偏移 = 4 格 → (32px)
    assert value_at(out, 3, 3) == 0.0
    assert "背景 第 1 路" in summary and "2(" in summary


def test_composite_respects_layout_offsets():
    samples, _denoise, _index, _summary = make_node().apply(
        MODE_COMPOSITE, 1, 1, "2 = 0, 0, 0",
        latent_1=latent(height=16, width=16),
        latent_2=latent(height=8, width=8, fill=7.0),
    )
    out = samples["samples"]
    assert value_at(out, 0, 0) == 7.0                  # 贴到左上角
    assert value_at(out, 8, 8) == 0.0                  # 右下仍是背景


def test_composite_handles_negative_offsets_by_clipping():
    samples, _denoise, _index, _summary = make_node().apply(
        MODE_COMPOSITE, 1, 1, "2 = -32, -32, 0",       # 左上各切掉 4 格
        latent_1=latent(height=16, width=16),
        latent_2=latent(height=8, width=8, fill=9.0),
    )
    out = samples["samples"]
    assert value_at(out, 0, 0) == 9.0                  # 可见部分仍贴上了
    assert value_at(out, 4, 4) == 0.0                  # 层只覆盖左上 4×4 格


def test_composite_stacks_layers_in_slot_order():
    samples, _denoise, _index, summary = make_node().apply(
        MODE_COMPOSITE, 1, 1, "2 = 0, 0, 0\n3 = 0, 0, 0",
        latent_1=latent(height=8, width=8),
        latent_2=latent(height=8, width=8, fill=1.0),
        latent_3=latent(height=8, width=8, fill=2.0),
    )
    assert value_at(samples["samples"], 0, 0) == 2.0   # 后叠的 3 覆盖 2
    assert "2(" in summary and "3(" in summary


def test_composite_feather_blends_edges():
    samples, _denoise, _index, _summary = make_node().apply(
        MODE_COMPOSITE, 1, 1, "2 = 0, 0, 16",          # feather 16px = 2 格
        latent_1=latent(height=32, width=32),
        latent_2=latent(height=16, width=16, fill=8.0),
    )
    out = samples["samples"]
    edge = value_at(out, 0, 0)
    assert 0.0 < edge < 8.0                            # 角落被羽化（既不是纯背景也不是纯层）
    assert value_at(out, 8, 8) == 8.0                  # 内部仍是纯层值
    assert value_at(out, 20, 20) == 0.0                # 层之外仍是背景


def test_composite_with_only_background_is_passthrough():
    samples, _denoise, index, summary = make_node().apply(
        MODE_COMPOSITE, 1, 1, "", latent_1=latent(fill=5.0))
    assert index == 1
    assert value_at(samples["samples"], 0, 0) == 5.0
    assert "无（只有背景）" in summary


def test_composite_falls_back_when_base_slot_empty():
    _samples, _denoise, index, summary = make_node().apply(
        MODE_COMPOSITE, 1, 6, "", latent_3=latent(height=8, width=8))
    assert index == 3
    assert "已改用第 3 路" in summary


# ── 工具函数 / 维度兼容 ──

def test_centered_offset_uses_last_two_dims():
    big = latent(height=16, width=16)["samples"]
    small = latent(height=8, width=8)["samples"]
    assert centered_offset(big, small) == (32, 32, 0)
    assert centered_offset(small, big) == (0, 0, 0)      # 层比背景大 → 不偏移


def test_paste_works_for_5d_anima_and_4d_sd_latents():
    """Anima 的 5D latent 与 SD 的 4D latent 都要贴对位置。

    （原生 LatentComposite 把 shape[2]/[3] 当高宽，对 5D 会拿帧维当高度 → 错位。）
    """
    for frames in (True, False):
        background = latent(height=16, width=16, frames=frames)["samples"]
        layer = latent(height=8, width=8, fill=3.0, frames=frames)["samples"]
        out = paste_latent(background, layer, 0, 0, 0)
        assert out.shape == background.shape
        assert value_at(out, 0, 0) == 3.0
        assert value_at(out, 12, 12) == 0.0
        assert out.dim() == background.dim()


def test_paste_returns_background_when_layer_fully_outside():
    background = latent(height=8, width=8)["samples"]
    layer = latent(height=8, width=8, fill=4.0)["samples"]
    out = paste_latent(background, layer, 512, 512, 0)
    assert value_at(out, 0, 0) == 0.0


def test_match_batch_repeats_and_truncates():
    single = latent(batch=1)["samples"]
    many = latent(batch=4)["samples"]
    assert match_batch(single, 4).shape[0] == 4
    assert match_batch(many, 2).shape[0] == 2
    assert match_batch(many, 4).shape[0] == 4
    assert match_batch(latent(batch=3)["samples"], 4).shape[0] == 4


def test_composite_aligns_mismatched_batch_sizes():
    samples, _denoise, _index, _summary = make_node().apply(
        MODE_COMPOSITE, 1, 1, "2 = 0, 0, 0",
        latent_1=latent(batch=2, height=8, width=8),
        latent_2=latent(batch=1, height=8, width=8, fill=6.0),
    )
    out = samples["samples"]
    assert out.shape[0] == 2
    assert value_at(out, 0, 0) == 6.0


def test_schema_exposes_six_slots_and_mode_switch():
    schema = AnimaTKLatentSwitch.INPUT_TYPES()
    optional = schema["optional"]
    assert all(f"latent_{i}" in optional for i in range(1, 7))
    assert all(f"denoise_{i}" in optional for i in range(1, 7))
    assert schema["required"]["mode"][0] == [MODE_PICK, MODE_COMPOSITE]
    assert AnimaTKLatentSwitch.RETURN_NAMES == ("latent", "denoise", "index", "summary")
