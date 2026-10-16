// ── Outputs 模块主页面 ──

import { restoreOutputSources, outputSources, sourceForFile, fileSourceIdentity, outputContentKey, outputFileId, readOutputSourceFile, requestOutputSourcePermission, setOutputSource, subscribeOutputSources } from '../services/outputSources'
import { scanOutputSource, refreshOutputSources, cancelOutputScan } from '../services/outputScanner'
import { renderOutputSourcesView, mountOutputSourcesView } from '../renderers/outputSourcesView'
import { backendThumbnailSource, restoreOutputAnnotations, outputPreviewIndex } from '../services/outputPresentation'
import { useOutputStore, outputSummaryForFile, configureOutputQueryExecutor } from '../store/outputStore'
import { createOutputSummaryIndex, type OutputClassification } from '../services/outputSummaryIndex'
import { outputGroups } from '../services/outputQuery'
import { createOutputSummaryReader } from '../services/outputSummaryReader'
import { createOutputSearchClient } from '../services/outputSearchClient'
import { outputGroupedLayout, type OutputLayoutItem } from '../services/outputGroupedLayout'
import { renderOutputFolder, renderOutputBreadcrumb, outputFolderLayout } from '../renderers/outputFolders'
import { setOutputSourceEnabled, removeOutputSource } from '../services/outputSources'
import type { OutputFolder } from '../services/outputBrowser'
import { createOutputDragSession, writeOutputDragData } from '../services/outputDrag'
import { createOutputPainter } from '../components/OutputPainter'
import { saveOutputEdit } from '../services/outputEditSave'
import { observeOutputFreshness } from '../services/outputFreshness'
import { outputFallbackSettings, outputFallbackCatalog, outputFallbackVersion, refreshOutputFallbackCatalog, setOutputFallbackSettings, subscribeOutputFallback, inferOutputFallback } from '../services/outputFallback'
import { deleteFiles, renameFile, batchFavorite, batchRate } from '../services/outputService'
import { scanOutputDir, scanOutputDirIncremental, reparseAllMetadata, readImageMetadata } from '../services/outputScanner'
import { restoreAllFromDb } from '../services/outputManifest'
import { probeBackendThumbs, backendThumbsEnabled, animaThumbUrl, probeGalleryIndex, galleryIndexEnabled, galleryEntries, galleryIndexBuiltAt, galleryParserVersion, galleryIndexParserVersion, galleryOutputRoot, fetchGalleryMeta, fetchGalleryChanges, requestGalleryRefresh, type GalleryChanges, type GalleryEntry } from '../services/outputThumbnail'
import { probeGalleryStatus, galleryStatusAvailable, galleryStatusBusy } from '../services/galleryStatus'
import { hashPath } from '../services/outputManifest'
import { outputsDb } from '../db/outputsDb'
import { addPrompt, generatePromptId } from '../store/prompts'
import { esc, escAttr, showToast, copyText, icon, attachSearchClear, debounce } from '../utils'
import { confirmModal, promptModal } from '../components/Modal'
import { closeLightbox, setupLightboxView, setLightboxViewLocked } from '../components/Lightbox'
import type { OutputFile, OutputMetadata, OutputDir, OutputScanStatus } from '../types/outputs'
import type { PromptEntry } from '../types'
import { extractLorasFromWorkflow, extractLoraTagsFromWorkflow, parseOutputMetadataBlob, outputLoraNames, PARSER_VERSION } from '../services/outputMetadata'
import { bindRawMetadataDetails } from '../renderers/outputGenerationDetails'
import { createImageSnapshot, bindMetadata, backendMetadataMatches, metadataForFile, metadataMatches, outputRootIdentity, promptBody, imageRevision, createMetadataLoader, normalizeOutputPath, commitListSource, listSourceStamp, type ImageSnapshot, type OutputSourceKind } from '../services/outputIdentity'
import { extractPngTextChunks, injectPngTextChunks } from '../services/pngChunks'
import { applyExportMetadata, isExportMetadataNoop } from '../utils/imageMetadata'
import { useExportMetadataStore, exportMetadataOptions, type ExportMetadataMode } from '../store/exportMetadata'
import { createOutputExportSession, compressOutputImage, snapshotExportMetadataPolicy, type OutputExportProgress } from '../services/outputExport'
import { VirtualScroll, type VirtualScrollItemStyle } from '../components/VirtualScroll'
import { MasonryVirtualScroll } from '../components/MasonryVirtualScroll'
import { ImageNodeCache } from '../components/ImageNodeCache'
import { computeMasonryLayout } from '../components/masonry'
import { initOutputDragSelection, type OutputGridGeometry } from './outputDragSelection'
import { nativeOutputUrl, comfyViewUrl, nativeScanOutputs, nativeListOutputs, probeNativeStorage } from '../services/nativeStorage'

import {
  renderList,
  renderEmpty,
  renderFilteredEmpty,
  renderStats,
  renderMetadataPanel,
  renderImageCard,
  STATUS_DEFS,
} from '../renderers/outputRenderer'

import { openContextMenu, closeContextMenu, createOutputContextMenu } from '../components/ContextMenu'

let _initDone = false
let _lastClickedFileIndex = -1
let _currentPreviewFileId = ''
let _focusMode = false
// 当前预览的原图 Blob URL（切换/关闭时 revoke，避免反复预览累积大图内存）
let _previewBlobUrl = ''
let _nativeOutputs = false
let _summaryReader: ReturnType<typeof createOutputSummaryReader> | undefined
let _searchClient: ReturnType<typeof createOutputSearchClient> | undefined
let _classificationVersion = ''
let _indexCanRead = true
let _indexDeferReason = ''
let _indexProgress: { done: number; total: number; deferred: boolean; deferredReason?: string; error: string; stage?: 'metadata' | 'wd14'; running?: boolean } = { done: 0, total: 0, deferred: false, error: '' }
let _currentCardRects = new Map<string, OutputLayoutItem>()
let _lastBrowseKey = ''
let _activeGroupAnchor: string | undefined
let _snapshotFilesRef: OutputFile[] | undefined
const _snapshotFiles = new Map<string, OutputFile>()
let _gallerySyncTask: Promise<boolean> | undefined
let _manualRefreshId = ''
const _newOutputIds = new Set<string>()
let _exportSession: ReturnType<typeof createOutputExportSession> | undefined
const _dragSession = createOutputDragSession({ current: snapshotIsCurrent, metadataPolicy: exportMetadataOptions,
  read: async (snapshot, signal) => (await getFileBlob(snapshot.file.id, snapshot, signal))?.blob || null })
