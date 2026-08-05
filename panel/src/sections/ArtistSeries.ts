import { esc, escAttr, copyText, showToast, fmtNum } from '../utils'
import { openLightbox } from '../components/Lightbox'
import {
  getArtists, refreshArtists, getArtistById, getArtistCategories,
  addArtist, deleteArtistById, updateArtist, addGhostArtist, clearGhostArtists,
  importArtists, exportArtists,
} from '../store/artists'
import { getSocialIcon, pool, resetDanbooruLimiter, getDanbooruCount, getDanbooruUrls } from '../api/danbooru'
import { useArtistStore } from '../store/artistStore'
import { parsePromptInput, generatePromptText } from './PromptParser'
import { openModal, closeModal, promptModal, confirmModal } from '../components/Modal'
import { VirtualScroll } from '../components/VirtualScroll'
import type { ArtistData } from '../types'

// ── 常量 ──

const CAT_ICONS: Record<string, string> = {
  '全部画师': '📋', '未分类': '📦', '二次元': '🖌️', '厚涂': '🎨', '写实': '📷',
  '水墨': '🏯', '黑白': '🖤', 'R18': '🔞',
}

const CAT_COLORS: Record<string, string> = {
  '二次元': '#6366f1',
  '厚涂': '#f97316',
  '写实': '#3b82f6',
  '水墨': '#14b8a6',
  '黑白': '#6b7280',
  'R18': '#ef4444',
}

function getCatIcon(cat: string): string {
  return CAT_ICONS[cat] || '📁'
}

function getCatColor(cat: string): string {
  return CAT_COLORS[cat] || '#8b5cf6'
}

// ── 虚拟滚动（多列网格） ──
let _artistVS: VirtualScroll | null = null
const ARTIST_CARD_MIN_WIDTH = 200
const ARTIST_CARD_GAP = 10
const ARTIST_ROW_HEIGHT = 95

function getArtistColumns(containerWidth: number): number {
  return Math.max(1, Math.floor((containerWidth + ARTIST_CARD_GAP) / (ARTIST_CARD_MIN_WIDTH + ARTIST_CARD_GAP)))
}

function destroyArtistVS() {
  if (_artistVS) { _artistVS.destroy(); _artistVS = null }
}

// ── 主渲染 ──

export function renderArtists() {
  const grid = document.getElementById('artistGrid')
  if (!grid) return

  const store = useArtistStore.getState()
  const artists = getArtists()
  const q = store.searchQuery.toLowerCase()
  const cat = store.filterCat

  // 过滤
  let filtered = artists.filter(a => {
    if (a._ghost && cat !== 'all' && cat !== '__ghost') return false
    if (cat === '__ghost') return !!a._ghost
    if (cat === '__presets') return false
    const matchCat = cat === 'all' || cat === '未分类' || a.categories.includes(cat)
    const matchSearch = !q || (a.tag + ' ' + a.name + ' ' + a.desc).toLowerCase().includes(q)
    return matchCat && matchSearch
  })

  // 排序
  if (store.sortMode === 'alpha') filtered.sort((a, b) => a.name.localeCompare(b.name))
  else if (store.sortMode === 'hot') filtered.sort((a, b) => (b.danbooruCount || 0) - (a.danbooruCount || 0))
  else filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  // 空状态（区分原因，友好提示）
  if (!filtered.length) {
    destroyArtistVS()
    const hasAny = artists.length > 0
    const msg = !hasAny
      ? '还没有画师，点击工具栏「➕ 添加」或「📊 提取」创建'
      : q
        ? '没有匹配的画师，换个关键词试试'
        : '该分类下暂无画师'
    grid.innerHTML = '<div class="empty-state" style="padding:40px"><div class="big">📭</div><p>' + msg + '</p></div>'
    renderSidebarLeft()
    renderSidebarRight()
    return
  }

  // 计算列数和行数
  const columns = getArtistColumns(grid.clientWidth)
  const totalRows = Math.ceil(filtered.length / columns)

  destroyArtistVS()
  _artistVS = new VirtualScroll({
    container: grid,
    itemHeight: ARTIST_ROW_HEIGHT,
    totalItems: totalRows,
    renderItem: (rowIndex, style) => {
      const s = useArtistStore.getState()
      const startIdx = rowIndex * columns
      let html = ''
      for (let i = 0; i < columns; i++) {
        const a = filtered[startIdx + i]
        if (!a) break
        html += `<div style="flex:1;min-width:0;padding:2px">${renderArtistCard(a, s)}</div>`
      }
      return `<div style="position:absolute;top:${style.top}px;left:0;width:100%;height:${style.height}px;display:flex;gap:${ARTIST_CARD_GAP - 4}px;padding:0 ${ARTIST_CARD_GAP / 2}px">${html}</div>`
    },
  })
  renderSidebarLeft()
  renderSidebarRight()
}

