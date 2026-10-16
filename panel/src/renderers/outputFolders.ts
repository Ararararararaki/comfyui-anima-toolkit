import type { OutputFolder, OutputBrowseStep } from '../services/outputBrowser'
import type { OutputFile } from '../types/outputs'
import { esc, escAttr, icon } from '../utils'

export function renderOutputBreadcrumb(path: OutputBrowseStep[]): string {
  return `<button type="button" class="outputs-back" data-output-back aria-label="返回上级" ${path.length ? '' : 'disabled'}>${icon('chevronLeft', 18)}</button><nav class="outputs-breadcrumb" aria-label="图片浏览位置"><button type="button" data-output-depth="0">图片库</button>${path.map((step, index) => `${icon('chevronRight', 12)}${index === path.length - 1 ? `<span aria-current="page" title="${escAttr(step.label)}">${esc(step.label)}</span>` : `<button type="button" data-output-depth="${index + 1}">${esc(step.label)}</button>`}`).join('')}</nav>`
}
export function renderOutputFolder(folder: OutputFolder, thumbnail: (file: OutputFile) => { src: string; key: string; revision: string }): string {
  const covers = folder.kind === 'character' ? folder.covers.slice(0, 1) : folder.covers
  const images = covers.map((file, index) => {
    const image = thumbnail(file)
    return `<img class="outputs-folder-cover cover-${index}" src="${escAttr(image.src)}" data-file-id="${escAttr(file.id)}" data-file-path="${escAttr(file.path)}" data-cache-key="${escAttr(image.key)}" data-file-version="${escAttr(image.revision)}" alt="" draggable="false" loading="eager">`
  }).join('')
  const directory = folder.kind === 'source' || folder.kind === 'directory'
  return `<div class="outputs-folder ${directory ? 'directory' : folder.kind === 'work' ? 'work-deck' : 'character'}" data-output-folder="${escAttr(folder.key)}" role="button" tabindex="0" aria-label="打开 ${escAttr(folder.label)}，${folder.count} 张图片" title="双击进入 ${escAttr(folder.label)}">
    <div class="outputs-folder-art">${images || `<span class="outputs-folder-empty" aria-hidden="true">${icon(directory ? 'folder' : 'images', 36)}</span>`}${directory ? `<span class="outputs-folder-mark">${icon('folder', 20)}</span>` : ''}</div>
    <div class="outputs-folder-label"><strong>${esc(folder.label)}</strong>${folder.subtitle ? `<small title="${escAttr(folder.subtitle)}">${esc(folder.subtitle)}</small>` : ''}<span>${folder.count.toLocaleString()} 张图片</span></div>
    ${folder.source ? `<button type="button" class="outputs-folder-more" data-output-source-menu="${escAttr(folder.source.id)}" aria-label="${escAttr(folder.label)} 目录操作" aria-haspopup="menu">${icon('moreHorizontal', 18)}</button>` : ''}
  </div>`
}

export function outputFolderLayout(folders: OutputFolder[], width: number): { items: Array<{ folder: OutputFolder; key: string; top: number; left: number; width: number; height: number }>; total: number } {
  const gap = 28, targetWidth = folders[0]?.kind === 'character' ? 224 : folders[0]?.kind === 'work' ? 360 : 254
  const cols = Math.max(1, Math.floor((width + gap) / targetWidth)), cardW = (width - (cols - 1) * gap) / cols
  const directory = folders.every(folder => folder.kind === 'source' || folder.kind === 'directory')
  const height = directory ? Math.min(230, cardW * .6 + 94) : cardW * (folders[0]?.kind === 'work' ? .94 : .9) + 90
  return { items: folders.map((folder, index) => ({ folder, key: folder.key, top: Math.floor(index / cols) * (height + gap), left: index % cols * (cardW + gap), width: cardW, height })), total: folders.length ? Math.ceil(folders.length / cols) * (height + gap) : 0 }
}
