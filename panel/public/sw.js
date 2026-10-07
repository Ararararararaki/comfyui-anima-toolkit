// Compatibility tombstone for previously installed toolkit service workers.
// Retire only the toolkit cache; preserve other applications and user data.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.delete('anima-lora-v2').then(() => self.registration.unregister())
  )
})
// No fetch handler: use normal HTTP cache/revalidation policies for all requests.
