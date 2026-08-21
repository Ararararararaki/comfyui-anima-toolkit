import { defineConfig } from 'vite'

// Allow overriding base path for ComfyUI embedding
// Usage: COMFYUI_BASE=/extensions/ComfyUI-Anima-Batch-LoRA/app/ npm run build
const basePath = process.env.COMFYUI_BASE || './'
// ComfyUI server URL for bridge API proxy (dev mode only)
const comfyuiUrl = process.env.COMFYUI_URL || 'http://localhost:8188'

export default defineConfig({
  base: basePath,
  define: {
    // 面板构建时间戳（界面右上角显示，用于确认是否加载了新版本）
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
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
      // 多源翻译走 ComfyUI 后端（dev 与生产同一实现；后端不可用时翻译失败属预期）
      '/api/translate': {
        target: comfyuiUrl,
        changeOrigin: true,
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
