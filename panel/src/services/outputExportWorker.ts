import { applyExportMetadataResult } from '../utils/imageMetadata'
import { generateOutputArchive } from './outputExportArchive'

// A job owns this worker. Cancellation terminates it, so abandoned work cannot send results.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
}
scope.onmessage = async event => {
  const { id, type, blob, policy, items } = event.data
  try {
    const result = type === 'metadata'
      ? await applyExportMetadataResult(blob, policy)
      : await generateOutputArchive(items, new AbortController().signal,
        percent => scope.postMessage({ id, type: 'progress', percent }))
    scope.postMessage({ id, type: 'result', result })
  } catch (error) {
    scope.postMessage({ id, type: 'error', name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error) })
  }
}
