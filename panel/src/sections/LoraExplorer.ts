import { useModelStore } from '../store/models'
import { renderCard, refreshLocalNames } from '../components/ModelCard'
import { renderArtists } from './ArtistSeries'
import { fetchModels, fetchModelById, fetchModelImages } from '../api/civitai'
import { Cache } from '../store/cache'
import {
  initFavorites, getCollections, getActiveCol, setActiveCol,
  createCollection, renameCollection, deleteCollection,
  exportFavData, importFavData, favCount, toggleFav
} from '../store/favorites'
import { addHidden, removeHidden, hiddenCount, getHiddenIds } from '../store/hidden'
import { addSearch, getSearches, clearSearches, getViews, addView } from '../store/history'
import { addArtistImage, removeArtistImage, getCustomImages, getMergedImages } from '../store/artistImages'
import { addArtist, deleteArtist, getArtists, extractArtistsFromModels, addArtistFromExtraction } from '../store/artists'
import { getNote, saveNote, getModelStatusText } from '../store/notes'
import { openLightbox, closeLightbox, navLightbox } from '../components/Lightbox'
import { openModal, closeModal, confirmModal } from '../components/Modal'
import { esc, escAttr, copyText, showToast, sleep, thumbUrl, fmtNum } from '../utils'
import { renderLocalView as renderLocal, activateLocalManager } from './LocalManager'
import { useLocalModelStore } from '../store/localModels'
import { initPromptDB, getPromptCountByModel } from '../store/prompts'
import { renderPromptLibrary, setupPromptHandlers } from './PromptLibrary'
import { renderPromptFreq, bindPromptFreqEvents } from './PromptFreq'

const MAX_PAGES = 20
const galleryPos: Record<number, number> = {}
let autoFetching = false
let autoTimer: ReturnType<typeof setTimeout> | null = null

export function toggleAuto() {
  autoFetching = !autoFetching
  const btn = document.getElementById('autoBtn') as HTMLButtonElement
  if (!btn) return
  if (autoFetching) {
    btn.textContent = '⏹ 停止'
    btn.classList.replace('btn-ghost', 'btn-danger')
    showToast('▶ 自动翻页已开启')
    runAuto()
  } else {
    btn.textContent = '▶ 自动翻页'
    btn.classList.replace('btn-danger', 'btn-ghost')
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
  }
}

async function runAuto() {
  if (!autoFetching) return
  const store = useModelStore.getState()
  if (store.hasMore && store.page < MAX_PAGES) {
    await fetchPage(store.page + 1, { quietError: true })
  }
  const store2 = useModelStore.getState()
  if (!store2.hasMore || store2.page >= MAX_PAGES) {
    showToast('✅ 自动翻页完成!')
    autoFetching = false
    const btn = document.getElementById('autoBtn')
    if (btn) { btn.textContent = '▶ 自动翻页'; btn.classList.replace('btn-danger', 'btn-ghost') }
    return
  }
  autoTimer = setTimeout(() => runAuto(), 2500)
}

export async function initLoraExplorer() {
  initFavorites()
  initPromptDB() // Initialize IndexedDB prompt library

  // 立即渲染默认页面（force=true 确保即使 store.section 已匹配也触发渲染）
  // 放在 await 之前，确保页面内容优先显示
  switchSection(useModelStore.getState().section as any, true)

  const store = useModelStore.getState()
  const cached = Cache.load<any[]>('models_' + store.period, 30 * 60 * 1000)
  if (cached && cached.length > 0) {
    store.setRaw(cached)
    store.rebuild()
    refreshView()
    const t = { AllTime: '全部时间', Month: '本月', Week: '本周' }[store.period] || store.period
    showToast(`📦 已恢复 ${t} ${cached.length} 个模型`, 'success')
  }

  await fetchPage(1)

  const fbModels = useModelStore.getState().processed.filter(m => m.needsFallback && m.images.length === 0)
  if (fbModels.length > 0) {
    for (const m of fbModels) {
      const imgs = await fetchModelImages(m.id)
      if (imgs.length > 0) m.images = imgs
      await sleep(600)
    }
    refreshView()
  }

  // 启动时自动检测本地目录是否有新文件
  const localStore = useLocalModelStore.getState()
  if (localStore.files.length > 0) {
    const restored = await localStore.loadDirHandle().catch(() => false)
    if (restored) {
      const newCount = await localStore.detectNewFiles().catch(() => 0)
      if (newCount > 0) {
        localStore.setNewFileCount(newCount)
        showToast(`📁 本地 LoRA 有新文件 (${newCount} 个)，切到「本地 lora 管理」可增量扫描`)
      }
    }
  }
}

