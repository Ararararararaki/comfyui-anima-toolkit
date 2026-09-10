/**
 * 「从 C 站链接批量下载」弹窗（2026-09-10 从 LocalManager.ts 纯搬迁，行为等价）。
 * 提交到 ComfyUI 后台队列（/anima/lora/download/*），支持 LoRA/Checkpoint/VAE 等；
 * 关闭弹窗不影响下载任务，进度可重新打开弹窗恢复。
 */
import { showToast, icon, escAttr } from '../utils'
import { useLocalModelStore } from '../store/localModels'

const $$ = (s: string): HTMLElement | null => document.getElementById(s)

export function bindUrlDownloadModal(renderLocalView: () => void, refreshLocalNames: () => void): void {
// 从 C 站链接批量下载模型（提交到 ComfyUI 后台，支持 LoRA/Checkpoint/VAE 等）
$$('localUrlBtn')?.addEventListener('click', () => {
  // ⚠️ 不用 backdrop-filter:blur —— 全屏模糊在几千节点的页面上是「点一下卡一帧」的来源；
  //    半透明纯色遮罩视觉足够（2026-09-10 性能排查）。
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(2,2,3,0.72);z-index:99999;display:flex;align-items:center;justify-content:center;'
  const modal = document.createElement('div')
  modal.className = 'ld-modal'
  modal.innerHTML = `<h3>🔗 从 C 站链接批量下载模型</h3>
    <div class="ld-sub">支持 LoRA、Checkpoint、VAE 等模型；提交后由 ComfyUI 后台下载，关闭窗口或页面不影响任务</div>
    <textarea class="ld-urls" rows="6" placeholder="https://civitai.com/models/2658471/denia-wuthering-wavesanima&#10;https://civitai.com/models/2529695/xxx?modelVersionId=3094753"></textarea>
    <div style="display:flex;gap:6px;margin-top:8px;">
      <input class="ld-token" type="password" value="${escAttr(localStorage.getItem('anima_civitai_token') || '')}" placeholder="C 站 API Key（只读权限即可，下载需登录的模型用）">
      <button class="ld-tokenlink" title="打开 C 站账号设置（账号 → API Keys 生成，选只读权限）">${icon('key', 12)} 生成 API Key</button>
    </div>
    <div class="ld-sub" style="margin-top:4px;">只读权限的 API Key 即可下载需登录的模型</div>
    <div class="ld-target-row">
      <label for="ld-target">保存到</label>
      <select id="ld-target" class="ld-target" title="选择 ComfyUI 已注册的模型目录">
        <option value="auto">自动（按 C 站模型类型）</option>
      </select>
    </div>
    <div class="ld-sub ld-target-tip">自动模式：Checkpoint → models/checkpoints，LoRA → models/loras；也可选择其他已注册目录。</div>
    <div class="ld-list"></div>
    <div class="ld-log"></div>
    <div class="ld-actions">
      <button class="ld-cancel">关闭窗口</button>
      <button class="ld-start">${icon('download', 12)} 加入后台下载</button>
    </div>`
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollBusy = false
  let completionNotified = false
  const rows = new Map<string, any>()
  const listEl = modal.querySelector('.ld-list') as HTMLElement
  const close = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    overlay.remove()
  }
  // 修复：拖拽选中文本时鼠标在弹窗外松开也会误关——只有按下和松开都在遮罩上才关闭
  let downOnOverlay = false
  overlay.addEventListener('mousedown', (e) => { downOnOverlay = (e.target === overlay) })
  overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnOverlay) close() })
  modal.querySelector('.ld-cancel')?.addEventListener('click', close)
  modal.querySelector('.ld-tokenlink')?.addEventListener('click', () => window.open('https://civitai.com/user/account', '_blank'))
  const targetSelect = modal.querySelector('#ld-target') as HTMLSelectElement
  const targetTip = modal.querySelector('.ld-target-tip') as HTMLElement
  const savedTarget = (() => { try { return localStorage.getItem('anima_civitai_download_target') || 'auto' } catch { return 'auto' } })()
  fetch('/anima/lora/download/targets')
    .then(r => r.json())
    .then(data => {
      const targets = Array.isArray(data?.targets) ? data.targets : []
      if (!targets.length) return
      targetSelect.replaceChildren(...targets.map((target: { label: string; key: string }) => new Option(target.label, target.key)))
      targetSelect.value = targets.some((target: { key: string }) => target.key === savedTarget) ? savedTarget : 'auto'
    })
    .catch(() => { targetTip.textContent = '目录列表加载失败，将使用自动目录；请确认 ComfyUI 后端在线。' })
  const renderJob = (job: any) => {
    const progressId = String(job.progressId || '')
    if (!progressId || rows.has(progressId)) return
    const row = document.createElement('div')
    row.className = 'ld-row'
    const nameEl = document.createElement('span')
    nameEl.className = 'ld-name'
    nameEl.textContent = String(job.label || job.url || progressId).slice(0, 36)
    nameEl.title = String(job.label || job.url || progressId)
    const barWrap = document.createElement('div')
    barWrap.className = 'ld-bar-wrap'
    const bar = document.createElement('div')
    bar.className = 'ld-bar'
    barWrap.appendChild(bar)
    const pctEl = document.createElement('span')
    pctEl.className = 'ld-pct'
    pctEl.textContent = '排队中'
    const cancelBtn = document.createElement('button')
    cancelBtn.innerHTML = icon('x', 12)
    cancelBtn.title = '取消后台任务'
    cancelBtn.style.cssText = 'padding:2px 6px;background:rgba(255,80,80,0.15);color:#ff6b6b;border:1px solid rgba(255,80,80,0.3);border-radius:4px;cursor:pointer;font-size:10px;flex-shrink:0;line-height:1;'
    cancelBtn.onclick = async () => {
      cancelBtn.disabled = true
      try { await fetch(`/anima/lora/download/cancel?progressId=${encodeURIComponent(progressId)}`) } catch { /* ignore */ }
      pctEl.textContent = '已取消'
    }
    row.append(nameEl, barWrap, pctEl, cancelBtn)
    listEl.appendChild(row)
    rows.set(progressId, { job, bar, pctEl, cancelBtn, reported: false })
  }

  const updateJob = (progressId: string, status: any) => {
    const row = rows.get(progressId)
    if (!row) return
    const s = status || {}
    const total = Number(s.total || 0)
    const done = Number(s.done || 0)
    if (total > 0) {
      const pc = Math.max(0, Math.min(100, Math.round(done / total * 100)))
      row.bar.style.width = pc + '%'
      row.pctEl.textContent = s.status === 'done' ? '✓' : `${pc}%`
    } else if (s.status === 'queued') row.pctEl.textContent = '排队中'
    else if (s.status === 'downloading') row.pctEl.textContent = '下载中'
    if (s.status === 'done') {
      row.bar.style.width = '100%'
      row.pctEl.textContent = '✓'
      row.cancelBtn.disabled = true
      if (!row.reported) {
        row.reported = true
        logEl.textContent += `✓ ${s.filename || row.job.label || progressId}\n`
        if (!completionNotified) {
          completionNotified = true
          void useLocalModelStore.getState().scanDir().then(() => { refreshLocalNames(); renderLocalView() })
        }
      }
    } else if (s.status === 'error') {
      row.pctEl.textContent = '✗'
      row.cancelBtn.disabled = true
      if (!row.reported) { row.reported = true; logEl.textContent += `✗ ${s.error || '下载失败'}\n` }
    } else if (s.status === 'cancelled') {
      row.pctEl.textContent = '已取消'
      row.cancelBtn.disabled = true
      if (!row.reported) { row.reported = true; logEl.textContent += `✗ ${row.job.label || progressId} 已取消\n` }
    }
  }

  const poll = async () => {
    if (pollBusy || !rows.size) return
    pollBusy = true
    try {
      await Promise.all([...rows.keys()].map(async (progressId) => {
        try {
          const sr = await fetch(`/anima/lora/download/status?progressId=${encodeURIComponent(progressId)}`)
          updateJob(progressId, await sr.json())
        } catch { /* ignore */ }
      }))
    } finally {
      pollBusy = false
    }
  }
  const startPolling = () => {
    if (!pollTimer) pollTimer = setInterval(poll, 500)
    void poll()
  }
  fetch('/anima/lora/download/list')
    .then(r => r.json())
    .then(data => { for (const job of (Array.isArray(data?.jobs) ? data.jobs : [])) renderJob(job); startPolling() })
    .catch(() => { /* ignore */ })

  const logEl = modal.querySelector('.ld-log') as HTMLElement
  modal.querySelector('.ld-start')?.addEventListener('click', async () => {
    const ta = modal.querySelector('.ld-urls') as HTMLTextAreaElement
    const urls = (ta?.value || '').split('\n').map(s => s.trim()).filter(Boolean)
    if (!urls.length) { showToast('请输入链接'); return }
    const targetKey = targetSelect?.value || 'auto'
    try { localStorage.setItem('anima_civitai_download_target', targetKey) } catch { /* ignore */ }
    const startBtn = modal.querySelector('.ld-start') as HTMLButtonElement
    const tokenVal = (modal.querySelector('.ld-token') as HTMLInputElement)?.value?.trim() || ''
    if (tokenVal) { try { localStorage.setItem('anima_civitai_token', tokenVal) } catch { /* ignore */ } }
    const items: any[] = []
    for (const url of urls) {
      const vm = url.match(/modelVersionId=(\d+)/)
      const mm = url.match(/civitai\.com\/models\/(\d+)/)
      const parsed = vm ? { versionId: vm[1] } : mm ? { modelId: mm[1] } : null
      if (!parsed) { logEl.textContent += `✗ 无法解析: ${url.slice(0, 50)}\n`; continue }
      items.push({ ...parsed, target: targetKey, token: tokenVal, url, label: url.slice(0, 240) })
    }
    if (!items.length) { showToast('没有可提交的有效 C 站链接'); return }
    startBtn.disabled = true
    try {
      const response = await fetch('/anima/lora/download/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`)
      for (const job of result.jobs || []) renderJob(job)
      logEl.textContent += `已加入后台下载：${(result.jobs || []).length} 个任务；关闭窗口不影响下载\n`
      startPolling()
    } catch (error) {
      logEl.textContent += `✗ 提交后台任务失败：${error instanceof Error ? error.message : String(error)}\n`
    } finally {
      startBtn.disabled = false
    }
  })
})
}
