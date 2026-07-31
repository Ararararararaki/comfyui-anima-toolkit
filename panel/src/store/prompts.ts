import { db } from './db'
import type { PromptEntry, PromptCategory } from '../types'

// ── Prompt CRUD ──

export async function getAllPrompts(): Promise<PromptEntry[]> {
  return db.prompts.orderBy('createdAt').reverse().toArray()
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

export async function initPromptDB() {
  const count = await db.promptCategories.count()
  if (count > 0) return
  const defaults: PromptCategory[] = [
    { id: 'uncategorized', name: '未分类', icon: '📦', sortOrder: 0 },
    { id: 'cat_faces', name: '人物面部', icon: '😊', sortOrder: 1 },
    { id: 'cat_style', name: '画师风格', icon: '🎨', sortOrder: 2 },
    { id: 'cat_env', name: '背景环境', icon: '🌄', sortOrder: 3 },
    { id: 'cat_light', name: '光影氛围', icon: '💡', sortOrder: 4 },
    { id: 'cat_detail', name: '细节增强', icon: '✨', sortOrder: 5 },
    { id: 'cat_fav', name: '⭐ 常用', icon: '⭐', sortOrder: 6 },
  ]
  await db.promptCategories.bulkAdd(defaults)
}
