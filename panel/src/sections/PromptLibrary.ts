import { getAllPrompts, countAllPrompts, countPromptsByCategory, searchPrompts, getPromptsByCategory, searchPromptsByCategory, getAllCategories, addCategory, deleteCategory, updateCategory, generateCategoryId, addPrompt, updatePrompt, deletePrompt, getPromptsByModel, getPrompt, generatePromptId } from '../store/prompts'
import { renderPromptCard } from '../components/PromptCard'
import { renderPromptEditor } from '../components/PromptEditor'
import type { PromptEntry, PromptCategory } from '../types'
import { showToast, esc, icon, attachSearchClear } from '../utils'
import { openModal, closeModal, promptModal, confirmModal } from '../components/Modal'

let currentSearch = ''
let currentCategory = ''

// 列表缓存与竞态保护（需求 1：切分类不重查、不闪骨架）
let hasRenderedList = false
let listLoadSeq = 0
const promptListCache = new Map<string, PromptEntry[]>()

export async function renderPromptLibrary() {
  const container = document.getElementById('promptGrid')
  const sidebar = document.getElementById('promptCategoryList')
  const searchInput = document.getElementById('promptSearch') as HTMLInputElement
  if (!container) return

  // 数据变更/切回 tab 时强制重取（覆盖 PromptFreq 保存等旁路写入）
  promptListCache.clear()

  // Render categories
  await renderCategories(sidebar)

  // Render prompts
  await renderPromptList()
}

function listCacheKey() { return currentCategory || 'all' }
// 从 chips 容器收集文本（tags/loras 通用）
function collectChips(id: string): string[] {
  const el = document.getElementById(id)
  if (!el) return []
  const out: string[] = []
  el.querySelectorAll('.tag').forEach(t => {
    const v = t.textContent?.trim()
    if (v) out.push(v)
  })
  return out
}


async function renderCategories(sidebar: HTMLElement | null) {
  if (!sidebar) return
  const cats = await getAllCategories()
  const counts = await Promise.all([countAllPrompts(), ...cats.map(c => countPromptsByCategory(c.id))])
  const allCount = counts[0]
  const catCounts: Record<string, number> = {}
  cats.forEach((c, i) => { catCounts[c.id] = counts[i + 1] })

  sidebar.innerHTML = `
    <button class="prompt-cat-item ${currentCategory === '' ? 'active' : ''}" data-catid="">
      ${icon('grid', 12)} 全部 <span class="count">${allCount}</span>
    </button>
    ${cats.map(c => `
      <div class="prompt-cat-row">
        <button class="prompt-cat-item ${currentCategory === c.id ? 'active' : ''}" data-catid="${c.id}">
          ${c.icon ? c.icon + ' ' : ''}${c.name} <span class="count">${catCounts[c.id] || 0}</span>
        </button>
        ${c.id !== 'uncategorized' ? `<button class="prompt-cat-del" data-catid="${c.id}" title="删除分类">${icon('x', 12)}</button>` : ''}
      </div>
    `).join('')}
    <button class="prompt-cat-add" onclick="window.__addPromptCategory()">${icon('plus', 12)} 新建分类</button>
  `

  // Bind category clicks
  sidebar.querySelectorAll('.prompt-cat-item').forEach(el => {
    el.addEventListener('click', async () => {
      currentCategory = (el as HTMLElement).dataset.catid || ''
      await renderPromptList()
      sidebar.querySelectorAll('.prompt-cat-item').forEach(e => e.classList.toggle('active', (e as HTMLElement).dataset.catid === currentCategory))
    })
  })

  // Bind category delete
  sidebar.querySelectorAll('.prompt-cat-del').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const catId = (el as HTMLElement).dataset.catid || ''
      if (!await confirmModal('删除分类', '删除此分类？其中的 Prompt 将移至"未分类"')) return
      await deleteCategory(catId)
      if (currentCategory === catId) currentCategory = ''
      await renderPromptLibrary()
    })
  })
}

