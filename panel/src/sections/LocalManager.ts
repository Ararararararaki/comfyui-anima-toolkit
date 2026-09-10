import { deleteLocalLoraPreview, loadLocalLoraPreviews, saveLocalLoraPreview, useLocalModelStore } from '../store/localModels'
import type { LocalDisplayMode, LocalSortKey, LocalFilterKey, LocalViewKey } from '../store/localModels'
import { esc, escAttr, copyText, showToast, fmtNum, thumbUrl, debounce, stripExt, setBtnIcon, icon, attachSearchClear } from '../utils'
import { openLightbox } from '../components/Lightbox'
import type { PngMeta, LocalLoraFile, TagFreq } from '../types'
import type { OutputMetadata } from '../types/outputs'
import { promptModal, confirmModal } from '../components/Modal'
import { openContextMenu, type ContextMenuAction } from '../components/ContextMenu'
import { refreshLocalNames } from '../components/ModelCard'
import { bindUrlDownloadModal } from './downloadUrlModal'
import { useOutputStore } from '../store/outputStore'
import { ensureAllMetadata, isMetadataIndexComplete } from '../services/outputMetadataIndex'
import { extractLorasFromWorkflow, decompressZlibAsync } from '../services/outputMetadata'

// ── 搜索高亮工具 ──
function highlightText(text: string, query: string): string {
  if (!query) return esc(text)
  const escaped = esc(text)
  const q = esc(query)
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>')
}

let _initDone = false
let _localStoreUnsubscribe: (() => void) | null = null

// ── 渲染调度：扫描/匹配期间 store 高频变化（每个文件 updateFile 一次），
// 若每次都全量重建列表 DOM（数千卡片）会把主线程反复打满 —— 表现为弹窗/滚动期间
// 页面接近无响应。这里做 250ms 尾沿节流：短风暴合并成每 250ms 最多一次重渲染。──
let _renderTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRenderLocalView(): void {
  if (_renderTimer !== null) return
  _renderTimer = setTimeout(() => {
    _renderTimer = null
    renderLocalView()
  }, 250)
}

// ── 拖拽框选选中的 LoRA（右键可批量添加分类） ──
let _dragSelected = new Set<string>()
let _dragInitDone = false
let _justBoxed = false

function clearDragHighlight() {
  document.querySelectorAll('#localFileList .local-list-item.local-drag-selected').forEach(el => {
    el.classList.remove('local-drag-selected')
  })
}

// 右键菜单：单个 LoRA 切换分类，或拖拽多选时批量添加分类
// 菜单为「连续勾选」模式：点击分类后菜单保持打开（sticky），可一次勾选多个分类，点「✅ 完成」收尾
function openLoraContextMenu(e: MouseEvent, name: string) {
  const x = e.clientX, y = e.clientY

  // ── 拖拽多选：右键在选中项上 → 批量添加分类 ──
  if (_dragSelected.size > 1 && _dragSelected.has(name)) {
    const names = [..._dragSelected]
    const openBatchMenu = () => {
      const s = useLocalModelStore.getState()
      let addedCount = 0
      const catItems: ContextMenuAction[] = s.categories.map(cat => {
        const it: ContextMenuAction = {
          label: `🏷️ ${cat}`,
          sticky: true,
          handler: () => {
            // setBatchModelCategories 为累加语义：可连续勾选多个分类
            useLocalModelStore.getState().setBatchModelCategories(names, cat)
            useLocalModelStore.getState().saveToCache()
            addedCount++
            it.label = `☑ ${cat}`
          },
        }
        return it
      })
      catItems.push({
        label: '➕ 新建分类…',
        handler: async () => {
          const n = (await promptModal('新建分类'))?.trim()
          if (!n) return
          const st = useLocalModelStore.getState()
          if (st.categories.includes(n)) { showToast('分类已存在'); return }
          st.addCategory(n)
          st.setBatchModelCategories(names, n)
          st.saveToCache()
          addedCount++
          openBatchMenu() // 重开菜单以纳入新分类
        },
      })
      catItems.push({
        label: '✅ 完成',
        handler: () => {
          _dragSelected.clear()
          clearDragHighlight()
          renderLocalView()
          if (addedCount > 0) showToast(`✅ ${names.length} 个 LoRA 已添加 ${addedCount} 项分类`)
        },
      })
      openContextMenu(x, y, [
        {
          label: `已选 ${names.length} 个 LoRA`,
          items: [{ label: '添加到分类', icon: '🏷️', handler: () => {}, children: catItems }],
        },
      ])
    }
    openBatchMenu()
    return
  }

  // ── 单个 LoRA：分类勾选/取消（菜单保持打开，可同时勾选多个分类）──
  const openSingleMenu = () => {
    const s = useLocalModelStore.getState()
    const key = stripExt(name)
    const current = () => useLocalModelStore.getState().modelCategories[key] || []
    const catItems: ContextMenuAction[] = s.categories.map(cat => {
      const it: ContextMenuAction = {
        label: current().includes(cat) ? `☑ ${cat}` : `☐ ${cat}`,
        sticky: true,
        handler: () => {
          const st = useLocalModelStore.getState()
          const cur = st.modelCategories[key] || []
          const next = cur.includes(cat) ? cur.filter(c => c !== cat) : [...cur, cat]
          st.setModelCategories(name, next)
          st.saveToCache()
          it.label = next.includes(cat) ? `☑ ${cat}` : `☐ ${cat}`
          renderLocalView()
        },
      }
      return it
    })
    catItems.push({
      label: '➕ 新建分类…',
      handler: async () => {
        const n = (await promptModal('新建分类'))?.trim()
        if (!n) return
        const st = useLocalModelStore.getState()
        if (st.categories.includes(n)) { showToast('分类已存在'); return }
        st.addCategory(n)
        st.setModelCategories(name, [...(st.modelCategories[key] || []), n])
        st.saveToCache()
        renderLocalView()
        openSingleMenu() // 重开菜单以纳入新分类并显示 ☑
      },
    })
    catItems.push({ label: '✅ 完成', handler: () => {} }) // 点击即关闭菜单（默认行为）
    openContextMenu(x, y, [
      {
        label: name.replace(/\.\w+$/, ''),
        items: [{ label: '分类', icon: '🏷️', handler: () => {}, children: catItems }],
      },
    ])
  }
  openSingleMenu()
}

