import { t, getLocale } from '../i18n'
import { sourceForFile, fileSourceIdentity, readOutputSourceFile } from '../services/outputSources'
import { createImageSnapshot, imageRevision } from '../services/outputIdentity'
import { deleteLocalLoraPreview, loadLocalLoraPreviews, saveLocalLoraPreview, useLocalModelStore, localScanSession } from '../store/localModels'
import type { LocalScanProgress } from '../services/localScanSession'
import type { LocalDisplayMode, LocalSortKey, LocalFilterKey, LocalViewKey } from '../store/localModels'
import { esc, escAttr, copyText, showToast, fmtNum, thumbUrl, debounce, stripExt, setBtnIcon, icon, attachSearchClear } from '../utils'
import { openLightbox } from '../components/Lightbox'
import { ImageNodeCache } from '../components/ImageNodeCache'
import { localCategoryEntries } from '../services/localCategoryNavigation'
import type { PngMeta, LocalLoraFile, LocalLoraMatch, TagFreq } from '../types'
import type { OutputMetadata } from '../types/outputs'
import { promptModal, confirmModal } from '../components/Modal'
import { openContextMenu, type ContextMenuAction } from '../components/ContextMenu'
import { refreshLocalNames } from '../components/ModelCard'
import { bindUrlDownloadModal } from './downloadUrlModal'
import { useOutputStore, outputSummaryForFile } from '../store/outputStore'
import { ensureAllMetadata, isMetadataIndexComplete } from '../services/outputMetadataIndex'
import { extractLorasFromWorkflow, parseOutputMetadataBlob, outputLoraNames, type ParsedMetadata } from '../services/outputMetadata'
import { renderMetadataReliability, renderGenerationDetails, bindRawMetadataDetails } from '../renderers/outputGenerationDetails'
import { metadataForFile, outputRootIdentity } from '../services/outputIdentity'
import { localLoraTriggerOverrides, normalizeLocalLoraIdentity } from '../services/localLoraTriggerOverrides'
// 底模口径单一真源：C 站匹配值优先，其次本地 safetensors 元数据识别值
import { resolveFileBaseModel, baseModelKey } from '../services/baseModelCatalog'
import type { LocalLoraTriggerOverrideEntry } from '../services/localLoraTriggerOverrides'

// ── 搜索高亮工具 ──
function highlightText(text: string, query: string): string {
  if (!query) return esc(text)
  const escaped = esc(text)
  const q = esc(query)
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>')
}

let _initDone = false
let _localStoreUnsubscribe: (() => void) | null = null
let _outputStoreUnsubscribe: (() => void) | null = null
let _scanProgressUnsubscribe: (() => void) | null = null
const _localImageNodes = new ImageNodeCache(128, 16 * 1024 * 1024)
window.addEventListener('pagehide', () => _localImageNodes.clear(), { once: true })

function localProgressLabel(progress: LocalScanProgress): string {
  if (getLocale() === 'zh-CN') return progress.label
  if (progress.status === 'matching') return t('lora.scan.matching')
  const reading = progress.label.match(/^扫描中 (.+) (\d+)%$/)
  if (reading) return t('lora.scan.reading', { name: reading[1], percent: reading[2] })
  const summary = progress.label.match(/^扫描 \(新(\d+) 变(\d+) 同(\d+)\)$/)
  if (summary) return t('lora.scan.summary', { added: summary[1], changed: summary[2], unchanged: summary[3] })
  return progress.status === 'scanning' ? t('lora.scan.scanning') : progress.label
}

function localCategoryLabel(value: string, fallback: string): string {
  if (!value) return t('lora.all')
  return value === '__uncategorized__' ? t('lora.category.uncategorized') : fallback
}

function renderScanProgress(progress: LocalScanProgress): void {
  const busy = progress.status === 'scanning' || progress.status === 'matching'
  const wrap = document.getElementById('localProgress')
  const bar = document.getElementById('localProgressBar')
  const text = document.getElementById('localProgressText')
  const scanButton = document.getElementById('localScanBtn') as HTMLButtonElement | null
  const matchButton = document.getElementById('localMatchAllBtn') as HTMLButtonElement | null
  if (scanButton) scanButton.disabled = busy
  if (matchButton) matchButton.disabled = busy
  if (wrap) wrap.style.display = busy ? 'flex' : 'none'
  const pct = progress.total > 0 ? Math.round(((progress.done + progress.partial) / progress.total) * 100) : 0
  if (bar) bar.style.width = busy ? `${pct}%` : '0%'
  if (text) text.textContent = `${localProgressLabel(progress)} ${progress.done}/${progress.total} (${pct}%)`
}

// ── 渲染调度：扫描/匹配期间 store 高频变化（每个文件 updateFile 一次），
// 若每次都全量重建列表 DOM（数千卡片）会把主线程反复打满 —— 表现为弹窗/滚动期间
// 页面接近无响应。这里做 250ms 尾沿节流：短风暴合并成每 250ms 最多一次重渲染。──
let _renderTimer: ReturnType<typeof setTimeout> | null = null
function isLocalManagerActive(): boolean {
  const section = document.getElementById('sectionLocal')
  return Boolean(section && !section.classList.contains('section-hidden'))
}

interface LocalTriggerEditorState {
  name: string
  identity: string
  requestId: number
  operationId: number
  entry: LocalLoraTriggerOverrideEntry | null
  automaticWords: string[] | null
  draft: string
  dirty: boolean
  copying: boolean
  status: 'loading' | 'ready' | 'uneditable' | 'error' | 'saving'
  error: string
}

let _triggerEditor: LocalTriggerEditorState | null = null
const _triggerDrafts = new Map<string, { draft: string; dirty: boolean }>()
let _triggerRequestId = 0
let _triggerCopyOperationId = 0
let _triggerSyncBound = false
let _triggerSyncUnsubscribe: (() => void) | null = null
let _categorySlotObserver: MutationObserver | null = null
let _categorySlotEventsBound = false
let _detailDrawerOpen = false
let _categoryToggleEventsBound = false

function triggerServiceAvailable(): boolean {
  return Boolean(localLoraTriggerOverrides && typeof localLoraTriggerOverrides.load === 'function')
}

function initializeTriggerOverrideSync(): void {
  if (_triggerSyncBound || !triggerServiceAvailable()) return
  _triggerSyncBound = true
  localLoraTriggerOverrides.initialize()
  _triggerSyncUnsubscribe = localLoraTriggerOverrides.subscribe((identities) => {
    const editor = _triggerEditor
    if (!editor || !identities.includes(editor.identity)) return
    const entry = localLoraTriggerOverrides.entry(editor.name)
    if (!entry) return
    editor.entry = entry
    if (!editor.dirty && editor.status !== 'saving') editor.draft = effectiveTriggerWords(entry, editor.automaticWords).join('\n')
    if (editor.status !== 'saving') editor.status = entry.editable ? 'ready' : 'uneditable'
    editor.error = ''
    updateTriggerEditorDom()
  })
}

function effectiveTriggerWords(entry: LocalLoraTriggerOverrideEntry, automaticWords: string[] | null = null): string[] {
  if (entry.hasOverride) return entry.words || []
  if (automaticWords) return automaticWords
  return entry.automaticWords || []
}

function setActiveTriggerName(name: string | null): void {
  if (triggerServiceAvailable() && typeof localLoraTriggerOverrides.setActiveName === 'function') {
    localLoraTriggerOverrides.setActiveName(name)
  }
}

function ensureTriggerEditor(f: LocalLoraFile): LocalTriggerEditorState {
  const identity = normalizeLocalLoraIdentity(f.name)
  if (_triggerEditor?.identity === identity) {
    _triggerEditor.automaticWords = Array.isArray(f.matchData?.trainedWords) ? f.matchData.trainedWords : null
    if (_triggerEditor.entry && !_triggerEditor.dirty && !_triggerEditor.entry.hasOverride) {
      _triggerEditor.draft = effectiveTriggerWords(_triggerEditor.entry, _triggerEditor.automaticWords).join('\n')
    }
    return _triggerEditor
  }

  if (_triggerEditor?.dirty) {
    _triggerDrafts.set(_triggerEditor.identity, { draft: _triggerEditor.draft, dirty: true })
  }
  const savedDraft = _triggerDrafts.get(identity)

  const editor: LocalTriggerEditorState = {
    name: f.name,
    identity,
    requestId: ++_triggerRequestId,
    operationId: 0,
    entry: null,
    automaticWords: Array.isArray(f.matchData?.trainedWords) ? f.matchData.trainedWords : null,
    draft: savedDraft?.draft || '',
    dirty: Boolean(savedDraft?.dirty),
    copying: false,
    status: 'loading',
    error: '',
  }
  _triggerEditor = editor
  setActiveTriggerName(_detailDrawerOpen || useLocalModelStore.getState().currentView === 'detail' ? f.name : null)
  if (!triggerServiceAvailable()) {
    editor.status = 'error'
    editor.error = t('lora.trigger.unavailable')
    return editor
  }

  const requestId = editor.requestId
  const operationId = editor.operationId
  void localLoraTriggerOverrides.load(f.name, true).then(entry => {
    if (_triggerEditor !== editor || editor.requestId !== requestId || editor.operationId !== operationId) return
    editor.entry = entry
    if (!editor.dirty) editor.draft = effectiveTriggerWords(entry, editor.automaticWords).join('\n')
    editor.status = entry.editable ? 'ready' : 'uneditable'
    editor.error = ''
    updateTriggerEditorDom()
  }).catch(error => {
    if (_triggerEditor !== editor || editor.requestId !== requestId || editor.operationId !== operationId) return
    editor.status = 'error'
    editor.error = error instanceof Error ? error.message : String(error)
    updateTriggerEditorDom()
  })
  return editor
}

function triggerEditorStatus(editor: LocalTriggerEditorState): string {
  if (editor.status === 'saving') return t('lora.trigger.saving')
  if (editor.status === 'error') return t('lora.trigger.syncError', { error: editor.error })
  if (editor.dirty) return t('lora.trigger.dirty')
  if (editor.status === 'loading') return t('lora.trigger.loadingSaved')
  if (editor.status === 'uneditable' || (editor.entry && !editor.entry.editable)) {
    return t('lora.trigger.ambiguous')
  }
  if (!editor.entry) return t('lora.trigger.notLoadedSaved')
  if (editor.entry.hasOverride && !(editor.entry.words || []).length) return t('lora.trigger.emptyOverride')
  return editor.entry.hasOverride
    ? t('lora.trigger.usingCustom', { count: editor.entry.words?.length || 0 })
    : t('lora.trigger.usingAutomatic', { count: (editor.automaticWords ?? editor.entry.automaticWords ?? []).length })
}

function updateTriggerEditorDom(): void {
  const editorEl = document.getElementById('localTriggerEditor')
  const state = _triggerEditor
  if (!editorEl || !state) return
  const statusEl = editorEl.querySelector('[data-trigger-status]')
  if (statusEl) statusEl.textContent = triggerEditorStatus(state)
  const effectiveEl = editorEl.querySelector('[data-trigger-effective]')
  if (effectiveEl) {
    const words = state.entry ? effectiveTriggerWords(state.entry, state.automaticWords) : null
    effectiveEl.textContent = words === null ? t('lora.trigger.notLoaded') : words.length ? words.join('\n') : t('lora.trigger.empty')
  }
  const autoEl = editorEl.querySelector('[data-trigger-automatic]')
  if (autoEl) {
    const words = state.automaticWords ?? state.entry?.automaticWords
    autoEl.textContent = words ? (words.join('\n') || t('lora.trigger.automaticEmpty')) : t('lora.reading')
  }
  const input = editorEl.querySelector('.local-trigger-draft') as HTMLTextAreaElement | null
  if (input && (document.activeElement !== input || !state.dirty)) input.value = state.draft
  if (input) input.disabled = state.status === 'saving' || state.status === 'uneditable'
  const save = editorEl.querySelector('.local-trigger-save') as HTMLButtonElement | null
  const reset = editorEl.querySelector('.local-trigger-reset') as HTMLButtonElement | null
  const copy = editorEl.querySelector('.local-trigger-copy') as HTMLButtonElement | null
  const retry = editorEl.querySelector('.local-trigger-retry') as HTMLButtonElement | null
  if (save) {
    save.disabled = state.status === 'saving' || state.status === 'uneditable'
    save.textContent = state.dirty ? t('lora.trigger.saveCustom') : t('lora.save')
  }
  if (reset) reset.disabled = state.status === 'saving' || !state.entry?.editable || !state.entry.hasOverride
  if (copy) {
    copy.disabled = state.copying || state.status === 'loading' || state.status === 'saving' || !state.entry || !effectiveTriggerWords(state.entry, state.automaticWords).length
    copy.setAttribute('aria-busy', String(state.copying))
    copy.innerHTML = state.copying ? t('lora.trigger.readLatest') : `${icon('copy', 14)} ${t('lora.trigger.copySaved')}`
  }
  if (retry) retry.hidden = state.status !== 'error'
}

function ensureLocalManagerLayout(): void {
  const root = document.getElementById('sectionLocal') as HTMLElement | null
  if (!root || typeof root.querySelector !== 'function') return
  const container = root.querySelector('.local-container') as HTMLElement | null
  const toolbar = container?.querySelector('.local-toolbar') as HTMLElement | null
  const sidebarTools = container?.querySelector('.local-sidebar-tools') as HTMLElement | null
  const main = container?.querySelector('.local-main') as HTMLElement | null
  const home = document.getElementById('pageLocalHome')
  const fileList = document.getElementById('localFileList')
  if (!container || !toolbar || !main || !home || !fileList) return
  container.classList.add('local-manager-polished')

  if (!home.contains(fileList)) home.prepend(fileList)
  const sidebar = container.querySelector('.local-sidebar') as HTMLElement | null
  const batchBar = document.getElementById('localBatchBar')
  if (batchBar && !home.contains(batchBar)) fileList.after(batchBar)

  const primary = toolbar.querySelector('.local-toolbar-primary') || document.createElement('div')
  primary.className = 'local-toolbar-primary'
  const more = toolbar.querySelector('.local-toolbar-more') as HTMLDetailsElement | null || document.createElement('details')
  more.className = 'local-toolbar-more'
  if (!more.querySelector('summary')) {
    const summary = document.createElement('summary')
    summary.setAttribute('aria-label', t('lora.local.moreActions'))
    summary.textContent = t('lora.more')
    const actions = document.createElement('div')
    actions.className = 'local-toolbar-more-actions'
    more.append(summary, actions)
  }
  const moreActions = more.querySelector('.local-toolbar-more-actions') as HTMLElement
  const primaryActions = ['localScanBtn']
  const moreActionIds = ['localFolderCategoryBtn', 'localMatchAllBtn', 'localClearBtn', 'localBatchToggleBtn']
  for (const id of primaryActions) {
    const button = document.getElementById(id)
    if (button && button.parentElement !== primary) primary.append(button)
  }
  for (const id of moreActionIds) {
    const button = document.getElementById(id)
    if (button && button.parentElement !== moreActions) moreActions.append(button)
  }
  const viewTabs = container.querySelector('.local-view-tabs') as HTMLElement | null
  if (viewTabs) {
    let viewGroup = moreActions.querySelector('.local-toolbar-more-views') as HTMLElement | null
    if (!viewGroup) {
      viewGroup = document.createElement('div')
      viewGroup.className = 'local-toolbar-more-views'
      viewGroup.setAttribute('role', 'group')
      viewGroup.setAttribute('aria-label', t('lora.local.views'))
      moreActions.append(viewGroup)
    }
    if (viewTabs.parentElement !== viewGroup) viewGroup.append(viewTabs)
  }
  const stats = document.getElementById('localScanStats')
  const newFileBadge = document.getElementById('localNewFileBadge')
  if (stats && stats.parentElement !== toolbar) toolbar.append(stats)
  if (newFileBadge && newFileBadge.parentElement !== toolbar) toolbar.append(newFileBadge)
  if (primary.parentElement !== toolbar) toolbar.prepend(primary)
  if (more.parentElement !== toolbar) toolbar.append(more)

  let controlRow = container.querySelector('.local-manager-control-row') as HTMLElement | null
  if (!controlRow) {
    controlRow = document.createElement('div')
    controlRow.className = 'local-manager-control-row'
    toolbar.after(controlRow)
  }
  if (sidebarTools) {
    const search = sidebarTools.querySelector('.local-sidebar-search')
    const filters = sidebarTools.querySelector('.local-sidebar-filters')
    if (search && search.parentElement !== controlRow) controlRow.append(search)
    if (filters && filters.parentElement !== controlRow) controlRow.append(filters)
  }
  const baseModel = document.getElementById('localBaseModelPanel')
  if (baseModel && baseModel.parentElement !== controlRow) controlRow.append(baseModel)

  const categorySlot = document.getElementById('toolboxLocalCategorySlot')
  const categories = document.getElementById('localGridCategoryList')
  if (categorySlot && categories && categories.parentElement !== categorySlot) categorySlot.append(categories)
  if (categorySlot) {
    ensureCategoryMenu(categorySlot, toolbar)
    syncCategorySlotVisibility()
    if (!_categorySlotEventsBound) {
      categorySlot.addEventListener('click', handleCategorySlotClick)
      _categorySlotEventsBound = true
    }
    if (!_categorySlotObserver && typeof MutationObserver !== 'undefined' && root) {
      _categorySlotObserver = new MutationObserver(syncCategorySlotVisibility)
      _categorySlotObserver.observe(root, { attributes: true, attributeFilter: ['class'] })
    }
  }
  // Every interactive control is moved out first. Hide the legacy two-column
  // sidebar rather than leaving its duplicate proxy buttons tabbable.
  if (sidebar && categorySlot && categories?.parentElement === categorySlot) {
    sidebar.hidden = true
    sidebar.style.display = 'none'
    sidebar.setAttribute('aria-hidden', 'true')
  }

  const detailPage = document.getElementById('pageLocalDetail')
  if (detailPage) {
    detailPage.classList.add('local-detail-drawer')
    detailPage.setAttribute('aria-hidden', String(!_detailDrawerOpen && useLocalModelStore.getState().currentView !== 'detail'))
    detailPage.classList.toggle('local-detail-drawer-open', _detailDrawerOpen && useLocalModelStore.getState().currentView !== 'detail')
  }
}

