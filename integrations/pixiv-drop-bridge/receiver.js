(() => {
  let copy = null, used = '', busy = false, lastPoll = 0
  const panel = document.createElement('aside'); panel.id = 'tk-pixiv-bridge'
  panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;padding:14px;max-width:320px;background:#fff;color:#222;border:2px solid #0096fa;border-radius:12px;box-shadow:0 4px 22px #0003;font:13px/1.6 sans-serif'
  const title = document.createElement('strong'); title.textContent = 'TK 图片接收桥'
  const status = document.createElement('div'); status.textContent = '等待从 Toolkit 拖出图片'
  status.style.cssText = 'overflow-wrap:anywhere;margin:6px 0'
  const button = document.createElement('button'); button.textContent = '接收刚拖出的图片'; button.disabled = true
  button.style.cssText = 'background:#007dc6;color:white;border:0;border-radius:7px;padding:8px 12px;cursor:pointer'
  panel.append(title, status, button)
  const inputs = () => [...document.querySelectorAll('input[type=file]')].filter(el => !el.disabled && (!el.accept || /image|\.png|\.jpe?g|\.gif/i.test(el.accept)))
  function mount() { if (inputs().length) { if (!panel.isConnected) document.documentElement.append(panel) } else { panel.remove(); copy = null } }
  function safeURL(raw) {
    try {
      const u = new URL(raw), port = Number(u.port || 80)
      return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && port >= 1 && port <= 65535 && !u.username && !u.password && !u.hash && u.pathname === '/anima/gallery/share' ? u.href : ''
    } catch { return '' }
  }
  async function refresh() {
    mount(); if (!panel.isConnected || busy || Date.now() - lastPoll < 700) return
    lastPoll = Date.now()
    try {
      const result = await chrome.runtime.sendMessage({ kind: 'peek' })
      if (!result?.ok) throw Error(result?.error || '扩展未响应')
      const next = result.copy
      if (next?.id !== copy?.id) {
        copy = next; button.disabled = !copy || copy.id === used
        status.textContent = copy ? `已准备：${copy.name}。拖到此框，或点击接收。` : '等待从 Toolkit 拖出图片'
      }
    } catch (error) { status.textContent = `接收桥失效：${error.message}；请刷新此页`; button.disabled = true }
  }
  async function receive(url = '') {
    if (busy) return
    busy = true; button.disabled = true
    try {
      const active = await chrome.runtime.sendMessage({ kind: 'peek' })
      if (!active?.ok || !active.copy) throw Error('没有待接收图片，请先在 Toolkit 拖动图片')
      const targets = inputs()
      if (targets.length !== 1) throw Error(`找到 ${targets.length} 个图片上传控件，无法确定目标；请保持 Pixiv 添加图片区域可用`)
      const target = targets[0]
      status.textContent = '正在读取导出图片…'
      const result = await chrome.runtime.sendMessage({ kind: 'receive', id: active.copy.id, url })
      if (!result?.ok) throw Error(result?.error || '读取失败')
      const currentTargets = inputs()
      if (!target.isConnected || currentTargets.length !== 1 || currentTargets[0] !== target) throw Error('上传区域已变化，请重试')
      const raw = atob(result.base64), bytes = Uint8Array.from(raw, c => c.charCodeAt(0))
      if (bytes.length !== result.size) throw Error('接收字节长度不一致')
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], result.name, { type: result.mime }))
      // Like a native file-picker selection, submit only this new batch. Sites
      // retain previous previews themselves; resending old Files duplicates them.
      target.files = transfer.files
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
      used = active.copy.id
      status.textContent = `已交给上传控件：${result.name}（${result.size.toLocaleString()} 字节）。请确认 Pixiv 已生成预览。`
    } catch (error) { status.textContent = `接收失败：${error.message}` }
    finally { busy = false; button.disabled = !copy || copy.id === used }
  }
  button.addEventListener('click', event => { if (event.isTrusted) void receive() })
  document.addEventListener('dragover', event => {
    if (!event.isTrusted || !panel.isConnected || !event.dataTransfer) return
    const types = [...event.dataTransfer.types]
    if (types.includes('application/x-tk-clean-image') || ((copy || panel.contains(event.target)) && types.includes('text/uri-list'))) { event.preventDefault(); event.stopImmediatePropagation(); event.dataTransfer.dropEffect = 'copy' }
  }, true)
  document.addEventListener('drop', event => {
    if (!event.isTrusted || !panel.isConnected || !event.dataTransfer) return
    const raw = event.dataTransfer.getData('text/uri-list').split(/\r?\n/).find(s => s && !s.startsWith('#')) || ''
    const url = safeURL(raw)
    if (raw && !url) return
    if (!url && !event.dataTransfer.types.includes('application/x-tk-clean-image')) return
    event.preventDefault(); event.stopImmediatePropagation(); void receive(url)
  }, true)
  // No account APIs, telemetry or persistent image storage.
  void refresh(); setInterval(() => { if (!document.hidden) void refresh() }, 1000)
})()
