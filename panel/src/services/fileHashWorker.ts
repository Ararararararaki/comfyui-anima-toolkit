import { IncrementalSha256 } from './sha256'

export const HASH_CHUNK_SIZE = 16 * 1024 * 1024
export const NATIVE_HASH_MAX_BYTES = 256 * 1024 * 1024

export type FileHashProgress = {
  bytesRead: number
  totalBytes: number
}

export type FileHashOptions = {
  signal?: AbortSignal
  onProgress?: (progress: FileHashProgress) => void
}

type WorkerResponse =
  | { type: 'progress'; id: number; bytesRead: number; totalBytes: number }
  | { type: 'done'; id: number; sha256: string }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string }

function digestToHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

type PendingJob = {
  resolve: (sha256: string) => void
  reject: (error: Error) => void
  onProgress?: (progress: FileHashProgress) => void
  signal?: AbortSignal
  onAbort: () => void
}

let hashWorker: Worker | null = null
let nextJobId = 1
const pendingJobs = new Map<number, PendingJob>()

function makeAbortError(): Error {
  return new DOMException('文件哈希已取消', 'AbortError')
}

function rejectWorkerJobs(error: Error): void {
  for (const [id, job] of pendingJobs) {
    job.signal?.removeEventListener('abort', job.onAbort)
    job.reject(error)
    pendingJobs.delete(id)
  }
}

function createHashWorker(): Worker {
  if (!hashWorker) {
    hashWorker = new Worker(new URL('./hashWorkerRuntime.ts', import.meta.url), { type: 'module' })
    hashWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      const job = pendingJobs.get(message.id)
      if (!job) return
      if (message.type === 'progress') {
        job.onProgress?.({ bytesRead: message.bytesRead, totalBytes: message.totalBytes })
        return
      }
      pendingJobs.delete(message.id)
      job.signal?.removeEventListener('abort', job.onAbort)
      if (message.type === 'done') job.resolve(message.sha256)
      else if (message.type === 'cancelled') job.reject(makeAbortError())
      else job.reject(new Error(message.message))
    }
    hashWorker.onerror = (event) => {
      hashWorker?.terminate()
      hashWorker = null
      rejectWorkerJobs(new Error(event.message || '后台哈希线程异常'))
    }
  }
  return hashWorker
}

async function hashInMainThread(file: File, options: FileHashOptions): Promise<string> {
  if (file.size <= NATIVE_HASH_MAX_BYTES && crypto.subtle) {
    const buffer = await file.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    options.onProgress?.({ bytesRead: file.size, totalBytes: file.size })
    return digestToHex(digest)
  }
  const hasher = new IncrementalSha256()
  let offset = 0
  while (offset < file.size) {
    if (options.signal?.aborted) throw makeAbortError()
    const end = Math.min(offset + HASH_CHUNK_SIZE, file.size)
    const buffer = await file.slice(offset, end).arrayBuffer()
    hasher.update(new Uint8Array(buffer))
    offset = end
    options.onProgress?.({ bytesRead: offset, totalBytes: file.size })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return hasher.digest()
}

/** Hash a file without ever materialising the complete file in the UI thread. */
export function hashFileSha256(file: File, options: FileHashOptions = {}): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(makeAbortError())
  if (typeof Worker === 'undefined') return hashInMainThread(file, options)

  const id = nextJobId++
  const worker = createHashWorker()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pendingJobs.delete(id)
      worker.postMessage({ type: 'cancel', id })
      reject(makeAbortError())
    }
    pendingJobs.set(id, { resolve, reject, onProgress: options.onProgress, signal: options.signal, onAbort })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.postMessage({ type: 'hash', id, file, chunkSize: HASH_CHUNK_SIZE })
  })
}
