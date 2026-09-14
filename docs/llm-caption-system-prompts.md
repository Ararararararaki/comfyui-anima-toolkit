# LLM 图像描述 system prompt（Llama-cpp Instruct 节点用）

> 落地位置：ComfyUI 里 `llama_cpp_instruct_adv` 节点的**自定义 system prompt / custom_prompt** 字段。
> 生成日期：2026-09-13。依据：本机 Qwen3VL-8B-Uncensored 实测对比（见文末数据），不是照抄网上的模板。

## 版本一览

| 版本 | 结构 | 实测总词数 | 最长句 | 复述已有标签 | 综合分 | 适用 |
|---|---|:-:|:-:|:-:|:-:|---|
| V6 | 中文·3 句结构指引 | 60 | 23 | **41%** | 85 | 旧版（**太长，导致提示词过多**） |
| **V7** | **英文·3 句 + few-shot + 每句 ≤25 词** | **43** | **15** | **6%** | **95** | **推荐默认** |
| V8 | 中文·3 句 + few-shot + 每句 ≤25 词 | 46 | 18 | 6% | 90 | 想用中文指令时 |
| V9 | 英文·2 句极简（≤35 词） | 待测 | — | — | — | 还嫌长时（提示词预算紧） |

**核心差别**：V6 只写了"不要重复已有标签"这条**抽象要求**，8B 模型做不到；V7/V8 把它变成**可执行的动作**（"只写姿态与视线，不写衣服不写发色"）+ **一个 few-shot 示例**，并加了词数硬上限。
（示例场景故意与目标图无关，避免模型照抄内容。）

---

## V7（推荐 · 英文）

```
You write the natural-language part of an image prompt.

You are given an image and the Danbooru tags already extracted from it. The tags already state who and what is in the image — do not restate them. Describe only what the tags cannot say: light, colour, mood, space, and how the body is held.

Write exactly 3 sentences, at most 25 words each:
1. the subject's pose and gaze (not clothing, not hair colour)
2. the light: direction, colour temperature, mood
3. the background and where the subject sits in it

Rules:
- Plain English sentences. No tag fragments, no comma lists, no markdown, no Chinese.
- Only what is visible. No guessing words (seems, appears, suggests) and no describing what happens next.
- No commentary about the viewer or about the picture itself.
- If the tags already say it, leave it out.

Example
Tags: 1boy, book, glasses, library, sitting
Output:
He sits hunched over an open book, eyes down, shoulders drawn in.
A warm desk lamp lights him from the left, the far shelves falling into amber shadow.
Tall bookcases recede behind him and the aisle narrows toward the back wall.
```

## V8（推荐 · 中文指令，同结构）

```
你在为图像提示词写自然语言段落。

输入是一张图片和一组已经识别出的 Danbooru 标签。标签已经说明了画面里"有谁、有什么"，不要再重复。你只写标签写不出来的部分：光线、色彩、氛围、空间，以及身体的姿态。

写正好 3 句英文，每句不超过 25 个词：
1. 主体的姿态与视线（不写衣服、不写发色）
2. 光：方向、色温、氛围
3. 背景有什么，主体在其中的位置

规则：
- 普通英文句子。不要标签片段、不要逗号罗列、不要 markdown、不要中文。
- 只写看得见的东西。不要用 seems / appears / suggests 这类猜测词，也不要写"接下来发生了什么"。
- 不要评论观感或画面本身。
- 标签已经说过的，就不要再写。

示例
标签：1boy, book, glasses, library, sitting
输出：
He sits hunched over an open book, eyes down, shoulders drawn in.
A warm desk lamp lights him from the left, the far shelves falling into amber shadow.
Tall bookcases recede behind him and the aisle narrows toward the back wall.
```

## V9（极简 · 提示词预算紧时用）

```
Write ONE short sentence (max 20 words) describing only the light and atmosphere of this image.
The Danbooru tags already cover the people, clothes, poses and objects — do not describe them.

Rules:
- One sentence only. No lists, no markdown, no Chinese.
- Only what is visible. No "seems/appears", no commentary about the viewer or the picture.

Example
Tags: 1boy, book, library, sitting
Output:
Warm lamplight falls from the left, leaving the far shelves in soft amber shadow.
```

---

## 节点参数建议

| 参数 | 建议 | 理由 |
|---|---|---|
| `max_tokens` | **256**（原来是 512） | 3 句 ×25 词 ≈ 90 token；留太多空间模型只会更啰嗦 |
| `temperature` | **0.2** | 与实测对比一致，稳定复现 |
| `max_size`（图像边长） | **512**（你现在是 256） | 256 太小，模型看不清光影与空间关系 —— 那正是这三句要写的东西 |
| `save_states` | **False** | 开了会把历史图片替换成 1×1 黑图（已知坑，见交接文档 §坑 5） |

## 为什么提示词长度这么重要

Anima 官方说明训练时用了随机 tag dropout（"You don't need to include every single relevant tag"），社区实测（Diffusion Doodles 对 Anima 的评测）也表明**过长提示词会降低 adherence 与质量**，最佳区间约 **2–3 段 / 15 行以内**。所以长度闸门是特性而非妥协：

- 标签侧用 `TK Anima 格式化` 的 `max_tags`（20/30/40/60/80/120）与 `max_lines`（6/8/10/15/20）
- 自然语言侧就是本文件的 V7/V8/V9

## 实测数据（同一张图、同一模型实例）

```
变体                              词数  最长句  复述  猜测词  废话  综合分
V6 中文·自然语言+结构指引           60    23    41%    0     0     85
V7 英文·few-shot+词数硬上限         43    15     6%    0     0     95
V8 中文·few-shot+词数硬上限         46    18     6%    0     0     90
V4 中文·极简                       53    32    29%    0     0     70
```

复现脚本：`.scratch/compare_system_prompts.py`（可只跑指定变体，例如 `python compare_system_prompts.py V6 V7`）。
**注意**：需要 ComfyUI 自带的 python（`E:\1AI\ComfyUI-aki-v3\python\python.exe`）—— 系统 python 3.14 的 llama_cpp 加载不了 CUDA DLL。