/** 统一刷新入口：数据变更后重置内存缓存并重渲染列表/侧边栏，避免漏刷新 */
function updateView() {
  refreshArtists()
  renderArtists()
}

function renderArtistCard(a: ArtistData, store: ReturnType<typeof useArtistStore.getState>): string {
  const tag = a.tag || ''
  const name = a.name || ''
  const desc = (a.desc || '').slice(0, 80)
  const hasLora = a.hasLora
  const id = a.id || ''
  const isGhost = !!a._ghost
  const isSelected = store.isSelected(tag)
  const selectionIdx = store.getSelectionIndex(tag)
  const isBatchSelected = store.batchMode && store.batchSelection.includes(tag)

  // 主分类颜色
  const primaryCat = a.categories.find(c => CAT_COLORS[c]) || a.categories[0] || '未分类'
  const accentColor = getCatColor(primaryCat)

  // 图片预览按钮（不嵌入图片，节省卡片空间）
  const imgCount = (a.images || []).length
  const previewBtn = imgCount > 0
    ? `<button class="artist-card-preview-btn" data-id="${escAttr(id)}" onclick="event.stopPropagation(); window.__openArtistLightbox('${escAttr(id)}', 0)" title="预览图片">🖼️ ${imgCount}张</button>`
    : ''

  // Danbooru 统计
  const dbHtml = a.danbooruCount > 0
    ? '<span class="artist-card-stat">🔥 ' + fmtNum(a.danbooruCount) + '</span>'
    : ''

  // 社交链接
  const socialHtml = a.socialLinks && a.socialLinks.length > 0
    ? '<div class="artist-card-socials">' + a.socialLinks.slice(0, 3).map(u =>
        '<a href="' + esc(u) + '" target="_blank" rel="noopener" class="artist-social-link" title="' + esc(u) + '" onclick="event.stopPropagation()">' + esc(getSocialIcon(u)) + '</a>'
      ).join('') + '</div>'
    : ''

  // LoRA 标签（显示数量，hover 查看名称）
  const loras = a.loras || []
  const loraHtml = hasLora
    ? `<span class="artist-card-badge" title="${esc(loras.slice(0, 6).join(', '))}${loras.length > 6 ? '…' : ''}">🎯 LoRA${loras.length > 0 ? ' ×' + loras.length : ''}</span>`
    : ''

  // 类名
  const classes = ['artist-card']
  if (isGhost) classes.push('ghost-artist')
  if (isSelected) classes.push('card-selected')
  if (isBatchSelected) classes.push('batch-selected')

  return '<div class="' + classes.join(' ') + '" data-id="' + escAttr(id) + '" data-tag="' + escAttr(tag) + '">\n' +
    '  <div class="artist-card-body">\n' +
    '    <div class="artist-card-header">\n' +
    '      <span class="artist-card-tag" style="color:' + accentColor + '">' + esc(tag) + '</span>\n' +
    (selectionIdx >= 0 ? '      <span class="artist-card-seq" style="background:' + accentColor + '">' + (selectionIdx + 1) + '</span>\n' : '') +
    '    </div>\n' +
    '    <div class="artist-card-name" title="' + esc(name) + '">' + esc(name) + '</div>\n' +
    '    <div class="artist-card-desc">' + esc(desc) + ((a.desc || '').length > 80 ? '…' : '') + '</div>\n' +
    '    <div class="artist-card-footer">\n' +
    '      ' + loraHtml + '\n' +
    '      ' + dbHtml + '\n' +
    '      ' + previewBtn + '\n' +
    '      ' + socialHtml + '\n' +
    '    </div>\n' +
    '  </div>\n' +
    (isGhost ? '  <span class="ghost-badge">👻</span>\n' : '') +
    '</div>'
}

// ── 左侧分类栏 ──

