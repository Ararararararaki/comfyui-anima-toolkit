export interface PromptPiece {
  text: string
  weight: string
  hidden: boolean
  separatorBefore: string
  trailingSeparator?: string
}
export interface PromptDocumentSnapshot {
  visibleText: string
  pieces: PromptPiece[]
  serializedState: string
  restored: boolean
  stateMismatch: boolean
}
export interface PromptCard { prompt?: string; en?: string; weight?: string | number }
export interface PromptFormatOptions { escapeBrackets?: boolean }
export type PromptDocumentChange =
  | { type: 'sync'; text: string }
  | { type: 'setText'; text: string; preserveHidden?: boolean }
  | { type: 'toggle' | 'remove'; index: number }
  | { type: 'weight'; index: number; weight: string | number }
  | { type: 'replace'; index: number; text: string }
  | { type: 'trailingSeparator'; separator?: string }
  | { type: 'append' | 'appendBlock'; text: string }
  | { type: 'appendCard'; card: PromptCard; separator?: string; options?: PromptFormatOptions }
  | { type: 'commit' }
export class PromptDocument {
  constructor(visibleText?: string)
  restore(raw: unknown, hostText?: string): PromptDocumentSnapshot
  apply(change: PromptDocumentChange): PromptDocumentSnapshot
  snapshot(): PromptDocumentSnapshot
}
export function splitPromptPieces(text: string): PromptPiece[]
export function splitTags(text: string): Array<Pick<PromptPiece, 'text' | 'weight'>>
export function serializePromptPieces(pieces: PromptPiece[]): string
export function formatWeightedPromptText(text: string, weight?: string | number): string
export function ensureTrailingSeparator(pieces: PromptPiece[], separator?: string): boolean
export function escapeAnimaBrackets(text: string): string
export function cardToText(card: PromptCard, options?: PromptFormatOptions): string
export function appendCardToPrompt(current: string, card: PromptCard, separator?: string, options?: PromptFormatOptions): string
export function appendPromptBlock(current: string, block: string): string
