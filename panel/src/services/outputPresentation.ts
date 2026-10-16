import type { OutputFile } from '../types/outputs'
import type { ImageSnapshot } from './outputIdentity'

/** A backend image URL is meaningful only for the output providers. */
export function backendThumbnailSource(snapshot: ImageSnapshot, enabled: boolean, makeUrl: (path: string) => string, revision: string): string {
  return enabled && (snapshot.source === 'gallery' || snapshot.source === 'native') ? makeUrl(snapshot.path) + '&v=' + encodeURIComponent(revision) : ''
}

/** Refreshing content must preserve the annotations of this exact source/path. */
export function restoreOutputAnnotations(file: OutputFile, saved?: OutputFile): OutputFile {
  if (!saved || saved.path !== file.path || (saved.sourceId || 'output') !== (file.sourceId || 'output')) return file
  const { favorite, rating, notes, tags, category, status, pinned, createdAt } = saved
  return { ...file, favorite, rating, notes, tags, category, status, pinned, createdAt }
}

export function outputPreviewIndex(files: OutputFile[], snapshot: ImageSnapshot | null): number {
  return snapshot ? files.findIndex(file => file.id === snapshot.file.id && (file.sourceId || 'output') === (snapshot.file.sourceId || 'output')) : -1
}
