import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  plugins: [vue(), {
    name: 'tk-inline-studio-css',
    apply: 'build', enforce: 'post',
    generateBundle(_, bundle) {
      let css = ''
      for (const [name, asset] of Object.entries(bundle)) {
        if (name.endsWith('.css') && asset.type === 'asset') { css += asset.source; delete bundle[name] }
      }
      const entry = bundle['studio.js']
      if (entry?.type === 'chunk') entry.code = `/*! GPL-3.0: ComfyUI-MOSSLayout f23d29be2e + TK integration. Corresponding source: third_party/moss_layout_studio; see NOTICE.md. Vue: MIT; Material Design Icons: Apache-2.0. */\nif(!document.querySelector('style[data-tk-moss-studio]')){const s=document.createElement('style');s.dataset.tkMossStudio='';s.textContent=${JSON.stringify(css)};document.head.append(s);}\n` + entry.code
    },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: '../../web/js/vendor/moss_layout_studio', emptyOutDir: false,
    minify: false, cssCodeSplit: false,
    lib: { entry: './src/tk-entry.ts', formats: ['es'], fileName: () => 'studio.js' },
    rollupOptions: {
      external: ['@comfy/app', '@comfy/api'],
      output: { paths: { '@comfy/app': '/scripts/app.js', '@comfy/api': '/scripts/api.js' }, inlineDynamicImports: true },
    },
  },
})