// 拖拽框选（复刻 Outputs）：在列表空白处按下并拖动，框选多个 LoRA
function initDragSelect() {
  if (_dragInitDone) return
  _dragInitDone = true

  let isDragging = false
  let startX = 0, startY = 0
  let rectEl: HTMLElement | null = null

  // 右键菜单：document 捕获阶段接管，防止浏览器默认菜单/扩展抢先
  document.addEventListener('contextmenu', (e: MouseEvent) => {
    const item = (e.target as HTMLElement).closest('#localFileList .local-list-item') as HTMLElement
    if (!item) return
    e.preventDefault()
    e.stopPropagation()
    const name = item.dataset.name
    if (name) openLoraContextMenu(e, name)
  }, true)

  document.addEventListener('mousedown', (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.closest('#sectionLocal')) return
    if (!target.closest('#localFileList')) return
    // 列表项/空白处按住左键拖动 = 框选（preventDefault 阻止浏览器文字选择/HTML5 drag）
    if (target.closest('.local-list-chk, button, input, select, .local-tree-cat-header')) return
    if (e.button !== 0) return
    isDragging = true
    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    e.preventDefault()
    e.stopPropagation()
    startX = e.pageX; startY = e.pageY
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      _dragSelected.clear()
      clearDragHighlight()
    }
    rectEl = document.createElement('div')
    rectEl.className = 'local-selection-rect'
    rectEl.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;z-index:99999;background:var(--accent-soft);border:2px dashed var(--accent-line);pointer-events:none;border-radius:4px`
    document.body.appendChild(rectEl)
  }, true)

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging || !rectEl) return
    const l = Math.min(startX, e.pageX), t = Math.min(startY, e.pageY)
    const r = Math.max(startX, e.pageX), b = Math.max(startY, e.pageY)
    const sx = window.scrollX, sy = window.scrollY
    rectEl.style.cssText = `position:fixed;left:${l - sx}px;top:${t - sy}px;width:${r - l}px;height:${b - t}px;z-index:99999;background:var(--accent-soft);border:2px dashed var(--accent-line);pointer-events:none;border-radius:4px`
    if (r - l > 5 || b - t > 5) {
      const inRect = new Set<string>()
      document.querySelectorAll('#localFileList .local-list-item').forEach(el => {
        const cr = el.getBoundingClientRect()
        const cardL = cr.left + sx, cardT = cr.top + sy
        const cardR = cr.right + sx, cardB = cr.bottom + sy
        if (l < cardR && r > cardL && t < cardB && b > cardT) {
          const nm = (el as HTMLElement).dataset.name
          if (nm) inRect.add(nm)
        }
      })
      _dragSelected = inRect
      clearDragHighlight()
      document.querySelectorAll('#localFileList .local-list-item').forEach(el => {
        const nm = (el as HTMLElement).dataset.name
        if (nm && _dragSelected.has(nm)) (el as HTMLElement).classList.add('local-drag-selected')
      })
    }
  })

  document.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    if (_dragSelected.size > 0) {
      _justBoxed = true
      showToast(`已选中 ${_dragSelected.size} 个，右键可批量添加分类`)
    }
  })

  // 拖拽中途失焦（切屏/alt-tab/切标签页）或鼠标离开页面 → mouseup 不会派发，
  // 必须手动取消拖拽并清理残留选框，否则虚线框会永久滞留页面。
  const cancelDrag = () => {
    if (!isDragging) return
    isDragging = false
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    _dragSelected.clear()
    clearDragHighlight()
  }
  window.addEventListener('blur', cancelDrag)
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelDrag() })
  document.addEventListener('mouseleave', cancelDrag)

  // capture 阶段拦截：框选结束后的 click 不应触发"选中详情"
  document.addEventListener('click', (e: MouseEvent) => {
    if (_justBoxed) {
      e.preventDefault()
      e.stopPropagation()
      _justBoxed = false
      return
    }
    const t = e.target as HTMLElement
    if (!t.closest('.local-drag-selected')) {
      _dragSelected.clear()
      clearDragHighlight()
    }
  }, true)
}


export async function initLocalManager() {
  const store = useLocalModelStore.getState()
  store.loadFromCache()
  store.rebuildTagFreq()
  renderLocalView()
  bindLocalEvents()
  if (!_localStoreUnsubscribe) {
    _localStoreUnsubscribe = useLocalModelStore.subscribe((state, previous) => {
      if (state.files !== previous.files || state.scanStatus !== previous.scanStatus || state.scanningDir !== previous.scanningDir) {
        // 扫描/匹配风暴期间 store 每个文件都变一次 → 节流合并，别每次全量重建 DOM
        scheduleRenderLocalView()
      }
    })
  }
  _initDone = true
  // 自定义预览图独立于扫描缓存保存，启动时异步恢复，避免大图阻塞首次打开。
  loadLocalLoraPreviews().then(previewImages => {
    useLocalModelStore.setState({ previewImages })
    renderSidebarList(useLocalModelStore.getState())
    renderDetail(useLocalModelStore.getState())
  })
  // 与节点 /anima/meta 双向分类同步：启动时拉取后端分类合并到本地（无变化不重渲染）
  useLocalModelStore.getState().loadBackendMeta().then((changed) => {
    if (changed) renderSidebarList(useLocalModelStore.getState())
  })
}

/** 激活流程并发守卫：快速反复切页时，上一次激活流程没走完就不再叠加 */
let _activateBusy = false
/** 自动扫描（增量检测/后端扫描）节流：5 分钟内只自动跑一次；手动「扫描」按钮不受限 */
const AUTO_SCAN_THROTTLE_MS = 5 * 60 * 1000
let _lastAutoScanAt = 0

export async function activateLocalManager() {
  if (!_initDone) return
  if (_activateBusy) return
  _activateBusy = true
  try {
    await activateLocalManagerInner()
    // 全库元数据补齐（关联出图统计用）：内部再延迟 1.2s，幂等
    scheduleMetadataIndexKick()
  } finally {
    _activateBusy = false
  }
}

async function activateLocalManagerInner() {
  // 拉取后端分类快照。⚠️ 不用 force=true：强制模式绕过 60s 节流，导致每次切到本页
  // 都做一次后端 fetch + 全量 renderLocalView（快速切页时的无谓开销）。
  // 非强制模式自带 60s 节流 —— TK 节点刚改的分类最迟 1 分钟内出现，需要立刻刷新
  // 可用工具箱里的「扫描/刷新」按钮。⚠️ 无变化时不重渲染（changed 才渲染）。
  useLocalModelStore.getState().loadBackendMeta().then((changed) => {
    if (changed) scheduleRenderLocalView()
  })
  const store = useLocalModelStore.getState()
  if (store.dirHandle) return
  // ⚠️ 自动扫描统一节流（2026-09-10 二次修复）：此前只在「句柄失效」分支判节流，
  // 「首次使用」分支（files=0）漏判 —— 扫描进行中 files 仍为 0，快速切页每次激活
  // 都重新 scanIncremental（CDP 实测 10 次往返产生 59 个后端扫描请求）。
  if (Date.now() - _lastAutoScanAt < AUTO_SCAN_THROTTLE_MS) return
  _lastAutoScanAt = Date.now()
  const hasCache = store.files.length > 0
  if (hasCache) {
    const restored = await store.loadDirHandle()
    if (restored) {
      const throttled = Date.now() - _lastAutoScanAt < AUTO_SCAN_THROTTLE_MS
      const newCount = throttled ? 0 : await store.detectNewFiles()
      _lastAutoScanAt = Date.now()
      if (newCount > 0) {
        // 自动增量扫描：用户痛点——新下载的 LoRA 必须手动重选目录扫描才会出现。
        // 有已授权句柄时直接后台扫描 + 自动匹配，免弹窗。
        store.setNewFileCount(newCount)
        showToast(`📁 发现 ${newCount} 个新 LoRA 文件，自动扫描中…`)
        await store.scanIncremental()
        renderLocalView()
      } else {
        showToast('🔄 已恢复上次扫描会话')
      }
    } else {
      // 句柄已失效（页面刷新后的常态）：静默回退后端扫描，全程无需交互、不弹任何对话框。
      // ⚠️ 后端扫描是全目录遍历，反复切页不能反复跑 —— 受 5 分钟节流约束。
      if (Date.now() - _lastAutoScanAt >= AUTO_SCAN_THROTTLE_MS) {
        _lastAutoScanAt = Date.now()
        showToast('🔄 已恢复缓存数据，后台同步中…')
        void store.scanIncremental().then(() => renderLocalView())
      }
    }
  } else {
    // 首次使用（无缓存）：静默扫一次（预设路径 → 上次路径 → ComfyUI loras 目录）
    void store.scanIncremental().then(() => renderLocalView())
  }
}

function $$(s: string): HTMLElement | null {
  return document.getElementById(s)
}

function localPreviewSources(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string[] {
  const custom = state.previewImages[f.name]
  const remote = (f.matchData?.images || []).filter(Boolean)
  return custom ? [custom, ...remote] : remote
}

function localPreviewSrc(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>, width: number): string {
  const custom = state.previewImages[f.name]
  return custom || (f.matchData?.images?.[0] ? thumbUrl(f.matchData.images[0], width) : '')
}

function localPreviewImg(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>, className: string, width: number): string {
  const src = localPreviewSrc(f, state, width)
  return src
    ? `<img src="${escAttr(src)}" class="${className}" loading="lazy" alt="${escAttr(f.matchData?.modelName || f.name)}" onerror="this.style.display='none'" onload="this.style.display='block'">`
    : ''
}

function localStatusBadge(f: LocalLoraFile, full = false): string {
  if (f.scanning) return `<span class="local-list-badge scanning">${full ? '匹配中…' : '⏳'}</span>`
  if (f.matched) return `<span class="local-list-badge matched">${full ? '已匹配' : '✓'}</span>`
  if (f.matchError) return `<span class="local-list-badge error">${full ? '未匹配' : '✗'}</span>`
  return ''
}

function renderListFileItem(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string {
  const isSel = f.name === state.selectedModel
  const isBatchSelected = state.batchSelection.includes(f.name)
  const thumb = localPreviewImg(f, state, 'local-list-thumb', 120) || '<div class="local-list-thumb local-list-thumb-placeholder"></div>'
  const label = f.matchData?.modelName || f.name
  const localSuffix = f.matchData?.modelName ? `<span class="local-list-localname">${esc(f.name.replace(/\.\w+$/, ''))}</span>` : ''
  const creator = f.matchData?.creator || fmtSize(f.size)
  const versionSuffix = f.matchData?.versionName ? ` <span style="color:var(--text2)">· v${esc(f.matchData.versionName)}</span>` : ''
  const query = state.searchQuery || ''
  const chk = state.batchMode
    ? `<input type="checkbox" class="local-list-chk" data-name="${escAttr(f.name)}" ${state.batchSelection.includes(f.name) ? 'checked' : ''}>`
    : ''
  return `<div class="local-list-item ${isSel ? 'active' : ''} ${isBatchSelected ? 'batch-selected' : ''}" data-name="${escAttr(f.name)}" draggable="true">
    ${chk}
    ${thumb}
    <div class="local-list-info">
      <div class="local-list-name">${highlightText(label, query)}${localSuffix}</div>
      <div class="local-list-meta">${f.matchData ? highlightText(creator, query) : creator}${versionSuffix}</div>
    </div>
    <div class="local-list-actions">
      ${localStatusBadge(f)}
      <button class="local-list-del" data-name="${escAttr(f.name)}" title="从磁盘删除">${icon('trash', 12)}</button>
    </div>
  </div>`
}

function localGridStatusDot(f: LocalLoraFile): string {
  const status = f.scanning ? 'scanning' : f.matched ? 'matched' : 'unmatched'
  const label = f.scanning ? '匹配中' : f.matched ? '已匹配' : '未匹配'
  return `<span class="local-grid-status-dot ${status}" title="${label}" aria-label="${label}"></span>`
}

function localModelUrl(f: LocalLoraFile): string | null {
  const d = f.matchData
  if (!d?.modelId) return null
  const version = d.versionId ? `?modelVersionId=${encodeURIComponent(String(d.versionId))}` : ''
  return `https://civitai.com/models/${encodeURIComponent(String(d.modelId))}${version}`
}

function renderGridFileItem(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string {
  const isSel = f.name === state.selectedModel
  const isBatchSelected = state.batchSelection.includes(f.name)
  const custom = !!state.previewImages[f.name]
  const query = state.searchQuery || ''
  const label = f.matchData?.modelName || f.name.replace(/\.\w+$/, '')
  const localName = f.matchData?.modelName ? f.name.replace(/\.\w+$/, '') : ''
  const tags = (state.modelCategories[stripExt(f.name)] || []).slice(0, 2)
  const image = localPreviewImg(f, state, 'local-grid-preview-img', 240) // 卡片实际显示 ~180px，240 覆盖 2x DPI；480 是解码内存浪费
  const preview = image
    ? `<div class="local-grid-preview">${image}${custom ? '<span class="local-grid-custom">自定义</span>' : ''}</div>`
    : `<div class="local-grid-preview local-grid-preview-empty"><span>${icon('package', 30)}</span><small>暂无预览图</small></div>`
  const chk = state.batchMode
    ? `<input type="checkbox" class="local-list-chk local-grid-check" data-name="${escAttr(f.name)}" ${state.batchSelection.includes(f.name) ? 'checked' : ''}>`
    : ''
  const creator = f.matchData?.creator || fmtSize(f.size)
  const stats = f.matchData
    ? `${fmtNum(f.matchData.downloadCount)} 下载 · ${fmtNum(f.matchData.thumbsUpCount)} 赞`
    : creator
  const modelUrl = localModelUrl(f)
  return `<div class="local-list-item local-grid-card ${isSel ? 'active' : ''} ${isBatchSelected ? 'batch-selected' : ''}" data-name="${escAttr(f.name)}" draggable="true">
    ${preview}
    ${chk}
    <div class="local-grid-overlay">
      ${localGridStatusDot(f)}
      <div class="local-grid-actions">
        <button class="local-preview-upload" data-name="${escAttr(f.name)}" title="上传/替换预览图">${icon('image', 13)}</button>
        ${modelUrl ? `<button class="local-open-model" data-url="${escAttr(modelUrl)}" title="打开对应 LoRA 页面">${icon('globe', 13)}</button>` : ''}
        ${custom ? `<button class="local-preview-reset" data-name="${escAttr(f.name)}" title="恢复 C 站预览图">${icon('x', 13)}</button>` : ''}
        <button class="local-list-del" data-name="${escAttr(f.name)}" title="从磁盘删除">${icon('trash', 13)}</button>
      </div>
    </div>
    <div class="local-grid-body">
      <div class="local-grid-name" title="${escAttr(label)}">${highlightText(label, query)}</div>
      ${localName ? `<div class="local-grid-localname" title="${escAttr(localName)}">${esc(localName)}</div>` : ''}
      <div class="local-grid-meta"><span>${esc(stats)}</span><span class="local-grid-extra">${f.matchData?.versionName ? `<span>v${esc(f.matchData.versionName)}</span>` : ''}${tags.length ? `<span class="local-grid-tags">${tags.map(c => `<span>${esc(c)}</span>`).join('')}</span>` : ''}</span></div>
    </div>
  </div>`
}

/**
 * Local 页的「本地 LoRA ↔ 出图关联」需要**全库**元数据视野（见下方两处遍历 metadataCache 的地方）。
 * 元数据已改为按需加载（不再进页面全量预载），所以这里做一次性的按需补齐：
 * 补齐完成后重渲染一次 Local 视图；_localIndexKick 保证不会反复触发。
 *
 * ⚠️ 2026-09-10 性能修复：kick 延迟到激活后 1.2s（让首帧与第一波交互先走），
 * 且完成回调走节流渲染 —— 全库补齐（真实环境数千条，分片 bulkGet）期间用户已经在
 * 操作页面，不能让补齐结束的全量重渲染插入到用户交互中间。
 */
let _localIndexKick = false
let _localKickTimer: ReturnType<typeof setTimeout> | null = null
function scheduleMetadataIndexKick(): void {
  if (_localIndexKick || _localKickTimer !== null) return
  _localKickTimer = setTimeout(() => {
    _localKickTimer = null
    kickMetadataIndexForLocal()
  }, 1200)
}
function kickMetadataIndexForLocal(): void {
  if (_localIndexKick) return
  _localIndexKick = true
  void ensureAllMetadata().then(() => {
    // 只有真的读了新数据才需要重渲染（ensureAllMetadata 在无缺失时立即 resolve，不会死循环）
    if (isMetadataIndexComplete()) scheduleRenderLocalView()
  })
}

export function renderLocalView() {
  const state = useLocalModelStore.getState()
  renderSidebarList(state)
  renderHome(state)
  renderDetail(state)
  updateStats(state)
  // PNG 解析视图：gallery 页始终渲染（空态/数据态），标签统计同步（review blocking 修复）
  renderGallery(state)
  renderTagFreq(state.tagFreq)
}

function renderFileItem(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string {
  return state.displayMode === 'grid' ? renderGridFileItem(f, state) : renderListFileItem(f, state)
}

function applyLocalDisplayMode(state: ReturnType<typeof useLocalModelStore.getState>) {
  const split = document.querySelector('.local-split')
  const container = document.querySelector('.local-container')
  split?.classList.toggle('local-display-grid', state.displayMode === 'grid')
  container?.classList.toggle('local-container-grid', state.displayMode === 'grid')
  const listBtn = $$('localListViewBtn')
  const gridBtn = $$('localGridViewBtn')
  for (const [button, active] of [[listBtn, state.displayMode === 'list'], [gridBtn, state.displayMode === 'grid']] as const) {
    if (!button) continue
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }
}

function renderGridCategoryRail(state: ReturnType<typeof useLocalModelStore.getState>, files: LocalLoraFile[]): string {
  const mc = state.modelCategories || {}
  const countFor = (cat: string | null) => files.filter(f => {
    const assigned = mc[stripExt(f.name)] || []
    return cat === null ? true : cat === '__uncategorized__' ? assigned.length === 0 : assigned.includes(cat)
  }).length
  const row = (cat: string | null, label: string, editable = false) => `<div class="local-grid-category-row">
    <button class="local-grid-cat-btn ${state.filterCategory === cat ? 'active' : ''}" data-cat="${escAttr(cat || '')}" type="button">
      <span class="local-grid-cat-label">${icon(cat === null ? 'grid' : 'folder', 12)}${esc(label)}</span><span class="local-grid-cat-count">${countFor(cat)}</span>
    </button>
    ${editable ? `<button class="local-cat-rename-btn local-grid-cat-action" data-cat="${escAttr(label)}" title="重命名">${icon('edit3', 11)}</button><button class="local-cat-del-btn local-grid-cat-action" data-cat="${escAttr(label)}" title="删除分类">${icon('x', 11)}</button>` : ''}
  </div>`
  const categoryRows = state.categories.map(cat => row(cat, cat, true)).join('')
  return `<div class="local-grid-category-heading"><span>分类</span><span class="local-grid-category-total">${files.length}</span></div>
    ${row(null, '全部')}
    ${categoryRows}
    ${row('__uncategorized__', '未分类')}
    <button class="btn btn-ghost btn-sm local-new-cat-btn local-grid-new-category" type="button">${icon('plus', 12)} 新建分类</button>`
}

function readPreviewFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
      reject(new Error('只支持 PNG、JPG、WebP 或 GIF 图片'))
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      reject(new Error('预览图不能超过 20 MB'))
      return
    }
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      try {
        const maxSide = 720
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('浏览器不支持图片压缩')
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        const result = canvas.toDataURL('image/webp', 0.82)
        URL.revokeObjectURL(objectUrl)
        resolve(result)
      } catch (error) {
        URL.revokeObjectURL(objectUrl)
        reject(error)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('预览图读取失败'))
    }
    image.src = objectUrl
  })
}