function syncCategorySlotVisibility(): void {
  const slot = document.getElementById('toolboxLocalCategorySlot') as HTMLElement | null
  const toggle = document.querySelector('.toolbox-local-category-toggle') as HTMLElement | null
  const menu = document.getElementById('localCategoryMenu') as HTMLDetailsElement | null
  const visible = isLocalManagerActive()
  if (slot) {
    slot.hidden = !visible
    slot.setAttribute('aria-hidden', String(!visible))
  }
  if (toggle) {
    toggle.hidden = !visible
    if (!visible) setCategoryRailOpen(false)
    toggle.setAttribute('aria-expanded', String(Boolean(menu?.open)))
  }
}

function setCategoryRailOpen(open: boolean): void {
  const menu = document.getElementById('localCategoryMenu') as HTMLDetailsElement | null
  const toggle = document.querySelector('.toolbox-local-category-toggle') as HTMLElement | null
  if (menu) menu.open = open
  toggle?.setAttribute('aria-expanded', String(open))
}

function ensureCategoryMenu(slot: HTMLElement, toolbar: HTMLElement): void {
  if (!_categoryToggleEventsBound) {
    const quick = document.createElement('nav')
    quick.id = 'localCategoryQuickFilters'; quick.className = 'local-category-strip'; quick.setAttribute('aria-label', t('lora.category.quickSwitch'))
    quick.addEventListener('click', handleCategorySlotClick)
    const menu = document.createElement('details')
    menu.id = 'localCategoryMenu'; menu.className = 'local-category-menu'
    const toggle = document.createElement('summary')
    toggle.className = 'toolbox-local-category-toggle'
    toggle.setAttribute('aria-controls', slot.id)
    toggle.setAttribute('aria-expanded', 'false')
    toggle.setAttribute('aria-label', t('lora.category.manageAria'))
    toggle.title = t('lora.category.manageTitle')
    toggle.innerHTML = `${icon('folder', 14)}<span>${t('lora.category.label')}</span>${icon('chevronDown', 12)}`
    const panel = document.createElement('div'); panel.className = 'local-category-panel'
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = t('lora.category.searchPlaceholder'); search.setAttribute('aria-label', t('lora.category.searchAria'))
    panel.append(search, slot); menu.append(toggle, panel); toolbar.append(quick, menu)
    const filter = () => { const query = search.value.trim().toLocaleLowerCase(); slot.querySelectorAll<HTMLElement>('.local-grid-category-row').forEach(row => { row.hidden = query !== '' && !row.textContent?.toLocaleLowerCase().includes(query) }) }
    search.addEventListener('input', filter)
    if (typeof MutationObserver !== 'undefined') new MutationObserver(filter).observe(slot, { childList: true, subtree: true })
    menu.addEventListener('toggle', () => toggle.setAttribute('aria-expanded', String(menu.open)))
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) setCategoryRailOpen(false) })
    toggle.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); setCategoryRailOpen(true); search.focus() } })
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('[role="dialog"], .modal, .modal-overlay')) return
      if (menu.open) {
        event.preventDefault()
        setCategoryRailOpen(false)
        toggle.focus()
        return
      }
      if (_detailDrawerOpen && isLocalManagerActive()) {
        event.preventDefault()
        closeLocalDetail()
      }
    })
    _categoryToggleEventsBound = true
  }
}

async function handleCategorySlotClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement
  // This menu lives inside sectionLocal now; the shared action must run once.
  event.stopPropagation()
  const del = target.closest('.local-cat-del-btn') as HTMLElement | null
  if (del) {
    const category = del.dataset.cat
    if (category && await confirmModal(t('lora.category.delete'), t('lora.category.confirmDelete', { name: category }))) {
      const store = useLocalModelStore.getState()
      store.removeCategory(category)
      store.saveToCache()
      renderSidebarList(useLocalModelStore.getState())
    }
    return
  }
  const rename = target.closest('.local-cat-rename-btn') as HTMLElement | null
  if (rename) {
    const category = rename.dataset.cat
    if (!category) return
    const store = useLocalModelStore.getState()
    const newName = await promptModal(t('lora.category.rename'), category)
    if (!newName || !newName.trim() || newName.trim() === category) return
    if (store.categories.includes(newName.trim())) { showToast(t('lora.category.duplicateName')); return }
    store.renameCategory(category, newName.trim())
    store.saveToCache()
    renderSidebarList(store)
    return
  }
  if (target.closest('.local-new-cat-btn')) {
    const category = await promptModal(t('lora.category.create'))
    if (!category || !category.trim()) return
    const store = useLocalModelStore.getState()
    if (store.categories.includes(category.trim())) { showToast(t('lora.category.duplicate')); return }
    store.addCategory(category.trim())
    store.saveToCache()
    renderSidebarList(store)
    return
  }
  const button = target.closest('.local-grid-cat-btn') as HTMLElement | null
  if (button) {
    const category = button.dataset.cat || null
    useLocalModelStore.getState().setFilterCategory(category)
    setCategoryRailOpen(false)
    renderSidebarList(useLocalModelStore.getState())
  }
}

function openLocalDetail(name: string): void {
  const state = useLocalModelStore.getState()
  const previousView = state.currentView || 'home'
  state.selectModel(name)
  if (previousView !== 'detail') useLocalModelStore.getState().setCurrentView(previousView)
  _detailDrawerOpen = true
  renderSidebarList(useLocalModelStore.getState())
  renderDetail(useLocalModelStore.getState())
  const page = document.getElementById('pageLocalDetail')
  if (page && useLocalModelStore.getState().currentView !== 'detail') {
    page.classList.add('local-detail-drawer-open')
    page.setAttribute('aria-hidden', 'false')
  }
  setActiveTriggerName(name)
}

function closeLocalDetail(): void {
  const state = useLocalModelStore.getState()
  _detailDrawerOpen = false
  setActiveTriggerName(null)
  if (state.currentView === 'detail') {
    state.setCurrentView('home')
    document.querySelectorAll('.local-view-tab').forEach(tab => tab.classList.toggle('active', (tab as HTMLElement).dataset.view === 'home'))
    document.querySelectorAll('.local-page').forEach(page => page.classList.toggle('active', (page as HTMLElement).id === 'pageLocalHome'))
  }
  const page = document.getElementById('pageLocalDetail')
  if (page) {
    page.classList.remove('local-detail-drawer-open')
    page.setAttribute('aria-hidden', 'true')
  }
  const fileList = document.getElementById('localFileList')
  fileList?.focus({ preventScroll: true })
}

async function retryTriggerEditorRead(name: string): Promise<void> {
  const editor = _triggerEditor
  if (!editor || editor.identity !== normalizeLocalLoraIdentity(name) || !triggerServiceAvailable()) return
  const operationId = ++editor.operationId
  editor.status = 'loading'
  editor.error = ''
  updateTriggerEditorDom()
  try {
    const entry = await localLoraTriggerOverrides.load(name, true)
    if (_triggerEditor !== editor || editor.operationId !== operationId) return
    editor.entry = entry
    if (!editor.dirty) editor.draft = effectiveTriggerWords(entry, editor.automaticWords).join('\n')
    editor.status = entry.editable ? 'ready' : 'uneditable'
  } catch (error) {
    if (_triggerEditor !== editor || editor.operationId !== operationId) return
    editor.status = 'error'
    editor.error = error instanceof Error ? error.message : String(error)
  }
  updateTriggerEditorDom()
}

async function copyConfirmedTriggerWords(name: string, button: HTMLElement): Promise<void> {
  const editor = _triggerEditor
  if (!editor || editor.identity !== normalizeLocalLoraIdentity(name) || editor.copying || editor.status === 'saving' || !triggerServiceAvailable()) return
  const copyOperationId = ++_triggerCopyOperationId
  const editorOperationId = editor.operationId
  editor.copying = true
  updateTriggerEditorDom()
  const isCurrent = () => {
    const state = useLocalModelStore.getState()
    return _triggerEditor === editor
      && copyOperationId === _triggerCopyOperationId
      && editor.operationId === editorOperationId
      && state.selectedModel
      && normalizeLocalLoraIdentity(state.selectedModel) === editor.identity
      && isLocalManagerActive()
      && (state.currentView === 'detail' || _detailDrawerOpen)
  }
  try {
    const entry = await localLoraTriggerOverrides.load(name, true)
    if (!isCurrent()) return
    editor.entry = entry
    if (!editor.dirty) editor.draft = effectiveTriggerWords(entry, editor.automaticWords).join('\n')
    editor.status = entry.editable ? 'ready' : 'uneditable'
    editor.error = ''
    updateTriggerEditorDom()
    const words = effectiveTriggerWords(entry, editor.automaticWords)
    if (words.length) copyText(words.join(', '), button)
  } catch (error) {
    if (!isCurrent()) return
    editor.status = 'error'
    editor.error = error instanceof Error ? error.message : String(error)
    // The failed refresh never replaces the draft or claims a stale value was copied.
  } finally {
    if (_triggerEditor === editor && copyOperationId === _triggerCopyOperationId) {
      editor.copying = false
      updateTriggerEditorDom()
    }
  }
}

async function persistTriggerEditor(name: string, reset = false): Promise<void> {
  const editor = _triggerEditor
  if (!editor || editor.identity !== normalizeLocalLoraIdentity(name) || editor.status === 'saving' || !triggerServiceAvailable()) return
  const operationId = ++editor.operationId
  const requestId = editor.requestId
  const draft = editor.draft
  editor.status = 'saving'
  editor.error = ''
  updateTriggerEditorDom()
  try {
    const entry = await localLoraTriggerOverrides.save(name, draft, reset)
    if (_triggerEditor !== editor || editor.requestId !== requestId || editor.operationId !== operationId) return
    editor.entry = entry
    editor.dirty = false
    editor.draft = effectiveTriggerWords(entry, editor.automaticWords).join('\n')
    _triggerDrafts.delete(editor.identity)
    editor.status = entry.editable ? 'ready' : 'uneditable'
    editor.error = ''
  } catch (error) {
    if (_triggerEditor !== editor || editor.requestId !== requestId || editor.operationId !== operationId) return
    editor.status = 'error'
    editor.error = error instanceof Error ? error.message : String(error)
    // Keep the user's text and dirty state so Save remains a real retry.
  }
  updateTriggerEditorDom()
}

function activateLocalView(view: LocalViewKey): void {
  const state = useLocalModelStore.getState()
  state.setCurrentView(view)
  document.querySelectorAll('.local-view-tab').forEach(tab => tab.classList.toggle('active', (tab as HTMLElement).dataset.view === view))
  document.querySelectorAll('.local-page').forEach(page => page.classList.toggle('active', page.id === `pageLocal${view.charAt(0).toUpperCase()}${view.slice(1)}`))
  const detailPage = document.getElementById('pageLocalDetail')
  if (view === 'detail') {
    _detailDrawerOpen = false
    detailPage?.classList.remove('local-detail-drawer-open')
    detailPage?.setAttribute('aria-hidden', 'false')
    renderDetail(state)
    if (state.selectedModel) setActiveTriggerName(state.selectedModel)
  } else {
    if (view !== 'home') _detailDrawerOpen = false
    if (!_detailDrawerOpen) {
      detailPage?.classList.remove('local-detail-drawer-open')
      detailPage?.setAttribute('aria-hidden', 'true')
      setActiveTriggerName(null)
    }
    if (view === 'gallery') {
      renderGallery(state)
      renderTagFreq(state.tagFreq)
    }
    if (view === 'models') void renderModelsTab()
    if (view === 'home' && _detailDrawerOpen && state.selectedModel) renderDetail(state)
  }
}

function renderTriggerEditor(f: LocalLoraFile, editor: LocalTriggerEditorState): string {
  const saved = editor.entry ? effectiveTriggerWords(editor.entry, editor.automaticWords) : null
  const automatic = editor.automaticWords || editor.entry?.automaticWords || []
  const savedText = saved === null ? t('lora.trigger.notLoaded') : saved.length ? saved.join('\n') : t('lora.trigger.empty')
  return `<section class="local-trigger-editor" id="localTriggerEditor" data-name="${escAttr(f.name)}">
    <div class="local-trigger-heading"><div><h4>${t('lora.trigger.shared')}</h4><span data-trigger-status role="status" aria-live="polite">${esc(triggerEditorStatus(editor))}</span></div>
      <button class="local-trigger-copy" type="button" title="${t('lora.trigger.copySavedTitle')}" aria-label="${t('lora.trigger.copySavedTitle')}">${icon('copy', 14)} ${t('lora.trigger.copySaved')}</button>
    </div>
    <div class="local-trigger-saved"><span>${t('lora.trigger.current')}</span><pre data-trigger-effective>${esc(savedText)}</pre></div>
    <label class="local-trigger-label" for="localTriggerDraft">${t('lora.trigger.draft')}</label>
    <textarea id="localTriggerDraft" class="local-trigger-draft" data-name="${escAttr(f.name)}" maxlength="20000" rows="4" placeholder="${t('lora.trigger.placeholder')}">${esc(editor.draft)}</textarea>
    <details class="local-trigger-auto"><summary>${t('lora.trigger.showAutomatic')}</summary><pre data-trigger-automatic>${esc(automatic.length ? automatic.join('\n') : t('lora.trigger.automaticEmpty'))}</pre></details>
    <div class="local-trigger-actions">
      <button class="local-trigger-save" data-name="${escAttr(f.name)}" type="button">${t('lora.save')}</button>
      <button class="local-trigger-reset" data-name="${escAttr(f.name)}" type="button">${t('lora.trigger.restoreAutomatic')}</button>
      <button class="local-trigger-retry" data-name="${escAttr(f.name)}" type="button" hidden>${t('lora.trigger.retryRead')}</button>
    </div>
  </section>`
}

function scheduleRenderLocalView(): void {
  if (!isLocalManagerActive() || _renderTimer !== null) return
  _renderTimer = setTimeout(() => {
    _renderTimer = null
    if (isLocalManagerActive()) renderLocalView()
  }, 250)
}

// ── 拖拽框选选中的 LoRA（右键可批量添加分类） ──
let _dragSelected = new Set<string>()
let _dragInitDone = false
let _justBoxed = false

