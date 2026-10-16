import { OutputQueryIndex, type OutputQuery } from '../services/outputQuery'
import type { OutputSummary } from '../types/outputs'
const index = new OutputQueryIndex()
const host = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (data: unknown) => void }
host.onmessage = event => {
  const message = event.data as { id: number; upserts?: OutputSummary[]; removed?: string[]; reset?: boolean; query?: OutputQuery }
  if (message.reset) index.replace(message.upserts || [])
  else index.upsert(message.upserts || [])
  index.remove(message.removed || [])
  if (message.query) host.postMessage({ id: message.id, ids: index.query(message.query) })
}
