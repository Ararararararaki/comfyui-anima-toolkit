import { t as tr } from '../i18n'
import { esc, escAttr } from '../utils'
import type { OutputFile, OutputMetadata, OutputDir, OutputSummary } from '../types/outputs'
import { metadataForFile, promptBody } from '../services/outputIdentity'
import { outputContentKey, fileSourceIdentity } from '../services/outputSources'
import { icon } from '../utils/icon'
import { CLAMP_MAX_ASPECT } from '../components/masonry'
import { renderGenerationDetails } from './outputGenerationDetails'
import { parseMetadataJSON } from '../services/metadataJSON'

// ── 状态标签定义 ──

export const STATUS_DEFS: Record<string, { label: string; color: string }> = {
  approved: { label: tr("workspace.approved"), color: '#22c55e' },
  review:   { label: tr("workspace.toReview"), color: '#eab308' },
  edit:     { label: tr("workspace.needsChanges"), color: '#f97316' },
  rejected: { label: tr("workspace.rejected"), color: '#ef4444' },
  select:   { label: tr("workspace.featured"), color: '#666666' },
}

// ── 目录树渲染 ──

export function renderDirTree(dir: OutputDir | null, currentPath: string): string {
  if (!dir) {
    return `<div class="outputs-empty-sidebar"><p>${tr("workspace.addAFolderToStartScanning", { p0: icon('folder', 16) })}</p></div>`
  }
  return renderDirNode(dir, 0, currentPath)
}

function renderDirNode(dir: OutputDir, depth: number, currentPath: string): string {
  const indent = depth * 16
  const hasChildren = dir.children.length > 0
  const isCurrentPath = currentPath === dir.path

  let html = `<div class="outputs-dir-node ${isCurrentPath ? 'active' : ''}"
    style="padding-left:${indent}px"
    data-path="${escAttr(dir.path)}">
    <span class="outputs-dir-arrow ${hasChildren ? 'has-children' : ''}">${hasChildren ? icon('chevronRight', 12) : ''}</span>
    <span class="outputs-dir-icon">${icon('folder', 14)}</span>
    <span class="outputs-dir-name">${esc(dir.name)}</span>
    <span class="outputs-dir-count">${dir.fileCount}</span>
  </div>`

  for (const child of dir.children) {
    html += renderDirNode(child, depth + 1, currentPath)
  }

  return html
}

// ── 图片网格渲染 ──

export function renderGrid(
  files: OutputFile[],
  selectedIds: Set<string>,
  metadataCache: Map<string, OutputMetadata>,
  lorasCache?: Map<string, string[]>,
): string {
  if (files.length === 0) return ''
  return files.map(f => {
    const meta = metadataCache.get(f.id)
    const loras = lorasCache?.get(f.id)
    return renderImageCard(f, meta ?? null, selectedIds.has(f.id), loras)
  }).join('')
}