export function switchSection(id: 'lora' | 'artist' | 'prompt' | 'prompt-freq' | 'local' | 'outputs', force?: boolean) {
  const store = useModelStore.getState()
  if (!force && id === store.section) return
  useModelStore.getState().setSection(id as any)
  document.querySelectorAll('#sectionLora, #sectionArtist, #sectionPrompt, #sectionPromptFreq, #sectionLocal, #sectionOutputs').forEach(el => el.classList.add('section-hidden'))
  const sectionMap: Record<string, string> = { lora: 'sectionLora', artist: 'sectionArtist', prompt: 'sectionPrompt', 'prompt-freq': 'sectionPromptFreq', local: 'sectionLocal', outputs: 'sectionOutputs' }
  document.getElementById(sectionMap[id])?.classList.remove('section-hidden')
  document.querySelectorAll('.main-tab').forEach(t => {
    const active = (t as HTMLElement).dataset.section === id
    t.classList.toggle('active', active)
    t.setAttribute('aria-selected', String(active))
  })
  if (id === 'artist') renderArtists()
  if (id === 'lora') renderGrid()
  if (id === 'prompt') renderPromptLibrary()
  if (id === 'prompt-freq') renderPromptFreq()
  if (id === 'local') { renderLocal(); activateLocalManager() }
  if (id === 'outputs') { /* Outputs handles its own activation */ }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function fetchPage(p: number, options?: { quietError?: boolean }) {
  const store = useModelStore.getState()
  if (store.loading) return

  useModelStore.setState({ loading: true })
  try {
    const data = await fetchModels(p, store.period)
    if (!data) return
    const items = data.items || []
    const meta = data.metadata || {}
    const maxPage = meta.totalPages || p
    const hasMore = meta.nextPage !== null && meta.nextPage !== undefined && p < MAX_PAGES

    store.appendRaw(items)
    store.setPagination(p, maxPage, hasMore)
    store.rebuild()
    refreshView()

    Cache.save('models_' + store.period, store.raw)
    return items
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null
    console.error(err)
    if (!options?.quietError) showToast('❌ 抓取出错: ' + (err as Error).message)
    return null
  } finally {
    useModelStore.setState({ loading: false })
  }
}

export async function loadMore() {
  const store = useModelStore.getState()
  if (store.loading || !store.hasMore) return
  const next = store.page + 1
  if (next > MAX_PAGES) { showToast('⚠️ 已达最大页数'); return }
  await fetchPage(next)
}

export async function fetchAll() {
  const store = useModelStore.getState()
  if (store.fetchAllBusy) return
  useModelStore.setState({ fetchAllBusy: true })
  const btn = document.getElementById('fetchBtn') as HTMLButtonElement
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 抓取中…' }

  if (store.raw.length === 0) await fetchPage(1)
  let p = store.page + 1
  while (p <= MAX_PAGES && store.hasMore) {
    const ok = await fetchPage(p, { quietError: true })
    if (!ok) break
    p = store.page + 1
    await sleep(400)
  }

  if (btn) {
    btn.textContent = '✅ 完成!'
    setTimeout(() => { btn.textContent = '🔄 抓取全部'; btn.disabled = false; useModelStore.setState({ fetchAllBusy: false }) }, 2000)
  }
  showToast('✅ 全部页面抓取完成!', 'success')
}

export function setPeriod(period: 'AllTime' | 'Month' | 'Week') {
  const store = useModelStore.getState()
  if (store.period === period) return
  useModelStore.getState().setPeriod(period)
  showToast(`📊 切换到「${{ AllTime: '全部', Month: '本月', Week: '本周' }[period]}」`)
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.period === period))
  fetchPage(1)
}

export function refreshView() {
  updateStats()
  updateTabs()
  renderGrid()
}

function updateStats() {
  const store = useModelStore.getState()
  const total = store.processed.length
  const totalDl = store.processed.reduce((s, m) => s + m.stats.downloadCount, 0)
  const totalLk = store.processed.reduce((s, m) => s + m.stats.thumbsUpCount, 0)
  const avgR = totalDl > 0 ? totalLk / totalDl : 0

  setText('totalCount', String(total))
  setText('totalDl', fmtNum(totalDl))
  setText('totalLike', fmtNum(totalLk))
  setText('avgRatio', (avgR * 100).toFixed(2) + '%')
  setText('pageInfo', `${store.page}/${Math.min(store.maxPage, MAX_PAGES)}`)

  const pct = store.maxPage > 0 ? (store.page / Math.min(store.maxPage, MAX_PAGES)) * 100 : 0
  const fill = document.getElementById('loadingFill')
  if (fill) (fill as HTMLElement).style.width = Math.min(100, pct) + '%'

  setText('loraBadge', String(total))
}

function updateTabs() {
  const store = useModelStore.getState()
  const hiddenSet = new Set(getHiddenIds())

  const counts: Record<string, number> = { all: 0, artist: 0, character: 0, aesthetic: 0, background: 0, other: 0 }
  for (const m of store.processed) {
    if (hiddenSet.has(m.id)) continue
    counts.all++
    if (counts[m.category] !== undefined) counts[m.category]++
  }

  const idMap: Record<string, string> = { all: 'cAll', artist: 'cArtist', character: 'cCharacter', aesthetic: 'cAesthetic', background: 'cBg', other: 'cOther', fav: 'cFav' }
  for (const [k, id] of Object.entries(idMap)) {
    setText(id, String(k === 'fav' ? favCount() : (counts[k] || 0)))
  }
  setText('cHidden', String(hiddenCount()))

  renderColTabs()

  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', (t as HTMLElement).dataset.cat === store.category)
  )
}

function renderColTabs() {
  const container = document.getElementById('colTabs')
  if (!container) return
  const store = useModelStore.getState()
  const show = store.category === 'fav'
  container.style.display = show ? 'flex' : 'none'
  if (!show) return

  const cols = getCollections()
  const activeCol = getActiveCol()
  container.innerHTML = cols.map(c =>
    `<button class="tab ${c.id === activeCol ? 'active' : ''}" data-colid="${c.id}" role="tab">${c.icon} ${esc(c.name)} <span class="count">${c.count}</span></button>`
  ).join('') +
    `<button class="tab" id="manageColBtn" role="tab" style="border-color:var(--accent);color:var(--accent);font-size:11px">⚙️ 管理</button>`
}

