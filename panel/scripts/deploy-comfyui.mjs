// Deploy built web app to ComfyUI custom node web directory
// Detection order: --path CLI arg > COMFYUI_NODE_DIR env var > .comfyui-path file

import { cp, readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// Detect path: CLI arg > env var > .comfyui-path file
let nodeDir = null

const cliIdx = process.argv.indexOf('--path')
if (cliIdx >= 0) {
  nodeDir = resolve(process.argv[cliIdx + 1])
} else if (process.env.COMFYUI_NODE_DIR) {
  nodeDir = resolve(process.env.COMFYUI_NODE_DIR)
} else {
  const configPath = join(root, '.comfyui-path')
  if (existsSync(configPath)) {
    nodeDir = readFileSync(configPath, 'utf-8').trim()
    if (nodeDir) nodeDir = resolve(nodeDir)
  }
}

if (!nodeDir) {
  console.error(`
❌ ComfyUI path not configured.
Ways to configure:
  1. CLI arg:   node scripts/deploy-comfyui.mjs --path <comfyui-node-dir>
  2. Env var:   set COMFYUI_NODE_DIR=<path> && node scripts/deploy-comfyui.mjs
  3. Config:    echo <comfyui-node-dir> > .comfyui-path
     (You can also set this path in the app Settings -> ComfyUI -> 设置部署目录)

The path should point to custom_nodes or ComfyUI-Anima-Batch-LoRA, e.g.:
  ComfyUI/custom_nodes/ComfyUI-Anima-Batch-LoRA
  ComfyUI/custom_nodes
`)
  process.exit(1)
}

// If user pointed to custom_nodes, auto-create the node subdirectory
const NODE_DIR_NAME = 'ComfyUI-Anima-Batch-LoRA'
const resolved = resolve(nodeDir)
const baseName = resolved.split(/[/\\]/).pop()
if (baseName !== NODE_DIR_NAME) {
  // Assume they pointed to custom_nodes/ — create node dir inside
  const nodePath = join(resolved, NODE_DIR_NAME)
  await mkdir(nodePath, { recursive: true })
  nodeDir = nodePath
  console.log(`📁 Created ${NODE_DIR_NAME}/ inside ${resolved}`)
}

const target = join(nodeDir, 'app')

// 构建目录：--src 参数 > 默认 dist（build:comfyui 用 dist-comfyui 避免覆盖普通版 dist）
let buildSrc = 'dist'
const srcIdx = process.argv.indexOf('--src')
if (srcIdx >= 0) buildSrc = process.argv[srcIdx + 1] || 'dist'

async function deploy() {
  const src = join(root, buildSrc)
  if (!existsSync(src)) {
    console.error('❌ dist/ not found. Run `npm run build` first.')
    process.exit(1)
  }

  await mkdir(target, { recursive: true })
  await cp(src, target, { recursive: true, force: true })

  const indexPath = join(target, 'index.html')
  if (existsSync(indexPath)) {
    let html = await readFile(indexPath, 'utf-8')
    html = html.replace(/src="\.\//g, 'src="/extensions/ComfyUI-Anima-Batch-LoRA/app/')
    html = html.replace(/href="\.\//g, 'href="/extensions/ComfyUI-Anima-Batch-LoRA/app/')
    await writeFile(indexPath, html, 'utf-8')
  }

  console.log(`✅ Deployed to ${target}`)
  console.log(`📦 App available at: /extensions/ComfyUI-Anima-Batch-LoRA/app/`)
}

deploy().catch(console.error)
