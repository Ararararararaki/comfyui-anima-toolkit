import { t as tr } from '../i18n'
import { openModal, closeModal } from '../components/Modal'
import { icon } from '../utils/icon'

interface Release { version: string; date: string; sections: { title: string; items: string[] }[] }
declare const __TK_RELEASE__: Release
export const QQ_GROUP = '758086740'

/** A version is acknowledged only after its notice has actually been displayed. */
export function initReleaseNotes(): () => void {
  const release = __TK_RELEASE__
  const key = `tk_toolkit_release_seen:${release.version}`
  const abort = new AbortController()
  let displayed = false
  const hasSeen = () => {
    if (displayed) return true
    try { return localStorage.getItem(key) === '1' } catch { return false }
  }
  const modal = document.createElement('div')
  modal.id = 'releaseNotesModal'
  modal.className = 'modal-overlay release-notes-overlay'
  modal.innerHTML = `<section class="modal-box release-notes-box" role="dialog" aria-modal="true" aria-labelledby="releaseNotesTitle" aria-describedby="releaseNotesIntro">
    <header class="release-notes-header"><div><span class="release-notes-kicker">TK Toolkit · ${release.version}</span><h3 id="releaseNotesTitle">${tr("workspace.releaseNotes")}</h3></div><button type="button" class="icon-btn" data-close aria-label="${tr("workspace.closeReleaseNotes")}">${icon('x', 18)}</button></header>
    <div class="release-notes-body"><p id="releaseNotesIntro" class="release-notes-intro">${tr("workspace.shownAutomaticallyOncePerVersionReopenFrom", { p2: release.date })}</p><div id="releaseNotesChanges"></div>
    <section class="release-notes-bridge"><h4>${tr("workspace.dragImagesToPixiv")}</h4><p>${tr("workspace.onLocalChromeOrEdgeDownloadAnd")}</p><a class="btn btn-sm" href="./tk-pixiv-drop-bridge.zip" download="TK-Pixiv接收桥.zip">${tr("workspace.downloadPixivBridge", { p3: icon('download', 14) })}</a></section></div>
    <footer class="release-notes-footer"><div class="release-notes-community"><span>${tr("workspace.qqCommunity")} <strong>${QQ_GROUP}</strong></span><button type="button" class="btn btn-sm btn-ghost" data-copy-group>${tr("workspace.copyGroupNumber", { p5: icon('copy', 14) })}</button><span class="release-notes-status" role="status" aria-live="polite"></span></div><button type="button" class="btn btn-primary" data-close data-primary>${tr("workspace.getStarted")}</button></footer>
  </section>`
  const changes = modal.querySelector('#releaseNotesChanges')!
  for (const section of release.sections) {
    const group = document.createElement('section'), title = document.createElement('h4'), list = document.createElement('ul')
    title.textContent = section.title
    for (const text of section.items) { const item = document.createElement('li'); item.textContent = text; list.append(item) }
    group.append(title, list); changes.append(group)
  }
  document.body.append(modal)
  const close = () => closeModal(modal.id)
  modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close, { signal: abort.signal }))
  modal.addEventListener('click', event => { if (event.target === modal) close() }, { signal: abort.signal })
  modal.querySelector('[data-copy-group]')?.addEventListener('click', async () => {
    const status = modal.querySelector<HTMLElement>('.release-notes-status')!
    try { await navigator.clipboard.writeText(QQ_GROUP); status.textContent = tr("workspace.groupNumberCopied") }
    catch { status.textContent = tr("workspace.selectTheGroupNumberAndCopyIt") }
  }, { signal: abort.signal })
  const show = () => {
    openModal(modal.id)
    displayed = true
    try { localStorage.setItem(key, '1') } catch { /* Restricted storage must not break the manager. */ }
  }
  document.getElementById('releaseNotesBtn')?.addEventListener('click', show, { signal: abort.signal })
  const observer = new MutationObserver(() => tryAutoShow())
  const tryAutoShow = () => {
    if (hasSeen()) { observer.disconnect(); return }
    if (document.hidden || document.querySelector('.modal-overlay.open, .lightbox.open, .cmdk-overlay.open')) return
    show(); observer.disconnect()
  }
  if (!hasSeen()) {
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] })
    document.addEventListener('visibilitychange', tryAutoShow, { signal: abort.signal })
    tryAutoShow()
  }
  return () => { abort.abort(); observer.disconnect(); modal.remove() }
}