function renderSidebarLeft() {
  const list = document.getElementById('artistCatList')
  if (!list) return

  const store = useArtistStore.getState()
  const artists = getArtists()
  const catCounts = new Map<string, number>()
  artists.forEach(a => {
    a.categories.forEach(c => catCounts.set(c, (catCounts.get(c) || 0) + 1))
  })
  const ghostCount = artists.filter(a => a._ghost).length
  const totalCount = artists.length
  const cats = getArtistCategories()

  const items: string[] = []

  // 全部
  items.push('<div class="artist-cat-item' + (store.filterCat === 'all' ? ' on' : '') + '" data-cat="all">' +
    '📋 全部 <span class="artist-cat-count">' + totalCount + '</span></div>')

  // 分类
  for (const cat of cats) {
    const count = catCounts.get(cat) || 0
    items.push('<div class="artist-cat-item' + (store.filterCat === cat ? ' on' : '') + '" data-cat="' + escAttr(cat) + '">' +
      getCatIcon(cat) + ' ' + esc(cat) + ' <span class="artist-cat-count">' + count + '</span></div>')
  }

  // 幽灵画师
  if (ghostCount > 0) {
    items.push('<div class="artist-cat-item' + (store.filterCat === '__ghost' ? ' on' : '') + '" data-cat="__ghost">' +
      '👻 占位 <span class="artist-cat-count">' + ghostCount + '</span></div>')
  }

  // 预设
  items.push('<div class="artist-cat-item' + (store.filterCat === '__presets' ? ' on' : '') + '" data-cat="__presets">' +
    '💾 预设 <span class="artist-cat-count">' + store.presets.length + '</span></div>')

  list.innerHTML = items.join('')
}

// ── 右侧组合面板 ──

function renderSidebarRight() {
  const selList = document.getElementById('artistSelList')
  const countEl = document.getElementById('artistSelCount')
  const previewEl = document.getElementById('artistPromptPreview')
  const presetList = document.getElementById('artistPresetList')
  if (!selList) return

  const store = useArtistStore.getState()
  const tags = store.selectedTags

  // 已选数量
  if (countEl) countEl.textContent = String(tags.length)

  // 已选画师列表
  if (tags.length === 0) {
    selList.innerHTML = '<div class="empty-state" style="padding:20px 12px"><div class="big">👆</div><p style="font-size:11px">点击画师卡片添加到组合</p></div>'
  } else {
    selList.innerHTML = tags.map((tag, i) => {
      const artist = getArtists().find(a => a.tag === tag)
      const weight = store.getWeight(tag)
      const name = artist?.name || tag
      const color = store.getColor(i)

      return '<div class="artist-sel-chip" data-tag="' + escAttr(tag) + '" style="border-left:3px solid ' + color + '">\n' +
        '  <span class="artist-sel-num" style="background:' + color + '">' + (i + 1) + '</span>\n' +
        '  <span class="artist-sel-tag">' + esc(tag) + '</span>\n' +
        '  <span class="artist-sel-name">' + esc(name) + '</span>\n' +
        '  <input type="range" class="artist-sel-weight" min="0.1" max="2" step="0.1" value="' + weight + '" data-tag="' + escAttr(tag) + '">\n' +
        '  <input type="number" class="artist-sel-weight-input" min="0.1" max="2" step="0.1" value="' + weight.toFixed(1) + '" data-tag="' + escAttr(tag) + '" title="直接输入权重 (0.1-2)">\n' +
        '  <button class="artist-sel-up" data-tag="' + escAttr(tag) + '" title="上移">↑</button>\n' +
        '  <button class="artist-sel-down" data-tag="' + escAttr(tag) + '" title="下移">↓</button>\n' +
        '  <button class="artist-sel-remove" data-tag="' + escAttr(tag) + '" title="移除">✕</button>\n' +
        '</div>'
    }).join('')
  }

  // Prompt 预览
  if (previewEl) {
    const textarea = previewEl as HTMLTextAreaElement
    if (tags.length === 0) {
      textarea.value = ''
    } else {
      const parsed = tags.map(tag => ({ tag, weight: store.getWeight(tag) }))
      textarea.value = generatePromptText(parsed, store.promptFormat)
    }
  }

  // 预设列表
  if (presetList) {
    presetList.innerHTML = store.presets.length === 0
      ? '<div class="empty-state" style="padding:8px;font-size:10px"><p>暂无预设</p></div>'
      : store.presets.map(p => '<div class="artist-preset-item" data-id="' + escAttr(p.id) + '">\n' +
          '  <span class="preset-name">' + esc(p.name) + '</span>\n' +
          '  <span class="preset-count">' + p.artists.length + '位</span>\n' +
          '  <button class="preset-load-btn" data-id="' + escAttr(p.id) + '" title="加载">📥</button>\n' +
          '  <button class="preset-del-btn" data-id="' + escAttr(p.id) + '" title="删除">✕</button>\n' +
          '</div>').join('')
  }
}

// ── 事件绑定 ──

