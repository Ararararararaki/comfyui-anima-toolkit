import { IncrementalSha256 } from './sha256'

const HASH_CHUNK_SIZE = 16 * 1024 * 1024
const NATIVE_HASH_MAX_BYTES = 256 * 1024 * 1024

type HashRequest = { type: 'hash'; id: number; file: File; chunkSize: number }
type CancelRequest = { type: 'cancel'; id: number }
type WorkerRequest = HashRequest | CancelRequest

type WorkerResponse =
  | { type: 'progress'; id: number; bytesRead: number; totalBytes: number }
  | { type: 'done'; id: number; sha256: string }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string }

type HashWorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse) => void
}

const workerScope = self as unknown as HashWorkerScope
const cancelled = new Set<number>()

function digestToHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

workerScope.onmessage = async (event) => {
  const request = event.data
  if (request.type === 'cancel') {
    cancelled.add(request.id)
    return
  }

  const { id, file } = request
  try {
    if (file.size <= NATIVE_HASH_MAX_BYTES && crypto.subtle) {
      const buffer = await file.arrayBuffer()
      if (cancelled.has(id)) {
        cancelled.delete(id)
        workerScope.postMessage({ type: 'cancelled', id })
        return
      }
      workerScope.postMessage({ type: 'progress', id, bytesRead: file.size, totalBytes: file.size })
      const digest = await crypto.subtle.digest('SHA-256', buffer)
      workerScope.postMessage({ type: 'done', id, sha256: digestToHex(digest) })
      return
    }

    const chunkSize = Math.max(1024 * 1024, request.chunkSize || HASH_CHUNK_SIZE)
    const hasher = new IncrementalSha256()
    let offset = 0
    while (offset < file.size) {
      if (cancelled.has(id)) {
        cancelled.delete(id)
        workerScope.postMessage({ type: 'cancelled', id })
        return
      }
      const end = Math.min(offset + chunkSize, file.size)
      const buffer = await file.slice(offset, end).arrayBuffer()
      hasher.update(new Uint8Array(buffer))
      offset = end
      workerScope.postMessage({ type: 'progress', id, bytesRead: offset, totalBytes: file.size })
    }
    if (cancelled.has(id)) {
      cancelled.delete(id)
      workerScope.postMessage({ type: 'cancelled', id })
      return
    }
    workerScope.postMessage({ type: 'done', id, sha256: hasher.digest() })
  } catch (error) {
    cancelled.delete(id)
    workerScope.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
