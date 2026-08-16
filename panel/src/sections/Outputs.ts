// ── Outputs 模块主页面 ──

import { useOutputStore } from '../store/outputStore'
import { deleteFiles, renameFile, batchFavorite, batchRate } from '../services/outputService'
import { scanOutputDir, scanOutputDirIncremental, loadOutputDirHandle, buildDirTree, ensureThumbnails, reparseAllMetadata, ensureMetadataFresh } from '../services/outputScanner'
import { restoreAllFromDb } from '../services/outputManifest'
import { preloadThumbnailsFromDb } from '../services/outputThumbnail'
import { hashPath } from '../services/outputManifest'
import { outputsDb } from '../db/outputsDb'
import { esc, escAttr, showToast, copyText, icon, attachSearchClear, debounce } from '../utils'
import { confirmModal, promptModal } from '../components/Modal'
import type { OutputFile, OutputMetadata, OutputDir, OutputScanStatus } from '../types/outputs'
import { extractLorasFromWorkflow, extractLoraTagsFromWorkflow } from '../services/outputMetadata'
import { extractPngTextChunks, injectPngTextChunks } from '../services/pngChunks'
import { backfillPrompts } from '../services/outputMetadataService'
import { VirtualScroll, type VirtualScrollItemStyle } from '../components/VirtualScroll'
import JSZip from 'jszip'