let _dragHover = 0
const _summaryIndex = createOutputSummaryIndex({
  files: () => useOutputStore.getState().files.filter(file => sourceForFile(file).enabled),
  cached: file => outputSummaryForFile(file, useOutputStore.getState().summaryCache),
  metadata: file => cachedImageMetadata(file), snapshot: file => imageSnapshot(file)!, current: snapshotIsCurrent,
  load: ids => outputsDb.summaries.bulkGet(ids), save: rows => outputsDb.summaries.bulkPut(rows),
  publish: rows => { if (rows.length) useOutputStore.getState().setSummaries(rows) },
  read: async (snapshot, signal) => {
    const source = sourceForFile(snapshot.file)
    if (!source.handle || !isOutputsActive()) return null
    _summaryReader ||= createOutputSummaryReader()
    return _summaryReader.read(snapshot, source.handle, signal)
  },
  classify: async (rows, signal) => {
    if (!rows.length) return []
    const response = await fetch('/anima/gallery/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ items: rows.map(row => ({ id: row.imageId, positivePrompt: row.prompt || row.identityPrompt || '', tags: row.manualTags || [], inferredTags: row.inferredTags || [] })) }) })
    if (!response.ok) throw new Error(`本地词库分类 HTTP ${response.status}`)
    const result = await response.json() as { items: OutputClassification[]; version?: string }
    if (result.version) _classificationVersion = result.version
    if (!Array.isArray(result.items)) throw new Error('本地分类返回格式无效')
    return result.items
  },
  canRead: () => isOutputsActive() && (_indexCanRead || _indexDeferReason === 'memory-pressure' && outputFallbackSettings().libraryMatching && outputFallbackCatalog().libraryMatches.count > 0),
  // Explicit metadata reads are sequential and do not load a tagger runtime.
  // Cache-only SHA lookups stay small; actual model inference keeps the budget gate.
  canReadMetadata: manual => isOutputsActive() && (_indexCanRead || manual && _indexDeferReason === 'memory-pressure'),
  deferReason: () => _indexDeferReason,
  fallbackEnabled: () => outputFallbackSettings().enabled && (outputFallbackCatalog().models.includes(outputFallbackSettings().model || outputFallbackCatalog().defaultModel) || outputFallbackSettings().libraryMatching && outputFallbackCatalog().libraryMatches.count > 0),
  fallbackVersion: outputFallbackVersion,
  fallbackIncludeUnrecognized: () => outputFallbackSettings().includeUnrecognized,
  fallback: (snapshot, signal) => inferOutputFallback(snapshot, signal, async () => (await getFileBlob(snapshot.file.id, snapshot, signal))?.blob || null, !_indexCanRead),
  classificationVersion: () => _classificationVersion,
  progress: progress => { _indexProgress = { ...progress, error: progress.error || '' }; syncIndexProgress() },
})
function syncIndexProgress(): void {
  const element = document.getElementById('outputsIndexStatus')
  if (!element) return
  const state = useOutputStore.getState()
  const reason = _indexProgress.deferredReason === 'memory-pressure' ? '内存不足，等待恢复'
    : _indexProgress.deferredReason === 'generation-active' ? '正在生图，等待空闲'
      : _indexProgress.deferredReason === 'tagger-busy' ? 'WD14 正被其他任务使用' : '等待资源或目录授权'
  const text = _indexProgress.error ? `处理待重试：${_indexProgress.error}`
    : _indexProgress.stage === 'wd14' ? `WD14 ${_indexProgress.done}/${_indexProgress.total}${_indexProgress.deferred ? ` · ${reason}` : _indexProgress.running ? ' · 反推中' : ' · 本轮完成'}`
      : _indexProgress.total ? `整理 ${_indexProgress.done}/${_indexProgress.total}${_indexProgress.deferred ? ` · ${reason}` : _indexProgress.running ? ' · 处理中' : ' · 本轮完成'}` : ''
  element.textContent = state.queryPending ? '搜索中…' : text
  const status = document.getElementById('outputsRecognitionStatus'); if (status) status.textContent = text
  const counts = document.getElementById('outputsOrganizationCounts')
  if (counts) {
    let pending = 0, unknown = 0, failed = 0
    const files = state.files.filter(file => sourceForFile(file).enabled)
    for (const file of files) {
      const group = outputGroups(outputSummaryForFile(file, state.summaryCache), 'character')[0]
      if (group.rank === 2) pending++
      else if (group.rank === 3) failed++
      else if (!group.characterId) unknown++
    }
    counts.textContent = `共 ${files.length} 张 · 待整理 ${pending} · 未识别 ${unknown} · 失败 ${failed}`
  }
}
async function syncGalleryCatalog(): Promise<boolean> {
  if (_nativeOutputs) return false
  if (_gallerySyncTask) return _gallerySyncTask
  const task = (async () => {
    const changes = await fetchGalleryChanges()
    if (!changes) return false
    const changed = changes.reset || Object.keys(changes.entries).length > 0 || changes.removed.length > 0
    if (changed) await applyGalleryChanges(changes)
    _outputsWarmupBusy = !!changes.pending && !useOutputStore.getState().files.length
    const refresh = changes.refresh, refreshElement = document.getElementById('outputsRefreshStatus')
    if (refresh && refreshElement && _manualRefreshId && String(refresh.requestId) === _manualRefreshId) {
      refreshElement.textContent = refresh.state === 'complete' ? '目录已核对' : refresh.state === 'failed' ? `核对失败：${refresh.error || '请重试'}`
        : refresh.state === 'deferred' ? `核对待恢复：${refresh.reason || '等待资源'}` : '正在核对 output 目录…'
    }
    const reason = changes.budgetReason || ''
    _indexDeferReason = reason
    const canRead = reason !== 'memory-pressure' && reason !== 'generation-active'
    const resumed = !_indexCanRead && canRead
    _indexCanRead = canRead
    if (changed && isOutputsActive()) renderOutputsView()
    if (changed || resumed || _indexProgress.deferred && canRead) _summaryIndex.schedule()
    return true
  })()
  _gallerySyncTask = task
  try { return await task } finally { if (_gallerySyncTask === task) _gallerySyncTask = undefined }
}
function galleryFile(path: string, entry: GalleryEntry): OutputFile {
  const mtime = Math.round(entry.mtime * 1000)
  return { id: hashPath(path), sourceId: 'output', path, filename: path.split('/').pop() || path, extension: path.split('.').pop()?.toLowerCase() || '',
    size: entry.size, mtime, width: entry.width, height: entry.height, favorite: false, rating: 0, notes: '', tags: [], category: '', status: '', pinned: false, createdAt: mtime }
}
async function applyGalleryChanges(changes: GalleryChanges): Promise<void> {
  const previous = useOutputStore.getState(), existing = new Map(previous.files.map(file => [file.id, file]))
  const removedPaths = new Set(changes.removed)
  const removed = new Set(previous.files.filter(file => (file.sourceId || 'output') === 'output' && removedPaths.has(file.path)).map(file => file.id))
  let files = previous.files.filter(file => (file.sourceId || 'output') !== 'output' || (!changes.reset && !removedPaths.has(file.path)))
  const byKey = new Map(files.map(file => [outputContentKey(file), file]))
  const incoming = Object.entries(changes.entries).map(([path, entry]) => ({ file: galleryFile(path, entry), entry })).filter(({ file }) => !isOutputIdentityDeleted(file.path, file.mtime, file.size, galleryOutputRoot()))
  if (isOutputsActive() && previous.files.length) {
    const previousKeys = new Set(previous.files.map(outputContentKey))
    for (const { file } of incoming) if (!previousKeys.has(outputContentKey(file))) _newOutputIds.add(file.id)
  }
  const saved = await outputsDb.files.bulkGet(incoming.map(row => row.file.id))
  const metadata: OutputMetadata[] = []
  for (let index = 0; index < incoming.length; index++) {
    const { file, entry } = incoming[index]
    const merged = restoreOutputAnnotations(file, existing.get(file.id) || saved[index])
    byKey.set(outputContentKey(file), merged)
    const summary = bindMetadata({ imageId: file.id, model: entry.model || '', prompt: entry.prompt || '', identityPrompt: entry.identityPrompt, seed: entry.seed || '', steps: entry.steps || '', cfg: entry.cfg || '', sampler: entry.sampler || '', vae: '', clipSkip: 0, negativePrompt: '', workflowJson: '', rawMetadata: {}, loras: entry.loras || [], lorasExtracted: true, hasWorkflow: !!entry.hasWorkflow, metadataState: entry.metadataState, metadataWarnings: entry.metadataWarnings, metadataFormat: entry.metadataFormat, summaryStatus: entry.summaryStatus || 'ready' }, createImageSnapshot(merged, 'gallery', galleryOutputRoot(), entry.parserVersion || galleryIndexParserVersion()))
    delete summary.metadataIdentity
    const cached = cachedImageMetadata(merged)
    if (!cached?.metadataIdentity || !metadataMatches(cached, createImageSnapshot(merged, 'gallery', galleryOutputRoot(), changes.parserVersion))) metadata.push(summary)
  }
  files = [...byKey.values()]
  const presentIds = new Set(files.map(file => file.id))
  for (const id of _newOutputIds) if (!presentIds.has(id)) _newOutputIds.delete(id)
  commitListSource('gallery', galleryOutputRoot(), galleryParserVersion())
  setOutputSource('gallery', galleryOutputRoot(), galleryParserVersion())
  useOutputStore.setState({ files, rootPath: galleryOutputRoot(), metadataParserVersion: galleryParserVersion(), selectedIds: new Set([...previous.selectedIds].filter(id => presentIds.has(id))) })
  useOutputStore.getState().putMetadataBatch(metadata)
  if (removed.size) useOutputStore.getState().removeMetadata([...removed])
  useOutputStore.getState().applyFilters()
  await outputsDb.transaction('rw', outputsDb.files, async () => {
    const latest = await outputsDb.files.bulkGet(incoming.map(row => row.file.id))
    await outputsDb.files.bulkPut(incoming.map(({ file }, index) => restoreOutputAnnotations(byKey.get(outputContentKey(file))!, latest[index] || existing.get(file.id))))
  })
}
let _viewEpoch = 0
let _scanActionEpoch = 0
let _previewToken = 0
let _detailToken = 0
let _copyToken = 0
let _currentPreviewSnapshot: ImageSnapshot | null = null
const _thumbnailRevisions = new Map<string, string>()

/**
 * 「刚刚确认从存储层删掉」的记忆 —— **不是**持久屏蔽注册表。
 *
 * 为什么需要它：gallery 模式下列表真源是后端索引（`/anima/gallery/manifest`），
 * 前端删掉文件后后端要等下一轮预热/重建才知道。这中间任何一次
 * 「探测到换代 → 拉全量 manifest → restoreOutputsFromDb() 重建 files」
 * 都会把已删文件加回列表。
 *
 * ⚠️ 但绝不能做成无限期的路径黑名单（用户 2026-10-04 明确纠正）：
 * 路径会被**复用** —— 同一路径下重新生成一张新图是完全正常的操作，
 * 按路径永久屏蔽会把新图一起藏掉，那是比"删除后复活"更严重的数据可见性事故。
 *
 * 因此这里的记录遵守三条硬约束：
 *   ① **按完整图片身份**（路径 + mtime + size + root）记录，不是按路径；
 *      重生成的新图 mtime/size 必然不同 → 身份不匹配 → 立刻正常显示。
 *   ② **有界且自动收敛**：只保留最近 N 条，并且在「store 已不含它」或
 *      「重置/切换图片来源」时立即清除；不做跨会话持久化。
 *   ③ 它只影响 **gallery manifest 重建**这一条路径的准入，不参与任何文件操作判定。
 *
 * 真正让删除持久生效的是后端索引追上（见 syncDeletedToGalleryIndex 显式收敛）。
 */
interface DeletedIdentity { path: string; mtime: number; size: number; root: string; at?: number }
const _deletedIdentities = new Map<string, DeletedIdentity & { at: number }>()
const DELETED_IDENTITY_MAX = 200

function deletedIdentityKey(path: string, mtime: number, size: number, root: string): string {
  return JSON.stringify([normalizeOutputPath(root), normalizeOutputPath(path), mtime, size])
}
/**
 * 登记「这批图片身份确实已从存储层删除」。
 * 只有成功到达 removeEntry 的图片才允许登记（由 deleteFiles 的返回值决定）。
 */
export function markOutputsDeleted(identities: DeletedIdentity[]): void {
  for (const it of identities) {
    if (!it?.path) continue
    _deletedIdentities.set(deletedIdentityKey(it.path, it.mtime, it.size, it.root), { ...it, at: Date.now() })
  }
  // 有界：超出容量即淘汰最老的一条
  if (_deletedIdentities.size > DELETED_IDENTITY_MAX) {
    const ordered = [..._deletedIdentities.entries()].sort((a, b) => a[1].at - b[1].at)
    for (let i = 0; i < ordered.length - DELETED_IDENTITY_MAX; i++) _deletedIdentities.delete(ordered[i][0])
  }
}

/**
 * gallery 重建列表时的准入判定。
 * 只有**完整身份一致**（同路径 + 同 mtime + 同 size + 同 root）才抑制 ——
 * 同路径下重新生成的新图身份不同，照常进列表。
 */
export function isOutputIdentityDeleted(relPath: string, mtime: number, size: number, root: string): boolean {
  return _deletedIdentities.has(deletedIdentityKey(relPath, mtime, size, root))
}

/** 收敛：store 里已经不含该身份（说明这一次重建就是它最后一次出现）→ 立刻忘记 */
function pruneDeletedIdentities(): void {
  if (_deletedIdentities.size === 0) return
  const present = new Set<string>()
  const state = useOutputStore.getState()
  const { root } = currentImageSource()
  for (const f of state.files) present.add(deletedIdentityKey(f.path, f.mtime, f.size, currentImageSource(f).root))
  for (const [k, v] of [..._deletedIdentities]) {
    // 超过 5 分钟一律忘记：避免任何形式的长期屏蔽
    if (Date.now() - v.at > 300_000) { _deletedIdentities.delete(k); continue }
    if (present.has(k)) _deletedIdentities.delete(k)
  }
}

/** 切换图片来源/重置时清空（root 变了旧身份全部失效） */
function clearDeletedIdentities(): void { _deletedIdentities.clear() }

function currentImageSource(file?: OutputFile) {
  const identity = fileSourceIdentity(file || { sourceId: 'output' } as OutputFile)
  return { ...identity, epoch: _viewEpoch }
}

function imageSnapshot(fileOrId: OutputFile | string, path?: string): ImageSnapshot | null {
  const state = useOutputStore.getState()
  const matches = typeof fileOrId === 'string' ? state.files.filter(f => f.id === fileOrId && (path == null || f.path === path)) : [fileOrId]
  const file = matches.length === 1 ? matches[0] : undefined
  if (!file) return null
  const { source, root, parserVersion, epoch } = currentImageSource(file)
  return createImageSnapshot(file, source, root, parserVersion, epoch)
}

function snapshotIsCurrent(snapshot: ImageSnapshot): boolean {
  const current = currentImageSource(snapshot.file)
  const files = useOutputStore.getState().files
  if (_snapshotFilesRef !== files) { _snapshotFilesRef = files; _snapshotFiles.clear(); for (const file of files) _snapshotFiles.set(outputContentKey(file), file) }
  const file = _snapshotFiles.get(outputContentKey(snapshot.file))
  return snapshot.epoch === _viewEpoch && sourceForFile(snapshot.file).enabled && current.source === snapshot.source && current.root === snapshot.root
    && current.parserVersion === snapshot.parserVersion
    && !!file && file.id === snapshot.file.id && file.mtime === snapshot.mtime && file.size === snapshot.size
}

function snapshotFromElement(el: HTMLElement): ImageSnapshot | null {
  const card = el.closest<HTMLElement>('.outputs-card, .outputs-list-card')
  if (card?.dataset.path == null) return null
  const snapshot = imageSnapshot(card.dataset.id || '', card.dataset.path)
  if (!snapshot) return null
  const version = card.querySelector<HTMLImageElement>('img[data-file-version]')?.dataset.fileVersion
  const expected = card.classList.contains('outputs-list-card') ? JSON.stringify([snapshot.root, snapshot.path, snapshot.mtime, snapshot.size]) : imageRevision(snapshot)
  return version === expected ? snapshot : null
}

function cachedImageMetadata(file: OutputFile): OutputMetadata | null {
  const source = currentImageSource(file)
  const state = useOutputStore.getState()
  const metadata = metadataForFile(state.metadataCache, file, source.root, source.parserVersion)
  if (metadata) return metadata
  const row = outputSummaryForFile(file, state.summaryCache)
  if (!row || row.indexStatus !== 'ready') return null
  return { imageId: file.id, model: row.model, prompt: row.prompt, loras: row.loras, hasWorkflow: row.hasWorkflow, metadataState: row.metadataState, metadataWarnings: row.metadataWarnings, lorasExtracted: true,
    summaryStatus: 'ready', seed: '', steps: '', cfg: '', sampler: '', vae: '', clipSkip: 0, negativePrompt: '', workflowJson: '', rawMetadata: {},
    sourceIdentity: { source: source.source, root: source.root, path: file.path, mtime: file.mtime, size: file.size, parserVersion: source.parserVersion } }
}
function cachedImageThumbnail(file: OutputFile): string {
  const snapshot = imageSnapshot(file)
  return snapshot && _thumbnailRevisions.get(outputContentKey(file)) === imageRevision(snapshot) ? useOutputStore.getState().thumbMemory.get(outputContentKey(file)) || '' : ''
}

async function refreshNativeOutputs() {
  await nativeScanOutputs()
  const page = await nativeListOutputs({ limit: 10000, sort: 'date', order: 'desc' })
  const files = page.items.map(item => ({
    ...item,
    width: item.width || 0,
    height: item.height || 0,
    favorite: !!item.favorite,
    pinned: !!item.pinned,
    tags: Array.isArray(item.tags) ? item.tags : [],
  })) as OutputFile[]
  const metadata = page.items.flatMap((item, index) => {
    const meta = item.metadata
    if (!meta) return []
    return [bindMetadata({
      ...meta, imageId: item.id,
      model: meta.model || '', seed: meta.seed || '', steps: meta.steps || '', cfg: meta.cfg || '',
      sampler: meta.sampler || '', scheduler: meta.scheduler, denoise: meta.denoise, noiseSeed: meta.noiseSeed,
      vae: meta.vae || '', clipSkip: meta.clipSkip || 0, prompt: meta.prompt || '',
      negativePrompt: meta.negativePrompt || '', workflowJson: meta.workflowJson || '', rawMetadata: meta.rawMetadata || {},
    } satisfies OutputMetadata, createImageSnapshot(files[index], 'native', 'TK SQLite · ComfyUI/output', PARSER_VERSION))]
  })
  useOutputStore.setState({ dirHandle: null, rootPath: 'TK SQLite · ComfyUI/output', metadataParserVersion: PARSER_VERSION, files: [...files.map(file => ({ ...file, sourceId: 'output' })), ...useOutputStore.getState().files.filter(file => file.sourceId && file.sourceId !== 'output')], metadataCache: new Map([...useOutputStore.getState().metadataCache].filter(([, meta]) => meta.sourceIdentity?.source === 'directory')) })
  // 显式声明：当前列表来自 native 桥
  commitListSource('native', outputRootIdentity('TK SQLite · ComfyUI/output', null), PARSER_VERSION)
  setOutputSource('native', 'TK SQLite · ComfyUI/output', PARSER_VERSION)
  useOutputStore.getState().putMetadataBatch(metadata)
  useOutputStore.getState().applyFilters()
  renderOutputSourcesView()
}

/**
 * 下载工作流 .json（ComfyUI 用 Load 或拖入画布导入最稳妥，替代复制——画布 Ctrl+V 易误导）
 */
async function downloadOutputWorkflow(meta: OutputMetadata | undefined, baseName: string) {
  const workflowJson = meta?.workflowJson || ''
  if (!workflowJson) { showToast('该图片无工作流数据'); return }
  try {
    const safeName = (baseName || 'workflow').replace(/\.png$/i, '').replace(/[\\/:*?"<>|]/g, '_')
    const blob = new Blob([workflowJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = safeName + '.json'
    a.click()
    URL.revokeObjectURL(url)
    showToast('⬇️ 工作流 .json 已下载，拖入 ComfyUI 画布即可导入')
  } catch {
    showToast('⚠️ 下载失败')
  }
}

/**
 * 取「完整元数据」（含 workflowJson / rawMetadata）的统一入口。
 *
 * 背景（2026-09-17 用户反馈："点进工具箱，元数据没解析，要手动点刷新才能提 LoRA 标签"）：
 * Gallery 索引模式下，内存里的条目是**后端摘要**（prompt/loras/model 有，workflowJson 为空），
 * 而"复制 LoRA 标签 / 查看元数据 / 保存到 Prompt 库"要的是**完整工作流**。此前这些路径一律
 * 直读 `outputsDb.metadata`（IndexedDB）—— 但 gallery 模式**从不写 IDB**，于是全部读到空：
 * 用户只能先点「刷新」（走目录句柄扫描、逐张解析 PNG 落 IDB）才拿得到，正是那个"浪费时间"的点。
 *
 * 现在的取用顺序：
 *   ① IndexedDB —— native / 目录句柄模式解析过的完整记录（也含此前本函数回填过的）
 *   ② Gallery 后端 `/anima/gallery/meta?path=` —— 摘要条目按需补全（一次几十 KB，本地毫秒级）
 *      取到后**落 IDB + 回写内存**：同一张再取就是零请求
 *   ③ 都没有 → 调用方自行回落内存摘要（prompt/loras 至少有）
 */
const getImageMetadata = createMetadataLoader({
  read: id => outputsDb.metadata.get(id),
  write: meta => outputsDb.metadata.put(meta),
  publish: meta => useOutputStore.getState().putMetadata(meta),
  isCurrent: snapshotIsCurrent,
  fetch: async snapshot => {
    if (snapshot.source === 'gallery') {
      const full = await fetchGalleryMeta(snapshot.path)
      if (!full || !backendMetadataMatches(full, snapshot)) return null
      return bindMetadata(normalizeGalleryMeta(full, snapshot.file, snapshot.file.id), snapshot)
    }
    if (snapshot.source === 'directory') {
      const dh = sourceForFile(snapshot.file).handle
      return dh ? readImageMetadata(dh, snapshot) : null
    }
    const blob = await getFileBlob(snapshot.file.id, snapshot)
    if (!blob || !snapshotIsCurrent(snapshot)) return null
    const meta = await parseOutputMetadataBlob(blob.blob, snapshot.file.extension, undefined, snapshot.file.filename)
    return meta ? bindMetadata({ ...meta, imageId: snapshot.file.id, rawMetadata: meta.raw, loras: outputLoraNames(meta), lorasExtracted: true }, snapshot) : null
  },
})

/**
 * gallery 条目的内容指纹：**带后端解析器版本**。
 * 为什么必须带版本：图没变（mtime/size 都不变）、只有**提取逻辑**变了时，光看 mtime+size
 * 无法区分新旧结果 —— 后端 `PARSER_VERSION` 一变，指纹跟着变，本地缓存（IndexedDB 回填记录、
 * 内存已提取标记）自然失效并重新解析。实测踩过：只按 mtime/size 做指纹时，
 * 后端改了 prompt 提取逻辑，前端仍长期拿旧结果（用户视角就是"重启了还是老样子"）。
 */
function galleryFingerprint(mtimeMs: number, size: number): string {
  return `g${galleryParserVersion()}:${Math.round(mtimeMs / 1000)}:${size}`
}

/** 后端 meta 响应 → 前端 OutputMetadata（imageId 必须换成前端 hashPath id，后端给的是相对路径）。 */
function normalizeGalleryMeta(full: Record<string, unknown>, file: OutputFile, fileId: string): OutputMetadata {
  const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  const raw = (full.rawMetadata && typeof full.rawMetadata === 'object')
    ? full.rawMetadata as Record<string, string>
    : {}
  return {
    ...(full as Partial<OutputMetadata>), imageId: fileId,
    model: text(full.model), seed: text(full.seed), steps: text(full.steps), cfg: text(full.cfg),
    sampler: text(full.sampler), scheduler: text(full.scheduler), vae: text(full.vae),
    clipSkip: Number(full.clipSkip) || 0,
    prompt: text(full.prompt), identityPrompt: text(full.identityPrompt), negativePrompt: text(full.negativePrompt),
    workflowJson: text(full.workflowJson), rawMetadata: raw,
    loras: Array.isArray(full.loras) ? full.loras as string[] : [],
    hasWorkflow: !!full.hasWorkflow || !!text(full.workflowJson),
    lorasExtracted: true,
    identity: full.identity as OutputMetadata['identity'],
    parserVersion: Number(full.parserVersion) || 0,
    promptStages: full.promptStages as OutputMetadata['promptStages'],
    promptStatus: full.promptStatus as OutputMetadata['promptStatus'],
    promptWarnings: Array.isArray(full.promptWarnings) ? full.promptWarnings.map(String) : [],
    // 与 gallery 摘要同款指纹：同一张图不会因"摘要 → 完整版"的写入把已提取结果判成变了
    workflowFingerprint: galleryFingerprint(file.mtime, file.size),
  }
}

async function loadFullOutputMeta(fileId: string, snapshot?: ImageSnapshot | null): Promise<OutputMetadata | null> {
  return getImageMetadata(snapshot === undefined ? imageSnapshot(fileId) : snapshot)
}

async function copyOutputPrompt(snapshot: ImageSnapshot | null): Promise<void> {
  const token = ++_copyToken
  const meta = await getImageMetadata(snapshot)
  if (token !== _copyToken || !snapshot || !snapshotIsCurrent(snapshot)) return
  const text = promptBody(meta)
  if (!text) { showToast(meta?.promptStatus === 'ambiguous' ? '无法确定本图对应的生成分支，暂不能可靠复制' : '未取得可靠 Prompt，请重试'); return }
  const ok = await writeClipboard(text)
  if (token === _copyToken) showToast(ok ? (meta?.promptStatus === 'partial' ? '已复制已解析的 Prompt；部分连接无法解析' : 'Prompt 已复制到剪贴板') : '复制失败：浏览器拒绝了剪贴板访问')
}

/**
 * 标记「这一张确认取不到元数据」（内存、IDB、gallery 后端都没有）。
 * 目的只有一个：让可见区观察器的早退判据成立（`!hasWorkflow`），
 * 否则这些条目每次进屏都会重新入队 → 反复读盘/请求却永远拿不到结果（实测会刷出上万条日志）。
 * 只写内存，**不写 IDB** —— 后端索引更新后（refreshOutputsFromGallery 会重建 files + 摘要）自动重新收录。
 */
function markMetadataUnavailable(fileId: string): void {
  useOutputStore.getState().putMetadata({
    imageId: fileId, model: '', seed: '', steps: '', cfg: '', sampler: '', scheduler: '',
    vae: '', clipSkip: 0, prompt: '', negativePrompt: '', workflowJson: '', rawMetadata: {},
    loras: [], hasWorkflow: false, lorasExtracted: true, metadataState: 'unknown',
  })
}

/**
 * 写剪贴板（**带兜底与超时**）。
 *
 * 为什么不能直接 `await navigator.clipboard.writeText()`（2026-09-17 实测）：
 * 它在两种真实场景下**既不 resolve 也不 reject，就是一直挂着** —— 页面失焦、或权限被策略拒绝时。
 * 后果是 `await` 之后的 `showToast` 永远不执行 ⇒ **用户点了按钮毫无反应**（既没成功提示也没失败提示）。
 * （实测：在无焦点的自动化上下文里，`clipboard.writeText()` 挂到 CDP 调用超时；同一份代码在人工点击时正常。）
 * 所以：1.2s 超时 + `execCommand('copy')` 回退，并**返回是否成功**，让调用方一定给出反馈。
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    const ok = await Promise.race([
      navigator.clipboard.writeText(text).then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1200)),
    ])
    if (ok) return true
  } catch { /* 被拒绝 → 走下面的回退 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    const done = document.execCommand('copy')
    ta.remove()
    return !!done
  } catch {
    return false
  }
}

export async function initOutputs() {
  if (_initDone) return
  _initDone = true
  await restoreOutputSources()
  mountOutputSourcesView(renderOutputsView)
  let sourceSignature = ''
  subscribeOutputSources(() => {
    const next = JSON.stringify(outputSources().map(source => [source.id, source.enabled, source.permission, source.root, source.parserVersion]))
    if (sourceSignature !== next) { sourceSignature = next; _summaryIndex.cancel(); _summaryIndex.retry() }
    if (_currentPreviewSnapshot && !sourceForFile(_currentPreviewSnapshot.file).enabled) closeLightbox()
    useOutputStore.getState().applyFilters(); renderOutputsView()
  })
  bindOutputsEvents()
  bindOutputsSettingsRefresh()
  bindScanProgressUI()
  syncMetadataButton()
  let renderFrame = 0
  useOutputStore.subscribe((state, previous) => {
    if (state.files !== previous.files || state.metadataVersion !== previous.metadataVersion) _summaryIndex.schedule()
    if (state.filteredFiles !== previous.filteredFiles || state.summaryVersion !== previous.summaryVersion || state.queryPending !== previous.queryPending) {
      if (renderFrame) return
      renderFrame = requestAnimationFrame(() => { renderFrame = 0; if (isOutputsActive()) renderOutputsView(); syncIndexProgress() })
    }
  })
  // Restored directory rows appear before any network probe or new disk scan.
  renderOutputsView()
  _nativeOutputs = await probeNativeStorage()
  await probeBackendThumbs()
  const currentCatalog = await syncGalleryCatalog().catch(() => false)
  if (!currentCatalog) await probeGalleryIndex()
  if (_nativeOutputs) {
    try { await refreshNativeOutputs() } catch { _nativeOutputs = false }
  }
  if (!_nativeOutputs && !currentCatalog) await restoreOutputsFromDb()
  renderOutputsView()
  startOutputsAutoScan()
  bindOutputsExecutionEvents()
  const stopFreshness = observeOutputFreshness(() => scheduleOutputsProbeAfterExecution(180))
  window.addEventListener('pagehide', () => { stopFreshness(); _summaryIndex.dispose(); _summaryReader?.dispose(); _searchClient?.dispose(); _outputImageNodes.clear(); if (_outputsPollTimer !== null) clearInterval(_outputsPollTimer) }, { once: true })
  subscribeOutputFallback(() => {
    _summaryIndex.cancel()
    if (!outputFallbackSettings().enabled) useOutputStore.getState().setSummaries([...useOutputStore.getState().summaryCache.values()].filter(row => row.inferenceStatus === 'pending').map(row => ({ ...row, inferenceStatus: undefined })))
    if (isOutputsActive()) _summaryIndex.retry()
    syncFallbackControls()
  })
  window.addEventListener('focus', triggerOutputsIncrementalScan)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) triggerOutputsIncrementalScan() })
  scheduleOutputsIdleWarmup()
}

// ── 面板启动即预备 outputs 数据（2026-09-15）──
// 用户需求：生完图打开管理页面，直接点 outputs 就能看到全新的图 —— **不需要**先点开别的栏目，
// 更不该等到点了 outputs 才开始加载。所以面板一启动（不管当前在哪个栏目）就在**闲置时**把数据备好。
//
// ⚠️ 首屏红线（同 initOutputs 里 ensureMetadataFresh 的血泪注释）：预热绝不能出现在首屏关键路径上。
//    它只在 requestIdleCallback 里跑、失败静默，且不允许在首屏 await。
let _warmupScheduled = false
let _prepareInflight: Promise<boolean> | null = null

/** 安排一次闲置预热：requestIdleCallback 优先（带 timeout 兜底），不支持时退回 setTimeout 1200ms。 */
function scheduleOutputsIdleWarmup() {
  if (_warmupScheduled) return
  _warmupScheduled = true
  const run = () => {
    void prepareOutputsData().then((ok) => {
      // 用户可能已经切到 outputs（或正停在这里）：把刚落库的数据显出来
      if (isOutputsActive()) renderOutputsView()
      // 数据已就位 → 顺手把**最新这批图**的完整元数据也备好（用户下一步多半就是点进 outputs 复制）
      if (ok) _summaryIndex.schedule()
    })
  }
  if (typeof window.requestIdleCallback === 'function') {
    // timeout：浏览器一直忙（比如正在出图）时也要保证 4s 内跑到，否则「预热」等于没有
    window.requestIdleCallback(run, { timeout: 4000 })
  } else {
    window.setTimeout(run, 1200)
  }
}

/** 数据预备：把 outputs 要用的数据搬进 store。并发去重（同一时刻只跑一条链，避免重复拉 manifest）。 */
function prepareOutputsData(): Promise<boolean> {
  if (_prepareInflight) return _prepareInflight
  const p = runPrepareOutputsData()
  _prepareInflight = p
  void p.then(() => { if (_prepareInflight === p) _prepareInflight = null })
  return p
}

/**
 * 预备本体（失败静默，绝不抛）：
 *   ① store 里已有数据 → 只做一次**极轻**的「索引换代了吗」检查（/anima/gallery/status 纯内存；
 *      老后端退回 /fresh）。换代才真的重拉 manifest —— 一次 16.5MB，绝不白拉。
 *   ② store 还是空的 → 拉一次 manifest 落库（面板刚启动、后端刚预备完的场景），
 *      用户切过去时数据已经在了。TK 原生模式的数据源是 /api/tk，不在这里抢。
 * 返回：现在 store 里有数据吗。
 */
async function runPrepareOutputsData(): Promise<boolean> {
  try {
    if (await syncGalleryCatalog()) return useOutputStore.getState().files.length > 0
    const hasData = useOutputStore.getState().files.length > 0
    if (hasData) {
      // 只有 gallery 索引在用时才有"索引换代"这回事；原生/目录管线由各自的轮询负责
      if (galleryIndexEnabled()) {
        const grew = await probeOutputsGrew()
        if (grew) await refreshOutputsFromGallery()
      }
      return true
    }
    if (_nativeOutputs) return false
    // 索引还没就绪：先问一次纯内存的预备状态 —— 后端正在预备时，用户该看到「后端正在预备新图…」
    // 而不是"没有图片"，并且要在几秒后自动补上（短延时重试链），而不是干等 60s 轮询。
    const status = await probeGalleryStatus()
    if (galleryStatusBusy(status)) {
      const runAt = Number(status?.warmup?.lastRunAt || 0)
      markOutputsWarmupBusy(runAt !== _lastOutputsWarmupRunAt)
      _lastOutputsWarmupRunAt = runAt
      return false
    }
    const ok = await probeGalleryIndex(true)
    if (!ok) return false
    await restoreOutputsFromDb()
    return useOutputStore.getState().files.length > 0
  } catch {
    return useOutputStore.getState().files.length > 0
  }
}

/** 扫描进度订阅：scanStatus 变化时更新进度条（全量扫描/重解析共用，gallery 分支也注册） */
function bindScanProgressUI() {
  let prevScanStatus: OutputScanStatus = 'idle'
  useOutputStore.subscribe((state) => {
    if (state.scanStatus !== prevScanStatus || state.scanStatus === 'scanning') {
      prevScanStatus = state.scanStatus
      updateScanProgress(state.scanStatus, state.scanProgress)
    }
  })
}

// ── 自动增量扫描：生成一张新图后无需手动刷新 ──

let _outputsPollTimer: number | null = null

function isOutputsActive() {
  const sec = document.getElementById('sectionOutputs')
  return !!sec && !sec.classList.contains('section-hidden')
}

function startOutputsAutoScan() {
  if (_outputsPollTimer !== null) return
  _outputsPollTimer = window.setInterval(() => {
    triggerOutputsIncrementalScan()
  }, 4000)
}

async function triggerOutputsIncrementalScan() {
  const s = useOutputStore.getState()
  if (await syncGalleryCatalog().catch(() => false)) {
    if (isOutputsActive() && !document.hidden) await refreshOutputSources({ automatic: true })
    return
  }
  // gallery 索引模式（**无论有没有 TK 原生存储**）：先问后端的「有没有新图」轻量探测，只有真的
  // 新增/换代才拉全量 manifest。这样即使停留在别的栏目（甚至页面被切走）也能把新图准备好，
  // 切回来立即可见。
  // ⚠️ 这段必须放在 _nativeOutputs 判断之外（2026-09-15 修）：此前它嵌在原生分支里，于是
  //    「gallery 索引可用 + 未装 TK 本地存储」这个组合（恰恰是不需要目录授权的主流用法）
  //    **从来没跑过**轻量探测 —— 生完图不点刷新就永远看不到新图。
  if (galleryIndexEnabled() && !outputsProbeDead()) {
    const grew = await probeOutputsGrew()
    if (grew) await refreshOutputsFromGallery()
    if (isOutputsActive()) renderOutputsView()
    return
  }
  if (_nativeOutputs) {
    // TK SQLite 模式：scan 是幂等的增量扫描，隐藏时也跑，数据先就位
    if (s.scanStatus === 'scanning') return
    try {
      await refreshNativeOutputs()
      if (isOutputsActive()) renderOutputsView()
    } catch { /* 静默 */ }
    return
  }

}

// ── 生成完成就后台更新（2026-09-13）──
// 用户反馈：不在 outputs 页面时生成的图不会自动出现，切进来还是旧的。
// 两条触发链：
//   ① ComfyUI 执行事件（executed / execution_success）→ 说明刚刚写了新图，稍等一下再探测；
//   ② 已有的 60s 轮询 + 窗口获焦/可见性变化 → 兜底（比如用 API 或别的客户端出的图）。
// 关键改动：**隐藏时也做探测/扫描**（旧代码在这里 return，正是「不进页面不更新」的原因），
// 但只在不显示时才重渲染，避免干扰用户当前操作。
let _outputsExecProbeTimer: number | null = null

function scheduleOutputsProbeAfterExecution(delayMs = 2500) {
  if (_outputsExecProbeTimer !== null) clearTimeout(_outputsExecProbeTimer)
  _outputsExecProbeTimer = window.setTimeout(() => {
    _outputsExecProbeTimer = null
    void triggerOutputsIncrementalScan()
  }, delayMs)
}

function bindOutputsExecutionEvents() {
  const comfyApp = (window as any).comfyAPI?.app?.app || (window as any).app
  const api = (window as any).comfyAPI?.api
    || (window as any).api
    || (comfyApp && (comfyApp.api || comfyApp.apiImpl))
  if (!api?.addEventListener) return
  const onDone = () => scheduleOutputsProbeAfterExecution()
  // executed：单个输出节点写盘完成；execution_success：整轮结束（批量出图时最后兜一次）
  for (const name of ['executed', 'execution_success', 'execution_cached']) {
    try { api.addEventListener(name, onDone) } catch { /* 旧前端没有该事件 */ }
  }
}

/**
 * gallery 索引模式下的「有没有新图」探测。
 *
 * ① 优先走后端**自驱预备**状态端点 `/anima/gallery/status`（纯内存、不扫盘，比 /fresh 还便宜），
 *    它一次给出 index.builtAt / index.building / warmup.pending —— 正好是这里需要的全部判据；
 * ② 老后端没有该端点（404）时**静默退回** /anima/gallery/fresh（只 stat 文件名，字段不变）；
 * ③ 后端整体不可用（两条端点都没有）时熔断，不再每轮轮询都吃 404。
 *
 * ⚠️ 判据不能只看 changed（磁盘文件数 > 索引里的 total）：
 *   ① 后端重建索引是**后台任务**，探测到 changed 的那一刻索引往往还没建完，
 *      此时拉 manifest 拿到的仍是旧索引；
 *   ② 等它建完后 count 已经追平，changed 又变回 false —— 于是**再也不会来拉**，
 *      新图永远不出现（用户实测：必须手动点刷新）。
 *   所以核心判据是后端返回的 `builtAt`（索引构建时刻）：只要索引换代了就重拉，与 changed 无关；
 *   `building` / `pending` 期间则跳过（等下一轮 builtAt 变了再拉），并安排一次短延时重试。
 */
let _outputsFreshMisses = 0
let _renderedIndexBuiltAt = 0
/** 后端是否正在预备/重建索引（供状态栏与空态提示「后端正在预备新图…」）。 */
let _outputsWarmupBusy = false
/** 上次轻量探测时刻：切栏目时 5s 内不重复问（刚问过就别再问，做到"零请求"直出）。 */
let _lastOutputsProbeAt = 0
/** 上次见到的预热轮次时刻（后端 warmup.lastRunAt）：用来判断"有没有新的一轮预热跑完"。 */
let _lastOutputsWarmupRunAt = 0
/** 「预备中」期间的短延时重试（后端 20s 一轮预热，别让用户等满 60s 的轮询）。 */
let _outputsBusyRetryTimer: number | null = null
let _outputsBusyRetries = 0
const OUTPUTS_BUSY_RETRY_MS = 4000
const OUTPUTS_BUSY_RETRY_MAX = 5

/** 轻量探测是否已整体判死（老插件：/status 与 /fresh 都没有）。判死后 gallery 分支退回目录增量扫描。 */
function outputsProbeDead(): boolean {
  return _outputsFreshMisses >= 3 && !galleryStatusAvailable()
}

/** 预备中重试：4s 后再探一次（最多 5 次 ≈ 20s，正好覆盖后端一轮预热），避免用户白等 60s 轮询。 */
function scheduleOutputsBusyRetry() {
  if (_outputsBusyRetryTimer !== null || _outputsBusyRetries >= OUTPUTS_BUSY_RETRY_MAX) return
  _outputsBusyRetries++
  _outputsBusyRetryTimer = window.setTimeout(() => {
    _outputsBusyRetryTimer = null
    // gallery 管线在用时走常规的探测链；否则（store 还空、索引尚未启用）直接再预备一次，
    // 否则重试会落到目录句柄分支上，等于什么都没做。
    if (galleryIndexEnabled() && !outputsProbeDead()) void triggerOutputsIncrementalScan()
    else void prepareOutputsData().then(() => { if (isOutputsActive()) renderOutputsView() })
  }, OUTPUTS_BUSY_RETRY_MS)
}

/**
 * 标记「后端正在预备」：置状态栏/空态提示 + 安排短延时重试。
 * `runAdvanced` = 后端又跑完一轮预热（有推进）→ 补一次重试额度，
 * 否则长预热（首次建库可达十几秒）会把 5 次额度耗光，用户要白等满 60s 轮询才看到新图。
 */
function markOutputsWarmupBusy(runAdvanced: boolean) {
  if (runAdvanced) _outputsBusyRetries = 0
  _outputsWarmupBusy = true
  scheduleOutputsBusyRetry()
}

/** 后端已把索引做完了 → 解除"预备中"标记与重试计数。 */
function clearOutputsBusy() {
  if (_outputsBusyRetryTimer !== null) { clearTimeout(_outputsBusyRetryTimer); _outputsBusyRetryTimer = null }
  _outputsBusyRetries = 0
  _outputsWarmupBusy = false
}

async function probeOutputsGrew(): Promise<boolean> {
  // 老版后端两个端点都没有：连续失败 3 次后就别再打了（避免每轮轮询都吃一个 404）
  if (_outputsFreshMisses >= 3) return false
  _lastOutputsProbeAt = Date.now()
  try {
    // ① 首选：后端自驱预备状态（纯内存）。拿到就完全按它的判据走，不再打 /fresh。
    const status = await probeGalleryStatus()
    if (status) {
      _outputsFreshMisses = 0
      // 预热轮次（秒级时间戳，只用来判断"后端有没有新的一轮进展"）
      const warmupRunAt = Number(status.warmup?.lastRunAt || 0)
      const warmupRunAdvanced = warmupRunAt !== _lastOutputsWarmupRunAt
      _lastOutputsWarmupRunAt = warmupRunAt
      // 正在重建/预热排队中：此刻拉只会拿到旧索引，本轮跳过（索引做完后 builtAt 会变）
      if (galleryStatusBusy(status)) {
        markOutputsWarmupBusy(warmupRunAdvanced)
        return false
      }
      clearOutputsBusy()
      // ⚠️ builtAt 取**两处里更新**的那个（2026-09-15 实测踩到）：/anima/gallery/status 是纯内存
      //    端点，**不**像 /manifest、/fresh 那样先把内存索引与磁盘对齐；而后台的增量预热是直接
      //    改索引**文件**的。于是 status.index.builtAt 在预热写过盘之后仍是旧值 —— 只认它就会
      //    「后端明明已经索引好了新图，前端却永远不拉」。warmup.lastResult.builtAt 是那一轮
      //    增量更新的真实返回值，两者取 max 才能既不过度拉取、又不漏掉换代。
      const indexBuiltAt = Number(status.index?.builtAt || 0)
      const warmupBuiltAt = Number(status.warmup?.lastResult?.builtAt || 0)
      const builtAt = Math.max(indexBuiltAt, warmupBuiltAt)
      // 预热器刚跑完一轮"真更新"（非 skipped）却没给 builtAt 时的兜底：只要真写了索引，builtAt
      // 必变。按预热轮次去重 —— 同一轮只可能拉一次，绝不会变成每轮轮询都拉 16.5MB。
      const warmupRewrote = warmupBuiltAt === 0 && indexBuiltAt === 0 && warmupRunAdvanced
        && !!status.warmup?.lastResult && !status.warmup.lastResult.skipped
      // 首屏那次 probeGalleryIndex() 已经载入了一份索引，它的 builtAt 由 service 记着；
      // 用它做基准，避免启动后第一次探测就为"比对版本"白拉一次 16.5MB manifest。
      const knownBuiltAt = _renderedIndexBuiltAt || galleryIndexBuiltAt()
      const indexRotated = builtAt > 0 && builtAt !== knownBuiltAt
      // 索引条数比载入的多（后端预热已增量收录新图，但 builtAt 尚未换代时的兜底判据）
      const knownTotal = galleryEntries()?.size || 0
      const indexGrew = Number(status.index?.total || 0) > knownTotal
      if (!indexRotated && !indexGrew && !warmupRewrote) return false
      await probeGalleryIndex(true)   // 强制重拉 manifest（false 会被首次探测后的短路挡住）
      // 基准取**真正载入内存**的那份索引的 builtAt（manifest 返回的权威值），
      // 否则上面那个 max() 会让下一轮又判定"换代了"，变成每轮都拉一次 16.5MB
      _renderedIndexBuiltAt = galleryIndexBuiltAt() || builtAt
      return true
    }

    // ② 老后端：退回 /anima/gallery/fresh（字段不变，语义相同）
    const resp = await fetch('/anima/gallery/fresh', { cache: 'no-store' })
    if (!resp.ok) throw new Error(String(resp.status))
    const data = await resp.json()
    _outputsFreshMisses = 0
    // 正在后台重建：此刻拉只会拿到旧索引，跳过（下一轮 builtAt 会变，那时再拉）
    if (data?.building) {
      markOutputsWarmupBusy(false)   // 老后端没有轮次信息：不补额度，重试次数上限兜底
      return false
    }
    clearOutputsBusy()
    const builtAt = Number(data?.builtAt || 0)
    const knownBuiltAt = _renderedIndexBuiltAt || galleryIndexBuiltAt()
    const indexRotated = builtAt > 0 && builtAt !== knownBuiltAt
    if (!data?.changed && !indexRotated) return false
    await probeGalleryIndex(true)   // 强制重拉 manifest（false 会被首次探测后的短路挡住）
    _renderedIndexBuiltAt = galleryIndexBuiltAt() || builtAt
    return true
  } catch {
    _outputsFreshMisses += 1
    if (_outputsFreshMisses === 3) {
      console.info('[Outputs] 后端轻量探测端点（/anima/gallery/status 与 /fresh）都不可用，退回「切换页面/窗口获焦」刷新')
    }
    return false
  }
}

/** gallery 模式下重新拉全量 manifest 并重渲染（新图就位） */
async function refreshOutputsFromGallery() {
  // 必须 force：否则 probeGalleryIndex 首次成功后永久短路，这里等于什么都没拉
  const ok = await probeGalleryIndex(true)
  if (!ok) return
  await restoreOutputsFromDb()
  if (isOutputsActive()) { renderOutputsView(); updateFilterPanel() }
}


// Activate summary queries and incremental freshness; full metadata is explicit-only.
export async function activateOutputs() {
  void refreshOutputFallbackCatalog().then(syncFallbackControls).catch(error => { const hint = document.getElementById('outputsFallbackHint'); if (hint) hint.textContent = (error as Error).message })
  if (!_initDone) return
  if (!_searchClient) { _searchClient = createOutputSearchClient(); configureOutputQueryExecutor(_searchClient.query); useOutputStore.getState().applyFilters() }
  _summaryIndex.schedule()
  void fetch('/anima/gallery/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }) }).then(async response => {
    if (!response.ok) return
    const result = await response.json()
    if (result.version && result.version !== _classificationVersion) { _classificationVersion = result.version; _summaryIndex.retry() }
  }).catch(() => {})
  renderOutputsView()
  if (_nativeOutputs) {
    try { await refreshNativeOutputs(); renderOutputsView() } catch { /* Retain the last complete list. */ }
  } else if (galleryIndexEnabled()) {
    if (Date.now() - _lastOutputsProbeAt >= 5000) void prepareOutputsData().then(() => { if (isOutputsActive()) renderOutputsView() })
    _summaryIndex.schedule()
  }
  setupInfiniteScroll()
  void triggerOutputsIncrementalScan()
}


function renderOutputsView() {
  renderOutputSourcesView()
  const state = useOutputStore.getState()
  syncIndexProgress()
  const newImages = document.getElementById('outputsNewImages')
  if (newImages) { newImages.hidden = _newOutputIds.size === 0; newImages.textContent = `查看 ${_newOutputIds.size} 张新图` }
  const groupSelect = document.querySelector<HTMLSelectElement>('.outputs-group-select')
  if (groupSelect) groupSelect.value = state.groupMode
  renderImageGrid(state)
  // 同步填充已缓存的缩略图，避免操作后图片闪烁
  document.querySelectorAll('.outputs-card img[data-file-path], .outputs-list-card-img img[data-file-path]').forEach(img => {
    const file = state.files.find(file => file.id === (img as HTMLImageElement).dataset.fileId)
    const cached = file ? cachedImageThumbnail(file) : ''
    if (cached) (img as HTMLImageElement).src = cached
  })
  const location = document.getElementById('outputsLocation')
  if (location) location.innerHTML = renderOutputBreadcrumb(state.browsePath)
  updateOutputsStats(state)
  updateFilterPanel()
  syncSortOrderBtn()
}

/** 仅同步选中的 CSS 类，不重建整个卡片 DOM（性能优化） */
function syncSelectionUI() {
  const selectedIds = useOutputStore.getState().selectedIds
  document.querySelectorAll('.outputs-card, .outputs-list-card').forEach(el => {
    const id = (el as HTMLElement).dataset.id
    if (id) el.classList.toggle('selected', selectedIds.has(id))
  })
}

/** 更新收藏图标（不触发全量重绘） */
function updateFavoriteUI(id: string) {
  const fav = useOutputStore.getState().files.find(f => f.id === id)
  if (!fav) return
  document.querySelectorAll(`[data-id="${id}"] .outputs-fav-btn`).forEach(el => {
    el.textContent = fav.favorite ? '⭐' : '☆'
    el.classList.toggle('active', fav.favorite)
  })
}

/** 更新状态标签 DOM（不触发全量重绘） */
function updateStatusUI(ids: string[], status: string) {
  const st = STATUS_DEFS[status] || null
  const section = document.getElementById('sectionOutputs')
  if (!section) return
  for (const id of ids) {
    // 卡片
    const card = section.querySelector(`.outputs-card[data-id="${id}"]`) as HTMLElement
    if (card) {
      // 更新 class
      for (const cls of card.classList) {
        if (cls.startsWith('status-')) card.classList.remove(cls)
      }
      if (status) card.classList.add(`status-${status}`)
      // 更新标签元素
      let tag = card.querySelector('.outputs-card-status-tag') as HTMLElement
      if (st) {
        if (!tag) {
          tag = document.createElement('div')
          tag.className = 'outputs-card-status-tag'
          card.querySelector('.outputs-card-img')?.prepend(tag)
        }
        tag.style.background = st.color
        tag.textContent = st.label
      } else if (tag) {
        tag.remove()
      }
    }
    // 列表行
    const row = section.querySelector(`.outputs-list-card[data-id="${id}"]`) as HTMLElement
    if (row) {
      const nameCol = row.querySelector('.outputs-list-name') as HTMLElement
      if (nameCol) {
        let dot = nameCol.querySelector('.outputs-list-status-dot') as HTMLElement
        if (st) {
          if (!dot) {
            dot = document.createElement('span')
            dot.className = 'outputs-list-status-dot'
            nameCol.prepend(dot)
          }
          dot.style.background = st.color
          dot.title = st.label
        } else if (dot) {
          dot.remove()
        }
      }
    }
  }
}

// Options consume already extracted metadata, scoped to the selected sources.
const _filterOptModels = new Set<string>()
const _filterOptLoras = new Set<string>()
let _filterOptionsKey = ''
let _filterOptionsFiles: OutputFile[] | undefined

function getOutputCategories(files: OutputFile[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const file of files) {
    if (file.category) counts.set(file.category, (counts.get(file.category) || 0) + 1)
  }
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function updateCategorySelects(state: ReturnType<typeof useOutputStore.getState>) {
  const categories = getOutputCategories(state.files)
  const uncategorized = state.files.filter(file => !file.category).length

  // 顶栏分类导航是唯一的“进入分类”入口；选择后下方网格直接切到该分类。
  const nav = document.querySelector('.outputs-filter-category') as HTMLSelectElement | null
  if (nav) {
    nav.innerHTML = `<option value="">全部图片（${state.files.length}）</option>` +
      `<option value="__none__">未分类（${uncategorized}）</option>` +
      categories.map(({ name, count }) => `<option value="${escAttr(name)}">${esc(name)}（${count}）</option>`).join('')
    nav.value = state.filterCategory || ''
  }

}

function updateFilterPanel() {
  const body = document.getElementById('outputsFilterBody')
  if (!body) return
  const s = useOutputStore.getState()
  const hasAny = s.filterModel || s.filterLora || s.filterDateMin || s.filterDateMax || s.filterQuickPeriod || s.filterStatusFlags.length > 0 || s.filterTag || s.filterCategory

  // 同步输入框值
  const setVal = (cls: string, val: string) => {
    const el = document.querySelector('.' + cls) as HTMLInputElement
    if (el && el.value !== val) el.value = val
  }
  setVal('outputs-filter-model', s.filterModel)
  setVal('outputs-filter-lora', s.filterLora)
  setVal('outputs-filter-date-min', s.filterDateMin)
  setVal('outputs-filter-date-max', s.filterDateMax)

  updateCategorySelects(s)

  // 同步快捷时间段按钮状态
  document.querySelectorAll('.outputs-period-btn').forEach(b => {
    b.classList.toggle('active', (b as HTMLElement).dataset.period === s.filterQuickPeriod)
  })

  // 同步状态标记按钮
  document.querySelectorAll('.outputs-filter-flag-btn').forEach(b => {
    const flag = (b as HTMLElement).dataset.flag
    b.classList.toggle('active', flag ? s.filterStatusFlags.includes(flag) : false)
  })

  const optionsKey = JSON.stringify([s.currentSourceId, s.metadataVersion, s.summaryVersion, outputSources().map(source => [source.id, source.enabled])])
  if (_filterOptionsFiles !== s.files || _filterOptionsKey !== optionsKey) {
    _filterOptionsFiles = s.files; _filterOptionsKey = optionsKey
    _filterOptModels.clear()
    _filterOptLoras.clear()
    for (const file of s.files.filter(file => sourceForFile(file).enabled && (!s.currentSourceId || file.sourceId === s.currentSourceId))) {
      const meta = cachedImageMetadata(file)
      if (!meta) continue
      if (meta.model) _filterOptModels.add(meta.model)
      if (meta.loras) {
        for (const l of meta.loras) _filterOptLoras.add(l)
      }
    }
    const modelList = document.getElementById('outputsModelList')
    if (modelList) modelList.innerHTML = Array.from(_filterOptModels).sort().map(m => `<option value="${escAttr(m)}">`).join('')
    const loraList = document.getElementById('outputsLoraList')
    if (loraList) loraList.innerHTML = Array.from(_filterOptLoras).sort().map(l => `<option value="${escAttr(l)}">`).join('')

    // 有数据时显示筛选组
    const modelGroup = document.getElementById('outputsFilterGroupModel')
    if (modelGroup) modelGroup.style.display = _filterOptModels.size > 0 ? 'block' : 'none'
    const loraGroup = document.getElementById('outputsFilterGroupLora')
    if (loraGroup) loraGroup.style.display = _filterOptLoras.size > 0 ? 'block' : 'none'
  }

  // 显示/隐藏清除按钮
  const clearBtn = document.querySelector('.outputs-filter-clear') as HTMLElement
  if (clearBtn) clearBtn.style.display = hasAny ? 'block' : 'none'
}

// ── 网格/瀑布流虚拟滚动（Perf-1：全量数据虚拟渲染，DOM 只含可视条目）──
let _outputsVS: VirtualScroll | MasonryVirtualScroll | null = null

// 已解码缩略图节点缓存：虚拟滚动 update 会重建行容器，但不能再销毁同一路径的 img。
// dataURL 在内存里并不等于浏览器已完成解码；只有复用原 img 节点才能从根上消除重解码黑帧。
const _outputImageNodes = new ImageNodeCache(600)

type OutputsGeom = OutputGridGeometry

/**
 * 网格几何：与 CSS 网格保持一致（卡片最小宽度来自设置；≤768px 时默认 150px/10px）。
 * 瀑布流下 `cardW` = 单列列宽（常规图宽度就是它），`cols` = 列数（跨列图按 span 取整列宽）。
 */
function outputsGeom(width: number): OutputsGeom {
  const narrow = window.innerWidth <= 768
  const fallbackMin = narrow ? 150 : 200
  const configuredMin = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-min-width'))
  const min = Number.isFinite(configuredMin) && configuredMin > 0 ? configuredMin : fallbackMin
  const configuredGap = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--grid-gap'))
  const gap = Number.isFinite(configuredGap) && configuredGap > 0 ? configuredGap : (narrow ? 10 : 16)
  const cols = Math.max(1, Math.floor((width + gap) / (min + gap)))
  const cardW = (width - (cols - 1) * gap) / cols
  return { cols, gap, cardW }
}

function destroyOutputsVS() {
  if (_outputsVS) { _outputsVS.destroy(); _outputsVS = null }
}

// Outputs 使用虚拟滚动，CSS 变量变化不会自动更新行列数量；合并滑块事件后重算几何。
let outputsSettingsFrame = 0
function bindOutputsSettingsRefresh() {
  window.addEventListener('anima:settings-applied', () => {
    if (outputsSettingsFrame) return
    outputsSettingsFrame = requestAnimationFrame(() => {
      outputsSettingsFrame = 0
      const section = document.getElementById('sectionOutputs')
      if (section && !section.classList.contains('section-hidden') && useOutputStore.getState().viewMode === 'grid') {
        renderOutputsView()
      }
    })
  })
}

function renderImageGrid(state: ReturnType<typeof useOutputStore.getState>) {
  const el = document.querySelector('.outputs-grid') as HTMLElement
  if (!el) return

  // 栏目隐藏时（display:none）容器宽高为 0：跳过渲染，
  // 否则虚拟滚动会按「1 列 + 退化行高」建几何，切进来时图片单行重叠
  // （显示后由 activateOutputs/renderOutputsView 以真实宽度渲染）
  if (el.clientWidth === 0 || el.clientHeight === 0) return
  _outputImageNodes.capture(el)
  const browseKey = JSON.stringify([state.browsePath, state.searchQuery, state.currentPath, state.currentSourceId, state.sortKey, state.sortOrder, state.groupMode, state.filterKey, state.filterModel, state.filterLora, state.filterTag, state.filterCategory, state.filterDateMin, state.filterDateMax])
  const resetPosition = !!_lastBrowseKey && _lastBrowseKey !== browseKey
  _lastBrowseKey = browseKey
  const oldScroll = resetPosition ? 0 : el.scrollTop, viewport = el.getBoundingClientRect()
  const anchors = resetPosition || oldScroll <= 4 ? [] : Array.from(el.querySelectorAll<HTMLElement>('.outputs-card[data-id], .outputs-list-card[data-id], [data-output-group]')).map(node => ({ id: node.dataset.id, group: node.dataset.outputGroup, offset: node.getBoundingClientRect().top - viewport.top, bottom: node.getBoundingClientRect().bottom - viewport.top })).filter(anchor => anchor.bottom > 0).sort((a, b) => {
    const priority = (anchor: typeof a) => anchor.group === _activeGroupAnchor && _activeGroupAnchor ? 0 : anchor.id ? 1 : 2
    return priority(a) - priority(b) || a.offset - b.offset
  })
  _activeGroupAnchor = undefined

  const files = state.filteredFiles
  const folders = state.browserView.folders
  const folderHtml = (folder: OutputFolder) => renderOutputFolder(folder, file => {
    const snapshot = imageSnapshot(file)!, revision = imageRevision(snapshot)
    return { src: backendThumbnailSource(snapshot, backendThumbsEnabled(), path => animaThumbUrl(path, 512), revision) || cachedImageThumbnail(file), key: outputContentKey(file), revision }
  })
  el.classList.toggle('outputs-folder-view', folders.length > 0)
  const hasDir = outputSources().some(source => source.kind === 'directory')

  if (files.length === 0 && folders.length === 0) {
    _currentCardRects.clear()
    destroyOutputsVS()
    removeOutputsSentinel()
    // 库里有图但被筛选/路径滤空 → 给准确空状态 + 一键清除筛选（防"幽灵筛选把历史日期藏掉"的困惑）
    const filtered = state.files.length > 0
    el.innerHTML = filtered ? renderFilteredEmpty() : renderEmpty(hasDir)
    // 索引模式下真·空库：换掉会误导的「选择目录」文案，必要时补「后端正在预备新图…」
    if (!filtered) decorateOutputsEmpty(el)
    el.querySelector<HTMLElement>('#outputsClearFiltersBtn')?.addEventListener('click', () => {
      const st2 = useOutputStore.getState()
      st2.clearAdvancedFilters()
      st2.setFilterKey('all')
      st2.setSearchQuery('')
      st2.setCurrentPath('')
      renderOutputsView()
    })
    return
  }

    if (state.viewMode === 'grid') {
    // ── 网格模式：列填充瀑布流（宽、高都随图片比例）虚拟滚动渲染全量
    //    超宽图跨 2/3 列；缩略图走 thumbMemory 回填 + IntersectionObserver，翻页不闪烁 ──
    const geom = outputsGeom(el.clientWidth)
    // 逐张放入当前最矮的列；跨列组对齐到组内最高列 top（绝不重叠）。布局带缓存，滚动画框选可复用。
    const summaries = new Map(files.map(file => [file.id, outputSummaryForFile(file, state.summaryCache)!]))
    const folderLayout = outputFolderLayout(folders, el.clientWidth)
    const grouped = outputGroupedLayout(files, summaries, 'none', new Set(), geom.cols, geom.cardW, geom.gap)
    for (const item of grouped.items) item.top += folderLayout.total
    const layout = { items: [...folderLayout.items, ...grouped.items] as Array<OutputLayoutItem & { folder?: OutputFolder }>, total: folderLayout.total + grouped.total }
    _currentCardRects = grouped.rects
    const headings = new Map(grouped.items.filter(item => !item.file).map(item => [item.key, item]))
    let desiredScroll = oldScroll
    for (const anchor of anchors) { const item = anchor.id ? grouped.rects.get(anchor.id) : headings.get(anchor.group || ''); if (item) { desiredScroll = item.top - anchor.offset; break } }
    const inner = el.querySelector<HTMLElement>('.masonry-virtual-scroll-inner')
    if (inner) inner.style.height = `${layout.total}px`
    el.scrollTop = Math.max(0, Math.min(desiredScroll, Math.max(0, layout.total - el.clientHeight)))

    // renderItem 只负责卡片内容；二维位置由 MasonryVirtualScroll 的 item rect 承担。
    // 普通 VirtualScroll 会把高度做一维前缀累加，无法表达「多列错位、同一 top 上有多张卡」的瀑布流。
    const renderItem = (index: number, style: VirtualScrollItemStyle) => {
      const s = useOutputStore.getState()
      const item = layout.items[index]
      if (item?.folder) return folderHtml(item.folder)
      if (item && !item.file) return `<button type="button" class="outputs-group-heading ${item.work ? 'work' : ''}" data-output-group="${escAttr(item.key)}" aria-expanded="${!item.collapsed}">${icon(item.collapsed ? 'chevronRight' : 'chevronDown', 14)}<span>${esc(item.label || '')}</span><small>${item.count}</small></button>`
      const f = item?.file
      if (!f) return ''
      const meta = cachedImageMetadata(f)
      // 传「布局实际使用的盒子比例」（极端比例已被上下限截断），而不是原图比例：
      // CSS 用 高度 = 宽度 ÷ 比例 反算高度，两者同源才能保证盒子高度与虚拟滚动
      // 的行几何严格一致（否则被截断的卡会比预算更高，压到下一行）。
      const boxAspect = item.aspect
      // thumbSrc 同步回填内存缩略图：虚拟滚动滚动时条目会被重建，
      // 若等 IntersectionObserver 异步回填会有几帧黑图闪烁
      const snapshot = imageSnapshot(f)!
      return renderImageCard(f, meta ?? null, s.selectedIds.has(f.id), meta?.loras?.length ? meta.loras : undefined, imageRevision(snapshot), backendThumbnailSource(snapshot, backendThumbsEnabled(), path => animaThumbUrl(path, 512), imageRevision(snapshot)) || cachedImageThumbnail(f), boxAspect, outputSummaryForFile(f, s.summaryCache))
    }

    const getItemRect = (index: number) => ({
      top: layout.items[index].top,
      left: layout.items[index].left,
      width: layout.items[index].width,
      height: layout.items[index].height,
    })

    // 布局/内容签名：只放会真正改变「卡片内容或几何」的因素。
    // 刻意不含 thumbMemory —— 缩略图到位时由 loadImageThumbnail 直接改对应 <img>.src，
    // 不需要重建成百上千个节点；一旦重建，图片就会重新请求，首屏必抖。
    // ⚠️ 元数据用 metadataVersion（内容版本号）而不是 metadataCache.size（2026-09-11 修）：
    // 元数据是同 key 覆盖（size 不变）—— 用 size 会让「按需加载到 LoRA 数据」无法触发重建，
    // 卡片 DOM 停在无「复制 LoRA 标签」按钮的旧 HTML 上（用户报的按钮消失/时有时无）。
    const vsSignature = [
      geom.cols, Math.round(geom.cardW), geom.gap,
      files.length, currentImageSource().root, files.map(f => JSON.stringify([f.sourceId, f.path, f.mtime, f.size])).join(','),
      state.selectedIds.size, state.metadataVersion ?? state.metadataCache.size, state.groupMode, state.summaryVersion, [...state.collapsedGroups].join(','), Math.round(layout.total),
      JSON.stringify(folders.map(folder => [folder.key, folder.count, folder.label, folder.subtitle, folder.covers.map(file => [file.id, file.mtime, file.size])])),
    ].join('|')

    if (_outputsVS instanceof MasonryVirtualScroll && el.querySelector('.masonry-virtual-scroll-inner')) {
      el.querySelector('.outputs-empty')?.remove()   // 清掉静态 HTML 占位残留
      _outputsVS.update({
        totalItems: layout.items.length,
        totalHeight: layout.total,
        renderItem,
        getItemRect,
        signature: vsSignature,
      })
    } else {
      destroyOutputsVS()
      removeOutputsSentinel()
      el.innerHTML = ''   // 清空容器（含 index.html 静态 .outputs-empty 占位），VirtualScroll 只 append 不清
      _outputsVS = new MasonryVirtualScroll({
        container: el,
        totalItems: layout.items.length,
        totalHeight: layout.total,
        renderItem,
        getItemRect,
        signature: vsSignature,
        beforeRender: inner => _outputImageNodes.capture(inner),
        afterRender: inner => _outputImageNodes.restore(inner, useOutputStore.getState().thumbMemory),
      })
    }
  } else {
    // ── 列表模式：保持原渲染（整表重建 + 加载更多），哨兵在滚动容器内驱动加载 ──
    destroyOutputsVS()
    _currentCardRects.clear()
    el.innerHTML = `<div class="outputs-folder-list">${folders.map(folderHtml).join('')}</div>` + renderList(files, state.selectedIds, state.metadataCache, currentImageSource().root, currentImageSource().parserVersion, new Map(files.map(file => [file.id, outputSummaryForFile(file, state.summaryCache)!])))
    _outputImageNodes.restore(el, state.thumbMemory)
    // 同步回填已缓存的缩略图，避免重建 DOM 时图片从灰图重新闪烁
    for (const img of el.querySelectorAll('img[data-file-path]')) {
      const p = (img as HTMLImageElement).dataset.filePath
      if (p) {
        const file = files.find(f => f.id === (img as HTMLImageElement).dataset.fileId && f.path === p)
        const cached = file ? cachedImageThumbnail(file) : ''
        if (cached) (img as HTMLImageElement).src = cached
      }
    }
    setupInfiniteScroll()
    if (resetPosition) el.scrollTop = 0
    else {
      let restored = false
      for (const anchor of anchors) {
        const node = [...el.querySelectorAll<HTMLElement>('.outputs-list-card[data-id], [data-output-group]')].find(node => anchor.id ? node.dataset.id === anchor.id : node.dataset.outputGroup === anchor.group)
        if (node) { el.scrollTop += node.getBoundingClientRect().top - viewport.top - anchor.offset; restored = true; break }
      }
      if (!restored) el.scrollTop = Math.min(oldScroll, el.scrollHeight - el.clientHeight)
    }
  }
}


function updateOutputsStats(state: ReturnType<typeof useOutputStore.getState>) {
  const el = document.querySelector('.outputs-stats') as HTMLElement
  if (!el) return
  // 后端正在预备/重建索引时顺带一句人话提示（比让用户对着旧图或空网格猜更好）
  el.innerHTML = renderStats(state.files.filter(file => sourceForFile(file).enabled).length, state.resultCount, state.selectedIds.size)
    + (_outputsWarmupBusy ? outputsWarmupHintHtml() : '')
}

/** 「后端正在预备新图…」提示（状态栏 / 空态共用）。图标走 icon()（禁 emoji），颜色跟随宿主主题变量。 */
function outputsWarmupHintHtml(): string {
  return `<span class="outputs-warmup-hint" style="display:inline-flex;align-items:center;gap:6px;color:var(--text2);font-size:12px">${icon('spinner', 12)}<span>后端正在预备新图…</span></span>`
}

/**
 * gallery 索引模式的空态兜底：索引模式**不需要**目录授权，静态空态那句「选择 ComfyUI 输出目录」
 * 会把人带偏；后端正在预备时更要说明"新图马上到"，而不是让用户对着空网格以为坏了。
 */
function decorateOutputsEmpty(root: HTMLElement) {
  if (!galleryIndexEnabled()) return
  const p = root.querySelector('.outputs-empty p')
  if (!p) return
  p.textContent = _outputsWarmupBusy ? '后端正在预备新图，完成后会自动出现' : '后端索引里还没有图片'
  if (_outputsWarmupBusy) p.insertAdjacentHTML('afterend', outputsWarmupHintHtml())
}

/** Shift+click 范围选中 */
function rangeSelectTo(id: string) {
  const files = useOutputStore.getState().filteredFiles
  const currentIdx = files.findIndex(f => f.id === id)
  if (currentIdx === -1) { _lastClickedFileIndex = -1; return }

  if (_lastClickedFileIndex < 0) {
    // 无上次点击记录 → 只选中当前项
    useOutputStore.getState().clearSelection()
    useOutputStore.getState().toggleSelect(id)
    _lastClickedFileIndex = currentIdx
    return
  }

  const start = Math.min(_lastClickedFileIndex, currentIdx)
  const end = Math.max(_lastClickedFileIndex, currentIdx)
  const ids = files.slice(start, end + 1).map(f => f.id)
  useOutputStore.setState({ selectedIds: new Set(ids) })
}

function bindOutputsEvents() {
  const dragSnapshot = (target: HTMLElement) => { if (target.closest('[data-output-preview-drag]')) return null; const element = target.closest<HTMLElement>('[data-output-drag]'); return element ? imageSnapshot(element.dataset.outputDrag!) : null }
  document.addEventListener('pointerover', event => {
    const snapshot = dragSnapshot(event.target as HTMLElement)
    if (!snapshot || _dragSession.get(snapshot)) return
    clearTimeout(_dragHover)
    _dragHover = window.setTimeout(() => { _dragHover = 0; void _dragSession.prepare(snapshot).catch(error => { if (error.name !== 'AbortError') console.warn('[Outputs] 拖出准备失败', error.message) }) }, 450)
  })
  document.addEventListener('pointerout', event => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-output-drag]'); if (target && !target.contains(event.relatedTarget as Node | null)) { clearTimeout(_dragHover); _dragHover = 0 } })
  document.addEventListener('dragstart', event => {
    if ((event.target as HTMLElement).closest('[data-output-preview-drag]')) {
      const target = _currentPreviewSnapshot
      const copy = target && !_editCropping && !_painter?.active && _editDragSession.get(target)
      if (!copy || !event.dataTransfer) { event.preventDefault(); showToast('正在准备当前编辑结果，就绪后请从“拖出当前图”拖动'); void prepareEditedDrag(); return }
      try { writeOutputDragData(event.dataTransfer, copy) }
      catch (error) { event.preventDefault(); showToast((error as Error).message) }
      return
    }
    const target = event.target as HTMLElement, snapshot = dragSnapshot(target)
    if (!snapshot || !event.dataTransfer) return
    const copy = _dragSession.get(snapshot)
    if (!copy) { event.preventDefault(); showToast('正在准备导出副本，准备好后再次拖出'); void _dragSession.prepare(snapshot).then(result => { if (result) showToast('导出副本已就绪，可以拖出') }).catch(error => { if (error.name !== 'AbortError') showToast(`准备拖出失败：${error.message}`) }); return }
    try { writeOutputDragData(event.dataTransfer, copy) }
    catch (error) { event.preventDefault(); showToast((error as Error).message); return }
    const image = target.closest('[data-output-drag]')?.querySelector('img')
    if (image?.complete && image.naturalWidth) event.dataTransfer.setDragImage(image, Math.min(80, image.clientWidth / 2), Math.min(80, image.clientHeight / 2))
  })
  const openFolder = async (target: HTMLElement) => {
    const st = useOutputStore.getState(), folder = st.browserView.folders.find(row => row.key === target.dataset.outputFolder)
    const epoch = _viewEpoch
    if (!folder) return
    try {
      if (folder.source) {
        if (folder.source.kind === 'directory' && !await requestOutputSourcePermission(folder.source.id)) { showToast('需要授权这个目录才能读取图片'); return }
        if (!folder.source.enabled) await setOutputSourceEnabled(folder.source.id, true)
      }
      if (_viewEpoch !== epoch || useOutputStore.getState().browsePath !== st.browsePath || !isOutputsActive()) return
      st.setBrowsePath([...st.browsePath, folder.step]); renderOutputsView()
    } catch (error) { showToast(`打开目录失败：${(error as Error).message}`) }
  }
  document.addEventListener('dblclick', event => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-output-folder]'); if (target && !(event.target as HTMLElement).closest('button')) { event.preventDefault(); void openFolder(target) } })
  document.addEventListener('keydown', event => { const target = event.target as HTMLElement; if (target.matches('[data-output-folder]') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void openFolder(target) } })
  document.addEventListener('click', event => {
    const target = event.target as HTMLElement
    for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.outputs-more[open]')) if (!menu.contains(target)) menu.open = false
  })
  document.addEventListener('keydown', event => {
    const target = event.target as HTMLElement, menu = target.closest<HTMLDetailsElement>('details.outputs-more')
    if (event.key === 'Escape' && document.querySelector('details.outputs-more[open]')) {
      for (const opened of document.querySelectorAll<HTMLDetailsElement>('details.outputs-more[open]')) { opened.open = false; opened.querySelector<HTMLElement>('summary')?.focus() }
      event.preventDefault(); event.stopImmediatePropagation(); return
    }
    if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && target.tagName !== 'SELECT') {
      menu.open = true
      const controls = [...menu.querySelectorAll<HTMLElement>('.outputs-more-panel button, .outputs-more-panel select')].filter(control => !control.hasAttribute('disabled'))
      const current = controls.indexOf(target), next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : event.key === 'ArrowUp' ? Math.max(0, current - 1) : Math.min(controls.length - 1, current + 1)
      controls[next]?.focus(); event.preventDefault()
    }
  }, { capture: true })
  // 初始化拖拽框选（放在最前面，避免被后续代码的运行时错误阻断）
  initOutputDragSelection({
    getGridGeometry: outputsGeom,
    getCardRects: () => _currentCardRects,
    onSelectionChanged: () => { syncSelectionUI(); updateBatchBar() },
  })
  // 预览图片编辑工具栏（旋转/裁剪/保存）
  bindEditToolbar()
  document.addEventListener('change', event => {
    const input = event.target as HTMLInputElement
    if (!input.id.startsWith('outputsFallback')) return
    try {
      if (input.id === 'outputsFallbackEnabled') setOutputFallbackSettings({ enabled: input.checked })
      else if (input.id === 'outputsFallbackUnrecognized') setOutputFallbackSettings({ includeUnrecognized: input.checked })
      else if (input.id === 'outputsFallbackLibrary') setOutputFallbackSettings({ libraryMatching: input.checked })
      else if (input.id === 'outputsFallbackModel') setOutputFallbackSettings({ model: input.value })
      else if (input.id === 'outputsFallbackThreshold') setOutputFallbackSettings({ threshold: Number(input.value) })
      else if (input.id === 'outputsFallbackCharacterThreshold') setOutputFallbackSettings({ characterThreshold: Number(input.value) })
    } catch (error) { showToast((error as Error).message); syncFallbackControls() }
  })

  // 事件委托 - 单一 click handler
  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    const sourceMenu = target.closest<HTMLElement>('[data-output-source-menu]')
    if (sourceMenu) {
      const source = outputSources().find(row => row.id === sourceMenu.dataset.outputSourceMenu)
      if (!source) return
      const rect = sourceMenu.getBoundingClientRect()
      openContextMenu(rect.right, rect.bottom, [{ items: [
        { label: source.enabled ? '从全部图片汇总中取消' : '加入全部图片汇总', icon: 'checkSquare', handler: () => { void setOutputSourceEnabled(source.id, !source.enabled) } },
        { label: '从图片库移除目录', icon: 'x', handler: () => { void removeOutputSource(source.id).then(() => { if (useOutputStore.getState().currentSourceId === source.id) useOutputStore.getState().setBrowsePath([]); renderOutputsView(); showToast('已移除目录，磁盘图片与收藏评分保留') }) } },
      ] }])
      return
    }
    const depth = target.closest<HTMLElement>('[data-output-depth], [data-output-back]')
    if (depth) { const st = useOutputStore.getState(); st.setBrowsePath(st.browsePath.slice(0, depth.hasAttribute('data-output-back') ? -1 : Number(depth.dataset.outputDepth))); renderOutputsView(); return }
    if (target.closest('[data-output-folder]')) return
    const group = target.closest<HTMLElement>('[data-output-group]')
    if (group) { _activeGroupAnchor = group.dataset.outputGroup; useOutputStore.getState().toggleGroup(group.dataset.outputGroup!); renderOutputsView(); return }
    const cardMore = target.closest<HTMLElement>('.outputs-card-more')
    if (cardMore) { const rectangle = cardMore.getBoundingClientRect(); cardMore.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rectangle.right, clientY: rectangle.bottom })); return }
    if (target.closest('.outputs-export-cancel')) { _exportSession?.cancel(); return }
    if (target.closest('#outputsNewImages')) {
      const state = useOutputStore.getState()
      _newOutputIds.clear(); state.clearAdvancedFilters(); state.setFilterKey('all'); state.setSearchQuery(''); state.setCurrentSource('output'); state.setGroupMode('flat'); state.setSortKey('date'); state.setSortOrder('desc')
      renderOutputsView(); const grid = document.querySelector('.outputs-grid'); if (grid) grid.scrollTop = 0
      return
    }
    const exportAction = target.closest<HTMLElement>('[data-output-export]')
    if (exportAction) {
      const ids = Array.from(useOutputStore.getState().selectedIds)
      const mode = exportAction.dataset.exportMode === 'clean' ? 'clean' : 'original'
      exportAction.closest('details')?.removeAttribute('open')
      await exportOutputs(ids, exportAction.dataset.outputExport === 'copy' ? 'copy' : 'download', mode)
      return
    }
    if (target.closest('.outputs-restore-output-btn')) { await setOutputSourceEnabled('output', true); renderOutputsView(); showToast('已恢复默认 ComfyUI output 目录'); return }
    if (target.closest('.outputs-organize-btn')) {
      _summaryIndex.retry({ reclassify: true, metadataOnly: true })
      showToast('已开始按提示词重新整理全部启用目录；未授权目录请进入文件夹授权')
      return
    }
    if (target.closest('.outputs-fallback-refresh-btn')) {
      try { await refreshOutputFallbackCatalog(); showToast(`找到 ${outputFallbackCatalog().models.length} 个本地 WD14 模型`) }
      catch (error) { showToast(`模型列表读取失败：${(error as Error).message}`) }
      return
    }
    if (target.closest('.outputs-fallback-pause-btn')) {
      setOutputFallbackSettings({ enabled: false }); showToast('WD14 反推已暂停，已完成的识别结果保留'); return
    }
    if (target.closest('.outputs-recognize-unknown-btn')) {
      try {
        await refreshOutputFallbackCatalog()
        const settings = outputFallbackSettings(), catalog = outputFallbackCatalog(), model = settings.model || catalog.defaultModel
        if (!catalog.models.includes(model)) { showToast('请先选择已安装的 WD14 模型'); return }
        setOutputFallbackSettings({ enabled: true, includeUnrecognized: true })
        _summaryIndex.retry({ reinfer: true })
        showToast(`已加入 WD14 识别队列：${model}；正在生图或内存不足时等待`)
      } catch (error) { showToast(`无法启动 WD14：${(error as Error).message}`) }
      return
    }

    // Directory additions extend the catalog and preserve output and other roots.
    if (target.closest('.outputs-select-btn')) {
      const action = ++_scanActionEpoch
      if (!('showDirectoryPicker' in window)) { showCompatMessage(); return }
      try {
        const handle = await (window as any).showDirectoryPicker({ mode: 'read' })
        await scanOutputDir(handle)
        if (action === _scanActionEpoch) renderOutputsView()
      } catch (error) {
        if ((error as Error).name !== 'AbortError') showToast(`添加目录失败：${(error as Error).message || '无法读取'}`)
      }
      return
    }
    if (target.closest('.outputs-cancel-scan-btn')) { _scanActionEpoch++; cancelOutputScan(); renderOutputsView(); showToast('扫描已取消'); return }
    if (target.closest('.outputs-refresh-btn')) {
      const action = ++_scanActionEpoch
      try {
        if (_nativeOutputs) await refreshNativeOutputs()
        else {
          const status = await requestGalleryRefresh()
          _manualRefreshId = String(status?.requestId || '')
          await syncGalleryCatalog()
          const element = document.getElementById('outputsRefreshStatus')
          if (element) element.textContent = status?.state === 'complete' ? '目录已核对' : '正在核对 output 目录…'
        }
        await refreshOutputSources()
        if (action !== _scanActionEpoch || !isOutputsActive()) return
        renderOutputsView()
        _summaryIndex.retry()
        showToast(_nativeOutputs ? '所选目录已刷新' : '已开始核对目录，新图将自动补入')
      } catch (error) { showToast(`刷新失败：${(error as Error).message}`) }
      return
    }
    if (target.closest('.outputs-reparse-btn')) {
      const action = ++_scanActionEpoch
      try {
        const selected = outputSources().filter(source => source.enabled && source.kind === 'directory' && source.handle)
        if (!selected.length) { showToast('output 元数据由后端自动解析；归档目录可添加后重新解析'); return }
        for (const source of selected) {
          if (action !== _scanActionEpoch) return
          await reparseAllMetadata(source.handle!)
        }
        if (action !== _scanActionEpoch || !isOutputsActive()) return
        renderOutputsView()
        showToast('所选目录元数据已更新')
      } catch (error) { showToast(`重新解析失败：${(error as Error).message}`) }
      return
    }

    // 卡片右上角分类入口：已选中的卡片按当前多选集批量归类，否则只处理当前卡片。
    const categoryBtn = target.closest('.outputs-card-category-icon') as HTMLElement
    if (categoryBtn) {
      const id = categoryBtn.dataset.id
      if (id) {
        const selected = useOutputStore.getState().selectedIds
        showCategoryPicker(selected.has(id) && selected.size > 0 ? Array.from(selected) : [id])
      }
      return
    }

    // 收藏按钮（列表视图）
    const favBtn = target.closest('.outputs-fav-btn') as HTMLElement
    if (favBtn) {
      const id = favBtn.dataset.id
      if (id) {
        await useOutputStore.getState().toggleFavorite(id)
        updateFavoriteUI(id)
      }
      return
    }

    // 置顶按钮
    const pinBtn = target.closest('.outputs-pin-btn') as HTMLElement
    if (pinBtn) {
      const id = pinBtn.dataset.id
      if (id) {
        await useOutputStore.getState().togglePinned(id)
        renderOutputsView()
      }
      return
    }

    // 复制按钮
    const copyBtn = target.closest('.outputs-copy-btn') as HTMLElement
    if (copyBtn) {
      const id = copyBtn.dataset.id
      if (id) { copyImageToClipboard(id, snapshotFromElement(copyBtn)); return }
    }

    // 下载按钮
    const downloadBtn = target.closest('.outputs-download-btn') as HTMLElement
    if (downloadBtn) {
      const id = downloadBtn.dataset.id
      if (id) { downloadImage(id, snapshotFromElement(downloadBtn)); return }
    }

    // 复制 Prompt 按钮
    const copyPromptBtn = target.closest('.outputs-copy-prompt-btn') as HTMLElement
    if (copyPromptBtn) {
      await copyOutputPrompt(snapshotFromElement(copyPromptBtn))
      return
    }

    // 保存 Prompt（连同独立图片副本）到 Prompt 库
    const savePromptBtn = target.closest('.outputs-save-prompt-btn') as HTMLElement
    if (savePromptBtn) {
      const id = savePromptBtn.dataset.id
      if (id) await saveOutputPromptToLibrary(id, snapshotFromElement(savePromptBtn))
      return
    }

    // 复制 LoRA 标签按钮（复用统一提取逻辑，与图片解析一致，兼容 UI/API/LoraManager）
    const copyLoraBtn = target.closest('.outputs-copy-lora-btn') as HTMLElement
    if (copyLoraBtn) {
      const id = copyLoraBtn.dataset.id
      if (id) {
        // 完整 workflow（含权重）：IDB 优先，gallery 模式自动从后端按需补全（不再是"必须先点刷新"）
        const full = await loadFullOutputMeta(id, snapshotFromElement(copyLoraBtn))
        if (full?.workflowJson) {
          const tags = extractLoraTagsFromWorkflow(full.workflowJson, full.rawMetadata)
          if (tags.length > 0) {
            const ok = await writeClipboard(tags.join(', '))
            showToast(ok ? `已复制 ${tags.length} 个 LoRA 标签` : '⚠️ 复制失败：浏览器拒绝了剪贴板访问')
          } else {
            showToast('未检测到 LoRA 节点')
          }
        } else {
          showToast('该图片无 LoRA 数据')
        }
      }
      return
    }

    // 下载工作流 JSON 按钮（卡片底部）
    const dlWfBtn = target.closest('.outputs-dl-wf-btn') as HTMLElement
    if (dlWfBtn) {
      const id = dlWfBtn.dataset.id
      if (id) {
        // 完整 workflow：统一入口（IDB → gallery 后端按需）
        const snapshot = snapshotFromElement(dlWfBtn)
        const meta = await loadFullOutputMeta(id, snapshot)
        const file = snapshot?.file
        await downloadOutputWorkflow(meta ?? undefined, file?.filename || 'workflow')
      }
      return
    }

    // 元数据按钮（卡片底部，独立弹窗，不依赖放大预览）
    const metaBtn = target.closest('.outputs-meta-btn') as HTMLElement
    if (metaBtn) {
      const id = metaBtn.dataset.id
      if (id) {
        openMetaPanel(id, snapshotFromElement(metaBtn))
      }
      return
    }

    // 预览按钮
    const previewBtn = target.closest('.outputs-preview-btn') as HTMLElement
    if (previewBtn) {
      const id = previewBtn.dataset.id
      if (id) {
        openPreview(id, snapshotFromElement(previewBtn))
      }
      return
    }

    // 重命名按钮
    const renameBtn = target.closest('.outputs-rename-btn') as HTMLElement
    if (renameBtn) {
      const id = renameBtn.dataset.id
      const oldName = renameBtn.dataset.name
      if (id && oldName) {
        const newName = await promptModal('重命名文件', oldName, '输入新的文件名（包含扩展名）')
        if (newName && newName.trim() && newName.trim() !== oldName) {
          await renameFile(id, newName.trim())
          renderOutputsView()
        }
      }
      return
    }

    // 卡片点击
    const card = target.closest('.outputs-card') as HTMLElement
    if (card && !target.closest('.outputs-card-btn')) {
      const id = card.dataset.id
      if (id) {
        if (e.shiftKey) {
          rangeSelectTo(id)
        } else if (e.ctrlKey || e.metaKey) {
          useOutputStore.getState().toggleSelect(id)
          _lastClickedFileIndex = useOutputStore.getState().filteredFiles.findIndex(f => f.id === id)
        } else {
          const sel = useOutputStore.getState().selectedIds
          if (sel.has(id)) {
            // 点击已选中卡片 → 取消选中（再次点击可取消）
            useOutputStore.getState().toggleSelect(id)
          } else {
            useOutputStore.getState().clearSelection()
            useOutputStore.getState().toggleSelect(id)
          }
          _lastClickedFileIndex = useOutputStore.getState().filteredFiles.findIndex(f => f.id === id)
        }
        syncSelectionUI()
        updateBatchBar()
      }
      return
    }

    // 列表行点击
    const row = target.closest('.outputs-list-card') as HTMLElement
    if (row && !target.closest('.outputs-list-chk') && !target.closest('.outputs-action-btn')) {
      const id = row.dataset.id
      if (id) {
        if (e.shiftKey) {
          rangeSelectTo(id)
        } else if (e.ctrlKey || e.metaKey) {
          useOutputStore.getState().toggleSelect(id)
          _lastClickedFileIndex = useOutputStore.getState().filteredFiles.findIndex(f => f.id === id)
        } else {
          const sel = useOutputStore.getState().selectedIds
          if (sel.has(id)) {
            // 点击已选中行 → 取消选中
            useOutputStore.getState().toggleSelect(id)
          } else {
            useOutputStore.getState().clearSelection()
            useOutputStore.getState().toggleSelect(id)
          }
          _lastClickedFileIndex = useOutputStore.getState().filteredFiles.findIndex(f => f.id === id)
        }
        syncSelectionUI()
        updateBatchBar()
      }
      return
    }

    // 批量操作
    if (target.closest('.outputs-batch-fav-btn')) {
      const ids = Array.from(useOutputStore.getState().selectedIds)
      if (ids.length > 0) {
        await batchFavorite(ids, true)
        ids.forEach(id => updateFavoriteUI(id))
        updateBatchBar()
      }
      return
    }

    if (target.closest('.outputs-batch-unfav-btn')) {
      const ids = Array.from(useOutputStore.getState().selectedIds)
      if (ids.length > 0) {
        await batchFavorite(ids, false)
        ids.forEach(id => updateFavoriteUI(id))
        updateBatchBar()
      }
      return
    }

    if (target.closest('.outputs-batch-delete-btn')) {
      const ids = Array.from(useOutputStore.getState().selectedIds)
      if (ids.length > 0) {
        const confirmed = await confirmModal('批量删除', `确认删除选中的 ${ids.length} 个文件？\n此操作不可撤销！`)
        if (confirmed) {
          await deleteOutputsAndTrack(ids)
          updateBatchBar()
        }
      }
      return
    }

    // 批量评分
    if (target.closest('.outputs-batch-rate-btn')) {
      const ids = Array.from(useOutputStore.getState().selectedIds)
      if (ids.length === 0) return
      showStarPicker(ids, target as HTMLElement)
      return
    }

    // 批量复制
    if (target.closest('.outputs-batch-copy-btn')) {
      const ids = Array.from(useOutputStore.getState().selectedIds)
      if (ids.length > 0) copyImagesToClipboard(ids)
      return
    }

    // 批量下载
    if (target.closest('.outputs-batch-download-btn')) {
      const ids = Array.from(useOutputStore.getState().selectedIds)
      if (ids.length > 0) downloadImagesAsZip(ids)
      return
    }

    // 工具栏：导出元数据开关 + 署名设置
    if (target.closest('.outputs-metadata-btn')) {
      toggleMetadataExport()
      return
    }
    if (target.closest('.outputs-metadata-config-btn')) {
      openMetadataConfigPanel()
      return
    }

    // 工具栏全选按钮（切换选中状态，基准=当前已过滤列表）
    if (target.closest('.outputs-select-all-btn')) {
      const st = useOutputStore.getState()
      const current = st.filteredFiles
      const currentIds = new Set(current.map(f => f.id))
      // 当前过滤列表是否全部选中
      const allSelected = current.length > 0 && current.every(f => st.selectedIds.has(f.id))
      if (allSelected) {
        // 取消：仅移除当前列表内的选中，保留其他页已选
        const next = new Set(st.selectedIds)
        currentIds.forEach(id => next.delete(id))
        useOutputStore.setState({ selectedIds: next })
      } else {
        // 全选：合并当前列表（不丢弃页外已选）
        const next = new Set(st.selectedIds)
        currentIds.forEach(id => next.add(id))
        useOutputStore.setState({ selectedIds: next })
      }
      syncSelectionUI()
      updateBatchBar()
      return
    }

    // 视图切换
    if (target.closest('.outputs-view-grid')) {
      useOutputStore.getState().setViewMode('grid')
      document.querySelector('.outputs-view-grid')?.classList.add('active')
      document.querySelector('.outputs-view-list')?.classList.remove('active')
      renderOutputsView()
      return
    }

    if (target.closest('.outputs-view-list')) {
      useOutputStore.getState().setViewMode('list')
      document.querySelector('.outputs-view-list')?.classList.add('active')
      document.querySelector('.outputs-view-grid')?.classList.remove('active')
      renderOutputsView()
      return
    }

    // 排序切换
    const sortBtn = target.closest('.outputs-sort-btn') as HTMLElement
    if (sortBtn) {
      const key = sortBtn.dataset.sort as any
      useOutputStore.getState().setSortKey(key)
      // 更新 active 状态
      document.querySelectorAll('.outputs-sort-btn').forEach(b => b.classList.remove('active'))
      sortBtn.classList.add('active')
      // 同步排序方向按钮
      syncSortOrderBtn()
      renderOutputsView()
      return
    }

    // 排序方向切换
    if (target.closest('.outputs-sort-order-btn')) {
      useOutputStore.getState().toggleSortOrder()
      syncSortOrderBtn()
      renderOutputsView()
      return
    }

    // 筛选切换
    const filterBtn = target.closest('.outputs-filter-btn') as HTMLElement
    if (filterBtn) {
      const key = filterBtn.dataset.filter as any
      const state = useOutputStore.getState()
      state.setFilterKey(key)
      if (key === 'all' && state.filterCategory) state.setFilterCategory('')
      // 更新 active 状态
      document.querySelectorAll('.outputs-filter-btn').forEach(b => b.classList.remove('active'))
      filterBtn.classList.add('active')
      renderOutputsView()
      return
    }

    // 快捷键提示
    if (target.closest('.outputs-shortcuts-btn')) {
      const existing = document.querySelector('.outputs-shortcuts-popup')
      if (existing) { existing.remove(); return }
      const popup = document.createElement('div')
      popup.className = 'outputs-shortcuts-popup'
      popup.style.cssText = `position:fixed;bottom:60px;right:24px;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px 20px;box-shadow:0 4px 20px rgba(0,0,0,0.3);min-width:300px;font-size:13px;line-height:1.6`
      popup.innerHTML = `<div style="font-weight:700;margin-bottom:10px;font-size:14px;color:var(--text)">⌨️ 快捷键</div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">Ctrl/Cmd+A</kbd></td><td style="color:var(--text);padding:2px 0">全选所有图片</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">Ctrl/Cmd+C</kbd></td><td style="color:var(--text);padding:2px 0">复制选中图片</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">Ctrl/Cmd+D/S</kbd></td><td style="color:var(--text);padding:2px 0">下载选中图片</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">Shift+点击</kbd></td><td style="color:var(--text);padding:2px 0">连续范围选中</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">Delete</kbd></td><td style="color:var(--text);padding:2px 0">删除选中图片</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">F2</kbd></td><td style="color:var(--text);padding:2px 0">重命名文件</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">Q</kbd></td><td style="color:var(--text);padding:2px 0">切换专注模式</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">0-5</kbd></td><td style="color:var(--text);padding:2px 0">设置/取消状态标签（重复按取消）</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">拖拽</kbd></td><td style="color:var(--text);padding:2px 0">框选图片（仅网格区域）</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:var(--text2);white-space:nowrap"><kbd style="background:var(--bg3);padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;border:1px solid var(--border)">Escape</kbd></td><td style="color:var(--text);padding:2px 0">取消所有选中</td></tr>
        </table>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:11px;color:var(--text3)">💡 拖拽框选只作用于图片网格区域，不影响目录树和工具栏</div>`
      document.body.appendChild(popup)
      const close = (e2: MouseEvent) => { if (!popup.contains(e2.target as Node)) { popup.remove(); document.removeEventListener('click', close) } }
      setTimeout(() => document.addEventListener('click', close), 0)
      return
    }

    // 加载更多
    if (target.closest('.outputs-load-more')) {
      useOutputStore.getState().loadMore()
      renderOutputsView()
      return
    }
  })

  // 复选框 change 事件
  document.addEventListener('change', (e) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('outputs-group-select')) { useOutputStore.getState().setGroupMode((target as HTMLSelectElement).value as 'none' | 'work' | 'character'); renderOutputsView(); return }

    if (target.classList.contains('outputs-sort-select')) {
      useOutputStore.getState().setSortKey((target as HTMLSelectElement).value as 'date' | 'name' | 'size')
      renderOutputsView()
    }

    if (target.classList.contains('outputs-list-chk')) {
      const id = (target as HTMLInputElement).dataset.id
      if (id) {
        useOutputStore.getState().toggleSelect(id)
        syncSelectionUI()
        updateOutputsStats(useOutputStore.getState())
        updateBatchBar()
      }
    }
  })

  // ── 元数据面板 ──
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement

    // 查看全部节点
    if (target.closest('#outputsNodeMoreBtn')) {
      document.querySelectorAll('.outputs-node-item.node-hidden').forEach(el => el.classList.remove('node-hidden'))
      const btn = document.getElementById('outputsNodeMoreBtn')
      if (btn) btn.style.display = 'none'
      return
    }

    // 预览上一张/下一张
    // 切换工作流显示
    if (target.closest('#outputsWorkflowToggle')) {
      const content = document.getElementById('outputsWorkflowContent')
      const arrow = document.querySelector('.outputs-workflow-toggle-arrow')
      if (content) {
        content.classList.toggle('outputs-workflow-collapsed')
        content.classList.toggle('outputs-workflow-expanded')
      }
      if (arrow) arrow.classList.toggle('expanded')
      return
    }

    // 空白区域点击：取消选中（不触发重绘）
    // 排除所有交互元素：卡片、按钮、输入框、目录树节点、筛选控件等
    if (target.closest('.outputs-main, .outputs-grid, .outputs-sidebar, .outputs-filter-panel, #outputsDirTree')
      && !target.closest('button, input, select, textarea, .outputs-card, .outputs-list-card, .outputs-card-btn, .outputs-list-chk, .outputs-dir-node, .outputs-toolbar-btn, .outputs-batch-btn, .outputs-filter-input, .outputs-filter-clear, .outputs-shortcuts-btn, .outputs-select-btn, .outputs-refresh-btn, .outputs-search, .outputs-workflow-toggle, .outputs-meta-close-btn, .lb-nav, #outputsNodeMoreBtn, .outputs-sort-btn, .outputs-filter-btn, .outputs-view-grid, .outputs-view-list')) {
      const s = useOutputStore.getState()
      if (s.selectedIds.size > 0) {
        s.clearSelection()
        syncSelectionUI()
        updateBatchBar()
      }
      return
    }
  })

  // ── 直接绑定 lightbox 导航按钮（绕过事件委托可能的问题） ──
  document.querySelectorAll('.lightbox .lb-nav').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const dir = (btn as HTMLElement).classList.contains('prev') ? -1 : 1
      navigatePreview(dir)
    })
  })

  // Shared close lifecycle also covers Escape and backdrop clicks.
  document.getElementById('lightbox')?.addEventListener('lightbox:closed', releaseOutputPreviewResources)

  // ── 右键菜单 ──
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement

    // 只处理 outputs 模块内部
    if (!target.closest('#sectionOutputs')) return

    // 找到被右键的图片卡片或列表行
    const card = target.closest('.outputs-card') as HTMLElement
    const row = target.closest('.outputs-list-card') as HTMLElement
    const el = card || row
    let fileIds: string[] = []

    if (el) {
      const id = el.dataset.id
      if (id) {
        const state = useOutputStore.getState()
        if (state.selectedIds.has(id)) {
          // 右键已选中的图片 → 对所有选中项执行批量操作
          fileIds = Array.from(state.selectedIds)
        } else {
          fileIds = [id]
        }
      }
    } else if (target.closest('.outputs-grid') || target.closest('.outputs-main')) {
      // 右键空白区域 — 如果有选中项则操作选中项
      const state = useOutputStore.getState()
      if (state.selectedIds.size > 0) {
        fileIds = Array.from(state.selectedIds)
      }
    }

    if (fileIds.length === 0) return

    e.preventDefault()

    const contextSnapshot = el ? snapshotFromElement(el) : null
    const contextTarget = (id: string) => contextSnapshot?.file.id === id ? contextSnapshot : imageSnapshot(id)
    const groups = createOutputContextMenu(fileIds, {
      onPreview: (id) => openPreview(id, contextTarget(id)),
      onFavorite: (id) => {
        useOutputStore.getState().toggleFavorite(id)
        updateFavoriteUI(id)
      },
      onRename: async (id) => {
        const file = useOutputStore.getState().files.find(f => f.id === id)
        if (!file) return
        const newName = await promptModal('重命名文件', file.filename, '输入新的文件名（包含扩展名）')
        if (newName && newName.trim() && newName.trim() !== file.filename) {
          await renameFile(id, newName.trim())
          renderOutputsView()
        }
      },
      onDelete: async (id) => {
        const confirmed = await confirmModal('删除文件', '确认删除这个文件？\n此操作不可撤销！')
        if (confirmed) {
          await deleteOutputsAndTrack([id])
        }
      },
      onCopyMetadata: async (id) => {
        // 按需读取这一张（内存未命中就单条回 DB），不再依赖全库预载
        const meta = await getImageMetadata(contextTarget(id))
        if (meta) {
          copyText(JSON.stringify(meta, null, 2))
          showToast('元数据已复制')
        }
      },
      onCopyPrompt: async (id) => {
        await copyOutputPrompt(contextTarget(id))
      },
      onSavePrompt: id => { void saveOutputPromptToLibrary(id, contextTarget(id)) },
      onCopyLoras: async id => { const meta = await getImageMetadata(contextTarget(id)); const tags = meta?.workflowJson ? extractLoraTagsFromWorkflow(meta.workflowJson, meta.rawMetadata) : []; if (tags.length) { const ok = await writeClipboard(tags.join(', ')); showToast(ok ? `已复制 ${tags.length} 个 LoRA 标签` : '剪贴板访问被拒绝') } else showToast('该图片没有已记录的 LoRA') },
      onWorkflow: async id => { const meta = await getImageMetadata(contextTarget(id)); await downloadOutputWorkflow(meta || undefined, contextTarget(id)?.file.filename || 'workflow') },
      onMetadata: id => { void openMetaPanel(id, contextTarget(id)) },
      onExport: (ids, action, mode) => { void exportOutputs(ids, action, mode, contextSnapshot) },
      onRate: (id) => {
        showStarPicker(id)
      },
      onBatchFavorite: (ids) => {
        batchFavorite(ids, true)
        renderOutputsView()
      },
      onBatchDelete: async (ids) => {
        const confirmed = await confirmModal('批量删除', `确认删除选中的 ${ids.length} 个文件？\n此操作不可撤销！`)
        if (confirmed) {
          await deleteOutputsAndTrack(ids)
        }
      },
      onBatchRate: (ids) => {
        showStarPicker(ids)
      },
      onPin: async (id) => {
        await useOutputStore.getState().togglePinned(id)
        renderOutputsView()
      },
      onBatchPin: async (ids) => {
        await useOutputStore.getState().batchPin(ids)
        renderOutputsView()
      },
      onCopyImage: (id) => { copyImageToClipboard(id, contextTarget(id)) },
      onDownloadImage: (id) => { downloadImage(id, contextTarget(id)) },
      onBatchCopyImage: (ids) => { copyImagesToClipboard(ids) },
      onBatchDownloadImage: (ids) => { downloadImagesAsZip(ids) },
      onSetCategory: (ids) => { showCategoryPicker(ids) },
    })

    openContextMenu(e.clientX, e.clientY, groups)
  })

  // ── 键盘快捷键 ──
  document.addEventListener('keydown', (e) => {
    const section = document.getElementById('sectionOutputs')
    if (!section || section.classList.contains('section-hidden')) return
    // 在输入框中输入时不触发快捷键
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    // F2: 重命名当前选中的文件
    if (e.key === 'F2') {
      const state = useOutputStore.getState()
      if (state.selectedIds.size === 1) {
        const id = Array.from(state.selectedIds)[0]
        const file = state.files.find(f => f.id === id)
        if (file) {
          e.preventDefault()
          promptModal('重命名文件', file.filename, '输入新的文件名（包含扩展名）').then(newName => {
            if (newName && newName.trim() && newName.trim() !== file.filename) {
              renameFile(id, newName.trim()).then(() => renderOutputsView())
            }
          })
        }
      }
    }

    // Delete: 删除选中的文件
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const state = useOutputStore.getState()
      if (state.selectedIds.size > 0) {
        e.preventDefault()
        confirmModal('批量删除', `确认删除选中的 ${state.selectedIds.size} 个文件？\n此操作不可撤销！`).then(confirmed => {
          if (confirmed) {
            const ids = Array.from(state.selectedIds)
            deleteOutputsAndTrack(ids)
          }
        })
      }
    }

    // Ctrl+A: 全选
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      const keyboardTarget = e.target as HTMLElement
      if (keyboardTarget.closest('.outputs-main') || keyboardTarget.closest('.outputs-grid')) {
        e.preventDefault()
        useOutputStore.getState().selectAll()
        syncSelectionUI()
        updateBatchBar()
      }
      return
    }

    // 专注模式: Q
    if (e.key === 'q' || e.key === 'Q') {
      const section = document.getElementById('sectionOutputs')
      if (!section || section.classList.contains('section-hidden')) return
      _focusMode = !_focusMode
      section.classList.toggle('outputs-focus', _focusMode)
      return
    }

    // 状态标签: 0 清除, 1-5 设置
    const statusKey = e.key as string
    if (/^[0-5]$/.test(statusKey)) {
      const section = document.getElementById('sectionOutputs')
      if (!section || section.classList.contains('section-hidden')) return
      const state = useOutputStore.getState()
      const ids = Array.from(state.selectedIds)
      if (ids.length === 0) return
      const statusMap = ['', 'approved', 'review', 'edit', 'rejected', 'select']
      const newStatus = statusMap[parseInt(statusKey)]
      // 如果选中文件已有该标签则取消，否则设置
      const first = state.files.find(f => f.id === ids[0])
      const status = (first?.status === newStatus) ? '' : newStatus
      for (const id of ids) {
        state.setStatus(id, status)
      }
      updateStatusUI(ids, status)
      return
    }

    // 收藏: F
    if (e.key === 'f' || e.key === 'F') {
      const section = document.getElementById('sectionOutputs')
      if (!section || section.classList.contains('section-hidden')) return
      const state = useOutputStore.getState()
      if (state.selectedIds.size === 1) {
        const id = Array.from(state.selectedIds)[0]
        state.toggleFavorite(id).then(() => {
          // 只更新对应卡片的星星图标
          updateFavoriteUI(id)
        })
      }
      return
    }

    // 置顶: P
    if (e.key === 'p' || e.key === 'P') {
      const section = document.getElementById('sectionOutputs')
      if (!section || section.classList.contains('section-hidden')) return
      const state = useOutputStore.getState()
      const ids = Array.from(state.selectedIds)
      if (ids.length === 0) return
      if (ids.length === 1) {
        state.togglePinned(ids[0]).then(() => renderOutputsView())
      } else {
        state.batchPin(ids).then(() => renderOutputsView())
      }
      return
    }

    // Escape: 取消选中
    if (e.key === 'Escape') {
      const section = document.getElementById('sectionOutputs')
      if (!section || section.classList.contains('section-hidden')) return
      if (useOutputStore.getState().selectedIds.size > 0) {
        useOutputStore.getState().clearSelection()
        syncSelectionUI()
        updateBatchBar()
      }
      return
    }

    // 预览左右切换
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const lightbox = document.getElementById('lightbox')
      if (lightbox?.classList.contains('open')) {
        e.preventDefault()
        navigatePreview(e.key === 'ArrowLeft' ? -1 : 1)
      }
      return
    }

    // Ctrl+C 复制（让 copy 事件统一处理，此处不拦截以免阻止 copy 事件触发）
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const activeEl = document.activeElement
      if (activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA') return
      const st = useOutputStore.getState()
      if (st.selectedIds.size === 0) return
      return
    }

    // Ctrl+D/S 下载
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D' || e.key === 's' || e.key === 'S')) {
      const st = useOutputStore.getState()
      if (st.selectedIds.size === 0) return
      e.preventDefault()
      if (st.selectedIds.size === 1) downloadImage(Array.from(st.selectedIds)[0])
      else downloadImagesAsZip(Array.from(st.selectedIds))
      return
    }
  })

  // 搜索
  const searchInput = document.querySelector('.outputs-search') as HTMLInputElement
  if (searchInput) {
    let debounce: ReturnType<typeof setTimeout>
    let composing = false
    const search = () => {
      clearTimeout(debounce)
      if (composing) return
      debounce = setTimeout(() => {
        useOutputStore.getState().setSearchQuery(searchInput.value)
        renderOutputsView()
        if (searchInput.value.trim()) _summaryIndex.schedule()
      }, 150)
    }
    searchInput.addEventListener('compositionstart', () => { composing = true; clearTimeout(debounce) })
    searchInput.addEventListener('compositionend', () => { composing = false; search() })
    searchInput.addEventListener('input', search)
    attachSearchClear(searchInput, () => {
      useOutputStore.getState().setSearchQuery('')
      renderOutputsView()
    })
  }

  // 虚拟网格预取：行会在进入屏幕前就被渲染，提前读取缩略图可避免快速滚动时先露出黑色容器。
  const grid = document.querySelector('.outputs-grid') as HTMLElement | null
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const img = entry.target as HTMLImageElement
        const fileId = img.dataset.fileId
        const filePath = img.dataset.filePath
        if (fileId && filePath) {
          loadImageThumbnail(img, fileId, filePath)
          requestVisibleMetadata(fileId, img.dataset.filePath)   // 元数据按需：只读这一张（含 LoRA 提取）
        }
        observer.unobserve(img)
      }
    }
  }, { root: grid, rootMargin: '600px 0px' })

  // 观察所有图片
  const observeImages = () => {
    let dbgObserved = 0, dbgDirect = 0
    document.querySelectorAll<HTMLImageElement>('#outputsGrid img[data-file-id]').forEach(img => {
      const id = img.dataset.fileId
      // renderImageCard 已同步写入 thumbMemory 命中项；不要再观察并重复设置相同 src，
      // 某些 Chromium 版本会因此重新走图片解码管线，造成一次黑帧。
      if (img.getAttribute('src')) {
        // 缩略图已就绪（thumbMemory 命中）→ 不重复观察，但**元数据仍要按需加载**：
        // 否则这些卡片拿不到 meta.loras，「复制 LoRA 标签」按钮永不出现（2026-09-11 修）。
        // requestVisibleMetadata 内部有「已提取/无需提取」早退与排队去重，可安全重复调用。
        dbgDirect++
        if (id) requestVisibleMetadata(id, img.dataset.filePath)
        return
      }
      dbgObserved++
      observer.observe(img)
    })
    if (META_DBG) console.log('[meta-dbg] observeImages', { observed: dbgObserved, direct: dbgDirect })
  }

  // 使用 MutationObserver 监听 DOM 变化
  if (grid) {
    const mutObs = new MutationObserver(observeImages)
    mutObs.observe(grid, { childList: true, subtree: true })
    observeImages()
  }

  // ── 高级筛选事件 ──
  // 折叠/展开
  document.getElementById('outputsFilterToggle')?.addEventListener('click', () => {
    const body = document.getElementById('outputsFilterBody')
    const arrow = document.querySelector('.outputs-filter-toggle-arrow')
    if (!body) return
    body.classList.toggle('collapsed')
    arrow?.classList.toggle('expanded')
  })

  // 筛选输入（防抖）
  const filterInputs = ['outputs-filter-model', 'outputs-filter-lora', 'outputs-filter-date-min', 'outputs-filter-date-max']
  filterInputs.forEach(cls => {
    const el = document.querySelector('.' + cls) as HTMLInputElement
    if (!el) return
    let timer: ReturnType<typeof setTimeout>
    el.addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const val = el.value
        const s = useOutputStore.getState()
        if (cls === 'outputs-filter-model') s.setFilterModel(val)
        else if (cls === 'outputs-filter-lora') s.setFilterLora(val)
        else if (cls === 'outputs-filter-date-min') s.setFilterDateMin(val)
        else if (cls === 'outputs-filter-date-max') s.setFilterDateMax(val)
        renderOutputsView()
        // 基座模型 / LoRA 属于**全库**筛选（applyFilters 会排除元数据未加载的条目）→
        // 只有用户真正用到它们时才补齐全库元数据，进入页面时不再预载。
        if (val && (cls === 'outputs-filter-model' || cls === 'outputs-filter-lora')) {
          _summaryIndex.schedule()
        }
      }, 300)
    })
  })

  // 快捷时间段按钮
  document.querySelectorAll('.outputs-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const period = (btn as HTMLElement).dataset.period || ''
      useOutputStore.getState().setFilterQuickPeriod(period)
      renderOutputsView()
    })
  })

  // 状态标记按钮
  document.querySelectorAll('.outputs-filter-flag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const flag = (btn as HTMLElement).dataset.flag
      if (!flag) return
      const s = useOutputStore.getState()
      const flags = [...s.filterStatusFlags]
      const idx = flags.indexOf(flag)
      if (idx >= 0) flags.splice(idx, 1)
      else flags.push(flag)
      s.setFilterStatusFlags(flags)
      renderOutputsView()
    })
  })

  // 清除筛选
  document.querySelector('.outputs-filter-clear')?.addEventListener('click', () => {
    useOutputStore.getState().clearAdvancedFilters()
    // 清空输入框的值
    document.querySelectorAll('.outputs-filter-input').forEach(el => {
      (el as HTMLInputElement).value = ''
    })
    document.querySelector('.outputs-filter-clear')?.setAttribute('style', 'display:none;margin-top:8px;width:100%')
    renderOutputsView()
  })

  // 分类筛选下拉
  document.querySelector('.outputs-filter-category')?.addEventListener('change', (e) => {
    const state = useOutputStore.getState()
    state.setFilterKey('all')
    state.setFilterCategory((e.target as HTMLSelectElement).value)
    document.querySelectorAll('.outputs-filter-btn').forEach(button => {
      button.classList.toggle('active', (button as HTMLElement).dataset.filter === 'all')
    })
    renderOutputsView()
  })

  // 管理分类按钮
  document.querySelector('.outputs-category-manage-btn')?.addEventListener('click', () => {
    showCategoryManager()
  })

  // ── Copy 事件兜底（防止浏览器默认复制选中 DOM，避免与 keydown 重复执行） ──
  let _copying = false
  document.addEventListener('copy', (e) => {
    const section = document.getElementById('sectionOutputs')
    if (!section || section.classList.contains('section-hidden')) return
    // 焦点在输入框/文本域/可编辑区时（如重命名弹窗选文件名复制）：放行浏览器默认复制，不劫持成复制图片。
    const ae = document.activeElement as HTMLElement | null
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
    const st = useOutputStore.getState()
    if (st.selectedIds.size === 0 || _copying) return
    e.preventDefault()
    _copying = true
    copyImagesToClipboard(Array.from(st.selectedIds)).finally(() => { _copying = false })
  })

  // ── 无限滚动 ──
  setupInfiniteScroll()

  // 网格虚拟滚动的行几何随窗口宽度变化 → 重渲染（虚拟行宽/列数需重建）
  window.addEventListener('resize', debounce(() => {
    const section = document.getElementById('sectionOutputs')
    if (section && !section.classList.contains('section-hidden') && useOutputStore.getState().viewMode === 'grid') {
      renderOutputsView()
    }
  }, 200))
}

