import { esc } from '../utils'
import type { OutputMetadata, PromptStatus } from '../types/outputs'

type DetailMetadata = Partial<OutputMetadata> & { raw?: Record<string, string> }

const promptLabels: Record<PromptStatus, string> = {
  complete: '提示词完整', partial: '提示词部分可恢复',
  ambiguous: '提示词所属分支不确定', missing: '未找到可靠提示词',
}
const generationLabels: Record<PromptStatus, string> = {
  complete: '生成配置完整', partial: '生成配置部分可恢复',
  ambiguous: '生成配置所属分支不确定', missing: '未找到生成配置',
}

function row(label: string, value: string | number | null | undefined): string {
  const text = value === '' || value == null ? '未记录' : String(value)
  return `<div class="outputs-meta-row" style="gap:12px;align-items:baseline"><span style="flex-shrink:0">${esc(label)}</span><span style="min-width:0;overflow-wrap:anywhere;text-align:right">${esc(text)}</span></div>`
}

/** Presence, prompt recovery and output association are separate facts. */
export function renderMetadataReliability(meta: DetailMetadata): string {
  const states = {
    present: '已保存元数据', absent: '已完成读取，未保存元数据',
    error: '元数据读取失败，已读字段仍保留', unsupported: '暂不支持此图片格式',
    unknown: '元数据状态未知，请重新解析',
  }
  const warnings = [...new Set([...(meta.metadataWarnings || []), ...(meta.promptWarnings || []), ...(meta.generationWarnings || [])])]
  const promptLabel = meta.promptStatus === 'missing'
    ? meta.hasWorkflow ? '有工作流，但未记录可核验的本图提示词' : '图片未保存可恢复的生成提示词'
    : meta.promptStatus ? promptLabels[meta.promptStatus] : '可靠性未记录'
  const scope = meta.generationScope === 'output'
    ? `输出链配置${meta.generationOutputNodeId ? ` · 输出节点 ${meta.generationOutputNodeId}` : ''}`
    : meta.generationScope === 'recorded' ? '记录配置 · 图片所属输出链未核验' : '配置范围未记录'
  return `<div class="outputs-meta-section" data-metadata-state="${esc(meta.metadataState || 'unknown')}" style="margin-top:10px">
    <h4>解析状态</h4>
    ${row('元数据', states[meta.metadataState || 'unknown'])}
    ${row('提示词', promptLabel)}
    ${row('生成配置', meta.generationStatus ? generationLabels[meta.generationStatus] : '可靠性未记录')}
    ${row('配置范围', scope)}
    ${meta.metadataFormat ? row('图片格式', meta.metadataFormat.toUpperCase()) : ''}
    ${warnings.length ? `<ul style="margin:8px 0 0;padding-left:18px;color:var(--text2);font-size:12px;overflow-wrap:anywhere">${warnings.map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : ''}
  </div>`
}

/** Detail-only markup. Raw values remain original strings, folded by default. */
export function renderGenerationDetails(meta: DetailMetadata, includeReliability = true): string {
  const models = meta.checkpoints?.length ? meta.checkpoints : meta.model ? [meta.model] : []
  const vaes = meta.vaes?.length ? meta.vaes : meta.vae ? [meta.vae] : []
  const stages = meta.generationStages || []
  const stageRows = stages.length ? stages.map(stage => `<details style="padding:8px 0;border-top:1px solid var(--border)">
    <summary style="cursor:pointer;font-size:12px;color:var(--text);overflow-wrap:anywhere">${esc(stage.label || `阶段 ${stage.nodeId}`)} <small style="color:var(--text3)">#${esc(stage.nodeId)} · ${esc(stage.sampler || '采样器未记录')}${stage.steps ? ` · ${esc(stage.steps)} 步` : ''}</small></summary>
    ${row('采样器', stage.sampler)}${row('调度器', stage.scheduler)}${row('记录步数', stage.steps)}
    ${stage.effectiveSteps != null ? row('有效步数', stage.effectiveSteps) : ''}
    ${row('CFG', stage.cfg)}${row('种子', stage.seed)}${stage.noiseSeed ? row('噪波种子', stage.noiseSeed) : ''}${row('去噪强度', stage.denoise)}
  </details>`).join('') : `${row('采样器', meta.sampler)}${row('调度器', meta.scheduler)}${row('记录步数', meta.steps)}${row('CFG', meta.cfg)}${row('种子', meta.seed)}${meta.noiseSeed ? row('噪波种子', meta.noiseSeed) : ''}${row('去噪强度', meta.denoise)}`
  const loras = (meta.loraDetails || []).map(item => `<details style="padding:8px 0;border-top:1px solid var(--border)">
    <summary style="cursor:pointer;font-size:12px;color:var(--text);overflow-wrap:anywhere">${esc(item.name)} <small style="color:var(--text3)">Model ${esc(String(item.strengthModel ?? '未知'))} · CLIP ${esc(String(item.strengthClip ?? '未知'))} · ${item.enabled ? '开启' : '关闭'}</small></summary>
    ${row('Model 权重', item.strengthModel ?? '未知')}${row('CLIP 权重', item.strengthClip ?? '未知')}
    ${row('开关', item.enabled ? '开启' : '关闭')}${row('输出关联', item.active === true ? '参与已知输出链' : item.active === false ? '未参与已知输出链' : '未知')}
  </details>`).join('')
  const raw = meta.rawMetadata || meta.raw || {}
  const rawEntries = Object.entries(raw)
  const hasConfig = models.length || vaes.length || meta.textEncoders?.length || stages.length || loras || meta.seed || meta.steps || meta.cfg || meta.sampler
  return `${includeReliability ? renderMetadataReliability(meta) : ''}
    ${hasConfig ? `<div class="outputs-meta-section"><h4>模型信息</h4>${row('底模', models.join(' / '))}${row('Text Encoder', (meta.textEncoders || []).join(' / '))}${row('VAE', vaes.join(' / '))}${meta.metadataSource ? row('保存格式', meta.metadataSource) : ''}</div>
    <div class="outputs-meta-section"><h4>生成阶段${stages.length ? ` (${stages.length})` : ''}</h4>${stageRows}</div>` : ''}
    ${loras ? `<div class="outputs-meta-section"><h4>LoRA 独立权重</h4><p style="font-size:11px;color:var(--text3)">输出关联表示保存图中的依赖关系，不证明模型文件已成功加载。</p>${loras}</div>` : ''}
    ${rawEntries.length ? `<details class="outputs-meta-section" data-raw-metadata style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--text2);padding:6px 0">原始保存字段 (${rawEntries.length})</summary>${rawEntries.map(([key, value]) => `<details data-raw-key="${esc(key)}" style="margin:4px 0"><summary style="cursor:pointer;font-size:11px;overflow-wrap:anywhere">${esc(key)} <small style="color:var(--text3)">${value.length.toLocaleString()} 字符</small></summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;margin:6px 0;padding:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:11px"></pre></details>`).join('')}</details>` : ''}`
}

const rawToggleHandlers = new WeakMap<HTMLDetailsElement, EventListener>()

/** Call after inserting detail markup. Large original fields enter the DOM
 * only while their field and outer raw section are open; textContent prevents
 * metadata from being interpreted as HTML. Rebinding uses the latest record.
 */
export function bindRawMetadataDetails(root: ParentNode, meta: DetailMetadata): void {
  const raw = meta.rawMetadata || meta.raw || {}
  const fields = Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-raw-key]'))
  const ancestors = new Set<HTMLDetailsElement>()
  const updates = fields.map(detail => {
    const parents: HTMLDetailsElement[] = []
    let parent = detail.parentElement?.closest<HTMLDetailsElement>('details')
    while (parent) {
      parents.push(parent)
      ancestors.add(parent)
      parent = parent.parentElement?.closest<HTMLDetailsElement>('details')
    }
    const update = () => {
      const pre = detail.querySelector('pre')
      if (!pre) return
      const key = detail.dataset.rawKey
      const value = detail.open && parents.every(owner => owner.open) && key != null && Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : ''
      if (pre.textContent !== value) pre.textContent = value
    }
    const previous = rawToggleHandlers.get(detail)
    if (previous) detail.removeEventListener('toggle', previous)
    detail.addEventListener('toggle', update)
    rawToggleHandlers.set(detail, update)
    update()
    return update
  })
  ancestors.forEach(detail => {
    const previous = rawToggleHandlers.get(detail)
    if (previous) detail.removeEventListener('toggle', previous)
    const update = () => updates.forEach(refresh => refresh())
    detail.addEventListener('toggle', update)
    rawToggleHandlers.set(detail, update)
  })
}
