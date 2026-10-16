// Local LoRA usage consumes the same saved search summaries as Outputs.
// A finite pass never retries an absent record forever and never clones workflows.
import { outputsDb } from '../db/outputsDb'
import { useOutputStore, outputSummaryForFile } from '../store/outputStore'
import { fileSourceIdentity } from './outputSources'
import { metadataForFile, createImageSnapshot, bindMetadata } from './outputIdentity'
import type { OutputMetadata, OutputSummary } from '../types/outputs'
import { summaryMatches } from './outputQuery'

let task: Promise<void> | undefined
export function countMetadataMissing(): number {
  const state = useOutputStore.getState()
  return state.files.filter(file => {
    const identity = fileSourceIdentity(file)
    return !metadataForFile(state.metadataCache, file, identity.root, identity.parserVersion)
      && outputSummaryForFile(file, state.summaryCache)?.indexStatus !== 'ready'
  }).length
}
export const isMetadataIndexComplete = (): boolean => countMetadataMissing() === 0
export function ensureAllMetadata(): Promise<void> {
  if (task) return task
  if (isMetadataIndexComplete()) return Promise.resolve()
  const run = async () => {
    const files = [...useOutputStore.getState().files]
    for (let offset = 0; offset < files.length; offset += 200) {
      const batch = files.slice(offset, offset + 200)
      const saved = await outputsDb.summaries.bulkGet(batch.map(file => file.id))
      const rows: OutputSummary[] = [], metadata: OutputMetadata[] = []
      for (let index = 0; index < batch.length; index++) {
        const row = saved[index], file = batch[index], identity = fileSourceIdentity(file)
        if (!summaryMatches(row, file, identity.root, identity.parserVersion) || row.indexStatus !== 'ready') continue
        rows.push(row)
        const meta = bindMetadata({ imageId: file.id, model: row.model, prompt: row.prompt, identityPrompt: row.identityPrompt, loras: row.loras, lorasExtracted: true, hasWorkflow: row.hasWorkflow, metadataState: row.metadataState, metadataWarnings: row.metadataWarnings, summaryStatus: 'ready', seed: '', steps: '', cfg: '', sampler: '', vae: '', clipSkip: 0, negativePrompt: '', workflowJson: '', rawMetadata: {} }, createImageSnapshot(file, identity.source, identity.root, identity.parserVersion))
        delete meta.metadataIdentity
        metadata.push(meta)
      }
      if (rows.length) { useOutputStore.getState().setSummaries(rows); useOutputStore.getState().putMetadataBatch(metadata) }
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  const running = run().finally(() => { if (task === running) task = undefined })
  task = running
  return running
}

