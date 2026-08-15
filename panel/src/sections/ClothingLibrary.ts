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
let selectionMode = false  // 多选模式开关
let selectedIds = new Set<string>()
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

export async function renderClothingLibrary() {
  const grid = container()
  if (!grid) return
  const seq = ++listLoadSeq
  await renderCats()

  let cards: ClothingCard[]
  if (currentCategory === 'fav') {
    const all = currentSearch ? await searchCards(currentSearch) : await getAllCards()
    cards = all.filter(c => c.favorite)
  } else if (currentCategory) {
    cards = currentSearch
      ? await searchCardsByCategory(currentSearch, currentCategory)
      : await getCardsByCategory(currentCategory)
  } else {
    cards = currentSearch ? await searchCards(currentSearch) : await getAllCards()
  }
  if (seq !== listLoadSeq) return

  ensureObjUrls(cards)
  grid.innerHTML = cards.map(c => renderClothingCard(c, objUrlCache.get(c.id), selectedIds.has(c.id))).join('')
  updateBatchBar()
}

// 多选批量条：显示已选数量 + 删除/取消按钮
function updateBatchBar() {
  const bar = document.getElementById('clothingBatchBar')
  const countEl = document.getElementById('clothingSelCount')
  if (countEl) countEl.textContent = String(selectedIds.size)
  if (bar) bar.style.display = selectionMode ? 'flex' : 'none'
  const selBtn = document.getElementById('clothingSelBtn')
  if (selBtn) selBtn.classList.toggle('active', selectionMode)
  // 选中态同步到卡片 DOM（删除/刷新后勾选框状态保持）
  document.querySelectorAll('#clothingGrid .clothing-card').forEach(el => {
    const id = el.getAttribute('data-card-id') || ''
    el.classList.toggle('selected', selectedIds.has(id))
    const check = el.querySelector('[data-check]')
    if (check) check.classList.toggle('on', selectedIds.has(id))
  })
}

function toggleSelectionMode() {
  selectionMode = !selectionMode
  if (!selectionMode) selectedIds.clear()
  updateBatchBar()
}

function toggleCardSelect(id: string) {
  if (!selectionMode) return
  if (selectedIds.has(id)) selectedIds.delete(id)
  else selectedIds.add(id)
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
  document.getElementById('clothingSelBtn')?.addEventListener('click', toggleSelectionMode)
  document.getElementById('clothingDelSelBtn')?.addEventListener('click', deleteSelected)
  document.getElementById('clothingSelCancelBtn')?.addEventListener('click', () => {
    selectedIds.clear()
    updateBatchBar()
  })
  document.getElementById('clothingImportBtn')?.addEventListener('click', () => {
    document.getElementById('clothingImportFile')?.click()
  })
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
    await doImport(data, selected)
  } finally {
    importing = false
  }
}

// 预览弹窗：分类折叠列表 + 展开后卡片缩略图，可勾选到单张；返回选中的卡片数组；取消返回 null
// 每次调用重建弹窗（不复用 DOM），避免确认按钮闭包捕获上一次的 resolve
function showImportPreview(allCards: any[]): Promise<any[] | null> {
  return new Promise((resolve) => {
    document.getElementById('clothingImportModal')?.remove()
    const modal = document.createElement('div')
    modal.id = 'clothingImportModal'
    modal.className = 'modal-overlay'
    modal.innerHTML = `
      <div class="modal-box" style="max-width:760px">
        <h3>${icon('download', 16)} 导入服装卡片</h3>
        <p class="sub" style="margin:6px 0 10px">点分类行展开看卡片图，勾选到单张；分类前的框 = 一键全选/全不选该类</p>
        <div id="ciCats" style="display:flex;flex-direction:column;gap:4px;max-height:420px;overflow-y:auto;padding-right:4px"></div>
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

    const done = (val: any[] | null) => { modal.classList.remove('open'); resolve(val) }
    modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) done(null) })
    document.getElementById('ciCancelBtn')?.addEventListener('click', () => done(null))
    document.getElementById('ciOkBtn')?.addEventListener('click', () => {
      done(allCards.filter((_, i) => selectedIdx.has(i)))
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

// 执行导入（只导入 selectedCards；清旧导入卡再写 → 可重复导入）
async function doImport(data: any, selectedCards: any[]) {
  if (!selectedCards.length) { showToast('没有选中的卡片'); return }
  // 分类：只建选中的卡片涉及到的分类（按名字去重，已存在跳过）
  const existing = await getAllCategories()
  const existingNames = new Set(existing.map(c => c.name))
  const catIdMap = new Map<string, string>()   // 导入文件分类名 -> 库内 id
  for (const c of existing) catIdMap.set(c.name, c.id)
  const needCats: string[] = []
  for (const c of selectedCards) {
    const name = String(c.category || '未分类')
    if (!needCats.includes(name)) needCats.push(name)
  }
  let newCatCount = 0
  for (const [i, name] of needCats.entries()) {
    if (existingNames.has(name)) continue
    const id = generateCategoryId()
    await addCategory({ id, name, sortOrder: 100 + i })
    catIdMap.set(name, id)
    newCatCount++
  }
  // 卡片：清掉旧导入卡（source=import）再批量写入，手建卡保留 → 可重复导入
  const olds = await getAllCards()
  for (const c of olds) {
    if (c.source === 'import') await deleteCard(c.id)
  }
  const now = Date.now()
  const cards: ClothingCard[] = selectedCards.map((c: any) => ({
    id: generateCardId(),
    name: String(c.name || '未命名'),
    prompt: String(c.prompt || ''),
    categoryId: catIdMap.get(String(c.category || '未分类')) || 'uncategorized',
    tags: String(c.prompt || '').split(',').map(t => t.trim()).filter(Boolean),
    imageBlob: c.imageBase64 ? base64ToBlob(c.imageBase64) : undefined,
    imageUrl: c.imageUrl || undefined,
    favorite: !!c.favorite,
    useCount: 0,
    source: 'import',
    createdAt: now + Math.random(),
    updatedAt: now,
  }))
  if (cards.length) await bulkAddCards(cards)
  showToast(`✅ 导入完成：${cards.length} 张卡片${newCatCount ? `，新增 ${newCatCount} 个分类` : ''}`)
  currentCategory = ''
  currentSearch = ''
  await renderClothingLibrary()
}

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: 'image/jpeg' })
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
    await renderClothingLibrary()
  }
  w.__clothingOpenGacha = () => openGachaModal()
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
  // 多选模式下点击卡片切换选中（按钮已 stopPropagation，不干扰）
  document.getElementById('clothingGrid')?.addEventListener('click', (e) => {
    if (!selectionMode) return
    const card = (e.target as HTMLElement).closest('.clothing-card') as HTMLElement
    if (!card) return
    toggleCardSelect(card.getAttribute('data-card-id') || '')
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
    if (!selectionMode) return
    const me = e as MouseEvent
    const target = e.target as HTMLElement
    if (!target.closest('#sectionClothing')) return
    if (target.closest('button, input, select, textarea, .clothing-cat-tab, .clothing-toolbar, .clothing-batch-bar')) return
    if (me.button !== 0) return

    isDragging = true
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
    if (selectedIds.size > 0) _justBoxed = true
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