export function renderImageCard(file: OutputFile, meta: OutputMetadata | null, isSelected: boolean, loras?: string[], sig?: string, thumbSrc?: string, boxAspect?: number, summary?: OutputSummary): string {
  const st = file.status ? STATUS_DEFS[file.status] : null
  const masonry = boxAspect ? ' masonry' : ''
  // 图片区高度**不再由 JS 内联**：一旦同时定死宽和高，CSS 的 aspect-ratio 与
  // <img> 的固有比例都会被忽略（MDN：「宽和高都确定时 aspect-ratio 不起作用」），
  // 盒子比例只能由外部决定，图片就只剩被 object-fit 裁切一条路 ——
  // 这正是「所有卡片高度被统一成同一个值、图片被裁」的根源。
  // 改为只传「盒子宽高比」，让浏览器按 高度 = 宽度 ÷ 比例 自己算。
  // boxAspect 由布局层给出（= 装箱时实际使用的比例，极端比例已按上下限截断），
  // 因此 CSS 反算出的高度与布局的 imgHeights 严格一致；没有布局信息时退回原图比例。
  const fileRatio = file.width > 0 && file.height > 0 ? file.width / file.height : 0
  const arValue = boxAspect || fileRatio || 'auto'
  // 超高图（h/w 超 CLAMP_MAX_ASPECT，布局层已按上限截断盒子比例）→ 加类，
  // 用 object-fit:contain 完整嵌入，避免被 cover 裁掉主体。
  // 超宽图不再截断：布局层用「跨 2/3 列」给它足够的宽度，保持真实比例零裁切。
  const cardAspect = file.width > 0 && file.height > 0 ? file.height / file.width : 1
  const clampClass = cardAspect > CLAMP_MAX_ASPECT ? ' tall-clamped' : ''
  return `<div class="outputs-card ${isSelected ? 'selected' : ''}${file.status ? ` status-${file.status}` : ''}${masonry}${clampClass}" data-id="${escAttr(file.id)}" data-path="${escAttr(file.path)}"${sig ? ` data-sig="${escAttr(sig)}"` : ''}>
    <div class="outputs-card-img" style="--card-ar:${arValue}" draggable="true" data-output-drag="${escAttr(file.id)}" title="${tr("workspace.dragACleanImageCopy")}">
      ${st ? `<div class="outputs-card-status-tag" style="background:${st.color}">${st.label}</div>` : ''}
      <img src="${escAttr(thumbSrc || '')}" draggable="false" data-file-id="${escAttr(file.id)}" data-file-path="${escAttr(file.path)}" data-cache-key="${escAttr(outputContentKey(file))}" data-file-version="${escAttr(sig || `${file.mtime}:${file.size}`)}" alt="${esc(file.filename)}" loading="eager">
      <div class="outputs-card-actions-top">
        ${file.pinned ? `<span class="outputs-card-pinned-icon">${icon('pin', 12)}</span>` : ''}
      </div>
      <div class="outputs-card-overlay">
        <button class="outputs-card-btn outputs-preview-btn" data-id="${escAttr(file.id)}" title="${tr("workspace.preview")}">${icon('eye', 14)}</button>
      </div>
      ${file.rating > 0 ? `<div class="outputs-card-rating">${'★'.repeat(file.rating)}${'☆'.repeat(5 - file.rating)}</div>` : ''}
    </div>
    <div class="outputs-card-info">
      <div class="outputs-card-name" title="${esc(file.filename)}">${esc(file.filename)}</div>
      <div class="outputs-card-meta">
        ${renderTagSource(summary)}
        ${file.category ? `<span class="outputs-card-category" title="${tr("workspace.category3", { p0: esc(file.category) })}">🏷 ${esc(file.category)}</span>` : ''}
        ${meta?.model ? `<span class="outputs-card-model" title="${esc(meta.model)}">${esc(meta.model.slice(0, 20))}</span>` : ''}
        <span class="outputs-card-size">${fmtSize(file.size)}</span>
      </div>
      <div class="outputs-card-date">${fmtDate(file.mtime)}</div>
      <div class="outputs-card-actions">
        <button class="outputs-fav-btn" data-id="${escAttr(file.id)}" aria-label="${file.favorite ? tr("workspace.removeFavorite") : tr("workspace.favorite")}" aria-pressed="${file.favorite}">${icon('star', 14, file.favorite ? 'fill-icon' : '')}</button>
        <button class="outputs-card-more" data-id="${escAttr(file.id)}" aria-label="${tr("workspace.imageActions")}" aria-haspopup="menu" title="${tr("workspace.imageActionsCopyDownloadPromptAndMetadata")}">${icon('moreHorizontal', 16)}</button>
      </div>
    </div>
  </div>`
}

// ── 列表视图渲染 ──

export function renderList(files: OutputFile[], selectedIds: Set<string>, metadataCache: Map<string, OutputMetadata>, root?: string, parserVersion?: number, summaries?: Map<string, OutputSummary>): string {
  return `<div class="outputs-list">
    ${files.map(f => renderListCard(f, selectedIds, metadataCache, root, parserVersion, summaries?.get(f.id))).join('')}
  </div>`
}

