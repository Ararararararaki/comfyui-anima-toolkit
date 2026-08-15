import {
  getAllCards, getCardsByCategory, searchCards, searchCardsByCategory,
  getCard, addCard, updateCard, deleteCard, bulkAddCards,
  generateCardId, getAllCategories, addCategory, updateCategory, deleteCategory as dbDeleteCategory,
  generateCategoryId, initClothingDB, drawCards, joinCardPrompts,
} from '../store/clothingDb'
import { renderClothingCard } from '../components/ClothingCard'
import { esc, icon, showToast, attachSearchClear, debounce } from '../utils'
import { openModal, closeModal, confirmModal, promptModal } from '../components/Modal'
import type { ClothingCard, ClothingCategory } from '../types'

// ── 服装卡片库：平铺分类 + 卡片网格 + 抽卡 ──

let currentCategory = ''   // '' = 全部, 'fav' = 收藏, 其他 = 分类 id
let currentSearch = ''
let listLoadSeq = 0
let selectedIds = new Set<string>()   // 点卡片/拖拽框选即选中，无开关
const PAGE_SIZE = 60
let page = 1
const objUrlCache = new Map<string, string>()   // card.id -> objectURL（imageBlob 渲染缓存）

function container(): HTMLElement | null {
  return document.getElementById('clothingGrid')
}

function ensureObjUrls(cards: ClothingCard[]) {
  for (const c of cards) {
    if (c.imageBlob && !objUrlCache.has(c.id)) {
      try { objUrlCache.set(c.id, URL.createObjectURL(c.imageBlob)) } catch { /* 忽略坏 Blob */ }
    }
  }
}

// ── 渲染 ──

// 当前视图的卡片（按分类/收藏/搜索过滤）
async function currentViewCards(): Promise<ClothingCard[]> {
  if (currentCategory === 'fav') {
    const all = currentSearch ? await searchCards(currentSearch) : await getAllCards()
    return all.filter(c => c.favorite)
  }
  if (currentCategory) {
    return currentSearch ? await searchCardsByCategory(currentSearch, currentCategory) : await getCardsByCategory(currentCategory)
  }
  return currentSearch ? await searchCards(currentSearch) : await getAllCards()
}

export async function renderClothingLibrary() {
  const grid = container()
  if (!grid) return
  const seq = ++listLoadSeq
  await renderCats()

  const cards = await currentViewCards()
  if (seq !== listLoadSeq) return

  ensureObjUrls(cards)
  const totalPages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE))
  if (page > totalPages) page = totalPages
  const pageCards = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  grid.innerHTML = pageCards.map(c => renderClothingCard(c, objUrlCache.get(c.id), selectedIds.has(c.id))).join('')
  renderPagination(cards.length, totalPages)
  updateBatchBar()
}