function clearDragHighlight() {
  document.querySelectorAll('#localFileList .local-list-item.local-drag-selected').forEach(el => {
    el.classList.remove('local-drag-selected')
  })
}

// 右键菜单：单个 LoRA 切换分类，或拖拽多选时批量添加分类
// 菜单为「连续勾选」模式：点击分类后菜单保持打开（sticky），可一次勾选多个分类，点「✅ 完成」收尾
async function deleteLocalLora(name: string): Promise<void> {
  if (!await confirmModal(t('lora.local.deleteFile'), t('lora.local.confirmDeleteFile', { name }))) return
  await useLocalModelStore.getState().deleteFile(name)
  const state = useLocalModelStore.getState()
  if (state.selectedModel === name) state.selectModel(null)
  renderLocalView()
}

function loraContextActions(name: string): ContextMenuAction[] {
  const state = useLocalModelStore.getState()
  const file = state.files.find(row => row.name === name)
  if (!file) return []
  const url = localModelUrl(file)
  return [
    { label: t('lora.local.viewDetails'), icon: 'file-text', handler: () => openLocalDetail(name) },
    { label: t('lora.local.uploadPreview'), icon: 'image', handler: () => openLocalPreviewPicker(name) },
    ...(url ? [{ label: t('lora.local.openLoraPage'), icon: 'globe', handler: () => { window.open(url, '_blank', 'noopener,noreferrer') } }] : []),
    ...(state.previewImages[name] ? [{ label: t('lora.local.restorePreview'), icon: 'refresh', handler: () => { void resetLocalPreview(name) } }] : []),
    { label: t('lora.local.deleteFileMenu'), icon: 'trash', danger: true, handler: () => { void deleteLocalLora(name) } },
  ]
}

function openLoraContextMenu(e: Pick<MouseEvent, 'clientX' | 'clientY'>, name: string, focus = false) {
  const x = e.clientX, y = e.clientY

  // ── 拖拽多选：右键在选中项上 → 批量添加分类 ──
  if (_dragSelected.size > 1 && _dragSelected.has(name)) {
    const names = [..._dragSelected]
    const openBatchMenu = () => {
      const s = useLocalModelStore.getState()
      let addedCount = 0
      const catItems: ContextMenuAction[] = s.categories.map(cat => {
        const it: ContextMenuAction = {
          label: `🏷️ ${cat}`,
          sticky: true,
          handler: () => {
            // setBatchModelCategories 为累加语义：可连续勾选多个分类
            useLocalModelStore.getState().setBatchModelCategories(names, cat)
            useLocalModelStore.getState().saveToCache()
            addedCount++
            it.label = `☑ ${cat}`
          },
        }
        return it
      })
      catItems.push({
        label: t('lora.category.createMenu'),
        handler: async () => {
          const n = (await promptModal(t('lora.category.create')))?.trim()
          if (!n) return
          const st = useLocalModelStore.getState()
          if (st.categories.includes(n)) { showToast(t('lora.category.duplicatePlain')); return }
          st.addCategory(n)
          st.setBatchModelCategories(names, n)
          st.saveToCache()
          addedCount++
          openBatchMenu() // 重开菜单以纳入新分类
        },
      })
      catItems.push({
        label: t('lora.done'),
        handler: () => {
          _dragSelected.clear()
          clearDragHighlight()
          renderLocalView()
          if (addedCount > 0) showToast(t('lora.category.batchAdded', { count: names.length, categories: addedCount }))
        },
      })
      openContextMenu(x, y, [
        {
          label: t('lora.local.selectedLoras', { count: names.length }),
          items: [{ label: t('lora.category.addTo'), icon: '🏷️', handler: () => {}, children: catItems }],
        },
        { label: name, items: loraContextActions(name) },
      ], focus)
    }
    openBatchMenu()
    return
  }

  // ── 单个 LoRA：分类勾选/取消（菜单保持打开，可同时勾选多个分类）──
  const openSingleMenu = () => {
    const s = useLocalModelStore.getState()
    const key = stripExt(name)
    const current = () => useLocalModelStore.getState().modelCategories[key] || []
    const catItems: ContextMenuAction[] = s.categories.map(cat => {
      const it: ContextMenuAction = {
        label: current().includes(cat) ? `☑ ${cat}` : `☐ ${cat}`,
        sticky: true,
        handler: () => {
          const st = useLocalModelStore.getState()
          const cur = st.modelCategories[key] || []
          const next = cur.includes(cat) ? cur.filter(c => c !== cat) : [...cur, cat]
          st.setModelCategories(name, next)
          st.saveToCache()
          it.label = next.includes(cat) ? `☑ ${cat}` : `☐ ${cat}`
          renderLocalView()
        },
      }
      return it
    })
    catItems.push({
      label: t('lora.category.createMenu'),
      handler: async () => {
        const n = (await promptModal(t('lora.category.create')))?.trim()
        if (!n) return
        const st = useLocalModelStore.getState()
        if (st.categories.includes(n)) { showToast(t('lora.category.duplicatePlain')); return }
        st.addCategory(n)
        st.setModelCategories(name, [...(st.modelCategories[key] || []), n])
        st.saveToCache()
        renderLocalView()
        openSingleMenu() // 重开菜单以纳入新分类并显示 ☑
      },
    })
    catItems.push({ label: t('lora.done'), handler: () => {} }) // 点击即关闭菜单（默认行为）
    openContextMenu(x, y, [
      {
        label: name.replace(/\.\w+$/, ''),
        items: loraContextActions(name),
      },
      { items: [{ label: t('lora.category.label'), icon: 'tag', handler: () => {}, children: catItems }] },
    ], focus)
  }
  openSingleMenu()
}

// 拖拽框选（复刻 Outputs）：在列表空白处按下并拖动，框选多个 LoRA
function initDragSelect() {
  if (_dragInitDone) return
  _dragInitDone = true

  let isDragging = false
  let startX = 0, startY = 0
  let rectEl: HTMLElement | null = null

  // 右键菜单：document 捕获阶段接管，防止浏览器默认菜单/扩展抢先
  document.addEventListener('contextmenu', (e: MouseEvent) => {
    const item = (e.target as HTMLElement).closest('#localFileList .local-list-item') as HTMLElement
    if (!item) return
    e.preventDefault()
    e.stopPropagation()
    const name = item.dataset.name
    if (name) openLoraContextMenu(e, name)
  }, true)

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    const item = (event.target as HTMLElement).closest('#localFileList .local-list-item') as HTMLElement | null
    if (!item || (event.target as HTMLElement).closest('input, textarea, select')) return
    const name = item.dataset.name
    if (!name) return
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      event.preventDefault()
      const rect = item.getBoundingClientRect()
      openLoraContextMenu({ clientX: rect.left + 16, clientY: rect.top + 16 }, name, true)
    } else if (event.key === 'Enter' && event.target === item) {
      event.preventDefault()
      openLocalDetail(name)
    }
  }, true)

  document.addEventListener('mousedown', (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.closest('#sectionLocal')) return
    if (!target.closest('#localFileList')) return
    // 列表项/空白处按住左键拖动 = 框选（preventDefault 阻止浏览器文字选择/HTML5 drag）
    if (target.closest('.local-list-chk, button, input, select, .local-tree-cat-header')) return
    if (e.button !== 0) return
    isDragging = true
    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    e.preventDefault()
    e.stopPropagation()
    startX = e.pageX; startY = e.pageY
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      _dragSelected.clear()
      clearDragHighlight()
    }
    rectEl = document.createElement('div')
    rectEl.className = 'local-selection-rect'
    rectEl.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;z-index:99999;background:var(--accent-soft);border:2px dashed var(--accent-line);pointer-events:none;border-radius:4px`
    document.body.appendChild(rectEl)
  }, true)

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging || !rectEl) return
    const l = Math.min(startX, e.pageX), t = Math.min(startY, e.pageY)
    const r = Math.max(startX, e.pageX), b = Math.max(startY, e.pageY)
    const sx = window.scrollX, sy = window.scrollY
    rectEl.style.cssText = `position:fixed;left:${l - sx}px;top:${t - sy}px;width:${r - l}px;height:${b - t}px;z-index:99999;background:var(--accent-soft);border:2px dashed var(--accent-line);pointer-events:none;border-radius:4px`
    if (r - l > 5 || b - t > 5) {
      const inRect = new Set<string>()
      document.querySelectorAll('#localFileList .local-list-item').forEach(el => {
        const cr = el.getBoundingClientRect()
        const cardL = cr.left + sx, cardT = cr.top + sy
        const cardR = cr.right + sx, cardB = cr.bottom + sy
        if (l < cardR && r > cardL && t < cardB && b > cardT) {
          const nm = (el as HTMLElement).dataset.name
          if (nm) inRect.add(nm)
        }
      })
      _dragSelected = inRect
      clearDragHighlight()
      document.querySelectorAll('#localFileList .local-list-item').forEach(el => {
        const nm = (el as HTMLElement).dataset.name
        if (nm && _dragSelected.has(nm)) (el as HTMLElement).classList.add('local-drag-selected')
      })
    }
  })

  document.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    if (_dragSelected.size > 0) {
      _justBoxed = true
      showToast(t('lora.local.dragSelected', { count: _dragSelected.size }))
    }
  })

  // 拖拽中途失焦（切屏/alt-tab/切标签页）或鼠标离开页面 → mouseup 不会派发，
  // 必须手动取消拖拽并清理残留选框，否则虚线框会永久滞留页面。
  const cancelDrag = () => {
    if (!isDragging) return
    isDragging = false
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    _dragSelected.clear()
    clearDragHighlight()
  }
  window.addEventListener('blur', cancelDrag)
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelDrag() })
  document.addEventListener('mouseleave', cancelDrag)

  // capture 阶段拦截：框选结束后的 click 不应触发"选中详情"
  document.addEventListener('click', (e: MouseEvent) => {
    if (_justBoxed) {
      e.preventDefault()
      e.stopPropagation()
      _justBoxed = false
      return
    }
    const t = e.target as HTMLElement
    if (!t.closest('.local-drag-selected')) {
      _dragSelected.clear()
      clearDragHighlight()
    }
  }, true)
}


export async function initLocalManager() {
  if (_initDone) return
  ensureLocalManagerLayout()
  initializeTriggerOverrideSync()
  const store = useLocalModelStore.getState()
  store.loadFromCache()
  store.rebuildTagFreq()
  if (isLocalManagerActive()) renderLocalView()
  bindLocalEvents()
  if (!_scanProgressUnsubscribe) _scanProgressUnsubscribe = localScanSession.subscribe(renderScanProgress)
  if (!_localStoreUnsubscribe) {
    _localStoreUnsubscribe = useLocalModelStore.subscribe((state, previous) => {
      if (state.files !== previous.files || state.scanStatus !== previous.scanStatus || state.scanningDir !== previous.scanningDir) {
        // 扫描/匹配风暴期间 store 每个文件都变一次 → 节流合并，别每次全量重建 DOM
        scheduleRenderLocalView()
      }
    })
  }
  _initDone = true
  if (!_outputStoreUnsubscribe) _outputStoreUnsubscribe = useOutputStore.subscribe((state, previous) => {
    if (state.files !== previous.files || state.summaryVersion !== previous.summaryVersion || state.metadataVersion !== previous.metadataVersion) scheduleRenderLocalView()
  })
  // 自定义预览图独立于扫描缓存保存，启动时异步恢复，避免大图阻塞首次打开。
  loadLocalLoraPreviews().then(previewImages => {
    useLocalModelStore.setState({ previewImages })
    if (isLocalManagerActive()) {
      renderSidebarList(useLocalModelStore.getState())
      renderDetail(useLocalModelStore.getState())
    }
  })
  // 与节点 /anima/meta 双向分类同步：启动时拉取后端分类合并到本地（无变化不重渲染）
  useLocalModelStore.getState().loadBackendMeta().then((changed) => {
    if (changed && isLocalManagerActive()) renderSidebarList(useLocalModelStore.getState())
  })
  // The saved initial tab is activated before this module is initialized. Catch up once ready.
  if (isLocalManagerActive()) void activateLocalManager().catch(() => showToast(t('lora.local.autoScanFailed')))
}

/** 激活流程并发守卫：快速反复切页时，上一次激活流程没走完就不再叠加 */
let _activateBusy = false
/** 自动扫描（增量检测/后端扫描）节流：5 分钟内只自动跑一次；手动「扫描」按钮不受限 */
const AUTO_SCAN_THROTTLE_MS = 5 * 60 * 1000
let _lastAutoScanAt = 0

export async function activateLocalManager() {
  if (!_initDone) return
  if (_activateBusy) return
  _activateBusy = true
  try {
    await activateLocalManagerInner()
    // 全库元数据补齐（关联出图统计用）：内部再延迟 1.2s，幂等
    scheduleMetadataIndexKick()
  } finally {
    _activateBusy = false
  }
}

async function activateLocalManagerInner() {
  // 拉取后端分类快照。⚠️ 不用 force=true：强制模式绕过 60s 节流，导致每次切到本页
  // 都做一次后端 fetch + 全量 renderLocalView（快速切页时的无谓开销）。
  // 非强制模式自带 60s 节流 —— TK 节点刚改的分类最迟 1 分钟内出现，需要立刻刷新
  // 可用工具箱里的「扫描/刷新」按钮。⚠️ 无变化时不重渲染（changed 才渲染）。
  useLocalModelStore.getState().loadBackendMeta().then((changed) => {
    if (changed) scheduleRenderLocalView()
  })
  const store = useLocalModelStore.getState()
  if (store.scanStatus === 'scanning' || store.scanStatus === 'matching') return
  // ⚠️ 自动扫描统一节流（2026-09-10 二次修复）：此前只在「句柄失效」分支判节流，
  // 「首次使用」分支（files=0）漏判 —— 扫描进行中 files 仍为 0，快速切页每次激活
  // 都重新 scanIncremental（CDP 实测 10 次往返产生 59 个后端扫描请求）。
  if (Date.now() - _lastAutoScanAt < AUTO_SCAN_THROTTLE_MS) return
  _lastAutoScanAt = Date.now() // Reserve this eligible scan once; do not test this timestamp again.
  const hasCache = store.files.length > 0
  if (hasCache) {
    const restored = Boolean(store.dirHandle) || await store.loadDirHandle()
    if (restored) {
      const newCount = await store.detectNewFiles()
      _lastAutoScanAt = Date.now()
      if (newCount > 0) {
        // 自动增量扫描：用户痛点——新下载的 LoRA 必须手动重选目录扫描才会出现。
        // 有已授权句柄时直接后台扫描 + 自动匹配，免弹窗。
        store.setNewFileCount(newCount)
        showToast(t('lora.local.autoScanning', { count: newCount }))
        await store.scanIncremental()
        if (isLocalManagerActive()) renderLocalView()
      } else {
        showToast(t('lora.local.sessionRestored'))
      }
    } else {
      // 句柄已失效（页面刷新后的常态）：静默回退后端扫描，全程无需交互、不弹任何对话框。
      // ⚠️ 后端扫描是全目录遍历，反复切页不能反复跑 —— 受 5 分钟节流约束。
      showToast(t('lora.local.cacheRestored'))
      await store.scanIncremental()
      if (isLocalManagerActive()) renderLocalView()
    }
  } else {
    // 首次使用（无缓存）：静默扫一次（预设路径 → 上次路径 → ComfyUI loras 目录）
    await store.scanIncremental()
    if (isLocalManagerActive()) renderLocalView()
  }
}

function $$(s: string): HTMLElement | null {
  return document.getElementById(s)
}

function localPreviewSources(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string[] {
  const custom = state.previewImages[f.name]
  const remote = (f.matchData?.images || []).filter(Boolean)
  return custom ? [custom, ...remote] : remote
}

function localPreviewSrc(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>, width: number): string {
  const custom = state.previewImages[f.name]
  return custom || (f.matchData?.images?.[0] ? thumbUrl(f.matchData.images[0], width) : '')
}

function localPreviewImg(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>, className: string, width: number): string {
  const src = localPreviewSrc(f, state, width)
  return src
    ? `<img src="${escAttr(src)}" data-cache-key="lora:${escAttr(f.name)}" data-file-version="${escAttr(src)}" class="${className}" loading="lazy" alt="${escAttr(f.matchData?.modelName || f.name)}" onerror="this.style.display='none'" onload="this.style.display='block'">`
    : ''
}

function renderListFileItem(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string {
  const isSel = f.name === state.selectedModel
  const isBatchSelected = state.batchSelection.includes(f.name)
  const thumb = localPreviewImg(f, state, 'local-list-thumb', 120) || '<div class="local-list-thumb local-list-thumb-placeholder"></div>'
  const label = f.matchData?.modelName || f.name
  const localSuffix = f.matchData?.modelName ? `<span class="local-list-localname">${esc(f.name.replace(/\.\w+$/, ''))}</span>` : ''
  const categories = state.modelCategories[stripExt(f.name)] || []
  // 底模走统一口径（C 站优先、其次本地元数据），否则未上传 C 站的自训 LoRA 在这里没有底模
  const listBaseModel = resolveFileBaseModel(f.matchData?.baseModel, f.localBaseModel)
  const metaParts = [f.matchData?.versionName, listBaseModel, ...categories].filter(Boolean)
  const query = state.searchQuery || ''
  const chk = state.batchMode
    ? `<input type="checkbox" class="local-list-chk" data-name="${escAttr(f.name)}" ${state.batchSelection.includes(f.name) ? 'checked' : ''}>`
    : ''
  return `<div class="local-list-item ${isSel ? 'active' : ''} ${isBatchSelected ? 'batch-selected' : ''}" data-name="${escAttr(f.name)}" draggable="true">
    ${chk}
    ${thumb}
    <div class="local-list-info">
      <div class="local-list-name" title="${escAttr(f.name)}">${localStatusDot(f)}${highlightText(label, query)}${localSuffix}</div>
      ${metaParts.length ? `<div class="local-list-meta">${metaParts.map(part => `<span>${highlightText(String(part), query)}</span>`).join('')}</div>` : ''}
    </div>
  </div>`
}

function localStatusDot(f: LocalLoraFile): string {
  const status = f.scanning ? 'scanning' : f.matched ? 'matched' : 'unmatched'
  const label = f.scanning ? t('lora.local.matching') : f.matched ? t('lora.local.matched') : f.matchError ? t('lora.local.matchFailed') : t('lora.local.notMatched')
  return `<span class="local-grid-status-dot ${status}" title="${label}" role="img" aria-label="${label}"></span>`
}

function localModelUrl(f: LocalLoraFile): string | null {
  const d = f.matchData
  if (!d?.modelId) return null
  const version = d.versionId ? `?modelVersionId=${encodeURIComponent(String(d.versionId))}` : ''
  return `https://civitai.com/models/${encodeURIComponent(String(d.modelId))}${version}`
}