async function setLocalPreview(name: string, image: string): Promise<boolean> {
  const s = useLocalModelStore.getState()
  s.setPreviewImage(name, image)
  if (!await saveLocalLoraPreview(name, image)) {
    s.clearPreviewImage(name)
    showToast('⚠️ 预览图保存失败，可能是浏览器存储空间不足')
    return false
  }
  renderSidebarList(useLocalModelStore.getState())
  renderDetail(useLocalModelStore.getState())
  showToast('✅ 已更新本地预览图')
  return true
}

function openLocalPreviewPicker(name: string) {
  document.getElementById('localPreviewModal')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'localPreviewModal'
  overlay.className = 'modal-overlay open local-preview-modal-overlay'
  overlay.innerHTML = `<section class="modal-box local-preview-modal-box" role="dialog" aria-modal="true" aria-labelledby="localPreviewModalTitle">
    <div class="local-preview-modal-head">
      <h3 id="localPreviewModalTitle">设置自定义预览图</h3>
      <button type="button" class="local-preview-modal-close" data-local-preview-close aria-label="关闭">${icon('x', 15)}</button>
    </div>
    <p class="sub">为「${esc(name)}」设置本地预览图。图片会压缩后保存在当前浏览器中。</p>
    <div class="local-preview-dropzone" id="localPreviewDropzone" tabindex="0" role="button" aria-label="拖拽图片或选择文件">
      <div class="local-preview-dropzone-icon">${icon('image', 28)}</div>
      <strong>拖拽图片到这里</strong>
      <span>支持 PNG、JPG、WebP、GIF，最大 20 MB</span>
      <button type="button" class="btn btn-primary btn-sm" id="localPreviewFileBtn">选择文件</button>
      <input type="file" id="localPreviewFileInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
    </div>
    <div class="modal-actions local-preview-modal-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-local-preview-close>取消</button>
    </div>
  </section>`
  document.body.appendChild(overlay)

  const dropzone = overlay.querySelector('#localPreviewDropzone') as HTMLElement
  const input = overlay.querySelector('#localPreviewFileInput') as HTMLInputElement
  const fileBtn = overlay.querySelector('#localPreviewFileBtn') as HTMLButtonElement
  let busy = false

  const close = () => {
    document.removeEventListener('keydown', onKeydown)
    overlay.remove()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close()
  }
  const processFile = async (file?: File) => {
    if (!file || busy) return
    busy = true
    dropzone.classList.add('is-processing')
    try {
      const saved = await setLocalPreview(name, await readPreviewFile(file))
      if (saved) close()
    } catch (error) {
      showToast(`⚠️ ${error instanceof Error ? error.message : '预览图读取失败'}`)
    } finally {
      busy = false
      dropzone.classList.remove('is-processing')
    }
  }

  overlay.addEventListener('click', event => {
    if (event.target === overlay || (event.target as HTMLElement).closest('[data-local-preview-close]')) close()
  })
  fileBtn.addEventListener('click', event => {
    event.stopPropagation()
    input.click()
  })
  input.addEventListener('change', () => processFile(input.files?.[0]))
  dropzone.addEventListener('click', event => {
    if (event.target === dropzone) input.click()
  })
  dropzone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      input.click()
    }
  })
  dropzone.addEventListener('dragover', event => {
    event.preventDefault()
    if (!busy) dropzone.classList.add('drag-over')
  })
  dropzone.addEventListener('dragleave', event => {
    if (event.target === dropzone) dropzone.classList.remove('drag-over')
  })
  dropzone.addEventListener('drop', event => {
    event.preventDefault()
    dropzone.classList.remove('drag-over')
    processFile(event.dataTransfer?.files?.[0])
  })
  document.addEventListener('keydown', onKeydown)
  dropzone.focus()
}

async function setLocalPreviewFromUrl(name: string) {
  const current = useLocalModelStore.getState().previewImages[name]
  const url = await promptModal('设置预览图 URL', current?.startsWith('http') ? current : '', '支持 http(s) 图片地址；保存后会优先显示这张图')
  if (url === null) return
  const normalized = url.trim()
  if (!/^https?:\/\//i.test(normalized)) {
    showToast('⚠️ 预览图 URL 必须以 http:// 或 https:// 开头')
    return
  }
  await setLocalPreview(name, normalized)
}

async function resetLocalPreview(name: string) {
  const s = useLocalModelStore.getState()
  s.clearPreviewImage(name)
  await deleteLocalLoraPreview(name)
  renderSidebarList(useLocalModelStore.getState())
  renderDetail(useLocalModelStore.getState())
  showToast('已恢复 C 站预览图')
}

function renderSidebarList(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('localFileList')
  if (!el) return
  // 分类/批量操作会全量重建列表 DOM；图片异步加载期间高度塌陷会把 scrollTop 钳到 0，
  // 打断"连续右键分类"的浏览位置 → 重建前记录、重建后立即+rAF 各恢复一次。
  const keepScroll = el.scrollTop
  const restoreScroll = () => { el.scrollTop = keepScroll }
  applyLocalDisplayMode(state)

  let files = [...state.files]

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase()
    files = files.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.matchData?.modelName || '').toLowerCase().includes(q) ||
      (f.matchData?.creator || '').toLowerCase().includes(q)
    )
  }
  if (state.filterKey === 'matched') files = files.filter(f => f.matched)
  if (state.filterKey === 'unmatched') files = files.filter(f => !f.matched && !f.scanning)

  const categorySourceFiles = [...files]
  const categoryList = $$('localGridCategoryList')
  if (state.displayMode === 'grid') {
    if (categoryList) categoryList.innerHTML = renderGridCategoryRail(state, categorySourceFiles)
    if (state.filterCategory) {
      files = files.filter(f => {
        const assigned = state.modelCategories[stripExt(f.name)] || []
        return state.filterCategory === '__uncategorized__' ? assigned.length === 0 : assigned.includes(state.filterCategory as string)
      })
    }
  } else {
    if (categoryList) categoryList.innerHTML = ''
    if (state.filterCategory) {
      files = files.filter(f => {
        const assigned = state.modelCategories[stripExt(f.name)] || []
        return state.filterCategory === '__uncategorized__' ? assigned.length === 0 : assigned.includes(state.filterCategory as string)
      })
    }
  }

  switch (state.sortKey) {
    case 'name': files.sort((a, b) => a.name.localeCompare(b.name)); break
    case 'size': files.sort((a, b) => b.size - a.size); break
    case 'date': files.sort((a, b) => b.lastModified - a.lastModified); break
    case 'match': files.sort((a, b) => (a.matched === b.matched ? 0 : a.matched ? -1 : 1)); break
  }

  if (files.length === 0) {
    el.innerHTML = '<div class="empty-state empty-state-wide"><div class="big">' + icon('mailOpen', 28) + '</div><p class="empty-state-text">没有匹配的文件</p></div>'
    updateBatchBar(state)
    return
  }

  if (state.displayMode === 'grid') {
    renderGridChunked(el, files, state)
    return
  }

  const cats = state.categories
  const exp = state.expandedCategories || []
  const mc = state.modelCategories || {}

  // 一次遍历按分类分组(O(n)),替代每分类 filter 的 O(cats×files)
  const byCat: Record<string, LocalLoraFile[]> = {}
  const uncat: LocalLoraFile[] = []
  const categorized = new Set<string>()
  for (const f of files) {
    const assigned = mc[stripExt(f.name)] || []
    if (assigned.length === 0) {
      uncat.push(f)
    } else {
      for (const c of assigned) {
        ;(byCat[c] ||= []).push(f)
        categorized.add(f.name)
      }
    }
  }

  let html = '<div class="local-tree-list">'

  for (const cat of cats) {
    const catFiles = byCat[cat] || []
    if (catFiles.length === 0 && state.searchQuery) continue
    const isExpanded = exp.includes(cat)
    html += `<div class="local-tree-cat" data-cat="${escAttr(cat)}">
      <div class="local-tree-cat-header" data-cat="${escAttr(cat)}">
        <span class="local-tree-cat-arrow ${isExpanded ? 'expanded' : ''}">▶</span>
        <span class="local-tree-cat-name">${esc(cat)}</span>
        <span class="local-tree-cat-count">${catFiles.length}</span>
        <button class="local-cat-rename-btn" data-cat="${escAttr(cat)}" title="重命名">${icon('edit3', 12)}</button>
        <button class="local-cat-del-btn" data-cat="${escAttr(cat)}" title="删除分类">${icon('x', 12)}</button>
        <button class="local-new-cat-btn" title="新建分类">${icon('plus', 12)}</button>
      </div>
      <div class="local-tree-cat-items ${isExpanded ? '' : 'collapsed'}">
        ${isExpanded ? catFiles.map(f => renderFileItem(f, state)).join('') : ''}
      </div>
    </div>`
  }

  const uncatFiles = uncat.filter(f => !categorized.has(f.name))
  if (uncatFiles.length > 0 || !state.searchQuery) {
    const isExpanded = exp.includes('__uncategorized__')
    html += `<div class="local-tree-cat" data-cat="__uncategorized__">
      <div class="local-tree-cat-header" data-cat="__uncategorized__">
        <span class="local-tree-cat-arrow ${isExpanded ? 'expanded' : ''}">▶</span>
        <span class="local-tree-cat-name">未分类</span>
        <span class="local-tree-cat-count">${uncatFiles.length}</span>
      </div>
      <div class="local-tree-cat-items ${isExpanded ? '' : 'collapsed'}">
        ${isExpanded ? uncatFiles.map(f => renderFileItem(f, state)).join('') : ''}
      </div>
    </div>`
  }

  html += '</div>'
  el.innerHTML = html
  restoreScroll()
  requestAnimationFrame(restoreScroll)
  updateBatchBar(state)
}

function updateBatchBar(state: ReturnType<typeof useLocalModelStore.getState>) {
  const bar = $$('localBatchBar')
  const count = $$('localBatchCount')
  if (!bar || !count) return
  count.textContent = `已选 ${state.batchSelection.length} 项`
  if (!state.batchMode || state.batchSelection.length === 0) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'flex'
}

// ── grid 分片渲染（2026-09-10 性能修复，CDP 实测依据）──
// 此前 grid 模式一次性 innerHTML 渲染全部卡片：1200 个 LoRA = 3.2 万 DOM 节点 +
// 960 张图片，单次主线程阻塞 ~500ms（探针实测 521/479ms），且每次切页/搜索/
// 匹配风暴都重复付出。改为「首片 150 + 底部 sentinel 无限追加」：首帧成本约 1/8，
// 滚动到底自动补齐，内容与全量渲染一致。
const LOCAL_GRID_CHUNK = 150
let _gridObserver: IntersectionObserver | null = null

