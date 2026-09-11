// ── Outputs 模块主页面 ──

import { useOutputStore } from '../store/outputStore'
import { deleteFiles, renameFile, batchFavorite, batchRate } from '../services/outputService'
import { scanOutputDir, scanOutputDirIncremental, loadOutputDirHandle, buildDirTree, reparseAllMetadata, ensureMetadataFresh } from '../services/outputScanner'
import { restoreAllFromDb } from '../services/outputManifest'
import { preloadThumbnailsFromDb, probeBackendThumbs, backendThumbsEnabled, animaThumbUrl, probeGalleryIndex, galleryIndexEnabled, galleryEntries, fetchGalleryMeta } from '../services/outputThumbnail'
import { hashPath } from '../services/outputManifest'
import { outputsDb } from '../db/outputsDb'
import { addPrompt, generatePromptId } from '../store/prompts'
import { esc, escAttr, showToast, copyText, icon, attachSearchClear, debounce } from '../utils'
import { confirmModal, promptModal } from '../components/Modal'
import type { OutputFile, OutputMetadata, OutputDir, OutputScanStatus } from '../types/outputs'
import type { PromptEntry } from '../types'
import { extractLorasFromWorkflow, extractLoraTagsFromWorkflow } from '../services/outputMetadata'
import { extractPngTextChunks, injectPngTextChunks } from '../services/pngChunks'
import { VirtualScroll, type VirtualScrollItemStyle } from '../components/VirtualScroll'
import { MasonryVirtualScroll } from '../components/MasonryVirtualScroll'
import { ensureAllMetadata, countMetadataMissing } from '../services/outputMetadataIndex'
import { ImageNodeCache } from '../components/ImageNodeCache'
import { computeMasonryLayout } from '../components/masonry'
import { initOutputDragSelection, type OutputGridGeometry } from './outputDragSelection'
import JSZip from 'jszip'
import { nativeOutputUrl, nativeScanOutputs, nativeListOutputs, probeNativeStorage } from '../services/nativeStorage'

import {
  renderDirTree as renderDirTreeHtml,
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
let dirTree: OutputDir | null = null
let _lastClickedFileIndex = -1
let _currentPreviewFileId = ''
let _focusMode = false
// 当前预览的原图 Blob URL（切换/关闭时 revoke，避免反复预览累积大图内存）
let _previewBlobUrl = ''
let _nativeOutputs = false

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
  const metadata = page.items.flatMap(item => {
    const meta = item.metadata
    if (!meta) return []
    return [{
      imageId: item.id,
      model: meta.model || '', seed: meta.seed || '', steps: meta.steps || '', cfg: meta.cfg || '',
      sampler: meta.sampler || '', scheduler: meta.scheduler, denoise: meta.denoise, noiseSeed: meta.noiseSeed,
      vae: meta.vae || '', clipSkip: meta.clipSkip || 0, prompt: meta.prompt || '',
      negativePrompt: meta.negativePrompt || '', workflowJson: meta.workflowJson || '', rawMetadata: meta.rawMetadata || {},
    } satisfies OutputMetadata]
  })
  useOutputStore.setState({ dirHandle: null, rootPath: 'TK SQLite · ComfyUI/output', files, metadataCache: new Map() })
  useOutputStore.getState().putMetadataBatch(metadata)
  useOutputStore.getState().applyFilters()
  renderNativeDirTree(page.total)
}

function renderNativeDirTree(total: number) {
  const el = document.getElementById('outputsDirTree')
  if (el) el.innerHTML = `<div class="outputs-dir-node active" data-path=""><span class="outputs-dir-icon">🗃️</span><span class="outputs-dir-name">TK SQLite · ComfyUI/output</span><span class="outputs-dir-count">${total}</span></div>`
}

/**
 * 下载工作流 .json（ComfyUI 用 Load 或拖入画布导入最稳妥，替代复制——画布 Ctrl+V 易误导）
 */
async function downloadOutputWorkflow(meta: OutputMetadata | undefined, baseName: string) {
  let workflowJson = meta?.workflowJson || ''
  // Gallery 索引模式：摘要条目不含 workflowJson，点击时向后端按需取完整元数据
  if (!workflowJson && meta && galleryIndexEnabled()) {
    const file = useOutputStore.getState().files.find(f => f.id === meta.imageId)
    if (file) {
      const full = await fetchGalleryMeta(file.path)
      if (full && typeof full.workflowJson === 'string' && full.workflowJson) {
        workflowJson = full.workflowJson
        // 回写缓存（保留摘要指纹与已提取 LoRA，避免覆盖丢失）
        useOutputStore.getState().putMetadata({
          ...meta, ...(full as object), imageId: meta.imageId,
          workflowJson: '', rawMetadata: (full.rawMetadata as Record<string, string>) || {},
          workflowFingerprint: `g:${file.mtime / 1000}:${file.size}`,
          lorasExtracted: true,
        } as OutputMetadata)
      }
    }
  }
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

export async function initOutputs() {
  if (_initDone) return
  _initDone = true

  _nativeOutputs = await probeNativeStorage()
  // 后端直供图源探测（插件 ≥2.5.1 的 /anima/thumb）：可用则卡片 <img> 直接引用小图 URL，
  // 浏览器不再自己读盘解码原图。探测一次，失败（旧版插件/后端离线）自动走旧管线。
  await probeBackendThumbs()
  // Gallery 元数据索引探测（插件 ≥2.6.0 的 /anima/gallery/manifest）：可用则列表与按钮
  // 摘要全部由后端索引直出（秒出、无需目录授权）；不可用走旧管线。
  await probeGalleryIndex()
  if (galleryIndexEnabled() && !_nativeOutputs) {
    await restoreOutputsFromDb()
    bindOutputsEvents()
    bindOutputsSettingsRefresh()
    startOutputsAutoScan()
    window.addEventListener('focus', triggerOutputsIncrementalScan)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) triggerOutputsIncrementalScan() })
    return
  }
  if (_nativeOutputs) {
    try {
      await refreshNativeOutputs()
      renderOutputsView()
    } catch (error) {
      console.warn('[Outputs] TK SQLite 初始化失败，回退 IndexedDB:', error)
      _nativeOutputs = false
    }
  }
  if (_nativeOutputs) {
    bindOutputsEvents()
    bindOutputsSettingsRefresh()
    startOutputsAutoScan()
    window.addEventListener('focus', triggerOutputsIncrementalScan)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) triggerOutputsIncrementalScan() })
    return
  }

  // 尝试恢复目录句柄与权限状态（句柄引用始终恢复；权限降级时用横幅引导一键重新授权）
  const loadResult = await loadOutputDirHandle()

  const dh = useOutputStore.getState().dirHandle
  if (dh && loadResult.permission === 'granted') {
    // 解析逻辑升级时自动失效旧元数据缓存并重新解析（增量扫描按 mtime 会跳过未变更文件）
    // ⚠️ 首屏红线：这里绝不能 await —— 解析器版本变化时它会全库重新解析（逐个读回近 4000
    // 个原图再解析，实测 195MB IndexedDB 写入 / 数分钟），await 在首次渲染之前就是「卡几分钟
    // 且页面毫无变化」。现在先用现有缓存渲染，重解析后台跑、结束后再刷新一次。
    void ensureMetadataFresh(dh).then(fresh => { if (fresh) { renderOutputsView(); updateFilterPanel() } })
    // 快速恢复：直接从 DB 恢复文件列表/元数据/缩略图缓存（跳过全量目录遍历），首屏秒出
    await restoreOutputsFromDb()
    // 构建目录树（buildDirTree 是轻量操作，仅遍历文件名）
    // 目录树也不挡首屏（要遍历整个输出目录，几千个条目）
    void buildDirTree(dh).then(t => { dirTree = t; renderDirTree(t); renderOutputsView() }).catch(() => {})
  } else if (dh) {
    // 权限降级（prompt/denied，如浏览器重启后）：显示重新授权横幅，避免被迫重新「选择目录」
    showReauthBanner()
  }

  // 首次渲染（恢复缓存后的网格）
  renderOutputsView()

  // 权限正常且有缓存时，后台增量扫描（仅发现新文件才重建网格，避免无变化也重建导致闪烁）
  if (dh && loadResult.permission === 'granted' && useOutputStore.getState().files.length > 0) {
    try {
      const count = await scanOutputDirIncremental(dh)
      if (count > 0) { dirTree = await buildDirTree(dh); renderDirTree(dirTree); renderOutputsView() }
    } catch { /* 静默 */ }
  }

  bindOutputsEvents()
  bindOutputsSettingsRefresh()

  // ── 自动检测新图：窗口获得焦点 / 页面重新可见 / 60s 轮询 ──
  startOutputsAutoScan()
  window.addEventListener('focus', triggerOutputsIncrementalScan)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) triggerOutputsIncrementalScan() })

  // ── 元数据不再在进入页面时全库预载（2026-09-10 改按需）──
  // 旧实现用「空闲分片」把**全部 3918 条**元数据读了一遍：每条记录都带 workflowJson
  // （几十~几百 KB），bulkGet 的结构化克隆在主线程上就是数百 MB 的搬运；跑完还有
  // 第二次全库遍历（scheduleIdleLoraExtraction）再次读盘解析工作流。这就是
  // 「进 Outputs 要等两三分钟才用得顺」的来源 —— 分片只是把它摊开，并没有减少总量。
  // 现在三条按需路径取代它：
  //   ① 可见卡片：loadVisibleMetadata() 随滚动逐屏读单条（含 LoRA 提取，只解析这一张的工作流）；
  //   ② 单图操作：复制 Prompt / 保存到 Prompt 库 / 复制 LoRA / 下载工作流 → 只读那一张；
  //   ③ 全局筛选：只有真正用到「基座模型 / LoRA / 标签」筛选时，才触发一次分片补齐（带提示）。

  // ── 扫描进度订阅 ──
  let prevScanStatus: OutputScanStatus = 'idle'
  useOutputStore.subscribe((state) => {
    if (state.scanStatus !== prevScanStatus || state.scanStatus === 'scanning') {
      prevScanStatus = state.scanStatus
      updateScanProgress(state.scanStatus, state.scanProgress)
    }
  })
}

