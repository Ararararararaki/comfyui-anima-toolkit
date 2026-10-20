import { t as tr } from '../i18n'
import { icon } from '../utils/icon'
import { esc } from '../utils'

export interface ContextMenuAction {
  label: string
  icon?: string
  shortcut?: string
  handler: () => void
  danger?: boolean
  disabled?: boolean
  children?: ContextMenuAction[]
  /** 勾选型条目：点击后菜单保持打开（handler 可更新自身 label 反映 ☑/☐），用于连续多选 */
  sticky?: boolean
}

export interface ContextMenuGroup {
  label?: string
  items: ContextMenuAction[]
}

let _activeMenu: HTMLElement | null = null
let _activeSubMenu: HTMLElement | null = null
let _subMenuTimer: number | null = null
let _keyboardOrigin: HTMLElement | null = null

function bindMenuKeys(menu: HTMLElement, parent?: HTMLElement): void {
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])')]
    const active = document.activeElement as HTMLElement
    const index = items.indexOf(active)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next].focus()
    } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight' && active?.classList.contains('has-submenu')) {
      event.preventDefault(); active?.click()
    } else if (event.key === 'ArrowLeft' && parent) {
      event.preventDefault(); closeSubMenu(); parent.focus()
    }
  })
}

/** 菜单图标：图标名 → SVG，非图标名（如旧 emoji）原样返回（兜底值转义防误用） */
function menuIcon(name: string): string {
  const svg = icon(name, 14)
  return svg || `${esc(name)} `
}

/** 取消待执行的子菜单关闭 */
function cancelCloseSubMenu() {
  if (_subMenuTimer !== null) {
    clearTimeout(_subMenuTimer)
    _subMenuTimer = null
  }
}

/**
 * 延迟关闭子菜单：鼠标从父项移向子菜单时会经过两者间的间隙，
 * 立即关闭会导致子菜单无法点击。延迟后在间隙时间内进入子菜单即取消关闭。
 */
function scheduleCloseSubMenu(delay = 160) {
  cancelCloseSubMenu()
  _subMenuTimer = window.setTimeout(() => {
    _subMenuTimer = null
    closeSubMenu()
  }, delay)
}

/**
 * 打开右键菜单
 * @param x 鼠标 X 坐标
 * @param y 鼠标 Y 坐标
 * @param groups 菜单分组列表
 */
export function openContextMenu(
  x: number,
  y: number,
  groups: ContextMenuGroup[],
  focus = false
) {
  closeContextMenu()
  if (focus) _keyboardOrigin = document.activeElement as HTMLElement | null

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.style.cssText = `left:${x}px;top:${y}px;`
  menu.setAttribute('role', 'menu')

  groups.forEach((group, gi) => {
    if (gi > 0) {
      const sep = document.createElement('div')
      sep.className = 'context-menu-sep'
      menu.appendChild(sep)
    }

    if (group.label) {
      const label = document.createElement('div')
      label.className = 'context-menu-label'
      label.textContent = group.label
      menu.appendChild(label)
    }

    group.items.forEach(item => {
      const el = document.createElement('div')
      el.className = `context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`
      el.setAttribute('role', 'menuitem')
      el.tabIndex = item.disabled ? -1 : 0
      if (item.disabled) {
        el.setAttribute('aria-disabled', 'true')
      }

      if (item.children && item.children.length > 0) {
        // 有子菜单
        el.classList.add('has-submenu')
        el.setAttribute('aria-haspopup', 'menu')
        el.addEventListener('click', event => {
          event.stopPropagation()
          if (item.disabled) return
          openSubMenu(el, item.children!, x, y)
          if (event.detail === 0) _activeSubMenu?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
        })

        const labelSpan = document.createElement('span')
        labelSpan.className = 'context-menu-item-label'
        labelSpan.innerHTML = item.icon ? `${menuIcon(item.icon)}${esc(item.label)}` : esc(item.label)
        el.appendChild(labelSpan)

        const arrow = document.createElement('span')
        arrow.className = 'context-menu-arrow'
        arrow.textContent = '▶'
        el.appendChild(arrow)

        // 子菜单
        el.addEventListener('mouseenter', (e) => {
          cancelCloseSubMenu()
          openSubMenu(el, item.children!, x, y)
        })
        el.addEventListener('mouseleave', () => {
          scheduleCloseSubMenu()
        })
      } else {
        el.innerHTML = `<span class="context-menu-item-label">${item.icon ? `${menuIcon(item.icon)}${esc(item.label)}` : esc(item.label)}</span>`
        if (item.shortcut) {
          const shortcut = document.createElement('span')
          shortcut.className = 'context-menu-shortcut'
          shortcut.textContent = item.shortcut
          el.appendChild(shortcut)
        }

        el.addEventListener('click', (e) => {
          e.stopPropagation()
          if (!item.disabled) {
            if (item.sticky) {
              // 勾选型条目：不关菜单，handler 内可改 item.label，这里同步刷新显示
              item.handler()
              const labelEl = el.querySelector('.context-menu-item-label')
              if (labelEl) labelEl.innerHTML = item.icon ? `${menuIcon(item.icon)}${esc(item.label)}` : esc(item.label)
            } else {
              closeContextMenu()
              item.handler()
            }
          }
        })
      }

      menu.appendChild(el)
    })
  })

  document.body.appendChild(menu)
  _activeMenu = menu
  bindMenuKeys(menu)
  if (focus) menu.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()

  // 确保菜单在视口内
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let adjustedX = x
    let adjustedY = y

    if (rect.right > vw) adjustedX = vw - rect.width - 4
    if (rect.bottom > vh) adjustedY = vh - rect.height - 4
    if (adjustedX < 4) adjustedX = 4
    if (adjustedY < 4) adjustedY = 4

    menu.style.left = `${adjustedX}px`
    menu.style.top = `${adjustedY}px`
    menu.classList.add('context-menu-visible')
  })
}