export function bindArtistEvents() {
  bindGridEvents()
  bindPanelEvents()
  bindSidebarEvents()
  bindToolbarEvents()
  bindBatchEvents()
  bindImportEvents()
  bindDanbooruEvents()
  bindKeyboardNav()
}

// 网格点击事件
function bindGridEvents() {
  const grid = document.getElementById('artistGrid')
  if (!grid) return

  grid.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const store = useArtistStore.getState()

    // 社交链接不处理
    if (target.closest('.artist-social-link')) return

    // 卡片点击
    const card = target.closest('.artist-card') as HTMLElement
    if (!card?.dataset?.tag) return

    const tag = card.dataset.tag

    if (store.batchMode) {
      store.toggleBatchSelection(tag)
      updateView()
    } else {
      store.toggleArtist(tag)
      updateView()
    }
  })
}

// 右侧面板事件
function bindPanelEvents() {
  const selList = document.getElementById('artistSelList')
  if (!selList) return

  // 权重滑块 / 数值输入
  selList.addEventListener('input', (e) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('artist-sel-weight')) {
      const tag = target.dataset.tag
      if (tag) {
        useArtistStore.getState().setWeight(tag, parseFloat((target as HTMLInputElement).value))
        renderSidebarRight()
      }
    } else if (target.classList.contains('artist-sel-weight-input')) {
      // 数值输入：仅同步滑块，不重建（避免击键失焦）
      const tag = target.dataset.tag
      if (tag) {
        const v = parseFloat((target as HTMLInputElement).value)
        if (!isNaN(v)) {
          const r = selList.querySelector(`.artist-sel-weight[data-tag="${CSS.escape(tag)}"]`) as HTMLInputElement
          if (r) r.value = String(Math.max(0.1, Math.min(2, v)))
        }
      }
    }
  })
  // 数值输入提交（失焦/回车）
  selList.addEventListener('change', (e) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('artist-sel-weight-input')) {
      const tag = target.dataset.tag
      if (tag) {
        const v = parseFloat((target as HTMLInputElement).value)
        const clamped = isNaN(v) ? 0.8 : Math.max(0.1, Math.min(2, v))
        useArtistStore.getState().setWeight(tag, clamped)
        renderSidebarRight()
      }
    }
  })

  // 按钮点击
  selList.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const tag = target.dataset?.tag
    if (!tag) return

    const store = useArtistStore.getState()

    if (target.classList.contains('artist-sel-remove')) {
      store.removeFromCombo(tag)
      updateView()
    } else if (target.classList.contains('artist-sel-up')) {
      store.moveUp(tag)
      renderSidebarRight()
    } else if (target.classList.contains('artist-sel-down')) {
      store.moveDown(tag)
      renderSidebarRight()
    }
  })

  // 清空按钮
  document.getElementById('artistClearBtn')?.addEventListener('click', () => {
    useArtistStore.getState().clearCombo()
    updateView()
  })

  // 复制按钮
  document.getElementById('artistCopyBtn')?.addEventListener('click', () => {
    const preview = document.getElementById('artistPromptPreview') as HTMLTextAreaElement
    if (preview?.value) copyText(preview.value)
  })

  // 保存预设
  document.getElementById('artistSavePresetBtn')?.addEventListener('click', async () => {
    const store = useArtistStore.getState()
    if (store.selectedTags.length === 0) { showToast('请先选择画师'); return }
    const name = await promptModal('保存预设', '', '输入预设名称:')
    if (name) { store.savePreset(name); updateView() }
  })

  // 格式切换
  document.getElementById('artistFormatBtn')?.addEventListener('click', () => {
    const store = useArtistStore.getState()
    const next = store.promptFormat === 'webui' ? 'nai' : 'webui'
    useArtistStore.setState({ promptFormat: next })
    const btn = document.getElementById('artistFormatBtn')
    if (btn) btn.textContent = next === 'webui' ? '🔄 NAI格式' : '🔄 WebUI格式'
    renderSidebarRight()
  })

  // 预设列表
  const presetList = document.getElementById('artistPresetList')
  if (presetList) {
    presetList.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement
      const store = useArtistStore.getState()

      if (target.classList.contains('preset-load-btn')) {
        const id = target.dataset.id
        const preset = store.presets.find(p => p.id === id)
        if (preset) {
          store.loadPreset(preset)
          updateView()
          showToast('已加载预设: ' + preset.name)
        }
      } else if (target.classList.contains('preset-del-btn')) {
        const id = target.dataset.id
        if (id && await confirmModal('删除预设', '确认删除该预设？')) {
          store.deletePreset(id)
          updateView()
        }
      }
    })
  }
}