function renderGrid() {
  refreshLocalNames()
  const grid = document.getElementById('grid')
  if (!grid) return
  const store = useModelStore.getState()
  const list = store.getFiltered()

  if (list.length === 0) {
    if (store.processed.length === 0 && store.page > 0) {
      grid.innerHTML = `<div class="empty-state"><div class="big">🔍</div><p>所有 LoRA 未达筛选条件</p><p class="sub">下载量 > 250，赞/比 > 5%</p></div>`
    } else {
      grid.innerHTML = `<div class="empty-state"><div class="big">🔮</div><p>${store.processed.length === 0 ? '还没有数据，点击「抓取全部」开始加载' : '没有匹配的 LoRA'}</p></div>`
    }
    const wrap = document.getElementById('loadMoreWrap')
    if (wrap) wrap.style.display = 'none'
    return
  }

  const wrap = document.getElementById('loadMoreWrap')
  if (wrap) wrap.style.display = store.hasMore ? 'flex' : 'none'

  grid.innerHTML = list.map(m => renderCard(m, store.category)).join('')
}

function setText(id: string, text: string) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

function randomPick() {
  const store = useModelStore.getState()
  const filtered = store.getFiltered()
  if (filtered.length === 0) { showToast('⚠️ 当前筛选结果为空'); return }
  const pick = filtered[Math.floor(Math.random() * filtered.length)]
  const card = document.querySelector(`.card[data-uid="${pick.uid}"]`) as HTMLElement
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card.style.transition = 'box-shadow .3s, transform .3s'
    card.style.boxShadow = '0 0 30px var(--accent-glow)'
    card.style.transform = 'translateY(-4px)'
    setTimeout(() => { card.style.boxShadow = ''; card.style.transform = '' }, 2000)
    showToast('🎲 随机选中: ' + pick.name, 'success')
  }
}

function renderArtistImgList(tag: string) {
  const list = document.getElementById('artistImgList')
  if (!list) return
  const imgs = getCustomImages(tag)
  if (imgs.length === 0) {
    list.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--text3);font-size:12px">暂无自定义图片，下方粘贴URL添加</div>'
  } else {
    list.innerHTML = imgs.map((url) =>
      `<div style="position:relative;aspect-ratio:1"><img src="${esc(url)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px"><button class="btn btn-danger" style="position:absolute;top:2px;right:2px;padding:1px 5px;font-size:9px;opacity:.8" onclick="window.__removeArtistImg('${esc(tag)}','${esc(url)}')">✕</button></div>`
    ).join('')
  }
}

function renderSearchHistory() {
  const dd = document.getElementById('searchHistory')
  if (!dd) return
  const searches = getSearches()
  const views = getViews()
  if (searches.length === 0 && views.length === 0) {
    dd.style.display = 'none'
    return
  }
  let html = ''
  if (searches.length > 0) {
    html += `<div class="sh-title">🔍 搜索历史 <button onclick="clearSearches();renderSearchHistory();showToast('已清空搜索历史')">清空</button></div>`
    for (const q of searches) {
      html += `<div class="sh-item" data-action="search" data-query="${esc(q)}"><span class="sh-icon">🕐</span><span class="sh-text">${esc(q)}</span></div>`
    }
  }
  if (views.length > 0) {
    html += `<div class="sh-title" style="margin-top:4px">👁️ 最近浏览</div>`
    for (const v of views) {
      html += `<div class="sh-item" data-action="view" data-url="${esc(v.url)}">${
        v.thumb ? `<img src="${esc(thumbUrl(v.thumb))}" style="width:28px;height:28px;border-radius:4px;object-fit:cover;flex-shrink:0">` : '<span class="sh-icon">📦</span>'
      }<span class="sh-text">${esc(v.name || '未知')}</span></div>`
    }
  }
  dd.innerHTML = html
  dd.style.display = 'block'
  dd.querySelectorAll('.sh-item').forEach(el => {
    el.addEventListener('click', function (this: HTMLElement, e) {
      e.stopPropagation()
      if (this.dataset.action === 'search') {
        const q = this.dataset.query || ''
        ;(document.getElementById('searchInput') as HTMLInputElement).value = q
        useModelStore.getState().setSearch(q)
        refreshView()
      } else if (this.dataset.action === 'view') {
        window.open(this.dataset.url, '_blank')
      }
      dd.style.display = 'none'
    })
  })
}

function openColManage() {
  renderColManageList()
  openModal('colManageModal')
}

