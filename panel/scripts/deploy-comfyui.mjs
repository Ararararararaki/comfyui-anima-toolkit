// Deploy built web app to the repo's app/ directory (panel/../app) by default.
// Override via --path CLI arg / COMFYUI_NODE_DIR env / .comfyui-path file.

import { cp, readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..') // panel/
const NODE_DIR_NAME = 'ComfyUI-Anima-Batch-LoRA'

// Default: deploy into this repo's app/ folder (clone-and-use layout)
let target = join(root, '..', 'app')

// Override detection: --path CLI arg > COMFYUI_NODE_DIR env var > .comfyui-path file
let nodeDir = null
const cliIdx = process.argv.indexOf('--path')
if (cliIdx >= 0) {
  nodeDir = resolve(process.argv[cliIdx + 1])
} else if (process.env.COMFYUI_NODE_DIR) {
  nodeDir = resolve(process.env.COMFYUI_NODE_DIR)
} else {
  const configPath = join(root, '.comfyui-path')
  if (existsSync(configPath)) {
    const p = readFileSync(configPath, 'utf-8').trim()
    if (p) nodeDir = resolve(p)
  }
}
if (nodeDir) {
  const baseName = nodeDir.split(/[/\\]/).pop()
  target = baseName === NODE_DIR_NAME ? join(nodeDir, 'app') : join(nodeDir, NODE_DIR_NAME, 'app')
  console.log(`📁 Deploy target: ${target}`)
}

async function deploy() {
  const src = join(root, 'dist')
  if (!existsSync(src)) {
    console.error('❌ dist/ not found. Run `npm run build` first.')
    process.exit(1)
  }

  await mkdir(target, { recursive: true })
  await cp(src, target, { recursive: true, force: true })

  // index.html uses relative asset paths (vite base './'), so the app works
  // under ANY node directory name — no path rewriting needed.

  console.log(`✅ Deployed to ${target}`)
  console.log(`📦 App available at: /extensions/ComfyUI-Anima-Batch-LoRA/app/`)
}

deploy().catch(console.error)
