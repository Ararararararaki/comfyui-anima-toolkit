// ── Outputs 模块渲染辅助函数 ──
// 纯函数：输入数据 → HTML string，不操作 DOM 或状态
// 职责：从 `src/sections/Outputs.ts` 中提取，降低文件复杂度

import { esc, escAttr } from '../utils'
import type { OutputFile, OutputMetadata, OutputDir } from '../types/outputs'
import { icon } from '../utils/icon'

// ── 状态标签定义 ──

export const STATUS_DEFS: Record<string, { label: string; color: string }> = {
  approved: { label: '通过', color: '#22c55e' },
  review:   { label: '待审', color: '#eab308' },
  edit:     { label: '待修', color: '#f97316' },
  rejected: { label: '驳回', color: '#ef4444' },
  select:   { label: '精选', color: '#3b82f6' },
}

// ── 目录树渲染 ──

export function renderDirTree(dir: OutputDir | null, currentPath: string): string {
  if (!dir) {
    return '<div class="outputs-empty-sidebar"><p>📁 选择目录开始扫描</p></div>'
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
    <span class="outputs-dir-arrow ${hasChildren ? 'has-children' : ''}">${hasChildren ? '▶' : ''}</span>
    <span class="outputs-dir-icon">${hasChildren ? '📂' : '📁'}</span>
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

function renderImageCard(file: OutputFile, meta: OutputMetadata | null, isSelected: boolean, loras?: string[]): string {
  const st = file.status ? STATUS_DEFS[file.status] : null
  return `<div class="outputs-card ${isSelected ? 'selected' : ''}${file.status ? ` status-${file.status}` : ''}" data-id="${escAttr(file.id)}" data-path="${escAttr(file.path)}">
    <div class="outputs-card-img">
      ${st ? `<div class="outputs-card-status-tag" style="background:${st.color}">${st.label}</div>` : ''}
      <img src="" data-file-id="${escAttr(file.id)}" data-file-path="${escAttr(file.path)}" alt="${esc(file.filename)}" loading="lazy">
      <div class="outputs-card-actions-top">
        ${file.pinned ? `<span class="outputs-card-pinned-icon">${icon('pin', 12)}</span>` : ''}
        <button class="outputs-card-fav-icon ${file.favorite ? 'active' : ''}" data-id="${escAttr(file.id)}" title="收藏">${icon('star', 14)}</button>
      </div>
      <div class="outputs-card-overlay">
        <button class="outputs-card-btn outputs-pin-btn" data-id="${escAttr(file.id)}" title="${file.pinned ? '取消置顶' : '置顶'}">${icon(file.pinned ? 'pin' : 'pin', 13, file.pinned ? 'fill-icon' : '')}</button>
        <button class="outputs-card-btn outputs-copy-btn" data-id="${escAttr(file.id)}" title="复制图片">${icon('copy', 13)}</button>
        <button class="outputs-card-btn outputs-download-btn" data-id="${escAttr(file.id)}" title="下载">${icon('download', 13)}</button>
        <button class="outputs-card-btn outputs-preview-btn" data-id="${escAttr(file.id)}" title="预览">${icon('eye', 13)}</button>
        <button class="outputs-card-btn outputs-rename-btn" data-id="${escAttr(file.id)}" data-name="${escAttr(file.filename)}" title="重命名">${icon('edit3', 13)}</button>
      </div>
      ${file.rating > 0 ? `<div class="outputs-card-rating">${'★'.repeat(file.rating)}${'☆'.repeat(5 - file.rating)}</div>` : ''}
    </div>
    <div class="outputs-card-info">
      <div class="outputs-card-name" title="${esc(file.filename)}">${esc(file.filename)}</div>
      <div class="outputs-card-meta">
        ${meta?.model ? `<span class="outputs-card-model" title="${esc(meta.model)}">${esc(meta.model.slice(0, 20))}</span>` : ''}
        <span class="outputs-card-size">${fmtSize(file.size)}</span>
      </div>
      <div class="outputs-card-actions">
        ${meta?.prompt ? `<button class="outputs-copy-prompt-btn" data-id="${escAttr(file.id)}" title="复制正面 Prompt">${icon('fileText', 12)} 正面 Prompt</button>` : ''}
        ${meta?.workflowJson ? `<button class="outputs-copy-lora-btn" data-id="${escAttr(file.id)}" title="复制 LoRA 标签">${icon('tag', 12)} LoRA 标签</button>` : ''}
      </div>
      ${loras && loras.length > 0
        ? `<div class="outputs-card-loras">${loras.slice(0, 3).map(l => `<span class="outputs-lora-chip">${esc(l)}</span>`).join('')}${loras.length > 3 ? `<span class="outputs-lora-more">+${loras.length - 3}</span>` : ''}</div>`
        : ''}
    </div>
  </div>`
}

// ── 列表视图渲染 ──

export function renderList(files: OutputFile[], selectedIds: Set<string>, metadataCache: Map<string, OutputMetadata>): string {
  return `<div class="outputs-list">
    ${files.map(f => renderListCard(f, selectedIds, metadataCache)).join('')}
  </div>`
}

function renderListCard(file: OutputFile, selectedIds: Set<string>, metadataCache: Map<string, OutputMetadata>): string {
  const meta = metadataCache.get(file.id)
  const isSelected = selectedIds.has(file.id)
  const st = file.status ? STATUS_DEFS[file.status] : null
  return `<div class="outputs-list-card ${isSelected ? 'selected' : ''}" data-id="${escAttr(file.id)}">
    <div class="outputs-list-card-top">
      <input type="checkbox" class="outputs-list-chk" data-id="${escAttr(file.id)}" ${isSelected ? 'checked' : ''}>
      ${file.pinned ? `<span class="outputs-list-pinned">${icon('pin', 10)}</span>` : ''}
      ${st ? `<span class="outputs-list-status-dot" style="background:${st.color}" title="${st.label}"></span>` : ''}
    </div>
    <div class="outputs-list-card-img">
      <img src="" data-file-id="${escAttr(file.id)}" data-file-path="${escAttr(file.path)}" alt="" loading="lazy">
    </div>
    <div class="outputs-list-card-body">
      <div class="outputs-list-card-name" title="${esc(file.filename)}">${esc(file.filename)}</div>
      <div class="outputs-list-card-meta">
        <span>${meta?.model ? esc(meta.model.slice(0, 20)) : '-'}</span>
        <span>${fmtSize(file.size)}</span>
        <span>${new Date(file.mtime).toLocaleDateString()}</span>
      </div>
      <div class="outputs-list-card-actions">
        <button class="outputs-action-btn outputs-fav-btn" data-id="${escAttr(file.id)}" title="收藏">${icon('star', 14, file.favorite ? 'fill-icon' : '')}</button>
        <button class="outputs-action-btn outputs-preview-btn" data-id="${escAttr(file.id)}" title="预览">${icon('eye', 14)}</button>
        <button class="outputs-action-btn outputs-rename-btn" data-id="${escAttr(file.id)}" data-name="${escAttr(file.filename)}" title="重命名">${icon('edit3', 14)}</button>
      </div>
    </div>
  </div>`
}

// ── 空状态渲染 ──

export function renderEmpty(dirHandle: boolean): string {
  return `<div class="outputs-empty">
    <div class="big">🖼️</div>
    <p>${dirHandle ? '当前目录没有图片' : '选择 ComfyUI 输出目录开始管理图片'}</p>
    ${!dirHandle ? '<button class="btn btn-primary outputs-select-btn">📁 选择目录</button>' : ''}
  </div>`
}

// ── 统计栏渲染 ──

export function renderStats(total: number, filtered: number, selected: number): string {
  return `
    <span>共 ${filtered} 张图片</span>
    ${total !== filtered ? `<span>（总计 ${total}）</span>` : ''}
    ${selected > 0 ? `<span class="outputs-stats-selected">已选 ${selected} 张</span>` : ''}
  `
}

// ── 元数据面板渲染 ──

export function renderMetadataPanel(meta: OutputMetadata | null, file: OutputFile): string {
  const hasWorkflow = !!meta?.workflowJson
  const header = `<div class="outputs-meta-header">
    <h3>元数据</h3>
    ${hasWorkflow ? `<button class="outputs-meta-copy-btn" id="outputsMetaCopyWorkflowBtn" title="复制工作流 JSON">📋</button>` : ''}
    <button class="outputs-meta-close-btn" id="outputsMetaCloseBtn" title="关闭面板">✕</button>
  </div>`

  if (!meta) return `${header}<div class="outputs-meta-empty">无元数据</div>`

  const workflowSection = hasWorkflow ? renderWorkflowSection(meta.workflowJson) : ''

  return `
    ${header}
    <div class="outputs-meta-section">
      <h4>模型信息</h4>
      <div class="outputs-meta-row"><span>模型</span><span>${esc(meta.model || '-')}</span></div>
      <div class="outputs-meta-row"><span>VAE</span><span>${esc(meta.vae || '-')}</span></div>
      <div class="outputs-meta-row"><span>采样器</span><span>${esc(meta.sampler || '-')}</span></div>
    </div>
    <div class="outputs-meta-section">
      <h4>生成参数</h4>
      <div class="outputs-meta-row"><span>种子</span><span>${esc(meta.seed || '-')}</span></div>
      <div class="outputs-meta-row"><span>步数</span><span>${esc(meta.steps || '-')}</span></div>
      <div class="outputs-meta-row"><span>CFG</span><span>${esc(meta.cfg || '-')}</span></div>
      <div class="outputs-meta-row"><span>尺寸</span><span>${file.width} × ${file.height}</span></div>
    </div>
    ${meta.prompt ? `
    <div class="outputs-meta-section">
      <h4>正向提示词</h4>
      <div class="outputs-meta-prompt" data-copy="${escAttr(meta.prompt)}">${esc(meta.prompt)}</div>
    </div>` : ''}
    ${meta.negativePrompt ? `
    <div class="outputs-meta-section">
      <h4>负向提示词</h4>
      <div class="outputs-meta-prompt" data-copy="${escAttr(meta.negativePrompt)}">${esc(meta.negativePrompt)}</div>
    </div>` : ''}
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

export function renderFilterPanel(
  filters: FilterPanelState,
  models: string[],
  loras: string[]
): string {
  const modelOptions = models.map(m =>
    `<option value="${escAttr(m)}"${filters.filterModel === m ? ' selected' : ''}>${esc(m)}</option>`
  ).join('')

  const loraOptions = loras.map(l =>
    `<option value="${escAttr(l)}"${filters.filterLora === l ? ' selected' : ''}>${esc(l)}</option>`
  ).join('')

  const hasAny = filters.filterModel || filters.filterLora || filters.filterSeedMin ||
    filters.filterSeedMax || filters.filterStepsMin || filters.filterStepsMax || filters.filterTag

  return `
    <div class="outputs-filter-panel">
      <div class="outputs-filter-panel-header" id="outputsFilterToggle">
        <span>🔍 高级筛选</span>
        <span class="outputs-filter-toggle-arrow${hasAny ? ' expanded' : ''}">▶</span>
      </div>
      <div class="outputs-filter-panel-body${hasAny ? '' : ' collapsed'}" id="outputsFilterBody">
        ${models.length > 0 ? `
        <div class="outputs-filter-group">
          <label>模型</label>
          <input type="text" class="outputs-filter-input outputs-filter-model" placeholder="输入模型名..." value="${escAttr(filters.filterModel)}">
          <datalist id="outputsModelList">${modelOptions}</datalist>
        </div>` : ''}
        ${loras.length > 0 ? `
        <div class="outputs-filter-group">
          <label>LoRA</label>
          <input type="text" class="outputs-filter-input outputs-filter-lora" placeholder="输入 LoRA 名..." value="${escAttr(filters.filterLora)}">
          <datalist id="outputsLoraList">${loraOptions}</datalist>
        </div>` : ''}
        <div class="outputs-filter-group">
          <label>种子范围</label>
          <div class="outputs-filter-range">
            <input type="number" class="outputs-filter-input outputs-filter-seed-min" placeholder="最小" value="${escAttr(filters.filterSeedMin)}">
            <span>~</span>
            <input type="number" class="outputs-filter-input outputs-filter-seed-max" placeholder="最大" value="${escAttr(filters.filterSeedMax)}">
          </div>
        </div>
        <div class="outputs-filter-group">
          <label>步数范围</label>
          <div class="outputs-filter-range">
            <input type="number" class="outputs-filter-input outputs-filter-steps-min" placeholder="最小" value="${escAttr(filters.filterStepsMin)}">
            <span>~</span>
            <input type="number" class="outputs-filter-input outputs-filter-steps-max" placeholder="最大" value="${escAttr(filters.filterStepsMax)}">
          </div>
        </div>
        ${hasAny ? '<button class="btn btn-ghost btn-xs outputs-filter-clear" style="margin-top:8px;width:100%">✕ 清除筛选</button>' : ''}
      </div>
    </div>`
}

function renderWorkflowSection(workflowJson: string): string {
  try {
    const workflow = JSON.parse(workflowJson)
    const nodes: any[] = workflow.nodes || []
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
        <div class="outputs-node-header">🔷 ${esc(headerText)} <span class="outputs-node-id">#${n.id ?? i}</span></div>
        ${params.length > 0 ? `<div class="outputs-node-params">${params.map(p => `<span class="outputs-node-param">${esc(p)}</span>`).join('')}</div>` : ''}
      </div>`
    }).join('')

    return `
    <div class="outputs-meta-section outputs-workflow-section">
      <div class="outputs-workflow-toggle" id="outputsWorkflowToggle">
        <span>📋 节点摘要${totalNodes > 0 ? ` <small>(${totalNodes} 节点)</small>` : ''}</span>
        <span class="outputs-workflow-toggle-arrow">▶</span>
      </div>
      <div class="outputs-workflow-content outputs-workflow-collapsed" id="outputsWorkflowContent">
        <div class="outputs-node-list">
          ${nodeItems}
          ${totalNodes > initialLimit ? `<div class="outputs-node-more" id="outputsNodeMoreBtn">📄 查看全部 ${totalNodes} 个节点</div>` : ''}
        </div>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;font-size:10px;color:var(--text3);padding:4px 0">原始 JSON</summary>
          <pre style="font-size:10px;overflow-x:auto;margin-top:4px;background:var(--bg);padding:8px;border-radius:6px;max-height:300px;overflow-y:auto">${esc(JSON.stringify(workflow, null, 2))}</pre>
        </details>
      </div>
    </div>`
  } catch {
    return `
    <div class="outputs-meta-section outputs-workflow-section">
      <div class="outputs-workflow-toggle" id="outputsWorkflowToggle">
        <span>📋 节点摘要</span>
        <span class="outputs-workflow-toggle-arrow">▶</span>
      </div>
      <div class="outputs-workflow-content outputs-workflow-collapsed" id="outputsWorkflowContent">
        <div class="outputs-node-list">
          <div style="font-size:11px;color:var(--text3);padding:4px 0">工作流数据格式无法解析，可查看原始 JSON</div>
        </div>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;font-size:10px;color:var(--text3);padding:4px 0">原始 JSON</summary>
          <pre style="font-size:10px;overflow-x:auto;margin-top:4px;background:var(--bg);padding:8px;border-radius:6px;max-height:300px;overflow-y:auto">${esc(workflowJson)}</pre>
        </details>
      </div>
    </div>`
  }
}

// ── 工具函数 ──

function fmtSize(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB'
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}
