import type { OutputFile, OutputMetadata, OutputSummary, OutputEntity } from '../types/outputs'
import type { ImageSnapshot } from './outputIdentity'
import { makeOutputSummary, summaryMatches, canInferOutputTags } from './outputQuery'
import type { OutputFallbackResult } from './outputFallback'

export interface OutputClassification { id?: string; characters: OutputEntity[]; works: OutputEntity[]; tagKeys: string[]; searchAliases: string[]; status: string; version: string }
interface IndexOptions {
  files: () => OutputFile[]
  cached: (file: OutputFile) => OutputSummary | undefined
  metadata: (file: OutputFile) => OutputMetadata | null
  snapshot: (file: OutputFile) => ImageSnapshot
  current: (snapshot: ImageSnapshot) => boolean
  load: (ids: string[]) => Promise<(OutputSummary | undefined)[]>
  save: (rows: OutputSummary[]) => Promise<unknown>
  publish: (rows: OutputSummary[]) => void
  read: (snapshot: ImageSnapshot, signal: AbortSignal) => Promise<OutputMetadata | null>
  classify: (rows: OutputSummary[], signal: AbortSignal) => Promise<OutputClassification[]>
  canRead: () => boolean
  canReadMetadata?: (manual: boolean) => boolean
  deferReason?: () => string
  fallback?: (snapshot: ImageSnapshot, signal: AbortSignal) => Promise<OutputFallbackResult>
  fallbackEnabled?: () => boolean
  fallbackVersion?: () => string
  fallbackIncludeUnrecognized?: () => boolean
  classificationVersion?: () => string
  progress: (progress: { done: number; total: number; deferred: boolean; deferredReason?: string; error?: string; stage?: 'metadata' | 'wd14'; running?: boolean }) => void
}
const SUMMARY_BATCH_SIZE = 128
const SUMMARY_READ_BATCH_SIZE = 1024
function applyClassification(row: OutputSummary, classification: OutputClassification): void {
  Object.assign(row, { characters: classification.characters, works: classification.works, tagKeys: classification.tagKeys,
    searchAliases: classification.searchAliases, classificationVersion: classification.version,
    classificationAmbiguous: classification.status === 'ambiguous',
    classificationStatus: classification.status === 'unavailable' ? 'error' : classification.status === 'identified' ? 'identified' : 'unrecognized',
    error: classification.status === 'unavailable' ? '本地人物词库暂不可用' : undefined })
}

