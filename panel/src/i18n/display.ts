import { t, type MessageKey } from './index'
import type { OutputBrowseStep, OutputFolder } from '../services/outputBrowser'

const promptDefaults: Record<string, [string, MessageKey]> = {
  uncategorized: ['未分类', 'workspace.builtin.uncategorized'],
  cat_faces: ['人物', 'workspace.builtin.characters'],
  cat_style: ['画师风格', 'workspace.builtin.artistStyles'],
  cat_env: ['背景环境', 'workspace.builtin.backgrounds'],
  cat_light: ['光影氛围', 'workspace.builtin.lighting'],
  cat_detail: ['细节增强', 'workspace.builtin.details'],
  cat_fav: ['常用', 'workspace.builtin.frequent'],
  cat_emotion: ['情绪 / 表情', 'workspace.builtin.emotions'],
}

// A renamed default or a user-created category always keeps its saved name.
export function promptCategoryLabel(category: { id: string; name: string }): string {
  const entry = promptDefaults[category.id]
  return entry && entry[0] === category.name ? t(entry[1]) : category.name
}

export function clothingCategoryLabel(category: { id: string; name: string }): string {
  return category.id === 'uncategorized' && category.name === '未分类'
    ? t('workspace.builtin.uncategorized') : category.name
}

const artistCategories: Record<string, MessageKey> = {
  未分类: 'workspace.builtin.uncategorized', 二次元: 'workspace.builtin.anime',
  厚涂: 'workspace.builtin.painterly', 写实: 'workspace.builtin.realistic',
  水墨: 'workspace.builtin.ink', 黑白: 'workspace.builtin.monochrome',
}
export function artistCategoryLabel(name: string): string {
  return artistCategories[name] ? t(artistCategories[name]) : name
}

const outputFallbacks: Record<string, MessageKey> = {
  待整理: 'workspace.builtin.pending', 读取失败: 'workspace.builtin.readFailed',
  识别失败: 'workspace.builtin.recognitionFailed', 未识别: 'workspace.builtin.unrecognized',
}
export function outputBrowseLabel(step: OutputBrowseStep): string {
  if (step.kind === 'source') return step.id === '' ? t('workspace.builtin.allImages') : step.label
  if (step.kind === 'directory') return step.label
  // Only fallback keys identify UI states. Real character/work names are data.
  try {
    const parts = JSON.parse(step.key)
    if (Array.isArray(parts) && parts[parts.length - 1] === step.label && outputFallbacks[step.label]) {
      return t(outputFallbacks[step.label])
    }
  } catch { /* unknown navigation format: preserve its recorded label */ }
  return step.label
}

export function outputFolderSubtitle(folder: OutputFolder): string {
  if (folder.kind === 'directory') return t('workspace.builtin.subfolder')
  if (folder.kind !== 'source') return folder.subtitle
  if (!folder.source) return t('workspace.builtin.enabledFolders')
  if (!folder.source.enabled) return t('workspace.builtin.excludedFolder')
  return folder.source.kind === 'directory' && folder.source.permission !== 'granted'
    ? t('workspace.builtin.grantAccess') : t('workspace.builtin.imageFolder')
}
