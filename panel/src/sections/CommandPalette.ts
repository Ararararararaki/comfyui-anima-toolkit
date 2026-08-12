// ── 命令面板（Cmd/Ctrl+K）──
// 快速搜索跳转：6 个主 tab + 打开设置 + 切换主题 + 常用操作。
// 无依赖、纯 DOM，便于内联到面板与节点。

import { icon } from '../utils/icon'
import { esc } from '../utils'

interface Command {
  id: string
  label: string
  hint: string
  iconName: string
  run: () => void
}

function buildCommands(): Command[] {
  return [
    { id: 'local', label: '本地 LoRA 管理', hint: '扫描 / 分类 / 发送', iconName: 'monitor', run: () => switchSectionSafe('local') },
    { id: 'lora', label: 'LoRA 探索', hint: 'C 站浏览 / 下载', iconName: 'package', run: () => switchSectionSafe('lora') },
    { id: 'artist', label: '画师系列', hint: '画师串 / 预设', iconName: 'brush', run: () => switchSectionSafe('artist') },
    { id: 'prompt', label: 'Prompt 库', hint: '提示词归档 / 搜索', iconName: 'book', run: () => switchSectionSafe('prompt') },
    { id: 'prompt-freq', label: '图片解析', hint: 'PNG 元数据 / 高频词', iconName: 'image', run: () => switchSectionSafe('prompt-freq') },
    { id: 'outputs', label: 'Outputs 图片管理', hint: '返图浏览 / 收藏 / 编辑', iconName: 'grid', run: () => switchSectionSafe('outputs') },
    { id: 'settings', label: '打开设置', hint: '主题 / 布局 / API Key', iconName: 'settings', run: () => document.getElementById('settingsBtn')?.click() },
    { id: 'theme-dark', label: '切换暗色主题', hint: 'Monochrome 暗', iconName: 'palette', run: () => setTheme('mono') },
    { id: 'theme-light', label: '切换亮色主题', hint: 'Monochrome 亮', iconName: 'palette', run: () => setTheme('mono-light') },
  ]
}

function switchSectionSafe(id: string) {
  // switchSection 在 LoraExplorer 中导出；动态取 window 上暴露的引用避免循环依赖
  const fn = (window as any).__animaSwitchSection
  if (typeof fn === 'function') fn(id)
}

function setTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('anima_theme', theme)
  document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', (d as HTMLElement).dataset.theme === theme))
}

const PALETTE_ID = 'commandPalette'

function paletteEl(): HTMLElement | null {
  return document.getElementById(PALETTE_ID)
}

function openCommandPalette() {
  let el = paletteEl()
  if (!el) {
    el = document.createElement('div')
    el.id = PALETTE_ID
    el.className = 'cmdk-overlay'
    el.innerHTML = `
      <div class="cmdk-box" role="dialog" aria-label="命令面板" aria-modal="true">
        <div class="cmdk-search">
          ${icon('search', 16)}
          <input type="text" class="cmdk-input" placeholder="搜索命令…（↑↓ 选择，Enter 执行，Esc 关闭）" autocomplete="off">
        </div>
        <div class="cmdk-list" role="listbox"></div>
        <div class="cmdk-footer">
          <span>${icon('arrowUp', 12)}${icon('arrowDown', 12)} 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>`
    document.body.appendChild(el)
    // 遮罩点击关闭
    el.addEventListener('mousedown', (e) => { if (e.target === el) closeCommandPalette() })
  }

  el.classList.add('open')
  const input = el.querySelector('.cmdk-input') as HTMLInputElement
  renderCommands(el, '')
  // 聚焦输入框
  setTimeout(() => input?.focus(), 0)
  let activeIdx = -1
  const listEl = el.querySelector('.cmdk-list') as HTMLElement

  input?.addEventListener('input', () => {
    renderCommands(el!, input.value.trim())
  })

  input?.addEventListener('keydown', (e) => {
    const items = Array.from(listEl.querySelectorAll('.cmdk-item')) as HTMLElement[]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      activeIdx = e.key === 'ArrowDown'
        ? (activeIdx + 1) % items.length
        : (activeIdx - 1 + items.length) % items.length
      items.forEach((it, i) => it.classList.toggle('active', i === activeIdx))
      items[activeIdx]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const active = items[activeIdx]
      if (active) (active as any).__cmd?.run()
      else if (items.length === 1) (items[0] as any).__cmd?.run()
      closeCommandPalette()
    } else if (e.key === 'Escape') {
      closeCommandPalette()
    }
  })
}

function closeCommandPalette() {
  paletteEl()?.classList.remove('open')
}

function renderCommands(el: HTMLElement, query: string) {
  const listEl = el.querySelector('.cmdk-list') as HTMLElement
  const q = query.toLowerCase()
  const cmds = buildCommands().filter(c =>
    !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
  )
  if (!cmds.length) {
    listEl.innerHTML = `<div class="cmdk-empty">无匹配命令</div>`
    return
  }
  listEl.innerHTML = cmds.map(c => `
    <div class="cmdk-item" role="option" data-cmd="${c.id}">
      <span class="cmdk-icon">${icon(c.iconName, 16)}</span>
      <span class="cmdk-label">${esc(c.label)}</span>
      <span class="cmdk-hint">${esc(c.hint)}</span>
    </div>`).join('')
  // 绑定 run
  listEl.querySelectorAll('.cmdk-item').forEach((node, i) => {
    const cmd = cmds[i]
    ;(node as any).__cmd = cmd
    node.addEventListener('click', () => { cmd.run(); closeCommandPalette() })
    node.addEventListener('mouseenter', () => {
      listEl.querySelectorAll('.cmdk-item').forEach(it => it.classList.remove('active'))
      node.classList.add('active')
    })
  })
}

export function initCommandPalette() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      if (paletteEl()?.classList.contains('open')) closeCommandPalette()
      else openCommandPalette()
    }
  })
}

export { openCommandPalette, closeCommandPalette }
