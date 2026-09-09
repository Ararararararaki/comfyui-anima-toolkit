import type { ProcessedModel } from '../types'
import { esc, escAttr, thumbUrl, icon } from '../utils'
import { isFav } from '../store/favorites'
import { getNote } from '../store/notes'
import { useModelStore } from '../store/models'
import { getLocalFileNames } from '../store/localModels'

// 本地文件名缓存（惰性刷新）
let _localNames: string[] | null = null

function isLocalModel(name: string): boolean {
  if (_localNames === null) _localNames = getLocalFileNames()
  const q = name.toLowerCase().replace(/[\s_-]/g, '')
  return _localNames.some(n => n.includes(q) || q.includes(n))
}

export function refreshLocalNames() { _localNames = null }

export function renderCard(m: ProcessedModel, currentCategory?: string): string {
  const imgs = m.images.slice(0, 8)
  const hasImgs = imgs.length > 0
  const multi = imgs.length > 1
  const isLocal = isLocalModel(m.name)

  const galleryHtml = hasImgs
    ? renderGalleryHtml(m, imgs, multi)
    : m.fallbackLoading
      ? `<div class="lora-gallery" style="height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text3);font-size:13px;gap:6px;background:var(--bg2)">
          <div style="width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:sp .6s linear infinite"></div>
          <span>🔍 搜索公开图片…</span>
          <style>@keyframes sp{to{transform:rotate(360deg)}}</style>
        </div>`
      : `<div class="lora-gallery" style="height:200px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px;background:var(--bg2)">🖼️ 暂无预览图</div>`

  // 描述浮层：同节点浏览卡样式——半透明渐变覆盖在预览图底部，点击展开（容器 pointer-events:none 穿透，保住画廊圆点/按钮）
  const descOverlayHtml = m.description
    ? `<div class="card-desc-overlay" style="position:absolute;left:0;right:0;bottom:0;z-index:8;margin:0;padding:26px 12px 14px;background:linear-gradient(180deg,rgba(8,8,7,0),rgba(8,8,7,.55) 40%,rgba(8,8,7,.86) 100%);color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.85);font-size:11px;line-height:1.55;pointer-events:none"><span style="pointer-events:auto;cursor:pointer;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden" onclick="this.classList.toggle('expanded')">${esc(m.description.slice(0, 200))}</span></div>`
    : ''

  // ── Notes / Rating / Status ──
  const note = getNote(m.id)
  const hasNotes = note && (note.notes || note.rating > 0 || note.status !== 'untried')
  const notesIcon = hasNotes
    ? `<span class="notes-indicator has-notes" onclick="event.stopPropagation();window.__openNotes(${m.id})" title="${esc(note?.notes?.slice(0, 50) || '查看备注')}">${icon('edit3', 12)}</span>`
    : `<span class="notes-indicator no-notes" onclick="event.stopPropagation();window.__openNotes(${m.id})" title="添加备注">${icon('edit3', 12)}</span>`

  const starsHtml = note && note.rating > 0
    ? `<span class="notes-stars">${'★'.repeat(note.rating)}${'☆'.repeat(5 - note.rating)}</span>`
    : ''

  const statusBadge = note && note.status !== 'untried'
    ? `<span class="model-status-badge ${note.status}">${{ trying: '🔄 尝试中', success: '✅ 好用', abandoned: '❌ 放弃' }[note.status]}</span>`
    : ''

  // ── Batch mode ──
  const { batchSelected, batchMode } = useModelStore.getState()
  const isSelected = batchSelected.has(m.id)
  const batchCheckbox = batchMode ? `<div class="batch-checkbox ${isSelected ? 'checked' : ''}" onclick="event.stopPropagation();window.__toggleBatchSelect(${m.id})">${isSelected ? '✓' : ''}</div>` : ''

  // ── Recommendations (removed for compactness) ──
  let recHtml = ''

  // ── Workflow prompt ──
  const wfBtn = m.trainedWords?.length > 0
    ? `<button class="wf-btn" onclick="event.stopPropagation();window.__copyWorkflowPrompt(${m.id},this)">${icon('zap', 12)} 工作流 Prompt</button>`
    : ''

  const promptsHtml = (m.trainedWords?.length > 0)
    ? `<details class="prompts-details" style="margin-top:4px"><summary style="cursor:pointer;font-size:10px;color:var(--text2)">🔑 触发词 (${m.trainedWords.length})</summary>
        <div class="prompts-wrap" style="margin-top:4px">${
          m.trainedWords.map(w =>
            `<div class="prompt-item"><code data-copy="${esc(w)}" onclick="event.stopPropagation();window.__copyText(this.dataset.copy,this)">${esc(w)}</code><div style="display:flex;gap:3px;flex-shrink:0"><button class="copy-btn" data-copy="${esc(w)}" onclick="event.stopPropagation();window.__copyText(this.dataset.copy,this)">${icon('copy', 12)}</button><button class="copy-btn" style="background:var(--purple-dim);color:var(--text);font-size:9px" data-ew="${esc(w)}" onclick="event.stopPropagation();window.__extractPrompt(${m.id},this.dataset.ew,this)" title="提取到 Prompt 库">${icon('plus', 12)}</button></div></div>`
          ).join('')
        }<div class="prompt-actions">
          <button class="pa-btn pa-btn-cpy" data-copy="${esc(m.trainedWords.join(', '))}" onclick="event.stopPropagation();window.__copyText(this.dataset.copy,this)">${icon('copy', 12)} 复制全部</button>
          <button class="pa-btn pa-btn-cf" data-copy="${esc(m.trainedWords.join(', ') + ', masterpiece, best quality')}" onclick="event.stopPropagation();window.__copyText(this.dataset.copy,this)">${icon('sparkles', 12)} +质量词</button>
          <button class="pa-btn pa-btn-sd" data-copy="${esc(m.trainedWords.map(w => '<lora:' + m.name.replace(/[^a-zA-Z0-9_]/g, '_') + ':' + w.replace(/^@/, '') + ':1.0>').join(' '))}" onclick="event.stopPropagation();window.__copyText(this.dataset.copy,this)">${icon('zap', 12)} ComfyUI 格式</button>
        </div></div>
      </details>`
    : ''

  const tagsHtml = (m.tags || []).slice(0, 5).map(t =>
    `<span class="tag" data-tag="${esc(t)}" onclick="event.stopPropagation();window.__searchByTag(this.dataset.tag)">${esc(t)}</span>`
  ).join('')

  const historyObj = { id: m.id, uid: m.uid, name: m.name, creator: m.creator, url: m.url, category: m.category, thumb: m.images?.[0] || '' }

  return `<div class="card${isSelected ? ' selected' : ''}" data-uid="${m.uid}" role="listitem">
    <div style="position:relative">${galleryHtml}${descOverlayHtml}${isLocal ? '<div class="local-badge-card">✅ 本地已有</div>' : ''}</div>${batchCheckbox}
    <div class="card-body">
      <div class="card-header">
        <div>
          <div class="card-title" style="font-size:12.5px"><a href="${esc(m.url)}" target="_blank" rel="noopener" data-history="${esc(JSON.stringify(historyObj))}" onclick="window.__addViewHistory(JSON.parse(this.dataset.history))">${esc(m.name)}</a> <span class="badge badge-sm ${m.badgeClass}">${m.categoryLabel}</span>${notesIcon}${starsHtml}${statusBadge}</div>
          <div class="card-creator" style="font-size:10px">👤 <a href="${esc(m.creatorUrl)}" target="_blank">${esc(m.creator)}</a><button class="creator-search" title="按作者搜索" onclick="event.stopPropagation();window.__searchCreator('${escAttr(m.creator)}')">${icon('search', 11)}</button>${m.versionName ? ' · <span style="color:var(--text3)">' + esc(m.versionName) + '</span>' : ''}</div>
        </div>
        ${m.customAdded ? '<span class="custom-badge">📌 手动</span>' : ''}${(m.quality || []).map(q => q === 'hot' ? '<span class="quality-badge hot">🔥 热门</span>' : q === 'quality' ? '<span class="quality-badge good">👍 优质</span>' : q === 'new' ? '<span class="quality-badge new">🆕 新</span>' : '').join('')}
      </div>
      ${tagsHtml ? `<div class="tags-wrap">${tagsHtml}</div>` : ''}
      ${promptsHtml}
      ${recHtml}
      <div style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap">
        ${m.versions && m.versions.length > 0
          ? `<div class="version-dropdown-wrap" data-mid="${m.id}">
              <button class="btn btn-primary version-dropdown-btn" style="flex:1;padding:5px;font-size:10px;min-width:80px">${icon('download', 12)} ${esc(m.versionName || m.versions[0].name)} ▾</button>
              <div class="version-dropdown" style="display:none">${m.versions.map(v =>
                `<div class="version-option" data-url="${esc(v.files?.[0]?.downloadUrl || '')}">${esc(v.name)}${v.files?.[0]?.name ? '<span class="version-file">' + esc(v.files[0].name) + '</span>' : ''}</div>`
              ).join('')}</div>
            </div>`
          : m.downloadUrl ? `<button class="btn btn-primary" style="flex:1;padding:5px;font-size:10px;min-width:80px" onclick="window.open('${esc(m.downloadUrl)}','_blank')">${icon('download', 12)} 下载</button>` : ''}
        ${m.versionId ? `<button class="btn btn-ghost" style="flex:0;padding:5px 8px;font-size:10px;color:var(--accent)" onclick="event.stopPropagation();window.__queueModelDownload(${m.id})" title="一键后台下载 → ComfyUI models/loras">${icon('downloadCloud', 12)}</button>` : ''}
        <button class="btn btn-ghost" style="flex:0;padding:5px 8px;font-size:10px" onclick="event.stopPropagation();window.__openNotes(${m.id})" title="备注/评分">${icon('star', 12)}</button>
        ${wfBtn}
        <button class="btn btn-ghost" style="flex:0;padding:5px 8px;font-size:10px" onclick="event.stopPropagation();window.__copyCardInfo(${m.id})" title="复制卡片信息">${icon('copy', 12)}</button>
        ${currentCategory === 'hidden'
          ? '<button class="btn" style="flex:1;padding:5px;font-size:10px;min-width:60px;background:var(--green-dim);color:var(--green)" onclick="event.stopPropagation();window.__restoreCard(' + m.id + ')">' + icon('refresh', 12) + ' 恢复</button>'
          : '<button class="btn btn-danger" style="flex:0;padding:5px 10px;font-size:10px;opacity:.6" onclick="event.stopPropagation();window.__deleteCard(' + m.id + ')" title="永久删除此 LoRA">' + icon('trash', 12) + '</button>'}
      </div>
    </div>
  </div>`
}