// ── 目录权限过期横幅 ──

function showReauthBanner() {
  const el = document.getElementById('outputsReauthBanner')
  if (el) el.style.display = 'flex'
}

function hideReauthBanner() {
  const el = document.getElementById('outputsReauthBanner')
  if (el) el.style.display = 'none'
}

/** 一键重新授权上次目录：浏览器重启后 FS Access 授权回到 prompt，点击恢复即可继续用增量扫描 */
async function reauthorizeOutputs() {
  const dh = useOutputStore.getState().dirHandle
  if (!dh) { showToast('⚠️ 没有可恢复的目录，请重新选择'); return }
  try {
    const perm = await (dh as any).requestPermission({ mode: 'readwrite' })
    if (perm === 'granted') {
      hideReauthBanner()
      // 清除灰图缩略图缓存，强制从文件系统重新加载
      useOutputStore.getState().invalidateThumbnails()
      await scanOutputDirIncremental(dh)
      dirTree = await buildDirTree(dh)
      renderDirTree(dirTree)
      renderOutputsView()
      updateFilterPanel()
      showToast('✅ 目录已重新授权')
    } else {
      showToast('⚠️ 授权未完成，请点击按钮重新授权')
    }
  } catch {
    showToast('⚠️ 授权失败，请重新选择目录')
  }
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
  }, 60_000)
}

async function triggerOutputsIncrementalScan() {
  const s = useOutputStore.getState()
  if (_nativeOutputs) {
    if (!isOutputsActive() || s.scanStatus === 'scanning') return
    try { await refreshNativeOutputs(); renderOutputsView() } catch { /* 静默 */ }
    return
  }
  if (s.dirHandle && s.files.length > 0 && isOutputsActive() && s.scanStatus !== 'scanning') {
    try {
      const count = await scanOutputDirIncremental(s.dirHandle)
      if (count > 0) { renderOutputsView(); updateFilterPanel() }
    } catch { /* 静默 */ }
  }
}

let _lastIncrementalScan = 0

export async function activateOutputs() {
  if (!_initDone) return
  if (_nativeOutputs) {
    try { await refreshNativeOutputs() } catch { /* 保留当前缓存 */ }
    renderOutputsView()
    setupInfiniteScroll()
    return
  }
  const state = useOutputStore.getState()

  // 有目录句柄时尝试增量扫描
  if (state.dirHandle) {
    const fileCount = state.files.length
    if (fileCount === 0) {
      // 缓存为空 -> 先尝试从 DB 快速恢复（跳过目录遍历），无缓存才全量扫描
      const ok = await restoreOutputsFromDb()
      if (!ok) {
        try {
          await scanOutputDir(state.dirHandle)
          dirTree = await buildDirTree(state.dirHandle)
          renderDirTree(dirTree)
          renderOutputsView()
        } catch { /* 静默失败 */ }
      }
    } else {
      // 已有缓存 -> 先立即按当前缓存渲染（栏目刚显示，容器已有真实宽度；
      // 若等扫描完成再渲染，期间会显示隐藏期留下的退化几何：单行+图片重叠）
      renderOutputsView()
      // 尝试检测新文件（轻量操作）；60s 节流避免每次切换栏目都遍历目录
      const now = Date.now()
      if (now - _lastIncrementalScan >= 60000) {
        _lastIncrementalScan = now
        try {
          const count = await scanOutputDirIncremental(state.dirHandle)
          if (count > 0) {
            dirTree = await buildDirTree(state.dirHandle)
            renderDirTree(dirTree)
            renderOutputsView()
          }
        } catch { /* 静默失败 */ }
      }
    }

    // ── 缩略图 / 元数据都不再做「全库补生成」（2026-09-10 改按需）──
    // 旧代码在这里调用 ensureThumbnails(dirHandle)：它对所有缺失缩略图的图片
    // （用户库实测 3782 张）按 **2 张/批串行** 读盘 + 生成 + 写 IndexedDB，一轮就是
    // 两三分钟的磁盘/主线程占用 —— 与元数据全量预载一起，构成「进页面要等两三分钟」。
    // 现在两者都只服务可见区：
    //   · 缩略图：loadImageThumbnail → 内存 → IndexedDB → 只读这一张文件生成并缓存；
    //   · 元数据：loadVisibleMetadata → 只读这一张（见 store.loadMetadata，带并发去重）。
    // 滚到哪补到哪，缓存写入 IndexedDB 后长期命中，不存在需要「先跑完一轮」的全局任务。
  } else {
    // 没有目录句柄，提示用户选择
    const empty = document.querySelector('.outputs-empty') as HTMLElement
    if (empty) empty.style.display = 'flex'
  }

  // 每次进入栏目都重渲染：虚拟滚动的行列几何依赖可见宽度
  // （旧 CSS grid 在显示时自动 reflow；现在由 JS 计算，隐藏期渲染过宽 0 的几何必须重建）
  renderOutputsView()

  setupInfiniteScroll()
}

function renderDirTree(dir: OutputDir | null) {
  const el = document.getElementById('outputsDirTree')
  if (!el) return
  const currentPath = useOutputStore.getState().currentPath
  el.innerHTML = renderDirTreeHtml(dir, currentPath)
}