// 左侧分类栏事件
function bindSidebarEvents() {
  const list = document.getElementById('artistCatList')
  if (!list) return

  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const item = target.closest('.artist-cat-item') as HTMLElement
    if (!item?.dataset?.cat) return

    const cat = item.dataset.cat
    const store = useArtistStore.getState()
    store.setFilterCat(cat)
    useArtistStore.setState({ batchMode: false, batchSelection: [] })

    if (cat === '__presets') renderPresets()
    else updateView()
  })
}

// 工具栏事件
function bindToolbarEvents() {
  // 搜索
  const searchInput = document.getElementById('artistSearch') as HTMLInputElement
  if (searchInput) {
    let timer: number
    searchInput.oninput = () => {
      useArtistStore.getState().setSearch(searchInput.value)
      clearTimeout(timer)
      timer = window.setTimeout(() => updateView(), 250)
    }
  }

  // 添加画师
  document.getElementById('addArtistBtn')?.addEventListener('click', showAddArtistModal)

  // 批量模式
  document.getElementById('artistBatchToggleBtn')?.addEventListener('click', () => {
    useArtistStore.getState().toggleBatchMode()
    updateView()
  })

  // 排序
  document.getElementById('artistSortBtn')?.addEventListener('click', () => {
    const store = useArtistStore.getState()
    const modes = ['default', 'alpha', 'hot'] as const
    const next = modes[(modes.indexOf(store.sortMode) + 1) % 3]
    store.setSortMode(next)
    const labels: Record<string, string> = { default: '📅 默认', alpha: '🔤 字母', hot: '🔥 热度' }
    const btn = document.getElementById('artistSortBtn')
    if (btn) btn.textContent = labels[next]
    updateView()
  })

  // 导出
  document.getElementById('artistExportBtn')?.addEventListener('click', () => {
    const data = exportArtists()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'artist_backup_' + new Date().toISOString().slice(0, 10) + '.json'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showToast('导出成功')
  })

  // 导入
  document.getElementById('artistImportBtn')?.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result as string)
          const artists = Array.isArray(json) ? json : (json.artists || [])
          const { added, updated } = importArtists(artists)
          refreshArtists()
          updateView()
          showToast('导入完成: 新增 ' + added + '，更新 ' + updated)
        } catch { showToast('导入失败: 文件格式错误') }
      }
      reader.readAsText(file)
    }
    input.click()
  })
}

// 批量操作事件
function bindBatchEvents() {
  const bar = document.getElementById('artistBatchBar')
  if (!bar) return

  bar.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    const store = useArtistStore.getState()

    if (target.id === 'artistBatchAllBtn') {
      const allTags = getFilteredTags()
      const allSelected = allTags.every(t => store.batchSelection.includes(t))
      useArtistStore.setState({ batchSelection: allSelected ? [] : [...allTags] })
      updateView()
    } else if (target.id === 'artistBatchDelBtn') {
      const tags = store.batchSelection
      if (tags.length && await confirmModal('批量删除', `确认删除选中的 ${tags.length} 位画师？`)) {
        // 获取对应的 id 并删除
        const artists = getArtists()
        tags.forEach(tag => {
          const a = artists.find(x => x.tag === tag)
          if (a) deleteArtistById(a.id)
        })
        // 从选中中移除
        const remaining = store.selectedTags.filter(t => !tags.includes(t))
        const weights = { ...store.weights }
        tags.forEach(t => delete weights[t])
        useArtistStore.setState({
          batchMode: false,
          batchSelection: [],
          selectedTags: remaining,
          weights,
        })
        updateView()
      }
    } else if (target.id === 'artistBatchCatBtn') {
      const cat = await promptModal('批量分类', '', '输入分类名称 (用逗号分隔多个):')
      if (!cat) return
      const cats = cat.split(',').map(c => c.trim()).filter(Boolean)
      if (cats.length === 0) return
      const artists = getArtists()
      store.batchSelection.forEach(tag => {
        const a = artists.find(x => x.tag === tag)
        if (a) {
          const newCats = [...new Set([...a.categories.filter(c => c !== '未分类'), ...cats])]
          updateArtist(a.id, { categories: newCats.length > 0 ? newCats : ['未分类'] })
        }
      })
      refreshArtists()
      useArtistStore.setState({ batchMode: false, batchSelection: [] })
      updateView()
      showToast('分类已更新')
    } else if (target.id === 'artistBatchCancelBtn') {
      useArtistStore.setState({ batchMode: false, batchSelection: [] })
      updateView()
    }
  })
}

