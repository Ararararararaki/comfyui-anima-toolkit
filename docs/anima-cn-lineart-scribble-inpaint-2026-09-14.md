# Anima CN 三类控制（线稿 / 涂鸦 / 重绘）— 实测与用法

> 日期：2026-09-14 · 承接 `docs/anima-pose-control-2026-09-13.md`（姿态那篇）
> 适用：Anima-Base v1.0 + `kohya-ss/ComfyUI-Anima-LLLite`
> 本轮把「其他 CN 类型」这条待办做完：线稿 / 涂鸦 / 重绘三类工作流已生成、**已在真图上跑通**。

---

## 1. 交付物

### 工作流（`ComfyUI/user/default/workflows/`）

| 文件 | 节点 / 连线 | 说明 |
|---|---|---|
| `TK Anima 线稿控制（完整）.json` | 15 / 16 | 打开就能跑：参考图 → 线稿 → LLLite → 采样 → 存图 |
| `TK Anima 线稿控制模块.json` | 5 / 3 | 复制进任意工作流（入口：缩放.image、LLLite.model） |
| `TK Anima 涂鸦控制（完整）.json` | 15 / 16 | 同上，换 Scribble XDoG |
| `TK Anima 涂鸦控制模块.json` | 5 / 3 | |
| `TK Anima 重绘控制（完整）.json` | 19 / 20 | 含 mask img2img + 掩码同步缩放 |
| `TK Anima 重绘控制模块.json` | 10 / 9 | **两个出口**：MODEL（接采样器）+ LATENT（接 KSampler 的 latent） |

### 脚本（`.scratch/`，均已 gitignore）

| 脚本 | 用途 |
|---|---|
| `build_cn_test.py` | HTTP API 对比测试。语法 `<类型>[@strength][@end][@denoise]`，如 `lineart@0.8@0.7`、`inpaint@1.0@0.8@0.6` |
| `build_cn_workflows.py` | 生成上面 6 个 UI 工作流（参数在文件顶部 `KINDS` 里，改这里 = 改产出） |
| `verify_cn_workflows.py` | **静态校验**：必填输入是否接线、widget 数量、槽位类型一致性、bypass 状态 |
| `make_cn_test_mask.py` | 造重绘测试用的 mask（白=重绘区） |
| `make_cn_compare_sheet.py` / `make_cn_full_sheet.py` | 把多张结果拼成一张对比图（省得逐张翻） |

---

## 2. 一句话结论

| 类型 | 预处理器 | 权重 | strength | end_percent | 备注 |
|---|---|---|---|---|---|
| 姿态（已完成） | `DWPreprocessor` | `any-test-like-v2` | 0.8 | **0.45** | 骨架最稀疏，0.8 会崩 |
| **线稿** | `AnimeLineArtPreprocessor` | `any-test-like-v2` | 0.8 | **0.7** | 想更自由降到 0.45 |
| **涂鸦** | `Scribble_XDoG_Preprocessor` | `any-test-like-v2` | 0.8 | **0.7** | 同上 |
| **重绘** | —（吃掩码） | `inpainting-v2`（4ch） | 1.0 | 0.8 | denoise 0.6；0.8~1.0 差异极小 |

**两条硬结论**：

1. **权重必须用 `any-test-like-v2` / `inpainting-v2`** —— 官方只为 Anima-Base v1.0 重训了这两个
   （前者训练数据就是 "Lineart / scribble / grayscale, heavily augmented"）。
2. **`lineart-1` / `scribble-1`（Preview3 老权重）在 v1.0 上几乎不跟随** —— 实测出图构图与参考图**无关**
   （见 §4 对比图 L3 / S3）。官方只说"质量略降"，实际是**控制力基本失效**，别浪费时间试。

---

## 3. 链路结构

线稿 / 涂鸦（与姿态同构，只换 ② 与 ④）：

```
[参考图] → ① ImageScaleByAspectRatio V2 (1280/16/letterbox/lanczos)
         → ② 预处理器（线稿 AnimeLineArt / 涂鸦 Scribble XDoG）─┬→ ③ PreviewImage
                                                              └→ ④ LLLite(strength 0.8, start 0, end 0.7)
[模型链] ─────────────────────────────────────────────────────→ MODEL → KSampler
```