import {
  renderDirTree as renderDirTreeHtml,
  renderList,
  renderEmpty,
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

/**
 * 下载工作流 .json（ComfyUI 用 Load 或拖入画布导入最稳妥，替代复制——画布 Ctrl+V 易误导）
 */
async function downloadOutputWorkflow(meta: OutputMetadata | undefined, baseName: string) {
  if (!meta?.workflowJson) { showToast('该图片无工作流数据'); return }
  try {
    const safeName = (baseName || 'workflow').replace(/\.png$/i, '').replace(/[\\/:*?"<>|]/g, '_')
    const blob = new Blob([meta.workflowJson], { type: 'application/json' })
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

  // 尝试恢复目录句柄与权限状态（句柄引用始终恢复；权限降级时用横幅引导一键重新授权）
  const loadResult = await loadOutputDirHandle()

  const dh = useOutputStore.getState().dirHandle
  if (dh && loadResult.permission === 'granted') {
    // 解析逻辑升级时自动失效旧元数据缓存并重新解析（增量扫描按 mtime 会跳过未变更文件）
    await ensureMetadataFresh(dh)
    // 快速恢复：直接从 DB 恢复文件列表/元数据/缩略图缓存（跳过全量目录遍历），首屏秒出
    await restoreOutputsFromDb()
    // 构建目录树（buildDirTree 是轻量操作，仅遍历文件名）
    dirTree = await buildDirTree(dh)
    renderDirTree(dirTree)
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

  // ── 自动检测新图：窗口获得焦点 / 页面重新可见 / 60s 轮询 ──
  startOutputsAutoScan()
  window.addEventListener('focus', triggerOutputsIncrementalScan)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) triggerOutputsIncrementalScan() })

  // ── 后台预加载元数据（让筛选器拿到 Model/LoRA 列表） ──
  const { files, metadataCache } = useOutputStore.getState()
  if (files.length > 0 && metadataCache.size === 0) {
    preloadMetadataBatch(files, metadataCache)
  }

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
      // 已有缓存 -> 尝试检测新文件（轻量操作）；60s 节流避免每次切换栏目都遍历目录
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

    // 后台补生成缺失的缩略图（非关键，失败不影响主流程）
    ensureThumbnails(state.dirHandle)

    // 后台批量预加载 metadata
    const { files, metadataCache } = useOutputStore.getState()
    preloadMetadataBatch(files, metadataCache)
  } else {
    // 没有目录句柄，提示用户选择
    const empty = document.querySelector('.outputs-empty') as HTMLElement
    if (empty) empty.style.display = 'flex'
  }

  // 每次进入栏目都重渲染：虚拟滚动的行列几何依赖可见宽度
  // （旧 CSS grid 在显示时自动 reflow；现在由 JS 计算，隐藏期渲染过宽 0 的几何必须重建）
  renderOutputsView()

  setupInfiniteScroll()
  initDragSelect()
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
  document.querySelectorAll(`[data-id="${id}"] .outputs-fav-btn, [data-id="${id}"] .outputs-card-fav-icon`).forEach(el => {
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

  // 填充分类下拉选项（从文件分类去重），并同步选中值
  const catEl = document.querySelector('.outputs-filter-category') as HTMLSelectElement
  if (catEl) {
    const cats = Array.from(new Set(s.files.map(f => f.category).filter(Boolean))).sort()
    const current = catEl.value
    catEl.innerHTML = '<option value="">全部</option><option value="__none__">未分类</option>' +
      cats.map(c => `<option value="${escAttr(c)}">${esc(c)}</option>`).join('')
    if (s.filterCategory) catEl.value = s.filterCategory
    else catEl.value = current && cats.includes(current) ? current : ''
  }

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

// ── 网格虚拟滚动（Perf-1：全量数据虚拟渲染，DOM 只含可视行）──
let _outputsVS: VirtualScroll | null = null
/** 卡片信息区固定高度（含 actions 两行预留），与 CSS `.outputs-card-info` 同步 */
const OUTPUTS_INFO_H = 136

interface OutputsGeom { cols: number; gap: number; cardW: number; rowH: number }

/** 网格几何：与 CSS `repeat(auto-fill, minmax(200px,1fr))` 保持一致（≤768px 时 150px/10px）；
 *  行高 = 卡宽 + 信息区高 + 卡片上下边框 4px（box-sizing: border-box 下内容区少 4px） */
function outputsGeom(width: number): OutputsGeom {
  const narrow = window.innerWidth <= 768
  const min = narrow ? 150 : 200
  const gap = narrow ? 10 : 16
  const cols = Math.max(1, Math.floor((width + gap) / (min + gap)))
  const cardW = (width - (cols - 1) * gap) / cols
  return { cols, gap, cardW, rowH: Math.round(cardW + OUTPUTS_INFO_H + 4) }
}

function destroyOutputsVS() {
  if (_outputsVS) { _outputsVS.destroy(); _outputsVS = null }
}

function renderImageGrid(state: ReturnType<typeof useOutputStore.getState>) {
  const el = document.querySelector('.outputs-grid') as HTMLElement
  if (!el) return

  const files = state.filteredFiles
  const hasDir = !!state.dirHandle

  if (files.length === 0) {
    destroyOutputsVS()
    el.innerHTML = renderEmpty(hasDir)
    return
  }

  if (state.viewMode === 'grid') {
    // ── 网格模式：虚拟滚动渲染全量（缩略图走 thumbMemory 回填 + IntersectionObserver，翻页不闪烁）──
    const geom = outputsGeom(el.clientWidth)
    const totalRows = Math.ceil(files.length / geom.cols)

    // renderItem 闭包捕获本次 files/geom，每次渲染带最新闭包
    const renderItem = (rowIndex: number, style: VirtualScrollItemStyle) => {
      const s = useOutputStore.getState()
      const startIdx = rowIndex * geom.cols
      let html = ''
      for (let i = 0; i < geom.cols; i++) {
        const f = files[startIdx + i]
        if (!f) break
        const meta = s.metadataCache.get(f.id)
        // thumbSrc 同步回填内存缩略图：虚拟滚动滚动时行会被重建，
        // 若等 IntersectionObserver 异步回填会有几帧黑图闪烁
        html += renderImageCard(f, meta ?? null, s.selectedIds.has(f.id), meta?.loras?.length ? meta.loras : undefined, undefined, s.thumbMemory.get(f.path))
      }
      return `<div style="position:absolute;top:${style.top}px;left:0;width:100%;height:${geom.rowH}px;display:grid;grid-template-columns:repeat(${geom.cols}, minmax(0,1fr));gap:${geom.gap}px;padding:0">${html}</div>`
    }

    if (_outputsVS && el.querySelector('.virtual-scroll-inner')) {
      // itemHeight 必须一起更新：隐藏期创建的实例可能是退化几何（宽 0），
      // 只改 totalItems 会导致 padding 沿用旧行高、滚动高度错乱
      el.querySelector('.outputs-empty')?.remove()   // 清掉静态 HTML 占位残留
      _outputsVS.update({ totalItems: totalRows, renderItem, itemHeight: geom.rowH })
    } else {
      destroyOutputsVS()
      removeOutputsSentinel()
      el.innerHTML = ''   // 清空容器（含 index.html 静态 .outputs-empty 占位），VirtualScroll 只 append 不清
      _outputsVS = new VirtualScroll({ container: el, itemHeight: geom.rowH, totalItems: totalRows, renderItem })
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
    (hasPrompt ? `<button class="outputs-copy-prompt-btn" data-id="${id}" title="复制正面 Prompt">${icon('file-text', 12)} 正面</button>` : '') +
    (hasLoras ? `<button class="outputs-copy-lora-btn" data-id="${id}" title="复制 LoRA 标签">${icon('tag', 12)} LoRA</button>` : '') +
    (hasWf ? `<button class="outputs-dl-wf-btn" data-id="${id}" title="保存为 .json 文件，拖入 ComfyUI 画布即可导入">${icon('download', 12)} 下载工作流</button>` : '') +
    (meta ? `<button class="outputs-meta-btn" data-id="${id}" title="查看元数据">${icon('info', 12)} 元数据</button>` : '')
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
  initDragSelect()
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

    // 收藏按钮（卡片内 + 列表内）
    const favBtn = target.closest('.outputs-fav-btn, .outputs-card-fav-icon') as HTMLElement
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
        const meta = useOutputStore.getState().metadataCache.get(id)
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
      useOutputStore.getState().setFilterKey(key)
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
      onCopyMetadata: (id) => {
        const meta = useOutputStore.getState().metadataCache.get(id)
        if (meta) {
          copyText(JSON.stringify(meta, null, 2))
          showToast('元数据已复制')
        }
      },
      onCopyPrompt: (id) => {
        const meta = useOutputStore.getState().metadataCache.get(id)
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

  // 图片懒加载
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const img = entry.target as HTMLImageElement
        const fileId = img.dataset.fileId
        const filePath = img.dataset.filePath
        if (fileId && filePath) {
          loadImageThumbnail(img, fileId, filePath)
        }
        observer.unobserve(img)
      }
    }
  }, { rootMargin: '100px' })

  // 观察所有图片
  const observeImages = () => {
    document.querySelectorAll('.outputs-card img[data-file-id], .outputs-list-card-img img[data-file-id]').forEach(img => {
      observer.observe(img)
    })
  }

  // 使用 MutationObserver 监听 DOM 变化
  const grid = document.querySelector('.outputs-grid')
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
    useOutputStore.getState().setFilterCategory((e.target as HTMLSelectElement).value)
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

// ── 拖拽框选：用 document 级事件，确保不被其他元素拦截 ──
let _dragInitDone = false

function initDragSelect() {
  if (_dragInitDone) return
  _dragInitDone = true
  console.log('[Outputs] initDragSelect — 绑定 document 级拖拽事件')

  let isDragging = false
  let startPageX = 0, startPageY = 0
  let rectEl: HTMLElement | null = null
  let _justBoxed = false

  function getCardIdsInRect(l: number, t: number, r: number, b: number): string[] {
    const state = useOutputStore.getState()
    const grid = document.querySelector('.outputs-grid') as HTMLElement | null
    if (!grid) return []

    // 网格模式（虚拟滚动）：DOM 里只有可视行，改用「选区矩形 → 行列索引」精确换算
    if (state.viewMode === 'grid' && grid.clientWidth > 0) {
      const geom = outputsGeom(grid.clientWidth)
      const sx = window.scrollX, sy = window.scrollY
      const gridRect = grid.getBoundingClientRect()
      const gridLeft = gridRect.left + sx
      const gridTop = gridRect.top + sy
      const scTop = grid.scrollTop   // 网格内部滚动，文档坐标需加回 scrollTop
      const firstRow = Math.max(0, Math.floor((t - gridTop + scTop) / geom.rowH))
      const lastRow = Math.max(0, Math.floor((b - gridTop + scTop) / geom.rowH))
      const firstCol = Math.max(0, Math.floor((l - gridLeft) / (geom.cardW + geom.gap)))
      const lastCol = Math.max(0, Math.floor((r - gridLeft) / (geom.cardW + geom.gap)))
      const ids: string[] = []
      const files = state.filteredFiles
      for (let row = firstRow; row <= lastRow; row++) {
        for (let col = firstCol; col <= lastCol; col++) {
          const f = files[row * geom.cols + col]
          if (f) ids.push(f.id)
        }
      }
      return ids
    }

    // 列表模式：DOM 命中（列表未虚拟化，全部行都在 DOM）
    const ids: string[] = []
    const sx = window.scrollX, sy = window.scrollY
    document.querySelectorAll('.outputs-card, .outputs-list-card').forEach(el => {
      const cr = el.getBoundingClientRect()
      // 卡片位置转文档坐标（pageX/pageY 体系）
      const cardL = cr.left + sx, cardT = cr.top + sy
      const cardR = cr.right + sx, cardB = cr.bottom + sy
      if (l < cardR && r > cardL && t < cardB && b > cardT) {
        const id = (el as HTMLElement).dataset.id
        if (id) ids.push(id)
      }
    })
    return ids
  }

  document.addEventListener('mousedown', (e: Event) => {
    const me = e as MouseEvent
    const target = e.target as HTMLElement
    if (!target.closest('#sectionOutputs')) return
    // 允许以图片卡片为起点拖拽（与节点内拖拽行为一致），排除工具栏/头部等控件
    if (target.closest('.outputs-list-header, button, input, .outputs-empty, .outputs-toolbar, .outputs-batch-bar')) return
    if (me.button !== 0) return

    isDragging = true
    // 阻止浏览器原生文字/图片选中产生的蓝色高亮
    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    e.preventDefault()

    startPageX = me.pageX
    startPageY = me.pageY

    if (!me.ctrlKey && !me.metaKey && !me.shiftKey) {
      useOutputStore.getState().clearSelection()
    }

    rectEl = document.createElement('div')
    rectEl.className = 'outputs-selection-rect'
    rectEl.style.cssText = `position:fixed;left:${me.clientX}px;top:${me.clientY}px;width:0;height:0;z-index:99999;background:rgba(99,102,241,0.12);border:2px dashed rgba(99,102,241,0.6);pointer-events:none;border-radius:4px`
    document.body.appendChild(rectEl)
  })

  document.addEventListener('mousemove', (e: Event) => {
    const me = e as MouseEvent
    if (!isDragging || !rectEl) return

    // 文档坐标计算（pageX/pageY），滚动后依然正确
    const l = Math.min(startPageX, me.pageX)
    const t = Math.min(startPageY, me.pageY)
    const r = Math.max(startPageX, me.pageX)
    const b = Math.max(startPageY, me.pageY)
    const w = r - l
    const h = b - t

    // 选区框用 position:fixed，转成视口坐标
    const sx = window.scrollX, sy = window.scrollY
    rectEl.style.cssText = `position:fixed;left:${l - sx}px;top:${t - sy}px;width:${w}px;height:${h}px;z-index:99999;background:rgba(99,102,241,0.12);border:2px dashed rgba(99,102,241,0.6);pointer-events:none;border-radius:4px`

    if (w > 5 || h > 5) {
      const ids = getCardIdsInRect(l, t, r, b)
      useOutputStore.setState({ selectedIds: new Set(ids) })
      const batchCount = document.getElementById('outputsBatchCount')
      if (batchCount) batchCount.textContent = `已选 ${ids.length} 张`
      document.querySelectorAll('.outputs-card, .outputs-list-card').forEach(el => {
        const id = (el as HTMLElement).dataset.id
        if (id) el.classList.toggle('selected', ids.includes(id))
      })
    }
  })

  document.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    // 恢复文字选中
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    if (useOutputStore.getState().selectedIds.size > 0) _justBoxed = true
    syncSelectionUI()
    updateBatchBar()
  })

  // 拖拽结束后的 click 不应触发卡片选中/预览（capture 阶段拦截，先于卡片点击逻辑）
  document.addEventListener('click', (e: Event) => {
    if (_justBoxed) {
      _justBoxed = false
      e.preventDefault()
      e.stopPropagation()
    }
  }, true)

  // 拖拽中途失焦（切屏/alt-tab/切标签页）或鼠标离开页面 → mouseup 不派发，
  // 手动取消拖拽并清理残留选框，否则虚线框会永久滞留页面。
  const cancelDrag = () => {
    if (!isDragging) return
    isDragging = false
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    syncSelectionUI()
    updateBatchBar()
  }
  window.addEventListener('blur', cancelDrag)
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelDrag() })
  document.addEventListener('mouseleave', cancelDrag)
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
        const newState = useOutputStore.getState()
        preloadMetadataBatch(newState.files, newState.metadataCache)
      }
    }
  }, { rootMargin: '400px' })

  observer.observe(sentinel)
  if (grid) (grid as any)._outputsSentinelIO = observer
}

