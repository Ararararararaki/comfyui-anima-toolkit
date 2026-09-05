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
  { id: 'cat_emotion', name: '情绪 / 表情', icon: '', sortOrder: 7 },
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

const EMOTION_CATEGORY_ID = 'cat_emotion'
const EMOTION_CATEGORY_NAME = '情绪 / 表情'
const EMOTION_SEED_KEY = 'anima_prompt_emotion_seed_v3'
const EMOTION_SEED_LEGACY_KEYS = ['anima_prompt_emotion_seed_v1', 'anima_prompt_emotion_seed_v2']
const EMOTION_PROMPT_SEEDS = [
  ['01_tsundere', '傲娇 / 嘴硬心软', 'crossed arms, looking away, pout, puffy cheeks, blush, furrowed brows', 'She crosses her arms and turns her eyes away, puffing her cheeks with a small pout while a faint blush gives away her embarrassment.'],
  ['02_confused_tilt', '疑惑 / 小脑袋问号', 'head tilt, raised eyebrow, parted lips, confused, finger to cheek', 'She tilts her head slightly, raises one eyebrow, and touches her cheek with a finger as she looks genuinely puzzled.'],
  ['03_thinking', '认真思考 / 灵机一动前', 'thinking, finger to mouth, looking up, closed mouth, furrowed brows', 'She brings a finger to her lips and raises her eyes thoughtfully, her brows slightly drawn together as she tries to figure something out.'],
  ['04_happy_fist_pump', '开心 / 活力满满', 'fist pump, clenched hand, grin, open mouth, happy, sparkling eyes', 'She pumps one fist excitedly, breaking into a bright open-mouthed grin as her eyes light up with happiness.'],
  ['05_gentle_care', '温柔关怀 / 担心你', 'hand on own chest, leaning forward, gentle smile, concerned, soft expression', 'She leans forward slightly with one hand resting against her chest, giving a gentle and caring smile as she watches with quiet concern.'],
  ['06_pleading', '渴望关照 / 撒娇请求', 'reaching out, outstretched hand, pleading, blush, parted lips, teary eyes', 'She reaches her hand out toward someone with a pleading look, her lips slightly parted and her eyes soft as if quietly asking for attention.'],
  ['07_playful_tease', '调皮捉弄 / 小恶魔感', 'tongue out, one eye closed, v, grin, playful', 'She sticks out her tongue, closes one eye, and flashes a playful V-sign with a mischievous grin.'],
  ['08_shy_approach', '害羞期待 / 偷偷靠近', 'hands behind back, leaning forward, blush, shy, smile, looking at viewer', 'She hides her hands behind her back and leans forward a little, smiling shyly with a warm blush as she waits for a response.'],
  ['09_innocent_shrug', '无辜困惑 / 我什么都不知道', 'shrugging, palms up, head tilt, confused, open mouth, raised eyebrows', 'She gives a small shrug with both palms turned upward, tilting her head with raised eyebrows as if she has absolutely no idea what happened.'],
  ['10_smug_idea', '得意 / 发现好主意', 'index finger raised, smug, smirk, closed mouth, raised eyebrow', 'She raises one index finger as if she has just thought of a clever idea, wearing a confident little smirk with one eyebrow slightly raised.'],
] as const

async function seedEmotionPrompts() {
  if (localStorage.getItem(EMOTION_SEED_KEY)) return

  const existingRecords = await Promise.all(
    EMOTION_PROMPT_SEEDS.map(([suffix]) => db.prompts.get(`prompt_emotion_${suffix}`)),
  )
  const isTagList = (value: unknown, tags: string[]) =>
    Array.isArray(value) && value.length === tags.length && value.every((tag, index) => tag === tags[index])
  const hasLegacySeedRecord = EMOTION_PROMPT_SEEDS.some(([,, tagsText, promptText], index) => {
    const existing = existingRecords[index]
    const tags = tagsText.split(',').map(tag => tag.trim()).filter(Boolean)
    return Boolean(existing && (
      (existing.prompt === tagsText && existing.notes === promptText) ||
      (existing.prompt === promptText && existing.notes === '' && isTagList(existing.tags, tags))
    ))
  })
  const repairLegacyRecords = EMOTION_SEED_LEGACY_KEYS.some(key => localStorage.getItem(key)) || hasLegacySeedRecord

  let category = await db.promptCategories.get(EMOTION_CATEGORY_ID)
  if (!category) {
    category = (await db.promptCategories.toArray()).find(c => c.name === EMOTION_CATEGORY_NAME)
  }
  if (!category) {
    category = { id: EMOTION_CATEGORY_ID, name: EMOTION_CATEGORY_NAME, icon: '', sortOrder: 7 }
    await db.promptCategories.add(category)
  }

  const createdAt = Date.now()
  for (const [index, [suffix, displayText, tagsText, promptText]] of EMOTION_PROMPT_SEEDS.entries()) {
    const id = `prompt_emotion_${suffix}`
    const existing = existingRecords[index]
    const tags = tagsText.split(',').map(tag => tag.trim()).filter(Boolean)
    const combinedPrompt = `${tagsText}\n\n${promptText}`
    if (existing) {
      // v1/v2 曾把两列内容拆到 prompt、tags、notes；仅对仍保持旧种子原值的记录合并修复，避免覆盖用户编辑。
      const isLegacyV1 = existing.prompt === tagsText && existing.notes === promptText
      const isLegacyV2 = existing.prompt === promptText && existing.notes === '' && isTagList(existing.tags, tags)
      if (repairLegacyRecords && (isLegacyV1 || isLegacyV2)) {
        await db.prompts.update(id, { prompt: combinedPrompt, tags: [], notes: '' })
      }
      continue
    }
    // v1 已初始化过的用户可能主动删除过某条种子，升级时不要把它重新塞回库。
    if (repairLegacyRecords) continue
    await db.prompts.add({
      id,
      prompt: combinedPrompt,
      displayText,
      images: [],
      primaryImage: '',
      tags: [],
      loras: [],
      categoryId: category.id,
      notes: '',
      isFavorite: false,
      createdAt: createdAt + Number(suffix.slice(0, 2)),
      updatedAt: createdAt + Number(suffix.slice(0, 2)),
    })
  }
  localStorage.setItem(EMOTION_SEED_KEY, '1')
}

export async function initPromptDB() {
  const count = await db.promptCategories.count()
  if (count === 0) {
    await db.promptCategories.bulkAdd(DEFAULT_CATEGORIES)
  }
  await migrateDefaultCategories()
  await seedEmotionPrompts()
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