function disconnectGridObserver(): void {
  if (_gridObserver) { _gridObserver.disconnect(); _gridObserver = null }
}

function renderGridChunked(el: HTMLElement, files: LocalLoraFile[], state: ReturnType<typeof useLocalModelStore.getState>): void {
  disconnectGridObserver()

  // 恢复滚动位置：只渲染首片时内容高度可能低于原 scrollTop（被浏览器钳到 0 → 丢失浏览位置），
  // 按容器宽度估列数、每卡 ~340px 估算需要预渲染到原位置的卡数，再恢复 scrollTop。
  const keepScroll = el.scrollTop
  const estCols = Math.max(1, Math.round(el.clientWidth / 192)) // 卡宽 180 + gap 12
  const minCards = Math.min(files.length, Math.ceil((Math.ceil(keepScroll / 340) + 2) * estCols))
  let rendered = Math.max(LOCAL_GRID_CHUNK, minCards)

  // 追加下一片并按需重挂 sentinel；数据已变（files 引用不同）则放弃 —— subscribe 会触发整体重渲染
  const mountSentinel = () => {
    const listEl = el.querySelector('.local-grid-card-list')
    if (!listEl) return
    const s = document.createElement('div')
    s.className = 'local-grid-sentinel'
    s.style.cssText = 'grid-column:1/-1;height:1px'
    listEl.appendChild(s)
    _gridObserver = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return
      const obs = _gridObserver
      if (obs) { obs.disconnect(); _gridObserver = null }
      if (useLocalModelStore.getState().files !== state.files) return
      listEl.querySelector('.local-grid-sentinel')?.remove()
      const to = Math.min(files.length, rendered + LOCAL_GRID_CHUNK)
      const frag = document.createElement('template')
      frag.innerHTML = files.slice(rendered, to).map(f => renderGridFileItem(f, useLocalModelStore.getState())).join('')
      listEl.appendChild(frag.content)
      rendered = to
      if (rendered < files.length) mountSentinel()
    }, { root: el, rootMargin: '600px 0px' })
    _gridObserver.observe(s)
  }

  el.innerHTML = `<div class="local-grid-card-list">${files.slice(0, rendered).map(f => renderGridFileItem(f, state)).join('')}</div>`
  if (rendered < files.length) mountSentinel()
  el.scrollTop = keepScroll
  requestAnimationFrame(() => { el.scrollTop = keepScroll })
  updateBatchBar(state)
}

// ── 模型管理 tab（checkpoint/VAE/embedding/controlnet 等）──
let _modelsLoaded = false
async function renderModelsTab() {
  const el = $$('localModelsContent')
  if (!el) return
  // 已加载过：列表 DOM 保留在页面上（tab 切换只改 display），无需重复 fetch
  if (_modelsLoaded) return
  el.innerHTML = `<div class="empty-state"><div class="big">⏳</div><p>加载模型中…</p></div>`
  try {
    const resp = await fetch('/anima/models')
    if (!resp.ok) throw new Error(`http ${resp.status}`)
    const data = await resp.json()
    _modelsLoaded = true
    const groups = (data.groups || []) as { type: string; label: string; items: any[]; count: number }[]
    const fmtSize = (b: number) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB'
    const fmtDate = (m: number) => m ? new Date(m * 1000).toLocaleDateString('zh-CN') : '-'
    const total = data.total || 0

    if (total === 0) {
      el.innerHTML = `<div class="empty-state"><div class="big">${icon('package', 28)}</div><p>未发现模型文件</p><p class="sub">模型需放在 ComfyUI 的 models/ 对应子目录（checkpoints、vae、embeddings 等）</p></div>`
      return
    }

    el.innerHTML = `
      <div class="local-models-toolbar">
        <span style="font-size:12px;color:var(--text2)">共 <strong style="color:var(--text)">${total}</strong> 个模型</span>
        <span style="font-size:11px;color:var(--text3)">点击模型名复制到剪贴板</span>
      </div>
      ${groups.filter(g => g.count > 0).map(g => `
        <div class="local-models-group">
          <div class="local-models-group-header">
            ${icon('folder', 13)} <span>${esc(g.label)}</span>
            <span class="local-models-count">${g.count}</span>
          </div>
          <div class="local-models-list">
            ${g.items.map(it => `
              <div class="local-models-row" data-name="${escAttr(it.name)}" title="点击复制模型名">
                <span class="local-models-name">${esc(trunc(it.name, 42))}</span>
                <span class="local-models-meta">${esc(it.ext)} · ${fmtSize(it.size)} · ${fmtDate(it.lastModified)}</span>
              </div>`).join('')}
          </div>
        </div>`).join('')}`
    // 点击复制模型名
    el.querySelectorAll('.local-models-row').forEach(row => {
      row.addEventListener('click', () => {
        const name = (row as HTMLElement).dataset.name || ''
        copyText(name, row as HTMLElement)
      })
    })
  } catch (e: any) {
    el.innerHTML = `<div class="empty-state"><div class="big">${icon('alertCircle', 28)}</div><p>加载模型失败</p><p class="sub">${esc(String(e.message || e))}（需 ComfyUI 后端 /anima/models 接口，旧版插件请更新）</p></div>`
  }
}

function renderPromptTab(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('promptLoraList')
  if (!el) return
  const files = state.files.filter(f => f.matched || state.modelCategories[stripExt(f.name)])
  if (files.length === 0) {
    el.innerHTML = '<div class="empty-state empty-state-compact"><p>暂无可用的 LoRA，请先扫描并匹配</p></div>'
    return
  }
  const pw = state.promptWeights || {}
  const lines = files.map(f => {
    const name = f.name.replace(/\.\w+$/, '')
    const w = pw[f.name] ?? 1.0
    return `<div class="prompt-lora-row" data-name="${escAttr(f.name)}">
      <div class="prompt-lora-info">
        <span class="prompt-lora-label" title="${esc(f.name)}">${esc(trunc(name, 30))}</span>
        ${f.matchData?.modelName ? '<span class="prompt-lora-localname">' + esc(f.name.replace(/\.\w+$/, '')) + '</span>' : ''}
      </div>
      <input type="range" class="prompt-lora-slider" min="0" max="2" step="0.05" value="${w}" data-name="${escAttr(f.name)}">
      <input type="number" class="prompt-lora-input" min="0" max="2" step="0.05" value="${w.toFixed(2)}" data-name="${escAttr(f.name)}">
      <button class="btn btn-ghost prompt-lora-copy btn-xs" data-tag="${esc(name)}" data-w="${w}" title="复制触发词">${icon('copy', 11)}</button>
    </div>`
  }).join('')
  el.innerHTML = lines + `
    <div class="prompt-lora-toolbar">
      <button class="btn btn-ghost btn-sm" id="promptCopyAllBtn">${icon('copy', 12)} 复制全部</button>
      <button class="btn btn-ghost btn-sm" id="promptSendComfyBtn">${icon('send', 12)} 发送到 ComfyUI</button>
    </div>`
}

