/** LoRA directory traversal shared by the LocalManager scan paths. */

export type LocalLoraScanEntry = {
  /** Path relative to the directory selected by the user. */
  name: string
  file: File
}

type DirectoryEntryHandle = {
  kind: 'file' | 'directory' | string
  getFile?: () => Promise<File>
  entries?: () => AsyncIterator<[string, DirectoryEntryHandle]>
}

type DirectoryHandleLike = DirectoryEntryHandle & {
  name?: string
  getDirectoryHandle?: (name: string) => Promise<DirectoryHandleLike>
  removeEntry?: (name: string) => Promise<void>
}

/** Keep scan keys portable and relative to the selected LoRA directory. */
export function normalizeRelativeLoraPath(value: string): string {
  const parts = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
  if (parts.includes('..')) return ''
  return parts.filter(part => part && part !== '.').join('/')
}

export function isLoraFileName(name: string): boolean {
  // Keep this in sync with the extensions accepted by TK Batch LoRA Loader.
  return /\.(safetensors|pt|ckpt|pth|bin)$/i.test(name)
}

/** Return the first directory below the selected root, or null for root files. */
export function getTopLevelLoraFolder(relativePath: string): string | null {
  const normalized = normalizeRelativeLoraPath(relativePath)
  const slash = normalized.indexOf('/')
  return slash > 0 ? normalized.slice(0, slash) : null
}

/** Group scanned relative paths by their first directory segment. */
export function groupLoraNamesByTopLevelFolder(names: readonly string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const name of names) {
    const folder = getTopLevelLoraFolder(name)
    if (!folder) continue
    const files = grouped.get(folder) || []
    files.push(normalizeRelativeLoraPath(name))
    grouped.set(folder, files)
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN', { numeric: true })))
}

/**
 * webkitdirectory includes the selected root folder in webkitRelativePath.
 * Remove that first segment so fallback scans produce the same keys as FSA.
 */
export function pickerRelativeLoraPath(file: File): string {
  const raw = String((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name || '')
  const normalized = normalizeRelativeLoraPath(raw)
  const parts = normalized.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(1).join('/') : normalized
}

function joinRelativePath(prefix: string, name: string): string {
  return normalizeRelativeLoraPath(prefix ? `${prefix}/${name}` : name)
}

/** Recursively enumerate model files below a File System Access API handle. */
export async function collectLoraFiles(root: FileSystemDirectoryHandle): Promise<LocalLoraScanEntry[]> {
  const result: LocalLoraScanEntry[] = []

  const visit = async (directory: DirectoryHandleLike, prefix: string): Promise<void> => {
    const iterator = directory.entries?.()
    if (!iterator) return
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      const [name, handle] = next.value
      const relativePath = joinRelativePath(prefix, name)
      if (!relativePath) continue
      if (handle.kind === 'file' && handle.getFile && isLoraFileName(name)) {
        result.push({ name: relativePath, file: await handle.getFile() })
      } else if (handle.kind === 'directory') {
        await visit(handle, relativePath)
      }
    }
  }

  await visit(root as unknown as DirectoryHandleLike, '')
  result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  return result
}

/** Delete a file addressed by its path relative to the selected root. */
export async function removeLoraFile(root: FileSystemDirectoryHandle, relativePath: string): Promise<void> {
  const parts = normalizeRelativeLoraPath(relativePath).split('/').filter(Boolean)
  const fileName = parts.pop()
  if (!fileName) throw new Error('LoRA 文件路径为空')

  let directory = root as unknown as DirectoryHandleLike
  for (const part of parts) {
    if (!directory.getDirectoryHandle) throw new Error('浏览器不支持子目录访问')
    directory = await directory.getDirectoryHandle(part)
  }
  if (!directory.removeEntry) throw new Error('浏览器不支持文件删除')
  await directory.removeEntry(fileName)
}