function renderOutputsView() {
  const state = useOutputStore.getState()
  renderImageGrid(state)
  // 同步填充已缓存的缩略图，避免操作后图片闪烁
  document.querySelectorAll('.outputs-card img[data-file-path], .outputs-list-card-img img[data-file-path]').forEach(img => {
    const p = (img as HTMLImageElement).dataset.filePath
    if (p) {
      const cached = state.thumbMemory.get(p)
      if (cached) (img as HTMLImageElement).src = cached
    }
  })
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

// 筛选面板模型/LoRA 选项增量缓存：每个 meta 只提取一次（修复：每次渲染全量遍历 metadataCache + JSON.parse workflow）
const _filterOptModels = new Set<string>()
const _filterOptLoras = new Set<string>()
const _filterOptDoneIds = new Set<string>()

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
  const hasMeta = s.metadataCache.size > 0
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

  // 填充 datalist 选项并显示/隐藏筛选组（增量缓存：每个 meta 只提取一次 LoRA，避免每次渲染全量 JSON.parse）
  if (hasMeta) {
    // 删除/清空导致缓存比数据多太多时重建增量缓存（如重解析清空 metadataCache）
    if (_filterOptDoneIds.size > s.metadataCache.size + 200) {
      _filterOptDoneIds.clear()
      _filterOptModels.clear()
      _filterOptLoras.clear()
    }
    for (const [id, meta] of s.metadataCache) {
      if (_filterOptDoneIds.has(id)) continue
      _filterOptDoneIds.add(id)
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

  const files = state.filteredFiles
  const hasDir = !!state.dirHandle

  if (files.length === 0) {
    destroyOutputsVS()
    removeOutputsSentinel()
    // 库里有图但被筛选/路径滤空 → 给准确空状态 + 一键清除筛选（防"幽灵筛选把历史日期藏掉"的困惑）
    el.innerHTML = state.files.length > 0 ? renderFilteredEmpty() : renderEmpty(hasDir)
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
    const layout = computeMasonryLayout(files, geom.cols, geom.cardW, geom.gap)

    // renderItem 只负责卡片内容；二维位置由 MasonryVirtualScroll 的 item rect 承担。
    // 普通 VirtualScroll 会把高度做一维前缀累加，无法表达「多列错位、同一 top 上有多张卡」的瀑布流。
    const renderItem = (index: number, style: VirtualScrollItemStyle) => {
      const s = useOutputStore.getState()
      const f = files[index]
      if (!f) return ''
      const meta = s.metadataCache.get(f.id)
      // 传「布局实际使用的盒子比例」（极端比例已被上下限截断），而不是原图比例：
      // CSS 用 高度 = 宽度 ÷ 比例 反算高度，两者同源才能保证盒子高度与虚拟滚动
      // 的行几何严格一致（否则被截断的卡会比预算更高，压到下一行）。
      const boxAspect = layout.boxAspects[index]
      // thumbSrc 同步回填内存缩略图：虚拟滚动滚动时条目会被重建，
      // 若等 IntersectionObserver 异步回填会有几帧黑图闪烁
      return renderImageCard(f, meta ?? null, s.selectedIds.has(f.id), meta?.loras?.length ? meta.loras : undefined, undefined, backendThumbsEnabled() ? animaThumbUrl(f.path, 512) : (s.thumbMemory.get(f.path) || ''), boxAspect)
    }

    const getItemRect = (index: number) => ({
      top: layout.tops[index],
      left: layout.lefts[index],
      width: layout.widths[index],
      height: layout.heights[index],
    })

    // 布局/内容签名：只放会真正改变「卡片内容或几何」的因素。
    // 刻意不含 thumbMemory —— 缩略图到位时由 loadImageThumbnail 直接改对应 <img>.src，
    // 不需要重建成百上千个节点；一旦重建，图片就会重新请求，首屏必抖。
    // ⚠️ 元数据用 metadataVersion（内容版本号）而不是 metadataCache.size（2026-09-11 修）：
    // 元数据是同 key 覆盖（size 不变）—— 用 size 会让「按需加载到 LoRA 数据」无法触发重建，
    // 卡片 DOM 停在无「复制 LoRA 标签」按钮的旧 HTML 上（用户报的按钮消失/时有时无）。
    const vsSignature = [
      geom.cols, Math.round(geom.cardW), geom.gap,
      files.length, files[0]?.id ?? '', files[files.length - 1]?.id ?? '',
      state.selectedIds.size, state.metadataVersion ?? state.metadataCache.size, Math.round(layout.total),
    ].join('|')

    if (_outputsVS instanceof MasonryVirtualScroll && el.querySelector('.masonry-virtual-scroll-inner')) {
      el.querySelector('.outputs-empty')?.remove()   // 清掉静态 HTML 占位残留
      _outputsVS.update({
        totalItems: files.length,
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
        totalItems: files.length,
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
    el.innerHTML = renderList(files, state.selectedIds, state.metadataCache)
    // 同步回填已缓存的缩略图，避免重建 DOM 时图片从灰图重新闪烁
    for (const img of el.querySelectorAll('img[data-file-path]')) {
      const p = (img as HTMLImageElement).dataset.filePath
      if (p) {
        const cached = state.thumbMemory.get(p)
        if (cached) (img as HTMLImageElement).src = cached
      }
    }
    setupInfiniteScroll()
  }
}

/** 复用卡片时同步 meta 相关显示（model 文本 / prompt / LoRA / 工作流按钮），不重建图片 */
function syncCardMeta(card: HTMLElement, file: OutputFile, meta: OutputMetadata | null) {
  const metaRow = card.querySelector<HTMLElement>('.outputs-card-meta')
  let modelEl = card.querySelector<HTMLElement>('.outputs-card-model')
  if (meta?.model) {
    if (modelEl) {
      modelEl.textContent = `🏷 ${meta.model.slice(0, 20)}`
      modelEl.title = meta.model
    } else if (metaRow) {
      const span = document.createElement('span')
      span.className = 'outputs-card-model'
      span.title = meta.model
      span.textContent = `🏷 ${meta.model.slice(0, 20)}`
      metaRow.prepend(span)
    }
  } else if (modelEl) {
    modelEl.remove()
  }

  const actionsEl = card.querySelector<HTMLElement>('.outputs-card-actions')
  if (!actionsEl) return
  const hasPrompt = !!meta?.prompt
  const hasLoras = !!meta?.loras?.length
  const hasWf = !!meta?.hasWorkflow
  const id = file.id
  actionsEl.innerHTML =
    (hasPrompt ? `<button class="outputs-copy-prompt-btn" data-id="${id}" title="复制正面 Prompt">${icon('file-text', 12)}</button>` : '') +
    (hasPrompt ? `<button class="outputs-save-prompt-btn" data-id="${id}" title="将 Prompt 和图片存入 Prompt 库">${icon('book', 12)}</button>` : '') +
    (hasLoras ? `<button class="outputs-copy-lora-btn" data-id="${id}" title="复制 LoRA 标签">${icon('tag', 12)}</button>` : '') +
    (hasWf ? `<button class="outputs-dl-wf-btn" data-id="${id}" title="下载工作流（保存 .json，拖入 ComfyUI 画布导入）">${icon('download', 12)}</button>` : '') +
    (meta ? `<button class="outputs-meta-btn" data-id="${id}" title="查看元数据">${icon('info', 12)}</button>` : '')
}

function updateOutputsStats(state: ReturnType<typeof useOutputStore.getState>) {
  const el = document.querySelector('.outputs-stats') as HTMLElement
  if (!el) return
  el.innerHTML = renderStats(state.files.length, state.filteredFiles.length, state.selectedIds.size)
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
  // 初始化拖拽框选（放在最前面，避免被后续代码的运行时错误阻断）
  initOutputDragSelection({
    getGridGeometry: outputsGeom,
    onSelectionChanged: () => { syncSelectionUI(); updateBatchBar() },
  })
  // 预览图片编辑工具栏（旋转/裁剪/保存）
  bindEditToolbar()

  // 事件委托 - 单一 click handler
  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement

    // 重新授权目录（浏览器重启后权限降级）
    if (target.closest('.outputs-reauth-btn')) {
      await reauthorizeOutputs()
      return
    }

    // 选择目录
    if (target.closest('.outputs-select-btn')) {
      if (!('showDirectoryPicker' in window)) {
        showCompatMessage()
        return
      }
      try {
        const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
        await scanOutputDir(dirHandle)
        dirTree = await buildDirTree(dirHandle)
        renderDirTree(dirTree)
        renderOutputsView()
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          showToast('选择目录失败')
        }
      }
      return
    }

    // 刷新目录 —— 用增量扫描：只处理新增/变更文件，已加载的图片不动
    if (target.closest('.outputs-refresh-btn')) {
      const dh = useOutputStore.getState().dirHandle
      if (!dh) {
        // 无目录句柄时给明确反馈（此前静默无反应，用户以为按钮坏了）
        showToast('请先点击「选择」授权输出目录')
        return
      }
      try {
        showToast('正在扫描新图片…')
        const count = await scanOutputDirIncremental(dh)
        dirTree = await buildDirTree(dh)
        renderDirTree(dirTree)
        renderOutputsView()
        showToast(count > 0 ? `✅ 已刷新：${count} 个文件有变化` : 'ℹ️ 没有新图片')
      } catch {
        showToast('⚠️ 刷新失败')
      }
      return
    }

    // 强制重新解析元数据（解析逻辑升级后，旧的 prompt/workflow 缓存需重扫才会更新）
    if (target.closest('.outputs-reparse-btn')) {
      const dh = useOutputStore.getState().dirHandle
      if (!dh) { showToast('请先点击「选择」授权输出目录'); return }
      // 重活：先确认，防止误点后长时间无反馈
      const ok = await confirmModal('重解析全部图片元数据？', '将逐个读取所有图片的 PNG 元数据并更新缓存。图片较多时可能需要一些时间，扫描进度会显示在工具栏下方。')
      if (!ok) return
      try {
        await reparseAllMetadata(dh)
        renderOutputsView()
        showToast('✅ 重解析完成')
      } catch {
        showToast('⚠️ 重解析失败')
      }
      return
    }

    // 目录树点击
    const dirNode = target.closest('.outputs-dir-node') as HTMLElement
    if (dirNode) {
      const path = dirNode.dataset.path
      useOutputStore.getState().setCurrentPath(path || '')
      renderDirTree(dirTree!)
      renderOutputsView()
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
      if (id) { copyImageToClipboard(id); return }
    }

    // 下载按钮
    const downloadBtn = target.closest('.outputs-download-btn') as HTMLElement
    if (downloadBtn) {
      const id = downloadBtn.dataset.id
      if (id) { downloadImage(id); return }
    }

    // 复制 Prompt 按钮
    const copyPromptBtn = target.closest('.outputs-copy-prompt-btn') as HTMLElement
    if (copyPromptBtn) {
      const id = copyPromptBtn.dataset.id
      if (id) {
        // 按需读取**这一张**的元数据（内存 → 单条 DB 读），不再依赖「进页面时已全量预载」
        const meta = await useOutputStore.getState().loadMetadata(id)
        if (meta?.prompt) {
          try {
            await navigator.clipboard.writeText(meta.prompt)
            showToast('Prompt 已复制到剪贴板')
          } catch {
            showToast('复制失败')
          }
        } else {
          showToast('该图片无 Prompt')
        }
      }
      return
    }

    // 保存 Prompt（连同独立图片副本）到 Prompt 库
    const savePromptBtn = target.closest('.outputs-save-prompt-btn') as HTMLElement
    if (savePromptBtn) {
      const id = savePromptBtn.dataset.id
      if (id) await saveOutputPromptToLibrary(id)
      return
    }

    // 复制 LoRA 标签按钮（复用统一提取逻辑，与图片解析一致，兼容 UI/API/LoraManager）
    const copyLoraBtn = target.closest('.outputs-copy-lora-btn') as HTMLElement
    if (copyLoraBtn) {
      const id = copyLoraBtn.dataset.id
      if (id) {
        // 完整 workflow（含权重）从 DB 懒读——内存缓存是瘦身版（无 workflowJson）
        const full = await outputsDb.metadata.get(id)
        if (full?.workflowJson) {
          const tags = extractLoraTagsFromWorkflow(full.workflowJson, full.rawMetadata)
          if (tags.length > 0) {
            await navigator.clipboard.writeText(tags.join(', '))
            showToast(`已复制 ${tags.length} 个 LoRA 标签`)
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
        // 完整 workflow 从 DB 懒读（内存缓存为瘦身版）
        const meta = await outputsDb.metadata.get(id)
        const file = useOutputStore.getState().files.find(f => f.id === id)
        await downloadOutputWorkflow(meta ?? undefined, file?.filename || 'workflow')
      }
      return
    }

    // 元数据按钮（卡片底部，独立弹窗，不依赖放大预览）
    const metaBtn = target.closest('.outputs-meta-btn') as HTMLElement
    if (metaBtn) {
      const id = metaBtn.dataset.id
      if (id) {
        openMetaPanel(id)
      }
      return
    }

    // 预览按钮
    const previewBtn = target.closest('.outputs-preview-btn') as HTMLElement
    if (previewBtn) {
      const id = previewBtn.dataset.id
      if (id) {
        openPreview(id)
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
          await deleteFiles(ids)
          renderOutputsView()
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

  // 关闭 lightbox 时释放最后一张预览的原图 Blob URL
  document.querySelector('.lightbox .close')?.addEventListener('click', () => {
    if (_previewBlobUrl) {
      URL.revokeObjectURL(_previewBlobUrl)
      _previewBlobUrl = ''
    }
  })

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

    const groups = createOutputContextMenu(fileIds, {
      onPreview: (id) => openPreview(id),
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
          await deleteFiles([id])
          renderOutputsView()
        }
      },
      onCopyMetadata: async (id) => {
        // 按需读取这一张（内存未命中就单条回 DB），不再依赖全库预载
        const meta = await useOutputStore.getState().loadMetadata(id)
        if (meta) {
          copyText(JSON.stringify(meta, null, 2))
          showToast('元数据已复制')
        }
      },
      onCopyPrompt: async (id) => {
        const meta = await useOutputStore.getState().loadMetadata(id)
        if (meta?.prompt) {
          copyText(meta.prompt)
          showToast('Prompt 已复制')
        }
      },
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
          await deleteFiles(ids)
          renderOutputsView()
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
      onCopyImage: (id) => { copyImageToClipboard(id) },
      onDownloadImage: (id) => { downloadImage(id) },
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
            deleteFiles(ids).then(() => renderOutputsView())
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
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        useOutputStore.getState().setSearchQuery(searchInput.value)
        renderOutputsView()
      }, 300)
    })
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
          requestVisibleMetadata(fileId)   // 元数据按需：只读这一张（含 LoRA 提取）
        }
        observer.unobserve(img)
      }
    }
  }, { root: grid, rootMargin: '600px 0px' })

  // 观察所有图片
  const observeImages = () => {
    let dbgObserved = 0, dbgDirect = 0
    document.querySelectorAll<HTMLImageElement>('.outputs-card img[data-file-id], .outputs-list-card-img img[data-file-id]').forEach(img => {
      const id = img.dataset.fileId
      // renderImageCard 已同步写入 thumbMemory 命中项；不要再观察并重复设置相同 src，
      // 某些 Chromium 版本会因此重新走图片解码管线，造成一次黑帧。
      if (img.getAttribute('src')) {
        // 缩略图已就绪（thumbMemory 命中）→ 不重复观察，但**元数据仍要按需加载**：
        // 否则这些卡片拿不到 meta.loras，「复制 LoRA 标签」按钮永不出现（2026-09-11 修）。
        // requestVisibleMetadata 内部有「已提取/无需提取」早退与排队去重，可安全重复调用。
        dbgDirect++
        if (id) requestVisibleMetadata(id)
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
          ensureMetadataForGlobalFilter()
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

/** 可见卡片元数据的并发上限：一屏十几张卡同时进屏时不至于把 IndexedDB 读取扎堆 */
const VISIBLE_META_CONCURRENCY = 6
let _visibleMetaRunning = 0
const _visibleMetaQueue: string[] = []
/** 已入队/已处理，避免滚动中反复排队 */
const _metaQueued = new Set<string>()
/** DB 读超时后的重试次数：兜底 IndexedDB 偶发悬挂，保证按钮最终能出现 */
const _metaRetry = new Map<string, number>()
const META_MAX_RETRY = 3
/** /anima/thumb 覆盖不到的路径（非 output 目录的授权扫描）：会话内直接走旧管线 */
const _thumbUrlBlocked = new Set<string>()
/** 诊断开关：URL 带 ?metaDbg=1 时打印可见区元数据链路（生产无副作用） */
const META_DBG = (() => { try { return new URLSearchParams(location.search).has('metaDbg') } catch { return false } })()

/** 元数据陆续到位时合并刷新：一屏的卡片只重建一次网格（图片走 ImageNodeCache 复用，不闪） */
let _metaRefreshTimer: ReturnType<typeof setTimeout> | null = null
/** 诊断：本屏元数据从首次请求到合并刷新的耗时（按需加载是否真的没有阻塞，看这一行） */
let _metaRefreshStartedAt = 0
let _metaRefreshCount = 0
function scheduleMetaRefresh(): void {
  if (_metaRefreshStartedAt === 0) _metaRefreshStartedAt = performance.now()
  _metaRefreshCount++
  if (_metaRefreshTimer !== null) return
  _metaRefreshTimer = setTimeout(() => {
    _metaRefreshTimer = null
    const cost = Math.round(performance.now() - _metaRefreshStartedAt)
    const loaded = useOutputStore.getState().metadataCache.size
    console.log(`[outputs] 元数据按需加载：本屏 ${_metaRefreshCount} 条，${cost}ms（缓存中共 ${loaded} 条；无全库读取）`)
    _metaRefreshStartedAt = 0
    _metaRefreshCount = 0
    // ⚠️ 增量同步，不要全量重建（2026-09-11）：
    // metadataVersion 进签名后，滚动浏览期间每 250ms 就会满足一次「签名变化」→
    // renderOutputsView → VS 全量重建可见卡片（replaceChildren）→ 主线程被反复占住，
    // 点击目录树/切换栏目全部排队无响应，点击目标还常落在重建窗口里被销毁（点了没反应）。
    // 元数据只影响卡片的 model 行与操作按钮 → 用 syncCardMeta 逐卡同步即可，图片节点不动。
    const state = useOutputStore.getState()
    if (state.viewMode !== 'grid') {
      renderOutputsView()   // 列表模式无逐卡同步支持，保持全量重建
      return
    }
    const byId = new Map(state.filteredFiles.map(f => [f.id, f]))
    let synced = 0
    document.querySelectorAll<HTMLElement>('.outputs-card[data-id]').forEach(card => {
      const id = card.dataset.id
      if (!id) return
      const file = byId.get(id)
      if (!file) return
      syncCardMeta(card, file, state.metadataCache.get(id) ?? null)
      synced++
    })
    updateFilterPanel()
    if (synced === 0) renderOutputsView()   // 无可同步卡片（异常态）→ 兜底全量重建
  }, 250)
}

/**
 * 可见卡片进屏时按需读它的元数据（含 LoRA 提取：只解析这一张的工作流）。
 * 由下方 IntersectionObserver 在图片进屏时调用 —— 「滚到哪读到哪」，
 * 不再有进入页面时的全库遍历；读到的结果进内存缓存，回滚不再重复读盘。
 */
function requestVisibleMetadata(fileId: string): void {
  if (!fileId) return
  const cached = useOutputStore.getState().metadataCache.get(fileId)
  // ⚠️ 早退判据不能只看「有没有缓存」（2026-09-11 修）：条目可能已被全库元数据补齐
  // （ensureAllMetadata → putMetadataBatch）写成了未提取 LoRA 的瘦身版（loras=[]）。
  // 只看 has() 会导致这些条目被判为"已加载" → 永不补提取 → 「复制 LoRA 标签」按钮消失后不恢复。
  // 正确判据：已加载 **且**（无工作流可提 或 LoRA 已提取）。
  if (cached && (!cached.hasWorkflow || cached.lorasExtracted)) {
    if (META_DBG) console.log('[meta-dbg] requestVisible skip', fileId, { hasWf: cached.hasWorkflow, extracted: cached.lorasExtracted })
    return
  }
  if (_metaQueued.has(fileId)) return
  if (META_DBG) console.log('[meta-dbg] requestVisible enqueue', fileId, { cached: !!cached, hasWf: cached?.hasWorkflow, extracted: cached?.lorasExtracted })
  _metaQueued.add(fileId)
  _visibleMetaQueue.push(fileId)
  void pumpVisibleMetadata()
}

async function pumpVisibleMetadata(): Promise<void> {
  while (_visibleMetaRunning < VISIBLE_META_CONCURRENCY && _visibleMetaQueue.length > 0) {
    const id = _visibleMetaQueue.shift()!
    _visibleMetaRunning++
    void useOutputStore.getState().loadMetadata(id, { loras: true })
      .then(() => {
        _metaRetry.delete(id)
        const c = useOutputStore.getState().metadataCache.get(id)
        if (META_DBG) console.log('[meta-dbg] pumped', id, { loras: c?.loras?.length, extracted: c?.lorasExtracted, hasWf: c?.hasWorkflow })
        if (useOutputStore.getState().metadataCache.has(id)) scheduleMetaRefresh()
      })
      .catch((err) => {
        if (META_DBG) console.log('[meta-dbg] pump ERROR', id, String(err && (err.stack || err.message || err)).slice(0, 300))
        // DB 读超时（IndexedDB 偶发悬挂，实测扫描刚结束时最明显）→ 退避重试。
        // 不重试的话这些卡片永久缺 loras，「复制 LoRA 标签」按钮不会出现。
        if ((err as Error)?.name === 'MetadataReadTimeoutError') {
          const n = _metaRetry.get(id) || 0
          if (n < META_MAX_RETRY) {
            _metaRetry.set(id, n + 1)
            setTimeout(() => requestVisibleMetadata(id), 800 * (n + 1))
          } else if (META_DBG) {
            console.log('[meta-dbg] pump give up', id, { retries: n })
          }
        }
      })
      .finally(() => {
        _visibleMetaRunning--
        _metaQueued.delete(id)
        if (_visibleMetaQueue.length > 0) void pumpVisibleMetadata()
      })
  }
}

/**
 * 只有用户**真正用到全局筛选**时才补齐全库元数据。
 * 必要性：applyFilters 对「基座模型 / LoRA / 标签」三项会排除元数据未加载的条目 ——
 * 懒加载后若不补齐，这三项筛选会静默漏结果（是结果错，不是变慢）。
 */
let _filterMetaToastShown = false
function ensureMetadataForGlobalFilter(): void {
  const missing = countMetadataMissing()
  if (missing === 0) return
  if (!_filterMetaToastShown) {
    _filterMetaToastShown = true
    showToast(`正在后台读取全部元数据以支持全局筛选（还有 ${missing} 张，可继续浏览）…`)
  }
  void ensureAllMetadata().then(() => {
    _filterMetaToastShown = false
    updateFilterPanel()
    renderOutputsView()
    showToast('✅ 全部元数据已就绪，筛选/关联结果已刷新')
  })
}

/**
 * 从 DB 快速恢复缓存（页面刷新后首屏秒出，跳过全量目录遍历）：
 * files 列表 + 缩略图批量回填内存（元数据改为按需），一次渲染到位；
 * 文件系统变化由后续增量扫描（initOutputs/activateOutputs 已有）后台校正。
 */
/** 首开只喂这么多条：够铺满首屏并留一点缓冲，其余空闲分片追加 */
const BOOT_FILES = 300
/** 空闲追加大分片：少几次重建、也少几次 setState */
const RESTORE_SLICE = 800
let _idleRestoreToken = 0

/**
 * 空闲分片追加剩余文件。
 * 目的：把「一次性装配 3900+ 条 + 首屏布局 + 首屏取图」从进入页面的那一刻挪走。
 * 首屏先出图、先可交互，剩余条目在浏览器空闲时补齐；每次追加后重建一次网格，
 * 卡片图片走 thumbMemory / ImageNodeCache 复用，不会重新请求。
 */
function scheduleIdleRestoreRest(rest: OutputFile[]): void {
  const token = ++_idleRestoreToken
  let cursor = 0
  const schedule = (fn: () => void) => {
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
    if (typeof idle === 'function') idle(fn, { timeout: 1500 })
    else setTimeout(fn, 40)
  }
  const step = () => {
    if (token !== _idleRestoreToken) return
    const chunk = rest.slice(cursor, cursor + RESTORE_SLICE)
    if (chunk.length === 0) return
    cursor += chunk.length
    useOutputStore.setState(s => ({ files: s.files.concat(chunk) }))
    renderOutputsView()
    if (cursor < rest.length) schedule(step)
  }
  schedule(step)
}

/**
 * 离开 Outputs 时释放"可重建"的内存，把 RAM 让给生图（ComfyUI 需要大块内存/显存）。
 *
 * 只丢缓存、不丢数据：缩略图回 IndexedDB 取、元数据仍在内存里（几十 MB 级）。
 * 再进 Outputs 会重新拉取（几百毫秒），换来的是**生图期间面板不常驻解码位图**。
 */
function releaseOutputMemory(): void {
  _outputImageNodes.clear()   // 已解码位图：最大的可释放项（清掉后滚动回来会按需重建）
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

async function restoreOutputsFromDb(): Promise<boolean> {
  const bootStartedAt = performance.now()
  // ── Gallery 索引模式（插件 ≥2.6.0 的 /anima/gallery/manifest）：列表与元数据摘要
  //    全部由后端索引直出，秒出且无需目录授权；缩略图走 /anima/thumb；不可用则回退旧管线。
  if (galleryIndexEnabled()) {
    const entries = galleryEntries()
    if (entries && entries.size > 0) {
      const files: OutputFile[] = []
      const metas: OutputMetadata[] = []
      for (const [rel, e] of entries) {
        const id = hashPath(rel)
        files.push({
          id, path: rel, filename: rel.split('/').pop() || rel,
          extension: (rel.split('.').pop() || '').toLowerCase(),
          size: e.size || 0, mtime: Math.round((e.mtime || 0) * 1000),
          width: e.width || 0, height: e.height || 0,
          favorite: false, rating: 0, notes: '', tags: [], category: '', status: '', pinned: false,
          createdAt: Math.round((e.mtime || 0) * 1000),
        })
        metas.push({
          imageId: id, model: e.model || '', seed: e.seed || '', steps: e.steps || '', cfg: e.cfg || '',
          sampler: e.sampler || '', scheduler: e.scheduler || '', vae: '', clipSkip: 0,
          prompt: e.prompt || '', negativePrompt: '', workflowJson: '', rawMetadata: {},
          loras: e.loras || [], hasWorkflow: !!e.hasWorkflow, lorasExtracted: true,
          workflowFingerprint: `g:${e.mtime}:${e.size}`,
        })
      }
      useOutputStore.setState({
        files, metadataCache: new Map(), metadataVersion: useOutputStore.getState().metadataVersion + 1,
        thumbMemory: new Map(),
      })
      useOutputStore.getState().putMetadataBatch(metas)
      useOutputStore.getState().applyFilters()
      console.log(`[outputs] Gallery 索引直出：${files.length} 个文件 + ${metas.length} 条元数据摘要（${Math.round(performance.now() - bootStartedAt)}ms）`)
      return true
    }
  }
  const restored = await restoreAllFromDb()
  if (restored.length === 0) return false
  // ⚠️ 首开性能关键（2026-09-10 修）：
  // 此前是一次性 `setFiles(restored)`（近 4000 条），于是「全部装配 + 首屏布局 +
  // 首屏取图」全挤在进入页面的那一刻 —— 用户实测特征正是「首次加载卡、之后不卡、
  // 功能都正常」。现在首屏只喂 BOOT_FILES 条，其余交给空闲分片追加。
  const head = restored.slice(0, BOOT_FILES)
  useOutputStore.getState().setFiles(head)
  // 并行回填：缩略图 → 内存缓存（渲染走同步路径）；元数据 → 只读缺失
  // 启动只预载首屏需要的量（两种情况都限 240）：其余缩略图交给 IntersectionObserver
  // 按需从 IndexedDB 取（loadImageThumbnail 的内存/IDB 分支对"无句柄"同样生效）。
  // 大图库全量灌内存会造成打开卡顿。
  const hasHandle = !!useOutputStore.getState().dirHandle || !!_nativeOutputs
  // ⚠️ 无句柄时也必须限量（2026-09-10 修）：
  // 此前写成 `hasHandle ? 前240 : 全量`，结果「未授权目录」的用户（恰恰是唯一没有其它
  // 出图通道的场景）会在进入页面时一次性从 IndexedDB 反序列化近 4000 条缩略图 dataURL
  // （几十上百 MB）—— 单次 bulkGet 的结构化克隆在主线程上就是一次长任务，页面上所有
  // 点击都要排队等它跑完，表现为「进入 Outputs 卡死、按钮全点不了、切栏目也没反应」。
  // 现在两种情况都只预载首屏需要的量，其余交给 IntersectionObserver 按需从 IDB 取即可。
  // 元数据不再随启动预载：首屏卡片进屏时按需读单条（requestVisibleMetadata），
  // 启动路径上因此不存在任何「全库」任务。
  // 后端直供图源（≥2.5.1）下 dataURL 预载整段跳过：卡片 <img> 直接引用 /anima/thumb URL，
  // IndexedDB dataURL 仓库只作为回退保留，不再占内存。
  if (backendThumbsEnabled()) {
    renderOutputsView()
    return true // 文件已恢复；仅跳过 dataURL 预载（图源走 /anima/thumb）
  }
  const thumbs = await preloadThumbnailsFromDb(restored.slice(0, 240))
  if (thumbs.size > 0) {
    useOutputStore.setState(state => {
      const merged = new Map(state.thumbMemory)
      for (const [p, d] of thumbs) merged.set(p, d)
      return { thumbMemory: merged }
    })
  }
  renderOutputsView()
  // 诊断：这条日志是「进页面要等多久」的唯一判据 —— 它只统计首屏装配 + 首屏缩略图，
  // 元数据与其余缩略图都不在其内（按需）。若这里远小于几秒，说明启动路径没有全库任务。
  console.log(`[outputs] 首屏就绪 ${Math.round(performance.now() - bootStartedAt)}ms`
    + `（files=${head.length}，缩略图 ${thumbs.size} 张，元数据/其余缩略图按需加载）`)
  // 剩余条目空闲追加（首屏已经能看能点，不再阻塞）
  if (restored.length > BOOT_FILES) scheduleIdleRestoreRest(restored.slice(BOOT_FILES))
  return true
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
  // ── 后端直供（插件 ≥2.5.1）：浏览器只解码 512px 小图 ──
  // 注意：/anima/thumb 只认 ComfyUI output 目录内的文件；用户用目录授权扫过其它目录时
  // 该端点会 404 —— onerror 后把该路径记入黑名单并回退旧管线（浏览器生成），会话内不再重试 URL。
  if (backendThumbsEnabled() && !_thumbUrlBlocked.has(filePath)) {
    const url = animaThumbUrl(filePath, 512)
    img.onerror = () => {
      img.onerror = null
      _thumbUrlBlocked.add(filePath)
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
  const dh = useOutputStore.getState().dirHandle
  if (_nativeOutputs) {
    // TK 原生模式：服务端对 /api/tk/output-file 是整文件回传（平均数 MB），
    // 过去直接把原图 URL 当缩略图用 —— 首屏数十张卡同时按原始尺寸下载 + 解码
    // （单张解码位图可达 6~25MB），主线程与内存瞬间被压满，表现为「进入 Outputs 卡死」。
    // 现在复用与目录模式相同的缩略图管线：内存 → IndexedDB → 下载一次并缩到 200px
    // 后回写缓存（管线内部限流 4 并发），二次进入直接命中缓存。
    try {
      const mem = useOutputStore.getState().thumbMemory.get(filePath)
      if (mem) {
        if (img.getAttribute('src') !== mem) img.src = mem
        _outputImageNodes.remember(img)
        return
      }

      const thumbMod = await import('../services/outputThumbnail')
      const cached = await thumbMod.getCachedThumbnail(filePath)
      if (cached) {
        useOutputStore.getState().setThumbMemory(filePath, cached)
        if (img.getAttribute('src') !== cached) img.src = cached
        _outputImageNodes.remember(img)
        return
      }

      const res = await fetch(nativeOutputUrl(filePath))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const thumb = await thumbMod.createThumbnailFromBlob(blob, 200)
      if (thumb?.dataUrl) {
        useOutputStore.getState().setThumbMemory(filePath, thumb.dataUrl)
        if (img.getAttribute('src') !== thumb.dataUrl) img.src = thumb.dataUrl
        _outputImageNodes.remember(img)
        return
      }
    } catch { /* 服务异常/超大图：下面退回原图，不阻塞其它图片 */ }
    // 兜底：缩略图不可得时退回原图 URL，保证不空着
    if (!img.getAttribute('src')) img.src = nativeOutputUrl(filePath)
    _outputImageNodes.remember(img)
    return
  }
  // 未授权目录（无句柄）时不再直接放弃：内存与 IndexedDB 里已有缓存的缩略图仍可展示，
  // 只是无法主动生成新的缩略图。补上这条，前面"启动只预载 240 张"才是安全的
  // ——其余缩略图滚动到就按需取，既不卡启动也不缺图。
  if (!dh) {
    try {
      const mem = useOutputStore.getState().thumbMemory.get(filePath)
      if (mem) {
        if (img.getAttribute('src') !== mem) img.src = mem
        _outputImageNodes.remember(img)
        return
      }
      const cached = await import('../services/outputThumbnail').then(m => m.getCachedThumbnail(filePath))
      if (cached) {
        useOutputStore.getState().setThumbMemory(filePath, cached)
        if (img.getAttribute('src') !== cached) img.src = cached
        _outputImageNodes.remember(img)
      }
    } catch { /* 缓存不可用：保持灰底，不抛错、不影响其它图片 */ }
    return
  }

  try {
    // 内存缓存（同步）
    const mem = useOutputStore.getState().thumbMemory.get(filePath)
    if (mem) {
      if (img.getAttribute('src') !== mem) img.src = mem
      _outputImageNodes.remember(img)
      return
    }

    // 尝试从 IndexedDB 缓存加载
    const cached = await import('../services/outputThumbnail').then(m => m.getCachedThumbnail(filePath))
    if (cached) {
      useOutputStore.getState().setThumbMemory(filePath, cached)
      if (img.getAttribute('src') !== cached) img.src = cached
      _outputImageNodes.remember(img)
      return
    }

    // 从文件系统加载
    const current = await resolveDirEntry(dh, filePath)
    const fileHandle = await current.getFileHandle(filePath.split('/').pop()!)
    const file = await fileHandle.getFile()

    const thumbnail = await import('../services/outputThumbnail').then(m => m.getThumbnail(file, filePath))
    if (thumbnail) {
      useOutputStore.getState().setThumbMemory(filePath, thumbnail)
      if (img.getAttribute('src') !== thumbnail) img.src = thumbnail
      _outputImageNodes.remember(img)
    }
  } catch {
    // 加载失败，显示占位符
    img.style.display = 'none'
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
  const currentIdx = files.findIndex(f => f.id === _currentPreviewFileId)
  if (currentIdx === -1) return
  const nextIdx = (currentIdx + direction + files.length) % files.length
  const nextFile = files[nextIdx]
  if (nextFile) {
    openPreview(nextFile.id)
  }
}

// ── 图片复制与下载 ──

/** 通过文件 ID 获取文件系统 File 对象 */
async function getFileBlob(fileId: string): Promise<{ name: string; blob: Blob } | null> {
  const dh = useOutputStore.getState().dirHandle
  const file = useOutputStore.getState().files.find(f => f.id === fileId)
  if (_nativeOutputs && file) {
    try {
      const response = await fetch(nativeOutputUrl(file.path))
      if (!response.ok) return null
      return { name: file.filename, blob: await response.blob() }
    } catch { return null }
  }
  if (!dh || !file) return null
  try {
    const current = await resolveDirEntry(dh, file.path)
    const handle = await current.getFileHandle(file.filename)
    const blob = await handle.getFile()
    return { name: file.filename, blob }
  } catch {
    return null
  }
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

/** 压缩图片——转为 WebP，缩小 base64 体积。尺寸 ≤ maxDimension 时不缩放但仍转格式 */
async function compressImage(blob: Blob, maxDimension = 1920): Promise<Blob> {
  try {
    const img = await createImageBitmap(blob)
    let { width, height } = img
    if (width > maxDimension || height > maxDimension) {
      if (width > height) {
        height = Math.round(height * maxDimension / width)
        width = maxDimension
      } else {
        width = Math.round(width * maxDimension / height)
        height = maxDimension
      }
    }
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, width, height)
    return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
  } catch {
    return blob // fallback: 返回原图
  }
}

/** 将 Outputs 图片的 Prompt 与压缩图片副本保存到 Prompt 库，脱离原文件后仍可查看。 */
async function saveOutputPromptToLibrary(fileId: string): Promise<void> {
  const state = useOutputStore.getState()
  const file = state.files.find(f => f.id === fileId)
  const meta = (await outputsDb.metadata.get(fileId)) ?? state.metadataCache.get(fileId)
  if (!file || !meta?.prompt.trim()) {
    showToast('该图片无 Prompt，无法保存')
    return
  }

  const result = await getFileBlob(fileId)
  if (!result) {
    showToast('保存失败：找不到原图片')
    return
  }

  try {
    const image = await blobToDataURL(await compressImage(result.blob))
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

/** 复制单张图片到剪贴板 */
async function copyImageToClipboard(fileId: string) {
  const result = await getFileBlob(fileId)
  if (!result) { showToast('复制失败：找不到文件'); return }
  try {
    const type = result.blob.type || 'image/png'
    await navigator.clipboard.write([
      new ClipboardItem({ [type]: result.blob })
    ])
    showToast('图片已复制到剪贴板')
  } catch {
    showToast('复制失败，请重试')
  }
}

/** 批量复制图片到剪贴板 */
async function copyImagesToClipboard(ids: string[]) {
  if (ids.length === 0) return

  // 1. 逐张转为 Base64，边构建边检测大小
  const MAX_HTML_SIZE = 16 * 1024 * 1024 // 16MB（实测 22MB 会被系统剪贴板截断）

  let htmlAccum = ''
  const names: string[] = []
  const dataUrls: string[] = []
  let copiedCount = 0

  for (const id of ids) {
    const result = await getFileBlob(id)
    if (!result) continue

    // 多图时压缩以减少 base64 体积
    const blob = ids.length > 1 ? await compressImage(result.blob) : result.blob
    const dataUrl = await blobToDataURL(blob)
    const tag = `<img src="${dataUrl}" alt="${escAttr(result.name)}" style="max-width:100%;display:block;margin:4px 0">`
    const newHtml = htmlAccum + tag

    // 精确测量实际大小
    if (copiedCount > 0 && new Blob([newHtml]).size > MAX_HTML_SIZE) {
      // 加这张会超限，停止
      console.log(`[复制] 第 ${copiedCount + 1} 张超出上限，停止累积。当前 ${copiedCount} 张`)
      break
    }

    htmlAccum = newHtml
    names.push(result.name)
    dataUrls.push(dataUrl)
    copiedCount++
  }

  if (copiedCount === 0) {
    showToast('单张图片过大，无法复制到剪贴板')
    return
  }

  // HTML 调试：检查所有图片是否已生成
  console.log('[HTML调试] 总图片数:', names.length)
  names.forEach((name, i) => {
    console.log(`[HTML调试] 图片 ${i + 1}: ${name}, Base64 长度: ${dataUrls[i]?.length || 0}`)
  })
  console.log('[HTML调试] 完整 HTML 长度:', htmlAccum.length)
  names.forEach((name, i) => {
    if (dataUrls[i]) {
      const included = htmlAccum.includes(dataUrls[i].substring(0, 80))
      console.log(`[HTML调试] 图片 ${i + 1} "${name}" 是否在 HTML 中: ${included}`)
    }
  })

  // 2. 写入剪贴板
  try {
    if (copiedCount === 1) {
      const resp = await fetch(dataUrls[0])
      const blob = await resp.blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    } else {
      const htmlBlob = new Blob([htmlAccum], { type: 'text/html' })
      const textBlob = new Blob([`已复制 ${copiedCount} 张图片\n${names.join('\n')}`], { type: 'text/plain' })
      console.log('[复制] HTML 大小:', htmlBlob.size, '字节, 图片数:', copiedCount)
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
      ])
    }
    const skipped = ids.length - copiedCount
    const compressed = ids.length > 1 ? '（已压缩至1920px以便复制更多）' : ''
    if (skipped > 0) {
      showToast(`已复制 ${copiedCount} 张图片${compressed}（剩余 ${skipped} 张超过剪贴板大小限制）`)
    } else {
      showToast(`已复制 ${copiedCount} 张图片到剪贴板${compressed}`)
    }
  } catch (err) {
    console.warn('[复制] 写入失败:', err)
    // 降级：复制文件名
    try {
      const allNames = await Promise.all(ids.map(async id => {
        const r = await getFileBlob(id); return r?.name || ''
      }))
      await navigator.clipboard.writeText(allNames.filter(Boolean).join('\n'))
      showToast(`已复制 ${allNames.filter(Boolean).length} 个文件名到剪贴板`)
    } catch { showToast('复制失败') }
  }
}

/** 下载单张图片 */
async function downloadImage(fileId: string) {
  const result = await getFileBlob(fileId)
  if (!result) { showToast('下载失败：找不到文件'); return }
  const url = URL.createObjectURL(result.blob)
  const a = document.createElement('a')
  a.href = url; a.download = result.name; a.click()
  URL.revokeObjectURL(url)
  showToast('已开始下载')
}

/** 批量下载（单张直接下载，多张打包 ZIP） */
async function downloadImagesAsZip(ids: string[]) {
  if (ids.length === 1) {
    // 单张：直接下载原文件
    downloadImage(ids[0])
    return
  }
  showToast('正在打包...')
  const zip = new JSZip()
  let added = 0
  for (const id of ids) {
    const result = await getFileBlob(id)
    if (result) { zip.file(result.name, result.blob); added++ }
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' })
  const now = new Date()
  const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`
  const url = URL.createObjectURL(zipBlob)
  const a = document.createElement('a')
  a.href = url; a.download = `outputs_${ts}.zip`; a.click()
  URL.revokeObjectURL(url)
  showToast(`已下载 ${added} 张图片${added < ids.length ? `（${ids.length - added} 张失败）` : ''}`)
}

/** 独立元数据弹窗（不放大图片，直接查看 prompt/参数/工作流） */
async function openMetaPanel(fileId: string) {
  const state = useOutputStore.getState()
  const file = state.files.find(f => f.id === fileId)
  if (!file) return
  // 完整元数据（含 workflowJson）从 DB 懒读——内存缓存为瘦身版，面板/下载需要完整数据
  const meta = (await outputsDb.metadata.get(fileId)) ?? state.metadataCache.get(fileId) ?? null

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:radial-gradient(ellipse at top,rgba(10,10,15,0.85),rgba(2,2,3,0.95));z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:var(--bg2);color:var(--text);border-radius:12px;padding:16px;width:90vw;max-width:640px;max-height:85vh;overflow-y:auto;border:1px solid var(--border);box-shadow:0 0 0 1px rgba(0,0,0,0.2),0 24px 70px rgba(0,0,0,0.5);'
  panel.innerHTML = renderMetadataPanel(meta ?? null, file)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  panel.querySelector('#outputsMetaCloseBtn')?.addEventListener('click', () => overlay.remove())
  panel.querySelector('#outputsMetaCopyWorkflowBtn')?.addEventListener('click', async () => {
    await downloadOutputWorkflow(meta ?? undefined, file?.filename || 'workflow')
  })
  // Esc 关闭
  const escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler) } }
  document.addEventListener('keydown', escHandler)
}

// ══ 预览图片编辑（旋转/翻转/框选裁剪，保存为副本，不覆盖原图） ══
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
let _editSrcImg: HTMLImageElement | null = null
let _editBase: HTMLCanvasElement | null = null
let _editCropping = false
let _cropStartX = 0
let _cropStartY = 0
let _saving = false

/** 导航到文件所在目录，返回目录句柄 */
async function resolveDirEntry(dirHandle: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  const parts = path.split('/')
  let current = dirHandle
  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i])
  }
  return current
}

/** 懒加载原始图像，并初始化编辑基准画布（切图时重新加载并重置编辑状态） */
async function ensureEditSrc(fileId: string): Promise<boolean> {
  if (_editFileId === fileId && _editBase) return true
  const blob = await getFileBlob(fileId)
  if (!blob) return false
  const url = URL.createObjectURL(blob.blob)
  const img = new Image()
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = url })
  URL.revokeObjectURL(url)
  _editFileId = fileId
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
}

function hideCropUI() {
  const layer = document.getElementById('lbCropLayer')
  const rect = document.getElementById('lbCropRect')
  if (layer) layer.style.display = 'none'
  if (rect) rect.style.display = 'none'
}

function rotateEdit(delta: number) {
  if (!_editBase) return
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
  _editBase = out
  hideCropUI()
  renderEdit()
}

function resetEdit() {
  _editSrcImg = null
  _editFileId = ''
  _editBase = null
  _editCropping = false
  const wrap = document.getElementById('lbEditWrap')
  const imgEl = document.getElementById('lbImg') as HTMLImageElement
  if (wrap) wrap.style.display = 'none'
  if (imgEl) imgEl.style.display = ''
  hideCropUI()
}

/** 保存编辑结果为副本文件（原名 + _edited），不覆盖原图 */
async function saveEditedImage() {
  if (!_editBase) { showToast('请先编辑再保存'); return }
  if (_saving) return
  const file = useOutputStore.getState().files.find(f => f.id === _editFileId)
  const dh = useOutputStore.getState().dirHandle
  if (!file || !dh) { showToast('请先选择目录'); return }

  // 仍处于裁剪模式且有选框时，先应用裁剪，确保保存结果与所见一致
  if (_editCropping) confirmCrop()

  _saving = true
  showToast('⏳ 正在保存副本...')
  try {
    const ext = file.extension || 'png'
    const mime = EXT_MIME[ext] || 'image/png'
    const cv = buildEditedCanvas()
    const blob = await new Promise<Blob | null>(res => cv.toBlob(b => res(b), mime))
    if (!blob) { showToast('⚠️ 导出失败'); return }

    // PNG 副本保留原始 prompt/workflow 元数据（写入导出 PNG 的 tEXt chunks）
    let bytes: Uint8Array<ArrayBuffer>
    if (ext === 'png') {
      const original = await getFileBlob(_editFileId)
      bytes = injectPngTextChunks(
        new Uint8Array(await blob.arrayBuffer()),
        original ? extractPngTextChunks(new Uint8Array(await original.blob.arrayBuffer())) : []
      )
    } else {
      bytes = new Uint8Array(await blob.arrayBuffer())
    }
    const savedBlob = new Blob([bytes], { type: mime })

    const base = file.filename.replace(/\.[^.]+$/, '')
    const newName = `${base}_edited.${ext}`
    const dir = await resolveDirEntry(dh, file.path)
    const newHandle = await dir.getFileHandle(newName, { create: true })
    const writable = await newHandle.createWritable()
    await writable.write(savedBlob)
    await writable.close()

    // 新副本加入列表：手动入库 + store，确保网格即时显示，不依赖增量扫描的可见性
    const parts = file.path.split('/')
    const newPath = parts.length > 1 ? parts.slice(0, -1).concat(newName).join('/') : newName
    const newId = hashPath(newPath)
    // 按需取源文件元数据（内存未命中就单条回 DB），保证另存副本继承 Prompt/LoRA
    const meta = await useOutputStore.getState().loadMetadata(_editFileId)
    const newFile: OutputFile = {
      id: newId, path: newPath, filename: newName, extension: ext,
      size: savedBlob.size, mtime: Date.now(), width: cv.width, height: cv.height,
      favorite: false, rating: 0, notes: '', tags: [], category: '', status: '', pinned: false,
      createdAt: Date.now(),
    }
    await outputsDb.files.put(newFile)
    if (meta) {
      const copyMeta = { ...meta, imageId: newId }
      await outputsDb.metadata.put(copyMeta)
      useOutputStore.getState().putMetadata(copyMeta)
    }
    useOutputStore.setState(s => ({ files: [newFile, ...s.files.filter(f => f.id !== newId)] }))
    useOutputStore.getState().applyFilters()
    renderOutputsView()

    // 后台增量扫描：同步 manifest / 缩略图（失败静默，不影响已显示的副本）
    try { await scanOutputDirIncremental(dh) } catch { /* 静默 */ }

    showToast(`✅ 已保存为 ${newName}`)
    // 切换预览到新副本，让用户立即看到编辑结果
    openPreview(newId).catch(() => {})
  } catch {
    showToast('⚠️ 保存失败')
  } finally {
    _saving = false
  }
}

/** 绑定编辑工具栏与裁剪交互（一次性） */
function bindEditToolbar() {
  const bar = document.getElementById('lbEditBar')
  bar?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement
    if (!btn) return
    const act = btn.dataset.act
    const fileId = _currentPreviewFileId
    if (!fileId) return
    if (act === 'save') {
      // 未编辑也允许保存原图副本：先确保原图已加载
      if (!_editBase && !(await ensureEditSrc(fileId))) { showToast('⚠️ 读取图片失败'); return }
      saveEditedImage()
      return
    }
    if (act === 'reset') { resetEdit(); return }
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
    e.stopPropagation()
    _editCropping = false
    hideCropUI()
    const wrap = document.getElementById('lbEditWrap')
    if (wrap) wrap.style.cursor = ''
  })
}

async function openPreview(fileId: string) {
  // 切换预览前 revoke 上一个 Blob URL（含失败路径，避免泄漏大图 Blob）
  if (_previewBlobUrl) {
    URL.revokeObjectURL(_previewBlobUrl)
    _previewBlobUrl = ''
  }
  _currentPreviewFileId = fileId
  const file = useOutputStore.getState().files.find(f => f.id === fileId)
  if (!file) return

  // 预加载元数据到缓存（供「ℹ️ 元数据」按钮弹窗等使用）
  await useOutputStore.getState().loadMetadata(fileId)

  // 获取图片 URL
  const dh = useOutputStore.getState().dirHandle
  if (!_nativeOutputs && !dh) return

  let imgUrl = ''
  if (_nativeOutputs) {
    imgUrl = nativeOutputUrl(file.path)
  }
  try {
    if (!_nativeOutputs) {
      if (!dh) return
      const current = await resolveDirEntry(dh, file.path)
      const fileHandle = await current.getFileHandle(file.filename)
      const f = await fileHandle.getFile()
      imgUrl = URL.createObjectURL(f)
      _previewBlobUrl = imgUrl
    }
  } catch {
    return
  }

  // 打开 lightbox
  const lightbox = document.getElementById('lightbox')
  const img = document.getElementById('lbImg') as HTMLImageElement
  const counter = document.getElementById('lbCounter')

  resetEdit()
  if (img) img.src = imgUrl
  if (counter) {
    const total = useOutputStore.getState().filteredFiles.length
    const idx = useOutputStore.getState().filteredFiles.findIndex(f => f.id === fileId)
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
