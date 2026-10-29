import { app } from '@comfy/app'

import { mountWidget } from '@/lib/mountWidget'
import MossLayoutStudio from '@/components/studio/MossLayoutStudio.vue'
import '@/extensions/scrollFix'

const extension: Record<string, unknown> = {
  name: 'mosslayout.studio',
  getCustomWidgets() {
    return {
      // Low minHeight (ComfyUI's hard floor) so the node can be shrunk.
      MOSS_LAYOUT_STUDIO(node: unknown) {
        return mountWidget(node as Parameters<typeof mountWidget>[0], {
          widgetName: 'studio',
          widgetType: 'MOSS_LAYOUT_STUDIO',
          component: MossLayoutStudio,
          minHeight: 200,
          defaultValue: null,
        })
      },
    } as never
  },
  nodeCreated(node: unknown) {
    const lg = node as {
      constructor?: { comfyClass?: string }
      size: [number, number]
      setSize: (s: [number, number]) => void
    }
    if (lg.constructor?.comfyClass === 'MossLayoutStudio') lg.setSize([Math.max(lg.size[0], 560), Math.max(lg.size[1], 760)])
  },
}

app.registerExtension(extension as never)