/** 移除无限滚动哨兵（网格模式用内部滚动监听，不需要它） */
function removeOutputsSentinel() {
  const old = document.querySelector('.outputs-scroll-sentinel') as HTMLElement | null
  if (old) {
    const grid = old.parentElement as HTMLElement | null
    ;(grid as any)?._outputsSentinelIO?.disconnect()
    delete (grid as any)?._outputsSentinelIO
    old.remove()
  }
}

function setupInfiniteScroll() {
  // 网格模式：内部滚动容器自己驱动 loadMore（见 renderImageGrid），不需要哨兵
  if (useOutputStore.getState().viewMode === 'grid') {
    removeOutputsSentinel()
    return
  }

  // 列表模式：grid 是内部滚动容器 → 哨兵放容器末尾
  const grid = document.querySelector('.outputs-grid') as HTMLElement | null
  // 清理旧观察器（renderList 每次 innerHTML 重建会清掉哨兵，这里幂等重建）
  ;(grid as any)?._outputsSentinelIO?.disconnect()
  let sentinel = document.querySelector('.outputs-scroll-sentinel') as HTMLElement | null
  if (!sentinel) {
    sentinel = document.createElement('div')
    sentinel.className = 'outputs-scroll-sentinel'
    if (grid) grid.appendChild(sentinel)
  }

  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      const state = useOutputStore.getState()
      if (state.hasMore && !state.loading) {
        state.loadMore()
        // 渲染新的一批
        renderOutputsView()
        // 批量后台加载 metadata
        // 元数据不再在这里批量补齐：新渲染出的卡片由可见区观察器按需读（见 requestVisibleMetadata）
      }
    }
  }, { rootMargin: '400px' })

  observer.observe(sentinel)
  if (grid) (grid as any)._outputsSentinelIO = observer
}

