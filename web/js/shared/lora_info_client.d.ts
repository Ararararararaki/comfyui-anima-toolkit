export interface LoraInfo {
  name?: string; modelName: string; versionName?: string;
  modelId?: number | string; versionId?: number | string;
  trainedWords: string[]; tags: string[]; images: string[]; previewUrl: string | null;
  source?: string; creator?: string; baseModel?: string; description?: string;
  [key: string]: unknown;
}
export function normalizeLoraInfo(value: unknown): LoraInfo | null;
export class LoraInfoClient<Ref, Result = LoraInfo> {
  constructor(lookup: (ref: Ref, options: {signal: AbortSignal}) => Promise<Result | null>, options?: {
    key?: (ref: Ref) => string; ttl?: number; clock?: () => number;
  });
  get(ref: Ref, options?: {signal?: AbortSignal}): Promise<Result | null>;
  peek(ref: Ref): Result | null;
}
export function filenameLookup(fetchFn?: typeof fetch, timeout?: number): (ref: {name: string}, options: {signal: AbortSignal}) => Promise<unknown>;
export class LoraLookupSession<Ref, Result = LoraInfo> {
  constructor(client: LoraInfoClient<Ref, Result>, limit?: number);
  get(ref: Ref): Promise<Result | null>;
  dispose(): void;
}
