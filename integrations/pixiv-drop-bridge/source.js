(() => {
  // Host permissions cover loopback ports; unrelated local pages stay inactive.
  if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(location.hostname)) return
  // Window bubble runs after Toolkit's document dragstart writer.
  window.addEventListener('dragstart', event => {
    if (!event.isTrusted || event.defaultPrevented || !event.target.closest?.('[data-output-drag], [data-output-preview-drag]') || !event.dataTransfer) return
    const transfer = event.dataTransfer
    const urls = transfer.getData('text/uri-list').split(/\r?\n/).filter(s => s && !s.startsWith('#'))
    if (urls.length !== 1) return
    const url = urls[0]
    let u; try { u = new URL(url) } catch { return }
    if (u.origin !== location.origin || u.pathname !== '/anima/gallery/share' || u.username || u.password || u.hash) return
    const download = /^image\/png:([^:]+):(.+)$/.exec(transfer.getData('DownloadURL'))
    if (!download || download[2] !== u.href) return
    // Keep standard URI data; the marker never carries pixels or local paths.
    // The worker validates the share parameters and binds to sender.url.
    transfer.setData('application/x-tk-clean-image', '1')
    chrome.runtime.sendMessage({ kind: 'arm', url: u.href, name: download[1] }).then(result => {
      if (result?.ok) document.documentElement.dataset.tkPixivSource = chrome.runtime.getManifest().version
      else console.warn('[TK Pixiv bridge]', result?.error || '准备失败')
    }).catch(error => console.warn('[TK Pixiv bridge]', error.message))
  })
})()