function renderGridFileItem(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string {
  const isSel = f.name === state.selectedModel
  const isBatchSelected = state.batchSelection.includes(f.name)
  const custom = !!state.previewImages[f.name]
  const query = state.searchQuery || ''
  const label = f.matchData?.modelName || f.name.replace(/\.\w+$/, '')
  const localName = f.matchData?.modelName ? f.name.replace(/\.\w+$/, '') : ''
  const categories = (state.modelCategories[stripExt(f.name)] || []).slice(0, 2)
  const image = localPreviewImg(f, state, 'local-grid-preview-img', 240) // 卡片实际显示 ~180px，240 覆盖 2x DPI；480 是解码内存浪费
  const preview = image
    ? `<div class="local-grid-preview">${image}${custom ? `<span class="local-grid-custom">${t('lora.custom')}</span>` : ''}</div>`
    : `<div class="local-grid-preview local-grid-preview-empty"><span>${icon('package', 30)}</span><small>${t('lora.noPreview')}</small></div>`
  const chk = state.batchMode
    ? `<input type="checkbox" class="local-list-chk local-grid-check" data-name="${escAttr(f.name)}" ${state.batchSelection.includes(f.name) ? 'checked' : ''}>`
    : ''
  // 底模走统一口径：C 站匹配值优先，未匹配时退回本地 safetensors 元数据识别值
  const civitaiBaseModel = f.matchData?.baseModel || ''
  const baseModel = resolveFileBaseModel(civitaiBaseModel, f.localBaseModel)
  const localOnlyBaseModel = !civitaiBaseModel && !!baseModel
  // 本地来源的底模在 title 里给出头部原值，便于排查（如 moss_image / KREA2 大小写差异）
  const baseModelTitle = localOnlyBaseModel
    ? t('lora.baseModel.localTooltip', { raw: f.localBaseModelRaw ? ` (ss_base_model_version=${f.localBaseModelRaw})` : '' })
    : t('lora.baseModel')
  const versionName = f.matchData?.versionName || ''
  return `<div class="local-list-item local-grid-card ${isSel ? 'active' : ''} ${isBatchSelected ? 'batch-selected' : ''}" data-name="${escAttr(f.name)}" draggable="true" tabindex="0" role="group" aria-label="${escAttr(label)}" aria-haspopup="menu" title="${t('lora.local.contextHint')}">
    ${preview}
    ${chk}
    <div class="local-grid-overlay">
      ${localStatusDot(f)}
    </div>
    <div class="local-grid-body">
      <div class="local-grid-name" title="${escAttr(label)}">${highlightText(label, query)}</div>
      ${localName ? `<div class="local-grid-localname" title="${escAttr(localName)}">${esc(localName)}</div>` : ''}
      ${(versionName || baseModel || categories.length) ? `<div class="local-grid-meta">
        ${versionName ? `<span class="local-grid-version" title="${t('lora.version')}">${esc(versionName)}</span>` : ''}
        ${baseModel ? `<span class="local-grid-base ${localOnlyBaseModel ? 'local-base-only' : ''}" title="${escAttr(baseModelTitle)}">${esc(baseModel)}</span>` : ''}
        ${categories.length ? `<span class="local-grid-tags" title="${t('lora.category.label')}">${categories.map(category => `<span>${esc(category)}</span>`).join('')}</span>` : ''}
      </div>` : ''}
    </div>
  </div>`
}

/**
 * Local 页的「本地 LoRA ↔ 出图关联」需要**全库**元数据视野（见下方两处遍历 metadataCache 的地方）。
 * 元数据已改为按需加载（不再进页面全量预载），所以这里做一次性的按需补齐：
 * 补齐完成后重渲染一次 Local 视图；_localIndexKick 保证不会反复触发。
 *
 * ⚠️ 2026-09-10 性能修复：kick 延迟到激活后 1.2s（让首帧与第一波交互先走），
 * 且完成回调走节流渲染 —— 全库补齐（真实环境数千条，分片 bulkGet）期间用户已经在
 * 操作页面，不能让补齐结束的全量重渲染插入到用户交互中间。
 */
let _localIndexKick = false
let _localKickTimer: ReturnType<typeof setTimeout> | null = null
function scheduleMetadataIndexKick(): void {
  if (_localIndexKick || _localKickTimer !== null) return
  _localKickTimer = setTimeout(() => {
    _localKickTimer = null
    kickMetadataIndexForLocal()
  }, 1200)
}
function kickMetadataIndexForLocal(): void {
  if (_localIndexKick) return
  _localIndexKick = true
  void ensureAllMetadata().then(() => {
    // 只有真的读了新数据才需要重渲染（ensureAllMetadata 在无缺失时立即 resolve，不会死循环）
    if (isMetadataIndexComplete()) scheduleRenderLocalView()
  })
}

// Keep generated content, not array references: scans may emit equivalent arrays.
const _localRenderedHtml = new WeakMap<HTMLElement, string>()
function setLocalHtml(el: HTMLElement, html: string): boolean {
  if (_localRenderedHtml.get(el) === html) return false
  _localImageNodes.capture(el)
  el.innerHTML = html
  _localImageNodes.restore(el)
  _localRenderedHtml.set(el, html)
  return true
}

function setDetailHtml(el: HTMLElement, html: string): boolean {
  const active = document.activeElement as HTMLTextAreaElement | null
  const restoreDraftFocus = Boolean(active && active.classList?.contains('local-trigger-draft') && el.contains(active))
  const selectionStart = restoreDraftFocus ? active!.selectionStart : null
  const selectionEnd = restoreDraftFocus ? active!.selectionEnd : null
  const changed = setLocalHtml(el, html)
  if (changed && restoreDraftFocus) {
    const replacement = el.querySelector('.local-trigger-draft') as HTMLTextAreaElement | null
    if (replacement) {
      replacement.focus()
      if (selectionStart !== null && selectionEnd !== null) replacement.setSelectionRange(selectionStart, selectionEnd)
    }
  }
  return changed
}

export function renderLocalView() {
  if (_renderTimer !== null) {
    clearTimeout(_renderTimer)
    _renderTimer = null
  }
  const state = useLocalModelStore.getState()
  renderSidebarList(state)
  updateStats(state)
  switch (state.currentView || 'home') {
    case 'home': break
    case 'detail': renderDetail(state); break
    case 'gallery':
      renderGallery(state)
      renderTagFreq(state.tagFreq)
      break
    case 'models': void renderModelsTab(); break
  }
  if (_detailDrawerOpen && state.currentView !== 'detail' && state.selectedModel) renderDetail(state)
  if (!_detailDrawerOpen && state.currentView !== 'detail') setActiveTriggerName(null)
  syncCategorySlotVisibility()
}

function renderFileItem(f: LocalLoraFile, state: ReturnType<typeof useLocalModelStore.getState>): string {
  return state.displayMode === 'grid' ? renderGridFileItem(f, state) : renderListFileItem(f, state)
}

function applyLocalDisplayMode(state: ReturnType<typeof useLocalModelStore.getState>) {
  const split = document.querySelector('.local-split')
  const container = document.querySelector('.local-container')
  split?.classList.toggle('local-display-grid', state.displayMode === 'grid')
  container?.classList.toggle('local-container-grid', state.displayMode === 'grid')
  const listBtn = $$('localListViewBtn')
  const gridBtn = $$('localGridViewBtn')
  for (const [button, active] of [[listBtn, state.displayMode === 'list'], [gridBtn, state.displayMode === 'grid']] as const) {
    if (!button) continue
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }
}

function renderGridCategoryRail(state: ReturnType<typeof useLocalModelStore.getState>, files: LocalLoraFile[]): string {
  const entries = localCategoryEntries(files.map(file => stripExt(file.name)), state.categories, state.modelCategories || {})
  const quick = document.getElementById('localCategoryQuickFilters')
  if (quick) {
    const signature = JSON.stringify([entries, state.filterCategory])
    if (quick.dataset.signature !== signature) {
      const scroll = quick.scrollLeft
      quick.innerHTML = entries.map(entry => `<button type="button" class="local-grid-cat-btn ${state.filterCategory === (entry.value || null) ? 'active' : ''}" data-cat="${escAttr(entry.value)}" aria-pressed="${state.filterCategory === (entry.value || null)}"><span>${esc(localCategoryLabel(entry.value, entry.label))}</span><small>${entry.count}</small></button>`).join('')
      quick.dataset.signature = signature; quick.scrollLeft = scroll
    }
  }
  const row = (cat: string | null, label: string, count: number, editable = false) => `<div class="local-grid-category-row">
    <button class="local-grid-cat-btn ${state.filterCategory === cat ? 'active' : ''}" data-cat="${escAttr(cat || '')}" type="button">
      <span class="local-grid-cat-label">${icon(cat === null ? 'grid' : 'folder', 12)}${esc(label)}</span><span class="local-grid-cat-count">${count}</span>
    </button>
    ${editable ? `<button class="local-cat-rename-btn local-grid-cat-action" data-cat="${escAttr(label)}" title="${t('lora.rename')}">${icon('edit3', 11)}</button><button class="local-cat-del-btn local-grid-cat-action" data-cat="${escAttr(label)}" title="${t('lora.category.delete')}">${icon('x', 11)}</button>` : ''}
  </div>`
  return `<div class="local-grid-category-heading"><span>${t('lora.category.label')}</span><span class="local-grid-category-total">${files.length}</span></div>
    ${entries.map(entry => row(entry.value || null, localCategoryLabel(entry.value, entry.label), entry.count, entry.editable)).join('')}
    <button class="btn btn-ghost btn-sm local-new-cat-btn local-grid-new-category" type="button">${icon('plus', 12)} ${t('lora.category.create')}</button>`
}

/**
 * 「未匹配」筛选项的哨兵值：底模既无 C 站匹配值、也无本地元数据识别值
 * （面板计数与下方主过滤共用这一常量，避免两处字符串写歪导致计数与结果不一致）
 */
const BM_UNMATCHED = '__unmatched__'

/**
 * 「按底模」展开面板（2026-09-11；2026-10-19 合并本地元数据源）：
 * 汇总的底模来自**统一口径** resolveFileBaseModel —— C 站匹配值优先（更精确，能区分 MOSS SFT/Base），
 * 其次本地 safetensors 头部 ss_base_model_version 识别的值。
 * 这样未上传 C 站的自训 LoRA（本机 26 个 moss_image）也有底模标签、也能被筛出来；
 * 「未匹配」现在只装「两种来源都没有」的文件。点击过滤、再点取消；网格/列表两种视图都渲染。
 * 计数来源 = 搜索 + 匹配状态筛选后的集合（不受底模/分类筛选影响，各底模分布稳定可点选）。
 */
function renderBaseModelPanel(state: ReturnType<typeof useLocalModelStore.getState>, files: LocalLoraFile[]): string {
  const counts = new Map<string, number>()
  let unmatched = 0
  for (const f of files) {
    const bm = resolveFileBaseModel(f.matchData?.baseModel, f.localBaseModel)
    if (bm) counts.set(bm, (counts.get(bm) || 0) + 1)
    else unmatched++
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const row = (value: string, label: string, count: number, iconKey: string) =>
    `<button class="local-bm-btn ${state.filterBaseModel === value ? 'active' : ''}" data-bm="${escAttr(value)}" type="button">
      <span class="local-grid-cat-label">${icon(iconKey, 12)}${esc(label)}</span><span class="local-grid-cat-count">${count}</span>
    </button>`
  const list = state.baseModelPanelOpen
    ? `<div class="local-bm-list">
        ${row('', t('lora.baseModel.all'), files.length, 'grid')}
        ${rows.map(([bm, n]) => row(bm, bm, n, 'tag')).join('')}
        ${unmatched > 0 ? row(BM_UNMATCHED, t('lora.local.unmatched'), unmatched, 'alertCircle') : ''}
      </div>`
    : ''
  const activeLabel = state.filterBaseModel === BM_UNMATCHED ? t('lora.local.unmatched') : state.filterBaseModel
  return `<button class="local-bm-toggle ${state.filterBaseModel ? 'has-filter' : ''}" type="button" aria-expanded="${state.baseModelPanelOpen}" title="${t('lora.baseModel.filterTitle')}">
      <span class="local-grid-cat-label">${icon('layers', 12)}${t('lora.baseModel.filter')}${activeLabel ? `：${esc(activeLabel)}` : ''}</span>
      <span class="local-bm-chevron ${state.baseModelPanelOpen ? 'open' : ''}">${icon('chevronDown', 12)}</span>
    </button>${list}`
}

function readPreviewFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
      reject(new Error(t('lora.preview.unsupportedType')))
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      reject(new Error(t('lora.preview.tooLarge')))
      return
    }
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      try {
        const maxSide = 720
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error(t('lora.preview.compressionUnsupported'))
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        const result = canvas.toDataURL('image/webp', 0.82)
        URL.revokeObjectURL(objectUrl)
        resolve(result)
      } catch (error) {
        URL.revokeObjectURL(objectUrl)
        reject(error)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error(t('lora.preview.readFailed')))
    }
    image.src = objectUrl
  })
}

async function setLocalPreview(name: string, image: string): Promise<boolean> {
  const s = useLocalModelStore.getState()
  s.setPreviewImage(name, image)
  if (!await saveLocalLoraPreview(name, image)) {
    s.clearPreviewImage(name)
    showToast(t('lora.preview.saveFailed'))
    return false
  }
  renderSidebarList(useLocalModelStore.getState())
  renderDetail(useLocalModelStore.getState())
  showToast(t('lora.preview.updated'))
  return true
}

