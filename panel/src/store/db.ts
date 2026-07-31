import Dexie, { type Table } from 'dexie'
import type { PromptEntry, PromptCategory, ArtistData } from '../types'

export class AnimaDB extends Dexie {
  prompts!: Table<PromptEntry, string>
  promptCategories!: Table<PromptCategory, string>
  artists!: Table<ArtistData, string>

  constructor() {
    super('anima-lora')
    this.version(1).stores({
      prompts: '&id, sourceModelId, *tags, categoryId, isFavorite, displayText, createdAt',
      promptCategories: '&id, name, parentId, sortOrder',
      artists: '&tag',
    })
  }
}

export const db = new AnimaDB()
