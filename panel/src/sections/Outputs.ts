// ── Outputs 模块主页面 ──

import { useOutputStore } from '../store/outputStore'
import { deleteFiles, renameFile, batchFavorite, batchRate } from '../services/outputService'
import { scanOutputDir, scanOutputDirIncremental, loadOutputDirHandle, buildDirTree, ensureThumbnails, reparseAllMetadata } from '../services/outputScanner'
import { outputsDb } from '../db/outputsDb'
import { esc, escAttr, showToast, copyText } from '../utils'
import { confirmModal, promptModal } from '../components/Modal'
import type { OutputFile, OutputMetadata, OutputDir, OutputScanStatus } from '../types/outputs'
import { extractLorasFromWorkflow } from '../services/outputMetadata'
import { backfillPrompts } from '../services/outputMetadataService'
import JSZip from 'jszip'

import {
  renderDirTree as renderDirTreeHtml,
  renderGrid,
  renderList,
  renderEmpty,
  renderStats,
  renderMetadataPanel,
  STATUS_DEFS,
} from '../renderers/outputRenderer'

import { openContextMenu, closeContextMenu, createOutputContextMenu } from '../components/ContextMenu'

let _initDone = false
let dirTree: OutputDir | null = null
let _lastClickedFileIndex = -1
let _currentPreviewFileId = ''
let _focusMode = false

