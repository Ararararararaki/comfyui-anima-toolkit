// Cross-platform build for the ComfyUI panel app.
// vite base stays './' (relative) so the built app works under ANY node directory name.
// Works on Windows (npm on cmd) and Linux (GitHub Actions).
import { execSync } from 'child_process'

console.log('[build:comfyui] typecheck (tsc)...')
execSync('npx tsc', { stdio: 'inherit' })

console.log('[build:comfyui] vite build...')
execSync('npx vite build', { stdio: 'inherit' })

console.log('[build:comfyui] deploy to app/...')
execSync('node scripts/deploy-comfyui.mjs', { stdio: 'inherit' })

console.log('[build:comfyui] done ✅')