function openLocalPreviewPicker(name: string) {
  document.getElementById('localPreviewModal')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'localPreviewModal'
  overlay.className = 'modal-overlay open local-preview-modal-overlay'
  overlay.innerHTML = `<section class="modal-box local-preview-modal-box" role="dialog" aria-modal="true" aria-labelledby="localPreviewModalTitle">
    <div class="local-preview-modal-head">
      <h3 id="localPreviewModalTitle">${t('lora.preview.setTitle')}</h3>
      <button type="button" class="local-preview-modal-close" data-local-preview-close aria-label="${t('lora.close')}">${icon('x', 15)}</button>
    </div>
    <p class="sub">${t('lora.preview.description', { name: esc(name) })}</p>
    <div class="local-preview-dropzone" id="localPreviewDropzone" tabindex="0" role="button" aria-label="${t('lora.preview.dropAria')}">
      <div class="local-preview-dropzone-icon">${icon('image', 28)}</div>
      <strong>${t('lora.preview.drop')}</strong>
      <span>${t('lora.preview.formats')}</span>
      <button type="button" class="btn btn-primary btn-sm" id="localPreviewFileBtn">${t('lora.chooseFile')}</button>
      <input type="file" id="localPreviewFileInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
    </div>
    <div class="modal-actions local-preview-modal-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-local-preview-close>${t('lora.cancel')}</button>
    </div>
  </section>`
  document.body.appendChild(overlay)

  const dropzone = overlay.querySelector('#localPreviewDropzone') as HTMLElement
  const input = overlay.querySelector('#localPreviewFileInput') as HTMLInputElement
  const fileBtn = overlay.querySelector('#localPreviewFileBtn') as HTMLButtonElement
  let busy = false

  const close = () => {
    document.removeEventListener('keydown', onKeydown)
    overlay.remove()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close()
  }
  const processFile = async (file?: File) => {
    if (!file || busy) return
    busy = true
    dropzone.classList.add('is-processing')
    try {
      const saved = await setLocalPreview(name, await readPreviewFile(file))
      if (saved) close()
    } catch (error) {
      showToast(`⚠️ ${error instanceof Error ? error.message : t('lora.preview.readFailed')}`)
    } finally {
      busy = false
      dropzone.classList.remove('is-processing')
    }
  }

  overlay.addEventListener('click', event => {
    if (event.target === overlay || (event.target as HTMLElement).closest('[data-local-preview-close]')) close()
  })
  fileBtn.addEventListener('click', event => {
    event.stopPropagation()
    input.click()
  })
  input.addEventListener('change', () => processFile(input.files?.[0]))
  dropzone.addEventListener('click', event => {
    if (event.target === dropzone) input.click()
  })
  dropzone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      input.click()
    }
  })
  dropzone.addEventListener('dragover', event => {
    event.preventDefault()
    if (!busy) dropzone.classList.add('drag-over')
  })
  dropzone.addEventListener('dragleave', event => {
    if (event.target === dropzone) dropzone.classList.remove('drag-over')
  })
  dropzone.addEventListener('drop', event => {
    event.preventDefault()
    dropzone.classList.remove('drag-over')
    processFile(event.dataTransfer?.files?.[0])
  })
  document.addEventListener('keydown', onKeydown)
  dropzone.focus()
}

async function setLocalPreviewFromUrl(name: string) {
  const current = useLocalModelStore.getState().previewImages[name]
  const url = await promptModal(t('lora.preview.urlTitle'), current?.startsWith('http') ? current : '', t('lora.preview.urlHint'))
  if (url === null) return
  const normalized = url.trim()
  if (!/^https?:\/\//i.test(normalized)) {
    showToast(t('lora.preview.invalidUrl'))
    return
  }
  await setLocalPreview(name, normalized)
}

async function resetLocalPreview(name: string) {
  const s = useLocalModelStore.getState()
  s.clearPreviewImage(name)
  await deleteLocalLoraPreview(name)
  renderSidebarList(useLocalModelStore.getState())
  renderDetail(useLocalModelStore.getState())
  showToast(t('lora.preview.restored'))
}

function renderSidebarList(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('localFileList')
  if (!el) return
  // 分类/批量操作会全量重建列表 DOM；图片异步加载期间高度塌陷会把 scrollTop 钳到 0，
  // 打断"连续右键分类"的浏览位置 → 重建前记录、重建后立即+rAF 各恢复一次。
  const keepScroll = el.scrollTop
  const restoreScroll = () => { el.scrollTop = keepScroll }
  applyLocalDisplayMode(state)

  let files = [...state.files]

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase()
    files = files.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.matchData?.modelName || '').toLowerCase().includes(q) ||
      (f.matchData?.creator || '').toLowerCase().includes(q)
    )
  }
  if (state.filterKey === 'matched') files = files.filter(f => f.matched)
  if (state.filterKey === 'unmatched') files = files.filter(f => !f.matched && !f.scanning)

  // ── 「按底模」面板 + 过滤（2026-09-11；2026-10-19 合并本地元数据源）：网格/列表都渲染，与分类筛选叠加 ──
  const baseModelSourceFiles = [...files]
  const bmPanel = $$('localBaseModelPanel')
  if (bmPanel) setLocalHtml(bmPanel, renderBaseModelPanel(state, baseModelSourceFiles))
  if (state.filterBaseModel) {
    // 与面板计数同一口径：C 站匹配值优先，其次本地 safetensors 元数据识别的底模
    const bmGroupKey = baseModelKey(state.filterBaseModel)
    files = files.filter(f => {
      const resolved = resolveFileBaseModel(f.matchData?.baseModel, f.localBaseModel)
      if (state.filterBaseModel === BM_UNMATCHED) return !resolved
      return !!resolved && baseModelKey(resolved) === bmGroupKey
    })
  }

  const categorySourceFiles = [...files]
  const categoryList = $$('localGridCategoryList')
  if (categoryList) setLocalHtml(categoryList, renderGridCategoryRail(state, categorySourceFiles))
  if (state.displayMode === 'grid') {
    if (state.filterCategory) {
      files = files.filter(f => {
        const assigned = state.modelCategories[stripExt(f.name)] || []
        return state.filterCategory === '__uncategorized__' ? assigned.length === 0 : assigned.includes(state.filterCategory as string)
      })
    }
  } else {
    if (state.filterCategory) {
      files = files.filter(f => {
        const assigned = state.modelCategories[stripExt(f.name)] || []
        return state.filterCategory === '__uncategorized__' ? assigned.length === 0 : assigned.includes(state.filterCategory as string)
      })
    }
  }

  switch (state.sortKey) {
    case 'name': files.sort((a, b) => a.name.localeCompare(b.name)); break
    case 'size': files.sort((a, b) => b.size - a.size); break
    case 'date': files.sort((a, b) => b.lastModified - a.lastModified); break
    case 'match': files.sort((a, b) => (a.matched === b.matched ? 0 : a.matched ? -1 : 1)); break
  }

  if (files.length === 0) {
    disconnectGridObserver()
    setLocalHtml(el, '<div class="empty-state empty-state-wide"><div class="big">' + icon('mailOpen', 28) + `</div><p class="empty-state-text">${t('lora.noMatchingFiles')}</p></div>`)
    updateBatchBar(state)
    return
  }

  if (state.displayMode === 'grid') {
    renderGridChunked(el, files, state)
    return
  }

  const cats = state.categories
  const exp = state.expandedCategories || []
  const mc = state.modelCategories || {}

  // 一次遍历按分类分组(O(n)),替代每分类 filter 的 O(cats×files)
  const byCat: Record<string, LocalLoraFile[]> = {}
  const uncat: LocalLoraFile[] = []
  const categorized = new Set<string>()
  for (const f of files) {
    const assigned = mc[stripExt(f.name)] || []
    if (assigned.length === 0) {
      uncat.push(f)
    } else {
      for (const c of assigned) {
        ;(byCat[c] ||= []).push(f)
        categorized.add(f.name)
      }
    }
  }

  let html = '<div class="local-tree-list">'

  for (const cat of cats) {
    const catFiles = byCat[cat] || []
    if (catFiles.length === 0 && state.searchQuery) continue
    const isExpanded = exp.includes(cat)
    html += `<div class="local-tree-cat" data-cat="${escAttr(cat)}">
      <div class="local-tree-cat-header" data-cat="${escAttr(cat)}">
        <span class="local-tree-cat-arrow ${isExpanded ? 'expanded' : ''}">▶</span>
        <span class="local-tree-cat-name">${esc(cat)}</span>
        <span class="local-tree-cat-count">${catFiles.length}</span>
        <button class="local-cat-rename-btn" data-cat="${escAttr(cat)}" title="${t('lora.rename')}">${icon('edit3', 12)}</button>
        <button class="local-cat-del-btn" data-cat="${escAttr(cat)}" title="${t('lora.category.delete')}">${icon('x', 12)}</button>
        <button class="local-new-cat-btn" title="${t('lora.category.create')}">${icon('plus', 12)}</button>
      </div>
      <div class="local-tree-cat-items ${isExpanded ? '' : 'collapsed'}">
        ${isExpanded ? catFiles.map(f => renderFileItem(f, state)).join('') : ''}
      </div>
    </div>`
  }

  const uncatFiles = uncat.filter(f => !categorized.has(f.name))
  if (uncatFiles.length > 0 || !state.searchQuery) {
    const isExpanded = exp.includes('__uncategorized__')
    html += `<div class="local-tree-cat" data-cat="__uncategorized__">
      <div class="local-tree-cat-header" data-cat="__uncategorized__">
        <span class="local-tree-cat-arrow ${isExpanded ? 'expanded' : ''}">▶</span>
        <span class="local-tree-cat-name">${t('lora.category.uncategorized')}</span>
        <span class="local-tree-cat-count">${uncatFiles.length}</span>
      </div>
      <div class="local-tree-cat-items ${isExpanded ? '' : 'collapsed'}">
        ${isExpanded ? uncatFiles.map(f => renderFileItem(f, state)).join('') : ''}
      </div>
    </div>`
  }

  html += '</div>'
  if (setLocalHtml(el, html)) {
    disconnectGridObserver()
    restoreScroll()
    requestAnimationFrame(restoreScroll)
  }
  updateBatchBar(state)
}

function updateBatchBar(state: ReturnType<typeof useLocalModelStore.getState>) {
  const bar = $$('localBatchBar')
  const count = $$('localBatchCount')
  if (!bar || !count) return
  count.textContent = t('lora.local.selectedCount', { count: state.batchSelection.length })
  if (!state.batchMode || state.batchSelection.length === 0) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'flex'
}

// ── grid 分片渲染（2026-09-10 性能修复，CDP 实测依据）──
// 此前 grid 模式一次性 innerHTML 渲染全部卡片：1200 个 LoRA = 3.2 万 DOM 节点 +
// 960 张图片，单次主线程阻塞 ~500ms（探针实测 521/479ms），且每次切页/搜索/
// 匹配风暴都重复付出。改为「首片 150 + 底部 sentinel 无限追加」：首帧成本约 1/8，
// 滚动到底自动补齐，内容与全量渲染一致。
const LOCAL_GRID_CHUNK = 150
let _gridObserver: IntersectionObserver | null = null
let _gridRenderEpoch = 0

function disconnectGridObserver(): void {
  _gridRenderEpoch++
  if (_gridObserver) { _gridObserver.disconnect(); _gridObserver = null }
}

function renderGridChunked(el: HTMLElement, files: LocalLoraFile[], state: ReturnType<typeof useLocalModelStore.getState>): void {
  const cards = files.map(f => renderGridFileItem(f, state))
  const signature = 'grid:' + cards.join('')
  if (_localRenderedHtml.get(el) === signature) {
    updateBatchBar(state)
    return
  }
  disconnectGridObserver()
  const renderEpoch = _gridRenderEpoch
  _localRenderedHtml.set(el, signature)

  // 恢复滚动位置：只渲染首片时内容高度可能低于原 scrollTop（被浏览器钳到 0 → 丢失浏览位置），
  // 按容器宽度估列数、每卡 ~340px 估算需要预渲染到原位置的卡数，再恢复 scrollTop。
  const keepScroll = el.scrollTop
  const estCols = Math.max(1, Math.round(el.clientWidth / 192)) // 卡宽 180 + gap 12
  const minCards = Math.min(files.length, Math.ceil((Math.ceil(keepScroll / 340) + 2) * estCols))
  let rendered = Math.max(LOCAL_GRID_CHUNK, minCards)

  // 追加下一片并按需重挂 sentinel；数据已变（files 引用不同）则放弃 —— subscribe 会触发整体重渲染
  const mountSentinel = () => {
    const listEl = el.querySelector('.local-grid-card-list')
    if (!listEl) return
    const s = document.createElement('div')
    s.className = 'local-grid-sentinel'
    s.style.cssText = 'grid-column:1/-1;height:1px'
    listEl.appendChild(s)
    _gridObserver = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return
      const obs = _gridObserver
      if (obs) { obs.disconnect(); _gridObserver = null }
      if (_gridRenderEpoch !== renderEpoch) return
      listEl.querySelector('.local-grid-sentinel')?.remove()
      const to = Math.min(files.length, rendered + LOCAL_GRID_CHUNK)
      const frag = document.createElement('template')
      frag.innerHTML = cards.slice(rendered, to).join('')
      listEl.appendChild(frag.content)
      _localImageNodes.restore(listEl as HTMLElement)
      rendered = to
      if (rendered < files.length) mountSentinel()
    }, { root: el, rootMargin: '600px 0px' })
    _gridObserver.observe(s)
  }

  _localImageNodes.capture(el)
  el.innerHTML = `<div class="local-grid-card-list">${cards.slice(0, rendered).join('')}</div>`
  _localImageNodes.restore(el)
  if (rendered < files.length) mountSentinel()
  el.scrollTop = keepScroll
  requestAnimationFrame(() => { el.scrollTop = keepScroll })
  updateBatchBar(state)
}

// ── 模型管理 tab（checkpoint/VAE/embedding/controlnet 等）──
let _modelsLoaded = false
async function renderModelsTab() {
  const el = $$('localModelsContent')
  if (!el) return
  // 已加载过：列表 DOM 保留在页面上（tab 切换只改 display），无需重复 fetch
  if (_modelsLoaded) return
  el.innerHTML = `<div class="empty-state"><div class="big">⏳</div><p>${t('lora.local.loadingModels')}</p></div>`
  try {
    const resp = await fetch('/anima/models')
    if (!resp.ok) throw new Error(`http ${resp.status}`)
    const data = await resp.json()
    _modelsLoaded = true
    const groups = (data.groups || []) as { type: string; label: string; items: any[]; count: number }[]
    const fmtSize = (b: number) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB'
    const fmtDate = (m: number) => m ? new Date(m * 1000).toLocaleDateString('zh-CN') : '-'
    const total = data.total || 0

    if (total === 0) {
      el.innerHTML = `<div class="empty-state"><div class="big">${icon('package', 28)}</div><p>${t('lora.local.noModelFiles')}</p><p class="sub">${t('lora.local.modelLocation')}</p></div>`
      return
    }

    el.innerHTML = `
      <div class="local-models-toolbar">
        <span style="font-size:12px;color:var(--text2)">${t('lora.local.modelCount', { count: '<strong style="color:var(--text)">' + total + '</strong>' })}</span>
        <span style="font-size:11px;color:var(--text3)">${t('lora.local.copyModelHint')}</span>
      </div>
      ${groups.filter(g => g.count > 0).map(g => `
        <div class="local-models-group">
          <div class="local-models-group-header">
            ${icon('folder', 13)} <span>${esc(g.label)}</span>
            <span class="local-models-count">${g.count}</span>
          </div>
          <div class="local-models-list">
            ${g.items.map(it => `
              <div class="local-models-row" data-name="${escAttr(it.name)}" title="${t('lora.local.copyModelTitle')}">
                <span class="local-models-name">${esc(trunc(it.name, 42))}</span>
                <span class="local-models-meta">${esc(it.ext)} · ${fmtSize(it.size)} · ${fmtDate(it.lastModified)}</span>
              </div>`).join('')}
          </div>
        </div>`).join('')}`
    // 点击复制模型名
    el.querySelectorAll('.local-models-row').forEach(row => {
      row.addEventListener('click', () => {
        const name = (row as HTMLElement).dataset.name || ''
        copyText(name, row as HTMLElement)
      })
    })
  } catch (e: any) {
    el.innerHTML = `<div class="empty-state"><div class="big">${icon('alertCircle', 28)}</div><p>${t('lora.local.loadModelsFailed')}</p><p class="sub">${esc(String(e.message || e))}${t('lora.local.modelsBackendHint')}</p></div>`
  }
}