// 分页条（每页 60 张；页码最多显示 7 个，超出用省略号）
function renderPagination(total: number, totalPages: number) {
  const box = document.getElementById('clothingPagination')
  if (!box) return
  if (totalPages <= 1) { box.innerHTML = ''; return }
  const pages: (number | '...')[] = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else {
    pages.push(1)
    if (page > 3) pages.push('...')
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i)
    if (page < totalPages - 2) pages.push('...')
    pages.push(totalPages)
  }
  box.innerHTML = `
    <button class="clothing-page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${icon('chevronLeft', 12)}</button>
    ${pages.map(p => p === '...'
      ? '<span class="clothing-page-dots">…</span>'
      : `<button class="clothing-page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`).join('')}
    <button class="clothing-page-btn" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>${icon('chevronRight', 12)}</button>
    <span class="clothing-page-info">共 ${total} 张 · 第 ${page}/${totalPages} 页</span>`
}

async function gotoPage(n: number) {
  const cards = await currentViewCards()
  const totalPages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE))
  page = Math.max(1, Math.min(n, totalPages))
  await renderClothingLibrary()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 多选批量条：有选中时显示（点卡片即选中、拖拽即框选，无需开关）
function updateBatchBar() {
  const bar = document.getElementById('clothingBatchBar')
  const countEl = document.getElementById('clothingSelCount')
  if (countEl) countEl.textContent = String(selectedIds.size)
  if (bar) bar.style.display = selectedIds.size > 0 ? 'flex' : 'none'
  // 选中态同步到卡片 DOM（删除/刷新后勾选框状态保持）
  document.querySelectorAll('#clothingGrid .clothing-card').forEach(el => {
    const id = el.getAttribute('data-card-id') || ''
    el.classList.toggle('selected', selectedIds.has(id))
    const check = el.querySelector('[data-check]')
    if (check) check.classList.toggle('on', selectedIds.has(id))
  })
}

function toggleCardSelect(id: string) {
  if (selectedIds.has(id)) selectedIds.delete(id)
  else selectedIds.add(id)
  updateBatchBar()
}

function clearSelection() {
  selectedIds.clear()
  updateBatchBar()
}

async function deleteSelected() {
  if (!selectedIds.size) return
  const ok = await confirmModal('批量删除', `确认删除选中的 ${selectedIds.size} 张卡片？\n删除后不可恢复！`)
  if (!ok) return
  for (const id of selectedIds) await deleteCard(id)
  showToast(`🗑️ 已删除 ${selectedIds.size} 张卡片`)
  selectedIds.clear()
  await renderClothingLibrary()
}

async function renderCats() {
  const catsEl = document.getElementById('clothingCats')
  if (!catsEl) return
  const cats = await getAllCategories()
  const all = await getAllCards()
  const favCount = all.filter(c => c.favorite).length
  const catCount = (id: string) => all.filter(c => c.categoryId === id).length

  const tab = (id: string, name: string, count: number) =>
    `<button class="clothing-cat-tab ${currentCategory === id ? 'active' : ''}" data-cat="${esc(id)}">${esc(name)}<span class="count">${count}</span></button>`

  catsEl.innerHTML =
    tab('', '全部', all.length) +
    tab('fav', '收藏', favCount) +
    cats.map(c => tab(c.id, c.name, catCount(c.id))).join('')
}

// ── 工具栏绑定 ──

function bindToolbar() {
  document.getElementById('clothingAddBtn')?.addEventListener('click', () => openClothingEditor())
  document.getElementById('clothingGachaBtn')?.addEventListener('click', () => openGachaModal())
  document.getElementById('clothingNewCatBtn')?.addEventListener('click', () => (window as any).__clothingAddCategory())
  document.getElementById('clothingDelSelBtn')?.addEventListener('click', deleteSelected)
  document.getElementById('clothingMoveBtn')?.addEventListener('click', moveSelectedToCategory)
  document.getElementById('clothingSelCancelBtn')?.addEventListener('click', clearSelection)
  document.getElementById('clothingImportBtn')?.addEventListener('click', () => {
    document.getElementById('clothingImportFile')?.click()
  })
  document.getElementById('clothingExportBtn')?.addEventListener('click', () => exportClothing())
  const fileInput = document.getElementById('clothingImportFile') as HTMLInputElement
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      await importClothingJson(text)
    } catch (e) {
      showToast('导入失败：' + (e as Error).message)
    } finally {
      fileInput.value = ''
    }
  })
  const searchInput = document.getElementById('clothingSearch') as HTMLInputElement
  if (searchInput) {
    searchInput.addEventListener('input', debounceSearch)
    attachSearchClear(searchInput, async () => { currentSearch = ''; await renderClothingLibrary() })
  }
}

const debounceSearch = debounce(async () => {
  const input = document.getElementById('clothingSearch') as HTMLInputElement
  currentSearch = input?.value || ''
  page = 1
  await renderClothingLibrary()
}, 250)

// ── 导入（clothing-import.json，由 scripts/import-clothing.mjs 生成）──

let importing = false   // 导入锁：防止快速重复触发导致双写

export async function importClothingJson(text: string) {
  if (importing) { showToast('⏳ 正在导入，请稍候…'); return }
  importing = true
  try {
    const data = JSON.parse(text)
    if (data.schemaVersion !== 1 || !Array.isArray(data.cards)) {
      throw new Error('文件格式不对（不是服装库导入文件）')
    }
    const selected = await showImportPreview(data.cards)
    if (!selected) { showToast('已取消导入'); return }
    await doImport(data, selected.cards, selected.useFileCats)
  } finally {
    importing = false
  }
}

// 预览弹窗：分类折叠列表 + 展开后卡片缩略图，可勾选到单张
// 返回 { cards: 选中的卡片数组, useFileCats: 是否按文件分类导入 }；取消返回 null
// 每次调用重建弹窗（不复用 DOM），避免确认按钮闭包捕获上一次的 resolve
function showImportPreview(allCards: any[]): Promise<{ cards: any[]; useFileCats: boolean } | null> {
  return new Promise((resolve) => {
    document.getElementById('clothingImportModal')?.remove()
    const modal = document.createElement('div')
    modal.id = 'clothingImportModal'
    modal.className = 'modal-overlay'
    modal.innerHTML = `
      <div class="modal-box" style="max-width:760px">
        <h3>${icon('download', 16)} 导入服装卡片</h3>
        <p class="sub" style="margin:6px 0 10px">点分类行展开看卡片图，勾选到单张；分类前的框 = 一键全选/全不选该类</p>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);margin-bottom:8px;cursor:pointer">
          <input type="checkbox" id="ciUseFileCats">
          按文件分类导入（不勾 = 全部进「未分类」，导入后你自己分类/收藏）
        </label>
        <div id="ciCats" style="display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto;padding-right:4px"></div>
        <div class="modal-actions" style="margin-top:12px">
          <button class="btn btn-ghost" id="ciAllBtn">全选</button>
          <button class="btn btn-ghost" id="ciNoneBtn">全不选</button>
          <span style="flex:1"></span>
          <button class="btn btn-ghost" id="ciCancelBtn">取消</button>
          <button class="btn btn-primary" id="ciOkBtn" data-primary>导入选中 (0 张)</button>
        </div>
      </div>`
    document.body.appendChild(modal)

    // 按分类分组（保序）
    const cats: string[] = []
    const byCat = new Map<string, number[]>()
    allCards.forEach((c, idx) => {
      const cat = String(c.category || '未分类')
      if (!byCat.has(cat)) { byCat.set(cat, []); cats.push(cat) }
      byCat.get(cat)!.push(idx)
    })

    const selectedIdx = new Set<number>(allCards.map((_, i) => i))   // 默认全选
    const expandedCat = new Set<string>()   // 展开的分类
    const catsBox = document.getElementById('ciCats')
    if (!catsBox) return

    const thumb = (c: any) => c.imageBase64
      ? `<img src="data:image/jpeg;base64,${c.imageBase64}" loading="lazy" alt="">`
      : `<span class="ci-card-noimg">${esc(String(c.name || '?').slice(0, 6))}</span>`

    const renderCards = (cat: string) => {
      const box = catsBox.querySelector(`[data-catbox="${esc(cat)}"]`) as HTMLElement
      if (!box) return
      box.innerHTML = byCat.get(cat)!.map(idx => {
        const c = allCards[idx]
        const on = selectedIdx.has(idx)
        return `<label class="ci-card ${on ? 'on' : ''}" data-idx="${idx}">
          <input type="checkbox" data-idx="${idx}" ${on ? 'checked' : ''}>
          <div class="ci-card-img">${thumb(c)}</div>
          <span class="ci-card-name" title="${esc(String(c.prompt || '').slice(0, 80))}">${esc(String(c.name || ''))}</span>
        </label>`
      }).join('')
    }

    const syncCatCheck = (cat: string) => {
      const idxs = byCat.get(cat) || []
      const onCount = idxs.filter(i => selectedIdx.has(i)).length
      const box = catsBox.querySelector(`[data-catcheck="${esc(cat)}"]`) as HTMLInputElement
      if (!box) return
      box.checked = onCount === idxs.length && idxs.length > 0
      box.indeterminate = onCount > 0 && onCount < idxs.length
    }

    const updateCount = () => {
      const n = selectedIdx.size
      const okBtn = document.getElementById('ciOkBtn')
      if (okBtn) okBtn.textContent = `导入选中 (${n} 张)`
    }

    // 分类行：checkbox + 名称 + 数量 + 展开箭头
    catsBox.innerHTML = cats.map(cat => {
      const cnt = byCat.get(cat)!.length
      return `<div class="ci-cat" data-catname="${esc(cat)}">
        <div class="ci-cat-head">
          <input type="checkbox" data-catcheck="${esc(cat)}" checked>
          <span class="ci-cat-name">${esc(cat)}</span>
          <span class="ci-cat-count">${cnt} 张</span>
          <button class="ci-cat-toggle" data-cat="${esc(cat)}" title="展开/收起">▸</button>
        </div>
        <div class="ci-cat-cards" data-catbox="${esc(cat)}" style="display:none"></div>
      </div>`
    }).join('')

    // 分类 checkbox：一键全选/全不选该类
    catsBox.querySelectorAll<HTMLInputElement>('[data-catcheck]').forEach(box => {
      box.addEventListener('change', () => {
        const cat = box.getAttribute('data-catcheck') || ''
        for (const idx of byCat.get(cat) || []) {
          if (box.checked) selectedIdx.add(idx); else selectedIdx.delete(idx)
        }
        renderCards(cat)
        updateCount()
      })
    })
    // 卡片 checkbox：单张切换
    catsBox.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement
      if (!target.matches('[data-idx]')) return
      const idx = Number(target.getAttribute('data-idx'))
      if (target.checked) selectedIdx.add(idx); else selectedIdx.delete(idx)
      const cardEl = target.closest('.ci-card')
      if (cardEl) cardEl.classList.toggle('on', target.checked)
      const cat = (target.closest('.ci-cat') as HTMLElement)?.getAttribute('data-catname') || ''
      // 分类名存在 data-catname 上（渲染时补）
      syncCatCheck(cat)
      updateCount()
    })
    // 展开/折叠
    catsBox.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.ci-cat-toggle') as HTMLElement
      if (!btn) return
      const cat = btn.getAttribute('data-cat') || ''
      const cardsEl = catsBox.querySelector(`[data-catbox="${esc(cat)}"]`) as HTMLElement
      const head = btn.closest('.ci-cat-head') as HTMLElement
      if (!cardsEl) return
      if (cardsEl.style.display === 'none') {
        cardsEl.style.display = 'grid'
        btn.textContent = '▾'
        if (head) head.setAttribute('data-open', '1')
        if (!expandedCat.has(cat)) { expandedCat.add(cat); renderCards(cat) }
      } else {
        cardsEl.style.display = 'none'
        btn.textContent = '▸'
        if (head) head.removeAttribute('data-open')
      }
    })

    const done = (val: { cards: any[]; useFileCats: boolean } | null) => { modal.classList.remove('open'); resolve(val) }
    modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) done(null) })
    document.getElementById('ciCancelBtn')?.addEventListener('click', () => done(null))
    document.getElementById('ciOkBtn')?.addEventListener('click', () => {
      const useFileCats = !!(document.getElementById('ciUseFileCats') as HTMLInputElement)?.checked
      done({ cards: allCards.filter((_, i) => selectedIdx.has(i)), useFileCats })
    })
    document.getElementById('ciAllBtn')?.addEventListener('click', () => {
      allCards.forEach((_, i) => selectedIdx.add(i))
      cats.forEach(cat => { renderCards(cat); syncCatCheck(cat) })
      updateCount()
    })
    document.getElementById('ciNoneBtn')?.addEventListener('click', () => {
      selectedIdx.clear()
      cats.forEach(cat => { renderCards(cat); syncCatCheck(cat) })
      updateCount()
    })
    updateCount()
    openModal('clothingImportModal')
  })
}

// 执行导入（合并模式：只加不删 + 查重跳过；useFileCats=false 时全部进「未分类」由用户自己分类）
async function doImport(data: any, selectedCards: any[], useFileCats: boolean) {
  if (!selectedCards.length) { showToast('没有选中的卡片'); return }
  // 现有卡片 prompt 索引（查重用）
  const existing = await getAllCards()
  const promptToCard = new Map<string, ClothingCard>()   // norm(prompt) -> 现有卡
  for (const c of existing) {
    const key = norm(c.prompt)
    if (!promptToCard.has(key)) promptToCard.set(key, c)
  }
  // 分类：useFileCats 时按文件分类建/复用；否则全部未分类
  const existingCats = await getAllCategories()
  const catIdMap = new Map<string, string>()
  for (const c of existingCats) catIdMap.set(c.name, c.id)
  let newCatCount = 0
  if (useFileCats) {
    const needCats: string[] = []
    for (const c of selectedCards) {
      const name = String(c.category || '未分类')
      if (!needCats.includes(name)) needCats.push(name)
    }
    for (const [i, name] of needCats.entries()) {
      if (catIdMap.has(name)) continue
      const id = generateCategoryId()
      await addCategory({ id, name, sortOrder: 100 + i })
      catIdMap.set(name, id)
      newCatCount++
    }
  }
  const now = Date.now()
  const cards: ClothingCard[] = []
  let skipped = 0      // 查重跳过的
  let recategorized = 0  // 重复但分类不同 → 更新现有卡分类（恢复分组）
  for (const c of selectedCards) {
    const prompt = String(c.prompt || '').trim()
    if (!prompt) continue
    const key = norm(prompt)
    const dup = promptToCard.get(key)
    const fileCat = useFileCats ? String(c.category || '未分类') : '未分类'
    if (dup) {
      // 重复：不新增；若勾了按文件分类且现有卡分类不同 → 把现有卡移入文件分类
      if (useFileCats) {
        const targetId = catIdMap.get(fileCat) || 'uncategorized'
        if (dup.categoryId !== targetId) {
          await updateCard(dup.id, { categoryId: targetId })
          recategorized++
        }
      }
      skipped++
      continue
    }
    cards.push({
      id: generateCardId(),
      name: String(c.name || '未命名'),
      prompt,
      categoryId: useFileCats ? (catIdMap.get(fileCat) || 'uncategorized') : 'uncategorized',
      tags: prompt.split(',').map(t => t.trim()).filter(Boolean),
      imageBlob: c.imageBase64 ? base64ToBlob(c.imageBase64, c.imageMime || 'image/jpeg') : undefined,
      imageUrl: c.imageUrl || undefined,
      favorite: !!c.favorite,
      useCount: 0,
      source: 'import',
      createdAt: now + Math.random(),
      updatedAt: now,
    })
  }
  if (cards.length) await bulkAddCards(cards)
  const parts = [`导入 ${cards.length} 张`]
  if (skipped) parts.push(`跳过重复 ${skipped} 张`)
  if (recategorized) parts.push(`更新分类 ${recategorized} 张`)
  if (newCatCount) parts.push(`新增分类 ${newCatCount} 个`)
  showToast(`✅ ${parts.join('，')}`)
  currentCategory = ''
  currentSearch = ''
  page = 1
  await renderClothingLibrary()
}

// 串归一化（查重/键名匹配用）：去首尾空白/逗号、转小写
function norm(s: string): string {
  return String(s || '').replace(/^[\s,]+|[\s,]+$/g, '').trim().toLowerCase()
}

// ── 导出备份（全部卡片含图 → JSON 文件，可再导入恢复）──

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).split(',')[1] || '')
    r.onerror = rej
    r.readAsDataURL(blob)
  })
}

async function buildExportJson(): Promise<{ text: string; count: number }> {
  const cats = await getAllCategories()
  const cards = await getAllCards()
  const catName = new Map(cats.map(c => [c.id, c.name]))
  const outCards: any[] = []
  for (const c of cards) {
    let b64: string | undefined
    let mime: string | undefined
    if (c.imageBlob) {
      try {
        b64 = await blobToBase64(c.imageBlob)
        mime = c.imageBlob.type || 'image/jpeg'
      } catch { /* 单张图片转换失败不阻塞导出 */ }
    }
    outCards.push({
      name: c.name,
      prompt: c.prompt,
      category: catName.get(c.categoryId) || '未分类',
      ...(b64 ? { imageBase64: b64, imageMime: mime } : {}),
      ...(c.imageUrl ? { imageUrl: c.imageUrl } : {}),
      favorite: c.favorite,
    })
  }
  const text = JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    categories: Array.from(catName.values()).map(name => ({ name })),
    cards: outCards,
  })
  return { text, count: cards.length }
}

async function exportClothing() {
  const { text, count } = await buildExportJson()
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `clothing-export-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
  showToast(`✅ 已导出 ${count} 张卡片（含图片，可随时再导入恢复）`)
}