export async function initOutputs() {
  if (_initDone) return
  _initDone = true

  // 尝试恢复目录句柄（内部已处理增量扫描）
  const restored = await loadOutputDirHandle()
  if (restored) {
    // 构建目录树（buildDirTree 是轻量操作，仅遍历文件名）
    const dh = useOutputStore.getState().dirHandle
    if (dh) {
      dirTree = await buildDirTree(dh)
      renderDirTree(dirTree)
    }
  }

  renderOutputsView()
  bindOutputsEvents()

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

export async function activateOutputs() {
  if (!_initDone) return
  const state = useOutputStore.getState()

  // 有目录句柄时尝试增量扫描
  if (state.dirHandle) {
    const fileCount = state.files.length
    if (fileCount === 0) {
      // 缓存为空 -> 执行扫描
      try {
        await scanOutputDir(state.dirHandle)
        dirTree = await buildDirTree(state.dirHandle)
        renderDirTree(dirTree)
        renderOutputsView()
      } catch { /* 静默失败 */ }
    } else {
      // 已有缓存 -> 尝试检测新文件（轻量操作）
      try {
        const count = await scanOutputDirIncremental(state.dirHandle)
        if (count > 0) {
          dirTree = await buildDirTree(state.dirHandle)
          renderDirTree(dirTree)
          renderOutputsView()
        }
      } catch { /* 静默失败 */ }
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
  updateOutputsStats(state)
  updateFilterPanel()
  syncSortOrderBtn()
}

/** 仅同步选中的 CSS 类，不重建整个卡片 DOM（性能优化） */
function syncSelectionUI() {
  const selectedIds = useOutputStore.getState().selectedIds
  document.querySelectorAll('.outputs-card, .outputs-list-row').forEach(el => {
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
    const row = section.querySelector(`.outputs-list-row[data-id="${id}"]`) as HTMLElement
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

function updateFilterPanel() {
  const body = document.getElementById('outputsFilterBody')
  if (!body) return
  const s = useOutputStore.getState()
  const hasMeta = s.metadataCache.size > 0
  const hasAny = s.filterModel || s.filterLora || s.filterDateMin || s.filterDateMax || s.filterQuickPeriod || s.filterStatusFlags.length > 0 || s.filterTag

  // 同步输入框值
  const setVal = (cls: string, val: string) => {
    const el = document.querySelector('.' + cls) as HTMLInputElement
    if (el && el.value !== val) el.value = val
  }
  setVal('outputs-filter-model', s.filterModel)
  setVal('outputs-filter-lora', s.filterLora)
  setVal('outputs-filter-date-min', s.filterDateMin)
  setVal('outputs-filter-date-max', s.filterDateMax)

  // 同步快捷时间段按钮状态
  document.querySelectorAll('.outputs-period-btn').forEach(b => {
    b.classList.toggle('active', (b as HTMLElement).dataset.period === s.filterQuickPeriod)
  })

  // 同步状态标记按钮
  document.querySelectorAll('.outputs-filter-flag-btn').forEach(b => {
    const flag = (b as HTMLElement).dataset.flag
    b.classList.toggle('active', flag ? s.filterStatusFlags.includes(flag) : false)
  })

  // 填充 datalist 选项并显示/隐藏筛选组
  if (hasMeta) {
    const models = new Set<string>()
    const loras = new Set<string>()
    for (const meta of s.metadataCache.values()) {
      if (meta.model) models.add(meta.model)
      if (meta.workflowJson) {
        try {
          const extracted = extractLorasFromWorkflow(meta.workflowJson, meta.rawMetadata)
          for (const l of extracted) loras.add(l)
        } catch {}
      }
    }
    const modelList = document.getElementById('outputsModelList')
    if (modelList) modelList.innerHTML = Array.from(models).sort().map(m => `<option value="${escAttr(m)}">`).join('')
    const loraList = document.getElementById('outputsLoraList')
    if (loraList) loraList.innerHTML = Array.from(loras).sort().map(l => `<option value="${escAttr(l)}">`).join('')

    // 有数据时显示筛选组
    const modelGroup = document.getElementById('outputsFilterGroupModel')
    if (modelGroup) modelGroup.style.display = models.size > 0 ? 'block' : 'none'
    const loraGroup = document.getElementById('outputsFilterGroupLora')
    if (loraGroup) loraGroup.style.display = loras.size > 0 ? 'block' : 'none'
  }

  // 显示/隐藏清除按钮
  const clearBtn = document.querySelector('.outputs-filter-clear') as HTMLElement
  if (clearBtn) clearBtn.style.display = hasAny ? 'block' : 'none'
}

function renderImageGrid(state: ReturnType<typeof useOutputStore.getState>) {
  const el = document.querySelector('.outputs-grid') as HTMLElement
  if (!el) return

  const files = state.filteredFiles
  const hasDir = !!state.dirHandle

  if (files.length === 0) {
    el.innerHTML = renderEmpty(hasDir)
    return
  }

  if (state.viewMode === 'grid') {
    // Pre-compute loras for card display
    const lorasCache = new Map<string, string[]>()
    for (const f of files) {
      const meta = state.metadataCache.get(f.id)
      if (meta?.workflowJson) {
        const extracted = extractLorasFromWorkflow(meta.workflowJson, meta.rawMetadata)
        if (extracted.length > 0) lorasCache.set(f.id, extracted)
      }
    }
    el.innerHTML = renderGrid(files, state.selectedIds, state.metadataCache, lorasCache)
  } else {
    el.innerHTML = renderList(files, state.selectedIds, state.metadataCache)
  }
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

  // 事件委托 - 单一 click handler
  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement

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

    // 刷新目录
    if (target.closest('.outputs-refresh-btn')) {
      const dh = useOutputStore.getState().dirHandle
      if (dh) {
        await scanOutputDir(dh)
        dirTree = await buildDirTree(dh)
        renderDirTree(dirTree)
        renderOutputsView()
      }
      return
    }

    // 强制重新解析元数据（解析逻辑升级后，旧的 prompt/workflow 缓存需重扫才会更新）
    if (target.closest('.outputs-reparse-btn')) {
      const dh = useOutputStore.getState().dirHandle
      if (!dh) { showToast('请先选择目录'); return }
      await reparseAllMetadata(dh)
      renderOutputsView()
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

    // 复制 LoRA 标签按钮
    const copyLoraBtn = target.closest('.outputs-copy-lora-btn') as HTMLElement
    if (copyLoraBtn) {
      const id = copyLoraBtn.dataset.id
      if (id) {
        const meta = useOutputStore.getState().metadataCache.get(id)
        if (meta?.workflowJson) {
          try {
            const workflow = JSON.parse(meta.workflowJson)
            const loras: string[] = []
            const LORA_TAG_RE = /<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>/gi
            const added = new Set<string>()

            function addFromNode(node: any) {
              const inputs = node?.inputs
              if (!inputs || typeof inputs !== 'object') return

              // Standard LoraLoader
              if (inputs.lora_name && typeof inputs.lora_name === 'string') {
                const clean = inputs.lora_name.replace(/\.(safetensors|pt|bin)$/i, '').trim()
                const weight = inputs.strength_model ?? 1.0
                if (clean && !added.has(clean)) {
                  added.add(clean)
                  loras.push(`<lora:${clean}:${Number(weight).toFixed(2)}>`)
                }
                return
              }

              // LoraManager: inputs.text = "<lora:name:w> <lora:name:w> ..."
              if (inputs.text && typeof inputs.text === 'string') {
                let m: RegExpExecArray | null
                while ((m = LORA_TAG_RE.exec(inputs.text)) !== null) {
                  const name = m[1].trim()
                  const w = parseFloat(m[2])
                  if (name && !added.has(name)) {
                    added.add(name)
                    loras.push(`<lora:${name}:${isNaN(w) ? '0.80' : w.toFixed(2)}>`)
                  }
                }
                return
              }

              // LoraManager widget object
              if (inputs.loras && typeof inputs.loras === 'object' && !Array.isArray(inputs.loras)) {
                for (const k of Object.keys(inputs.loras)) {
                  const entry = inputs.loras[k]
                  if (entry && typeof entry === 'object') {
                    const name = (entry.name || entry.lora_name || '').trim()
                    const w = parseFloat(entry.strength ?? entry.model_strength ?? 0.8)
                    if (name && !added.has(name)) {
                      added.add(name)
                      loras.push(`<lora:${name}:${isNaN(w) ? '0.80' : w.toFixed(2)}>`)
                    }
                  }
                }
              }
            }

            // Workflow format
            for (const node of (workflow.nodes || [])) addFromNode(node)
            // Prompt format
            if (typeof workflow === 'object') {
              for (const key of Object.keys(workflow)) addFromNode(workflow[key])
            }

            if (loras.length > 0) {
              await navigator.clipboard.writeText(loras.join(', '))
              showToast(`已复制 ${loras.length} 个 LoRA 标签`)
            } else if (meta?.rawMetadata?.prompt && meta.rawMetadata.prompt !== meta.workflowJson) {
              // Fallback: try raw prompt format (stored alongside UI workflow in old scans)
              try {
                const promptWorkflow = JSON.parse(meta.rawMetadata.prompt)
                for (const key of Object.keys(promptWorkflow)) addFromNode(promptWorkflow[key])
                if (loras.length > 0) {
                  await navigator.clipboard.writeText(loras.join(', '))
                  showToast(`已复制 ${loras.length} 个 LoRA 标签`)
                } else {
                  showToast('未检测到 LoRA 节点')
                }
              } catch {
                showToast('未检测到 LoRA 节点')
              }
            } else {
              showToast('未检测到 LoRA 节点')
            }
          } catch {
            showToast('解析 workflow 失败')
          }
        } else {
          showToast('该图片无 LoRA 数据')
        }
      }
      return
    }

    // 复制工作流 JSON 按钮（卡片底部）
    const copyWfBtn = target.closest('.outputs-copy-wf-btn') as HTMLElement
    if (copyWfBtn) {
      const id = copyWfBtn.dataset.id
      if (id) {
        const meta = useOutputStore.getState().metadataCache.get(id)
        if (meta?.workflowJson) {
          await navigator.clipboard.writeText(meta.workflowJson)
          showToast('工作流 JSON 已复制')
        } else {
          showToast('该图片无工作流数据')
        }
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
          useOutputStore.getState().clearSelection()
          useOutputStore.getState().toggleSelect(id)
          _lastClickedFileIndex = useOutputStore.getState().filteredFiles.findIndex(f => f.id === id)
        }
        syncSelectionUI()
        updateBatchBar()
      }
      return
    }

    // 列表行点击
    const row = target.closest('.outputs-list-row') as HTMLElement
    if (row && !target.closest('.outputs-list-chk') && !target.closest('.outputs-action-btn')) {
      const id = row.dataset.id
      if (id) {
        if (e.shiftKey) {
          rangeSelectTo(id)
        } else if (e.ctrlKey || e.metaKey) {
          useOutputStore.getState().toggleSelect(id)
          _lastClickedFileIndex = useOutputStore.getState().filteredFiles.findIndex(f => f.id === id)
        } else {
          useOutputStore.getState().clearSelection()
          useOutputStore.getState().toggleSelect(id)
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

    // 全选
    if (target.id === 'outputsSelectAll') {
      const checkbox = target as HTMLInputElement
      if (checkbox.checked) {
        useOutputStore.getState().selectAll()
      } else {
        useOutputStore.getState().clearSelection()
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

    // 关闭元数据面板
    if (target.closest('#outputsMetaCloseBtn')) {
      const panel = document.querySelector('.outputs-metadata-panel') as HTMLElement
      const lightbox = document.getElementById('lightbox')
      if (panel) panel.classList.remove('open')
      if (lightbox) lightbox.classList.remove('open')
      return
    }

    // 复制工作流 JSON
    if (target.closest('#outputsMetaCopyWorkflowBtn')) {
      const meta = useOutputStore.getState().metadataCache.get(_currentPreviewFileId)
      if (meta?.workflowJson) {
        navigator.clipboard.writeText(meta.workflowJson).then(() => {
          showToast('工作流 JSON 已复制')
        }).catch(() => {
          showToast('复制失败')
        })
      }
      return
    }

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
      && !target.closest('button, input, select, textarea, .outputs-card, .outputs-list-row, .outputs-card-btn, .outputs-list-chk, .outputs-dir-node, .outputs-toolbar-btn, .outputs-batch-btn, .outputs-filter-input, .outputs-filter-clear, .outputs-shortcuts-btn, .outputs-select-btn, .outputs-refresh-btn, .outputs-search, .outputs-workflow-toggle, #outputsMetaCopyWorkflowBtn, #outputsMetaCloseBtn, .outputs-meta-close-btn, .lb-nav, #outputsNodeMoreBtn, .outputs-sort-btn, .outputs-filter-btn, .outputs-view-grid, .outputs-view-list')) {
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

  // ── 右键菜单 ──
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement

    // 只处理 outputs 模块内部
    if (!target.closest('#sectionOutputs') && !target.closest('.outputs-metadata-panel')) return

    // 找到被右键的图片卡片或列表行
    const card = target.closest('.outputs-card') as HTMLElement
    const row = target.closest('.outputs-list-row') as HTMLElement
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

  function getCardIdsInRect(l: number, t: number, r: number, b: number): string[] {
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
    if (target.closest('.outputs-card, .outputs-list-card, .outputs-list-header, button, input, .outputs-empty, .outputs-toolbar, .outputs-batch-bar')) return
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
    syncSelectionUI()
    updateBatchBar()
  })
}

function setupInfiniteScroll() {
  // 查找或创建滚动哨兵元素
  let sentinel = document.querySelector('.outputs-scroll-sentinel') as HTMLElement
  if (!sentinel) {
    sentinel = document.createElement('div')
    sentinel.className = 'outputs-scroll-sentinel'
    const outputsGrid = document.querySelector('.outputs-grid')
    if (outputsGrid) {
      outputsGrid.after(sentinel)
    }
  }

  // 清理旧观察器
  if ((sentinel as any)._io) {
    ;(sentinel as any)._io.disconnect()
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
  ;(sentinel as any)._io = observer
}

async function preloadMetadataBatch(files: OutputFile[], cache: Map<string, OutputMetadata>) {
  const ids = files.map(f => f.id).filter(id => !cache.has(id))
  if (ids.length === 0) return

  // 分批从 IndexedDB 读取，每批 50
  const BATCH = 50
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    try {
      const metas = await outputsDb.metadata.bulkGet(batch)
      const next = new Map(useOutputStore.getState().metadataCache)
      let updated = false
      for (const meta of metas) {
        if (meta && !next.has(meta.imageId)) {
          next.set(meta.imageId, meta)
          updated = true
        }
      }
      if (updated) {
        useOutputStore.setState({ metadataCache: next })
        // 元数据加载后刷新卡片（让复制 Prompt 等依赖元数据的按钮显示）
        if (i + BATCH >= ids.length || ids.length <= BATCH) {
          // 最后一批或少量数据时，一次性刷新
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
  orderBtn.textContent = state.sortOrder === 'desc' ? '↓' : '↑'
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
    // 尝试从缓存加载
    const cached = await import('../services/outputThumbnail').then(m => m.getCachedThumbnail(filePath))
    if (cached) {
      img.src = cached
      return
    }

    // 从文件系统加载
    const parts = filePath.split('/')
    let current = dh
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i])
    }
    const fileHandle = await current.getFileHandle(parts[parts.length - 1])
    const file = await fileHandle.getFile()

    const thumbnail = await import('../services/outputThumbnail').then(m => m.getThumbnail(file, filePath))
    if (thumbnail) {
      img.src = thumbnail
    }
  } catch {
    // 加载失败，显示占位符
    img.style.display = 'none'
  }
}

function showCompatMessage() {
  showToast('⚠️ 当前浏览器不支持目录访问权限。请使用 Chrome/Edge，或检查浏览器设置中是否允许 "存储访问" 权限。')
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
    const parts = file.path.split('/')
    let current = dh
    for (let i = 0; i < parts.length - 1; i++) current = await current.getDirectoryHandle(parts[i])
    const handle = await current.getFileHandle(parts[parts.length - 1])
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
function openMetaPanel(fileId: string) {
  const state = useOutputStore.getState()
  const file = state.files.find(f => f.id === fileId)
  const meta = state.metadataCache.get(fileId)
  if (!file) return

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:radial-gradient(ellipse at top,rgba(10,10,15,0.85),rgba(2,2,3,0.95));z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:linear-gradient(180deg,#111116,#0a0a0c);border-radius:12px;padding:16px;width:90vw;max-width:640px;max-height:85vh;overflow-y:auto;border:1px solid rgba(255,255,255,0.1);box-shadow:0 0 0 1px rgba(255,255,255,0.04),0 24px 70px rgba(0,0,0,0.7);'
  panel.innerHTML = renderMetadataPanel(meta ?? null, file)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  panel.querySelector('#outputsMetaCloseBtn')?.addEventListener('click', () => overlay.remove())
  panel.querySelector('#outputsMetaCopyWorkflowBtn')?.addEventListener('click', async () => {
    if (meta?.workflowJson) {
      await navigator.clipboard.writeText(meta.workflowJson)
      showToast('工作流 JSON 已复制')
    }
  })
  // Esc 关闭
  const escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler) } }
  document.addEventListener('keydown', escHandler)
}

async function openPreview(fileId: string) {
  _currentPreviewFileId = fileId
  const file = useOutputStore.getState().files.find(f => f.id === fileId)
  if (!file) return

  const meta = await useOutputStore.getState().loadMetadata(fileId)

  // 获取图片 URL
  const dh = useOutputStore.getState().dirHandle
  if (!dh) return

  let imgUrl = ''
  try {
    const parts = file.path.split('/')
    let current = dh
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i])
    }
    const fileHandle = await current.getFileHandle(parts[parts.length - 1])
    const f = await fileHandle.getFile()
    imgUrl = URL.createObjectURL(f)
  } catch {
    return
  }

  // 打开 lightbox
  const lightbox = document.getElementById('lightbox')
  const img = document.getElementById('lbImg') as HTMLImageElement
  const counter = document.getElementById('lbCounter')

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

  // 显示元数据面板
  showMetadataPanel(meta, file)
  document.querySelector('.outputs-metadata-panel')?.classList.add('open')
}

function showMetadataPanel(meta: OutputMetadata | null, file: OutputFile) {
  const panel = document.querySelector('.outputs-metadata-panel') as HTMLElement
  if (!panel) return
  panel.innerHTML = renderMetadataPanel(meta, file)
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