function renderHome(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('pageLocalHome')
  if (!el) return

  // Stats
  const totalFiles = state.files.length
  const matchedFiles = state.files.filter(f => f.matched).length

  // Analyze outputs for lora usage
  const outputState = useOutputStore.getState()
  const outputTotal = outputState.files.length

  // Also collect which loras are in our local files for cross-ref
  const localLoraNames = new Set(state.files.map(f => f.name.replace(/\.\w+$/, '').toLowerCase()))

  // Track how many outputs reference each local lora
  let outputWithLocalLora = 0

  for (const meta of outputState.metadataCache.values()) {
    const loras = meta.loras || []
    if (loras.length === 0) continue

    // Check if any lora is local
    const hasLocal = loras.some(l => localLoraNames.has(l.toLowerCase()))
    if (!hasLocal) continue

    outputWithLocalLora++
  }

  let html = `
    <div class="local-home-summary">
      <div class="local-stat-card"><div class="local-stat-num">${totalFiles}</div><div class="local-stat-label">LoRA 总数</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${matchedFiles}</div><div class="local-stat-label">已匹配</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${outputTotal}</div><div class="local-stat-label">Outputs 总数</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${outputWithLocalLora}</div><div class="local-stat-label">关联 LoRA</div></div>
    </div>`

  if (!outputWithLocalLora) {
    html += `<div class="empty-state"><div class="big">${icon('trendingUp', 28)}</div><p>暂无使用数据，扫描 Outputs 目录后自动生成</p></div>`
  }

  el.innerHTML = html
}
function renderDetail(state: ReturnType<typeof useLocalModelStore.getState>) {
  const empty = $$('detailEmpty')
  const content = $$('detailContent')
  if (!empty || !content) return

  if (!state.selectedModel) {
    empty.style.display = ''
    content.style.display = 'none'
    return
  }

  const f = state.files.find(x => x.name === state.selectedModel)
  if (!f) {
    empty.style.display = ''
    content.style.display = 'none'
    return
  }

  empty.style.display = 'none'
  content.style.display = 'block'

  const d = f.matchData
  const previewSources = localPreviewSources(f, state)
  const customPreview = !!state.previewImages[f.name]
  const imgHtml = previewSources[0]
    ? `<img src="${escAttr(customPreview ? previewSources[0] : thumbUrl(previewSources[0], 400))}" class="detail-hero-img" loading="lazy" alt="${escAttr(d?.modelName || f.name)}" onerror="this.style.display='none'">`
    : '<div class="detail-no-img">📦</div>'
  const previewTools = `<div class="detail-preview-tools">
    <button class="btn btn-ghost btn-sm local-preview-upload" data-name="${escAttr(f.name)}">${icon('image', 12)} ${customPreview ? '替换预览图' : '自定义预览图'}</button>
    <button class="btn btn-ghost btn-sm local-preview-url" data-name="${escAttr(f.name)}">${icon('globe', 12)} 图片 URL</button>
    ${customPreview ? `<button class="btn btn-ghost btn-sm local-preview-reset" data-name="${escAttr(f.name)}">${icon('x', 12)} 恢复 C 站图片</button>` : ''}
  </div>`

  const statusBadge = f.scanning
    ? '<span class="local-badge scanning">⏳ 匹配中…</span>'
    : f.matched
    ? '<span class="local-badge matched">✅ 已匹配</span>'
    : f.matchError
    ? `<span class="local-badge error">❌ ${esc(f.matchError)}</span>`
    : '<span class="local-badge idle">⏸ 未匹配</span>'

  const actionBtn = !f.matched && !f.scanning
    ? `<button class="btn btn-ghost detail-match-btn btn-md" data-name="${escAttr(f.name)}">${icon('search', 12)} 匹配</button>`
    : ''

  const trainedWords = d?.trainedWords?.length
    ? `<div class="detail-section"><h4>触发词</h4><div class="detail-tw-list">${d.trainedWords.map(w => `<code class="local-tw-item" data-copy="${esc(w + ',')}">${esc(w)},</code>`).join('')}</div></div>`
    : ''

  const tags = d?.tags?.length
    ? `<div class="detail-section"><h4>模型标签</h4><div class="detail-tags">${d.tags.map(t => `<span class="detail-tag" data-copy="${esc(t)}">${esc(t)}</span>`).join('')}</div></div>`
    : ''

  const description = d?.description
    ? `<div class="detail-section"><h4>简介</h4><p class="detail-desc">${esc(d.description.slice(0, 300))}${d.description.length > 300 ? '…' : ''}</p></div>`
    : ''

  const modelCats = state.modelCategories[stripExt(f.name)] || []
  const catHtml = `<div class="detail-section"><h4>分类</h4>
    <div class="detail-cats" id="detailCats">
      ${modelCats.map(c => `<span class="detail-cat-chip" data-cat="${escAttr(c)}">${esc(c)} <span class="detail-cat-rm" data-name="${escAttr(f.name)}" data-cat="${escAttr(c)}">✕</span></span>`).join('')}
      <div class="detail-cat-add-wrap">
        <button class="btn btn-ghost btn-sm" id="detailCatAddBtn">+ 分类</button>
        <div class="local-catfilter-dropdown detail-cat-dd" id="detailCatDropdown" style="display:none"></div>
      </div>
    </div></div>`

  // LoRA 标签构建器（权重滑块 + 复制）
  const localBase = f.name.replace(/\.\w+$/, '')
  const loraWeight = state.promptWeights?.[f.name] ?? 1.0
  const loraTagHtml = `<div class="detail-section"><h4>🏷️ LoRA 标签</h4>
    <div class="detail-lora-builder" data-name="${escAttr(f.name)}">
      <div class="detail-lora-preview" id="loraPreview_${escAttr(f.name)}"><code>&lt;lora:${esc(localBase)}:${loraWeight.toFixed(2)}&gt;</code></div>
      <div class="detail-lora-controls">
        <input type="range" class="detail-lora-slider" min="0" max="2" step="0.05" value="${loraWeight}" data-name="${escAttr(f.name)}">
        <input type="number" class="detail-lora-input" min="0" max="2" step="0.05" value="${loraWeight.toFixed(2)}" data-name="${escAttr(f.name)}" style="width:56px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:12px;text-align:center">
        <button class="btn btn-ghost btn-sm detail-lora-copy" data-tag="${esc(localBase)}" data-w="${loraWeight.toFixed(2)}">${icon('copy', 12)} 复制</button>
      </div>
    </div></div>`

  const manualMatchHtml = !f.matched && !f.scanning
    ? `<div class="detail-section"><h4>🔗 手动匹配</h4>
      <div class="detail-manual-match">
        <input type="text" id="manualMatchUrl" placeholder="粘贴 Civitai 链接 (https://civitai.com/models/...)" class="input-sm">
        <button class="btn btn-primary btn-sm" id="manualMatchBtn" data-name="${escAttr(f.name)}">确认</button>
      </div></div>`
    : ''

  const descText = state.descriptions[f.name] || ''
  const descHtml = `<div class="detail-section"><h4>📝 我的备注</h4>
    <textarea class="detail-desc-edit" data-name="${escAttr(f.name)}" placeholder="写下你对此 LoRA 的使用心得、推荐搭配、注意事项…" rows="4">${esc(descText)}</textarea>
    <div class="detail-desc-save" id="descSave_${escAttr(f.name)}">已保存</div></div>`

  const html = `<div class="detail-hero">${imgHtml}${previewTools}</div>
    <div class="detail-actions">
      ${statusBadge}
      <span class="detail-name">${esc(d?.modelName || f.name)}</span>
      <span class="detail-sep">|</span>
      <span class="detail-creator">${esc(d?.creator || '')}</span>
      <div class="detail-actions-right">
        ${d ? `<button class="btn btn-ghost detail-open-url btn-sm" data-id="${d.modelId}">${icon('globe', 12)} Civitai</button>` : ''}
        ${actionBtn}
        <button class="btn btn-ghost btn-sm detail-send-comfy" data-name="${escAttr(f.name)}">${icon('send', 12)} ComfyUI</button>
        <button class="btn btn-ghost detail-del-btn btn-sm btn-red">${icon('trash', 12)} 删除文件</button>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-body-left">
        ${previewSources.length > 1 ? `<div class="detail-section"><h4>图片预览</h4><div class="detail-gallery">${previewSources.slice(1, 6).map((im, i) => `<img src="${escAttr(customPreview && i === 0 ? im : thumbUrl(im, 200))}" class="detail-gallery-thumb" loading="lazy" onerror="this.style.display='none'">`).join('')}</div></div>` : ''}
        ${trainedWords}
        ${tags}
        ${catHtml}
        ${loraTagHtml}
        ${manualMatchHtml}
      </div>
      <div class="detail-body-right">
        ${description}
        <div class="detail-section"><h4>文件信息</h4>
          <div class="detail-fileinfo">
            <div class="detail-fi-row"><span>文件名</span><span>${esc(f.name)}</span></div>
            <div class="detail-fi-row"><span>大小</span><span>${fmtSize(f.size)}</span></div>
            <div class="detail-fi-row"><span>SHA256</span><span class="detail-sha" title="${esc(f.sha256)}">${esc(f.sha256.slice(0, 20))}…</span></div>
            ${d ? `<div class="detail-fi-row"><span>基座模型</span><span>${esc(d.baseModel)}</span></div>` : ''}
            ${d?.versionName ? `<div class="detail-fi-row"><span>版本</span><span>v${esc(d.versionName)} <span style="color:var(--text3);font-size:10px">(ID: ${d.versionId})</span></span></div>` : ''}
            ${d ? `<div class="detail-fi-row"><span>下载</span><span>${fmtNum(d.downloadCount)}</span></div>` : ''}
            ${d ? `<div class="detail-fi-row"><span>点赞</span><span>${fmtNum(d.thumbsUpCount)}</span></div>` : ''}
          </div>
        </div>
        ${descHtml}
        ${renderRelatedOutputs(f)}
      </div>
    </div>`

  content.innerHTML = html

  // Load related output thumbnails eagerly
  loadRelatedOutputThumbnails()
}

function renderRelatedOutputs(f: LocalLoraFile): string {
  const loraBase = f.name.replace(/\.\w+$/, '').toLowerCase()
  const outputState = useOutputStore.getState()
  const matches: { id: string; filePath: string; mtime: number; meta: OutputMetadata | null }[] = []

  for (const meta of outputState.metadataCache.values()) {
    const loras = meta.loras || []
    const match = loras.find(l => l.toLowerCase() === loraBase)
    if (!match) continue

    const file = outputState.files.find(f2 => f2.id === meta.imageId)
    matches.push({
      id: meta.imageId,
      filePath: file?.path || meta.imageId,
      mtime: file?.mtime || 0,
      meta,
    })
  }

  if (matches.length === 0) {
    return '<div class="detail-section"><h4>🖼️ 关联出图</h4><p style="font-size:11px;color:var(--text3)">暂无关联出图</p></div>'
  }

  matches.sort((a, b) => b.mtime - a.mtime)
  const top = matches.slice(0, 12)

  const items = top.map(m => {
    const dateStr = m.mtime ? new Date(m.mtime).toLocaleDateString() : ''
    return `<div class="detail-output-item" data-id="${escAttr(m.id)}" data-path="${escAttr(m.filePath)}">
      <div class="detail-output-thumb" data-path="${escAttr(m.filePath)}">
        <div class="detail-thumb-placeholder">⏳</div>
      </div>
      <div class="detail-output-info">
        <span class="detail-output-date">${dateStr}</span>
      </div>
    </div>`
  }).join('')

  return `<div class="detail-section"><h4>🖼️ 关联出图 <small>${matches.length} 张</small></h4>
    <div class="detail-output-grid">${items}</div></div>`
}

/** 在 detail 渲染后，加载关联出图的缩略图 */
async function loadRelatedOutputThumbnails() {
  const dh = useOutputStore.getState().dirHandle
  if (!dh) return
  const items = document.querySelectorAll('.detail-output-thumb[data-path]')
  for (const el of items) {
    const filePath = (el as HTMLElement).dataset.path
    if (!filePath) continue

    try {
      // Try cache first
      const { getCachedThumbnail, getThumbnail } = await import('../services/outputThumbnail')
      const cached = await getCachedThumbnail(filePath)
      if (cached) {
        el.innerHTML = `<img src="${escAttr(cached)}" alt="" style="width:100%;height:100%;object-fit:cover">`
        continue
      }

      // Load from filesystem
      const parts = filePath.split('/')
      let current = dh
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i])
      }
      const fileHandle = await current.getFileHandle(parts[parts.length - 1])
      const file = await fileHandle.getFile()
      const thumb = await getThumbnail(file, filePath)
      if (thumb) {
        el.innerHTML = `<img src="${escAttr(thumb)}" alt="" style="width:100%;height:100%;object-fit:cover">`
      } else {
        el.innerHTML = '<div style="color:var(--text3);font-size:20px;text-align:center;padding:20% 0">🖼️</div>'
      }
    } catch {
      el.innerHTML = '<div style="color:var(--text3);font-size:20px;text-align:center;padding:20% 0">🖼️</div>'
    }
  }
}

function renderGallery(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('localPngList')
  if (!el) return
  const pngs = state.pngs
  if (pngs.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="big">' + icon('image', 28) + '</div><p>尚未添加 PNG 图片，点击上方区域选择或拖入图片</p></div>'
    return
  }
  el.innerHTML = pngs.map(p => {
    const tags = extractTagsFromPrompt(p.positive).slice(0, 20)
    return `<div class="local-png-card">
      <div class="local-png-header">
        <span class="local-png-name">${esc(p.fileName)}</span>
        <span class="local-png-size">${fmtSize(p.fileSize)}</span>
      </div>
      ${p.positive ? `<div class="local-png-field"><label>正 Prompt</label><div class="local-png-text" data-copy="${esc(p.positive)}">${esc(trunc(p.positive, 200))}</div></div>` : ''}
      ${p.negative ? `<div class="local-png-field"><label>负 Prompt</label><div class="local-png-text" data-copy="${esc(p.negative)}">${esc(trunc(p.negative, 150))}</div></div>` : ''}
      <div class="local-png-params">
        ${p.seed ? `<span>🌰 ${esc(p.seed)}</span>` : ''}
        ${p.steps ? `<span>👣 ${esc(p.steps)}</span>` : ''}
        ${p.cfg ? `<span>⚙️ CFG ${esc(p.cfg)}</span>` : ''}
        ${p.sampler ? `<span>🔬 ${esc(p.sampler)}</span>` : ''}
        ${p.model ? `<span>🧠 ${esc(trunc(p.model, 30))}</span>` : ''}
      </div>
      ${tags.length > 0 ? `<div class="local-png-tags">${tags.map(t => `<code class="local-tw-item" data-copy="${esc(t)}">${esc(t)}</code>`).join('')}</div>` : ''}
      ${p.loras.length > 0 ? `<div class="local-png-loras">${p.loras.map(l => `<code class="local-tw-item lora" data-copy="${esc(l)}">${esc(l)}</code>`).join('')}</div>` : ''}
    </div>`
  }).join('')
}

function renderTagFreq(tags: TagFreq[]) {
  const el = $$('localTagList')
  if (!el) return
  if (tags.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="big">' + icon('tag', 28) + '</div><p>暂无数据，扫描 LoRA 或添加 PNG 后自动生成</p></div>'
    return
  }
  const maxCount = tags[0]?.count || 1
  el.innerHTML = tags.slice(0, 100).map(t => {
    const pct = (t.count / maxCount) * 100
    const fontSize = 11 + pct * 0.06
    return `<span class="local-tag-item" style="font-size:${fontSize.toFixed(1)}px" data-copy="${esc(t.tag)}" title="出现 ${t.count} 次">
      ${esc(t.tag)} <small>${t.count}</small>
    </span>`
  }).join('')
}

function updateStats(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('localScanStats')
  if (el) {
    const matched = state.files.filter(f => f.matched).length
    el.innerHTML = `📦 ${state.files.length} 个文件 · ✅ ${matched} 已匹配`
  }
  const gridStats = $$('localGridStats')
  if (gridStats) {
    const matched = state.files.filter(f => f.matched).length
    gridStats.textContent = `${state.files.length} 个文件 · ${matched} 已匹配`
  }
  const fc = $$('statFileCount')
  const mc = $$('statMatchedCount')
  const pc = $$('statPngCount')
  const tc = $$('statTagCount')
  if (fc) fc.textContent = String(state.files.length)
  if (mc) mc.textContent = String(state.files.filter(f => f.matched).length)
  if (pc) pc.textContent = String(state.pngs.length)
  if (tc) tc.textContent = String(state.tagFreq.length)

  const badge = $$('localNewFileBadge')
  if (badge) {
    const n = state.newFileCount
    if (n > 0 && state.files.length === 0) {
      badge.style.display = 'inline-block'
      badge.textContent = `🆕 发现 ${n} 个新文件，点击扫描`
      badge.onclick = () => useLocalModelStore.getState().scanDir()
    } else {
      badge.style.display = 'none'
    }
  }
}

