import type { PromptEntry } from '../types'
import { esc, fmtNum } from '../utils'

// ── 搜索高亮工具 ──
function highlightText(text: string, query: string): string {
  if (!query) return esc(text)
  const escaped = esc(text)
  const q = esc(query)
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>')
}

export function renderPromptCard(p: PromptEntry, searchQuery = ''): string {
  const date = new Date(p.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  const tagsHtml = p.tags.slice(0, 8).map(t =>
    `<span class="tag-sm" onclick="event.stopPropagation();window.__searchPromptsByTag('${esc(t)}')">${esc(t)}</span>`
  ).join('')

  const imgHtml = p.primaryImage
    ? `<div class="prompt-card-img"><img src="${esc(p.primaryImage)}" alt="" loading="lazy" onclick="window.__openLightbox(${JSON.stringify(p.images.length > 0 ? p.images : [p.primaryImage])},0)"></div>`
    : p.images.length > 0
      ? `<div class="prompt-card-img"><img src="${esc(p.images[0])}" alt="" loading="lazy" onclick="window.__openLightbox(${JSON.stringify(p.images)},0)"></div>`
      : ''

  const title = p.displayText || p.prompt.slice(0, 40)
  const promptPreview = p.prompt.slice(0, 120)

  return `<div class="prompt-card" data-prompt-id="${p.id}">
    ${imgHtml}
    <div class="prompt-card-body">
      <div class="prompt-card-header">
        <span class="prompt-card-title">${highlightText(title, searchQuery)}</span>
        <span class="prompt-card-fav ${p.isFavorite ? 'on' : ''}" onclick="event.stopPropagation();window.__togglePromptFav('${p.id}')">${p.isFavorite ? '⭐' : '☆'}</span>
      </div>
      <div class="prompt-card-prompt"><code>${highlightText(promptPreview, searchQuery)}${p.prompt.length > 120 ? '…' : ''}</code></div>
      <div class="prompt-card-meta">
        ${p.sourceModelName ? `<span class="pmeta-item" onclick="event.stopPropagation();window.__searchPromptsByModel(${p.sourceModelId})" title="查看该模型的所有 Prompt">📦 ${highlightText(p.sourceModelName, searchQuery)}</span>` : ''}
        ${p.weight ? `<span class="pmeta-item">⚖️ ${p.weight.toFixed(1)}</span>` : ''}
        <span class="pmeta-item">📅 ${date}</span>
        ${p.images.length > 1 ? `<span class="pmeta-item">📷 ${p.images.length}图</span>` : ''}
      </div>
      ${tagsHtml ? `<div class="prompt-card-tags">${tagsHtml}</div>` : ''}
      ${p.notes ? `<div class="prompt-card-notes">💬 ${highlightText(p.notes.slice(0, 60), searchQuery)}${p.notes.length > 60 ? '…' : ''}</div>` : ''}
      <div class="prompt-card-actions">
        <button class="btn btn-primary" data-copy="${esc(p.prompt)}" onclick="event.stopPropagation();window.__copyText(this.dataset.copy,this)">📋 复制 Prompt</button>
        <button class="btn btn-ghost" onclick="event.stopPropagation();window.__editPrompt('${p.id}')">✏️</button>
        <button class="btn btn-danger prompt-card-del-btn" data-prompt-id="${p.id}">🗑️</button>
      </div>
    </div>
  </div>`
}
