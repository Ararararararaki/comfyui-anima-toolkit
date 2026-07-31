// Setup ComfyUI build+deploy path
// Usage: node scripts/setup-comfyui.mjs

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const configPath = join(root, '.comfyui-path')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(r => rl.question(q, r))

async function main() {
  console.log(`\n  ⚙️   Anima LoRA Explorer — ComfyUI 部署配置\n`)

  // Check existing config
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, 'utf-8').trim()
    if (existing) {
      console.log(`  当前路径: ${resolve(existing)}`)
      const ans = (await ask('  是否重新配置？(y/N) ')).toLowerCase()
      if (ans !== 'y' && ans !== 'yes') {
        console.log(`\n  ✅ 使用现有配置。运行 npm run build:comfyui 一键部署。\n`)
        rl.close()
        return
      }
    }
  }

  // Prompt for path
  console.log(`  请选择配置方式:
    1) 输入 ComfyUI 的 custom_nodes 目录路径
    2) 输入 ComfyUI-Anima-Batch-LoRA 节点目录路径`)
  const choice = (await ask('  请选择 (1/2): ')).trim()

  let nodePath = ''
  if (choice === '1') {
    nodePath = (await ask('  输入 custom_nodes 目录路径: ')).trim().replace(/^"|"$/g, '').replace(/\\$/, '')
    const nodeDir = join(nodePath, 'ComfyUI-Anima-Batch-LoRA')
    if (!existsSync(nodeDir)) {
      const create = (await ask(`  ComfyUI-Anima-Batch-LoRA/ 不存在，是否创建？(Y/n) `)).toLowerCase()
      if (create !== 'n' && create !== 'no') {
        const { mkdirSync } = await import('fs')
        mkdirSync(nodeDir, { recursive: true })
        console.log('  ✅ 已创建 ComfyUI-Anima-Batch-LoRA/')
      }
    }
  } else {
    nodePath = (await ask('  输入 ComfyUI-Anima-Batch-LoRA 目录路径: ')).trim().replace(/^"|"$/g, '').replace(/\\$/, '')
  }

  const resolved = resolve(nodePath)
  if (!existsSync(resolved)) {
    console.log(`\n  ❌ 路径不存在: ${resolved}\n`)
    rl.close()
    return
  }

  writeFileSync(configPath, resolved, 'utf-8')
  console.log(`\n  ✅ 配置已保存: ${resolved}`)
  console.log(`  运行 npm run build:comfyui 一键构建并部署\n`)
  rl.close()
}

main().catch(e => { console.error(e); process.exit(1) })