async function preloadMetadataBatch(files: OutputFile[], cache: Map<string, OutputMetadata>) {
  const ids = files.map(f => f.id)
  if (ids.length === 0) return

  // 只读缺失部分：切 tab 时内存缓存已完整 → 直接跳过，不再重复全量读 DB
  const missing = ids.filter(id => !cache.has(id))
  if (missing.length === 0) return

  // 分批从 IndexedDB 读取，每批 200
  const BATCH = 200
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    try {
      const metas = await outputsDb.metadata.bulkGet(batch)
      const valid = metas.filter((m): m is OutputMetadata => !!m)
      if (valid.length > 0) {
        const before = useOutputStore.getState().metadataCache.size
        useOutputStore.getState().putMetadataBatch(valid)
        const after = useOutputStore.getState().metadataCache.size
        // 仅当缓存确实新增了元数据时才重渲染网格，避免每次进入页面都重建导致图片闪烁
        if (after !== before && (i + BATCH >= missing.length || missing.length <= BATCH)) {
          renderOutputsView()
        }
      }
    } catch {
      // 批量读取失败，跳过
    }
  }
  // 元数据加载后刷新筛选面板
  updateFilterPanel()
  // 对旧数据补全 prompt
  const fixed = await backfillPrompts(useOutputStore.getState().metadataCache)
  if (fixed > 0) {
    renderOutputsView()
  }
  // 刷新本地管理首页（元数据就绪后更新统计）
  const { renderLocalView } = await import('./LocalManager')
  renderLocalView()
}

