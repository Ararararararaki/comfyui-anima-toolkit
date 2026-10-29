# MOSS Layout Studio source and TK integration

Source: https://github.com/0Printemps0/ComfyUI-MOSSLayout
Pinned commit: f23d29be2eb59ae1840dfa9e92b3612db78c638a (2026-10-23).
Upstream is based on nynxz/ComfyUI-IdeogramHelper by Henry Lee.
This source, its TK modifications and generated frontend remain GPL-3.0;
see LICENSE. Original copyright notices and acknowledgements are retained.

Changes: exposed a per-instance API, removed global JSON import, added explicit
draw/select tools and keyboard nudging, persisted reference backgrounds,
cleaned up pending snapshots on unmount, and added a TK build entry.
Template storage uses a browser-local IndexedDB adapter rather than requiring
the upstream plugin's independent HTTP server.

Build: `npm ci --ignore-scripts` then `npx vite build --config tk.vite.config.mts`.
The committed lockfile pins build dependencies. ComfyUI's app/API are external;
Vue is bundled inside this editor, not added to the Toolkit panel framework.
The generated module is web/js/vendor/moss_layout_studio/studio.js.
After building, run `python package_source.py` to regenerate the corresponding
source ZIP at web/licenses/moss-layout-studio-source.zip. This also delivers
the source and license notices through older Toolkit web-only update filters.

Build dependency additions: @mdi/js 7.4.47 (Apache-2.0). Run
`node generate-icons.mjs` when adding icons; it emits only used SVG paths.
MDI-LICENSE and VUE-LICENSE preserve the bundled libraries' notices.
The upstream overlay renderer is retained in services/prompt_agent/layout_overlay.py,
with lazy imports for offline module loading. TK adds per-node preview routing,
selected-region expansion, local templates retaining editor metadata, exact pixel
dimensions, automatic reference-image sizing, and cleanup on unmount.

The combined distribution containing this GPL editor must be distributed under
applicable GPL terms with corresponding source, not represented as wholly MIT.
Original MIT components retain their notices and original grants.
