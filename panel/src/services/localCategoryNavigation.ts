/** Shared counts and identities for the quick strip and the full category menu. */
export function localCategoryEntries(keys: readonly string[], categories: string[], assignments: Record<string, string[]>): Array<{ value: string; label: string; count: number; editable: boolean }> {
  const counts = new Map<string, number>(), all = keys.length
  let unclassified = 0
  for (const key of keys) {
    const assigned = assignments[key] || []
    if (!assigned.length) unclassified++
    for (const category of new Set(assigned)) counts.set(category, (counts.get(category) || 0) + 1)
  }
  return [{ value: '', label: '全部', count: all, editable: false },
    ...categories.map(value => ({ value, label: value, count: counts.get(value) || 0, editable: true })),
    { value: '__uncategorized__', label: '未分类', count: unclassified, editable: false }]
}
