import { PromptLibrary } from '@tk/shared/prompt_library.js'
import type { PromptLibrarySnapshot as SharedSnapshot } from '@tk/shared/prompt_library.js'
import { db } from '../store/db'
import type { PromptCategory, PromptEntry } from '../types'
import { showToast } from '../utils'

export type PromptLibrarySnapshot = SharedSnapshot<PromptEntry, PromptCategory>

const pendingStorage = (() => { try { return localStorage } catch { return null } })()
export const promptLibrary = new PromptLibrary<PromptEntry, PromptCategory>({
  pendingStorage,
  store: {
    async read() {
      const [categories, prompts] = await Promise.all([db.promptCategories.toArray(), db.prompts.toArray()])
      return { schemaVersion: 1, updatedAt: Date.now(), categories, prompts }
    },
    async write(changes) {
      if (!changes.categories?.length && !changes.prompts?.length) return
      await db.transaction('rw', db.promptCategories, db.prompts, async () => {
        if (changes.categories?.length) await db.promptCategories.bulkPut(changes.categories)
        if (changes.prompts?.length) await db.prompts.bulkPut(changes.prompts)
      })
    },
    async remove(ids) {
      if (!ids.length) return
      await db.transaction('rw', db.promptCategories, db.prompts, async () => {
        await db.promptCategories.bulkDelete(ids)
        await db.prompts.bulkDelete(ids)
      })
    },
  },
})

let lastError = ''
let lastErrorAt = 0
promptLibrary.subscribe(state => {
  if (!state.error) { lastError = ''; return }
  if (state.error !== lastError || Date.now() - lastErrorAt > 30000) {
    lastError = state.error
    lastErrorAt = Date.now()
    console.warn('[Prompt 库]', state.error)
    showToast(state.error)
  }
})

// Compatibility exports keep existing seeding/import callers on the shared policy.
export async function tombstonePrompts(ids: string[]): Promise<void> { await promptLibrary.remove(ids) }
export function pushPromptLibrary(): Promise<boolean> { return promptLibrary.upsert({}, { flush: true }) }
export function schedulePromptLibrarySync(): void { void promptLibrary.upsert() }

let lifecycleBound = false
export async function restorePromptLibrary(): Promise<void> {
  if (typeof window !== 'undefined' && !lifecycleBound) {
    lifecycleBound = true
    const flush = () => { void pushPromptLibrary() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
  }
  await promptLibrary.load()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('anima-prompt-library-restored'))
}
