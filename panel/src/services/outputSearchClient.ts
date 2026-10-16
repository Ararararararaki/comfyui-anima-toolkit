import { OutputQueryIndex, type OutputQuery } from './outputQuery'
import type { OutputSummary } from '../types/outputs'

/** One worker owns normalized search text. Pending requests retire on dispose. */
export function createOutputSearchClient() {
  let worker: Worker | undefined
  try { worker = new Worker(new URL('../workers/outputQuery.worker.ts', import.meta.url), { type: 'module' }) } catch { /* Embedded browser without Worker uses the same index. */ }
  const fallback = new OutputQueryIndex()
  const documents = new Map<string, OutputSummary>()
  const requests = new Map<number, { resolve: (ids: string[]) => void; reject: (error: Error) => void }>()
  let serial = 0, disposed = false
  const failWorker = () => { worker?.terminate(); worker = undefined; fallback.replace([...documents.values()]); for (const request of requests.values()) request.reject(new Error('检索线程已重建，请重试')); requests.clear() }
  if (worker) {
    worker.onmessage = event => { const request = requests.get(event.data.id); requests.delete(event.data.id); request?.resolve(event.data.ids) }
    worker.onerror = failWorker
  }
  return {
    query(rows: OutputSummary[], query: OutputQuery): Promise<string[]> {
      if (disposed) return Promise.reject(new DOMException('Search disposed', 'AbortError'))
      const present = new Set(rows.map(row => row.imageId)), removed = [...documents.keys()].filter(id => !present.has(id))
      const upserts = rows.filter(row => documents.get(row.imageId) !== row)
      for (const id of removed) documents.delete(id)
      for (const row of upserts) documents.set(row.imageId, row)
      if (!worker) { fallback.remove(removed); fallback.upsert(upserts); return Promise.resolve(fallback.query(query)) }
      const id = ++serial
      return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); worker!.postMessage({ id, upserts, removed, query }) })
    },
    dispose() { disposed = true; worker?.terminate(); for (const request of requests.values()) request.reject(new DOMException('Search disposed', 'AbortError')); requests.clear(); documents.clear() },
  }
}