function bindLocalEvents() {
  // 右键分类菜单 + 拖拽框选（capture 阶段在 initDragSelect 绑定，防止浏览器默认行为/扩展抢先）
  initDragSelect()

  $$('localScanBtn')?.addEventListener('click', async () => {
    if (useLocalModelStore.getState().scanStatus === 'scanning') return
    await useLocalModelStore.getState().scanDir()
    refreshLocalNames()
    renderLocalView()
  })

  $$('localProgressCancel')?.addEventListener('click', () => {
    useLocalModelStore.getState().cancelScan()
  })

  $$('localFolderCategoryBtn')?.addEventListener('click', () => {
    const result = useLocalModelStore.getState().categorizeBySubfolders()
    if (result.folders.length) renderLocalView()
  })

  // 「从 C 站链接批量下载」弹窗已拆分到 downloadUrlModal.ts（纯搬迁，行为等价）
  bindUrlDownloadModal(() => renderLocalView(), () => refreshLocalNames())


  $$('localMatchAllBtn')?.addEventListener('click', async () => {
    const btn = $$('localMatchAllBtn') as HTMLButtonElement
    btn.disabled = true
    setBtnIcon(btn, 'spinner', '匹配中…')
    await useLocalModelStore.getState().matchAll()
    btn.disabled = false
    setBtnIcon(btn, 'refresh', '全部匹配')
    renderLocalView()
  })

  $$('localClearBtn')?.addEventListener('click', () => {
    useLocalModelStore.setState({ files: [], scanStatus: 'idle' })
    useLocalModelStore.getState().saveToCache()
    renderLocalView()
  })

  $$('localPngClearBtn')?.addEventListener('click', () => {
    useLocalModelStore.setState({ pngs: [] })
    useLocalModelStore.getState().saveToCache()
    renderLocalView()
  })

  $$('localPngDropZone')?.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.png'
    input.multiple = true
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files
      if (!files) return
      for (const f of Array.from(files)) {
        const png = await parsePngFile(f)
        if (png) useLocalModelStore.getState().addPng(png)
      }
      useLocalModelStore.getState().saveToCache()
      useLocalModelStore.getState().rebuildTagFreq()
      renderLocalView()
    }
    input.click()
  })

  $$('localPngDropZone')?.addEventListener('dragover', (e) => {
    e.preventDefault()
    $$('localPngDropZone')!.classList.add('drag-over')
  })

  $$('localPngDropZone')?.addEventListener('dragleave', () => {
    $$('localPngDropZone')!.classList.remove('drag-over')
  })

  $$('localPngDropZone')?.addEventListener('drop', async (e) => {
    e.preventDefault()
    $$('localPngDropZone')!.classList.remove('drag-over')
    const items = e.dataTransfer?.files
    if (!items) return
    for (const f of Array.from(items)) {
      if (!f.name.toLowerCase().endsWith('.png')) continue
      const png = await parsePngFile(f)
      if (png) useLocalModelStore.getState().addPng(png)
    }
    useLocalModelStore.getState().saveToCache()
    useLocalModelStore.getState().rebuildTagFreq()
    renderLocalView()
  })

  // 搜索防抖：每次按键全量重建文件树代价高，150ms 合并连续输入
  const debouncedLocalSearch = debounce(() => {
    const q = ($$('localSearch') as HTMLInputElement).value
    useLocalModelStore.getState().setSearchQuery(q)
    renderSidebarList(useLocalModelStore.getState())
  }, 150)
  $$('localSearch')?.addEventListener('input', debouncedLocalSearch)
  attachSearchClear($$('localSearch') as HTMLInputElement, () => {
    useLocalModelStore.getState().setSearchQuery('')
    renderSidebarList(useLocalModelStore.getState())
  })

  $$('localSort')?.addEventListener('change', () => {
    const v = ($$('localSort') as HTMLSelectElement).value as LocalSortKey
    useLocalModelStore.getState().setSortKey(v)
    renderSidebarList(useLocalModelStore.getState())
  })

  $$('localFilter')?.addEventListener('change', () => {
    const v = ($$('localFilter') as HTMLSelectElement).value as LocalFilterKey
    useLocalModelStore.getState().setFilterKey(v)
    renderSidebarList(useLocalModelStore.getState())
  })

  for (const id of ['localListViewBtn', 'localGridViewBtn']) {
    $$(id)?.addEventListener('click', () => {
      const mode = ($$(id) as HTMLElement).dataset.displayMode as LocalDisplayMode
      if (mode !== 'list' && mode !== 'grid') return
      useLocalModelStore.getState().setDisplayMode(mode)
      renderSidebarList(useLocalModelStore.getState())
    })
  }

  document.querySelectorAll('.local-view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const view = (tab as HTMLElement).dataset.view as LocalViewKey
      useLocalModelStore.getState().setCurrentView(view)
      document.querySelectorAll('.local-view-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      document.querySelectorAll('.local-page').forEach(p => p.classList.remove('active'))
      const target = $$('pageLocal' + view.charAt(0).toUpperCase() + view.slice(1))
      if (target) target.classList.add('active')
      if (view === 'home') renderHome(useLocalModelStore.getState())
      if (view === 'detail') renderDetail(useLocalModelStore.getState())
      if (view === 'gallery') renderGallery(useLocalModelStore.getState())
      if (view === 'prompt') renderPromptTab(useLocalModelStore.getState())
      if (view === 'models') renderModelsTab()
    })
  })

  $$('localBatchToggleBtn')?.addEventListener('click', () => {
    const s = useLocalModelStore.getState()
    s.setBatchMode(!s.batchMode)
    renderSidebarList(useLocalModelStore.getState())
  })

  const fileList = $$('localFileList')

  fileList?.addEventListener('dragstart', (e) => {
    const item = (e.target as HTMLElement).closest('.local-list-item') as HTMLElement
    if (item && item.dataset.name) {
      e.dataTransfer?.setData('text/plain', item.dataset.name)
      e.dataTransfer!.effectAllowed = 'move'
    }
  })

  fileList?.addEventListener('dragover', (e) => {
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header, .local-grid-cat-btn') as HTMLElement
    if (!header) return
    e.preventDefault()
    header.classList.add('drag-over')
  })

  fileList?.addEventListener('dragleave', (e) => {
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header, .local-grid-cat-btn') as HTMLElement
    if (header) header.classList.remove('drag-over')
  })

  fileList?.addEventListener('drop', (e) => {
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header, .local-grid-cat-btn') as HTMLElement
    if (!header) return
    header.classList.remove('drag-over')
    const cat = header.dataset.cat
    const fileName = e.dataTransfer?.getData('text/plain')
    if (!cat || !fileName || cat === '__uncategorized__') return
    const s = useLocalModelStore.getState()
    const existing = s.modelCategories[stripExt(fileName)] || []
    if (!existing.includes(cat)) {
      s.setModelCategories(fileName, [...existing, cat])
      s.saveToCache()
      renderSidebarList(s)
    }
  })

  const gridCategoryList = $$('localGridCategoryList')
  gridCategoryList?.addEventListener('dragover', (e) => {
    const button = (e.target as HTMLElement).closest('.local-grid-cat-btn') as HTMLElement
    if (!button || !button.dataset.cat) return
    e.preventDefault()
    button.classList.add('drag-over')
  })
  gridCategoryList?.addEventListener('dragleave', (e) => {
    const button = (e.target as HTMLElement).closest('.local-grid-cat-btn') as HTMLElement
    if (button) button.classList.remove('drag-over')
  })
  gridCategoryList?.addEventListener('drop', (e) => {
    const button = (e.target as HTMLElement).closest('.local-grid-cat-btn') as HTMLElement
    if (!button) return
    button.classList.remove('drag-over')
    const cat = button.dataset.cat
    const fileName = e.dataTransfer?.getData('text/plain')
    if (!cat || cat === '__uncategorized__' || !fileName) return
    const s = useLocalModelStore.getState()
    const existing = s.modelCategories[stripExt(fileName)] || []
    if (!existing.includes(cat)) {
      s.setModelCategories(fileName, [...existing, cat])
      s.saveToCache()
      renderSidebarList(s)
    }
  })

  fileList?.addEventListener('keydown', (e) => {
    // 在输入框中输入时不触发导航
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    const items = Array.from(fileList.querySelectorAll('.local-list-item'))
    if (items.length === 0) return

    const currentIdx = items.findIndex(item => item.classList.contains('active'))
    let nextIdx = currentIdx

    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault()
        nextIdx = currentIdx < items.length - 1 ? currentIdx + 1 : 0
        break
      case 'ArrowUp':
      case 'k':
        e.preventDefault()
        nextIdx = currentIdx > 0 ? currentIdx - 1 : items.length - 1
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (currentIdx >= 0) {
          const name = (items[currentIdx] as HTMLElement).dataset.name
          if (name) {
            const state = useLocalModelStore.getState()
            if (state.batchMode) {
              state.toggleBatchSelection(name)
              renderSidebarList(useLocalModelStore.getState())
            } else {
              state.selectModel(name)
              renderSidebarList(useLocalModelStore.getState())
              renderDetail(useLocalModelStore.getState())
              document.querySelectorAll('.local-view-tab').forEach(t => t.classList.remove('active'))
              document.querySelectorAll('.local-page').forEach(p => p.classList.remove('active'))
              const dt = document.querySelector('.local-view-tab[data-view="detail"]')
              if (dt) dt.classList.add('active')
              const dp = $$('pageLocalDetail')
              if (dp) dp.classList.add('active')
            }
          }
        }
        return
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        if (currentIdx >= 0) {
          const name = (items[currentIdx] as HTMLElement).dataset.name
          if (name) {
            const delBtn = items[currentIdx].querySelector('.local-list-del') as HTMLElement
            if (delBtn) delBtn.click()
          }
        }
        return
      case 'Escape':
        e.preventDefault()
        useLocalModelStore.getState().selectModel(null)
        renderSidebarList(useLocalModelStore.getState())
        renderDetail(useLocalModelStore.getState())
        return
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          const state = useLocalModelStore.getState()
          if (state.batchMode) {
            items.forEach(item => {
              const name = (item as HTMLElement).dataset.name
              if (name && !state.batchSelection.includes(name)) {
                state.toggleBatchSelection(name)
              }
            })
            renderSidebarList(state)
          }
        }
        return
      default:
        return
    }

    if (nextIdx !== currentIdx) {
      items.forEach((item, i) => {
        item.classList.toggle('active', i === nextIdx)
      })
      const name = (items[nextIdx] as HTMLElement).dataset.name
      if (name) {
        useLocalModelStore.getState().selectModel(name)
        renderDetail(useLocalModelStore.getState())
        document.querySelectorAll('.local-view-tab').forEach(t => t.classList.remove('active'))
        document.querySelectorAll('.local-page').forEach(p => p.classList.remove('active'))
        const dt = document.querySelector('.local-view-tab[data-view="detail"]')
        if (dt) dt.classList.add('active')
        const dp = $$('pageLocalDetail')
        if (dp) dp.classList.add('active')
      }
      items[nextIdx]?.scrollIntoView({ block: 'nearest' })
    }
  })

  fileList?.setAttribute('tabindex', '0')

  document.addEventListener('click', (e) => {
    const bd = $$('localBatchDropdown')
    if (bd && bd.style.display === 'block' && !(e.target as HTMLElement).closest('#localBatchDDWrap, #localBatchAssignBtn')) {
      bd.style.display = 'none'
    }
    const dd = $$('detailCatDropdown')
    if (dd && dd.style.display === 'block' && !(e.target as HTMLElement).closest('#detailCatDropdown, #detailCatAddBtn')) {
      dd.style.display = 'none'
    }
  })

  fileList?.addEventListener('dblclick', async (e) => {
    const nameEl = (e.target as HTMLElement).closest('.local-tree-cat-name') as HTMLElement
    if (!nameEl) return
    const header = nameEl.closest('.local-tree-cat-header') as HTMLElement
    if (!header) return
    const cat = header.dataset.cat
    if (!cat || cat === '__uncategorized__') return
    const newName = await promptModal('重命名分类', nameEl.textContent || '')
    if (!newName || !newName.trim() || newName.trim() === nameEl.textContent) return
    const s = useLocalModelStore.getState()
    if (s.categories.includes(newName.trim())) { showToast('⚠️ 分类名已存在'); return }
    s.renameCategory(cat, newName.trim())
    s.saveToCache()
    renderSidebarList(s)
  })

  $$('sectionLocal')?.addEventListener('change', (e) => {
    const ta = (e.target as HTMLElement).closest('.detail-desc-edit') as HTMLTextAreaElement
    if (ta) {
      const name = ta.dataset.name
      if (name) {
        useLocalModelStore.getState().setDescription(name, ta.value)
        useLocalModelStore.getState().saveToCache()
      }
      return
    }

    // Number input blur/Enter: save store, sync slider, update detail preview
    const numInput = (e.target as HTMLElement).closest('.prompt-lora-input, .detail-lora-input') as HTMLInputElement
    if (numInput) {
      const name = numInput.dataset.name
      const val = parseFloat(numInput.value)
      if (!name || isNaN(val)) return
      const clamped = Math.max(0, Math.min(2, val))
      numInput.value = clamped.toFixed(2)

      const row = numInput.closest('.prompt-lora-row, .detail-lora-builder')
      const slider = row?.querySelector('.prompt-lora-slider, .detail-lora-slider') as HTMLInputElement
      if (slider) slider.value = String(clamped)

      const s = useLocalModelStore.getState()
      s.setPromptWeights({ ...s.promptWeights, [name]: clamped })

      const detailBuilder = numInput.closest('.detail-lora-builder') as HTMLElement
      if (detailBuilder) {
        const previewEl = detailBuilder.querySelector('.detail-lora-preview code')
        if (previewEl) {
          const localBase = name.replace(/\.\w+$/, '')
          previewEl.textContent = `<lora:${localBase}:${clamped.toFixed(2)}>`
        }
        // Sync copy button data-w
        const copyBtn = detailBuilder.querySelector('.detail-lora-copy') as HTMLElement
        if (copyBtn) copyBtn.dataset.w = clamped.toFixed(2)
      }
      return
    }
  })

  // 滑块拖拽实时更新数字 + 详情页预览
  $$('sectionLocal')?.addEventListener('input', (e) => {
    const target = e.target as HTMLElement

    // Slider drag: sync number, save store, update detail preview
    const slider = target.closest('.prompt-lora-slider, .detail-lora-slider') as HTMLInputElement
    if (slider) {
      const val = parseFloat(slider.value)
      const name = slider.dataset.name
      if (!name) return
      const row = slider.closest('.prompt-lora-row, .detail-lora-builder')
      const numInput = row?.querySelector('.prompt-lora-input, .detail-lora-input') as HTMLInputElement
      if (numInput) numInput.value = val.toFixed(2)

      // Save store
      const s = useLocalModelStore.getState()
      s.setPromptWeights({ ...s.promptWeights, [name]: val })

      // Update detail page lora preview live (DOM only, no re-render)
      const detailBuilder = slider.closest('.detail-lora-builder') as HTMLElement
      if (detailBuilder) {
        const previewEl = detailBuilder.querySelector('.detail-lora-preview code')
        if (previewEl) {
          const localBase = name.replace(/\.\w+$/, '')
          previewEl.textContent = `<lora:${localBase}:${val.toFixed(2)}>`
        }
        // Sync copy button data-w
        const copyBtn = detailBuilder.querySelector('.detail-lora-copy') as HTMLElement
        if (copyBtn) copyBtn.dataset.w = val.toFixed(2)
      }
      return
    }

    // Number input typing: sync slider position (no store save, wait change)
    const numInput = target.closest('.prompt-lora-input, .detail-lora-input') as HTMLInputElement
    if (numInput) {
      const val = parseFloat(numInput.value)
      if (!isNaN(val)) {
        const clamped = Math.max(0, Math.min(2, val))
        const row = numInput.closest('.prompt-lora-row, .detail-lora-builder')
        const slider = row?.querySelector('.prompt-lora-slider, .detail-lora-slider') as HTMLInputElement
        if (slider) slider.value = String(clamped)
      }
    }
  })

  $$('sectionLocal')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement

    const proxyAction = target.closest('[data-local-action]') as HTMLElement
    if (proxyAction) {
      const targetId = proxyAction.dataset.localAction
      if (targetId) document.getElementById(targetId)?.click()
      return
    }

    const chk = target.closest('.local-list-chk') as HTMLInputElement
    if (chk) {
      const name = chk.dataset.name
      if (name) useLocalModelStore.getState().toggleBatchSelection(name)
      renderSidebarList(useLocalModelStore.getState())
      return
    }

    const delCatBtn = target.closest('.local-cat-del-btn') as HTMLElement
    if (delCatBtn) {
      const cat = delCatBtn.dataset.cat
      if (cat && await confirmModal('删除分类', `确认删除分类「${cat}」？\n已归入该分类的 LoRA 不会被删除，仅移除分类标记。`)) {
        useLocalModelStore.getState().removeCategory(cat)
        useLocalModelStore.getState().saveToCache()
        renderSidebarList(useLocalModelStore.getState())
      }
      return
    }

    const renameBtn = target.closest('.local-cat-rename-btn') as HTMLElement
    if (renameBtn) {
      const cat = renameBtn.dataset.cat
      if (!cat) return
      const s = useLocalModelStore.getState()
      const newName = await promptModal('重命名分类', cat)
      if (!newName || !newName.trim() || newName.trim() === cat) return
      if (s.categories.includes(newName.trim())) { showToast('⚠️ 分类名已存在'); return }
      s.renameCategory(cat, newName.trim())
      s.saveToCache()
      renderSidebarList(s)
      return
    }

    const catHeader = target.closest('.local-tree-cat-header') as HTMLElement
    if (catHeader && !target.closest('.local-new-cat-btn') && !target.closest('.local-cat-del-btn') && !target.closest('.local-cat-rename-btn')) {
      const cat = catHeader.dataset.cat
      if (cat) {
        useLocalModelStore.getState().toggleCategoryExpanded(cat)
        renderSidebarList(useLocalModelStore.getState())
      }
      return
    }

    const newCatBtn = target.closest('.local-new-cat-btn') as HTMLElement
    if (newCatBtn) {
      const cat = await promptModal('新建分类')
      if (!cat || !cat.trim()) return
      const s = useLocalModelStore.getState()
      if (s.categories.includes(cat.trim())) { showToast('⚠️ 分类已存在'); return }
      s.addCategory(cat.trim())
      s.saveToCache()
      renderSidebarList(s)
      return
    }

    const gridCatBtn = target.closest('.local-grid-cat-btn') as HTMLElement
    if (gridCatBtn) {
      const cat = gridCatBtn.dataset.cat || null
      useLocalModelStore.getState().setFilterCategory(cat)
      renderSidebarList(useLocalModelStore.getState())
      return
    }

    const previewUploadBtn = target.closest('.local-preview-upload') as HTMLElement
    if (previewUploadBtn) {
      const name = previewUploadBtn.dataset.name
      if (name) openLocalPreviewPicker(name)
      return
    }

    const openModelBtn = target.closest('.local-open-model') as HTMLElement
    if (openModelBtn) {
      const url = openModelBtn.dataset.url
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
      return
    }

    const previewUrlBtn = target.closest('.local-preview-url') as HTMLElement
    if (previewUrlBtn) {
      const name = previewUrlBtn.dataset.name
      if (name) await setLocalPreviewFromUrl(name)
      return
    }

    const previewResetBtn = target.closest('.local-preview-reset') as HTMLElement
    if (previewResetBtn) {
      const name = previewResetBtn.dataset.name
      if (name) await resetLocalPreview(name)
      return
    }

    const delBtn = target.closest('.local-list-del, .detail-del-btn') as HTMLElement
    if (delBtn) {
      const name = delBtn.dataset.name
      if (name && await confirmModal('删除文件', `确认从磁盘删除「${name}」？\n此操作不可撤销！`)) {
        await useLocalModelStore.getState().deleteFile(name)
        const state = useLocalModelStore.getState()
        if (state.selectedModel === name) state.selectModel(null)
        renderLocalView()
      }
      return
    }

    // C 站预览图点击放大：列表缩略图（先于选中详情处理，避免点图同时跳详情）
    const listThumb = target.closest('.local-list-thumb, .local-grid-preview') as HTMLElement
    if (listThumb) {
      const item = listThumb.closest('.local-list-item') as HTMLElement
      const name = item?.dataset.name
      const state = useLocalModelStore.getState()
      if (state.batchMode && name) {
        state.toggleBatchSelection(name)
        renderSidebarList(useLocalModelStore.getState())
        return
      }
      const f = name ? useLocalModelStore.getState().files.find(ff => ff.name === name) : undefined
      const imgs = f ? localPreviewSources(f, state) : []
      if (imgs.length) openLightbox(imgs.map((u, i) => i === 0 && state.previewImages[f!.name] ? u : thumbUrl(u, 800)), 0)
      return
    }
    // C 站预览图点击放大：详情页大图 / 画廊缩略图
    const heroImg = target.closest('.detail-hero-img') as HTMLElement
    if (heroImg) {
      const st = useLocalModelStore.getState()
      const f = st.files.find(x => x.name === st.selectedModel)
      const imgs = f ? localPreviewSources(f, st) : []
      if (imgs.length) openLightbox(imgs.map((u, i) => i === 0 && st.previewImages[f!.name] ? u : thumbUrl(u, 800)), 0)
      return
    }
    const galleryImg = target.closest('.detail-gallery-thumb') as HTMLElement
    if (galleryImg) {
      const st = useLocalModelStore.getState()
      const f = st.files.find(x => x.name === st.selectedModel)
      const imgs = f ? localPreviewSources(f, st) : []
      if (imgs.length) {
        // gallery 渲染 images.slice(1,6)：容器内第 i 个子元素对应 images[i+1]
        const gal = galleryImg.parentElement
        const idx = gal ? Array.from(gal.children).indexOf(galleryImg) + 1 : 1
        openLightbox(imgs.map((u, i) => i === 0 && st.previewImages[f!.name] ? u : thumbUrl(u, 800)), Math.min(idx, imgs.length - 1))
      }
      return
    }

    const listItem = target.closest('.local-list-item') as HTMLElement
    if (listItem) {
      const name = listItem.dataset.name
      if (name) {
        const state = useLocalModelStore.getState()
        // 批量模式下点击整张卡片就是选择动作，不能进入详情流程，更不能把网格强制切成列表。
        // 复选框仍由上方的 .local-list-chk 分支处理；这里覆盖卡片图片、标题和空白区域。
        if (state.batchMode) {
          state.toggleBatchSelection(name)
          renderSidebarList(useLocalModelStore.getState())
          return
        }
        if (state.displayMode === 'grid') state.setDisplayMode('list')
        useLocalModelStore.getState().selectModel(name)
        renderSidebarList(useLocalModelStore.getState())
        renderDetail(useLocalModelStore.getState())
        document.querySelectorAll('.local-view-tab').forEach(t => t.classList.remove('active'))
        document.querySelectorAll('.local-page').forEach(p => p.classList.remove('active'))
        const dt = document.querySelector('.local-view-tab[data-view="detail"]')
        if (dt) dt.classList.add('active')
        const dp = $$('pageLocalDetail')
        if (dp) dp.classList.add('active')
      }
      return
    }

    const matchBtn = target.closest('.detail-match-btn') as HTMLElement
    if (matchBtn) {
      const name = matchBtn.dataset.name
      if (!name) return
      await useLocalModelStore.getState().matchOne(name)
      renderLocalView()
      return
    }

    const copyEl = target.closest('[data-copy]') as HTMLElement
    if (copyEl) {
      copyText(copyEl.dataset.copy || '', copyEl)
      return
    }

    const openUrl = target.closest('.detail-open-url') as HTMLElement
    if (openUrl) {
      const id = openUrl.dataset.id
      if (id) window.open(`https://civitai.com/models/${id}`, '_blank')
      return
    }

    // Send single LoRA to ComfyUI from detail page
    const sendComfy = target.closest('.detail-send-comfy') as HTMLElement
    if (sendComfy) {
      const name = sendComfy.dataset.name
      if (!name) return
      const f = useLocalModelStore.getState().files.find(ff => ff.name === name)
      if (!f) { showToast('⚠️ LoRA 未找到'); return }
      const loraName = f.name.replace(/\.\w+$/, '')
      const w = useLocalModelStore.getState().promptWeights?.[f.name] ?? 1.0
      const bridgeData = {
        loras: `<lora:${loraName}:${w.toFixed(2)}>`,
        lora_list: [{ name: loraName, model_strength: parseFloat(w.toFixed(2)), trigger_words: f.matchData?.trainedWords || [] }],
        updatedAt: Date.now(),
      }
      try {
        const csrf = document.cookie.replace(/(?:(?:^|.*;\s*)csrftoken\s*=\s*([^;]*).*$)|^.*$/, "$1")
        const resp = await fetch('/anima/bridge/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify(bridgeData),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        showToast('✅ 已发送到 ComfyUI')
      } catch (e: any) {
        showToast('❌ 发送失败: ' + e.message + '，请确认 ComfyUI 已重启')
      }
      return
    }

    if (target.id === 'localBatchClearBtn') {
      useLocalModelStore.getState().clearBatchSelection()
      renderSidebarList(useLocalModelStore.getState())
      return
    }

    if (target.id === 'localBatchAssignBtn') {
      const dd = $$('localBatchDropdown')
      if (!dd) return
      const cats = useLocalModelStore.getState().categories
      dd.innerHTML = cats.map(c => `<div class="td-opt" data-cat="${escAttr(c)}">${esc(c)}</div>`).join('')
      dd.style.display = dd.style.display === 'block' ? 'none' : 'block'
      return
    }

    const batchOpt = target.closest('#localBatchDropdown .td-opt') as HTMLElement
    if (batchOpt) {
      const cat = batchOpt.dataset.cat
      if (!cat) return
      const s = useLocalModelStore.getState()
      s.setBatchModelCategories(s.batchSelection, cat)
      s.saveToCache()
      s.clearBatchSelection()
      $$('localBatchDropdown')!.style.display = 'none'
      renderLocalView()
      return
    }

    if (target.id === 'detailCatAddBtn') {
      const dd = $$('detailCatDropdown')
      if (!dd) return
      const s = useLocalModelStore.getState()
      const fname = s.selectedModel
      if (!fname) return
      const existing = s.modelCategories[stripExt(fname)] || []
      const available = s.categories.filter(c => !existing.includes(c))
      dd.innerHTML = available.length
        ? available.map(c => `<div class="td-opt" data-cat="${escAttr(c)}">${esc(c)}</div>`).join('')
        : '<div class="td-opt dropdown-empty">无更多分类</div>'
      dd.style.display = dd.style.display === 'block' ? 'none' : 'block'
      return
    }

    const detailCatSel = target.closest('#detailCatDropdown .td-opt') as HTMLElement
    if (detailCatSel) {
      const cat = detailCatSel.dataset.cat
      if (!cat) return
      const s = useLocalModelStore.getState()
      const fname = s.selectedModel
      if (fname) {
        const existing = s.modelCategories[stripExt(fname)] || []
        s.setModelCategories(fname, [...existing, cat])
        s.saveToCache()
      }
      $$('detailCatDropdown')!.style.display = 'none'
      renderDetail(useLocalModelStore.getState())
      return
    }

    const catRm = target.closest('.detail-cat-rm') as HTMLElement
    if (catRm) {
      const fname = catRm.dataset.name
      const cat = catRm.dataset.cat
      if (fname && cat) {
        const s = useLocalModelStore.getState()
        const existing = s.modelCategories[stripExt(fname)] || []
        s.setModelCategories(fname, existing.filter((c: string) => c !== cat))
        s.saveToCache()
        renderDetail(s)
      }
      return
    }

    if (target.id === 'manualMatchBtn') {
      const name = (target as HTMLElement).dataset.name
      const url = ($$('manualMatchUrl') as HTMLInputElement)?.value
      if (!name || !url) return
      await useLocalModelStore.getState().matchByUrl(name, url.trim())
      renderLocalView()
      return
    }

    if (target.id === 'promptCopyAllBtn') {
      const state = useLocalModelStore.getState()
      const pw = state.promptWeights || {}
      const tags = state.files
        .filter(f => f.matched || state.modelCategories[stripExt(f.name)])
        .map(f => {
          const name = f.name.replace(/\.\w+$/, '')
          const w = pw[f.name] ?? 1.0
          return `<lora:${name}:${w.toFixed(2)}>`
        })
        .join(' ')
      copyText(tags)
      return
    }

    if (target.id === 'promptSendComfyBtn') {
      const state = useLocalModelStore.getState()
      const pw = state.promptWeights || {}
      const loraList = state.files
        .filter(f => f.matched || state.modelCategories[stripExt(f.name)])
        .map(f => {
          const name = f.name.replace(/\.\w+$/, '')
          const w = pw[f.name] ?? 1.0
          return {
            name,
            model_strength: parseFloat(w.toFixed(2)),
            trigger_words: f.matchData?.trainedWords || [],
          }
        })
      if (!loraList.length) { showToast('⚠️ 没有可用的 LoRA'); return }
      const bridgeData = {
        loras: loraList.map(l => `<lora:${l.name}:${l.model_strength}>`).join(' '),
        lora_list: loraList,
        updatedAt: Date.now(),
      }
      // Send via HTTP API (no File System Access required, works in all browsers)
      try {
        const csrf = document.cookie.replace(/(?:(?:^|.*;\s*)csrftoken\s*=\s*([^;]*).*$)|^.*$/, "$1")
        const resp = await fetch('/anima/bridge/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify(bridgeData),
        })
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}))
          throw new Error(err.error || `HTTP ${resp.status}`)
        }
        showToast('✅ 已发送到 ComfyUI（HTTP 桥接）')
      } catch (e: any) {
        console.error('[Anima] Bridge send failed:', e)
        if (e.name === 'TypeError' && e.message.includes('fetch')) {
          showToast('⚠️ 无法连接 ComfyUI，请确认 ComfyUI 正在运行')
        } else {
          showToast(`❌ 发送失败: ${e.message}，请确认 ComfyUI 已重启`)
        }
      }
      return
    }

    // Click related output → switch to Outputs tab
    const outputItem = target.closest('.detail-output-item') as HTMLElement
    if (outputItem) {
      const id = outputItem.dataset.id
      if (id) {
        // Switch to outputs tab
        const outputsTab = document.querySelector('.main-tab[data-section="outputs"]') as HTMLElement
        if (outputsTab) outputsTab.click()
        // Focus the image after a short delay
        setTimeout(() => {
          const card = document.querySelector(`.outputs-card[data-id="${escAttr(id)}"]`) as HTMLElement
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' })
            card.classList.add('highlight-flash')
            setTimeout(() => card.classList.remove('highlight-flash'), 2000)
          }
        }, 300)
      }
      return
    }

    const copyLora = target.closest('.prompt-lora-copy, .detail-lora-copy') as HTMLElement
    if (copyLora) {
      const tag = copyLora.dataset.tag
      const w = copyLora.dataset.w
      if (tag) {
        copyText(`<lora:${tag}:${w}>`)
        showToast('✅ 已复制')
      }
      return
    }
  })
}

