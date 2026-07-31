interface TouchData {
  startX: number
  startY: number
  uid: string
  track: HTMLElement
  gallery: HTMLElement
  moved: boolean
}

let touchData: TouchData | null = null

export function initGallerySwipes() {
  document.querySelectorAll('.gallery').forEach(gal => {
    if (gal.hasAttribute('data-swipe-init')) return
    gal.setAttribute('data-swipe-init', '1')

    const onStart = (e: MouseEvent | TouchEvent) => {
      if (e.target instanceof HTMLElement && e.target.tagName !== 'IMG') return
      const track = gal.querySelector('.gallery-track') as HTMLElement
      if (!track || track.children.length <= 1) return
      const pos = 'touches' in e ? e.touches[0] : e
      touchData = {
        startX: pos.clientX, startY: pos.clientY,
        uid: gal.getAttribute('data-uid') || '',
        track, gallery: gal as HTMLElement, moved: false,
      }
    }

    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!touchData || touchData.gallery !== gal) return
      const pos = 'touches' in e ? e.touches[0] : e
      const dx = pos.clientX - touchData.startX
      const dy = pos.clientY - touchData.startY
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 5) {
        touchData.moved = true
        if ('touches' in e) e.preventDefault()
        const curIdx = getCurrentIndex(touchData.track, gal as HTMLElement)
        const offset = -curIdx * 100 + (dx / (gal as HTMLElement).offsetWidth) * 100
        touchData.track.style.transition = 'none'
        touchData.track.style.transform = `translateX(${offset}%)`
      }
    }

    const onEnd = (e: MouseEvent | TouchEvent) => {
      if (!touchData || touchData.gallery !== gal) return
      const pos = 'changedTouches' in e ? e.changedTouches[0] : e
      const dx = pos.clientX - touchData.startX
      const td = touchData
      touchData = null
      const total = td.track.children.length
      if (total <= 1) return
      const curIdx = getCurrentIndex(td.track, gal as HTMLElement)
      td.track.style.transition = 'transform .4s ease'
      let nextIdx = curIdx
      if (td.moved) {
        const thr = (gal as HTMLElement).offsetWidth * 0.2
        if (dx < -thr) nextIdx = Math.min(curIdx + 1, total - 1)
        else if (dx > thr) nextIdx = Math.max(curIdx - 1, 0)
      }
      td.track.style.transform = `translateX(-${nextIdx * 100}%)`
      gal.querySelectorAll('.gallery-dots span').forEach((s, i) => s.classList.toggle('active', i === nextIdx))
    }

    gal.addEventListener('touchstart', onStart as EventListener, { passive: true })
    gal.addEventListener('touchmove', onMove as EventListener, { passive: false })
    gal.addEventListener('touchend', onEnd as EventListener, { passive: true })
    gal.addEventListener('mousedown', onStart as EventListener)
  })
}

function getCurrentIndex(track: HTMLElement, gallery: HTMLElement): number {
  const m = track.style.transform.match(/translateX\((-?\d+(?:\.\d+)?)%\)/)
  if (m) return Math.round(Math.abs(parseFloat(m[1])) / 100) || 0
  const dots = gallery.querySelectorAll('.gallery-dots span')
  for (let i = 0; i < dots.length; i++) { if (dots[i].classList.contains('active')) return i }
  return 0
}
