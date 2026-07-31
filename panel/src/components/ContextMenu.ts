// ── 轻量级右键菜单组件 ──
// Vanilla TS 实现，支持分组、分隔线、危险操作、子菜单

export interface ContextMenuAction {
  label: string
  icon?: string
  shortcut?: string
  handler: () => void
  danger?: boolean
  disabled?: boolean
  children?: ContextMenuAction[]
}

export interface ContextMenuGroup {
  label?: string
  items: ContextMenuAction[]
}

let _activeMenu: HTMLElement | null = null
let _activeSubMenu: HTMLElement | null = null

/**
 * 打开右键菜单
 * @param x 鼠标 X 坐标
 * @param y 鼠标 Y 坐标
 * @param groups 菜单分组列表
 */
export function openContextMenu(
  x: number,
  y: number,
  groups: ContextMenuGroup[]
) {
  closeContextMenu()

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
      if (item.disabled) {
        el.setAttribute('aria-disabled', 'true')
      }

      if (item.children && item.children.length > 0) {
        // 有子菜单
        el.classList.add('has-submenu')

        const labelSpan = document.createElement('span')
        labelSpan.className = 'context-menu-item-label'
        labelSpan.innerHTML = item.icon ? `${item.icon} ${item.label}` : item.label
        el.appendChild(labelSpan)

        const arrow = document.createElement('span')
        arrow.className = 'context-menu-arrow'
        arrow.textContent = '▶'
        el.appendChild(arrow)

        // 子菜单
        el.addEventListener('mouseenter', (e) => {
          openSubMenu(el, item.children!, x, y)
        })
        el.addEventListener('mouseleave', () => {
          closeSubMenu()
        })
      } else {
        el.innerHTML = `<span class="context-menu-item-label">${item.icon ? `${item.icon} ${item.label}` : item.label}</span>`
        if (item.shortcut) {
          const shortcut = document.createElement('span')
          shortcut.className = 'context-menu-shortcut'
          shortcut.textContent = item.shortcut
          el.appendChild(shortcut)
        }

        el.addEventListener('click', (e) => {
          e.stopPropagation()
          if (!item.disabled) {
            closeContextMenu()
            item.handler()
          }
        })
      }

      menu.appendChild(el)
    })
  })

  document.body.appendChild(menu)
  _activeMenu = menu

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
  closeSubMenu()

  const sub = document.createElement('div')
  sub.className = 'context-menu context-submenu'

  items.forEach(item => {
    const el = document.createElement('div')
    el.className = `context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`
    el.innerHTML = `<span class="context-menu-item-label">${item.icon ? `${item.icon} ${item.label}` : item.label}</span>`
    if (item.shortcut) {
      const shortcut = document.createElement('span')
      shortcut.className = 'context-menu-shortcut'
      shortcut.textContent = item.shortcut
      el.appendChild(shortcut)
    }
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!item.disabled) {
        closeContextMenu()
        item.handler()
      }
    })
    sub.appendChild(el)
  })

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
  closeSubMenu()
  if (_activeMenu) {
    _activeMenu.remove()
    _activeMenu = null
  }
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
    onPin?: (id: string, pinned: boolean) => void
    onCopyImage?: (id: string) => void
    onDownloadImage?: (id: string) => void
    onBatchFavorite?: (ids: string[]) => void
    onBatchDelete?: (ids: string[]) => void
    onBatchRate?: (ids: string[]) => void
    onBatchPin?: (ids: string[], pinned: boolean) => void
    onBatchCopyImage?: (ids: string[]) => void
    onBatchDownloadImage?: (ids: string[]) => void
  }
): ContextMenuGroup[] {
  const groups: ContextMenuGroup[] = []

  if (fileIds.length === 1) {
    const id = fileIds[0]
    groups.push({
      items: [
        { label: '预览', icon: '🔍', handler: () => handlers.onPreview?.(id), shortcut: 'Enter' },
        { label: '收藏', icon: '⭐', handler: () => handlers.onFavorite?.(id) },
        { label: '评分', icon: '🌟', handler: () => handlers.onRate?.(id) },
        { label: '置顶', icon: '📍', handler: () => handlers.onPin?.(id, true) },
        { label: '复制', icon: '📋', handler: () => handlers.onCopyImage?.(id) },
        { label: '下载', icon: '⬇️', handler: () => handlers.onDownloadImage?.(id) },
        { label: '重命名', icon: '✏️', handler: () => handlers.onRename?.(id), shortcut: 'F2' },
      ]
    })
    groups.push({
      items: [
        { label: '复制元数据', icon: '📋', handler: () => handlers.onCopyMetadata?.(id) },
        { label: '复制 Prompt', icon: '📝', handler: () => handlers.onCopyPrompt?.(id) },
      ]
    })
    groups.push({
      items: [
        { label: '删除', icon: '🗑️', handler: () => handlers.onDelete?.(id), danger: true, shortcut: 'Del' },
      ]
    })
  } else if (fileIds.length > 1) {
    groups.push({
      label: `已选 ${fileIds.length} 个文件`,
      items: [
        { label: '批量收藏', icon: '⭐', handler: () => handlers.onBatchFavorite?.(fileIds) },
        { label: '批量评分', icon: '🌟', handler: () => handlers.onBatchRate?.(fileIds) },
        { label: '批量置顶', icon: '📍', handler: () => handlers.onBatchPin?.(fileIds, true) },
        { label: '批量复制', icon: '📋', handler: () => handlers.onBatchCopyImage?.(fileIds) },
        { label: '批量下载', icon: '⬇️', handler: () => handlers.onBatchDownloadImage?.(fileIds) },
        { label: '批量删除', icon: '🗑️', handler: () => handlers.onBatchDelete?.(fileIds), danger: true },
      ]
    })
  }

  return groups
}
