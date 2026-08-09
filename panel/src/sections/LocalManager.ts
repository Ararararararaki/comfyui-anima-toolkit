import { useLocalModelStore } from '../store/localModels'
import type { LocalSortKey, LocalFilterKey, LocalViewKey } from '../store/localModels'
import { esc, escAttr, copyText, showToast, fmtNum, thumbUrl, debounce, stripExt } from '../utils'
import { openLightbox } from '../components/Lightbox'
import type { PngMeta, LocalLoraFile, TagFreq } from '../types'
import type { OutputMetadata } from '../types/outputs'
import { promptModal, confirmModal } from '../components/Modal'
import { openContextMenu } from '../components/ContextMenu'
import { refreshLocalNames } from '../components/ModelCard'
import { useOutputStore } from '../store/outputStore'
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
function openLoraContextMenu(e: MouseEvent, name: string) {
  const s = useLocalModelStore.getState()
  const catActions = (existing: string[], apply: (cat: string) => void) => [
    ...s.categories.map(cat => ({
      label: existing.includes(cat) ? `☑ ${cat}` : `☐ ${cat}`,
      handler: () => apply(cat),
    })),
    {
      label: '➕ 新建分类…', icon: '',
      handler: async () => {
        const n = (await promptModal('新建分类'))?.trim()
        if (!n) return
        if (s.categories.includes(n)) { showToast('分类已存在'); return }
        s.addCategory(n)
        apply(n)
        s.saveToCache()
        renderLocalView()
      },
    },
  ]

  // 拖拽多选优先：右键在选中项上 → 批量添加分类
  if (_dragSelected.size > 1 && _dragSelected.has(name)) {
    const names = [..._dragSelected]
    openContextMenu(e.clientX, e.clientY, [
      {
        label: `已选 ${names.length} 个 LoRA`,
        items: [{
          label: '添加到分类', icon: '🏷️', handler: () => {},
          children: catActions([], (cat) => {
            s.setBatchModelCategories(names, cat)
            s.saveToCache()
            _dragSelected.clear()
            clearDragHighlight()
            renderLocalView()
            showToast(`✅ ${names.length} 个已添加到「${cat}」`)
          }),
        }],
      },
    ])
    return
  }

  // 单个 LoRA：分类勾选/取消
  const existing = s.modelCategories[stripExt(name)] || []
  openContextMenu(e.clientX, e.clientY, [
    {
      label: name.replace(/\.\w+$/, ''),
      items: [{
        label: '分类', icon: '🏷️', handler: () => {},
        children: catActions(existing, (cat) => {
          const cur = s.modelCategories[stripExt(name)] || []
          const next = cur.includes(cat) ? cur.filter(c => c !== cat) : [...cur, cat]
          s.setModelCategories(name, next)
          s.saveToCache()
          renderLocalView()
        }),
      }],
    },
  ])
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
    rectEl.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;z-index:99999;background:rgba(99,102,241,0.12);border:2px dashed rgba(99,102,241,0.6);pointer-events:none;border-radius:4px`
    document.body.appendChild(rectEl)
  }, true)

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging || !rectEl) return
    const l = Math.min(startX, e.pageX), t = Math.min(startY, e.pageY)
    const r = Math.max(startX, e.pageX), b = Math.max(startY, e.pageY)
    const sx = window.scrollX, sy = window.scrollY
    rectEl.style.cssText = `position:fixed;left:${l - sx}px;top:${t - sy}px;width:${r - l}px;height:${b - t}px;z-index:99999;background:rgba(99,102,241,0.12);border:2px dashed rgba(99,102,241,0.6);pointer-events:none;border-radius:4px`
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
  _initDone = true
  // 与节点 /anima/meta 双向分类同步：启动时拉取后端分类合并到本地
  useLocalModelStore.getState().loadBackendMeta().then(() => {
    renderSidebarList(useLocalModelStore.getState())
  })
}

export async function activateLocalManager() {
  if (!_initDone) return
  // 激活栏目时拉取后端分类合并(节点侧改的分类同步回面板,无需刷新页面)
  useLocalModelStore.getState().loadBackendMeta().then(() => {
    renderSidebarList(useLocalModelStore.getState())
  })
  const store = useLocalModelStore.getState()
  if (store.dirHandle) return
  const hasCache = store.files.length > 0
  if (hasCache) {
    const restored = await store.loadDirHandle()
    if (restored) {
      const newCount = await store.detectNewFiles()
      if (newCount > 0) {
        store.setNewFileCount(newCount)
        showToast(`📁 发现 ${newCount} 个新 LoRA 文件，点击扫描增量更新`)
      } else {
        showToast('🔄 已恢复上次扫描会话')
      }
    } else {
      showToast('🔄 已恢复缓存数据')
    }
  }
}

function $$(s: string): HTMLElement | null {
  return document.getElementById(s)
}

export function renderLocalView() {
  const state = useLocalModelStore.getState()
  renderSidebarList(state)
  renderHome(state)
  renderDetail(state)
  updateStats(state)
}

function renderFileItem(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string {
  const isSel = f.name === state.selectedModel
  const thumb = f.matchData?.images?.[0]
    ? `<img src="${esc(thumbUrl(f.matchData.images[0], 120))}" class="local-list-thumb" loading="lazy" onerror="this.style.display='none'" onload="this.style.display=''">`
    : '<div class="local-list-thumb local-list-thumb-placeholder"></div>'
  const badge = f.scanning
    ? '<span class="local-list-badge scanning">⏳</span>'
    : f.matched
    ? '<span class="local-list-badge matched">✓</span>'
    : f.matchError
    ? '<span class="local-list-badge error">✗</span>'
    : ''
  const label = f.matchData?.modelName || f.name
  const localSuffix = f.matchData?.modelName ? `<span class="local-list-localname">${esc(f.name.replace(/\.\w+$/, ''))}</span>` : ''
  const creator = f.matchData?.creator || fmtSize(f.size)
  const versionSuffix = f.matchData?.versionName ? ` <span style="color:var(--text2)">· v${esc(f.matchData.versionName)}</span>` : ''
  const query = state.searchQuery || ''
  const chk = state.batchMode
    ? `<input type="checkbox" class="local-list-chk" data-name="${escAttr(f.name)}" ${state.batchSelection.includes(f.name) ? 'checked' : ''}>`
    : ''
  return `<div class="local-list-item ${isSel ? 'active' : ''}" data-name="${escAttr(f.name)}" draggable="true">
    ${chk}
    ${thumb}
    <div class="local-list-info">
      <div class="local-list-name">${highlightText(label, query)}${localSuffix}</div>
      <div class="local-list-meta">${f.matchData ? highlightText(creator, query) : creator}${versionSuffix}</div>
    </div>
    <div class="local-list-actions">
      ${badge}
      <button class="local-list-del" data-name="${escAttr(f.name)}" title="从磁盘删除">🗑️</button>
    </div>
  </div>`
}

function renderSidebarList(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('localFileList')
  if (!el) return

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

  switch (state.sortKey) {
    case 'name': files.sort((a, b) => a.name.localeCompare(b.name)); break
    case 'size': files.sort((a, b) => b.size - a.size); break
    case 'date': files.sort((a, b) => b.lastModified - a.lastModified); break
    case 'match': files.sort((a, b) => (a.matched === b.matched ? 0 : a.matched ? -1 : 1)); break
  }

  if (files.length === 0) {
    el.innerHTML = '<div class="empty-state empty-state-wide"><div class="big">📭</div><p class="empty-state-text">没有匹配的文件</p></div>'
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
    const assigned = mc[f.name] || []
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
        <button class="local-cat-rename-btn" data-cat="${escAttr(cat)}" title="重命名">✏️</button>
        <button class="local-cat-del-btn" data-cat="${escAttr(cat)}" title="删除分类">✕</button>
        <button class="local-new-cat-btn" title="新建分类">➕</button>
      </div>
      <div class="local-tree-cat-items ${isExpanded ? '' : 'collapsed'}">
        ${catFiles.map(f => renderFileItem(f, state)).join('')}
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
        ${uncatFiles.map(f => renderFileItem(f, state)).join('')}
      </div>
    </div>`
  }

  html += '</div>'
  el.innerHTML = html
  updateBatchBar(state)
}

