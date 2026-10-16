import type { ImageSnapshot } from './outputIdentity'
import { bindMetadata } from './outputIdentity'
import { resolveOutputFileHandle } from './outputSources'
import { readImageMetadata } from './outputScanner'
import type { OutputMetadata } from '../types/outputs'

export function createOutputSummaryReader() {
  let worker: Worker | undefined
  try { worker = new Worker(new URL('../workers/outputMetadata.worker.ts', import.meta.url), { type: 'module' }) } catch { /* Same parser fallback for browsers without workers. */ }
  let serial = 0
  const pending = new Map<number, { resolve: (metadata: Partial<OutputMetadata>) => void; reject: (error: Error) => void }>()
  if (worker) {
    worker.onmessage = event => { const task = pending.get(event.data.id); pending.delete(event.data.id); if (event.data.error) task?.reject(new Error(event.data.error)); else task?.resolve(event.data.metadata) }
    worker.onerror = () => { worker?.terminate(); worker = undefined; for (const task of pending.values()) task.reject(new Error('元数据线程读取失败')); pending.clear() }
  }
  return {
    async read(snapshot: ImageSnapshot, handle: FileSystemDirectoryHandle, signal: AbortSignal): Promise<OutputMetadata | null> {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      if (!worker) return readImageMetadata(handle, snapshot, { strict: true, signal })
      const fileHandle = await resolveOutputFileHandle(snapshot.file)
      if (!fileHandle) throw new Error('目录未授权或图片不存在')
      const file = await fileHandle.getFile()
      if (file.lastModified !== snapshot.mtime || file.size !== snapshot.size) return null
      const metadata = await new Promise<Partial<OutputMetadata>>((resolve, reject) => {
        const id = ++serial
        const abort = () => { pending.delete(id); worker?.postMessage({ id, cancel: true }); reject(new DOMException('Cancelled', 'AbortError')) }
        signal.addEventListener('abort', abort, { once: true })
        pending.set(id, { resolve: value => { signal.removeEventListener('abort', abort); resolve(value) }, reject: error => { signal.removeEventListener('abort', abort); reject(error) } })
        worker!.postMessage({ id, file, extension: snapshot.file.extension, sourceFilename: snapshot.path })
      })
      const after = await fileHandle.getFile()
      if (signal.aborted || after.lastModified !== snapshot.mtime || after.size !== snapshot.size) return null
      return bindMetadata({ imageId: snapshot.file.id, seed: '', steps: '', cfg: '', sampler: '', vae: '', clipSkip: 0, negativePrompt: '', workflowJson: '', rawMetadata: {}, model: '', prompt: '', lorasExtracted: true, ...metadata }, snapshot)
    },
    dispose() { worker?.terminate(); for (const task of pending.values()) task.reject(new DOMException('Disposed', 'AbortError')); pending.clear() },
  }
}
