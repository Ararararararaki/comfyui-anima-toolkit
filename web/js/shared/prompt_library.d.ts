export interface PromptRecord { id: string; updatedAt?: number; createdAt?: number; categoryId?: string }
export interface CategoryRecord { id: string }
export interface PromptLibrarySnapshot<P extends PromptRecord = PromptRecord, C extends CategoryRecord = CategoryRecord> {
  schemaVersion: 1
  updatedAt: number
  categories: C[]
  prompts: P[]
  deletedIds?: string[]
}
export interface PromptLibraryState<P extends PromptRecord = PromptRecord, C extends CategoryRecord = CategoryRecord> {
  status: 'idle' | 'loading' | 'syncing' | 'synced' | 'offline'
  dirty: boolean
  error: string | null
  pendingDeletes: string[]
  snapshot: PromptLibrarySnapshot<P, C> | null
}
export interface PromptLibraryStore<P extends PromptRecord, C extends CategoryRecord> {
  read(): Promise<PromptLibrarySnapshot<P, C>>
  write(changes: Partial<PromptLibrarySnapshot<P, C>>): Promise<void>
  remove(ids: string[]): Promise<void>
}
export class PromptLibrary<P extends PromptRecord = PromptRecord, C extends CategoryRecord = CategoryRecord> {
  constructor(options: {
    store: PromptLibraryStore<P, C>
    request?: (input: RequestInfo | URL, options?: RequestInit) => Promise<Response>
    pendingStorage?: Pick<Storage, 'getItem' | 'setItem'> | null
    now?: () => number
    maxSnapshotBytes?: number
    timers?: { setTimeout(callback: () => void, delay: number): unknown; clearTimeout(id: unknown): void }
  })
  readonly state: PromptLibraryState<P, C>
  load(options?: { refresh?: boolean }): Promise<PromptLibrarySnapshot<P, C>>
  upsert(changes?: Partial<PromptLibrarySnapshot<P, C>>, options?: { flush?: boolean }): Promise<boolean>
  remove(selection: string[] | { prompts?: string[]; categories?: string[] }): Promise<boolean>
  subscribe(listener: (state: PromptLibraryState<P, C>) => void): () => void
}