function updateBatchBar(state: ReturnType<typeof useLocalModelStore.getState>) {
  const bar = $$('localBatchBar')
  const count = $$('localBatchCount')
  if (!bar || !count) return
  if (!state.batchMode || state.batchSelection.length === 0) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'flex'
  count.textContent = `已选 ${state.batchSelection.length} 项`
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
      <button class="btn btn-ghost prompt-lora-copy btn-xs" data-tag="${esc(name)}" data-w="${w}">📋</button>
    </div>`
  }).join('')
  el.innerHTML = lines + `
    <div class="prompt-lora-toolbar">
      <button class="btn btn-ghost btn-sm" id="promptCopyAllBtn">📋 复制全部</button>
      <button class="btn btn-ghost btn-sm" id="promptSendComfyBtn">📤 发送到 ComfyUI</button>
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
  const loraUsage = new Map<string, number>()  // lora_name → count
  const coocMap = new Map<string, Map<string, number>>()  // loraA → { loraB → count }

  // Also collect which loras are in our local files for cross-ref
  const localLoraNames = new Set(state.files.map(f => f.name.replace(/\.\w+$/, '').toLowerCase()))

  // Track how many outputs reference each local lora
  let outputWithLocalLora = 0
  const recentOutputs: { id: string; loras: string[]; mtime: number }[] = []

  for (const meta of outputState.metadataCache.values()) {
    if (!meta.workflowJson) continue
    const loras = extractLorasFromWorkflow(meta.workflowJson, meta.rawMetadata)
    if (loras.length === 0) continue

    // Check if any lora is local
    const hasLocal = loras.some(l => localLoraNames.has(l.toLowerCase()))
    if (!hasLocal) continue

    outputWithLocalLora++
    // Build global co-occurrence from ALL extracted loras (not just local)
    for (let i = 0; i < loras.length; i++) {
      const a = loras[i]
      loraUsage.set(a, (loraUsage.get(a) || 0) + 1)
      for (let j = i + 1; j < loras.length; j++) {
        const b = loras[j]
        if (!coocMap.has(a)) coocMap.set(a, new Map())
        coocMap.get(a)!.set(b, (coocMap.get(a)!.get(b) || 0) + 1)
        if (!coocMap.has(b)) coocMap.set(b, new Map())
        coocMap.get(b)!.set(a, (coocMap.get(b)!.get(a) || 0) + 1)
      }
    }
  }

  // Sort loras by usage
  const sortedLoras = [...loraUsage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)

  let html = `
    <div class="local-home-summary">
      <div class="local-stat-card"><div class="local-stat-num">${totalFiles}</div><div class="local-stat-label">LoRA 总数</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${matchedFiles}</div><div class="local-stat-label">已匹配</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${outputTotal}</div><div class="local-stat-label">Outputs 总数</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${outputWithLocalLora}</div><div class="local-stat-label">关联 LoRA</div></div>
    </div>`

  // Top loras section
  if (sortedLoras.length > 0) {
    html += `<div class="local-section"><h4>🏆 最常用 LoRA</h4><div class="local-top-loras">`
    for (const [name, count] of sortedLoras) {
      const file = state.files.find(f => f.name.replace(/\.\w+$/, '').toLowerCase() === name.toLowerCase())
      const label = file?.matchData?.modelName || name
      const matched = file?.matched ? 'matched' : ''
      html += `<div class="local-top-lora-item ${matched}" data-lora="${escAttr(name)}">
        <span class="local-top-lora-name">${esc(label)}</span>
        <span class="local-top-lora-count">${count} 次</span>
      </div>`
    }
    html += `</div></div>`
  }

  // Common combinations
  if (sortedLoras.length > 0) {
    html += `<div class="local-section"><h4>🔗 常搭配组合</h4><div class="local-combos">`
    for (const [name,] of sortedLoras.slice(0, 5)) {
      const cooc = coocMap.get(name)
      if (!cooc) continue
      const partners = [...cooc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      if (partners.length === 0) continue
      const total = loraUsage.get(name) || 1
      html += `<div class="local-combo-row" data-lora="${escAttr(name)}">
        <span class="local-combo-main">${esc(name)}</span>
        <span class="local-combo-with">搭配:</span>
        ${partners.map(([pName, pCount]) =>
          `<span class="local-combo-chip">${esc(pName)} <small>${Math.round(pCount / total * 100)}%</small></span>`
        ).join('')}
      </div>`
    }
    html += `</div></div>`
  }

  if (!outputWithLocalLora) {
    html += `<div class="empty-state"><div class="big">📊</div><p>暂无使用数据，扫描 Outputs 目录后自动生成</p></div>`
  }

  el.innerHTML = html

  // Bind click: click lora item → switch to detail
  el.querySelectorAll('.local-top-lora-item').forEach(item => {
    item.addEventListener('click', () => {
      const name = (item as HTMLElement).dataset.lora
      if (!name) return
      // Find the file by name
      const f = state.files.find(ff => ff.name.replace(/\.\w+$/, '').toLowerCase() === name.toLowerCase())
      if (f) {
        useLocalModelStore.getState().selectModel(f.name)
        renderSidebarList(useLocalModelStore.getState())
        renderDetail(useLocalModelStore.getState())
        document.querySelectorAll('.local-view-tab').forEach(t => t.classList.remove('active'))
        document.querySelectorAll('.local-page').forEach(p => p.classList.remove('active'))
        const dt = document.querySelector('.local-view-tab[data-view="detail"]')
        if (dt) dt.classList.add('active')
        const dp = $$('pageLocalDetail')
        if (dp) dp.classList.add('active')
      }
    })
  })
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
  const imgHtml = d?.images?.[0]
    ? `<img src="${esc(thumbUrl(d.images[0], 400))}" class="detail-hero-img" loading="lazy" onerror="this.style.display='none'">`
    : '<div class="detail-no-img">📦</div>'

  const statusBadge = f.scanning
    ? '<span class="local-badge scanning">⏳ 匹配中…</span>'
    : f.matched
    ? '<span class="local-badge matched">✅ 已匹配</span>'
    : f.matchError
    ? `<span class="local-badge error">❌ ${esc(f.matchError)}</span>`
    : '<span class="local-badge idle">⏸ 未匹配</span>'

  const actionBtn = !f.matched && !f.scanning
    ? `<button class="btn btn-ghost detail-match-btn btn-md" data-name="${escAttr(f.name)}">🔍 匹配</button>`
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
        <button class="btn btn-ghost btn-sm detail-lora-copy" data-tag="${esc(localBase)}" data-w="${loraWeight.toFixed(2)}">📋 复制</button>
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

  const html = `<div class="detail-hero">${imgHtml}</div>
    <div class="detail-actions">
      ${statusBadge}
      <span class="detail-name">${esc(d?.modelName || f.name)}</span>
      <span class="detail-sep">|</span>
      <span class="detail-creator">${esc(d?.creator || '')}</span>
      <div class="detail-actions-right">
        ${d ? `<button class="btn btn-ghost detail-open-url btn-sm" data-id="${d.modelId}">🌐 Civitai</button>` : ''}
        ${actionBtn}
        <button class="btn btn-ghost btn-sm detail-send-comfy" data-name="${escAttr(f.name)}">📤 ComfyUI</button>
        <button class="btn btn-ghost detail-del-btn btn-sm btn-red">🗑️ 删除文件</button>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-body-left">
        ${d?.images?.length ? `<div class="detail-section"><h4>图片预览</h4><div class="detail-gallery">${d.images.slice(1, 6).map(im => `<img src="${esc(thumbUrl(im, 200))}" class="detail-gallery-thumb" loading="lazy" onerror="this.style.display='none'">`).join('')}</div></div>` : ''}
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
    if (!meta.workflowJson) continue
    const loras = extractLorasFromWorkflow(meta.workflowJson, meta.rawMetadata)
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
    el.innerHTML = '<div class="empty-state"><div class="big">🖼️</div><p>尚未添加 PNG 图片，点击上方区域选择或拖入图片</p></div>'
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
    el.innerHTML = '<div class="empty-state"><div class="big">🏷️</div><p>暂无数据，扫描 LoRA 或添加 PNG 后自动生成</p></div>'
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
    await useLocalModelStore.getState().scanDir()
    refreshLocalNames()
    renderLocalView()
  })

  // 从 C 站链接批量下载 LoRA（复用后端 /anima/lora/download，支持 modelId 或 modelVersionId）
  $$('localUrlBtn')?.addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(2,2,3,0.72);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);'
    const modal = document.createElement('div')
    modal.className = 'ld-modal'
    modal.innerHTML = `<h3>🔗 从 C 站链接批量下载 LoRA</h3>
      <div class="ld-sub">每行一个链接（civitai.com/models/...），可带可不带 modelVersionId</div>
      <textarea class="ld-urls" rows="6" placeholder="https://civitai.com/models/2658471/denia-wuthering-wavesanima&#10;https://civitai.com/models/2529695/xxx?modelVersionId=3094753"></textarea>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <input class="ld-token" type="password" value="${(() => { try { return localStorage.getItem('anima_civitai_token') || '' } catch { return '' } })()}" placeholder="C 站 API Key（只读权限即可，下载需登录的模型用）">
        <button class="ld-tokenlink" title="打开 C 站账号设置（账号 → API Keys 生成，选只读权限）">🔑 生成 API Key</button>
      </div>
      <div class="ld-sub" style="margin-top:4px;">只读权限的 API Key 即可下载需登录的模型</div>
      <div class="ld-list"></div>
      <div class="ld-log"></div>
      <div class="ld-actions">
        <button class="ld-cancel">取消</button>
        <button class="ld-start">⬇️ 开始下载</button>
      </div>`
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    const close = () => overlay.remove()
    // 修复：拖拽选中文本时鼠标在弹窗外松开也会误关——只有按下和松开都在遮罩上才关闭
    let downOnOverlay = false
    overlay.addEventListener('mousedown', (e) => { downOnOverlay = (e.target === overlay) })
    overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnOverlay) close() })
    modal.querySelector('.ld-cancel')?.addEventListener('click', close)
    modal.querySelector('.ld-tokenlink')?.addEventListener('click', () => window.open('https://civitai.com/user/account', '_blank'))
    modal.querySelector('.ld-start')?.addEventListener('click', async () => {
      const ta = modal.querySelector('.ld-urls') as HTMLTextAreaElement
      const urls = (ta?.value || '').split('\n').map(s => s.trim()).filter(Boolean)
      if (!urls.length) { showToast('请输入链接'); return }
      const logEl = modal.querySelector('.ld-log') as HTMLElement
      const listEl = modal.querySelector('.ld-list') as HTMLElement
      const startBtn = modal.querySelector('.ld-start') as HTMLButtonElement
      startBtn.disabled = true
      let ok = 0, fail = 0
      for (const url of urls) {
        const vm = url.match(/modelVersionId=(\d+)/)
        const mm = url.match(/civitai\.com\/models\/(\d+)/)
        const qs = vm ? `versionId=${vm[1]}` : mm ? `modelId=${mm[1]}` : null
        if (!qs) { fail++; logEl.textContent += `✗ 无法解析: ${url.slice(0, 50)}\n`; continue }
        const progressId = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)

        const row = document.createElement('div')
        row.className = 'ld-row'
        const nameEl = document.createElement('span')
        nameEl.className = 'ld-name'
        nameEl.textContent = url.slice(0, 36)
        const barWrap = document.createElement('div')
        barWrap.className = 'ld-bar-wrap'
        const bar = document.createElement('div')
        bar.className = 'ld-bar'
        barWrap.appendChild(bar)
        const pctEl = document.createElement('span')
        pctEl.className = 'ld-pct'
        pctEl.textContent = '0%'
        const cancelBtn = document.createElement('button')
        cancelBtn.textContent = '✕'
        cancelBtn.title = '取消下载'
        cancelBtn.style.cssText = 'padding:2px 6px;background:rgba(255,80,80,0.15);color:#ff6b6b;border:1px solid rgba(255,80,80,0.3);border-radius:4px;cursor:pointer;font-size:10px;flex-shrink:0;line-height:1;'
        row.append(nameEl, barWrap, pctEl, cancelBtn)
        listEl.appendChild(row)
        listEl.scrollTop = listEl.scrollHeight

        await new Promise<void>((resolve) => {
          let cleared = false
          const stop = () => { if (!cleared) { cleared = true; clearInterval(timer) } }
          cancelBtn.onclick = async () => {
            cancelBtn.disabled = true
            try { await fetch(`/anima/lora/download/cancel?progressId=${progressId}`) } catch { /* ignore */ }
            stop()
            fail++
            logEl.textContent += `✗ ${url.slice(0, 40)} 已取消\n`
            pctEl.textContent = '已取消'
            resolve()
          }
          const timer = setInterval(async () => {
            try {
              const sr = await fetch(`/anima/lora/download/status?progressId=${progressId}`)
              const s = await sr.json()
              if (s.total) {
                const pc = Math.round(s.done / s.total * 100)
                bar.style.width = pc + '%'
                pctEl.textContent = pc + '%'
              }
              if (s.status === 'done') { stop(); bar.style.width = '100%'; pctEl.textContent = '✓' }
              else if (s.status === 'error' || s.status === 'cancelled') { stop(); pctEl.textContent = '✗' }
            } catch { /* ignore */ }
          }, 400)

          const tokenVal = (modal.querySelector('.ld-token') as HTMLInputElement)?.value?.trim() || ''
          if (tokenVal) { try { localStorage.setItem('anima_civitai_token', tokenVal) } catch { /* ignore */ } }
          const tokenQ = tokenVal ? `&token=${encodeURIComponent(tokenVal)}` : ''
          fetch(`/anima/lora/download?${qs}&progressId=${progressId}${tokenQ}`)
            .then((r) => r.json())
            .then((j) => {
              stop()
              if (j.ok) { ok++; logEl.textContent += `✓ ${j.filename}\n`; bar.style.width = '100%'; pctEl.textContent = '✓' }
              else { fail++; logEl.textContent += `✗ ${j.error || '失败'}\n`; pctEl.textContent = '✗' }
              resolve()
            })
            .catch((e: any) => { stop(); fail++; logEl.textContent += `✗ ${e.message}\n`; pctEl.textContent = '✗'; resolve() })
        })
        logEl.scrollTop = logEl.scrollHeight
      }
      startBtn.disabled = false
      logEl.textContent += `\n✅ 完成: ${ok} 成功 / ${fail} 失败\n`
      if (useLocalModelStore.getState().dirHandle) {
        await useLocalModelStore.getState().scanDir()
        refreshLocalNames()
        renderLocalView()
      }
    })
  })

  $$('localMatchAllBtn')?.addEventListener('click', async () => {
    const btn = $$('localMatchAllBtn') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = '⏳ 匹配中…'
    await useLocalModelStore.getState().matchAll()
    btn.disabled = false
    btn.textContent = '🔍 全部匹配'
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
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header') as HTMLElement
    if (!header) return
    e.preventDefault()
    header.classList.add('drag-over')
  })

  fileList?.addEventListener('dragleave', (e) => {
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header') as HTMLElement
    if (header) header.classList.remove('drag-over')
  })

  fileList?.addEventListener('drop', (e) => {
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header') as HTMLElement
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
    const listThumb = target.closest('.local-list-thumb') as HTMLElement
    if (listThumb) {
      const item = listThumb.closest('.local-list-item') as HTMLElement
      const name = item?.dataset.name
      const f = name ? useLocalModelStore.getState().files.find(ff => ff.name === name) : undefined
      const imgs = f?.matchData?.images || []
      if (imgs.length) openLightbox(imgs.map(u => thumbUrl(u, 800)), 0)
      return
    }
    // C 站预览图点击放大：详情页大图 / 画廊缩略图
    const heroImg = target.closest('.detail-hero-img') as HTMLElement
    if (heroImg) {
      const st = useLocalModelStore.getState()
      const f = st.files.find(x => x.name === st.selectedModel)
      const imgs = f?.matchData?.images || []
      if (imgs.length) openLightbox(imgs.map(u => thumbUrl(u, 800)), 0)
      return
    }
    const galleryImg = target.closest('.detail-gallery-thumb') as HTMLElement
    if (galleryImg) {
      const st = useLocalModelStore.getState()
      const f = st.files.find(x => x.name === st.selectedModel)
      const imgs = f?.matchData?.images || []
      if (imgs.length) {
        // gallery 渲染 images.slice(1,6)：容器内第 i 个子元素对应 images[i+1]
        const gal = galleryImg.parentElement
        const idx = gal ? Array.from(gal.children).indexOf(galleryImg) + 1 : 1
        openLightbox(imgs.map(u => thumbUrl(u, 800)), Math.min(idx, imgs.length - 1))
      }
      return
    }

    const listItem = target.closest('.local-list-item') as HTMLElement
    if (listItem) {
      const name = listItem.dataset.name
      if (name) {
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

function parsePngFile(file: File): Promise<PngMeta | null> {
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
      while (keyEnd < dataEnd && bytes[keyEnd] !== 0) keyEnd++
      const key = String.fromCharCode(...bytes.slice(dataStart, keyEnd))

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