// ── 批量移动分类（选中卡片 → 指定分类）──

async function moveSelectedToCategory() {
  if (!selectedIds.size) { showToast('先选中卡片'); return }
  const cats = await getAllCategories()
  // 轻量选择弹窗：下拉选已有分类 + 或输入新分类名
  const modal = document.createElement('div')
  modal.id = 'clothingMoveModal'
  modal.className = 'modal-overlay'
  modal.innerHTML = `
    <div class="modal-box" style="max-width:400px">
      <h3>${icon('folder', 16)} 移动选中卡片到分类</h3>
      <p class="sub" style="margin:6px 0 10px">已选 ${selectedIds.size} 张；选已有分类或输入新分类名</p>
      <select id="cmCatSel" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;outline:none;font-family:var(--font)">
        ${cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
      </select>
      <input type="text" id="cmNewCat" placeholder="或输入新分类名（留空用上面的）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;outline:none;font-family:var(--font);margin-top:8px;box-sizing:border-box">
      <div class="modal-actions" style="margin-top:12px">
        <button class="btn btn-ghost" id="cmCancelBtn">取消</button>
        <button class="btn btn-primary" id="cmOkBtn" data-primary>移动</button>
      </div>
    </div>`
  document.body.appendChild(modal)
  const close = () => modal.remove()
  modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) close() })
  document.getElementById('cmCancelBtn')?.addEventListener('click', close)
  document.getElementById('cmOkBtn')?.addEventListener('click', async () => {
    const sel = document.getElementById('cmCatSel') as HTMLSelectElement
    const newName = (document.getElementById('cmNewCat') as HTMLInputElement).value.trim()
    let catId = sel?.value || 'uncategorized'
    if (newName) {
      const existed = cats.find(c => c.name === newName)
      if (existed) catId = existed.id
      else {
        catId = generateCategoryId()
        await addCategory({ id: catId, name: newName, sortOrder: 100 + cats.length })
      }
    }
    for (const id of selectedIds) await updateCard(id, { categoryId: catId })
    close()
    showToast(`✅ 已移动 ${selectedIds.size} 张卡片到「${newName || cats.find(c => c.id === sel?.value)?.name || '未分类'}」`)
    selectedIds.clear()
    await renderClothingLibrary()
  })
  openModal('clothingMoveModal')
}