// ── 元数据按需加载（2026-09-10：取代「进入页面全库预载」）──

/** /anima/thumb 覆盖不到的路径（非 output 目录的授权扫描）：会话内直接走旧管线 */
const _thumbUrlBlocked = new Set<string>()
const META_DBG = (() => { try { return new URLSearchParams(location.search).has('metaDbg') } catch { return false } })()

/**
 * 可见卡片进屏时按需读它的元数据（含 LoRA 提取：只解析这一张的工作流）。
 * 由下方 IntersectionObserver 在图片进屏时调用 —— 「滚到哪读到哪」，
 * 不再有进入页面时的全库遍历；读到的结果进内存缓存，回滚不再重复读盘。
 */
function requestVisibleMetadata(fileId: string, path?: string): void {
  const snapshot = imageSnapshot(fileId, path)
  if (!snapshot) return
  if (!outputSummaryForFile(snapshot.file, useOutputStore.getState().summaryCache)) _summaryIndex.schedule()
}

/**
 * 只有用户**真正用到全局筛选**时才补齐全库元数据。
 * 必要性：applyFilters 对「基座模型 / LoRA / 标签」三项会排除元数据未加载的条目 ——
 * 懒加载后若不补齐，这三项筛选会静默漏结果（是结果错，不是变慢）。
 */

