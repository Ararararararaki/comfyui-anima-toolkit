declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// ComfyUI runtime shims; bare specifiers rewritten by Rollup output.paths at build.
declare module '@comfy/app' {
  import type { ComfyApp } from '@comfyorg/comfyui-frontend-types'
  export const app: ComfyApp
}

declare module '@comfy/api' {
  import type { ComfyApi } from '@comfyorg/comfyui-frontend-types'
  export const api: ComfyApi
}
