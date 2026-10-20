import { t as tr } from '../i18n'
import { outputSources, sourceForFile, setOutputSourceEnabled, removeOutputSource, requestOutputSourcePermission } from '../services/outputSources'
import { scanOutputSource, buildDirTreeFromPaths } from '../services/outputScanner'
import { useOutputStore } from '../store/outputStore'
import type { OutputDir } from '../types/outputs'
import { esc, escAttr, icon, showToast } from '../utils'
import { openContextMenu } from '../components/ContextMenu'
import type { OutputFile } from '../types/outputs'

const expanded = new Set<string>(['output'])
const nodeKey = (source: string, path: string) => JSON.stringify([source, path])
let mounted = false
let lastSignature = ''
let catalogFiles: OutputFile[] | undefined, treeRevision = 0
const treeCache = new Map<string, { tree: OutputDir; count: number }>()

/** View state owns expansion; the catalog owns permissions, handles and scans. */
export function renderOutputSourcesView(): void {
  const host = document.getElementById('outputsDirTree')
  if (!host) return
  const state = useOutputStore.getState()
  const sources = outputSources()
  if (catalogFiles !== state.files) {
    catalogFiles = state.files; treeRevision++
    const grouped = new Map<string, string[]>()
    for (const file of state.files) { const id = file.sourceId || 'output'; if (!grouped.has(id)) grouped.set(id, []); grouped.get(id)!.push(file.path) }
    treeCache.clear()
    for (const [id, paths] of grouped) treeCache.set(id, { tree: buildDirTreeFromPaths(paths), count: paths.length })
  }
  const signature = JSON.stringify([state.currentSourceId, state.currentPath, sources.map(s => [s.id, s.enabled, s.permission]), treeRevision, [...expanded]])
  if (signature === lastSignature) return
  lastSignature = signature
  const total = state.files.filter(file => sourceForFile(file).enabled).length
  let html = `<div class="outputs-source-row ${!state.currentSourceId ? 'active' : ''}"><button type="button" class="outputs-source-open" data-source-id="" data-path="">${icon('images', 15)}<span>${tr("workspace.allSelectedFolders")}</span></button><span class="outputs-source-count">${total}</span></div>`
  const children = (dir: OutputDir, sourceId: string): string => dir.children.map(child => {
    const key = nodeKey(sourceId, child.path)
    const open = expanded.has(key)
    return `<div class="outputs-source-row ${state.currentSourceId === sourceId && state.currentPath === child.path ? 'active' : ''}">
      ${child.children.length ? `<button class="outputs-source-action" type="button" data-source-expand="${escAttr(key)}" aria-label="${open ? tr("workspace.collapse") : tr("workspace.expand")} ${escAttr(child.name)}" aria-expanded="${open}">${icon(open ? 'chevronDown' : 'chevronRight', 13)}</button>` : ''}
      <button type="button" class="outputs-source-open" data-source-id="${escAttr(sourceId)}" data-path="${escAttr(child.path)}" title="${escAttr(child.path)}">${icon('folder', 14)}<span>${esc(child.name)}</span></button><span class="outputs-source-count">${child.fileCount}</span>
    </div>${open ? `<div class="outputs-source-children">${children(child, sourceId)}</div>` : ''}`
  }).join('')
  for (const source of sources) {
    const cached = treeCache.get(source.id)
    const tree = cached?.tree || buildDirTreeFromPaths([], source.label)
    const open = expanded.has(source.id)
    html += `<div class="outputs-source-row ${state.currentSourceId === source.id && !state.currentPath ? 'active' : ''}">
      <input type="checkbox" data-source-enabled="${escAttr(source.id)}" ${source.enabled ? 'checked' : ''} aria-label="${tr("workspace.includeInAllImages2", { p3: escAttr(source.label) })}">
      <button type="button" class="outputs-source-action" data-source-expand="${escAttr(source.id)}" aria-label="${open ? tr("workspace.collapse") : tr("workspace.expand")} ${escAttr(source.label)}" aria-expanded="${open}">${icon(open ? 'chevronDown' : 'chevronRight', 13)}</button>
      <button type="button" class="outputs-source-open" data-source-id="${escAttr(source.id)}" data-path="" title="${escAttr(source.label)}">${icon(source.id === 'output' ? 'hardDrive' : 'folder', 15)}<span>${esc(source.label)}</span></button>
      <span class="outputs-source-count">${cached?.count || 0}</span>${source.id !== 'output' ? `<button type="button" class="outputs-source-action" data-source-menu="${escAttr(source.id)}" aria-label="${tr("workspace.folderActions", { p1: escAttr(source.label) })}" title="${tr("workspace.folderActions2")}">${icon('moreHorizontal', 14)}</button>` : ''}
    </div>`
    if (source.kind === 'directory' && source.permission !== 'granted') html += `<button class="outputs-source-permission" type="button" data-source-authorize="${escAttr(source.id)}">${tr("workspace.grantAccessTo", { p1: esc(source.label) })}</button>`
    if (open) html += `<div class="outputs-source-children">${children(tree, source.id)}</div>`
  }
  host.innerHTML = html
}

export function mountOutputSourcesView(onChange: () => void): void {
  if (mounted) return
  const host = document.getElementById('outputsDirTree')
  if (!host) return
  mounted = true
  host.addEventListener('change', async event => {
    const check = (event.target as HTMLElement).closest<HTMLInputElement>('[data-source-enabled]')
    if (!check) return
    try { await setOutputSourceEnabled(check.dataset.sourceEnabled!, check.checked); onChange() }
    catch { showToast(tr("workspace.couldNotSaveFolderSelection")); renderOutputSourcesView() }
  })
  host.addEventListener('click', async event => {
    const target = event.target as HTMLElement
    const menu = target.closest<HTMLElement>('[data-source-menu]')
    if (menu) {
      const id = menu.dataset.sourceMenu!, rect = menu.getBoundingClientRect()
      const perform = async (operation: () => Promise<unknown>) => { try { await operation(); onChange() } catch (error) { showToast(tr("workspace.folderActionFailed", { p0: (error as Error).message })) } }
      openContextMenu(rect.right, rect.bottom, [{ items: [
        { label: tr("workspace.refreshThisFolder"), icon: 'refreshCw', handler: () => { void perform(() => scanOutputSource(id)) } },
        { label: tr("workspace.removeFromLibraryKeepImagesFavoritesAnd"), icon: 'folder', handler: () => { void perform(() => removeOutputSource(id)) } },
      ] }])
      return
    }
    const toggle = target.closest<HTMLElement>('[data-source-expand]')
    if (toggle) {
      const key = toggle.dataset.sourceExpand!
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key)
      renderOutputSourcesView()
      return
    }
    const open = target.closest<HTMLElement>('[data-source-id]')
    if (open) { useOutputStore.getState().setCurrentSource(open.dataset.sourceId || '', open.dataset.path || ''); onChange(); return }
    const remove = target.closest<HTMLElement>('[data-source-remove]')
    if (remove) { try { await removeOutputSource(remove.dataset.sourceRemove!); onChange() } catch (error) { showToast(tr("workspace.couldNotRemove", { p0: (error as Error).message })) }; return }
    const authorize = target.closest<HTMLElement>('[data-source-authorize]')
    if (authorize) {
      try {
        const id = authorize.dataset.sourceAuthorize!
        if (await requestOutputSourcePermission(id)) { await scanOutputSource(id); onChange() }
        else showToast(tr("workspace.folderAccessWasNotGrantedYouCan"))
      } catch { showToast(tr("workspace.couldNotGrantAccessAddThisFolder")) }
    }
  })
  renderOutputSourcesView()
}