function renderHome(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('pageLocalHome')
  if (!el) return

  // Stats
  const totalFiles = state.files.length
  const matchedFiles = state.files.filter(f => f.matched).length

  // Analyze outputs for lora usage
  const outputState = useOutputStore.getState()
  const outputTotal = outputState.files.length

  // Also collect which loras are in our local files for cross-ref
  const localLoraNames = new Set(state.files.map(f => f.name.replace(/\.\w+$/, '').toLowerCase()))

  // Track how many outputs reference each local lora
  let outputWithLocalLora = 0

  for (const file of outputState.files) {
    const identity = fileSourceIdentity(file)
    const meta = metadataForFile(outputState.metadataCache, file, identity.root, identity.parserVersion)
    const loras = meta?.loras || outputSummaryForFile(file, outputState.summaryCache)?.loras || []
    if (loras.length === 0) continue

    // Check if any lora is local
    const hasLocal = loras.some(l => localLoraNames.has(l.toLowerCase()))
    if (!hasLocal) continue

    outputWithLocalLora++
  }

  let html = `
    <div class="local-home-summary">
      <div class="local-stat-card"><div class="local-stat-num">${totalFiles}</div><div class="local-stat-label">${t('lora.stats.totalLoras')}</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${matchedFiles}</div><div class="local-stat-label">${t('lora.stats.matched')}</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${outputTotal}</div><div class="local-stat-label">${t('lora.stats.totalOutputs')}</div></div>
      <div class="local-stat-card"><div class="local-stat-num">${outputWithLocalLora}</div><div class="local-stat-label">${t('lora.stats.linkedLoras')}</div></div>
    </div>`

  if (!outputWithLocalLora) {
    html += `<div class="empty-state"><div class="big">${icon('trendingUp', 28)}</div><p>${t('lora.stats.noUsage')}</p></div>`
  }

  setLocalHtml(el, html)
}
/**
 * 详情「文件信息」里的基座模型行。
 * 显示值走统一口径；C 站匹配回来的值带「Civitai」来源标记，
 * 没有 C 站数据但本地 safetensors 头部认出了底模时也照样显示，并把原值放进 title 便于排查。
 */
function detailBaseModelRow(f: LocalLoraFile, d: LocalLoraMatch | null): string {
  const civitaiValue = (d?.baseModel || '').trim()
  const resolved = resolveFileBaseModel(civitaiValue, f.localBaseModel)
  if (!resolved) return ''
  const hint = civitaiValue
    ? t('lora.baseModel.civitaiSource')
    : t('lora.baseModel.localSource', { raw: f.localBaseModelRaw ? ` (ss_base_model_version=${f.localBaseModelRaw})` : '' })
  return `<div class="detail-fi-row">
      <span>${t('lora.baseModel.label')}</span>
      <span class="detail-fi-base">
        <span class="detail-base-badge ${civitaiValue ? 'from-civitai' : 'from-local'}">${civitaiValue ? 'Civitai' : t('lora.local')}</span>
        <span class="detail-base-value" title="${escAttr(`${resolved} · ${hint}`)}">${esc(resolved)}</span>
      </span>
    </div>`
}

function renderDetail(state: ReturnType<typeof useLocalModelStore.getState>) {
  const empty = $$('detailEmpty')
  const content = $$('detailContent')
  if (!empty || !content) return

  if (!state.selectedModel) {
    empty.style.display = ''
    content.style.display = 'none'
    setActiveTriggerName(null)
    const page = $$('pageLocalDetail')
    page?.classList.remove('local-detail-drawer-open')
    page?.setAttribute('aria-hidden', 'true')
    return
  }

  const f = state.files.find(x => x.name === state.selectedModel)
  if (!f) {
    empty.style.display = ''
    content.style.display = 'none'
    setActiveTriggerName(null)
    return
  }

  empty.style.display = 'none'
  content.style.display = 'block'

  const detailPage = $$('pageLocalDetail')
  const isDrawer = state.currentView !== 'detail'
  const drawerOpen = isDrawer && _detailDrawerOpen
  detailPage?.classList.add('local-detail-drawer')
  detailPage?.classList.toggle('local-detail-drawer-open', drawerOpen)
  detailPage?.setAttribute('aria-hidden', String(isDrawer && !drawerOpen))
  const triggerEditor = ensureTriggerEditor(f)
  setActiveTriggerName(drawerOpen || state.currentView === 'detail' ? f.name : null)

  const d = f.matchData
  const previewSources = localPreviewSources(f, state)
  const customPreview = !!state.previewImages[f.name]
  const imgHtml = previewSources[0]
    ? `<img src="${escAttr(customPreview ? previewSources[0] : thumbUrl(previewSources[0], 400))}" class="detail-hero-img" loading="lazy" alt="${escAttr(d?.modelName || f.name)}" onerror="this.style.display='none'">`
    : '<div class="detail-no-img">📦</div>'
  const previewTools = `<div class="detail-preview-tools">
    <button class="btn btn-ghost btn-sm local-preview-upload" data-name="${escAttr(f.name)}">${icon('image', 12)} ${customPreview ? t('lora.preview.replace') : t('lora.preview.custom')}</button>
    <button class="btn btn-ghost btn-sm local-preview-url" data-name="${escAttr(f.name)}">${icon('globe', 12)} ${t('lora.preview.imageUrl')}</button>
    ${customPreview ? `<button class="btn btn-ghost btn-sm local-preview-reset" data-name="${escAttr(f.name)}">${icon('x', 12)} ${t('lora.preview.restoreCivitai')}</button>` : ''}
  </div>`

  const actionBtn = !f.matched && !f.scanning
    ? `<button class="btn btn-ghost detail-match-btn btn-md" data-name="${escAttr(f.name)}">${icon('search', 12)} ${t('lora.match')}</button>`
    : ''

  const trainedWords = renderTriggerEditor(f, triggerEditor)

  const tags = d?.tags?.length
    ? `<div class="detail-section"><h4>${t('lora.modelTags')}</h4><div class="detail-tags">${d.tags.map(t => `<span class="detail-tag" data-copy="${esc(t)}">${esc(t)}</span>`).join('')}</div></div>`
    : ''

  const description = d?.description
    ? `<div class="detail-section"><h4>${t('lora.description')}</h4><p class="detail-desc">${esc(d.description.slice(0, 300))}${d.description.length > 300 ? '…' : ''}</p></div>`
    : ''

  const modelCats = state.modelCategories[stripExt(f.name)] || []
  const catHtml = `<div class="detail-section"><h4>${t('lora.category.label')}</h4>
    <div class="detail-cats" id="detailCats">
      ${modelCats.map(c => `<span class="detail-cat-chip" data-cat="${escAttr(c)}">${esc(c)} <span class="detail-cat-rm" data-name="${escAttr(f.name)}" data-cat="${escAttr(c)}">✕</span></span>`).join('')}
      <div class="detail-cat-add-wrap">
        <button class="btn btn-ghost btn-sm" id="detailCatAddBtn">+ ${t('lora.category.label')}</button>
        <div class="local-catfilter-dropdown detail-cat-dd" id="detailCatDropdown" style="display:none"></div>
      </div>
    </div></div>`

  // LoRA 标签构建器（权重滑块 + 复制）
  const localBase = f.name.replace(/\.\w+$/, '')
  const loraWeight = state.promptWeights?.[f.name] ?? 1.0
  const loraTagHtml = `<div class="detail-section"><h4>🏷️ ${t('lora.local.loraTag')}</h4>
    <div class="detail-lora-builder" data-name="${escAttr(f.name)}">
      <div class="detail-lora-preview" id="loraPreview_${escAttr(f.name)}"><code>&lt;lora:${esc(localBase)}:${loraWeight.toFixed(2)}&gt;</code></div>
      <div class="detail-lora-controls">
        <input type="range" class="detail-lora-slider" min="0" max="2" step="0.05" value="${loraWeight}" data-name="${escAttr(f.name)}">
        <input type="number" class="detail-lora-input" min="0" max="2" step="0.05" value="${loraWeight.toFixed(2)}" data-name="${escAttr(f.name)}" style="width:56px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:12px;text-align:center">
        <button class="btn btn-ghost btn-sm detail-lora-copy" data-tag="${esc(localBase)}" data-w="${loraWeight.toFixed(2)}">${icon('copy', 12)} ${t('lora.copy')}</button>
      </div>
    </div></div>`

  const manualMatchHtml = !f.matched && !f.scanning
    ? `<div class="detail-section"><h4>🔗 ${t('lora.manualMatch')}</h4>
      <div class="detail-manual-match">
        <input type="text" id="manualMatchUrl" placeholder="${t('lora.manualMatchPlaceholder')}" class="input-sm">
        <button class="btn btn-primary btn-sm" id="manualMatchBtn" data-name="${escAttr(f.name)}">${t('lora.confirm')}</button>
      </div></div>`
    : ''

  const descText = state.descriptions[f.name] || ''
  const descHtml = `<div class="detail-section"><h4>📝 ${t('lora.notes')}</h4>
    <textarea class="detail-desc-edit" data-name="${escAttr(f.name)}" placeholder="${t('lora.notesPlaceholder')}" rows="4">${esc(descText)}</textarea>
    <div class="detail-desc-save" id="descSave_${escAttr(f.name)}">${t('lora.saved')}</div></div>`

  const html = `<div class="detail-hero">${imgHtml}${previewTools}</div>
    <div class="detail-actions">
      ${localStatusDot(f)}
      <span class="detail-name">${esc(d?.modelName || f.name)}</span>
      ${d?.creator ? `<span class="detail-sep">|</span><span class="detail-creator">${esc(d.creator)}</span>` : ''}
      <div class="detail-actions-right">
        ${d ? `<button class="btn btn-ghost detail-open-url btn-sm" data-id="${d.modelId}">${icon('globe', 12)} Civitai</button>` : ''}
        ${actionBtn}
        <button class="local-detail-close" type="button" title="${t('lora.closeDetails')}" aria-label="${t('lora.closeDetails')}">${icon('x', 16)}</button>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-body-left">
        ${previewSources.length > 1 ? `<div class="detail-section"><h4>${t('lora.imagePreviews')}</h4><div class="detail-gallery">${previewSources.slice(1, 6).map((im, i) => `<img src="${escAttr(customPreview && i === 0 ? im : thumbUrl(im, 200))}" class="detail-gallery-thumb" loading="lazy" onerror="this.style.display='none'">`).join('')}</div></div>` : ''}
        ${trainedWords}
        ${tags}
        ${catHtml}
        ${loraTagHtml}
        ${manualMatchHtml}
      </div>
      <div class="detail-body-right">
        ${description}
        <div class="detail-section"><h4>${t('lora.fileInfo')}</h4>
          <div class="detail-fileinfo">
            <div class="detail-fi-row"><span>${t('lora.filename')}</span><span>${esc(f.name)}</span></div>
            <div class="detail-fi-row"><span>${t('lora.fileSize')}</span><span>${fmtSize(f.size)}</span></div>
            <div class="detail-fi-row"><span>SHA256</span><span class="detail-sha" title="${esc(f.sha256)}">${esc(f.sha256.slice(0, 20))}…</span></div>
            ${detailBaseModelRow(f, d)}
            ${d?.versionName ? `<div class="detail-fi-row"><span>${t('lora.version')}</span><span>${esc(d.versionName)} <span style="color:var(--text3);font-size:10px">(ID: ${d.versionId})</span></span></div>` : ''}
          </div>
        </div>
        ${descHtml}
        ${renderRelatedOutputs(f)}
      </div>
    </div>`

  if (setDetailHtml(content, html)) {
    // Existing image nodes survive equivalent metadata refreshes.
    loadRelatedOutputThumbnails()
  }
}

function renderRelatedOutputs(f: LocalLoraFile): string {
  const loraBase = f.name.replace(/\.\w+$/, '').toLowerCase()
  const outputState = useOutputStore.getState()
  const matches: { id: string; filePath: string; mtime: number }[] = []

  for (const file of outputState.files) {
    const identity = fileSourceIdentity(file)
    const meta = metadataForFile(outputState.metadataCache, file, identity.root, identity.parserVersion)
    const loras = meta?.loras || outputSummaryForFile(file, outputState.summaryCache)?.loras || []
    if (!loras.some(l => l.toLowerCase() === loraBase)) continue
    matches.push({ id: file.id, filePath: file.path, mtime: file.mtime })
  }

  if (matches.length === 0) {
    return `<div class="detail-section"><h4>🖼️ ${t('lora.linkedOutputs')}</h4><p style="font-size:11px;color:var(--text3)">${t('lora.noLinkedOutputs')}</p></div>`
  }

  matches.sort((a, b) => b.mtime - a.mtime)
  const top = matches.slice(0, 12)

  const items = top.map(m => {
    const dateStr = m.mtime ? new Date(m.mtime).toLocaleDateString() : ''
    return `<div class="detail-output-item" data-id="${escAttr(m.id)}" data-path="${escAttr(m.filePath)}">
      <div class="detail-output-thumb" data-id="${escAttr(m.id)}" data-path="${escAttr(m.filePath)}">
        <div class="detail-thumb-placeholder">⏳</div>
      </div>
      <div class="detail-output-info">
        <span class="detail-output-date">${dateStr}</span>
      </div>
    </div>`
  }).join('')

  return `<div class="detail-section"><h4>🖼️ ${t('lora.linkedOutputs')} <small>${t('lora.local.linkedImageCount', { count: matches.length })}</small></h4>
    <div class="detail-output-grid">${items}</div></div>`
}

/** 在 detail 渲染后，加载关联出图的缩略图 */
async function loadRelatedOutputThumbnails() {
  const items = document.querySelectorAll<HTMLElement>('.detail-output-thumb[data-id]')
  const { getCachedThumbnail, getThumbnail, animaThumbUrl, backendThumbsEnabled } = await import('../services/outputThumbnail')
  for (const el of items) {
    const row = useOutputStore.getState().files.find(file => file.id === el.dataset.id)
    if (!row) continue
    const identity = fileSourceIdentity(row)
    const revision = imageRevision(createImageSnapshot(row, identity.source, identity.root, identity.parserVersion))
    try {
      let url = identity.source === 'gallery' && backendThumbsEnabled() ? animaThumbUrl(row.path, 512) + '&v=' + encodeURIComponent(revision) : await getCachedThumbnail(row.id, revision)
      if (!url && identity.source === 'directory') {
        const file = await readOutputSourceFile(row)
        if (file) url = await getThumbnail(file, row.id, revision)
      }
      if (url && el.isConnected) el.innerHTML = `<img src="${escAttr(url)}" alt="${escAttr(row.filename)}" style="width:100%;height:100%;object-fit:cover">`
    } catch { /* Leave the per-image placeholder when its source is unavailable. */ }
  }
}

