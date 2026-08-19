import { useOutputStore } from '../store/outputStore'

export interface OutputGridGeometry {
  cols: number
  gap: number
  cardW: number
  rowH: number
}

export interface OutputDragSelectionOptions {
  getGridGeometry: (width: number) => OutputGridGeometry
  onSelectionChanged: () => void
}

let initialized = false

/**
 * Outputs 框选状态机。网格模式以“内容坐标”锚定起点，因此按住鼠标并用滚轮跨行时，
 * 起始图片不会随 scrollTop 平移出选区；滚动可以一直扩展到数据末尾。
 */
export function initOutputDragSelection(options: OutputDragSelectionOptions): void {
  if (initialized) return
  initialized = true

  let isDragging = false
  let startPageX = 0, startPageY = 0
  let startContentX = 0, startContentY = 0
  let currentClientX = 0, currentClientY = 0
  let dragGrid: HTMLElement | null = null
  let dragMoved = false
  let additiveSelection = false
  let selectionAtStart = new Set<string>()
  let rectEl: HTMLElement | null = null
  let justBoxed = false

  function getGridCardIdsInRect(l: number, t: number, r: number, b: number, grid: HTMLElement): string[] {
    const state = useOutputStore.getState()
    if (grid.clientWidth <= 0) return []
    const geom = options.getGridGeometry(grid.clientWidth)
    const files = state.filteredFiles
    const maxRow = Math.max(0, Math.ceil(files.length / geom.cols) - 1)
    const firstRow = Math.min(maxRow, Math.max(0, Math.floor(t / geom.rowH)))
    const lastRow = Math.min(maxRow, Math.max(0, Math.floor(b / geom.rowH)))
    const firstCol = Math.min(geom.cols - 1, Math.max(0, Math.floor(l / (geom.cardW + geom.gap))))
    const lastCol = Math.min(geom.cols - 1, Math.max(0, Math.floor(r / (geom.cardW + geom.gap))))
    const ids: string[] = []
    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = firstCol; col <= lastCol; col++) {
        const file = files[row * geom.cols + col]
        if (file) ids.push(file.id)
      }
    }
    return ids
  }

  function getListCardIdsInRect(l: number, t: number, r: number, b: number): string[] {
    const ids: string[] = []
    const sx = window.scrollX, sy = window.scrollY
    document.querySelectorAll('.outputs-card, .outputs-list-card').forEach(el => {
      const cr = el.getBoundingClientRect()
      const cardL = cr.left + sx, cardT = cr.top + sy
      const cardR = cr.right + sx, cardB = cr.bottom + sy
      if (l < cardR && r > cardL && t < cardB && b > cardT) {
        const id = (el as HTMLElement).dataset.id
        if (id) ids.push(id)
      }
    })
    return ids
  }

  function applySelectedIds(ids: string[]): void {
    const next = additiveSelection ? new Set([...selectionAtStart, ...ids]) : new Set(ids)
    const prev = useOutputStore.getState().selectedIds
    if (prev.size === next.size && Array.from(next).every(id => prev.has(id))) return
    useOutputStore.setState({ selectedIds: next })
    const batchCount = document.getElementById('outputsBatchCount')
    if (batchCount) batchCount.textContent = `已选 ${next.size} 张`
    document.querySelectorAll('.outputs-card, .outputs-list-card').forEach(el => {
      const id = (el as HTMLElement).dataset.id
      if (id) el.classList.toggle('selected', next.has(id))
    })
    options.onSelectionChanged()
  }

  function updateGridDragSelection(): void {
    if (!isDragging || !dragGrid || !rectEl) return
    const gridRect = dragGrid.getBoundingClientRect()
    const currentContentX = currentClientX - gridRect.left + dragGrid.scrollLeft
    const currentContentY = currentClientY - gridRect.top + dragGrid.scrollTop
    const l = Math.min(startContentX, currentContentX)
    const t = Math.min(startContentY, currentContentY)
    const r = Math.max(startContentX, currentContentX)
    const b = Math.max(startContentY, currentContentY)

    const startClientX = gridRect.left + startContentX - dragGrid.scrollLeft
    const startClientY = gridRect.top + startContentY - dragGrid.scrollTop
    const clampX = (x: number) => Math.max(gridRect.left, Math.min(gridRect.right, x))
    const clampY = (y: number) => Math.max(gridRect.top, Math.min(gridRect.bottom, y))
    const visualL = Math.min(clampX(startClientX), clampX(currentClientX))
    const visualT = Math.min(clampY(startClientY), clampY(currentClientY))
    const visualR = Math.max(clampX(startClientX), clampX(currentClientX))
    const visualB = Math.max(clampY(startClientY), clampY(currentClientY))
    rectEl.style.left = visualL + 'px'
    rectEl.style.top = visualT + 'px'
    rectEl.style.width = Math.max(0, visualR - visualL) + 'px'
    rectEl.style.height = Math.max(0, visualB - visualT) + 'px'

    if (Math.abs(currentContentX - startContentX) > 5 || Math.abs(currentContentY - startContentY) > 5) {
      dragMoved = true
      applySelectedIds(getGridCardIdsInRect(l, t, r, b, dragGrid))
    }
  }

  document.addEventListener('mousedown', (event: Event) => {
    const mouse = event as MouseEvent
    const target = event.target as HTMLElement
    if (!target.closest('#sectionOutputs')) return
    const grid = target.closest('.outputs-grid') as HTMLElement | null
    if (!grid) return
    if (target.closest('.outputs-list-header, button, input, .outputs-empty, .outputs-toolbar, .outputs-batch-bar')) return
    if (mouse.button !== 0) return

    isDragging = true
    dragMoved = false
    dragGrid = grid
    currentClientX = mouse.clientX
    currentClientY = mouse.clientY
    additiveSelection = mouse.ctrlKey || mouse.metaKey || mouse.shiftKey
    selectionAtStart = new Set(useOutputStore.getState().selectedIds)
    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    event.preventDefault()

    startPageX = mouse.pageX
    startPageY = mouse.pageY
    const gridRect = grid.getBoundingClientRect()
    startContentX = mouse.clientX - gridRect.left + grid.scrollLeft
    startContentY = mouse.clientY - gridRect.top + grid.scrollTop

    if (!additiveSelection) {
      selectionAtStart.clear()
      useOutputStore.getState().clearSelection()
    }

    rectEl = document.createElement('div')
    rectEl.className = 'outputs-selection-rect'
    rectEl.style.cssText = `position:fixed;left:${mouse.clientX}px;top:${mouse.clientY}px;width:0;height:0;z-index:99999;pointer-events:none`
    document.body.appendChild(rectEl)
  })

  document.addEventListener('mousemove', (event: Event) => {
    const mouse = event as MouseEvent
    if (!isDragging || !rectEl) return
    currentClientX = mouse.clientX
    currentClientY = mouse.clientY

    if (useOutputStore.getState().viewMode === 'grid' && dragGrid) {
      updateGridDragSelection()
      return
    }

    const l = Math.min(startPageX, mouse.pageX)
    const t = Math.min(startPageY, mouse.pageY)
    const r = Math.max(startPageX, mouse.pageX)
    const b = Math.max(startPageY, mouse.pageY)
    const w = r - l, h = b - t
    rectEl.style.left = (l - window.scrollX) + 'px'
    rectEl.style.top = (t - window.scrollY) + 'px'
    rectEl.style.width = w + 'px'
    rectEl.style.height = h + 'px'
    if (w > 5 || h > 5) {
      dragMoved = true
      applySelectedIds(getListCardIdsInRect(l, t, r, b))
    }
  })

  document.querySelector('.outputs-grid')?.addEventListener('scroll', () => {
    if (isDragging && useOutputStore.getState().viewMode === 'grid') updateGridDragSelection()
  }, { passive: true })

  document.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    dragGrid = null
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    if (dragMoved && useOutputStore.getState().selectedIds.size > 0) justBoxed = true
    options.onSelectionChanged()
  })

  document.addEventListener('click', (event: Event) => {
    if (!justBoxed) return
    justBoxed = false
    event.preventDefault()
    event.stopPropagation()
  }, true)

  const cancelDrag = () => {
    if (!isDragging) return
    isDragging = false
    dragGrid = null
    document.body.style.userSelect = ''
    document.body.style.webkitUserSelect = ''
    if (rectEl) { rectEl.remove(); rectEl = null }
    options.onSelectionChanged()
  }
  window.addEventListener('blur', cancelDrag)
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelDrag() })
  document.addEventListener('mouseleave', cancelDrag)
}
