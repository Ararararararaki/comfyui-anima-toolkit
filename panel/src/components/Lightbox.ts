import { t as tr } from '../i18n'
let images: string[] = []
let index = 0
let touchStartX = 0
let scale = 1
let offsetX = 0
let offsetY = 0
let locked = false
let drag: { id: number; x: number; y: number; moved: boolean; el: HTMLElement } | null = null
let suppressClick = false
const bound = new WeakSet<HTMLElement>()

function surface(): HTMLElement | null {
  const wrap = document.getElementById('lbEditWrap')
  return wrap && wrap.style.display !== 'none' ? wrap : document.getElementById('lbImg')
}

function paintView() {
  const el = surface()
  if (!el) return
  // Keep the fitted image area covered, so panning cannot lose the picture.
  const limitX = el.offsetWidth * (scale - 1) / 2
  const limitY = el.offsetHeight * (scale - 1) / 2
  offsetX = Math.max(-limitX, Math.min(limitX, offsetX))
  offsetY = Math.max(-limitY, Math.min(limitY, offsetY))
  el.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
  el.style.cursor = locked ? '' : scale > 1 ? (drag ? 'grabbing' : 'grab') : 'zoom-in'
  const fit = document.getElementById('lbFitView') as HTMLButtonElement | null
  if (fit) { fit.textContent = tr("workspace.fit", { p0: Math.round(scale * 100) }); fit.disabled = locked }
}

/** View transforms never change the image or editor canvas pixels. */
export function resetLightboxView() {
  drag = null
  suppressClick = false
  scale = 1
  offsetX = offsetY = 0
  for (const id of ['lbImg', 'lbEditWrap']) {
    const el = document.getElementById(id)
    if (el) { el.style.transform = ''; el.style.cursor = '' }
  }
  paintView()
}

export function setLightboxViewLocked(value: boolean) {
  locked = value
  resetLightboxView()
}

/** Also called by Outputs, whose asynchronous preview has its own navigation. */
export function setupLightboxView() {
  const lb = document.getElementById('lightbox')
  if (!lb || bound.has(lb)) return
  bound.add(lb)
  const fit = document.createElement('button')
  fit.id = 'lbFitView'
  fit.className = 'lb-fit-view'
  fit.title = tr("workspace.scrollToZoomDragToPanDouble")
  fit.addEventListener('click', e => { e.stopPropagation(); resetLightboxView() })
  const stage = lb.querySelector('.lb-stage') || lb
  stage.appendChild(fit)
  if (stage !== lb) stage.addEventListener('click', e => { if (e.target === stage) closeLightbox() })
  const isPicture = (target: EventTarget | null) => target instanceof Element && !!target.closest('#lbImg, #lbEditWrap')
  lb.addEventListener('wheel', e => {
    if (!lb.classList.contains('open') || !isPicture(e.target) || locked) return
    e.preventDefault()
    const el = surface()
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = e.clientX - (rect.left + rect.width / 2) + offsetX
    const y = e.clientY - (rect.top + rect.height / 2) + offsetY
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? lb.clientHeight : 1)
    const next = Math.max(1, Math.min(8, scale * Math.exp(-Math.max(-240, Math.min(240, delta)) * .002)))
    offsetX = x - (x - offsetX) * next / scale
    offsetY = y - (y - offsetY) * next / scale
    scale = next
    paintView()
  }, { passive: false })
  lb.addEventListener('pointerdown', e => {
    if (!isPicture(e.target) || locked || scale <= 1 || e.button !== 0 || drag) return
    e.preventDefault()
    suppressClick = false
    const el = surface()!
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, el }
    el.setPointerCapture(e.pointerId)
    paintView()
  })
  lb.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    drag.moved ||= Math.abs(dx) + Math.abs(dy) > 2
    offsetX += dx; offsetY += dy
    drag.x = e.clientX; drag.y = e.clientY
    paintView()
  })
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    suppressClick = drag.moved
    const el = drag.el
    drag = null
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    paintView()
  }
  lb.addEventListener('pointerup', endDrag)
  lb.addEventListener('pointercancel', endDrag)
  lb.addEventListener('lostpointercapture', endDrag)
  lb.addEventListener('click', e => {
    if (!suppressClick) return
    suppressClick = false
    e.preventDefault(); e.stopImmediatePropagation()
  }, true)
  lb.addEventListener('dblclick', e => {
    if (!locked && isPicture(e.target)) { e.preventDefault(); resetLightboxView() }
  })
  lb.addEventListener('dragstart', e => { if (isPicture(e.target)) e.preventDefault() })
  lb.addEventListener('touchstart', e => { touchStartX = e.touches.length === 1 ? e.touches[0].clientX : NaN }, { passive: true })
  lb.addEventListener('touchend', e => {
    if (scale !== 1 || locked || !isPicture(e.target)) return
    const dx = e.changedTouches[0].clientX - touchStartX
    if (Math.abs(dx) > 50) navLightbox(dx < 0 ? 1 : -1)
  }, { passive: true })
  document.getElementById('lbImg')?.addEventListener('load', resetLightboxView)
  window.addEventListener('resize', () => { if (lb.classList.contains('open')) resetLightboxView() })
  paintView()
}

export function openLightbox(imgs: string[], idx: number) {
  setupLightboxView()
  setLightboxViewLocked(false)
  images = imgs
  index = Math.max(0, Math.min(idx, imgs.length - 1))
  updateLightbox()
  const lb = document.getElementById('lightbox')
  if (lb) lb.classList.add('open')
  document.body.style.overflow = 'hidden'
}

export function closeLightbox() {
  setLightboxViewLocked(false)
  const lb = document.getElementById('lightbox')
  lb?.classList.remove('open')
  document.getElementById('lbImg')?.removeAttribute('src')
  const canvas = document.getElementById('lbEditCanvas') as HTMLCanvasElement | null
  if (canvas) { canvas.width = 0; canvas.height = 0 }
  images = []
  index = 0
  document.body.style.overflow = ''
  lb?.dispatchEvent(new Event('lightbox:closed'))
}

export function navLightbox(dir: number) {
  if (images.length <= 1) return
  index = (index + dir + images.length) % images.length
  updateLightbox()
}

function updateLightbox() {
  resetLightboxView()
  const img = document.getElementById('lbImg') as HTMLImageElement
  const counter = document.getElementById('lbCounter')
  if (img) img.src = images[index] || ''
  if (counter) counter.textContent = `${index + 1}/${images.length}`
  document.querySelectorAll('.lightbox .lb-nav').forEach(b => {
    (b as HTMLElement).style.display = images.length > 1 ? '' : 'none'
  })
}

export { images as lightboxImages, index as lightboxIndex }
