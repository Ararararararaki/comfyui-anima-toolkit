// The package's single canonical record guard for untrusted JSON values.
// Narrows to Record<string, unknown>; validate used fields with typeof / Array.isArray.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