function getFilteredTags(): string[] {
  const store = useArtistStore.getState()
  const artists = getArtists()
  const q = store.searchQuery.toLowerCase()
  const cat = store.filterCat
  return artists
    .filter(a => {
      if (cat === '__presets' || cat === '__ghost') return false
      if (!q) return cat === 'all' || a.categories.includes(cat)
      return (cat === 'all' || a.categories.includes(cat)) && (a.tag + a.name + a.desc).toLowerCase().includes(q)
    })
    .map(a => a.tag)
}

// 画师串导入事件
function bindImportEvents() {
  document.getElementById('artistPromptImportBtn')?.addEventListener('click', () => {
    const textarea = document.getElementById('artistPromptImportText') as HTMLTextAreaElement
    if (!textarea?.value.trim()) { showToast('请粘贴画师串'); return }

    const parsed = parsePromptInput(textarea.value)
    if (parsed.length === 0) { showToast('未检测到有效画师标签'); return }

    clearGhostArtists()
    refreshArtists()
    const store = useArtistStore.getState()
    store.clearCombo()

    let found = 0, ghost = 0
    for (const item of parsed) {
      const needle = item.tag.toLowerCase().trim()
      const artist = getArtists().find(a => {
        const dbTag = (a.tag || '').toLowerCase().trim()
        const dbName = (a.name || '').toLowerCase().trim()
        return dbTag === needle || dbName === needle || dbTag.replace(/^artist:\s*/, '') === needle
      })

      if (artist) {
        store.toggleArtist(artist.tag)
        if (item.weight !== 1.0) store.setWeight(artist.tag, item.weight)
        found++
      } else {
        const ghostArtist = addGhostArtist(item.tag)
        store.toggleArtist(ghostArtist.tag)
        if (item.weight !== 1.0) store.setWeight(ghostArtist.tag, item.weight)
        ghost++
      }
    }

    updateView()
    showToast('导入完成: ' + found + ' 位已匹配' + (ghost > 0 ? '，' + ghost + ' 位占位' : ''))
  })
}

// Danbooru 更新事件
function bindDanbooruEvents() {
  const btn = document.getElementById('artistDanbooruBtn')
  const container = document.getElementById('danbooruStatus')
  if (!btn || !container) return

  let cancelled = false

  btn.onclick = async () => {
    if ((btn as HTMLButtonElement).disabled) return
    ;(btn as HTMLButtonElement).disabled = true
    cancelled = false
    btn.textContent = '⏳ 更新中…'

    const rate = 3
    const concurrency = 3
    resetDanbooruLimiter(rate)

    const abort = new AbortController()
    const artists = getArtists().filter(a => !a._ghost)
    let done = 0, total = artists.length, errors = 0
    if (container) container.style.display = 'block'

    function updateUI() {
      const pct = total > 0 ? Math.round(done / total * 100) : 0
      if (container) {
        container.innerHTML = '<div class="danbooru-progress">\n' +
          '<div class="danbooru-progress-bar"><div class="danbooru-progress-fill" style="width:' + pct + '%"></div></div>\n' +
          '<span>' + done + '/' + total + ' (' + errors + ' 错误)</span>\n' +
          '<button class="btn btn-ghost" id="danbooruCancelBtn" style="font-size:10px">⏹ 停止</button>\n' +
          '</div>'
        document.getElementById('danbooruCancelBtn')?.addEventListener('click', () => {
          cancelled = true
          abort.abort()
        })
      }
    }
    updateUI()

    const todo = artists.map((a, i) => ({ a, i }))

    await pool(concurrency, todo, async ({ a }) => {
      if (cancelled) return
      try {
        const [countResult, urls] = await Promise.all([
          getDanbooruCount(a.tag, abort.signal),
          getDanbooruUrls(a.tag, abort.signal),
        ])
        if (cancelled) return
        if (countResult.category !== 'error') {
          updateArtist(a.id, {
            danbooruCount: countResult.count,
            danbooruName: countResult.name || '',
            socialLinks: urls.length > 0 ? urls : a.socialLinks,
          })
        } else {
          errors++
        }
      } catch {
        errors++
      }
      done++
      if (done % 5 === 0) { refreshArtists(); updateUI() }
    }, () => cancelled)

    refreshArtists()
    updateView()
    container.style.display = 'none'
    ;(btn as HTMLButtonElement).disabled = false
    btn.textContent = '🔄 Danbooru 更新'
    const msg = cancelled ? '更新已取消' : '更新完成: ' + done + '/' + total
    showToast(msg)
  }
}

