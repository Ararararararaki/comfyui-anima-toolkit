import { db } from './db'
import type { PromptEntry, PromptCategory } from '../types'

// ── Prompt CRUD ──

export async function getAllPrompts(): Promise<PromptEntry[]> {
  return db.prompts.orderBy('createdAt').reverse().toArray()
}

export async function countAllPrompts(): Promise<number> {
  return db.prompts.count()
}

export async function countPromptsByCategory(catId: string): Promise<number> {
  return db.prompts.where('categoryId').equals(catId).count()
}

export async function searchPrompts(keyword: string): Promise<PromptEntry[]> {
  if (!keyword.trim()) return getAllPrompts()
  const q = keyword.toLowerCase()
  return db.prompts.filter(p =>
    p.displayText.toLowerCase().includes(q) ||
    p.prompt.toLowerCase().includes(q) ||
    p.tags.some(t => t.toLowerCase().includes(q)) ||
    p.notes.toLowerCase().includes(q) ||
    (p.sourceModelName || '').toLowerCase().includes(q)
  ).reverse().sortBy('createdAt')
}

export async function getPromptsByCategory(catId: string): Promise<PromptEntry[]> {
  return db.prompts.where('categoryId').equals(catId).reverse().sortBy('createdAt')
}

export async function searchPromptsByCategory(keyword: string, catId: string): Promise<PromptEntry[]> {
  if (!keyword.trim()) return getPromptsByCategory(catId)
  const q = keyword.toLowerCase()
  return db.prompts.where('categoryId').equals(catId).filter(p =>
    p.displayText.toLowerCase().includes(q) ||
    p.prompt.toLowerCase().includes(q) ||
    p.tags.some(t => t.toLowerCase().includes(q)) ||
    p.notes.toLowerCase().includes(q)
  ).reverse().sortBy('createdAt')
}

export async function getPrompt(id: string): Promise<PromptEntry | undefined> {
  return db.prompts.get(id)
}

export async function addPrompt(entry: PromptEntry): Promise<string> {
  await db.prompts.add(entry)
  return entry.id
}

export async function updatePrompt(id: string, data: Partial<PromptEntry>): Promise<void> {
  data.updatedAt = Date.now()
  await db.prompts.update(id, data)
}

export async function deletePrompt(id: string): Promise<void> {
  await db.prompts.delete(id)
}

export async function getPromptsByModel(modelId: number): Promise<PromptEntry[]> {
  return db.prompts.where('sourceModelId').equals(modelId).toArray()
}

export async function getPromptCountByModel(modelId: number): Promise<number> {
  return db.prompts.where('sourceModelId').equals(modelId).count()
}

export function generatePromptId(): string {
  return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

// ── Category CRUD ──

export async function getAllCategories(): Promise<PromptCategory[]> {
  return db.promptCategories.orderBy('sortOrder').toArray()
}

export async function addCategory(cat: PromptCategory): Promise<string> {
  await db.promptCategories.add(cat)
  return cat.id
}

export async function updateCategory(id: string, data: Partial<PromptCategory>): Promise<void> {
  await db.promptCategories.update(id, data)
}

export async function deleteCategory(id: string): Promise<void> {
  await db.promptCategories.delete(id)
  const prompts = await db.prompts.where('categoryId').equals(id).toArray()
  for (const p of prompts) {
    await db.prompts.update(p.id, { categoryId: 'uncategorized' })
  }
}

export function generateCategoryId(): string {
  return 'cat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
}

// ── Init ──

const CAT_MIGRATION_KEY = 'anima_prompt_cat_migration_v1'

// 新默认分类（icon 清空；人物面部→人物；cat_fav 去掉 ⭐）
const DEFAULT_CATEGORIES: PromptCategory[] = [
  { id: 'uncategorized', name: '未分类', icon: '', sortOrder: 0 },
  { id: 'cat_faces', name: '人物', icon: '', sortOrder: 1 },
  { id: 'cat_style', name: '画师风格', icon: '', sortOrder: 2 },
  { id: 'cat_env', name: '背景环境', icon: '', sortOrder: 3 },
  { id: 'cat_light', name: '光影氛围', icon: '', sortOrder: 4 },
  { id: 'cat_detail', name: '细节增强', icon: '', sortOrder: 5 },
  { id: 'cat_fav', name: '常用', icon: '', sortOrder: 6 },
]

// 旧默认值，用于定向迁移判断（仅当仍是旧默认时才更新，避免覆盖用户改名）
const OLD_DEFAULT_CATEGORIES: Record<string, { name: string; icon: string }> = {
  uncategorized: { name: '未分类', icon: '📦' },
  cat_faces: { name: '人物面部', icon: '😊' },
  cat_style: { name: '画师风格', icon: '🎨' },
  cat_env: { name: '背景环境', icon: '🌄' },
  cat_light: { name: '光影氛围', icon: '💡' },
  cat_detail: { name: '细节增强', icon: '✨' },
  cat_fav: { name: '⭐ 常用', icon: '⭐' },
}

export async function initPromptDB() {
  const count = await db.promptCategories.count()
  if (count === 0) {
    await db.promptCategories.bulkAdd(DEFAULT_CATEGORIES)
  }
  await migrateDefaultCategories()
}

// 对已有用户一次性迁移默认分类（icon 清空、人物面部→人物、常用去 ⭐）
async function migrateDefaultCategories() {
  if (localStorage.getItem(CAT_MIGRATION_KEY)) return
  for (const id of Object.keys(OLD_DEFAULT_CATEGORIES)) {
    const existing = await db.promptCategories.get(id)
    if (!existing) continue
    const old = OLD_DEFAULT_CATEGORIES[id]
    if (existing.name === old.name && existing.icon === old.icon) {
      const def = DEFAULT_CATEGORIES.find(d => d.id === id)!
      await db.promptCategories.update(id, { name: def.name, icon: def.icon })
    }
  }
  localStorage.setItem(CAT_MIGRATION_KEY, '1')
}
