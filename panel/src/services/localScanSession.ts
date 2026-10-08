import type { LocalLoraFile, LocalLoraMatch, LocalScanStatus } from '../types'
import { normalizeRelativeLoraPath } from './localLoraScanner'

export type ManifestEntry = { name: string; size: number; lastModified: number; sha256: string }
export type ScanSource = { size: number; lastModified: number }
export type ScanListing<Source extends ScanSource> = {
  entries: { name: string; file: Source }[]
  directory: string
}
export type LocalScanSnapshot = {
  files: LocalLoraFile[]
  manifest: Record<string, ManifestEntry>
  descriptions: Record<string, string>
}
type ScanUpdate = Partial<LocalScanSnapshot> & { scanPath?: string; newFileCount?: number }
export type LocalScanProgress = {
  status: LocalScanStatus
  done: number
  total: number
  label: string
  partial: number
  directory: string
  notice?: string
}
type Dependencies<Source extends ScanSource> = {
  read: () => LocalScanSnapshot
  commit: (update: ScanUpdate) => void
  hash: (file: Source, options: { signal: AbortSignal; onProgress: (p: { bytesRead: number; totalBytes: number }) => void }) => Promise<string>
  match: (hash: string, signal: AbortSignal) => Promise<LocalLoraMatch | null>
  persist: () => void
  removePreviews: (names: string[]) => void
}
export type LocalScanRequest<Source extends ScanSource> =
  | { kind: 'scan'; list: (signal: AbortSignal) => Promise<ScanListing<Source>> }
  | { kind: 'match'; names?: readonly string[]; resolve?: (file: LocalLoraFile, signal: AbortSignal) => Promise<LocalLoraMatch | null> }

type Run = { controller: AbortController; accepted: boolean }
const LARGE_HASH_DEFER_BYTES = 512 * 1024 * 1024

/** One scan and its matching phase own all commits until cancelled or replaced. */
export class LocalScanSession<Source extends ScanSource> {
  private current: Run | null = null
  private sources = new Map<string, Source>()
  private listeners = new Set<(progress: LocalScanProgress) => void>()
  private progress: LocalScanProgress = { status: 'idle', done: 0, total: 0, partial: 0, label: '', directory: '' }

  constructor(private readonly deps: Dependencies<Source>) {}

  subscribe(listener: (progress: LocalScanProgress) => void): () => void {
    this.listeners.add(listener)
    listener(this.progress)
    return () => { this.listeners.delete(listener) }
  }

  cancel(): void {
    const run = this.current
    if (!run) return
    this.current = null
    run.controller.abort()
    this.deps.commit({ files: this.deps.read().files.map(file => ({ ...file, scanning: false })) })
    if (run.accepted) this.deps.persist()
    this.publish({ status: 'idle', done: 0, total: 0, partial: 0, label: '', directory: this.progress.directory,
      notice: this.progress.status === 'matching' ? '匹配已取消' : '扫描已取消' })
  }

  async run(request: LocalScanRequest<Source>): Promise<void> {
    const previous = this.current
    const run: Run = { controller: new AbortController(), accepted: false }
    this.current = run
    previous?.controller.abort()
    this.deps.commit({ files: this.deps.read().files.map(file => file.scanning ? { ...file, scanning: false } : file) })
    // Save only accepted data, before the new run can commit. Retired completions never own a cache write.
    if (previous?.accepted) this.deps.persist()
    this.report(run, { status: request.kind === 'scan' ? 'scanning' : 'matching', done: 0, total: 0,
      partial: 0, label: request.kind === 'scan' ? '扫描' : '匹配', directory: this.progress.directory })
    try {
      if (request.kind === 'scan') {
        const listing = await request.list(run.controller.signal)
        this.check(run)
        const changed = await this.scan(run, listing)
        if (changed) await this.match(run)
      } else {
        await this.match(run, request.names, request.resolve)
      }
      this.check(run)
      this.report(run, { ...this.progress, status: 'done', partial: 0, notice: undefined })
    } catch (error) {
      if (this.current !== run) return
      if (run.controller.signal.aborted || (error as Error).name === 'AbortError') {
        this.cancel()
      } else {
        this.deps.commit({ files: this.deps.read().files.map(file => ({ ...file, scanning: false })) })
        this.report(run, { ...this.progress, status: 'error', partial: 0,
          notice: `扫描失败：${(error as Error).message || '未知错误'}` })
      }
    } finally {
      if (this.current === run) this.current = null
    }
  }

