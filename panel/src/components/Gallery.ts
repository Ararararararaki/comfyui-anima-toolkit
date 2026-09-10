interface TouchData {
  startX: number
  startY: number
  uid: string
  track: HTMLElement
  gallery: HTMLElement
  moved: boolean
}

let touchData: TouchData | null = null

function getCurrentIndex(track: HTMLElement, gallery: HTMLElement): number {
  const m = track.style.transform.match(/translateX\((-?\d+(?:\.\d+)?)%\)/)
  if (m) return Math.round(Math.abs(parseFloat(m[1])) / 100) || 0
  const dots = gallery.querySelectorAll('.gallery-dots span')
  for (let i = 0; i < dots.length; i++) { if (dots[i].classList.contains('active')) return i }
  return 0
}
