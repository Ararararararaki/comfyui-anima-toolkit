/** Pixel editing owns gestures/history; the preview owns the current full-size canvas. */
export function createOutputPainter(options: {
  canvas: HTMLCanvasElement
  get: () => HTMLCanvasElement | null
  set: (canvas: HTMLCanvasElement) => void
  changed: () => void
  busy: () => boolean
}) {
  type Mode = 'view' | 'pen' | 'mosaic' | 'cover'
  let mode: Mode = 'view', color = '#000000', size = 24, mosaicSize = 8, mosaicStrength = 1
  type Mosaic = { source: HTMLCanvasElement; x: number; y: number; width: number; height: number }
  let lastMosaic: Mosaic | null = null
  let stroke: { id: number; x: number; y: number; lastX: number; lastY: number } | null = null
  const history: HTMLCanvasElement[] = []
  const cv = options.canvas
  const draw = () => {
    const base = options.get()
    if (!base) return
    if (cv.width !== base.width || cv.height !== base.height) { cv.width = base.width; cv.height = base.height }
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(base, 0, 0)
  }
  const checkpoint = () => {
    lastMosaic = null
    const base = options.get()
    if (!base) return
    const bytes = base.width * base.height * 4
    while (history.length && (history.length >= 8 || history.reduce((sum, c) => sum + c.width * c.height * 4, 0) + bytes > 64 * 1024 * 1024)) history.shift()
    // Keep one undo even for large images; never retain an unbounded stroke history.
    const copy = document.createElement('canvas'); copy.width = base.width; copy.height = base.height
    copy.getContext('2d')!.drawImage(base, 0, 0); history.push(copy)
  }
  const point = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect(), base = options.get()!
    return { x: Math.max(0, Math.min(base.width, (e.clientX - r.left) * base.width / r.width)), y: Math.max(0, Math.min(base.height, (e.clientY - r.top) * base.height / r.height)) }
  }
  const line = (x: number, y: number, toX: number, toY: number) => {
    const ctx = options.get()!.getContext('2d')!
    ctx.strokeStyle = color; ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(toX, toY); ctx.stroke()
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(toX, toY, size / 2, 0, Math.PI * 2); ctx.fill()
  }
  const mosaic = (base: HTMLCanvasElement, region: Mosaic) => {
    const { source, x, y, width: w, height: h } = region
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.ceil(w / mosaicSize)); small.height = Math.max(1, Math.ceil(h / mosaicSize))
    small.getContext('2d')!.drawImage(source, x, y, w, h, 0, 0, small.width, small.height)
    const ctx = base.getContext('2d')!
    // Crossfade premultiplied pixels, keeping transparent images and the rest of the canvas intact.
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    ctx.imageSmoothingEnabled = false; ctx.globalAlpha = mosaicStrength
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000000'; ctx.fillRect(x, y, w, h)
    ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h)
    ctx.restore()
  }
  cv.addEventListener('pointerdown', e => {
    if (mode === 'view' || !options.get() || e.button !== 0 || stroke || options.busy()) return
    e.preventDefault(); e.stopPropagation()
    const p = point(e); checkpoint()
    stroke = { id: e.pointerId, x: p.x, y: p.y, lastX: p.x, lastY: p.y }
    cv.setPointerCapture(e.pointerId)
    // Invalidate an old drag copy before a new edit changes any pixels.
    options.changed()
    if (mode === 'pen') { line(p.x, p.y, p.x, p.y); draw() }
  })
  cv.addEventListener('pointermove', e => {
    if (!stroke || stroke.id !== e.pointerId) return
    e.stopPropagation()
    const p = point(e)
    if (mode === 'pen') line(stroke.lastX, stroke.lastY, p.x, p.y)
    stroke.lastX = p.x; stroke.lastY = p.y
    draw()
    if (mode !== 'pen') {
      const ctx = cv.getContext('2d')!
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4])
      ctx.strokeRect(stroke.x, stroke.y, p.x - stroke.x, p.y - stroke.y); ctx.setLineDash([])
    }
  })
  const finish = (e: PointerEvent, cancel = false) => {
    if (!stroke || stroke.id !== e.pointerId) return
    e.stopPropagation()
    const base = options.get()!, s = stroke; stroke = null
    if (cancel) {
      const old = history.pop(); if (old) options.set(old)
    } else if (mode !== 'pen') {
      const p = point(e), x = Math.floor(Math.min(s.x, p.x)), y = Math.floor(Math.min(s.y, p.y))
      const w = Math.ceil(Math.abs(p.x - s.x)), h = Math.ceil(Math.abs(p.y - s.y))
      if (w && h) {
        const ctx = base.getContext('2d')!
        if (mode === 'cover') { ctx.fillStyle = color; ctx.fillRect(x, y, w, h) }
        else {
          lastMosaic = { source: history[history.length - 1], x, y, width: w, height: h }
          mosaic(base, lastMosaic)
        }
      } else history.pop()
    }
    if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId)
    draw(); options.changed()
  }
  cv.addEventListener('pointerup', e => finish(e))
  cv.addEventListener('pointercancel', e => finish(e, true))
  cv.addEventListener('lostpointercapture', e => finish(e, true))
  cv.addEventListener('dblclick', e => { if (mode !== 'view') e.stopPropagation() })
  return {
    checkpoint,
    setMode(next: Mode) { if (stroke) return; if (next !== mode) lastMosaic = null; mode = next; cv.style.cursor = mode === 'view' ? '' : 'crosshair' },
    configure(next: { color: string; brushSize: number; mosaicSize: number; mosaicStrength: number }) {
      const clamp = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
      const grain = clamp(next.mosaicSize, 2, 128, mosaicSize), strength = clamp(next.mosaicStrength, 1, 100, mosaicStrength * 100) / 100
      const changed = grain !== mosaicSize || strength !== mosaicStrength
      color = next.color; size = clamp(next.brushSize, 2, 128, size); mosaicSize = grain; mosaicStrength = strength
      const base = options.get()
      if (changed && lastMosaic && base && !stroke && !options.busy()) {
        const ctx = base.getContext('2d')!
        ctx.clearRect(0, 0, base.width, base.height); ctx.drawImage(lastMosaic.source, 0, 0)
        mosaic(base, lastMosaic); draw(); options.changed()
      }
    },
    undo() { if (stroke || options.busy()) return; lastMosaic = null; const old = history.pop(); if (old) { options.set(old); draw(); options.changed() } },
    reset() { stroke = null; lastMosaic = null; history.length = 0; mode = 'view'; cv.style.cursor = '' },
    get active() { return stroke !== null },
  }
}
