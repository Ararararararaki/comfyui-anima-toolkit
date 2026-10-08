export interface LoraSyntaxEntry { name: string; weight: number; clipWeight?: number; disabled?: boolean }
export interface ParsedLoraSyntaxEntry extends LoraSyntaxEntry { clipWeight: number; disabled: boolean }
export type LoraDisabledMap = Record<string, number | { weight: number; clipWeight: number }>
export interface LoraSyntaxOptions { disabledMap?: LoraDisabledMap; disabledNames?: Iterable<string> }
export interface LoraSyntaxSnapshot { text: string; disabledMap: LoraDisabledMap }
export function normalizeLoraName(value: unknown): string
export function parseLoraSyntax(text: string, options?: LoraSyntaxOptions): ParsedLoraSyntaxEntry[]
export function serializeLoraSyntax(items: LoraSyntaxEntry[]): string
export function loraDisabledMap(items: LoraSyntaxEntry[]): LoraDisabledMap
export const LoRASyntax: {
  parse: typeof parseLoraSyntax
  serialize: typeof serializeLoraSyntax
  disabledMap: typeof loraDisabledMap
  snapshot(items: LoraSyntaxEntry[]): LoraSyntaxSnapshot
}