function renderColManageList() {
  const list = document.getElementById('colList')
  if (!list) return
  const cols = getCollections()
  list.innerHTML = cols.map(c => {
    const isDefault = c.id === 'default'
    const safeName = esc(c.name)
    const safeId = esc(c.id)
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)">' +
      '<span style="font-size:16px">' + c.icon + '</span>' +
      (isDefault
        ? '<span style="flex:1;font-size:13px">' + safeName + '</span>'
        : '<input class="col-rename-input" data-colid="' + safeId + '" type="text" value="' + safeName + '" style="flex:1;padding:4px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;font-family:var(--font);outline:none">'
      ) +
      '<span style="font-size:11px;color:var(--text3);white-space:nowrap">' + c.count + ' 项</span>' +
      (isDefault ? '' : '<button class="btn btn-danger col-del-btn" style="padding:3px 8px;font-size:10px;opacity:.6" data-colid="' + safeId + '" data-colname="' + safeName + '">✕</button>') +
      '</div>'
  }).join('')

  list.querySelectorAll('.col-rename-input').forEach(inp => {
    inp.addEventListener('change', function (this: HTMLInputElement) {
      renameCollection(this.dataset.colid || '', this.value)
      refreshView()
    })
  })

  // Event delegation for delete collection button
  list.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    const delBtn = target.closest('.col-del-btn') as HTMLElement
    if (delBtn) {
      const colId = delBtn.dataset.colid
      const colName = delBtn.dataset.colname
      if (colId && await confirmModal('删除合集', `确认删除「${colName}」？`)) {
        deleteCollection(colId)
        refreshView()
      }
    }
  })
}

