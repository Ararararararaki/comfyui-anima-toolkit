const CACHE = 'anima-lora-v3'
const PRECACHE = ['/', '/index.html']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  )
})

self.addEventListener('fetch', (e) => {
  const { request } = e
  const url = new URL(request.url)

  if (url.hostname === 'image.civitai.com' || url.hostname === 'civitai.com') {
    e.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        const clone = res.clone()
        if (res.ok) caches.open(CACHE).then((c) => c.put(request, clone))
        return res
      }).catch(() => new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect fill="#1a1e28" width="400" height="300"/><text x="200" y="150" text-anchor="middle" fill="#6b728c" font-size="14">离线</text></svg>', { headers: { 'Content-Type': 'image/svg+xml' } })))
    )
    return
  }

  e.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res.ok && request.method === 'GET') {
        const clone = res.clone()
        caches.open(CACHE).then((c) => c.put(request, clone))
      }
      return res
    }))
  )
})
