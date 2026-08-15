# -*- coding: utf-8 -*-
"""parse_prompt_groups 纯函数单测（不依赖 ComfyUI）。

运行：python tests/test_parse_groups.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from anima_prompt_parser import parse_prompt_groups


def write_tmp(content):
    fd, path = tempfile.mkstemp(suffix='.txt')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(content)
    return path


def test_markdown_heading_with_neg():
    path = write_tmp(
        "## 组1 · 少女\n"
        "masterpiece, 1girl\n"
        "负向: lowres, bad anatomy\n"
        "负面: extra fingers\n"
        "## 组2 · 风景\n"
        "scenery, sky\n"
    )
    groups = parse_prompt_groups(path)
    os.unlink(path)
    assert len(groups) == 2, groups
    name, prompts, region, bg, person, camera, neg = groups[0]
    assert name == "组1 · 少女"
    assert prompts == ["masterpiece, 1girl"]
    assert neg == "lowres, bad anatomy extra fingers", neg
    name2, prompts2, _r, _b, _p, _c, neg2 = groups[1]
    assert name2 == "组2 · 风景"
    assert neg2 is None


def test_no_heading_single_group():
    path = write_tmp("a1, b2\n负向: nsfw\n")
    groups = parse_prompt_groups(path)
    os.unlink(path)
    assert len(groups) == 1
    name, prompts, _r, _b, _p, _c, neg = groups[0]
    assert name.endswith('.txt') or name == os.path.splitext(os.path.basename(path))[0]
    assert prompts == ["a1, b2"]
    assert neg == "nsfw"


def test_empty_group_skip():
    path = write_tmp("## 空\n\n## 有内容\nhello\n")
    groups = parse_prompt_groups(path)
    os.unlink(path)
    assert len(groups) == 1, groups
    assert groups[0][0] == "有内容"


def test_comment_skip():
    path = write_tmp("# 注释\n## 组A\nx\n")
    groups = parse_prompt_groups(path)
    os.unlink(path)
    assert len(groups) == 1
    assert groups[0][0] == "组A"


def test_camera_and_neg_together():
    path = write_tmp("## 机位组\nsolo\n相机: 俯视 近景\n负向: bad hands\n")
    groups = parse_prompt_groups(path)
    os.unlink(path)
    assert len(groups) == 1
    _n, _p, _r, _b, _p2, cam, neg = groups[0]
    assert cam == "俯视 近景"
    assert neg == "bad hands"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"PASS {t.__name__}")
    print(f"\nAll {len(tests)} tests passed.")
