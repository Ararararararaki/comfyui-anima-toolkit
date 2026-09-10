/**
 * 已废弃（2026-09-10）：模型备注/评分功能按需求整体移除。
 * 此文件保留空壳以维持模块路径稳定（避免删除式变更），不再有任何引用方；
 * 历史数据仍留在浏览器 localStorage（key: model_notes_v1），如需清理可手动删除该 key。
 */
export type ModelNote = { id: number; notes: string; rating: number; status: 'untried' | 'trying' | 'success' | 'abandoned'; lastUsed: number; updatedAt: number }
export const getNote = (_id: number): ModelNote | null => null
export const saveNote = (_id: number, _data: Partial<ModelNote>): ModelNote => { throw new Error('模型备注功能已移除') }