function renderGalleryHtml(m: ProcessedModel, imgs: string[], multi: boolean): string {
  const maxImgs = imgs.slice(0, 3)
  const track = maxImgs.map((u, i) =>
    `<img src="${esc(thumbUrl(u, 400))}" alt="" loading="${i === 0 ? 'eager' : 'lazy'}" data-uid="${m.uid}" data-imgidx="${i}" data-fullurl="${esc(u)}">`
  ).join('')
  const dots = multi ? maxImgs.map((_, i) =>
    `<span class="${i === 0 ? 'active' : ''}" data-uid="${m.uid}" data-imgidx="${i}"></span>`
  ).join('') : ''
  const fbBadge = m.fallbackDone
    ? `<span class="img-count" style="right:6px;left:auto;top:auto;bottom:74px">${icon('refreshCw', 10)} 公开图库</span>`
    : ''
  const isFavStatus = isFav(m.id)
  return `<div class="gallery" data-uid="${m.uid}">
    <button class="fav-btn ${isFavStatus ? 'on' : ''}" data-favid="${m.id}" onclick="event.stopPropagation();window.__toggleFav(${m.id},this)">${isFavStatus ? icon('star', 14) : icon('star', 14)}</button>
    <div class="gallery-track" data-uid="${m.uid}">${track}</div>
    ${multi ? `<button class="gallery-btn prev" data-uid="${m.uid}" data-dir="-1">‹</button>
    <button class="gallery-btn next" data-uid="${m.uid}" data-dir="1">›</button>
    <div class="gallery-dots">${dots}</div>
    <span class="img-count">📷 ${imgs.length}</span>` : ''}
    ${fbBadge}
  </div>`
}
