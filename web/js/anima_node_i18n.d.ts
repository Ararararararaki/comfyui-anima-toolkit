export function getNodeLocale(): 'en' | 'zh-CN';
export function builtinCategoryLabel(category: { id?: string; name?: string } | null | undefined): string;
export function uiText(chinese: string, english: string, params?: Record<string, string | number | null | undefined>): string;
export function onNodeLocaleChange(callback: (locale: 'en' | 'zh-CN') => void): () => void;
