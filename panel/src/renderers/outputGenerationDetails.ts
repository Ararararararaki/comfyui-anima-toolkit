import { t as tr } from '../i18n'
import { esc } from '../utils'
import type { OutputMetadata, PromptStatus } from '../types/outputs'

type DetailMetadata = Partial<OutputMetadata> & { raw?: Record<string, string> }

const promptLabels: Record<PromptStatus, string> = {
  complete: tr("workspace.promptComplete"), partial: tr("workspace.promptPartiallyRecoverable"),
  ambiguous: tr("workspace.promptBranchIsUncertain"), missing: tr("workspace.noReliablePromptFound"),
}
const generationLabels: Record<PromptStatus, string> = {
  complete: tr("workspace.generationSettingsComplete"), partial: tr("workspace.generationSettingsPartiallyRecoverable"),
  ambiguous: tr("workspace.generationSettingsBranchIsUncertain"), missing: tr("workspace.noGenerationSettingsFound"),
}

function row(label: string, value: string | number | null | undefined): string {
  const text = value === '' || value == null ? tr("workspace.notRecorded") : String(value)
  return `<div class="outputs-meta-row" style="gap:12px;align-items:baseline"><span style="flex-shrink:0">${esc(label)}</span><span style="min-width:0;overflow-wrap:anywhere;text-align:right">${esc(text)}</span></div>`
}

