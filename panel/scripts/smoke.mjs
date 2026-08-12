#!/usr/bin/env node
/**
 * Anima Toolkit · CDP 冒烟测试（可复用开发工作流）
 * ─────────────────────────────────────────────────────────────
 * 用法：
 *   node scripts/smoke.mjs                # 默认：构建产物冒烟（dist/ 静态服务 + headless Chrome）
 *   node scripts/smoke.mjs --checks=tab   # 仅检查 tab 图标
 *   node scripts/smoke.mjs --port=8899 --debug=9223
 *
 * 功能：
 *   1. 启动静态服务器（serve dist/，默认 8899）
 *   2. 启动 headless Chrome（--no-proxy-server 绕过系统代理，默认调试端口 9223）
 *   3. 等待 CDP 就绪 → 导航到页面 → 等待加载
 *   4. 执行检查（tab 图标注入 / 按钮 SVG / console 错误 / 异常）
 *   5. 输出 JSON 结果，非零退出码表示失败（可被 CI/脚本捕获）
 *
 * 依赖：Node 21+（内置 fetch 与全局 WebSocket；Node 18 缺全局 WebSocket 会以 ReferenceError 干净退出）。Windows Chrome 路径可经 CHROME_PATH 环境变量覆盖。
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ── 参数解析 ──
const args = process.argv.slice(2)
function argVal(name, def) {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : (args.includes(`--${name}`) ? true : def)
}
const PORT = parseInt(argVal('port', '8899'))
const DEBUG_PORT = parseInt(argVal('debug', '9223'))
const CHECKS = (argVal('checks', 'all') || 'all').split(',')

const log = (...a) => console.log('[smoke]', ...a)
const fail = (msg) => { console.error('[smoke] ✗', msg); cleanup(); process.exit(1) }

// ── Chrome 路径（可环境变量覆盖）──
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

// ── 资源句柄（模块级，供异常路径统一清理）──
let _chrome = null
let _server = null
let _ws = null
function cleanup() {
  try { _ws?.close(); _ws = null } catch { _ws = null }
  try {
    if (_chrome) {
      _chrome.kill()
      // Windows：taskkill /F /T 强杀进程树，确保 profile 锁释放（review nit）
      try {
        if (process.platform === 'win32' && _chrome.pid) {
          spawnSync('taskkill', ['/PID', String(_chrome.pid), '/F', '/T'], { stdio: 'ignore' })
        }
      } catch { /* taskkill 不可用则跳过 */ }
    }
    _chrome = null
  } catch { _chrome = null }
  try { _server?.close(); _server = null } catch { _server = null }
}

