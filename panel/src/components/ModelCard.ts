import type { ProcessedModel } from '../types'
import { esc, escAttr, icon } from '../utils'
import { loraImgTag } from '../services/loraCardImage'
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

  // 绿/红状态标签（🔄尝试中 / ✅好用 / ❌放弃）已按用户要求移除（2026-09-10）：
  // 评分与状态数据仍保留在 note 里（详情/统计仍可用），只是不再渲染难看的彩色徽章。

  // ── Batch mode ──
  const { batchSelected, batchMode } = useModelStore.getState()
  const isSelected = batchSelected.has(m.id)
  const batchCheckbox = batchMode ? `<div class="batch-checkbox ${isSelected ? 'checked' : ''}" onclick="event.stopPropagation();window.__toggleBatchSelect(${m.id})">${isSelected ? '✓' : ''}</div>` : ''

  // ── Recommendations (removed for compactness) ──
  let recHtml = ''

  // 「⚡ 工作流 Prompt」按钮已随触发词一起移除（2026-09-10）：它展示/复制的都是
  // trainedWords 派生内容，用户明确表示不需要；同时少一个按钮能显著缓解
  // 按钮行换行导致的卡片底部被裁问题。

  // 触发词展示已按用户要求移除（2026-09-10）：卡片上的「🔑 触发词」折叠块不再渲染。
  // 搜索索引与复制工作流仍可用 trainedWords（仅数据层，不出现在卡片 UI）。

  const tagsHtml = (m.tags || []).slice(0, 5).map(t =>
    `<span class="tag" data-tag="${esc(t)}" onclick="event.stopPropagation();window.__searchByTag(this.dataset.tag)">${esc(t)}</span>`
  ).join('')

  const historyObj = { id: m.id, uid: m.uid, name: m.name, creator: m.creator, url: m.url, category: m.category, thumb: m.images?.[0] || '' }

  return `<div class="card${isSelected ? ' selected' : ''}" data-uid="${m.uid}" role="listitem">
    <div style="position:relative">${galleryHtml}${descOverlayHtml}</div>${batchCheckbox}
    <div class="card-body">
      <div class="card-header">
        <div>
          <div class="card-title" style="font-size:12.5px"><a href="${esc(m.url)}" target="_blank" rel="noopener" data-history="${esc(JSON.stringify(historyObj))}" onclick="window.__addViewHistory(JSON.parse(this.dataset.history))">${esc(m.name)}</a> <span class="badge badge-sm ${m.badgeClass}">${m.categoryLabel}</span>${notesIcon}${starsHtml}</div>
          <div class="card-creator" style="font-size:10px">👤 <a href="${esc(m.creatorUrl)}" target="_blank">${esc(m.creator)}</a><button class="creator-search" title="按作者搜索" onclick="event.stopPropagation();window.__searchCreator('${escAttr(m.creator)}')">${icon('search', 11)}</button>${m.versionName ? ' · <span style="color:var(--text3)">' + esc(m.versionName) + '</span>' : ''}</div>
        </div>
        ${m.customAdded ? '<span class="custom-badge">📌 手动</span>' : ''}
      </div>
      ${tagsHtml ? `<div class="tags-wrap">${tagsHtml}</div>` : ''}
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
        ${(m.versionId || m.downloadUrl) ? `<button class="btn btn-ghost" style="flex:0;padding:5px 8px;font-size:10px;color:var(--accent)" onclick="event.stopPropagation();window.__queueModelDownload(${m.id})" title="一键后台下载 → ComfyUI models/loras（有下载链接即可，无需版本 ID）">${icon('downloadCloud', 12)} 后台下载</button>` : ''}
        <button class="btn btn-ghost" style="flex:0;padding:5px 8px;font-size:10px" onclick="event.stopPropagation();window.__openNotes(${m.id})" title="备注/评分">${icon('star', 12)} 备注</button>
        <button class="btn btn-ghost" style="flex:0;padding:5px 8px;font-size:10px" onclick="event.stopPropagation();window.__copyCardInfo(${m.id})" title="复制卡片信息">${icon('copy', 12)} 信息</button>
        ${currentCategory === 'hidden'
          ? '<button class="btn" style="flex:1;padding:5px;font-size:10px;min-width:60px;background:var(--green-dim);color:var(--green)" onclick="event.stopPropagation();window.__restoreCard(' + m.id + ')">' + icon('refresh', 12) + ' 恢复</button>'
          : '<button class="btn btn-danger" style="flex:0;padding:5px 10px;font-size:10px" onclick="event.stopPropagation();window.__deleteCard(' + m.id + ')" title="永久删除此 LoRA">' + icon('trash', 12) + ' 删除</button>'}
      </div>
    </div>
  </div>`
}

function renderGalleryHtml(m: ProcessedModel, imgs: string[], multi: boolean): string {
  const maxImgs = imgs.slice(0, 3)
  const track = maxImgs.map((u, i) => loraImgTag(u, i, m.uid)).join('')
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
