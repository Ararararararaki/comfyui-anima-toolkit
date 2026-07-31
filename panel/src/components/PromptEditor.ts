import type { PromptEntry } from '../types'
import { esc } from '../utils'
import { getAllCategories } from '../store/prompts'

export function renderPromptEditor(p: Partial<PromptEntry> & { id: string }) {
  const el = document.getElementById('promptEditForm')
  if (!el) return

  let tagsHtml = ''
  if (p.tags) {
    tagsHtml = p.tags.map(t => `<span class="tag tag-editable">${esc(t)} <button class="tag-del-btn" onclick="window.__removePromptEditTag('${esc(t)}')">✕</button></span>`).join('')
  }

  const images = p.images || []
  const imgsHtml = images.length > 0
    ? `<div class="img-thumb-grid">${images.map((u, i) =>
        `<div class="img-thumb-wrap">
          <img src="${esc(u)}" alt="">
          <button type="button" class="img-thumb-del" onclick="window.__removePromptImage(${i})">✕</button>
        </div>`).join('')}</div>`
    : ''

  el.innerHTML = `
    <input type="text" id="pe_displayText" value="${esc(p.displayText || '')}" placeholder="显示名称（可选）" class="mb-8">
    <textarea id="pe_prompt" placeholder="Prompt 全文" class="textarea-md min-h-60 mb-8">${esc(p.prompt || '')}</textarea>
    <div class="form-row">
      <input type="number" id="pe_weight" value="${p.weight || 1.0}" step="0.1" min="0.1" max="2.0" placeholder="权重" style="flex:1">
      <select id="pe_category" class="select-md" style="flex:2"></select>
    </div>
    <div class="form-row-stretch">
      <input type="text" id="pe_newTag" placeholder="添加标签后回车" style="flex:1" onkeydown="if(event.key==='Enter'){event.preventDefault();window.__addPromptEditTag()}">
    </div>
    <div id="pe_tags" class="form-row-stretch">${tagsHtml}</div>
    <div id="pe_images">${imgsHtml}</div>
    <div class="form-gap-sm">
      <button type="button" class="btn btn-ghost btn-md" onclick="document.getElementById('pe_fileInput').click()">📷 添加预览图</button>
      <input type="file" id="pe_fileInput" accept="image/*" multiple style="display:none">
    </div>
    <textarea id="pe_notes" placeholder="个人备注" class="textarea-md min-h-40">${esc(p.notes || '')}</textarea>
  `

  // Wire file input
  const fileInput = document.getElementById('pe_fileInput') as HTMLInputElement
  if (fileInput) {
    fileInput.onchange = () => {
      const files = fileInput.files
      if (!files || files.length === 0) return
      const modal = document.getElementById('promptEditModal')
      const existing: string[] = modal?.dataset.peImages ? JSON.parse(modal.dataset.peImages) : [...images]
      let pending = files.length
      for (const file of files) {
        if (!file.type.startsWith('image/')) { pending--; continue }
        const reader = new FileReader()
        reader.onload = () => {
          existing.push(reader.result as string)
          pending--
          if (pending === 0) {
            if (modal) modal.dataset.peImages = JSON.stringify(existing)
            const cont = document.getElementById('pe_images')
            if (cont) {
              cont.innerHTML = existing.map((u, i) =>
                `<div class="img-thumb-wrap">
                  <img src="${esc(u)}" alt="">
                  <button type="button" class="img-thumb-del" onclick="window.__removePromptImage(${i})">✕</button>
                </div>`
              ).join('')
            }
          }
        }
        reader.readAsDataURL(file)
      }
      fileInput.value = ''
    }
  }

  getAllCategories().then(cats => {
    const sel = document.getElementById('pe_category') as HTMLSelectElement
    if (!sel) return
    sel.innerHTML = cats.map(c => `<option value="${c.id}" ${(p.categoryId || 'uncategorized') === c.id ? 'selected' : ''}>${c.icon} ${c.name}</option>`).join('')
  })
}