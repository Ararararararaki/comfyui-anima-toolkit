import { parseOutputMetadataBlob, outputLoraNames } from '../services/outputMetadata'
const host = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (data: unknown) => void }
const jobs = new Map<number, AbortController>()
host.onmessage = async event => {
  const { id, file, extension, sourceFilename, cancel } = event.data as { id: number; file: File; extension: string; sourceFilename?: string; cancel?: boolean }
  if (cancel) { jobs.get(id)?.abort(); return }
  const job = new AbortController()
  jobs.set(id, job)
  try {
    const meta = await parseOutputMetadataBlob(file, extension, job.signal, sourceFilename)
    if (job.signal.aborted) return
    host.postMessage({ id, metadata: { model: meta.model, prompt: meta.prompt, identityPrompt: meta.identityPrompt,
      loras: outputLoraNames(meta),
      hasWorkflow: !!meta.hasWorkflow, metadataState: meta.metadataState,
      metadataFormat: meta.metadataFormat, metadataWarnings: meta.metadataWarnings,
      promptStatus: meta.promptStatus, summaryStatus: 'ready' } })
  } catch (error) {
    if ((error as Error).name !== 'AbortError') host.postMessage({ id, error: '元数据线程读取失败' })
  } finally { if (jobs.get(id) === job) jobs.delete(id) }
}