function renderGallery(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('localPngList')
  if (!el) return
  const pngs = state.pngs
  if (pngs.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="big">' + icon('image', 28) + `</div><p>${t('lora.gallery.empty')}</p></div>`
    return
  }
  el.innerHTML = pngs.map((p, index) => {
    const tags = extractTagsFromPrompt(p.positive).slice(0, 20)
    const metadata = p as LocalImageMetadata
    return `<div class="local-png-card" data-local-image-index="${index}">
      <div class="local-png-header">
        <span class="local-png-name">${esc(p.fileName)}</span>
        <span class="local-png-size">${fmtSize(p.fileSize)}</span>
      </div>
      ${metadata.metadataState ? renderMetadataReliability(metadata) : ''}
      ${p.positive ? `<div class="local-png-field"><label>${t('lora.positivePrompt')}</label><div class="local-png-text" data-copy="${esc(p.positive)}">${esc(trunc(p.positive, 200))}</div></div>` : ''}
      ${p.negative ? `<div class="local-png-field"><label>${t('lora.negativePrompt')}</label><div class="local-png-text" data-copy="${esc(p.negative)}">${esc(trunc(p.negative, 150))}</div></div>` : ''}
      <div class="local-png-params">
        ${p.seed ? `<span>🌰 ${esc(p.seed)}</span>` : ''}
        ${p.steps ? `<span>👣 ${esc(p.steps)}</span>` : ''}
        ${p.cfg ? `<span>⚙️ CFG ${esc(p.cfg)}</span>` : ''}
        ${p.sampler ? `<span>🔬 ${esc(p.sampler)}</span>` : ''}
        ${p.model ? `<span>🧠 ${esc(trunc(p.model, 30))}</span>` : ''}
      </div>
      ${tags.length > 0 ? `<div class="local-png-tags">${tags.map(t => `<code class="local-tw-item" data-copy="${esc(t)}">${esc(t)}</code>`).join('')}</div>` : ''}
      ${p.loras.length > 0 ? `<div class="local-png-loras">${p.loras.map(l => `<code class="local-tw-item lora" data-copy="${esc(l)}">${esc(l)}</code>`).join('')}</div>` : ''}
      <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--text2);font-size:12px">${icon('slidersHorizontal', 12)} ${t('lora.generationDetails')}</summary><div style="margin-top:10px">${renderGenerationDetails(metadata, false)}</div></details>
    </div>`
  }).join('')
  el.querySelectorAll<HTMLElement>('[data-local-image-index]').forEach(card => {
    const image = pngs[Number(card.dataset.localImageIndex)]
    if (image) bindRawMetadataDetails(card, image as LocalImageMetadata)
  })
}

function renderTagFreq(tags: TagFreq[]) {
  const el = $$('localTagList')
  if (!el) return
  if (tags.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="big">' + icon('tag', 28) + `</div><p>${t('lora.tags.empty')}</p></div>`
    return
  }
  const maxCount = tags[0]?.count || 1
  el.innerHTML = tags.slice(0, 100).map(tag => {
    const pct = (tag.count / maxCount) * 100
    const fontSize = 11 + pct * 0.06
    return `<span class="local-tag-item" style="font-size:${fontSize.toFixed(1)}px" data-copy="${esc(tag.tag)}" title="${t('lora.tags.occurrenceCount', { count: tag.count })}">
      ${esc(tag.tag)} <small>${tag.count}</small>
    </span>`
  }).join('')
}

function updateStats(state: ReturnType<typeof useLocalModelStore.getState>) {
  const el = $$('localScanStats')
  if (el) el.textContent = t('lora.local.totalNotice', { count: state.files.length })
  const gridStats = $$('localGridStats')
  if (gridStats) gridStats.textContent = t('lora.local.total', { count: state.files.length })
  const fc = $$('statFileCount')
  const mc = $$('statMatchedCount')
  const pc = $$('statPngCount')
  const tc = $$('statTagCount')
  if (fc) fc.textContent = String(state.files.length)
  if (mc) mc.textContent = String(state.files.filter(f => f.matched).length)
  if (pc) pc.textContent = String(state.pngs.length)
  if (tc) tc.textContent = String(state.tagFreq.length)

  const badge = $$('localNewFileBadge')
  if (badge) {
    const n = state.newFileCount
    if (n > 0 && state.files.length === 0) {
      badge.style.display = 'inline-block'
      badge.textContent = t('lora.local.newFilesBadge', { count: n })
      badge.onclick = () => useLocalModelStore.getState().scanDir()
    } else {
      badge.style.display = 'none'
    }
  }
}