// 键盘导航
function bindKeyboardNav() {
  document.addEventListener('keydown', (e) => {
    const section = document.getElementById('sectionArtist')
    if (!section || section.classList.contains('section-hidden')) return
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return

    const store = useArtistStore.getState()
    if (store.batchMode || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return

    e.preventDefault()
    const grid = document.getElementById('artistGrid')
    if (!grid) return
    const cards = grid.querySelectorAll<HTMLElement>('.artist-card:not(.preset-card)')
    if (!cards.length) return

    const selTags = store.selectedTags
    let idx = selTags.length > 0
      ? Array.from(cards).findIndex(c => c.dataset.tag === selTags[selTags.length - 1])
      : -1

    idx = e.key === 'ArrowDown'
      ? Math.min(idx + 1, cards.length - 1)
      : Math.max(idx - 1, idx < 0 ? cards.length - 1 : 0)

    const target = cards[idx]
    const tag = target?.dataset.tag
    if (tag) {
      if (!store.isSelected(tag)) store.toggleArtist(tag)
      updateView()
      target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })

  // 点击卡片设置焦点
  document.getElementById('artistGrid')?.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.artist-card')
    if (card) card.tabIndex = -1
  })
}

// ── 预设视图 ──

function renderPresets() {
  const grid = document.getElementById('artistGrid')
  if (!grid) return

  const store = useArtistStore.getState()
  const artists = getArtists()

  if (store.presets.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="padding:40px"><div class="big">💾</div><p>暂无风格预设</p><p class="sub">选择画师组合后点击"保存预设"</p></div>'
    renderSidebarLeft()
    renderSidebarRight()
    return
  }

  grid.innerHTML = store.presets.map(p => {
    const artistTags = p.artists.map(a => {
      const found = artists.find(x => x.tag === a.tag)
      return found ? (found.name || found.tag) : a.tag
    }).join(', ')

    return '<div class="artist-card preset-card" data-id="' + escAttr(p.id) + '">\n' +
      '  <div class="artist-card-accent" style="background:#8b5cf6"></div>\n' +
      '  <div class="artist-card-body">\n' +
      '    <div class="artist-card-header">\n' +
      '      <span class="artist-card-tag">' + esc(p.name) + '</span>\n' +
      '      <span class="artist-card-badge">💾</span>\n' +
      '    </div>\n' +
      '    <div class="artist-card-name">' + p.artists.length + ' 位画师</div>\n' +
      '    <div class="artist-card-desc">' + esc(artistTags).slice(0, 120) + (artistTags.length > 120 ? '…' : '') + '</div>\n' +
      '  </div>\n' +
      '</div>'
  }).join('')

  renderSidebarLeft()
  renderSidebarRight()
}

// ── 模态框 ──

function showAddArtistModal() {
  const modal = document.getElementById('addArtistModal')
  if (!modal) return

  const cats = getArtistCategories().filter(c => c !== '未分类')
  const catOpts = cats.map(c => '<option value="' + escAttr(c) + '">' + getCatIcon(c) + ' ' + esc(c) + '</option>').join('')

  modal.innerHTML = '<div class="modal-box">\n' +
    '  <h3>➕ 添加画师</h3>\n' +
    '  <div style="display:flex;flex-direction:column;gap:8px">\n' +
    '    <input type="text" id="addArtistTag" placeholder="Tag (不含@前缀，如 g0w0ru)" autocomplete="off">\n' +
    '    <input type="text" id="addArtistName" placeholder="显示名称 (如 g0w0ru)" autocomplete="off">\n' +
    '    <textarea id="addArtistDesc" placeholder="风格描述..." rows="2" style="resize:vertical"></textarea>\n' +
    '    <div><label style="font-size:11px;color:var(--text3)">分类:</label>\n' +
    '      <select id="addArtistCat" multiple style="width:100%;height:80px">\n' +
    '        ' + catOpts + '\n' +
    '      </select>\n' +
    '      <input type="text" id="addArtistNewCat" placeholder="或输入新分类 (逗号分隔)" style="margin-top:4px">\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <div class="modal-actions" style="margin-top:12px">\n' +
    '    <button class="btn btn-primary" id="addArtistConfirm">✅ 确认</button>\n' +
    '    <button class="btn btn-ghost" id="addArtistCancel">取消</button>\n' +
    '  </div>\n' +
    '</div>'

  modal.style.display = 'flex'

  const close = () => { modal.style.display = 'none' }
  document.getElementById('addArtistCancel')!.onclick = close
  modal.onclick = (e) => { if (e.target === modal) close() }

  document.getElementById('addArtistConfirm')!.onclick = () => {
    const tagEl = document.getElementById('addArtistTag') as HTMLInputElement
    const nameEl = document.getElementById('addArtistName') as HTMLInputElement
    const descEl = document.getElementById('addArtistDesc') as HTMLTextAreaElement
    const catEl = document.getElementById('addArtistCat') as HTMLSelectElement
    const newCatEl = document.getElementById('addArtistNewCat') as HTMLInputElement

    const tag = tagEl.value.trim()
    if (!tag) { showToast('Tag 必填'); return }

    const selectedCats = Array.from(catEl.selectedOptions).map(o => o.value)
    const newCats = newCatEl.value.split(',').map(c => c.trim()).filter(Boolean)
    const cats = [...new Set([...selectedCats, ...newCats])]

    const result = addArtist(tag, nameEl.value.trim(), descEl.value.trim(), cats.length > 0 ? cats : undefined)
    if (!result) { showToast('Tag 已存在!'); return }
    close()
    refreshArtists()
    updateView()
    showToast('添加成功')
  }
}

