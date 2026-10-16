/** Global section switcher. The shared tab controller remains the only section owner. */
export function initToolboxMenu(): () => void {
  const menu = document.getElementById('toolboxSidebar'), trigger = document.getElementById('toolboxFoldersToggle')
  if (!menu || !trigger) return () => {}
  const abort = new AbortController()
  const setOpen = (open: boolean, focus = false) => {
    menu.hidden = !open; trigger.setAttribute('aria-expanded', String(open))
    if (focus) (open ? menu.querySelector<HTMLElement>('.main-tab.active') : trigger)?.focus()
  }
  trigger.addEventListener('click', () => setOpen(menu.hidden, true), { signal: abort.signal })
  menu.addEventListener('click', event => { if ((event.target as HTMLElement).closest('.main-tab')) setOpen(false, true) }, { signal: abort.signal })
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node) && !trigger.contains(event.target as Node)) setOpen(false) }, { signal: abort.signal })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); setOpen(false, true) } }, { signal: abort.signal })
  trigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true, true) } }, { signal: abort.signal })
  return () => { abort.abort(); setOpen(false) }
}
