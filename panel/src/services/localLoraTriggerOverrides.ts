export interface LocalLoraTriggerOverrideEntry {
  editable: boolean
  hasOverride: boolean
  words: string[] | null
  automaticWords: string[]
}

interface TriggerOverrideResponse {
  revision?: string
  loras?: Record<string, LocalLoraTriggerOverrideEntry>
  error?: string
}

type TriggerRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type TriggerListener = (names: string[]) => void

/** Match the exact identity normalization used by the TK node client. */
export function normalizeLocalLoraIdentity(name: string): string {
  return String(name).trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

function entriesEqual(a: LocalLoraTriggerOverrideEntry | undefined, b: LocalLoraTriggerOverrideEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Client for the TK node's shared manual trigger-word store. It deliberately has
 * no import-time browser listeners; initLocalManager starts synchronization once.
 */
export class LocalLoraTriggerOverrideClient {
  private readonly request: TriggerRequest
  private readonly entries = new Map<string, LocalLoraTriggerOverrideEntry>()
  private readonly names = new Map<string, string>()
  private readonly pendingReads = new Map<string, Promise<LocalLoraTriggerOverrideEntry>>()
  private readonly writeQueues = new Map<string, Promise<unknown>>()
  private readonly epochs = new Map<string, number>()
  private readonly listeners = new Set<TriggerListener>()
  private activeName: string | null = null
  private channel: BroadcastChannel | null = null
  private initialized = false

  constructor(request: TriggerRequest = (...args) => fetch(...args)) {
    this.request = request
  }

  entry(name: string): LocalLoraTriggerOverrideEntry | undefined {
    return this.entries.get(normalizeLocalLoraIdentity(name))
  }

  effectiveWords(name: string): string[] | null {
    const entry = this.entry(name)
    if (!entry) return null
    return entry.hasOverride ? (entry.words || []) : (entry.automaticWords || [])
  }

  subscribe(listener: TriggerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('tk-lora-trigger-overrides')
      this.channel.onmessage = () => this.refreshActive()
    }
    if (typeof window !== 'undefined') window.addEventListener('focus', this.refreshActive)
  }

  setActiveName(name: string | null): void {
    this.activeName = name ? name : null
  }

  async load(name: string, refresh = false): Promise<LocalLoraTriggerOverrideEntry> {
    const key = normalizeLocalLoraIdentity(name)
    if (!key) throw new Error('缺少 LoRA 相对路径')
    this.names.set(key, name)
    const cached = this.entries.get(key)
    if (!refresh && cached) return cached
    const pending = this.pendingReads.get(key)
    if (pending && !refresh) return pending

    const epoch = refresh ? (this.epochs.get(key) || 0) + 1 : (this.epochs.get(key) || 0)
    if (refresh) this.epochs.set(key, epoch)
    let promise!: Promise<LocalLoraTriggerOverrideEntry>
    promise = (async () => {
      const data = await this.requestJson(`/anima/lora_trigger_overrides?names=${encodeURIComponent(JSON.stringify([name]))}`)
      const entry = data.loras?.[name]
      if (!entry) throw new Error('自定义触发词响应不完整')
      if (epoch !== (this.epochs.get(key) || 0)) {
        const newerRead = this.pendingReads.get(key)
        if (newerRead && newerRead !== promise) return newerRead
        const confirmed = this.entries.get(key)
        if (confirmed) return confirmed
        if (newerRead === promise) this.pendingReads.delete(key)
        return this.load(name, true)
      }
      this.apply(name, entry)
      return this.entries.get(key) || entry
    })()
    this.pendingReads.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.pendingReads.get(key) === promise) this.pendingReads.delete(key)
    }
  }

  async save(name: string, words: string, reset = false): Promise<LocalLoraTriggerOverrideEntry> {
    const key = normalizeLocalLoraIdentity(name)
    if (!key) throw new Error('缺少 LoRA 相对路径')
    this.names.set(key, name)

    const epoch = (this.epochs.get(key) || 0) + 1
    this.epochs.set(key, epoch)
    const previous = this.writeQueues.get(key) || Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => this.requestJson('/anima/lora_trigger_overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, words, action: reset ? 'reset' : 'save' }),
    }))
    this.writeQueues.set(key, operation)
    let data: TriggerOverrideResponse
    try {
      data = await operation
    } finally {
      if (this.writeQueues.get(key) === operation) this.writeQueues.delete(key)
    }

    const entry = data.loras?.[name]
    if (!entry) throw new Error('自定义触发词保存响应不完整')
    this.epochs.set(key, (this.epochs.get(key) || 0) + 1)
    this.apply(name, entry)
    this.channel?.postMessage({ changed: true })
    return this.entries.get(key) || entry
  }

  private readonly refreshActive = (): void => {
    const name = this.activeName
    if (name) void this.load(name, true).catch(error => console.warn('[TK] 自定义触发词刷新失败', error))
  }

  private async requestJson(url: string, init?: RequestInit): Promise<TriggerOverrideResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时，请稍后重试')), 15000)
    try {
      const response = await this.request(url, { ...init, signal: controller.signal })
      const data = await response.json() as TriggerOverrideResponse
      if (!response.ok || data.error) throw new Error(data.error || `请求失败 (${response.status})`)
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  private apply(name: string, entry: LocalLoraTriggerOverrideEntry): void {
    const key = normalizeLocalLoraIdentity(name)
    const previous = this.entries.get(key)
    this.entries.set(key, entry)
    if (entriesEqual(previous, entry)) return
    for (const listener of this.listeners) listener([key])
  }
}

export const localLoraTriggerOverrides = new LocalLoraTriggerOverrideClient()