export function setupGlobalHandlers() {
  const w = window as any

  w.__copyText = copyText

  w.__searchByTag = (tag: string) => {
    const input = document.querySelector('.search-wrap input') as HTMLInputElement
    if (input) input.value = tag
    useModelStore.getState().setSearch(tag)
    addSearch(tag)
    refreshView()
    switchSection('lora')
    const artists = getArtists()
    const artist = artists.find(a => a.tag.toLowerCase() === tag.toLowerCase())
    const banner = document.getElementById('artistPreviewBanner')
    if (artist && banner) {
      const autoFilled = [...artist.images]
      if (autoFilled.length === 0) {
        const q = tag.toLowerCase()
        const models = useModelStore.getState().processed
        for (const m of models) {
          if (!m.trainedWords?.some(w => w.toLowerCase() === q)) continue
          for (const img of m.images) {
            if (!autoFilled.includes(img)) autoFilled.push(img)
            if (autoFilled.length >= 3) break
          }
          if (autoFilled.length >= 3) break
        }
      }
      const imgs = getMergedImages(artist.tag, autoFilled).slice(0, 6)
      banner.style.display = imgs.length > 0 ? 'block' : 'none'
      banner.innerHTML = imgs.length > 0 ? `<div style="margin-bottom:16px;padding:16px;background:linear-gradient(135deg,rgba(94,106,210,.08),transparent);border:1px solid var(--border);border-radius:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="font-size:20px;font-weight:700;color:var(--accent)">${esc(artist.tag)}</span>
          <span style="font-size:13px;color:var(--text2)">${esc(artist.name)}</span>
          <span style="font-size:11px;color:var(--text3)">— ${imgs.length} 张示例图</span>
        </div>
        <p style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.5">${esc(artist.desc)}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px">${imgs.map((u,i) => `<img src="${esc(u)}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;cursor:pointer;transition:transform .2s" loading="lazy" onclick="window.__openLightbox(${JSON.stringify(imgs)},${i})">`).join('')}</div>
      </div>` : ''
    } else if (banner) {
      banner.style.display = 'none'
    }
  }

  w.__toggleFav = (id: number, btn: HTMLElement) => {
    const m = useModelStore.getState().processed.find(p => p.id === id)
    if (!m) return
    const added = toggleFav(m)
    btn.textContent = added ? '⭐' : '☆'
    btn.classList.toggle('on', added)
    btn.classList.remove('pop')
    void btn.offsetWidth
    btn.classList.add('pop')
    updateTabs()
  }

  w.__deleteCard = (id: number) => {
    addHidden(id)
    refreshView()
    showToast('🗑️ 已隐藏此 LoRA（可在「已隐藏」标签中恢复）')
  }

  w.__restoreCard = (id: number) => {
    removeHidden(id)
    refreshView()
    showToast('♻️ 已恢复此 LoRA', 'success')
  }

  w.__addViewHistory = (data: { id: number; uid: number; name: string; creator: string; url: string; category: string; thumb: string }) => {
    addView({ ...data, time: Date.now() })
  }

  w.__copyCardInfo = (id: number) => {
    const m = useModelStore.getState().processed.find(p => p.id === id)
    if (!m) return
    const tw = m.trainedWords?.length > 0 ? m.trainedWords.join(', ') : '无'
    const text = '📦 ' + m.name + '\n' +
      '👤 作者: ' + m.creator + '\n' +
      '⬇ 下载: ' + fmtNum(m.stats.downloadCount) + '\n' +
      '👍 点赞: ' + fmtNum(m.stats.thumbsUpCount) + '\n' +
      '📊 赞比: ' + (m.stats.ratio * 100).toFixed(2) + '%\n' +
      '🏷️ 分类: ' + m.categoryLabel + '\n' +
      '🔑 触发词: ' + tw + '\n' +
      '🔗 ' + m.url
    copyText(text)
    showToast('📋 信息已复制', 'success')
  }

  w.__openLightbox = (imgs: string[], idx: number) => openLightbox(imgs, idx)

  w.__openLoraLightbox = (modelId: number, imgIdx: number) => {
    const m = useModelStore.getState().processed.find(p => p.id === modelId)
    if (m?.images?.length) openLightbox(m.images, imgIdx)
  }

  w.__openNotes = (modelId: number) => {
    const store = useModelStore.getState()
    const m = store.processed.find(p => p.id === modelId)
    if (!m) return
    const note = getNote(modelId)
    const modal = document.getElementById('notesModal')
    if (modal) modal.dataset.modelId = String(modelId)

    const nameEl = document.getElementById('notesModalName')
    if (nameEl) nameEl.textContent = '· ' + m.name

    const content = document.getElementById('notesContent') as HTMLTextAreaElement
    if (content) content.value = note?.notes || ''

    const starsContainer = document.getElementById('notesStars')
    if (starsContainer) {
      const r = note?.rating || 0
      starsContainer.innerHTML = Array.from({ length: 5 }, (_, i) =>
        `<button class="star-btn" data-star="${i + 1}" onclick="event.stopPropagation();document.getElementById('notesStars').querySelectorAll('.star-btn').forEach((b,j)=>b.textContent=j<${i + 1}?'★':'☆')">${i < r ? '★' : '☆'}</button>`
      ).join('')
    }

    const statusContainer = document.getElementById('notesQuickStatus')
    if (statusContainer) {
      const cur = note?.status || 'untried'
      statusContainer.innerHTML = ['untried', 'trying', 'success', 'abandoned'].map(s =>
        `<button class="status-btn ${s === cur ? 'active' : ''}" data-status="${s}" onclick="document.getElementById('notesQuickStatus').querySelectorAll('.status-btn').forEach(b=>b.classList.toggle('active',b.dataset.status==='${s}'));this.classList.add('active')">${getModelStatusText(s)}</button>`
      ).join('')
    }

    openModal('notesModal')
  }

  w.__saveNotes = () => {
    const modal = document.getElementById('notesModal')
    const id = parseInt(modal?.dataset.modelId || '0')
    if (!id) return

    const content = (document.getElementById('notesContent') as HTMLTextAreaElement)?.value || ''
    const starsEl = document.getElementById('notesStars')
    let rating = 0
    if (starsEl) {
      rating = [...starsEl.querySelectorAll('.star-btn')].filter(b => b.textContent === '★').length
    }
    const activeStatus = document.querySelector('#notesQuickStatus .status-btn.active')
    const status = (activeStatus as HTMLElement)?.dataset?.status || 'untried'

    saveNote(id, { notes: content, rating, status: status as any })
    closeModal('notesModal')
    refreshView()
    showToast('✅ 备注已保存', 'success')
  }

  w.__copyWorkflowPrompt = (modelId: number, btn: HTMLElement) => {
    const m = useModelStore.getState().processed.find(p => p.id === modelId)
    if (!m || !m.trainedWords?.length) return
    const words = m.trainedWords.join(', ')
    const weight = '0.8'
    const comfyui = m.trainedWords.map(w => `<lora:${m.name.replace(/[^a-zA-Z0-9_]/g, '_')}:${weight}>`).join(' ')
    const prompt = `${words}, masterpiece, best quality, high quality, ${comfyui}`
    copyText(prompt, btn)
    showToast('⚡ 工作流 Prompt 已复制', 'success')
  }

  w.__toggleBatchMode = () => {
    useModelStore.getState().toggleBatchMode()
    const mode = useModelStore.getState().batchMode
    document.body.classList.toggle('batch-mode', mode)
    document.getElementById('batchBar')!.style.display = mode ? 'flex' : 'none'
    if (!mode) refreshView()
    showToast(mode ? '✂️ 选择模式已开启' : '✂️ 选择模式已关闭')
  }

  w.__toggleBatchSelect = (id: number) => {
    useModelStore.getState().toggleBatchSelect(id)
    const count = useModelStore.getState().batchSelected.size
    document.getElementById('batchCount')!.textContent = `已选 ${count} 项`
    refreshView()
  }

  w.__batchFavorite = () => {
    const store = useModelStore.getState()
    const ids = [...store.batchSelected]
    for (const id of ids) {
      const m = store.processed.find(p => p.id === id)
      if (m) toggleFav(m)
    }
    showToast(`⭐ 已收藏 ${ids.length} 个模型`, 'success')
    store.clearBatch()
    document.body.classList.remove('batch-mode')
    document.getElementById('batchBar')!.style.display = 'none'
    refreshView()
    updateTabs()
  }

  w.__batchHide = () => {
    const store = useModelStore.getState()
    const ids = [...store.batchSelected]
    for (const id of ids) addHidden(id)
    showToast(`🗑️ 已隐藏 ${ids.length} 个模型`, 'success')
    store.clearBatch()
    document.body.classList.remove('batch-mode')
    document.getElementById('batchBar')!.style.display = 'none'
    refreshView()
  }

  w.__batchCopy = () => {
    const store = useModelStore.getState()
    const ids = [...store.batchSelected]
    const words: string[] = []
    for (const id of ids) {
      const m = store.processed.find(p => p.id === id)
      if (m?.trainedWords) words.push(...m.trainedWords)
    }
    if (words.length === 0) { showToast('⚠️ 所选模型没有触发词'); return }
    copyText(words.join(', '))
    showToast(`📋 已复制 ${words.length} 个触发词`, 'success')
  }

  w.__extractPrompt = async (modelId: number, word: string, btn: HTMLElement) => {
    try {
      const store = useModelStore.getState()
      const m = store.processed.find(p => p.id === modelId)
      if (!m) { showToast('⚠️ 未找到模型数据'); return }

      // Check if already extracted
      const count = await getPromptCountByModel(modelId)

      btn.textContent = '✅'
      btn.style.background = '#34d399'

      const modal = document.getElementById('promptEditModal')
      if (modal) {
        modal.dataset.editId = 'new_' + Date.now()
        modal.dataset.sourceModelId = String(m.id)
        modal.dataset.sourceModelName = m.name
        modal.dataset.sourceModelUrl = m.url
        modal.dataset.sourceModelCategory = m.category
        modal.dataset.promptImages = JSON.stringify(m.images || [])
        modal.dataset.editTags = m.tags?.join(',') || word
      }

      // Prefill editor
      const { renderPromptEditor } = await import('../components/PromptEditor')
      renderPromptEditor({
        id: 'prefill',
        prompt: word,
        displayText: word,
        tags: m.tags || [],
        loras: [],
        categoryId: 'uncategorized',
        notes: count > 0 ? `📦 已从该模型提取 ${count + 1} 个 Prompt` : '',
        images: m.images || [],
        primaryImage: m.images?.[0] || '',
      })

      const { openModal } = await import('../components/Modal')
      openModal('promptEditModal')

      showToast('📥 已预填 Prompt 信息，点击保存即可加入库中', 'success')
    } catch (err) {
      showToast('❌ 提取失败: ' + (err as Error).message)
    }
  }

  w.__editArtistImages = (tag: string) => {
    const modal = document.getElementById('artistImgModal')
    const desc = document.getElementById('artistImgModalDesc')
    if (desc) desc.textContent = '为 ' + tag + ' 管理自定义预览图片'
    if (modal) {
      modal.setAttribute('data-artist-tag', tag)
      renderArtistImgList(tag)
    }
    ;(document.getElementById('artistImgUrl') as HTMLInputElement).value = ''
    setText('artistImgStatus', '')
    openModal('artistImgModal')
  }

  w.__removeArtistImg = (tag: string, url: string) => {
    removeArtistImage(tag, url)
    renderArtistImgList(tag)
    renderArtists()
  }

  w.__deleteArtist = (tag: string) => {
    deleteArtist(tag)
    renderArtists()
    showToast('🗑️ 已删除画师 ' + tag)
  }

  w.renderArtists = renderArtists
  w.addArtistFromExtraction = addArtistFromExtraction
  w.showToast = showToast

  w.__deleteCol = (colId: string) => {
    deleteCollection(colId)
    renderColManageList()
    refreshView()
  }

  // Lightbox event listeners
  document.querySelector('.lightbox .close')?.addEventListener('click', () => closeLightbox())
  document.querySelectorAll('.lightbox .lb-nav').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const dir = parseInt((b as HTMLElement).dataset.dir || ((b as HTMLElement).classList.contains('prev') ? '-1' : '1'))
      navLightbox(dir)
    })
  })
  document.getElementById('lightbox')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLightbox()
  })

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const lightbox = document.getElementById('lightbox')
    if (lightbox?.classList.contains('open')) {
      if (e.key === 'Escape') closeLightbox()
      if (e.key === 'ArrowLeft') { e.preventDefault(); navLightbox(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); navLightbox(1) }
    } else {
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !(e.target as HTMLElement).closest('input,textarea')) {
        randomPick()
      }
    }
  })
}

