import JSZip from 'jszip'

export interface OutputArchiveEntry { path: string; blob: Blob }

/** Bounded by the session before arrival. STORE avoids wasting CPU recompressing PNG/JPEG. */
export async function generateOutputArchive(
  entries: readonly OutputArchiveEntry[], signal: AbortSignal,
  progress: (percent: number) => void = () => {},
): Promise<Blob> {
  const abort = () => { if (signal.aborted) throw new DOMException('导出已取消', 'AbortError') }
  const zip = new JSZip()
  for (const entry of entries) {
    abort()
    const bytes = await entry.blob.arrayBuffer()
    abort()
    zip.file(entry.path, bytes)
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE', streamFiles: true }, update => {
    abort(); progress(update.percent)
  })
  abort()
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
}
