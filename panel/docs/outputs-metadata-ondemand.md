# Outputs 元数据加载：从「全库预载」改为「按需懒加载」（2026-09-10）

> 现象：进入 Outputs 后要等两三分钟页面才顺手。
> 结论：启动路径上存在**两个全库任务**（元数据全量遍历 ×2 次 + 缩略图全库串行生成），
> 且都不受首屏范围限制。现改为三条按需路径 —— 可见区逐屏读、单图操作读单条、
> 全局能力（筛选/关联）由用户触发时才补齐。

## 一、定位：全量加载到底在哪

| # | 位置 | 做了什么 | 为什么慢 |
|---|---|---|---|
| 1 | `sections/Outputs.ts` → `scheduleIdleMetadataPreload()`（进入页面即调用） | 空闲分片遍历**全部**文件，每片 `outputsDb.metadata.bulkGet(200)` | 每条元数据记录都含 `workflowJson`（几十~几百 KB）。近 3900 条 = 数百 MB 的结构化克隆，全部在主线程完成。**分片只是把它摊开，总量没减少** |
| 2 | 同一文件的 `scheduleIdleLoraExtraction()` | **第二次全库遍历**：再次 `bulkGet` 同一批记录并解析工作流 JSON | 又一次数百 MB 读盘 + 每条一次 `JSON.parse` |
| 3 | `preloadMetadataBatch(files, …)`（进入栏目 + 触底加载各一处） | 按**全量** `files` 求差集后批量读 | 与 #1 同量级；进入栏目时还会在循环里 `renderOutputsView()` |
| 4 | `ensureThumbnails(dirHandle)`（进入栏目） | 所有缺缩略图的图片按 **2 张/批串行** 读盘 → 生成 → 写 IndexedDB | 用户库实测缺 3782 张 → 一轮就是几分钟的磁盘 + 主线程占用（`createImageBitmap` 只优化了单张，不改变 1900 次串行） |

关键点：**#1/#2 是「同一条数据读两遍」**，而 #4 是纯磁盘 I/O。三者的共同前提是
「必须先把全库处理完，页面才算可用」——这个前提本身就是错的。

## 二、改成按需：三条路径

| 路径 | 触发时机 | 读什么 | 实现 |
|---|---|---|---|
| 可见区 | 卡片进屏（IntersectionObserver，`rootMargin: 600px`） | 只读**这一张**（同一条记录顺带提取 LoRA） | `requestVisibleMetadata()` → `store.loadMetadata(id, { loras: true })`，并发上限 6，到位后 250ms 合并刷新一次网格/筛选面板 |
| 单图操作 | 用户点击 | 只读**这一张** | 复制正面 Prompt、右键复制元数据、右键复制 Prompt、编辑另存继承 → 统一 `await loadMetadata(id)` |
| 全局能力 | 用户真正用到 | 分片补齐**全库**（带进度 toast） | `services/outputMetadataIndex.ts` 的 `ensureAllMetadata()`，幂等 + 可中断；被「基座模型 / LoRA」筛选与 Local 页「本地 LoRA ↔ 出图」关联调用 |

### 为什么必须有第三条（不能全按需）
`store.applyFilters()` 对 `filterModel / filterLora / filterTag` 会**排除元数据未加载**的条目：

```ts
if (!meta) return !(filterModel || filterLora || filterTag)
```

所以这三项筛选需要**全库视野**。若不做补齐，懒加载会让它们**静默漏结果**——那不是「慢」，
是「结果错」。因此把它做成「用户主动使用该筛选时才补齐」，而不是进入页面就做。
Local 页的关联出图统计同理（`metadataCache.values()` 全表遍历）。

### 顺带的健壮性
- `store.loadMetadata` 增加**并发去重**（同一 id 共享同一个 Promise：连点复制、一屏十几张卡都会撞上）
  与「已提取 LoRA」标记；`putMetadata / putMetadataBatch / removeMetadata` 会清除该标记 →
  重新扫描后仍会重新提取。
- `ensureAllMetadata` 用 `countMetadataMissing()`（O(N) 轻量检查，不读 DB）判断是否需要跑，
  不做「一次跑完永久为真」的标记 → 扫到新文件后自动重新生效。
- `ensureThumbnails` 标注 **🚫 已停用**（保留给显式的「整体重建」），不再有启动调用。

## 三、验证