function renderListCard(file: OutputFile, selectedIds: Set<string>, metadataCache: Map<string, OutputMetadata>, root?: string, parserVersion?: number, summary?: OutputSummary): string {
  if (file.sourceId) { const identity = fileSourceIdentity(file); root = identity.root; parserVersion = identity.parserVersion }
  const meta = metadataForFile(metadataCache, file, root, parserVersion)
  const isSelected = selectedIds.has(file.id)
  const st = file.status ? STATUS_DEFS[file.status] : null
  return `<div class="outputs-list-card ${isSelected ? 'selected' : ''}" data-id="${escAttr(file.id)}" data-path="${escAttr(file.path)}">
    <div class="outputs-list-card-top">
      <input type="checkbox" class="outputs-list-chk" data-id="${escAttr(file.id)}" ${isSelected ? 'checked' : ''}>
      ${file.pinned ? `<span class="outputs-list-pinned">${icon('pin', 10)}</span>` : ''}
      ${st ? `<span class="outputs-list-status-dot" style="background:${st.color}" title="${st.label}"></span>` : ''}
    </div>
    <div class="outputs-list-card-img" draggable="true" data-output-drag="${escAttr(file.id)}" title="${tr("workspace.dragACleanImageCopy")}">
      <img src="" draggable="false" data-file-id="${escAttr(file.id)}" data-file-path="${escAttr(file.path)}" data-cache-key="${escAttr(outputContentKey(file))}" data-file-version="${escAttr(JSON.stringify([root || '', file.path, file.mtime, file.size]))}" alt="${escAttr(file.filename)}" loading="lazy">
    </div>
    <div class="outputs-list-card-body">
      <div class="outputs-list-card-name" title="${esc(file.filename)}">${esc(file.filename)}</div>
      <div class="outputs-list-card-meta">
        ${renderTagSource(summary)}
        ${file.category ? `<span class="outputs-card-category" title="${tr("workspace.category3", { p0: esc(file.category) })}">🏷 ${esc(file.category)}</span>` : ''}
        <span>${meta?.model ? esc(meta.model.slice(0, 20)) : '-'}</span>
        <span>${fmtSize(file.size)}</span>
        <span>${new Date(file.mtime).toLocaleDateString()}</span>
      </div>
      <div class="outputs-list-card-actions">
        <button class="outputs-action-btn outputs-fav-btn" data-id="${escAttr(file.id)}" aria-label="${file.favorite ? tr("workspace.removeFavorite") : tr("workspace.favorite")}" aria-pressed="${file.favorite}">${icon('star', 14, file.favorite ? 'fill-icon' : '')}</button>
        <button class="outputs-action-btn outputs-preview-btn" data-id="${escAttr(file.id)}" title="${tr("workspace.preview")}">${icon('eye', 14)}</button>
        <button class="outputs-action-btn outputs-card-more" data-id="${escAttr(file.id)}" aria-label="${tr("workspace.imageActions")}" aria-haspopup="menu">${icon('moreHorizontal', 16)}</button>
      </div>
    </div>
  </div>`
}

// ── 空状态渲染 ──

export function renderEmpty(dirHandle: boolean): string {
  return `<div class="outputs-empty">
    <div class="big">${icon('image', 28)}</div>
    <p>${dirHandle ? tr("workspace.noImagesInThisFolder") : tr("workspace.chooseAComfyuiOutputFolderToManage")}</p>
    ${!dirHandle ? `<button class="btn btn-primary outputs-select-btn" data-icon="folder"><span>${tr("workspace.chooseFolder")}</span></button>` : ''}
  </div>`
}

/** 空状态（库里有图、但被筛选/路径过滤成空）：明确提示可能残留筛选，并提供一键清除 */
export function renderFilteredEmpty(): string {
  return `<div class="outputs-empty">
    <div class="big">${icon('filter', 28)}</div>
    <p>${tr("workspace.noImagesMatchTheseFilters")}</p>
    <p class="sub">${tr("workspace.imagesMayBeHiddenByASaved")}</p>
    <button type="button" id="outputsClearFiltersBtn" class="btn btn-primary"><span>${tr("workspace.clearFiltersAndShowAll")}</span></button>
  </div>`
}

// ── 统计栏渲染 ──

export function renderStats(total: number, filtered: number, selected: number): string {
  return `
    <span>${tr("workspace.images3", { p0: filtered })}</span>
    ${total !== filtered ? `<span>${tr("workspace.total", { p0: total })}</span>` : ''}
    ${selected > 0 ? `<span class="outputs-stats-selected">${tr("workspace.imagesSelected", { p0: selected })}</span>` : ''}
  `
}

// ── 元数据面板渲染 ──

