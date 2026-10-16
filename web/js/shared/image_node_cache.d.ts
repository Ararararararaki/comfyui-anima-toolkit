export class ImageNodeCache {
  constructor(maxEntries?: number, maxBytes?: number);
  remember(img: HTMLImageElement): void;
  byteSize(): number;
  clear(): void;
  capture(inner: HTMLElement): void;
  restore(inner: HTMLElement, desiredSources?: ReadonlyMap<string, string>): void;
}