### 静态核对（`.workbuddy/tmp/verify-ondemand-meta.cjs`，全绿）
- 4 个全库遍历函数已从 `Outputs.ts` 移除；`restoreOutputsFromDb` 函数体内无 `bulkGet`
- 无 `ensureThumbnails(` 调用；`metadata.bulkGet` 只剩按需服务一个入口
- 单图操作 6 处走 `loadMetadata(`；`_metaInflight` 并发去重与 `opts.loras` 顺带提取均在
- 进屏观察器已接入 `requestVisibleMetadata`

> 注意：说明性注释里提到旧函数名会被脚本误判 → 脚本已先剥离注释再核对。

### 运行时可测量的日志（新增，判断快慢请看这两行）
```
[outputs] 首屏就绪 1234ms（files=300，缩略图 240 张，元数据/其余缩略图按需加载）
[outputs] 元数据按需加载：本屏 24 条，310ms（缓存中共 24 条；无全库读取）
```
第一条只统计「首屏装配 + 首屏缩略图」，**不含**任何全库任务；若它远小于几秒，
说明启动路径已经没有全库处理。

## 四、已知取舍
- 卡片上的 Model / LoRA 胶囊、以及「复制正面 Prompt」按钮的出现时机：从「进页面即有」
  变为「该卡进屏后 ~百毫秒内出现」（按钮依赖元数据里的 prompt 存在性）。缓存进内存后回滚不再延迟。
- 筛选面板的 Model / LoRA 候选列表同样随浏览逐步补全；输入框本身仍可手输任意值即时筛选。
- 未授权目录（无句柄）时行为不变：只读 IndexedDB 里已有的缩略图/元数据。

---

## 附：2026-09-10 18:0x 「还是卡几分钟、页面毫无变化」事故（第二轮，已定位并修复）

### 浏览器侧取证（未依赖用户排查）
1. **HTTP 缓存取证**：`Cache/Cache_Data` 里出现了当前 bundle（`index-C8KChVzV.js`）且含新日志串
   `首屏就绪` / `元数据按需加载`，同时**全库旧函数名 `scheduleIdleMetadataPreload` 已不在任何缓存文件中**
   → 浏览器确实在跑新版（不是缓存旧 bundle）。
2. **IndexedDB 取证**：`http_127.0.0.1_8188.indexeddb.leveldb` 的 `LOG` 达 **195MB**、
   `MANIFEST` 89MB、最近写入时间 18:05，而 25 秒后复测只增 116KB → **一次性的全库写入洪峰，已结束**。
   195MB ≈ 3900 张 × 50KB（缩略图级写入量）。
3. **代码取证**：`initOutputs()` 在**第一次 renderOutputsView() 之前** `await ensureMetadataFresh(dh)`；
   解析器版本不匹配时它会 `metadata.clear()` + `thumbnails.clear()` + `reparseAllMetadata()`：
   逐个 `getFile()` + `readFileAsArrayBuffer()` **整读近 4000 个原图**（每个 2~5MB → 8~20GB IO）再解析，
   期间 `scanStatus='scanning'` → **首屏被推迟到全程结束** = 「卡几分钟且页面没有任何变化」。

### 修复
1. **首屏红线**：`ensureMetadataFresh` 与 `buildDirTree` 一律不再 `await` 在首次渲染之前；
   先用现有缓存渲染，后台完成后刷新一次（扫描进度条显示 done/total）。
2. **重解析成本降一个数量级**：新增 `readAndParseMetadata()` —— 元数据（PNG tEXt/iTXt、JPEG APPn）
   都在**文件头部**，先只读前 1MB 解析，解析不出内容才退回整读；全量扫描路径同样改用它。
3. **重解析让出主线程**：每 20 张 `setTimeout(0)` 一次，每 200 张打印进度，界面不再"假死"。
4. **「有新版本」自检**：焦点/可见时对比 `index.html` 引用的 bundle 与运行中的 bundle，
   不一致就提示 `Ctrl+Shift+R` —— 彻底消除「右上角显示最新、实际跑旧版」这一类误判
   （右上角构建时间来自 bundle 内的 `__BUILD_TIME__`，本身是可信的，但需要刷新才会变）。

### 教训
- **解析器版本号（`PARSER_VERSION`）递增的代价 = 每个用户下一次打开面板要做一次全库重解析**。
  升级前必须先确认这条路径不挡首屏、且不是整文件读取 —— 否则发布即等于让所有用户卡几分钟。
- 「分片 / 空闲调度」不等于不阻塞：只要它被 `await` 在首次渲染之前，或它本身是 IO 密集型长任务，
  用户感知就是卡死。**判断标准永远是：首次渲染之前有没有 await 任何与库规模相关的工作。**