export function renderMetadataPanel(meta: OutputMetadata | null, file: OutputFile): string {
  const hasWorkflow = !!meta?.workflowJson
  const header = `<div class="outputs-meta-header">
    <h3>${tr("workspace.metadata")}</h3>
    ${hasWorkflow ? `<button class="outputs-meta-copy-btn" id="outputsMetaCopyWorkflowBtn" title="${tr("workspace.downloadWorkflowJson2")}">${icon('download', 12)}</button>` : ''}
    <button class="outputs-meta-close-btn" id="outputsMetaCloseBtn" title="${tr("workspace.closePanel")}">${icon('x', 14)}</button>
  </div>`

  if (!meta) return `${header}<div class="outputs-meta-empty">${tr("workspace.metadataCouldNotBeReadOrFound")}<button id="outputsMetaRetryBtn" class="btn btn-sm">${tr("workspace.reparse")}</button></div>`

  const workflowSection = hasWorkflow ? renderWorkflowSection(meta.workflowJson) : ''
  const needsRetry = meta.metadataState === 'error' || meta.metadataState === 'unknown' || ['partial', 'ambiguous', 'missing'].includes(meta.promptStatus || '')
  const stages = meta.promptStages || []
  const copyAttribute = (value: string) => ['missing', 'ambiguous'].includes(meta.promptStatus || '') ? '' : ` data-copy="${escAttr(value)}"`
  const prompts = stages.length > 1 ? stages.map(stage => `<div class="outputs-meta-section"><h4>${esc(stage.label || tr("workspace.stage", { p0: stage.nodeId }))}</h4>${stage.prompt ? `<div class="outputs-meta-prompt"${copyAttribute(stage.prompt)}>${esc(stage.prompt)}</div>` : ''}${stage.negativePrompt ? `<h4>${tr("workspace.negativePrompt3")}</h4><div class="outputs-meta-prompt"${copyAttribute(stage.negativePrompt)}>${esc(stage.negativePrompt)}</div>` : ''}</div>`).join('') : `${meta.prompt ? `<div class="outputs-meta-section"><h4>${tr("workspace.positivePrompt2")}</h4><div class="outputs-meta-prompt"${copyAttribute(meta.prompt)}>${esc(meta.prompt)}</div></div>` : ''}${meta.negativePrompt ? `<div class="outputs-meta-section"><h4>${tr("workspace.negativePrompt3")}</h4><div class="outputs-meta-prompt"${copyAttribute(meta.negativePrompt)}>${esc(meta.negativePrompt)}</div></div>` : ''}`

  return `
    ${header}
    ${renderGenerationDetails(meta)}
    <div class="outputs-meta-section">
      <h4>${tr("workspace.imageInfo")}</h4>
      <div class="outputs-meta-row"><span>${tr("workspace.dimensions")}</span><span>${file.width} × ${file.height}</span></div>
    </div>
    ${needsRetry ? `<div class="outputs-meta-section"><button id="outputsMetaRetryBtn">${tr("workspace.reparse")}</button></div>` : ''}
    ${prompts}
    ${workflowSection}
  `
}

// ── 高级筛选面板 ──

export interface FilterPanelState {
  filterModel: string
  filterLora: string
  filterSeedMin: string
  filterSeedMax: string
  filterStepsMin: string
  filterStepsMax: string
  filterTag: string
}