function openSubMenu(parentEl: HTMLElement, items: ContextMenuAction[], parentX: number, parentY: number) {
  cancelCloseSubMenu()
  closeSubMenu()

  const sub = document.createElement('div')
  sub.className = 'context-menu context-submenu'
  sub.setAttribute('role', 'menu')

  items.forEach(item => {
    const el = document.createElement('div')
    el.className = `context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`
    el.setAttribute('role', 'menuitem')
    el.tabIndex = item.disabled ? -1 : 0
    if (item.disabled) el.setAttribute('aria-disabled', 'true')
    el.innerHTML = `<span class="context-menu-item-label">${item.icon ? `${menuIcon(item.icon)}${esc(item.label)}` : esc(item.label)}</span>`
    if (item.shortcut) {
      const shortcut = document.createElement('span')
      shortcut.className = 'context-menu-shortcut'
      shortcut.textContent = item.shortcut
      el.appendChild(shortcut)
    }
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!item.disabled) {
        if (item.sticky) {
          // 勾选型条目：不关菜单，handler 内可改 item.label，这里同步刷新显示
          item.handler()
          const labelEl = el.querySelector('.context-menu-item-label')
          if (labelEl) labelEl.innerHTML = item.icon ? `${menuIcon(item.icon)}${esc(item.label)}` : esc(item.label)
        } else {
          closeContextMenu()
          item.handler()
        }
      }
    })
    sub.appendChild(el)
  })

  // 子菜单悬停时取消父项 mouseleave 的延迟关闭，允许鼠标跨间隙移入子菜单
  sub.addEventListener('mouseenter', () => cancelCloseSubMenu())
  sub.addEventListener('mouseleave', () => scheduleCloseSubMenu())

  // 定位子菜单位于父菜单右侧
  const parentRect = parentEl.getBoundingClientRect()
  sub.style.cssText = `left:${parentRect.right}px;top:${parentRect.top}px;`

  requestAnimationFrame(() => {
    const rect = sub.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let l = parentRect.right
    let t = parentRect.top
    if (rect.right > vw) l = parentRect.left - rect.width
    if (rect.bottom > vh) t = vh - rect.height - 4
    sub.style.left = `${l}px`
    sub.style.top = `${t}px`
    sub.classList.add('context-menu-visible')
  })

  document.body.appendChild(sub)
  _activeSubMenu = sub
  bindMenuKeys(sub, parentEl)
}

function closeSubMenu() {
  if (_activeSubMenu) {
    _activeSubMenu.remove()
    _activeSubMenu = null
  }
}

/**
 * 关闭右键菜单
 */
export function closeContextMenu() {
  cancelCloseSubMenu()
  closeSubMenu()
  if (_activeMenu) {
    _activeMenu.remove()
    _activeMenu = null
  }
  if (_keyboardOrigin?.isConnected) _keyboardOrigin.focus()
  _keyboardOrigin = null
}

// ── 全局事件绑定 ──

// 点击其他区域关闭菜单
document.addEventListener('click', (e) => {
  if (_activeMenu && !_activeMenu.contains(e.target as Node)) {
    closeContextMenu()
  }
})

// Esc 键关闭菜单
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _activeMenu) {
    closeContextMenu()
    e.preventDefault()
  }
})

// 窗口尺寸变化时关闭菜单
window.addEventListener('resize', closeContextMenu)

// ── 便捷工厂函数 ──

/**
 * 从输出文件 ID 列表构建菜单分组
 * 配合 Outputs 模块使用的快捷工厂
 */
