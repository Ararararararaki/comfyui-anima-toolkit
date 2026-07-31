import { defineConfig } from 'vite'

// Allow overriding base path for ComfyUI embedding
// Usage: COMFYUI_BASE=/extensions/ComfyUI-Anima-Batch-LoRA/app/ npm run build
const basePath = process.env.COMFYUI_BASE || './'
// ComfyUI server URL for bridge API proxy (dev mode only)
const comfyuiUrl = process.env.COMFYUI_URL || 'http://localhost:8188'

export default defineConfig({
  base: basePath,
  server: {
    proxy: {
      '/api/civitai': {
        target: 'https://civitai.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/civitai/, '/api/v1'),
        secure: false,
      },
      '/api/danbooru': {
        target: 'https://danbooru.donmai.us',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/danbooru/, ''),
        secure: false,
      },
      '/api/translate': {
        target: 'https://api.mymemory.translated.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/translate/, '/get'),
        secure: false,
      },
      // Bridge + node API proxy (dev mode: frontend → Vite → ComfyUI)
      '/anima': {
        target: comfyuiUrl,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 4096,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['zustand', 'dexie'],
        },
      },
    },
  },
})
