// ── 命令面板（Cmd/Ctrl+K）──
// 快速搜索跳转：6 个主 tab + 打开设置 + 切换主题 + 常用操作。
// 无依赖、纯 DOM，便于内联到面板与节点。

import { icon } from '../utils/icon'
import { esc } from '../utils'
import { t } from '../i18n'

interface Command {
  id: string
  label: string
  hint: string
  iconName: string
  run: () => void
}

function buildCommands(): Command[] {
  return [
    { id: 'local', label: t('shell.localTitle'), hint: t('shell.commandLocalHint'), iconName: 'monitor', run: () => switchSectionSafe('local') },
    { id: 'lora', label: t('shell.loraTitle'), hint: t('shell.commandLoraHint'), iconName: 'package', run: () => switchSectionSafe('lora') },
    { id: 'artist', label: t('shell.artistTitle'), hint: t('shell.commandArtistHint'), iconName: 'brush', run: () => switchSectionSafe('artist') },
    { id: 'prompt', label: t('shell.promptTitle'), hint: t('shell.commandPromptHint'), iconName: 'book', run: () => switchSectionSafe('prompt') },
    { id: 'prompt-freq', label: t('shell.imageAnalysis'), hint: t('shell.commandImageHint'), iconName: 'image', run: () => switchSectionSafe('prompt-freq') },
    { id: 'outputs', label: t('shell.commandOutputs'), hint: t('shell.commandOutputsHint'), iconName: 'grid', run: () => switchSectionSafe('outputs') },
    { id: 'settings', label: t('shell.openSettings'), hint: t('shell.commandSettingsHint'), iconName: 'settings', run: () => document.getElementById('settingsBtn')?.click() },
    { id: 'theme-dark', label: t('shell.switchDarkTheme'), hint: t('shell.commandDarkHint'), iconName: 'moon', run: () => setTheme('mono') },
    { id: 'theme-light', label: t('shell.switchLightTheme'), hint: t('shell.commandLightHint'), iconName: 'sun', run: () => setTheme('mono-light') },
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
// 键盘导航当前高亮索引（每次打开重置）
let activeIdx = -1

function paletteEl(): HTMLElement | null {
  return document.getElementById(PALETTE_ID)
}

// 输入/键盘监听器只在 DOM 创建时绑定一次（具名函数 + open 守卫），
// 避免 openCommandPalette 每次打开都重复 addEventListener 造成监听器累积。
function handlePaletteInput(this: HTMLInputElement) {
  if (!paletteEl()?.classList.contains('open')) return
  const el = paletteEl()!
  renderCommands(el, this.value.trim())
}

function handlePaletteKeydown(e: KeyboardEvent) {
  const el = paletteEl()
  if (!el || !el.classList.contains('open')) return
  const listEl = el.querySelector('.cmdk-list') as HTMLElement
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
}

function openCommandPalette() {
  let el = paletteEl()
  if (!el) {
    el = document.createElement('div')
    el.id = PALETTE_ID
    el.className = 'cmdk-overlay'
    el.innerHTML = `
      <div class="cmdk-box" role="dialog" aria-label="${esc(t('shell.commandPalette'))}" aria-modal="true">
        <div class="cmdk-search">
          ${icon('search', 16)}
          <input type="text" class="cmdk-input" placeholder="${esc(t('shell.commandSearchPlaceholder'))}" autocomplete="off">
        </div>
        <div class="cmdk-list" role="listbox"></div>
        <div class="cmdk-footer">
          <span>${icon('arrowUp', 12)}${icon('arrowDown', 12)} ${esc(t('shell.commandChoose'))}</span>
          <span>${esc(t('shell.commandRun'))}</span>
          <span>${esc(t('shell.commandClose'))}</span>
        </div>
      </div>`
    document.body.appendChild(el)
    // 遮罩点击关闭
    el.addEventListener('mousedown', (e) => { if (e.target === el) closeCommandPalette() })
    // 一次性的输入/键盘监听器（见 handlePaletteInput/Keydown 注释）
    const input = el.querySelector('.cmdk-input') as HTMLInputElement
    input.addEventListener('input', handlePaletteInput)
    input.addEventListener('keydown', handlePaletteKeydown)
  }

  el.classList.add('open')
  activeIdx = -1
  const input = el.querySelector('.cmdk-input') as HTMLInputElement
  input.value = '' // 重开时清空上次的搜索词，与列表（空查询）保持一致
  renderCommands(el, '')
  // 聚焦输入框
  setTimeout(() => input?.focus(), 0)
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
    listEl.innerHTML = `<div class="cmdk-empty">${esc(t('shell.commandEmpty'))}</div>`
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