/** Presence, prompt recovery and output association are separate facts. */
export function renderMetadataReliability(meta: DetailMetadata): string {
  const states = {
    present: tr("workspace.metadataSaved"), absent: tr("workspace.readingFinishedNoMetadataWasSaved"),
    error: tr("workspace.metadataReadFailedFieldsAlreadyReadAre"), unsupported: tr("workspace.thisImageFormatIsNotSupportedYet"),
    unknown: tr("workspace.metadataStateUnknownPleaseReparse"),
  }
  const warnings = [...new Set([...(meta.metadataWarnings || []), ...(meta.promptWarnings || []), ...(meta.generationWarnings || [])])]
  const promptLabel = meta.promptStatus === 'missing'
    ? meta.hasWorkflow ? tr("workspace.aWorkflowExistsButNoVerifiablePrompt") : tr("workspace.noRecoverableGenerationPromptWasSavedIn")
    : meta.promptStatus ? promptLabels[meta.promptStatus] : tr("workspace.reliabilityNotRecorded")
  const scope = meta.generationScope === 'output'
    ? tr("workspace.outputBranchSettings", { p0: meta.generationOutputNodeId ? tr("workspace.outputNode", { p0: meta.generationOutputNodeId }) : '' })
    : meta.generationScope === 'recorded' ? tr("workspace.recordedSettingsOutputBranchNotVerified") : tr("workspace.settingsScopeNotRecorded")
  return `<div class="outputs-meta-section" data-metadata-state="${esc(meta.metadataState || 'unknown')}" style="margin-top:10px">
    <h4>${tr("workspace.parseStatus")}</h4>
    ${row(tr("workspace.metadata"), states[meta.metadataState || 'unknown'])}
    ${row(tr("workspace.prompt"), promptLabel)}
    ${row(tr("workspace.generationSettings"), meta.generationStatus ? generationLabels[meta.generationStatus] : tr("workspace.reliabilityNotRecorded"))}
    ${row(tr("workspace.settingsScope"), scope)}
    ${meta.metadataFormat ? row(tr("workspace.imageFormat"), meta.metadataFormat.toUpperCase()) : ''}
    ${warnings.length ? `<ul style="margin:8px 0 0;padding-left:18px;color:var(--text2);font-size:12px;overflow-wrap:anywhere">${warnings.map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : ''}
  </div>`
}

/** Detail-only markup. Raw values remain original strings, folded by default. */
export function renderGenerationDetails(meta: DetailMetadata, includeReliability = true): string {
  const models = meta.checkpoints?.length ? meta.checkpoints : meta.model ? [meta.model] : []
  const vaes = meta.vaes?.length ? meta.vaes : meta.vae ? [meta.vae] : []
  const stages = meta.generationStages || []
  const stageRows = stages.length ? stages.map(stage => `<details style="padding:8px 0;border-top:1px solid var(--border)">
    <summary style="cursor:pointer;font-size:12px;color:var(--text);overflow-wrap:anywhere">${esc(stage.label || tr("workspace.stage", { p0: stage.nodeId }))} <small style="color:var(--text3)">#${esc(stage.nodeId)} · ${esc(stage.sampler || tr("workspace.samplerNotRecorded"))}${stage.steps ? tr("workspace.steps", { p0: esc(stage.steps) }) : ''}</small></summary>
    ${row(tr("workspace.sampler2"), stage.sampler)}${row(tr("workspace.scheduler"), stage.scheduler)}${row(tr("workspace.recordedSteps"), stage.steps)}
    ${stage.effectiveSteps != null ? row(tr("workspace.effectiveSteps"), stage.effectiveSteps) : ''}
    ${row('CFG', stage.cfg)}${row(tr("workspace.seed"), stage.seed)}${stage.noiseSeed ? row(tr("workspace.noiseSeed"), stage.noiseSeed) : ''}${row(tr("workspace.denoise"), stage.denoise)}
  </details>`).join('') : `${row(tr("workspace.sampler2"), meta.sampler)}${row(tr("workspace.scheduler"), meta.scheduler)}${row(tr("workspace.recordedSteps"), meta.steps)}${row('CFG', meta.cfg)}${row(tr("workspace.seed"), meta.seed)}${meta.noiseSeed ? row(tr("workspace.noiseSeed"), meta.noiseSeed) : ''}${row(tr("workspace.denoise"), meta.denoise)}`
  const loras = (meta.loraDetails || []).map(item => `<details style="padding:8px 0;border-top:1px solid var(--border)">
    <summary style="cursor:pointer;font-size:12px;color:var(--text);overflow-wrap:anywhere">${esc(item.name)} <small style="color:var(--text3)">Model ${esc(String(item.strengthModel ?? tr("workspace.unknown")))} · CLIP ${esc(String(item.strengthClip ?? tr("workspace.unknown")))} · ${item.enabled ? tr("workspace.on") : tr("workspace.close")}</small></summary>
    ${row(tr("workspace.modelWeight"), item.strengthModel ?? tr("workspace.unknown"))}${row(tr("workspace.clipWeight"), item.strengthClip ?? tr("workspace.unknown"))}
    ${row(tr("workspace.enabled"), item.enabled ? tr("workspace.on") : tr("workspace.close"))}${row(tr("workspace.outputAssociation"), item.active === true ? tr("workspace.inTheKnownOutputBranch") : item.active === false ? tr("workspace.outsideTheKnownOutputBranch") : tr("workspace.unknown"))}
  </details>`).join('')
  const raw = meta.rawMetadata || meta.raw || {}
  const rawEntries = Object.entries(raw)
  const hasConfig = models.length || vaes.length || meta.textEncoders?.length || stages.length || loras || meta.seed || meta.steps || meta.cfg || meta.sampler
  return `${includeReliability ? renderMetadataReliability(meta) : ''}
    ${hasConfig ? `<div class="outputs-meta-section"><h4>${tr("workspace.modelInfo")}</h4>${row(tr("workspace.baseModel"), models.join(' / '))}${row('Text Encoder', (meta.textEncoders || []).join(' / '))}${row('VAE', vaes.join(' / '))}${meta.metadataSource ? row(tr("workspace.savedFormat"), meta.metadataSource) : ''}</div>
    <div class="outputs-meta-section"><h4>${tr("workspace.generationStages", { p4: stages.length ? ` (${stages.length})` : '' })}</h4>${stageRows}</div>` : ''}
    ${loras ? `<div class="outputs-meta-section"><h4>${tr("workspace.loraWeights")}</h4><p style="font-size:11px;color:var(--text3)">${tr("workspace.outputAssociationDescribesDependenciesInTheSaved")}</p>${loras}</div>` : ''}
    ${rawEntries.length ? `<details class="outputs-meta-section" data-raw-metadata style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--text2);padding:6px 0">${tr("workspace.rawSavedFields", { p0: rawEntries.length })}</summary>${rawEntries.map(([key, value]) => `<details data-raw-key="${esc(key)}" style="margin:4px 0"><summary style="cursor:pointer;font-size:11px;overflow-wrap:anywhere">${esc(key)} <small style="color:var(--text3)">${tr("workspace.characters", { p2: value.length.toLocaleString() })}</small></summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;margin:6px 0;padding:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:11px"></pre></details>`).join('')}</details>` : ''}`
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