function showExtractModal() {
  const modal = document.getElementById('addArtistModal')
  if (!modal) return

  modal.innerHTML = '<div class="modal-box" style="max-width:400px">\n' +
    '  <h3>📊 提取画师</h3>\n' +
    '  <p class="sub">从已加载 LoRA 的 trainedWords 中自动检测 @ 开头的画师标签</p>\n' +
    '  <div id="extractResult" style="max-height:200px;overflow-y:auto;font-size:11px">\n' +
    '    <p style="color:var(--text3)">点击下方按钮开始提取…</p>\n' +
    '  </div>\n' +
    '  <div class="modal-actions" style="margin-top:12px">\n' +
    '    <button class="btn btn-primary" id="extractStartBtn">🔍 开始提取</button>\n' +
    '    <button class="btn btn-ghost" id="extractCancelBtn">关闭</button>\n' +
    '  </div>\n' +
    '</div>'

  modal.style.display = 'flex'

  const close = () => { modal.style.display = 'none' }
  document.getElementById('extractCancelBtn')!.onclick = close
  modal.onclick = (e) => { if (e.target === modal) close() }

  document.getElementById('extractStartBtn')!.onclick = async () => {
    const { extractArtistsFromModels, addArtistFromExtraction } = await import('../store/artists')
    const { useModelStore } = await import('../store/models')

    const models = useModelStore.getState().processed || []
    const wordsLists = models.map(m => m.trainedWords || [])
    const extracted = extractArtistsFromModels(wordsLists)
    const resultEl = document.getElementById('extractResult')!

    if (extracted.length === 0) {
      resultEl.innerHTML = '<p>未检测到 @ 开头的画师标签</p>'
      return
    }

    let html = '<p>检测到 <strong>' + extracted.length + '</strong> 个候选:</p>'
    for (const item of extracted) {
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">\n' +
        '  <span><strong>' + esc(item.tag) + '</strong> <span style="color:var(--text3)">(' + item.count + '次)</span></span>\n' +
        '  <button class="btn btn-ghost extract-add-btn" data-tag="' + escAttr(item.tag) + '" data-count="' + item.count + '" style="font-size:9px;padding:2px 6px">➕</button>\n' +
        '</div>'
    }
    html += '<div style="margin-top:8px"><button class="btn btn-primary" id="extractAllBtn" style="font-size:10px">📥 全部添加</button></div>'
    resultEl.innerHTML = html

    resultEl.addEventListener('click', (e2) => {
      const t = e2.target as HTMLElement
      if (t.classList.contains('extract-add-btn')) {
        const tag = t.dataset.tag!
        const count = parseInt(t.dataset.count || '1')
        const result = addArtistFromExtraction(tag, count)
        if (result) {
          t.textContent = '✅'
          t.classList.replace('btn-ghost', 'btn-primary')
        } else {
          t.textContent = '已有'
          ;(t as HTMLButtonElement).disabled = true
        }
        // 刷新主网格与侧边栏，让刚添加的画师立即显示
        refreshArtists()
        updateView()
      }
      if (t.id === 'extractAllBtn') {
        for (const item of extracted) {
          addArtistFromExtraction(item.tag, item.count)
        }
        refreshArtists()
        updateView()
        close()
        showToast('添加了 ' + extracted.length + ' 位画师')
      }
    })
  }
}

// ── Lightbox ──

declare global {
  interface Window { __openArtistLightbox: (artistId: string, imgIndex: number) => void }
}

window.__openArtistLightbox = (artistId: string, imgIndex: number) => {
  const artist = getArtistById(artistId)
  if (!artist?.images?.length) return
  openLightbox(artist.images, imgIndex)
}
