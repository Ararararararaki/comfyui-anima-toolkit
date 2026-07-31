// Cross-platform build for the ComfyUI panel app.
// Sets COMFYUI_BASE (vite base path), then typechecks + builds + deploys into ../app.
// Works on Windows (npm on cmd) and Linux (GitHub Actions).
import { execSync } from 'child_process'

process.env.COMFYUI_BASE = '/extensions/ComfyUI-Anima-Batch-LoRA/app/'

console.log('[build:comfyui] typecheck (tsc)...')
execSync('npx tsc', { stdio: 'inherit' })

console.log('[build:comfyui] vite build...')
execSync('npx vite build', { stdio: 'inherit' })

console.log('[build:comfyui] deploy to app/...')
execSync('node scripts/deploy-comfyui.mjs', { stdio: 'inherit' })

console.log('[build:comfyui] done ✅')