function renderWorkflowSection(workflowJson: string): string {
  try {
    const workflow = parseMetadataJSON(workflowJson)
    if (!workflow || typeof workflow !== 'object') throw new Error('invalid-workflow')
    const nodes: any = workflow.nodes
    const promptFormat = !Array.isArray(nodes) && typeof workflow === 'object' && !workflow.nodes
    let nodeList: any[] = []

    if (Array.isArray(nodes)) {
      // API 格式: { nodes: [{ id, type, inputs }] }
      nodeList = nodes
    } else if (promptFormat) {
      // Prompt 格式: { "nodeId": { class_type, inputs } }
      nodeList = Object.entries(workflow).map(([id, n]: [string, any]) => ({
        id: parseInt(id) || id,
        type: n?.class_type || 'unknown',
        inputs: n?.inputs || {},
        _meta: n?._meta,
      }))
    }

    const totalNodes = nodeList.length
    const initialLimit = 20
    const showAll = totalNodes <= initialLimit

    const nodeItems = nodeList.map((n: any, i: number) => {
      const type = n.type || 'unknown'
      const title = n.title || n._meta?.title || ''
      const inputs = n.inputs || {}
      const params: string[] = []

      // 提取关键参数
      const important = ['seed', 'steps', 'cfg', 'sampler_name', 'ckpt_name', 'lora_name',
        'strength_model', 'strength_clip', 'vae_name', 'model_name', 'text', 'noise_seed']
      for (const key of important) {
        if (inputs[key] !== undefined && inputs[key] !== null) {
          params.push(`${key}: ${inputs[key]}`)
        }
      }
      // 也显示非无关的其他参数
      const skip = new Set(['seed', 'steps', 'cfg', 'sampler_name', 'ckpt_name', 'lora_name',
        'strength_model', 'strength_clip', 'vae_name', 'model_name', 'text', 'noise_seed',
        'model', 'clip', 'vae', 'positive', 'negative', 'image', 'images', 'latent_image',
        'samples', 'conditioning', 'denoise'])
      for (const [k, v] of Object.entries(inputs)) {
        if (!skip.has(k) && v !== undefined && v !== null && typeof v !== 'object') {
          params.push(`${k}: ${v}`)
        }
      }

      const headerText = title ? `${type} (${title})` : type
      const hiddenClass = showAll ? '' : (i >= initialLimit ? 'node-hidden' : '')
      return `<div class="outputs-node-item${hiddenClass ? ' node-hidden' : ''}" data-node-index="${i}">
        <div class="outputs-node-header">${icon('layers', 12)} ${esc(headerText)} <span class="outputs-node-id">#${esc(String(n.id ?? i))}</span></div>
        ${params.length > 0 ? `<div class="outputs-node-params">${params.map(p => `<span class="outputs-node-param">${esc(p)}</span>`).join('')}</div>` : ''}
      </div>`
    }).join('')

    return `
    <div class="outputs-meta-section outputs-workflow-section">
      <div class="outputs-workflow-toggle" id="outputsWorkflowToggle">
        <span>${tr("workspace.nodeSummary2", { p0: icon('layers', 12), p1: totalNodes > 0 ? ` <small>${tr("workspace.nodes", { p0: totalNodes })}</small>` : '' })}</span>
        <span class="outputs-workflow-toggle-arrow">${icon('chevronRight', 12)}</span>
      </div>
      <div class="outputs-workflow-content outputs-workflow-collapsed" id="outputsWorkflowContent">
        <div class="outputs-node-list">
          ${nodeItems}
          ${totalNodes > initialLimit ? `<div class="outputs-node-more" id="outputsNodeMoreBtn">${tr("workspace.viewAllNodes", { p0: icon('file-text', 12), p1: totalNodes })}</div>` : ''}
        </div>
      </div>
    </div>`
  } catch {
    return `
    <div class="outputs-meta-section outputs-workflow-section">
      <div class="outputs-workflow-toggle" id="outputsWorkflowToggle">
        <span>${tr("workspace.nodeSummary", { p0: icon('layers', 12) })}</span>
        <span class="outputs-workflow-toggle-arrow">${icon('chevronRight', 12)}</span>
      </div>
      <div class="outputs-workflow-content outputs-workflow-collapsed" id="outputsWorkflowContent">
        <div class="outputs-node-list">
          <div style="font-size:11px;color:var(--text3);padding:4px 0">${tr("workspace.theWorkflowFormatCouldNotBeParsed")}</div>
        </div>
      </div>
    </div>`
  }
}

// ── 工具函数 ──
function renderTagSource(summary?: OutputSummary): string {
  if (summary?.tagSource === 'wd14' || summary?.inferredTags?.length) {
    const source = summary.inferenceModel?.startsWith('CCIP') ? tr("workspace.similarImageRecognition")
      : summary.inferenceModel?.startsWith('PixAI') ? tr("workspace.pixaiRecognition") : 'WD14'
    return `<span class="outputs-tag-source" title="${tr("workspace.locallyInferredTagsOriginalMetadataIsRetained", { p0: esc(source) })}">${icon('tag', 11)} ${source}</span>`
  }
  if (summary?.indexStatus === 'ready' && !summary.prompt.trim()) return `<span class="outputs-tag-source" title="${tr("workspace.noSearchablePositivePromptWasSaved")}">${tr("workspace.noPrompt")}</span>`
  return ''
}

function fmtSize(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB'
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

/** 文件创建时间 → `YYYY-MM-DD HH:mm` */
function fmtDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
