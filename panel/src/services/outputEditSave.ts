import type { ImageSnapshot } from './outputIdentity'

export interface SavedOutputEdit { path: string; filename: string; mtime: number; size: number; width: number; height: number; backup?: string | null }
/** No writes until the caller has explicitly chosen save/overwrite. */
export async function saveOutputEdit(options: {
  target: ImageSnapshot; blob: Blob; width: number; height: number; overwrite: boolean
  handle?: FileSystemDirectoryHandle; current: () => boolean
}): Promise<SavedOutputEdit> {
  const { target, blob, overwrite, handle } = options
  if (!options.current()) throw Error('图片来源已变化，请重新打开')
  if (target.source === 'gallery') {
    const body = new FormData()
    body.append('image', blob, target.file.filename)
    for (const [key, value] of Object.entries({ path: target.path, root: target.root, mtime: target.mtime, size: target.size, overwrite })) body.append(key, String(value))
    const response = await fetch('/anima/gallery/edit', { method: 'POST', body })
    const result = await response.json()
    if (!response.ok) throw Error(result.error || `保存失败 HTTP ${response.status}`)
    return result
  }
  if (!handle) throw Error('请先授权图片所在目录，再保存')
  const parts = target.path.split('/'), filename = parts.pop()!
  let directory = handle
  for (const part of parts) directory = await directory.getDirectoryHandle(part)
  const original = await directory.getFileHandle(filename)
  const check = async () => {
    const file = await original.getFile()
    if (!options.current() || file.lastModified !== target.mtime || file.size !== target.size) throw Error('原图已变化，未覆盖；请重新打开后编辑')
    return file
  }
  const source = await check()
  const unique = crypto.randomUUID()
  let backup: string | null = null
  const write = async (file: FileSystemFileHandle, data: Blob) => {
    const stream = await file.createWritable()
    try { await stream.write(data); await stream.close() }
    catch (error) { await stream.abort().catch(() => {}); throw error }
  }
  const unused = async (directory: FileSystemDirectoryHandle, name: string) => {
    try { await directory.getFileHandle(name) }
    catch (error) { if ((error as Error).name === 'NotFoundError') return; throw error }
    throw Error('目标文件已存在，未写入，请重试')
  }
  if (overwrite) {
    const backups = await directory.getDirectoryHandle('.tk-edit-backups', { create: true })
    backup = `${unique}-${filename}`
    await unused(backups, backup)
    const entry = await backups.getFileHandle(backup, { create: true })
    await write(entry, source)
    const sha = async (b: Blob) => new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer())).join(',')
    if (await sha(await entry.getFile()) !== await sha(source)) throw Error('原图备份核验失败，未覆盖')
    await check()
  }
  const name = overwrite ? filename : filename.replace(/(\.[^.]+)$/, `_edited_${unique.slice(0, 10)}$1`)
  if (!overwrite) await unused(directory, name)
  const destination = overwrite ? original : await directory.getFileHandle(name, { create: true })
  await check()
  await write(destination, blob)
  const written = await destination.getFile()
  return { path: [...parts, name].join('/'), filename: name, size: written.size, mtime: written.lastModified, width: options.width, height: options.height, backup: backup ? [...parts, '.tk-edit-backups', backup].join('/') : null }
}
