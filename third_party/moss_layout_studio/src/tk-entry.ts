// TK integration of ComfyUI-MOSSLayout, GPL-3.0. See NOTICE.md.
import { createApp, nextTick } from 'vue'
import Studio from './components/studio/MossLayoutStudio.vue'
import MdiIcon from './components/ui/MdiIcon.vue'

export function mountStudio(container: HTMLElement, value: unknown, onChange: (v: unknown) => void, prepareReference?: (source: string) => Promise<string>) {
  let stored = value
  const widget = { get value() { return stored }, set value(v) { stored = v; onChange(v) }, serializeValue: null as any, prepareReference }
  const app = createApp(Studio, { widget })
  app.component('MdiIcon', MdiIcon)
  const instance = app.mount(container) as any
  return {
    ready: nextTick(),
    payload: () => instance.exportPayload(),
    load: (v: unknown) => instance.loadPayload(v),
    selection: () => instance.selection(),
    captions: (draft: unknown) => instance.applyCaptions(draft),
    compiled: () => instance.compiled(),
    reference: (url: string | null, transient = false) => instance.reference(url, transient),
    destroy: () => app.unmount(),
  }
}