function renderListContent(container: HTMLElement, prompts: PromptEntry[]) {
  if (prompts.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="big">${icon('book', 28)}</div><p>${currentSearch ? '没有匹配的 Prompt' : 'Prompt 库为空'}</p><p class="sub">浏览 LoRA 列表，从卡片中提取触发词</p></div>`
    return
  }
  container.innerHTML = prompts.map(p => renderPromptCard(p, currentSearch)).join('')
}

async function renderPromptList() {
  const container = document.getElementById('promptGrid')
  if (!container) return
  const seq = ++listLoadSeq
  const useCache = !currentSearch
  const key = listCacheKey()

  // 缓存命中 → 同步渲染，无骨架
  if (useCache && promptListCache.has(key)) {
    renderListContent(container, promptListCache.get(key)!)
    return
  }

  // 未命中：首次进入显示骨架；切分类保留旧内容 + 轻量加载态（不闪浅黄骨架）
  if (!hasRenderedList) {
    container.innerHTML = `
      <div class="skeleton-card" style="grid-column:1/-1">
        <div class="skeleton-img"></div>
        <div class="skeleton-text"></div>
        <div class="skeleton-text" style="width:75%"></div>
        <div class="skeleton-text" style="width:55%"></div>
        <div class="skeleton-badges">
          <div class="skeleton-badge"></div>
          <div class="skeleton-badge"></div>
        </div>
      </div>
      <div class="skeleton-card" style="grid-column:1/-1">
        <div class="skeleton-img"></div>
        <div class="skeleton-text"></div>
        <div class="skeleton-text" style="width:60%"></div>
        <div class="skeleton-badges">
          <div class="skeleton-badge"></div>
        </div>
      </div>
      <div class="skeleton-card" style="grid-column:1/-1">
        <div class="skeleton-img"></div>
        <div class="skeleton-text"></div>
        <div class="skeleton-text" style="width:80%"></div>
        <div class="skeleton-text" style="width:40%"></div>
        <div class="skeleton-badges">
          <div class="skeleton-badge"></div>
          <div class="skeleton-badge"></div>
          <div class="skeleton-badge"></div>
        </div>
      </div>`
  } else {
    container.classList.add('prompt-loading')
  }

  let prompts: PromptEntry[]
  if (currentCategory) {
    prompts = currentSearch
      ? await searchPromptsByCategory(currentSearch, currentCategory)
      : await getPromptsByCategory(currentCategory)
  } else {
    prompts = currentSearch
      ? await searchPrompts(currentSearch)
      : await getAllPrompts()
  }

  // 竞态保护：期间已切换分类则丢弃过期结果
  if (seq !== listLoadSeq) return
  if (useCache) promptListCache.set(key, prompts)
  hasRenderedList = true
  container.classList.remove('prompt-loading')
  renderListContent(container, prompts)
}

// ── Global handlers exported for LoraExplorer ──

export function setupPromptHandlers() {
  const w = window as any

  w.__refreshPrompt = async () => {
    await renderPromptLibrary()
  }

  w.__searchPrompts = async () => {
    const input = document.getElementById('promptSearch') as HTMLInputElement
    currentSearch = input?.value || ''
    await renderPromptList()
  }

  w.__searchPromptsByTag = async (tag: string) => {
    const input = document.getElementById('promptSearch') as HTMLInputElement
    if (input) input.value = tag
    currentSearch = tag
    await renderPromptList()
  }

  w.__searchPromptsByModel = async (modelId: number) => {
    const container = document.getElementById('promptGrid')
    if (!container) return
    const prompts = await getPromptsByModel(modelId)
    if (prompts.length === 0) { showToast('⚠️ 该模型暂无已提取的 Prompt'); return }
    // Switch to prompt tab and show filtered results
    const mainTab = document.querySelector('.main-tab[data-section="prompt"]') as HTMLElement
    if (mainTab) mainTab.click()
    container.innerHTML = prompts.map(p => renderPromptCard(p)).join('')
  }

  w.__togglePromptFav = async (id: string) => {
    const p = await getPrompt(id)
    if (!p) return
    await updatePrompt(id, { isFavorite: !p.isFavorite })
    promptListCache.clear()
    await renderPromptList()
  }

  w.__deletePrompt = async (id: string) => {
    await deletePrompt(id)
    promptListCache.clear()
    await renderPromptList()
    showToast('🗑️ Prompt 已删除')
  }

  w.__editPrompt = async (id: string) => {
    const p = await getPrompt(id)
    if (!p) return
    // Store editing id on modal
    const modal = document.getElementById('promptEditModal')
    if (modal) {
      modal.dataset.editId = id
      modal.dataset.peImages = JSON.stringify(p.images || [])
    }
    renderPromptEditor(p)
    openModal('promptEditModal')
  }

  w.__addPromptCategory = async () => {
    const name = await promptModal('新建分类', '', '输入分类名称:')
    if (!name?.trim()) return
    const id = generateCategoryId()
    const order = (await getAllCategories()).length
    await addCategory({ id, name: name.trim(), icon: '📁', sortOrder: order })
    await renderPromptLibrary()
  }

  w.__savePromptEdit = async () => {
    const modal = document.getElementById('promptEditModal')
    const id = modal?.dataset.editId
    if (!id) return

    const displayText = (document.getElementById('pe_displayText') as HTMLInputElement)?.value?.trim() || ''
    const prompt = (document.getElementById('pe_prompt') as HTMLTextAreaElement)?.value?.trim() || ''
    const categoryId = (document.getElementById('pe_category') as HTMLSelectElement)?.value || 'uncategorized'
    const notes = (document.getElementById('pe_notes') as HTMLTextAreaElement)?.value?.trim() || ''
    // Collect tags + loras chips from DOM
    const tags = collectChips('pe_tags')
    const loras = collectChips('pe_loras')

    if (!prompt) { showToast('⚠️ Prompt 不能为空'); return }

    if (id.startsWith('new_')) {
      // Merge images: peImages (uploaded) + promptImages (model extraction)
      let allImages: string[] = []
      if (modal?.dataset.peImages) allImages = JSON.parse(modal.dataset.peImages)
      if (modal?.dataset.promptImages) {
        const extracted = JSON.parse(modal.dataset.promptImages) as string[]
        for (const u of extracted) {
          if (!allImages.includes(u)) allImages.push(u)
        }
      }
      // New prompt
      const entry: PromptEntry = {
        id: generatePromptId(),
        prompt,
        displayText: displayText || prompt.slice(0, 40),
        images: allImages,
        primaryImage: allImages[0] || '',
        tags,
        loras,
        categoryId,
        notes,
        isFavorite: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(modal?.dataset.sourceModelId ? { sourceModelId: parseInt(modal.dataset.sourceModelId) } : {}),
        ...(modal?.dataset.sourceModelName ? { sourceModelName: modal.dataset.sourceModelName } : {}),
        ...(modal?.dataset.sourceModelUrl ? { sourceModelUrl: modal.dataset.sourceModelUrl } : {}),
        ...(modal?.dataset.sourceModelCategory ? { sourceModelCategory: modal.dataset.sourceModelCategory } : {}),
      }
      await addPrompt(entry)
    } else {
      // Update existing — use peImages if present
      let allImages: string[] = []
      if (modal?.dataset.peImages) allImages = JSON.parse(modal.dataset.peImages)
      await updatePrompt(id, { displayText, prompt, categoryId, notes, tags, loras, images: allImages, primaryImage: allImages[0] || '' })
    }

    closeModal('promptEditModal')
    await renderPromptLibrary()
    showToast(id.startsWith('new_') ? '✅ Prompt 已添加' : '✅ Prompt 已更新', 'success')
  }

  w.__addPromptEditTag = () => {
    const input = document.getElementById('pe_newTag') as HTMLInputElement
    const tagsContainer = document.getElementById('pe_tags')
    if (!input || !tagsContainer) return
    const tag = input.value.trim()
    if (!tag) return
    input.value = ''
    const span = document.createElement('span')
    span.className = 'tag tag-editable'
    span.innerHTML = `${tag} <button class="tag-del-btn" onclick="this.parentElement.remove()">${icon('x', 12)}</button>`
    tagsContainer.appendChild(span)
  }

  w.__addPromptEditLora = () => {
    const input = document.getElementById('pe_newLora') as HTMLInputElement
    const lorasContainer = document.getElementById('pe_loras')
    if (!input || !lorasContainer) return
    const lora = input.value.trim()
    if (!lora) return
    input.value = ''
    const span = document.createElement('span')
    span.className = 'tag tag-editable'
    span.innerHTML = `${lora} <button class="tag-del-btn" onclick="this.parentElement.remove()">${icon('x', 12)}</button>`
    lorasContainer.appendChild(span)
  }

  w.__removePromptEditLora = (lora: string) => {
    const lorasContainer = document.getElementById('pe_loras')
    if (!lorasContainer) return
    lorasContainer.querySelectorAll('.tag').forEach(el => {
      if (el.textContent?.trim() === lora) el.remove()
    })
  }

  w.__removePromptEditTag = (tag: string) => {
    const tagsContainer = document.getElementById('pe_tags')
    if (!tagsContainer) return
    tagsContainer.querySelectorAll('.tag').forEach(el => {
      if (el.textContent?.trim() === tag) el.remove()
    })
  }

  w.__removePromptImage = (idx: number) => {
    const modal = document.getElementById('promptEditModal')
    if (!modal) return
    const images: string[] = modal.dataset.peImages ? JSON.parse(modal.dataset.peImages) : []
    images.splice(idx, 1)
    modal.dataset.peImages = JSON.stringify(images)
    const cont = document.getElementById('pe_images')
    if (cont) {
      cont.innerHTML = images.length > 0
        ? `<div class="img-thumb-grid">${images.map((u, i) =>
            `<div class="img-thumb-wrap">
              <img src="${esc(u)}" alt="">
              <button type="button" class="img-thumb-del" onclick="window.__removePromptImage(${i})">${icon('x', 12)}</button>
            </div>`).join('')}</div>`
        : ''
    }
  }

  // Wire new prompt button
  document.getElementById('promptAddBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('promptEditModal')
    if (modal) {
      modal.dataset.editId = 'new_' + Date.now()
      modal.dataset.peImages = '[]'
    }
    renderPromptEditor({ id: 'prefill_new', prompt: '', displayText: '', tags: [], loras: [], categoryId: 'uncategorized', notes: '', images: [], primaryImage: '' })
    openModal('promptEditModal')
  })

  // Wire save button
  document.getElementById('promptEditSaveBtn')?.addEventListener('click', () => w.__savePromptEdit())
  document.getElementById('promptEditCancelBtn')?.addEventListener('click', () => closeModal('promptEditModal'))

  // Wire search
  const searchInput = document.getElementById('promptSearch')
  if (searchInput) {
    let timer: ReturnType<typeof setTimeout>
    searchInput.addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(() => w.__searchPrompts(), 300)
    })
    attachSearchClear(searchInput as HTMLInputElement, () => {
      currentSearch = ''
      renderPromptList()
    })
  }

  // Event delegation for prompt grid
  document.getElementById('promptGrid')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    const delBtn = target.closest('.prompt-card-del-btn') as HTMLElement
    if (delBtn) {
      e.stopPropagation()
      const id = delBtn.dataset.promptId
      if (id && await confirmModal('删除 Prompt', '确认删除此 Prompt?')) {
        await deletePrompt(id)
        await renderPromptList()
        showToast('🗑️ Prompt 已删除')
      }
    }
  })
}