async function main() {
  // 1. 静态服务器（serve dist/）
  const dist = path.resolve(ROOT, 'dist')
  if (!existsSync(path.join(dist, 'index.html'))) {
    fail(`dist/index.html 不存在，请先运行 npm run build（当前检查目录: ${dist}）`)
  }
  _server = http.createServer((req, res) => {
    let url
    try {
      url = decodeURIComponent(req.url.split('?')[0])
    } catch {
      // 畸形 URL 编码（如 /%zz）：拒绝而非崩溃（security_review MEDIUM）
      res.statusCode = 400
      res.end('400 Bad Request')
      return
    }
    if (url === '/') url = '/index.html'
    // 兼容 build:comfyui 产物：/extensions/ComfyUI-Anima-Batch-LoRA/app/ 前缀映射到 dist/
    const EXT_PREFIX = '/extensions/ComfyUI-Anima-Batch-LoRA/app/'
    if (url.startsWith(EXT_PREFIX)) {
      url = url.slice(EXT_PREFIX.length - 1) || '/'
      if (url === '/') url = '/index.html'
    }
    const file = path.join(dist, url)
    // 路径分隔符边界：防 /../dist-evil/ 前缀绕过（security_review LOW）
    const withinDist = file === dist || file.startsWith(dist + path.sep)
    if (!withinDist) { res.statusCode = 404; res.end('404'); return }
    try {
      if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end('404'); return }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream'
      res.setHeader('Content-Type', mime)
      res.end(readFileSync(file))
    } catch {
      // 权限等 IO 异常：返回 500 而非崩溃（security_review LOW）
      res.statusCode = 500
      res.end('500 Internal Error')
    }
  })
  await new Promise((resolve, reject) => {
    _server.once('error', (err) => {
      cleanup()
      reject(err)
    })
    // 仅绑定本机回环，避免局域网畸形请求 DoS（security_review MEDIUM）
    _server.listen(PORT, '127.0.0.1', resolve)
  }).catch((err) => fail(`静态服务器启动失败: ${err.message}`))
  log(`静态服务器 http://127.0.0.1:${PORT}`)

  // 2. headless Chrome
  const chromePath = chromeCandidates.find(c => c && existsSync(c))
  if (!chromePath) fail('未找到 Chrome，请设置 CHROME_PATH')
  const profile = path.resolve(ROOT, '.scratch/chrome_smoke')
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  _chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--no-proxy-server',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' })
  log('Chrome 已启动，等待 CDP 就绪...')

  // 3. 等待 CDP
  let ok = false
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://localhost:${DEBUG_PORT}/json`)).ok) { ok = true; break } } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!ok) { cleanup(); fail('CDP 端口未就绪') }
  log('CDP 就绪')

  const targets = await (await fetch(`http://localhost:${DEBUG_PORT}/json`)).json()
  const page = targets.find(t => t.type === 'page')
  if (!page) { cleanup(); fail('未找到页面 target') }
  // 校验 ws 地址指向本机 DEBUG_PORT，防连到无关进程的 CDP 端口（security_review 可选加固）
  try {
    const wsUrl = new URL(page.webSocketDebuggerUrl)
    // '[::1]' 为 WHATWG URL 对 IPv6 的实际返回（方括号形式）；'::1' 为防御冗余写法，勿删
    const isLoopback = wsUrl.hostname === 'localhost' || wsUrl.hostname === '127.0.0.1' || wsUrl.hostname === '[::1]' || wsUrl.hostname === '::1'
    if (!isLoopback) throw new Error('host 不匹配')
    if (wsUrl.port !== String(DEBUG_PORT)) throw new Error('port 不匹配')
  } catch (err) {
    cleanup()
    fail(`CDP target 校验失败: ${err.message}`)
  }
  _ws = new WebSocket(page.webSocketDebuggerUrl)

  let msgId = 0
  const pending = new Map()
  const events = []
  _ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method) events.push(m)
  }
  // 断连时拒绝全部 pending，避免脚本挂死（review nit）
  let wsClosed = false
  _ws.onclose = () => {
    wsClosed = true
    pending.forEach(res => res({ error: 'ws closed' }))
    pending.clear()
  }
  // 握手失败/超时防护：onopen 永不触发时快速失败并清理（review should-fix）
  const wsReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000)
    _ws.onopen = () => { clearTimeout(timer); resolve() }
    _ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')) }
  })
  try {
    await wsReady
  } catch (err) {
    cleanup()
    fail(err.message)
  }
  const SEND_TIMEOUT = 15000
  const send = (method, params = {}) => new Promise(res => {
    // ws 已关闭时新请求立即失败，避免 pending 永不 resolve 挂死（review nit）
    if (wsClosed) { res({ error: 'ws closed' }); return }
    const id = ++msgId
    const timer = setTimeout(() => {
      pending.delete(id)
      res({ error: `CDP 响应超时（${method}）` })
    }, SEND_TIMEOUT)
    const done = (m) => {
      clearTimeout(timer)
      pending.delete(id)
      res(m)
    }
    pending.set(id, done)
    _ws.send(JSON.stringify({ id, method, params }))
  })

  await send('Runtime.enable')
  await send('Page.enable')

  // 4. 等待加载完成（最多 25s，超时重试导航一次，兼容 Chrome 冷启动竞态）
  let ready = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0 // 清空上次导航的临时事件（避免污染错误检查）
    await send('Page.navigate', { url: `http://localhost:${PORT}/` })
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 500))
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
      ready = r.result?.result?.value || ''
      if (ready === 'complete') break
    }
    if (ready === 'complete') break
    log(`第 ${attempt + 1} 次导航未完成（readyState=${ready}），重试...`)
  }
  if (ready !== 'complete') { cleanup(); fail(`页面未完成加载（readyState=${ready}）`) }

  // 5. 执行检查（等待图标注入完成——module script 异步执行）
  await new Promise(r => setTimeout(r, 1500))
  const evalRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      tabs: document.querySelectorAll('.main-tab').length,
      tabSvg: document.querySelectorAll('.main-tab svg').length,
      catTabs: document.querySelectorAll('.tab').length,
      catTabSvg: document.querySelectorAll('.tab svg').length,
      settingsSvg: document.querySelectorAll('#settingsBtn svg').length,
      searchSvg: document.querySelectorAll('.search-wrap .icon svg').length,
      selectAllBtn: !!document.getElementById('outputsSelectAllBtn'),
      localTabs: Array.from(document.querySelectorAll('.local-view-tab')).map(t => t.textContent.trim()),
      localTabSvg: document.querySelectorAll('.local-view-tab svg').length,
      bodyLen: document.body.innerText.length,
    })`,
    returnByValue: true,
  })
  const state = JSON.parse(evalRes.result.result.value)

  const errors = events.filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map(e => e.params.args.map(a => a.value || a.description).join(' '))
  const exceptions = events.filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => e.params.exceptionDetails?.text || 'exception')

  // 6. 校验（按 checks 参数过滤）
  const checks = CHECKS.includes('all') ? ['tab', 'icons', 'errors', 'pages'] : CHECKS
  const results = []
  if (checks.includes('tab')) {
    results.push({ name: '主 tab', pass: state.tabs === 6 && state.tabSvg === 6, detail: `tabs=${state.tabs} svg=${state.tabSvg}` })
    results.push({ name: '分类 tab', pass: state.catTabs >= 1 && state.catTabSvg === state.catTabs, detail: `tabs=${state.catTabs} svg=${state.catTabSvg}` })
  }
  if (checks.includes('icons')) {
    results.push({ name: '设置按钮 SVG', pass: state.settingsSvg === 1, detail: `svg=${state.settingsSvg}` })
    results.push({ name: '本地管理 tab', pass: state.localTabs.includes('批量发送') && state.localTabSvg === state.localTabs.length, detail: `tabs=${state.localTabs.join('/')} svg=${state.localTabSvg}` })
  }
  if (checks.includes('errors')) {
    results.push({ name: 'console 错误', pass: errors.length === 0, detail: `errors=${errors.length}` })
    results.push({ name: 'JS 异常', pass: exceptions.length === 0, detail: `exceptions=${exceptions.length}` })
  }
  if (checks.includes('pages')) {
    results.push({ name: '页面加载', pass: state.title.includes('Anima Toolkit') && state.bodyLen > 0, detail: `title=${state.title}` })
    results.push({ name: '全选按钮', pass: state.selectAllBtn, detail: `exists=${state.selectAllBtn}` })
  }

  // 7. 输出
  console.log('\n=== 冒烟结果 ===')
  console.log(JSON.stringify({ page: { title: state.title, tabs: state.tabs, tabSvg: state.tabSvg }, checks: results }, null, 2))
  if (errors.length) console.log('\nconsole 错误:\n' + errors.slice(0, 5).join('\n'))
  if (exceptions.length) console.log('\nJS 异常:\n' + exceptions.slice(0, 5).join('\n'))

  cleanup()
  const allPass = results.every(r => r.pass)
  log(allPass ? '✅ 冒烟全部通过' : '❌ 存在失败项')
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('[smoke] 运行失败:', e); cleanup(); process.exit(1) })