function base64ToBlob(b64: string, mime = 'image/jpeg'): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// ── 编辑弹窗（动态创建，新建/编辑共用）──

function getEditorModal(): HTMLElement {
  let modal = document.getElementById('clothingEditorModal')
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = 'clothingEditorModal'
  modal.className = 'modal-overlay'
  modal.innerHTML = `
    <div class="modal-box" style="max-width:480px">
      <h3 id="ceTitle">添加服装卡片</h3>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
        <div>
          <label style="font-size:12px;color:var(--text2)">名称（无图时卡片大字显示）</label>
          <input type="text" id="ceName" placeholder="如：旗袍 / 兔女郎" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;outline:none;font-family:var(--font);margin-top:4px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text2)">分类</label>
          <select id="ceCat" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;outline:none;font-family:var(--font);margin-top:4px"></select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--text2)">提示词（英文 tag 串，逗号分隔）</label>
          <textarea id="cePrompt" rows="4" placeholder="black dress, black gloves, frills, ..." style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:12px;outline:none;font-family:var(--font);margin-top:4px;box-sizing:border-box;resize:vertical"></textarea>
        </div>
        <div>
          <label style="font-size:12px;color:var(--text2)">图片（可选，不选则为文字卡）</label>
          <input type="file" id="ceImg" accept="image/*" style="margin-top:4px;font-size:12px;color:var(--text2)">
          <div id="ceImgPreview" style="margin-top:6px"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="ceCancelBtn">取消</button>
        <button class="btn btn-primary" id="ceSaveBtn" data-primary>保存</button>
      </div>
    </div>`
  document.body.appendChild(modal)
  modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal('clothingEditorModal') })
  document.getElementById('ceCancelBtn')?.addEventListener('click', () => closeModal('clothingEditorModal'))
  document.getElementById('ceSaveBtn')?.addEventListener('click', saveEditor)
  const imgInput = document.getElementById('ceImg') as HTMLInputElement
  imgInput?.addEventListener('change', () => {
    const file = imgInput.files?.[0]
    const preview = document.getElementById('ceImgPreview')
    if (!preview) return
    preview.innerHTML = ''
    if (file) {
      const url = URL.createObjectURL(file)
      preview.innerHTML = `<img src="${url}" style="max-width:120px;border-radius:6px;border:1px solid var(--border)">`
    }
  })
  return modal
}