重绘（多一条 mask 链，且是 img2img 不是空 latent）：

```
[原图] → ① 缩放 ─┬→ VAEEncode ──→ SetLatentNoiseMask ──→ KSampler.latent_image
                 └→ ④ LLLite.image
[掩码] → LoadImageMask → MaskToImage → ③ 缩放(nearest) → ImageToMask ─┬→ SetLatentNoiseMask.mask
                                                                     └→ ④ LLLite.mask（4 通道必需）
[模型链] → ④ LLLite → MODEL → KSampler（denoise 0.6）
```

**为什么 mask 要单独再缩放一次**：① 缩放会改变原图尺寸，而 `SetLatentNoiseMask` 要求掩码与 latent 同尺寸；
两处用**同一套缩放参数**（`original / letterbox / 16 / longest / 1280`）即可对齐，掩码那路把插值改成
**`nearest`**，否则 lanczos 会把二值边缘插成灰边。

---

## 4. 实测（2026-09-14，同图同 seed / 12 步 / cfg 1 / euler+simple）

参考图 `b34feb2243e6a01e3e44d3fa9c72da79.png`（1344×1728，探针实测能检出姿态的那张）。
对比图：`ComfyUI/output/tk_cn_compare_sheet.png`（3×3）与 `tk_cn_full_workflows_sheet.png`（三个工作流的真实产物）。

| 变体 | 结果 |
|---|---|
| 线稿 + any-test-like-v2 @0.8 / end **0.45** | ✅ 跟随、画面干净 |
| 线稿 + any-test-like-v2 @0.8 / end **0.7** | ✅ 跟随更强且**不崩**（采用为默认） |
| 线稿 + **lineart-1** @0.8 / end 0.45 | ❌ **不跟随**（出图是近景特写，与线稿无关），画面本身正常 |
| 涂鸦 + any-test-like-v2 @0.8 / end 0.45 | ✅ 跟随 |
| 涂鸦 + any-test-like-v2 @0.8 / end **0.7** | ✅ 跟随更强、不崩（采用为默认） |
| 涂鸦 + **scribble-1** @0.8 / end 0.45 | ❌ **不跟随**（站立近景，与涂鸦无关） |
| 重绘 @1.0 / end 0.8 / d0.6 | ✅ 掩码区精确补全、无接缝（采用为默认） |
| 重绘 @1.0 / end 1.0 / d0.6 | ✅ 同上，肉眼几乎无差别 |
| 重绘 @0.8 / end 0.8 / d0.6 | ✅ 同上 |

**end_percent 的规律（本轮最有价值的一条）**：它取决于**控制图的稠密程度**，不是"越低越安全"。

- 骨架（极稀疏，只有关节点）→ 必须低（0.45），高了形体来不及收敛 → 崩
- 线稿 / 涂鸦（线条较稠密）→ 可以用到 0.7，跟随更强且不崩
- 重绘（4 通道 + mask img2img）→ 0.8~1.0 都行，差异极小

---

## 5. 五个坑（都是本轮真踩的）

### 坑 1：缩放节点的输出槽顺序不是你以为的那样

`LayerUtility: ImageScaleByAspectRatio V2` 的输出是
**`[image, mask, original_size, width, height]`** —— `width/height` 在 **3 / 4**，不是 1 / 2。

接错的后果：把 `mask`(MASK) 和 `original_size`(BOX) 喂给空 latent 的 INT 输入 → 前端能加载，
但 Queue 时报 `return_type_mismatch`。**改 `set_output` 时别忘了 `links` 数组里硬编码的 `origin_slot`**
（本轮就是改了前者忘了后者）。

### 坑 2：忘了接线的工作流"看起来"是好的

第一版线稿工作流的 `SaveImage.images` 漏接，前端加载一切正常（节点不红、不报错），
**直到 Queue 才报 `required_input_missing`**。
→ 已加 `verify_cn_workflows.py`：拿 `/object_info` 的 required 定义，把"必填输入口没接线 / widget 数量不够 /
槽位类型不一致 / 节点处于 bypass"一次性查出来。**生成工作流后先跑它，再提交。**

