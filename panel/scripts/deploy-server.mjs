// Local deploy server — runs alongside dev server
// Usage: node scripts/deploy-server.mjs
// Exposes POST /deploy — triggers npm run build + copies to configured path

import { execSync } from 'child_process'
import { cp, readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const configPath = join(root, '.comfyui-path')
const PORT = 5166

function getNodeDir() {
  if (existsSync(configPath)) {
    const p = readFileSync(configPath, 'utf-8').trim()
    if (p) return resolve(p)
  }
  return null
}

async function deploy() {
  let nodeDir = getNodeDir()
  if (!nodeDir) return { ok: false, error: '未配置路径，请在设置中选择目录后再部署' }

  if (nodeDir.endsWith('custom_nodes') || !nodeDir.endsWith('ComfyUI-Anima-Batch-LoRA')) {
    nodeDir = join(nodeDir, 'ComfyUI-Anima-Batch-LoRA')
  }

  console.log('[deploy-server] Building...')
  execSync('npm run build', { cwd: root, stdio: 'pipe' })
  console.log('[deploy-server] Build done')

  const dist = join(root, 'dist')
  const target = join(nodeDir, 'app')
  await mkdir(target, { recursive: true })
  await cp(dist, target, { recursive: true, force: true })

  const indexPath = join(target, 'index.html')
  let html = await readFile(indexPath, 'utf-8')
  html = html.replace(/src="\.\//g, 'src="/extensions/ComfyUI-Anima-Batch-LoRA/app/')
  html = html.replace(/href="\.\//g, 'href="/extensions/ComfyUI-Anima-Batch-LoRA/app/')
  await writeFile(indexPath, html, 'utf-8')

  return { ok: true, path: target }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method === 'GET' && req.url === '/status') {
    const nodeDir = getNodeDir()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ configured: !!nodeDir, path: nodeDir }))
    return
  }

  if (req.method === 'POST' && req.url === '/deploy') {
    console.log('[deploy-server] Deploy request received')
    const result = await deploy()
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  if (req.method === 'POST' && req.url === '/configure') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { path } = JSON.parse(body)
        if (!path) throw new Error('path required')
        writeFileSync(configPath, resolve(path), 'utf-8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: resolve(path) }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    })
    return
  }

  res.writeHead(404); res.end()
})

server.listen(PORT, () => {
  console.log(`\n  🚀 Deploy server ready at http://localhost:${PORT}`)
  console.log(`     POST /deploy     — build + deploy to ComfyUI`)
  console.log(`     POST /configure  — set deploy path`)
  console.log(`     GET  /status     — check config\n`)
})