let editingId: string | null = null
let editingBlob: Blob | null = null

async function openClothingEditor(card?: ClothingCard) {
  const modal = getEditorModal()
  const cats = await getAllCategories()
  const catSel = document.getElementById('ceCat') as HTMLSelectElement
  catSel.innerHTML = cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
  editingId = card?.id || null
  editingBlob = null
  const nameEl = document.getElementById('ceName') as HTMLInputElement
  const promptEl = document.getElementById('cePrompt') as HTMLTextAreaElement
  const preview = document.getElementById('ceImgPreview')
  if (preview) preview.innerHTML = ''
  const imgInput = document.getElementById('ceImg') as HTMLInputElement
  if (imgInput) imgInput.value = ''
  const title = document.getElementById('ceTitle')
  if (title) title.textContent = card ? '编辑服装卡片' : '添加服装卡片'
  if (card) {
    nameEl.value = card.name
    promptEl.value = card.prompt
    if (card.categoryId) catSel.value = card.categoryId
    if (card.imageBlob) {
      editingBlob = card.imageBlob
      const url = URL.createObjectURL(card.imageBlob)
      if (preview) preview.innerHTML = `<img src="${url}" style="max-width:120px;border-radius:6px;border:1px solid var(--border)">`
    }
  } else {
    nameEl.value = ''
    promptEl.value = ''
    if (catSel.options.length && !catSel.value) catSel.value = cats[0]?.id || 'uncategorized'
  }
  openModal('clothingEditorModal')
}