export function setupBindingListeners() {
  // Section switching
  document.getElementById('mainTabs')?.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.main-tab') as HTMLElement
    if (tab) switchSection(tab.dataset.section as 'lora' | 'artist' | 'prompt' | 'local' | 'outputs')
  })

  // Category tabs
  document.getElementById('tabsContainer')?.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab') as HTMLElement
    if (tab) {
      useModelStore.getState().setCategory(tab.dataset.cat || 'all')
      refreshView()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  })

  // Collection sub-tabs
  document.getElementById('colTabs')?.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab') as HTMLElement
    if (!tab) return
    const colId = tab.dataset.colid
    if (colId) {
      setActiveCol(colId)
      refreshView()
    } else if (tab.id === 'manageColBtn') {
      openColManage()
    }
  })

  // Search
  const searchInput = document.getElementById('searchInput') as HTMLInputElement
  if (searchInput) {
    let searchTimer: ReturnType<typeof setTimeout>
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        useModelStore.getState().setSearch(searchInput.value)
        refreshView()
      }, 400)
    })
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addSearch(searchInput.value)
        renderSearchHistory()
      }
    })
    searchInput.addEventListener('focus', () => renderSearchHistory())
    document.addEventListener('click', (e) => {
      const dd = document.getElementById('searchHistory')
      if (dd && !(e.target as HTMLElement).closest('.search-wrap')) dd.style.display = 'none'
    })
  }

  // Sort
  document.getElementById('sortSelect')?.addEventListener('change', (e) => {
    useModelStore.getState().setSort((e.target as HTMLSelectElement).value as any)
    refreshView()
  })

  // Quality filter
  document.getElementById('qualityFilter')?.addEventListener('change', (e) => {
    useModelStore.getState().setQualityFilter((e.target as HTMLSelectElement).value)
    refreshView()
  })

  document.getElementById('baseModelFilter')?.addEventListener('change', (e) => {
    useModelStore.getState().setFilterBaseModel((e.target as HTMLSelectElement).value)
    refreshView()
  })

  // Batch mode buttons
  document.getElementById('batchCloseBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__toggleBatchMode) w.__toggleBatchMode()
  })
  document.getElementById('batchFavBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__batchFavorite) w.__batchFavorite()
  })
  document.getElementById('batchHideBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__batchHide) w.__batchHide()
  })
  document.getElementById('batchCopyBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__batchCopy) w.__batchCopy()
  })

  // Notes modal
  document.getElementById('notesSaveBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__saveNotes) w.__saveNotes()
  })

  // Buttons
  document.getElementById('fetchBtn')?.addEventListener('click', () => fetchAll())
  document.getElementById('loadMoreBtn')?.addEventListener('click', () => loadMore())
  document.getElementById('randomBtn')?.addEventListener('click', () => randomPick())
  document.getElementById('batchModeBtn')?.addEventListener('click', () => {
    const w = window as any
    if (w.__toggleBatchMode) w.__toggleBatchMode()
  })
  document.getElementById('autoBtn')?.addEventListener('click', () => toggleAuto())

  // Add LoRA modal
  document.getElementById('addLoraBtn')?.addEventListener('click', () => {
    openModal('addModal')
    const input = document.getElementById('addUrlInput') as HTMLInputElement
    if (input) { input.value = ''; input.focus() }
    setText('addStatus', '')
  })
  document.getElementById('addConfirmBtn')?.addEventListener('click', async () => {
    const url = (document.getElementById('addUrlInput') as HTMLInputElement).value.trim()
    const status = document.getElementById('addStatus')
    if (!url) { if (status) status.textContent = '⚠️ 请输入 Civitai URL'; return }
    if (status) status.textContent = '⏳ 正在获取…'
    try {
      const parts = url.split('civitai.com/models/')
      if (parts.length < 2) throw new Error('❌ 无效的 Civitai URL')
      const idStr = parts[1].split('/')[0].split('?')[0]
      const id = parseInt(idStr)
      if (isNaN(id) || id <= 0) throw new Error('❌ 无法从 URL 中提取模型 ID')
      const customList = Cache.load<any[]>('custom_loras', 365 * 24 * 60 * 60 * 1000) || []
      if (customList.some((c: any) => c.id === id)) throw new Error('⚠️ 该 LoRA 已添加过')
      const data = await fetchModelById(id)
      if (!data?.id) throw new Error('❌ 未能获取模型信息')
      customList.unshift(data)
      if (customList.length > 100) customList.length = 100
      Cache.save('custom_loras', customList)
      if (status) status.textContent = '✅ 添加成功！'
      useModelStore.getState().rebuild()
      refreshView()
      setTimeout(() => closeModal('addModal'), 1500)
    } catch (err) {
      if (status) status.textContent = (err as Error).message
    }
  })

  // Collection management buttons
  document.getElementById('createColBtn')?.addEventListener('click', () => {
    const input = document.getElementById('newColName') as HTMLInputElement
    const name = input.value.trim()
    if (!name) { showToast('⚠️ 请输入收藏夹名称'); return }
    createCollection(name)
    input.value = ''
    renderColManageList()
    refreshView()
    showToast('✅ 收藏夹「' + name + '」已创建', 'success')
  })
  document.getElementById('exportFavBtn')?.addEventListener('click', () => {
    const data = exportFavData()
    if (!data) { showToast('⚠️ 没有可导出的数据'); return }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'civitai_favorites_' + new Date().toISOString().slice(0, 10) + '.json'
    a.click()
    URL.revokeObjectURL(url)
    showToast('📤 收藏夹已导出', 'success')
  })
  document.getElementById('importFavBtn')?.addEventListener('click', () => {
    document.getElementById('importFavFile')?.click()
  })
  document.getElementById('importFavFile')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string)
        if (importFavData(data)) {
          renderColManageList()
          refreshView()
          showToast('📥 收藏夹已导入', 'success')
        } else {
          showToast('⚠️ 无效的收藏夹数据格式')
        }
      } catch (err) {
        showToast('❌ 导入失败: ' + (err as Error).message)
      }
    }
    reader.readAsText(file)
    ;(e.target as HTMLInputElement).value = ''
  })

  // Extract artist from data
  document.getElementById('extractArtistBtn')?.addEventListener('click', () => {
    const store = useModelStore.getState()
    const processed = store.processed
    const trainedWords = processed.map(m => m.trainedWords)
    const found = extractArtistsFromModels(trainedWords)
    if (found.length === 0) { showToast('⚠️ 没有找到画师标签'); return }

    const existing = new Set(getArtists().map(a => a.tag))

    const tagSources: Record<string, string[]> = {}
    for (const m of processed) {
      for (const w of m.trainedWords) {
        const t = w.trim()
        if (t.startsWith('@') && t.length > 2) {
          if (!tagSources[t]) tagSources[t] = []
          if (!tagSources[t].includes(m.name)) tagSources[t].push(m.name)
        }
      }
    }

    const container = document.getElementById('artistExtractList')
    if (!container) return

    const newCount = found.filter(f => !existing.has(f.tag)).length

    container.innerHTML = `<div style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center">
      <span style="font-size:12px;color:var(--text2)">发现 <b>${found.length}</b> 个画师标签，<b style="color:var(--green)">${newCount}</b> 个可添加</span>
      ${newCount > 0 ? `<button class="btn btn-primary" id="extractAddAllBtn" style="padding:4px 12px;font-size:10px;margin-left:auto">➕ 添加全部 (${newCount})</button>` : ''}
    </div>`
    + found.map(f => {
      const already = existing.has(f.tag)
      const sources = tagSources[f.tag] || []
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)">
        <span style="font-size:16px;width:24px;text-align:center">🎨</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-family:'Courier New',monospace;color:var(--accent)">${esc(f.tag)}</div>
          <div style="font-size:9px;color:var(--text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            出现 ${f.count} 次 · 来源: ${sources.slice(0, 3).join(', ')}${sources.length > 3 ? ` 等 ${sources.length} 个模型` : ''}
          </div>
        </div>
        ${already
          ? '<span style="font-size:10px;color:var(--text3);white-space:nowrap">✅ 已存在</span>'
          : `<button class="btn btn-primary extract-add-one" data-tag="${escAttr(f.tag)}" data-count="${f.count}" style="padding:3px 10px;font-size:10px;white-space:nowrap">➕ 添加</button>`
        }
      </div>`
    }).join('')
    openModal('artistExtractModal')
  })

  // Extract modal event delegation (add single / add all)
  document.getElementById('artistExtractModal')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement

    if (target.id === 'extractAddAllBtn') {
      const btns = document.querySelectorAll('#artistExtractList .extract-add-one:not([disabled])')
      let added = 0
      btns.forEach(btn => {
        const tag = (btn as HTMLElement).dataset.tag
        const count = parseInt((btn as HTMLElement).dataset.count || '1')
        if (tag && addArtistFromExtraction(tag, count)) added++
        btn.setAttribute('disabled', 'disabled')
      })
      if (added > 0) {
        showToast(`✅ 已添加 ${added} 个画师`, 'success')
        renderArtists()
        document.getElementById('extractArtistBtn')?.click()
      }
      return
    }

    const addBtn = target.closest('.extract-add-one') as HTMLElement
    if (addBtn) {
      const tag = addBtn.dataset.tag
      const count = parseInt(addBtn.dataset.count || '1')
      if (tag && addArtistFromExtraction(tag, count)) {
        showToast(`✅ 已添加 ${tag}`, 'success')
        renderArtists()
        document.getElementById('extractArtistBtn')?.click()
      }
      return
    }
  })

  // Artist modals handled by ArtistSeries.ts bindArtistEvents()

  // Global gallery click delegation
  document.addEventListener('click', handleGalleryClick)

  // Version dropdown toggle
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const btn = target.closest('.version-dropdown-btn') as HTMLElement
    if (btn) {
      e.stopPropagation()
      const wrap = btn.closest('.version-dropdown-wrap') as HTMLElement
      if (!wrap) return
      // 关闭其他 dropdown
      document.querySelectorAll('.version-dropdown').forEach(d => { if (d !== wrap.querySelector('.version-dropdown')) (d as HTMLElement).style.display = 'none' })
      const dd = wrap.querySelector('.version-dropdown') as HTMLElement
      dd.style.display = dd.style.display === 'none' ? 'block' : 'none'
      return
    }
    const opt = target.closest('.version-option') as HTMLElement
    if (opt) {
      e.stopPropagation()
      const url = opt.dataset.url
      if (url) { window.open(url, '_blank'); return }
    }
    // 点击外部关闭所有 dropdown
    if (!target.closest('.version-dropdown-wrap')) {
      document.querySelectorAll('.version-dropdown').forEach(d => (d as HTMLElement).style.display = 'none')
    }
  })

  // Period buttons
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setPeriod((btn as HTMLElement).dataset.period as 'AllTime' | 'Month' | 'Week')
    })
  })
}

function handleGalleryClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('.gallery-btn') as HTMLElement
  if (btn) {
    e.stopPropagation()
    const g = btn.closest('.gallery') as HTMLElement
    if (!g) return
    const t = g.querySelector('.gallery-track') as HTMLElement
    if (!t || t.children.length <= 1) return
    const card = btn.closest('.card') as HTMLElement
    const uid = parseInt(card?.dataset.uid || '0') || 0
    const cur = galleryPos[uid] ?? 0
    const n = cur + parseInt(btn.dataset.dir || '0')
    const imgs = t.children.length
    const clamped = ((n % imgs) + imgs) % imgs
    t.style.transform = `translateX(-${clamped * 100}%)`
    g.querySelectorAll('.gallery-dots span').forEach((s, i) => s.classList.toggle('active', i === clamped))
    galleryPos[uid] = clamped
    return
  }

  const img = (e.target as HTMLElement).closest('.gallery-track img') as HTMLElement
  if (img && img.dataset.uid) {
    e.stopPropagation()
    const idx = parseInt(img.dataset.imgidx || '0')
    const track = img.closest('.gallery-track')
    let fullUrls: string[] = []
    if (track) {
      fullUrls = [...track.querySelectorAll('img')].map(el => (el as HTMLElement).dataset.fullurl || (el as HTMLImageElement).src).filter(Boolean)
    }
    if (fullUrls.length > 0) openLightbox(fullUrls, idx)
    return
  }

  const dot = (e.target as HTMLElement).closest('.gallery-dots span') as HTMLElement
  if (dot && dot.dataset.uid) {
    e.stopPropagation()
    const g = dot.closest('.gallery') as HTMLElement
    if (!g) return
    const t = g.querySelector('.gallery-track') as HTMLElement
    if (!t) return
    const idx = parseInt(dot.dataset.imgidx || '0')
    t.style.transform = `translateX(-${idx * 100}%)`
    g.querySelectorAll('.gallery-dots span').forEach((s, i) => s.classList.toggle('active', i === idx))
    const uid = parseInt(dot.dataset.uid || g.dataset.uid || '0')
    if (uid) galleryPos[uid] = idx
  }
}
