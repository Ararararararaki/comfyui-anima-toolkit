/** Observe the host's gallery broadcast; disconnects fall back to the caller's poll. */
export function observeOutputFreshness(onChange: () => void): () => void {
  const owner = window as unknown as { comfyAPI?: { api?: { api?: EventTarget } }; api?: EventTarget }
  let api = owner.comfyAPI?.api?.api || owner.api
  try { const parent = window.parent as unknown as typeof owner; api ||= parent.comfyAPI?.api?.api || parent.api } catch { /* Cross-origin panel uses its own read-only socket. */ }
  if (api?.addEventListener) { api.addEventListener('anima_gallery_changed', onChange); return () => api!.removeEventListener('anima_gallery_changed', onChange) }
  let socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, disposed = false
  const connect = () => {
    if (disposed) return
    try { socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?clientId=tk-outputs-${crypto.randomUUID()}`) }
    catch { retry = setTimeout(connect, 4000); return }
    socket.onmessage = event => { if (typeof event.data !== 'string') return; try { if (JSON.parse(event.data).type === 'anima_gallery_changed') onChange() } catch { /* Host binary preview or unrelated event. */ } }
    socket.onclose = () => { if (!disposed) retry = setTimeout(connect, 4000) }
    socket.onerror = () => socket?.close()
  }
  connect()
  return () => { disposed = true; if (retry) clearTimeout(retry); socket?.close() }
}