/**
 * 从 DB 快速恢复缓存（页面刷新后首屏秒出，跳过全量目录遍历）：
 * files 列表 + 缩略图批量回填内存（元数据改为按需），一次渲染到位；
 * 文件系统变化由后续增量扫描（initOutputs/activateOutputs 已有）后台校正。
 */
function releaseOutputMemory(): void {
  clearTimeout(_dragHover); _dragHover = 0; _dragSession.cancel()
  _viewEpoch++
  _scanActionEpoch++
  cancelOutputScan()
  _summaryIndex.cancel()
  _exportSession?.cancel()
  _summaryReader?.dispose(); _summaryReader = undefined
  _currentCardRects.clear()
  _searchClient?.dispose(); _searchClient = undefined
  configureOutputQueryExecutor()

  if (_currentPreviewSnapshot) closeLightbox()
  else releaseOutputPreviewResources()
  const grid = document.getElementById('outputsGrid')
  if (grid) _outputImageNodes.capture(grid) // Keep at most 32 MiB of ready thumbnails across section switches.
  destroyOutputsVS()          // 网格 + 虚拟滚动实例及其 DOM
  // ⚠️ 刻意**保留** thumbMemory：它是"路径 → 160px dataURL"表（≤500 条、约 15MB），
  // 但重新填充要读 240 次 IndexedDB。上一版把它一起清了，导致每次切回 Outputs 都要重读，
  // 用户实测"来回切换页面更卡" —— 释放该释放的，别释放"重建很贵"的。
}