function bindLocalEvents() {
  // 右键分类菜单 + 拖拽框选（capture 阶段在 initDragSelect 绑定，防止浏览器默认行为/扩展抢先）
  initDragSelect()

  $$('localScanBtn')?.addEventListener('click', async () => {
    if (['scanning', 'matching'].includes(useLocalModelStore.getState().scanStatus)) return
    await useLocalModelStore.getState().scanDir()
    refreshLocalNames()
    renderLocalView()
  })

  $$('localProgressCancel')?.addEventListener('click', () => {
    useLocalModelStore.getState().cancelScan()
  })

  $$('localFolderCategoryBtn')?.addEventListener('click', () => {
    const result = useLocalModelStore.getState().categorizeBySubfolders()
    if (result.folders.length) renderLocalView()
  })

  // 「从 C 站链接批量下载」弹窗已拆分到 downloadUrlModal.ts（纯搬迁，行为等价）
  bindUrlDownloadModal(() => renderLocalView(), () => refreshLocalNames())


  $$('localMatchAllBtn')?.addEventListener('click', async () => {
    await useLocalModelStore.getState().matchAll()
    renderLocalView()
  })

  $$('localClearBtn')?.addEventListener('click', () => {
    useLocalModelStore.getState().cancelScan()
    useLocalModelStore.setState({ files: [], scanStatus: 'idle' })
    useLocalModelStore.getState().saveToCache()
    renderLocalView()
  })

  $$('localPngClearBtn')?.addEventListener('click', () => {
    useLocalModelStore.setState({ pngs: [] })
    useLocalModelStore.getState().saveToCache()
    renderLocalView()
  })

  $$('localPngDropZone')?.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp'
    input.multiple = true
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files
      if (!files) return
      for (const f of Array.from(files)) {
        const png = await parsePngFile(f)
        if (png) useLocalModelStore.getState().addPng(png)
      }
      useLocalModelStore.getState().saveToCache()
      useLocalModelStore.getState().rebuildTagFreq()
      renderLocalView()
    }
    input.click()
  })

  $$('localPngDropZone')?.addEventListener('dragover', (e) => {
    e.preventDefault()
    $$('localPngDropZone')!.classList.add('drag-over')
  })

  $$('localPngDropZone')?.addEventListener('dragleave', () => {
    $$('localPngDropZone')!.classList.remove('drag-over')
  })

  $$('localPngDropZone')?.addEventListener('drop', async (e) => {
    e.preventDefault()
    $$('localPngDropZone')!.classList.remove('drag-over')
    const items = e.dataTransfer?.files
    if (!items) return
    for (const f of Array.from(items)) {
      if (!/\.(png|jpe?g|webp)$/i.test(f.name)) continue
      const png = await parsePngFile(f)
      if (png) useLocalModelStore.getState().addPng(png)
    }
    useLocalModelStore.getState().saveToCache()
    useLocalModelStore.getState().rebuildTagFreq()
    renderLocalView()
  })

  // 搜索防抖：每次按键全量重建文件树代价高，150ms 合并连续输入
  const debouncedLocalSearch = debounce(() => {
    const q = ($$('localSearch') as HTMLInputElement).value
    useLocalModelStore.getState().setSearchQuery(q)
    renderSidebarList(useLocalModelStore.getState())
  }, 150)
  $$('localSearch')?.addEventListener('input', debouncedLocalSearch)
  attachSearchClear($$('localSearch') as HTMLInputElement, () => {
    useLocalModelStore.getState().setSearchQuery('')
    renderSidebarList(useLocalModelStore.getState())
  })

  $$('localSort')?.addEventListener('change', () => {
    const v = ($$('localSort') as HTMLSelectElement).value as LocalSortKey
    useLocalModelStore.getState().setSortKey(v)
    renderSidebarList(useLocalModelStore.getState())
  })

  $$('localFilter')?.addEventListener('change', () => {
    const v = ($$('localFilter') as HTMLSelectElement).value as LocalFilterKey
    useLocalModelStore.getState().setFilterKey(v)
    renderSidebarList(useLocalModelStore.getState())
  })

  for (const id of ['localListViewBtn', 'localGridViewBtn']) {
    $$(id)?.addEventListener('click', () => {
      const mode = ($$(id) as HTMLElement).dataset.displayMode as LocalDisplayMode
      if (mode !== 'list' && mode !== 'grid') return
      useLocalModelStore.getState().setDisplayMode(mode)
      renderSidebarList(useLocalModelStore.getState())
    })
  }

  document.querySelectorAll('.local-view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const view = (tab as HTMLElement).dataset.view as LocalViewKey
      activateLocalView(view)
    })
  })

  $$('localBatchToggleBtn')?.addEventListener('click', () => {
    const s = useLocalModelStore.getState()
    s.setBatchMode(!s.batchMode)
    renderSidebarList(useLocalModelStore.getState())
  })

  const fileList = $$('localFileList')

  fileList?.addEventListener('dragstart', (e) => {
    const item = (e.target as HTMLElement).closest('.local-list-item') as HTMLElement
    if (item && item.dataset.name) {
      e.dataTransfer?.setData('text/plain', item.dataset.name)
      e.dataTransfer!.effectAllowed = 'move'
    }
  })

  fileList?.addEventListener('dragover', (e) => {
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header, .local-grid-cat-btn') as HTMLElement
    if (!header) return
    e.preventDefault()
    header.classList.add('drag-over')
  })

  fileList?.addEventListener('dragleave', (e) => {
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header, .local-grid-cat-btn') as HTMLElement
    if (header) header.classList.remove('drag-over')
  })

  fileList?.addEventListener('drop', (e) => {
    const header = (e.target as HTMLElement).closest('.local-tree-cat-header, .local-grid-cat-btn') as HTMLElement
    if (!header) return
    header.classList.remove('drag-over')
    const cat = header.dataset.cat
    const fileName = e.dataTransfer?.getData('text/plain')
    if (!cat || !fileName || cat === '__uncategorized__') return
    const s = useLocalModelStore.getState()
    const existing = s.modelCategories[stripExt(fileName)] || []
    if (!existing.includes(cat)) {
      s.setModelCategories(fileName, [...existing, cat])
      s.saveToCache()
      renderSidebarList(s)
    }
  })

  const gridCategoryList = $$('localGridCategoryList')
  gridCategoryList?.addEventListener('dragover', (e) => {
    const button = (e.target as HTMLElement).closest('.local-grid-cat-btn') as HTMLElement
    if (!button || !button.dataset.cat) return
    e.preventDefault()
    button.classList.add('drag-over')
  })
  gridCategoryList?.addEventListener('dragleave', (e) => {
    const button = (e.target as HTMLElement).closest('.local-grid-cat-btn') as HTMLElement
    if (button) button.classList.remove('drag-over')
  })
  gridCategoryList?.addEventListener('drop', (e) => {
    const button = (e.target as HTMLElement).closest('.local-grid-cat-btn') as HTMLElement
    if (!button) return
    button.classList.remove('drag-over')
    const cat = button.dataset.cat
    const fileName = e.dataTransfer?.getData('text/plain')
    if (!cat || cat === '__uncategorized__' || !fileName) return
    const s = useLocalModelStore.getState()
    const existing = s.modelCategories[stripExt(fileName)] || []
    if (!existing.includes(cat)) {
      s.setModelCategories(fileName, [...existing, cat])
      s.saveToCache()
      renderSidebarList(s)
    }
  })

  fileList?.addEventListener('keydown', (e) => {
    // 在输入框中输入时不触发导航
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    const items = Array.from(fileList.querySelectorAll('.local-list-item'))
    if (items.length === 0) return

    const currentIdx = items.findIndex(item => item.classList.contains('active'))
    let nextIdx = currentIdx

    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault()
        nextIdx = currentIdx < items.length - 1 ? currentIdx + 1 : 0
        break
      case 'ArrowUp':
      case 'k':
        e.preventDefault()
        nextIdx = currentIdx > 0 ? currentIdx - 1 : items.length - 1
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (currentIdx >= 0) {
          const name = (items[currentIdx] as HTMLElement).dataset.name
          if (name) {
            const state = useLocalModelStore.getState()
            if (state.batchMode) {
              state.toggleBatchSelection(name)
              renderSidebarList(useLocalModelStore.getState())
            } else {
              openLocalDetail(name)
            }
          }
        }
        return
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        if (currentIdx >= 0) {
          const name = (items[currentIdx] as HTMLElement).dataset.name
          if (name) {
            const delBtn = items[currentIdx].querySelector('.local-list-del') as HTMLElement
            if (delBtn) delBtn.click()
          }
        }
        return
      case 'Escape':
        e.preventDefault()
        if (_detailDrawerOpen || useLocalModelStore.getState().currentView === 'detail') closeLocalDetail()
        else {
          useLocalModelStore.getState().selectModel(null)
          renderSidebarList(useLocalModelStore.getState())
          renderDetail(useLocalModelStore.getState())
        }
        return
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          const state = useLocalModelStore.getState()
          if (state.batchMode) {
            items.forEach(item => {
              const name = (item as HTMLElement).dataset.name
              if (name && !state.batchSelection.includes(name)) {
                state.toggleBatchSelection(name)
              }
            })
            renderSidebarList(state)
          }
        }
        return
      default:
        return
    }

    if (nextIdx !== currentIdx) {
      items.forEach((item, i) => {
        item.classList.toggle('active', i === nextIdx)
      })
      const name = (items[nextIdx] as HTMLElement).dataset.name
      if (name) {
        openLocalDetail(name)
        const selected = Array.from(fileList.querySelectorAll('.local-list-item'))
          .find(item => (item as HTMLElement).dataset.name === name) as HTMLElement | undefined
        selected?.scrollIntoView({ block: 'nearest' })
      }
    }
  })

  fileList?.setAttribute('tabindex', '0')

  document.addEventListener('click', (e) => {
    const bd = $$('localBatchDropdown')
    if (bd && bd.style.display === 'block' && !(e.target as HTMLElement).closest('#localBatchDDWrap, #localBatchAssignBtn')) {
      bd.style.display = 'none'
    }
    const dd = $$('detailCatDropdown')
    if (dd && dd.style.display === 'block' && !(e.target as HTMLElement).closest('#detailCatDropdown, #detailCatAddBtn')) {
      dd.style.display = 'none'
    }
  })

  fileList?.addEventListener('dblclick', async (e) => {
    const nameEl = (e.target as HTMLElement).closest('.local-tree-cat-name') as HTMLElement
    if (!nameEl) return
    const header = nameEl.closest('.local-tree-cat-header') as HTMLElement
    if (!header) return
    const cat = header.dataset.cat
    if (!cat || cat === '__uncategorized__') return
    const newName = await promptModal(t('lora.category.rename'), nameEl.textContent || '')
    if (!newName || !newName.trim() || newName.trim() === nameEl.textContent) return
    const s = useLocalModelStore.getState()
    if (s.categories.includes(newName.trim())) { showToast(t('lora.category.duplicateName')); return }
    s.renameCategory(cat, newName.trim())
    s.saveToCache()
    renderSidebarList(s)
  })

  $$('sectionLocal')?.addEventListener('change', (e) => {
    const ta = (e.target as HTMLElement).closest('.detail-desc-edit') as HTMLTextAreaElement
    if (ta) {
      const name = ta.dataset.name
      if (name) {
        useLocalModelStore.getState().setDescription(name, ta.value)
        useLocalModelStore.getState().saveToCache()
      }
      return
    }

    // Number input blur/Enter: save store, sync slider, update detail preview
    const numInput = (e.target as HTMLElement).closest('.detail-lora-input') as HTMLInputElement
    if (numInput) {
      const name = numInput.dataset.name
      const val = parseFloat(numInput.value)
      if (!name || isNaN(val)) return
      const clamped = Math.max(0, Math.min(2, val))
      numInput.value = clamped.toFixed(2)

      const row = numInput.closest('.detail-lora-builder')
      const slider = row?.querySelector('.detail-lora-slider') as HTMLInputElement
      if (slider) slider.value = String(clamped)

      const s = useLocalModelStore.getState()
      s.setPromptWeights({ ...s.promptWeights, [name]: clamped })

      const detailBuilder = numInput.closest('.detail-lora-builder') as HTMLElement
      if (detailBuilder) {
        const previewEl = detailBuilder.querySelector('.detail-lora-preview code')
        if (previewEl) {
          const localBase = name.replace(/\.\w+$/, '')
          previewEl.textContent = `<lora:${localBase}:${clamped.toFixed(2)}>`
        }
        // Sync copy button data-w
        const copyBtn = detailBuilder.querySelector('.detail-lora-copy') as HTMLElement
        if (copyBtn) copyBtn.dataset.w = clamped.toFixed(2)
      }
      return
    }
  })

  // 滑块拖拽实时更新数字 + 详情页预览
  $$('sectionLocal')?.addEventListener('input', (e) => {
    const target = e.target as HTMLElement

    const triggerDraft = target.closest('.local-trigger-draft') as HTMLTextAreaElement | null
    if (triggerDraft) {
      const editor = _triggerEditor
      const name = triggerDraft.dataset.name || ''
      if (!editor || editor.identity !== normalizeLocalLoraIdentity(name)) return
      editor.draft = triggerDraft.value
      const saved = editor.entry ? effectiveTriggerWords(editor.entry, editor.automaticWords).join('\n') : null
      editor.dirty = saved === null ? triggerDraft.value.length > 0 : triggerDraft.value !== saved
      if (editor.dirty) _triggerDrafts.set(editor.identity, { draft: editor.draft, dirty: true })
      else _triggerDrafts.delete(editor.identity)
      updateTriggerEditorDom()
      return
    }

    // Slider drag: sync number, save store, update detail preview
    const slider = target.closest('.detail-lora-slider') as HTMLInputElement
    if (slider) {
      const val = parseFloat(slider.value)
      const name = slider.dataset.name
      if (!name) return
      const row = slider.closest('.detail-lora-builder')
      const numInput = row?.querySelector('.detail-lora-input') as HTMLInputElement
      if (numInput) numInput.value = val.toFixed(2)

      // Save store
      const s = useLocalModelStore.getState()
      s.setPromptWeights({ ...s.promptWeights, [name]: val })

      // Update detail page lora preview live (DOM only, no re-render)
      const detailBuilder = slider.closest('.detail-lora-builder') as HTMLElement
      if (detailBuilder) {
        const previewEl = detailBuilder.querySelector('.detail-lora-preview code')
        if (previewEl) {
          const localBase = name.replace(/\.\w+$/, '')
          previewEl.textContent = `<lora:${localBase}:${val.toFixed(2)}>`
        }
        // Sync copy button data-w
        const copyBtn = detailBuilder.querySelector('.detail-lora-copy') as HTMLElement
        if (copyBtn) copyBtn.dataset.w = val.toFixed(2)
      }
      return
    }

    // Number input typing: sync slider position (no store save, wait change)
    const numInput = target.closest('.detail-lora-input') as HTMLInputElement
    if (numInput) {
      const val = parseFloat(numInput.value)
      if (!isNaN(val)) {
        const clamped = Math.max(0, Math.min(2, val))
        const row = numInput.closest('.detail-lora-builder')
        const slider = row?.querySelector('.detail-lora-slider') as HTMLInputElement
        if (slider) slider.value = String(clamped)
      }
    }
  })

  $$('sectionLocal')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement

    if (target.closest('.local-detail-close')) {
      closeLocalDetail()
      return
    }

    const triggerSave = target.closest('.local-trigger-save') as HTMLElement | null
    if (triggerSave) {
      const name = triggerSave.dataset.name || _triggerEditor?.name
      if (name) await persistTriggerEditor(name)
      return
    }

    const triggerReset = target.closest('.local-trigger-reset') as HTMLElement | null
    if (triggerReset) {
      const name = triggerReset.dataset.name || _triggerEditor?.name
      if (name) await persistTriggerEditor(name, true)
      return
    }

    const triggerRetry = target.closest('.local-trigger-retry') as HTMLElement | null
    if (triggerRetry) {
      const name = triggerRetry.dataset.name || _triggerEditor?.name
      if (name) await retryTriggerEditorRead(name)
      return
    }

    const triggerCopy = target.closest('.local-trigger-copy') as HTMLElement | null
    if (triggerCopy) {
      const name = triggerCopy.closest('#localTriggerEditor')?.getAttribute('data-name') || _triggerEditor?.name
      if (name) await copyConfirmedTriggerWords(name, triggerCopy)
      return
    }

    const proxyAction = target.closest('[data-local-action]') as HTMLElement
    if (proxyAction) {
      const targetId = proxyAction.dataset.localAction
      if (targetId) document.getElementById(targetId)?.click()
      return
    }

    const chk = target.closest('.local-list-chk') as HTMLInputElement
    if (chk) {
      const name = chk.dataset.name
      if (name) useLocalModelStore.getState().toggleBatchSelection(name)
      renderSidebarList(useLocalModelStore.getState())
      return
    }

    const delCatBtn = target.closest('.local-cat-del-btn') as HTMLElement
    if (delCatBtn) {
      const cat = delCatBtn.dataset.cat
      if (cat && await confirmModal(t('lora.category.delete'), t('lora.category.confirmDelete', { name: cat }))) {
        useLocalModelStore.getState().removeCategory(cat)
        useLocalModelStore.getState().saveToCache()
        renderSidebarList(useLocalModelStore.getState())
      }
      return
    }

    const renameBtn = target.closest('.local-cat-rename-btn') as HTMLElement
    if (renameBtn) {
      const cat = renameBtn.dataset.cat
      if (!cat) return
      const s = useLocalModelStore.getState()
      const newName = await promptModal(t('lora.category.rename'), cat)
      if (!newName || !newName.trim() || newName.trim() === cat) return
      if (s.categories.includes(newName.trim())) { showToast(t('lora.category.duplicateName')); return }
      s.renameCategory(cat, newName.trim())
      s.saveToCache()
      renderSidebarList(s)
      return
    }

    const catHeader = target.closest('.local-tree-cat-header') as HTMLElement
    if (catHeader && !target.closest('.local-new-cat-btn') && !target.closest('.local-cat-del-btn') && !target.closest('.local-cat-rename-btn')) {
      const cat = catHeader.dataset.cat
      if (cat) {
        useLocalModelStore.getState().toggleCategoryExpanded(cat)
        renderSidebarList(useLocalModelStore.getState())
      }
      return
    }

    const newCatBtn = target.closest('.local-new-cat-btn') as HTMLElement
    if (newCatBtn) {
      const cat = await promptModal(t('lora.category.create'))
      if (!cat || !cat.trim()) return
      const s = useLocalModelStore.getState()
      if (s.categories.includes(cat.trim())) { showToast(t('lora.category.duplicate')); return }
      s.addCategory(cat.trim())
      s.saveToCache()
      renderSidebarList(s)
      return
    }

    const bmToggle = target.closest('.local-bm-toggle') as HTMLElement
    if (bmToggle) {
      useLocalModelStore.getState().toggleBaseModelPanel()
      renderSidebarList(useLocalModelStore.getState())
      return
    }

    const bmBtn = target.closest('.local-bm-btn') as HTMLElement
    if (bmBtn) {
      const s = useLocalModelStore.getState()
      const bm = bmBtn.dataset.bm || ''
      s.setFilterBaseModel(s.filterBaseModel === bm ? '' : bm)
      renderSidebarList(useLocalModelStore.getState())
      return
    }

    const gridCatBtn = target.closest('.local-grid-cat-btn') as HTMLElement
    if (gridCatBtn) {
      const cat = gridCatBtn.dataset.cat || null
      useLocalModelStore.getState().setFilterCategory(cat)
      renderSidebarList(useLocalModelStore.getState())
      return
    }

    const previewUploadBtn = target.closest('.local-preview-upload') as HTMLElement
    if (previewUploadBtn) {
      const name = previewUploadBtn.dataset.name
      if (name) openLocalPreviewPicker(name)
      return
    }

    const previewUrlBtn = target.closest('.local-preview-url') as HTMLElement
    if (previewUrlBtn) {
      const name = previewUrlBtn.dataset.name
      if (name) await setLocalPreviewFromUrl(name)
      return
    }

    const previewResetBtn = target.closest('.local-preview-reset') as HTMLElement
    if (previewResetBtn) {
      const name = previewResetBtn.dataset.name
      if (name) await resetLocalPreview(name)
      return
    }

    const delBtn = target.closest('.local-list-del, .detail-del-btn') as HTMLElement
    if (delBtn) {
      const name = delBtn.dataset.name
      if (name) await deleteLocalLora(name)
      return
    }

    // C 站预览图点击放大：列表缩略图（先于选中详情处理，避免点图同时跳详情）
    const listThumb = target.closest('.local-list-thumb, .local-grid-preview') as HTMLElement
    if (listThumb) {
      const item = listThumb.closest('.local-list-item') as HTMLElement
      const name = item?.dataset.name
      const state = useLocalModelStore.getState()
      if (state.batchMode && name) {
        state.toggleBatchSelection(name)
        renderSidebarList(useLocalModelStore.getState())
        return
      }
      const f = name ? useLocalModelStore.getState().files.find(ff => ff.name === name) : undefined
      const imgs = f ? localPreviewSources(f, state) : []
      if (imgs.length) openLightbox(imgs.map((u, i) => i === 0 && state.previewImages[f!.name] ? u : thumbUrl(u, 800)), 0)
      return
    }
    // C 站预览图点击放大：详情页大图 / 画廊缩略图
    const heroImg = target.closest('.detail-hero-img') as HTMLElement
    if (heroImg) {
      const st = useLocalModelStore.getState()
      const f = st.files.find(x => x.name === st.selectedModel)
      const imgs = f ? localPreviewSources(f, st) : []
      if (imgs.length) openLightbox(imgs.map((u, i) => i === 0 && st.previewImages[f!.name] ? u : thumbUrl(u, 800)), 0)
      return
    }
    const galleryImg = target.closest('.detail-gallery-thumb') as HTMLElement
    if (galleryImg) {
      const st = useLocalModelStore.getState()
      const f = st.files.find(x => x.name === st.selectedModel)
      const imgs = f ? localPreviewSources(f, st) : []
      if (imgs.length) {
        // gallery 渲染 images.slice(1,6)：容器内第 i 个子元素对应 images[i+1]
        const gal = galleryImg.parentElement
        const idx = gal ? Array.from(gal.children).indexOf(galleryImg) + 1 : 1
        openLightbox(imgs.map((u, i) => i === 0 && st.previewImages[f!.name] ? u : thumbUrl(u, 800)), Math.min(idx, imgs.length - 1))
      }
      return
    }

    const listItem = target.closest('.local-list-item') as HTMLElement
    if (listItem) {
      // The overflow menu must remain usable without opening the underlying card.
      const name = listItem.dataset.name
      if (name) {
        const state = useLocalModelStore.getState()
        // 批量模式下点击整张卡片就是选择动作，不能进入详情流程，更不能把网格强制切成列表。
        // 复选框仍由上方的 .local-list-chk 分支处理；这里覆盖卡片图片、标题和空白区域。
        if (state.batchMode) {
          state.toggleBatchSelection(name)
          renderSidebarList(useLocalModelStore.getState())
          return
        }
        if (_detailDrawerOpen && state.selectedModel === name && state.currentView !== 'detail') closeLocalDetail()
        else openLocalDetail(name)
      }
      return
    }

    const matchBtn = target.closest('.detail-match-btn') as HTMLElement
    if (matchBtn) {
      const name = matchBtn.dataset.name
      if (!name) return
      await useLocalModelStore.getState().matchOne(name)
      renderLocalView()
      return
    }

    const copyEl = target.closest('[data-copy]') as HTMLElement
    if (copyEl) {
      copyText(copyEl.dataset.copy || '', copyEl)
      return
    }

    const openUrl = target.closest('.detail-open-url') as HTMLElement
    if (openUrl) {
      const id = openUrl.dataset.id
      if (id) window.open(`https://civitai.com/models/${id}`, '_blank')
      return
    }

    if (target.id === 'localBatchClearBtn') {
      useLocalModelStore.getState().clearBatchSelection()
      renderSidebarList(useLocalModelStore.getState())
      return
    }

    if (target.id === 'localBatchAssignBtn') {
      const dd = $$('localBatchDropdown')
      if (!dd) return
      const cats = useLocalModelStore.getState().categories
      dd.innerHTML = cats.map(c => `<div class="td-opt" data-cat="${escAttr(c)}">${esc(c)}</div>`).join('')
      dd.style.display = dd.style.display === 'block' ? 'none' : 'block'
      return
    }

    const batchOpt = target.closest('#localBatchDropdown .td-opt') as HTMLElement
    if (batchOpt) {
      const cat = batchOpt.dataset.cat
      if (!cat) return
      const s = useLocalModelStore.getState()
      s.setBatchModelCategories(s.batchSelection, cat)
      s.saveToCache()
      s.clearBatchSelection()
      $$('localBatchDropdown')!.style.display = 'none'
      renderLocalView()
      return
    }

    if (target.id === 'detailCatAddBtn') {
      const dd = $$('detailCatDropdown')
      if (!dd) return
      const s = useLocalModelStore.getState()
      const fname = s.selectedModel
      if (!fname) return
      const existing = s.modelCategories[stripExt(fname)] || []
      const available = s.categories.filter(c => !existing.includes(c))
      dd.innerHTML = available.length
        ? available.map(c => `<div class="td-opt" data-cat="${escAttr(c)}">${esc(c)}</div>`).join('')
        : `<div class="td-opt dropdown-empty">${t('lora.category.noMore')}</div>`
      dd.style.display = dd.style.display === 'block' ? 'none' : 'block'
      return
    }

    const detailCatSel = target.closest('#detailCatDropdown .td-opt') as HTMLElement
    if (detailCatSel) {
      const cat = detailCatSel.dataset.cat
      if (!cat) return
      const s = useLocalModelStore.getState()
      const fname = s.selectedModel
      if (fname) {
        const existing = s.modelCategories[stripExt(fname)] || []
        s.setModelCategories(fname, [...existing, cat])
        s.saveToCache()
      }
      $$('detailCatDropdown')!.style.display = 'none'
      renderDetail(useLocalModelStore.getState())
      return
    }

    const catRm = target.closest('.detail-cat-rm') as HTMLElement
    if (catRm) {
      const fname = catRm.dataset.name
      const cat = catRm.dataset.cat
      if (fname && cat) {
        const s = useLocalModelStore.getState()
        const existing = s.modelCategories[stripExt(fname)] || []
        s.setModelCategories(fname, existing.filter((c: string) => c !== cat))
        s.saveToCache()
        renderDetail(s)
      }
      return
    }

    if (target.id === 'manualMatchBtn') {
      const name = (target as HTMLElement).dataset.name
      const url = ($$('manualMatchUrl') as HTMLInputElement)?.value
      if (!name || !url) return
      await useLocalModelStore.getState().matchByUrl(name, url.trim())
      renderLocalView()
      return
    }

    // Click related output → switch to Outputs tab
    const outputItem = target.closest('.detail-output-item') as HTMLElement
    if (outputItem) {
      const id = outputItem.dataset.id
      if (id) {
        // Switch to outputs tab
        const outputsTab = document.querySelector('.main-tab[data-section="outputs"]') as HTMLElement
        if (outputsTab) outputsTab.click()
        // Focus the image after a short delay
        setTimeout(() => {
          const card = document.querySelector(`.outputs-card[data-id="${escAttr(id)}"]`) as HTMLElement
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' })
            card.classList.add('highlight-flash')
            setTimeout(() => card.classList.remove('highlight-flash'), 2000)
          }
        }, 300)
      }
      return
    }

    const copyLora = target.closest('.detail-lora-copy') as HTMLElement
    if (copyLora) {
      const tag = copyLora.dataset.tag
      const w = copyLora.dataset.w
      if (tag) {
        copyText(`<lora:${tag}:${w}>`)
        showToast(t('lora.copied'))
      }
      return
    }
  })
}

type LocalImageMetadata = PngMeta & Partial<ParsedMetadata>

async function parsePngFile(file: File): Promise<LocalImageMetadata | null> {
  try {
    const metadata = await parsePngMetadata(file)
    return {
      ...metadata, fileName: file.name, fileSize: file.size,
      positive: metadata.prompt, negative: metadata.negativePrompt,
      loras: outputLoraNames(metadata),
    }
  } catch {
    showToast(t('lora.metadataReadFailed'))
    return null
  }
}

async function parsePngMetadata(blob: Blob): Promise<ParsedMetadata> {
  return parseOutputMetadataBlob(blob)
}

export const __test = { parsePngFile, parsePngMetadata }

function extractTagsFromPrompt(prompt: string): string[] {
  const tags = prompt.split(/[,，、\n]+/).map(t => t.trim()).filter(Boolean)
  const seen = new Set<string>()
  const result: string[] = []
  for (const t of tags) {
    const clean = t.replace(/^\(|\):\d+(\.\d+)?|\)$/g, '').trim().toLowerCase()
    if (clean && !seen.has(clean) && clean.length > 1) {
      seen.add(clean)
      result.push(clean)
    }
  }
  return result
}

function fmtSize(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB'
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
