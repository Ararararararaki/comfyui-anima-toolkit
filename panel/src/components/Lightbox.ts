let images: string[] = []
let index = 0
let touchStartX = 0

export function openLightbox(imgs: string[], idx: number) {
  images = imgs
  index = Math.max(0, Math.min(idx, imgs.length - 1))
  updateLightbox()
  const lb = document.getElementById('lightbox')
  if (lb) lb.classList.add('open')
  document.body.style.overflow = 'hidden'
  lb?.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX
  }, { passive: true })
  lb?.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX
    if (Math.abs(dx) > 50) navLightbox(dx < 0 ? 1 : -1)
  }, { passive: true })
}

export function closeLightbox() {
  document.getElementById('lightbox')?.classList.remove('open')
  document.body.style.overflow = ''
}

export function navLightbox(dir: number) {
  if (images.length <= 1) return
  index = (index + dir + images.length) % images.length
  updateLightbox()
}

function updateLightbox() {
  const img = document.getElementById('lbImg') as HTMLImageElement
  const counter = document.getElementById('lbCounter')
  if (img) img.src = images[index] || ''
  if (counter) counter.textContent = `${index + 1}/${images.length}`
  document.querySelectorAll('.lightbox .lb-nav').forEach(b => {
    (b as HTMLElement).style.display = images.length > 1 ? '' : 'none'
  })
}

export { images as lightboxImages, index as lightboxIndex }