### 坑 3：复制节点会把 bypass 状态带过来（pose 模块的老 bug，本轮修掉）

从用户工作流复制节点时，源节点若是 `mode: 4`（bypass），复制过来仍然是静音的。
`build_pose_module.py` 当时漏了这一步 → **姿态模块里的 LLLite 一直是 bypass 的**（接好了也不生效）。
`build_pose_workflow.py` 有 `node["mode"] = 0`，模块脚本没有 —— 本轮已补，模块已重新生成。

### 坑 4：涂鸦预处理器只能选 XDoG（本机离线约束）

`ScribblePreprocessor`（PiDiNet）与 `Scribble_PiDiNet_Preprocessor` 需要 `scribble_mlsd.pth` /
`table5_pidinet.pth`，本机 `ckpts/lllyasviel/Annotators/` 里**没有**，而 `HF_HUB_OFFLINE=1` → 必然失败。
本机可用的是 **`Scribble_XDoG_Preprocessor`（纯 OpenCV，零模型依赖）**。
线稿这边同理：`AnimeLineArtPreprocessor` 用 `netG.pth`、`LineartStandardPreprocessor` 用 `sk_model*.pth`，
两个本机都有 ✅；`Manga2Anime_LineArt_Preprocessor`（erika.pth）与 `AnyLineArtPreprocessor_aux`（多模型）**没有**。

### 坑 5：重绘必须配 mask img2img，否则颜色会漂

官方模型卡明确建议"**mask 付き img2img を併用**（不併用颜色会微妙变化）"。
所以重绘工作流不是"空 latent + LLLite"，而是 `VAEEncode → SetLatentNoiseMask → KSampler(denoise 0.6)`。

---

## 6. 复现命令

```powershell
cd "E:\claude program\ComfyUI-Anima-Batch-LoRA"

# ① 对比测试（走 HTTP API，不经 MCP；工作流 JSON 不进模型上下文）
& "E:\1AI\ComfyUI-aki-v3\python\python.exe" -X utf8 .scratch/build_cn_test.py lineart@0.8@0.7 scribble@0.8@0.7
& "E:\1AI\ComfyUI-aki-v3\python\python.exe" -X utf8 .scratch/build_cn_test.py inpaint@1.0@0.8@0.6

# ② 重新生成工作流（改参数就改脚本顶部的 KINDS）
& "E:\1AI\ComfyUI-aki-v3\python\python.exe" -X utf8 .scratch/build_cn_workflows.py

# ③ 提交前静态校验（必跑）
& "E:\1AI\ComfyUI-aki-v3\python\python.exe" -X utf8 .scratch/verify_cn_workflows.py
```

---

## 7. 依据（不是拍脑袋）

- **kohya 官方 HF 模型卡 `kohya-ss/Anima-LLLite`**：公开权重里只有
  `anima-lllite-inpainting-v2`（4ch: RGB+mask，动态掩码生成图）与
  `anima-lllite-any-test-like-v2`（**Lineart / scribble / grayscale, heavily augmented**）
  是为 **Anima-Base v1.0** 训练的；lineart / depth / pose / scribble 四个是 **Preview3 时代**权重，
  "在 v1.0 上仍可用但质量下降"。
- **本机实测补充**：那句"质量下降"对 lineart-1 / scribble-1 而言实际是**控制力几乎失效**（§4）。
- **`ComfyUI-Anima-LLLite` README**：`mask` 只在 4 通道（inpaint）权重下必需，白=要填的区域；
  3 通道权重接了 mask 只记一条警告；多个 LLLite 可以串联（`preserve_wrapper=True` 时 wrapper 会级联而不是互相覆盖）。

---

## 8. 还没做的

- **姿态 + 线稿同时控制**（级联两个 LLLite）：结构上支持（README 明确说可以串），但没实测过叠加后的
  `strength` 总量（会相加，可能过饱和）。
- **`Claquasse/Anima-Control-Pose`**（社区更强的姿态权重，见姿态文档 §3.2）：本机未装，未对比。
- **`end_percent` 只测了单图单 seed**：上面给的是可复现的起点值，换图仍建议先看 ③ 预览图再调。