async function saveEditor() {
  const name = (document.getElementById('ceName') as HTMLInputElement).value.trim()
  const prompt = (document.getElementById('cePrompt') as HTMLTextAreaElement).value.trim()
  const catId = (document.getElementById('ceCat') as HTMLSelectElement).value || 'uncategorized'
  if (!prompt) { showToast('⚠️ 提示词不能为空'); return }
  const imgInput = document.getElementById('ceImg') as HTMLInputElement
  const file = imgInput?.files?.[0]
  const blob = file || editingBlob
  const now = Date.now()
  if (editingId) {
    await updateCard(editingId, { name: name || prompt.slice(0, 20), prompt, categoryId: catId, tags: prompt.split(',').map(t => t.trim()).filter(Boolean), imageBlob: blob ?? undefined })
    showToast('✅ 已保存')
  } else {
    await addCard({
      id: generateCardId(), name: name || prompt.slice(0, 20), prompt, categoryId: catId,
      tags: prompt.split(',').map(t => t.trim()).filter(Boolean), imageBlob: blob ?? undefined,
      favorite: false, useCount: 0, source: 'manual', createdAt: now, updatedAt: now,
    })
    showToast('✅ 已添加')
  }
  closeModal('clothingEditorModal')
  await renderClothingLibrary()
}

// ── 抽卡面板（弹窗）──

let gachaScope = ''          // '' = 全部, 'fav' = 收藏, 其他 = 分类 id
let gachaCount = 3
let gachaResult: ClothingCard[] = []
let gachaLocked = new Set<string>()

function getGachaModal(): HTMLElement {
  let modal = document.getElementById('clothingGachaModal')
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = 'clothingGachaModal'
  modal.className = 'modal-overlay'
  modal.innerHTML = `
    <div class="modal-box" style="max-width:640px">
      <h3>${icon('dice', 16)} 服装抽卡</h3>
      <div class="gacha-controls" style="margin-top:12px">
        <label>范围</label>
        <select id="gaScope"></select>
        <label>数量</label>
        <input type="number" id="gaCount" min="1" max="10" value="3">
        <button class="btn btn-primary" id="gaDrawBtn">${icon('dice', 13)} 抽卡</button>
        <button class="btn btn-ghost" id="gaCopyBtn" style="display:none">${icon('copy', 13)} 复制合并</button>
        <button class="btn btn-ghost" id="gaCloseBtn">关闭</button>
      </div>
      <div class="gacha-results" id="gaResults" style="margin-top:10px"></div>
      <div class="gacha-merged" id="gaMerged" style="display:none"></div>
    </div>`
  document.body.appendChild(modal)
  modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal('clothingGachaModal') })
  document.getElementById('gaCloseBtn')?.addEventListener('click', () => closeModal('clothingGachaModal'))
  document.getElementById('gaDrawBtn')?.addEventListener('click', gachaDraw)
  document.getElementById('gaCount')?.addEventListener('change', (e) => {
    gachaCount = Math.max(1, Math.min(10, parseInt((e.target as HTMLInputElement).value) || 3))
  })
  document.getElementById('gaCopyBtn')?.addEventListener('click', () => {
    const text = joinCardPrompts(gachaResult)
    if (!text) return
    navigator.clipboard.writeText(text).then(() => showToast('✅ 已复制合并提示词')).catch(() => showToast('❌ 复制失败'))
  })
  return modal
}