/**
 * 从 DB 快速恢复缓存（页面刷新后首屏秒出，跳过全量目录遍历）：
 * files 列表 + 缩略图批量回填内存 + 元数据预载，一次渲染到位；
 * 文件系统变化由后续增量扫描（initOutputs/activateOutputs 已有）后台校正。
 */
async function restoreOutputsFromDb(): Promise<boolean> {
  const restored = await restoreAllFromDb()
  if (restored.length === 0) return false
  useOutputStore.getState().setFiles(restored)
  // 并行回填：缩略图 → 内存缓存（渲染走同步路径）；元数据 → 只读缺失
  const [thumbs] = await Promise.all([
    preloadThumbnailsFromDb(restored),
    preloadMetadataBatch(restored, useOutputStore.getState().metadataCache),
  ])
  if (thumbs.size > 0) {
    useOutputStore.setState(state => {
      const merged = new Map(state.thumbMemory)
      for (const [p, d] of thumbs) merged.set(p, d)
      return { thumbMemory: merged }
    })
  }
  renderOutputsView()
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
  const dh = useOutputStore.getState().dirHandle
  if (!dh) return

  try {
    // 内存缓存（同步）
    const mem = useOutputStore.getState().thumbMemory.get(filePath)
    if (mem) { img.src = mem; return }

    // 尝试从 IndexedDB 缓存加载
    const cached = await import('../services/outputThumbnail').then(m => m.getCachedThumbnail(filePath))
    if (cached) {
      useOutputStore.getState().setThumbMemory(filePath, cached)
      img.src = cached
      return
    }

    // 从文件系统加载
    const current = await resolveDirEntry(dh, filePath)
    const fileHandle = await current.getFileHandle(filePath.split('/').pop()!)
    const file = await fileHandle.getFile()

    const thumbnail = await import('../services/outputThumbnail').then(m => m.getThumbnail(file, filePath))
    if (thumbnail) {
      useOutputStore.getState().setThumbMemory(filePath, thumbnail)
      img.src = thumbnail
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
    const meta = useOutputStore.getState().metadataCache.get(_editFileId)
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
  if (!dh) return

  let imgUrl = ''
  try {
    const current = await resolveDirEntry(dh, file.path)
    const fileHandle = await current.getFileHandle(file.filename)
    const f = await fileHandle.getFile()
    imgUrl = URL.createObjectURL(f)
    _previewBlobUrl = imgUrl
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
    panel.innerHTML += `<p style="color:var(--text-dim);font-size:12px;margin:12px 0;">暂无分类，右键图片 → 设置分类即可创建</p>`
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