/** 监听 Outputs 区域被隐藏 → 释放内存。自绑定，无需改动其它栏目代码。 */
function bindOutputsLeaveRelease(): void {
  const sec = document.getElementById('sectionOutputs') as (HTMLElement & { _leaveObs?: boolean }) | null
  if (!sec || sec._leaveObs) return
  sec._leaveObs = true
  new MutationObserver(() => {
    if (sec.classList.contains('section-hidden')) releaseOutputMemory()
  }).observe(sec, { attributes: true, attributeFilter: ['class'] })
}

// 模块加载即尝试绑定（sectionOutputs 是 index.html 里的静态区域，不依赖激活时机）
if (typeof window !== 'undefined') setTimeout(bindOutputsLeaveRelease, 0)

/**
 * 统一的删除入口：删除 → 把「确实到达存储层」的图片身份登记为已删 → 显式收敛索引。
 *
 * 为什么不直接在 4 个调用点写 deleteFiles：只有 deleteFiles 返回的成功项才允许登记，
 * 且必须按**完整图片身份**（路径+mtime+size+root）登记，集中一处避免漏改。
 */
async function deleteOutputsAndTrack(ids: string[]): Promise<void> {
  // 先按 id 快照身份：删除过程中 store 会被更新，事后按 id 再查可能已查不到
  const { root } = currentImageSource()
  const byId = new Map<string, { path: string; mtime: number; size: number; root: string }>()
  for (const f of useOutputStore.getState().files) {
    byId.set(f.id, { path: f.path, mtime: f.mtime, size: f.size, root: currentImageSource(f).root })
  }
  const result = await deleteFiles(ids)
  // 只有成功删除的 id 才有身份记录；失败项一个都不登记（它们必须继续可见、可重试）
  const gone = result.deletedIds
    .map(id => byId.get(id))
    .filter((x): x is { path: string; mtime: number; size: number; root: string } => !!x)
  if (gone.length > 0) {
    markOutputsDeleted(gone)
    // 显式把删除收敛到真实存储/索引：不再依赖"等下一轮探测"
    void syncDeletedToGalleryIndex(gone.map(g => g.path))
  }
  renderOutputsView()
  updateBatchBar()
}

/**
 * 让后端索引显式追上这次删除。
 *
 * 为什么需要：gallery 模式下列表真源是后端索引。前端删除只动了磁盘，
 * 后端要等自己下一轮预热才发现 → 这中间列表一重建就会把文件加回来。
 * 靠前端无限期屏蔽路径是错的（同路径会有新图），正确做法是**催后端重建索引**，
 * 然后用真实索引收敛。索引构建是幂等的，重复调用无副作用。
 */
async function syncDeletedToGalleryIndex(_paths: string[]): Promise<void> {
  if (!galleryIndexEnabled()) return
  try {
    await fetch('/anima/gallery/rebuild', { cache: 'no-store' })
  } catch { /* 后端不可用：本轮不收敛，下次探测换代后自然收敛 */ }
}

async function restoreOutputsFromDb(): Promise<boolean> {
  const bootStartedAt = performance.now()
  // ── Gallery 索引模式（插件 ≥2.6.0 的 /anima/gallery/manifest）：列表与元数据摘要
  //    全部由后端索引直出，秒出且无需目录授权；缩略图走 /anima/thumb；不可用则回退旧管线。
  if (galleryIndexEnabled()) {
    const entries = galleryEntries()
    if (entries) {
      // 先收敛：store 里已不含、或已超时的身份记录立即忘记（不做无限期屏蔽）
      pruneDeletedIdentities()
      const { root } = currentImageSource()
      const files: OutputFile[] = []
      const metas: OutputMetadata[] = []
      for (const [rel, e] of entries) {
        // 只对**刚刚确认从存储层删掉、且身份完全一致**的条目做抑制：
        // 同路径下重新生成的新图 mtime/size 不同 → 身份不匹配 → 照常显示
        const mtime = Math.round((e.mtime || 0) * 1000)
        if (isOutputIdentityDeleted(rel, mtime, e.size || 0, root)) continue
        const id = hashPath(rel)
        files.push({
          id, sourceId: 'output', path: rel, filename: rel.split('/').pop() || rel,
          extension: (rel.split('.').pop() || '').toLowerCase(),
          size: e.size || 0, mtime: Math.round((e.mtime || 0) * 1000),
          width: e.width || 0, height: e.height || 0,
          favorite: false, rating: 0, notes: '', tags: [], category: '', status: '', pinned: false,
          createdAt: Math.round((e.mtime || 0) * 1000),
        })
        const summary = bindMetadata({
          imageId: id, model: e.model || '', seed: e.seed || '', steps: e.steps || '', cfg: e.cfg || '',
          sampler: e.sampler || '', scheduler: e.scheduler || '', vae: '', clipSkip: 0,
          prompt: e.prompt || '', identityPrompt: e.identityPrompt, negativePrompt: '', workflowJson: '', rawMetadata: {},
          loras: e.loras || [], hasWorkflow: !!e.hasWorkflow, lorasExtracted: true,
          metadataState: e.metadataState, metadataWarnings: e.metadataWarnings, metadataFormat: e.metadataFormat,
          summaryStatus: e.summaryStatus || 'ready',
          workflowFingerprint: galleryFingerprint((e.mtime || 0) * 1000, e.size || 0),
        }, createImageSnapshot(files[files.length - 1], 'gallery', galleryOutputRoot(), Number(e.parserVersion ?? galleryIndexParserVersion())))
        // A manifest is only a summary. Actions/visible cards refresh it through the full endpoint.
        delete summary.metadataIdentity
        metas.push(summary)
      }
      // Restore annotations only from the same ID and exact relative path.
      const saved = await outputsDb.files.bulkGet(files.map(file => file.id))
      for (let i = 0; i < files.length; i++) {
        files[i] = restoreOutputAnnotations(files[i], saved[i])
      }
      useOutputStore.setState({
        files: [...files, ...useOutputStore.getState().files.filter(f => f.sourceId && f.sourceId !== 'output')], rootPath: galleryOutputRoot(), dirHandle: null, metadataParserVersion: galleryParserVersion(), metadataCache: new Map([...useOutputStore.getState().metadataCache].filter(([, meta]) => meta.sourceIdentity?.source === 'directory')), metadataVersion: useOutputStore.getState().metadataVersion + 1,
        thumbMemory: useOutputStore.getState().thumbMemory,
      })
      // 显式声明：当前列表来自画廊索引
      commitListSource('gallery', galleryOutputRoot(), galleryParserVersion())
      setOutputSource('gallery', galleryOutputRoot(), galleryParserVersion())
      useOutputStore.getState().putMetadataBatch(metas)
      useOutputStore.getState().applyFilters()
      console.log(`[outputs] Gallery 索引直出：${files.length} 个文件 + ${metas.length} 条元数据摘要（${Math.round(performance.now() - bootStartedAt)}ms）`)
      return true
    }
  }
  const restored = await restoreAllFromDb()
  const store = useOutputStore.getState()
  const combined = new Map(store.files.map(file => [file.id, file]))
  for (const file of restored) if (file.sourceId) combined.set(file.id, file)
  store.setFiles([...combined.values()])
  renderOutputsView()
  return combined.size > 0
}


function updateBatchBar() {
  const bar = document.getElementById('outputsBatchBar')
  const count = document.getElementById('outputsBatchCount')
  if (!bar || !count) return

  const selected = useOutputStore.getState().selectedIds.size
  if (selected > 0) {
    bar.style.display = 'flex'
    count.textContent = `已选 ${selected} 张`
  } else {
    bar.style.display = 'none'
  }
}

/** 同步排序方向按钮的图标和 active 状态 */
function syncSortOrderBtn() {
  const orderBtn = document.querySelector('.outputs-sort-order-btn') as HTMLElement
  if (!orderBtn) return
  const state = useOutputStore.getState()
  orderBtn.innerHTML = state.sortOrder === 'desc' ? icon('arrowDown', 14) : icon('arrowUp', 14)
  orderBtn.classList.toggle('active', state.sortOrder === 'asc')
}

/** 从 Outputs metadata 中提取高频 Prompt 词 */

/** 更新扫描进度条 */
function updateScanProgress(status: OutputScanStatus, progress: { done: number; total: number }) {
  const el = document.getElementById('outputsScanProgress')
  const bar = document.getElementById('outputsScanProgressBar')
  const text = document.getElementById('outputsScanProgressText')
  if (!el || !bar || !text) return
  if (status === 'scanning') {
    el.style.display = 'flex'
    const pct = progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0
    bar.style.setProperty('--progress', pct + '%')
    text.textContent = `扫描中... ${progress.done}/${progress.total}`
  } else {
    el.style.display = 'none'
  }
}

async function loadImageThumbnail(img: HTMLImageElement, fileId: string, filePath: string) {
  const snapshot = imageSnapshot(fileId, filePath)
  if (!snapshot) return
  const version = img.dataset.fileVersion
  const bound = () => img.isConnected && img.dataset.filePath === snapshot.path && img.dataset.fileId === snapshot.file.id && img.dataset.fileVersion === version && snapshotIsCurrent(snapshot)
  // ── 后端直供（插件 ≥2.5.1）：浏览器只解码 512px 小图 ──
  // 注意：/anima/thumb 只认 ComfyUI output 目录内的文件；用户用目录授权扫过其它目录时
  // 该端点会 404 —— onerror 后把该路径记入黑名单并回退旧管线（浏览器生成），会话内不再重试 URL。
  // ⚠️ 2026-10-04 owner 要求：provider 由**操作捕获的 snapshot.source** 决定，
  //    不能只看全局 backendThumbs 能力 —— native 桥下同样存在该端点不可用的组合。
  const thumbsUsable = backendThumbsEnabled() && (snapshot.source === 'gallery' || snapshot.source === 'native')
  if (thumbsUsable && !_thumbUrlBlocked.has(outputContentKey(snapshot.file))) {
    const url = animaThumbUrl(filePath, 512) + '&v=' + encodeURIComponent(imageRevision(snapshot))
    img.onerror = () => {
      if (!bound()) return
      img.onerror = null
      _thumbUrlBlocked.add(outputContentKey(snapshot.file))
      void legacyThumbLoad(img, fileId, filePath)
    }
    if (img.getAttribute('src') !== url) img.src = url
    _outputImageNodes.remember(img)
    return
  }
  await legacyThumbLoad(img, fileId, filePath)
}

/** 旧管线：内存 → IndexedDB → 目录授权读原图生成（后端端点不可用/不覆盖该路径时兜底） */
async function legacyThumbLoad(img: HTMLImageElement, fileId: string, filePath: string) {
  const snapshot = imageSnapshot(fileId, filePath)
  if (!snapshot) return
  const revision = imageRevision(snapshot)
  const version = img.dataset.fileVersion
  const bound = () => img.isConnected && img.dataset.filePath === snapshot.path && img.dataset.fileId === snapshot.file.id && img.dataset.fileVersion === version && snapshotIsCurrent(snapshot)
  const assign = (dataUrl: string) => {
    if (!dataUrl || !bound()) return
    _thumbnailRevisions.set(outputContentKey(snapshot.file), revision)
    useOutputStore.getState().setThumbMemory(outputContentKey(snapshot.file), dataUrl)
    if (img.getAttribute('src') !== dataUrl) img.src = dataUrl
    _outputImageNodes.remember(img)
  }
  const dh = sourceForFile(snapshot.file).handle
    if (snapshot.source === 'native') {
    // TK 原生模式：服务端对 /api/tk/output-file 是整文件回传（平均数 MB），
    // 过去直接把原图 URL 当缩略图用 —— 首屏数十张卡同时按原始尺寸下载 + 解码
    // （单张解码位图可达 6~25MB），主线程与内存瞬间被压满，表现为「进入 Outputs 卡死」。
    // 现在复用与目录模式相同的缩略图管线：内存 → IndexedDB → 下载一次并缩到 200px
    // 后回写缓存（管线内部限流 4 并发），二次进入直接命中缓存。
    try {
      const mem = cachedImageThumbnail(snapshot.file)
      if (mem) {
        assign(mem)
        return
      }

      const thumbMod = await import('../services/outputThumbnail')
      const cached = await thumbMod.getCachedThumbnail(fileId, revision)
      if (cached) {
        assign(cached)
        return
      }

      const res = await fetch(nativeOutputUrl(filePath))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      if (!bound()) return
      const thumb = await thumbMod.createThumbnailFromBlob(blob, 200)
      if (thumb?.dataUrl) {
        assign(thumb.dataUrl)
        return
      }
    } catch { /* 服务异常/超大图：下面退回原图，不阻塞其它图片 */ }
    // 兜底：缩略图不可得时退回原图 URL，保证不空着
    if (bound() && !img.getAttribute('src')) img.src = nativeOutputUrl(filePath)
    if (bound()) _outputImageNodes.remember(img)
    return
  }
  // 未授权目录（无句柄）时不再直接放弃：内存与 IndexedDB 里已有缓存的缩略图仍可展示，
  // 只是无法主动生成新的缩略图。补上这条，前面"启动只预载 240 张"才是安全的
  // ——其余缩略图滚动到就按需取，既不卡启动也不缺图。
  if (!dh) {
    try {
      const mem = cachedImageThumbnail(snapshot.file)
      if (mem) {
        assign(mem)
        return
      }
      const cached = await import('../services/outputThumbnail').then(m => m.getCachedThumbnail(fileId, revision))
      if (cached) {
        assign(cached)
      }
    } catch { /* 缓存不可用：保持灰底，不抛错、不影响其它图片 */ }
    return
  }

  try {
    // 内存缓存（同步）
    const mem = cachedImageThumbnail(snapshot.file)
    if (mem) {
      assign(mem)
      return
    }

    // 尝试从 IndexedDB 缓存加载
    const cached = await import('../services/outputThumbnail').then(m => m.getCachedThumbnail(fileId, revision))
    if (cached) {
      assign(cached)
      return
    }

    // 从文件系统加载
    const current = await resolveDirEntry(dh, filePath)
    const fileHandle = await current.getFileHandle(filePath.split('/').pop()!)
    const file = await fileHandle.getFile()
    if (!bound() || file.lastModified !== snapshot.mtime || file.size !== snapshot.size) return

    const thumbnail = await import('../services/outputThumbnail').then(m => m.getThumbnail(file, fileId, revision))
    if (thumbnail) {
      assign(thumbnail)
    }
  } catch {
    // 加载失败，显示占位符
    if (bound()) img.style.display = 'none'
  }
}

function showCompatMessage() {
  // Outputs 的增量扫描/权限恢复依赖 FileSystemDirectoryHandle，webkitdirectory 回退不适用；
  // 无句柄时已缓存内容仍可浏览，提示用户可用的替代路径
  const cached = useOutputStore.getState().files.length
  showToast(cached > 0
    ? `⚠️ 当前浏览器/访问方式不支持目录选择（需 Chrome/Edge + localhost/HTTPS）；已缓存 ${cached} 张图片仍可浏览，但无法增量刷新`
    : '⚠️ 当前浏览器/访问方式不支持目录选择：请用 Chrome/Edge 并通过 localhost 或 HTTPS 访问（局域网 IP 访问不支持目录权限）')
}

/**
 * 预览导航：上一张/下一张
 */
