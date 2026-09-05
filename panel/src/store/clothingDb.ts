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
    // v2：加 *tags 多值索引（Dexie 自动重建，旧数据无需迁移动作）
    this.version(2).stores({
      cards: '&id, categoryId, favorite, source, createdAt, *tags',
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

// ── 分页查询（Perf-2：DB 端 offset/limit，只取一页，不再全量 toArray 后切片）──

export interface CardPageQuery {
  /** 分类过滤（未定义 = 全部；fav 用 fav 字段） */
  categoryId?: string
  /** 只看收藏 */
  fav?: boolean
  /** 名称/提示词/tags 子串搜索（与旧 searchCards 语义一致） */
  keyword?: string
  offset: number
  limit: number
}

export interface CardPage {
  cards: ClothingCard[]
  total: number
}

/**
 * 按 createdAt 倒序分页查询。
 * 有过滤条件时走有序 cursor + filter（行为与旧 searchCards 完全一致），
 * 但 offset/limit 在 DB 端生效——只物化一页数据，不把全部卡片（含 imageBlob）拉进内存。
 * ⚠️ Dexie 的 offset/limit/filter 会原地修改 collection，必须先 count() 再取页。
 */
export async function queryCardsPage(q: CardPageQuery): Promise<CardPage> {
  const kw = (q.keyword || '').trim().toLowerCase()
  const needFilter = !!q.fav || !!q.categoryId || !!kw
  let col = clothingDb.cards.orderBy('createdAt').reverse()
  if (needFilter) {
    col = col.filter(c => {
      if (q.fav && !c.favorite) return false
      if (q.categoryId && c.categoryId !== q.categoryId) return false
      if (kw) {
        return c.name.toLowerCase().includes(kw) ||
          c.prompt.toLowerCase().includes(kw) ||
          (c.tags || []).some(t => t.toLowerCase().includes(kw))
      }
      return true
    })
  }
  const total = await col.count()
  const cards = await col.offset(q.offset).limit(q.limit).toArray()
  return { cards, total }
}

// ── 计数（渲染分类标签用；走索引/扫描 count，不物化数组）──

export async function countCards(): Promise<number> {
  return clothingDb.cards.count()
}

export async function countCardsByCategory(catId: string): Promise<number> {
  return clothingDb.cards.where('categoryId').equals(catId).count()
}

export async function countFavCards(): Promise<number> {
  return clothingDb.cards.filter(c => c.favorite).count()
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

// ── 批量写（Perf-5：bulkUpdate/bulkDelete 替换逐条 for 循环）──

/**
 * 批量更新多张卡。changes 为单对象时对所有卡应用相同字段；
 * 传数组时按位对应每张卡（如抽卡 useCount 各自 +1）。
 * 自动补 updatedAt；undefined 字段被 Dexie 忽略（与 update() 语义一致）。
 */
export async function bulkUpdateCards(keys: string[], changes: Partial<ClothingCard> | Partial<ClothingCard>[]): Promise<void> {
  if (!keys.length) return
  const now = Date.now()
  const specs = Array.isArray(changes)
    ? changes.map(ch => ({ ...ch, updatedAt: now }))
    : keys.map(() => ({ ...changes, updatedAt: now }))
  await clothingDb.cards.bulkUpdate(keys.map((key, i) => ({ key, changes: specs[i] })))
}

export async function bulkDeleteCards(ids: string[]): Promise<void> {
  if (!ids.length) return
  await clothingDb.cards.bulkDelete(ids)
}

export async function clearCards(): Promise<number> {
  return clothingDb.transaction('rw', clothingDb.cards, async () => {
    const count = await clothingDb.cards.count()
    await clothingDb.cards.clear()
    return count
  })
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
  // 该分类下的卡片归入「未分类」（批量写，只取主键不载入整卡）
  const keys = await clothingDb.cards.where('categoryId').equals(id).primaryKeys()
  await bulkUpdateCards(keys, { categoryId: 'uncategorized' })
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
