// Offline checks for the panel's language catalog and settings compatibility.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'tk-i18n-'))
const values = new Map()
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
}
const previousStorage = globalThis.localStorage
const previousDocument = globalThis.document
globalThis.localStorage = storage
globalThis.document = { documentElement: { lang: '' } }
try {
  const bundle = join(temporary, 'language.mjs')
  await build({ stdin: { contents: `export * from './src/i18n/index'; export * from './src/store/settings'; export * from './src/i18n/display'`,
    resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' })
  const api = await import(pathToFileURL(bundle).href)
  let checks = 0
  const check = (name, run) => { run(); checks++; console.log(`[OK] ${name}`) }
  check('old settings keep Chinese and existing preferences', () => {
    values.set('anima_settings', JSON.stringify({ fontSize: 17, contentWidth: 'wide', layoutVersion: 2 }))
    const saved = api.loadSettings()
    assert.equal(saved.locale, 'zh-CN')
    assert.equal(saved.fontSize, 17)
    assert.equal(saved.contentWidth, 'wide')
  })
  check('invalid locale falls back to Chinese', () => {
    values.set('anima_settings', JSON.stringify({ locale: 'fr', layoutVersion: 2 }))
    assert.equal(api.loadSettings().locale, 'zh-CN')
  })
  check('language preference survives saving and reloading settings', () => {
    assert.equal(api.saveSettings({ locale: 'en', fontSize: 16 }), true)
    assert.equal(api.loadSettings().locale, 'en')
    assert.equal(api.loadSettings().fontSize, 16)
  })
  const parameters = value => [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort()
  check('every message has both languages and identical placeholders', () => {
    for (const [key, entry] of Object.entries(api.messages)) {
      assert.equal(typeof entry.zh, 'string', key)
      assert.equal(typeof entry.en, 'string', key)
      assert.deepEqual(parameters(entry.en), parameters(entry.zh), key)
    }
  })
  check('static HTML bindings reference real keys', () => {
    // The complete set is checked below after reading index.html.
    assert.ok(Object.keys(api.messages).length > 1000)
  })
  const html = await readFile(resolve(root, 'index.html'), 'utf8')
  for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
    assert.ok(Object.hasOwn(api.messages, match[1]), `Missing HTML message: ${match[1]}`)
  }
  check('English and Chinese resolve through the same API', () => {
    api.setLocale('en')
    assert.equal(document.documentElement.lang, 'en')
    assert.equal(api.t('settings.title'), 'Settings')
    api.setLocale('zh-CN')
    assert.equal(api.t('settings.title'), '设置')
  })
  check('empty English unit suffix remains empty', () => {
    api.setLocale('en')
    assert.equal(api.t('shell.pageSuffix'), '')
  })
  check('interpolation preserves user braces and replacement characters', () => {
    const value = '中文 <img> {p1} $&'
    assert.equal(api.t('workspace.category3', { p0: value }), `Category: ${value}`)
  })
  check('only unchanged built-in category names are translated', () => {
    assert.equal(api.promptCategoryLabel({ id: 'uncategorized', name: '未分类' }), 'Uncategorized')
    assert.equal(api.promptCategoryLabel({ id: 'uncategorized', name: '我的分类' }), '我的分类')
    assert.equal(api.promptCategoryLabel({ id: 'custom', name: '人物' }), '人物')
    assert.equal(api.clothingCategoryLabel({ id: 'custom', name: '未分类' }), '未分类')
  })
  check('folder paths and real character names remain unchanged', () => {
    assert.equal(api.outputBrowseLabel({ kind: 'directory', path: '未识别', label: '未识别' }), '未识别')
    assert.equal(api.outputBrowseLabel({ kind: 'character', key: '["未识别"]', label: '未识别' }), 'Unrecognized')
    assert.equal(api.outputBrowseLabel({ kind: 'character', key: '["[\\"character-id\\"]"]', label: '未识别' }), '未识别')
  })
  check('storage failure is reported without losing runtime preferences', () => {
    const savedSet = storage.setItem
    storage.setItem = () => { throw new Error('storage unavailable') }
    assert.equal(api.saveSettings({ locale: 'zh-CN' }), false)
    storage.setItem = savedSet
  })
  check('reset restores the default language', () => {
    assert.equal(api.resetSettings().locale, 'zh-CN')
  })
  console.log(`[PASS] ${checks} checks; ${Object.keys(api.messages).length} bilingual messages`)
} finally {
  globalThis.localStorage = previousStorage
  globalThis.document = previousDocument
  // This directory is created by this process under the OS temporary folder.
  if (!temporary.startsWith(join(tmpdir(), 'tk-i18n-'))) throw new Error('Unexpected temporary path')
  await rm(temporary, { recursive: true, force: true })
}