function navigatePreview(direction: number) {
  const state = useOutputStore.getState()
  const files = state.filteredFiles
  if (!_currentPreviewFileId || files.length === 0) return
  const currentIdx = outputPreviewIndex(files, _currentPreviewSnapshot)
  if (currentIdx === -1) return
  const nextIdx = (currentIdx + direction + files.length) % files.length
  const nextFile = files[nextIdx]
  if (nextFile) {
    openPreview(nextFile.id, imageSnapshot(nextFile))
  }
}

// ── 图片复制与下载 ──

/** 通过文件 ID 获取文件系统 File 对象 */
async function getFileBlob(fileId: string, snapshot?: ImageSnapshot | null, signal?: AbortSignal): Promise<{ name: string; blob: Blob } | null> {
  const target = snapshot === undefined ? imageSnapshot(fileId) : snapshot
  const file = target?.file
  if (!target || signal?.aborted || !snapshotIsCurrent(target)) return null
  if (target.source === 'gallery' && file) {
    // 画廊来源走 ComfyUI 原生 /view（原图字节），与预览同一 provider，避免再次 404
    try {
      const response = await fetch(comfyViewUrl(target.path), { signal })
      if (!response.ok) return null
      const blob = await response.blob()
      return !signal?.aborted && snapshotIsCurrent(target) ? { name: file.filename, blob } : null
    } catch { return null }
  }
  if (target.source === 'native' && file) {
    // TK 原生桥：整文件直连
    try {
      const response = await fetch(nativeOutputUrl(file.path), { signal })
      if (!response.ok) return null
      const blob = await response.blob()
      return !signal?.aborted && snapshotIsCurrent(target) ? { name: file.filename, blob } : null
    } catch { return null }
  }
  if (!file) return null
  const blob = await readOutputSourceFile(target)
  return blob && !signal?.aborted && snapshotIsCurrent(target) ? { name: file.filename, blob } : null
}

/**
 * 导出专用取字节：在 getFileBlob 之上套一层元数据策略（开关关闭时是零开销直通）。
 * ⚠️ 只在「用户会拿到这份字节」的路径上用它。以下用途必须继续用 getFileBlob：
 *   · ensureEditSrc —— 编辑画布的像素基准
 *   · saveEditedImage 里读原图元数据以注入副本 —— 一旦被 strip 就静默破坏「副本保留工作流」
 */
async function getExportBlob(fileId: string, snapshot?: ImageSnapshot | null): Promise<{ name: string; blob: Blob } | null> {
  const policy = snapshotExportMetadataPolicy(exportMetadataOptions())
  const r = await getFileBlob(fileId, snapshot)
  if (!r) return null
  return { name: r.name, blob: await applyExportMetadata(r.blob, policy) }
}

/** 把开关状态同步到工具栏按钮：active 高亮 + title 写明当前状态（避免用户忘了自己开过） */
function syncMetadataButton() {
  const st = useExportMetadataStore.getState()
  const btn = document.getElementById('outputsMetadataBtn')
  if (!btn) return
  btn.classList.toggle('active', st.enabled)
  btn.setAttribute('aria-pressed', String(st.enabled))
  const label = btn.querySelector('span')
  if (label) label.textContent = st.enabled ? '去除生成信息 · 已开启' : '保留生成信息（原图）'
  const filled = st.entries.filter(e => e.key.trim() !== '' && e.value !== '').length
  btn.title = st.enabled
    ? `导出时去除元数据：已开启${filled > 0 ? `（另写入 ${filled} 项署名）` : '（未填署名 = 只去不写）'}`
    : '导出时去除元数据（当前：关闭）'
}

function syncFallbackControls(): void {
  const settings = outputFallbackSettings(), catalog = outputFallbackCatalog()
  const check = document.getElementById('outputsFallbackEnabled') as HTMLInputElement | null
  if (check) check.checked = settings.enabled
  const unrecognized = document.getElementById('outputsFallbackUnrecognized') as HTMLInputElement | null
  if (unrecognized) unrecognized.checked = settings.includeUnrecognized
  const library = document.getElementById('outputsFallbackLibrary') as HTMLInputElement | null
  if (library) library.checked = settings.libraryMatching
  const model = document.getElementById('outputsFallbackModel') as HTMLSelectElement | null
  if (model) {
    const names = [...catalog.models]; if (settings.model && !names.includes(settings.model)) names.push(settings.model)
    model.innerHTML = `<option value="">自动${catalog.defaultModel ? `（${esc(catalog.defaultModel)}）` : '选择已安装模型'}</option>` + names.map(name => `<option value="${escAttr(name)}">${esc(name)}${catalog.models.includes(name) ? '' : '（未安装）'}</option>`).join('')
    model.value = settings.model
  }
  for (const [id, value] of [['outputsFallbackThreshold', settings.threshold], ['outputsFallbackCharacterThreshold', settings.characterThreshold]] as const) { const input = document.getElementById(id) as HTMLInputElement | null; if (input) input.value = String(value) }
  const hint = document.getElementById('outputsFallbackHint')
  if (hint) hint.textContent = catalog.models.length ? `当前：${settings.model || catalog.defaultModel} · CPU。${settings.enabled ? '反推已启用' : '反推已暂停'}。${settings.includeUnrecognized ? '包括已有提示词但未识别角色的图片。' : '自动反推仅处理确认无元数据的图片。'}切换模型或阈值后可点击“用所选模型重试未识别”。角色置信度不足时仍保留未识别，不强行归类。` : '没有完整的本地 WD14 ONNX+CSV 模型；在 WD14 Tagger 安装后刷新列表。'
  if (hint && catalog.libraryMatches.count) hint.textContent += ` 本机有 ${catalog.libraryMatches.count} 项识别缓存，${settings.libraryMatching ? '优先复用相似匹配与本机模型结果，未命中时再用所选 WD14；内存不足时仍可读取已有结果' : '当前未启用复用'}。识别标签不属于原始提示词。`
}

/** 开关按钮：切换 + 同步 UI + 明确告知影响面（这是会改变用户拿到的东西的开关，不能静默） */
function toggleMetadataExport() {
  const st = useExportMetadataStore.getState()
  st.setEnabled(!st.enabled)
  syncMetadataButton()
  showToast(st.enabled
    ? '已开启：导出副本将去除提示词、工作流与提示词来源记录（磁盘原图保留）'
    : '已关闭：导出恢复为原图字节')
}

/**
 * 「署名与自定义元数据」设置弹层。
 * 输入框改动只写 store 不重绘（否则每敲一个字就丢焦点、光标跳到末尾），只有增删行才重绘。
 */
function openMetadataConfigPanel() {
  document.getElementById('outputsMetaConfigOverlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'outputsMetaConfigOverlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:radial-gradient(ellipse at top,rgba(10,10,15,0.85),rgba(2,2,3,0.95));z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:var(--bg2);color:var(--text);border-radius:12px;padding:16px;width:90vw;max-width:560px;max-height:85vh;overflow-y:auto;border:1px solid var(--border);box-shadow:0 24px 70px rgba(0,0,0,0.5);'

  const draw = () => {
    const st = useExportMetadataStore.getState()
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <strong style="font-size:14px">导出元数据</strong>
        <span style="flex:1"></span>
        <button class="outputs-meta-close-btn" data-cfg="close" title="关闭">${icon('x', 14)}</button>
      </div>
      <div style="font-size:12px;color:var(--descrip-text);line-height:1.7;margin-bottom:12px">
        开启后，<b>下载 / 打包下载 / 复制到剪贴板 / 大图预览 / 编辑器副本</b>会清理 PNG 中的
        提示词、工作流和本插件的提示词来源记录，并写入下面的署名。像素、色彩信息及无关元数据保留。<br>
        <b>磁盘上的原图不会被改动</b>；去掉 workflow 后图片拖回 ComfyUI 无法恢复工作流。
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer">
        <input type="checkbox" data-cfg="enabled" ${st.enabled ? 'checked' : ''}>
        <span style="font-size:13px">启用（默认关闭）</span>
      </label>
      <div style="font-size:12px;color:var(--descrip-text);margin-bottom:6px">
        署名与自定义元数据（<b>留空 = 不写入该项</b>；也不会去清除图里已有的同名块）
      </div>
      ${st.entries.map((e, i) => `
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input class="outputs-filter-input" data-cfg="key" data-idx="${i}" value="${escAttr(e.key)}" placeholder="键名" style="width:38%">
          <input class="outputs-filter-input" data-cfg="value" data-idx="${i}" value="${escAttr(e.value)}" placeholder="值" style="flex:1">
          <button class="outputs-batch-btn danger" data-cfg="remove" data-idx="${i}" title="删除该行">${icon('trash', 12)}</button>
        </div>`).join('')}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="outputs-batch-btn" data-cfg="add">${icon('plus', 12)}<span>添加自定义键</span></button>
        <button class="outputs-batch-btn" data-cfg="reset">恢复默认四键</button>
      </div>`
  }

  const close = () => {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }

  // 输入框只写 store（不重绘，保住焦点与光标位置）
  panel.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement
    const field = el.dataset.cfg
    if (field !== 'key' && field !== 'value') return
    useExportMetadataStore.getState().setEntry(Number(el.dataset.idx),
      field === 'key' ? { key: el.value } : { value: el.value })
    syncMetadataButton()
  })

  panel.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement
    if (el.dataset.cfg === 'enabled') {
      useExportMetadataStore.getState().setEnabled(el.checked)
      syncMetadataButton()
    }
  })

  panel.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('[data-cfg]') as HTMLElement | null
    if (!el) return
    const st = useExportMetadataStore.getState()
    switch (el.dataset.cfg) {
      case 'close': close(); return
      case 'add': st.addEntry(); draw(); return
      case 'reset': st.restoreDefaults(); draw(); syncMetadataButton(); return
      case 'remove': st.removeEntry(Number(el.dataset.idx)); draw(); syncMetadataButton(); return
    }
  })

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  document.addEventListener('keydown', onKey)
  draw()
  overlay.appendChild(panel)
  document.body.appendChild(overlay)
}

/** Blob 转 Base64 DataURL */
function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}



/** 将 Outputs 图片的 Prompt 与压缩图片副本保存到 Prompt 库，脱离原文件后仍可查看。 */
async function saveOutputPromptToLibrary(fileId: string, snapshot?: ImageSnapshot | null): Promise<void> {
  const target = snapshot === undefined ? imageSnapshot(fileId) : snapshot
  const file = target?.file
  const meta = await getImageMetadata(target)
  if (!file || !promptBody(meta)) {
    showToast('该图片无 Prompt，无法保存')
    return
  }

  const result = await getFileBlob(fileId, target)
  if (!result) {
    showToast('保存失败：找不到原图片')
    return
  }

  try {
    const image = await blobToDataURL(await compressOutputImage(result.blob))
    if (!target || !snapshotIsCurrent(target) || !meta) return
    const loras = meta.workflowJson
      ? extractLoraTagsFromWorkflow(meta.workflowJson, meta.rawMetadata)
      : (meta.loras || [])
    const params = [
      meta.model && `模型: ${meta.model}`,
      meta.seed && `Seed: ${meta.seed}`,
      meta.steps && `Steps: ${meta.steps}`,
      meta.cfg && `CFG: ${meta.cfg}`,
      meta.sampler && `采样器: ${meta.sampler}`,
    ].filter(Boolean).join(' | ')
    const notes = [
      meta.negativePrompt && `负 Prompt: ${meta.negativePrompt}`,
      params && `参数: ${params}`,
    ].filter(Boolean).join('\n')
    const entry: PromptEntry = {
      id: generatePromptId(),
      prompt: meta.prompt,
      displayText: file.filename.replace(/\.[^.]+$/, '') || 'Outputs Prompt',
      images: [image],
      primaryImage: image,
      tags: [...file.tags],
      loras,
      categoryId: 'uncategorized',
      notes,
      isFavorite: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await addPrompt(entry)
    showToast('✅ Prompt 与图片已保存到 Prompt 库', 'success')
  } catch (error) {
    console.warn('[outputs] 保存 Prompt 失败:', error)
    showToast('保存失败，请重试')
  }
}

/** Every export freezes file revisions and policy before any asynchronous read. */
async function exportOutputs(ids: string[], action: 'copy' | 'download', mode: ExportMetadataMode = 'default', target?: ImageSnapshot | null): Promise<void> {
  if (!ids.length) return
  if (_exportSession) { showToast('已有导出任务，完成或取消后再试'); return }
  const snapshots = [...new Set(ids)].map(id => target?.file.id === id ? target : imageSnapshot(id)).filter((snapshot): snapshot is ImageSnapshot => !!snapshot)
  if (!snapshots.length) { showToast('找不到可导出的图片'); return }
  const byId = new Map(snapshots.map(snapshot => [snapshot.file.id, snapshot]))
  const session = createOutputExportSession(snapshots.map(snapshot => ({
    id: snapshot.file.id, sourceId: snapshot.file.sourceId || 'output',
    path: snapshot.path, filename: snapshot.file.filename, size: snapshot.file.size,
  })), {
    policy: exportMetadataOptions(mode),
    readBlob: async (item, signal) => {
      const snapshot = byId.get(item.id)
      const result = await getFileBlob(item.id, snapshot, signal)
      if (!result) throw new Error('图片已移动、目录未授权或文件读取失败')
      return result.blob
    },
    download: async (artifact, signal) => {
      if (signal.aborted) throw new DOMException('导出已取消', 'AbortError')
      const url = URL.createObjectURL(artifact.blob)
      const link = document.createElement('a')
      link.href = url; link.download = artifact.name
      document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    archiveName: `outputs-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  })
  _exportSession = session
  const progress = document.getElementById('outputsExportProgress')
  if (progress) { progress.hidden = false; progress.title = ''; const button = progress.querySelector<HTMLElement>('button'); if (button) button.hidden = false }
  const unsubscribe = session.subscribe(state => {
    if (_exportSession !== session || !progress) return
    const text = progress.querySelector('span')
    const labels: Record<OutputExportProgress['phase'], string> = {
      reading: '读取', processing: '处理生成信息', packing: '打包', copying: '复制', downloading: '交付下载', complete: '完成', cancelled: '已取消',
    }
    if (text) text.textContent = `${labels[state.phase]} ${state.completed}/${state.total}${state.part ? ` · 第${state.part}包` : ''}${state.failed ? ` · ${state.failed}张失败` : ''}`
  })
  try {
    const result = await session.run(action === 'download' && snapshots.length > 1 ? 'zip' : action)
    if (_exportSession !== session || !isOutputsActive()) return
    const text = progress?.querySelector('span')
    const message = result.status === 'cancelled' ? `已取消，已交付 ${result.succeeded} 张`
      : `${action === 'copy' ? '已复制' : '已提交下载'} ${result.succeeded}/${result.total} 张${result.failures.length ? `，${result.failures.length} 张失败` : ''}${result.warnings.length ? `，${result.warnings.length} 项提示` : ''}`
    if (text) text.textContent = message
    if (progress) {
      progress.title = [...result.failures.map(failure => `${failure.name}：${failure.message}`), ...result.warnings.map(warning => `${warning.name}：${warning.message}`)].join('\n')
      const button = progress.querySelector<HTMLElement>('button'); if (button) button.hidden = true
    }
    showToast(message)
  } catch (error) {
    if (_exportSession === session && isOutputsActive()) showToast(`导出失败：${(error as Error).message}`)
  } finally {
    unsubscribe()
    if (_exportSession === session) _exportSession = undefined
  }
}

async function copyImageToClipboard(fileId: string, snapshot?: ImageSnapshot | null): Promise<void> {
  await exportOutputs([fileId], 'copy', 'default', snapshot)
}
async function copyImagesToClipboard(ids: string[]): Promise<void> { await exportOutputs(ids, 'copy') }
async function downloadImage(fileId: string, snapshot?: ImageSnapshot | null): Promise<void> {
  await exportOutputs([fileId], 'download', 'default', snapshot)
}
async function downloadImagesAsZip(ids: string[]): Promise<void> { await exportOutputs(ids, 'download') }

/** 独立元数据弹窗（不放大图片，直接查看 prompt/参数/工作流） */
async function openMetaPanel(fileId: string, snapshot?: ImageSnapshot | null) {
  const token = ++_detailToken
  const target = snapshot === undefined ? imageSnapshot(fileId) : snapshot
  const file = target?.file
  if (!file) return
  // 完整元数据（含 workflowJson）：统一入口 —— IDB 命中即用，gallery 模式自动从后端补全
  const meta = await getImageMetadata(target)
  if (token !== _detailToken || !target || !snapshotIsCurrent(target)) return

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:radial-gradient(ellipse at top,rgba(10,10,15,0.85),rgba(2,2,3,0.95));z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:var(--bg2);color:var(--text);border-radius:12px;padding:16px;width:90vw;max-width:640px;max-height:85vh;overflow-y:auto;border:1px solid var(--border);box-shadow:0 0 0 1px rgba(0,0,0,0.2),0 24px 70px rgba(0,0,0,0.5);'
  panel.innerHTML = renderMetadataPanel(meta ?? null, file)
  bindRawMetadataDetails(panel, meta || {})
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  panel.querySelector('#outputsMetaCloseBtn')?.addEventListener('click', () => overlay.remove())
  panel.querySelector('#outputsMetaRetryBtn')?.addEventListener('click', async () => {
    await getImageMetadata(target, true)
    overlay.remove()
    if (snapshotIsCurrent(target)) void openMetaPanel(fileId, target)
  })
  panel.querySelector('#outputsMetaCopyWorkflowBtn')?.addEventListener('click', async () => {
    await downloadOutputWorkflow(meta ?? undefined, file?.filename || 'workflow')
  })
  // Esc 关闭
  const escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler) } }
  document.addEventListener('keydown', escHandler)
}

// ══ 预览图片编辑：当前像素画布、临时拖出及显式保存 ══
// 状态模型：_editBase 是「当前编辑结果」基准画布。每个操作（旋转/翻转/裁剪）都把结果固化到基准，
// 后续操作总是基于最新结果继续，因此任意顺序组合都不会出现坐标错位。

/** 扩展名 → canvas.toBlob 的 MIME 类型 */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