export function createOutputContextMenu(
  fileIds: string[],
  handlers: {
    onPreview?: (id: string) => void
    onFavorite?: (id: string) => void
    onRename?: (id: string) => void
    onDelete?: (id: string) => void
    onRate?: (id: string) => void
    onCopyMetadata?: (id: string) => void
    onCopyPrompt?: (id: string) => void
    onSavePrompt?: (id: string) => void
    onCopyLoras?: (id: string) => void
    onWorkflow?: (id: string) => void
    onMetadata?: (id: string) => void
    onExport?: (ids: string[], action: 'copy' | 'download', mode: 'original' | 'clean') => void
    onPin?: (id: string, pinned: boolean) => void
    onCopyImage?: (id: string) => void
    onDownloadImage?: (id: string) => void
    onBatchFavorite?: (ids: string[]) => void
    onBatchDelete?: (ids: string[]) => void
    onBatchRate?: (ids: string[]) => void
    onBatchPin?: (ids: string[], pinned: boolean) => void
    onBatchCopyImage?: (ids: string[]) => void
    onBatchDownloadImage?: (ids: string[]) => void
    onSetCategory?: (ids: string[]) => void
  }
): ContextMenuGroup[] {
  const groups: ContextMenuGroup[] = []

  if (fileIds.length === 1) {
    const id = fileIds[0]
    groups.push({
      items: [
        { label: tr("workspace.preview"), icon: 'eye', handler: () => handlers.onPreview?.(id), shortcut: 'Enter' },
        { label: tr("workspace.favorite"), icon: 'star', handler: () => handlers.onFavorite?.(id) },
        { label: tr("workspace.rate"), icon: 'thumbsUp', handler: () => handlers.onRate?.(id) },
        { label: tr("workspace.pin"), icon: 'pin', handler: () => handlers.onPin?.(id, true) },
        { label: tr("workspace.setCategory"), icon: 'tag', handler: () => handlers.onSetCategory?.([id]) },
        { label: tr("workspace.copy"), icon: 'copy', handler: () => handlers.onCopyImage?.(id) },
        { label: tr("workspace.download"), icon: 'download', handler: () => handlers.onDownloadImage?.(id) },
        { label: tr("workspace.rename"), icon: 'edit3', handler: () => handlers.onRename?.(id), shortcut: 'F2' },
      ]
    })
    groups.push({
      items: [
        { label: tr("workspace.copyMetadata"), icon: 'file-text', handler: () => handlers.onCopyMetadata?.(id) },
        { label: tr("workspace.copyPrompt2"), icon: 'copy', handler: () => handlers.onCopyPrompt?.(id) },
        { label: tr("workspace.saveToPromptLibrary2"), icon: 'book', handler: () => handlers.onSavePrompt?.(id) },
        { label: tr("workspace.copyLoraTags"), icon: 'tag', handler: () => handlers.onCopyLoras?.(id) },
        { label: tr("workspace.downloadWorkflow"), icon: 'fileJson', handler: () => handlers.onWorkflow?.(id) },
        { label: tr("workspace.viewMetadata"), icon: 'info', handler: () => handlers.onMetadata?.(id) },
      ]
    })
    groups.push({
      items: [
        { label: tr("workspace.delete"), icon: 'trash', handler: () => handlers.onDelete?.(id), danger: true, shortcut: 'Del' },
      ]
    })
  } else if (fileIds.length > 1) {
    groups.push({
      label: tr("workspace.filesSelected", { p0: fileIds.length }),
      items: [
        { label: tr("workspace.favoriteSelected"), icon: 'star', handler: () => handlers.onBatchFavorite?.(fileIds) },
        { label: tr("workspace.rateSelected"), icon: 'thumbsUp', handler: () => handlers.onBatchRate?.(fileIds) },
        { label: tr("workspace.pinSelected"), icon: 'pin', handler: () => handlers.onBatchPin?.(fileIds, true) },
        { label: tr("workspace.categorizeSelected2"), icon: 'tag', handler: () => handlers.onSetCategory?.(fileIds) },
        { label: tr("workspace.copySelected"), icon: 'copy', handler: () => handlers.onBatchCopyImage?.(fileIds) },
        { label: tr("workspace.downloadSelected"), icon: 'download', handler: () => handlers.onBatchDownloadImage?.(fileIds) },
        { label: tr("workspace.deleteSelected"), icon: 'trash', handler: () => handlers.onBatchDelete?.(fileIds), danger: true },
      ]
    })
  }

  if (fileIds.length && handlers.onExport) groups.splice(groups.length - 1, 0, {
    label: tr("workspace.exportCopy"), items: [
      { label: tr("workspace.copyOptions"), icon: 'copy', handler: () => {}, children: [
        { label: tr("workspace.copyOriginal"), handler: () => handlers.onExport?.(fileIds, 'copy', 'original') },
        { label: tr("workspace.copyWithoutGenerationMetadata"), handler: () => handlers.onExport?.(fileIds, 'copy', 'clean') },
      ] },
      { label: tr("workspace.downloadOptions"), icon: 'download', handler: () => {}, children: [
        { label: tr("workspace.downloadOriginal"), handler: () => handlers.onExport?.(fileIds, 'download', 'original') },
        { label: tr("workspace.downloadWithoutGenerationMetadata"), handler: () => handlers.onExport?.(fileIds, 'download', 'clean') },
      ] },
    ],
  })
  return groups
}
