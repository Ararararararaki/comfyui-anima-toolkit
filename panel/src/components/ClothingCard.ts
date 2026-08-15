import type { ClothingCard } from '../types'
import { esc, icon } from '../utils'

// ── 服装卡片：有图显示图片卡，无图显示文字卡 ──
// objUrl：由调用方从 blob→objectURL 缓存 Map 传入（组件保持纯函数）

export function renderClothingCard(card: ClothingCard, objUrl?: string): string {
  const imgHtml = objUrl
    ? `<div class="clothing-card-img"><img src="${esc(objUrl)}" alt="" loading="lazy"></div>`
    : card.imageUrl
      ? `<div class="clothing-card-img"><img src="${esc(card.imageUrl)}" alt="" loading="lazy" onerror="this.closest('.clothing-card').classList.add('no-img')"></div>`
      : ''

  // 无图文字卡：首 tag 大字 + 分类色块
  const textCardHtml = !imgHtml
    ? `<div class="clothing-card-text"><span class="clothing-card-text-main">${esc(card.name)}</span><span class="clothing-card-text-sub">${esc(card.tags.slice(0, 4).join(', '))}</span></div>`
    : ''

  const promptPreview = card.prompt.length > 90 ? card.prompt.slice(0, 90) + '…' : card.prompt

  return `<div class="clothing-card ${imgHtml ? '' : 'no-img'}" data-card-id="${esc(card.id)}">
    ${imgHtml}
    ${textCardHtml}
    <div class="clothing-card-body">
      <div class="clothing-card-header">
        <span class="clothing-card-name" title="${esc(card.prompt)}">${esc(card.name)}</span>
        <span class="clothing-card-fav ${card.favorite ? 'on' : ''}" onclick="event.stopPropagation();window.__clothingToggleFav('${esc(card.id)}')" title="收藏">${icon(card.favorite ? 'heart' : 'heart', 13)}</span>
      </div>
      <div class="clothing-card-prompt"><code>${esc(promptPreview)}</code></div>
      <div class="clothing-card-actions">
        <button class="btn btn-primary" data-copy="${esc(card.prompt)}" onclick="event.stopPropagation();window.__copyText(this.dataset.copy,this)">${icon('copy', 12)} 复制</button>
        <button class="btn btn-ghost" onclick="event.stopPropagation();window.__clothingEdit('${esc(card.id)}')" title="编辑">${icon('edit3', 12)}</button>
        <button class="btn btn-danger" onclick="event.stopPropagation();window.__clothingDelete('${esc(card.id)}')" title="删除">${icon('trash', 12)}</button>
      </div>
    </div>
  </div>`
}
