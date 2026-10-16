import { createBridge } from './core.js'

const bridge = createBridge()
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || !['arm', 'peek', 'receive'].includes(message.kind)) return
  bridge.handle(message, sender.url).then(reply, error => reply({ ok: false, error: error.message }))
  return true
})
