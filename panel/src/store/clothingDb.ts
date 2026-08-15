import Dexie, { type Table } from 'dexie'
import type { ClothingCard, ClothingCategory } from '../types'

// ── 服装卡片库：独立 Dexie 库（不碰 anima-lora / outputs-db 的 schema）──

export class ClothingDB extends Dexie {
  cards!: Table<ClothingCard, string>
  categories!: Table<ClothingCategory, string>

  constructor() {
    super('clothing-db')
    this.version(1).stores({
      cards: '&id, categoryId, favorite, source, createdAt',
      categories: '&id, name, sortOrder',
    })
  }
}

export const clothingDb = new ClothingDB()

// ── Card CRUD ──

export async function getAllCards(): Promise<ClothingCard[]> {
  return clothingDb.cards.orderBy('createdAt').reverse().toArray()
}

export async function getCardsByCategory(catId: string): Promise<ClothingCard[]> {
  return clothingDb.cards.where('categoryId').equals(catId).reverse().sortBy('createdAt')
}

export async function searchCards(keyword: string): Promise<ClothingCard[]> {
  if (!keyword.trim()) return getAllCards()
  const q = keyword.toLowerCase()
  return clothingDb.cards.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.prompt.toLowerCase().includes(q) ||
    c.tags.some(t => t.toLowerCase().includes(q))
  ).reverse().sortBy('createdAt')
}

export async function searchCardsByCategory(keyword: string, catId: string): Promise<ClothingCard[]> {
  if (!keyword.trim()) return getCardsByCategory(catId)
  const q = keyword.toLowerCase()
  return clothingDb.cards.where('categoryId').equals(catId).filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.prompt.toLowerCase().includes(q) ||
    c.tags.some(t => t.toLowerCase().includes(q))
  ).reverse().sortBy('createdAt')
}

export async function getCard(id: string): Promise<ClothingCard | undefined> {
  return clothingDb.cards.get(id)
}

export async function addCard(card: ClothingCard): Promise<string> {
  await clothingDb.cards.add(card)
  return card.id
}

export async function updateCard(id: string, data: Partial<ClothingCard>): Promise<void> {
  data.updatedAt = Date.now()
  await clothingDb.cards.update(id, data)
}

export async function deleteCard(id: string): Promise<void> {
  await clothingDb.cards.delete(id)
}

export async function bulkAddCards(cards: ClothingCard[]): Promise<void> {
  await clothingDb.cards.bulkAdd(cards)
}

export async function clearCards(): Promise<void> {
  await clothingDb.cards.clear()
}

export function generateCardId(): string {
  return 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

// ── Category CRUD（平铺分类：一个名字一组，无层级）──

export async function getAllCategories(): Promise<ClothingCategory[]> {
  return clothingDb.categories.orderBy('sortOrder').toArray()
}

export async function addCategory(cat: ClothingCategory): Promise<string> {
  await clothingDb.categories.add(cat)
  return cat.id
}

export async function updateCategory(id: string, data: Partial<ClothingCategory>): Promise<void> {
  await clothingDb.categories.update(id, data)
}

export async function deleteCategory(id: string): Promise<void> {
  await clothingDb.categories.delete(id)
  // 该分类下的卡片归入「未分类」
  const cards = await clothingDb.cards.where('categoryId').equals(id).toArray()
  for (const c of cards) {
    await clothingDb.cards.update(c.id, { categoryId: 'uncategorized' })
  }
}

export function generateCategoryId(): string {
  return 'ccat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
}

// ── 初始化：空库时建「未分类」兜底 ──

export async function initClothingDB() {
  const catCount = await clothingDb.categories.count()
  if (catCount === 0) {
    await clothingDb.categories.add({ id: 'uncategorized', name: '未分类', sortOrder: 0 })
  }
}

// ── 抽卡纯函数（Fisher-Yates 洗牌，照抄 Prompt-Manager 已验证实现）──

/** 从 cards 中公平随机抽取 count 张（不重复）；count 超上限时取全部 */
export function drawCards<T>(cards: T[], count: number): T[] {
  const arr = [...cards]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, Math.max(0, Math.min(count, arr.length)))
}

/** 把多张卡的 prompt 串按逗号连接成一段（去掉每串末尾多余逗号） */
export function joinCardPrompts(cards: ClothingCard[]): string {
  return cards.map(c => c.prompt.replace(/,\s*$/, '')).filter(Boolean).join(', ')
}
