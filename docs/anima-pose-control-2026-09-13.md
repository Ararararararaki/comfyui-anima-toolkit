# Anima 姿态控制（CN Pose）模块 — 实测结论与用法

> 日期：2026-09-13 · 适用：Anima-Base v1.0 + `kohya-ss/ComfyUI-Anima-LLLite`
> 交付物：`ComfyUI/user/default/workflows/TK Anima 姿态控制模块.json`（5 节点，已验证可加载）

## 1. 一句话结论

**用 `anima-lllite-any-test-like-v2` + `strength 0.8` + `end_percent 0.45`**，配 **DWPose 骨架**，就能既跟随姿态又不崩画面。
关键不在 strength，而在 **`end_percent`**。

## 2. 实测数据（同一张参考图、同一 seed、12 步 / cfg 1 / euler+simple）

| 权重 | strength | end_percent | 结果 |
|---|:-:|:-:|---|
| —（无控制） | — | — | 正常人物，姿态自由 |
| any-test-like-v2 | 0.8 | 0.8 | ❌ **崩坏**（形体融成布状物） |
| any-test-like-v2 | 1.0 | 0.8 | ❌ 崩坏 |
| any-test-like-v2 | 1.2 | 0.8 | ❌ 完全糊掉 |
| any-test-like-v2 | 1.0 | 0.45 | ❌ 仍崩坏 |
| **any-test-like-v2** | **0.8** | **0.45** | ✅ **姿态跟随 + 画面正常** |

**为什么**：姿态骨架是**稀疏线条**，信息量远小于深度图。`end_percent 0.8` 意味着采样前 80% 的步都被强加约束，形体来不及自由收敛 → 糊。
`0.45` 只在早期构图阶段控制，后期放开展开细节。**深度模块的 0.8 不能照搬到姿态。**

## 3. 权重选择依据（社区共识，不是我的推测）

- **B站《专为二次元打造的姿态控制方案》(BV1HSNJ6uEnh, 2026-07-10)**：动作控制模型放
  `models/controlnet/anima-lllite-any-test-like-v2.safetensors`，并写"LLLite 权重建议 0.8–1.2 之间，过高会导致画面崩坏"。
- **kohya 官方 `PREVIEW3.md`**：`anima-lllite-pose-1` 是 **Preview3 时代权重**，官方明确说它
  "**明显弱于另外三个**，应作为 **soft pose prior（软姿态先验）** 而非严格姿态锁定"；
  且 lineart / depth / pose / scribble **这 4 个没有为 Base v1.0 重训**，只有 Preview3 版。
- 官方给出的 pose 训练条件：**DWPose 标准输出 = 彩色身体骨架 + 白色面部关键点 + 手部关键点**（1,544 对，仅取 DWPose 成功提取的图）。

→ 所以：**权重用 any-test-like-v2（新底座重训过），检测器用 DWPose 且 hand/face/body 全开**。

## 4. 模块结构

```
[图片输入] ──→ ① ImageScaleByAspectRatio V2 ──→ ② DWPreprocessor ──┬─→ ③ PreviewImage（看骨架）
              1280 / 16 / letterbox / lanczos                      └─→ ④ AnimaLLLiteApply_sdscripts
                                                                        ↓
[模型链] ────────────────────────────────────────────────────────────→ MODEL 输出 → 采样器
```

- 入口（留空待接）：**① 的 `image`**、**④ 的 `model`**
- 出口：**④ 的 `MODEL`** → 接 KSampler
- 用法：整组复制到任意工作流的画布 → 接上两个入口即可（图片沿用工作流自己的输入节点，模块不自带 LoadImage）

## 5. 参数表

| 节点 | 参数 | 值 | 说明 |
|---|---|---|---|
| ① 缩放 | aspect_ratio / fit / method | original / letterbox / lanczos | 比例不变，长边对齐 |
| | round_to_multiple / scale_to_side / scale_to_length | 16 / longest / **1280** | 与 latent 尺寸一致 |
| ② DWPose | detect_hand / body / face | enable ×3 | 官方训练条件要求手+脸关键点 |
| | resolution | 768 | |
| | bbox_detector / pose_estimator | **yolox_l.onnx / dw-ll_ucoco_384.onnx** | ⚠️ 必须选这两个（见坑 2） |
| ④ LLLite | lllite_name | anima-lllite-any-test-like-v2.safetensors | |
| | strength / start / end | **0.8 / 0.0 / 0.45** | end 是关键 |
| | preserve_wrapper | True | |

