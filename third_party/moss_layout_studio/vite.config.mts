import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

// ComfyUI serves `app`/`api` at runtime — keep them external, mapped to the host paths.
const COMFY_RUNTIME_MODULES: Record<string, string> = {
  "@comfy/app": "../../../scripts/app.js",
  "@comfy/api": "../../../scripts/api.js",
};

// ComfyUI loads .js but ignores sibling .css, so fold the CSS into main.js.
function inlineCssPlugin(): Plugin {
  return {
    name: "moss-inline-css",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      let css = "";
      for (const [name, asset] of Object.entries(bundle)) {
        if (name.endsWith(".css") && asset.type === "asset") {
          css += String(asset.source);
          delete bundle[name];
        }
      }
      const main = bundle["main.js"];
      if (!css || main?.type !== "chunk") return;
      main.code =
        `(function(){var s=document.createElement('style');` +
        `s.setAttribute('data-extension','comfyui-mosslayout');` +
        `s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})();` +
        main.code;
    },
  };
}

export default defineConfig({
  plugins: [vue(), inlineCssPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2022",
    outDir: "web",
    emptyOutDir: true,
    minify: false, // committed to git + served locally; keep it readable
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    lib: {
      entry: fileURLToPath(new URL("./src/main.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: (id) => id in COMFY_RUNTIME_MODULES,
      output: {
        paths: COMFY_RUNTIME_MODULES,
        assetFileNames: "assets/[name].[ext]",
        entryFileNames: "main.js",
        inlineDynamicImports: true,
      },
    },
  },
});