/** One cancellable historical-index job, shared by search and grouping. */
export function createOutputSummaryIndex(options: IndexOptions) {
  let controller: AbortController | undefined, scheduled: ReturnType<typeof setTimeout> | undefined, rerun = false
  const attempted = new Map<string, string>()
  const cachedReads = new Map<string, string>()
  const inferenceAttempts = new Map<string, string>()
  const retainedInference = new Map<string, { key: string; fields: Partial<OutputSummary> }>()
  type RunMode = { reclassify?: boolean; metadataOnly?: boolean; reinfer?: boolean }
  let nextMode: RunMode = {}, lastProgress: Parameters<IndexOptions['progress']>[0] | undefined
  let pendingInference: { snapshot: ImageSnapshot; previous: OutputSummary; pending: OutputSummary } | undefined
  const restorePending = () => {
    const pending = pendingInference; pendingInference = undefined
    if (pending && options.current(pending.snapshot) && options.cached(pending.snapshot.file) === pending.pending) options.publish([pending.previous])
  }
  const report: IndexOptions['progress'] = progress => { lastProgress = { ...progress, running: true }; options.progress(lastProgress) }
  const execute = async (signal: AbortSignal, mode: RunMode) => {
    const files = options.files(), snapshots = files.map(options.snapshot)
    const activeIds = new Set(files.map(file => file.id))
    for (const id of attempted.keys()) if (!activeIds.has(id)) attempted.delete(id)
    for (const id of cachedReads.keys()) if (!activeIds.has(id)) cachedReads.delete(id)
    for (const id of inferenceAttempts.keys()) if (!activeIds.has(id)) inferenceAttempts.delete(id)
    for (const id of retainedInference.keys()) if (!activeIds.has(id)) retainedInference.delete(id)
    let done = 0, deferred = false, lastError: string | undefined
    // Hydrate compact persisted summaries in larger batches. Reusing their
    // classification must not sort and redraw the entire library per few rows.
    for (let offset = 0; offset < snapshots.length && !signal.aborted; offset += SUMMARY_READ_BATCH_SIZE) {
      const missing = snapshots.slice(offset, offset + SUMMARY_READ_BATCH_SIZE).filter(snapshot => options.current(snapshot) &&
        cachedReads.get(snapshot.file.id) !== snapshot.key && options.cached(snapshot.file)?.indexStatus !== 'ready')
      if (!missing.length) continue
      const saved = await options.load(missing.map(snapshot => snapshot.file.id))
      if (signal.aborted) return
      for (let i = 0; i < saved.length; i++) {
        const row = saved[i], snapshot = missing[i]
        // Inference belongs to the unchanged file revision, independently of
        // parser/index versions. Never rebind it to a replaced file or root.
        if (row && Array.isArray(row.inferredTags) && row.sourceId === (snapshot.file.sourceId || 'output') &&
          row.path === snapshot.path && row.root === snapshot.root && row.mtime === snapshot.mtime && row.size === snapshot.size) {
          retainedInference.set(snapshot.file.id, { key: snapshot.key, fields: { inferredTags: row.inferredTags, inferenceStatus: row.inferenceStatus,
            inferenceVersion: row.inferenceVersion, inferenceModel: row.inferenceModel, inferenceError: row.inferenceError } })
        }
      }
      const valid = saved.filter((row, i): row is OutputSummary => summaryMatches(row, missing[i].file, missing[i].root, missing[i].parserVersion) && options.current(missing[i]))
      if (valid.length) options.publish(valid)
      for (const snapshot of missing) cachedReads.set(snapshot.file.id, snapshot.key)
      await new Promise(resolve => setTimeout(resolve, 12))
    }
    for (let offset = 0; offset < snapshots.length && !signal.aborted; offset += SUMMARY_BATCH_SIZE) {
      const batch = snapshots.slice(offset, offset + SUMMARY_BATCH_SIZE).filter(options.current)
      const changed: OutputSummary[] = []
      for (const snapshot of batch) {
        if (signal.aborted) return
        if (!options.current(snapshot)) continue
        const previous = options.cached(snapshot.file)
        const meta = options.metadata(snapshot.file)
        const sameTags = (previous?.manualTags || []).length === snapshot.file.tags.length && (previous?.manualTags || []).every((tag, index) => tag === snapshot.file.tags[index])
        // Explicit reparsing can recover a different saved prompt without a file,
        // parser or dictionary revision. Classifications belong to that prompt too.
        const samePrompt = !meta || meta.summaryStatus === 'pending' || previous?.prompt === meta.prompt && (previous?.identityPrompt || '') === (meta.identityPrompt || '')
        if (!mode.reclassify && previous?.indexStatus === 'ready' && ['identified', 'unrecognized'].includes(previous.classificationStatus) && sameTags && samePrompt && (!options.classificationVersion?.() || previous.classificationVersion === options.classificationVersion())) { done++; continue }
        const attemptKey = JSON.stringify([snapshot.key, meta?.summaryStatus || '', meta?.metadataState || '', meta?.prompt || '', meta?.identityPrompt || '', snapshot.file.tags, options.classificationVersion?.() || ''])
        if (attempted.get(snapshot.file.id) === attemptKey) { done++; continue }
        let row = previous || makeOutputSummary(snapshot.file, meta, snapshot.parserVersion, snapshot.root)
        try {
          if (meta && meta.summaryStatus !== 'pending') row = { ...makeOutputSummary(snapshot.file, meta, snapshot.parserVersion, snapshot.root), indexStatus: 'ready' }
          else if (row.indexStatus === 'ready') { row = { ...row, manualTags: snapshot.file.tags, notes: snapshot.file.notes } }
          else if (snapshot.source === 'directory' && (options.canReadMetadata?.(!!mode.metadataOnly) ?? options.canRead())) {
            const parsed = await options.read(snapshot, signal)
            if (!parsed || !options.current(snapshot)) { deferred = true; continue }
            row = { ...makeOutputSummary(snapshot.file, parsed, snapshot.parserVersion, snapshot.root), indexStatus: 'ready' }
          } else { deferred = true; continue }
          const retained = retainedInference.get(snapshot.file.id)
          const derived = previous?.inferredTags ? { inferredTags: previous.inferredTags, inferenceStatus: previous.inferenceStatus,
            inferenceVersion: previous.inferenceVersion, inferenceModel: previous.inferenceModel, inferenceError: previous.inferenceError }
            : retained?.key === snapshot.key ? retained.fields : undefined
          if (derived && !row.inferredTags) row = { ...row, ...derived, tagSource: row.prompt.trim() ? 'saved' : 'wd14' }
          attempted.set(snapshot.file.id, attemptKey)
          changed.push(row)
        } catch (error) {
          if (signal.aborted) return
          attempted.set(snapshot.file.id, attemptKey)
          changed.push({ ...row, indexStatus: 'error', classificationStatus: 'error', error: (error as Error).message })
        }
        done++
      }
      if (changed.length) {
        const ready = changed.filter(row => row.indexStatus === 'ready')
        try {
          const classifications = await options.classify(ready, signal)
          for (const row of ready) {
            const classification = classifications.find(result => result.id === row.imageId)
            if (!classification) throw new Error('本地分类返回缺少图片身份')
            applyClassification(row, classification)
          }
        } catch (error) {
          if (signal.aborted) return
          for (const row of ready) { row.classificationStatus = 'pending'; attempted.delete(row.imageId) }
          lastError = (error as Error).message
          report({ done, total: files.length, deferred: true, error: lastError })
        }
        const valid = changed.filter(row => { const snapshot = batch.find(candidate => candidate.file.id === row.imageId); return snapshot && options.current(snapshot) })
        if (!signal.aborted && valid.length) { await options.save(valid); if (!signal.aborted) options.publish(valid) }
      }
      report({ stage: 'metadata', done, total: files.length, deferred, deferredReason: deferred ? options.deferReason?.() : undefined, error: lastError })
      if (lastError) return
      if (changed.length) await new Promise(resolve => setTimeout(resolve, 12))
    }
    report({ stage: 'metadata', done, total: files.length, deferred, deferredReason: deferred ? options.deferReason?.() : undefined, error: lastError })
  }
  // Metadata is indexed first. A slow tagger never delays publication of other saved prompts.
  const inferMissing = async (signal: AbortSignal, mode: RunMode) => {
    if (!options.fallback || !options.fallbackEnabled?.()) return
    const eligible = (row: OutputSummary | undefined) => canInferOutputTags(row, options.fallbackIncludeUnrecognized?.())
    const candidates = options.files().filter(file => eligible(options.cached(file)))
    let done = 0, cacheDeferred = false
    for (const file of candidates) {
      if (signal.aborted) return
      const snapshot = options.snapshot(file), previous = options.cached(file), version = options.fallbackVersion?.() || ''
      if (!eligible(previous) || !previous || !options.current(snapshot)) continue
      if (!mode.reinfer && previous.inferenceStatus === 'ready' && previous.inferenceVersion === version) { done++; continue }
      const key = JSON.stringify([snapshot.key, version])
      if (inferenceAttempts.get(file.id) === key) { done++; continue }
      if (!options.canRead()) { nextMode = mode; report({ stage: 'wd14', done, total: candidates.length, deferred: true, deferredReason: options.deferReason?.() }); return }
      report({ stage: 'wd14', done, total: candidates.length, deferred: false })
      let row: OutputSummary = { ...previous, inferenceStatus: 'pending' }
      pendingInference = { snapshot, previous, pending: row }
      options.publish([row])
      try {
        const result = await options.fallback(snapshot, signal)
        if (signal.aborted || !options.current(snapshot)) return
        if (result.status === 'deferred') {
          nextMode = mode; restorePending()
          if (result.cacheMiss) { cacheDeferred = true; done++; continue }
          report({ stage: 'wd14', done, total: candidates.length, deferred: true, deferredReason: result.reason }); return
        }
        inferenceAttempts.set(file.id, key)
        // Published summaries are snapshots. The search worker detects replacement
        // by identity; mutating its pending row would leave its index stale.
        row = { ...row }
        if (result.status === 'complete') {
          row.inferredTags = result.tags || []; row.inferenceStatus = 'ready'; row.inferenceVersion = version
          row.inferenceModel = result.model; row.tagSource = 'wd14'; row.inferenceError = undefined
          const classification = (await options.classify([row], signal)).find(item => item.id === row.imageId)
          if (!classification) throw new Error('WD14 标签分类缺少图片身份')
          applyClassification(row, classification)
        } else {
          row.inferenceStatus = 'error'; row.inferenceError = result.error || '本地 WD14 模型不可用'
        }
      } catch (error) {
        if (signal.aborted) return
        inferenceAttempts.set(file.id, key)
        row = { ...row, inferenceStatus: 'error', inferenceError: (error as Error).message,
          classificationStatus: previous.classificationStatus }
      }
      if (signal.aborted || !options.current(snapshot)) return
      await options.save([row]); if (signal.aborted || !options.current(snapshot)) return
      options.publish([row]); done++
      pendingInference = undefined
      report({ stage: 'wd14', done, total: candidates.length, deferred: false, error: row.inferenceError })
      await new Promise(resolve => setTimeout(resolve, 12))
    }
    if (cacheDeferred) report({ stage: 'wd14', done, total: candidates.length, deferred: true, deferredReason: 'memory-pressure' })
  }
  const start = () => {
    scheduled = undefined
    if (controller) { rerun = true; return }
    const job = new AbortController(); controller = job
    const mode = nextMode; nextMode = {}
    report({ stage: 'metadata', done: 0, total: options.files().length, deferred: false })
    void execute(job.signal, mode).then(() => { if (!job.signal.aborted && !mode.metadataOnly) return inferMissing(job.signal, mode) }).catch(error => { if (!job.signal.aborted) report({ done: 0, total: options.files().length, deferred: false, error: (error as Error).message }) }).finally(() => {
      if (controller !== job) return
      restorePending(); controller = undefined
      if (lastProgress) options.progress({ ...lastProgress, running: false })
      if (rerun && !job.signal.aborted) { rerun = false; schedule() }
    })
  }
  const schedule = () => { if (scheduled) return; scheduled = setTimeout(start, 180) }
  return { schedule, retry(mode: RunMode = {}) { this.cancel(); nextMode = mode; attempted.clear(); cachedReads.clear(); inferenceAttempts.clear(); schedule() }, cancel() { if (scheduled) clearTimeout(scheduled); scheduled = undefined; rerun = false; nextMode = {}; controller?.abort(); controller = undefined; restorePending() }, dispose() { this.cancel(); attempted.clear(); cachedReads.clear(); inferenceAttempts.clear(); retainedInference.clear() } }
}