## 6. 三个坑（都踩过）

### 坑 1：参考图检不出姿态 → 骨架全黑 → 生成图崩溃
DWPose/OpenPose 对**动漫特写、半身托腮**这类构图经常检不出人。实测三张候选图：

| 图 | DWPose | OpenPose |
|---|---|---|
| `ca77639a…png`（动漫半身） | 0.0 全黑 | 0.0 全黑 |
| `提丰参考图.png` | 0.0 全黑 | 0.0 全黑 |
| `b34feb22…png` | **0.028 有骨架** | 0.0213 有骨架 |

**模块里放了 `PreviewImage` 就是为了先看骨架**：全黑就换参考图，别急着怪模型。
（探针脚本：`.scratch/probe_pose_detectors.py` —— 多图 × 多检测器批量跑，用非黑像素比例判定，不必逐张肉眼检查。）

### 坑 2：`AIO_Preprocessor` 默认参数要联网下载 → 必然失败
`AIO_Preprocessor(preprocessor="DWPreprocessor")` 不暴露子参数，用的是默认的
**`dw-ll_ucoco_384_bs5.torchscript.pt`**；而本机 `HF_HUB_OFFLINE=1`（已配 hf-mirror 镜像但禁网），缓存里只有
**`.onnx`** 版 → 报 `OfflineModeIsEnabled`。
**解法**：改用独立的 **`DWPreprocessor` 节点**，显式选 `yolox_l.onnx` + `dw-ll_ucoco_384.onnx`
（本机 `custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose/` 下已有，共 335 MB，不用下载）。

### 坑 3：别自己穷举权重
我最初想当然地拿 `pose-1` vs `any-test-like-v2` 试参数，而社区 B站教程与 kohya 官方文档早已给出结论
（用 any-test-like-v2 做动作控制；pose-1 偏弱且是旧底座权重）。
**先搜已有方案，再动手** —— 这一点已写进全局 `~/.dsh/AGENTS.md`。

## 7. 其他 CN 类型的做法（**2026-09-14 已全部完成**）

线稿 / 涂鸦 / 重绘三类已生成工作流并实测跑通，参数与坑见
**`docs/anima-cn-lineart-scribble-inpaint-2026-09-14.md`**。一句话版：

| 类型 | 预处理器 | 权重 | strength | end_percent |
|---|---|---|---|---|
| 姿态 | `DWPreprocessor`（hand/body/face 全开） | any-test-like-v2 ✅ | 0.8 | 0.45 |
| 深度 | `DepthAnythingV2Preprocessor`（本机有 V2-Large） | any-test-like-v2（你现用）或 `depth-1` | — | — |
| 线稿 | `AnimeLineArtPreprocessor` | any-test-like-v2 ✅ | 0.8 | **0.7** |
| 涂鸦 | `Scribble_XDoG_Preprocessor` | any-test-like-v2 ✅ | 0.8 | **0.7** |
| 重绘 | —（用 mask + mask img2img） | `inpainting-v2`（4ch）✅ | 1.0 | 0.8 |

⚠️ 两条实测结论（详见新文档）：`lineart-1` / `scribble-1` 是 Preview3 老权重，**在 Base v1.0 上几乎不跟随**；
`end_percent` 由**控制图稠密度**决定（骨架 0.45 / 线稿涂鸦 0.7 / 重绘 0.8–1.0 差异极小），不是越低越安全。

## 8. 复现命令

```powershell
cd "E:\claude program\ComfyUI-Anima-Batch-LoRA"
& "E:\1AI\ComfyUI-aki-v3\python\python.exe" -X utf8 .scratch/build_pose_test.py baseline anytest@0.8@0.8 anytest@0.8@0.45
# 语法：<变体>[@strength][@end_percent]
& "E:\1AI\ComfyUI-aki-v3\python\python.exe" -X utf8 .scratch/build_pose_module.py   # 重新生成模块
```

> 走 ComfyUI HTTP API（POST /prompt + 轮询 /history），不经 MCP —— 工作流 JSON 不该塞进模型上下文。
