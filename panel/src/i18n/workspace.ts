// Presentation messages only. Model names, prompts and user categories stay unchanged.
export const workspaceMessages = {
  "workspace.panelBuiltAtReopenThePanelAfter": {
    "zh": "面板构建时间：{p0}（发布新版后重开面板窗口即更新）",
    "en": "Panel built at {p0}. Reopen the panel after an update."
  },
  "workspace.built": {
    "zh": "构建 {p0}",
    "en": "Built {p0}"
  },
  "workspace.aPanelUpdateIsAvailablePressCtrl": {
    "zh": "🔄 面板有新版本，按 Ctrl+Shift+R 刷新即可生效",
    "en": "A panel update is available. Press Ctrl+Shift+R to refresh."
  },
  "workspace.clearSearch": {
    "zh": "清空搜索",
    "en": "Clear search"
  },
  "workspace.copied": {
    "zh": "✅ 已复制!",
    "en": "Copied!"
  },
  "workspace.10k": {
    "zh": "万",
    "en": "×10k"
  },
  "workspace.deletedCategory": {
    "zh": "已删除分类「{p0}」",
    "en": "Deleted category “{p0}”"
  },
  "workspace.deleteCategoryFilesWillBecomeUncategorized": {
    "zh": "删除分类「{p0}」？{p1} 个文件将变为未分类",
    "en": "Delete category “{p0}”? {p1} files will become uncategorized."
  },
  "workspace.deleteCategory": {
    "zh": "删除分类",
    "en": "Delete category"
  },
  "workspace.delete": {
    "zh": "删除",
    "en": "Delete"
  },
  "workspace.renamedTo": {
    "zh": "已重命名「{p0}」→「{p1}」",
    "en": "Renamed “{p0}” to “{p1}”"
  },
  "workspace.enterANewCategoryName": {
    "zh": "输入新分类名",
    "en": "Enter a new category name"
  },
  "workspace.renameCategory": {
    "zh": "重命名分类",
    "en": "Rename category"
  },
  "workspace.rename": {
    "zh": "重命名",
    "en": "Rename"
  },
  "workspace.noCategoriesYetCreateOneUsingThe": {
    "zh": "暂无分类，点击卡片右上角的分类按钮即可创建",
    "en": "No categories yet. Create one using the category button on a card."
  },
  "workspace.manageCategories": {
    "zh": "分类管理（{p0} 个分类）",
    "en": "Manage categories ({p0})"
  },
  "workspace.create": {
    "zh": "新建",
    "en": "Create"
  },
  "workspace.newCategory": {
    "zh": "新建分类…",
    "en": "New category…"
  },
  "workspace.assignedFilesTo": {
    "zh": "{p0} 个文件已设分类「{p1}」",
    "en": "Assigned {p0} files to “{p1}”"
  },
  "workspace.assignedFilesToFailed": {
    "zh": "{p0} 个文件已设分类「{p1}」（{p2} 个失败）",
    "en": "Assigned {p0} files to “{p1}” ({p2} failed)"
  },
  "workspace.categoryCleared": {
    "zh": "已清除分类",
    "en": "Category cleared"
  },
  "workspace.assignedTo": {
    "zh": "已设置分类「{p0}」",
    "en": "Assigned to “{p0}”"
  },
  "workspace.setCategoryFiles": {
    "zh": "设置分类（{p0} 个文件）",
    "en": "Set category ({p0} files)"
  },
  "workspace.couldNotRateTheSelectedFiles": {
    "zh": "批量评分失败",
    "en": "Could not rate the selected files"
  },
  "workspace.ratedSelectedFilesStars": {
    "zh": "已批量评分 {p0} 星",
    "en": "Rated selected files {p0} stars"
  },
  "workspace.couldNotSaveRating": {
    "zh": "评分失败",
    "en": "Could not save rating"
  },
  "workspace.ratedStars": {
    "zh": "已评分 {p0} 星",
    "en": "Rated {p0} stars"
  },
  "workspace.couldNotLoadTheImageTheCurrent": {
    "zh": "图片加载失败，保留当前预览，请重试",
    "en": "Could not load the image. The current preview is kept. Please retry."
  },
  "workspace.theImageChangedOrCouldNotBe": {
    "zh": "图片已变化或读取失败，保留当前预览，请重试",
    "en": "The image changed or could not be read. The current preview is kept. Please retry."
  },
  "workspace.couldNotReadTheImageTheCurrent": {
    "zh": "图片读取失败，保留当前预览，请重试",
    "en": "Could not read the image. The current preview is kept. Please retry."
  },
  "workspace.grantAccessToThisFolderAgainIn": {
    "zh": "请在目录栏重新授权该目录",
    "en": "Grant access to this folder again in the folder sidebar."
  },
  "workspace.couldNotReadTheImage": {
    "zh": "⚠️ 读取图片失败",
    "en": "Could not read the image"
  },
  "workspace.couldNotReadTheImage2": {
    "zh": "读取图片失败",
    "en": "Could not read the image"
  },
  "workspace.saveFailed": {
    "zh": "保存失败：{p0}",
    "en": "Save failed: {p0}"
  },
  "workspace.savedACopyAs": {
    "zh": "已另存 {p0}",
    "en": "Saved a copy as {p0}"
  },
  "workspace.overwroteOriginalBackup": {
    "zh": "已覆盖 {p0}，原图备份：{p1}",
    "en": "Overwrote {p0}. Original backup: {p1}"
  },
  "workspace.couldNotReadTheOriginalMetadataNothing": {
    "zh": "无法读取原图元数据，未保存",
    "en": "Could not read the original metadata. Nothing was saved."
  },
  "workspace.theBrowserCannotExportTheOriginalImage": {
    "zh": "浏览器无法按原图片格式导出",
    "en": "The browser cannot export the original image format."
  },
  "workspace.savingRequiresWriteAccessToThisFolder": {
    "zh": "保存需要目录写入权限",
    "en": "Saving requires write access to this folder."
  },
  "workspace.overwriteTheOriginalWillBeVerifiedAnd": {
    "zh": "将覆盖 {p0}。\n会先核验并保留原图备份；也可取消后选择“另存副本”。",
    "en": "Overwrite {p0}?\nThe original will be verified and backed up first. Cancel to use Save a copy instead."
  },
  "workspace.overwriteOriginal": {
    "zh": "覆盖原图",
    "en": "Overwrite original"
  },
  "workspace.editingSupportsStaticPngJpegAndWebp": {
    "zh": "保存编辑仅支持 PNG、JPEG、WebP 静态图片",
    "en": "Editing supports static PNG, JPEG and WebP images only."
  },
  "workspace.theImageSourceChangedReopenTheImage": {
    "zh": "图片来源已变化，请重新打开后保存",
    "en": "The image source changed. Reopen the image before saving."
  },
  "workspace.scrollToZoomThenDragToPan": {
    "zh": "滚轮缩放，放大后拖动查看",
    "en": "Scroll to zoom, then drag to pan."
  },
  "workspace.dragARectangleToCoverItWith": {
    "zh": "拖出矩形，用当前颜色遮盖",
    "en": "Drag a rectangle to cover it with the current color."
  },
  "workspace.drawDirectlyOnTheImageIncludingWhile": {
    "zh": "在图片上直接涂画；放大后也可绘制",
    "en": "Draw directly on the image, including while zoomed in."
  },
  "workspace.dragARectangleAdjustSizeAndStrength": {
    "zh": "拖出矩形；调整颗粒与强度可预览最后一块效果",
    "en": "Drag a rectangle. Adjust size and strength to preview the last mosaic."
  },
  "workspace.retryPreparingDrag": {
    "zh": "重试准备拖出",
    "en": "Retry preparing drag"
  },
  "workspace.dragCurrentImage": {
    "zh": "拖出当前图",
    "en": "Drag current image"
  },
  "workspace.preparingDrag": {
    "zh": "准备拖出…",
    "en": "Preparing drag…"
  },
  "workspace.exportFailed": {
    "zh": "导出失败：{p0}",
    "en": "Export failed: {p0}"
  },
  "workspace.downloadStarted": {
    "zh": "已提交下载",
    "en": "Download started"
  },
  "workspace.copied2": {
    "zh": "已复制",
    "en": "Copied"
  },
  "workspace.failed": {
    "zh": "，{p0} 张失败",
    "en": ", {p0} failed"
  },
  "workspace.notices": {
    "zh": "，{p0} 项提示",
    "en": ", {p0} notices"
  },
  "workspace.images": {
    "zh": "{p0} {p1}/{p2} 张{p3}{p4}",
    "en": "{p0} {p1}/{p2} images{p3}{p4}"
  },
  "workspace.canceledDeliveredImages": {
    "zh": "已取消，已交付 {p0} 张",
    "en": "Canceled. Delivered {p0} images."
  },
  "workspace.part": {
    "zh": " · 第{p0}包",
    "en": " · Part {p0}"
  },
  "workspace.failed2": {
    "zh": " · {p0}张失败",
    "en": " · {p0} failed"
  },
  "workspace.canceled": {
    "zh": "已取消",
    "en": "Canceled"
  },
  "workspace.done": {
    "zh": "完成",
    "en": "Done"
  },
  "workspace.startDownload": {
    "zh": "交付下载",
    "en": "Start download"
  },
  "workspace.copy": {
    "zh": "复制",
    "en": "Copy"
  },
  "workspace.package": {
    "zh": "打包",
    "en": "Package"
  },
  "workspace.processMetadata": {
    "zh": "处理生成信息",
    "en": "Process metadata"
  },
  "workspace.read": {
    "zh": "读取",
    "en": "Read"
  },
  "workspace.exportCanceled": {
    "zh": "导出已取消",
    "en": "Export canceled"
  },
  "workspace.theImageMovedFolderAccessIsMissing": {
    "zh": "图片已移动、目录未授权或文件读取失败",
    "en": "The image moved, folder access is missing, or the file could not be read."
  },
  "workspace.noImagesAvailableToExport": {
    "zh": "找不到可导出的图片",
    "en": "No images available to export"
  },
  "workspace.anExportIsRunningWaitForIt": {
    "zh": "已有导出任务，完成或取消后再试",
    "en": "An export is running. Wait for it to finish or cancel it first."
  },
  "workspace.couldNotSavePleaseRetry": {
    "zh": "保存失败，请重试",
    "en": "Could not save. Please retry."
  },
  "workspace.promptAndImageSavedToThePrompt": {
    "zh": "✅ Prompt 与图片已保存到 Prompt 库",
    "en": "Prompt and image saved to the Prompt Library"
  },
  "workspace.parameters": {
    "zh": "参数: {p0}",
    "en": "Parameters: {p0}"
  },
  "workspace.negativePrompt": {
    "zh": "负 Prompt: {p0}",
    "en": "Negative prompt: {p0}"
  },
  "workspace.sampler": {
    "zh": "采样器: {p0}",
    "en": "Sampler: {p0}"
  },
  "workspace.model": {
    "zh": "模型: {p0}",
    "en": "Model: {p0}"
  },
  "workspace.couldNotSaveTheOriginalImageWas": {
    "zh": "保存失败：找不到原图片",
    "en": "Could not save: the original image was not found."
  },
  "workspace.thisImageHasNoPromptToSave": {
    "zh": "该图片无 Prompt，无法保存",
    "en": "This image has no prompt to save."
  },
  "workspace.key": {
    "zh": "键名",
    "en": "Key"
  },
  "workspace.value": {
    "zh": "值",
    "en": "Value"
  },
  "workspace.removeRow": {
    "zh": "删除该行",
    "en": "Remove row"
  },
  "workspace.close": {
    "zh": "关闭",
    "en": "Close"
  },
  "workspace.exportMetadata": {
    "zh": "导出元数据",
    "en": "Export metadata"
  },
  "workspace.whenEnabled": {
    "zh": "开启后，",
    "en": "When enabled, "
  },
  "workspace.downloadsZipArchivesClipboardCopiesPreviewsEditor": {
    "zh": "下载 / 打包下载 / 复制到剪贴板 / 大图预览 / 编辑器副本",
    "en": "downloads / ZIP archives / clipboard copies / previews / editor copies"
  },
  "workspace.removePromptsWorkflowsAndPromptProvenanceFrom": {
    "zh": "会清理 PNG 中的\n        提示词、工作流和本插件的提示词来源记录，并写入下面的署名。像素、色彩信息及无关元数据保留。",
    "en": " remove prompts, workflows and prompt provenance from PNG files, then add the credits below. Pixels, color profiles and unrelated metadata are retained."
  },
  "workspace.originalFilesOnDiskArePreserved": {
    "zh": "磁盘上的原图不会被改动",
    "en": "Original files on disk are preserved"
  },
  "workspace.withoutTheWorkflowMetadataDraggingTheImage": {
    "zh": "；去掉 workflow 后图片拖回 ComfyUI 无法恢复工作流。",
    "en": ". Without the workflow metadata, dragging the image into ComfyUI cannot restore its workflow."
  },
  "workspace.enableOffByDefault": {
    "zh": "启用（默认关闭）",
    "en": "Enable (off by default)"
  },
  "workspace.creditsAndCustomMetadata": {
    "zh": "署名与自定义元数据（",
    "en": "Credits and custom metadata ("
  },
  "workspace.leaveBlankToSkip": {
    "zh": "留空 = 不写入该项",
    "en": "leave blank to skip"
  },
  "workspace.existingFieldsWithTheSameNamesAre": {
    "zh": "；也不会去清除图里已有的同名块）",
    "en": "; existing fields with the same names are retained)"
  },
  "workspace.addCustomField": {
    "zh": "添加自定义键",
    "en": "Add custom field"
  },
  "workspace.restoreFourDefaultFields": {
    "zh": "恢复默认四键",
    "en": "Restore four default fields"
  },
  "workspace.disabledExportsUseTheOriginalBytes": {
    "zh": "已关闭：导出恢复为原图字节",
    "en": "Disabled: exports use the original bytes."
  },
  "workspace.enabledExportCopiesRemovePromptsWorkflowsAnd": {
    "zh": "已开启：导出副本将去除提示词、工作流与提示词来源记录（磁盘原图保留）",
    "en": "Enabled: export copies remove prompts, workflows and prompt provenance. Originals on disk are preserved."
  },
  "workspace.reuseIsDisabled": {
    "zh": "当前未启用复用",
    "en": "reuse is disabled"
  },
  "workspace.reuseSimilarMatchesAndLocalModelResults": {
    "zh": "优先复用相似匹配与本机模型结果，未命中时再用所选 WD14；内存不足时仍可读取已有结果",
    "en": "reuse similar matches and local model results first, then use the selected WD14 model for misses; cached results remain available under memory pressure"
  },
  "workspace.localRecognitionCacheEntriesInferredTagsAre": {
    "zh": " 本机有 {p0} 项识别缓存，{p1}。识别标签不属于原始提示词。",
    "en": " {p0} local recognition cache entries; {p1}. Inferred tags are separate from the original prompt."
  },
  "workspace.noCompleteLocalWd14OnnxCsvModel": {
    "zh": "没有完整的本地 WD14 ONNX+CSV 模型；在 WD14 Tagger 安装后刷新列表。",
    "en": "No complete local WD14 ONNX + CSV model found. Install a WD14 Tagger model and refresh the list."
  },
  "workspace.taggingPaused": {
    "zh": "反推已暂停",
    "en": "tagging paused"
  },
  "workspace.taggingEnabled": {
    "zh": "反推已启用",
    "en": "tagging enabled"
  },
  "workspace.automaticTaggingOnlyProcessesImagesConfirmedTo": {
    "zh": "自动反推仅处理确认无元数据的图片。",
    "en": "Automatic tagging only processes images confirmed to have no metadata."
  },
  "workspace.alsoIncludesImagesWithPromptsButNo": {
    "zh": "包括已有提示词但未识别角色的图片。",
    "en": "Also includes images with prompts but no recognized character."
  },
  "workspace.currentCpuAfterChangingTheModelOr": {
    "zh": "当前：{p0} · CPU。{p1}。{p2}切换模型或阈值后可点击“用所选模型重试未识别”。角色置信度不足时仍保留未识别，不强行归类。",
    "en": "Current: {p0} · CPU · {p1}. {p2} After changing the model or threshold, use Retry unrecognized with selected model. Low confidence characters remain unrecognized."
  },
  "workspace.notInstalled": {
    "zh": "（未安装）",
    "en": " (not installed)"
  },
  "workspace.chooseAnInstalledModel": {
    "zh": "选择已安装模型",
    "en": "choose an installed model"
  },
  "workspace.auto": {
    "zh": "自动{p0}",
    "en": "Auto {p0}"
  },
  "workspace.removeExportMetadataCurrentlyOff": {
    "zh": "导出时去除元数据（当前：关闭）",
    "en": "Remove export metadata (currently off)"
  },
  "workspace.noCreditsRemoveOnly": {
    "zh": "（未填署名 = 只去不写）",
    "en": " (no credits: remove only)"
  },
  "workspace.addCreditFields": {
    "zh": "（另写入 {p0} 项署名）",
    "en": " (add {p0} credit fields)"
  },
  "workspace.removeExportMetadataOn": {
    "zh": "导出时去除元数据：已开启{p0}",
    "en": "Remove export metadata: on{p0}"
  },
  "workspace.keepGenerationMetadataOriginal": {
    "zh": "保留生成信息（原图）",
    "en": "Keep generation metadata (original)"
  },
  "workspace.removeGenerationMetadataOn": {
    "zh": "去除生成信息 · 已开启",
    "en": "Remove generation metadata · On"
  },
  "workspace.folderAccessIsUnavailableUseChromeOr": {
    "zh": "⚠️ 当前浏览器/访问方式不支持目录选择：请用 Chrome/Edge 并通过 localhost 或 HTTPS 访问（局域网 IP 访问不支持目录权限）",
    "en": "Folder access is unavailable. Use Chrome or Edge over localhost or HTTPS. LAN IP addresses do not support folder permissions."
  },
  "workspace.folderAccessRequiresChromeOrEdgeOver": {
    "zh": "⚠️ 当前浏览器/访问方式不支持目录选择（需 Chrome/Edge + localhost/HTTPS）；已缓存 {p0} 张图片仍可浏览，但无法增量刷新",
    "en": "Folder access requires Chrome or Edge over localhost or HTTPS. You can browse {p0} cached images, but cannot refresh the folder."
  },
  "workspace.scanning": {
    "zh": "扫描中... {p0}/{p1}",
    "en": "Scanning… {p0}/{p1}"
  },
  "workspace.imagesSelected": {
    "zh": "已选 {p0} 张",
    "en": "{p0} images selected"
  },
  "workspace.deleteSelectedFilesThisCannotBeUndone": {
    "zh": "确认删除选中的 {p0} 个文件？\n此操作不可撤销！",
    "en": "Delete {p0} selected files?\nThis cannot be undone."
  },
  "workspace.deleteSelected": {
    "zh": "批量删除",
    "en": "Delete selected"
  },
  "workspace.enterTheNewFilenameIncludingItsExtension": {
    "zh": "输入新的文件名（包含扩展名）",
    "en": "Enter the new filename, including its extension"
  },
  "workspace.renameFile": {
    "zh": "重命名文件",
    "en": "Rename file"
  },
  "workspace.thisImageHasNoRecordedLoras": {
    "zh": "该图片没有已记录的 LoRA",
    "en": "This image has no recorded LoRAs."
  },
  "workspace.clipboardAccessDenied": {
    "zh": "剪贴板访问被拒绝",
    "en": "Clipboard access denied"
  },
  "workspace.copiedLoraTags": {
    "zh": "已复制 {p0} 个 LoRA 标签",
    "en": "Copied {p0} LoRA tags"
  },
  "workspace.metadataCopied": {
    "zh": "元数据已复制",
    "en": "Metadata copied"
  },
  "workspace.deleteThisFileThisCannotBeUndone": {
    "zh": "确认删除这个文件？\n此操作不可撤销！",
    "en": "Delete this file?\nThis cannot be undone."
  },
  "workspace.deleteFile": {
    "zh": "删除文件",
    "en": "Delete file"
  },
  "workspace.keyboardShortcuts": {
    "zh": "⌨️ 快捷键",
    "en": "Keyboard shortcuts"
  },
  "workspace.selectAllImages": {
    "zh": "全选所有图片",
    "en": "Select all images"
  },
  "workspace.copySelectedImages": {
    "zh": "复制选中图片",
    "en": "Copy selected images"
  },
  "workspace.downloadSelectedImages": {
    "zh": "下载选中图片",
    "en": "Download selected images"
  },
  "workspace.shiftClick": {
    "zh": "Shift+点击",
    "en": "Shift + click"
  },
  "workspace.selectARange": {
    "zh": "连续范围选中",
    "en": "Select a range"
  },
  "workspace.deleteSelectedImages": {
    "zh": "删除选中图片",
    "en": "Delete selected images"
  },
  "workspace.toggleFocusMode": {
    "zh": "切换专注模式",
    "en": "Toggle focus mode"
  },
  "workspace.setOrClearAStatusPressAgain": {
    "zh": "设置/取消状态标签（重复按取消）",
    "en": "Set or clear a status (press again to clear)"
  },
  "workspace.drag": {
    "zh": "拖拽",
    "en": "Drag"
  },
  "workspace.selectImagesByRectangleImageGridOnly": {
    "zh": "框选图片（仅网格区域）",
    "en": "Select images by rectangle (image grid only)"
  },
  "workspace.clearSelection": {
    "zh": "取消所有选中",
    "en": "Clear selection"
  },
  "workspace.rectangleSelectionOnlyAffectsTheImageGrid": {
    "zh": "💡 拖拽框选只作用于图片网格区域，不影响目录树和工具栏",
    "en": "Rectangle selection only affects the image grid, leaving the folder tree and toolbar available."
  },
  "workspace.thisImageHasNoLoraData": {
    "zh": "该图片无 LoRA 数据",
    "en": "This image has no LoRA data."
  },
  "workspace.noLoraNodesDetected": {
    "zh": "未检测到 LoRA 节点",
    "en": "No LoRA nodes detected"
  },
  "workspace.copyFailedClipboardAccessDenied": {
    "zh": "⚠️ 复制失败：浏览器拒绝了剪贴板访问",
    "en": "Copy failed: clipboard access denied"
  },
  "workspace.couldNotReparse": {
    "zh": "重新解析失败：{p0}",
    "en": "Could not reparse: {p0}"
  },
  "workspace.folderMetadataUpdated": {
    "zh": "所选目录元数据已更新",
    "en": "Folder metadata updated"
  },
  "workspace.theBackendParsesOutputMetadataAutomaticallyAdd": {
    "zh": "output 元数据由后端自动解析；归档目录可添加后重新解析",
    "en": "The backend parses output metadata automatically. Add an archive folder to reparse it."
  },
  "workspace.refreshFailed": {
    "zh": "刷新失败：{p0}",
    "en": "Refresh failed: {p0}"
  },
  "workspace.folderCheckStartedNewImagesWillAppear": {
    "zh": "已开始核对目录，新图将自动补入",
    "en": "Folder check started. New images will appear automatically."
  },
  "workspace.folderRefreshed": {
    "zh": "所选目录已刷新",
    "en": "Folder refreshed"
  },
  "workspace.checkingTheOutputFolder": {
    "zh": "正在核对 output 目录…",
    "en": "Checking the output folder…"
  },
  "workspace.folderChecked": {
    "zh": "目录已核对",
    "en": "Folder checked"
  },
  "workspace.scanCanceled": {
    "zh": "扫描已取消",
    "en": "Scan canceled"
  },
  "workspace.couldNotRead": {
    "zh": "无法读取",
    "en": "Could not read"
  },
  "workspace.couldNotAddFolder": {
    "zh": "添加目录失败：{p0}",
    "en": "Could not add folder: {p0}"
  },
  "workspace.couldNotStartWd14": {
    "zh": "无法启动 WD14：{p0}",
    "en": "Could not start WD14: {p0}"
  },
  "workspace.queuedForWd14WithWaitingWhileGeneration": {
    "zh": "已加入 WD14 识别队列：{p0}；正在生图或内存不足时等待",
    "en": "Queued for WD14 with {p0}. Waiting while generation is active or memory is low."
  },
  "workspace.selectAnInstalledWd14ModelFirst": {
    "zh": "请先选择已安装的 WD14 模型",
    "en": "Select an installed WD14 model first."
  },
  "workspace.wd14TaggingPausedCompletedResultsAreKept": {
    "zh": "WD14 反推已暂停，已完成的识别结果保留",
    "en": "WD14 tagging paused. Completed results are kept."
  },
  "workspace.couldNotReadModelList": {
    "zh": "模型列表读取失败：{p0}",
    "en": "Could not read model list: {p0}"
  },
  "workspace.foundLocalWd14Models": {
    "zh": "找到 {p0} 个本地 WD14 模型",
    "en": "Found {p0} local WD14 models"
  },
  "workspace.organizingEnabledFoldersByPromptOpenAny": {
    "zh": "已开始按提示词重新整理全部启用目录；未授权目录请进入文件夹授权",
    "en": "Organizing enabled folders by prompt. Open any unauthorized folders to grant access."
  },
  "workspace.defaultComfyuiOutputFolderRestored": {
    "zh": "已恢复默认 ComfyUI output 目录",
    "en": "Default ComfyUI output folder restored"
  },
  "workspace.folderRemovedImagesFavoritesAndRatingsAre": {
    "zh": "已移除目录，磁盘图片与收藏评分保留",
    "en": "Folder removed. Images, favorites and ratings are kept."
  },
  "workspace.removeFolderFromLibrary": {
    "zh": "从图片库移除目录",
    "en": "Remove folder from library"
  },
  "workspace.includeInAllImages": {
    "zh": "加入全部图片汇总",
    "en": "Include in all images"
  },
  "workspace.excludeFromAllImages": {
    "zh": "从全部图片汇总中取消",
    "en": "Exclude from all images"
  },
  "workspace.couldNotOpenFolder": {
    "zh": "打开目录失败：{p0}",
    "en": "Could not open folder: {p0}"
  },
  "workspace.grantFolderAccessToReadItsImages": {
    "zh": "需要授权这个目录才能读取图片",
    "en": "Grant folder access to read its images."
  },
  "workspace.couldNotPrepareDrag": {
    "zh": "准备拖出失败：{p0}",
    "en": "Could not prepare drag: {p0}"
  },
  "workspace.exportCopyReadyToDrag": {
    "zh": "导出副本已就绪，可以拖出",
    "en": "Export copy ready to drag"
  },
  "workspace.preparingExportCopyDragAgainWhenReady": {
    "zh": "正在准备导出副本，准备好后再次拖出",
    "en": "Preparing export copy. Drag again when ready."
  },
  "workspace.preparingEditedImageUseDragCurrentImage": {
    "zh": "正在准备当前编辑结果，就绪后请从“拖出当前图”拖动",
    "en": "Preparing edited image. Use Drag current image when ready."
  },
  "workspace.theBackendIndexHasNoImagesYet": {
    "zh": "后端索引里还没有图片",
    "en": "The backend index has no images yet."
  },
  "workspace.theBackendIsPreparingNewImagesThey": {
    "zh": "后端正在预备新图，完成后会自动出现",
    "en": "The backend is preparing new images. They will appear automatically."
  },
  "workspace.preparingNewImages": {
    "zh": "后端正在预备新图…",
    "en": "Preparing new images…"
  },
  "workspace.uncategorized": {
    "zh": "未分类（{p0}）",
    "en": "Uncategorized ({p0})"
  },
  "workspace.allImages": {
    "zh": "全部图片（{p0}）",
    "en": "All images ({p0})"
  },
  "workspace.viewNewImages": {
    "zh": "查看 {p0} 张新图",
    "en": "View {p0} new images"
  },
  "workspace.copyFailedClipboardAccessDenied2": {
    "zh": "复制失败：浏览器拒绝了剪贴板访问",
    "en": "Copy failed: clipboard access denied"
  },
  "workspace.promptCopiedToClipboard": {
    "zh": "Prompt 已复制到剪贴板",
    "en": "Prompt copied to clipboard"
  },
  "workspace.parsedPromptCopiedSomeConnectionsCouldNot": {
    "zh": "已复制已解析的 Prompt；部分连接无法解析",
    "en": "Parsed prompt copied. Some connections could not be resolved."
  },
  "workspace.noReliablePromptFoundPleaseRetry": {
    "zh": "未取得可靠 Prompt，请重试",
    "en": "No reliable prompt found. Please retry."
  },
  "workspace.theImageSGenerationBranchIsUncertain": {
    "zh": "无法确定本图对应的生成分支，暂不能可靠复制",
    "en": "The image's generation branch is uncertain, so its prompt cannot be copied reliably."
  },
  "workspace.downloadFailed": {
    "zh": "⚠️ 下载失败",
    "en": "Download failed"
  },
  "workspace.workflowJsonDownloadedDragItOntoThe": {
    "zh": "⬇️ 工作流 .json 已下载，拖入 ComfyUI 画布即可导入",
    "en": "Workflow JSON downloaded. Drag it onto the ComfyUI canvas to import it."
  },
  "workspace.thisImageHasNoWorkflowData": {
    "zh": "该图片无工作流数据",
    "en": "This image has no workflow data."
  },
  "workspace.waitingForResources": {
    "zh": "等待资源",
    "en": "Waiting for resources"
  },
  "workspace.folderCheckWaiting": {
    "zh": "核对待恢复：{p0}",
    "en": "Folder check waiting: {p0}"
  },
  "workspace.pleaseRetry": {
    "zh": "请重试",
    "en": "Please retry"
  },
  "workspace.folderCheckFailed": {
    "zh": "核对失败：{p0}",
    "en": "Folder check failed: {p0}"
  },
  "workspace.imagesPendingUnrecognizedFailed": {
    "zh": "共 {p0} 张 · 待整理 {p1} · 未识别 {p2} · 失败 {p3}",
    "en": "{p0} images · {p1} pending · {p2} unrecognized · {p3} failed"
  },
  "workspace.searching": {
    "zh": "搜索中…",
    "en": "Searching…"
  },
  "workspace.passComplete": {
    "zh": " · 本轮完成",
    "en": " · Pass complete"
  },
  "workspace.processing": {
    "zh": " · 处理中",
    "en": " · Processing"
  },
  "workspace.organizing": {
    "zh": "整理 {p0}/{p1}{p2}",
    "en": "Organizing {p0}/{p1}{p2}"
  },
  "workspace.tagging": {
    "zh": " · 反推中",
    "en": " · Tagging"
  },
  "workspace.retryNeeded": {
    "zh": "处理待重试：{p0}",
    "en": "Retry needed: {p0}"
  },
  "workspace.waitingForResourcesOrFolderAccess": {
    "zh": "等待资源或目录授权",
    "en": "Waiting for resources or folder access"
  },
  "workspace.wd14IsInUseByAnotherTask": {
    "zh": "WD14 正被其他任务使用",
    "en": "WD14 is in use by another task"
  },
  "workspace.generatingImagesWaitingForIdle": {
    "zh": "正在生图，等待空闲",
    "en": "Generating images; waiting for idle"
  },
  "workspace.lowMemoryWaitingToRecover": {
    "zh": "内存不足，等待恢复",
    "en": "Low memory; waiting to recover"
  },
  "workspace.invalidResponseFromLocalClassification": {
    "zh": "本地分类返回格式无效",
    "en": "Invalid response from local classification"
  },
  "workspace.localDictionaryClassificationHttp": {
    "zh": "本地词库分类 HTTP {p0}",
    "en": "Local dictionary classification HTTP {p0}"
  },
  "workspace.batch": {
    "zh": "批量",
    "en": "Batch"
  },
  "workspace.promptDeleted": {
    "zh": "🗑️ Prompt 已删除",
    "en": "Prompt deleted"
  },
  "workspace.deleteThisPrompt": {
    "zh": "确认删除此 Prompt?",
    "en": "Delete this prompt?"
  },
  "workspace.deletePrompt": {
    "zh": "删除 Prompt",
    "en": "Delete prompt"
  },
  "workspace.promptUpdated": {
    "zh": "✅ Prompt 已更新",
    "en": "Prompt updated"
  },
  "workspace.promptAdded": {
    "zh": "✅ Prompt 已添加",
    "en": "Prompt added"
  },
  "workspace.aPromptIsRequired": {
    "zh": "⚠️ Prompt 不能为空",
    "en": "A prompt is required."
  },
  "workspace.enterACategoryName": {
    "zh": "输入分类名称:",
    "en": "Enter a category name:"
  },
  "workspace.newCategory2": {
    "zh": "新建分类",
    "en": "New category"
  },
  "workspace.batchModeSelectCardsThenUseThe": {
    "zh": "🖱️ 批量模式：点击卡片选择/取消，底部操作条执行批量操作",
    "en": "Batch mode: select cards, then use the actions at the bottom."
  },
  "workspace.noPromptsHaveBeenExtractedForThis": {
    "zh": "⚠️ 该模型暂无已提取的 Prompt",
    "en": "No prompts have been extracted for this model yet."
  },
  "workspace.yourPromptLibraryIsEmpty": {
    "zh": "Prompt 库为空",
    "en": "Your Prompt Library is empty"
  },
  "workspace.noMatchingPrompts": {
    "zh": "没有匹配的 Prompt",
    "en": "No matching prompts"
  },
  "workspace.browseLorasAndExtractTriggerWordsFrom": {
    "zh": "浏览 LoRA 列表，从卡片中提取触发词",
    "en": "Browse LoRAs and extract trigger words from a card."
  },
  "workspace.deleteThisCategoryItsPromptsWillMove": {
    "zh": "删除此分类？其中的 Prompt 将移至\"未分类\"",
    "en": "Delete this category? Its prompts will move to Uncategorized."
  },
  "workspace.all": {
    "zh": "{p1} 全部",
    "en": "{p1} All"
  },
  "workspace.newCategory3": {
    "zh": "{p4} 新建分类",
    "en": "{p4} New category"
  },
  "workspace.removedDuplicatePrompts": {
    "zh": "🧹 去重完成，已删除 {p0} 条",
    "en": "Removed {p0} duplicate prompts"
  },
  "workspace.foundDuplicatePromptsKeepTheNewestIn": {
    "zh": "发现 {p0} 条重复 Prompt（每组保留最新一条）。确认删除其余重复项？",
    "en": "Found {p0} duplicate prompts. Keep the newest in each group and delete the rest?"
  },
  "workspace.removeDuplicates": {
    "zh": "整库去重",
    "en": "Remove duplicates"
  },
  "workspace.noDuplicatePromptsFound": {
    "zh": "✅ 没有发现重复 Prompt",
    "en": "No duplicate prompts found"
  },
  "workspace.deletedPrompts": {
    "zh": "🗑️ 已删除 {p0} 条",
    "en": "Deleted {p0} prompts"
  },
  "workspace.deleteSelectedPromptsThisCannotBeUndone": {
    "zh": "确认删除选中的 {p0} 条 Prompt？此操作不可恢复！",
    "en": "Delete {p0} selected prompts? This cannot be undone."
  },
  "workspace.renamedPrompts": {
    "zh": "✅ 已重命名 {p0} 条",
    "en": "Renamed {p0} prompts"
  },
  "workspace.enterANamePrefixEntriesAreNumbered": {
    "zh": "输入名称前缀（自动按创建时间从旧到新编号 01、02…）:",
    "en": "Enter a name prefix. Entries are numbered 01, 02… from oldest to newest:"
  },
  "workspace.renameSelected": {
    "zh": "批量命名",
    "en": "Rename selected"
  },
  "workspace.movedPromptsTo": {
    "zh": "✅ 已将 {p0} 条移入「{p1}」",
    "en": "Moved {p0} prompts to “{p1}”"
  },
  "workspace.enterACategoryExistingANewName": {
    "zh": "输入目标分类名（现有: {p0}；不存在则自动新建）:",
    "en": "Enter a category (existing: {p0}). A new name creates a category:"
  },
  "workspace.categorizeSelected": {
    "zh": "批量分类",
    "en": "Categorize selected"
  },
  "workspace.selected": {
    "zh": "已选",
    "en": "Selected"
  },
  "workspace.items": {
    "zh": "项",
    "en": "items"
  },
  "workspace.categorize": {
    "zh": "{p0} 批量分类",
    "en": "{p0} Categorize"
  },
  "workspace.rename2": {
    "zh": "{p1} 批量命名",
    "en": "{p1} Rename"
  },
  "workspace.deleteSelected2": {
    "zh": "{p2} 删除选中",
    "en": "{p2} Delete selected"
  },
  "workspace.removeDuplicates2": {
    "zh": "{p3} 整库去重",
    "en": "{p3} Remove duplicates"
  },
  "workspace.exit": {
    "zh": "{p4} 退出",
    "en": "{p4} Exit"
  },
  "workspace.couldNotParseTheImagePleaseRetry": {
    "zh": "图片解析失败，请重试",
    "en": "Could not parse the image. Please retry."
  },
  "workspace.imageFilesProcessed": {
    "zh": "已处理图片文件",
    "en": "Image files processed"
  },
  "workspace.processedImages": {
    "zh": "已处理 {p0} 张图片",
    "en": "Processed {p0} images"
  },
  "workspace.thisImageHasNoWorkflowData2": {
    "zh": "⚠️ 该图片无工作流数据",
    "en": "This image has no workflow data."
  },
  "workspace.allLoraTagsCopied": {
    "zh": "📋 已复制全部 LoRA 标签",
    "en": "All LoRA tags copied"
  },
  "workspace.copiedLora": {
    "zh": "已复制 LoRA: {p0}",
    "en": "Copied LoRA: {p0}"
  },
  "workspace.selectAnOutputFolderInOutputsFirst": {
    "zh": "⚠️ 请先在 Outputs 栏目选择输出目录",
    "en": "Select an output folder in Outputs first."
  },
  "workspace.translationFailedCheckYourConnectionOrChoose": {
    "zh": "⚠️ 翻译失败：请检查网络后重试，或点「翻译源」换一个试试",
    "en": "Translation failed. Check your connection or choose another translation source."
  },
  "workspace.translateAll": {
    "zh": "翻译全部",
    "en": "Translate all"
  },
  "workspace.translating": {
    "zh": "翻译中…",
    "en": "Translating…"
  },
  "workspace.copiedAll": {
    "zh": "已复制全部",
    "en": "Copied all"
  },
  "workspace.copied3": {
    "zh": "已复制: {p0},",
    "en": "Copied: {p0},"
  },
  "workspace.noDataYet": {
    "zh": "暂无数据",
    "en": "No data yet"
  },
  "workspace.scanAFolderInOutputsOrUpload": {
    "zh": "请先在 Outputs 中扫描图片目录，或上传 PNG / JPEG / WebP 图片",
    "en": "Scan a folder in Outputs, or upload PNG, JPEG or WebP images."
  },
  "workspace.dropImagesHereOrClickToUpload": {
    "zh": "{p0} 拖拽或点击上传图片 · PNG / JPEG / WebP",
    "en": "{p0} Drop images here or click to upload · PNG / JPEG / WebP"
  },
  "workspace.saveAsJsonThenDragItOnto": {
    "zh": "保存为 .json 文件，拖入 ComfyUI 画布即可导入",
    "en": "Save as JSON, then drag it onto the ComfyUI canvas to import."
  },
  "workspace.downloadWorkflowJson": {
    "zh": "{p1} 下载工作流 .json",
    "en": "{p1} Download workflow JSON"
  },
  "workspace.generationSettingsAndRawMetadata": {
    "zh": "{p0} 生成配置与原始字段",
    "en": "{p0} Generation settings and raw metadata"
  },
  "workspace.name": {
    "zh": "名称",
    "en": "name"
  },
  "workspace.tag": {
    "zh": "标签",
    "en": "tag"
  },
  "workspace.loraClickToCopy": {
    "zh": "🧩 LoRA（点击复制 {p0}）",
    "en": "LoRA (click to copy {p0})"
  },
  "workspace.copyAllLoras": {
    "zh": "{p3}复制全部 LoRA",
    "en": "{p3} Copy all LoRAs"
  },
  "workspace.translationSourceCurrent": {
    "zh": "选择翻译源（当前：{p5}）",
    "en": "Translation source (current: {p5})"
  },
  "workspace.negativePrompt2": {
    "zh": "负 Prompt",
    "en": "Negative prompt"
  },
  "workspace.copyAll": {
    "zh": "{p3}复制全部",
    "en": "{p3} Copy all"
  },
  "workspace.translateAll2": {
    "zh": "{p4}翻译全部",
    "en": "{p4} Translate all"
  },
  "workspace.positivePrompt": {
    "zh": "正 Prompt",
    "en": "Positive prompt"
  },
  "workspace.clickToPreview": {
    "zh": "点击放大预览",
    "en": "Click to preview"
  },
  "workspace.apiParametersOnlyNoCanvasWorkflow": {
    "zh": "仅 API 执行参数，无画布工作流",
    "en": "API parameters only; no canvas workflow"
  },
  "workspace.containsAUiWorkflowThatCanBe": {
    "zh": "已内嵌 UI 格式工作流，可导入 ComfyUI",
    "en": "Contains a UI workflow that can be imported into ComfyUI"
  },
  "workspace.noOutputFolderSelectedClickToChoose": {
    "zh": "未选择输出目录，点击前往 Outputs 选择",
    "en": "No output folder selected. Click to choose one in Outputs."
  },
  "workspace.sendToOutputsChooseACategoryBefore": {
    "zh": "发送到 Outputs（先选分类再保存文件）",
    "en": "Send to Outputs (choose a category before saving)"
  },
  "workspace.sentToOutputs": {
    "zh": "已发送到 Outputs",
    "en": "Sent to Outputs"
  },
  "workspace.chooseOutputFolder": {
    "zh": "选择输出目录",
    "en": "Choose output folder"
  },
  "workspace.sendToOutputs": {
    "zh": "发送到 Outputs",
    "en": "Send to Outputs"
  },
  "workspace.sent": {
    "zh": "已发送",
    "en": "Sent"
  },
  "workspace.noReliablePromptWasParsedFromThis": {
    "zh": "该图未解析出可靠 Prompt，无法保存",
    "en": "No reliable prompt was parsed from this image, so it cannot be saved."
  },
  "workspace.saveToPromptLibrary": {
    "zh": "保存到 Prompt 库",
    "en": "Save to Prompt Library"
  },
  "workspace.savedToThePromptLibraryOpenIt": {
    "zh": "已保存到 Prompt 库，可在顶部「Prompt 库」查看",
    "en": "Saved to the Prompt Library. Open it from the sidebar."
  },
  "workspace.saved": {
    "zh": "已保存",
    "en": "Saved"
  },
  "workspace.remove": {
    "zh": "移除",
    "en": "Remove"
  },
  "workspace.uploadedImages": {
    "zh": "{p0} 上传的图片 ({p1})",
    "en": "{p0} Uploaded images ({p1})"
  },
  "workspace.chooseCategory": {
    "zh": "选择分类",
    "en": "Choose category"
  },
  "workspace.noOutputFolderSelected": {
    "zh": "未选择输出目录",
    "en": "No output folder selected"
  },
  "workspace.couldNotSend": {
    "zh": "❌ 发送失败: ",
    "en": "Could not send: "
  },
  "workspace.sentToOutputs2": {
    "zh": "✅ 已发送到 Outputs",
    "en": "Sent to Outputs"
  },
  "workspace.sentToOutputsCategory": {
    "zh": "✅ 已发送到 Outputs（分类：{p0}）",
    "en": "Sent to Outputs (category: {p0})"
  },
  "workspace.selectAnOutputFolderInOutputsFirst2": {
    "zh": "⚠️ 请先在 Outputs 中选择输出目录",
    "en": "Select an output folder in Outputs first."
  },
  "workspace.savedToThePromptLibraryOpenIt2": {
    "zh": "✅ 已保存到 Prompt 库，可在顶部「Prompt 库」查看",
    "en": "Saved to the Prompt Library. Open it from the sidebar."
  },
  "workspace.imagePrompt": {
    "zh": "图片 Prompt",
    "en": "Image prompt"
  },
  "workspace.noReliablePromptWasParsedFromThis2": {
    "zh": "该图片未解析出可靠 Prompt",
    "en": "No reliable prompt was parsed from this image."
  },
  "workspace.translationSource": {
    "zh": "翻译源：",
    "en": "Translation source:"
  },
  "workspace.tryLocalDictionaryDeeplxMymemoryGoogleQwen": {
    "zh": "按 本地词典 → DeepLX → MyMemory → Google → 通义 顺序自动回退",
    "en": "Try local dictionary → DeepLX → MyMemory → Google → Qwen in order"
  },
  "workspace.couldNotReadImageMetadataPleaseRetry": {
    "zh": "图片元数据读取失败，请重试",
    "en": "Could not read image metadata. Please retry."
  },
  "workspace.auto2": {
    "zh": "自动",
    "en": "Auto"
  },
  "workspace.qwen": {
    "zh": "通义",
    "en": "Qwen"
  },
  "workspace.localDictionary": {
    "zh": "本地词典",
    "en": "Local dictionary"
  },
  "workspace.artists": {
    "zh": " 位画师",
    "en": " artists"
  },
  "workspace.added": {
    "zh": "添加了 ",
    "en": "Added "
  },
  "workspace.added2": {
    "zh": "已有",
    "en": "Added"
  },
  "workspace.addAll": {
    "zh": "全部添加",
    "en": "Add all"
  },
  "workspace.add": {
    "zh": "添加",
    "en": "Add"
  },
  "workspace.times": {
    "zh": "次)",
    "en": " times)"
  },
  "workspace.candidates": {
    "zh": "个候选:",
    "en": " candidates:"
  },
  "workspace.detected": {
    "zh": "检测到",
    "en": "Detected"
  },
  "workspace.noArtistTagsStartingWithWereFound": {
    "zh": "未检测到 @ 开头的画师标签",
    "en": "No artist tags starting with @ were found."
  },
  "workspace.startExtraction": {
    "zh": "开始提取",
    "en": "Start extraction"
  },
  "workspace.clickBelowToStartExtraction": {
    "zh": "点击下方按钮开始提取…",
    "en": "Click below to start extraction…"
  },
  "workspace.findArtistTagsStartingWithInThe": {
    "zh": "从已加载 LoRA 的 trainedWords 中自动检测 @ 开头的画师标签",
    "en": "Find artist tags starting with @ in the loaded LoRAs' trigger words."
  },
  "workspace.extractArtists": {
    "zh": "提取画师",
    "en": "Extract artists"
  },
  "workspace.added3": {
    "zh": "添加成功",
    "en": "Added"
  },
  "workspace.thisTagAlreadyExists": {
    "zh": "Tag 已存在!",
    "en": "This tag already exists."
  },
  "workspace.aTagIsRequired": {
    "zh": "Tag 必填",
    "en": "A tag is required."
  },
  "workspace.cancel": {
    "zh": "取消",
    "en": "Cancel"
  },
  "workspace.confirm": {
    "zh": "确认",
    "en": "Confirm"
  },
  "workspace.orEnterNewCategoriesSeparatedByCommas": {
    "zh": "或输入新分类 (逗号分隔)",
    "en": "Or enter new categories, separated by commas"
  },
  "workspace.category": {
    "zh": "分类:",
    "en": "Category:"
  },
  "workspace.styleDescription": {
    "zh": "风格描述...",
    "en": "Style description…"
  },
  "workspace.displayNameEGG0w0ru": {
    "zh": "显示名称 (如 g0w0ru)",
    "en": "Display name (e.g. g0w0ru)"
  },
  "workspace.tagWithoutThePrefixEGG0w0ru": {
    "zh": "Tag (不含@前缀，如 g0w0ru)",
    "en": "Tag without the @ prefix (e.g. g0w0ru)"
  },
  "workspace.addArtist": {
    "zh": "添加画师",
    "en": "Add artist"
  },
  "workspace.artists2": {
    "zh": "位画师",
    "en": "artists"
  },
  "workspace.noStylePresetsYet": {
    "zh": "暂无风格预设",
    "en": "No style presets yet"
  },
  "workspace.selectArtistsThenChooseSavePreset": {
    "zh": "选择画师组合后点击\"保存预设\"",
    "en": "Select artists, then choose Save preset."
  },
  "workspace.updateComplete": {
    "zh": "更新完成: ",
    "en": "Update complete: "
  },
  "workspace.updateCanceled": {
    "zh": "更新已取消",
    "en": "Update canceled"
  },
  "workspace.updateFromDanbooru": {
    "zh": "Danbooru 更新",
    "en": "Update from Danbooru"
  },
  "workspace.stop": {
    "zh": "停止",
    "en": "Stop"
  },
  "workspace.errors": {
    "zh": "错误)",
    "en": " errors)"
  },
  "workspace.updating": {
    "zh": "更新中…",
    "en": "Updating…"
  },
  "workspace.placeholders": {
    "zh": " 位占位",
    "en": " placeholders"
  },
  "workspace.matched": {
    "zh": " 位已匹配",
    "en": " matched"
  },
  "workspace.importComplete": {
    "zh": "导入完成: ",
    "en": "Import complete: "
  },
  "workspace.noValidArtistTagsDetected": {
    "zh": "未检测到有效画师标签",
    "en": "No valid artist tags detected"
  },
  "workspace.pasteArtistTagsFirst": {
    "zh": "请粘贴画师串",
    "en": "Paste artist tags first."
  },
  "workspace.categoriesUpdated": {
    "zh": "分类已更新",
    "en": "Categories updated"
  },
  "workspace.enterCategoriesSeparatedByCommas": {
    "zh": "输入分类名称 (用逗号分隔多个):",
    "en": "Enter categories, separated by commas:"
  },
  "workspace.deleteSelectedArtists": {
    "zh": "确认删除选中的 {p0} 位画师？",
    "en": "Delete {p0} selected artists?"
  },
  "workspace.importFailedInvalidFileFormat": {
    "zh": "导入失败: 文件格式错误",
    "en": "Import failed: invalid file format"
  },
  "workspace.updated": {
    "zh": "，更新 ",
    "en": ", updated "
  },
  "workspace.importCompleteAdded": {
    "zh": "导入完成: 新增 ",
    "en": "Import complete. Added "
  },
  "workspace.exportComplete": {
    "zh": "导出成功",
    "en": "Export complete"
  },
  "workspace.popularity": {
    "zh": "热度",
    "en": "Popularity"
  },
  "workspace.alphabetical": {
    "zh": "字母",
    "en": "Alphabetical"
  },
  "workspace.default": {
    "zh": "默认",
    "en": "Default"
  },
  "workspace.deleteThisPreset": {
    "zh": "确认删除该预设？",
    "en": "Delete this preset?"
  },
  "workspace.deletePreset": {
    "zh": "删除预设",
    "en": "Delete preset"
  },
  "workspace.presetLoaded": {
    "zh": "已加载预设: ",
    "en": "Preset loaded: "
  },
  "workspace.webuiFormat": {
    "zh": "WebUI格式",
    "en": "WebUI format"
  },
  "workspace.naiFormat": {
    "zh": "NAI格式",
    "en": "NAI format"
  },
  "workspace.enterAPresetName": {
    "zh": "输入预设名称:",
    "en": "Enter a preset name:"
  },
  "workspace.savePreset": {
    "zh": "保存预设",
    "en": "Save preset"
  },
  "workspace.selectArtistsFirst": {
    "zh": "请先选择画师",
    "en": "Select artists first."
  },
  "workspace.load": {
    "zh": "加载",
    "en": "Load"
  },
  "workspace.artists3": {
    "zh": "位",
    "en": "artists"
  },
  "workspace.noPresetsYet": {
    "zh": "暂无预设",
    "en": "No presets yet"
  },
  "workspace.moveDown": {
    "zh": "下移",
    "en": "Move down"
  },
  "workspace.moveUp": {
    "zh": "上移",
    "en": "Move up"
  },
  "workspace.enterWeight012": {
    "zh": "直接输入权重 (0.1-2)",
    "en": "Enter weight (0.1–2)"
  },
  "workspace.clickAnArtistCardToAddIt": {
    "zh": "点击画师卡片添加到组合",
    "en": "Click an artist card to add it to your combination."
  },
  "workspace.presets": {
    "zh": "预设",
    "en": "Presets"
  },
  "workspace.placeholders2": {
    "zh": "占位",
    "en": "Placeholders"
  },
  "workspace.all2": {
    "zh": "全部",
    "en": "All"
  },
  "workspace.previewImages": {
    "zh": "预览图片",
    "en": "Preview images"
  },
  "workspace.images2": {
    "zh": "{p2} {p3}张",
    "en": "{p2} {p3} images"
  },
  "workspace.noArtistsInThisCategoryYet": {
    "zh": "该分类下暂无画师",
    "en": "No artists in this category yet."
  },
  "workspace.noMatchingArtistsTryAnotherSearch": {
    "zh": "没有匹配的画师，换个关键词试试",
    "en": "No matching artists. Try another search."
  },
  "workspace.noArtistsYetUseAddOrExtract": {
    "zh": "还没有画师，点击工具栏「添加」或「提取」创建",
    "en": "No artists yet. Use Add or Extract in the toolbar."
  },
  "workspace.renameCategory2": {
    "zh": "{p0} 重命名分类",
    "en": "{p0} Rename category"
  },
  "workspace.deleteCategory2": {
    "zh": "{p1} 删除分类",
    "en": "{p1} Delete category"
  },
  "workspace.cardsInThisCategoryWillMoveTo": {
    "zh": "该分类下的卡片会移到「未分类」",
    "en": "Cards in this category will move to Uncategorized."
  },
  "workspace.deleteThisCategory": {
    "zh": "删除这个分类？",
    "en": "Delete this category?"
  },
  "workspace.enterACategoryName2": {
    "zh": "输入分类名称（一个名字一组）",
    "en": "Enter a category name:"
  },
  "workspace.deleted": {
    "zh": "🗑️ 已删除",
    "en": "Deleted"
  },
  "workspace.thisCannotBeUndone": {
    "zh": "删除后不可恢复",
    "en": "This cannot be undone."
  },
  "workspace.deleteThisClothingCard": {
    "zh": "删除这张服装卡片？",
    "en": "Delete this clothing card?"
  },
  "workspace.lock": {
    "zh": "🔓 锁定",
    "en": "Lock"
  },
  "workspace.locked": {
    "zh": "🔒 已锁",
    "en": "Locked"
  },
  "workspace.lockKeepWhenDrawingAgain": {
    "zh": "锁定（重抽不换掉）",
    "en": "Lock (keep when drawing again)"
  },
  "workspace.removeThisCard": {
    "zh": "移除这张",
    "en": "Remove this card"
  },
  "workspace.remove2": {
    "zh": "✕ 移除",
    "en": "Remove"
  },
  "workspace.chooseDrawToStartLockedCardsStay": {
    "zh": "点「抽卡」开始——锁定的卡不会被换掉",
    "en": "Choose Draw to start. Locked cards stay in place."
  },
  "workspace.noCardsInThisSelection": {
    "zh": "⚠️ 该范围没有卡片",
    "en": "No cards in this selection."
  },
  "workspace.favorites": {
    "zh": "收藏 ({p0})",
    "en": "Favorites ({p0})"
  },
  "workspace.all3": {
    "zh": "全部 ({p0})",
    "en": "All ({p0})"
  },
  "workspace.copyFailed": {
    "zh": "❌ 复制失败",
    "en": "Copy failed"
  },
  "workspace.combinedPromptCopied": {
    "zh": "✅ 已复制合并提示词",
    "en": "Combined prompt copied"
  },
  "workspace.randomOutfits": {
    "zh": "{p0} 服装抽卡",
    "en": "{p0} Random outfits"
  },
  "workspace.scope": {
    "zh": "范围",
    "en": "Scope"
  },
  "workspace.count": {
    "zh": "数量",
    "en": "Count"
  },
  "workspace.draw": {
    "zh": "{p1} 抽卡",
    "en": "{p1} Draw"
  },
  "workspace.copyCombined": {
    "zh": "{p2} 复制合并",
    "en": "{p2} Copy combined"
  },
  "workspace.added4": {
    "zh": "✅ 已添加",
    "en": "Added"
  },
  "workspace.saved2": {
    "zh": "✅ 已保存",
    "en": "Saved"
  },
  "workspace.aPromptIsRequired2": {
    "zh": "⚠️ 提示词不能为空",
    "en": "A prompt is required."
  },
  "workspace.addClothingCard": {
    "zh": "添加服装卡片",
    "en": "Add clothing card"
  },
  "workspace.editClothingCard": {
    "zh": "编辑服装卡片",
    "en": "Edit clothing card"
  },
  "workspace.eGCheongsamBunnySuit": {
    "zh": "如：旗袍 / 兔女郎",
    "en": "E.g. cheongsam / bunny suit"
  },
  "workspace.nameShownOnCardsWithoutAnImage": {
    "zh": "名称（无图时卡片大字显示）",
    "en": "Name (shown on cards without an image)"
  },
  "workspace.category2": {
    "zh": "分类",
    "en": "Category"
  },
  "workspace.promptEnglishTagsSeparatedByCommas": {
    "zh": "提示词（英文 tag 串，逗号分隔）",
    "en": "Prompt (English tags separated by commas)"
  },
  "workspace.imageOptionalLeaveEmptyForAText": {
    "zh": "图片（可选，不选则为文字卡）",
    "en": "Image (optional; leave empty for a text card)"
  },
  "workspace.chooseFromOutputs": {
    "zh": "{p0} 从 Outputs 选图",
    "en": "{p0} Choose from Outputs"
  },
  "workspace.save": {
    "zh": "保存",
    "en": "Save"
  },
  "workspace.movedCardsTo": {
    "zh": "✅ 已移动 {p0} 张卡片到「{p1}」",
    "en": "Moved {p0} cards to “{p1}”"
  },
  "workspace.orEnterANewCategoryNameLeave": {
    "zh": "或输入新分类名（留空用上面的）",
    "en": "Or enter a new category name (leave blank to use the selection above)"
  },
  "workspace.moveSelectedCards": {
    "zh": "{p0} 移动选中卡片到分类",
    "en": "{p0} Move selected cards"
  },
  "workspace.cardsSelectedChooseACategoryOrEnter": {
    "zh": "已选 {p1} 张；选已有分类或输入新分类名",
    "en": "{p1} cards selected. Choose a category or enter a new name."
  },
  "workspace.move": {
    "zh": "移动",
    "en": "Move"
  },
  "workspace.selectCardsFirst": {
    "zh": "先选中卡片",
    "en": "Select cards first."
  },
  "workspace.couldNotReadImage": {
    "zh": "❌ 读取图片失败",
    "en": "Could not read image"
  },
  "workspace.selectedOutputsImage": {
    "zh": "✅ 已选用 Outputs 图片：{p0}",
    "en": "Selected Outputs image: {p0}"
  },
  "workspace.noImagesInOutputsYet": {
    "zh": "Outputs 里还没有图",
    "en": "No images in Outputs yet"
  },
  "workspace.recentImagesClickToAssignOneTo": {
    "zh": "最近 {p1} 张出图（点选即配到卡片；没有可用图时请先扫描 Outputs 或手动上传）",
    "en": "{p1} recent images. Click to assign one to the card. Scan Outputs or upload an image if this list is empty."
  },
  "workspace.exportedCardsWithImagesImportTheFile": {
    "zh": "✅ 已导出 {p0} 张卡片（含图片，可随时再导入恢复）",
    "en": "Exported {p0} cards with images. Import the file to restore them."
  },
  "workspace.categoriesAdded": {
    "zh": "新增分类 {p0} 个",
    "en": "{p0} categories added"
  },
  "workspace.cardsRecategorized": {
    "zh": "更新分类 {p0} 张",
    "en": "{p0} cards recategorized"
  },
  "workspace.duplicatesSkipped": {
    "zh": "跳过重复 {p0} 张",
    "en": "{p0} duplicates skipped"
  },
  "workspace.cardsImported": {
    "zh": "导入 {p0} 张",
    "en": "{p0} cards imported"
  },
  "workspace.untitled": {
    "zh": "未命名",
    "en": "Untitled"
  },
  "workspace.noCardsSelected": {
    "zh": "没有选中的卡片",
    "en": "No cards selected"
  },
  "workspace.expandCollapse": {
    "zh": "展开/收起",
    "en": "Expand / collapse"
  },
  "workspace.cards": {
    "zh": "{p3} 张",
    "en": "{p3} cards"
  },
  "workspace.importSelectedCards": {
    "zh": "导入选中 ({p0} 张)",
    "en": "Import selected ({p0} cards)"
  },
  "workspace.importClothingCards": {
    "zh": "{p0} 导入服装卡片",
    "en": "{p0} Import clothing cards"
  },
  "workspace.expandACategoryToSelectIndividualCards": {
    "zh": "点分类行展开看卡片图，勾选到单张；分类前的框 = 一键全选/全不选该类",
    "en": "Expand a category to select individual cards. The category checkbox selects or clears its entire group."
  },
  "workspace.useCategoriesFromTheFileOtherwiseImport": {
    "zh": "按文件分类导入（不勾 = 全部进「未分类」，导入后你自己分类/收藏）",
    "en": "Use categories from the file (otherwise import everything into Uncategorized)"
  },
  "workspace.selectAll": {
    "zh": "全选",
    "en": "Select all"
  },
  "workspace.selectNone": {
    "zh": "全不选",
    "en": "Select none"
  },
  "workspace.importSelected0Cards": {
    "zh": "导入选中 (0 张)",
    "en": "Import selected (0 cards)"
  },
  "workspace.importCanceled": {
    "zh": "已取消导入",
    "en": "Import canceled"
  },
  "workspace.invalidClothingLibraryImportFile": {
    "zh": "文件格式不对（不是服装库导入文件）",
    "en": "Invalid clothing library import file"
  },
  "workspace.importingPleaseWait": {
    "zh": "⏳ 正在导入，请稍候…",
    "en": "Importing, please wait…"
  },
  "workspace.importFailed": {
    "zh": "导入失败：",
    "en": "Import failed: "
  },
  "workspace.favorite": {
    "zh": "收藏",
    "en": "Favorite"
  },
  "workspace.deletedCards": {
    "zh": "🗑️ 已删除 {p0} 张卡片",
    "en": "Deleted {p0} cards"
  },
  "workspace.deleteSelectedCardsThisCannotBeUndone": {
    "zh": "确认删除选中的 {p0} 张卡片？\n删除后不可恢复！",
    "en": "Delete {p0} selected cards?\nThis cannot be undone."
  },
  "workspace.cardsPage": {
    "zh": "共 {p7} 张 · 第 {p8}/{p9} 页",
    "en": "{p7} cards · Page {p8}/{p9}"
  },
  "workspace.searchByCategoryAndUseEachMatching": {
    "zh": "# 用法：按分类 grep 检索，命中后整串使用，勿拆改",
    "en": "# Search by category and use each matching prompt in full."
  },
  "workspace.lineFormatCategoryNamePromptCommaSeparated": {
    "zh": "# 每行格式：分类|名称|prompt（prompt 为可直接使用的逗号连接 tag 串）",
    "en": "# Line format: category|name|prompt (comma-separated tags ready to use)"
  },
  "workspace.cardsCategories": {
    "zh": "# 共 {p0} 张卡 · 分类：{p1}",
    "en": "# {p0} cards · Categories: {p1}"
  },
  "workspace.clothingLibraryIndexAnimaToolkitTextOnly": {
    "zh": "# 服装卡片库索引（Anima Toolkit 面板「服装库」，无图轻量版）",
    "en": "# Clothing library index (Anima Toolkit; text only)"
  },
  "workspace.noSearchablePositivePromptWasSaved": {
    "zh": "未保存可检索的正面提示词",
    "en": "No searchable positive prompt was saved"
  },
  "workspace.noPrompt": {
    "zh": "无提示词",
    "en": "No prompt"
  },
  "workspace.locallyInferredTagsOriginalMetadataIsRetained": {
    "zh": "本地推断标签（{p0}）；没有替代原图元数据",
    "en": "Locally inferred tags ({p0}); original metadata is retained"
  },
  "workspace.pixaiRecognition": {
    "zh": "PixAI 识别",
    "en": "PixAI recognition"
  },
  "workspace.similarImageRecognition": {
    "zh": "图库相似识别",
    "en": "Similar image recognition"
  },
  "workspace.nodeSummary": {
    "zh": "{p0} 节点摘要",
    "en": "{p0} Node summary"
  },
  "workspace.theWorkflowFormatCouldNotBeParsed": {
    "zh": "工作流数据格式无法解析，可展开原始保存字段查看。",
    "en": "The workflow format could not be parsed. Expand the raw metadata to inspect it."
  },
  "workspace.nodes": {
    "zh": "({p0} 节点)",
    "en": "({p0} nodes)"
  },
  "workspace.viewAllNodes": {
    "zh": "{p0} 查看全部 {p1} 个节点",
    "en": "{p0} View all {p1} nodes"
  },
  "workspace.nodeSummary2": {
    "zh": "{p0} 节点摘要{p1}",
    "en": "{p0} Node summary{p1}"
  },
  "workspace.reparse": {
    "zh": "重试解析",
    "en": "Reparse"
  },
  "workspace.imageInfo": {
    "zh": "图片信息",
    "en": "Image info"
  },
  "workspace.dimensions": {
    "zh": "尺寸",
    "en": "Dimensions"
  },
  "workspace.positivePrompt2": {
    "zh": "正向提示词",
    "en": "Positive prompt"
  },
  "workspace.negativePrompt3": {
    "zh": "负向提示词",
    "en": "Negative prompt"
  },
  "workspace.stage": {
    "zh": "阶段 {p0}",
    "en": "Stage {p0}"
  },
  "workspace.metadataCouldNotBeReadOrFound": {
    "zh": "元数据读取失败或未找到，请重试。",
    "en": "Metadata could not be read or found. Please retry."
  },
  "workspace.downloadWorkflowJson2": {
    "zh": "下载工作流 JSON",
    "en": "Download workflow JSON"
  },
  "workspace.closePanel": {
    "zh": "关闭面板",
    "en": "Close panel"
  },
  "workspace.metadata": {
    "zh": "元数据",
    "en": "Metadata"
  },
  "workspace.total": {
    "zh": "（总计 {p0}）",
    "en": "(total {p0})"
  },
  "workspace.images3": {
    "zh": "共 {p0} 张图片",
    "en": "{p0} images"
  },
  "workspace.noImagesMatchTheseFilters": {
    "zh": "筛选条件下没有可显示的图片",
    "en": "No images match these filters"
  },
  "workspace.imagesMayBeHiddenByASaved": {
    "zh": "这里其实有图片，可能是残留了日期范围或其它筛选条件（也许是很久以前设过一直生效）",
    "en": "Images may be hidden by a saved date range or other active filters."
  },
  "workspace.clearFiltersAndShowAll": {
    "zh": "清除筛选，查看全部",
    "en": "Clear filters and show all"
  },
  "workspace.chooseAComfyuiOutputFolderToManage": {
    "zh": "选择 ComfyUI 输出目录开始管理图片",
    "en": "Choose a ComfyUI output folder to manage images."
  },
  "workspace.noImagesInThisFolder": {
    "zh": "当前目录没有图片",
    "en": "No images in this folder"
  },
  "workspace.chooseFolder": {
    "zh": "选择目录",
    "en": "Choose folder"
  },
  "workspace.category3": {
    "zh": "分类：{p0}",
    "en": "Category: {p0}"
  },
  "workspace.removeFavorite": {
    "zh": "取消收藏",
    "en": "Remove favorite"
  },
  "workspace.dragACleanImageCopy": {
    "zh": "拖出干净图片副本",
    "en": "Drag a clean image copy"
  },
  "workspace.preview": {
    "zh": "预览",
    "en": "Preview"
  },
  "workspace.imageActions": {
    "zh": "图片操作",
    "en": "Image actions"
  },
  "workspace.imageActionsCopyDownloadPromptAndMetadata": {
    "zh": "图片操作：复制、下载、Prompt 和元数据",
    "en": "Image actions: copy, download, prompt and metadata"
  },
  "workspace.addAFolderToStartScanning": {
    "zh": "{p0} 添加目录开始扫描",
    "en": "{p0} Add a folder to start scanning"
  },
  "workspace.featured": {
    "zh": "精选",
    "en": "Featured"
  },
  "workspace.rejected": {
    "zh": "驳回",
    "en": "Rejected"
  },
  "workspace.needsChanges": {
    "zh": "待修",
    "en": "Needs changes"
  },
  "workspace.toReview": {
    "zh": "待审",
    "en": "To review"
  },
  "workspace.approved": {
    "zh": "通过",
    "en": "Approved"
  },
  "workspace.folderActions": {
    "zh": "{p1} 目录操作",
    "en": "{p1} folder actions"
  },
  "workspace.openImages": {
    "zh": "打开 {p2}，{p3} 张图片",
    "en": "Open {p2}, {p3} images"
  },
  "workspace.doubleClickToOpen": {
    "zh": "双击进入 {p4}",
    "en": "Double-click to open {p4}"
  },
  "workspace.images4": {
    "zh": "{p9} 张图片",
    "en": "{p9} images"
  },
  "workspace.goUp": {
    "zh": "返回上级",
    "en": "Go up"
  },
  "workspace.imageLocation": {
    "zh": "图片浏览位置",
    "en": "Image location"
  },
  "workspace.imageLibrary": {
    "zh": "图片库",
    "en": "Image Library"
  },
  "workspace.couldNotGrantAccessAddThisFolder": {
    "zh": "目录授权失败，请重新添加该目录",
    "en": "Could not grant access. Add this folder again."
  },
  "workspace.folderAccessWasNotGrantedYouCan": {
    "zh": "目录权限未获得，可稍后重新授权",
    "en": "Folder access was not granted. You can retry later."
  },
  "workspace.couldNotRemove": {
    "zh": "移除失败：{p0}",
    "en": "Could not remove: {p0}"
  },
  "workspace.removeFromLibraryKeepImagesFavoritesAnd": {
    "zh": "从图库移除（保留图片、收藏与评分）",
    "en": "Remove from library (keep images, favorites and ratings)"
  },
  "workspace.refreshThisFolder": {
    "zh": "刷新此目录",
    "en": "Refresh this folder"
  },
  "workspace.folderActionFailed": {
    "zh": "目录操作失败：{p0}",
    "en": "Folder action failed: {p0}"
  },
  "workspace.couldNotSaveFolderSelection": {
    "zh": "目录选择保存失败",
    "en": "Could not save folder selection"
  },
  "workspace.grantAccessTo": {
    "zh": "重新授权 {p1}",
    "en": "Grant access to {p1}"
  },
  "workspace.expand": {
    "zh": "展开",
    "en": "Expand"
  },
  "workspace.collapse": {
    "zh": "折叠",
    "en": "Collapse"
  },
  "workspace.folderActions2": {
    "zh": "目录操作",
    "en": "Folder actions"
  },
  "workspace.includeInAllImages2": {
    "zh": "一起浏览 {p3}",
    "en": "Include {p3} in all images"
  },
  "workspace.allSelectedFolders": {
    "zh": "所有已选目录",
    "en": "All selected folders"
  },
  "workspace.baseModel": {
    "zh": "底模",
    "en": "Base model"
  },
  "workspace.savedFormat": {
    "zh": "保存格式",
    "en": "Saved format"
  },
  "workspace.modelInfo": {
    "zh": "模型信息",
    "en": "Model info"
  },
  "workspace.generationStages": {
    "zh": "生成阶段{p4}",
    "en": "Generation stages{p4}"
  },
  "workspace.loraWeights": {
    "zh": "LoRA 独立权重",
    "en": "LoRA weights"
  },
  "workspace.outputAssociationDescribesDependenciesInTheSaved": {
    "zh": "输出关联表示保存图中的依赖关系，不证明模型文件已成功加载。",
    "en": "Output association describes dependencies in the saved image. It does not confirm that model files loaded successfully."
  },
  "workspace.characters": {
    "zh": "{p2} 字符",
    "en": "{p2} characters"
  },
  "workspace.rawSavedFields": {
    "zh": "原始保存字段 ({p0})",
    "en": "Raw saved fields ({p0})"
  },
  "workspace.unknown": {
    "zh": "未知",
    "en": "Unknown"
  },
  "workspace.on": {
    "zh": "开启",
    "en": "On"
  },
  "workspace.modelWeight": {
    "zh": "Model 权重",
    "en": "Model weight"
  },
  "workspace.clipWeight": {
    "zh": "CLIP 权重",
    "en": "CLIP weight"
  },
  "workspace.enabled": {
    "zh": "开关",
    "en": "Enabled"
  },
  "workspace.outsideTheKnownOutputBranch": {
    "zh": "未参与已知输出链",
    "en": "Outside the known output branch"
  },
  "workspace.inTheKnownOutputBranch": {
    "zh": "参与已知输出链",
    "en": "In the known output branch"
  },
  "workspace.outputAssociation": {
    "zh": "输出关联",
    "en": "Output association"
  },
  "workspace.sampler2": {
    "zh": "采样器",
    "en": "Sampler"
  },
  "workspace.scheduler": {
    "zh": "调度器",
    "en": "Scheduler"
  },
  "workspace.recordedSteps": {
    "zh": "记录步数",
    "en": "Recorded steps"
  },
  "workspace.seed": {
    "zh": "种子",
    "en": "Seed"
  },
  "workspace.noiseSeed": {
    "zh": "噪波种子",
    "en": "Noise seed"
  },
  "workspace.denoise": {
    "zh": "去噪强度",
    "en": "Denoise"
  },
  "workspace.samplerNotRecorded": {
    "zh": "采样器未记录",
    "en": "Sampler not recorded"
  },
  "workspace.steps": {
    "zh": " · {p0} 步",
    "en": " · {p0} steps"
  },
  "workspace.effectiveSteps": {
    "zh": "有效步数",
    "en": "Effective steps"
  },
  "workspace.prompt": {
    "zh": "提示词",
    "en": "Prompt"
  },
  "workspace.reliabilityNotRecorded": {
    "zh": "可靠性未记录",
    "en": "Reliability not recorded"
  },
  "workspace.generationSettings": {
    "zh": "生成配置",
    "en": "Generation settings"
  },
  "workspace.settingsScope": {
    "zh": "配置范围",
    "en": "Settings scope"
  },
  "workspace.imageFormat": {
    "zh": "图片格式",
    "en": "Image format"
  },
  "workspace.parseStatus": {
    "zh": "解析状态",
    "en": "Parse status"
  },
  "workspace.settingsScopeNotRecorded": {
    "zh": "配置范围未记录",
    "en": "Settings scope not recorded"
  },
  "workspace.recordedSettingsOutputBranchNotVerified": {
    "zh": "记录配置 · 图片所属输出链未核验",
    "en": "Recorded settings · Output branch not verified"
  },
  "workspace.outputNode": {
    "zh": " · 输出节点 {p0}",
    "en": " · Output node {p0}"
  },
  "workspace.outputBranchSettings": {
    "zh": "输出链配置{p0}",
    "en": "Output branch settings{p0}"
  },
  "workspace.noRecoverableGenerationPromptWasSavedIn": {
    "zh": "图片未保存可恢复的生成提示词",
    "en": "No recoverable generation prompt was saved in this image."
  },
  "workspace.aWorkflowExistsButNoVerifiablePrompt": {
    "zh": "有工作流，但未记录可核验的本图提示词",
    "en": "A workflow exists, but no verifiable prompt was recorded for this image."
  },
  "workspace.metadataStateUnknownPleaseReparse": {
    "zh": "元数据状态未知，请重新解析",
    "en": "Metadata state unknown. Please reparse."
  },
  "workspace.thisImageFormatIsNotSupportedYet": {
    "zh": "暂不支持此图片格式",
    "en": "This image format is not supported yet."
  },
  "workspace.metadataReadFailedFieldsAlreadyReadAre": {
    "zh": "元数据读取失败，已读字段仍保留",
    "en": "Metadata read failed. Fields already read are kept."
  },
  "workspace.readingFinishedNoMetadataWasSaved": {
    "zh": "已完成读取，未保存元数据",
    "en": "Reading finished; no metadata was saved."
  },
  "workspace.metadataSaved": {
    "zh": "已保存元数据",
    "en": "Metadata saved"
  },
  "workspace.notRecorded": {
    "zh": "未记录",
    "en": "Not recorded"
  },
  "workspace.noGenerationSettingsFound": {
    "zh": "未找到生成配置",
    "en": "No generation settings found"
  },
  "workspace.generationSettingsBranchIsUncertain": {
    "zh": "生成配置所属分支不确定",
    "en": "Generation settings branch is uncertain"
  },
  "workspace.generationSettingsPartiallyRecoverable": {
    "zh": "生成配置部分可恢复",
    "en": "Generation settings partially recoverable"
  },
  "workspace.generationSettingsComplete": {
    "zh": "生成配置完整",
    "en": "Generation settings complete"
  },
  "workspace.noReliablePromptFound": {
    "zh": "未找到可靠提示词",
    "en": "No reliable prompt found"
  },
  "workspace.promptBranchIsUncertain": {
    "zh": "提示词所属分支不确定",
    "en": "Prompt branch is uncertain"
  },
  "workspace.promptPartiallyRecoverable": {
    "zh": "提示词部分可恢复",
    "en": "Prompt partially recoverable"
  },
  "workspace.promptComplete": {
    "zh": "提示词完整",
    "en": "Prompt complete"
  },
  "workspace.viewAllPromptsFromThisModel": {
    "zh": "查看该模型的所有 Prompt",
    "en": "View all prompts from this model"
  },
  "workspace.images5": {
    "zh": "📷 {p0}图",
    "en": "{p0} images"
  },
  "workspace.edit": {
    "zh": "编辑",
    "en": "Edit"
  },
  "workspace.copyPrompt": {
    "zh": "{p14} 复制 Prompt",
    "en": "{p14} Copy prompt"
  },
  "workspace.displayNameOptional": {
    "zh": "显示名称（可选）",
    "en": "Display name (optional)"
  },
  "workspace.fullPrompt": {
    "zh": "Prompt 全文",
    "en": "Full prompt"
  },
  "workspace.enterATagAndPressEnter": {
    "zh": "添加标签后回车",
    "en": "Enter a tag and press Enter"
  },
  "workspace.enterALoraAndPressEnterE": {
    "zh": "添加 LoRA 后回车（如 lora:foo:0.8）",
    "en": "Enter a LoRA and press Enter (e.g. lora:foo:0.8)"
  },
  "workspace.personalNotes": {
    "zh": "个人备注",
    "en": "Personal notes"
  },
  "workspace.addPreviewImage": {
    "zh": "{p5} 添加预览图",
    "en": "{p5} Add preview image"
  },
  "workspace.copy2": {
    "zh": "{p13} 复制",
    "en": "{p13} Copy"
  },
  "workspace.scrollToZoomDragToPanDouble": {
    "zh": "滚轮缩放 · 放大后拖动 · 双击恢复适应窗口（百分比相对适应尺寸）",
    "en": "Scroll to zoom · Drag to pan · Double-click to fit (percentage relative to fitted size)"
  },
  "workspace.fit": {
    "zh": "适应 · {p0}%",
    "en": "Fit · {p0}%"
  },
  "workspace.downloadWithoutGenerationMetadata": {
    "zh": "去除生成信息后下载",
    "en": "Download without generation metadata"
  },
  "workspace.downloadOriginal": {
    "zh": "下载原图",
    "en": "Download original"
  },
  "workspace.downloadOptions": {
    "zh": "下载选项",
    "en": "Download options"
  },
  "workspace.copyWithoutGenerationMetadata": {
    "zh": "去除生成信息后复制",
    "en": "Copy without generation metadata"
  },
  "workspace.copyOriginal": {
    "zh": "复制原图",
    "en": "Copy original"
  },
  "workspace.copyOptions": {
    "zh": "复制选项",
    "en": "Copy options"
  },
  "workspace.exportCopy": {
    "zh": "导出副本",
    "en": "Export copy"
  },
  "workspace.downloadSelected": {
    "zh": "批量下载",
    "en": "Download selected"
  },
  "workspace.copySelected": {
    "zh": "批量复制",
    "en": "Copy selected"
  },
  "workspace.categorizeSelected2": {
    "zh": "批量设置分类",
    "en": "Categorize selected"
  },
  "workspace.pinSelected": {
    "zh": "批量置顶",
    "en": "Pin selected"
  },
  "workspace.rateSelected": {
    "zh": "批量评分",
    "en": "Rate selected"
  },
  "workspace.favoriteSelected": {
    "zh": "批量收藏",
    "en": "Favorite selected"
  },
  "workspace.filesSelected": {
    "zh": "已选 {p0} 个文件",
    "en": "{p0} files selected"
  },
  "workspace.viewMetadata": {
    "zh": "查看元数据",
    "en": "View metadata"
  },
  "workspace.downloadWorkflow": {
    "zh": "下载工作流",
    "en": "Download workflow"
  },
  "workspace.copyLoraTags": {
    "zh": "复制 LoRA 标签",
    "en": "Copy LoRA tags"
  },
  "workspace.saveToPromptLibrary2": {
    "zh": "存入 Prompt 库",
    "en": "Save to Prompt Library"
  },
  "workspace.copyPrompt2": {
    "zh": "复制 Prompt",
    "en": "Copy prompt"
  },
  "workspace.copyMetadata": {
    "zh": "复制元数据",
    "en": "Copy metadata"
  },
  "workspace.download": {
    "zh": "下载",
    "en": "Download"
  },
  "workspace.setCategory": {
    "zh": "设置分类",
    "en": "Set category"
  },
  "workspace.pin": {
    "zh": "置顶",
    "en": "Pin"
  },
  "workspace.rate": {
    "zh": "评分",
    "en": "Rate"
  },
  "workspace.selectTheGroupNumberAndCopyIt": {
    "zh": "请选中群号后复制",
    "en": "Select the group number and copy it."
  },
  "workspace.groupNumberCopied": {
    "zh": "群号已复制",
    "en": "Group number copied"
  },
  "workspace.closeReleaseNotes": {
    "zh": "关闭更新日志",
    "en": "Close release notes"
  },
  "workspace.releaseNotes": {
    "zh": "更新日志",
    "en": "Release notes"
  },
  "workspace.shownAutomaticallyOncePerVersionReopenFrom": {
    "zh": "{p2} · 同一版本仅在首次进入时自动显示，可从工具箱菜单再次打开。",
    "en": "{p2} · Shown automatically once per version. Reopen from the Toolkit menu."
  },
  "workspace.dragImagesToPixiv": {
    "zh": "把图片拖到 Pixiv",
    "en": "Drag images to Pixiv"
  },
  "workspace.onLocalChromeOrEdgeDownloadAnd": {
    "zh": "本机 Chrome / Edge：下载并解压接收桥，在浏览器扩展页开启开发者模式，加载解压后的文件夹。安装后刷新工具箱和 Pixiv 两端即可，地址与端口自动识别，无需填 Key。仅添加图片，不会自动投稿。",
    "en": "On local Chrome or Edge: download and extract the bridge, enable Developer mode on the browser extensions page, then load the extracted folder. Refresh both Toolkit and Pixiv after installation. The address and port are detected automatically; no key is needed. Images are attached without submitting a post."
  },
  "workspace.downloadPixivBridge": {
    "zh": "{p3} 下载 Pixiv 接收桥",
    "en": "{p3} Download Pixiv bridge"
  },
  "workspace.qqCommunity": {
    "zh": "QQ 交流群",
    "en": "QQ community"
  },
  "workspace.copyGroupNumber": {
    "zh": "{p5} 复制群号",
    "en": "{p5} Copy group number"
  },
  "workspace.getStarted": {
    "zh": "开始使用",
    "en": "Get started"
  },
  "workspace.builtin.uncategorized": {
    "zh": "未分类",
    "en": "Uncategorized"
  },
  "workspace.builtin.characters": {
    "zh": "人物",
    "en": "Characters"
  },
  "workspace.builtin.artistStyles": {
    "zh": "画师风格",
    "en": "Artist styles"
  },
  "workspace.builtin.backgrounds": {
    "zh": "背景环境",
    "en": "Backgrounds"
  },
  "workspace.builtin.lighting": {
    "zh": "光影氛围",
    "en": "Lighting"
  },
  "workspace.builtin.details": {
    "zh": "细节增强",
    "en": "Details"
  },
  "workspace.builtin.frequent": {
    "zh": "常用",
    "en": "Frequent"
  },
  "workspace.builtin.emotions": {
    "zh": "情绪 / 表情",
    "en": "Emotions / Expressions"
  },
  "workspace.builtin.anime": {
    "zh": "二次元",
    "en": "Anime"
  },
  "workspace.builtin.painterly": {
    "zh": "厚涂",
    "en": "Painterly"
  },
  "workspace.builtin.realistic": {
    "zh": "写实",
    "en": "Realistic"
  },
  "workspace.builtin.ink": {
    "zh": "水墨",
    "en": "Ink"
  },
  "workspace.builtin.monochrome": {
    "zh": "黑白",
    "en": "Monochrome"
  },
  "workspace.builtin.pending": {
    "zh": "待整理",
    "en": "Pending"
  },
  "workspace.builtin.readFailed": {
    "zh": "读取失败",
    "en": "Read failed"
  },
  "workspace.builtin.recognitionFailed": {
    "zh": "识别失败",
    "en": "Recognition failed"
  },
  "workspace.builtin.unrecognized": {
    "zh": "未识别",
    "en": "Unrecognized"
  },
  "workspace.builtin.allImages": {
    "zh": "全部图片",
    "en": "All images"
  },
  "workspace.builtin.subfolder": {
    "zh": "子目录",
    "en": "Subfolder"
  },
  "workspace.builtin.enabledFolders": {
    "zh": "汇总已启用的目录",
    "en": "All enabled folders"
  },
  "workspace.builtin.excludedFolder": {
    "zh": "未加入汇总",
    "en": "Excluded from all images"
  },
  "workspace.builtin.grantAccess": {
    "zh": "点击授权后读取",
    "en": "Click to grant access"
  },
  "workspace.builtin.imageFolder": {
    "zh": "图片目录",
    "en": "Image folder"
  }
} as const