  private check(run: Run): void {
    if (this.current !== run || run.controller.signal.aborted) throw new DOMException('扫描已取消', 'AbortError')
  }

  private publish(progress: LocalScanProgress): void {
    this.progress = progress
    for (const listener of this.listeners) listener(progress)
  }

  private report(run: Run, progress: LocalScanProgress): void {
    if (this.current === run && !run.controller.signal.aborted) this.publish(progress)
  }

  private commit(run: Run, update: ScanUpdate, accepted = true): void {
    this.check(run)
    this.deps.commit(update)
    if (accepted) run.accepted = true
  }

  private fileProgress(run: Run, done: number, total: number, name: string, bytesRead: number, totalBytes: number): void {
    const partial = totalBytes > 0 ? Math.min(1, Math.max(0, bytesRead / totalBytes)) : 0
    const fileName = name.split('/').pop() || name
    const shortName = fileName.length > 42 ? `${fileName.slice(0, 18)}…${fileName.slice(-21)}` : fileName
    this.report(run, { ...this.progress, done, total, partial, notice: undefined,
      label: `扫描中 ${shortName} ${Math.round(partial * 100)}%` })
  }

  private async scan(run: Run, listing: ScanListing<Source>): Promise<boolean> {
    const entries = listing.entries.map(entry => ({ ...entry, name: normalizeRelativeLoraPath(entry.name) }))
    const old = this.deps.read()
    const oldFileMap = new Map(old.files.map(file => [file.name, file]))
    this.sources = new Map(entries.map(entry => [entry.name, entry.file]))
    const manifest: Record<string, ManifestEntry> = {}
    const results: LocalLoraFile[] = entries.map(({ name, file }) => {
      const cached = old.manifest[name]
      const previous = oldFileMap.get(name)
      const unchanged = !!cached && cached.size === file.size && cached.lastModified === file.lastModified
      return { name, path: name, size: file.size, lastModified: file.lastModified,
        sha256: unchanged ? cached.sha256 : '', matched: unchanged ? previous?.matched || false : false,
        matchData: unchanged ? previous?.matchData || null : null,
        matchError: unchanged ? previous?.matchError || '' : '', scanning: !unchanged }
    })
    let unchanged = 0, changed = 0, added = 0
    const total = entries.length
    this.commit(run, { files: [...results], scanPath: listing.directory })
    this.report(run, { status: 'scanning', done: 0, total, partial: 0, label: '扫描', directory: listing.directory })
    for (let i = 0; i < total; i++) {
      this.check(run)
      const { name, file } = entries[i]
      const cached = old.manifest[name]
      if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
        unchanged++
        manifest[name] = { ...cached, name }
      } else {
        let sha256 = ''
        if (file.size <= LARGE_HASH_DEFER_BYTES) {
          sha256 = await this.deps.hash(file, { signal: run.controller.signal,
            onProgress: p => this.fileProgress(run, i, total, name, p.bytesRead, p.totalBytes) })
          this.check(run)
        }
        results[i] = { ...results[i], sha256 }
        manifest[name] = { name, size: file.size, lastModified: file.lastModified, sha256 }
        if (cached) changed++; else added++
      }
      results[i] = { ...results[i], scanning: false }
      this.commit(run, { files: [...results], manifest: { ...this.deps.read().manifest, [name]: manifest[name] } })
      this.report(run, { ...this.progress, done: i + 1, partial: 0, label: `扫描 (新${added} 变${changed} 同${unchanged})` })
    }
    const names = new Set(entries.map(entry => entry.name))
    const removed = old.files.filter(file => !names.has(file.name)).map(file => file.name)
    const descriptions = { ...this.deps.read().descriptions }
    let removedDescriptions = 0
    for (const name of removed) {
      if (name in descriptions) { delete descriptions[name]; removedDescriptions++ }
    }
    this.commit(run, { files: results, manifest, descriptions, newFileCount: 0 })
    this.check(run)
    this.deps.removePreviews(removed)
    this.deps.persist()
    const changedFiles = added + changed + removed.length > 0
    this.report(run, { ...this.progress, status: 'done', notice: changedFiles
      ? `扫描完成: 新增 ${added} · 变更 ${changed} · 移除 ${removed.length} · 跳过 ${unchanged}${removedDescriptions ? `（含 ${removedDescriptions} 条描述清理）` : ''}`
      : `扫描完成: 无变化（${unchanged} 个未变）` })
    return changedFiles && results.some(file => !file.matched)
  }

  private async match(run: Run, names?: readonly string[], resolve?: (file: LocalLoraFile, signal: AbortSignal) => Promise<LocalLoraMatch | null>): Promise<void> {
    this.check(run)
    const selected = names && new Set(names)
    const files = this.deps.read().files.filter(file => selected ? selected.has(file.name) : !file.matched)
    let done = 0, next = 0, errors = 0
    this.report(run, { status: 'matching', done, total: files.length, partial: 0, label: '匹配', directory: this.progress.directory })
    await Promise.all(Array.from({ length: Math.min(3, files.length) }, async () => {
      while (next < files.length) {
        this.check(run)
        const file = files[next++]
        this.updateFile(run, file.name, { scanning: true })
        try {
          let data: LocalLoraMatch | null
          if (resolve) {
            data = await resolve(file, run.controller.signal)
          } else {
            let sha256 = file.sha256
            if (!sha256) {
              const source = this.sources.get(file.name)
              if (!source) throw new Error('请重新扫描此文件后再匹配')
              sha256 = await this.deps.hash(source, { signal: run.controller.signal,
                onProgress: p => this.fileProgress(run, done, files.length, file.name, p.bytesRead, p.totalBytes) })
              this.check(run)
              const manifest = { ...this.deps.read().manifest }
              if (manifest[file.name]) manifest[file.name] = { ...manifest[file.name], sha256 }
              this.commit(run, { manifest })
              this.updateFile(run, file.name, { sha256 })
            }
            data = await this.deps.match(sha256, run.controller.signal)
          }
          this.check(run)
          this.updateFile(run, file.name, data
            ? { matched: true, matchData: data, scanning: false, matchError: '' }
            : { matched: false, scanning: false, matchError: 'C站未匹配到此文件' })
        } catch (error) {
          this.check(run)
          if ((error as Error).name === 'AbortError') throw error
          this.updateFile(run, file.name, { scanning: false, matchError: (error as Error).message || '匹配异常' })
          errors++
        }
        this.check(run)
        done++
        this.report(run, { ...this.progress, done, partial: 0, label: `匹配 (${done}/${files.length})` })
      }
    }))
    this.check(run)
    this.deps.persist()
    this.report(run, { ...this.progress, status: 'done', notice: errors
      ? `${errors} 个匹配异常` : files.length ? `匹配完成 (${done} 个)` : '所有文件已匹配' })
  }

  private updateFile(run: Run, name: string, update: Partial<LocalLoraFile>): void {
    this.commit(run, { files: this.deps.read().files.map(file => file.name === name ? { ...file, ...update } : file) },
      Object.keys(update).some(key => key !== 'scanning'))
  }
}