const MAX_PNG_SIZE = 20 * 1024 * 1024 // 20MB 上限，防超大文件放大解压炸弹（security MEDIUM 修复）

function parsePngFile(file: File): Promise<PngMeta | null> {
  // 文件大小检查：超大文件直接拒绝，避免 readAsArrayBuffer 全量读入放大攻击面
  if (file.size > MAX_PNG_SIZE) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = async () => {
      const buf = reader.result as ArrayBuffer
      const meta = await parsePngMetadata(buf)
      if (meta) {
        resolve({
          fileName: file.name,
          fileSize: file.size,
          ...meta,
        })
      } else {
        resolve(null)
      }
    }
    reader.onerror = () => resolve(null)
    reader.readAsArrayBuffer(file)
  })
}

async function parsePngMetadata(buf: ArrayBuffer): Promise<Omit<PngMeta, 'fileName' | 'fileSize'> | null> {
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== pngSig[i]) return null
  }

  const raw: Record<string, string> = {}
  let offset = 8
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) break
    const len = view.getUint32(offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])

    const isText = type === 'tEXt' || type === 'zTXt' || type === 'iTXt'
    if (isText) {
      const dataStart = offset + 8
      const dataEnd = dataStart + len
      if (dataEnd > bytes.length) break

      let keyEnd = dataStart
      while (keyEnd < dataEnd && bytes[keyEnd] !== 0 && keyEnd - dataStart < 79) keyEnd++
      // key 按 PNG 规范 ≤79 字节截断，循环拼接避免超大 spread 抛 RangeError 挂死（security HIGH/MEDIUM 修复）
      let key = ''
      for (let i = dataStart; i < keyEnd; i++) key += String.fromCharCode(bytes[i])

      let val: string
      if (type === 'zTXt') {
        try {
          const compData = bytes.slice(keyEnd + 2, dataEnd)
          // 复用 outputMetadata 的 DecompressionStream 解压(项目无 pako 依赖,原实现必失败输出乱码)
          val = await decompressZlibAsync(compData)
        } catch {
          val = new TextDecoder().decode(bytes.slice(keyEnd + 1, dataEnd))
        }
      } else {
        val = new TextDecoder().decode(bytes.slice(keyEnd + 1, dataEnd))
      }
      raw[key] = val
    }
    offset += 12 + len
  }

  const prompt = raw['prompt'] || raw['parameters'] || raw['user_comment'] || raw['Description'] || ''
  const params = raw['parameters'] || ''

  let positive = prompt
  let negative = ''
  const loras: string[] = []

  if (params) {
    const parts = params.split('\n')
    const posParts: string[] = []
    let inNeg = false
    for (const line of parts) {
      if (line.startsWith('Negative prompt:')) {
        inNeg = true
        posParts.push(line.replace('Negative prompt:', '').trim())
        continue
      }
      if (inNeg) {
        const negMatch = line.match(/^Negative prompt:\s*(.+)/i)
        if (negMatch) {
          negative += line.replace(/^Negative prompt:\s*/i, '').trim() + ' '
        } else if (/^Steps:|^Sampler:|^CFG scale:|^Seed:|^Model:|^Size:|^Model hash:|^Hashes:/.test(line)) {
          break
        } else {
          negative += line.trim() + ' '
        }
      } else {
        posParts.push(line)
      }
    }
    positive = posParts.join('\n').trim()

    const paramLines = params.split('\n')
    for (const line of paramLines) {
      if (/^Negative prompt:/i.test(line)) {
        const negText = line.replace(/^Negative prompt:\s*/i, '').trim()
        if (negText && negText !== positive) negative = negText
      }
    }

    const loraMatch = positive.match(/<lora:([^:>]+)/g)
    if (loraMatch) loras.push(...loraMatch.map((l: string) => l.replace('<lora:', '')))
  }

  const loraMatch2 = positive.match(/<lora:([^:>]+)/g)
  if (loraMatch2) loras.push(...loraMatch2.map((l: string) => l.replace('<lora:', '')))

  function extractParam(line: string): string {
    for (const l of params.split('\n')) {
      if (l.startsWith(line)) {
        return l.replace(line, '').trim()
      }
    }
    return ''
  }

  const negativeRaw = extractParam('Negative prompt:')

  return {
    positive: positive || prompt,
    negative: negative || raw['negative_prompt'] || negativeRaw,
    seed: raw['seed'] || extractParam('Seed:'),
    steps: raw['steps'] || extractParam('Steps:'),
    cfg: raw['cfg'] || extractParam('CFG scale:'),
    sampler: raw['sampler'] || extractParam('Sampler:'),
    model: raw['model'] || extractParam('Model:'),
    loras: [...new Set(loras)],
    raw,
  }
}

function extractTagsFromPrompt(prompt: string): string[] {
  const tags = prompt.split(/[,，、\n]+/).map(t => t.trim()).filter(Boolean)
  const seen = new Set<string>()
  const result: string[] = []
  for (const t of tags) {
    const clean = t.replace(/^\(|\):\d+(\.\d+)?|\)$/g, '').trim().toLowerCase()
    if (clean && !seen.has(clean) && clean.length > 1) {
      seen.add(clean)
      result.push(clean)
    }
  }
  return result
}

function fmtSize(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB'
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
