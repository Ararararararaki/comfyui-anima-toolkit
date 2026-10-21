import { loadSettings, type Locale } from '../store/settings'
import { settingsMessages } from './settings'
import { shellMessages } from './shell'
import { loraMessages } from './lora'
import { workspaceMessages } from './workspace'

export type { Locale } from '../store/settings'

export const messages = {
  ...settingsMessages,
  ...shellMessages,
  ...loraMessages,
  ...workspaceMessages,
} as const

export type MessageKey = keyof typeof messages
export type MessageParams = Readonly<Record<string, string | number | null | undefined>>

// Read the settings owner before modules construct their presentation labels.
// Language changes reload the panel, so views do not retain another language.
let locale: Locale = loadSettings().locale

export function getLocale(): Locale {
  return locale
}

export function setLocale(value: Locale): void {
  locale = value === 'en' ? 'en' : 'zh-CN'
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('tk-toolkit-locale-change', { detail: { locale } }))
}

export function t(key: MessageKey, params: MessageParams = {}): string {
  const entry = messages[key]
  // An empty translation is intentional for unit suffixes in English.
  const text = entry?.[locale === 'en' ? 'en' : 'zh'] ?? entry?.zh ?? key
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder: string, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder)
}

const translatedAttributes = ['title', 'placeholder', 'aria-label', 'alt', 'data-label'] as const

// Explicit bindings only. Never scan user prompts, model names or arbitrary DOM
// text, and never rebuild a container that owns images, icons or event handlers.
export function applyTranslations(root: ParentNode = document): void {
  const selector = ['[data-i18n]', ...translatedAttributes.map(name => `[data-i18n-${name}]`)].join(',')
  const elements: Element[] = Array.from(root.querySelectorAll(selector))
  if (root instanceof Element && root.matches(selector)) elements.unshift(root)
  for (const element of elements) {
    const key = element.getAttribute('data-i18n')
    if (key && Object.prototype.hasOwnProperty.call(messages, key) && element.children.length === 0) {
      element.textContent = t(key as MessageKey)
    }
    for (const name of translatedAttributes) {
      const attributeKey = element.getAttribute(`data-i18n-${name}`)
      if (attributeKey && Object.prototype.hasOwnProperty.call(messages, attributeKey)) {
        element.setAttribute(name, t(attributeKey as MessageKey))
      }
    }
  }
}

export function initLocale(): void {
  setLocale(loadSettings().locale)
  applyTranslations()
}