let _editFileId = ''
let _editSnapshot: ImageSnapshot | null = null
let _editSrcImg: HTMLImageElement | null = null
let _editBase: HTMLCanvasElement | null = null
let _editCropping = false
let _cropStartX = 0
let _cropStartY = 0
let _saving = false
let _painter: ReturnType<typeof createOutputPainter> | undefined
let _editDragTimer = 0
const _editDragSession = createOutputDragSession({
  forceUpload: true,
  metadataPolicy: exportMetadataOptions,
  current: snapshot => snapshotIsCurrent(snapshot) && _currentPreviewSnapshot?.key === snapshot.key,
  read: async snapshot => {
    if (_editCropping || _painter?.active) return null
    if (!_editBase || _editSnapshot?.key !== snapshot.key) return (await getFileBlob(snapshot.file.id, snapshot))?.blob || null
    return new Promise<Blob | null>(resolve => buildEditedCanvas().toBlob(resolve, 'image/png'))
  },
})
function invalidateEditedDrag() {
  _editDragSession.cancel(); clearTimeout(_editDragTimer)
  const button = document.getElementById('lbPreviewDrag')
  if (button) button.textContent = '准备拖出…'
  _editDragTimer = window.setTimeout(() => { if (!_painter?.active && !_editCropping) void prepareEditedDrag() }, 350)
}
async function prepareEditedDrag() {
  const snapshot = _currentPreviewSnapshot
  if (!snapshot || _editCropping || _painter?.active) return
  try {
    const copy = await _editDragSession.prepare(snapshot)
    if (copy && _currentPreviewSnapshot?.key === snapshot.key) {
      const button = document.getElementById('lbPreviewDrag')
      if (button) button.textContent = '拖出当前图'
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    const button = document.getElementById('lbPreviewDrag')
    if (button) { button.textContent = '重试准备拖出'; button.title = (error as Error).message }
  }
}
function setPaintMode(mode: 'view' | 'pen' | 'mosaic' | 'cover') {
  _painter?.setMode(mode)
  document.querySelectorAll<HTMLElement>('[data-paint]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paint === mode)))
  document.querySelectorAll<HTMLElement>('[data-paint-controls]').forEach(control => { control.hidden = !control.dataset.paintControls?.split(' ').includes(mode) })
  const hint = document.getElementById('lbEditHint')
  if (hint) hint.textContent = mode === 'mosaic' ? '拖出矩形；调整颗粒与强度可预览最后一块效果' : mode === 'pen' ? '在图片上直接涂画；放大后也可绘制' : mode === 'cover' ? '拖出矩形，用当前颜色遮盖' : '滚轮缩放，放大后拖动查看'
}

/** Navigate within an already authorized directory (also used by bulk export). */
async function resolveDirEntry(dirHandle: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  const parts = path.split('/')
  let current = dirHandle
  for (let i = 0; i < parts.length - 1; i++) current = await current.getDirectoryHandle(parts[i])
  return current
}

/** 懒加载原始图像，并初始化编辑基准画布（切图时重新加载并重置编辑状态） */
async function ensureEditSrc(fileId: string): Promise<boolean> {
  const target = _currentPreviewSnapshot?.file.id === fileId ? _currentPreviewSnapshot : imageSnapshot(fileId)
  if (!target || !snapshotIsCurrent(target)) return false
  if (_editSnapshot?.key === target.key && _editBase) return true
  const blob = await getFileBlob(fileId, target)
  if (!blob || !snapshotIsCurrent(target)) return false
  const url = URL.createObjectURL(blob.blob)
  const img = new Image()
  let loaded = false
  try {
    loaded = await new Promise<boolean>(resolve => {
      img.onload = () => resolve(true)
      img.onerror = () => resolve(false)
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
    img.onload = null
    img.onerror = null
  }
  if (!loaded || !snapshotIsCurrent(target) || _currentPreviewSnapshot?.key !== target.key) return false
  _editFileId = fileId
  _editSnapshot = target
  _editSrcImg = img
  _editBase = canvasFromImage(img)
  _editCropping = false
  return true
}

/** 把 Image 绘制为独立 canvas */
function canvasFromImage(img: HTMLImageElement): HTMLCanvasElement {
  const base = document.createElement('canvas')
  base.width = img.naturalWidth
  base.height = img.naturalHeight
  base.getContext('2d')!.drawImage(img, 0, 0)
  return base
}

/** 返回当前编辑结果的独立副本（供导出，避免后续编辑污染已生成的 blob） */
function buildEditedCanvas(): HTMLCanvasElement {
  const src = _editBase!
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  out.getContext('2d')!.drawImage(src, 0, 0)
  return out
}

/** 把当前编辑基准渲染到预览画布（隐藏原 img） */
function renderEdit() {
  setLightboxViewLocked(false)
  const wrap = document.getElementById('lbEditWrap')
  const cv = document.getElementById('lbEditCanvas') as HTMLCanvasElement
  const imgEl = document.getElementById('lbImg') as HTMLImageElement
  if (!wrap || !cv || !imgEl || !_editBase) return
  cv.width = _editBase.width
  cv.height = _editBase.height
  cv.getContext('2d')!.drawImage(_editBase, 0, 0)
  imgEl.style.display = 'none'
  wrap.style.display = 'inline-block'
  hideCropUI()
  setPaintMode('view')
  invalidateEditedDrag()
}

function hideCropUI() {
  setLightboxViewLocked(false)
  const layer = document.getElementById('lbCropLayer')
  const rect = document.getElementById('lbCropRect')
  if (layer) layer.style.display = 'none'
  if (rect) rect.style.display = 'none'
}

function rotateEdit(delta: number) {
  if (!_editBase) return
  _painter?.checkpoint()
  const src = _editBase
  const rot = ((delta % 360) + 360) % 360
  const swap = rot === 90 || rot === 270
  const out = document.createElement('canvas')
  out.width = swap ? src.height : src.width
  out.height = swap ? src.width : src.height
  const ctx = out.getContext('2d')!
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate(rot * Math.PI / 180)
  ctx.drawImage(src, -src.width / 2, -src.height / 2)
  _editBase = out
  renderEdit()
}

function toggleFlip(axis: 'h' | 'v') {
  if (!_editBase) return
  _painter?.checkpoint()
  const src = _editBase
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  const ctx = out.getContext('2d')!
  ctx.translate(axis === 'h' ? src.width : 0, axis === 'v' ? src.height : 0)
  ctx.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1)
  ctx.drawImage(src, 0, 0)
  _editBase = out
  renderEdit()
}

function enterCropMode() {
  if (!_editBase) return
  renderEdit() // 确保编辑画布显示——否则裁剪层位于隐藏的 wrap 里，点击裁剪看起来"无效"
  _editCropping = true
  _editDragSession.cancel()
  setLightboxViewLocked(true)
  const layer = document.getElementById('lbCropLayer')
  const rect = document.getElementById('lbCropRect')
  const wrap = document.getElementById('lbEditWrap')
  if (layer) layer.style.display = 'block'
  if (rect) rect.style.display = 'none'
  if (wrap) wrap.style.cursor = 'crosshair'
}

function confirmCrop() {
  if (!_editBase) return
  const rect = document.getElementById('lbCropRect') as HTMLElement
  const layer = document.getElementById('lbCropLayer') as HTMLElement
  const cv = document.getElementById('lbEditCanvas') as HTMLCanvasElement
  const wrap = document.getElementById('lbEditWrap')
  if (wrap) wrap.style.cursor = ''
  _editCropping = false
  if (rect.style.display === 'none' || !cv) { hideCropUI(); return }
  const lw = parseFloat(rect.style.width)
  const lh = parseFloat(rect.style.height)
  const lx = parseFloat(rect.style.left)
  const ly = parseFloat(rect.style.top)
  if (!lw || !lh) { hideCropUI(); return }
  // 显示坐标 → canvas 像素坐标（考虑缩放），并 clamp 到画布边界（选框拖出画布时兜底）
  const layerRect = layer.getBoundingClientRect()
  const scaleX = cv.width / layerRect.width
  const scaleY = cv.height / layerRect.height
  const x = Math.max(0, Math.min(_editBase.width - 1, lx * scaleX))
  const y = Math.max(0, Math.min(_editBase.height - 1, ly * scaleY))
  const cw = Math.min(_editBase.width - x, lw * scaleX)
  const ch = Math.min(_editBase.height - y, lh * scaleY)
  if (cw < 2 || ch < 2) { hideCropUI(); return }
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(cw))
  out.height = Math.max(1, Math.round(ch))
  out.getContext('2d')!.drawImage(_editBase, x, y, cw, ch, 0, 0, out.width, out.height)
  _painter?.checkpoint()
  _editBase = out
  hideCropUI()
  renderEdit()
}

function resetEdit() {
  _painter?.reset()
  _editDragSession.cancel(); clearTimeout(_editDragTimer)
  setPaintMode('view')
  _editSrcImg = null
  _editFileId = ''
  _editSnapshot = null
  _editBase = null
  _editCropping = false
  const wrap = document.getElementById('lbEditWrap')
  const imgEl = document.getElementById('lbImg') as HTMLImageElement
  if (wrap) wrap.style.display = 'none'
  if (imgEl) imgEl.style.display = ''
  hideCropUI()
}

/** Save only on explicit user action; overwrite always keeps a verified original backup. */
async function saveEditedImage(overwrite = false) {
  if (!_editBase || _saving || _painter?.active) return
  const target = _editSnapshot
  const file = target?.file
  if (!file || !target || !snapshotIsCurrent(target)) { showToast('图片来源已变化，请重新打开后保存'); return }
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(file.extension.toLowerCase())) { showToast('保存编辑仅支持 PNG、JPEG、WebP 静态图片'); return }
  _saving = true
  try {
    if (overwrite && !await confirmModal('覆盖原图', `将覆盖 ${file.filename}。\n会先核验并保留原图备份；也可取消后选择“另存副本”。`)) return
    if (_editCropping) confirmCrop()
    const cv = buildEditedCanvas(), ext = file.extension.toLowerCase(), mime = EXT_MIME[ext]
    const dh = sourceForFile(file).handle
    if (target.source !== 'gallery' && (!dh || !await requestOutputSourcePermission(file.sourceId || 'output', 'readwrite'))) { showToast('保存需要目录写入权限'); return }
    const blob = await new Promise<Blob | null>(res => cv.toBlob(res, mime))
    if (!blob || blob.type !== mime) throw Error('浏览器无法按原图片格式导出')
    let savedBlob = blob
    if (ext === 'png') {
      if (isExportMetadataNoop(exportMetadataOptions())) {
        const original = await getFileBlob(target.file.id, target)
        if (!original) throw Error('无法读取原图元数据，未保存')
        const bytes = injectPngTextChunks(new Uint8Array(await blob.arrayBuffer()), extractPngTextChunks(new Uint8Array(await original.blob.arrayBuffer())))
        savedBlob = new Blob([bytes], { type: mime })
      } else savedBlob = await applyExportMetadata(blob, exportMetadataOptions())
    }
    const meta = await getImageMetadata(target)
    const saved = await saveOutputEdit({ target, blob: savedBlob, width: cv.width, height: cv.height, overwrite, handle: dh,
      current: () => snapshotIsCurrent(target) && _currentPreviewSnapshot?.key === target.key && (target.source === 'gallery' || sourceForFile(target.file).handle === dh) })
    const newId = overwrite ? file.id : file.sourceId && file.sourceId !== 'output' ? outputFileId(file.sourceId, saved.path) : hashPath(saved.path)
    const newFile: OutputFile = {
      ...file, id: newId, path: saved.path, filename: saved.filename, mtime: saved.mtime, size: saved.size, width: saved.width, height: saved.height,
      ...(overwrite ? {} : { favorite: false, rating: 0, notes: '', tags: [], category: '', status: '', pinned: false, createdAt: Date.now() }),
    }
    await outputsDb.files.put(newFile)
    const store = useOutputStore.getState()
    store.removeMetadata([newId]); store.invalidateThumbnails([outputContentKey(file), outputContentKey(newFile)])
    if (meta) {
      const copyMeta = bindMetadata({ ...meta, imageId: newId }, createImageSnapshot(newFile, target.source, target.root, target.parserVersion, target.epoch))
      await outputsDb.metadata.put(copyMeta); store.putMetadata(copyMeta)
    }
    useOutputStore.setState(s => ({ files: [newFile, ...s.files.filter(f => f.id !== newId)] }))
    useOutputStore.getState().applyFilters(); renderOutputsView()
    if (target.source === 'gallery') void requestGalleryRefresh().catch(() => {})
    else if (dh) void scanOutputDirIncremental(dh).catch(() => {})
    showToast(overwrite ? `已覆盖 ${saved.filename}，原图备份：${saved.backup}` : `已另存 ${saved.filename}`)
    if (_currentPreviewSnapshot?.key === target.key) await openPreview(newId, imageSnapshot(newFile))
  } catch (error) { showToast(`保存失败：${(error as Error).message}`) }
  finally { _saving = false }
}


/** 绑定编辑工具栏与裁剪交互（一次性） */
function bindEditToolbar() {
  const editCanvas = document.getElementById('lbEditCanvas') as HTMLCanvasElement | null
  if (editCanvas) _painter = createOutputPainter({ canvas: editCanvas, get: () => _editBase,
    set: canvas => { _editBase = canvas }, changed: invalidateEditedDrag, busy: () => _saving || _editCropping })
  document.getElementById('lbPaintBar')?.addEventListener('click', async e => {
    const mode = (e.target as HTMLElement).closest<HTMLElement>('[data-paint]')?.dataset.paint as 'view' | 'pen' | 'mosaic' | 'cover' | undefined
    if (!mode || _saving || !_currentPreviewFileId) return
    if (mode !== 'view') {
      if (!await ensureEditSrc(_currentPreviewFileId)) { showToast('读取图片失败'); return }
      renderEdit()
    }
    setPaintMode(mode)
  })
  const configure = () => {
    const color = (document.getElementById('lbPaintColor') as HTMLInputElement).value
    const size = Number((document.getElementById('lbPaintSize') as HTMLInputElement).value)
    const mosaicSize = Number((document.getElementById('lbMosaicSize') as HTMLInputElement).value)
    const mosaicStrength = Number((document.getElementById('lbMosaicStrength') as HTMLInputElement).value)
    _painter?.configure({ color, brushSize: size, mosaicSize, mosaicStrength })
    const label = document.getElementById('lbPaintSizeValue'); if (label) label.textContent = String(size)
    const grainLabel = document.getElementById('lbMosaicSizeValue'); if (grainLabel) grainLabel.textContent = String(mosaicSize)
    const strengthLabel = document.getElementById('lbMosaicStrengthValue'); if (strengthLabel) strengthLabel.textContent = `${mosaicStrength}%`
  }
  document.getElementById('lbPaintColor')?.addEventListener('input', configure)
  document.getElementById('lbPaintSize')?.addEventListener('input', configure)
  document.getElementById('lbMosaicSize')?.addEventListener('input', configure)
  document.getElementById('lbMosaicStrength')?.addEventListener('input', configure)
  configure()
  document.getElementById('lbPaintUndo')?.addEventListener('click', () => {
    hideCropUI(); _editCropping = false; _painter?.undo()
  })
  document.getElementById('lbPreviewDrag')?.addEventListener('pointerenter', () => { void prepareEditedDrag() })
  document.getElementById('lbPreviewDrag')?.addEventListener('click', () => { void prepareEditedDrag() })
  const bar = document.getElementById('lbEditBar')
  bar?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement
    if (!btn) return
    const act = btn.dataset.act
    const fileId = _currentPreviewFileId
    if (!fileId || _saving || _painter?.active) return
    if (act === 'save' || act === 'overwrite') {
      // 未编辑也允许保存原图副本：先确保原图已加载
      if (!_editBase && !(await ensureEditSrc(fileId))) { showToast('⚠️ 读取图片失败'); return }
      void saveEditedImage(act === 'overwrite')
      return
    }
    if (act === 'reset') { resetEdit(); invalidateEditedDrag(); return }
    if (!_editBase && !(await ensureEditSrc(fileId))) { showToast('⚠️ 读取图片失败'); return }
    switch (act) {
      case 'rotl': rotateEdit(-90); break
      case 'rotr': rotateEdit(90); break
      case 'fliph': toggleFlip('h'); break
      case 'flipv': toggleFlip('v'); break
      case 'crop': enterCropMode(); break
    }
  })

  const layer = document.getElementById('lbCropLayer')
  if (layer) {
    let dragging = false
    layer.addEventListener('mousedown', (e) => {
      if (!_editCropping) return
      // 点击「确认/取消」按钮时 mousedown 会冒泡到这里，不能启动拖拽，
      // 否则会把已拖好的选框重置为 0，导致 confirmCrop 读到空框而裁剪失效
      if ((e.target as HTMLElement).closest('.lb-crop-btns')) return
      e.stopPropagation()
      dragging = true
      const r = layer.getBoundingClientRect()
      _cropStartX = e.clientX - r.left
      _cropStartY = e.clientY - r.top
      const rect = document.getElementById('lbCropRect') as HTMLElement
      rect.style.left = _cropStartX + 'px'
      rect.style.top = _cropStartY + 'px'
      rect.style.width = '0px'
      rect.style.height = '0px'
      rect.style.display = 'block'
    })
    layer.addEventListener('mousemove', (e) => {
      if (!dragging || !_editCropping) return
      const r = layer.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      const rect = document.getElementById('lbCropRect') as HTMLElement
      const lx = Math.min(_cropStartX, x)
      const ly = Math.min(_cropStartY, y)
      rect.style.left = lx + 'px'
      rect.style.top = ly + 'px'
      rect.style.width = Math.abs(x - _cropStartX) + 'px'
      rect.style.height = Math.abs(y - _cropStartY) + 'px'
    })
    layer.addEventListener('mouseup', () => { dragging = false })
    layer.addEventListener('mouseleave', () => { dragging = false })
  }

  document.getElementById('lbCropConfirm')?.addEventListener('click', (e) => { e.stopPropagation(); confirmCrop() })
  document.getElementById('lbCropCancel')?.addEventListener('click', (e) => {
    invalidateEditedDrag()
    e.stopPropagation()
    _editCropping = false
    hideCropUI()
    const wrap = document.getElementById('lbEditWrap')
    if (wrap) wrap.style.cursor = ''
  })
}

function releaseOutputPreviewResources(): void {
  ++_previewToken
  _currentPreviewFileId = ''
  _currentPreviewSnapshot = null
  if (_previewBlobUrl) URL.revokeObjectURL(_previewBlobUrl)
  _previewBlobUrl = ''
  resetEdit()
}

function preparePreviewImage(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const image = new Image()
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      image.onload = null
      image.onerror = null
      if (!ready) image.src = ''
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), 15000)
    image.onload = () => finish(true)
    image.onerror = () => finish(false)
    image.src = url
  })
}

async function openPreview(fileId: string, snapshot?: ImageSnapshot | null) {
  const token = ++_previewToken
  const target = snapshot === undefined ? imageSnapshot(fileId) : snapshot
  if (!target || !snapshotIsCurrent(target)) return
  // Commit the visible identity only after the replacement image is ready.
  const file = target.file
  if (!file) return

  // 预加载元数据到缓存（供「ℹ️ 元数据」按钮弹窗等使用）
  void getImageMetadata(target).catch(() => {})

  // 获取图片 URL
  const dh = sourceForFile(file).handle
  if (target.source === 'directory' && !dh) { showToast('请在目录栏重新授权该目录'); return }

  let imgUrl = ''
  // 开关开启时预览也走「干净副本」——否则用户在预览界面「右键 → 图片另存为」拿到的仍是
  // 带 prompt/workflow 的原图，整条功能被绕过（实测这是最常用的另存为路径）。
  // 关闭时保持原路径：native 模式零拷贝直连后端整文件、目录模式直接用原 File，
  // 既不动字节也不额外占内存。
  if (!isExportMetadataNoop(exportMetadataOptions())) {
    const r = await getExportBlob(fileId, target)
    if (!r) { if (token === _previewToken) showToast('图片读取失败，保留当前预览，请重试'); return }
    imgUrl = URL.createObjectURL(r.blob)
  } else if (target.source === 'gallery') {
    // 画廊来源：必须走 ComfyUI **原生** `/view`。
    // ⚠️ 2026-10-04 owner 实检：这里此前是 `_nativeOutputs || galleryIndexEnabled()`
    // 然后调 nativeOutputUrl()（`/api/tk/output-file`，插件并不提供）→ 真实 HTTP 404
    // → 用户点预览固定报「图片加载失败，保留当前预览，请重试」。
    // 现在按**操作捕获的 target.source** 选 provider，不再按全局能力猜。
    imgUrl = comfyViewUrl(target.path)
  } else if (target.source === 'native') {
    // TK 原生桥：/api/tk/output-file 由启动器提供，零拷贝直连
    imgUrl = nativeOutputUrl(file.path)
  } else {
    try {
      if (!dh) return
      const r = await getFileBlob(fileId, target)
      if (!r) { if (token === _previewToken) showToast("图片已变化或读取失败，保留当前预览，请重试"); return }
      imgUrl = URL.createObjectURL(r.blob)
    } catch {
      return
    }
  }

  if (token !== _previewToken || !snapshotIsCurrent(target)) {
    if (imgUrl.startsWith('blob:')) URL.revokeObjectURL(imgUrl)
    return
  }
  const ready = await preparePreviewImage(imgUrl)
  if (!ready || token !== _previewToken || !snapshotIsCurrent(target)) {
    if (imgUrl.startsWith('blob:')) URL.revokeObjectURL(imgUrl)
    if (!ready && token === _previewToken) showToast('图片加载失败，保留当前预览，请重试')
    return
  }
  if (_previewBlobUrl) URL.revokeObjectURL(_previewBlobUrl)
  _previewBlobUrl = imgUrl.startsWith('blob:') ? imgUrl : ''
  _currentPreviewFileId = fileId
  _currentPreviewSnapshot = target

  // 打开 lightbox
  const lightbox = document.getElementById('lightbox')
  const img = document.getElementById('lbImg') as HTMLImageElement
  const counter = document.getElementById('lbCounter')

  resetEdit()
  if (img) img.src = imgUrl
  setupLightboxView()
  const dragButton = document.getElementById('lbPreviewDrag')
  if (dragButton) dragButton.dataset.outputDrag = fileId
  invalidateEditedDrag()
  if (counter) {
    const total = useOutputStore.getState().filteredFiles.length
    const idx = outputPreviewIndex(useOutputStore.getState().filteredFiles, target)
    counter.textContent = total > 1 ? `${idx + 1}/${total}` : file.filename
  }
  if (lightbox) lightbox.classList.add('open')

  // 确保导航按钮可见（清除其他组件可能设置的 display:none）
  document.querySelectorAll('.lightbox .lb-nav').forEach(b => {
    (b as HTMLElement).style.display = ''
  })
}

/**
 * 显示星级评分选择器浮层
 */
function showStarPicker(idOrIds: string | string[], anchorEl?: HTMLElement) {
  const existing = document.querySelector('.outputs-rate-popup')
  if (existing) { existing.remove() }

  const popup = document.createElement('div')
  popup.className = 'outputs-rate-popup'
  popup.style.cssText = 'position:fixed;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px;display:flex;gap:4px;z-index:10000;box-shadow:0 4px 16px rgba(0,0,0,0.2)'

  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement('button')
    btn.textContent = '★'.repeat(i) + '☆'.repeat(5 - i)
    btn.style.cssText = 'border:none;background:transparent;cursor:pointer;font-size:18px;padding:4px 6px;border-radius:4px;color:var(--text)'
    btn.onmouseenter = () => btn.style.background = 'var(--accent-dim)'
    btn.onmouseleave = () => btn.style.background = 'transparent'
    btn.onclick = async () => {
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
      if (ids.length === 1) {
        try {
          await useOutputStore.getState().setRating(ids[0], i)
          showToast(`已评分 ${i} 星`)
        } catch (err) {
          console.warn('[Outputs] setRating 调用失败:', err)
          showToast('评分失败')
        }
      } else {
        try {
          await batchRate(ids, i)
          showToast(`已批量评分 ${i} 星`)
        } catch (err) {
          console.warn('[Outputs] batchRate 调用失败:', err)
          showToast('批量评分失败')
        }
      }
      popup.remove()
      renderOutputsView()
      updateBatchBar()
    }
    popup.appendChild(btn)
  }

  // 定位
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect()
    popup.style.top = (rect.bottom + 4) + 'px'
    popup.style.left = rect.left + 'px'
  } else {
    popup.style.top = '35%'
    popup.style.left = '50%'
    popup.style.transform = 'translateX(-50%)'
  }

  document.body.appendChild(popup)

  const closeOnClick = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node)) {
      popup.remove()
      document.removeEventListener('click', closeOnClick)
    }
  }
  setTimeout(() => document.addEventListener('click', closeOnClick), 0)
}

/** 分类选择器：列出已有分类 / 未分类 / 新建，应用到指定文件 */
function showCategoryPicker(ids: string[]) {
  const existing = document.querySelector('.outputs-category-picker')
  if (existing) existing.remove()

  const s = useOutputStore.getState()
  const cats = Array.from(new Set(s.files.map(f => f.category).filter(Boolean))).sort()

  const overlay = document.createElement('div')
  overlay.className = 'outputs-category-picker'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:14px;width:260px;max-height:70vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.5);'
  panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;"><h4 style="margin:0;font-size:13px">设置分类（${ids.length} 个文件）</h4></div>`

  const mkCat = (label: string, val: string) => {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.style.cssText = 'display:block;width:100%;padding:7px 10px;margin-bottom:4px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;background:transparent;color:var(--text);text-align:left;'
    btn.onmouseenter = () => { btn.style.background = 'var(--bg3)' }
    btn.onmouseleave = () => { btn.style.background = 'transparent' }
    btn.onclick = () => apply(val)
    panel.appendChild(btn)
  }
  mkCat('未分类', '')

  const apply = async (cat: string) => {
    overlay.remove()
    if (ids.length === 1) {
      await useOutputStore.getState().setCategory(ids[0], cat)
      showToast(cat ? `已设置分类「${cat}」` : '已清除分类')
    } else {
      const failed = await useOutputStore.getState().batchSetCategory(ids, cat)
      showToast(failed > 0
        ? `${ids.length - failed} 个文件已设分类「${cat}」（${failed} 个失败）`
        : `${ids.length} 个文件已设分类「${cat}」`)
    }
    renderOutputsView()
    updateFilterPanel()
  }

  cats.forEach(c => mkCat(c, c))

  const newWrap = document.createElement('div')
  newWrap.style.cssText = 'display:flex;gap:6px;margin-top:8px;'
  const input = document.createElement('input')
  input.placeholder = '新建分类…'
  input.style.cssText = 'flex:1;padding:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px;outline:none;'
  const addBtn = document.createElement('button')
  addBtn.textContent = '新建'
  addBtn.style.cssText = 'padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;background:var(--accent);color:#fff;'
  addBtn.onclick = () => { const v = input.value.trim(); if (v) apply(v) }
  input.onkeydown = (e) => { if (e.key === 'Enter') addBtn.click() }
  newWrap.append(input, addBtn)
  panel.appendChild(newWrap)

  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
  input.focus()
}

/** 分类管理：列出所有分类，支持删除/重命名 */
function showCategoryManager() {
  const s = useOutputStore.getState()
  const cats = Array.from(new Set(s.files.map(f => f.category).filter(Boolean))).sort()

  const overlay = document.createElement('div')
  overlay.className = 'outputs-category-picker'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:14px;width:300px;max-height:70vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.5);'
  panel.innerHTML = `<h4 style="margin:0 0 8px;font-size:13px">分类管理（${cats.length} 个分类）</h4>`

  if (cats.length === 0) {
    panel.innerHTML += `<p style="color:var(--text-dim);font-size:12px;margin:12px 0;">暂无分类，点击卡片右上角的分类按钮即可创建</p>`
  }

  for (const c of cats) {
    const count = s.files.filter(f => f.category === c).length
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--border);'
    row.innerHTML = `<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🏷 ${esc(c)} <small style="color:var(--text-dim)">(${count})</small></span>`
    const renameBtn = document.createElement('button')
    renameBtn.textContent = '重命名'
    renameBtn.style.cssText = 'padding:3px 8px;border:1px solid var(--border);border-radius:5px;cursor:pointer;font-size:11px;background:transparent;color:var(--text);'
    renameBtn.onclick = async () => {
      const n = (await promptModal('重命名分类', c, '输入新分类名'))?.trim()
      if (n && n !== c) {
        await useOutputStore.getState().renameCategory(c, n)
        if (useOutputStore.getState().filterCategory === c) {
          useOutputStore.getState().setFilterCategory(n)
        }
        overlay.remove()
        renderOutputsView()
        updateFilterPanel()
        showToast(`已重命名「${c}」→「${n}」`)
      }
    }
    const delBtn = document.createElement('button')
    delBtn.textContent = '删除'
    delBtn.style.cssText = 'padding:3px 8px;border:1px solid var(--danger, #f44);border-radius:5px;cursor:pointer;font-size:11px;background:transparent;color:#f66;'
    delBtn.onclick = async () => {
      const ok = await confirmModal('删除分类', `删除分类「${c}」？${count} 个文件将变为未分类`)
      if (ok) {
        await useOutputStore.getState().deleteCategory(c)
        if (useOutputStore.getState().filterCategory === c) {
          // 分类删除后图片会进入“未分类”，继续展示这些图片而不是落入空视图。
          useOutputStore.getState().setFilterCategory('__none__')
        }
        overlay.remove()
        renderOutputsView()
        updateFilterPanel()
        showToast(`已删除分类「${c}」`)
      }
    }
    row.append(renameBtn, delBtn)
    panel.appendChild(row)
  }

  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
}

/**
 * 测试接缝（仅回归测试使用，**不改变任何运行时行为**）。
 *
 * 为什么保留：预览与图片读取依赖真实 DOM / Image 解码 / fetch，
 * 必须能让回归驱动**生产用的同一份实现**（而不是在测试里复刻一份"等价预览"再自证）。
 * 已实际被 `tests/test_outputs_delete_recovery.mjs` 的 J 组引用
 * （断言 gallery 预览走 `/view`、native 走 `/api/tk/output-file`、原图读取同源）。
 */
export const __test = { openPreview, snapshotIsCurrent, currentImageSource, getFileBlob }