async function openGachaModal() {
  const modal = getGachaModal()
  const cats = await getAllCategories()
  const all = await getAllCards()
  const scopeSel = document.getElementById('gaScope') as HTMLSelectElement
  scopeSel.innerHTML =
    `<option value="">全部 (${all.length})</option>` +
    `<option value="fav">收藏 (${all.filter(c => c.favorite).length})</option>` +
    cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)} (${all.filter(x => x.categoryId === c.id).length})</option>`).join('')
  scopeSel.value = gachaScope || ''
  gachaResult = []
  gachaLocked.clear()
  renderGachaResults()
  openModal('clothingGachaModal')
}

async function gachaDraw() {
  const scopeSel = document.getElementById('gaScope') as HTMLSelectElement
  gachaScope = scopeSel?.value || ''
  let pool: ClothingCard[]
  if (gachaScope === 'fav') {
    const allc = await getAllCards()
    pool = allc.filter(c => c.favorite)
  } else if (gachaScope) {
    pool = await getCardsByCategory(gachaScope)
  } else {
    pool = await getAllCards()
  }
  if (!pool.length) { showToast('⚠️ 该范围没有卡片'); return }
  // 锁定卡保留；从池中排除锁定卡后重抽
  const lockedCards = pool.filter(c => gachaLocked.has(c.id))
  const rest = pool.filter(c => !gachaLocked.has(c.id))
  const need = Math.max(0, gachaCount - lockedCards.length)
  const drawn = drawCards(rest, need)
  gachaResult = [...lockedCards, ...drawn]
  for (const c of gachaResult) if (c.id) await updateCard(c.id, { useCount: (c.useCount || 0) + 1 })
  renderGachaResults()
}

function renderGachaResults() {
  const box = document.getElementById('gaResults')
  const copyBtn = document.getElementById('gaCopyBtn') as HTMLElement
  const merged = document.getElementById('gaMerged')
  if (!box) return
  if (!gachaResult.length) {
    box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px 0;text-align:center">点「抽卡」开始——锁定的卡不会被换掉</div>'
    if (copyBtn) copyBtn.style.display = 'none'
    if (merged) merged.style.display = 'none'
    return
  }
  ensureObjUrls(gachaResult)
  box.innerHTML = gachaResult.map(c => {
    const locked = gachaLocked.has(c.id)
    const img = objUrlCache.get(c.id)
      ? `<div class="gacha-result-img"><img src="${objUrlCache.get(c.id)}"></div>`
      : c.imageUrl
        ? `<div class="gacha-result-img"><img src="${esc(c.imageUrl)}" onerror="this.remove()"></div>`
        : ''
    return `<div class="gacha-result-card ${locked ? 'locked' : ''}" data-id="${esc(c.id)}">
      ${img}
      <div class="gacha-result-text">${esc(c.prompt.slice(0, 80))}</div>
      <div class="gacha-result-actions">
        <button class="lock-btn ${locked ? 'on' : ''}" title="锁定（重抽不换掉）">${locked ? '🔒 已锁' : '🔓 锁定'}</button>
        <button class="rm-btn" title="移除这张">✕ 移除</button>
      </div>
    </div>`
  }).join('')
  box.querySelectorAll('.lock-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = (e.currentTarget as HTMLElement).closest('.gacha-result-card')?.getAttribute('data-id') || ''
      if (gachaLocked.has(id)) gachaLocked.delete(id); else gachaLocked.add(id)
      renderGachaResults()
    })
  })
  box.querySelectorAll('.rm-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = (e.currentTarget as HTMLElement).closest('.gacha-result-card')?.getAttribute('data-id') || ''
      gachaResult = gachaResult.filter(c => c.id !== id)
      gachaLocked.delete(id)
      renderGachaResults()
    })
  })
  const text = joinCardPrompts(gachaResult)
  if (copyBtn) copyBtn.style.display = text ? '' : 'none'
  if (merged) {
    merged.style.display = text ? '' : 'none'
    merged.textContent = text
  }
}

// ── 全局 handlers + 初始化 ──

export function setupClothingHandlers() {
  const w = window as any
  w.__clothingRefresh = () => renderClothingLibrary()
  w.__clothingToggleFav = async (id: string) => {
    const c = await getCard(id)
    if (!c) return
    await updateCard(id, { favorite: !c.favorite })
    await renderClothingLibrary()
  }
  w.__clothingEdit = async (id: string) => {
    const c = await getCard(id)
    if (c) await openClothingEditor(c)
  }
  w.__clothingDelete = async (id: string) => {
    const ok = await confirmModal('删除这张服装卡片？', '删除后不可恢复')
    if (!ok) return
    await deleteCard(id)
    showToast('🗑️ 已删除')
    await renderClothingLibrary()
  }
  w.__clothingSetCat = async (catId: string) => {
    currentCategory = catId
    page = 1
    await renderClothingLibrary()
  }
  w.__clothingOpenGacha = () => openGachaModal()
  w.__clothingExport = () => exportClothing()
  w.__clothingBuildExportJson = () => buildExportJson()
  w.__clothingAdd = () => openClothingEditor()
  w.__clothingAddCategory = async () => {
    const name = await promptModal('新建分类', '', '输入分类名称（一个名字一组）')
    if (!name) return
    const cats = await getAllCategories()
    await addCategory({ id: generateCategoryId(), name, sortOrder: 100 + cats.length })
    await renderClothingLibrary()
  }
  w.__clothingRenameCategory = async (id: string) => {
    const cats = await getAllCategories()
    const cat = cats.find(c => c.id === id)
    if (!cat) return
    const name = await promptModal('重命名分类', cat.name)
    if (!name) return
    await updateCategory(id, { name })
    await renderClothingLibrary()
  }
  w.__clothingDeleteCategory = async (id: string) => {
    const ok = await confirmModal('删除这个分类？', '该分类下的卡片会移到「未分类」')
    if (!ok) return
    await dbDeleteCategory(id)
    await renderClothingLibrary()
  }
  bindToolbar()
  document.getElementById('clothingCats')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.clothing-cat-tab') as HTMLElement
    if (!btn) return
    w.__clothingSetCat(btn.getAttribute('data-cat') || '')
  })
  // 点击卡片 = 切换选中（按钮已 stopPropagation，不干扰）；点网格空白 = 清空选择
  document.getElementById('clothingGrid')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const card = target.closest('.clothing-card') as HTMLElement
    if (card) {
      toggleCardSelect(card.getAttribute('data-card-id') || '')
    } else if (target === document.getElementById('clothingGrid')) {
      clearSelection()
    }
  })
  // 分页条事件
  document.getElementById('clothingPagination')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.clothing-page-btn') as HTMLElement
    if (!btn || btn.hasAttribute('disabled')) return
    const n = Number(btn.getAttribute('data-page'))
    if (n > 0) gotoPage(n)
  })
  initDragSelect()
}

export async function initClothing() {
  await initClothingDB()
  setupClothingHandlers()
  await renderClothingLibrary()
}

// ── 拖拽框选（多选模式下生效；document 级事件，照 Outputs 模式）──

let _dragInitDone = false

function initDragSelect() {
  if (_dragInitDone) return
  _dragInitDone = true

  let isDragging = false
  let startPageX = 0, startPageY = 0
  let rectEl: HTMLElement | null = null
  let _justBoxed = false
  let _boxedMoved = false   // 本次拖拽是否真的画了框（区分「拖拽框选」与「点一下」）

  function getCardIdsInRect(l: number, t: number, r: number, b: number): string[] {
    const ids: string[] = []
    const sx = window.scrollX, sy = window.scrollY
    document.querySelectorAll('#sectionClothing .clothing-card').forEach(el => {
      const cr = el.getBoundingClientRect()
      const cardL = cr.left + sx, cardT = cr.top + sy
      const cardR = cr.right + sx, cardB = cr.bottom + sy
      if (l < cardR && r > cardL && t < cardB && b > cardT) {
        const id = (el as HTMLElement).getAttribute('data-card-id')
        if (id) ids.push(id)
      }
    })
    return ids
  }

  document.addEventListener('mousedown', (e: Event) => {
    const me = e as MouseEvent
    const target = e.target as HTMLElement
    if (!target.closest('#sectionClothing')) return
    if (target.closest('button, input, select, textarea, .clothing-cat-tab, .clothing-toolbar, .clothing-batch-bar')) return
    if (me.button !== 0) return

    isDragging = true
    _boxedMoved = false
    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    e.preventDefault()

    startPageX = me.pageX
    startPageY = me.pageY
    rectEl = document.createElement('div')
    rectEl.className = 'clothing-selection-rect'
    rectEl.style.cssText = `left:${me.clientX}px;top:${me.clientY}px;width:0;height:0`
    document.body.appendChild(rectEl)
  })

  document.addEventListener('mousemove', (e: Event) => {
    const me = e as MouseEvent
    if (!isDragging || !rectEl) return
    const l = Math.min(startPageX, me.pageX)
    const t = Math.min(startPageY, me.pageY)
    const r = Math.max(startPageX, me.pageX)
    const b = Math.max(startPageY, me.pageY)
    const sx = window.scrollX, sy = window.scrollY
    rectEl.style.cssText = `left:${l - sx}px;top:${t - sy}px;width:${r - l}px;height:${b - t}px`
    if (r - l > 5 || b - t > 5) {
      _boxedMoved = true
      const ids = getCardIdsInRect(l, t, r, b)
      selectedIds = new Set(ids)
      updateBatchBar()
    }
  })

  document.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    if (_boxedMoved) _justBoxed = true   // 真拖了框才拦截后续 click；点一下不拦（让空白点击清空生效）
    _boxedMoved = false
    updateBatchBar()
  })

  // 拖拽结束后的 click 不应触发卡片选中（capture 阶段拦截）
  document.addEventListener('click', (e: Event) => {
    if (_justBoxed) {
      _justBoxed = false
      e.preventDefault()
      e.stopPropagation()
    }
  }, true)

  const cancelDrag = () => {
    if (!isDragging) return
    isDragging = false
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    updateBatchBar()
  }
  window.addEventListener('blur', cancelDrag)
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelDrag() })
  document.addEventListener('mouseleave', cancelDrag)
}
