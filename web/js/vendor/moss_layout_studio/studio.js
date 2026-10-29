/*! GPL-3.0: ComfyUI-MOSSLayout f23d29be2e + TK integration. Corresponding source: third_party/moss_layout_studio; see NOTICE.md. Vue: MIT; Material Design Icons: Apache-2.0. */
if(!document.querySelector('style[data-tk-moss-studio]')){const s=document.createElement('style');s.dataset.tkMossStudio='';s.textContent="\n.ui-btn[data-v-7a0f70ea] {\r\n  display: inline-flex; align-items: center; justify-content: center; gap: 4px;\r\n  min-height: 24px; padding: 3px 9px; box-sizing: border-box;\r\n  background: var(--st-btn); color: var(--st-text); border: 1px solid var(--st-border);\r\n  border-radius: var(--radius-sm, 5px); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit;\r\n  white-space: nowrap; transition: border-color .1s, background .1s;\n}\n.ui-btn.icon[data-v-7a0f70ea] { min-width: 26px; padding: 0 6px; font-size: 12px;\n}\n.ui-btn[data-v-7a0f70ea] .mdi { font-size: 15px; line-height: 1;\n}\n.ui-btn[data-v-7a0f70ea]:hover { border-color: var(--st-accent);\n}\n.ui-btn[data-v-7a0f70ea]:disabled { opacity: .4; cursor: default;\n}\n.ui-btn[data-v-7a0f70ea]:disabled:hover { border-color: var(--st-border);\n}\n.ui-btn.on[data-v-7a0f70ea],\r\n.ui-btn.primary[data-v-7a0f70ea] { background: var(--st-accent); border-color: var(--st-accent); color: var(--st-on-accent, #fff);\n}\n.ui-btn.primary[data-v-7a0f70ea]:hover { filter: brightness(1.08);\n}\r\n\n.ui-pop[data-v-3afe332d] { position: relative; display: inline-flex;\n}\n.ui-pop-panel[data-v-3afe332d] {\r\n  position: absolute; top: calc(100% + 5px); z-index: 50;\r\n  background: var(--st-panel); border: 1px solid var(--st-border); border-radius: var(--st-radius, 6px);\r\n  padding: 10px 12px; min-width: 240px; max-width: 320px; max-height: 360px; overflow-y: auto;\r\n  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);\r\n  font-size: 11px; line-height: 1.5; color: var(--st-text); cursor: default;\n}\n.ui-pop-panel.right[data-v-3afe332d] { right: 0;\n}\n.ui-pop-panel.left[data-v-3afe332d] { left: 0;\n}\n.ui-pop-panel.up[data-v-3afe332d] { top: auto; bottom: calc(100% + 5px);\n}\r\n\n.canvas-wrap[data-v-d0cccbb5] { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; align-items: center;\n}\n.toolbar[data-v-d0cccbb5] { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; align-self: stretch; flex: none;\n}\n.mdi[data-v-d0cccbb5] { font-size: 15px; line-height: 1;\n}\n.tag .mdi[data-v-d0cccbb5] { font-size: 1em;\n}\n.seg[data-v-d0cccbb5] { display: flex; gap: 2px;\n}\n.divider[data-v-d0cccbb5] { width: 1px; height: 18px; background: var(--st-border); margin: 0 2px;\n}\n.spacer[data-v-d0cccbb5] { flex: 1 1 auto;\n}\n.cmenu[data-v-d0cccbb5] { display: flex; flex-direction: column; gap: 5px; min-width: 170px;\n}\n.citem[data-v-d0cccbb5] { display: flex; align-items: center; gap: 6px; text-align: left; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 5px; padding: 5px 8px; font-size: 11px; cursor: pointer;\n}\n.citem[data-v-d0cccbb5]:hover { border-color: var(--st-accent);\n}\n.citem.on[data-v-d0cccbb5] { background: var(--st-accent); border-color: var(--st-accent); color: var(--st-on-accent, #fff);\n}\n.crow[data-v-d0cccbb5] { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--st-muted);\n}\n.crow input[type='range'][data-v-d0cccbb5] { flex: 1; accent-color: var(--st-accent);\n}\n.crow input[type='number'][data-v-d0cccbb5] { width: 54px; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; padding: 3px; font-size: 11px;\n}\n.ckrow[data-v-d0cccbb5] { gap: 12px;\n}\n.cdiv[data-v-d0cccbb5] { border-top: 1px solid var(--st-border); margin: 3px 0;\n}\n.cgroup[data-v-d0cccbb5] { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--st-muted);\n}\n.chint[data-v-d0cccbb5] { margin: 2px 0 0; font-size: 10px; line-height: 1.4; color: var(--st-muted);\n}\n.cic[data-v-d0cccbb5] { display: inline-flex; align-items: center; justify-content: center; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; width: 26px; height: 24px; cursor: pointer;\n}\n.cic[data-v-d0cccbb5]:hover { border-color: var(--st-accent);\n}\n.stage[data-v-d0cccbb5] {\r\n  position: relative; flex: none; max-width: 100%; background: var(--st-input);\r\n  border: 1px solid var(--st-border); border-radius: 6px; overflow: hidden;\r\n  touch-action: none; user-select: none; cursor: crosshair;\n}\n.stage.dragging[data-v-d0cccbb5] { cursor: grabbing;\n}\n.stage[data-v-d0cccbb5]:focus { outline: none;\n}\n.backdrop[data-v-d0cccbb5] { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none;\n}\r\n/* no z-index: DOM order paints it above the backdrop but below the grid/boxes */\n.livelayer[data-v-d0cccbb5] { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none;\n}\n.livebadge[data-v-d0cccbb5] {\r\n  position: absolute; top: 6px; left: 6px; z-index: 2; pointer-events: none;\r\n  display: inline-flex; align-items: center; gap: 3px;\r\n  background: rgba(0,0,0,.6); color: #fff; border-radius: 4px;\r\n  padding: 1px 6px 1px 4px; font-size: 9px; font-weight: 700;\r\n  text-transform: uppercase; letter-spacing: .5px;\n}\n.livebadge .mdi[data-v-d0cccbb5] { font-size: 11px; color: #ef4444; animation: livepulse-d0cccbb5 1.2s ease-in-out infinite;\n}\n@keyframes livepulse-d0cccbb5 {\n0%, 100% { opacity: 1;\n}\n50% { opacity: .25;\n}\n}\n.grid[data-v-d0cccbb5] {\r\n  position: absolute; inset: 0; pointer-events: none;\r\n  background-image: linear-gradient(to right, rgba(128,128,128,.18) 1px, transparent 1px),\r\n    linear-gradient(to bottom, rgba(128,128,128,.18) 1px, transparent 1px);\r\n  background-size: 10% 10%;\n}\n.box[data-v-d0cccbb5] { position: absolute; box-sizing: border-box; cursor: move; background: transparent; transition: background .1s;\n}\r\n/* border as ::after (painted after children) so the outline sits over the label */\n.box[data-v-d0cccbb5]::after { content: ''; position: absolute; inset: 0; border: 2px solid var(--c, #60a5fa); pointer-events: none;\n}\n.box[data-v-d0cccbb5]:hover { background: var(--fill);\n}\n.box.sel[data-v-d0cccbb5] { background: var(--fill); box-shadow: 0 0 0 1.5px var(--st-accent, #60a5fa); z-index: 4;\n}\n.box.primary[data-v-d0cccbb5] { box-shadow: 0 0 0 1px #fff, 0 0 0 2px var(--st-accent, #60a5fa), 0 0 10px rgba(0,0,0,.6); z-index: 5;\n}\n.box.draft[data-v-d0cccbb5] { opacity: 0.8; pointer-events: none; background: rgba(156,163,175,.12);\n}\n.box.draft[data-v-d0cccbb5]::after { border-style: dashed;\n}\n.groupframe[data-v-d0cccbb5] { position: absolute; box-sizing: border-box; border: 1px dashed var(--gc, var(--st-accent, #60a5fa)); background: transparent; z-index: 6; pointer-events: none;\n}\n.groupframe .h[data-v-d0cccbb5] { pointer-events: auto; background: var(--gc, var(--st-accent, #60a5fa)); border-color: #fff;\n}\n.marquee[data-v-d0cccbb5] { position: absolute; box-sizing: border-box; border: 1px solid var(--st-accent, #60a5fa); background: color-mix(in srgb, var(--st-accent, #60a5fa) 15%, transparent); z-index: 7; pointer-events: none;\n}\n.tag[data-v-d0cccbb5] {\r\n  position: absolute; top: 0; left: 0; transform: translateY(-100%);\r\n  display: inline-flex; align-items: center; gap: 3px;\r\n  font-size: 10px; line-height: 1.4; padding: 1px 5px; white-space: nowrap;\r\n  max-width: 240px; overflow: hidden; border-radius: 3px 3px 0 0; pointer-events: none;\n}\n.tag .tagi[data-v-d0cccbb5] { flex: none;\n}\n.tag .tagn[data-v-d0cccbb5] { flex: none; font-weight: 700; font-variant-numeric: tabular-nums;\n}\r\n/* text hidden by default (icon + index only); shown on hover/selection */\n.tag .tagt[data-v-d0cccbb5] { display: none; overflow: hidden; text-overflow: ellipsis; max-width: 200px;\n}\n.box:hover .tag .tagt[data-v-d0cccbb5], .box.sel .tag .tagt[data-v-d0cccbb5], .box.primary .tag .tagt[data-v-d0cccbb5] { display: inline;\n}\n.tag .tagt[data-v-d0cccbb5]::before { content: '· ';\n}\r\n/* per-group color tab on the label's left edge; negative margins bleed to the tag edges */\n.tag.grouped .gseg[data-v-d0cccbb5] { flex: none; align-self: stretch; width: 4px; margin: -1px 3px -1px -5px; border-radius: 3px 0 0 0; background: var(--gc, var(--st-accent));\n}\n.h[data-v-d0cccbb5] { position: absolute; width: 11px; height: 11px; background: #fff; border: 1px solid #333; border-radius: 2px; z-index: 1;\n}\n.h-nw[data-v-d0cccbb5] { top: -6px; left: -6px; cursor: nwse-resize;\n}\n.h-n[data-v-d0cccbb5]  { top: -6px; left: 50%; margin-left: -5px; cursor: ns-resize;\n}\n.h-ne[data-v-d0cccbb5] { top: -6px; right: -6px; cursor: nesw-resize;\n}\n.h-e[data-v-d0cccbb5]  { top: 50%; right: -6px; margin-top: -5px; cursor: ew-resize;\n}\n.h-se[data-v-d0cccbb5] { bottom: -6px; right: -6px; cursor: nwse-resize;\n}\n.h-s[data-v-d0cccbb5]  { bottom: -6px; left: 50%; margin-left: -5px; cursor: ns-resize;\n}\n.h-sw[data-v-d0cccbb5] { bottom: -6px; left: -6px; cursor: nesw-resize;\n}\n.h-w[data-v-d0cccbb5]  { top: 50%; left: -6px; margin-top: -5px; cursor: ew-resize;\n}\r\n\r\n/* absolute over .studio (which is position:relative) */\n.liboverlay[data-v-18ee3e52] {\r\n  position: absolute; inset: 0; z-index: 60;\r\n  background: color-mix(in srgb, var(--st-bg, #1a1a1f) 72%, transparent);\r\n  backdrop-filter: blur(4px);\r\n  display: flex; padding: 12px; box-sizing: border-box;\r\n  border-radius: 8px; /* follow the node's rounded corners */\n}\n.libpanel[data-v-18ee3e52] {\r\n  flex: 1; min-height: 0; display: flex; flex-direction: column;\r\n  background: var(--st-panel); border: 1px solid var(--st-border); border-radius: calc(var(--st-radius, 6px) + 3px);\r\n  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); overflow: hidden;\n}\r\n\r\n/* ── header ─────────────────────────────────────────────── */\n.libhead[data-v-18ee3e52] { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--st-border); flex-wrap: wrap;\n}\n.libhead .t[data-v-18ee3e52] { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 700; letter-spacing: .2px;\n}\n.libhead .t .mdi[data-v-18ee3e52] { font-size: 17px; color: var(--st-accent);\n}\n.count[data-v-18ee3e52] {\r\n  display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px;\r\n  padding: 0 6px; border-radius: 9px; background: color-mix(in srgb, var(--st-accent) 22%, transparent);\r\n  color: var(--st-accent); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;\n}\n.grow[data-v-18ee3e52] { flex: 1;\n}\n.search[data-v-18ee3e52] { display: flex; align-items: center; gap: 4px; background: var(--st-input); border: 1px solid var(--st-border); border-radius: 7px; padding: 0 6px; height: 28px; transition: border-color .12s;\n}\n.search[data-v-18ee3e52]:focus-within { border-color: var(--st-accent);\n}\n.search .mdi[data-v-18ee3e52] { font-size: 14px; color: var(--st-muted);\n}\n.search input[data-v-18ee3e52] { background: none; border: none; outline: none; color: var(--st-text); font-size: 11px; font-family: inherit; width: 130px; padding: 0;\n}\n.search .clr[data-v-18ee3e52] { display: inline-flex; background: none; border: none; color: var(--st-muted); cursor: pointer; padding: 0;\n}\n.search .clr[data-v-18ee3e52]:hover { color: var(--st-text);\n}\r\n\r\n/* ── body / grid ────────────────────────────────────────── */\n.libbody[data-v-18ee3e52] { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 11px;\n}\n.grid[data-v-18ee3e52] { display: grid; grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); gap: 11px;\n}\n.tile[data-v-18ee3e52] {\r\n  position: relative; display: flex; flex-direction: column; gap: 6px; padding: 6px;\r\n  background: var(--st-input); border: 1px solid var(--st-border); border-radius: calc(var(--st-radius, 6px) + 1px);\r\n  transition: border-color .12s, box-shadow .12s, transform .1s;\n}\n.tile[data-v-18ee3e52]:hover { border-color: var(--st-accent); box-shadow: 0 0 0 1px var(--st-accent) inset, 0 6px 16px rgba(0, 0, 0, .35); transform: translateY(-2px);\n}\n.tile.confirming[data-v-18ee3e52] { border-color: #ef4444; box-shadow: 0 0 0 1px #ef4444 inset;\n}\n.thumb[data-v-18ee3e52] {\r\n  position: relative; width: 100%; aspect-ratio: 1; border-radius: 5px; overflow: hidden;\r\n  border: none; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center;\r\n  background: color-mix(in srgb, var(--st-bg, #1a1a1f) 60%, #000);\n}\r\n/* cover so the thumbnail fills the frame without letterbox bars */\n.thumb img[data-v-18ee3e52] { width: 100%; height: 100%; object-fit: cover; display: block;\n}\n.thumb .ph[data-v-18ee3e52] { font-size: 24px; color: var(--st-muted); opacity: .45;\n}\n.badge[data-v-18ee3e52] {\r\n  position: absolute; top: 5px; left: 5px; display: inline-flex; align-items: center; gap: 3px;\r\n  padding: 1px 6px; border-radius: 8px; background: rgba(0, 0, 0, .62); color: #fff;\r\n  font-size: 10px; font-weight: 600; backdrop-filter: blur(2px);\n}\n.badge .mdi[data-v-18ee3e52] { font-size: 11px;\n}\n.del[data-v-18ee3e52] {\r\n  position: absolute; top: 9px; right: 9px; z-index: 2; display: inline-flex; align-items: center; justify-content: center;\r\n  width: 24px; height: 24px; border-radius: 6px; background: rgba(0, 0, 0, .55); border: none; color: #fff;\r\n  cursor: pointer; opacity: 0; transition: opacity .12s, background .12s;\n}\n.del .mdi[data-v-18ee3e52] { font-size: 15px;\n}\n.tile:hover .del[data-v-18ee3e52] { opacity: 1;\n}\n.del[data-v-18ee3e52]:hover { background: #dc2626;\n}\n.name[data-v-18ee3e52] { font-size: 11px; color: var(--st-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 2px;\n}\r\n\r\n/* delete confirm overlay over the tile */\n.confirm[data-v-18ee3e52] {\r\n  position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px;\r\n  background: color-mix(in srgb, var(--st-panel) 88%, transparent); backdrop-filter: blur(2px);\r\n  border-radius: inherit; padding: 8px; text-align: center;\n}\n.confirm .q[data-v-18ee3e52] { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--st-text);\n}\n.confirm .q .mdi[data-v-18ee3e52] { color: #ef4444; font-size: 15px;\n}\n.cbtns[data-v-18ee3e52] { display: flex; gap: 6px;\n}\n.cbtns button[data-v-18ee3e52] { border: none; border-radius: 6px; padding: 5px 11px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit;\n}\n.cbtns .yes[data-v-18ee3e52] { background: #dc2626; color: #fff;\n}\n.cbtns .yes[data-v-18ee3e52]:hover { background: #ef4444;\n}\n.cbtns .no[data-v-18ee3e52] { background: var(--st-btn); color: var(--st-text); border: 1px solid var(--st-border);\n}\n.cbtns .no[data-v-18ee3e52]:hover { border-color: var(--st-accent);\n}\r\n\r\n/* ── empty / loading ────────────────────────────────────── */\n.empty[data-v-18ee3e52] { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; height: 100%; min-height: 180px; color: var(--st-muted); font-size: 12px; text-align: center;\n}\n.empty .mdi[data-v-18ee3e52] { font-size: 17px;\n}\n.empty .big[data-v-18ee3e52] { font-size: 40px; opacity: .35;\n}\n.empty small[data-v-18ee3e52] { font-size: 11px; opacity: .8;\n}\r\n\r\n/* ── footer / save bar ──────────────────────────────────── */\n.libfoot[data-v-18ee3e52] { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-top: 1px solid var(--st-border); background: color-mix(in srgb, var(--st-bg, #1a1a1f) 35%, transparent); flex-wrap: wrap;\n}\n.libfoot .fic[data-v-18ee3e52] { font-size: 16px; color: var(--st-muted);\n}\n.nm[data-v-18ee3e52] { background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 7px; padding: 6px 9px; font-size: 11px; font-family: inherit; width: 150px;\n}\n.nm[data-v-18ee3e52]:focus { outline: none; border-color: var(--st-accent);\n}\n.thumbck[data-v-18ee3e52] { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--st-muted); white-space: nowrap; cursor: pointer;\n}\n.thumbck.disabled[data-v-18ee3e52] { opacity: .45; cursor: not-allowed;\n}\n.flash[data-v-18ee3e52] { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--st-accent); white-space: nowrap;\n}\n.flash .mdi[data-v-18ee3e52] { font-size: 14px;\n}\n.flash.err[data-v-18ee3e52] { color: #f87171;\n}\n.flash-enter-active[data-v-18ee3e52], .flash-leave-active[data-v-18ee3e52] { transition: opacity .18s;\n}\n.flash-enter-from[data-v-18ee3e52], .flash-leave-to[data-v-18ee3e52] { opacity: 0;\n}\r\n\n.ui-card[data-v-665b913d] {\r\n  background: var(--st-panel); border: 1px solid var(--st-border); border-radius: var(--st-radius, 6px);\r\n  padding: 8px; display: flex; flex-direction: column; gap: 7px;\n}\n.ui-card-head[data-v-665b913d] { display: flex; align-items: center; justify-content: space-between; gap: 8px;\n}\n.ui-card-title[data-v-665b913d] { font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--st-muted);\n}\r\n\n.palette[data-v-bd1d882e] { display: flex; flex-direction: column; gap: 4px;\n}\n.swatches[data-v-bd1d882e] { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;\n}\n.swatch-wrap[data-v-bd1d882e] { position: relative;\n}\n.swatch[data-v-bd1d882e] {\r\n  display: block; width: 26px; height: 26px; border-radius: 5px;\r\n  border: 1px solid var(--st-border); cursor: pointer; overflow: hidden;\n}\n.swatch input[data-v-bd1d882e] { opacity: 0; width: 100%; height: 100%; cursor: pointer;\n}\n.add[data-v-bd1d882e] {\r\n  width: 26px; height: 26px; border-radius: 5px; cursor: pointer;\r\n  border: 1px dashed var(--st-border); background: transparent;\r\n  color: var(--st-muted); font-size: 16px; line-height: 1;\n}\n.hint[data-v-bd1d882e] { font-size: 10px; color: var(--st-muted);\n}\r\n\n.combo[data-v-2f602dd0] { display: flex; gap: 4px;\n}\n.combo input[data-v-2f602dd0] { flex: 1; min-width: 0; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 5px; padding: 6px; font-size: 12px;\n}\n.cpick[data-v-2f602dd0] { flex: none; width: 74px; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-muted); border-radius: 5px; cursor: pointer; font-size: 11px; padding: 0 2px;\n}\n.cpick[data-v-2f602dd0]:hover { border-color: var(--st-accent);\n}\n.cpick[data-v-2f602dd0]:hover { border-color: var(--st-accent);\n}\r\n\n.chead[data-v-f5d58465] { display: flex; align-items: center; gap: 4px;\n}\n.grow[data-v-f5d58465] { flex: 1 1 auto;\n}\n.fold[data-v-f5d58465] { display: inline-flex; align-items: center; background: none; border: none; cursor: pointer; color: var(--st-muted); padding: 0; margin-left: -3px;\n}\n.fold[data-v-f5d58465]:hover { color: var(--st-text);\n}\n.fold .mdi[data-v-f5d58465] { font-size: 16px; line-height: 1;\n}\n.lhead[data-v-f5d58465] { display: inline-flex; align-items: center; font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--st-muted);\n}\n.canvasmode[data-v-f5d58465] { background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 5px; font-size: 11px; padding: 2px 4px;\n}\n.field[data-v-f5d58465] { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--st-muted);\n}\n.field textarea[data-v-f5d58465] {\r\n  background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text);\r\n  border-radius: 5px; padding: 6px; font-size: 12px; resize: vertical; font-family: inherit; line-height: 1.45;\r\n  min-height: 72px;\n}\n.field textarea[data-v-f5d58465]:focus, .canvasmode[data-v-f5d58465]:focus { outline: none; border-color: var(--st-accent);\n}\n.presetsck[data-v-f5d58465] { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--st-muted); cursor: pointer;\n}\r\n\n.adds[data-v-01882720] { display: flex; gap: 4px;\n}\n.chead[data-v-01882720] { display: flex; align-items: center; gap: 4px;\n}\n.lhead[data-v-01882720] { display: inline-flex; align-items: center; gap: 1px; background: none; border: none; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--st-muted); padding: 0;\n}\n.lhead[data-v-01882720]:hover { color: var(--st-text);\n}\n.lhead .mdi[data-v-01882720] { font-size: 15px;\n}\n.lhead .flt[data-v-01882720] { font-size: 13px; margin-right: 2px;\n}\n.lmenu[data-v-01882720] { display: flex; flex-direction: column; gap: 1px; min-width: 150px;\n}\n.litem[data-v-01882720] { display: flex; align-items: center; gap: 8px; text-align: left; background: none; border: none; color: var(--st-text); padding: 6px 8px; border-radius: 5px; font-size: 11px; cursor: pointer;\n}\n.litem[data-v-01882720]:hover { background: var(--st-btn);\n}\n.litem.on[data-v-01882720] { color: var(--st-accent);\n}\n.litem .mdi[data-v-01882720] { font-size: 15px; color: var(--st-muted);\n}\n.litem.on .mdi[data-v-01882720] { color: var(--st-accent);\n}\nul[data-v-01882720] { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; flex: 1 1 auto; min-height: 0; overflow-y: auto;\n}\nli[data-v-01882720] {\r\n  position: relative;\r\n  display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 5px;\r\n  background: var(--st-input); border: 1px solid transparent; cursor: pointer; font-size: 12px; color: var(--st-text);\r\n  transition: opacity .12s, box-shadow .12s, background .12s;\n}\nli[data-v-01882720]:hover { border-color: var(--st-border);\n}\nli.sel[data-v-01882720] { border-color: var(--st-accent);\n}\r\n/* primary = the item the editor targets */\nli.primary[data-v-01882720] { border-color: var(--st-accent); background: color-mix(in srgb, var(--st-accent) 18%, var(--st-input));\n}\nli.primary .snip[data-v-01882720] { font-weight: 600;\n}\r\n/* per-group color sliver; absolute inside the existing padding so rows stay aligned */\nli.grouped[data-v-01882720]::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; border-radius: 5px 0 0 5px; background: var(--gc, var(--st-accent));\n}\nli.dragging[data-v-01882720] { opacity: .35;\n}\nli.dragover[data-v-01882720] { box-shadow: inset 0 3px 0 -1px var(--st-accent); background: color-mix(in srgb, var(--st-accent) 12%, var(--st-input));\n}\n.handle[data-v-01882720] { flex: none; color: var(--st-muted); cursor: grab; font-size: 14px; opacity: .3; margin: 0 -4px 0 -2px; transition: opacity .12s, color .12s;\n}\nli:hover .handle[data-v-01882720] { opacity: .85;\n}\n.handle[data-v-01882720]:hover { color: var(--st-accent);\n}\n.handle[data-v-01882720]:active { cursor: grabbing;\n}\n.typeicon[data-v-01882720] { flex: none; color: var(--st-muted); line-height: 1; display: inline-flex;\n}\n.typeicon .mdi[data-v-01882720] { font-size: 15px;\n}\n.idxchip[data-v-01882720] {\r\n  flex: none; min-width: 17px; height: 16px; padding: 0 4px; box-sizing: border-box;\r\n  display: inline-flex; align-items: center; justify-content: center;\r\n  border-radius: 4px; background: var(--st-accent); color: #fff;\r\n  font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums;\r\n  text-shadow: 0 1px 1px rgba(0, 0, 0, .35);\n}\n.link[data-v-01882720] { flex: none; font-size: 13px; color: var(--st-muted);\n}\n.snip[data-v-01882720] { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\n}\n.more[data-v-01882720] { display: inline-flex; align-items: center; justify-content: center; flex: none; background: none; border: none; color: var(--st-muted); border-radius: 4px; width: 20px; height: 20px; cursor: pointer; padding: 0; opacity: 0; transition: opacity .12s;\n}\n.more .mdi[data-v-01882720] { font-size: 16px;\n}\nli:hover .more[data-v-01882720], li.sel .more[data-v-01882720] { opacity: 1;\n}\n.more[data-v-01882720]:hover { color: var(--st-text); background: var(--st-btn);\n}\n.empty[data-v-01882720] { font-size: 11px; color: var(--st-muted); margin: 2px 0;\n}\r\n\n.jctrl[data-v-f6a6cf00] { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap;\n}\n.grow[data-v-f6a6cf00] { flex: 1 1 auto;\n}\n.jstat[data-v-f6a6cf00] { font-size: 15px; line-height: 1; cursor: help;\n}\n.jstat.good[data-v-f6a6cf00] { color: #34d399;\n}\n.jstat.warn[data-v-f6a6cf00] { color: #f59e0b;\n}\n.jstat.bad[data-v-f6a6cf00] { color: #f87171;\n}\n.jnote[data-v-f6a6cf00] {\r\n  max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\r\n  font-size: 10px; color: var(--st-muted); background: var(--st-btn);\r\n  border: 1px solid var(--st-border); border-radius: var(--radius-sm, 5px);\r\n  padding: 2px 6px; cursor: help;\n}\n.jtok[data-v-f6a6cf00] { display: inline-flex; align-items: center; min-height: 24px; box-sizing: border-box; font-size: 10px; color: var(--st-muted); font-family: ui-monospace, monospace; background: var(--st-btn); border: 1px solid var(--st-border); border-radius: var(--radius-sm, 5px); padding: 0 7px; cursor: help;\n}\r\n\n.ehead[data-v-9e084768] { display: flex; align-items: center; gap: 6px; width: 100%; flex-wrap: wrap;\n}\n.coordinates[data-v-9e084768]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;font-size:10px;color:var(--st-muted)}\n.coordinates label[data-v-9e084768]{display:flex;flex-direction:column;gap:3px}.coordinates input[data-v-9e084768]{min-width:0;width:100%;background:var(--st-input);color:var(--st-text);border:1px solid var(--st-border);border-radius:4px;padding:4px}\n.grow[data-v-9e084768] { flex: 1 1 auto;\n}\r\n/* overflow:hidden clips the absolute color input to the chip so it can't overlap the type buttons */\n.idchip[data-v-9e084768] { position: relative; display: inline-flex; flex: none; cursor: pointer; overflow: hidden; border-radius: 5px;\n}\n.idchip .n[data-v-9e084768] {\r\n  display: inline-flex; align-items: center; justify-content: center;\r\n  min-width: 22px; height: 22px; padding: 0 6px; box-sizing: border-box;\r\n  border-radius: 5px; color: #fff; font-size: 11px; font-weight: 700;\r\n  font-variant-numeric: tabular-nums; text-shadow: 0 1px 1px rgba(0, 0, 0, .35);\r\n  border: 1px solid rgba(0, 0, 0, .25);\n}\n.idchip input[data-v-9e084768] { position: absolute; inset: 0; opacity: 0; cursor: pointer;\n}\n.seg[data-v-9e084768] { display: flex; gap: 2px;\n}\n.filine[data-v-9e084768] { display: flex; gap: 8px; align-items: flex-start; font-size: 11px; color: var(--st-muted);\n}\n.filine > span[data-v-9e084768] { width: 44px; flex: none; padding-top: 5px; text-align: right;\n}\n.filine input[type='text'][data-v-9e084768], .filine textarea[data-v-9e084768] {\r\n  flex: 1; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text);\r\n  border-radius: 5px; padding: 6px; font-size: 12px; resize: vertical; font-family: inherit;\n}\n.filine[data-v-9e084768] .palette { flex: 1;\n}\r\n\n.jcard[data-v-d977b910] { display: flex; flex-direction: column; gap: 6px; min-height: 0;\n}\n.json[data-v-d977b910] {\r\n  background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text);\r\n  border-radius: 6px; padding: 8px; font-size: 11px; line-height: 1.5;\r\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\r\n  max-height: 240px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word;\n}\ntextarea.json[data-v-d977b910] { width: 100%; box-sizing: border-box; resize: vertical; min-height: 140px;\n}\ntextarea.json[data-v-d977b910]:focus, textarea.json.bad[data-v-d977b910]:focus { outline: none;\n}\ntextarea.json.bad[data-v-d977b910] { border-color: #f87171;\n}\n.compiled[data-v-d977b910] { position: relative; display: flex; flex-direction: column; gap: 2px;\n}\n.clbl[data-v-d977b910] { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--st-muted);\n}\n.cbtn[data-v-d977b910] { position: absolute; right: 10px; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-muted); border-radius: 4px; width: 22px; height: 20px; cursor: pointer; font-size: 12px; line-height: 1;\n}\n.cbtn[data-v-d977b910]:hover { color: var(--st-text); border-color: var(--st-accent);\n}\n.cline[data-v-d977b910] {\r\n  background: var(--st-input); border: 1px dashed var(--st-border); color: var(--st-muted);\r\n  border-radius: 6px; padding: 6px 8px; font-size: 10px; line-height: 1.5;\r\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\r\n  max-height: 110px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-all;\n}\n.parseerr[data-v-d977b910] { display: flex; flex-direction: column; gap: 4px;\n}\n.errhead[data-v-d977b910] { display: flex; align-items: center; gap: 6px;\n}\n.errhead .msg[data-v-d977b910] { flex: 1; font-size: 11px; color: #f87171; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\n}\n.ebtn[data-v-d977b910] { background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-muted); border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer;\n}\n.ebtn[data-v-d977b910]:hover { color: var(--st-text); border-color: var(--st-accent);\n}\n.ebtn.clamp[data-v-d977b910] { color: #fbbf24; border-color: rgba(251, 191, 36, .45);\n}\n.errframe[data-v-d977b910] {\r\n  background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text);\r\n  border-radius: 6px; padding: 6px 8px; font-size: 10px; line-height: 1.5;\r\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\r\n  max-height: 120px; overflow: auto; margin: 0; cursor: pointer;\n}\n.warnlist[data-v-d977b910] { margin: 0; padding: 0 0 0 16px; font-size: 10px; color: #f59e0b; display: flex; flex-direction: column; gap: 2px;\n}\n.errlist[data-v-d977b910] { margin: 0; padding: 0 0 0 16px; font-size: 10px; color: #f87171; display: flex; flex-direction: column; gap: 2px;\n}\n.applyerr[data-v-d977b910] { display: flex; flex-direction: column; gap: 4px;\n}\n.syncbox[data-v-d977b910] { border-top: 1px solid var(--st-border); padding-top: 6px; display: flex; flex-direction: column; gap: 3px;\n}\n.syncbad[data-v-d977b910] { font-size: 10px; color: #f87171; overflow-wrap: anywhere;\n}\n.syncnote[data-v-d977b910] { font-size: 10px; color: #34d399; overflow-wrap: anywhere;\n}\r\n\n.ctxbg[data-v-881d670b] { position: fixed; inset: 0; z-index: 10000;\n}\n.ctx[data-v-881d670b] {\r\n  --st-panel: var(--comfy-menu-secondary-bg, #202026);\r\n  --st-input: var(--comfy-input-bg, #15151a);\r\n  --st-btn: var(--comfy-input-bg, #2a2a30);\r\n  --st-text: var(--input-text, #e5e5ea);\r\n  --st-muted: var(--descrip-text, #9aa0aa);\r\n  --st-border: var(--border-color, #3a3a44);\r\n  --st-accent: var(--p-primary-color, #3b82f6);\r\n  --st-radius: var(--radius-md, 6px);\r\n  position: fixed; min-width: 172px; z-index: 10001;\r\n  background: var(--st-panel); border: 1px solid var(--st-border); border-radius: var(--st-radius);\r\n  padding: 4px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);\r\n  font-family: var(--p-font-family, -apple-system, system-ui, sans-serif);\r\n  display: flex; flex-direction: column; gap: 1px;\n}\n.ctxhead[data-v-881d670b] { display: flex; align-items: center; gap: 6px; padding: 4px 9px 6px; color: var(--st-muted);\n}\n.ctxhead .cdot[data-v-881d670b] { width: 9px; height: 9px; border-radius: 2px; flex: none;\n}\n.ctxhead .cnum[data-v-881d670b] { font-size: 11px; font-weight: 600;\n}\n.ctxhead .mdi[data-v-881d670b] { font-size: 14px; margin-left: auto;\n}\n.ctxedit[data-v-881d670b] { margin: 0 4px 4px; padding: 5px 7px; background: var(--st-input, #15151a); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 5px; font-size: 12px; font-family: inherit;\n}\n.ctxedit[data-v-881d670b]:focus { outline: none; border-color: var(--st-accent);\n}\n.ctxitem[data-v-881d670b] { display: flex; align-items: center; gap: 8px; text-align: left; background: none; border: none; color: var(--st-text); padding: 6px 9px; border-radius: calc(var(--st-radius) - 1px); cursor: pointer; font-size: 12px;\n}\n.ctxitem[data-v-881d670b]:hover { background: var(--st-btn);\n}\n.ctxitem .mdi[data-v-881d670b] { font-size: 15px; color: var(--st-muted);\n}\n.ctxkey[data-v-881d670b] { margin-left: auto; font-size: 10px; color: var(--st-muted); opacity: .7;\n}\n.ctxitem.del[data-v-881d670b]:hover { background: #b91c1c; color: #fff;\n}\n.ctxitem.del:hover .mdi[data-v-881d670b] { color: #fff;\n}\n.ctxdiv[data-v-881d670b] { border-top: 1px solid var(--st-border); margin: 3px 0;\n}\r\n\r\n/* Map ComfyUI theme vars to semantic names (dark fallbacks); inherited by children. */\n.studio[data-v-36a1f786] {\r\n  position: relative; container-type: inline-size;\r\n  --st-bg: var(--comfy-menu-bg, #1a1a1f);\r\n  --st-panel: var(--comfy-menu-secondary-bg, #202026);\r\n  --st-input: var(--comfy-input-bg, #15151a);\r\n  --st-btn: var(--comfy-input-bg, #2a2a30);\r\n  --st-border: var(--border-color, #3a3a44);\r\n  --st-text: var(--input-text, #e5e5ea);\r\n  --st-muted: var(--descrip-text, #9aa0aa);\r\n  --st-accent: var(--p-primary-color, #60a5fa);\r\n  --st-on-accent: var(--p-primary-button-text-color, #fff);\r\n  --st-radius: var(--radius-md, 6px);\r\n  color: var(--st-text);\r\n  background: var(--st-bg);\r\n  font-family: var(--p-font-family, -apple-system, system-ui, sans-serif);\r\n  height: 100%;\r\n  display: flex; flex-direction: column; min-height: 0; overflow: hidden;\r\n  overscroll-behavior: contain;\n}\n.main[data-v-36a1f786] { display: flex; gap: 12px; flex: 1; min-height: 0;\n}\n.left[data-v-36a1f786] { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;\n}\n.right[data-v-36a1f786] { flex: none; width: 300px; display: flex; flex-direction: column; gap: 10px; overflow: auto; min-height: 0; overscroll-behavior: contain;\n}\n.drawer-backdrop[data-v-36a1f786] { display: none;\n}\n.slim-controls[data-v-36a1f786] { display: none;\n}\n@container (max-width: 760px) {\n.main[data-v-36a1f786] { position: relative;\n}\n.right[data-v-36a1f786] {\r\n    position: absolute; right: 0; top: 0; bottom: 0; z-index: 30;\r\n    background: var(--st-panel); padding: 8px; width: 260px;\r\n    transform: translateX(100%); transition: transform .15s;\n}\n.studio.panel-open .right[data-v-36a1f786] { transform: none;\n}\n.studio.panel-open .drawer-backdrop[data-v-36a1f786] { display: block; position: absolute; inset: 0; z-index: 29; background: rgba(0,0,0,.4);\n}\n.slim-controls[data-v-36a1f786] { display: inline-flex;\n}\n}\n.resmenu[data-v-36a1f786] { display: flex; flex-direction: column; gap: 6px; min-width: 210px;\n}\n.rsec[data-v-36a1f786], .rdiv[data-v-36a1f786] { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--st-muted);\n}\n.rdiv[data-v-36a1f786] { border-top: 1px solid var(--st-border); margin: 2px 0;\n}\n.aspects[data-v-36a1f786] { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;\n}\n.achip[data-v-36a1f786] { display: flex; flex-direction: column; align-items: center; gap: 3px; background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 6px; padding: 6px 2px; cursor: pointer;\n}\n.achip.on[data-v-36a1f786] { border-color: var(--st-accent); color: var(--st-accent);\n}\n.arect[data-v-36a1f786] { border: 1.5px solid currentColor; border-radius: 2px; display: block;\n}\n.albl[data-v-36a1f786] { font-size: 9px; font-variant-numeric: tabular-nums;\n}\n.mprow[data-v-36a1f786] { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--st-muted);\n}\n.mppresets[data-v-36a1f786] { display: flex; gap: 3px;\n}\n.mpp[data-v-36a1f786] { background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; font-size: 10px; padding: 2px 6px; cursor: pointer;\n}\n.mpp.on[data-v-36a1f786] { border-color: var(--st-accent); color: var(--st-accent);\n}\n.mprow input[type='number'][data-v-36a1f786] { width: 52px; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; padding: 3px; font-size: 11px;\n}\n.whrow[data-v-36a1f786] { display: flex; align-items: center; gap: 8px;\n}\n.whrow label[data-v-36a1f786] { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--st-muted); flex: 1;\n}\n.whrow input[data-v-36a1f786] { width: 100%; background: var(--st-input); border: 1px solid var(--st-border); color: var(--st-text); border-radius: 4px; padding: 4px; font-size: 12px;\n}\n.swap[data-v-36a1f786] { background: var(--st-btn); border: 1px solid var(--st-border); color: var(--st-muted); border-radius: 4px; width: 26px; height: 26px; cursor: pointer; flex: none;\n}\n.swap[data-v-36a1f786]:hover { color: var(--st-accent); border-color: var(--st-accent);\n}\n.rfoot[data-v-36a1f786] { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--st-muted);\n}\n.roob[data-v-36a1f786] { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 5px; border-top: 1px solid var(--st-border); font-size: 10px; color: #f59e0b;\n}\n.roob .refit[data-v-36a1f786] { background: var(--st-btn); border: 1px solid rgba(245, 158, 11, .45); color: #fbbf24; border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer;\n}\n.roob .refit[data-v-36a1f786]:hover { border-color: #fbbf24;\n}\n.help[data-v-36a1f786] { display: flex; flex-direction: column; gap: 6px; min-width: 240px; max-width: 300px; font-size: 11px;\n}\n.help .h[data-v-36a1f786] { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--st-muted); margin: 2px 0 0;\n}\n.help dl[data-v-36a1f786] { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0;\n}\n.help dt[data-v-36a1f786] { color: var(--st-muted); white-space: nowrap;\n}\n.help dd[data-v-36a1f786] { margin: 0;\n}\n.help .tip[data-v-36a1f786] { color: var(--st-muted); font-size: 10px; margin: 4px 0 0;\n}\n.help .credit[data-v-36a1f786] { color: var(--st-muted); font-size: 9px; margin: 6px 0 0; border-top: 1px solid var(--st-border); padding-top: 6px;\n}\n.help .credit a[data-v-36a1f786] { color: var(--st-accent);\n}\n.resetc[data-v-36a1f786] { display: flex; flex-direction: column; gap: 6px; min-width: 210px;\n}\n.resetc .rq[data-v-36a1f786] { margin: 0; font-size: 12px; font-weight: 600;\n}\n.resetc .rh[data-v-36a1f786] { margin: 0; font-size: 10px; color: var(--st-muted);\n}\n.rbtns[data-v-36a1f786] { display: flex; gap: 6px; justify-content: flex-end;\n}\n.rno[data-v-36a1f786], .ryes[data-v-36a1f786] { border: 1px solid var(--st-border); background: var(--st-btn); color: var(--st-text); border-radius: 5px; padding: 4px 10px; font-size: 11px; cursor: pointer;\n}\n.ryes[data-v-36a1f786] { background: #b91c1c; border-color: #b91c1c; color: #fff;\n}\r\n.tk-studio-icon{display:inline-block;width:16px;height:16px;min-width:16px;fill:currentColor;vertical-align:middle;flex:none}.tk-studio-icon.mdi-spin{animation:tk-moss-spin 1s linear infinite}@keyframes tk-moss-spin{to{transform:rotate(360deg)}}";document.head.append(s);}
/**
* @vue/shared v3.5.44
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/
// @__NO_SIDE_EFFECTS__
function makeMap(str) {
  const map = /* @__PURE__ */ Object.create(null);
  for (const key of str.split(",")) map[key] = 1;
  return (val) => val in map;
}
const EMPTY_OBJ = {};
const EMPTY_ARR = [];
const NOOP = () => {
};
const NO = () => false;
const isOn = (key) => key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && // uppercase letter
(key.charCodeAt(2) > 122 || key.charCodeAt(2) < 97);
const isModelListener = (key) => key.startsWith("onUpdate:");
const extend = Object.assign;
const remove = (arr, el) => {
  const i = arr.indexOf(el);
  if (i > -1) {
    arr.splice(i, 1);
  }
};
const hasOwnProperty$1 = Object.prototype.hasOwnProperty;
const hasOwn = (val, key) => hasOwnProperty$1.call(val, key);
const isArray = Array.isArray;
const isMap = (val) => toTypeString(val) === "[object Map]";
const isSet = (val) => toTypeString(val) === "[object Set]";
const isDate = (val) => toTypeString(val) === "[object Date]";
const isFunction = (val) => typeof val === "function";
const isString = (val) => typeof val === "string";
const isSymbol = (val) => typeof val === "symbol";
const isObject = (val) => val !== null && typeof val === "object";
const isPromise = (val) => {
  return (isObject(val) || isFunction(val)) && isFunction(val.then) && isFunction(val.catch);
};
const objectToString = Object.prototype.toString;
const toTypeString = (value) => objectToString.call(value);
const toRawType = (value) => {
  return toTypeString(value).slice(8, -1);
};
const isPlainObject = (val) => toTypeString(val) === "[object Object]";
const isIntegerKey = (key) => isString(key) && key !== "NaN" && key[0] !== "-" && "" + parseInt(key, 10) === key;
const isReservedProp = /* @__PURE__ */ makeMap(
  // the leading comma is intentional so empty string "" is also included
  ",key,ref,ref_for,ref_key,onVnodeBeforeMount,onVnodeMounted,onVnodeBeforeUpdate,onVnodeUpdated,onVnodeBeforeUnmount,onVnodeUnmounted"
);
const cacheStringFunction = (fn) => {
  const cache = /* @__PURE__ */ Object.create(null);
  return ((str) => {
    const hit = cache[str];
    return hit || (cache[str] = fn(str));
  });
};
const camelizeRE = /-\w/g;
const camelize = cacheStringFunction(
  (str) => {
    return str.replace(camelizeRE, (c) => c.slice(1).toUpperCase());
  }
);
const hyphenateRE = /\B([A-Z])/g;
const hyphenate = cacheStringFunction(
  (str) => str.replace(hyphenateRE, "-$1").toLowerCase()
);
const capitalize = cacheStringFunction((str) => {
  return str.charAt(0).toUpperCase() + str.slice(1);
});
const toHandlerKey = cacheStringFunction(
  (str) => {
    const s = str ? `on${capitalize(str)}` : ``;
    return s;
  }
);
const hasChanged = (value, oldValue) => !Object.is(value, oldValue);
const invokeArrayFns = (fns, ...arg) => {
  for (let i = 0; i < fns.length; i++) {
    fns[i](...arg);
  }
};
const def = (obj, key, value, writable = false) => {
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: false,
    writable,
    value
  });
};
const looseToNumber = (val) => {
  const n = parseFloat(val);
  return isNaN(n) ? val : n;
};
const toNumber = (val) => {
  const n = isString(val) ? Number(val) : NaN;
  return isNaN(n) ? val : n;
};
let _globalThis;
const getGlobalThis = () => {
  return _globalThis || (_globalThis = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
};
function normalizeStyle(value) {
  if (isArray(value)) {
    const res = {};
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const normalized = isString(item) ? parseStringStyle(item) : normalizeStyle(item);
      if (normalized) {
        for (const key in normalized) {
          res[key] = normalized[key];
        }
      }
    }
    return res;
  } else if (isString(value) || isObject(value)) {
    return value;
  }
}
const listDelimiterRE = /;(?![^(]*\))/g;
const propertyDelimiterRE = /:([^]+)/;
const styleCommentRE = /"(?:[^"\\]|\\[^])*"|'(?:[^'\\]|\\[^])*'|\\[^]|\/\*[^]*?\*\//g;
function parseStringStyle(cssText) {
  const ret = {};
  cssText.replace(styleCommentRE, (match) => match.startsWith("/*") ? "" : match).split(listDelimiterRE).forEach((item) => {
    if (item) {
      const tmp = item.split(propertyDelimiterRE);
      tmp.length > 1 && (ret[tmp[0].trim()] = tmp[1].trim());
    }
  });
  return ret;
}
function normalizeClass(value) {
  let res = "";
  if (isString(value)) {
    res = value;
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const normalized = normalizeClass(value[i]);
      if (normalized) {
        res += normalized + " ";
      }
    }
  } else if (isObject(value)) {
    for (const name in value) {
      if (value[name]) {
        res += name + " ";
      }
    }
  }
  return res.trim();
}
const specialBooleanAttrs = `itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,playsinline,readonly`;
const isSpecialBooleanAttr = /* @__PURE__ */ makeMap(specialBooleanAttrs);
function includeBooleanAttr(value) {
  return !!value || value === "";
}
function looseCompareArrays(a, b, seen) {
  if (a.length !== b.length) return false;
  let equal = true;
  for (let i = 0; equal && i < a.length; i++) {
    equal = looseEqual(a[i], b[i], seen);
  }
  return equal;
}
function looseCompareCollections(a, b, seen) {
  if (a.size !== b.size) return false;
  const candidates = Array.from(b);
  const matched = new Uint8Array(candidates.length);
  for (const item of a) {
    let index = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (!matched[i] && looseEqual(item, candidates[i], seen)) {
        index = i;
        break;
      }
    }
    if (index < 0) return false;
    matched[index] = 1;
  }
  return true;
}
function looseCompareObjects(a, b, seen) {
  let aValidType = isMap(a);
  let bValidType = isMap(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? looseCompareCollections(a, b, seen) : false;
  }
  aValidType = isSet(a);
  bValidType = isSet(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? looseCompareCollections(a, b, seen) : false;
  }
  const aKeysCount = Object.keys(a).length;
  const bKeysCount = Object.keys(b).length;
  if (aKeysCount !== bKeysCount) {
    return false;
  }
  for (const key in a) {
    const aHasKey = a.hasOwnProperty(key);
    const bHasKey = b.hasOwnProperty(key);
    if (aHasKey && !bHasKey || !aHasKey && bHasKey || !looseEqual(a[key], b[key], seen)) {
      return false;
    }
  }
  return String(a) === String(b);
}
function looseCompareNested(a, b, seen, compare) {
  if (!seen) {
    seen = [/* @__PURE__ */ new Map(), /* @__PURE__ */ new Map()];
  }
  const [seenA, seenB] = seen;
  if (seenA.has(a) || seenB.has(b)) {
    return seenA.get(a) === b && seenB.get(b) === a;
  }
  seenA.set(a, b);
  seenB.set(b, a);
  const equal = compare(a, b, seen);
  seenA.delete(a);
  seenB.delete(b);
  return equal;
}
function looseEqual(a, b, seen) {
  if (a === b) return true;
  let aValidType = isDate(a);
  let bValidType = isDate(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? a.getTime() === b.getTime() : false;
  }
  aValidType = isSymbol(a);
  bValidType = isSymbol(b);
  if (aValidType || bValidType) {
    return a === b;
  }
  aValidType = isArray(a);
  bValidType = isArray(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? looseCompareNested(a, b, seen, looseCompareArrays) : false;
  }
  aValidType = isObject(a);
  bValidType = isObject(b);
  if (aValidType || bValidType) {
    if (!aValidType || !bValidType) {
      return false;
    }
    return looseCompareNested(a, b, seen, looseCompareObjects);
  }
  return String(a) === String(b);
}
function looseIndexOf(arr, val) {
  return arr.findIndex((item) => looseEqual(item, val));
}
const isRef$1 = (val) => {
  return !!(val && val["__v_isRef"] === true);
};
const toDisplayString = (val) => {
  return isString(val) ? val : val == null ? "" : isArray(val) || isObject(val) && (val.toString === objectToString || !isFunction(val.toString)) ? isRef$1(val) ? toDisplayString(val.value) : JSON.stringify(val, replacer, 2) : String(val);
};
const replacer = (_key, val) => {
  if (isRef$1(val)) {
    return replacer(_key, val.value);
  } else if (isMap(val)) {
    return {
      [`Map(${val.size})`]: [...val.entries()].reduce(
        (entries, [key, val2], i) => {
          entries[stringifySymbol(key, i) + " =>"] = val2;
          return entries;
        },
        {}
      )
    };
  } else if (isSet(val)) {
    return {
      [`Set(${val.size})`]: [...val.values()].map((v) => stringifySymbol(v))
    };
  } else if (isSymbol(val)) {
    return stringifySymbol(val);
  } else if (isObject(val) && !isArray(val) && !isPlainObject(val)) {
    return String(val);
  }
  return val;
};
const stringifySymbol = (v, i = "") => {
  var _a;
  return (
    // Symbol.description in es2019+ so we need to cast here to pass
    // the lib: es2016 check
    isSymbol(v) ? `Symbol(${(_a = v.description) != null ? _a : i})` : v
  );
};
/**
* @vue/reactivity v3.5.44
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/
let activeEffectScope;
class EffectScope {
  // TODO isolatedDeclarations "__v_skip"
  constructor(detached = false) {
    this.detached = detached;
    this._active = true;
    this._on = 0;
    this.effects = [];
    this.cleanups = [];
    this._isPaused = false;
    this._warnOnRun = true;
    this.__v_skip = true;
    if (!detached && activeEffectScope) {
      if (activeEffectScope.active) {
        this.parent = activeEffectScope;
        this.index = (activeEffectScope.scopes || (activeEffectScope.scopes = [])).push(
          this
        ) - 1;
      } else {
        this._active = false;
        this._warnOnRun = false;
      }
    }
  }
  get active() {
    return this._active;
  }
  pause() {
    if (this._active) {
      this._isPaused = true;
      let i, l;
      if (this.scopes) {
        const scopes = this.scopes.slice();
        for (i = 0, l = scopes.length; i < l; i++) {
          scopes[i].pause();
        }
      }
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].pause();
      }
    }
  }
  /**
   * Resumes the effect scope, including all child scopes and effects.
   */
  resume() {
    if (this._active) {
      if (this._isPaused) {
        this._isPaused = false;
        let i, l;
        if (this.scopes) {
          const scopes = this.scopes.slice();
          for (i = 0, l = scopes.length; i < l; i++) {
            scopes[i].resume();
          }
        }
        const effects = this.effects.slice();
        for (i = 0, l = effects.length; i < l; i++) {
          effects[i].resume();
        }
      }
    }
  }
  run(fn) {
    if (this._active) {
      const currentEffectScope = activeEffectScope;
      try {
        activeEffectScope = this;
        return fn();
      } finally {
        activeEffectScope = currentEffectScope;
      }
    }
  }
  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  on() {
    if (++this._on === 1) {
      this.prevScope = activeEffectScope;
      activeEffectScope = this;
    }
  }
  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  off() {
    if (this._on > 0 && --this._on === 0) {
      if (activeEffectScope === this) {
        activeEffectScope = this.prevScope;
      } else {
        let current = activeEffectScope;
        while (current) {
          if (current.prevScope === this) {
            current.prevScope = this.prevScope;
            break;
          }
          current = current.prevScope;
        }
      }
      this.prevScope = void 0;
    }
  }
  stop(fromParent) {
    if (this._active) {
      this._active = false;
      let i, l;
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].stop();
      }
      this.effects.length = 0;
      for (i = 0, l = this.cleanups.length; i < l; i++) {
        this.cleanups[i]();
      }
      this.cleanups.length = 0;
      if (this.scopes) {
        const scopes = this.scopes.slice();
        for (i = 0, l = scopes.length; i < l; i++) {
          scopes[i].stop(true);
        }
        this.scopes.length = 0;
      }
      if (!this.detached && this.parent && !fromParent) {
        const last = this.parent.scopes.pop();
        if (last && last !== this) {
          this.parent.scopes[this.index] = last;
          last.index = this.index;
        }
      }
      this.parent = void 0;
    }
  }
}
function getCurrentScope() {
  return activeEffectScope;
}
let activeSub;
const pausedQueueEffects = /* @__PURE__ */ new WeakSet();
class ReactiveEffect {
  constructor(fn) {
    this.fn = fn;
    this.deps = void 0;
    this.depsTail = void 0;
    this.flags = 1 | 4;
    this.next = void 0;
    this.cleanup = void 0;
    this.scheduler = void 0;
    if (activeEffectScope) {
      if (activeEffectScope.active) {
        activeEffectScope.effects.push(this);
      } else {
        this.flags &= -2;
      }
    }
  }
  pause() {
    this.flags |= 64;
  }
  resume() {
    if (this.flags & 64) {
      this.flags &= -65;
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this);
        this.trigger();
      }
    }
  }
  /**
   * @internal
   */
  notify() {
    if (this.flags & 2 && !(this.flags & 32)) {
      return;
    }
    if (!(this.flags & 8)) {
      batch(this);
    }
  }
  run() {
    if (!(this.flags & 1)) {
      return this.fn();
    }
    this.flags |= 2;
    cleanupEffect(this);
    prepareDeps(this);
    const prevEffect = activeSub;
    const prevShouldTrack = shouldTrack;
    activeSub = this;
    shouldTrack = true;
    try {
      return this.fn();
    } finally {
      cleanupDeps(this);
      activeSub = prevEffect;
      shouldTrack = prevShouldTrack;
      this.flags &= -3;
    }
  }
  stop() {
    if (this.flags & 1) {
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link);
      }
      this.deps = this.depsTail = void 0;
      cleanupEffect(this);
      this.onStop && this.onStop();
      this.flags &= -2;
    }
  }
  trigger() {
    if (this.flags & 64) {
      pausedQueueEffects.add(this);
    } else if (this.scheduler) {
      this.scheduler();
    } else {
      this.runIfDirty();
    }
  }
  /**
   * @internal
   */
  runIfDirty() {
    if (isDirty(this)) {
      this.run();
    }
  }
  get dirty() {
    return isDirty(this);
  }
}
let batchDepth = 0;
let batchedSub;
let batchedComputed;
function batch(sub, isComputed = false) {
  sub.flags |= 8;
  if (isComputed) {
    sub.next = batchedComputed;
    batchedComputed = sub;
    return;
  }
  sub.next = batchedSub;
  batchedSub = sub;
}
function startBatch() {
  batchDepth++;
}
function endBatch() {
  if (--batchDepth > 0) {
    return;
  }
  if (batchedComputed) {
    let e = batchedComputed;
    batchedComputed = void 0;
    while (e) {
      const next = e.next;
      e.next = void 0;
      e.flags &= -9;
      e = next;
    }
  }
  let error;
  while (batchedSub) {
    let e = batchedSub;
    batchedSub = void 0;
    while (e) {
      const next = e.next;
      e.next = void 0;
      e.flags &= -9;
      if (e.flags & 1) {
        try {
          ;
          e.trigger();
        } catch (err) {
          if (!error) error = err;
        }
      }
      e = next;
    }
  }
  if (error) throw error;
}
function prepareDeps(sub) {
  for (let link = sub.deps; link; link = link.nextDep) {
    link.version = -1;
    link.prevActiveLink = link.dep.activeLink;
    link.dep.activeLink = link;
  }
}
function cleanupDeps(sub) {
  let head;
  let tail = sub.depsTail;
  let link = tail;
  while (link) {
    const prev = link.prevDep;
    if (link.version === -1) {
      if (link === tail) tail = prev;
      removeSub(link);
      removeDep(link);
    } else {
      head = link;
    }
    link.dep.activeLink = link.prevActiveLink;
    link.prevActiveLink = void 0;
    link = prev;
  }
  sub.deps = head;
  sub.depsTail = tail;
}
function isDirty(sub) {
  for (let link = sub.deps; link; link = link.nextDep) {
    if (link.dep.version !== link.version || link.dep.computed && (refreshComputed(link.dep.computed) || link.dep.version !== link.version)) {
      return true;
    }
  }
  if (sub._dirty) {
    return true;
  }
  return false;
}
function refreshComputed(computed2) {
  if (computed2.flags & 4 && !(computed2.flags & 16)) {
    return;
  }
  computed2.flags &= -17;
  if (computed2.globalVersion === globalVersion) {
    return;
  }
  computed2.globalVersion = globalVersion;
  if (!computed2.isSSR && computed2.flags & 128 && (!computed2.deps && !computed2._dirty || !isDirty(computed2))) {
    return;
  }
  computed2.flags |= 2;
  const dep = computed2.dep;
  const prevSub = activeSub;
  const prevShouldTrack = shouldTrack;
  activeSub = computed2;
  shouldTrack = true;
  try {
    prepareDeps(computed2);
    const value = computed2.fn(computed2._value);
    if (dep.version === 0 || hasChanged(value, computed2._value)) {
      computed2.flags |= 128;
      computed2._value = value;
      dep.version++;
    }
  } catch (err) {
    dep.version++;
    throw err;
  } finally {
    activeSub = prevSub;
    shouldTrack = prevShouldTrack;
    cleanupDeps(computed2);
    computed2.flags &= -3;
  }
}
function removeSub(link, soft = false) {
  const { dep, prevSub, nextSub } = link;
  if (prevSub) {
    prevSub.nextSub = nextSub;
    link.prevSub = void 0;
  }
  if (nextSub) {
    nextSub.prevSub = prevSub;
    link.nextSub = void 0;
  }
  if (dep.subs === link) {
    dep.subs = prevSub;
    if (!prevSub && dep.computed) {
      dep.computed.flags &= -5;
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        removeSub(l, true);
      }
    }
  }
  if (!soft && !--dep.sc && dep.map) {
    dep.map.delete(dep.key);
  }
}
function removeDep(link) {
  const { prevDep, nextDep } = link;
  if (prevDep) {
    prevDep.nextDep = nextDep;
    link.prevDep = void 0;
  }
  if (nextDep) {
    nextDep.prevDep = prevDep;
    link.nextDep = void 0;
  }
}
let shouldTrack = true;
const trackStack = [];
function pauseTracking() {
  trackStack.push(shouldTrack);
  shouldTrack = false;
}
function resetTracking() {
  const last = trackStack.pop();
  shouldTrack = last === void 0 ? true : last;
}
function cleanupEffect(e) {
  const { cleanup } = e;
  e.cleanup = void 0;
  if (cleanup) {
    const prevSub = activeSub;
    activeSub = void 0;
    try {
      cleanup();
    } finally {
      activeSub = prevSub;
    }
  }
}
let globalVersion = 0;
class Link {
  constructor(sub, dep) {
    this.sub = sub;
    this.dep = dep;
    this.version = dep.version;
    this.nextDep = this.prevDep = this.nextSub = this.prevSub = this.prevActiveLink = void 0;
  }
}
class Dep {
  // TODO isolatedDeclarations "__v_skip"
  constructor(computed2) {
    this.computed = computed2;
    this.version = 0;
    this.activeLink = void 0;
    this.subs = void 0;
    this.map = void 0;
    this.key = void 0;
    this.sc = 0;
    this.__v_skip = true;
  }
  track(debugInfo) {
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return;
    }
    let link = this.activeLink;
    if (link === void 0 || link.sub !== activeSub) {
      link = this.activeLink = new Link(activeSub, this);
      if (!activeSub.deps) {
        activeSub.deps = activeSub.depsTail = link;
      } else {
        link.prevDep = activeSub.depsTail;
        activeSub.depsTail.nextDep = link;
        activeSub.depsTail = link;
      }
      addSub(link);
    } else if (link.version === -1) {
      link.version = this.version;
      if (link.nextDep) {
        const next = link.nextDep;
        next.prevDep = link.prevDep;
        if (link.prevDep) {
          link.prevDep.nextDep = next;
        }
        link.prevDep = activeSub.depsTail;
        link.nextDep = void 0;
        activeSub.depsTail.nextDep = link;
        activeSub.depsTail = link;
        if (activeSub.deps === link) {
          activeSub.deps = next;
        }
      }
    }
    return link;
  }
  trigger(debugInfo) {
    this.version++;
    globalVersion++;
    this.notify(debugInfo);
  }
  notify(debugInfo) {
    startBatch();
    try {
      if (false) ;
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          ;
          link.sub.dep.notify();
        }
      }
    } finally {
      endBatch();
    }
  }
}
function addSub(link) {
  link.dep.sc++;
  if (link.sub.flags & 4) {
    const computed2 = link.dep.computed;
    if (computed2 && !link.dep.subs) {
      computed2.flags |= 4 | 16;
      for (let l = computed2.deps; l; l = l.nextDep) {
        addSub(l);
      }
    }
    const currentTail = link.dep.subs;
    if (currentTail !== link) {
      link.prevSub = currentTail;
      if (currentTail) currentTail.nextSub = link;
    }
    link.dep.subs = link;
  }
}
const targetMap = /* @__PURE__ */ new WeakMap();
const ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
const MAP_KEY_ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
const ARRAY_ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
function track(target, type, key) {
  if (shouldTrack && activeSub) {
    let depsMap = targetMap.get(target);
    if (!depsMap) {
      targetMap.set(target, depsMap = /* @__PURE__ */ new Map());
    }
    let dep = depsMap.get(key);
    if (!dep) {
      depsMap.set(key, dep = new Dep());
      dep.map = depsMap;
      dep.key = key;
    }
    {
      dep.track();
    }
  }
}
function trigger(target, type, key, newValue, oldValue, oldTarget) {
  const depsMap = targetMap.get(target);
  if (!depsMap) {
    globalVersion++;
    return;
  }
  const run = (dep) => {
    if (dep) {
      {
        dep.trigger();
      }
    }
  };
  startBatch();
  if (type === "clear") {
    depsMap.forEach(run);
  } else {
    const targetIsArray = isArray(target);
    const isArrayIndex = targetIsArray && isIntegerKey(key);
    if (targetIsArray && key === "length") {
      const newLength = Number(newValue);
      depsMap.forEach((dep, key2) => {
        if (key2 === "length" || key2 === ARRAY_ITERATE_KEY || !isSymbol(key2) && key2 >= newLength) {
          run(dep);
        }
      });
    } else {
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key));
      }
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY));
      }
      switch (type) {
        case "add":
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY));
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY));
            }
          } else if (isArrayIndex) {
            run(depsMap.get("length"));
          }
          break;
        case "delete":
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY));
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY));
            }
          }
          break;
        case "set":
          if (isMap(target)) {
            run(depsMap.get(ITERATE_KEY));
          }
          break;
      }
    }
  }
  endBatch();
}
function reactiveReadArray(array) {
  const raw = /* @__PURE__ */ toRaw(array);
  if (raw === array) return raw;
  track(raw, "iterate", ARRAY_ITERATE_KEY);
  if (/* @__PURE__ */ isShallow(array)) return raw;
  if (!/* @__PURE__ */ isReadonly(array)) return raw.map(toReactive);
  return /* @__PURE__ */ isReactive(array) ? raw.map((item) => toReadonly(toReactive(item))) : raw.map(toReadonly);
}
function shallowReadArray(arr) {
  track(arr = /* @__PURE__ */ toRaw(arr), "iterate", ARRAY_ITERATE_KEY);
  return arr;
}
function toWrapped(target, item) {
  if (/* @__PURE__ */ isReadonly(target)) {
    return /* @__PURE__ */ isReactive(target) ? toReadonly(toReactive(item)) : toReadonly(item);
  }
  return toReactive(item);
}
const arrayInstrumentations = {
  __proto__: null,
  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, (item) => toWrapped(this, item));
  },
  concat(...args) {
    return reactiveReadArray(this).concat(
      ...args.map((x) => isArray(x) ? reactiveReadArray(x) : x)
    );
  },
  entries() {
    return iterator(this, "entries", (value) => {
      value[1] = toWrapped(this, value[1]);
      return value;
    });
  },
  every(fn, thisArg) {
    return apply(this, "every", fn, thisArg, void 0, arguments);
  },
  filter(fn, thisArg) {
    return apply(
      this,
      "filter",
      fn,
      thisArg,
      (v) => v.map((item) => toWrapped(this, item)),
      arguments
    );
  },
  find(fn, thisArg) {
    return apply(
      this,
      "find",
      fn,
      thisArg,
      (item) => toWrapped(this, item),
      arguments
    );
  },
  findIndex(fn, thisArg) {
    return apply(this, "findIndex", fn, thisArg, void 0, arguments);
  },
  findLast(fn, thisArg) {
    return apply(
      this,
      "findLast",
      fn,
      thisArg,
      (item) => toWrapped(this, item),
      arguments
    );
  },
  findLastIndex(fn, thisArg) {
    return apply(this, "findLastIndex", fn, thisArg, void 0, arguments);
  },
  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement
  forEach(fn, thisArg) {
    return apply(this, "forEach", fn, thisArg, void 0, arguments);
  },
  includes(...args) {
    return searchProxy(this, "includes", args);
  },
  indexOf(...args) {
    return searchProxy(this, "indexOf", args);
  },
  join(separator) {
    return reactiveReadArray(this).join(separator);
  },
  // keys() iterator only reads `length`, no optimization required
  lastIndexOf(...args) {
    return searchProxy(this, "lastIndexOf", args);
  },
  map(fn, thisArg) {
    return apply(this, "map", fn, thisArg, void 0, arguments);
  },
  pop() {
    return noTracking(this, "pop");
  },
  push(...args) {
    return noTracking(this, "push", args);
  },
  reduce(fn, ...args) {
    return reduce(this, "reduce", fn, args);
  },
  reduceRight(fn, ...args) {
    return reduce(this, "reduceRight", fn, args);
  },
  shift() {
    return noTracking(this, "shift");
  },
  // slice could use ARRAY_ITERATE but also seems to beg for range tracking
  some(fn, thisArg) {
    return apply(this, "some", fn, thisArg, void 0, arguments);
  },
  splice(...args) {
    return noTracking(this, "splice", args);
  },
  toReversed() {
    return reactiveReadArray(this).toReversed();
  },
  toSorted(comparer) {
    return reactiveReadArray(this).toSorted(comparer);
  },
  toSpliced(...args) {
    return reactiveReadArray(this).toSpliced(...args);
  },
  unshift(...args) {
    return noTracking(this, "unshift", args);
  },
  values() {
    return iterator(this, "values", (item) => toWrapped(this, item));
  }
};
function iterator(self2, method, wrapValue) {
  const arr = shallowReadArray(self2);
  const methodFn = arr[method];
  const iter = methodFn.call(arr);
  if (arr !== self2 && !/* @__PURE__ */ isShallow(self2)) {
    if (iter[Symbol.toStringTag] === "Array Iterator") {
      const wrapped = Object.create(Object.getPrototypeOf(iter));
      wrapped.next = () => wrapResult(iter.next(), wrapValue);
      if (methodFn !== arrayProto[method]) {
        Object.defineProperties(wrapped, {
          return: {
            get() {
              const fn = iter.return;
              return typeof fn === "function" ? fn.bind(iter) : fn;
            }
          },
          throw: {
            get() {
              const fn = iter.throw;
              return typeof fn === "function" ? fn.bind(iter) : fn;
            }
          }
        });
      }
      return wrapped;
    }
    iter._next = iter.next;
    iter.next = () => wrapResult(iter._next(), wrapValue);
  }
  return iter;
}
function wrapResult(result, wrapValue) {
  if (!result.done) {
    result.value = wrapValue(result.value);
  }
  return result;
}
const arrayProto = Array.prototype;
function apply(self2, method, fn, thisArg, wrappedRetFn, args) {
  const arr = shallowReadArray(self2);
  const needsWrap = arr !== self2 && !/* @__PURE__ */ isShallow(self2);
  const methodFn = arr[method];
  if (methodFn !== arrayProto[method]) {
    const result2 = methodFn.apply(self2, args);
    return needsWrap ? toReactive(result2) : result2;
  }
  let wrappedFn = fn;
  if (arr !== self2) {
    if (needsWrap) {
      wrappedFn = function(item, index) {
        return fn.call(this, toWrapped(self2, item), index, self2);
      };
    } else if (fn.length > 2) {
      wrappedFn = function(item, index) {
        return fn.call(this, item, index, self2);
      };
    }
  }
  const result = methodFn.call(arr, wrappedFn, thisArg);
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result;
}
function reduce(self2, method, fn, args) {
  const arr = shallowReadArray(self2);
  const needsWrap = arr !== self2 && !/* @__PURE__ */ isShallow(self2);
  let wrappedFn = fn;
  let wrapInitialAccumulator = false;
  if (arr !== self2) {
    if (needsWrap) {
      wrapInitialAccumulator = args.length === 0;
      wrappedFn = function(acc, item, index) {
        if (wrapInitialAccumulator) {
          wrapInitialAccumulator = false;
          acc = toWrapped(self2, acc);
        }
        return fn.call(this, acc, toWrapped(self2, item), index, self2);
      };
    } else if (fn.length > 3) {
      wrappedFn = function(acc, item, index) {
        return fn.call(this, acc, item, index, self2);
      };
    }
  }
  const result = arr[method](wrappedFn, ...args);
  return wrapInitialAccumulator ? toWrapped(self2, result) : result;
}
function searchProxy(self2, method, args) {
  const arr = /* @__PURE__ */ toRaw(self2);
  track(arr, "iterate", ARRAY_ITERATE_KEY);
  const res = arr[method](...args);
  if ((res === -1 || res === false) && /* @__PURE__ */ isProxy(args[0])) {
    args[0] = /* @__PURE__ */ toRaw(args[0]);
    return arr[method](...args);
  }
  return res;
}
function noTracking(self2, method, args = []) {
  pauseTracking();
  startBatch();
  const res = (/* @__PURE__ */ toRaw(self2))[method].apply(self2, args);
  endBatch();
  resetTracking();
  return res;
}
const isNonTrackableKeys = /* @__PURE__ */ makeMap(`__proto__,__v_isRef,__isVue`);
const builtInSymbols = new Set(
  /* @__PURE__ */ Object.getOwnPropertyNames(Symbol).filter((key) => key !== "arguments" && key !== "caller").map((key) => Symbol[key]).filter(isSymbol)
);
function hasOwnProperty(key) {
  if (!isSymbol(key)) key = String(key);
  const obj = /* @__PURE__ */ toRaw(this);
  track(obj, "has", key);
  return obj.hasOwnProperty(key);
}
class BaseReactiveHandler {
  constructor(_isReadonly = false, _isShallow = false) {
    this._isReadonly = _isReadonly;
    this._isShallow = _isShallow;
  }
  get(target, key, receiver) {
    if (key === "__v_skip") return target["__v_skip"];
    const isReadonly2 = this._isReadonly, isShallow2 = this._isShallow;
    if (key === "__v_isReactive") {
      return !isReadonly2;
    } else if (key === "__v_isReadonly") {
      return isReadonly2;
    } else if (key === "__v_isShallow") {
      return isShallow2;
    } else if (key === "__v_raw") {
      if (receiver === (isReadonly2 ? isShallow2 ? shallowReadonlyMap : readonlyMap : isShallow2 ? shallowReactiveMap : reactiveMap).get(target) || // receiver is not the reactive proxy, but has the same prototype
      // this means the receiver is a user proxy of the reactive proxy
      Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)) {
        return target;
      }
      return;
    }
    const targetIsArray = isArray(target);
    if (!isReadonly2) {
      let fn;
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn;
      }
      if (key === "hasOwnProperty") {
        return hasOwnProperty;
      }
    }
    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      /* @__PURE__ */ isRef(target) ? target : receiver
    );
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res;
    }
    if (!isReadonly2) {
      track(target, "get", key);
    }
    if (isShallow2) {
      return res;
    }
    if (/* @__PURE__ */ isRef(res)) {
      const value = targetIsArray && isIntegerKey(key) ? res : res.value;
      return isReadonly2 && isObject(value) ? /* @__PURE__ */ readonly(value) : value;
    }
    if (isObject(res)) {
      return isReadonly2 ? /* @__PURE__ */ readonly(res) : /* @__PURE__ */ reactive(res);
    }
    return res;
  }
}
class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow2 = false) {
    super(false, isShallow2);
  }
  set(target, key, value, receiver) {
    let oldValue = target[key];
    const isArrayWithIntegerKey = isArray(target) && isIntegerKey(key);
    if (!this._isShallow) {
      const isOldValueReadonly = /* @__PURE__ */ isReadonly(oldValue);
      if (!/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value)) {
        oldValue = /* @__PURE__ */ toRaw(oldValue);
        value = /* @__PURE__ */ toRaw(value);
      }
      if (!isArrayWithIntegerKey && /* @__PURE__ */ isRef(oldValue) && !/* @__PURE__ */ isRef(value)) {
        if (isOldValueReadonly) {
          return true;
        } else {
          oldValue.value = value;
          return true;
        }
      }
    }
    const hadKey = isArrayWithIntegerKey ? Number(key) < target.length : hasOwn(target, key);
    const result = Reflect.set(
      target,
      key,
      value,
      /* @__PURE__ */ isRef(target) ? target : receiver
    );
    if (target === /* @__PURE__ */ toRaw(receiver) && result) {
      if (!hadKey) {
        trigger(target, "add", key, value);
      } else if (hasChanged(value, oldValue)) {
        trigger(target, "set", key, value);
      }
    }
    return result;
  }
  deleteProperty(target, key) {
    const hadKey = hasOwn(target, key);
    target[key];
    const result = Reflect.deleteProperty(target, key);
    if (result && hadKey) {
      trigger(target, "delete", key, void 0);
    }
    return result;
  }
  has(target, key) {
    const result = Reflect.has(target, key);
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, "has", key);
    }
    return result;
  }
  ownKeys(target) {
    track(
      target,
      "iterate",
      isArray(target) ? "length" : ITERATE_KEY
    );
    return Reflect.ownKeys(target);
  }
}
class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow2 = false) {
    super(true, isShallow2);
  }
  set(target, key) {
    return true;
  }
  deleteProperty(target, key) {
    return true;
  }
}
const mutableHandlers = /* @__PURE__ */ new MutableReactiveHandler();
const readonlyHandlers = /* @__PURE__ */ new ReadonlyReactiveHandler();
const shallowReactiveHandlers = /* @__PURE__ */ new MutableReactiveHandler(true);
const shallowReadonlyHandlers = /* @__PURE__ */ new ReadonlyReactiveHandler(true);
const toShallow = (value) => value;
const getProto = (v) => Reflect.getPrototypeOf(v);
function createIterableMethod(method, isReadonly2, isShallow2) {
  return function(...args) {
    const target = this["__v_raw"];
    const rawTarget = /* @__PURE__ */ toRaw(target);
    const targetIsMap = isMap(rawTarget);
    const isPair = method === "entries" || method === Symbol.iterator && targetIsMap;
    const isKeyOnly = method === "keys" && targetIsMap;
    const innerIterator = target[method](...args);
    const wrap = isShallow2 ? toShallow : isReadonly2 ? toReadonly : toReactive;
    !isReadonly2 && track(
      rawTarget,
      "iterate",
      isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
    );
    return extend(
      // inheriting all iterator properties
      Object.create(innerIterator),
      {
        // iterator protocol
        next() {
          const { value, done } = innerIterator.next();
          return done ? { value, done } : {
            value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
            done
          };
        }
      }
    );
  };
}
function createReadonlyMethod(type) {
  return function(...args) {
    return type === "delete" ? false : type === "clear" ? void 0 : this;
  };
}
function createInstrumentations(readonly2, shallow) {
  const instrumentations = {
    get(key) {
      const target = this["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const rawKey = /* @__PURE__ */ toRaw(key);
      if (!readonly2) {
        if (hasChanged(key, rawKey)) {
          track(rawTarget, "get", key);
        }
        track(rawTarget, "get", rawKey);
      }
      const { has } = getProto(rawTarget);
      const wrap = shallow ? toShallow : readonly2 ? toReadonly : toReactive;
      if (has.call(rawTarget, key)) {
        return wrap(target.get(key));
      } else if (has.call(rawTarget, rawKey)) {
        return wrap(target.get(rawKey));
      } else if (target !== rawTarget) {
        target.get(key);
      }
    },
    get size() {
      const target = this["__v_raw"];
      !readonly2 && track(/* @__PURE__ */ toRaw(target), "iterate", ITERATE_KEY);
      return target.size;
    },
    has(key) {
      const target = this["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const rawKey = /* @__PURE__ */ toRaw(key);
      if (!readonly2) {
        if (hasChanged(key, rawKey)) {
          track(rawTarget, "has", key);
        }
        track(rawTarget, "has", rawKey);
      }
      return key === rawKey ? target.has(key) : target.has(key) || target.has(rawKey);
    },
    forEach(callback, thisArg) {
      const observed = this;
      const target = observed["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const wrap = shallow ? toShallow : readonly2 ? toReadonly : toReactive;
      !readonly2 && track(rawTarget, "iterate", ITERATE_KEY);
      return target.forEach((value, key) => {
        return callback.call(thisArg, wrap(value), wrap(key), observed);
      });
    }
  };
  extend(
    instrumentations,
    readonly2 ? {
      add: createReadonlyMethod("add"),
      set: createReadonlyMethod("set"),
      delete: createReadonlyMethod("delete"),
      clear: createReadonlyMethod("clear")
    } : {
      add(value) {
        const target = /* @__PURE__ */ toRaw(this);
        const proto = getProto(target);
        const rawValue = /* @__PURE__ */ toRaw(value);
        const valueToAdd = !shallow && !/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value) ? rawValue : value;
        const hadKey = proto.has.call(target, valueToAdd) || hasChanged(value, valueToAdd) && proto.has.call(target, value) || hasChanged(rawValue, valueToAdd) && proto.has.call(target, rawValue);
        if (!hadKey) {
          target.add(valueToAdd);
          trigger(target, "add", valueToAdd, valueToAdd);
        }
        return this;
      },
      set(key, value) {
        if (!shallow && !/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value)) {
          value = /* @__PURE__ */ toRaw(value);
        }
        const target = /* @__PURE__ */ toRaw(this);
        const { has, get } = getProto(target);
        let hadKey = has.call(target, key);
        if (!hadKey) {
          key = /* @__PURE__ */ toRaw(key);
          hadKey = has.call(target, key);
        }
        const oldValue = get.call(target, key);
        target.set(key, value);
        if (!hadKey) {
          trigger(target, "add", key, value);
        } else if (hasChanged(value, oldValue)) {
          trigger(target, "set", key, value);
        }
        return this;
      },
      delete(key) {
        const target = /* @__PURE__ */ toRaw(this);
        const { has, get } = getProto(target);
        let hadKey = has.call(target, key);
        if (!hadKey) {
          key = /* @__PURE__ */ toRaw(key);
          hadKey = has.call(target, key);
        }
        get ? get.call(target, key) : void 0;
        const result = target.delete(key);
        if (hadKey) {
          trigger(target, "delete", key, void 0);
        }
        return result;
      },
      clear() {
        const target = /* @__PURE__ */ toRaw(this);
        const hadItems = target.size !== 0;
        const result = target.clear();
        if (hadItems) {
          trigger(
            target,
            "clear",
            void 0,
            void 0
          );
        }
        return result;
      }
    }
  );
  const iteratorMethods = [
    "keys",
    "values",
    "entries",
    Symbol.iterator
  ];
  iteratorMethods.forEach((method) => {
    instrumentations[method] = createIterableMethod(method, readonly2, shallow);
  });
  return instrumentations;
}
function createInstrumentationGetter(isReadonly2, shallow) {
  const instrumentations = createInstrumentations(isReadonly2, shallow);
  return (target, key, receiver) => {
    if (key === "__v_isReactive") {
      return !isReadonly2;
    } else if (key === "__v_isReadonly") {
      return isReadonly2;
    } else if (key === "__v_isShallow") {
      return shallow;
    } else if (key === "__v_raw") {
      return target;
    }
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target ? instrumentations : target,
      key,
      receiver
    );
  };
}
const mutableCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(false, false)
};
const shallowCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(false, true)
};
const readonlyCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(true, false)
};
const shallowReadonlyCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(true, true)
};
const reactiveMap = /* @__PURE__ */ new WeakMap();
const shallowReactiveMap = /* @__PURE__ */ new WeakMap();
const readonlyMap = /* @__PURE__ */ new WeakMap();
const shallowReadonlyMap = /* @__PURE__ */ new WeakMap();
function targetTypeMap(rawType) {
  switch (rawType) {
    case "Object":
    case "Array":
      return 1;
    case "Map":
    case "Set":
    case "WeakMap":
    case "WeakSet":
      return 2;
    default:
      return 0;
  }
}
// @__NO_SIDE_EFFECTS__
function reactive(target) {
  if (/* @__PURE__ */ isReadonly(target)) {
    return target;
  }
  return createReactiveObject(
    target,
    false,
    mutableHandlers,
    mutableCollectionHandlers,
    reactiveMap
  );
}
// @__NO_SIDE_EFFECTS__
function shallowReactive(target) {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers,
    shallowReactiveMap
  );
}
// @__NO_SIDE_EFFECTS__
function readonly(target) {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap
  );
}
// @__NO_SIDE_EFFECTS__
function shallowReadonly(target) {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap
  );
}
function createReactiveObject(target, isReadonly2, baseHandlers, collectionHandlers, proxyMap) {
  if (!isObject(target)) {
    return target;
  }
  if (target["__v_raw"] && !(isReadonly2 && target["__v_isReactive"])) {
    return target;
  }
  if (target["__v_skip"] || !Object.isExtensible(target)) {
    return target;
  }
  const existingProxy = proxyMap.get(target);
  if (existingProxy) {
    return existingProxy;
  }
  const targetType = targetTypeMap(toRawType(target));
  if (targetType === 0) {
    return target;
  }
  const proxy = new Proxy(
    target,
    targetType === 2 ? collectionHandlers : baseHandlers
  );
  proxyMap.set(target, proxy);
  return proxy;
}
// @__NO_SIDE_EFFECTS__
function isReactive(value) {
  if (/* @__PURE__ */ isReadonly(value)) {
    return /* @__PURE__ */ isReactive(value["__v_raw"]);
  }
  return !!(value && value["__v_isReactive"]);
}
// @__NO_SIDE_EFFECTS__
function isReadonly(value) {
  return !!(value && value["__v_isReadonly"]);
}
// @__NO_SIDE_EFFECTS__
function isShallow(value) {
  return !!(value && value["__v_isShallow"]);
}
// @__NO_SIDE_EFFECTS__
function isProxy(value) {
  return value ? !!value["__v_raw"] : false;
}
// @__NO_SIDE_EFFECTS__
function toRaw(observed) {
  const raw = observed && observed["__v_raw"];
  return raw ? /* @__PURE__ */ toRaw(raw) : observed;
}
function markRaw(value) {
  if (!hasOwn(value, "__v_skip") && Object.isExtensible(value)) {
    def(value, "__v_skip", true);
  }
  return value;
}
const toReactive = (value) => isObject(value) ? /* @__PURE__ */ reactive(value) : value;
const toReadonly = (value) => isObject(value) ? /* @__PURE__ */ readonly(value) : value;
// @__NO_SIDE_EFFECTS__
function isRef(r) {
  return r ? r["__v_isRef"] === true : false;
}
// @__NO_SIDE_EFFECTS__
function ref(value) {
  return createRef(value, false);
}
function createRef(rawValue, shallow) {
  if (/* @__PURE__ */ isRef(rawValue)) {
    return rawValue;
  }
  return new RefImpl(rawValue, shallow);
}
class RefImpl {
  constructor(value, isShallow2) {
    this.dep = new Dep();
    this["__v_isRef"] = true;
    this["__v_isShallow"] = false;
    this._rawValue = isShallow2 ? value : /* @__PURE__ */ toRaw(value);
    this._value = isShallow2 ? value : toReactive(value);
    this["__v_isShallow"] = isShallow2;
  }
  get value() {
    {
      this.dep.track();
    }
    return this._value;
  }
  set value(newValue) {
    const oldValue = this._rawValue;
    const useDirectValue = this["__v_isShallow"] || /* @__PURE__ */ isShallow(newValue) || /* @__PURE__ */ isReadonly(newValue);
    newValue = useDirectValue ? newValue : /* @__PURE__ */ toRaw(newValue);
    if (hasChanged(newValue, oldValue)) {
      this._rawValue = newValue;
      this._value = useDirectValue ? newValue : toReactive(newValue);
      {
        this.dep.trigger();
      }
    }
  }
}
function unref(ref2) {
  return /* @__PURE__ */ isRef(ref2) ? ref2.value : ref2;
}
const shallowUnwrapHandlers = {
  get: (target, key, receiver) => key === "__v_raw" ? target : unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key];
    if (/* @__PURE__ */ isRef(oldValue) && !/* @__PURE__ */ isRef(value)) {
      oldValue.value = value;
      return true;
    } else {
      return Reflect.set(target, key, value, receiver);
    }
  }
};
function proxyRefs(objectWithRefs) {
  return /* @__PURE__ */ isReactive(objectWithRefs) ? objectWithRefs : new Proxy(objectWithRefs, shallowUnwrapHandlers);
}
class ComputedRefImpl {
  constructor(fn, setter, isSSR) {
    this.fn = fn;
    this.setter = setter;
    this._value = void 0;
    this.dep = new Dep(this);
    this.__v_isRef = true;
    this.deps = void 0;
    this.depsTail = void 0;
    this.flags = 16;
    this.globalVersion = globalVersion - 1;
    this.next = void 0;
    this.effect = this;
    this["__v_isReadonly"] = !setter;
    this.isSSR = isSSR;
  }
  /**
   * @internal
   */
  notify() {
    this.flags |= 16;
    if (!(this.flags & 8) && // avoid infinite self recursion
    activeSub !== this) {
      batch(this, true);
      return true;
    }
  }
  get value() {
    const link = this.dep.track();
    refreshComputed(this);
    if (link) {
      link.version = this.dep.version;
    }
    return this._value;
  }
  set value(newValue) {
    if (this.setter) {
      this.setter(newValue);
    }
  }
}
// @__NO_SIDE_EFFECTS__
function computed$1(getterOrOptions, debugOptions, isSSR = false) {
  let getter;
  let setter;
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions;
  } else {
    getter = getterOrOptions.get;
    setter = getterOrOptions.set;
  }
  const cRef = new ComputedRefImpl(getter, setter, isSSR);
  return cRef;
}
const INITIAL_WATCHER_VALUE = {};
const cleanupMap = /* @__PURE__ */ new WeakMap();
let activeWatcher = void 0;
function onWatcherCleanup(cleanupFn, failSilently = false, owner = activeWatcher) {
  if (owner) {
    let cleanups = cleanupMap.get(owner);
    if (!cleanups) cleanupMap.set(owner, cleanups = []);
    cleanups.push(cleanupFn);
  }
}
function watch$1(source, cb, options = EMPTY_OBJ) {
  const { immediate, deep, once, scheduler, augmentJob, call } = options;
  const reactiveGetter = (source2) => {
    if (deep) return source2;
    if (/* @__PURE__ */ isShallow(source2) || deep === false || deep === 0)
      return traverse(source2, 1);
    return traverse(source2);
  };
  let effect2;
  let getter;
  let cleanup;
  let boundCleanup;
  let forceTrigger = false;
  let isMultiSource = false;
  if (/* @__PURE__ */ isRef(source)) {
    getter = () => source.value;
    forceTrigger = /* @__PURE__ */ isShallow(source);
  } else if (/* @__PURE__ */ isReactive(source)) {
    getter = () => reactiveGetter(source);
    forceTrigger = true;
  } else if (isArray(source)) {
    isMultiSource = true;
    forceTrigger = source.some((s) => /* @__PURE__ */ isReactive(s) || /* @__PURE__ */ isShallow(s));
    getter = () => source.map((s) => {
      if (/* @__PURE__ */ isRef(s)) {
        return s.value;
      } else if (/* @__PURE__ */ isReactive(s)) {
        return reactiveGetter(s);
      } else if (isFunction(s)) {
        return call ? call(s, 2) : s();
      } else ;
    });
  } else if (isFunction(source)) {
    if (cb) {
      getter = call ? () => call(source, 2) : source;
    } else {
      getter = () => {
        if (cleanup) {
          pauseTracking();
          try {
            cleanup();
          } finally {
            resetTracking();
          }
        }
        const currentEffect = activeWatcher;
        activeWatcher = effect2;
        try {
          return call ? call(source, 3, [boundCleanup]) : source(boundCleanup);
        } finally {
          activeWatcher = currentEffect;
        }
      };
    }
  } else {
    getter = NOOP;
  }
  if (cb && deep) {
    const baseGetter = getter;
    const depth = deep === true ? Infinity : deep;
    getter = () => traverse(baseGetter(), depth);
  }
  const scope = getCurrentScope();
  const watchHandle = () => {
    effect2.stop();
    if (scope && scope.active) {
      remove(scope.effects, effect2);
    }
  };
  if (once && cb) {
    const _cb = cb;
    cb = (...args) => {
      try {
        return _cb(...args);
      } finally {
        watchHandle();
      }
    };
  }
  let oldValue = isMultiSource ? new Array(source.length).fill(INITIAL_WATCHER_VALUE) : INITIAL_WATCHER_VALUE;
  const job = (immediateFirstRun) => {
    if (!(effect2.flags & 1) || !effect2.dirty && !immediateFirstRun) {
      return;
    }
    if (cb) {
      const newValue = effect2.run();
      if (immediateFirstRun || deep || forceTrigger || (isMultiSource ? newValue.some((v, i) => hasChanged(v, oldValue[i])) : hasChanged(newValue, oldValue))) {
        const currentWatcher = activeWatcher;
        pauseTracking();
        try {
          if (cleanup) {
            cleanup();
          }
          activeWatcher = effect2;
          const args = [
            newValue,
            // pass undefined as the old value when it's changed for the first time
            oldValue === INITIAL_WATCHER_VALUE ? void 0 : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE ? [] : oldValue,
            boundCleanup
          ];
          oldValue = newValue;
          call ? call(cb, 3, args) : (
            // @ts-expect-error
            cb(...args)
          );
        } finally {
          activeWatcher = currentWatcher;
          resetTracking();
        }
      }
    } else {
      effect2.run();
    }
  };
  if (augmentJob) {
    augmentJob(job);
  }
  effect2 = new ReactiveEffect(getter);
  effect2.scheduler = scheduler ? () => scheduler(job, false) : job;
  boundCleanup = (fn) => onWatcherCleanup(fn, false, effect2);
  cleanup = effect2.onStop = () => {
    const cleanups = cleanupMap.get(effect2);
    if (cleanups) {
      if (call) {
        call(cleanups, 4);
      } else {
        for (const cleanup2 of cleanups) cleanup2();
      }
      cleanupMap.delete(effect2);
    }
  };
  if (cb) {
    if (immediate) {
      job(true);
    } else {
      oldValue = effect2.run();
    }
  } else if (scheduler) {
    scheduler(job.bind(null, true), true);
  } else {
    effect2.run();
  }
  watchHandle.pause = effect2.pause.bind(effect2);
  watchHandle.resume = effect2.resume.bind(effect2);
  watchHandle.stop = watchHandle;
  return watchHandle;
}
function traverse(value, depth = Infinity, seen) {
  if (depth <= 0 || !isObject(value) || value["__v_skip"]) {
    return value;
  }
  seen = seen || /* @__PURE__ */ new Map();
  if ((seen.get(value) || 0) >= depth) {
    return value;
  }
  seen.set(value, depth);
  depth--;
  if (/* @__PURE__ */ isRef(value)) {
    traverse(value.value, depth, seen);
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], depth, seen);
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v) => {
      traverse(v, depth, seen);
    });
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse(value[key], depth, seen);
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse(value[key], depth, seen);
      }
    }
  }
  return value;
}
/**
* @vue/runtime-core v3.5.44
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/
const stack = [];
let isWarning = false;
function warn$1(msg, ...args) {
  if (isWarning) return;
  isWarning = true;
  pauseTracking();
  const instance = stack.length ? stack[stack.length - 1].component : null;
  const appWarnHandler = instance && instance.appContext.config.warnHandler;
  const trace = getComponentTrace();
  if (appWarnHandler) {
    callWithErrorHandling(
      appWarnHandler,
      instance,
      11,
      [
        // eslint-disable-next-line no-restricted-syntax
        msg + args.map((a) => {
          var _a, _b;
          return (_b = (_a = a.toString) == null ? void 0 : _a.call(a)) != null ? _b : JSON.stringify(a);
        }).join(""),
        instance && instance.proxy,
        trace.map(
          ({ vnode }) => `at <${formatComponentName(instance, vnode.type)}>`
        ).join("\n"),
        trace
      ]
    );
  } else {
    const warnArgs = [`[Vue warn]: ${msg}`, ...args];
    if (trace.length && // avoid spamming console during tests
    true) {
      warnArgs.push(`
`, ...formatTrace(trace));
    }
    console.warn(...warnArgs);
  }
  resetTracking();
  isWarning = false;
}
function getComponentTrace() {
  let currentVNode = stack[stack.length - 1];
  if (!currentVNode) {
    return [];
  }
  const normalizedStack = [];
  while (currentVNode) {
    const last = normalizedStack[0];
    if (last && last.vnode === currentVNode) {
      last.recurseCount++;
    } else {
      normalizedStack.push({
        vnode: currentVNode,
        recurseCount: 0
      });
    }
    const parentInstance = currentVNode.component && currentVNode.component.parent;
    currentVNode = parentInstance && parentInstance.vnode;
  }
  return normalizedStack;
}
function formatTrace(trace) {
  const logs = [];
  trace.forEach((entry, i) => {
    logs.push(...i === 0 ? [] : [`
`], ...formatTraceEntry(entry));
  });
  return logs;
}
function formatTraceEntry({ vnode, recurseCount }) {
  const postfix = recurseCount > 0 ? `... (${recurseCount} recursive calls)` : ``;
  const isRoot = vnode.component ? vnode.component.parent == null : false;
  const open = ` at <${formatComponentName(
    vnode.component,
    vnode.type,
    isRoot
  )}`;
  const close = `>` + postfix;
  return vnode.props ? [open, ...formatProps(vnode.props), close] : [open + close];
}
function formatProps(props) {
  const res = [];
  const keys = Object.keys(props);
  keys.slice(0, 3).forEach((key) => {
    res.push(...formatProp(key, props[key]));
  });
  if (keys.length > 3) {
    res.push(` ...`);
  }
  return res;
}
function formatProp(key, value, raw) {
  if (isString(value)) {
    value = JSON.stringify(value);
    return raw ? value : [`${key}=${value}`];
  } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return raw ? value : [`${key}=${value}`];
  } else if (/* @__PURE__ */ isRef(value)) {
    value = formatProp(key, /* @__PURE__ */ toRaw(value.value), true);
    return raw ? value : [`${key}=Ref<`, value, `>`];
  } else if (isFunction(value)) {
    return [`${key}=fn${value.name ? `<${value.name}>` : ``}`];
  } else {
    value = /* @__PURE__ */ toRaw(value);
    return raw ? value : [`${key}=`, value];
  }
}
function callWithErrorHandling(fn, instance, type, args) {
  try {
    return args ? fn(...args) : fn();
  } catch (err) {
    handleError(err, instance, type);
  }
}
function callWithAsyncErrorHandling(fn, instance, type, args) {
  if (isFunction(fn)) {
    const res = callWithErrorHandling(fn, instance, type, args);
    if (res && isPromise(res)) {
      res.catch((err) => {
        handleError(err, instance, type);
      });
    }
    return res;
  }
  if (isArray(fn)) {
    const values = [];
    for (let i = 0; i < fn.length; i++) {
      values.push(callWithAsyncErrorHandling(fn[i], instance, type, args));
    }
    return values;
  }
}
function handleError(err, instance, type, throwInDev = true) {
  const contextVNode = instance ? instance.vnode : null;
  const { errorHandler, throwUnhandledErrorInProduction } = instance && instance.appContext.config || EMPTY_OBJ;
  if (instance) {
    let cur = instance.parent;
    const exposedInstance = instance.proxy;
    const errorInfo = `https://vuejs.org/error-reference/#runtime-${type}`;
    while (cur) {
      const errorCapturedHooks = cur.ec;
      if (errorCapturedHooks) {
        for (let i = 0; i < errorCapturedHooks.length; i++) {
          if (errorCapturedHooks[i](err, exposedInstance, errorInfo) === false) {
            return;
          }
        }
      }
      cur = cur.parent;
    }
    if (errorHandler) {
      pauseTracking();
      callWithErrorHandling(errorHandler, null, 10, [
        err,
        exposedInstance,
        errorInfo
      ]);
      resetTracking();
      return;
    }
  }
  logError(err, type, contextVNode, throwInDev, throwUnhandledErrorInProduction);
}
function logError(err, type, contextVNode, throwInDev = true, throwInProd = false) {
  if (throwInProd) {
    throw err;
  } else {
    console.error(err);
  }
}
const queue = [];
let flushIndex = -1;
const pendingPostFlushCbs = [];
let activePostFlushCbs = null;
let postFlushIndex = 0;
const resolvedPromise = /* @__PURE__ */ Promise.resolve();
let currentFlushPromise = null;
function nextTick(fn) {
  const p2 = currentFlushPromise || resolvedPromise;
  return fn ? p2.then(this ? fn.bind(this) : fn) : p2;
}
function findInsertionIndex(id) {
  let start = flushIndex + 1;
  let end = queue.length;
  while (start < end) {
    const middle = start + end >>> 1;
    const middleJob = queue[middle];
    const middleJobId = getId(middleJob);
    if (middleJobId < id || middleJobId === id && middleJob.flags & 2) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return start;
}
function queueJob(job) {
  if (!(job.flags & 1)) {
    const jobId = getId(job);
    const lastJob = queue[queue.length - 1];
    if (!lastJob || // fast path when the job id is larger than the tail
    !(job.flags & 2) && jobId >= getId(lastJob)) {
      queue.push(job);
    } else {
      queue.splice(findInsertionIndex(jobId), 0, job);
    }
    job.flags |= 1;
    queueFlush();
  }
}
function queueFlush() {
  if (!currentFlushPromise) {
    currentFlushPromise = resolvedPromise.then(flushJobs);
  }
}
function queuePostFlushCb(cb) {
  if (!isArray(cb)) {
    if (activePostFlushCbs && cb.id === -1) {
      activePostFlushCbs.splice(postFlushIndex + 1, 0, cb);
    } else if (!(cb.flags & 1)) {
      pendingPostFlushCbs.push(cb);
      cb.flags |= 1;
    }
  } else {
    for (let i = 0; i < cb.length; i++) {
      pendingPostFlushCbs.push(cb[i]);
    }
  }
  queueFlush();
}
function flushPreFlushCbs(instance, minUid, seen, i = flushIndex + 1) {
  for (; i < queue.length; i++) {
    const cb = queue[i];
    if (cb && cb.flags & 2) {
      if (instance && cb.id !== instance.uid || minUid !== void 0 && !(cb.id >= minUid)) {
        continue;
      }
      queue.splice(i, 1);
      i = instance ? i - 1 : flushIndex;
      if (cb.flags & 4) {
        cb.flags &= -2;
      }
      cb();
      if (!(cb.flags & 4)) {
        cb.flags &= -2;
      }
    }
  }
}
function flushPostFlushCbs(seen, skip, minUid = 0) {
  if (pendingPostFlushCbs.length) {
    let cbs = pendingPostFlushCbs;
    let kept = 0;
    if (skip) {
      cbs = [];
      for (let i = 0; i < pendingPostFlushCbs.length; i++) {
        const cb = pendingPostFlushCbs[i];
        if (cb.i !== void 0 ? !cb.i || cb.i.uid < minUid : skip.has(cb)) {
          pendingPostFlushCbs[kept++] = cb;
        } else {
          cbs.push(cb);
        }
      }
    }
    const deduped = [...new Set(cbs)].sort((a, b) => getId(a) - getId(b));
    pendingPostFlushCbs.length = kept;
    if (activePostFlushCbs) {
      for (let i = 0; i < deduped.length; i++) {
        activePostFlushCbs.push(deduped[i]);
      }
      return;
    }
    activePostFlushCbs = deduped;
    for (postFlushIndex = 0; postFlushIndex < activePostFlushCbs.length; postFlushIndex++) {
      const cb = activePostFlushCbs[postFlushIndex];
      if (cb.flags & 4) {
        cb.flags &= -2;
      }
      if (!(cb.flags & 8)) cb();
      cb.flags &= -2;
    }
    activePostFlushCbs = null;
    postFlushIndex = 0;
  }
}
let isFlushing = false;
function flushOnAppMount(fn, minUid) {
  if (isFlushing) {
    fn();
    return;
  }
  const queued = minUid === void 0 ? void 0 : new Set(pendingPostFlushCbs);
  fn();
  isFlushing = true;
  try {
    flushPreFlushCbs(void 0, minUid);
    flushPostFlushCbs(void 0, queued, minUid);
  } finally {
    isFlushing = false;
  }
}
const getId = (job) => job.id == null ? job.flags & 2 ? -1 : Infinity : job.id;
function flushJobs(seen) {
  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job && !(job.flags & 8)) {
        if (false) ;
        if (job.flags & 4) {
          job.flags &= ~1;
        }
        callWithErrorHandling(
          job,
          job.i,
          job.i ? 15 : 14
        );
        if (!(job.flags & 4)) {
          job.flags &= ~1;
        }
      }
    }
  } finally {
    for (; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job) {
        job.flags &= -2;
      }
    }
    flushIndex = -1;
    queue.length = 0;
    flushPostFlushCbs();
    currentFlushPromise = null;
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs();
    }
  }
}
let currentRenderingInstance = null;
let currentScopeId = null;
function setCurrentRenderingInstance(instance) {
  const prev = currentRenderingInstance;
  currentRenderingInstance = instance;
  currentScopeId = instance && instance.type.__scopeId || null;
  return prev;
}
function withCtx(fn, ctx = currentRenderingInstance, isNonScopedSlot) {
  if (!ctx) return fn;
  if (fn._n) {
    return fn;
  }
  const renderFnWithContext = (...args) => {
    if (renderFnWithContext._d) {
      setBlockTracking(-1);
    }
    const prevInstance = setCurrentRenderingInstance(ctx);
    const prevStackSize = blockStack.length;
    let res;
    try {
      res = fn(...args);
    } finally {
      for (let i = blockStack.length; i > prevStackSize; i--) closeBlock();
      setCurrentRenderingInstance(prevInstance);
      if (renderFnWithContext._d) {
        setBlockTracking(1);
      }
    }
    return res;
  };
  renderFnWithContext._n = true;
  renderFnWithContext._c = true;
  renderFnWithContext._d = true;
  return renderFnWithContext;
}
function withDirectives(vnode, directives) {
  if (currentRenderingInstance === null) {
    return vnode;
  }
  const instance = getComponentPublicInstance(currentRenderingInstance);
  const bindings = vnode.dirs || (vnode.dirs = []);
  for (let i = 0; i < directives.length; i++) {
    let [dir, value, arg, modifiers = EMPTY_OBJ] = directives[i];
    if (dir) {
      if (isFunction(dir)) {
        dir = {
          mounted: dir,
          updated: dir
        };
      }
      if (dir.deep) {
        traverse(value);
      }
      bindings.push({
        dir,
        instance,
        value,
        oldValue: void 0,
        arg,
        modifiers
      });
    }
  }
  return vnode;
}
function invokeDirectiveHook(vnode, prevVNode, instance, name) {
  const bindings = vnode.dirs;
  const oldBindings = prevVNode && prevVNode.dirs;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (oldBindings) {
      binding.oldValue = oldBindings[i].value;
    }
    let hook = binding.dir[name];
    if (hook) {
      pauseTracking();
      callWithAsyncErrorHandling(hook, instance, 8, [
        vnode.el,
        binding,
        vnode,
        prevVNode
      ]);
      resetTracking();
    }
  }
}
function provide(key, value) {
  if (currentInstance) {
    let provides = currentInstance.provides;
    const parentProvides = currentInstance.parent && currentInstance.parent.provides;
    if (parentProvides === provides) {
      provides = currentInstance.provides = Object.create(parentProvides);
    }
    provides[key] = value;
  }
}
function inject(key, defaultValue, treatDefaultAsFactory = false) {
  const instance = getCurrentInstance();
  if (instance || currentApp) {
    let provides = currentApp ? currentApp._context.provides : instance ? instance.parent == null || instance.ce ? instance.vnode.appContext && instance.vnode.appContext.provides : instance.parent.provides : void 0;
    if (provides && key in provides) {
      return provides[key];
    } else if (arguments.length > 1) {
      return treatDefaultAsFactory && isFunction(defaultValue) ? defaultValue.call(instance && instance.proxy) : defaultValue;
    } else ;
  }
}
const ssrContextKey = /* @__PURE__ */ Symbol.for("v-scx");
const useSSRContext = () => {
  {
    const ctx = inject(ssrContextKey);
    return ctx;
  }
};
function watch(source, cb, options) {
  return doWatch(source, cb, options);
}
function doWatch(source, cb, options = EMPTY_OBJ) {
  const { immediate, deep, flush, once } = options;
  const baseWatchOptions = extend({}, options);
  const runsImmediately = cb && immediate || !cb && flush !== "post";
  let ssrCleanup;
  if (isInSSRComponentSetup) {
    if (flush === "sync") {
      const ctx = useSSRContext();
      ssrCleanup = ctx.__watcherHandles || (ctx.__watcherHandles = []);
    } else if (!runsImmediately) {
      const watchStopHandle = () => {
      };
      watchStopHandle.stop = NOOP;
      watchStopHandle.resume = NOOP;
      watchStopHandle.pause = NOOP;
      return watchStopHandle;
    }
  }
  const instance = currentInstance;
  baseWatchOptions.call = (fn, type, args) => callWithAsyncErrorHandling(fn, instance, type, args);
  let isPre = false;
  if (flush === "post") {
    baseWatchOptions.scheduler = (job) => {
      job.i = instance;
      queuePostRenderEffect(job, instance && instance.suspense);
    };
  } else if (flush !== "sync") {
    isPre = true;
    baseWatchOptions.scheduler = (job, isFirstRun) => {
      if (isFirstRun) {
        job();
      } else {
        queueJob(job);
      }
    };
  }
  baseWatchOptions.augmentJob = (job) => {
    if (cb) {
      job.flags |= 4;
    }
    if (isPre) {
      job.flags |= 2;
      if (instance) {
        job.id = instance.uid;
        job.i = instance;
      }
    }
  };
  const watchHandle = watch$1(source, cb, baseWatchOptions);
  if (isInSSRComponentSetup) {
    if (ssrCleanup) {
      ssrCleanup.push(watchHandle);
    } else if (runsImmediately) {
      watchHandle();
    }
  }
  return watchHandle;
}
function instanceWatch(source, value, options) {
  const publicThis = this.proxy;
  const getter = isString(source) ? source.includes(".") ? createPathGetter(publicThis, source) : () => publicThis[source] : source.bind(publicThis, publicThis);
  let cb;
  if (isFunction(value)) {
    cb = value;
  } else {
    cb = value.handler;
    options = value;
  }
  const reset = setCurrentInstance(this);
  const res = doWatch(getter, cb.bind(publicThis), options);
  reset();
  return res;
}
function createPathGetter(ctx, path) {
  const segments = path.split(".");
  return () => {
    let cur = ctx;
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]];
    }
    return cur;
  };
}
const pendingMounts = /* @__PURE__ */ new WeakMap();
const TeleportEndKey = /* @__PURE__ */ Symbol("_vte");
const isTeleport = (type) => type.__isTeleport;
const isTeleportDisabled = (props) => props && (props.disabled || props.disabled === "");
const isTeleportDeferred = (props) => props && (props.defer || props.defer === "");
const isTargetSVG = (target) => typeof SVGElement !== "undefined" && target instanceof SVGElement;
const isTargetMathML = (target) => typeof MathMLElement === "function" && target instanceof MathMLElement;
const resolveTarget = (props, select) => {
  const targetSelector = props && props.to;
  if (isString(targetSelector)) {
    if (!select) {
      return null;
    } else {
      const target = select(targetSelector);
      return target;
    }
  } else {
    return targetSelector;
  }
};
const TeleportImpl = {
  name: "Teleport",
  __isTeleport: true,
  process(n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized, internals) {
    const {
      mc: mountChildren,
      pc: patchChildren,
      pbc: patchBlockChildren,
      o: { insert, querySelector, createText, createComment, parentNode }
    } = internals;
    const disabled = isTeleportDisabled(n2.props);
    let { dynamicChildren } = n2;
    const mount = (vnode, container2, anchor2) => {
      if (vnode.shapeFlag & 16) {
        mountChildren(
          vnode.children,
          container2,
          anchor2,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      }
    };
    const mountToTarget = (vnode = n2) => {
      const disabled2 = isTeleportDisabled(vnode.props);
      const target = vnode.target = resolveTarget(vnode.props, querySelector);
      const targetAnchor = prepareAnchor(target, vnode, createText, insert);
      if (target) {
        if (namespace !== "svg" && isTargetSVG(target)) {
          namespace = "svg";
        } else if (namespace !== "mathml" && isTargetMathML(target)) {
          namespace = "mathml";
        }
        if (parentComponent && parentComponent.isCE) {
          (parentComponent.ce._teleportTargets || (parentComponent.ce._teleportTargets = /* @__PURE__ */ new Set())).add(target);
        }
        if (!disabled2) {
          mount(vnode, target, targetAnchor);
          updateCssVars(vnode, false);
        }
      }
    };
    const queuePendingMount = (vnode) => {
      const mountJob = () => {
        if (pendingMounts.get(vnode) !== mountJob) return;
        pendingMounts.delete(vnode);
        if (isTeleportDisabled(vnode.props)) {
          const mountContainer = parentNode(vnode.el) || container;
          mount(vnode, mountContainer, vnode.anchor);
          updateCssVars(vnode, true);
        }
        mountToTarget(vnode);
      };
      pendingMounts.set(vnode, mountJob);
      queuePostRenderEffect(mountJob, parentSuspense);
    };
    if (n1 == null) {
      const placeholder = n2.el = createText("");
      const mainAnchor = n2.anchor = createText("");
      insert(placeholder, container, anchor);
      insert(mainAnchor, container, anchor);
      if (isTeleportDeferred(n2.props) || parentSuspense && parentSuspense.pendingBranch) {
        queuePendingMount(n2);
        return;
      }
      if (disabled) {
        mount(n2, container, mainAnchor);
        updateCssVars(n2, true);
      }
      mountToTarget();
    } else {
      n2.el = n1.el;
      const mainAnchor = n2.anchor = n1.anchor;
      const pendingMount = pendingMounts.get(n1);
      if (pendingMount) {
        pendingMount.flags |= 8;
        pendingMounts.delete(n1);
        queuePendingMount(n2);
        return;
      }
      n2.targetStart = n1.targetStart;
      const target = n2.target = n1.target;
      const targetAnchor = n2.targetAnchor = n1.targetAnchor;
      const wasDisabled = isTeleportDisabled(n1.props);
      const currentContainer = wasDisabled ? container : target;
      const currentAnchor = wasDisabled ? mainAnchor : targetAnchor;
      if (namespace === "svg" || isTargetSVG(target)) {
        namespace = "svg";
      } else if (namespace === "mathml" || isTargetMathML(target)) {
        namespace = "mathml";
      }
      if (dynamicChildren) {
        patchBlockChildren(
          n1.dynamicChildren,
          dynamicChildren,
          currentContainer,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds
        );
        traverseStaticChildren(n1, n2, true);
      } else if (!optimized) {
        patchChildren(
          n1,
          n2,
          currentContainer,
          currentAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          false
        );
      }
      if (disabled) {
        if (!wasDisabled) {
          moveTeleport(
            n2,
            container,
            mainAnchor,
            internals,
            1
          );
        } else {
          if (n2.props && n1.props && n2.props.to !== n1.props.to) {
            n2.props.to = n1.props.to;
          }
        }
      } else {
        if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) {
          const nextTarget = resolveTarget(n2.props, querySelector);
          if (nextTarget) {
            n2.target = nextTarget;
            moveTeleport(
              n2,
              nextTarget,
              null,
              internals,
              0
            );
          }
        } else if (wasDisabled) {
          moveTeleport(
            n2,
            target,
            targetAnchor,
            internals,
            1
          );
        }
      }
      updateCssVars(n2, disabled);
    }
  },
  remove(vnode, parentComponent, parentSuspense, { um: unmount, o: { remove: hostRemove } }, doRemove) {
    const {
      shapeFlag,
      children,
      anchor,
      targetStart,
      targetAnchor,
      target,
      props
    } = vnode;
    const disabled = isTeleportDisabled(props);
    const shouldRemove = doRemove || !disabled;
    const pendingMount = pendingMounts.get(vnode);
    if (pendingMount) {
      pendingMount.flags |= 8;
      pendingMounts.delete(vnode);
    }
    if (target) {
      hostRemove(targetStart);
      hostRemove(targetAnchor);
    }
    doRemove && hostRemove(anchor);
    if (!pendingMount && (disabled || target) && shapeFlag & 16) {
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        unmount(
          child,
          parentComponent,
          parentSuspense,
          shouldRemove,
          !!child.dynamicChildren
        );
      }
    }
  },
  move: moveTeleport,
  hydrate: hydrateTeleport
};
function moveTeleport(vnode, container, parentAnchor, { o: { insert }, m: move }, moveType = 2) {
  if (moveType === 0) {
    if (vnode.targetStart) {
      insert(vnode.targetStart, container, parentAnchor);
    }
    insert(vnode.targetAnchor, container, parentAnchor);
    parentAnchor = vnode.targetAnchor;
  }
  const { el, anchor, shapeFlag, children, props } = vnode;
  const isReorder = moveType === 2;
  if (isReorder) {
    insert(el, container, parentAnchor);
  }
  if (!pendingMounts.has(vnode) && (!isReorder || isTeleportDisabled(props))) {
    if (shapeFlag & 16) {
      for (let i = 0; i < children.length; i++) {
        move(
          children[i],
          container,
          parentAnchor,
          2
        );
      }
    }
  }
  if (isReorder) {
    insert(anchor, container, parentAnchor);
  }
}
function hydrateTeleport(node, vnode, parentComponent, parentSuspense, slotScopeIds, optimized, {
  o: { nextSibling, parentNode, querySelector, insert, createText }
}, hydrateChildren) {
  function hydrateAnchor(target2, targetNode) {
    let targetAnchor = targetNode;
    while (targetAnchor) {
      if (targetAnchor && targetAnchor.nodeType === 8) {
        if (targetAnchor.data === "teleport start anchor") {
          vnode.targetStart = targetAnchor;
        } else if (targetAnchor.data === "teleport anchor") {
          vnode.targetAnchor = targetAnchor;
          target2._lpa = vnode.targetAnchor && nextSibling(vnode.targetAnchor);
          break;
        }
      }
      targetAnchor = nextSibling(targetAnchor);
    }
  }
  function hydrateDisabledTeleport(node2, vnode2) {
    vnode2.anchor = hydrateChildren(
      nextSibling(node2),
      vnode2,
      parentNode(node2),
      parentComponent,
      parentSuspense,
      slotScopeIds,
      optimized
    );
  }
  const target = vnode.target = resolveTarget(
    vnode.props,
    querySelector
  );
  const disabled = isTeleportDisabled(vnode.props);
  if (target) {
    const targetNode = target._lpa || target.firstChild;
    if (vnode.shapeFlag & 16) {
      if (disabled) {
        hydrateDisabledTeleport(node, vnode);
        hydrateAnchor(target, targetNode);
        if (!vnode.targetAnchor) {
          prepareAnchor(
            target,
            vnode,
            createText,
            insert,
            // if target is the same as the main view, insert anchors before current node
            // to avoid hydrating mismatch
            parentNode(node) === target ? node : null
          );
        }
      } else {
        vnode.anchor = nextSibling(node);
        hydrateAnchor(target, targetNode);
        if (!vnode.targetAnchor) {
          prepareAnchor(target, vnode, createText, insert);
        }
        hydrateChildren(
          targetNode && nextSibling(targetNode),
          vnode,
          target,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        );
      }
    }
    updateCssVars(vnode, disabled);
  } else if (disabled) {
    if (vnode.shapeFlag & 16) {
      hydrateDisabledTeleport(node, vnode);
      vnode.targetStart = node;
      vnode.targetAnchor = nextSibling(node);
    }
  }
  return vnode.anchor && nextSibling(vnode.anchor);
}
const Teleport = TeleportImpl;
function updateCssVars(vnode, isDisabled) {
  const ctx = vnode.ctx;
  if (ctx && ctx.ut) {
    let node, anchor;
    if (isDisabled) {
      node = vnode.el;
      anchor = vnode.anchor;
    } else {
      node = vnode.targetStart;
      anchor = vnode.targetAnchor;
    }
    while (node && node !== anchor) {
      if (node.nodeType === 1) node.setAttribute("data-v-owner", ctx.uid);
      node = node.nextSibling;
    }
    ctx.ut();
  }
}
function prepareAnchor(target, vnode, createText, insert, anchor = null) {
  const targetStart = vnode.targetStart = createText("");
  const targetAnchor = vnode.targetAnchor = createText("");
  targetStart[TeleportEndKey] = targetAnchor;
  if (target) {
    insert(targetStart, target, anchor);
    insert(targetAnchor, target, anchor);
  }
  return targetAnchor;
}
const leaveCbKey = /* @__PURE__ */ Symbol("_leaveCb");
const enterCbKey = /* @__PURE__ */ Symbol("_enterCb");
function useTransitionState() {
  const state = {
    isMounted: false,
    isLeaving: false,
    isUnmounting: false,
    leavingVNodes: /* @__PURE__ */ new Map()
  };
  onMounted(() => {
    state.isMounted = true;
  });
  onBeforeUnmount(() => {
    state.isUnmounting = true;
  });
  return state;
}
const TransitionHookValidator = [Function, Array];
const BaseTransitionPropsValidators = {
  mode: String,
  appear: Boolean,
  persisted: Boolean,
  // enter
  onBeforeEnter: TransitionHookValidator,
  onEnter: TransitionHookValidator,
  onAfterEnter: TransitionHookValidator,
  onEnterCancelled: TransitionHookValidator,
  // leave
  onBeforeLeave: TransitionHookValidator,
  onLeave: TransitionHookValidator,
  onAfterLeave: TransitionHookValidator,
  onLeaveCancelled: TransitionHookValidator,
  // appear
  onBeforeAppear: TransitionHookValidator,
  onAppear: TransitionHookValidator,
  onAfterAppear: TransitionHookValidator,
  onAppearCancelled: TransitionHookValidator
};
const BaseTransitionImpl = {
  name: `BaseTransition`,
  props: BaseTransitionPropsValidators,
  setup(props, { slots }) {
    const instance = getCurrentInstance();
    const state = useTransitionState();
    return () => {
      const children = slots.default && getTransitionRawChildren(slots.default(), true);
      const child = children && children.length ? findNonCommentChild(children) : (
        // Keep explicit default-slot conditionals on the same transition path
        // as regular v-if branches, which render a comment placeholder.
        instance.subTree ? createCommentVNode() : void 0
      );
      if (!child) {
        return;
      }
      const rawProps = /* @__PURE__ */ toRaw(props);
      const { mode } = rawProps;
      if (state.isLeaving) {
        return emptyPlaceholder(child);
      }
      const innerChild = getInnerChild$1(child);
      if (!innerChild) {
        return emptyPlaceholder(child);
      }
      let enterHooks = resolveTransitionHooks(
        innerChild,
        rawProps,
        state,
        instance,
        // #11061, ensure enterHooks is fresh after clone
        (hooks) => enterHooks = hooks
      );
      if (innerChild.type !== Comment) {
        setTransitionHooks(innerChild, enterHooks);
      }
      let oldInnerChild = instance.subTree && getInnerChild$1(instance.subTree);
      if (oldInnerChild && oldInnerChild.type !== Comment && !isSameVNodeType(oldInnerChild, innerChild) && getTransitionRoot(instance.subTree)) {
        let leavingHooks = resolveTransitionHooks(
          oldInnerChild,
          rawProps,
          state,
          instance
        );
        setTransitionHooks(oldInnerChild, leavingHooks);
        if (mode === "out-in" && innerChild.type !== Comment) {
          state.isLeaving = true;
          leavingHooks.afterLeave = () => {
            state.isLeaving = false;
            if (!(instance.job.flags & 8)) {
              instance.update();
            }
            delete leavingHooks.afterLeave;
            oldInnerChild = void 0;
          };
          return emptyPlaceholder(child);
        } else if (mode === "in-out" && innerChild.type !== Comment) {
          leavingHooks.delayLeave = (el, earlyRemove, delayedLeave) => {
            const leavingVNodesCache = getLeavingNodesForType(
              state,
              oldInnerChild
            );
            leavingVNodesCache[String(oldInnerChild.key)] = oldInnerChild;
            el[leaveCbKey] = () => {
              earlyRemove();
              el[leaveCbKey] = void 0;
              delete enterHooks.delayedLeave;
              oldInnerChild = void 0;
            };
            enterHooks.delayedLeave = () => {
              delayedLeave();
              delete enterHooks.delayedLeave;
              oldInnerChild = void 0;
            };
          };
        } else {
          oldInnerChild = void 0;
        }
      } else if (oldInnerChild) {
        oldInnerChild = void 0;
      }
      return child;
    };
  }
};
function findNonCommentChild(children) {
  let child = children[0];
  if (children.length > 1) {
    for (const c of children) {
      if (c.type !== Comment) {
        child = c;
        break;
      }
    }
  }
  return child;
}
const BaseTransition = BaseTransitionImpl;
function getLeavingNodesForType(state, vnode) {
  const { leavingVNodes } = state;
  let leavingVNodesCache = leavingVNodes.get(vnode.type);
  if (!leavingVNodesCache) {
    leavingVNodesCache = /* @__PURE__ */ Object.create(null);
    leavingVNodes.set(vnode.type, leavingVNodesCache);
  }
  return leavingVNodesCache;
}
function resolveTransitionHooks(vnode, props, state, instance, postClone) {
  const {
    appear,
    mode,
    persisted = false,
    onBeforeEnter,
    onEnter,
    onAfterEnter,
    onEnterCancelled,
    onBeforeLeave,
    onLeave,
    onAfterLeave,
    onLeaveCancelled,
    onBeforeAppear,
    onAppear,
    onAfterAppear,
    onAppearCancelled
  } = props;
  const key = String(vnode.key);
  const leavingVNodesCache = getLeavingNodesForType(state, vnode);
  const callHook2 = (hook, args) => {
    hook && callWithAsyncErrorHandling(
      hook,
      instance,
      9,
      args
    );
  };
  const callAsyncHook = (hook, args) => {
    const done = args[1];
    callHook2(hook, args);
    if (isArray(hook)) {
      if (hook.every((hook2) => hook2.length <= 1)) done();
    } else if (hook.length <= 1) {
      done();
    }
  };
  const hooks = {
    mode,
    persisted,
    beforeEnter(el) {
      let hook = onBeforeEnter;
      if (!state.isMounted) {
        if (appear) {
          hook = onBeforeAppear || onBeforeEnter;
        } else {
          return;
        }
      }
      if (el[leaveCbKey]) {
        el[leaveCbKey](
          true
          /* cancelled */
        );
      }
      const leavingVNode = leavingVNodesCache[key];
      if (leavingVNode && isSameVNodeType(vnode, leavingVNode)) {
        let leavingCb = leavingVNode.el[leaveCbKey];
        if (!leavingCb) {
          const leavingRoot = getTransitionRoot(leavingVNode);
          leavingCb = leavingRoot && leavingRoot.el[leaveCbKey];
        }
        if (leavingCb) {
          leavingCb();
        }
      }
      callHook2(hook, [el]);
    },
    enter(el) {
      if (leavingVNodesCache[key] === vnode) return;
      let hook = onEnter;
      let afterHook = onAfterEnter;
      let cancelHook = onEnterCancelled;
      if (!state.isMounted) {
        if (appear) {
          hook = onAppear || onEnter;
          afterHook = onAfterAppear || onAfterEnter;
          cancelHook = onAppearCancelled || onEnterCancelled;
        } else {
          return;
        }
      }
      let called = false;
      el[enterCbKey] = (cancelled) => {
        if (called) return;
        called = true;
        if (cancelled) {
          callHook2(cancelHook, [el]);
        } else {
          callHook2(afterHook, [el]);
        }
        if (hooks.delayedLeave) {
          hooks.delayedLeave();
        }
        el[enterCbKey] = void 0;
      };
      const done = el[enterCbKey].bind(null, false);
      if (hook) {
        callAsyncHook(hook, [el, done]);
      } else {
        done();
      }
    },
    leave(el, remove2) {
      const key2 = String(vnode.key);
      if (el[enterCbKey]) {
        el[enterCbKey](
          true
          /* cancelled */
        );
      }
      if (state.isUnmounting) {
        return remove2();
      }
      callHook2(onBeforeLeave, [el]);
      let called = false;
      el[leaveCbKey] = (cancelled) => {
        if (called) return;
        called = true;
        remove2();
        if (cancelled) {
          callHook2(onLeaveCancelled, [el]);
        } else {
          callHook2(onAfterLeave, [el]);
        }
        el[leaveCbKey] = void 0;
        if (leavingVNodesCache[key2] === vnode) {
          delete leavingVNodesCache[key2];
        }
      };
      const done = el[leaveCbKey].bind(null, false);
      leavingVNodesCache[key2] = vnode;
      if (onLeave) {
        callAsyncHook(onLeave, [el, done]);
      } else {
        done();
      }
    },
    clone(vnode2) {
      const hooks2 = resolveTransitionHooks(
        vnode2,
        props,
        state,
        instance,
        postClone
      );
      if (postClone) postClone(hooks2);
      return hooks2;
    }
  };
  return hooks;
}
function emptyPlaceholder(vnode) {
  if (isKeepAlive(vnode)) {
    vnode = cloneVNode(vnode);
    vnode.children = null;
    return vnode;
  }
}
function getInnerChild$1(vnode) {
  if (!isKeepAlive(vnode)) {
    if (isTeleport(vnode.type) && vnode.children) {
      return findNonCommentChild(vnode.children);
    }
    return vnode;
  }
  if (vnode.component) {
    return vnode.component.subTree;
  }
  const { shapeFlag, children } = vnode;
  if (children) {
    if (shapeFlag & 16) {
      return children[0];
    }
    if (shapeFlag & 32 && isFunction(children.default)) {
      return children.default();
    }
  }
}
function setTransitionHooks(vnode, hooks) {
  if (vnode.shapeFlag & 6 && vnode.component) {
    vnode.transition = hooks;
    const subTree = vnode.component.subTree;
    setTransitionHooks(
      isTeleport(subTree.type) ? getInnerChild$1(subTree) || subTree : subTree,
      hooks
    );
  } else if (vnode.shapeFlag & 128) {
    vnode.ssContent.transition = hooks.clone(vnode.ssContent);
    vnode.ssFallback.transition = hooks.clone(vnode.ssFallback);
  } else {
    vnode.transition = hooks;
    if (vnode.type === Fragment && isArray(vnode.children)) {
      const child = filterSingleRoot(vnode.children, false);
      if (child) {
        setTransitionHooks(child, hooks);
      }
    }
  }
}
function getTransitionRawChildren(children, keepComment = false, parentKey) {
  let ret = [];
  let keyedFragmentCount = 0;
  for (let i = 0; i < children.length; i++) {
    let child = children[i];
    const key = parentKey == null ? child.key : String(parentKey) + String(child.key != null ? child.key : i);
    if (child.type === Fragment) {
      if (child.patchFlag & 128) keyedFragmentCount++;
      ret = ret.concat(
        getTransitionRawChildren(child.children, keepComment, key)
      );
    } else if (keepComment || child.type !== Comment) {
      ret.push(key != null ? cloneVNode(child, { key }) : child);
    }
  }
  if (keyedFragmentCount > 1) {
    for (let i = 0; i < ret.length; i++) {
      ret[i].patchFlag = -2;
    }
  }
  return ret;
}
function getTransitionRoot(vnode) {
  if (vnode.component) {
    return getTransitionRoot(vnode.component.subTree);
  }
  if (vnode.type === Fragment) {
    const child = isArray(vnode.children) && filterSingleRoot(vnode.children, false);
    return child ? getTransitionRoot(child) : void 0;
  }
  if (vnode.type !== Comment) {
    return vnode;
  }
}
// @__NO_SIDE_EFFECTS__
function defineComponent(options, extraOptions) {
  return isFunction(options) ? (
    // #8236: extend call and options.name access are considered side-effects
    // by Rollup, so we have to wrap it in a pure-annotated IIFE.
    /* @__PURE__ */ (() => extend({ name: options.name }, extraOptions, { setup: options }))()
  ) : options;
}
function markAsyncBoundary(instance) {
  instance.ids = [instance.ids[0] + instance.ids[2]++ + "-", 0, 0];
}
function isTemplateRefKey(refs, key) {
  let desc;
  return !!((desc = Object.getOwnPropertyDescriptor(refs, key)) && !desc.configurable);
}
const pendingSetRefMap = /* @__PURE__ */ new WeakMap();
function setRef(rawRef, oldRawRef, parentSuspense, vnode, isUnmount = false) {
  if (isArray(rawRef)) {
    rawRef.forEach(
      (r, i) => setRef(
        r,
        oldRawRef && (isArray(oldRawRef) ? oldRawRef[i] : oldRawRef),
        parentSuspense,
        vnode,
        isUnmount
      )
    );
    return;
  }
  if (isAsyncWrapper(vnode) && !isUnmount) {
    if (vnode.shapeFlag & 512 && vnode.type.__asyncResolved && vnode.component.subTree.component) {
      setRef(rawRef, oldRawRef, parentSuspense, vnode.component.subTree);
    }
    return;
  }
  const refValue = vnode.shapeFlag & 4 ? getComponentPublicInstance(vnode.component) : vnode.el;
  const value = isUnmount ? null : refValue;
  const { i: owner, r: ref3 } = rawRef;
  const oldRef = oldRawRef && oldRawRef.r;
  const refs = owner.refs === EMPTY_OBJ ? owner.refs = {} : owner.refs;
  const setupState = owner.setupState;
  const rawSetupState = /* @__PURE__ */ toRaw(setupState);
  const canSetSetupRef = setupState === EMPTY_OBJ ? NO : (key) => {
    if (isTemplateRefKey(refs, key)) {
      return false;
    }
    return hasOwn(rawSetupState, key);
  };
  const canSetRef = (ref22, key) => {
    if (key && isTemplateRefKey(refs, key)) {
      return false;
    }
    return true;
  };
  if (oldRef != null && oldRef !== ref3) {
    invalidatePendingSetRef(oldRawRef);
    if (isString(oldRef)) {
      refs[oldRef] = null;
      if (canSetSetupRef(oldRef)) {
        setupState[oldRef] = null;
      }
    } else if (/* @__PURE__ */ isRef(oldRef)) {
      const oldRawRefAtom = oldRawRef;
      if (canSetRef(oldRef, oldRawRefAtom.k)) {
        oldRef.value = null;
      }
      if (oldRawRefAtom.k) refs[oldRawRefAtom.k] = null;
    }
  }
  if (isFunction(ref3)) {
    callWithErrorHandling(ref3, owner, 12, [value, refs]);
  } else {
    const _isString = isString(ref3);
    const _isRef = /* @__PURE__ */ isRef(ref3);
    if (_isString || _isRef) {
      const doSet = () => {
        if (rawRef.f) {
          const existing = _isString ? canSetSetupRef(ref3) ? setupState[ref3] : refs[ref3] : canSetRef() || !rawRef.k ? ref3.value : refs[rawRef.k];
          if (isUnmount) {
            isArray(existing) && remove(existing, refValue);
          } else {
            if (!isArray(existing)) {
              if (_isString) {
                refs[ref3] = [refValue];
                if (canSetSetupRef(ref3)) {
                  setupState[ref3] = refs[ref3];
                }
              } else {
                const newVal = [refValue];
                if (canSetRef(ref3, rawRef.k)) {
                  ref3.value = newVal;
                }
                if (rawRef.k) refs[rawRef.k] = newVal;
              }
            } else if (!existing.includes(refValue)) {
              existing.push(refValue);
            }
          }
        } else if (_isString) {
          refs[ref3] = value;
          if (canSetSetupRef(ref3)) {
            setupState[ref3] = value;
          }
        } else if (_isRef) {
          if (canSetRef(ref3, rawRef.k)) {
            ref3.value = value;
          }
          if (rawRef.k) refs[rawRef.k] = value;
        } else ;
      };
      if (value) {
        const job = () => {
          doSet();
          pendingSetRefMap.delete(rawRef);
        };
        job.id = -1;
        pendingSetRefMap.set(rawRef, job);
        queuePostRenderEffect(job, parentSuspense);
      } else {
        invalidatePendingSetRef(rawRef);
        doSet();
      }
    }
  }
}
function invalidatePendingSetRef(rawRef) {
  const pendingSetRef = pendingSetRefMap.get(rawRef);
  if (pendingSetRef) {
    pendingSetRef.flags |= 8;
    pendingSetRefMap.delete(rawRef);
  }
}
getGlobalThis().requestIdleCallback || ((cb) => setTimeout(cb, 1));
getGlobalThis().cancelIdleCallback || ((id) => clearTimeout(id));
const isAsyncWrapper = (i) => !!i.type.__asyncLoader;
const isKeepAlive = (vnode) => vnode.type.__isKeepAlive;
function onActivated(hook, target) {
  registerKeepAliveHook(hook, "a", target);
}
function onDeactivated(hook, target) {
  registerKeepAliveHook(hook, "da", target);
}
function registerKeepAliveHook(hook, type, target = currentInstance) {
  const wrappedHook = hook.__wdc || (hook.__wdc = () => {
    let current = target;
    while (current) {
      if (current.isDeactivated) {
        return;
      }
      current = current.parent;
    }
    return hook();
  });
  injectHook(type, wrappedHook, target);
  if (target) {
    let current = target.parent;
    while (current && current.parent) {
      if (isKeepAlive(current.parent.vnode)) {
        injectToKeepAliveRoot(wrappedHook, type, target, current);
      }
      current = current.parent;
    }
  }
}
function injectToKeepAliveRoot(hook, type, target, keepAliveRoot) {
  const injected = injectHook(
    type,
    hook,
    keepAliveRoot,
    true
    /* prepend */
  );
  onUnmounted(() => {
    remove(keepAliveRoot[type], injected);
  }, target);
}
function injectHook(type, hook, target = currentInstance, prepend = false) {
  if (target) {
    const hooks = target[type] || (target[type] = []);
    const wrappedHook = hook.__weh || (hook.__weh = (...args) => {
      pauseTracking();
      const reset = setCurrentInstance(target);
      const res = callWithAsyncErrorHandling(hook, target, type, args);
      reset();
      resetTracking();
      return res;
    });
    if (prepend) {
      hooks.unshift(wrappedHook);
    } else {
      hooks.push(wrappedHook);
    }
    return wrappedHook;
  }
}
const createHook = (lifecycle) => (hook, target = currentInstance) => {
  if (!isInSSRComponentSetup || lifecycle === "sp") {
    injectHook(lifecycle, (...args) => hook(...args), target);
  }
};
const onBeforeMount = createHook("bm");
const onMounted = createHook("m");
const onBeforeUpdate = createHook(
  "bu"
);
const onUpdated = createHook("u");
const onBeforeUnmount = createHook(
  "bum"
);
const onUnmounted = createHook("um");
const onServerPrefetch = createHook(
  "sp"
);
const onRenderTriggered = createHook("rtg");
const onRenderTracked = createHook("rtc");
function onErrorCaptured(hook, target = currentInstance) {
  injectHook("ec", hook, target);
}
const COMPONENTS = "components";
function resolveComponent(name, maybeSelfReference) {
  return resolveAsset(COMPONENTS, name, true, maybeSelfReference) || name;
}
const NULL_DYNAMIC_COMPONENT = /* @__PURE__ */ Symbol.for("v-ndc");
function resolveAsset(type, name, warnMissing = true, maybeSelfReference = false) {
  const instance = currentRenderingInstance || currentInstance;
  if (instance) {
    const Component = instance.type;
    {
      const selfName = getComponentName(
        Component,
        false
      );
      if (selfName && (selfName === name || selfName === camelize(name) || selfName === capitalize(camelize(name)))) {
        return Component;
      }
    }
    const res = (
      // local registration
      // check instance[type] first which is resolved for options API
      resolve(instance[type] || Component[type], name) || // global registration
      resolve(instance.appContext[type], name)
    );
    if (!res && maybeSelfReference) {
      return Component;
    }
    return res;
  }
}
function resolve(registry, name) {
  return registry && (registry[name] || registry[camelize(name)] || registry[capitalize(camelize(name))]);
}
function renderList(source, renderItem, cache, index) {
  let ret;
  const cached = cache;
  const sourceIsArray = isArray(source);
  if (sourceIsArray || isString(source)) {
    const sourceIsReactiveArray = sourceIsArray && /* @__PURE__ */ isReactive(source);
    let needsWrap = false;
    let isReadonlySource = false;
    if (sourceIsReactiveArray) {
      needsWrap = !/* @__PURE__ */ isShallow(source);
      isReadonlySource = /* @__PURE__ */ isReadonly(source);
      source = shallowReadArray(source);
    }
    ret = new Array(source.length);
    for (let i = 0, l = source.length; i < l; i++) {
      ret[i] = renderItem(
        needsWrap ? isReadonlySource ? toReadonly(toReactive(source[i])) : toReactive(source[i]) : source[i],
        i,
        void 0,
        cached
      );
    }
  } else if (typeof source === "number") {
    if (!Number.isInteger(source) || source < 0) {
      ret = [];
    } else {
      ret = new Array(source);
      for (let i = 0; i < source; i++) {
        ret[i] = renderItem(i + 1, i, void 0, cached);
      }
    }
  } else if (isObject(source)) {
    if (source[Symbol.iterator]) {
      ret = Array.from(
        source,
        (item, i) => renderItem(item, i, void 0, cached)
      );
    } else {
      const keys = Object.keys(source);
      ret = new Array(keys.length);
      for (let i = 0, l = keys.length; i < l; i++) {
        const key = keys[i];
        ret[i] = renderItem(source[key], key, i, cached);
      }
    }
  } else {
    ret = [];
  }
  return ret;
}
function renderSlot(slots, name, props, fallback, noSlotted, branchKey) {
  if (props == null) props = {};
  if (currentRenderingInstance.ce || currentRenderingInstance.parent && isAsyncWrapper(currentRenderingInstance.parent) && currentRenderingInstance.parent.ce) {
    const slotProps = props;
    const hasProps = Object.keys(slotProps).length > 0;
    if (name !== "default") slotProps.name = name;
    return openBlock(), createBlock(
      Fragment,
      null,
      [createVNode("slot", slotProps, fallback)],
      hasProps ? -2 : 64
    );
  }
  let slot = slots[name];
  if (slot && slot._c) {
    slot._d = false;
  }
  const prevStackSize = blockStack.length;
  openBlock();
  let rendered;
  try {
    const validSlotContent = slot && ensureValidVNode(slot(props));
    const slotKey = props.key || branchKey || // slot content array of a dynamic conditional slot may have a branch
    // key attached in the `createSlots` helper, respect that
    validSlotContent && validSlotContent.key;
    rendered = createBlock(
      Fragment,
      {
        key: (slotKey && !isSymbol(slotKey) ? slotKey : `_${name}`) + // #7256 force differentiate fallback content from actual content
        (!validSlotContent && fallback ? "_fb" : "")
      },
      validSlotContent || (fallback ? fallback() : []),
      validSlotContent && slots._ === 1 ? 64 : -2
    );
  } catch (err) {
    for (let i = blockStack.length; i > prevStackSize; i--) closeBlock();
    throw err;
  } finally {
    if (slot && slot._c) {
      slot._d = true;
    }
  }
  return rendered;
}
function ensureValidVNode(vnodes) {
  return vnodes.some((child) => {
    if (!isVNode(child)) return true;
    if (child.type === Comment) return false;
    if (child.type === Fragment && !ensureValidVNode(child.children))
      return false;
    return true;
  }) ? vnodes : null;
}
const getPublicInstance = (i) => {
  if (!i) return null;
  if (isStatefulComponent(i)) return getComponentPublicInstance(i);
  return getPublicInstance(i.parent);
};
const publicPropertiesMap = (
  // Move PURE marker to new line to workaround compiler discarding it
  // due to type annotation
  /* @__PURE__ */ extend(/* @__PURE__ */ Object.create(null), {
    $: (i) => i,
    $el: (i) => i.vnode.el,
    $data: (i) => i.data,
    $props: (i) => i.props,
    $attrs: (i) => i.attrs,
    $slots: (i) => i.slots,
    $refs: (i) => i.refs,
    $parent: (i) => getPublicInstance(i.parent),
    $root: (i) => getPublicInstance(i.root),
    $host: (i) => i.ce,
    $emit: (i) => i.emit,
    $options: (i) => resolveMergedOptions(i),
    $forceUpdate: (i) => i.f || (i.f = () => {
      queueJob(i.update);
    }),
    $nextTick: (i) => i.n || (i.n = nextTick.bind(i.proxy)),
    $watch: (i) => instanceWatch.bind(i)
  })
);
const hasSetupBinding = (state, key) => state !== EMPTY_OBJ && !state.__isScriptSetup && hasOwn(state, key);
const PublicInstanceProxyHandlers = {
  get({ _: instance }, key) {
    if (key === "__v_skip") {
      return true;
    }
    const { ctx, setupState, data, props, accessCache, type, appContext } = instance;
    if (key[0] !== "$") {
      const n = accessCache[key];
      if (n !== void 0) {
        switch (n) {
          case 1:
            return setupState[key];
          case 2:
            return data[key];
          case 4:
            return ctx[key];
          case 3:
            return props[key];
        }
      } else if (hasSetupBinding(setupState, key)) {
        accessCache[key] = 1;
        return setupState[key];
      } else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
        accessCache[key] = 2;
        return data[key];
      } else if (hasOwn(props, key)) {
        accessCache[key] = 3;
        return props[key];
      } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
        accessCache[key] = 4;
        return ctx[key];
      } else if (shouldCacheAccess) {
        accessCache[key] = 0;
      }
    }
    const publicGetter = publicPropertiesMap[key];
    let cssModule, globalProperties;
    if (publicGetter) {
      if (key === "$attrs") {
        track(instance.attrs, "get", "");
      }
      return publicGetter(instance);
    } else if (
      // css module (injected by vue-loader)
      (cssModule = type.__cssModules) && (cssModule = cssModule[key])
    ) {
      return cssModule;
    } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
      accessCache[key] = 4;
      return ctx[key];
    } else if (
      // global properties
      globalProperties = appContext.config.globalProperties, hasOwn(globalProperties, key)
    ) {
      {
        return globalProperties[key];
      }
    } else ;
  },
  set({ _: instance }, key, value) {
    const { data, setupState, ctx } = instance;
    if (hasSetupBinding(setupState, key)) {
      setupState[key] = value;
      return true;
    } else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
      data[key] = value;
      return true;
    } else if (hasOwn(instance.props, key)) {
      return false;
    }
    if (key[0] === "$" && key.slice(1) in instance) {
      return false;
    } else {
      {
        ctx[key] = value;
      }
    }
    return true;
  },
  has({
    _: { data, setupState, accessCache, ctx, appContext, props, type }
  }, key) {
    let cssModules;
    return !!(accessCache[key] || data !== EMPTY_OBJ && key[0] !== "$" && hasOwn(data, key) || hasSetupBinding(setupState, key) || hasOwn(props, key) || hasOwn(ctx, key) || hasOwn(publicPropertiesMap, key) || hasOwn(appContext.config.globalProperties, key) || (cssModules = type.__cssModules) && cssModules[key]);
  },
  defineProperty(target, key, descriptor) {
    if (descriptor.get != null) {
      target._.accessCache[key] = 0;
    } else if (hasOwn(descriptor, "value")) {
      this.set(target, key, descriptor.value, null);
    }
    return Reflect.defineProperty(target, key, descriptor);
  }
};
function useAttrs() {
  return getContext().attrs;
}
function getContext(calledFunctionName) {
  const i = getCurrentInstance();
  return i.setupContext || (i.setupContext = createSetupContext(i));
}
function normalizePropsOrEmits(props) {
  return isArray(props) ? props.reduce(
    (normalized, p2) => (normalized[p2] = null, normalized),
    {}
  ) : props;
}
let shouldCacheAccess = true;
function applyOptions(instance) {
  const options = resolveMergedOptions(instance);
  const publicThis = instance.proxy;
  const ctx = instance.ctx;
  shouldCacheAccess = false;
  if (options.beforeCreate) {
    callHook$1(options.beforeCreate, instance, "bc");
  }
  const {
    // state
    data: dataOptions,
    computed: computedOptions,
    methods,
    watch: watchOptions,
    provide: provideOptions,
    inject: injectOptions,
    // lifecycle
    created,
    beforeMount,
    mounted,
    beforeUpdate,
    updated,
    activated,
    deactivated,
    beforeDestroy,
    beforeUnmount,
    destroyed,
    unmounted,
    render,
    renderTracked,
    renderTriggered,
    errorCaptured,
    serverPrefetch,
    // public API
    expose,
    inheritAttrs,
    // assets
    components,
    directives,
    filters
  } = options;
  const checkDuplicateProperties = null;
  if (injectOptions) {
    resolveInjections(injectOptions, ctx, checkDuplicateProperties);
  }
  if (methods) {
    for (const key in methods) {
      const methodHandler = methods[key];
      if (isFunction(methodHandler)) {
        {
          ctx[key] = methodHandler.bind(publicThis);
        }
      }
    }
  }
  if (dataOptions) {
    const data = dataOptions.call(publicThis, publicThis);
    if (!isObject(data)) ;
    else {
      instance.data = /* @__PURE__ */ reactive(data);
    }
  }
  shouldCacheAccess = true;
  if (computedOptions) {
    for (const key in computedOptions) {
      const opt = computedOptions[key];
      const get = isFunction(opt) ? opt.bind(publicThis, publicThis) : isFunction(opt.get) ? opt.get.bind(publicThis, publicThis) : NOOP;
      const set = !isFunction(opt) && isFunction(opt.set) ? opt.set.bind(publicThis) : NOOP;
      const c = computed({
        get,
        set
      });
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => c.value,
        set: (v) => c.value = v
      });
    }
  }
  if (watchOptions) {
    for (const key in watchOptions) {
      createWatcher(watchOptions[key], ctx, publicThis, key);
    }
  }
  if (provideOptions) {
    const provides = isFunction(provideOptions) ? provideOptions.call(publicThis) : provideOptions;
    Reflect.ownKeys(provides).forEach((key) => {
      provide(key, provides[key]);
    });
  }
  if (created) {
    callHook$1(created, instance, "c");
  }
  function registerLifecycleHook(register, hook) {
    if (isArray(hook)) {
      hook.forEach((_hook) => register(_hook.bind(publicThis)));
    } else if (hook) {
      register(hook.bind(publicThis));
    }
  }
  registerLifecycleHook(onBeforeMount, beforeMount);
  registerLifecycleHook(onMounted, mounted);
  registerLifecycleHook(onBeforeUpdate, beforeUpdate);
  registerLifecycleHook(onUpdated, updated);
  registerLifecycleHook(onActivated, activated);
  registerLifecycleHook(onDeactivated, deactivated);
  registerLifecycleHook(onErrorCaptured, errorCaptured);
  registerLifecycleHook(onRenderTracked, renderTracked);
  registerLifecycleHook(onRenderTriggered, renderTriggered);
  registerLifecycleHook(onBeforeUnmount, beforeUnmount);
  registerLifecycleHook(onUnmounted, unmounted);
  registerLifecycleHook(onServerPrefetch, serverPrefetch);
  if (isArray(expose)) {
    if (expose.length) {
      const exposed = instance.exposed || (instance.exposed = {});
      expose.forEach((key) => {
        Object.defineProperty(exposed, key, {
          get: () => publicThis[key],
          set: (val) => publicThis[key] = val,
          enumerable: true
        });
      });
    } else if (!instance.exposed) {
      instance.exposed = {};
    }
  }
  if (render && instance.render === NOOP) {
    instance.render = render;
  }
  if (inheritAttrs != null) {
    instance.inheritAttrs = inheritAttrs;
  }
  if (components) instance.components = components;
  if (directives) instance.directives = directives;
  if (serverPrefetch) {
    markAsyncBoundary(instance);
  }
}
function resolveInjections(injectOptions, ctx, checkDuplicateProperties = NOOP) {
  if (isArray(injectOptions)) {
    injectOptions = normalizeInject(injectOptions);
  }
  for (const key in injectOptions) {
    const opt = injectOptions[key];
    let injected;
    if (isObject(opt)) {
      if ("default" in opt) {
        injected = inject(
          opt.from || key,
          opt.default,
          true
        );
      } else {
        injected = inject(opt.from || key);
      }
    } else {
      injected = inject(opt);
    }
    if (/* @__PURE__ */ isRef(injected)) {
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => injected.value,
        set: (v) => injected.value = v
      });
    } else {
      ctx[key] = injected;
    }
  }
}
function callHook$1(hook, instance, type) {
  callWithAsyncErrorHandling(
    isArray(hook) ? hook.map((h2) => h2.bind(instance.proxy)) : hook.bind(instance.proxy),
    instance,
    type
  );
}
function createWatcher(raw, ctx, publicThis, key) {
  let getter = key.includes(".") ? createPathGetter(publicThis, key) : () => publicThis[key];
  if (isString(raw)) {
    const handler = ctx[raw];
    if (isFunction(handler)) {
      {
        watch(getter, handler);
      }
    }
  } else if (isFunction(raw)) {
    {
      watch(getter, raw.bind(publicThis));
    }
  } else if (isObject(raw)) {
    if (isArray(raw)) {
      raw.forEach((r) => createWatcher(r, ctx, publicThis, key));
    } else {
      const handler = isFunction(raw.handler) ? raw.handler.bind(publicThis) : ctx[raw.handler];
      if (isFunction(handler)) {
        watch(getter, handler, raw);
      }
    }
  } else ;
}
function resolveMergedOptions(instance) {
  const base = instance.type;
  const { mixins, extends: extendsOptions } = base;
  const {
    mixins: globalMixins,
    optionsCache: cache,
    config: { optionMergeStrategies }
  } = instance.appContext;
  const cached = cache.get(base);
  let resolved;
  if (cached) {
    resolved = cached;
  } else if (!globalMixins.length && !mixins && !extendsOptions) {
    {
      resolved = base;
    }
  } else {
    resolved = {};
    if (globalMixins.length) {
      globalMixins.forEach(
        (m) => mergeOptions(resolved, m, optionMergeStrategies, true)
      );
    }
    mergeOptions(resolved, base, optionMergeStrategies);
  }
  if (isObject(base)) {
    cache.set(base, resolved);
  }
  return resolved;
}
function mergeOptions(to, from, strats, asMixin = false) {
  const { mixins, extends: extendsOptions } = from;
  if (extendsOptions) {
    mergeOptions(to, extendsOptions, strats, true);
  }
  if (mixins) {
    mixins.forEach(
      (m) => mergeOptions(to, m, strats, true)
    );
  }
  for (const key in from) {
    if (asMixin && key === "expose") ;
    else {
      const strat = internalOptionMergeStrats[key] || strats && strats[key];
      to[key] = strat ? strat(to[key], from[key]) : from[key];
    }
  }
  return to;
}
const internalOptionMergeStrats = {
  data: mergeDataFn,
  props: mergeEmitsOrPropsOptions,
  emits: mergeEmitsOrPropsOptions,
  // objects
  methods: mergeObjectOptions,
  computed: mergeObjectOptions,
  // lifecycle
  beforeCreate: mergeAsArray,
  created: mergeAsArray,
  beforeMount: mergeAsArray,
  mounted: mergeAsArray,
  beforeUpdate: mergeAsArray,
  updated: mergeAsArray,
  beforeDestroy: mergeAsArray,
  beforeUnmount: mergeAsArray,
  destroyed: mergeAsArray,
  unmounted: mergeAsArray,
  activated: mergeAsArray,
  deactivated: mergeAsArray,
  errorCaptured: mergeAsArray,
  serverPrefetch: mergeAsArray,
  // assets
  components: mergeObjectOptions,
  directives: mergeObjectOptions,
  // watch
  watch: mergeWatchOptions,
  // provide / inject
  provide: mergeDataFn,
  inject: mergeInject
};
function mergeDataFn(to, from) {
  if (!from) {
    return to;
  }
  if (!to) {
    return from;
  }
  return function mergedDataFn() {
    return extend(
      isFunction(to) ? to.call(this, this) : to,
      isFunction(from) ? from.call(this, this) : from
    );
  };
}
function mergeInject(to, from) {
  return mergeObjectOptions(normalizeInject(to), normalizeInject(from));
}
function normalizeInject(raw) {
  if (isArray(raw)) {
    const res = {};
    for (let i = 0; i < raw.length; i++) {
      res[raw[i]] = raw[i];
    }
    return res;
  }
  return raw;
}
function mergeAsArray(to, from) {
  return to ? [...new Set([].concat(to, from))] : from;
}
function mergeObjectOptions(to, from) {
  return to ? extend(/* @__PURE__ */ Object.create(null), to, from) : from;
}
function mergeEmitsOrPropsOptions(to, from) {
  if (to) {
    if (isArray(to) && isArray(from)) {
      return [.../* @__PURE__ */ new Set([...to, ...from])];
    }
    return extend(
      /* @__PURE__ */ Object.create(null),
      normalizePropsOrEmits(to),
      normalizePropsOrEmits(from != null ? from : {})
    );
  } else {
    return from;
  }
}
function mergeWatchOptions(to, from) {
  if (!to) return from;
  if (!from) return to;
  const merged = extend(/* @__PURE__ */ Object.create(null), to);
  for (const key in from) {
    merged[key] = mergeAsArray(to[key], from[key]);
  }
  return merged;
}
function createAppContext() {
  return {
    app: null,
    config: {
      isNativeTag: NO,
      performance: false,
      globalProperties: {},
      optionMergeStrategies: {},
      errorHandler: void 0,
      warnHandler: void 0,
      compilerOptions: {}
    },
    mixins: [],
    components: {},
    directives: {},
    provides: /* @__PURE__ */ Object.create(null),
    optionsCache: /* @__PURE__ */ new WeakMap(),
    propsCache: /* @__PURE__ */ new WeakMap(),
    emitsCache: /* @__PURE__ */ new WeakMap()
  };
}
let uid$1 = 0;
function createAppAPI(render, hydrate) {
  return function createApp2(rootComponent, rootProps = null) {
    if (!isFunction(rootComponent)) {
      rootComponent = extend({}, rootComponent);
    }
    if (rootProps != null && !isObject(rootProps)) {
      rootProps = null;
    }
    const context = createAppContext();
    const installedPlugins = /* @__PURE__ */ new WeakSet();
    const pluginCleanupFns = [];
    let isMounted = false;
    const app = context.app = {
      _uid: uid$1++,
      _component: rootComponent,
      _props: rootProps,
      _container: null,
      _context: context,
      _instance: null,
      version,
      get config() {
        return context.config;
      },
      set config(v) {
      },
      use(plugin, ...options) {
        if (installedPlugins.has(plugin)) ;
        else if (plugin && isFunction(plugin.install)) {
          installedPlugins.add(plugin);
          plugin.install(app, ...options);
        } else if (isFunction(plugin)) {
          installedPlugins.add(plugin);
          plugin(app, ...options);
        } else ;
        return app;
      },
      mixin(mixin) {
        {
          if (!context.mixins.includes(mixin)) {
            context.mixins.push(mixin);
          }
        }
        return app;
      },
      component(name, component) {
        if (!component) {
          return context.components[name];
        }
        context.components[name] = component;
        return app;
      },
      directive(name, directive) {
        if (!directive) {
          return context.directives[name];
        }
        context.directives[name] = directive;
        return app;
      },
      mount(rootContainer, isHydrate, namespace) {
        if (!isMounted) {
          const vnode = app._ceVNode || createVNode(rootComponent, rootProps);
          vnode.appContext = context;
          if (namespace === true) {
            namespace = "svg";
          } else if (namespace === false) {
            namespace = void 0;
          }
          {
            render(vnode, rootContainer, namespace);
          }
          isMounted = true;
          app._container = rootContainer;
          rootContainer.__vue_app__ = app;
          return getComponentPublicInstance(vnode.component);
        }
      },
      onUnmount(cleanupFn) {
        pluginCleanupFns.push(cleanupFn);
      },
      unmount() {
        if (isMounted) {
          callWithAsyncErrorHandling(
            pluginCleanupFns,
            app._instance,
            16
          );
          render(null, app._container);
          delete app._container.__vue_app__;
        }
      },
      provide(key, value) {
        context.provides[key] = value;
        return app;
      },
      runWithContext(fn) {
        const lastApp = currentApp;
        currentApp = app;
        try {
          return fn();
        } finally {
          currentApp = lastApp;
        }
      }
    };
    return app;
  };
}
let currentApp = null;
const getModelModifiers = (props, modelName) => {
  return modelName === "modelValue" || modelName === "model-value" ? props.modelModifiers : props[`${modelName}Modifiers`] || props[`${camelize(modelName)}Modifiers`] || props[`${hyphenate(modelName)}Modifiers`];
};
function emit(instance, event, ...rawArgs) {
  if (instance.isUnmounted) return;
  const props = instance.vnode.props || EMPTY_OBJ;
  let args = rawArgs;
  const isModelListener2 = event.startsWith("update:");
  const modifiers = isModelListener2 && getModelModifiers(props, event.slice(7));
  if (modifiers) {
    if (modifiers.trim) {
      args = rawArgs.map((a) => isString(a) ? a.trim() : a);
    }
    if (modifiers.number) {
      args = args.map(looseToNumber);
    }
  }
  let handlerName;
  let handler = props[handlerName = toHandlerKey(event)] || // also try camelCase event handler (#2249)
  props[handlerName = toHandlerKey(camelize(event))];
  if (!handler && isModelListener2) {
    handler = props[handlerName = toHandlerKey(hyphenate(event))];
  }
  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      6,
      args
    );
  }
  const onceHandler = props[handlerName + `Once`];
  if (onceHandler) {
    if (!instance.emitted) {
      instance.emitted = {};
    } else if (instance.emitted[handlerName]) {
      return;
    }
    instance.emitted[handlerName] = true;
    callWithAsyncErrorHandling(
      onceHandler,
      instance,
      6,
      args
    );
  }
}
const mixinEmitsCache = /* @__PURE__ */ new WeakMap();
function normalizeEmitsOptions(comp, appContext, asMixin = false) {
  const cache = asMixin ? mixinEmitsCache : appContext.emitsCache;
  const cached = cache.get(comp);
  if (cached !== void 0) {
    return cached;
  }
  const raw = comp.emits;
  let normalized = {};
  let hasExtends = false;
  if (!isFunction(comp)) {
    const extendEmits = (raw2) => {
      const normalizedFromExtend = normalizeEmitsOptions(raw2, appContext, true);
      if (normalizedFromExtend) {
        hasExtends = true;
        extend(normalized, normalizedFromExtend);
      }
    };
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits);
    }
    if (comp.extends) {
      extendEmits(comp.extends);
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits);
    }
  }
  if (!raw && !hasExtends) {
    if (isObject(comp)) {
      cache.set(comp, null);
    }
    return null;
  }
  if (isArray(raw)) {
    raw.forEach((key) => normalized[key] = null);
  } else {
    extend(normalized, raw);
  }
  if (isObject(comp)) {
    cache.set(comp, normalized);
  }
  return normalized;
}
function isEmitListener(options, key) {
  if (!options || !isOn(key)) {
    return false;
  }
  key = key.slice(2);
  key = key === "Once" ? key : key.replace(/Once$/, "");
  return hasOwn(options, key[0].toLowerCase() + key.slice(1)) || hasOwn(options, hyphenate(key)) || hasOwn(options, key);
}
function markAttrsAccessed() {
}
function renderComponentRoot(instance) {
  const {
    type: Component,
    vnode,
    proxy,
    withProxy,
    propsOptions: [propsOptions],
    slots,
    attrs,
    emit: emit2,
    render,
    renderCache,
    props,
    data,
    setupState,
    ctx,
    inheritAttrs
  } = instance;
  const prev = setCurrentRenderingInstance(instance);
  let result;
  let fallthroughAttrs;
  try {
    if (vnode.shapeFlag & 4) {
      const proxyToUse = withProxy || proxy;
      const thisProxy = false ? new Proxy(proxyToUse, {
        get(target, key, receiver) {
          warn$1(
            `Property '${String(
              key
            )}' was accessed via 'this'. Avoid using 'this' in templates.`
          );
          return Reflect.get(target, key, receiver);
        }
      }) : proxyToUse;
      result = normalizeVNode(
        render.call(
          thisProxy,
          proxyToUse,
          renderCache,
          false ? /* @__PURE__ */ shallowReadonly(props) : props,
          setupState,
          data,
          ctx
        )
      );
      fallthroughAttrs = attrs;
    } else {
      const render2 = Component;
      if (false) ;
      result = normalizeVNode(
        render2.length > 1 ? render2(
          false ? /* @__PURE__ */ shallowReadonly(props) : props,
          false ? {
            get attrs() {
              markAttrsAccessed();
              return /* @__PURE__ */ shallowReadonly(attrs);
            },
            slots,
            emit: emit2
          } : { attrs, slots, emit: emit2 }
        ) : render2(
          false ? /* @__PURE__ */ shallowReadonly(props) : props,
          null
        )
      );
      fallthroughAttrs = Component.props ? attrs : getFunctionalFallthrough(attrs);
    }
  } catch (err) {
    blockStack.length = 0;
    handleError(err, instance, 1);
    result = createVNode(Comment);
  }
  let root = result;
  if (fallthroughAttrs && inheritAttrs !== false) {
    const keys = Object.keys(fallthroughAttrs);
    const { shapeFlag } = root;
    if (keys.length) {
      if (shapeFlag & (1 | 6)) {
        if (propsOptions && keys.some(isModelListener)) {
          fallthroughAttrs = filterModelListeners(
            fallthroughAttrs,
            propsOptions
          );
        }
        root = cloneVNode(root, fallthroughAttrs, false, true);
      }
    }
  }
  if (vnode.dirs) {
    root = cloneVNode(root, null, false, true);
    root.dirs = root.dirs ? root.dirs.concat(vnode.dirs) : vnode.dirs;
  }
  if (vnode.transition) {
    const child = isTeleport(root.type) ? getInnerChild$1(root) || root : root;
    setTransitionHooks(child, vnode.transition);
  }
  {
    result = root;
  }
  setCurrentRenderingInstance(prev);
  return result;
}
function filterSingleRoot(children, recurse = true) {
  let singleRoot;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isVNode(child)) {
      if (child.type !== Comment || child.children === "v-if") {
        if (singleRoot) {
          return;
        } else {
          singleRoot = child;
        }
      }
    } else {
      return;
    }
  }
  return singleRoot;
}
const getFunctionalFallthrough = (attrs) => {
  let res;
  for (const key in attrs) {
    if (key === "class" || key === "style" || isOn(key)) {
      (res || (res = {}))[key] = attrs[key];
    }
  }
  return res;
};
const filterModelListeners = (attrs, props) => {
  const res = {};
  for (const key in attrs) {
    if (!isModelListener(key) || !(key.slice(9) in props)) {
      res[key] = attrs[key];
    }
  }
  return res;
};
function shouldUpdateComponent(prevVNode, nextVNode, optimized) {
  const { props: prevProps, children: prevChildren, component } = prevVNode;
  const { props: nextProps, children: nextChildren, patchFlag } = nextVNode;
  const emits = component.emitsOptions;
  if (nextVNode.dirs || nextVNode.transition) {
    return true;
  }
  if (optimized && patchFlag >= 0) {
    if (patchFlag & 1024) {
      return true;
    }
    if (patchFlag & 16) {
      if (!prevProps) {
        return !!nextProps;
      }
      return hasPropsChanged(prevProps, nextProps, emits);
    } else if (patchFlag & 8) {
      const dynamicProps = nextVNode.dynamicProps;
      for (let i = 0; i < dynamicProps.length; i++) {
        const key = dynamicProps[i];
        if (hasPropValueChanged(nextProps, prevProps, key) && !isEmitListener(emits, key)) {
          return true;
        }
      }
    }
  } else {
    if (prevChildren || nextChildren) {
      if (!nextChildren || !nextChildren.$stable) {
        return true;
      }
    }
    if (prevProps === nextProps) {
      return false;
    }
    if (!prevProps) {
      return !!nextProps;
    }
    if (!nextProps) {
      return true;
    }
    return hasPropsChanged(prevProps, nextProps, emits);
  }
  return false;
}
function hasPropsChanged(prevProps, nextProps, emitsOptions) {
  const nextKeys = Object.keys(nextProps);
  if (nextKeys.length !== Object.keys(prevProps).length) {
    return true;
  }
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i];
    if (!hasOwn(prevProps, key) || hasPropValueChanged(nextProps, prevProps, key) && !isEmitListener(emitsOptions, key)) {
      return true;
    }
  }
  return false;
}
function hasPropValueChanged(nextProps, prevProps, key) {
  const nextProp = nextProps[key];
  const prevProp = prevProps[key];
  if (key === "style" && isObject(nextProp) && isObject(prevProp)) {
    return !looseEqual(nextProp, prevProp);
  }
  return nextProp !== prevProp;
}
function updateHOCHostEl({ vnode, parent, suspense }, el) {
  while (parent) {
    const root = parent.subTree;
    if (root.suspense && root.suspense.activeBranch === vnode) {
      root.suspense.vnode.el = root.el = el;
      vnode = root;
    }
    if (root === vnode) {
      (vnode = parent.vnode).el = el;
      parent = parent.parent;
    } else {
      break;
    }
  }
  if (suspense && suspense.activeBranch === vnode) {
    suspense.vnode.el = el;
  }
}
const internalObjectProto = {};
const createInternalObject = () => Object.create(internalObjectProto);
const isInternalObject = (obj) => Object.getPrototypeOf(obj) === internalObjectProto;
function initProps(instance, rawProps, isStateful, isSSR = false) {
  const props = {};
  const attrs = createInternalObject();
  instance.propsDefaults = /* @__PURE__ */ Object.create(null);
  setFullProps(instance, rawProps, props, attrs);
  for (const key in instance.propsOptions[0]) {
    if (!(key in props)) {
      props[key] = void 0;
    }
  }
  if (isStateful) {
    instance.props = isSSR ? props : /* @__PURE__ */ shallowReactive(props);
  } else {
    if (!instance.type.props) {
      instance.props = attrs;
    } else {
      instance.props = props;
    }
  }
  instance.attrs = attrs;
}
function updateProps(instance, rawProps, rawPrevProps, optimized) {
  const {
    props,
    attrs,
    vnode: { patchFlag }
  } = instance;
  const rawCurrentProps = /* @__PURE__ */ toRaw(props);
  const [options] = instance.propsOptions;
  let hasAttrsChanged = false;
  if (
    // always force full diff in dev
    // - #1942 if hmr is enabled with sfc component
    // - vite#872 non-sfc component used by sfc component
    (optimized || patchFlag > 0) && !(patchFlag & 16)
  ) {
    if (patchFlag & 8) {
      const propsToUpdate = instance.vnode.dynamicProps;
      for (let i = 0; i < propsToUpdate.length; i++) {
        let key = propsToUpdate[i];
        if (isEmitListener(instance.emitsOptions, key)) {
          continue;
        }
        const value = rawProps[key];
        if (options) {
          if (hasOwn(attrs, key)) {
            if (value !== attrs[key]) {
              attrs[key] = value;
              hasAttrsChanged = true;
            }
          } else {
            const camelizedKey = camelize(key);
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value,
              instance,
              false
            );
          }
        } else {
          if (value !== attrs[key]) {
            attrs[key] = value;
            hasAttrsChanged = true;
          }
        }
      }
    }
  } else {
    if (setFullProps(instance, rawProps, props, attrs)) {
      hasAttrsChanged = true;
    }
    let kebabKey;
    for (const key in rawCurrentProps) {
      if (!rawProps || // for camelCase
      !hasOwn(rawProps, key) && // it's possible the original props was passed in as kebab-case
      // and converted to camelCase (#955)
      ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey))) {
        if (options) {
          if (rawPrevProps && // for camelCase
          (rawPrevProps[key] !== void 0 || // for kebab-case
          rawPrevProps[kebabKey] !== void 0)) {
            props[key] = resolvePropValue(
              options,
              rawCurrentProps,
              key,
              void 0,
              instance,
              true
            );
          }
        } else {
          delete props[key];
        }
      }
    }
    if (attrs !== rawCurrentProps) {
      for (const key in attrs) {
        if (!rawProps || !hasOwn(rawProps, key) && true) {
          delete attrs[key];
          hasAttrsChanged = true;
        }
      }
    }
  }
  if (hasAttrsChanged) {
    trigger(instance.attrs, "set", "");
  }
}
function setFullProps(instance, rawProps, props, attrs) {
  const [options, needCastKeys] = instance.propsOptions;
  let hasAttrsChanged = false;
  let rawCastValues;
  if (rawProps) {
    for (let key in rawProps) {
      if (isReservedProp(key)) {
        continue;
      }
      const value = rawProps[key];
      let camelKey;
      if (options && hasOwn(options, camelKey = camelize(key))) {
        if (!needCastKeys || !needCastKeys.includes(camelKey)) {
          props[camelKey] = value;
        } else {
          (rawCastValues || (rawCastValues = {}))[camelKey] = value;
        }
      } else if (!isEmitListener(instance.emitsOptions, key)) {
        if (!(key in attrs) || value !== attrs[key]) {
          attrs[key] = value;
          hasAttrsChanged = true;
        }
      }
    }
  }
  if (needCastKeys) {
    const rawCurrentProps = /* @__PURE__ */ toRaw(props);
    const castValues = rawCastValues || EMPTY_OBJ;
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i];
      props[key] = resolvePropValue(
        options,
        rawCurrentProps,
        key,
        castValues[key],
        instance,
        !hasOwn(castValues, key)
      );
    }
  }
  return hasAttrsChanged;
}
function resolvePropValue(options, props, key, value, instance, isAbsent) {
  const opt = options[key];
  if (opt != null) {
    const hasDefault = hasOwn(opt, "default");
    if (hasDefault && value === void 0) {
      const defaultValue = opt.default;
      if (opt.type !== Function && !opt.skipFactory && isFunction(defaultValue)) {
        const { propsDefaults } = instance;
        if (key in propsDefaults) {
          value = propsDefaults[key];
        } else {
          const reset = setCurrentInstance(instance);
          value = propsDefaults[key] = defaultValue.call(
            null,
            props
          );
          reset();
        }
      } else {
        value = defaultValue;
      }
      if (instance.ce) {
        instance.ce._setProp(key, value);
      }
    }
    if (opt[
      0
      /* shouldCast */
    ]) {
      if (isAbsent && !hasDefault) {
        value = false;
      } else if (opt[
        1
        /* shouldCastTrue */
      ] && (value === "" || value === hyphenate(key))) {
        value = true;
      }
    }
  }
  return value;
}
const mixinPropsCache = /* @__PURE__ */ new WeakMap();
function normalizePropsOptions(comp, appContext, asMixin = false) {
  const cache = asMixin ? mixinPropsCache : appContext.propsCache;
  const cached = cache.get(comp);
  if (cached) {
    return cached;
  }
  const raw = comp.props;
  const normalized = {};
  const needCastKeys = [];
  let hasExtends = false;
  if (!isFunction(comp)) {
    const extendProps = (raw2) => {
      hasExtends = true;
      const [props, keys] = normalizePropsOptions(raw2, appContext, true);
      extend(normalized, props);
      if (keys) needCastKeys.push(...keys);
    };
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendProps);
    }
    if (comp.extends) {
      extendProps(comp.extends);
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendProps);
    }
  }
  if (!raw && !hasExtends) {
    if (isObject(comp)) {
      cache.set(comp, EMPTY_ARR);
    }
    return EMPTY_ARR;
  }
  if (isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const normalizedKey = camelize(raw[i]);
      if (validatePropName(normalizedKey)) {
        normalized[normalizedKey] = EMPTY_OBJ;
      }
    }
  } else if (raw) {
    for (const key in raw) {
      const normalizedKey = camelize(key);
      if (validatePropName(normalizedKey)) {
        const opt = raw[key];
        const prop = normalized[normalizedKey] = isArray(opt) || isFunction(opt) ? { type: opt } : extend({}, opt);
        const propType = prop.type;
        let shouldCast = false;
        let shouldCastTrue = true;
        if (isArray(propType)) {
          for (let index = 0; index < propType.length; ++index) {
            const type = propType[index];
            const typeName = isFunction(type) && type.name;
            if (typeName === "Boolean") {
              shouldCast = true;
              break;
            } else if (typeName === "String") {
              shouldCastTrue = false;
            }
          }
        } else {
          shouldCast = isFunction(propType) && propType.name === "Boolean";
        }
        prop[
          0
          /* shouldCast */
        ] = shouldCast;
        prop[
          1
          /* shouldCastTrue */
        ] = shouldCastTrue;
        if (shouldCast || hasOwn(prop, "default")) {
          needCastKeys.push(normalizedKey);
        }
      }
    }
  }
  const res = [normalized, needCastKeys];
  if (isObject(comp)) {
    cache.set(comp, res);
  }
  return res;
}
function validatePropName(key) {
  if (key[0] !== "$" && !isReservedProp(key)) {
    return true;
  }
  return false;
}
const isInternalKey = (key) => key === "_" || key === "_ctx" || key === "$stable";
const normalizeSlotValue = (value) => isArray(value) ? value.map(normalizeVNode) : [normalizeVNode(value)];
const normalizeSlot = (key, rawSlot, ctx) => {
  if (rawSlot._n) {
    return rawSlot;
  }
  const normalized = withCtx((...args) => {
    if (false) ;
    return normalizeSlotValue(rawSlot(...args));
  }, ctx);
  normalized._c = false;
  return normalized;
};
const normalizeObjectSlots = (rawSlots, slots, instance) => {
  const ctx = rawSlots._ctx;
  for (const key in rawSlots) {
    if (isInternalKey(key)) continue;
    const value = rawSlots[key];
    if (isFunction(value)) {
      slots[key] = normalizeSlot(key, value, ctx);
    } else if (value != null) {
      const normalized = normalizeSlotValue(value);
      slots[key] = () => normalized;
    }
  }
};
const normalizeVNodeSlots = (instance, children) => {
  const normalized = normalizeSlotValue(children);
  instance.slots.default = () => normalized;
};
const assignSlots = (slots, children, optimized) => {
  for (const key in children) {
    if (optimized || !isInternalKey(key)) {
      slots[key] = children[key];
    }
  }
};
const initSlots = (instance, children, optimized) => {
  const slots = instance.slots = createInternalObject();
  if (instance.vnode.shapeFlag & 32) {
    const type = children._;
    if (type) {
      assignSlots(slots, children, optimized);
      if (optimized) {
        def(slots, "_", type, true);
      }
    } else {
      normalizeObjectSlots(children, slots);
    }
  } else if (children) {
    normalizeVNodeSlots(instance, children);
  }
};
const updateSlots = (instance, children, optimized) => {
  const { vnode, slots } = instance;
  let needDeletionCheck = true;
  let deletionComparisonTarget = EMPTY_OBJ;
  if (vnode.shapeFlag & 32) {
    const type = children._;
    if (type) {
      if (optimized && type === 1) {
        needDeletionCheck = false;
      } else {
        assignSlots(slots, children, optimized);
      }
    } else {
      needDeletionCheck = !children.$stable;
      normalizeObjectSlots(children, slots);
    }
    deletionComparisonTarget = children;
  } else if (children) {
    normalizeVNodeSlots(instance, children);
    deletionComparisonTarget = { default: 1 };
  }
  if (needDeletionCheck) {
    for (const key in slots) {
      if (!isInternalKey(key) && deletionComparisonTarget[key] == null) {
        delete slots[key];
      }
    }
  }
};
const queuePostRenderEffect = queueEffectWithSuspense;
function createRenderer(options) {
  return baseCreateRenderer(options);
}
function baseCreateRenderer(options, createHydrationFns) {
  const target = getGlobalThis();
  target.__VUE__ = true;
  const {
    insert: hostInsert,
    remove: hostRemove,
    patchProp: hostPatchProp,
    createElement: hostCreateElement,
    createText: hostCreateText,
    createComment: hostCreateComment,
    setText: hostSetText,
    setElementText: hostSetElementText,
    parentNode: hostParentNode,
    nextSibling: hostNextSibling,
    setScopeId: hostSetScopeId = NOOP,
    insertStaticContent: hostInsertStaticContent
  } = options;
  const patch = (n1, n2, container, anchor = null, parentComponent = null, parentSuspense = null, namespace = void 0, slotScopeIds = null, optimized = !!n2.dynamicChildren) => {
    if (n1 === n2) {
      return;
    }
    if (n1 && !isSameVNodeType(n1, n2)) {
      anchor = getNextHostNode(n1);
      unmount(n1, parentComponent, parentSuspense, true);
      n1 = null;
    }
    if (n2.patchFlag === -2) {
      optimized = false;
      n2.dynamicChildren = null;
    }
    if (n2.dynamicChildren && n1 && n1.dynamicChildren && n1.dynamicChildren.hasOnce) {
      if (n2.dynamicChildren === EMPTY_ARR) {
        n2.dynamicChildren = [];
      }
      n2.dynamicChildren.hasOnce = true;
    }
    const { type, ref: ref3, shapeFlag } = n2;
    switch (type) {
      case Text:
        processText(n1, n2, container, anchor);
        break;
      case Comment:
        processCommentNode(n1, n2, container, anchor);
        break;
      case Static:
        if (n1 == null) {
          mountStaticNode(n2, container, anchor, namespace);
        }
        break;
      case Fragment:
        processFragment(
          n1,
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        break;
      default:
        if (shapeFlag & 1) {
          processElement(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (shapeFlag & 6) {
          processComponent(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (shapeFlag & 64) {
          type.process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals
          );
        } else if (shapeFlag & 128) {
          type.process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals
          );
        } else ;
    }
    if (ref3 != null && parentComponent) {
      setRef(ref3, n1 && n1.ref, parentSuspense, n2 || n1, !n2);
    } else if (ref3 == null && n1 && n1.ref != null) {
      setRef(n1.ref, null, parentSuspense, n1, true);
    }
  };
  const processText = (n1, n2, container, anchor) => {
    if (n1 == null) {
      hostInsert(
        n2.el = hostCreateText(n2.children),
        container,
        anchor
      );
    } else {
      const el = n2.el = n1.el;
      if (n2.children !== n1.children) {
        hostSetText(el, n2.children);
      }
    }
  };
  const processCommentNode = (n1, n2, container, anchor) => {
    if (n1 == null) {
      hostInsert(
        n2.el = hostCreateComment(n2.children || ""),
        container,
        anchor
      );
    } else {
      n2.el = n1.el;
    }
  };
  const mountStaticNode = (n2, container, anchor, namespace) => {
    [n2.el, n2.anchor] = hostInsertStaticContent(
      n2.children,
      container,
      anchor,
      namespace,
      n2.el,
      n2.anchor
    );
  };
  const moveStaticNode = ({ el, anchor }, container, nextSibling) => {
    let next;
    while (el && el !== anchor) {
      next = hostNextSibling(el);
      hostInsert(el, container, nextSibling);
      el = next;
    }
    hostInsert(anchor, container, nextSibling);
  };
  const removeStaticNode = ({ el, anchor }) => {
    let next;
    while (el && el !== anchor) {
      next = hostNextSibling(el);
      hostRemove(el);
      el = next;
    }
    hostRemove(anchor);
  };
  const processElement = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    if (n2.type === "svg") {
      namespace = "svg";
    } else if (n2.type === "math") {
      namespace = "mathml";
    }
    if (n1 == null) {
      mountElement(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    } else {
      const customElement = n1.el && n1.el._isVueCE ? n1.el : null;
      try {
        if (customElement) {
          customElement._beginPatch();
        }
        patchElement(
          n1,
          n2,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } finally {
        if (customElement) {
          customElement._endPatch();
        }
      }
    }
  };
  const mountElement = (vnode, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    let el;
    let vnodeHook;
    const { props, shapeFlag, transition, dirs } = vnode;
    el = vnode.el = hostCreateElement(
      vnode.type,
      namespace,
      props && props.is,
      props
    );
    if (shapeFlag & 8) {
      hostSetElementText(el, vnode.children);
    } else if (shapeFlag & 16) {
      mountChildren(
        vnode.children,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(vnode, namespace),
        slotScopeIds,
        optimized
      );
    }
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, "created");
    }
    setScopeId(el, vnode, vnode.scopeId, slotScopeIds, parentComponent);
    if (props) {
      for (const key in props) {
        if (key !== "value" && !isReservedProp(key)) {
          hostPatchProp(el, key, null, props[key], namespace, parentComponent);
        }
      }
      if ("value" in props) {
        hostPatchProp(el, "value", null, props.value, namespace);
      }
      if (vnodeHook = props.onVnodeBeforeMount) {
        invokeVNodeHook(vnodeHook, parentComponent, vnode);
      }
    }
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, "beforeMount");
    }
    const needCallTransitionHooks = needTransition(parentSuspense, transition);
    if (needCallTransitionHooks) {
      transition.beforeEnter(el);
    }
    hostInsert(el, container, anchor);
    if ((vnodeHook = props && props.onVnodeMounted) || needCallTransitionHooks || dirs) {
      queuePostRenderEffect(() => {
        try {
          vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
          needCallTransitionHooks && transition.enter(el);
          dirs && invokeDirectiveHook(vnode, null, parentComponent, "mounted");
        } finally {
        }
      }, parentSuspense);
    }
  };
  const setScopeId = (el, vnode, scopeId, slotScopeIds, parentComponent) => {
    if (scopeId) {
      hostSetScopeId(el, scopeId);
    }
    if (slotScopeIds) {
      for (let i = 0; i < slotScopeIds.length; i++) {
        hostSetScopeId(el, slotScopeIds[i]);
      }
    }
    if (parentComponent) {
      let subTree = parentComponent.subTree;
      if (vnode === subTree || isSuspense(subTree.type) && (subTree.ssContent === vnode || subTree.ssFallback === vnode)) {
        const parentVNode = parentComponent.vnode;
        setScopeId(
          el,
          parentVNode,
          parentVNode.scopeId,
          parentVNode.slotScopeIds,
          parentComponent.parent
        );
      }
    }
  };
  const mountChildren = (children, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized, start = 0) => {
    for (let i = start; i < children.length; i++) {
      const child = children[i] = optimized ? cloneIfMounted(children[i]) : normalizeVNode(children[i]);
      patch(
        null,
        child,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    }
  };
  const patchElement = (n1, n2, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    const el = n2.el = n1.el;
    let { patchFlag, dynamicChildren, dirs } = n2;
    patchFlag |= n1.patchFlag & 16;
    const oldProps = n1.props || EMPTY_OBJ;
    const newProps = n2.props || EMPTY_OBJ;
    let vnodeHook;
    parentComponent && toggleRecurse(parentComponent, false);
    if (vnodeHook = newProps.onVnodeBeforeUpdate) {
      invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
    }
    if (dirs) {
      invokeDirectiveHook(n2, n1, parentComponent, "beforeUpdate");
    }
    parentComponent && toggleRecurse(parentComponent, true);
    if (
      // #6385 the old vnode may be a user-wrapped non-isomorphic block
      // Force full diff when block metadata is unstable.
      dynamicChildren && (!n1.dynamicChildren || n1.dynamicChildren.length !== dynamicChildren.length)
    ) {
      patchFlag = 0;
      optimized = false;
      dynamicChildren = null;
    }
    if (oldProps.innerHTML && newProps.innerHTML == null || oldProps.textContent && newProps.textContent == null) {
      hostSetElementText(el, "");
    }
    if (dynamicChildren) {
      patchBlockChildren(
        n1.dynamicChildren,
        dynamicChildren,
        el,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds
      );
    } else if (!optimized) {
      patchChildren(
        n1,
        n2,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds,
        false
      );
    }
    if (patchFlag > 0) {
      if (patchFlag & 16) {
        patchProps(el, oldProps, newProps, parentComponent, namespace);
      } else {
        if (patchFlag & 2) {
          if (oldProps.class !== newProps.class) {
            hostPatchProp(el, "class", null, newProps.class, namespace);
          }
        }
        if (patchFlag & 4) {
          hostPatchProp(el, "style", oldProps.style, newProps.style, namespace);
        }
        if (patchFlag & 8) {
          const propsToUpdate = n2.dynamicProps;
          for (let i = 0; i < propsToUpdate.length; i++) {
            const key = propsToUpdate[i];
            const prev = oldProps[key];
            const next = newProps[key];
            if (next !== prev || key === "value") {
              hostPatchProp(el, key, prev, next, namespace, parentComponent);
            }
          }
        }
      }
      if (patchFlag & 1) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children);
        }
      }
    } else if (!optimized && dynamicChildren == null) {
      patchProps(el, oldProps, newProps, parentComponent, namespace);
    }
    if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
        dirs && invokeDirectiveHook(n2, n1, parentComponent, "updated");
      }, parentSuspense);
    }
  };
  const patchBlockChildren = (oldChildren, newChildren, fallbackContainer, parentComponent, parentSuspense, namespace, slotScopeIds) => {
    for (let i = 0; i < newChildren.length; i++) {
      const oldVNode = oldChildren[i];
      const newVNode = newChildren[i];
      const oldEl = oldVNode.el || resolveAsyncComponentPlaceholder(oldVNode);
      const container = (
        // oldVNode may be an errored async setup() component inside Suspense
        // which will not have a mounted element
        oldEl && // - In the case of a Fragment, we need to provide the actual parent
        // of the Fragment itself so it can move its children.
        (oldVNode.type === Fragment || // - In the case of different nodes, there is going to be a replacement
        // which also requires the correct parent container
        !isSameVNodeType(oldVNode, newVNode) || // - In the case of a component, it could contain anything.
        oldVNode.shapeFlag & (6 | 64 | 128)) ? hostParentNode(oldEl) : (
          // In other cases, the parent container is not actually used so we
          // just pass the block element here to avoid a DOM parentNode call.
          fallbackContainer
        )
      );
      patch(
        oldVNode,
        newVNode,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        true
      );
    }
  };
  const patchProps = (el, oldProps, newProps, parentComponent, namespace) => {
    if (oldProps !== newProps) {
      if (oldProps !== EMPTY_OBJ) {
        for (const key in oldProps) {
          if (!isReservedProp(key) && !(key in newProps)) {
            hostPatchProp(
              el,
              key,
              oldProps[key],
              null,
              namespace,
              parentComponent
            );
          }
        }
      }
      for (const key in newProps) {
        if (isReservedProp(key)) continue;
        const next = newProps[key];
        const prev = oldProps[key];
        if (next !== prev && key !== "value") {
          hostPatchProp(el, key, prev, next, namespace, parentComponent);
        }
      }
      if ("value" in newProps) {
        hostPatchProp(el, "value", oldProps.value, newProps.value, namespace);
      }
    }
  };
  const processFragment = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    const fragmentStartAnchor = n2.el = n1 ? n1.el : hostCreateText("");
    const fragmentEndAnchor = n2.anchor = n1 ? n1.anchor : hostCreateText("");
    let { patchFlag, dynamicChildren, slotScopeIds: fragmentSlotScopeIds } = n2;
    if (fragmentSlotScopeIds) {
      slotScopeIds = slotScopeIds ? slotScopeIds.concat(fragmentSlotScopeIds) : fragmentSlotScopeIds;
    }
    if (n1 == null) {
      hostInsert(fragmentStartAnchor, container, anchor);
      hostInsert(fragmentEndAnchor, container, anchor);
      mountChildren(
        // #10007
        // such fragment like `<></>` will be compiled into
        // a fragment which doesn't have a children.
        // In this case fallback to an empty array
        n2.children || [],
        container,
        fragmentEndAnchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    } else {
      if (patchFlag > 0 && patchFlag & 64 && dynamicChildren && // #2715 the previous fragment could've been a BAILed one as a result
      // of renderSlot() with no valid children
      n1.dynamicChildren && n1.dynamicChildren.length === dynamicChildren.length) {
        patchBlockChildren(
          n1.dynamicChildren,
          dynamicChildren,
          container,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds
        );
        if (
          // #2080 if the stable fragment has a key, it's a <template v-for> that may
          //  get moved around. Make sure all root level vnodes inherit el.
          // #2134 or if it's a component root, it may also get moved around
          // as the component is being moved.
          n2.key != null || parentComponent && n2 === parentComponent.subTree
        ) {
          traverseStaticChildren(
            n1,
            n2,
            true
            /* shallow */
          );
        }
      } else {
        patchChildren(
          n1,
          n2,
          container,
          fragmentEndAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      }
    }
  };
  const processComponent = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    n2.slotScopeIds = slotScopeIds;
    if (n1 == null) {
      if (n2.shapeFlag & 512) {
        parentComponent.ctx.activate(
          n2,
          container,
          anchor,
          namespace,
          optimized
        );
      } else {
        mountComponent(
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          optimized
        );
      }
    } else {
      updateComponent(n1, n2, optimized);
    }
  };
  const mountComponent = (initialVNode, container, anchor, parentComponent, parentSuspense, namespace, optimized) => {
    const instance = initialVNode.component = createComponentInstance(
      initialVNode,
      parentComponent,
      parentSuspense
    );
    if (isKeepAlive(initialVNode)) {
      instance.ctx.renderer = internals;
    }
    {
      setupComponent(instance, false, optimized);
    }
    if (instance.asyncDep) {
      parentSuspense && parentSuspense.registerDep(
        instance,
        setupRenderEffect,
        optimized,
        namespace
      );
      if (!initialVNode.el) {
        const placeholder = instance.subTree = createVNode(Comment);
        processCommentNode(null, placeholder, container, anchor);
        initialVNode.placeholder = placeholder.el;
      }
    } else {
      setupRenderEffect(
        instance,
        initialVNode,
        container,
        anchor,
        parentSuspense,
        namespace,
        optimized
      );
    }
  };
  const updateComponent = (n1, n2, optimized) => {
    const instance = n2.component = n1.component;
    if (shouldUpdateComponent(n1, n2, optimized)) {
      if (instance.asyncDep && !instance.asyncResolved) {
        n2.el = n1.el;
        n2.placeholder = n1.placeholder;
        updateComponentPreRender(instance, n2, optimized);
        return;
      } else {
        instance.next = n2;
        instance.update();
      }
    } else {
      n2.el = n1.el;
      n2.placeholder = n1.placeholder;
      instance.vnode = n2;
    }
  };
  const setupRenderEffect = (instance, initialVNode, container, anchor, parentSuspense, namespace, optimized) => {
    const componentUpdateFn = () => {
      if (!instance.isMounted) {
        let vnodeHook;
        const { el, props } = initialVNode;
        const { bm, m, parent, root, type } = instance;
        const isAsyncWrapperVNode = isAsyncWrapper(initialVNode);
        toggleRecurse(instance, false);
        if (bm) {
          invokeArrayFns(bm);
        }
        if (!isAsyncWrapperVNode && (vnodeHook = props && props.onVnodeBeforeMount)) {
          invokeVNodeHook(vnodeHook, parent, initialVNode);
        }
        toggleRecurse(instance, true);
        {
          if (root.ce && root.ce._hasShadowRoot()) {
            root.ce._injectChildStyle(
              type,
              instance.parent ? instance.parent.type : void 0
            );
          }
          const subTree = instance.subTree = renderComponentRoot(instance);
          patch(
            null,
            subTree,
            container,
            anchor,
            instance,
            parentSuspense,
            namespace
          );
          initialVNode.el = subTree.el;
        }
        if (m) {
          queuePostRenderEffect(m, parentSuspense);
        }
        if (!isAsyncWrapperVNode && (vnodeHook = props && props.onVnodeMounted)) {
          const scopedInitialVNode = initialVNode;
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook, parent, scopedInitialVNode),
            parentSuspense
          );
        }
        if (initialVNode.shapeFlag & 256 || parent && isAsyncWrapper(parent.vnode) && parent.vnode.shapeFlag & 256) {
          instance.a && queuePostRenderEffect(instance.a, parentSuspense);
        }
        instance.isMounted = true;
        initialVNode = container = anchor = null;
      } else {
        let { next, bu, u, parent, vnode } = instance;
        {
          const nonHydratedAsyncRoot = locateNonHydratedAsyncRoot(instance);
          if (nonHydratedAsyncRoot) {
            if (next) {
              next.el = vnode.el;
              updateComponentPreRender(instance, next, optimized);
            }
            nonHydratedAsyncRoot.asyncDep.then(() => {
              queuePostRenderEffect(() => {
                if (!instance.isUnmounted) update();
              }, parentSuspense);
            });
            return;
          }
        }
        let originNext = next;
        let vnodeHook;
        toggleRecurse(instance, false);
        if (next) {
          next.el = vnode.el;
          updateComponentPreRender(instance, next, optimized);
        } else {
          next = vnode;
        }
        if (bu) {
          invokeArrayFns(bu);
        }
        if (vnodeHook = next.props && next.props.onVnodeBeforeUpdate) {
          invokeVNodeHook(vnodeHook, parent, next, vnode);
        }
        toggleRecurse(instance, true);
        const nextTree = renderComponentRoot(instance);
        const prevTree = instance.subTree;
        instance.subTree = nextTree;
        patch(
          prevTree,
          nextTree,
          // parent may have changed if it's in a teleport
          hostParentNode(prevTree.el),
          // anchor may have changed if it's in a fragment
          getNextHostNode(prevTree),
          instance,
          parentSuspense,
          namespace
        );
        next.el = nextTree.el;
        if (originNext === null) {
          updateHOCHostEl(instance, nextTree.el);
        }
        if (u) {
          queuePostRenderEffect(u, parentSuspense);
        }
        if (vnodeHook = next.props && next.props.onVnodeUpdated) {
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook, parent, next, vnode),
            parentSuspense
          );
        }
      }
    };
    instance.scope.on();
    const effect2 = instance.effect = new ReactiveEffect(componentUpdateFn);
    instance.scope.off();
    const update = instance.update = effect2.run.bind(effect2);
    const job = instance.job = effect2.runIfDirty.bind(effect2);
    job.i = instance;
    job.id = instance.uid;
    effect2.scheduler = () => queueJob(job);
    toggleRecurse(instance, true);
    update();
  };
  const updateComponentPreRender = (instance, nextVNode, optimized) => {
    nextVNode.component = instance;
    const prevProps = instance.vnode.props;
    instance.vnode = nextVNode;
    instance.next = null;
    updateProps(instance, nextVNode.props, prevProps, optimized);
    updateSlots(instance, nextVNode.children, optimized);
    pauseTracking();
    flushPreFlushCbs(instance);
    resetTracking();
  };
  const patchChildren = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized = false) => {
    const c1 = n1 && n1.children;
    const prevShapeFlag = n1 ? n1.shapeFlag : 0;
    const c2 = n2.children;
    const { patchFlag, shapeFlag } = n2;
    if (patchFlag > 0) {
      if (patchFlag & 128) {
        patchKeyedChildren(
          c1,
          c2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        return;
      } else if (patchFlag & 256) {
        patchUnkeyedChildren(
          c1,
          c2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        return;
      }
    }
    if (shapeFlag & 8) {
      if (prevShapeFlag & 16) {
        unmountChildren(c1, parentComponent, parentSuspense);
      }
      if (c2 !== c1) {
        hostSetElementText(container, c2);
      }
    } else {
      if (prevShapeFlag & 16) {
        if (shapeFlag & 16) {
          patchKeyedChildren(
            c1,
            c2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else {
          unmountChildren(c1, parentComponent, parentSuspense, true);
        }
      } else {
        if (prevShapeFlag & 8) {
          hostSetElementText(container, "");
        }
        if (shapeFlag & 16) {
          mountChildren(
            c2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        }
      }
    }
  };
  const patchUnkeyedChildren = (c1, c2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    c1 = c1 || EMPTY_ARR;
    c2 = c2 || EMPTY_ARR;
    const oldLength = c1.length;
    const newLength = c2.length;
    const commonLength = Math.min(oldLength, newLength);
    let i;
    for (i = 0; i < commonLength; i++) {
      const nextChild = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
      patch(
        c1[i],
        nextChild,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    }
    if (oldLength > newLength) {
      unmountChildren(
        c1,
        parentComponent,
        parentSuspense,
        true,
        false,
        commonLength
      );
    } else {
      mountChildren(
        c2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
        commonLength
      );
    }
  };
  const patchKeyedChildren = (c1, c2, container, parentAnchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    let i = 0;
    const l2 = c2.length;
    let e1 = c1.length - 1;
    let e2 = l2 - 1;
    while (i <= e1 && i <= e2) {
      const n1 = c1[i];
      const n2 = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } else {
        break;
      }
      i++;
    }
    while (i <= e1 && i <= e2) {
      const n1 = c1[e1];
      const n2 = c2[e2] = optimized ? cloneIfMounted(c2[e2]) : normalizeVNode(c2[e2]);
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } else {
        break;
      }
      e1--;
      e2--;
    }
    if (i > e1) {
      if (i <= e2) {
        const nextPos = e2 + 1;
        const anchor = nextPos < l2 ? c2[nextPos].el : parentAnchor;
        while (i <= e2) {
          patch(
            null,
            c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]),
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
          i++;
        }
      }
    } else if (i > e2) {
      while (i <= e1) {
        unmount(c1[i], parentComponent, parentSuspense, true);
        i++;
      }
    } else {
      const s1 = i;
      const s2 = i;
      const keyToNewIndexMap = /* @__PURE__ */ new Map();
      for (i = s2; i <= e2; i++) {
        const nextChild = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
        if (nextChild.key != null) {
          keyToNewIndexMap.set(nextChild.key, i);
        }
      }
      let j;
      let patched = 0;
      const toBePatched = e2 - s2 + 1;
      let moved = false;
      let maxNewIndexSoFar = 0;
      const newIndexToOldIndexMap = new Array(toBePatched);
      for (i = 0; i < toBePatched; i++) newIndexToOldIndexMap[i] = 0;
      for (i = s1; i <= e1; i++) {
        const prevChild = c1[i];
        if (patched >= toBePatched) {
          unmount(prevChild, parentComponent, parentSuspense, true);
          continue;
        }
        let newIndex;
        if (prevChild.key != null) {
          newIndex = keyToNewIndexMap.get(prevChild.key);
        } else {
          for (j = s2; j <= e2; j++) {
            if (newIndexToOldIndexMap[j - s2] === 0 && isSameVNodeType(prevChild, c2[j])) {
              newIndex = j;
              break;
            }
          }
        }
        if (newIndex === void 0) {
          unmount(prevChild, parentComponent, parentSuspense, true);
        } else {
          newIndexToOldIndexMap[newIndex - s2] = i + 1;
          if (newIndex >= maxNewIndexSoFar) {
            maxNewIndexSoFar = newIndex;
          } else {
            moved = true;
          }
          patch(
            prevChild,
            c2[newIndex],
            container,
            null,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
          patched++;
        }
      }
      const increasingNewIndexSequence = moved ? getSequence(newIndexToOldIndexMap) : EMPTY_ARR;
      j = increasingNewIndexSequence.length - 1;
      for (i = toBePatched - 1; i >= 0; i--) {
        const nextIndex = s2 + i;
        const nextChild = c2[nextIndex];
        const anchorVNode = c2[nextIndex + 1];
        const anchor = nextIndex + 1 < l2 ? (
          // #13559, #14173 fallback to el placeholder for unresolved async component
          anchorVNode.el || resolveAsyncComponentPlaceholder(anchorVNode)
        ) : parentAnchor;
        if (newIndexToOldIndexMap[i] === 0) {
          patch(
            null,
            nextChild,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (moved) {
          if (j < 0 || i !== increasingNewIndexSequence[j]) {
            move(nextChild, container, anchor, 2);
          } else {
            j--;
          }
        }
      }
    }
  };
  const move = (vnode, container, anchor, moveType, parentSuspense = null) => {
    const { el, type, transition, children, shapeFlag } = vnode;
    if (shapeFlag & 6) {
      move(vnode.component.subTree, container, anchor, moveType);
      return;
    }
    if (shapeFlag & 128) {
      vnode.suspense.move(container, anchor, moveType);
      return;
    }
    if (shapeFlag & 64) {
      type.move(vnode, container, anchor, internals);
      return;
    }
    if (type === Fragment) {
      hostInsert(el, container, anchor);
      for (let i = 0; i < children.length; i++) {
        move(children[i], container, anchor, moveType);
      }
      hostInsert(vnode.anchor, container, anchor);
      return;
    }
    if (type === Static) {
      moveStaticNode(vnode, container, anchor);
      return;
    }
    const needTransition2 = moveType !== 2 && shapeFlag & 1 && transition;
    if (needTransition2) {
      if (moveType === 0) {
        if (transition.persisted && !el[leaveCbKey]) {
          hostInsert(el, container, anchor);
        } else {
          transition.beforeEnter(el);
          hostInsert(el, container, anchor);
          queuePostRenderEffect(() => transition.enter(el), parentSuspense);
        }
      } else {
        const { leave, delayLeave, afterLeave } = transition;
        const remove22 = () => {
          if (vnode.ctx.isUnmounted) {
            hostRemove(el);
          } else {
            hostInsert(el, container, anchor);
          }
        };
        const performLeave = () => {
          const wasLeaving = el._isLeaving || !!el[leaveCbKey];
          if (el._isLeaving) {
            el[leaveCbKey](
              true
              /* cancelled */
            );
          }
          if (transition.persisted && !wasLeaving) {
            remove22();
          } else {
            leave(el, () => {
              remove22();
              afterLeave && afterLeave();
            });
          }
        };
        if (delayLeave) {
          delayLeave(el, remove22, performLeave);
        } else {
          performLeave();
        }
      }
    } else {
      hostInsert(el, container, anchor);
    }
  };
  const unmount = (vnode, parentComponent, parentSuspense, doRemove = false, optimized = false) => {
    const {
      type,
      props,
      ref: ref3,
      children,
      dynamicChildren,
      shapeFlag,
      patchFlag,
      dirs,
      cacheIndex,
      memo
    } = vnode;
    if (patchFlag === -2 || dynamicChildren && dynamicChildren.hasOnce) {
      optimized = false;
    }
    if (ref3 != null) {
      pauseTracking();
      setRef(ref3, null, parentSuspense, vnode, true);
      resetTracking();
    }
    if (cacheIndex != null && (!vnode.ctx || vnode.ctx === parentComponent)) {
      parentComponent.renderCache[cacheIndex] = void 0;
    }
    if (shapeFlag & 256) {
      parentComponent.ctx.deactivate(vnode);
      return;
    }
    const shouldInvokeDirs = shapeFlag & 1 && dirs;
    const shouldInvokeVnodeHook = !isAsyncWrapper(vnode);
    let vnodeHook;
    if (shouldInvokeVnodeHook && (vnodeHook = props && props.onVnodeBeforeUnmount)) {
      invokeVNodeHook(vnodeHook, parentComponent, vnode);
    }
    if (shapeFlag & 6) {
      unmountComponent(vnode.component, parentSuspense, doRemove);
    } else {
      if (shapeFlag & 128) {
        vnode.suspense.unmount(parentSuspense, doRemove);
        return;
      }
      if (shouldInvokeDirs) {
        invokeDirectiveHook(vnode, null, parentComponent, "beforeUnmount");
      }
      if (shapeFlag & 64) {
        vnode.type.remove(
          vnode,
          parentComponent,
          parentSuspense,
          internals,
          doRemove
        );
      } else if (dynamicChildren && // #5154
      // when v-once is used inside a block, setBlockTracking(-1) marks the
      // parent block with hasOnce: true
      // so that it doesn't take the fast path during unmount - otherwise
      // components nested in v-once are never unmounted.
      !dynamicChildren.hasOnce && // #1153: fast path should not be taken for non-stable (v-for) fragments
      (type !== Fragment || patchFlag > 0 && patchFlag & 64)) {
        unmountChildren(
          dynamicChildren,
          parentComponent,
          parentSuspense,
          false,
          true
        );
      } else if (type === Fragment && patchFlag & (128 | 256) || !optimized && shapeFlag & 16) {
        unmountChildren(children, parentComponent, parentSuspense);
      }
      if (doRemove) {
        remove2(vnode);
      }
    }
    const shouldInvalidateMemo = memo != null && cacheIndex == null;
    if (shouldInvokeVnodeHook && (vnodeHook = props && props.onVnodeUnmounted) || shouldInvokeDirs || shouldInvalidateMemo) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
        shouldInvokeDirs && invokeDirectiveHook(vnode, null, parentComponent, "unmounted");
        if (shouldInvalidateMemo) {
          vnode.el = null;
        }
      }, parentSuspense);
    }
  };
  const remove2 = (vnode) => {
    const { type, el, anchor, transition } = vnode;
    const isFragment = type === Fragment;
    if (isFragment && !transition) {
      removeFragment(el, anchor);
      return;
    }
    if (type === Static) {
      removeStaticNode(vnode);
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave();
      }
      return;
    }
    const leavingNode = isFragment ? getTransitionRoot(vnode) : vnode;
    const performRemove = () => {
      if (isFragment) {
        if (hostParentNode(el)) {
          removeFragment(el, anchor);
        }
      } else {
        hostRemove(el);
      }
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave();
      }
    };
    if (leavingNode && leavingNode.shapeFlag & 1 && transition && !transition.persisted) {
      const { leave, delayLeave } = transition;
      const leavingEl = leavingNode.el;
      const performLeave = () => leave(leavingEl, performRemove);
      if (delayLeave) {
        delayLeave(leavingEl, performRemove, performLeave);
      } else {
        performLeave();
      }
    } else {
      performRemove();
    }
  };
  const removeFragment = (cur, end) => {
    let next;
    while (cur !== end) {
      next = hostNextSibling(cur);
      hostRemove(cur);
      cur = next;
    }
    hostRemove(end);
  };
  const unmountComponent = (instance, parentSuspense, doRemove) => {
    const { bum, scope, job, subTree, um, m, a } = instance;
    invalidateMount(m);
    invalidateMount(a);
    if (bum) {
      invokeArrayFns(bum);
    }
    scope.stop();
    if (job) {
      job.flags |= 8;
      unmount(subTree, instance, parentSuspense, doRemove);
    } else if (instance.vnode.el && subTree) {
      subTree.transition = instance.vnode.transition;
      unmount(subTree, instance, parentSuspense, doRemove);
    }
    if (um) {
      queuePostRenderEffect(um, parentSuspense);
    }
    queuePostRenderEffect(() => {
      instance.isUnmounted = true;
    }, parentSuspense);
  };
  const unmountChildren = (children, parentComponent, parentSuspense, doRemove = false, optimized = false, start = 0) => {
    for (let i = start; i < children.length; i++) {
      unmount(children[i], parentComponent, parentSuspense, doRemove, optimized);
    }
  };
  const getNextHostNode = (vnode) => {
    if (vnode.shapeFlag & 6) {
      return getNextHostNode(vnode.component.subTree);
    }
    if (vnode.shapeFlag & 128) {
      return vnode.suspense.next();
    }
    const el = hostNextSibling(vnode.anchor || vnode.el);
    const teleportEnd = el && el[TeleportEndKey];
    return teleportEnd ? hostNextSibling(teleportEnd) : el;
  };
  const render = (vnode, container, namespace) => {
    const minUid = vnode && container._vnode ? void 0 : vnode && vnode.component ? vnode.component.uid : getNextUid();
    flushOnAppMount(() => {
      if (vnode == null) {
        if (container._vnode) {
          unmount(container._vnode, null, null, true);
        }
      } else {
        patch(
          container._vnode || null,
          vnode,
          container,
          null,
          null,
          null,
          namespace
        );
      }
      container._vnode = vnode;
    }, minUid);
  };
  const internals = {
    p: patch,
    um: unmount,
    m: move,
    r: remove2,
    mt: mountComponent,
    mc: mountChildren,
    pc: patchChildren,
    pbc: patchBlockChildren,
    n: getNextHostNode,
    o: options
  };
  let hydrate;
  return {
    render,
    hydrate,
    createApp: createAppAPI(render)
  };
}
function resolveChildrenNamespace({ type, props }, currentNamespace) {
  return currentNamespace === "svg" && type === "foreignObject" || currentNamespace === "mathml" && type === "annotation-xml" && props && props.encoding && props.encoding.includes("html") ? void 0 : currentNamespace;
}
function toggleRecurse({ effect: effect2, job }, allowed) {
  if (allowed) {
    effect2.flags |= 32;
    job.flags |= 4;
  } else {
    effect2.flags &= -33;
    job.flags &= -5;
  }
}
function needTransition(parentSuspense, transition) {
  return (!parentSuspense || parentSuspense && !parentSuspense.pendingBranch) && transition && !transition.persisted;
}
function traverseStaticChildren(n1, n2, shallow = false) {
  const ch1 = n1.children;
  const ch2 = n2.children;
  if (isArray(ch1) && isArray(ch2)) {
    for (let i = 0; i < ch1.length; i++) {
      const c1 = ch1[i];
      let c2 = ch2[i];
      if (c2.shapeFlag & 1 && !c2.dynamicChildren) {
        if (c2.patchFlag <= 0 || c2.patchFlag === 32) {
          c2 = ch2[i] = cloneIfMounted(ch2[i]);
          c2.el = c1.el;
        }
        if (!shallow && c2.patchFlag !== -2)
          traverseStaticChildren(c1, c2);
      }
      if (c2.type === Text) {
        if (c2.patchFlag === -1) {
          c2 = ch2[i] = cloneIfMounted(c2);
        }
        c2.el = c1.el;
      }
      if (c2.type === Comment && !c2.el) {
        c2.el = c1.el;
      }
    }
  }
}
function getSequence(arr) {
  const p2 = arr.slice();
  const result = [0];
  let i, j, u, v, c;
  const len = arr.length;
  for (i = 0; i < len; i++) {
    const arrI = arr[i];
    if (arrI !== 0) {
      j = result[result.length - 1];
      if (arr[j] < arrI) {
        p2[i] = j;
        result.push(i);
        continue;
      }
      u = 0;
      v = result.length - 1;
      while (u < v) {
        c = u + v >> 1;
        if (arr[result[c]] < arrI) {
          u = c + 1;
        } else {
          v = c;
        }
      }
      if (arrI < arr[result[u]]) {
        if (u > 0) {
          p2[i] = result[u - 1];
        }
        result[u] = i;
      }
    }
  }
  u = result.length;
  v = result[u - 1];
  while (u-- > 0) {
    result[u] = v;
    v = p2[v];
  }
  return result;
}
function locateNonHydratedAsyncRoot(instance) {
  const subComponent = instance.subTree.component;
  if (subComponent) {
    if (subComponent.asyncDep && !subComponent.asyncResolved) {
      return subComponent;
    } else {
      return locateNonHydratedAsyncRoot(subComponent);
    }
  }
}
function invalidateMount(hooks) {
  if (hooks) {
    for (let i = 0; i < hooks.length; i++)
      hooks[i].flags |= 8;
  }
}
function resolveAsyncComponentPlaceholder(anchorVnode) {
  if (anchorVnode.placeholder) {
    return anchorVnode.placeholder;
  }
  const instance = anchorVnode.component;
  if (instance) {
    return resolveAsyncComponentPlaceholder(instance.subTree);
  }
  return null;
}
const isSuspense = (type) => type.__isSuspense;
function queueEffectWithSuspense(fn, suspense) {
  if (suspense && suspense.pendingBranch) {
    if (isArray(fn)) {
      suspense.effects.push(...fn);
    } else {
      suspense.effects.push(fn);
    }
  } else {
    queuePostFlushCb(fn);
  }
}
const Fragment = /* @__PURE__ */ Symbol.for("v-fgt");
const Text = /* @__PURE__ */ Symbol.for("v-txt");
const Comment = /* @__PURE__ */ Symbol.for("v-cmt");
const Static = /* @__PURE__ */ Symbol.for("v-stc");
const blockStack = [];
let currentBlock = null;
function openBlock(disableTracking = false) {
  blockStack.push(currentBlock = disableTracking ? null : []);
}
function closeBlock() {
  blockStack.pop();
  currentBlock = blockStack[blockStack.length - 1] || null;
}
let isBlockTreeEnabled = 1;
function setBlockTracking(value, inVOnce = false) {
  isBlockTreeEnabled += value;
  if (value < 0 && currentBlock && inVOnce) {
    currentBlock.hasOnce = true;
  }
}
function setupBlock(vnode) {
  vnode.dynamicChildren = isBlockTreeEnabled > 0 ? currentBlock || EMPTY_ARR : null;
  closeBlock();
  if (isBlockTreeEnabled > 0 && currentBlock) {
    currentBlock.push(vnode);
  }
  return vnode;
}
function createElementBlock(type, props, children, patchFlag, dynamicProps, shapeFlag) {
  return setupBlock(
    createBaseVNode(
      type,
      props,
      children,
      patchFlag,
      dynamicProps,
      shapeFlag,
      true
    )
  );
}
function createBlock(type, props, children, patchFlag, dynamicProps) {
  return setupBlock(
    createVNode(
      type,
      props,
      children,
      patchFlag,
      dynamicProps,
      true
    )
  );
}
function isVNode(value) {
  return value ? value.__v_isVNode === true : false;
}
function isSameVNodeType(n1, n2) {
  return n1.type === n2.type && n1.key === n2.key;
}
const normalizeKey = ({ key }) => key != null ? key : null;
const normalizeRef = ({
  ref: ref3,
  ref_key,
  ref_for
}) => {
  if (typeof ref3 === "number") {
    ref3 = "" + ref3;
  }
  return ref3 != null ? isString(ref3) || /* @__PURE__ */ isRef(ref3) || isFunction(ref3) ? { i: currentRenderingInstance, r: ref3, k: ref_key, f: !!ref_for } : ref3 : null;
};
function createBaseVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, shapeFlag = type === Fragment ? 0 : 1, isBlockNode = false, needFullChildrenNormalization = false) {
  const vnode = {
    __v_isVNode: true,
    __v_skip: true,
    type,
    props,
    key: props && normalizeKey(props),
    ref: props && normalizeRef(props),
    scopeId: currentScopeId,
    slotScopeIds: null,
    children,
    component: null,
    suspense: null,
    ssContent: null,
    ssFallback: null,
    dirs: null,
    transition: null,
    el: null,
    anchor: null,
    target: null,
    targetStart: null,
    targetAnchor: null,
    staticCount: 0,
    shapeFlag,
    patchFlag,
    dynamicProps,
    dynamicChildren: null,
    appContext: null,
    ctx: currentRenderingInstance
  };
  if (needFullChildrenNormalization) {
    normalizeChildren(vnode, children);
    if (shapeFlag & 128) {
      type.normalize(vnode);
    }
  } else if (children) {
    vnode.shapeFlag |= isString(children) ? 8 : 16;
  }
  if (isBlockTreeEnabled > 0 && // avoid a block node from tracking itself
  !isBlockNode && // has current parent block
  currentBlock && // presence of a patch flag indicates this node needs patching on updates.
  // component nodes also should always be patched, because even if the
  // component doesn't need to update, it needs to persist the instance on to
  // the next vnode so that it can be properly unmounted later.
  (vnode.patchFlag > 0 || shapeFlag & 6) && // the EVENTS flag is only for hydration and if it is the only flag, the
  // vnode should not be considered dynamic due to handler caching.
  vnode.patchFlag !== 32) {
    currentBlock.push(vnode);
  }
  return vnode;
}
const createVNode = _createVNode;
function _createVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, isBlockNode = false) {
  if (!type || type === NULL_DYNAMIC_COMPONENT) {
    type = Comment;
  }
  if (isVNode(type)) {
    const cloned = cloneVNode(
      type,
      props,
      true
      /* mergeRef: true */
    );
    if (children) {
      normalizeChildren(cloned, children);
    }
    if (isBlockTreeEnabled > 0 && !isBlockNode && currentBlock) {
      if (cloned.shapeFlag & 6) {
        currentBlock[currentBlock.indexOf(type)] = cloned;
      } else {
        currentBlock.push(cloned);
      }
    }
    cloned.patchFlag = -2;
    return cloned;
  }
  if (isClassComponent(type)) {
    type = type.__vccOpts;
  }
  if (props) {
    props = guardReactiveProps(props);
    let { class: klass, style } = props;
    if (klass && !isString(klass)) {
      props.class = normalizeClass(klass);
    }
    if (isObject(style)) {
      if (/* @__PURE__ */ isProxy(style) && !isArray(style)) {
        style = extend({}, style);
      }
      props.style = normalizeStyle(style);
    }
  }
  const shapeFlag = isString(type) ? 1 : isSuspense(type) ? 128 : isTeleport(type) ? 64 : isObject(type) ? 4 : isFunction(type) ? 2 : 0;
  return createBaseVNode(
    type,
    props,
    children,
    patchFlag,
    dynamicProps,
    shapeFlag,
    isBlockNode,
    true
  );
}
function guardReactiveProps(props) {
  if (!props) return null;
  return /* @__PURE__ */ isProxy(props) || isInternalObject(props) ? extend({}, props) : props;
}
function cloneVNode(vnode, extraProps, mergeRef = false, cloneTransition = false) {
  const { props, ref: ref3, patchFlag, children, transition } = vnode;
  const mergedProps = extraProps ? mergeProps(props || {}, extraProps) : props;
  const cloned = {
    __v_isVNode: true,
    __v_skip: true,
    type: vnode.type,
    props: mergedProps,
    key: mergedProps && normalizeKey(mergedProps),
    ref: extraProps && extraProps.ref ? (
      // #2078 in the case of <component :is="vnode" ref="extra"/>
      // if the vnode itself already has a ref, cloneVNode will need to merge
      // the refs so the single vnode can be set on multiple refs
      mergeRef && ref3 ? isArray(ref3) ? ref3.concat(normalizeRef(extraProps)) : [ref3, normalizeRef(extraProps)] : normalizeRef(extraProps)
    ) : ref3,
    scopeId: vnode.scopeId,
    slotScopeIds: vnode.slotScopeIds,
    children,
    target: vnode.target,
    targetStart: vnode.targetStart,
    targetAnchor: vnode.targetAnchor,
    staticCount: vnode.staticCount,
    shapeFlag: vnode.shapeFlag,
    // if the vnode is cloned with extra props, we can no longer assume its
    // existing patch flag to be reliable and need to add the FULL_PROPS flag.
    // note: preserve flag for fragments since they use the flag for children
    // fast paths only.
    patchFlag: extraProps && vnode.type !== Fragment ? patchFlag === -1 ? 16 : patchFlag | 16 : patchFlag,
    dynamicProps: vnode.dynamicProps,
    dynamicChildren: vnode.dynamicChildren,
    appContext: vnode.appContext,
    dirs: vnode.dirs,
    transition,
    // These should technically only be non-null on mounted VNodes. However,
    // they *should* be copied for kept-alive vnodes. So we just always copy
    // them since them being non-null during a mount doesn't affect the logic as
    // they will simply be overwritten.
    component: vnode.component,
    suspense: vnode.suspense,
    ssContent: vnode.ssContent && cloneVNode(vnode.ssContent),
    ssFallback: vnode.ssFallback && cloneVNode(vnode.ssFallback),
    placeholder: vnode.placeholder,
    el: vnode.el,
    anchor: vnode.anchor,
    ctx: vnode.ctx,
    ce: vnode.ce,
    cacheIndex: vnode.cacheIndex
  };
  if (transition && cloneTransition) {
    setTransitionHooks(
      cloned,
      transition.clone(cloned)
    );
  }
  return cloned;
}
function createTextVNode(text = " ", flag = 0) {
  return createVNode(Text, null, text, flag);
}
function createCommentVNode(text = "", asBlock = false) {
  return asBlock ? (openBlock(), createBlock(Comment, null, text)) : createVNode(Comment, null, text);
}
function normalizeVNode(child) {
  if (child == null || typeof child === "boolean") {
    return createVNode(Comment);
  } else if (isArray(child)) {
    return createVNode(
      Fragment,
      null,
      // #3666, avoid reference pollution when reusing vnode
      child.slice()
    );
  } else if (isVNode(child)) {
    return cloneIfMounted(child);
  } else {
    return createVNode(Text, null, String(child));
  }
}
function cloneIfMounted(child) {
  return child.el === null && child.patchFlag !== -1 || child.memo ? child : cloneVNode(child);
}
function normalizeChildren(vnode, children) {
  let type = 0;
  const { shapeFlag } = vnode;
  if (children == null) {
    children = null;
  } else if (isArray(children)) {
    type = 16;
  } else if (typeof children === "object") {
    if (shapeFlag & (1 | 64)) {
      const slot = children.default;
      if (slot) {
        slot._c && (slot._d = false);
        normalizeChildren(vnode, slot());
        slot._c && (slot._d = true);
      }
      return;
    } else {
      type = 32;
      const slotFlag = children._;
      if (!slotFlag && !isInternalObject(children)) {
        children._ctx = currentRenderingInstance;
      } else if (slotFlag === 3 && currentRenderingInstance) {
        if (currentRenderingInstance.slots._ === 1) {
          children._ = 1;
        } else {
          children._ = 2;
          vnode.patchFlag |= 1024;
        }
      }
    }
  } else if (isFunction(children)) {
    if (shapeFlag & (1 | 64)) {
      normalizeChildren(vnode, { default: children });
      return;
    }
    children = { default: children, _ctx: currentRenderingInstance };
    type = 32;
  } else {
    children = String(children);
    if (shapeFlag & 64) {
      type = 16;
      children = [createTextVNode(children)];
    } else {
      type = 8;
    }
  }
  vnode.children = children;
  vnode.shapeFlag |= type;
}
function mergeProps(...args) {
  const ret = {};
  for (let i = 0; i < args.length; i++) {
    const toMerge = args[i];
    for (const key in toMerge) {
      if (key === "class") {
        if (ret.class !== toMerge.class) {
          ret.class = normalizeClass([ret.class, toMerge.class]);
        }
      } else if (key === "style") {
        ret.style = normalizeStyle([ret.style, toMerge.style]);
      } else if (isOn(key)) {
        const existing = ret[key];
        const incoming = toMerge[key];
        if (incoming && existing !== incoming && !(isArray(existing) && existing.includes(incoming))) {
          ret[key] = existing ? [].concat(existing, incoming) : incoming;
        } else if (incoming == null && existing == null && // mergeProps({ 'onUpdate:modelValue': undefined }) should not retain
        // the model listener.
        !isModelListener(key)) {
          ret[key] = incoming;
        }
      } else if (key !== "") {
        ret[key] = toMerge[key];
      }
    }
  }
  return ret;
}
function invokeVNodeHook(hook, instance, vnode, prevVNode = null) {
  callWithAsyncErrorHandling(hook, instance, 7, [
    vnode,
    prevVNode
  ]);
}
const emptyAppContext = createAppContext();
let uid = 0;
function getNextUid() {
  return uid;
}
function createComponentInstance(vnode, parent, suspense) {
  const type = vnode.type;
  const appContext = (parent ? parent.appContext : vnode.appContext) || emptyAppContext;
  const instance = {
    uid: uid++,
    vnode,
    type,
    parent,
    appContext,
    root: null,
    // to be immediately set
    next: null,
    subTree: null,
    // will be set synchronously right after creation
    effect: null,
    update: null,
    // will be set synchronously right after creation
    job: null,
    scope: new EffectScope(
      true
      /* detached */
    ),
    render: null,
    proxy: null,
    exposed: null,
    exposeProxy: null,
    withProxy: null,
    provides: parent ? parent.provides : Object.create(appContext.provides),
    ids: parent ? parent.ids : ["", 0, 0],
    accessCache: null,
    renderCache: [],
    // local resolved assets
    components: null,
    directives: null,
    // resolved props and emits options
    propsOptions: normalizePropsOptions(type, appContext),
    emitsOptions: normalizeEmitsOptions(type, appContext),
    // emit
    emit: null,
    // to be set immediately
    emitted: null,
    // props default value
    propsDefaults: EMPTY_OBJ,
    // inheritAttrs
    inheritAttrs: type.inheritAttrs,
    // state
    ctx: EMPTY_OBJ,
    data: EMPTY_OBJ,
    props: EMPTY_OBJ,
    attrs: EMPTY_OBJ,
    slots: EMPTY_OBJ,
    refs: EMPTY_OBJ,
    setupState: EMPTY_OBJ,
    setupContext: null,
    // suspense related
    suspense,
    suspenseId: suspense ? suspense.pendingId : 0,
    asyncDep: null,
    asyncResolved: false,
    // lifecycle hooks
    // not using enums here because it results in computed properties
    isMounted: false,
    isUnmounted: false,
    isDeactivated: false,
    bc: null,
    c: null,
    bm: null,
    m: null,
    bu: null,
    u: null,
    um: null,
    bum: null,
    da: null,
    a: null,
    rtg: null,
    rtc: null,
    ec: null,
    sp: null
  };
  {
    instance.ctx = { _: instance };
  }
  instance.root = parent ? parent.root : instance;
  instance.emit = emit.bind(null, instance);
  if (vnode.ce) {
    vnode.ce(instance);
  }
  return instance;
}
let currentInstance = null;
const getCurrentInstance = () => currentInstance || currentRenderingInstance;
let internalSetCurrentInstance;
let setInSSRSetupState;
{
  const g = getGlobalThis();
  const registerGlobalSetter = (key, setter) => {
    let setters;
    if (!(setters = g[key])) setters = g[key] = [];
    setters.push(setter);
    return (v) => {
      if (setters.length > 1) setters.forEach((set) => set(v));
      else setters[0](v);
    };
  };
  internalSetCurrentInstance = registerGlobalSetter(
    `__VUE_INSTANCE_SETTERS__`,
    (v) => currentInstance = v
  );
  setInSSRSetupState = registerGlobalSetter(
    `__VUE_SSR_SETTERS__`,
    (v) => isInSSRComponentSetup = v
  );
}
const setCurrentInstance = (instance) => {
  const prev = currentInstance;
  internalSetCurrentInstance(instance);
  instance.scope.on();
  return () => {
    instance.scope.off();
    internalSetCurrentInstance(prev);
  };
};
const unsetCurrentInstance = () => {
  currentInstance && currentInstance.scope.off();
  internalSetCurrentInstance(null);
};
function isStatefulComponent(instance) {
  return instance.vnode.shapeFlag & 4;
}
let isInSSRComponentSetup = false;
function setupComponent(instance, isSSR = false, optimized = false) {
  isSSR && setInSSRSetupState(isSSR);
  const { props, children } = instance.vnode;
  const isStateful = isStatefulComponent(instance);
  initProps(instance, props, isStateful, isSSR);
  initSlots(instance, children, optimized || isSSR);
  const setupResult = isStateful ? setupStatefulComponent(instance, isSSR) : void 0;
  isSSR && setInSSRSetupState(false);
  return setupResult;
}
function setupStatefulComponent(instance, isSSR) {
  const Component = instance.type;
  instance.accessCache = /* @__PURE__ */ Object.create(null);
  instance.proxy = new Proxy(instance.ctx, PublicInstanceProxyHandlers);
  const { setup } = Component;
  if (setup) {
    pauseTracking();
    const setupContext = instance.setupContext = setup.length > 1 ? createSetupContext(instance) : null;
    const reset = setCurrentInstance(instance);
    const setupResult = callWithErrorHandling(
      setup,
      instance,
      0,
      [
        instance.props,
        setupContext
      ]
    );
    const isAsyncSetup = isPromise(setupResult);
    resetTracking();
    reset();
    if ((isAsyncSetup || instance.sp) && !isAsyncWrapper(instance)) {
      markAsyncBoundary(instance);
    }
    if (isAsyncSetup) {
      setupResult.then(unsetCurrentInstance, unsetCurrentInstance);
      if (isSSR) {
        return setupResult.then((resolvedResult) => {
          setInSSRSetupState(true);
          try {
            handleSetupResult(instance, resolvedResult, isSSR);
          } finally {
            setInSSRSetupState(false);
          }
        }).catch((e) => {
          handleError(e, instance, 0);
        });
      } else {
        instance.asyncDep = setupResult;
      }
    } else {
      handleSetupResult(instance, setupResult);
    }
  } else {
    finishComponentSetup(instance);
  }
}
function handleSetupResult(instance, setupResult, isSSR) {
  if (isFunction(setupResult)) {
    if (instance.type.__ssrInlineRender) {
      instance.ssrRender = setupResult;
    } else {
      instance.render = setupResult;
    }
  } else if (isObject(setupResult)) {
    instance.setupState = proxyRefs(setupResult);
  } else ;
  finishComponentSetup(instance);
}
function finishComponentSetup(instance, isSSR, skipOptions) {
  const Component = instance.type;
  if (!instance.render) {
    instance.render = Component.render || NOOP;
  }
  {
    const reset = setCurrentInstance(instance);
    pauseTracking();
    try {
      applyOptions(instance);
    } finally {
      resetTracking();
      reset();
    }
  }
}
const attrsProxyHandlers = {
  get(target, key) {
    track(target, "get", "");
    return target[key];
  }
};
function createSetupContext(instance) {
  const expose = (exposed) => {
    instance.exposed = exposed || {};
  };
  {
    return {
      attrs: new Proxy(instance.attrs, attrsProxyHandlers),
      slots: instance.slots,
      emit: instance.emit,
      expose
    };
  }
}
function getComponentPublicInstance(instance) {
  if (instance.exposed) {
    return instance.exposeProxy || (instance.exposeProxy = new Proxy(proxyRefs(markRaw(instance.exposed)), {
      get(target, key) {
        if (key in target) {
          return target[key];
        } else if (key in publicPropertiesMap) {
          return publicPropertiesMap[key](instance);
        }
      },
      has(target, key) {
        return key in target || key in publicPropertiesMap;
      }
    }));
  } else {
    return instance.proxy;
  }
}
const classifyRE = /(?:^|[-_])\w/g;
const classify = (str) => str.replace(classifyRE, (c) => c.toUpperCase()).replace(/[-_]/g, "");
function getComponentName(Component, includeInferred = true) {
  return isFunction(Component) ? Component.displayName || Component.name : Component.name || includeInferred && Component.__name;
}
function formatComponentName(instance, Component, isRoot = false) {
  let name = getComponentName(Component);
  if (!name && Component.__file) {
    const match = Component.__file.match(/([^/\\]+)\.\w+$/);
    if (match) {
      name = match[1];
    }
  }
  if (!name && instance) {
    const inferFromRegistry = (registry) => {
      for (const key in registry) {
        if (registry[key] === Component) {
          return key;
        }
      }
    };
    name = inferFromRegistry(instance.components) || instance.parent && inferFromRegistry(
      instance.parent.type.components
    ) || inferFromRegistry(instance.appContext.components);
  }
  return name ? classify(name) : isRoot ? `App` : `Anonymous`;
}
function isClassComponent(value) {
  return isFunction(value) && "__vccOpts" in value;
}
const computed = (getterOrOptions, debugOptions) => {
  const c = /* @__PURE__ */ computed$1(getterOrOptions, debugOptions, isInSSRComponentSetup);
  return c;
};
function h(type, propsOrChildren, children) {
  try {
    setBlockTracking(-1);
    const l = arguments.length;
    if (l === 2) {
      if (isObject(propsOrChildren) && !isArray(propsOrChildren)) {
        if (isVNode(propsOrChildren)) {
          return createVNode(type, null, [propsOrChildren]);
        }
        return createVNode(type, propsOrChildren);
      } else {
        return createVNode(type, null, propsOrChildren);
      }
    } else {
      if (l > 3) {
        children = Array.prototype.slice.call(arguments, 2);
      } else if (l === 3 && isVNode(children)) {
        children = [children];
      }
      return createVNode(type, propsOrChildren, children);
    }
  } finally {
    setBlockTracking(1);
  }
}
const version = "3.5.44";
/**
* @vue/runtime-dom v3.5.44
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/
let policy = void 0;
const tt = typeof window !== "undefined" && window.trustedTypes;
if (tt) {
  try {
    policy = /* @__PURE__ */ tt.createPolicy("vue", {
      createHTML: (val) => val
    });
  } catch (e) {
  }
}
const unsafeToTrustedHTML = policy ? (val) => policy.createHTML(val) : (val) => val;
const svgNS = "http://www.w3.org/2000/svg";
const mathmlNS = "http://www.w3.org/1998/Math/MathML";
const doc = typeof document !== "undefined" ? document : null;
const templateContainer = doc && /* @__PURE__ */ doc.createElement("template");
const nodeOps = {
  insert: (child, parent, anchor) => {
    parent.insertBefore(child, anchor || null);
  },
  remove: (child) => {
    const parent = child.parentNode;
    if (parent) {
      parent.removeChild(child);
    }
  },
  createElement: (tag, namespace, is, props) => {
    const el = namespace === "svg" ? doc.createElementNS(svgNS, tag) : namespace === "mathml" ? doc.createElementNS(mathmlNS, tag) : is ? doc.createElement(tag, { is }) : doc.createElement(tag);
    if (tag === "select" && props && props.multiple != null) {
      el.setAttribute("multiple", props.multiple);
    }
    return el;
  },
  createText: (text) => doc.createTextNode(text),
  createComment: (text) => doc.createComment(text),
  setText: (node, text) => {
    node.nodeValue = text;
  },
  setElementText: (el, text) => {
    el.textContent = text;
  },
  parentNode: (node) => node.parentNode,
  nextSibling: (node) => node.nextSibling,
  querySelector: (selector) => doc.querySelector(selector),
  setScopeId(el, id) {
    el.setAttribute(id, "");
  },
  // __UNSAFE__
  // Reason: innerHTML.
  // Static content here can only come from compiled templates.
  // As long as the user only uses trusted templates, this is safe.
  insertStaticContent(content, parent, anchor, namespace, start, end) {
    const before = anchor ? anchor.previousSibling : parent.lastChild;
    if (start && (start === end || start.nextSibling)) {
      while (true) {
        parent.insertBefore(start.cloneNode(true), anchor);
        if (start === end || !(start = start.nextSibling)) break;
      }
    } else {
      templateContainer.innerHTML = unsafeToTrustedHTML(
        namespace === "svg" ? `<svg>${content}</svg>` : namespace === "mathml" ? `<math>${content}</math>` : content
      );
      const template = templateContainer.content;
      if (namespace === "svg" || namespace === "mathml") {
        const wrapper = template.firstChild;
        while (wrapper.firstChild) {
          template.appendChild(wrapper.firstChild);
        }
        template.removeChild(wrapper);
      }
      parent.insertBefore(template, anchor);
    }
    return [
      // first
      before ? before.nextSibling : parent.firstChild,
      // last
      anchor ? anchor.previousSibling : parent.lastChild
    ];
  }
};
const TRANSITION = "transition";
const ANIMATION = "animation";
const vtcKey = /* @__PURE__ */ Symbol("_vtc");
const DOMTransitionPropsValidators = {
  name: String,
  type: String,
  css: {
    type: Boolean,
    default: true
  },
  duration: [String, Number, Object],
  enterFromClass: String,
  enterActiveClass: String,
  enterToClass: String,
  appearFromClass: String,
  appearActiveClass: String,
  appearToClass: String,
  leaveFromClass: String,
  leaveActiveClass: String,
  leaveToClass: String
};
const TransitionPropsValidators = /* @__PURE__ */ extend(
  {},
  BaseTransitionPropsValidators,
  DOMTransitionPropsValidators
);
const decorate$1 = (t) => {
  t.displayName = "Transition";
  t.props = TransitionPropsValidators;
  return t;
};
const Transition = /* @__PURE__ */ decorate$1(
  (props, { slots }) => h(BaseTransition, resolveTransitionProps(props), slots)
);
const callHook = (hook, args = []) => {
  if (isArray(hook)) {
    hook.forEach((h2) => h2(...args));
  } else if (hook) {
    hook(...args);
  }
};
const hasExplicitCallback = (hook) => {
  return hook ? isArray(hook) ? hook.some((h2) => h2.length > 1) : hook.length > 1 : false;
};
function resolveTransitionProps(rawProps) {
  const baseProps = {};
  for (const key in rawProps) {
    if (!(key in DOMTransitionPropsValidators)) {
      baseProps[key] = rawProps[key];
    }
  }
  if (rawProps.css === false) {
    return baseProps;
  }
  const {
    name = "v",
    type,
    duration,
    enterFromClass = `${name}-enter-from`,
    enterActiveClass = `${name}-enter-active`,
    enterToClass = `${name}-enter-to`,
    appearFromClass = enterFromClass,
    appearActiveClass = enterActiveClass,
    appearToClass = enterToClass,
    leaveFromClass = `${name}-leave-from`,
    leaveActiveClass = `${name}-leave-active`,
    leaveToClass = `${name}-leave-to`
  } = rawProps;
  const durations = normalizeDuration(duration);
  const enterDuration = durations && durations[0];
  const leaveDuration = durations && durations[1];
  const {
    onBeforeEnter,
    onEnter,
    onEnterCancelled,
    onLeave,
    onLeaveCancelled,
    onBeforeAppear = onBeforeEnter,
    onAppear = onEnter,
    onAppearCancelled = onEnterCancelled
  } = baseProps;
  const finishEnter = (el, isAppear, done, isCancelled) => {
    el._enterCancelled = isCancelled;
    removeTransitionClass(el, isAppear ? appearToClass : enterToClass);
    removeTransitionClass(el, isAppear ? appearActiveClass : enterActiveClass);
    done && done();
  };
  const finishLeave = (el, done) => {
    el._isLeaving = false;
    removeTransitionClass(el, leaveFromClass);
    removeTransitionClass(el, leaveToClass);
    removeTransitionClass(el, leaveActiveClass);
    done && done();
  };
  const makeEnterHook = (isAppear) => {
    return (el, done) => {
      const hook = isAppear ? onAppear : onEnter;
      const resolve2 = () => finishEnter(el, isAppear, done);
      callHook(hook, [el, resolve2]);
      nextFrame(() => {
        removeTransitionClass(el, isAppear ? appearFromClass : enterFromClass);
        addTransitionClass(el, isAppear ? appearToClass : enterToClass);
        if (!hasExplicitCallback(hook)) {
          whenTransitionEnds(el, type, enterDuration, resolve2);
        }
      });
    };
  };
  return extend(baseProps, {
    onBeforeEnter(el) {
      callHook(onBeforeEnter, [el]);
      addTransitionClass(el, enterFromClass);
      addTransitionClass(el, enterActiveClass);
    },
    onBeforeAppear(el) {
      callHook(onBeforeAppear, [el]);
      addTransitionClass(el, appearFromClass);
      addTransitionClass(el, appearActiveClass);
    },
    onEnter: makeEnterHook(false),
    onAppear: makeEnterHook(true),
    onLeave(el, done) {
      el._isLeaving = true;
      const resolve2 = () => finishLeave(el, done);
      addTransitionClass(el, leaveFromClass);
      if (!el._enterCancelled) {
        forceReflow(el);
        addTransitionClass(el, leaveActiveClass);
      } else {
        addTransitionClass(el, leaveActiveClass);
        forceReflow(el);
      }
      nextFrame(() => {
        if (!el._isLeaving) {
          return;
        }
        removeTransitionClass(el, leaveFromClass);
        addTransitionClass(el, leaveToClass);
        if (!hasExplicitCallback(onLeave)) {
          whenTransitionEnds(el, type, leaveDuration, resolve2);
        }
      });
      callHook(onLeave, [el, resolve2]);
    },
    onEnterCancelled(el) {
      finishEnter(el, false, void 0, true);
      callHook(onEnterCancelled, [el]);
    },
    onAppearCancelled(el) {
      finishEnter(el, true, void 0, true);
      callHook(onAppearCancelled, [el]);
    },
    onLeaveCancelled(el) {
      finishLeave(el);
      callHook(onLeaveCancelled, [el]);
    }
  });
}
function normalizeDuration(duration) {
  if (duration == null) {
    return null;
  } else if (isObject(duration)) {
    return [NumberOf(duration.enter), NumberOf(duration.leave)];
  } else {
    const n = NumberOf(duration);
    return [n, n];
  }
}
function NumberOf(val) {
  const res = toNumber(val);
  return res;
}
function addTransitionClass(el, cls) {
  cls.split(/\s+/).forEach((c) => c && el.classList.add(c));
  (el[vtcKey] || (el[vtcKey] = /* @__PURE__ */ new Set())).add(cls);
}
function removeTransitionClass(el, cls) {
  cls.split(/\s+/).forEach((c) => c && el.classList.remove(c));
  const _vtc = el[vtcKey];
  if (_vtc) {
    _vtc.delete(cls);
    if (!_vtc.size) {
      el[vtcKey] = void 0;
    }
  }
}
function nextFrame(cb) {
  requestAnimationFrame(() => {
    requestAnimationFrame(cb);
  });
}
let endId = 0;
function whenTransitionEnds(el, expectedType, explicitTimeout, resolve2) {
  const id = el._endId = ++endId;
  const resolveIfNotStale = () => {
    if (id === el._endId) {
      resolve2();
    }
  };
  if (explicitTimeout != null) {
    return setTimeout(resolveIfNotStale, explicitTimeout);
  }
  const { type, timeout, propCount } = getTransitionInfo(el, expectedType);
  if (!type) {
    return resolve2();
  }
  const endEvent = type + "end";
  let ended = 0;
  const end = () => {
    el.removeEventListener(endEvent, onEnd);
    resolveIfNotStale();
  };
  const onEnd = (e) => {
    if (e.target === el && ++ended >= propCount) {
      end();
    }
  };
  setTimeout(() => {
    if (ended < propCount) {
      end();
    }
  }, timeout + 1);
  el.addEventListener(endEvent, onEnd);
}
function getTransitionInfo(el, expectedType) {
  const styles = window.getComputedStyle(el);
  const getStyleProperties = (key) => (styles[key] || "").split(", ");
  const transitionDelays = getStyleProperties(`${TRANSITION}Delay`);
  const transitionDurations = getStyleProperties(`${TRANSITION}Duration`);
  const transitionTimeout = getTimeout(transitionDelays, transitionDurations);
  const animationDelays = getStyleProperties(`${ANIMATION}Delay`);
  const animationDurations = getStyleProperties(`${ANIMATION}Duration`);
  const animationTimeout = getTimeout(animationDelays, animationDurations);
  let type = null;
  let timeout = 0;
  let propCount = 0;
  if (expectedType === TRANSITION) {
    if (transitionTimeout > 0) {
      type = TRANSITION;
      timeout = transitionTimeout;
      propCount = transitionDurations.length;
    }
  } else if (expectedType === ANIMATION) {
    if (animationTimeout > 0) {
      type = ANIMATION;
      timeout = animationTimeout;
      propCount = animationDurations.length;
    }
  } else {
    timeout = Math.max(transitionTimeout, animationTimeout);
    type = timeout > 0 ? transitionTimeout > animationTimeout ? TRANSITION : ANIMATION : null;
    propCount = type ? type === TRANSITION ? transitionDurations.length : animationDurations.length : 0;
  }
  const hasTransform = type === TRANSITION && /\b(?:transform|all)(?:,|$)/.test(
    getStyleProperties(`${TRANSITION}Property`).toString()
  );
  return {
    type,
    timeout,
    propCount,
    hasTransform
  };
}
function getTimeout(delays, durations) {
  while (delays.length < durations.length) {
    delays = delays.concat(delays);
  }
  return Math.max(...durations.map((d, i) => toMs(d) + toMs(delays[i])));
}
function toMs(s) {
  if (s === "auto") return 0;
  return Number(s.slice(0, -1).replace(",", ".")) * 1e3;
}
function forceReflow(el) {
  const targetDocument = el ? el.ownerDocument : document;
  return targetDocument.body.offsetHeight;
}
function patchClass(el, value, isSVG) {
  const transitionClasses = el[vtcKey];
  if (transitionClasses) {
    value = (value ? [value, ...transitionClasses] : [...transitionClasses]).join(" ");
  }
  if (value == null) {
    el.removeAttribute("class");
  } else if (isSVG) {
    el.setAttribute("class", value);
  } else {
    el.className = value;
  }
}
const vShowOriginalDisplay = /* @__PURE__ */ Symbol("_vod");
const vShowHidden = /* @__PURE__ */ Symbol("_vsh");
const CSS_VAR_TEXT = /* @__PURE__ */ Symbol("");
const displayRE = /(?:^|;)\s*display\s*:/;
function patchStyle(el, prev, next) {
  const style = el.style;
  const isCssString = isString(next);
  let hasControlledDisplay = false;
  if (next && !isCssString) {
    if (prev) {
      if (!isString(prev)) {
        for (const key in prev) {
          if (next[key] == null) {
            setStyle(style, key, "");
          }
        }
      } else {
        for (const prevStyle of prev.split(";")) {
          const key = prevStyle.slice(0, prevStyle.indexOf(":")).trim();
          if (next[key] == null) {
            setStyle(style, key, "");
          }
        }
      }
    }
    for (const key in next) {
      if (key === "display") {
        hasControlledDisplay = true;
      }
      const value = next[key];
      if (value != null) {
        if (!shouldPreserveTextareaResizeStyle(
          el,
          key,
          !isString(prev) && prev ? prev[key] : void 0,
          value
        )) {
          setStyle(style, key, value);
        }
      } else {
        setStyle(style, key, "");
      }
    }
  } else {
    if (isCssString) {
      if (prev !== next) {
        const cssVarText = style[CSS_VAR_TEXT];
        if (cssVarText) {
          next += ";" + cssVarText;
        }
        style.cssText = next;
        hasControlledDisplay = displayRE.test(next);
      }
    } else if (prev) {
      el.removeAttribute("style");
    }
  }
  if (vShowOriginalDisplay in el) {
    if (!isCssString || prev !== next) {
      el[vShowOriginalDisplay] = hasControlledDisplay ? style.display : "";
    }
    if (el[vShowHidden]) {
      style.display = "none";
    }
  }
}
const importantRE = /\s*!important$/;
function setStyle(style, name, val) {
  if (isArray(val)) {
    val.forEach((v) => setStyle(style, name, v));
  } else {
    if (val == null) val = "";
    if (name.startsWith("--")) {
      if (importantRE.test(val)) {
        style.setProperty(name, val.replace(importantRE, ""), "important");
      } else {
        style.setProperty(name, val);
      }
    } else {
      const prefixed = autoPrefix(style, name);
      if (importantRE.test(val)) {
        style.setProperty(
          hyphenate(prefixed),
          val.replace(importantRE, ""),
          "important"
        );
      } else {
        style[prefixed] = val;
      }
    }
  }
}
const prefixes = ["Webkit", "Moz", "ms"];
const prefixCache = {};
function autoPrefix(style, rawName) {
  const cached = prefixCache[rawName];
  if (cached) {
    return cached;
  }
  let name = camelize(rawName);
  if (name !== "filter" && name in style) {
    return prefixCache[rawName] = name;
  }
  name = capitalize(name);
  for (let i = 0; i < prefixes.length; i++) {
    const prefixed = prefixes[i] + name;
    if (prefixed in style) {
      return prefixCache[rawName] = prefixed;
    }
  }
  return rawName;
}
function shouldPreserveTextareaResizeStyle(el, key, prev, next) {
  return el.tagName === "TEXTAREA" && (key === "width" || key === "height") && isString(next) && prev === next;
}
const xlinkNS = "http://www.w3.org/1999/xlink";
function patchAttr(el, key, value, isSVG, instance, isBoolean = isSpecialBooleanAttr(key)) {
  if (isSVG && key.startsWith("xlink:")) {
    if (value == null) {
      el.removeAttributeNS(xlinkNS, key.slice(6, key.length));
    } else {
      el.setAttributeNS(xlinkNS, key, value);
    }
  } else {
    if (value == null || isBoolean && !includeBooleanAttr(value)) {
      el.removeAttribute(key);
    } else {
      el.setAttribute(
        key,
        isBoolean ? "" : isSymbol(value) ? String(value) : value
      );
    }
  }
}
function patchDOMProp(el, key, value, parentComponent, attrName) {
  if (key === "innerHTML" || key === "textContent") {
    if (value != null) {
      el[key] = key === "innerHTML" ? unsafeToTrustedHTML(value) : value;
    }
    return;
  }
  const tag = el.tagName;
  if (key === "value" && tag !== "PROGRESS" && // custom elements may use _value internally
  !tag.includes("-")) {
    const oldValue = tag === "OPTION" ? el.getAttribute("value") || "" : el.value;
    const newValue = value == null ? (
      // #11647: value should be set as empty string for null and undefined,
      // but <input type="checkbox"> should be set as 'on'.
      el.type === "checkbox" ? "on" : ""
    ) : String(value);
    if (oldValue !== newValue || !("_value" in el)) {
      el.value = newValue;
    }
    if (value == null) {
      el.removeAttribute(key);
    }
    el._value = value;
    return;
  }
  let needRemove = false;
  if (value === "" || value == null) {
    const type = typeof el[key];
    if (type === "boolean") {
      value = includeBooleanAttr(value);
    } else if (value == null && type === "string") {
      value = "";
      needRemove = true;
    } else if (type === "number") {
      value = 0;
      needRemove = true;
    }
  }
  try {
    el[key] = value;
  } catch (e) {
  }
  needRemove && el.removeAttribute(attrName || key);
}
function addEventListener(el, event, handler, options) {
  el.addEventListener(event, handler, options);
}
function removeEventListener(el, event, handler, options) {
  el.removeEventListener(event, handler, options);
}
const veiKey = /* @__PURE__ */ Symbol("_vei");
function patchEvent(el, rawName, prevValue, nextValue, instance = null) {
  const invokers = el[veiKey] || (el[veiKey] = {});
  const existingInvoker = invokers[rawName];
  if (nextValue && existingInvoker) {
    existingInvoker.value = nextValue;
  } else {
    const [name, options] = parseName(rawName);
    if (nextValue) {
      const invoker = invokers[rawName] = createInvoker(
        nextValue,
        instance
      );
      addEventListener(el, name, invoker, options);
    } else if (existingInvoker) {
      removeEventListener(el, name, existingInvoker, options);
      invokers[rawName] = void 0;
    }
  }
}
const optionsModifierRE = /(Once|Passive|Capture)$/;
const optionsModifierEventRE = /^on:?(?:Once|Passive|Capture)$/;
function parseName(name) {
  let options;
  let m;
  while ((m = name.match(optionsModifierRE)) && !optionsModifierEventRE.test(name)) {
    if (!options) options = {};
    name = name.slice(0, name.length - m[1].length);
    options[m[1].toLowerCase()] = true;
  }
  const event = name[2] === ":" ? name.slice(3) : hyphenate(name.slice(2));
  return [event, options];
}
let cachedNow = 0;
const p = /* @__PURE__ */ Promise.resolve();
const getNow = () => cachedNow || (p.then(() => cachedNow = 0), cachedNow = Date.now());
function createInvoker(initialValue, instance) {
  const invoker = (e) => {
    if (!e._vts) {
      e._vts = Date.now();
    } else if (e._vts <= invoker.attached) {
      return;
    }
    const value = invoker.value;
    if (isArray(value)) {
      const originalStop = e.stopImmediatePropagation;
      e.stopImmediatePropagation = () => {
        originalStop.call(e);
        e._stopped = true;
      };
      const handlers = value.slice();
      const args = [e];
      for (let i = 0; i < handlers.length; i++) {
        if (e._stopped) {
          break;
        }
        const handler = handlers[i];
        if (handler) {
          callWithAsyncErrorHandling(
            handler,
            instance,
            5,
            args
          );
        }
      }
    } else {
      callWithAsyncErrorHandling(
        value,
        instance,
        5,
        [e]
      );
    }
  };
  invoker.value = initialValue;
  invoker.attached = getNow();
  return invoker;
}
const isNativeOn = (key) => key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && // lowercase letter
key.charCodeAt(2) > 96 && key.charCodeAt(2) < 123;
const patchProp = (el, key, prevValue, nextValue, namespace, parentComponent) => {
  const isSVG = namespace === "svg";
  if (key === "class") {
    patchClass(el, nextValue, isSVG);
  } else if (key === "style") {
    patchStyle(el, prevValue, nextValue);
  } else if (isOn(key)) {
    if (!isModelListener(key)) {
      patchEvent(el, key, prevValue, nextValue, parentComponent);
    }
  } else if (key[0] === "." ? (key = key.slice(1), true) : key[0] === "^" ? (key = key.slice(1), false) : shouldSetAsProp(el, key, nextValue, isSVG)) {
    patchDOMProp(el, key, nextValue);
    if (!el.tagName.includes("-") && (key === "value" || key === "checked" || key === "selected")) {
      patchAttr(el, key, nextValue, isSVG, parentComponent, key !== "value");
    }
  } else if (
    // #11081 force set props for possible async custom element
    el._isVueCE && // #12408 check if it's declared prop or it's async custom element
    (shouldSetAsPropForVueCE(el, key) || // @ts-expect-error _def is private
    el._def.__asyncLoader && (/[A-Z]/.test(key) || !isString(nextValue)))
  ) {
    patchDOMProp(el, camelize(key), nextValue, parentComponent, key);
  } else {
    if (key === "true-value") {
      el._trueValue = nextValue;
    } else if (key === "false-value") {
      el._falseValue = nextValue;
    }
    patchAttr(el, key, nextValue, isSVG);
  }
};
function shouldSetAsProp(el, key, value, isSVG) {
  if (isSVG) {
    if (key === "innerHTML" || key === "textContent") {
      return true;
    }
    if (key in el && isNativeOn(key) && isFunction(value)) {
      return true;
    }
    return false;
  }
  if (key === "spellcheck" || key === "draggable" || key === "translate" || key === "autocorrect") {
    return false;
  }
  if (key === "sandbox" && el.tagName === "IFRAME") {
    return false;
  }
  if (key === "form") {
    return false;
  }
  if (key === "list" && el.tagName === "INPUT") {
    return false;
  }
  if (key === "type" && el.tagName === "TEXTAREA") {
    return false;
  }
  if (key === "width" || key === "height") {
    const tag = el.tagName;
    if (tag === "IMG" || tag === "VIDEO" || tag === "CANVAS" || tag === "SOURCE") {
      return false;
    }
  }
  if (isNativeOn(key) && isString(value)) {
    return false;
  }
  return key in el;
}
function shouldSetAsPropForVueCE(el, key) {
  const props = (
    // @ts-expect-error _def is private
    el._def.props
  );
  if (!props) {
    return false;
  }
  const camelKey = camelize(key);
  return Array.isArray(props) ? props.some((prop) => camelize(prop) === camelKey) : Object.keys(props).some((prop) => camelize(prop) === camelKey);
}
const getModelAssigner = (vnode) => {
  const fn = vnode.props["onUpdate:modelValue"] || false;
  return isArray(fn) ? (value) => invokeArrayFns(fn, value) : fn;
};
function onCompositionStart(e) {
  e.target.composing = true;
}
function onCompositionEnd(e) {
  const target = e.target;
  if (target.composing) {
    target.composing = false;
    target.dispatchEvent(new Event("input"));
  }
}
const assignKey = /* @__PURE__ */ Symbol("_assign");
const initialValueKey = /* @__PURE__ */ Symbol("_initialValue");
function castValue(value, trim, number) {
  if (trim) value = value.trim();
  if (number) value = looseToNumber(value);
  return value;
}
const vModelText = {
  created(el, { modifiers: { lazy, trim, number } }, vnode) {
    if (el.parentNode) {
      if (el.type === "text") {
        el[initialValueKey] = el.defaultValue.replace(/[\r\n]/g, "");
      } else if (el.type === "textarea") {
        el[initialValueKey] = el.defaultValue.replace(/\r\n?/g, "\n");
      }
    }
    el[assignKey] = getModelAssigner(vnode);
    const castToNumber = number || vnode.props && vnode.props.type === "number";
    addEventListener(el, lazy ? "change" : "input", (e) => {
      if (e.target.composing) return;
      el[assignKey](castValue(el.value, trim, castToNumber));
    });
    if (trim || castToNumber) {
      addEventListener(el, "change", () => {
        el.value = castValue(el.value, trim, castToNumber);
      });
    }
    if (!lazy) {
      addEventListener(el, "compositionstart", onCompositionStart);
      addEventListener(el, "compositionend", onCompositionEnd);
      addEventListener(el, "change", onCompositionEnd);
    }
  },
  // set value on mounted so it's after min/max for type="range"
  mounted(el, { value, modifiers: { trim, number } }) {
    const newValue = value == null ? "" : value;
    const initialValue = el[initialValueKey];
    delete el[initialValueKey];
    if (initialValue !== void 0 && (el.type === "text" || el.type === "textarea") && el.value !== initialValue) {
      el[assignKey](castValue(el.value, trim, number));
    } else {
      el.value = newValue;
    }
  },
  beforeUpdate(el, { value, oldValue, modifiers: { lazy, trim, number } }, vnode) {
    el[assignKey] = getModelAssigner(vnode);
    if (el.composing) return;
    const elValue = (number || el.type === "number") && !/^0\d/.test(el.value) ? looseToNumber(el.value) : el.value;
    const newValue = value == null ? "" : value;
    if (elValue === newValue) {
      return;
    }
    const rootNode = el.getRootNode();
    if ((rootNode instanceof Document || rootNode instanceof ShadowRoot) && rootNode.activeElement === el && el.type !== "range") {
      if (lazy && value === oldValue) {
        return;
      }
      if (trim && el.value.trim() === newValue) {
        return;
      }
    }
    el.value = newValue;
  }
};
const vModelCheckbox = {
  // #4096 array checkboxes need to be deep traversed
  deep: true,
  created(el, _, vnode) {
    el[assignKey] = getModelAssigner(vnode);
    addEventListener(el, "change", () => {
      const modelValue = el._modelValue;
      const elementValue = getValue(el);
      const checked = el.checked;
      const assign = el[assignKey];
      if (isArray(modelValue)) {
        const index = looseIndexOf(modelValue, elementValue);
        const found = index !== -1;
        if (checked && !found) {
          assign(modelValue.concat(elementValue));
        } else if (!checked && found) {
          const filtered = [...modelValue];
          filtered.splice(index, 1);
          assign(filtered);
        }
      } else if (isSet(modelValue)) {
        const cloned = new Set(modelValue);
        if (checked) {
          cloned.add(elementValue);
        } else {
          cloned.delete(elementValue);
        }
        assign(cloned);
      } else {
        assign(getCheckboxValue(el, checked));
      }
    });
  },
  // set initial checked on mount to wait for true-value/false-value
  mounted: setChecked,
  beforeUpdate(el, binding, vnode) {
    el[assignKey] = getModelAssigner(vnode);
    setChecked(el, binding, vnode);
  }
};
function setChecked(el, { value, oldValue }, vnode) {
  el._modelValue = value;
  let checked;
  if (isArray(value)) {
    checked = looseIndexOf(value, vnode.props.value) > -1;
  } else if (isSet(value)) {
    checked = value.has(vnode.props.value);
  } else {
    if (value === oldValue) return;
    checked = looseEqual(value, getCheckboxValue(el, true));
  }
  if (el.checked !== checked) {
    el.checked = checked;
  }
}
const vModelSelect = {
  // <select multiple> value need to be deep traversed
  deep: true,
  created(el, { value, modifiers: { number } }, vnode) {
    el._modelValue = value;
    addEventListener(el, "change", () => {
      const selectedVal = Array.prototype.filter.call(el.options, (o) => o.selected).map(
        (o) => number ? looseToNumber(getValue(o)) : getValue(o)
      );
      const multiple = el.multiple;
      const assignedValue = multiple ? isSet(el._modelValue) ? new Set(selectedVal) : selectedVal : selectedVal[0];
      const pending = el._pendingValue = [
        multiple,
        multiple ? isArray(assignedValue) ? selectedVal.slice() : selectedVal : assignedValue
      ];
      try {
        el[assignKey](assignedValue);
      } finally {
        nextTick(() => {
          if (el._pendingValue === pending) {
            el._pendingValue = void 0;
          }
        });
      }
    });
    el[assignKey] = getModelAssigner(vnode);
  },
  // set value in mounted & updated because <select> relies on its children
  // <option>s.
  mounted(el, { value }) {
    setSelected(el, value);
  },
  beforeUpdate(el, { value }, vnode) {
    el._modelValue = value;
    el[assignKey] = getModelAssigner(vnode);
  },
  updated(el, { value }) {
    const pending = el._pendingValue;
    el._pendingValue = void 0;
    if (!pending || pending[0] !== el.multiple || !isSameSelectValue(value, pending[1], pending[0])) {
      setSelected(el, value);
    }
  }
};
function isSameSelectValue(value, assignedValue, multiple) {
  if (!multiple) return looseEqual(value, assignedValue);
  if (isArray(value)) return looseEqual(value, assignedValue);
  if (isSet(value)) {
    if (value.size !== assignedValue.length) return false;
    for (const item of assignedValue) {
      if (!value.has(item)) return false;
    }
    return true;
  }
  return false;
}
function setSelected(el, value) {
  const isMultiple = el.multiple;
  const isArrayValue = isArray(value);
  if (isMultiple && !isArrayValue && !isSet(value)) {
    return;
  }
  for (let i = 0, l = el.options.length; i < l; i++) {
    const option = el.options[i];
    const optionValue = getValue(option);
    if (isMultiple) {
      if (isArrayValue) {
        const optionType = typeof optionValue;
        if (optionType === "string" || optionType === "number") {
          option.selected = value.some((v) => String(v) === String(optionValue));
        } else {
          option.selected = looseIndexOf(value, optionValue) > -1;
        }
      } else {
        option.selected = value.has(optionValue);
      }
    } else if (looseEqual(getValue(option), value)) {
      if (el.selectedIndex !== i) el.selectedIndex = i;
      return;
    }
  }
  if (!isMultiple && el.selectedIndex !== -1) {
    el.selectedIndex = -1;
  }
}
function getValue(el) {
  return "_value" in el ? el._value : el.value;
}
function getCheckboxValue(el, checked) {
  const key = checked ? "_trueValue" : "_falseValue";
  return key in el ? el[key] : checked;
}
const systemModifiers = ["ctrl", "shift", "alt", "meta"];
const modifierGuards = {
  stop: (e) => e.stopPropagation(),
  prevent: (e) => e.preventDefault(),
  self: (e) => e.target !== e.currentTarget,
  ctrl: (e) => !e.ctrlKey,
  shift: (e) => !e.shiftKey,
  alt: (e) => !e.altKey,
  meta: (e) => !e.metaKey,
  left: (e) => "button" in e && e.button !== 0,
  middle: (e) => "button" in e && e.button !== 1,
  right: (e) => "button" in e && e.button !== 2,
  exact: (e, modifiers) => systemModifiers.some((m) => e[`${m}Key`] && !modifiers.includes(m))
};
const withModifiers = (fn, modifiers) => {
  if (!fn) return fn;
  const cache = fn._withMods || (fn._withMods = {});
  const cacheKey = modifiers.join(".");
  return cache[cacheKey] || (cache[cacheKey] = ((event, ...args) => {
    for (let i = 0; i < modifiers.length; i++) {
      const guard = modifierGuards[modifiers[i]];
      if (guard && guard(event, modifiers)) return;
    }
    return fn(event, ...args);
  }));
};
const keyNames = {
  esc: "escape",
  space: " ",
  up: "arrow-up",
  left: "arrow-left",
  right: "arrow-right",
  down: "arrow-down",
  delete: "backspace"
};
const withKeys = (fn, modifiers) => {
  const cache = fn._withKeys || (fn._withKeys = {});
  const cacheKey = modifiers.join(".");
  return cache[cacheKey] || (cache[cacheKey] = ((event) => {
    if (!("key" in event)) {
      return;
    }
    const eventKey = hyphenate(event.key);
    if (modifiers.some(
      (k) => k === eventKey || keyNames[k] === eventKey
    )) {
      return fn(event);
    }
  }));
};
const rendererOptions = /* @__PURE__ */ extend({ patchProp }, nodeOps);
let renderer;
function ensureRenderer() {
  return renderer || (renderer = createRenderer(rendererOptions));
}
const createApp = ((...args) => {
  const app = ensureRenderer().createApp(...args);
  const { mount } = app;
  app.mount = (containerOrSelector) => {
    const container = normalizeContainer(containerOrSelector);
    if (!container) return;
    const component = app._component;
    if (!isFunction(component) && !component.render && !component.template) {
      component.template = container.innerHTML;
    }
    if (container.nodeType === 1) {
      container.textContent = "";
    }
    const proxy = mount(container, false, resolveRootNamespace(container));
    if (container instanceof Element) {
      container.removeAttribute("v-cloak");
      container.setAttribute("data-v-app", "");
    }
    return proxy;
  };
  return app;
});
function resolveRootNamespace(container) {
  if (container instanceof SVGElement) {
    return "svg";
  }
  if (typeof MathMLElement === "function" && container instanceof MathMLElement) {
    return "mathml";
  }
}
function normalizeContainer(container) {
  if (isString(container)) {
    const res = document.querySelector(container);
    return res;
  }
  return container;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const CANVAS_MODES = ["single", "multi_panel", "collage"];
function isNumArray(v) {
  return Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}
const BOX_PALETTE = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#22d3ee", "#f87171", "#a3e635"];
let _colorSeq = 0;
function nextBoxColor() {
  return BOX_PALETTE[_colorSeq++ % BOX_PALETTE.length];
}
function groupColor(groupId) {
  let h2 = 0;
  for (let i = 0; i < groupId.length; i++) h2 = h2 * 31 + groupId.charCodeAt(i) >>> 0;
  return `hsl(${h2 % 360} 70% 55%)`;
}
function emptyOverlay() {
  return { lineWidth: 3, fillAlpha: 0.18, labelSize: 16, showIndex: true, showText: true };
}
function emptyUi() {
  return { sync: true, showLabels: true, backdropOpacity: 0.5, newType: "object", jsonOpen: false, summaryOpen: true, itemsOpen: true, showPresets: false, jsonSync: false, livePreview: false };
}
let _seq = 0;
function newId() {
  return `e${++_seq}_${Math.random().toString(36).slice(2, 7)}`;
}
function syncSeq(ids) {
  for (const id of ids) {
    const m = id && /^(?:e)(\d+)_/.exec(id);
    if (m) _seq = Math.max(_seq, parseInt(m[1], 10));
  }
}
function newElement(label, bbox) {
  return { id: newId(), label, bbox, caption: "", text: "", tags: [], palette: [], boxColor: nextBoxColor(), linkId: null, groupId: null };
}
function emptyState() {
  return {
    width: 1024,
    height: 1024,
    summary: { caption: "", meta: [], canvas: "single", palette: [] },
    elements: [],
    overlay: emptyOverlay(),
    ui: emptyUi()
  };
}
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
function normalizeHex(raw) {
  const s = raw.trim();
  if (HEX_RE.test(s)) return s.toUpperCase();
  if (/^#[0-9A-Fa-f]{3}$/.test(s)) return "#" + s.slice(1).split("").map((c) => c + c).join("").toUpperCase();
  return null;
}
function snapDim(v) {
  const n = Math.round(v);
  return Math.max(1, n);
}
function clampBbox(b, w, h2) {
  let [x1, y1, x2, y2] = b;
  x1 = Math.max(0, Math.min(w, x1));
  x2 = Math.max(0, Math.min(w, x2));
  y1 = Math.max(0, Math.min(h2, y1));
  y2 = Math.max(0, Math.min(h2, y2));
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];
  return [x1, y1, x2, y2];
}
function buildDraft(state) {
  const width = snapDim(state.width);
  const height = snapDim(state.height);
  const summary = { canvas: state.summary.canvas, caption: state.summary.caption.trim() || "A scene arranged according to the specified regional composition." };
  if (state.summary.meta.length) summary.meta = [...state.summary.meta];
  if (state.summary.palette.length) summary.palette = [...state.summary.palette];
  const items = state.elements.map((el) => {
    const it = { label: el.label, caption: el.caption.trim() || (el.label === "text" ? "Visible lettering." : el.label === "character" ? "A character in this region." : "An object in this region."), bbox: clampBbox(el.bbox, width, height) };
    if (el.label === "text") it.text = el.text;
    if (el.tags.length) it.tags = [...el.tags];
    if (el.palette.length) it.palette = [...el.palette];
    return it;
  });
  return { width, height, bbox_coord_space: "abs", bbox_format: "xyxy", summary, items };
}
function compileDraft(draft) {
  const warnings = [];
  const width = draft.width, height = draft.height;
  const items = draft.items.map((it) => {
    var _a, _b;
    const [x1, y1, x2, y2] = it.bbox;
    const box = [
      Math.floor(y1) - (height >> 1),
      Math.floor(x1) - (width >> 1),
      Math.ceil(y2) - (height >> 1),
      Math.ceil(x2) - (width >> 1)
    ];
    const out = { label: it.label, caption: it.caption, bbox: box };
    if (it.text) out.text = it.text;
    if ((_a = it.tags) == null ? void 0 : _a.length) out.tags = it.tags;
    if ((_b = it.palette) == null ? void 0 : _b.length) out.palette = it.palette;
    return out;
  });
  const result = { summary: draft.summary, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" };
  return { json: JSON.stringify(result), warnings };
}
function serialize(state) {
  const draft = buildDraft(state);
  const compiled = compileDraft(draft);
  return { draft, draftPretty: JSON.stringify(draft, null, 2), prompt: compiled.json, warnings: compiled.warnings };
}
function matchingStudio(value, draft) {
  if (!isRecord(value) || !Array.isArray(value.elements) || !isRecord(value.summary) || !isRecord(value.ui) || !isRecord(value.overlay)) return null;
  try {
    const state = value;
    return JSON.stringify(serialize(state).draft) === JSON.stringify(draft) ? state : null;
  } catch {
    return null;
  }
}
function parseJsonLoose(text) {
  if (!text || !text.trim()) return { ok: false, error: "empty input" };
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^`+/, "").replace(/`+$/, "");
    if (/^json/i.test(s.trim())) s = s.trim().slice(4);
    s = s.trim();
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "no JSON object found" };
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (!isRecord(obj)) return { ok: false, error: "payload is not a JSON object" };
    return { ok: true, obj };
  } catch (e) {
    return { ok: false, error: String((e == null ? void 0 : e.message) || e) };
  }
}
function _issue(strict, message, warnings, errors) {
  if (strict) errors.push(message);
  else warnings.push(message);
}
function _readDim(value, where, strict, warnings, errors) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    _issue(strict, `${where} must be a positive integer; got ${String(value)}`, warnings, errors);
    return null;
  }
  if (strict) {
    if (!Number.isInteger(value)) {
      _issue(strict, `${where} must be a positive integer; got ${value}`, warnings, errors);
      return null;
    }
    return value;
  }
  const snapped = snapDim(value);
  if (!Number.isInteger(value)) {
    warnings.push(`${where} ${value} rounded to ${snapped}`);
  }
  return snapped;
}
function _stringList(value, where, strict, warnings, errors) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) {
    _issue(strict, `${where}: expected an array of strings`, warnings, errors);
    return [];
  }
  const out = [];
  value.forEach((entry, j) => {
    if (typeof entry === "string") out.push(entry);
    else warnings.push(`${where}[${j}]: non-string entry dropped`);
  });
  return out;
}
function _fallbackBox(w, h2) {
  return [0, 0, Math.min(64, Math.max(16, w)), Math.min(64, Math.max(16, h2))];
}
function _fmtBox(box) {
  return Array.isArray(box) ? `[${box.map((v) => typeof v === "number" ? Number(v.toFixed(3)) : v).join(", ")}]` : String(box);
}
function resolveToState(obj, width, height, opts = {}) {
  const strict = opts.strict ?? false;
  const bboxMode = opts.bboxMode ?? (strict ? "reject" : "clamp");
  const rawTolerance = Number(opts.bboxTolerance ?? 2);
  const bboxTolerance = Number.isFinite(rawTolerance) ? Math.max(0, rawTolerance) : 2;
  const warnings = [];
  const errors = [];
  if (!isRecord(obj)) {
    _issue(strict, "payload is not a JSON object", warnings, errors);
    return { state: {}, warnings, errors };
  }
  const hasCoord = "bbox_coord_space" in obj;
  const hasFmt = "bbox_format" in obj;
  let compiled = false;
  let editor = false;
  if (hasCoord) {
    const coord = obj.bbox_coord_space;
    if (typeof coord !== "string") {
      _issue(strict, "bbox_coord_space must be a string", warnings, errors);
    } else if (coord !== "abs" && coord !== "abs_centralized") {
      _issue(strict, `unsupported bbox_coord_space '${coord}'; expected 'abs' or 'abs_centralized'`, warnings, errors);
    } else if (coord === "abs_centralized") {
      compiled = true;
    } else {
      editor = true;
    }
  }
  if (hasFmt) {
    const fmt = obj.bbox_format;
    if (typeof fmt !== "string") {
      _issue(strict, "bbox_format must be a string", warnings, errors);
    } else if (fmt !== "xyxy" && fmt !== "yxyx") {
      _issue(strict, `unsupported bbox_format '${fmt}'; expected 'xyxy' or 'yxyx'`, warnings, errors);
    } else if (fmt === "yxyx") {
      compiled = true;
    } else {
      editor = true;
    }
  }
  if (compiled && editor) {
    _issue(
      strict,
      "conflicting bbox_coord_space/bbox_format: compiled coordinates (abs_centralized/yxyx) cannot be combined with editor coordinates (abs/xyxy)",
      warnings,
      errors
    );
  }
  let kind = compiled ? "compiled_prompt" : "editor_draft";
  if (!compiled && !editor && !hasCoord && !hasFmt) {
    const summary2 = isRecord(obj.summary) ? obj.summary : {};
    if (!("items" in obj) && (typeof obj.caption === "string" || typeof summary2.caption === "string")) {
      kind = "caption_only";
    } else {
      warnings.push(
        "bbox_coord_space/bbox_format missing; assuming an editor draft (abs/xyxy). Compiled payloads must declare abs_centralized/yxyx."
      );
    }
  }
  const hasW = "width" in obj;
  const hasH = "height" in obj;
  if (hasW !== hasH) _issue(strict, "width and height must both be provided", warnings, errors);
  const pw = hasW ? _readDim(obj.width, "width", strict, warnings, errors) : null;
  const ph = hasH ? _readDim(obj.height, "height", strict, warnings, errors) : null;
  const tw = _readDim(width, "target width", strict, warnings, errors);
  const th = _readDim(height, "target height", strict, warnings, errors);
  let w;
  let h2;
  if (pw && ph) {
    w = pw;
    h2 = ph;
    if (tw && th && (tw !== pw || th !== ph)) {
      warnings.push(
        `target canvas ${tw}x${th} ignored: payload declares ${pw}x${ph} (external width/height take priority)`
      );
    }
    if (kind === "compiled_prompt") {
      warnings.push(`compiled prompt de-centered onto its declared canvas ${pw}x${ph}`);
    }
  } else if (kind === "compiled_prompt") {
    if (!hasW && !hasH) {
      _issue(
        strict,
        "compiled prompt has no width/height; pass target width/height (the canvas cannot be inferred from center-origin boxes)",
        warnings,
        errors
      );
    }
    w = tw ?? snapDim(width);
    h2 = th ?? snapDim(height);
    if (tw && th) warnings.push(`compiled prompt has no width/height; de-centered onto target canvas ${tw}x${th}`);
  } else if (tw && th) {
    w = tw;
    h2 = th;
    if (!(hasW && hasH)) warnings.push(`width/height missing; using target canvas ${tw}x${th}`);
  } else {
    w = snapDim(width);
    h2 = snapDim(height);
    warnings.push("width/height missing; defaulted to 1024x1024");
  }
  let rawSummary = {};
  if (obj.summary !== void 0) {
    if (isRecord(obj.summary)) rawSummary = obj.summary;
    else _issue(strict, "summary must be an object", warnings, errors);
  }
  let caption = "";
  if (kind === "caption_only" && "caption" in obj) {
    if (typeof obj.caption === "string") {
      caption = obj.caption;
      if (typeof rawSummary.caption === "string" && rawSummary.caption && rawSummary.caption !== caption) {
        warnings.push("caption-only payload: root caption overrides summary.caption");
      }
    } else {
      _issue(strict, "caption must be a string", warnings, errors);
    }
  } else if ("caption" in rawSummary) {
    if (typeof rawSummary.caption === "string") caption = rawSummary.caption;
    else _issue(strict, "summary.caption must be a string", warnings, errors);
  }
  if (!caption.trim()) warnings.push("summary.caption is empty; the compiled prompt requires caption text");
  const meta = _stringList(rawSummary.meta, "summary.meta", strict, warnings, errors);
  const palette = _stringList(rawSummary.palette, "summary.palette", strict, warnings, errors);
  const canvasRaw = rawSummary.canvas ?? "single";
  const canvas = CANVAS_MODES.includes(canvasRaw) ? canvasRaw : (() => {
    _issue(strict, `summary.canvas '${String(canvasRaw)}' invalid; expected single, multi_panel or collage`, warnings, errors);
    return "single";
  })();
  for (const key of Object.keys(rawSummary)) {
    if (!["meta", "canvas", "caption", "palette"].includes(key)) {
      warnings.push(`summary.${key}: not an official summary field; dropped`);
    }
  }
  const summary = { caption, meta, canvas, palette };
  let rawItems = [];
  if (obj.items === void 0) {
    if (kind !== "caption_only") warnings.push("items is missing; imported an empty layout");
  } else if (!Array.isArray(obj.items)) {
    _issue(strict, "items must be an array", warnings, errors);
  } else {
    rawItems = obj.items;
  }
  const halfW = w >> 1;
  const halfH = h2 >> 1;
  const elements = [];
  rawItems.forEach((raw, i) => {
    const where = `items[${i}]`;
    if (!isRecord(raw)) {
      _issue(strict, `${where} is not an object; the item was not imported`, warnings, errors);
      elements.push(newElement("object", _fallbackBox(w, h2)));
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!["label", "caption", "bbox", "text", "tags", "palette"].includes(key)) {
        warnings.push(`${where}.${key}: not an official item field; dropped`);
      }
    }
    let label = "object";
    if (raw.label !== "object" && raw.label !== "character" && raw.label !== "text") {
      _issue(strict, `${where}.label '${String(raw.label)}' invalid; expected object, character or text`, warnings, errors);
    } else {
      label = raw.label;
    }
    let itemCaption = "";
    if (typeof raw.caption === "string") {
      itemCaption = raw.caption;
      if (!itemCaption.trim()) warnings.push(`${where}.caption is empty; the compiled prompt requires caption text`);
    } else if (raw.caption !== void 0) {
      _issue(strict, `${where}.caption must be a string`, warnings, errors);
    }
    let bbox;
    if (!isNumArray(raw.bbox)) {
      _issue(strict, `${where}.bbox must be four finite numbers`, warnings, errors);
      bbox = _fallbackBox(w, h2);
    } else {
      const box = kind === "compiled_prompt" ? [
        raw.bbox[1] + halfW,
        raw.bbox[0] + halfH,
        raw.bbox[3] + halfW,
        raw.bbox[2] + halfH
      ] : [...raw.bbox];
      if (!(box[0] < box[2] && box[1] < box[3])) {
        _issue(strict, `${where}.bbox must have positive width and height; got ${_fmtBox(box)}`, warnings, errors);
        bbox = _fallbackBox(w, h2);
      } else if (!(0 <= box[0] && box[2] <= w && 0 <= box[1] && box[3] <= h2)) {
        const overflow = Math.max(0 - box[0], box[2] - w, 0 - box[1], box[3] - h2);
        const shouldClamp = bboxMode === "clamp" || bboxMode === "auto" && overflow <= bboxTolerance;
        if (shouldClamp) {
          const clamped = clampBbox(box, w, h2);
          if (!(clamped[0] < clamped[2] && clamped[1] < clamped[3])) {
            _issue(
              strict,
              `${where}.bbox ${_fmtBox(box)} collapses to zero area when clamped to ${w}x${h2}`,
              warnings,
              errors
            );
            bbox = _fallbackBox(w, h2);
          } else {
            const how = bboxMode === "auto" ? "auto-clamped" : "clamped";
            const extra = bboxMode === "auto" ? ` (overflow ${overflow.toFixed(2)}px <= tolerance ${bboxTolerance}px)` : "";
            warnings.push(`${where}.bbox ${_fmtBox(box)} exceeded canvas ${w}x${h2}; ${how} to ${_fmtBox(clamped)}${extra}`);
            bbox = clamped;
          }
        } else {
          const hint = bboxMode === "auto" ? `bbox_mode='auto', tolerance=${bboxTolerance}px; use 'clamp' to accept a clamped box` : "bbox_mode='reject'; use 'auto' with a tolerance or 'clamp' to accept a clamped box";
          _issue(
            strict,
            `${where}.bbox ${_fmtBox(box)} exceeds canvas ${w}x${h2} by ${overflow.toFixed(2)}px (${hint})`,
            warnings,
            errors
          );
          bbox = clampBbox(box, w, h2);
          if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) bbox = _fallbackBox(w, h2);
        }
      } else {
        bbox = box;
      }
    }
    const el = newElement(label, bbox);
    el.caption = itemCaption;
    if (raw.text !== void 0) {
      if (typeof raw.text === "string") {
        if (label === "text" && !raw.text.trim()) {
          _issue(strict, `${where}: text items require a non-empty literal 'text'`, warnings, errors);
        } else if (label !== "text" && !raw.text.trim()) {
          warnings.push(`${where}.text is empty; omitted from the canonical draft`);
        }
        el.text = raw.text;
      } else if (label === "text") {
        _issue(strict, `${where}: text items require a non-empty literal 'text'`, warnings, errors);
      } else {
        warnings.push(`${where}.text is not a string; omitted from the canonical draft`);
      }
    } else if (label === "text") {
      _issue(strict, `${where}: text items require a non-empty literal 'text'`, warnings, errors);
    }
    el.tags = _stringList(raw.tags, `${where}.tags`, strict, warnings, errors);
    el.palette = _stringList(raw.palette, `${where}.palette`, strict, warnings, errors);
    elements.push(el);
  });
  if (!elements.length) warnings.push("items is empty; the compiled prompt requires at least one item");
  return { state: { width: w, height: h2, summary, elements }, warnings, errors };
}
function _pruneLink(elements, groupId) {
  if (!groupId) return;
  const members = elements.filter((e) => e.linkId === groupId);
  if (members.length === 1) members[0].linkId = null;
}
function _pruneGroup(elements, groupId) {
  if (!groupId) return;
  const members = elements.filter((e) => e.groupId === groupId);
  if (members.length === 1) members[0].groupId = null;
}
function _expandGroups(elements, ids) {
  const out = [];
  for (const id of ids) {
    const el = elements.find((e) => e.id === id);
    if (!el) continue;
    const members = el.groupId ? elements.filter((e) => e.groupId === el.groupId) : [el];
    for (const m of members) if (!out.includes(m.id)) out.push(m.id);
  }
  return out;
}
function _flipBbox(el, axis, w, h2) {
  const [x1, y1, x2, y2] = el.bbox;
  el.bbox = axis === "h" ? [w - x2, y1, w - x1, y2] : [x1, h2 - y2, x2, h2 - y1];
}
const KEY = Symbol("moss-studio");
function createStudioStore() {
  const store = /* @__PURE__ */ reactive({
    state: emptyState(),
    selectedIds: [],
    get selectedId() {
      return store.selectedIds.length ? store.selectedIds[store.selectedIds.length - 1] : null;
    },
    isSelected(id) {
      return store.selectedIds.includes(id);
    },
    _hist: [],
    _hi: -1,
    restoring: false,
    get canUndo() {
      return store._hi > 0;
    },
    get canRedo() {
      return store._hi >= 0 && store._hi < store._hist.length - 1;
    },
    snapshot() {
      if (store.restoring) return;
      const snap = JSON.stringify(store.state);
      if (store._hist[store._hi] === snap) return;
      store._hist = store._hist.slice(0, store._hi + 1);
      store._hist.push(snap);
      if (store._hist.length > 80) store._hist.shift();
      store._hi = store._hist.length - 1;
    },
    _restore(snap) {
      store.restoring = true;
      const parsed = JSON.parse(snap);
      Object.assign(store.state, emptyState(), parsed);
      _syncSeq(store.state.elements);
      store.selectedIds = store.selectedIds.filter((id) => store.getElement(id));
      setTimeout(() => {
        store.restoring = false;
      }, 0);
    },
    undo() {
      if (!store.canUndo) return;
      store._hi -= 1;
      store._restore(store._hist[store._hi]);
    },
    redo() {
      if (!store.canRedo) return;
      store._hi += 1;
      store._restore(store._hist[store._hi]);
    },
    resetHistory() {
      store._hist = [JSON.stringify(store.state)];
      store._hi = 0;
    },
    select(id, additive = false) {
      if (id == null) {
        store.selectedIds = [];
        return;
      }
      const members = _expandGroups(store.state.elements, [id]);
      if (additive) {
        const allSel = members.every((m) => store.selectedIds.includes(m));
        if (allSel) store.selectedIds = store.selectedIds.filter((x) => !members.includes(x));
        else for (const m of members) if (!store.selectedIds.includes(m)) store.selectedIds.push(m);
      } else {
        store.selectedIds = [...members.filter((m) => m !== id), id];
      }
    },
    setSelection(ids, additive = false) {
      const valid = _expandGroups(store.state.elements, ids.filter((id) => store.getElement(id)));
      if (additive) {
        for (const id of valid) if (!store.selectedIds.includes(id)) store.selectedIds.push(id);
      } else {
        store.selectedIds = valid;
      }
    },
    addElement(label, bbox = null) {
      if (!bbox) {
        const w = store.state.width, h2 = store.state.height;
        const o = store.state.elements.length % 6 * 32;
        bbox = [
          Math.round(w * 0.2) + o,
          Math.round(h2 * 0.2) + o,
          Math.round(w * 0.55) + o,
          Math.round(h2 * 0.55) + o
        ];
      }
      const el = newElement(label, bbox);
      store.state.elements.push(el);
      store.select(el.id);
      return el;
    },
    removeElement(id) {
      const src = store.getElement(id);
      const lid = (src == null ? void 0 : src.linkId) ?? null;
      const grp = (src == null ? void 0 : src.groupId) ?? null;
      const i = store.state.elements.findIndex((e) => e.id === id);
      if (i >= 0) store.state.elements.splice(i, 1);
      store.selectedIds = store.selectedIds.filter((x) => x !== id);
      _pruneLink(store.state.elements, lid);
      _pruneGroup(store.state.elements, grp);
    },
    _copyOf(src, dx) {
      const copy = newElement(src.label, [...src.bbox]);
      copy.caption = src.caption;
      copy.text = src.text;
      copy.tags = [...src.tags];
      copy.palette = [...src.palette];
      copy.boxColor = src.boxColor;
      copy.bbox = copy.bbox.map((v, idx) => {
        const max = idx % 2 === 0 ? store.state.width : store.state.height;
        return Math.max(0, Math.min(max, v + dx));
      });
      return copy;
    },
    duplicateElement(id) {
      const src = store.getElement(id);
      if (!src) return;
      const copy = store._copyOf(src, 24);
      store.state.elements.push(copy);
      store.select(copy.id);
    },
    // Copies of a single group form a new group.
    duplicateMany(ids) {
      const srcs = ids.map((id) => store.getElement(id)).filter((e) => !!e);
      if (!srcs.length) return;
      const wasGroup = srcs.length > 1 && !!srcs[0].groupId && srcs.every((e) => e.groupId === srcs[0].groupId);
      const gid = wasGroup ? newId() : null;
      const copyIds = [];
      for (const src of srcs) {
        const copy = store._copyOf(src, 24);
        copy.groupId = gid;
        store.state.elements.push(copy);
        copyIds.push(copy.id);
      }
      store.setSelection(copyIds);
    },
    flipAll(axis) {
      for (const el of store.state.elements) _flipBbox(el, axis, store.state.width, store.state.height);
    },
    duplicateLinked(id) {
      const src = store.getElement(id);
      if (!src) return;
      if (!src.linkId) src.linkId = newId();
      const copy = store._copyOf(src, 32);
      copy.linkId = src.linkId;
      store.state.elements.push(copy);
      store.select(copy.id);
    },
    unlink(id) {
      const el = store.getElement(id);
      if (!(el == null ? void 0 : el.linkId)) return;
      const gid = el.linkId;
      el.linkId = null;
      _pruneLink(store.state.elements, gid);
    },
    linkGroupSize(id) {
      const el = store.getElement(id);
      if (!(el == null ? void 0 : el.linkId)) return 1;
      return store.state.elements.filter((e) => e.linkId === el.linkId).length;
    },
    group(ids) {
      const valid = ids.filter((id) => store.getElement(id));
      if (valid.length < 2) return;
      const gid = newId();
      for (const id of valid) {
        const e = store.getElement(id);
        if (e) e.groupId = gid;
      }
      store.selectedIds = _expandGroups(store.state.elements, valid);
    },
    ungroup(id) {
      const el = store.getElement(id);
      if (!(el == null ? void 0 : el.groupId)) return;
      const gid = el.groupId;
      for (const e of store.state.elements) if (e.groupId === gid) e.groupId = null;
    },
    groupMembers(id) {
      const el = store.getElement(id);
      if (!(el == null ? void 0 : el.groupId)) return el ? [el] : [];
      return store.state.elements.filter((e) => e.groupId === el.groupId);
    },
    groupSize(id) {
      const el = store.getElement(id);
      if (!(el == null ? void 0 : el.groupId)) return 1;
      return store.state.elements.filter((e) => e.groupId === el.groupId).length;
    },
    copySelection() {
      const els = store.selectedIds.map((id) => store.getElement(id)).filter((e) => !!e);
      if (!els.length) return;
      const grouped = els.length > 1 && !!els[0].groupId && els.every((e) => e.groupId === els[0].groupId);
      store.clipboard = els.map((e) => ({
        label: e.label,
        bbox: [...e.bbox],
        caption: e.caption,
        text: e.text,
        tags: [...e.tags],
        palette: [...e.palette],
        boxColor: e.boxColor,
        grouped
      }));
    },
    // Paste centered on (x,y) in pixel coords, preserving relative layout; a copied
    // group pastes as a new group. Falls back to stored positions if x/y are invalid.
    pasteAt(x, y) {
      const clip = store.clipboard;
      if (!clip.length) return;
      const W = store.state.width, H = store.state.height;
      const boxed = clip.filter((c) => c.bbox);
      let dx = 0;
      let dy = 0;
      if (boxed.length && Number.isFinite(x) && Number.isFinite(y)) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const c of boxed) {
          x0 = Math.min(x0, c.bbox[0]);
          y0 = Math.min(y0, c.bbox[1]);
          x1 = Math.max(x1, c.bbox[2]);
          y1 = Math.max(y1, c.bbox[3]);
        }
        dx = Math.max(-x0, Math.min(W - x1, Math.round(x - (x0 + x1) / 2)));
        dy = Math.max(-y0, Math.min(H - y1, Math.round(y - (y0 + y1) / 2)));
      }
      const grouped = clip.length > 1 && clip.every((c) => c.grouped);
      const gid = grouped ? newId() : null;
      const ids = [];
      for (const c of clip) {
        const el = store._copyOf({ ...c, id: "", linkId: null, groupId: null, bbox: c.bbox ?? [0, 0, 64, 64] }, 0);
        el.groupId = gid;
        if (c.bbox && (dx || dy)) {
          const [bx1, by1, bx2, by2] = el.bbox;
          el.bbox = [bx1 + dx, by1 + dy, bx2 + dx, by2 + dy];
        }
        store.state.elements.push(el);
        ids.push(el.id);
      }
      store.setSelection(ids);
    },
    setShared(id, key, value) {
      const el = store.getElement(id);
      if (!el) return;
      const members = el.linkId ? store.state.elements.filter((e) => e.linkId === el.linkId) : [el];
      for (const m of members) Object.assign(m, { [key]: value });
    },
    moveElement(id, dir) {
      const i = store.state.elements.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= store.state.elements.length) return;
      const arr = store.state.elements;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    },
    moveElementTo(id, index) {
      const arr = store.state.elements;
      const from = arr.findIndex((e) => e.id === id);
      if (from < 0) return;
      const to = Math.max(0, Math.min(arr.length - 1, index));
      if (from === to) return;
      const [el] = arr.splice(from, 1);
      arr.splice(to, 0, el);
    },
    getElement(id) {
      return store.state.elements.find((e) => e.id === id);
    },
    refitToCanvas() {
      const w = store.state.width;
      const h2 = store.state.height;
      let changed = 0;
      for (const el of store.state.elements) {
        let box = clampBbox(el.bbox, w, h2);
        if (!(box[0] < box[2] && box[1] < box[3])) {
          const cx = Math.max(0, Math.min(w, Math.round((el.bbox[0] + el.bbox[2]) / 2)));
          const cy = Math.max(0, Math.min(h2, Math.round((el.bbox[1] + el.bbox[3]) / 2)));
          const x1 = Math.max(0, Math.min(w - 16, cx - 8));
          const y1 = Math.max(0, Math.min(h2 - 16, cy - 8));
          box = [x1, y1, Math.min(w, x1 + 16), Math.min(h2, y1 + 16)];
        }
        if (box.some((v, i) => v !== el.bbox[i])) {
          el.bbox = box;
          changed += 1;
        }
      }
      if (changed) store.snapshot();
      return changed;
    },
    load(s) {
      Object.assign(store.state, emptyState(), s);
      store.state.ui = { ...emptyUi(), ...s.ui || {} };
      _syncSeq(store.state.elements);
    },
    json: {
      editing: false,
      draft: "",
      syncError: "",
      syncWarnings: [],
      syncNote: "",
      applyErrors: [],
      applyWarnings: [],
      wasOpen: false
    },
    refImage: "",
    clipboard: [],
    ctxMenu: null,
    openContextMenu(x, y, id) {
      store.ctxMenu = { x, y, id };
    },
    closeContextMenu() {
      store.ctxMenu = null;
    },
    jsonStartEdit() {
      store.json.draft = serialize(store.state).draftPretty;
      store.json.applyErrors = [];
      store.json.applyWarnings = [];
      store.json.wasOpen = store.state.ui.jsonOpen;
      store.json.editing = true;
      store.state.ui.jsonOpen = true;
    },
    jsonCancel() {
      store.json.editing = false;
      store.state.ui.jsonOpen = store.json.wasOpen;
    },
    jsonTidy() {
      const res = parseJsonLoose(store.json.draft);
      if (res.ok) store.json.draft = JSON.stringify(res.obj, null, 2);
    },
    jsonApply() {
      const res = store.importDraftJson(store.json.draft);
      store.json.applyErrors = res.errors ?? (res.error ? [res.error] : []);
      store.json.applyWarnings = res.warnings ?? [];
      if (res.ok) {
        store.json.editing = false;
        store.state.ui.jsonOpen = store.json.wasOpen;
      }
    },
    jsonApplyClamp() {
      const res = store.importDraftJson(store.json.draft, { bboxMode: "clamp" });
      store.json.applyErrors = res.errors ?? (res.error ? [res.error] : []);
      store.json.applyWarnings = res.warnings ?? [];
      if (res.ok) {
        store.json.editing = false;
        store.state.ui.jsonOpen = store.json.wasOpen;
        store.json.syncError = "";
        store.json.syncWarnings = res.warnings ?? [];
        const n = store.state.elements.length;
        const warnCount = store.json.syncWarnings.length;
        const warnNote = warnCount ? ` · ${warnCount} warning${warnCount === 1 ? "" : "s"}` : "";
        store.json.syncNote = `Clamped import applied · ${n} item${n === 1 ? "" : "s"}${warnNote}`;
      }
    },
    importDraftJson(text, opts = {}) {
      var _a, _b;
      const keepDims = opts.keepDims ?? false;
      const strict = opts.strict ?? true;
      const bboxMode = opts.bboxMode ?? (strict ? "reject" : "clamp");
      const bboxTolerance = opts.bboxTolerance ?? 2;
      const res = parseJsonLoose(text);
      if (!res.ok) return { ok: false, error: res.error, errors: [res.error], warnings: [] };
      const { state, warnings, errors } = resolveToState(
        ((_a = res.obj) == null ? void 0 : _a.draft) || res.obj,
        keepDims ? store.state.width : 1024,
        keepDims ? store.state.height : 1024,
        { strict, bboxMode, bboxTolerance }
      );
      if (errors.length) {
        return { ok: false, error: errors.join("; "), errors, warnings };
      }
      const curUi = store.state.ui;
      const curOverlay = store.state.overlay;
      const stored = matchingStudio((_b = res.obj) == null ? void 0 : _b.studio, serialize(state).draft);
      store.load(stored || { ...state, ui: curUi, overlay: curOverlay });
      if (!keepDims && state.width) store.state.width = state.width;
      if (!keepDims && state.height) store.state.height = state.height;
      store.select(null);
      store.snapshot();
      return { ok: true, warnings, errors: [] };
    }
  });
  return store;
}
function _syncSeq(elements) {
  syncSeq(elements.flatMap((e) => [e.id, e.linkId, e.groupId]));
}
function provideStudioStore(store) {
  provide(KEY, store);
}
function useStudioStore() {
  return inject(KEY);
}
const _hoisted_1$d = ["aria-label"];
const _sfc_main$e = /* @__PURE__ */ defineComponent({
  __name: "UiButton",
  props: {
    variant: { default: "default" },
    active: { type: Boolean, default: false },
    icon: { type: Boolean, default: false }
  },
  setup(__props) {
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("button", {
        type: "button",
        "aria-label": String(_ctx.$attrs["aria-label"] || _ctx.$attrs.title || "") || void 0,
        class: normalizeClass(["ui-btn", [__props.variant, { on: __props.active, icon: __props.icon }]])
      }, [
        renderSlot(_ctx.$slots, "default", {}, void 0)
      ], 10, _hoisted_1$d);
    };
  }
});
const _export_sfc = (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) {
    target[key] = val;
  }
  return target;
};
const UiButton = /* @__PURE__ */ _export_sfc(_sfc_main$e, [["__scopeId", "data-v-7a0f70ea"]]);
const _sfc_main$d = /* @__PURE__ */ defineComponent({
  __name: "UiPopover",
  props: {
    align: { default: "right" },
    up: { type: Boolean, default: false }
  },
  setup(__props) {
    const open = /* @__PURE__ */ ref(false);
    const root = /* @__PURE__ */ ref(null);
    function onDoc(e) {
      if (root.value && !root.value.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    function bind() {
      document.addEventListener("pointerdown", onDoc, true);
      document.addEventListener("keydown", onKey);
    }
    function unbind() {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    }
    function close() {
      open.value = false;
      unbind();
    }
    function toggle() {
      open.value = !open.value;
      open.value ? bind() : unbind();
    }
    onBeforeUnmount(unbind);
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("span", {
        ref_key: "root",
        ref: root,
        class: "ui-pop"
      }, [
        createBaseVNode("span", {
          class: "ui-pop-trigger",
          onClick: toggle
        }, [
          renderSlot(_ctx.$slots, "trigger", {}, void 0)
        ]),
        open.value ? (openBlock(), createElementBlock("div", {
          key: 0,
          class: normalizeClass(["ui-pop-panel", [__props.align, { up: __props.up }]]),
          onPointerdown: _cache[0] || (_cache[0] = withModifiers(() => {
          }, ["stop"]))
        }, [
          renderSlot(_ctx.$slots, "default", { close }, void 0)
        ], 34)) : createCommentVNode("", true)
      ], 512);
    };
  }
});
const UiPopover = /* @__PURE__ */ _export_sfc(_sfc_main$d, [["__scopeId", "data-v-3afe332d"]]);
const _hoisted_1$c = {
  key: 0,
  class: "divider"
};
const _hoisted_2$c = { class: "cmenu" };
const _hoisted_3$b = { class: "crow" };
const _hoisted_4$8 = {
  key: 2,
  class: "divider"
};
const _hoisted_5$8 = { class: "cmenu" };
const _hoisted_6$7 = { class: "crow" };
const _hoisted_7$6 = { class: "crow" };
const _hoisted_8$5 = { class: "crow" };
const _hoisted_9$5 = { class: "crow" };
const _hoisted_10$5 = { class: "crow ckrow" };
const _hoisted_11$5 = {
  key: 0,
  role: "alert",
  style: { "color": "var(--error-text,#d95d5d)" }
};
const _hoisted_12$5 = ["src"];
const _hoisted_13$4 = ["src"];
const _hoisted_14$4 = {
  key: 2,
  class: "livebadge"
};
const _hoisted_15$3 = ["data-box"];
const _hoisted_16$2 = {
  key: 0,
  class: "gseg"
};
const _hoisted_17$2 = { class: "tagn" };
const _hoisted_18$2 = { class: "tagt" };
const _hoisted_19$2 = ["data-handle"];
const _hoisted_20$2 = ["data-handle"];
const MIN_SPAN = 10;
const _sfc_main$c = /* @__PURE__ */ defineComponent({
  __name: "BBoxCanvas",
  props: {
    backdrop: {},
    hideRef: { type: Boolean },
    prepareReference: { type: Function }
  },
  setup(__props) {
    const store = useStudioStore();
    const canvasWrap = /* @__PURE__ */ ref(null);
    const fit = /* @__PURE__ */ ref({ width: "100%", height: "100%" });
    let fitFrame = 0;
    let fitObserver;
    function fitCanvas() {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        const wrap = canvasWrap.value;
        if (!wrap || !wrap.clientWidth || !wrap.clientHeight) return;
        const toolbar = wrap.querySelector(".toolbar");
        const available = Math.max(40, wrap.clientHeight - ((toolbar == null ? void 0 : toolbar.offsetHeight) || 0) - 8);
        const ratio = store.state.width / store.state.height;
        const width = Math.min(wrap.clientWidth, available * ratio);
        fit.value = { width: `${width}px`, height: `${width / ratio}px` };
      });
    }
    onMounted(() => {
      fitObserver = new ResizeObserver(fitCanvas);
      fitObserver.observe(canvasWrap.value);
      fitCanvas();
    });
    onBeforeUnmount(() => {
      fitObserver == null ? void 0 : fitObserver.disconnect();
      cancelAnimationFrame(fitFrame);
    });
    watch(() => [store.state.width, store.state.height], fitCanvas);
    const props = __props;
    const referenceError = /* @__PURE__ */ ref("");
    const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    const drawMode = /* @__PURE__ */ ref(false);
    const newType = computed({ get: () => store.state.ui.newType, set: (v) => store.state.ui.newType = v });
    const showLabels = computed({ get: () => store.state.ui.showLabels, set: (v) => store.state.ui.showLabels = v });
    const backdropOpacity = computed({ get: () => store.state.ui.backdropOpacity, set: (v) => store.state.ui.backdropOpacity = v });
    const syncRef = computed({ get: () => store.state.ui.sync, set: (v) => store.state.ui.sync = v });
    const livePreview = computed({ get: () => store.state.ui.livePreview, set: (v) => store.state.ui.livePreview = v });
    const backdropUrl = computed({ get: () => store.state.ui.referenceImage || null, set: (v) => {
      store.state.ui.referenceImage = v;
    } });
    const effectiveBackdrop = computed(() => props.backdrop ?? backdropUrl.value);
    const previewSyncImage = computed(() => store.previewImage || null);
    watch(effectiveBackdrop, (v) => store.refImage = v || "", { immediate: true });
    function onBackdropLoad(e) {
      if (props.backdrop == null) return;
      const img = e.target;
      if (img.naturalWidth && img.naturalHeight) {
        store.state.width = snapDim(img.naturalWidth);
        store.state.height = snapDim(img.naturalHeight);
      }
    }
    const fileInput = /* @__PURE__ */ ref(null);
    function toggleSync() {
      syncRef.value = !syncRef.value;
    }
    function pickImage() {
      var _a;
      (_a = fileInput.value) == null ? void 0 : _a.click();
    }
    function readImage(f) {
      referenceError.value = "";
      if (f.type === "image/svg+xml" || /\.svg$/i.test(f.name)) {
        referenceError.value = "请载入 PNG、JPEG 或 WebP 等位图参考图。";
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        const image = new Image();
        image.onerror = () => {
          referenceError.value = "无法读取这张参考图，请使用浏览器支持的图片格式。";
        };
        image.onload = async () => {
          if (unmounted) return;
          let source = r.result;
          try {
            if (props.prepareReference) source = await props.prepareReference(source);
          } catch (e) {
            if (!unmounted) referenceError.value = String(e.message || e);
            return;
          }
          if (unmounted) return;
          store.snapshot();
          const sx = image.naturalWidth / store.state.width, sy = image.naturalHeight / store.state.height;
          store.state.elements.forEach((el) => {
            el.bbox = el.bbox.map((v, i) => Math.round(v * (i % 2 ? sy : sx)));
          });
          store.state.width = image.naturalWidth;
          store.state.height = image.naturalHeight;
          backdropUrl.value = source;
          store.snapshot();
        };
        image.src = r.result;
      };
      r.readAsDataURL(f);
    }
    let unmounted = false;
    onBeforeUnmount(() => {
      unmounted = true;
    });
    function onFile(e) {
      var _a;
      const f = (_a = e.target.files) == null ? void 0 : _a[0];
      if (f) readImage(f);
      e.target.value = "";
    }
    function onDrop(e) {
      var _a, _b;
      e.preventDefault();
      const f = (_b = (_a = e.dataTransfer) == null ? void 0 : _a.files) == null ? void 0 : _b[0];
      if (f && f.type.startsWith("image/")) readImage(f);
    }
    const stage = /* @__PURE__ */ ref(null);
    const draft = /* @__PURE__ */ ref(null);
    const marquee = /* @__PURE__ */ ref(null);
    const hint = /* @__PURE__ */ ref("");
    const boxed = computed(() => store.state.elements);
    function labelIcon(label) {
      return label === "text" ? "mdi-format-text" : label === "character" ? "mdi-account-outline" : "mdi-vector-square";
    }
    const selectedBoxes = computed(
      () => store.selectedIds.map((id) => store.getElement(id)).filter((e) => !!e)
    );
    const groupBox = computed(() => {
      if (selectedBoxes.value.length < 2) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const e of selectedBoxes.value) {
        const [a, b, c, d] = e.bbox;
        x0 = Math.min(x0, a);
        y0 = Math.min(y0, b);
        x1 = Math.max(x1, c);
        y1 = Math.max(y1, d);
      }
      return [x0, y0, x1, y1];
    });
    const groupFrameColor = computed(() => {
      const els = selectedBoxes.value;
      if (els.length < 2) return "";
      const gid = els[0].groupId;
      return gid && els.every((e) => e.groupId === gid) ? groupColor(gid) : "";
    });
    function rectStyle(b) {
      const W = store.state.width, H = store.state.height;
      const x0 = Math.min(b[0], b[2]), x1 = Math.max(b[0], b[2]);
      const y0 = Math.min(b[1], b[3]), y1 = Math.max(b[1], b[3]);
      return {
        left: `${x0 / W * 100}%`,
        top: `${y0 / H * 100}%`,
        width: `${(x1 - x0) / W * 100}%`,
        height: `${(y1 - y0) / H * 100}%`
      };
    }
    const groupStyle = computed(() => {
      const b = groupBox.value;
      if (!b) return {};
      const s = rectStyle(b);
      if (groupFrameColor.value) s["--gc"] = groupFrameColor.value;
      return s;
    });
    const marqueeStyle = computed(() => marquee.value ? rectStyle(marquee.value) : {});
    const stageStyle = computed(() => ({ ...fit.value, aspectRatio: `${store.state.width} / ${store.state.height}` }));
    function hexToRgba(hex, a) {
      const h2 = hex.replace("#", "");
      const r = parseInt(h2.slice(0, 2), 16) || 0;
      const g = parseInt(h2.slice(2, 4), 16) || 0;
      const b = parseInt(h2.slice(4, 6), 16) || 0;
      return `rgba(${r},${g},${b},${a})`;
    }
    function boxStyle(el) {
      const color = el.boxColor || "#60a5fa";
      return {
        ...rectStyle(el.bbox),
        borderColor: color,
        "--c": color,
        "--fill": hexToRgba(color, 0.16)
      };
    }
    function tagStyle(el) {
      const s = { background: hexToRgba(el.boxColor || "#60a5fa", 0.88), color: "#fff" };
      if (el.groupId) s["--gc"] = groupColor(el.groupId);
      return s;
    }
    function pointToCoords(ev) {
      const r = stage.value.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(store.state.width, Math.round((ev.clientX - r.left) / r.width * store.state.width))),
        y: Math.max(0, Math.min(store.state.height, Math.round((ev.clientY - r.top) / r.height * store.state.height)))
      };
    }
    let drag = null;
    let lastPointer = { x: 512, y: 512 };
    function boxesUnder(p2) {
      return store.state.elements.filter((el) => p2.x >= el.bbox[0] && p2.x <= el.bbox[2] && p2.y >= el.bbox[1] && p2.y <= el.bbox[3]).map((el) => el.id);
    }
    function onPointerDown(ev) {
      var _a, _b;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.button !== 0) return;
      try {
        stage.value.setPointerCapture(ev.pointerId);
      } catch {
      }
      (_a = stage.value) == null ? void 0 : _a.focus({ preventScroll: true });
      const target = ev.target;
      const handle = target.dataset.handle;
      const isGroupHandle = !!target.dataset.group;
      const boxId = ((_b = target.closest("[data-box]")) == null ? void 0 : _b.getAttribute("data-box")) ?? void 0;
      const start = pointToCoords(ev);
      const drawMod = drawMode.value || ev.ctrlKey || ev.metaKey;
      const additive = ev.shiftKey;
      if (handle && isGroupHandle && groupBox.value) {
        drag = {
          kind: "resize-group",
          handle,
          start,
          moved: false,
          groupStart: [...groupBox.value],
          groupTargets: selectedBoxes.value.map((e) => ({ el: e, start: [...e.bbox] }))
        };
        return;
      }
      if (handle && store.selectedId && store.selectedIds.length === 1) {
        const el = store.getElement(store.selectedId);
        if (el) {
          drag = { kind: "resize", el, handle, start, moved: false };
          return;
        }
      }
      if (drawMod) {
        draft.value = [start.x, start.y, start.x, start.y];
        drag = { kind: "draw", start, moved: false, ctrlClick: true, clickedId: boxId };
        return;
      }
      if (boxId) {
        if (additive) {
          store.select(boxId, true);
          return;
        }
        const wasPrimary = store.selectedIds.length === 1 && store.selectedId === boxId;
        const wasClickedPrimary = store.selectedId === boxId;
        if (!store.isSelected(boxId)) store.select(boxId);
        const moveTargets = store.selectedIds.map((id) => store.getElement(id)).filter((e) => !!e).map((e) => ({ el: e, start: [...e.bbox] }));
        drag = { kind: "move", start, moved: false, moveTargets, clickedId: boxId, wasPrimary, wasClickedPrimary };
        return;
      }
      marquee.value = [start.x, start.y, start.x, start.y];
      drag = { kind: "marquee", start, moved: false, additive };
    }
    function onPointerMove(ev) {
      lastPointer = pointToCoords(ev);
      if (!drag) return;
      ev.preventDefault();
      const p2 = pointToCoords(ev);
      if (Math.abs(p2.x - drag.start.x) > 2 || Math.abs(p2.y - drag.start.y) > 2) drag.moved = true;
      if (drag.kind === "draw") {
        draft.value = [Math.min(drag.start.x, p2.x), Math.min(drag.start.y, p2.y), Math.max(drag.start.x, p2.x), Math.max(drag.start.y, p2.y)];
        hint.value = bboxLabel(draft.value);
      } else if (drag.kind === "marquee") {
        marquee.value = [Math.min(drag.start.x, p2.x), Math.min(drag.start.y, p2.y), Math.max(drag.start.x, p2.x), Math.max(drag.start.y, p2.y)];
      } else if (drag.kind === "resize-group" && drag.groupStart && drag.groupTargets && drag.handle) {
        const [ox0, oy0, ox1, oy1] = drag.groupStart;
        let gx0 = ox0, gy0 = oy0, gx1 = ox1, gy1 = oy1;
        if (drag.handle.includes("n")) gy0 = Math.min(p2.y, oy1 - MIN_SPAN);
        if (drag.handle.includes("s")) gy1 = Math.max(p2.y, oy0 + MIN_SPAN);
        if (drag.handle.includes("w")) gx0 = Math.min(p2.x, ox1 - MIN_SPAN);
        if (drag.handle.includes("e")) gx1 = Math.max(p2.x, ox0 + MIN_SPAN);
        const sx = ox1 - ox0 ? (gx1 - gx0) / (ox1 - ox0) : 1;
        const sy = oy1 - oy0 ? (gy1 - gy0) / (oy1 - oy0) : 1;
        for (const t of drag.groupTargets) {
          const [x0, y0, x1, y1] = t.start;
          t.el.bbox = [
            clampCoord(gx0 + (x0 - ox0) * sx, store.state.width),
            clampCoord(gy0 + (y0 - oy0) * sy, store.state.height),
            clampCoord(gx1 + (x1 - ox0) * sx, store.state.width),
            clampCoord(gy1 + (y1 - oy0) * sy, store.state.height)
          ];
        }
      } else if (drag.kind === "move" && drag.moveTargets) {
        const targets = drag.moveTargets;
        let dx = p2.x - drag.start.x;
        let dy = p2.y - drag.start.y;
        let loX = -Infinity, hiX = Infinity, loY = -Infinity, hiY = Infinity;
        for (const t of targets) {
          const [x0, y0, x1, y1] = t.start;
          loX = Math.max(loX, -x0);
          hiX = Math.min(hiX, store.state.width - x1);
          loY = Math.max(loY, -y0);
          hiY = Math.min(hiY, store.state.height - y1);
        }
        dx = Math.max(loX, Math.min(hiX, dx));
        dy = Math.max(loY, Math.min(hiY, dy));
        for (const t of targets) {
          const [x0, y0, x1, y1] = t.start;
          t.el.bbox = [Math.round(x0 + dx), Math.round(y0 + dy), Math.round(x1 + dx), Math.round(y1 + dy)];
        }
        if (targets.length === 1) hint.value = bboxLabel(targets[0].el.bbox);
      } else if (drag.kind === "resize" && drag.el && drag.handle) {
        const [x0, y0, x1, y1] = drag.el.bbox;
        let nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1;
        if (drag.handle.includes("n")) ny0 = Math.min(p2.y, y1 - 2);
        if (drag.handle.includes("s")) ny1 = Math.max(p2.y, y0 + 2);
        if (drag.handle.includes("w")) nx0 = Math.min(p2.x, x1 - 2);
        if (drag.handle.includes("e")) nx1 = Math.max(p2.x, x0 + 2);
        drag.el.bbox = [nx0, ny0, nx1, ny1];
        hint.value = bboxLabel(drag.el.bbox);
      }
    }
    function onPointerUp(ev) {
      if (!drag) return;
      try {
        stage.value.releasePointerCapture(ev.pointerId);
      } catch {
      }
      if (drag.kind === "draw") {
        const b = draft.value;
        draft.value = null;
        if (b && b[2] - b[0] >= 8 && b[3] - b[1] >= 8) {
          store.addElement(newType.value, b);
          drawMode.value = false;
          nextTick(() => {
            var _a, _b;
            const field = (_b = (_a = stage.value) == null ? void 0 : _a.closest(".studio")) == null ? void 0 : _b.querySelector('textarea[aria-label="区域描述"]');
            field == null ? void 0 : field.focus({ preventScroll: true });
          });
        } else if (!drag.moved && drag.ctrlClick && drag.clickedId) {
          store.select(drag.clickedId, true);
        }
      } else if (drag.kind === "marquee") {
        const m = marquee.value;
        marquee.value = null;
        if (drag.moved && m) {
          const ids = store.state.elements.filter((el) => intersects(el.bbox, m)).map((el) => el.id);
          store.setSelection(ids, drag.additive);
        } else if (!drag.moved && !drag.additive) {
          store.select(null);
        }
      } else if (drag.kind === "move" && !drag.moved && drag.clickedId) {
        const el = store.getElement(drag.clickedId);
        if (el == null ? void 0 : el.groupId) {
          if (drag.wasClickedPrimary) store.select(null);
          else store.select(drag.clickedId);
        } else if (store.selectedIds.length > 1) {
          store.select(drag.clickedId);
        } else if (drag.wasPrimary) {
          const ids = boxesUnder(drag.start);
          if (ids.length > 1) {
            const ci = ids.indexOf(drag.clickedId);
            store.select(ids[ci === -1 ? 0 : (ci + 1) % ids.length]);
          }
        }
      }
      drag = null;
      hint.value = "";
    }
    function onKeyDown(ev) {
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod && ["b", "v"].includes(ev.key.toLowerCase())) {
        drawMode.value = ev.key.toLowerCase() === "b";
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const step = ev.shiftKey ? 10 : 1;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (delta[ev.key] && store.selectedIds.length) {
        ev.preventDefault();
        ev.stopPropagation();
        const targets = selectedBoxes.value;
        let [dx, dy] = delta[ev.key];
        dx = Math.max(-Math.min(...targets.map((e) => e.bbox[0])), Math.min(dx, store.state.width - Math.max(...targets.map((e) => e.bbox[2]))));
        dy = Math.max(-Math.min(...targets.map((e) => e.bbox[1])), Math.min(dy, store.state.height - Math.max(...targets.map((e) => e.bbox[3]))));
        store.snapshot();
        targets.forEach((e) => {
          const b = e.bbox;
          e.bbox = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
        });
        store.snapshot();
        return;
      }
      if (mod && (ev.key === "c" || ev.key === "C")) {
        ev.preventDefault();
        ev.stopPropagation();
        store.copySelection();
        return;
      }
      if (mod && (ev.key === "v" || ev.key === "V")) {
        ev.preventDefault();
        ev.stopPropagation();
        store.pasteAt(lastPointer.x, lastPointer.y);
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "g" || ev.key === "G")) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.shiftKey) {
          if (store.selectedId) store.ungroup(store.selectedId);
        } else if (store.selectedIds.length >= 2) {
          store.group(store.selectedIds);
        }
        return;
      }
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      if (!store.selectedIds.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      for (const id of [...store.selectedIds]) store.removeElement(id);
      store.snapshot();
    }
    function onContextMenu(ev) {
      var _a;
      const id = (_a = ev.target.closest("[data-box]")) == null ? void 0 : _a.getAttribute("data-box");
      if (!id) return;
      if (!store.isSelected(id)) store.select(id);
      store.openContextMenu(ev.clientX, ev.clientY, id);
    }
    function bboxLabel(b) {
      return `bbox [x${b[0]} y${b[1]} x${b[2]} y${b[3]}]  ·  ${b[2] - b[0]}×${b[3] - b[1]}`;
    }
    function clampCoord(v, max) {
      return Math.max(0, Math.min(max, Math.round(v)));
    }
    function intersects(a, m) {
      return a[0] < m[2] && a[2] > m[0] && a[1] < m[3] && a[3] > m[1];
    }
    return (_ctx, _cache) => {
      const _component_MdiIcon = resolveComponent("MdiIcon");
      return openBlock(), createElementBlock("div", {
        class: "canvas-wrap",
        ref_key: "canvasWrap",
        ref: canvasWrap
      }, [
        createBaseVNode("div", {
          class: "toolbar",
          onPointerdown: _cache[14] || (_cache[14] = withModifiers(() => {
          }, ["stop"]))
        }, [
          renderSlot(_ctx.$slots, "lead", {}, void 0),
          createVNode(UiButton, {
            active: drawMode.value,
            title: "拖动即可画框（B）；画完自动回到选择工具",
            onClick: _cache[0] || (_cache[0] = ($event) => drawMode.value = true)
          }, {
            default: withCtx(() => [..._cache[16] || (_cache[16] = [
              createTextVNode("画框", -1)
            ])]),
            _: 1
          }, 8, ["active"]),
          createVNode(UiButton, {
            active: !drawMode.value,
            title: "选择、框选、移动（V）",
            onClick: _cache[1] || (_cache[1] = ($event) => drawMode.value = false)
          }, {
            default: withCtx(() => [..._cache[17] || (_cache[17] = [
              createTextVNode("选择", -1)
            ])]),
            _: 1
          }, 8, ["active"]),
          withDirectives(createBaseVNode("select", {
            "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => newType.value = $event),
            "aria-label": "新区域类型"
          }, [..._cache[18] || (_cache[18] = [
            createBaseVNode("option", { value: "character" }, "人物", -1),
            createBaseVNode("option", { value: "object" }, "物体", -1),
            createBaseVNode("option", { value: "text" }, "文字", -1)
          ])], 512), [
            [vModelSelect, newType.value]
          ]),
          _ctx.$slots.lead ? (openBlock(), createElementBlock("span", _hoisted_1$c)) : createCommentVNode("", true),
          _cache[36] || (_cache[36] = createBaseVNode("span", { class: "divider" }, null, -1)),
          !__props.hideRef ? (openBlock(), createBlock(UiPopover, {
            key: 1,
            align: "left"
          }, {
            trigger: withCtx(() => [
              createVNode(UiButton, {
                icon: "",
                active: !!backdropUrl.value || syncRef.value,
                title: "参考图 / 描摹底图"
              }, {
                default: withCtx(() => [
                  createVNode(_component_MdiIcon, { class: "mdi mdi-image-outline" })
                ]),
                _: 1
              }, 8, ["active"])
            ]),
            default: withCtx(() => [
              createBaseVNode("div", _hoisted_2$c, [
                createBaseVNode("button", {
                  class: "citem",
                  onClick: pickImage
                }, [
                  createVNode(_component_MdiIcon, { class: "mdi mdi-folder-image" }),
                  _cache[19] || (_cache[19] = createTextVNode(" 载入参考图…", -1))
                ]),
                createBaseVNode("button", {
                  class: normalizeClass(["citem", { on: syncRef.value }]),
                  title: "连接 TK MOSS Layout Preview 节点，同步生成结果作为底图",
                  onClick: toggleSync
                }, [
                  createVNode(_component_MdiIcon, {
                    class: normalizeClass(["mdi", syncRef.value ? "mdi-sync" : "mdi-sync-off"])
                  }, null, 8, ["class"]),
                  _cache[20] || (_cache[20] = createTextVNode(" 同步生成结果", -1))
                ], 2),
                createBaseVNode("button", {
                  class: normalizeClass(["citem", { on: livePreview.value }]),
                  title: "预览节点上游采样过程；连接 TK MOSS Layout Preview 后生效",
                  onClick: _cache[3] || (_cache[3] = ($event) => livePreview.value = !livePreview.value)
                }, [
                  createVNode(_component_MdiIcon, {
                    class: normalizeClass(["mdi", livePreview.value ? "mdi-television-play" : "mdi-television-off"])
                  }, null, 8, ["class"]),
                  _cache[21] || (_cache[21] = createTextVNode(" 采样实时预览", -1))
                ], 2),
                createBaseVNode("label", _hoisted_3$b, [
                  _cache[22] || (_cache[22] = createTextVNode("底图透明度 ", -1)),
                  withDirectives(createBaseVNode("input", {
                    type: "range",
                    min: "0",
                    max: "1",
                    step: "0.05",
                    "onUpdate:modelValue": _cache[4] || (_cache[4] = ($event) => backdropOpacity.value = $event)
                  }, null, 512), [
                    [
                      vModelText,
                      backdropOpacity.value,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                backdropUrl.value ? (openBlock(), createElementBlock("button", {
                  key: 0,
                  class: "citem",
                  onClick: _cache[5] || (_cache[5] = ($event) => backdropUrl.value = null)
                }, [
                  createVNode(_component_MdiIcon, { class: "mdi mdi-close" }),
                  _cache[23] || (_cache[23] = createTextVNode(" 移除参考图", -1))
                ])) : createCommentVNode("", true)
              ])
            ]),
            _: 1
          })) : createCommentVNode("", true),
          !__props.hideRef ? (openBlock(), createElementBlock("span", _hoisted_4$8)) : createCommentVNode("", true),
          createVNode(UiPopover, { align: "left" }, {
            trigger: withCtx(() => [
              createVNode(UiButton, {
                icon: "",
                title: "画布与叠框设置"
              }, {
                default: withCtx(() => [
                  createVNode(_component_MdiIcon, { class: "mdi mdi-tune-variant" })
                ]),
                _: 1
              })
            ]),
            default: withCtx(() => [
              createBaseVNode("div", _hoisted_5$8, [
                _cache[31] || (_cache[31] = createBaseVNode("div", { class: "cgroup" }, "画布", -1)),
                createBaseVNode("button", {
                  class: normalizeClass(["citem", { on: showLabels.value }]),
                  title: "Show 区域标签 on the canvas",
                  onClick: _cache[6] || (_cache[6] = ($event) => showLabels.value = !showLabels.value)
                }, [
                  createVNode(_component_MdiIcon, {
                    class: normalizeClass(["mdi", showLabels.value ? "mdi-label" : "mdi-label-outline"])
                  }, null, 8, ["class"]),
                  _cache[24] || (_cache[24] = createTextVNode(" 区域标签", -1))
                ], 2),
                _cache[32] || (_cache[32] = createBaseVNode("div", { class: "cdiv" }, null, -1)),
                createBaseVNode("div", _hoisted_6$7, [
                  _cache[25] || (_cache[25] = createTextVNode("镜像画布 ", -1)),
                  createBaseVNode("button", {
                    class: "cic",
                    title: "水平镜像",
                    onClick: _cache[7] || (_cache[7] = ($event) => unref(store).flipAll("h"))
                  }, [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-flip-horizontal" })
                  ]),
                  createBaseVNode("button", {
                    class: "cic",
                    title: "垂直镜像",
                    onClick: _cache[8] || (_cache[8] = ($event) => unref(store).flipAll("v"))
                  }, [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-flip-vertical" })
                  ])
                ]),
                _cache[33] || (_cache[33] = createBaseVNode("div", { class: "cdiv" }, null, -1)),
                _cache[34] || (_cache[34] = createBaseVNode("div", { class: "cgroup" }, "叠框图像输出", -1)),
                createBaseVNode("label", _hoisted_7$6, [
                  _cache[26] || (_cache[26] = createTextVNode("线宽 ", -1)),
                  withDirectives(createBaseVNode("input", {
                    type: "number",
                    min: "1",
                    max: "40",
                    "onUpdate:modelValue": _cache[9] || (_cache[9] = ($event) => unref(store).state.overlay.lineWidth = $event)
                  }, null, 512), [
                    [
                      vModelText,
                      unref(store).state.overlay.lineWidth,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                createBaseVNode("label", _hoisted_8$5, [
                  _cache[27] || (_cache[27] = createTextVNode("填充 ", -1)),
                  withDirectives(createBaseVNode("input", {
                    type: "range",
                    min: "0",
                    max: "1",
                    step: "0.02",
                    "onUpdate:modelValue": _cache[10] || (_cache[10] = ($event) => unref(store).state.overlay.fillAlpha = $event)
                  }, null, 512), [
                    [
                      vModelText,
                      unref(store).state.overlay.fillAlpha,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                createBaseVNode("label", _hoisted_9$5, [
                  _cache[28] || (_cache[28] = createTextVNode("字号 ", -1)),
                  withDirectives(createBaseVNode("input", {
                    type: "number",
                    min: "6",
                    max: "96",
                    "onUpdate:modelValue": _cache[11] || (_cache[11] = ($event) => unref(store).state.overlay.labelSize = $event)
                  }, null, 512), [
                    [
                      vModelText,
                      unref(store).state.overlay.labelSize,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                createBaseVNode("div", _hoisted_10$5, [
                  createBaseVNode("label", null, [
                    withDirectives(createBaseVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[12] || (_cache[12] = ($event) => unref(store).state.overlay.showIndex = $event)
                    }, null, 512), [
                      [vModelCheckbox, unref(store).state.overlay.showIndex]
                    ]),
                    _cache[29] || (_cache[29] = createTextVNode(" 序号", -1))
                  ]),
                  createBaseVNode("label", null, [
                    withDirectives(createBaseVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[13] || (_cache[13] = ($event) => unref(store).state.overlay.showText = $event)
                    }, null, 512), [
                      [vModelCheckbox, unref(store).state.overlay.showText]
                    ]),
                    _cache[30] || (_cache[30] = createTextVNode(" 文字", -1))
                  ])
                ]),
                _cache[35] || (_cache[35] = createBaseVNode("p", { class: "chint" }, "控制 TK MOSS Layout Preview 的 overlay 输出，不修改原图", -1))
              ])
            ]),
            _: 1
          }),
          _cache[37] || (_cache[37] = createBaseVNode("span", { class: "spacer" }, null, -1)),
          renderSlot(_ctx.$slots, "trail", {}, void 0),
          createBaseVNode("input", {
            ref_key: "fileInput",
            ref: fileInput,
            type: "file",
            accept: "image/*",
            hidden: "",
            onChange: onFile
          }, null, 544)
        ], 32),
        referenceError.value ? (openBlock(), createElementBlock("span", _hoisted_11$5, toDisplayString(referenceError.value), 1)) : createCommentVNode("", true),
        createBaseVNode("div", {
          ref_key: "stage",
          ref: stage,
          class: normalizeClass(["stage", { dragging: !!unref(drag) }]),
          tabindex: "0",
          onPointerdown: onPointerDown,
          onPointermove: onPointerMove,
          onPointerup: onPointerUp,
          onPointercancel: onPointerUp,
          onLostpointercapture: onPointerUp,
          onKeydown: onKeyDown,
          onContextmenu: withModifiers(onContextMenu, ["prevent"]),
          onDragover: _cache[15] || (_cache[15] = withModifiers(() => {
          }, ["prevent"])),
          onDrop,
          style: normalizeStyle(stageStyle.value)
        }, [
          effectiveBackdrop.value ? (openBlock(), createElementBlock("img", {
            key: 0,
            class: "backdrop",
            src: effectiveBackdrop.value,
            style: normalizeStyle({ opacity: backdropOpacity.value }),
            draggable: "false",
            alt: "reference",
            onLoad: onBackdropLoad
          }, null, 44, _hoisted_12$5)) : createCommentVNode("", true),
          livePreview.value && previewSyncImage.value ? (openBlock(), createElementBlock("img", {
            key: 1,
            class: "livelayer",
            src: previewSyncImage.value,
            draggable: "false",
            alt: "live preview"
          }, null, 8, _hoisted_13$4)) : createCommentVNode("", true),
          livePreview.value && previewSyncImage.value ? (openBlock(), createElementBlock("span", _hoisted_14$4, [
            createVNode(_component_MdiIcon, { class: "mdi mdi-record" }),
            _cache[38] || (_cache[38] = createTextVNode(" live", -1))
          ])) : createCommentVNode("", true),
          _cache[39] || (_cache[39] = createBaseVNode("div", { class: "grid" }, null, -1)),
          (openBlock(true), createElementBlock(Fragment, null, renderList(boxed.value, (el, i) => {
            return openBlock(), createElementBlock("div", {
              key: el.id,
              class: normalizeClass(["box", { sel: unref(store).isSelected(el.id), primary: el.id === unref(store).selectedId }]),
              style: normalizeStyle(boxStyle(el)),
              "data-box": el.id
            }, [
              showLabels.value ? (openBlock(), createElementBlock("span", {
                key: 0,
                class: normalizeClass(["tag", { grouped: !!el.groupId }]),
                style: normalizeStyle(tagStyle(el))
              }, [
                el.groupId ? (openBlock(), createElementBlock("span", _hoisted_16$2)) : createCommentVNode("", true),
                createVNode(_component_MdiIcon, {
                  class: normalizeClass(["mdi tagi", el.linkId ? "mdi-link-variant" : labelIcon(el.label)])
                }, null, 8, ["class"]),
                createBaseVNode("span", _hoisted_17$2, toDisplayString(i + 1), 1),
                createBaseVNode("span", _hoisted_18$2, toDisplayString(el.label === "text" ? el.text || "text" : el.caption || el.label), 1)
              ], 6)) : createCommentVNode("", true),
              el.id === unref(store).selectedId && unref(store).selectedIds.length === 1 ? (openBlock(), createElementBlock(Fragment, { key: 1 }, renderList(HANDLES, (hdl) => {
                return createBaseVNode("i", {
                  key: hdl,
                  class: normalizeClass(["h", "h-" + hdl]),
                  "data-handle": hdl
                }, null, 10, _hoisted_19$2);
              }), 64)) : createCommentVNode("", true)
            ], 14, _hoisted_15$3);
          }), 128)),
          groupBox.value ? (openBlock(), createElementBlock("div", {
            key: 3,
            class: "groupframe",
            style: normalizeStyle(groupStyle.value)
          }, [
            (openBlock(), createElementBlock(Fragment, null, renderList(HANDLES, (hdl) => {
              return createBaseVNode("i", {
                key: hdl,
                class: normalizeClass(["h", "h-" + hdl]),
                "data-handle": hdl,
                "data-group": "1"
              }, null, 10, _hoisted_20$2);
            }), 64))
          ], 4)) : createCommentVNode("", true),
          marquee.value ? (openBlock(), createElementBlock("div", {
            key: 4,
            class: "marquee",
            style: normalizeStyle(marqueeStyle.value)
          }, null, 4)) : createCommentVNode("", true),
          draft.value ? (openBlock(), createElementBlock("div", {
            key: 5,
            class: "box draft",
            style: normalizeStyle(boxStyle({ bbox: draft.value, boxColor: "#9ca3af" }))
          }, null, 4)) : createCommentVNode("", true)
        ], 38)
      ], 512);
    };
  }
});
const BBoxCanvas = /* @__PURE__ */ _export_sfc(_sfc_main$c, [["__scopeId", "data-v-d0cccbb5"]]);
let opening = null;
function database() {
  if (!opening) opening = new Promise((resolve2, reject) => {
    const r = indexedDB.open("tk-moss-layout-templates-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("templates", { keyPath: "name" });
    r.onsuccess = () => {
      r.result.onversionchange = () => {
        r.result.close();
        opening = null;
      };
      resolve2(r.result);
    };
    r.onerror = () => {
      opening = null;
      reject(r.error);
    };
    r.onblocked = () => {
      opening = null;
      reject(new Error("请关闭旧版模板窗口后重试"));
    };
  });
  return opening;
}
async function transaction(mode, run) {
  const db = await database();
  return new Promise((resolve2, reject) => {
    const tx = db.transaction("templates", mode), request = run(tx.objectStore("templates"));
    tx.oncomplete = () => resolve2(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("模板保存中断"));
  });
}
const thumbs = /* @__PURE__ */ new Map();
function thumbUrl(_dir, name) {
  return thumbs.get(name.replace(/\.thumb\.jpg$/, ".json")) || "";
}
async function previewJson(json) {
  var _a;
  const parsed = parseJsonLoose(json);
  if (!parsed.ok) return { preview: "", valid: false, errors: [parsed.error], warnings: [] };
  const result = resolveToState(((_a = parsed.obj) == null ? void 0 : _a.draft) || parsed.obj, 1024, 1024), state = result.state;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = Math.max(1, Math.min(1024, Math.round(320 * (state.height || 1024) / (state.width || 1024))));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#202026";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / (state.width || 1024), canvas.height / (state.height || 1024));
  ctx.lineWidth = 5;
  for (const el of state.elements || []) {
    const [x, y, x2, y2] = el.bbox;
    ctx.strokeStyle = el.boxColor;
    ctx.strokeRect(x, y, x2 - x, y2 - y);
  }
  return { preview: canvas.toDataURL("image/png"), valid: !result.errors.length, errors: result.errors, warnings: result.warnings };
}
async function listLibrary() {
  const entries = await transaction("readonly", (s) => s.getAll());
  thumbs.clear();
  entries.forEach((e) => {
    if (e.thumb) thumbs.set(e.name, e.thumb);
  });
  return { dir: "browser", templates: entries.sort((a, b) => a.name.localeCompare(b.name)) };
}
async function saveTemplate(_dir, name, json, overwrite = false, thumb = "") {
  var _a, _b;
  const parsed = parseJsonLoose(json);
  if (!parsed.ok) throw new Error(parsed.error);
  const state = resolveToState(((_a = parsed.obj) == null ? void 0 : _a.draft) || parsed.obj, 1024, 1024, { strict: true });
  if (state.errors.length) throw new Error(state.errors.join("；"));
  const stem = name.trim().replace(/\.json$/i, "") || "template_001", key = stem + ".json";
  const existing = await transaction("readonly", (s) => s.get(key));
  if (existing && !overwrite) return { ok: false, error: "已有同名模板，请改名后保存" };
  const canonical = serialize(state.state).draft;
  const studio = matchingStudio((_b = parsed.obj) == null ? void 0 : _b.studio, canonical);
  const payload = studio ? { draft: canonical, studio } : canonical;
  await transaction("readwrite", (s) => s.put({ name: key, stem, caption: JSON.stringify(payload), thumb }));
  return { ok: true, name: stem };
}
async function deleteTemplate(name) {
  await transaction("readwrite", (s) => s.delete(name));
  thumbs.delete(name);
  return { ok: true, removed: [name] };
}
const _hoisted_1$b = { class: "libpanel" };
const _hoisted_2$b = { class: "libhead" };
const _hoisted_3$a = { class: "t" };
const _hoisted_4$7 = {
  key: 0,
  class: "count"
};
const _hoisted_5$7 = { class: "search" };
const _hoisted_6$6 = { class: "libbody" };
const _hoisted_7$5 = {
  key: 0,
  class: "grid"
};
const _hoisted_8$4 = ["title", "onClick"];
const _hoisted_9$4 = ["src", "alt"];
const _hoisted_10$4 = {
  key: 2,
  class: "badge"
};
const _hoisted_11$4 = ["onClick"];
const _hoisted_12$4 = ["title"];
const _hoisted_13$3 = { class: "q" };
const _hoisted_14$3 = { class: "cbtns" };
const _hoisted_15$2 = ["onClick"];
const _hoisted_16$1 = {
  key: 1,
  class: "empty"
};
const _hoisted_17$1 = {
  key: 2,
  class: "empty"
};
const _hoisted_18$1 = {
  key: 3,
  class: "empty"
};
const _hoisted_19$1 = { class: "libfoot" };
const _hoisted_20$1 = ["disabled"];
const _sfc_main$b = /* @__PURE__ */ defineComponent({
  __name: "StudioLibrary",
  props: {
    open: { type: Boolean }
  },
  emits: ["update:open"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit2 = __emit;
    const store = useStudioStore();
    const templates = /* @__PURE__ */ ref([]);
    const previews = /* @__PURE__ */ reactive({});
    const libDir = /* @__PURE__ */ ref("");
    const loading = /* @__PURE__ */ ref(false);
    const saveName = /* @__PURE__ */ ref("template_001");
    const withThumb = /* @__PURE__ */ ref(true);
    const flash = /* @__PURE__ */ ref("");
    const query = /* @__PURE__ */ ref("");
    const pendingDelete = /* @__PURE__ */ ref(null);
    const isErr = computed(() => /error|not found/i.test(flash.value));
    const shown = computed(() => {
      const q = query.value.trim().toLowerCase();
      return q ? templates.value.filter((t) => t.stem.toLowerCase().includes(q)) : templates.value;
    });
    function nextName(stem) {
      const m = /^(.*?)(\d+)$/.exec(stem);
      if (m) return m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, "0");
      return stem + "_002";
    }
    function elCount(t) {
      var _a;
      try {
        const value = JSON.parse(t.caption);
        const items = ((_a = value == null ? void 0 : value.draft) == null ? void 0 : _a.items) || (value == null ? void 0 : value.items);
        return Array.isArray(items) ? items.length : 0;
      } catch {
        return 0;
      }
    }
    function thumbOf(t) {
      if (t.thumb && libDir.value) return thumbUrl(libDir.value, `${t.stem}.thumb.jpg`);
      return previews[t.stem] || "";
    }
    async function refresh() {
      loading.value = true;
      flash.value = "";
      try {
        const r = await listLibrary();
        templates.value = r.templates || [];
        libDir.value = r.dir || "";
      } catch (e) {
        flash.value = "error: " + String((e == null ? void 0 : e.message) || e);
      }
      loading.value = false;
      for (const t of templates.value) {
        if (t.thumb || previews[t.stem]) continue;
        previewJson(t.caption).then((p2) => {
          if (p2.preview) previews[t.stem] = p2.preview;
        });
      }
    }
    watch(
      () => props.open,
      (o) => {
        if (o) {
          pendingDelete.value = null;
          void refresh();
        }
      }
    );
    function load(t) {
      const res = store.importDraftJson(t.caption);
      if (res.ok) emit2("update:open", false);
      else flash.value = "load error: " + (res.error || "invalid template");
    }
    async function doDelete(t) {
      try {
        const r = await deleteTemplate(t.name);
        if (r.ok) {
          flash.value = "deleted " + t.stem;
          pendingDelete.value = null;
          delete previews[t.stem];
          await refresh();
        } else {
          flash.value = "delete error: " + (r.error || "unknown");
        }
      } catch (e) {
        flash.value = "delete error: " + String((e == null ? void 0 : e.message) || e);
      }
    }
    function hexA(hex, a) {
      const h2 = hex.replace("#", "");
      const r = parseInt(h2.slice(0, 2), 16) || 0;
      const g = parseInt(h2.slice(2, 4), 16) || 0;
      const b = parseInt(h2.slice(4, 6), 16) || 0;
      return `rgba(${r},${g},${b},${a})`;
    }
    async function makeThumb() {
      const src = store.refImage;
      if (!src) return "";
      return new Promise((resolve2) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const max = 320;
          const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h2 = Math.max(1, Math.round(img.naturalHeight * scale));
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h2;
          const ctx = c.getContext("2d");
          if (!ctx) return resolve2("");
          ctx.drawImage(img, 0, 0, w, h2);
          const W = store.state.width, H = store.state.height;
          ctx.lineWidth = Math.max(1, Math.round(w / 220));
          for (const el of store.state.elements) {
            const [x1, y1, x2, y2] = el.bbox;
            const rx = x1 / W * w;
            const ry = y1 / H * h2;
            const rw = (x2 - x1) / W * w;
            const rh = (y2 - y1) / H * h2;
            const color = el.boxColor || "#60a5fa";
            ctx.fillStyle = hexA(color, 0.16);
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = color;
            ctx.strokeRect(rx, ry, rw, rh);
          }
          try {
            resolve2(c.toDataURL("image/jpeg", 0.82));
          } catch {
            resolve2("");
          }
        };
        img.onerror = () => resolve2("");
        img.src = src;
      });
    }
    async function saveCurrent() {
      const json = JSON.stringify({ draft: serialize(store.state).draft, studio: JSON.parse(JSON.stringify(store.state)) });
      const thumb = withThumb.value && store.refImage ? await makeThumb() : "";
      try {
        const r = await saveTemplate("", saveName.value.trim() || "template_001", json, false, thumb);
        if (r.ok) {
          flash.value = "saved as " + (r.name || saveName.value) + ".json";
          saveName.value = nextName(r.name || saveName.value);
          await refresh();
        } else {
          flash.value = "save error: " + (r.error || "unknown");
        }
      } catch (e) {
        flash.value = "save error: " + String((e == null ? void 0 : e.message) || e);
      }
    }
    return (_ctx, _cache) => {
      const _component_MdiIcon = resolveComponent("MdiIcon");
      return __props.open ? (openBlock(), createElementBlock("div", {
        key: 0,
        class: "liboverlay",
        onPointerdown: _cache[7] || (_cache[7] = withModifiers(($event) => emit2("update:open", false), ["self"])),
        onContextmenu: _cache[8] || (_cache[8] = withModifiers(() => {
        }, ["prevent", "stop"]))
      }, [
        createBaseVNode("div", _hoisted_1$b, [
          createBaseVNode("header", _hoisted_2$b, [
            createBaseVNode("span", _hoisted_3$a, [
              createVNode(_component_MdiIcon, { class: "mdi mdi-bookshelf" }),
              _cache[9] || (_cache[9] = createTextVNode(" 本机布局模板", -1))
            ]),
            templates.value.length ? (openBlock(), createElementBlock("span", _hoisted_4$7, toDisplayString(shown.value.length), 1)) : createCommentVNode("", true),
            _cache[10] || (_cache[10] = createBaseVNode("span", { class: "grow" }, null, -1)),
            createBaseVNode("div", _hoisted_5$7, [
              createVNode(_component_MdiIcon, { class: "mdi mdi-magnify" }),
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => query.value = $event),
                placeholder: "搜索模板…",
                spellcheck: "false"
              }, null, 512), [
                [vModelText, query.value]
              ]),
              query.value ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "clr",
                title: "Clear",
                onClick: _cache[1] || (_cache[1] = ($event) => query.value = "")
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-close" })
              ])) : createCommentVNode("", true)
            ]),
            createVNode(UiButton, {
              icon: "",
              title: "刷新模板",
              onClick: refresh
            }, {
              default: withCtx(() => [
                createVNode(_component_MdiIcon, {
                  class: normalizeClass(["mdi", loading.value ? "mdi-loading mdi-spin" : "mdi-refresh"])
                }, null, 8, ["class"])
              ]),
              _: 1
            }),
            createVNode(UiButton, {
              icon: "",
              title: "关闭",
              onClick: _cache[2] || (_cache[2] = ($event) => emit2("update:open", false))
            }, {
              default: withCtx(() => [
                createVNode(_component_MdiIcon, { class: "mdi mdi-close" })
              ]),
              _: 1
            })
          ]),
          createBaseVNode("div", _hoisted_6$6, [
            shown.value.length ? (openBlock(), createElementBlock("div", _hoisted_7$5, [
              (openBlock(true), createElementBlock(Fragment, null, renderList(shown.value, (t) => {
                return openBlock(), createElementBlock("div", {
                  key: t.name,
                  class: normalizeClass(["tile", { confirming: pendingDelete.value === t.name }])
                }, [
                  createBaseVNode("button", {
                    class: "thumb",
                    title: "Load " + t.stem,
                    onClick: ($event) => load(t)
                  }, [
                    thumbOf(t) ? (openBlock(), createElementBlock("img", {
                      key: 0,
                      src: thumbOf(t),
                      alt: t.stem,
                      draggable: "false"
                    }, null, 8, _hoisted_9$4)) : (openBlock(), createBlock(_component_MdiIcon, {
                      key: 1,
                      class: normalizeClass(["mdi ph", loading.value ? "mdi-loading mdi-spin" : "mdi-image-outline"])
                    }, null, 8, ["class"])),
                    elCount(t) ? (openBlock(), createElementBlock("span", _hoisted_10$4, [
                      createVNode(_component_MdiIcon, { class: "mdi mdi-shape-outline" }),
                      createTextVNode(" " + toDisplayString(elCount(t)), 1)
                    ])) : createCommentVNode("", true)
                  ], 8, _hoisted_8$4),
                  createBaseVNode("button", {
                    class: "del",
                    title: "删除模板",
                    onClick: withModifiers(($event) => pendingDelete.value = t.name, ["stop"])
                  }, [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-trash-can-outline" })
                  ], 8, _hoisted_11$4),
                  createBaseVNode("div", {
                    class: "name",
                    title: t.stem
                  }, toDisplayString(t.stem), 9, _hoisted_12$4),
                  pendingDelete.value === t.name ? (openBlock(), createElementBlock("div", {
                    key: 0,
                    class: "confirm",
                    onClick: _cache[4] || (_cache[4] = withModifiers(() => {
                    }, ["stop"]))
                  }, [
                    createBaseVNode("span", _hoisted_13$3, [
                      createVNode(_component_MdiIcon, { class: "mdi mdi-trash-can-outline" }),
                      _cache[11] || (_cache[11] = createTextVNode(" 删除模板？", -1))
                    ]),
                    createBaseVNode("div", _hoisted_14$3, [
                      createBaseVNode("button", {
                        class: "yes",
                        onClick: ($event) => doDelete(t)
                      }, "删除", 8, _hoisted_15$2),
                      createBaseVNode("button", {
                        class: "no",
                        onClick: _cache[3] || (_cache[3] = ($event) => pendingDelete.value = null)
                      }, "取消")
                    ])
                  ])) : createCommentVNode("", true)
                ], 2);
              }), 128))
            ])) : loading.value ? (openBlock(), createElementBlock("p", _hoisted_16$1, [
              createVNode(_component_MdiIcon, { class: "mdi mdi-loading mdi-spin" }),
              _cache[12] || (_cache[12] = createTextVNode(" loading…", -1))
            ])) : query.value ? (openBlock(), createElementBlock("p", _hoisted_17$1, [
              createVNode(_component_MdiIcon, { class: "mdi mdi-magnify" }),
              createTextVNode(" No templates match “" + toDisplayString(query.value) + "”.", 1)
            ])) : (openBlock(), createElementBlock("p", _hoisted_18$1, [
              createVNode(_component_MdiIcon, { class: "mdi mdi-bookshelf big" }),
              _cache[13] || (_cache[13] = createBaseVNode("span", null, "还没有保存的模板", -1)),
              _cache[14] || (_cache[14] = createBaseVNode("small", null, [
                createTextVNode("编辑布局后，输入名称并点下方"),
                createBaseVNode("b", null, "保存当前布局"),
                createTextVNode("。")
              ], -1))
            ]))
          ]),
          createBaseVNode("footer", _hoisted_19$1, [
            createVNode(_component_MdiIcon, { class: "mdi mdi-content-save-outline fic" }),
            withDirectives(createBaseVNode("input", {
              "onUpdate:modelValue": _cache[5] || (_cache[5] = ($event) => saveName.value = $event),
              class: "nm",
              placeholder: "模板名称",
              spellcheck: "false",
              onKeydown: withKeys(saveCurrent, ["enter"])
            }, null, 544), [
              [vModelText, saveName.value]
            ]),
            createBaseVNode("label", {
              class: normalizeClass(["thumbck", { disabled: !unref(store).refImage }]),
              title: "Save a small thumbnail of the current reference image so the template is easy to recognise"
            }, [
              withDirectives(createBaseVNode("input", {
                type: "checkbox",
                "onUpdate:modelValue": _cache[6] || (_cache[6] = ($event) => withThumb.value = $event),
                disabled: !unref(store).refImage
              }, null, 8, _hoisted_20$1), [
                [vModelCheckbox, withThumb.value]
              ]),
              _cache[15] || (_cache[15] = createTextVNode(" 参考图缩略图 ", -1))
            ], 2),
            _cache[17] || (_cache[17] = createBaseVNode("span", { class: "grow" }, null, -1)),
            createVNode(Transition, { name: "flash" }, {
              default: withCtx(() => [
                flash.value ? (openBlock(), createElementBlock("span", {
                  key: 0,
                  class: normalizeClass(["flash", { err: isErr.value }])
                }, [
                  createVNode(_component_MdiIcon, {
                    class: normalizeClass(["mdi", isErr.value ? "mdi-alert-circle-outline" : "mdi-check-circle-outline"])
                  }, null, 8, ["class"]),
                  createTextVNode(" " + toDisplayString(flash.value), 1)
                ], 2)) : createCommentVNode("", true)
              ]),
              _: 1
            }),
            createVNode(UiButton, {
              title: "将完整布局保存为本机模板",
              onClick: saveCurrent
            }, {
              default: withCtx(() => [
                createVNode(_component_MdiIcon, { class: "mdi mdi-content-save-outline" }),
                _cache[16] || (_cache[16] = createTextVNode(" 保存当前布局", -1))
              ]),
              _: 1
            })
          ])
        ])
      ], 32)) : createCommentVNode("", true);
    };
  }
});
const StudioLibrary = /* @__PURE__ */ _export_sfc(_sfc_main$b, [["__scopeId", "data-v-18ee3e52"]]);
const _hoisted_1$a = { class: "ui-card" };
const _hoisted_2$a = {
  key: 0,
  class: "ui-card-head"
};
const _hoisted_3$9 = {
  key: 0,
  class: "ui-card-title"
};
const _sfc_main$a = /* @__PURE__ */ defineComponent({
  __name: "UiCard",
  props: {
    title: {}
  },
  setup(__props) {
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$a, [
        __props.title || _ctx.$slots.header ? (openBlock(), createElementBlock("div", _hoisted_2$a, [
          __props.title ? (openBlock(), createElementBlock("span", _hoisted_3$9, toDisplayString(__props.title), 1)) : createCommentVNode("", true),
          renderSlot(_ctx.$slots, "header", {}, void 0)
        ])) : createCommentVNode("", true),
        renderSlot(_ctx.$slots, "default", {}, void 0)
      ]);
    };
  }
});
const UiCard = /* @__PURE__ */ _export_sfc(_sfc_main$a, [["__scopeId", "data-v-665b913d"]]);
const _hoisted_1$9 = { class: "palette" };
const _hoisted_2$9 = { class: "swatches" };
const _hoisted_3$8 = ["onContextmenu"];
const _hoisted_4$6 = ["title"];
const _hoisted_5$6 = ["value", "onInput"];
const _hoisted_6$5 = { class: "hint" };
const _sfc_main$9 = /* @__PURE__ */ defineComponent({
  __name: "PaletteEditor",
  props: {
    modelValue: {},
    max: { default: 16 },
    label: { default: "colors" }
  },
  emits: ["update:modelValue"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit2 = __emit;
    function add() {
      emit2("update:modelValue", [...props.modelValue, "#888888"]);
    }
    function remove2(i) {
      const next = props.modelValue.slice();
      next.splice(i, 1);
      emit2("update:modelValue", next);
    }
    function update(i, raw) {
      const h2 = normalizeHex(raw) ?? props.modelValue[i];
      const next = props.modelValue.slice();
      next[i] = h2;
      emit2("update:modelValue", next);
    }
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$9, [
        createBaseVNode("div", _hoisted_2$9, [
          (openBlock(true), createElementBlock(Fragment, null, renderList(__props.modelValue, (c, i) => {
            return openBlock(), createElementBlock("div", {
              key: i,
              class: "swatch-wrap",
              onContextmenu: withModifiers(($event) => remove2(i), ["prevent"])
            }, [
              createBaseVNode("label", {
                class: "swatch",
                style: normalizeStyle({ background: c }),
                title: c + "  —  click: edit · right-click: remove"
              }, [
                createBaseVNode("input", {
                  type: "color",
                  value: c,
                  onInput: ($event) => update(i, $event.target.value)
                }, null, 40, _hoisted_5$6)
              ], 12, _hoisted_4$6)
            ], 40, _hoisted_3$8);
          }), 128)),
          __props.modelValue.length < __props.max ? (openBlock(), createElementBlock("button", {
            key: 0,
            class: "add",
            title: "Add color",
            onClick: add
          }, "+")) : createCommentVNode("", true)
        ]),
        createBaseVNode("div", _hoisted_6$5, toDisplayString(__props.modelValue.length) + "/" + toDisplayString(__props.max) + " " + toDisplayString(__props.label), 1)
      ]);
    };
  }
});
const PaletteEditor = /* @__PURE__ */ _export_sfc(_sfc_main$9, [["__scopeId", "data-v-bd1d882e"]]);
const _hoisted_1$8 = { class: "combo" };
const _hoisted_2$8 = ["value", "placeholder"];
const _hoisted_3$7 = ["value"];
const _sfc_main$8 = /* @__PURE__ */ defineComponent({
  __name: "ComboInput",
  props: {
    modelValue: {},
    options: { default: () => [] },
    placeholder: { default: "" }
  },
  emits: ["update:modelValue"],
  setup(__props, { emit: __emit }) {
    const emit2 = __emit;
    function pick(e) {
      const sel = e.target;
      if (sel.value) emit2("update:modelValue", sel.value);
      sel.value = "";
    }
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$8, [
        createBaseVNode("input", {
          value: __props.modelValue,
          placeholder: __props.placeholder,
          onInput: _cache[0] || (_cache[0] = ($event) => emit2("update:modelValue", $event.target.value))
        }, null, 40, _hoisted_2$8),
        __props.options.length ? (openBlock(), createElementBlock("select", {
          key: 0,
          class: "cpick",
          title: "Pick a preset",
          onChange: pick
        }, [
          _cache[1] || (_cache[1] = createBaseVNode("option", {
            value: "",
            disabled: "",
            selected: "",
            hidden: ""
          }, "presets…", -1)),
          (openBlock(true), createElementBlock(Fragment, null, renderList(__props.options, (p2) => {
            return openBlock(), createElementBlock("option", {
              key: p2,
              value: p2
            }, toDisplayString(p2), 9, _hoisted_3$7);
          }), 128))
        ], 32)) : createCommentVNode("", true)
      ]);
    };
  }
});
const ComboInput = /* @__PURE__ */ _export_sfc(_sfc_main$8, [["__scopeId", "data-v-2f602dd0"]]);
const PRESETS = {
  meta: [
    "photograph",
    "illustration",
    "poster",
    "product campaign",
    "studio photography",
    "concept art",
    "watercolor",
    "anime",
    "3d render",
    "comic",
    "infographic",
    "menu design",
    "book cover",
    "ui mockup",
    "magazine layout"
  ],
  tags: [
    "soft lighting",
    "warm palette",
    "high detail",
    "minimalist",
    "vintage",
    "clean composition",
    "studio backdrop",
    "golden hour",
    "matte texture",
    "glossy"
  ]
};
const _hoisted_1$7 = { class: "chead" };
const _hoisted_2$7 = ["title"];
const _hoisted_3$6 = ["value"];
const _hoisted_4$5 = { class: "field" };
const _hoisted_5$5 = { class: "field" };
const _hoisted_6$4 = { class: "field" };
const _hoisted_7$4 = { class: "presetsck" };
const _sfc_main$7 = /* @__PURE__ */ defineComponent({
  __name: "SummaryPanel",
  setup(__props) {
    const store = useStudioStore();
    const opts = computed(() => store.state.ui.showPresets ? PRESETS.meta : []);
    const metaText = computed({
      get: () => store.state.summary.meta.join(", "),
      set: (v) => {
        store.state.summary.meta = v.split(",").map((s) => s.trim()).filter(Boolean);
      }
    });
    return (_ctx, _cache) => {
      const _component_MdiIcon = resolveComponent("MdiIcon");
      return openBlock(), createBlock(UiCard, null, {
        header: withCtx(() => [
          createBaseVNode("div", _hoisted_1$7, [
            createBaseVNode("button", {
              class: "fold",
              title: unref(store).state.ui.summaryOpen ? "Collapse" : "Expand",
              onClick: _cache[0] || (_cache[0] = ($event) => unref(store).state.ui.summaryOpen = !unref(store).state.ui.summaryOpen)
            }, [
              createVNode(_component_MdiIcon, {
                class: normalizeClass(["mdi", unref(store).state.ui.summaryOpen ? "mdi-chevron-down" : "mdi-chevron-right"])
              }, null, 8, ["class"])
            ], 8, _hoisted_2$7),
            _cache[6] || (_cache[6] = createBaseVNode("span", {
              class: "lhead",
              title: "summary — global image description"
            }, "全局描述", -1)),
            _cache[7] || (_cache[7] = createBaseVNode("span", { class: "grow" }, null, -1)),
            withDirectives(createBaseVNode("select", {
              "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => unref(store).state.summary.canvas = $event),
              class: "canvasmode",
              title: "summary.canvas — how the canvas is composed"
            }, [
              (openBlock(true), createElementBlock(Fragment, null, renderList(unref(CANVAS_MODES), (m) => {
                return openBlock(), createElementBlock("option", {
                  key: m,
                  value: m
                }, toDisplayString(m), 9, _hoisted_3$6);
              }), 128))
            ], 512), [
              [vModelSelect, unref(store).state.summary.canvas]
            ])
          ])
        ]),
        default: withCtx(() => [
          unref(store).state.ui.summaryOpen ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [
            createBaseVNode("div", _hoisted_4$5, [
              withDirectives(createBaseVNode("textarea", {
                "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => unref(store).state.summary.caption = $event),
                rows: "4",
                placeholder: "整体场景、镜头与光照；人物专属特征写入各自区域，可见台词写入文字区域"
              }, null, 512), [
                [vModelText, unref(store).state.summary.caption]
              ])
            ]),
            createBaseVNode("div", _hoisted_5$5, [
              _cache[8] || (_cache[8] = createBaseVNode("span", null, "媒介 / 类型标签", -1)),
              createVNode(ComboInput, {
                modelValue: metaText.value,
                "onUpdate:modelValue": _cache[3] || (_cache[3] = ($event) => metaText.value = $event),
                options: opts.value,
                placeholder: "product campaign, studio photography"
              }, null, 8, ["modelValue", "options"])
            ]),
            createBaseVNode("div", _hoisted_6$4, [
              _cache[9] || (_cache[9] = createBaseVNode("span", null, "全局配色（可选）", -1)),
              createVNode(PaletteEditor, {
                modelValue: unref(store).state.summary.palette,
                "onUpdate:modelValue": _cache[4] || (_cache[4] = ($event) => unref(store).state.summary.palette = $event),
                max: 16,
                label: "image colors"
              }, null, 8, ["modelValue"])
            ]),
            createBaseVNode("label", _hoisted_7$4, [
              withDirectives(createBaseVNode("input", {
                type: "checkbox",
                "onUpdate:modelValue": _cache[5] || (_cache[5] = ($event) => unref(store).state.ui.showPresets = $event)
              }, null, 512), [
                [vModelCheckbox, unref(store).state.ui.showPresets]
              ]),
              _cache[10] || (_cache[10] = createTextVNode(" 显示标签建议", -1))
            ])
          ], 64)) : createCommentVNode("", true)
        ]),
        _: 1
      });
    };
  }
});
const SummaryPanel = /* @__PURE__ */ _export_sfc(_sfc_main$7, [["__scopeId", "data-v-f5d58465"]]);
const _hoisted_1$6 = { class: "chead" };
const _hoisted_2$6 = {
  class: "lhead",
  title: "筛选区域"
};
const _hoisted_3$5 = { class: "lmenu" };
const _hoisted_4$4 = ["onClick"];
const _hoisted_5$4 = ["onClick"];
const _hoisted_6$3 = ["onClick"];
const _hoisted_7$3 = ["onClick"];
const _hoisted_8$3 = { class: "adds" };
const _hoisted_9$3 = ["draggable", "onClick", "onContextmenu", "onDragstart", "onDragover", "onDrop"];
const _hoisted_10$3 = { class: "typeicon" };
const _hoisted_11$3 = { class: "snip" };
const _hoisted_12$3 = ["onClick"];
const _hoisted_13$2 = {
  key: 1,
  class: "empty"
};
const _hoisted_14$2 = {
  key: 2,
  class: "empty"
};
const _sfc_main$6 = /* @__PURE__ */ defineComponent({
  __name: "ElementList",
  setup(__props) {
    const store = useStudioStore();
    const filter = /* @__PURE__ */ ref("all");
    const filterIcon = computed(
      () => filter.value === "object" ? "mdi-vector-square" : filter.value === "character" ? "mdi-account-outline" : filter.value === "text" ? "mdi-format-text" : "mdi-format-list-bulleted"
    );
    function labelIcon(label) {
      return label === "text" ? "mdi-format-text" : label === "character" ? "mdi-account-outline" : "mdi-vector-square";
    }
    const rows = computed(
      () => store.state.elements.map((el, i) => ({ el, i })).filter(({ el }) => filter.value === "all" || el.label === filter.value)
    );
    const dragArmed = /* @__PURE__ */ ref(false);
    const dragId = /* @__PURE__ */ ref(null);
    const overIdx = /* @__PURE__ */ ref(-1);
    function onDragStart(e, id) {
      dragId.value = id;
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    }
    function onDrop(i) {
      if (dragId.value) {
        store.moveElementTo(dragId.value, i);
        store.snapshot();
      }
    }
    function onDragEnd() {
      dragArmed.value = false;
      dragId.value = null;
      overIdx.value = -1;
    }
    function openMenu(e, id) {
      if (!store.isSelected(id)) store.select(id);
      store.openContextMenu(e.clientX, e.clientY, id);
    }
    function rowClick(e, id) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        store.select(id, true);
        return;
      }
      const el = store.getElement(id);
      if (el == null ? void 0 : el.groupId) {
        if (store.selectedId === id) store.select(null);
        else store.select(id);
        return;
      }
      if (store.selectedIds.length === 1 && store.isSelected(id)) store.select(null);
      else store.select(id);
    }
    return (_ctx, _cache) => {
      const _component_MdiIcon = resolveComponent("MdiIcon");
      return openBlock(), createBlock(UiCard, { style: { "flex": "1 1 0", "min-height": "200px" } }, {
        header: withCtx(() => [
          createBaseVNode("div", _hoisted_1$6, [
            createVNode(UiPopover, { align: "left" }, {
              trigger: withCtx(() => [
                createBaseVNode("button", _hoisted_2$6, [
                  createVNode(_component_MdiIcon, {
                    class: normalizeClass(["mdi flt", filterIcon.value])
                  }, null, 8, ["class"]),
                  createTextVNode(" 区域 (" + toDisplayString(rows.value.length) + ")", 1),
                  createVNode(_component_MdiIcon, { class: "mdi mdi-menu-down" })
                ])
              ]),
              default: withCtx(({ close }) => [
                createBaseVNode("div", _hoisted_3$5, [
                  createBaseVNode("button", {
                    class: normalizeClass(["litem", { on: filter.value === "all" }]),
                    onClick: ($event) => {
                      filter.value = "all";
                      close();
                    }
                  }, [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-format-list-bulleted" }),
                    _cache[6] || (_cache[6] = createTextVNode(" 全部区域", -1))
                  ], 10, _hoisted_4$4),
                  createBaseVNode("button", {
                    class: normalizeClass(["litem", { on: filter.value === "object" }]),
                    onClick: ($event) => {
                      filter.value = "object";
                      close();
                    }
                  }, [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-vector-square" }),
                    _cache[7] || (_cache[7] = createTextVNode(" 物体", -1))
                  ], 10, _hoisted_5$4),
                  createBaseVNode("button", {
                    class: normalizeClass(["litem", { on: filter.value === "character" }]),
                    onClick: ($event) => {
                      filter.value = "character";
                      close();
                    }
                  }, [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-account-outline" }),
                    _cache[8] || (_cache[8] = createTextVNode(" 人物", -1))
                  ], 10, _hoisted_6$3),
                  createBaseVNode("button", {
                    class: normalizeClass(["litem", { on: filter.value === "text" }]),
                    onClick: ($event) => {
                      filter.value = "text";
                      close();
                    }
                  }, [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-format-text" }),
                    _cache[9] || (_cache[9] = createTextVNode(" 文字", -1))
                  ], 10, _hoisted_7$3)
                ])
              ]),
              _: 1
            })
          ]),
          createBaseVNode("div", _hoisted_8$3, [
            createVNode(UiButton, {
              title: "新增物体框",
              onClick: _cache[0] || (_cache[0] = ($event) => unref(store).addElement("object"))
            }, {
              default: withCtx(() => [
                createVNode(_component_MdiIcon, { class: "mdi mdi-plus" }),
                _cache[10] || (_cache[10] = createTextVNode(" 物体", -1))
              ]),
              _: 1
            }),
            createVNode(UiButton, {
              title: "新增人物框",
              onClick: _cache[1] || (_cache[1] = ($event) => unref(store).addElement("character"))
            }, {
              default: withCtx(() => [
                createVNode(_component_MdiIcon, { class: "mdi mdi-plus" }),
                _cache[11] || (_cache[11] = createTextVNode(" 人物", -1))
              ]),
              _: 1
            }),
            createVNode(UiButton, {
              title: "新增文字框",
              onClick: _cache[2] || (_cache[2] = ($event) => unref(store).addElement("text"))
            }, {
              default: withCtx(() => [
                createVNode(_component_MdiIcon, { class: "mdi mdi-plus" }),
                _cache[12] || (_cache[12] = createTextVNode(" 文字", -1))
              ]),
              _: 1
            })
          ])
        ]),
        default: withCtx(() => [
          rows.value.length ? (openBlock(), createElementBlock("ul", {
            key: 0,
            class: "ellist",
            onPointerup: _cache[5] || (_cache[5] = ($event) => dragArmed.value = false)
          }, [
            (openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, ({ el, i }) => {
              return openBlock(), createElementBlock("li", {
                key: el.id,
                draggable: dragArmed.value,
                class: normalizeClass({ sel: unref(store).isSelected(el.id), primary: el.id === unref(store).selectedId, grouped: !!el.groupId, dragover: overIdx.value === i && dragId.value && dragId.value !== el.id, dragging: dragId.value === el.id }),
                style: normalizeStyle(el.groupId ? { "--gc": unref(groupColor)(el.groupId) } : {}),
                onClick: ($event) => rowClick($event, el.id),
                onContextmenu: withModifiers(($event) => openMenu($event, el.id), ["prevent"]),
                onDragstart: ($event) => onDragStart($event, el.id),
                onDragover: withModifiers(($event) => overIdx.value = i, ["prevent"]),
                onDrop: ($event) => onDrop(i),
                onDragend: onDragEnd
              }, [
                filter.value === "all" ? (openBlock(), createBlock(_component_MdiIcon, {
                  key: 0,
                  class: "mdi mdi-drag-vertical handle",
                  title: "拖动排序",
                  onPointerdown: _cache[3] || (_cache[3] = ($event) => dragArmed.value = true),
                  onClick: _cache[4] || (_cache[4] = withModifiers(() => {
                  }, ["stop"]))
                })) : createCommentVNode("", true),
                createBaseVNode("span", _hoisted_10$3, [
                  createVNode(_component_MdiIcon, {
                    class: normalizeClass(["mdi", labelIcon(el.label)])
                  }, null, 8, ["class"])
                ]),
                createBaseVNode("span", {
                  class: "idxchip",
                  style: normalizeStyle({ background: el.boxColor })
                }, toDisplayString(i + 1), 5),
                el.linkId ? (openBlock(), createBlock(_component_MdiIcon, {
                  key: 1,
                  class: "mdi mdi-link-variant link",
                  title: "Linked ×" + unref(store).linkGroupSize(el.id)
                }, null, 8, ["title"])) : createCommentVNode("", true),
                createBaseVNode("span", _hoisted_11$3, toDisplayString(el.label === "text" ? "“" + (el.text || "…") + "”" : el.caption || el.label + "…"), 1),
                createBaseVNode("button", {
                  class: "more",
                  title: "区域操作（也可右键）",
                  onClick: withModifiers(($event) => openMenu($event, el.id), ["stop"])
                }, [
                  createVNode(_component_MdiIcon, { class: "mdi mdi-dots-horizontal" })
                ], 8, _hoisted_12$3)
              ], 46, _hoisted_9$3);
            }), 128))
          ], 32)) : unref(store).state.elements.length ? (openBlock(), createElementBlock("p", _hoisted_13$2, "no " + toDisplayString(filter.value) + " items", 1)) : (openBlock(), createElementBlock("p", _hoisted_14$2, "点击“画框”后拖动，松开即可输入描述。"))
        ]),
        _: 1
      });
    };
  }
});
const ElementList = /* @__PURE__ */ _export_sfc(_sfc_main$6, [["__scopeId", "data-v-01882720"]]);
const _hoisted_1$5 = { class: "jctrl" };
const _hoisted_2$5 = ["title"];
const _hoisted_3$4 = {
  key: 3,
  class: "jtok",
  title: "Compiled prompt token estimate (rough)"
};
const _sfc_main$5 = /* @__PURE__ */ defineComponent({
  __name: "JsonControls",
  setup(__props) {
    const store = useStudioStore();
    const j = store.json;
    const copied = /* @__PURE__ */ ref(false);
    const result = computed(() => serialize(store.state));
    const warnings = computed(() => result.value.warnings);
    const tokens = computed(() => Math.round(result.value.prompt.length / 4));
    const parseError = computed(() => {
      if (!j.editing || !j.draft.trim()) return "";
      const res = parseJsonLoose(j.draft);
      return res.ok ? "" : res.error;
    });
    const statusClass = computed(() => {
      if (j.editing) return parseError.value ? "mdi-alert-circle bad" : "mdi-check-circle good";
      return warnings.value.length ? "mdi-alert warn" : "mdi-check-circle good";
    });
    const statusTitle = computed(() => {
      if (j.editing) return parseError.value ? "Invalid JSON" : "Parses OK";
      return warnings.value.length ? `${warnings.value.length} warning${warnings.value.length > 1 ? "s" : ""}:
${warnings.value.join("\n")}` : "Valid draft";
    });
    const syncWarningTitle = computed(() => {
      const n = j.syncWarnings.length;
      return `${n} import warning${n === 1 ? "" : "s"}:
${j.syncWarnings.join("\n")}`;
    });
    async function copy() {
      try {
        await navigator.clipboard.writeText(serialize(store.state).draftPretty);
        copied.value = true;
        setTimeout(() => copied.value = false, 1200);
      } catch {
      }
    }
    return (_ctx, _cache) => {
      const _component_MdiIcon = resolveComponent("MdiIcon");
      return openBlock(), createElementBlock("div", _hoisted_1$5, [
        createVNode(_component_MdiIcon, {
          class: normalizeClass(["jstat mdi", statusClass.value]),
          title: statusTitle.value
        }, null, 8, ["class", "title"]),
        unref(j).syncError ? (openBlock(), createBlock(_component_MdiIcon, {
          key: 0,
          class: "jstat mdi mdi-sync-alert bad",
          title: unref(j).syncError
        }, null, 8, ["title"])) : unref(j).syncWarnings.length ? (openBlock(), createBlock(_component_MdiIcon, {
          key: 1,
          class: "jstat mdi mdi-sync-alert warn",
          title: syncWarningTitle.value
        }, null, 8, ["title"])) : createCommentVNode("", true),
        unref(j).syncNote ? (openBlock(), createElementBlock("span", {
          key: 2,
          class: "jnote",
          title: unref(j).syncNote
        }, toDisplayString(unref(j).syncNote), 9, _hoisted_2$5)) : createCommentVNode("", true),
        unref(store).state.ui.jsonOpen && !unref(j).editing ? (openBlock(), createElementBlock("span", _hoisted_3$4, "~" + toDisplayString(tokens.value) + " tok", 1)) : createCommentVNode("", true),
        _cache[8] || (_cache[8] = createBaseVNode("span", { class: "grow" }, null, -1)),
        !unref(j).editing ? (openBlock(), createElementBlock(Fragment, { key: 4 }, [
          unref(store).state.ui.jsonOpen ? (openBlock(), createBlock(UiButton, {
            key: 0,
            icon: "",
            title: copied.value ? "Copied" : "Copy draft JSON",
            onClick: copy
          }, {
            default: withCtx(() => [
              createVNode(_component_MdiIcon, {
                class: normalizeClass(["mdi", copied.value ? "mdi-check" : "mdi-content-copy"])
              }, null, 8, ["class"])
            ]),
            _: 1
          }, 8, ["title"])) : createCommentVNode("", true),
          createVNode(UiButton, {
            icon: "",
            title: "编辑 / 粘贴 JSON",
            onClick: _cache[0] || (_cache[0] = ($event) => unref(store).jsonStartEdit())
          }, {
            default: withCtx(() => [
              createVNode(_component_MdiIcon, { class: "mdi mdi-pencil-outline" })
            ]),
            _: 1
          }),
          createVNode(UiButton, {
            icon: "",
            title: unref(store).state.ui.jsonOpen ? "收起 JSON" : "展开 JSON",
            onClick: _cache[1] || (_cache[1] = ($event) => unref(store).state.ui.jsonOpen = !unref(store).state.ui.jsonOpen)
          }, {
            default: withCtx(() => [
              createVNode(_component_MdiIcon, {
                class: normalizeClass(["mdi", unref(store).state.ui.jsonOpen ? "mdi-chevron-up" : "mdi-chevron-down"])
              }, null, 8, ["class"])
            ]),
            _: 1
          }, 8, ["title"])
        ], 64)) : (openBlock(), createElementBlock(Fragment, { key: 5 }, [
          createVNode(UiButton, {
            title: "Re-indent the JSON",
            onClick: _cache[2] || (_cache[2] = ($event) => unref(store).jsonTidy())
          }, {
            default: withCtx(() => [..._cache[5] || (_cache[5] = [
              createTextVNode("格式化", -1)
            ])]),
            _: 1
          }),
          createVNode(UiButton, {
            variant: "primary",
            disabled: !!parseError.value,
            onClick: _cache[3] || (_cache[3] = ($event) => unref(store).jsonApply())
          }, {
            default: withCtx(() => [..._cache[6] || (_cache[6] = [
              createTextVNode("应用", -1)
            ])]),
            _: 1
          }, 8, ["disabled"]),
          createVNode(UiButton, {
            onClick: _cache[4] || (_cache[4] = ($event) => unref(store).jsonCancel())
          }, {
            default: withCtx(() => [..._cache[7] || (_cache[7] = [
              createTextVNode("取消", -1)
            ])]),
            _: 1
          })
        ], 64))
      ]);
    };
  }
});
const JsonControls = /* @__PURE__ */ _export_sfc(_sfc_main$5, [["__scopeId", "data-v-f6a6cf00"]]);
const _hoisted_1$4 = { class: "ehead" };
const _hoisted_2$4 = ["title"];
const _hoisted_3$3 = ["value"];
const _hoisted_4$3 = { class: "seg" };
const _hoisted_5$3 = {
  class: "coordinates",
  "aria-label": "区域像素坐标"
};
const _hoisted_6$2 = ["aria-label", "value", "max", "onChange"];
const _hoisted_7$2 = {
  key: 0,
  class: "filine"
};
const _hoisted_8$2 = ["value"];
const _hoisted_9$2 = { class: "filine" };
const _hoisted_10$2 = ["value", "placeholder"];
const _hoisted_11$2 = { class: "filine" };
const _hoisted_12$2 = { class: "filine" };
const _sfc_main$4 = /* @__PURE__ */ defineComponent({
  __name: "ElementEditor",
  setup(__props) {
    const store = useStudioStore();
    const el = computed(() => store.getElement(store.selectedId));
    const index = computed(() => store.state.elements.findIndex((e) => e.id === store.selectedId));
    const linked = computed(() => {
      var _a;
      return !!((_a = el.value) == null ? void 0 : _a.linkId);
    });
    const groupSize = computed(() => el.value ? store.linkGroupSize(el.value.id) : 1);
    const opts = computed(() => store.state.ui.showPresets ? PRESETS.tags : []);
    const sharedTags = computed({
      get: () => el.value ? el.value.tags.join(", ") : "",
      set: (v) => {
        if (el.value) store.setShared(el.value.id, "tags", v.split(",").map((s) => s.trim()).filter(Boolean));
      }
    });
    function setShared(key, value) {
      if (el.value) store.setShared(el.value.id, key, value);
    }
    function coordinate(index2, input) {
      if (!el.value) return;
      const bbox = [...el.value.bbox];
      const value = Number(input.value);
      if (!Number.isFinite(value)) {
        input.value = String(bbox[index2]);
        return;
      }
      const limit = index2 % 2 ? store.state.height : store.state.width;
      bbox[index2] = index2 < 2 ? Math.max(0, Math.min(bbox[index2 + 2] - 1, Math.round(value))) : Math.max(bbox[index2 - 2] + 1, Math.min(limit, Math.round(value)));
      store.snapshot();
      el.value.bbox = clampBbox(bbox, store.state.width, store.state.height);
      input.value = String(el.value.bbox[index2]);
      store.snapshot();
    }
    return (_ctx, _cache) => {
      const _component_MdiIcon = resolveComponent("MdiIcon");
      return el.value ? (openBlock(), createBlock(UiCard, { key: 0 }, {
        header: withCtx(() => [
          createBaseVNode("div", _hoisted_1$4, [
            createBaseVNode("label", {
              class: "idchip",
              title: "Item " + (index.value + 1) + (linked.value ? " · linked ×" + groupSize.value : "") + " — click to recolour"
            }, [
              createBaseVNode("span", {
                class: "n",
                style: normalizeStyle({ background: el.value.boxColor })
              }, toDisplayString(index.value + 1), 5),
              createBaseVNode("input", {
                type: "color",
                value: el.value.boxColor,
                onInput: _cache[0] || (_cache[0] = ($event) => setShared("boxColor", $event.target.value))
              }, null, 40, _hoisted_3$3)
            ], 8, _hoisted_2$4),
            createBaseVNode("div", _hoisted_4$3, [
              createVNode(UiButton, {
                icon: "",
                active: el.value.label === "object",
                title: "物体",
                onClick: _cache[1] || (_cache[1] = ($event) => setShared("label", "object"))
              }, {
                default: withCtx(() => [
                  createVNode(_component_MdiIcon, { class: "mdi mdi-vector-square" })
                ]),
                _: 1
              }, 8, ["active"]),
              createVNode(UiButton, {
                icon: "",
                active: el.value.label === "character",
                title: "人物",
                onClick: _cache[2] || (_cache[2] = ($event) => setShared("label", "character"))
              }, {
                default: withCtx(() => [
                  createVNode(_component_MdiIcon, { class: "mdi mdi-account-outline" })
                ]),
                _: 1
              }, 8, ["active"]),
              createVNode(UiButton, {
                icon: "",
                active: el.value.label === "text",
                title: "文字",
                onClick: _cache[3] || (_cache[3] = ($event) => setShared("label", "text"))
              }, {
                default: withCtx(() => [
                  createVNode(_component_MdiIcon, { class: "mdi mdi-format-text" })
                ]),
                _: 1
              }, 8, ["active"])
            ]),
            _cache[10] || (_cache[10] = createBaseVNode("span", { class: "grow" }, null, -1)),
            createVNode(UiButton, {
              icon: "",
              title: "关联副本：共享内容，位置独立",
              onClick: _cache[4] || (_cache[4] = ($event) => unref(store).duplicateLinked(el.value.id))
            }, {
              default: withCtx(() => [
                createVNode(_component_MdiIcon, { class: "mdi mdi-link-variant-plus" })
              ]),
              _: 1
            }),
            linked.value ? (openBlock(), createBlock(UiButton, {
              key: 0,
              icon: "",
              title: "Unlink from group (×" + groupSize.value + ")",
              onClick: _cache[5] || (_cache[5] = ($event) => unref(store).unlink(el.value.id))
            }, {
              default: withCtx(() => [
                createVNode(_component_MdiIcon, { class: "mdi mdi-link-variant-off" })
              ]),
              _: 1
            }, 8, ["title"])) : createCommentVNode("", true)
          ])
        ]),
        default: withCtx(() => [
          createBaseVNode("div", _hoisted_5$3, [
            (openBlock(), createElementBlock(Fragment, null, renderList(["左 X", "上 Y", "右 X", "下 Y"], (name, i) => {
              return createBaseVNode("label", { key: i }, [
                createTextVNode(toDisplayString(name) + " ", 1),
                createBaseVNode("input", {
                  type: "number",
                  "aria-label": name,
                  value: el.value.bbox[i],
                  min: "0",
                  max: i % 2 ? unref(store).state.height : unref(store).state.width,
                  onChange: ($event) => coordinate(i, $event.target)
                }, null, 40, _hoisted_6$2)
              ]);
            }), 64))
          ]),
          el.value.label === "text" ? (openBlock(), createElementBlock("label", _hoisted_7$2, [
            _cache[11] || (_cache[11] = createBaseVNode("span", null, "可见文字", -1)),
            createBaseVNode("input", {
              value: el.value.text,
              type: "text",
              placeholder: "要显示的原文；用 \\n 换行",
              onInput: _cache[6] || (_cache[6] = ($event) => setShared("text", $event.target.value))
            }, null, 40, _hoisted_8$2)
          ])) : createCommentVNode("", true),
          createBaseVNode("label", _hoisted_9$2, [
            _cache[12] || (_cache[12] = createBaseVNode("span", null, "区域描述", -1)),
            createBaseVNode("textarea", {
              "aria-label": "区域描述",
              value: el.value.caption,
              rows: "2",
              placeholder: el.value.label === "text" ? "字体、气泡和文字外观；台词填在上方文字栏" : "简单描述这个区域，或写完整提示词直接使用",
              onInput: _cache[7] || (_cache[7] = ($event) => setShared("caption", $event.target.value))
            }, null, 40, _hoisted_10$2)
          ]),
          createBaseVNode("div", _hoisted_11$2, [
            _cache[13] || (_cache[13] = createBaseVNode("span", null, "补充标签", -1)),
            createVNode(ComboInput, {
              modelValue: sharedTags.value,
              "onUpdate:modelValue": _cache[8] || (_cache[8] = ($event) => sharedTags.value = $event),
              options: opts.value,
              placeholder: "可选，逗号分隔"
            }, null, 8, ["modelValue", "options"])
          ]),
          createBaseVNode("div", _hoisted_12$2, [
            _cache[14] || (_cache[14] = createBaseVNode("span", null, "区域配色", -1)),
            createVNode(PaletteEditor, {
              modelValue: el.value.palette,
              max: 8,
              label: "item colours",
              "onUpdate:modelValue": _cache[9] || (_cache[9] = ($event) => setShared("palette", $event))
            }, null, 8, ["modelValue"])
          ])
        ]),
        _: 1
      })) : createCommentVNode("", true);
    };
  }
});
const ElementEditor = /* @__PURE__ */ _export_sfc(_sfc_main$4, [["__scopeId", "data-v-9e084768"]]);
const _hoisted_1$3 = {
  key: 1,
  class: "json"
};
const _hoisted_2$3 = {
  key: 2,
  class: "compiled"
};
const _hoisted_3$2 = ["title"];
const _hoisted_4$2 = { class: "cline" };
const _hoisted_5$2 = {
  key: 3,
  class: "parseerr"
};
const _hoisted_6$1 = { class: "errhead" };
const _hoisted_7$1 = { class: "msg" };
const _hoisted_8$1 = {
  key: 4,
  class: "applyerr"
};
const _hoisted_9$1 = { class: "errhead" };
const _hoisted_10$1 = { class: "errlist" };
const _hoisted_11$1 = {
  key: 5,
  class: "warnlist"
};
const _hoisted_12$1 = {
  key: 0,
  class: "syncbad"
};
const _hoisted_13$1 = {
  key: 1,
  class: "syncnote"
};
const _hoisted_14$1 = {
  key: 2,
  class: "warnlist"
};
const _hoisted_15$1 = {
  key: 7,
  class: "warnlist"
};
const _sfc_main$3 = /* @__PURE__ */ defineComponent({
  __name: "JsonPreview",
  setup(__props) {
    const store = useStudioStore();
    const j = store.json;
    const taEl = /* @__PURE__ */ ref(null);
    const copiedErr = /* @__PURE__ */ ref(false);
    const copiedPrompt = /* @__PURE__ */ ref(false);
    const result = computed(() => serialize(store.state));
    const pretty = computed(() => result.value.draftPretty);
    const prompt = computed(() => result.value.prompt);
    const warnings = computed(() => result.value.warnings);
    const parseInfo = computed(() => {
      if (!j.editing || !j.draft.trim()) return { error: "", line: null, col: null };
      if (parseJsonLoose(j.draft).ok) return { error: "", line: null, col: null };
      try {
        JSON.parse(j.draft);
        return { error: "", line: null, col: null };
      } catch (e) {
        const msg = String((e == null ? void 0 : e.message) || e);
        let line = null;
        let col = null;
        const pos = msg.match(/position (\d+)/);
        if (pos) {
          const i = Number(pos[1]);
          const upto = j.draft.slice(0, i);
          line = upto.split("\n").length;
          col = i - upto.lastIndexOf("\n");
        } else {
          const lc = msg.match(/line (\d+) column (\d+)/);
          if (lc) {
            line = Number(lc[1]);
            col = Number(lc[2]);
          }
        }
        return { error: msg, line, col };
      }
    });
    const parseError = computed(() => parseInfo.value.error);
    const canClamp = computed(
      () => j.applyErrors.some((e) => /exceeds canvas/i.test(e) && !/collapses/i.test(e))
    );
    const parseMsg = computed(() => {
      const { error, line, col } = parseInfo.value;
      if (!error) return "";
      const short = error.replace(/^JSON\.parse: /, "").replace(/ in JSON at position \d+.*/i, "").replace(/ at line \d+ column \d+.*/i, "");
      return line ? `Line ${line}, column ${col}: ${short}` : short;
    });
    const parseFrame = computed(() => {
      const { line, col } = parseInfo.value;
      if (!line) return "";
      const lines = j.draft.split("\n");
      const w = String(line).length;
      const rows = [];
      if (line - 2 >= 0) rows.push(`${String(line - 1).padStart(w)} | ${lines[line - 2]}`);
      rows.push(`${String(line).padStart(w)} | ${lines[line - 1] ?? ""}`);
      rows.push(`${" ".repeat(w)} | ${" ".repeat(Math.max(0, (col ?? 1) - 1))}^`);
      return rows.join("\n");
    });
    function jumpToError() {
      var _a;
      const ta = taEl.value;
      const { line } = parseInfo.value;
      if (!ta || !line) return;
      const lines = j.draft.split("\n");
      let start = 0;
      for (let i = 0; i < line - 1; i++) start += lines[i].length + 1;
      const end = start + (((_a = lines[line - 1]) == null ? void 0 : _a.length) ?? 0);
      ta.focus();
      ta.setSelectionRange(start, end);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 16;
      ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2);
    }
    async function copyError() {
      const text = parseFrame.value ? `${parseMsg.value}
${parseFrame.value}` : parseMsg.value;
      try {
        await navigator.clipboard.writeText(text);
        copiedErr.value = true;
        setTimeout(() => copiedErr.value = false, 1200);
      } catch {
      }
    }
    async function copyPrompt() {
      try {
        await navigator.clipboard.writeText(prompt.value);
        copiedPrompt.value = true;
        setTimeout(() => copiedPrompt.value = false, 1200);
      } catch {
      }
    }
    return (_ctx, _cache) => {
      return unref(store).state.ui.jsonOpen ? (openBlock(), createBlock(UiCard, {
        key: 0,
        class: "jcard"
      }, {
        default: withCtx(() => [
          unref(j).editing ? withDirectives((openBlock(), createElementBlock("textarea", {
            key: 0,
            ref_key: "taEl",
            ref: taEl,
            "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => unref(j).draft = $event),
            class: normalizeClass(["json edit", { bad: !!parseError.value }]),
            spellcheck: "false",
            placeholder: "Paste a whole MOSS draft JSON (or a compiled prompt) here, then Apply to load it into the studio."
          }, null, 2)), [
            [vModelText, unref(j).draft]
          ]) : (openBlock(), createElementBlock("pre", _hoisted_1$3, toDisplayString(pretty.value), 1)),
          !unref(j).editing ? (openBlock(), createElementBlock("div", _hoisted_2$3, [
            _cache[2] || (_cache[2] = createBaseVNode("span", {
              class: "clbl",
              title: "The compiled model prompt — what the prompt output sends to the sampler"
            }, "compiled prompt", -1)),
            createBaseVNode("button", {
              class: "cbtn",
              title: copiedPrompt.value ? "Copied" : "Copy the compiled prompt",
              onClick: copyPrompt
            }, toDisplayString(copiedPrompt.value ? "✓" : "⧉"), 9, _hoisted_3$2),
            createBaseVNode("pre", _hoisted_4$2, toDisplayString(prompt.value), 1)
          ])) : createCommentVNode("", true),
          unref(j).editing && parseError.value ? (openBlock(), createElementBlock("div", _hoisted_5$2, [
            createBaseVNode("div", _hoisted_6$1, [
              createBaseVNode("span", _hoisted_7$1, "⚠ " + toDisplayString(parseMsg.value), 1),
              parseInfo.value.line ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "ebtn",
                title: "Jump to this line in the editor",
                onClick: jumpToError
              }, "go to →")) : createCommentVNode("", true),
              createBaseVNode("button", {
                class: "ebtn",
                title: "Copy the error",
                onClick: copyError
              }, toDisplayString(copiedErr.value ? "copied ✓" : "copy"), 1)
            ]),
            parseFrame.value ? (openBlock(), createElementBlock("pre", {
              key: 0,
              class: "errframe",
              title: "Jump to this line",
              onClick: jumpToError
            }, toDisplayString(parseFrame.value), 1)) : createCommentVNode("", true)
          ])) : createCommentVNode("", true),
          unref(j).editing && unref(j).applyErrors.length ? (openBlock(), createElementBlock("div", _hoisted_8$1, [
            createBaseVNode("div", _hoisted_9$1, [
              _cache[3] || (_cache[3] = createBaseVNode("span", { class: "msg" }, "⚠ Import rejected — nothing was applied", -1)),
              canClamp.value ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "ebtn clamp",
                title: "Clamp every out-of-canvas bbox and apply",
                onClick: _cache[1] || (_cache[1] = ($event) => unref(store).jsonApplyClamp())
              }, "clamp & apply")) : createCommentVNode("", true)
            ]),
            createBaseVNode("ul", _hoisted_10$1, [
              (openBlock(true), createElementBlock(Fragment, null, renderList(unref(j).applyErrors, (e, i) => {
                return openBlock(), createElementBlock("li", { key: i }, toDisplayString(e), 1);
              }), 128))
            ])
          ])) : createCommentVNode("", true),
          unref(j).editing && unref(j).applyWarnings.length ? (openBlock(), createElementBlock("ul", _hoisted_11$1, [
            (openBlock(true), createElementBlock(Fragment, null, renderList(unref(j).applyWarnings, (w, i) => {
              return openBlock(), createElementBlock("li", { key: i }, toDisplayString(w), 1);
            }), 128))
          ])) : createCommentVNode("", true),
          !unref(j).editing && (unref(j).syncError || unref(j).syncWarnings.length || unref(j).syncNote) ? (openBlock(), createElementBlock("div", {
            key: 6,
            class: normalizeClass(["syncbox", { bad: !!unref(j).syncError }])
          }, [
            unref(j).syncError ? (openBlock(), createElementBlock("div", _hoisted_12$1, "sync: " + toDisplayString(unref(j).syncError), 1)) : createCommentVNode("", true),
            unref(j).syncNote ? (openBlock(), createElementBlock("div", _hoisted_13$1, toDisplayString(unref(j).syncNote), 1)) : createCommentVNode("", true),
            unref(j).syncWarnings.length ? (openBlock(), createElementBlock("ul", _hoisted_14$1, [
              (openBlock(true), createElementBlock(Fragment, null, renderList(unref(j).syncWarnings, (w, i) => {
                return openBlock(), createElementBlock("li", { key: i }, "sync: " + toDisplayString(w), 1);
              }), 128))
            ])) : createCommentVNode("", true)
          ], 2)) : createCommentVNode("", true),
          !unref(j).editing && warnings.value.length ? (openBlock(), createElementBlock("ul", _hoisted_15$1, [
            (openBlock(true), createElementBlock(Fragment, null, renderList(warnings.value, (w, i) => {
              return openBlock(), createElementBlock("li", { key: i }, toDisplayString(w), 1);
            }), 128))
          ])) : createCommentVNode("", true)
        ]),
        _: 1
      })) : createCommentVNode("", true);
    };
  }
});
const JsonPreview = /* @__PURE__ */ _export_sfc(_sfc_main$3, [["__scopeId", "data-v-d977b910"]]);
const _hoisted_1$2 = { class: "ctxhead" };
const _hoisted_2$2 = { class: "cnum" };
const _hoisted_3$1 = { class: "ctxhead" };
const _hoisted_4$1 = { class: "cnum" };
const _hoisted_5$1 = ["value", "placeholder"];
const _sfc_main$2 = /* @__PURE__ */ defineComponent({
  __name: "ElementContextMenu",
  setup(__props) {
    const store = useStudioStore();
    const m = computed(() => store.ctxMenu);
    const el = computed(() => {
      var _a;
      return store.getElement(((_a = m.value) == null ? void 0 : _a.id) ?? null);
    });
    const index = computed(() => store.state.elements.findIndex((e) => {
      var _a;
      return e.id === ((_a = m.value) == null ? void 0 : _a.id);
    }));
    const editEl = /* @__PURE__ */ ref(null);
    const bulk = computed(() => !!m.value && store.selectedIds.length > 1 && store.selectedIds.includes(m.value.id));
    const anyGrouped = computed(() => store.selectedIds.some((id) => {
      var _a;
      return (_a = store.getElement(id)) == null ? void 0 : _a.groupId;
    }));
    const isOneGroup = computed(() => {
      var _a;
      const ids = store.selectedIds;
      if (ids.length < 2) return false;
      const g = (_a = store.getElement(ids[0])) == null ? void 0 : _a.groupId;
      if (!g || !ids.every((id) => {
        var _a2;
        return ((_a2 = store.getElement(id)) == null ? void 0 : _a2.groupId) === g;
      })) return false;
      return store.groupSize(ids[0]) === ids.length;
    });
    function labelIcon(label) {
      return label === "text" ? "mdi-format-text" : label === "character" ? "mdi-account-outline" : "mdi-vector-square";
    }
    function ungroupBulk() {
      for (const id of [...store.selectedIds]) store.ungroup(id);
    }
    function onEdit(v) {
      if (el.value) store.setShared(el.value.id, el.value.label === "text" ? "text" : "caption", v);
    }
    function close() {
      store.closeContextMenu();
    }
    function run(fn) {
      fn();
      close();
    }
    function runBulk(fn) {
      for (const id of [...store.selectedIds]) fn(id);
      close();
    }
    const style = computed(() => {
      if (!m.value) return {};
      const x = Math.max(4, Math.min(m.value.x, window.innerWidth - 190));
      const y = Math.max(4, Math.min(m.value.y, window.innerHeight - 260));
      return { left: `${x}px`, top: `${y}px` };
    });
    onBeforeUnmount(() => document.removeEventListener("keydown", onEsc, true));
    function onEsc(e) {
      if (e.key === "Escape") close();
    }
    watch(m, (v) => {
      if (v) {
        document.addEventListener("keydown", onEsc, true);
        nextTick(() => {
          var _a;
          return (_a = editEl.value) == null ? void 0 : _a.focus();
        });
      } else {
        document.removeEventListener("keydown", onEsc, true);
      }
    });
    return (_ctx, _cache) => {
      const _component_MdiIcon = resolveComponent("MdiIcon");
      return openBlock(), createBlock(Teleport, { to: "body" }, [
        m.value && el.value ? (openBlock(), createElementBlock("div", {
          key: 0,
          class: "ctxbg",
          onPointerdown: close,
          onContextmenu: withModifiers(close, ["prevent"]),
          onWheel: close
        }, [
          createBaseVNode("div", {
            class: "ctx",
            style: normalizeStyle(style.value),
            onPointerdown: _cache[14] || (_cache[14] = withModifiers(() => {
            }, ["stop"])),
            onContextmenu: _cache[15] || (_cache[15] = withModifiers(() => {
            }, ["prevent", "stop"]))
          }, [
            bulk.value ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [
              createBaseVNode("div", _hoisted_1$2, [
                createVNode(_component_MdiIcon, {
                  class: normalizeClass(["mdi", isOneGroup.value ? "mdi-group" : "mdi-checkbox-multiple-marked-outline"])
                }, null, 8, ["class"]),
                createBaseVNode("span", _hoisted_2$2, toDisplayString(isOneGroup.value ? "Group · " + unref(store).selectedIds.length : unref(store).selectedIds.length + " selected"), 1)
              ]),
              !isOneGroup.value ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "ctxitem",
                onClick: _cache[0] || (_cache[0] = ($event) => run(() => unref(store).group(unref(store).selectedIds)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-group" }),
                _cache[16] || (_cache[16] = createTextVNode(" 编组", -1))
              ])) : createCommentVNode("", true),
              anyGrouped.value ? (openBlock(), createElementBlock("button", {
                key: 1,
                class: "ctxitem",
                onClick: _cache[1] || (_cache[1] = ($event) => run(ungroupBulk))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-ungroup" }),
                _cache[17] || (_cache[17] = createTextVNode(" 取消编组", -1))
              ])) : createCommentVNode("", true),
              createBaseVNode("button", {
                class: "ctxitem",
                onClick: _cache[2] || (_cache[2] = ($event) => run(() => unref(store).duplicateMany(unref(store).selectedIds)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-content-copy" }),
                createTextVNode(" duplicate" + toDisplayString(isOneGroup.value ? " group" : ""), 1)
              ]),
              createBaseVNode("button", {
                class: "ctxitem",
                onClick: _cache[3] || (_cache[3] = ($event) => run(unref(store).copySelection))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-content-duplicate" }),
                _cache[18] || (_cache[18] = createTextVNode(" 复制 ", -1)),
                _cache[19] || (_cache[19] = createBaseVNode("span", { class: "ctxkey" }, "⌘C", -1))
              ]),
              _cache[20] || (_cache[20] = createBaseVNode("div", { class: "ctxdiv" }, null, -1)),
              createBaseVNode("button", {
                class: "ctxitem del",
                onClick: _cache[4] || (_cache[4] = ($event) => runBulk((id) => unref(store).removeElement(id)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-delete-outline" }),
                createTextVNode(" 删除 " + toDisplayString(unref(store).selectedIds.length), 1)
              ])
            ], 64)) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [
              createBaseVNode("div", _hoisted_3$1, [
                createBaseVNode("span", {
                  class: "cdot",
                  style: normalizeStyle({ background: el.value.boxColor })
                }, null, 4),
                createBaseVNode("span", _hoisted_4$1, "#" + toDisplayString(index.value + 1), 1),
                createVNode(_component_MdiIcon, {
                  class: normalizeClass(["mdi", labelIcon(el.value.label)])
                }, null, 8, ["class"])
              ]),
              createBaseVNode("input", {
                ref_key: "editEl",
                ref: editEl,
                class: "ctxedit",
                value: el.value.label === "text" ? el.value.text : el.value.caption,
                placeholder: el.value.label === "text" ? "text to render…" : "caption…",
                onInput: _cache[5] || (_cache[5] = ($event) => onEdit($event.target.value)),
                onKeydown: _cache[6] || (_cache[6] = withModifiers(() => {
                }, ["stop"]))
              }, null, 40, _hoisted_5$1),
              createBaseVNode("button", {
                class: "ctxitem",
                onClick: _cache[7] || (_cache[7] = ($event) => run(() => unref(store).duplicateLinked(m.value.id)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-link-variant-plus" }),
                _cache[21] || (_cache[21] = createTextVNode(" 关联副本", -1))
              ]),
              createBaseVNode("button", {
                class: "ctxitem",
                onClick: _cache[8] || (_cache[8] = ($event) => run(() => unref(store).duplicateElement(m.value.id)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-content-copy" }),
                _cache[22] || (_cache[22] = createTextVNode(" 独立副本", -1))
              ]),
              createBaseVNode("button", {
                class: "ctxitem",
                onClick: _cache[9] || (_cache[9] = ($event) => run(unref(store).copySelection))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-content-duplicate" }),
                _cache[23] || (_cache[23] = createTextVNode(" 复制 ", -1)),
                _cache[24] || (_cache[24] = createBaseVNode("span", { class: "ctxkey" }, "⌘C", -1))
              ]),
              el.value.linkId ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "ctxitem",
                onClick: _cache[10] || (_cache[10] = ($event) => run(() => unref(store).unlink(m.value.id)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-link-variant-off" }),
                _cache[25] || (_cache[25] = createTextVNode(" 解除关联", -1))
              ])) : createCommentVNode("", true),
              _cache[29] || (_cache[29] = createBaseVNode("div", { class: "ctxdiv" }, null, -1)),
              createBaseVNode("button", {
                class: "ctxitem",
                onClick: _cache[11] || (_cache[11] = ($event) => run(() => unref(store).moveElement(m.value.id, -1)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-arrow-up" }),
                _cache[26] || (_cache[26] = createTextVNode(" 上移", -1))
              ]),
              createBaseVNode("button", {
                class: "ctxitem",
                onClick: _cache[12] || (_cache[12] = ($event) => run(() => unref(store).moveElement(m.value.id, 1)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-arrow-down" }),
                _cache[27] || (_cache[27] = createTextVNode(" 下移", -1))
              ]),
              _cache[30] || (_cache[30] = createBaseVNode("div", { class: "ctxdiv" }, null, -1)),
              createBaseVNode("button", {
                class: "ctxitem del",
                onClick: _cache[13] || (_cache[13] = ($event) => run(() => unref(store).removeElement(m.value.id)))
              }, [
                createVNode(_component_MdiIcon, { class: "mdi mdi-delete-outline" }),
                _cache[28] || (_cache[28] = createTextVNode(" 删除", -1))
              ])
            ], 64))
          ], 36)
        ], 32)) : createCommentVNode("", true)
      ]);
    };
  }
});
const ElementContextMenu = /* @__PURE__ */ _export_sfc(_sfc_main$2, [["__scopeId", "data-v-881d670b"]]);
const _hoisted_1$1 = { class: "main" };
const _hoisted_2$1 = { class: "resmenu" };
const _hoisted_3 = { class: "aspects" };
const _hoisted_4 = ["title", "onClick"];
const _hoisted_5 = { class: "albl" };
const _hoisted_6 = { class: "mprow" };
const _hoisted_7 = { class: "mppresets" };
const _hoisted_8 = ["onClick"];
const _hoisted_9 = { class: "whrow" };
const _hoisted_10 = ["value"];
const _hoisted_11 = ["value"];
const _hoisted_12 = { class: "rfoot" };
const _hoisted_13 = { class: "rmp" };
const _hoisted_14 = {
  key: 0,
  class: "roob"
};
const _hoisted_15 = { class: "help" };
const _hoisted_16 = { class: "resetc" };
const _hoisted_17 = { class: "rq" };
const _hoisted_18 = { class: "rbtns" };
const _hoisted_19 = ["onClick"];
const _hoisted_20 = ["onClick"];
const _hoisted_21 = { class: "slim-controls" };
const _sfc_main$1 = /* @__PURE__ */ defineComponent({
  __name: "MossLayoutStudio",
  props: {
    widget: {},
    node: {}
  },
  setup(__props, { expose: __expose }) {
    const props = __props;
    const store = createStudioStore();
    provideStudioStore(store);
    const rootEl = /* @__PURE__ */ ref(null);
    const libraryOpen = /* @__PURE__ */ ref(false);
    const panelOpen = /* @__PURE__ */ ref(false);
    watch(() => store.selectedId, (id) => {
      var _a;
      if (id && (((_a = rootEl.value) == null ? void 0 : _a.clientWidth) || 0) <= 760) panelOpen.value = true;
    });
    const leftEl = /* @__PURE__ */ ref(null);
    const rightEl = /* @__PURE__ */ ref(null);
    function onUndoKey(e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      const root = rootEl.value;
      const ae = document.activeElement;
      if (!root || !ae || !root.contains(ae)) return;
      const tag = ae.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ae.isContentEditable) return;
      const redo = k === "y" || k === "z" && e.shiftKey;
      if (redo) store.redo();
      else store.undo();
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    onMounted(() => document.addEventListener("keydown", onUndoKey, true));
    onBeforeUnmount(() => {
      document.removeEventListener("keydown", onUndoKey, true);
      clearTimeout(snapTimer);
    });
    const CORE_ASPECTS = [
      { label: "1:1", name: "square", w: 1, h: 1 },
      { label: "3:2", name: "photo", w: 3, h: 2 },
      { label: "4:3", name: "standard", w: 4, h: 3 },
      { label: "16:9", name: "widescreen", w: 16, h: 9 },
      { label: "21:9", name: "ultrawide", w: 21, h: 9 },
      { label: "2:3", name: "portrait", w: 2, h: 3 },
      { label: "3:4", name: "portrait", w: 3, h: 4 },
      { label: "9:16", name: "portrait", w: 9, h: 16 }
    ];
    const aspect = /* @__PURE__ */ ref("1:1");
    const mp = /* @__PURE__ */ ref(1);
    const MP_PRESETS = [0.5, 1, 2, 4];
    const mpActual = computed(() => (store.state.width * store.state.height / (1024 * 1024)).toFixed(2));
    const outsideCount = computed(
      () => store.state.elements.filter(
        (e) => e.bbox[0] < 0 || e.bbox[1] < 0 || e.bbox[2] > store.state.width || e.bbox[3] > store.state.height
      ).length
    );
    function aspectRectStyle(a) {
      const s = 15 / Math.max(a.w, a.h);
      return { width: Math.round(a.w * s) + "px", height: Math.round(a.h * s) + "px" };
    }
    function setAspect(label) {
      aspect.value = label;
      applyRes();
    }
    function setMp(p2) {
      mp.value = p2;
      applyRes();
    }
    function swapWH() {
      setCanvasSize(store.state.height, store.state.width);
    }
    function setCanvasSize(width, height) {
      const sx = width / store.state.width, sy = height / store.state.height;
      store.snapshot();
      store.state.elements.forEach((el) => {
        el.bbox = el.bbox.map((v, i) => Math.round(v * (i % 2 ? sy : sx)));
      });
      store.state.width = width;
      store.state.height = height;
      store.snapshot();
      seedRes();
    }
    function setWH(dimension, value) {
      if (!Number.isFinite(value)) return;
      setCanvasSize(
        dimension === "width" ? Math.max(1, Math.round(value)) : store.state.width,
        dimension === "height" ? Math.max(1, Math.round(value)) : store.state.height
      );
    }
    const snap16 = (v) => Math.max(16, Math.round(v / 16) * 16);
    function applyRes() {
      const a = CORE_ASPECTS.find((x) => x.label === aspect.value) || CORE_ASPECTS[0];
      const total = Math.max(0.1, mp.value || 1) * 1024 * 1024;
      const scale = Math.sqrt(total / (a.w * a.h));
      setCanvasSize(snap16(a.w * scale), snap16(a.h * scale));
    }
    function seedRes() {
      const w = store.state.width;
      const h2 = store.state.height;
      mp.value = Math.max(0.1, Number((w * h2 / (1024 * 1024)).toFixed(2)));
      const r = w / h2;
      aspect.value = CORE_ASPECTS.reduce(
        (best, x) => Math.abs(x.w / x.h - r) < Math.abs(best.w / best.h - r) ? x : best,
        CORE_ASPECTS[0]
      ).label;
    }
    function refitBoxes() {
      const n = store.refitToCanvas();
      if (!n) return;
      store.json.syncError = "";
      store.json.syncWarnings = [];
      store.json.syncNote = `Canvas refit · ${n} box${n === 1 ? "" : "es"} clamped`;
    }
    function plainState() {
      return JSON.parse(JSON.stringify(store.state));
    }
    function resetAll() {
      store.snapshot();
      store.load(emptyState());
      store.select(null);
      store.snapshot();
    }
    let snapTimer;
    function scheduleSnapshot() {
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => store.snapshot(), 350);
    }
    function deriveDraft(state) {
      if (!state || !Array.isArray(state.elements) || !state.summary) return "";
      try {
        return JSON.stringify(serialize(state).draft);
      } catch {
        return "";
      }
    }
    function draftInputWidget() {
      var _a;
      const node = props.node;
      return (_a = node == null ? void 0 : node.widgets) == null ? void 0 : _a.find((w) => w.name === "draft");
    }
    function readDraftInput() {
      var _a;
      const value = (_a = draftInputWidget()) == null ? void 0 : _a.value;
      return typeof value === "string" && value.trim() ? value : "";
    }
    function clearDraftInput() {
      var _a, _b;
      const widget = draftInputWidget();
      const node = props.node;
      const linked = !!((_b = (_a = node == null ? void 0 : node.inputs) == null ? void 0 : _a.find((i) => i.name === "draft")) == null ? void 0 : _b.link);
      if (!widget || widget.link || linked) return false;
      widget.value = "";
      return true;
    }
    onMounted(() => {
      var _a;
      const v = (_a = props.widget) == null ? void 0 : _a.value;
      const inputDraft = readDraftInput();
      let loadedFromExternal = false;
      if (isRecord(v) && isRecord(v.studio)) {
        const fromStudio = deriveDraft(v.studio);
        const savedDraft = inputDraft || (typeof v.draft === "string" ? v.draft : JSON.stringify(v.draft ?? {}));
        if (fromStudio === savedDraft) {
          store.load(v.studio);
          loadedFromExternal = !!inputDraft;
        } else {
          const parsed = parseJsonLoose(savedDraft);
          if (parsed.ok) {
            const { state } = resolveToState(parsed.obj, v.studio.width || 1024, v.studio.height || 1024);
            const ui = v.studio.ui;
            const overlay = v.studio.overlay;
            store.load({ ...state, ui, overlay });
            loadedFromExternal = !!inputDraft;
          } else {
            store.load(v.studio);
          }
        }
        if (loadedFromExternal) {
          const cleared = clearDraftInput();
          store.json.syncError = "";
          store.json.syncWarnings = [];
          store.json.syncNote = cleared ? "Loaded external draft into editor · draft input cleared" : "Draft input is connected · it overrides editor changes";
        }
      } else if (isRecord(v) && (v.draft || v.caption)) {
        const parsed = parseJsonLoose(typeof v.draft === "string" ? v.draft : JSON.stringify(v.draft));
        if (parsed.ok) {
          const { state } = resolveToState(parsed.obj, 1024, 1024);
          store.load(state);
        }
      }
      seedRes();
      store.resetHistory();
      props.widget.serializeValue = async () => {
        const { draft } = serialize(store.state);
        return { draft, studio: plainState() };
      };
      watch(
        () => store.state,
        () => {
          const { draft } = serialize(store.state);
          props.widget.value = { draft, studio: plainState() };
          if (!store.restoring) scheduleSnapshot();
        },
        { deep: true, immediate: true }
      );
    });
    function exportPayload() {
      return { draft: serialize(store.state).draft, studio: plainState() };
    }
    function loadPayload(v) {
      if (!v || !v.draft) throw new Error("布局数据缺少 draft");
      const parsed = parseJsonLoose(typeof v.draft === "string" ? v.draft : JSON.stringify(v.draft));
      if (!parsed.ok) throw new Error(parsed.error);
      const result = resolveToState(parsed.obj, 1024, 1024, { strict: true });
      if (result.errors.length) throw new Error(result.errors.join("；"));
      if (v.studio && deriveDraft(v.studio) === JSON.stringify(parsed.obj)) store.load(v.studio);
      else store.load(result.state);
      store.select(null);
      seedRes();
      store.resetHistory();
    }
    function selection() {
      return store.state.elements.flatMap((el, i) => store.selectedIds.includes(el.id) ? [i] : []);
    }
    function compiled() {
      return serialize(store.state);
    }
    function reference(url, transient = false) {
      if (transient) store.previewImage = url;
      else {
        store.previewImage = null;
        store.state.ui.referenceImage = url;
      }
    }
    function applyCaptions(draft) {
      var _a;
      const original = serialize(store.state).draft;
      if (original.width !== draft.width || original.height !== draft.height || original.items.length !== ((_a = draft.items) == null ? void 0 : _a.length))
        throw new Error("画布已变化，未覆盖当前布局");
      for (let i = 0; i < original.items.length; i++) {
        const before = original.items[i], after = draft.items[i];
        if (before.label !== after.label || JSON.stringify(before.bbox) !== JSON.stringify(after.bbox) || before.text !== after.text)
          throw new Error("区域已变化，未覆盖当前布局");
      }
      store.snapshot();
      store.state.summary.caption = draft.summary.caption;
      store.state.elements.forEach((el, i) => {
        el.caption = draft.items[i].caption;
      });
      store.snapshot();
    }
    __expose({ exportPayload, loadPayload, selection, applyCaptions, compiled, reference });
    return (_ctx, _cache) => {
      var _a;
      const _component_MdiIcon = resolveComponent("MdiIcon");
      return openBlock(), createElementBlock("div", {
        class: normalizeClass(["studio", { "panel-open": panelOpen.value }]),
        ref_key: "rootEl",
        ref: rootEl,
        onContextmenu: _cache[9] || (_cache[9] = withModifiers(() => {
        }, ["prevent", "stop"]))
      }, [
        createBaseVNode("div", _hoisted_1$1, [
          createBaseVNode("div", {
            class: "left",
            ref_key: "leftEl",
            ref: leftEl
          }, [
            createVNode(BBoxCanvas, {
              "prepare-reference": (_a = props.widget) == null ? void 0 : _a.prepareReference
            }, {
              lead: withCtx(() => [
                createVNode(UiButton, {
                  icon: "",
                  disabled: !unref(store).canUndo,
                  title: "撤销 (Ctrl+Z)",
                  onClick: _cache[0] || (_cache[0] = ($event) => unref(store).undo())
                }, {
                  default: withCtx(() => [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-undo" })
                  ]),
                  _: 1
                }, 8, ["disabled"]),
                createVNode(UiButton, {
                  icon: "",
                  disabled: !unref(store).canRedo,
                  title: "重做 (Ctrl+Shift+Z)",
                  onClick: _cache[1] || (_cache[1] = ($event) => unref(store).redo())
                }, {
                  default: withCtx(() => [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-redo" })
                  ]),
                  _: 1
                }, 8, ["disabled"]),
                _cache[15] || (_cache[15] = createBaseVNode("span", { class: "divider" }, null, -1)),
                createVNode(UiPopover, { align: "left" }, {
                  trigger: withCtx(() => [
                    createVNode(UiButton, { title: "画布尺寸：比例与像素" }, {
                      default: withCtx(() => [
                        createTextVNode(toDisplayString(unref(store).state.width) + "×" + toDisplayString(unref(store).state.height) + " ▾", 1)
                      ]),
                      _: 1
                    })
                  ]),
                  default: withCtx(() => [
                    createBaseVNode("div", _hoisted_2$1, [
                      _cache[13] || (_cache[13] = createBaseVNode("div", { class: "rsec" }, "宽高比", -1)),
                      createBaseVNode("div", _hoisted_3, [
                        (openBlock(), createElementBlock(Fragment, null, renderList(CORE_ASPECTS, (a) => {
                          return createBaseVNode("button", {
                            key: a.label,
                            class: normalizeClass(["achip", { on: aspect.value === a.label }]),
                            title: a.label + " · " + a.name,
                            onClick: ($event) => setAspect(a.label)
                          }, [
                            createBaseVNode("span", {
                              class: "arect",
                              style: normalizeStyle(aspectRectStyle(a))
                            }, null, 4),
                            createBaseVNode("span", _hoisted_5, toDisplayString(a.label), 1)
                          ], 10, _hoisted_4);
                        }), 64))
                      ]),
                      _cache[14] || (_cache[14] = createBaseVNode("div", { class: "rdiv" }, null, -1)),
                      createBaseVNode("div", _hoisted_6, [
                        _cache[10] || (_cache[10] = createBaseVNode("span", null, "百万像素", -1)),
                        createBaseVNode("div", _hoisted_7, [
                          (openBlock(), createElementBlock(Fragment, null, renderList(MP_PRESETS, (p2) => {
                            return createBaseVNode("button", {
                              key: p2,
                              class: normalizeClass(["mpp", { on: mp.value === p2 }]),
                              onClick: ($event) => setMp(p2)
                            }, toDisplayString(p2), 11, _hoisted_8);
                          }), 64))
                        ]),
                        withDirectives(createBaseVNode("input", {
                          type: "number",
                          min: "0.1",
                          max: "16",
                          step: "0.1",
                          "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => mp.value = $event),
                          onInput: applyRes
                        }, null, 544), [
                          [
                            vModelText,
                            mp.value,
                            void 0,
                            { number: true }
                          ]
                        ])
                      ]),
                      createBaseVNode("div", _hoisted_9, [
                        createBaseVNode("label", null, [
                          _cache[11] || (_cache[11] = createBaseVNode("span", null, "宽", -1)),
                          createBaseVNode("input", {
                            type: "number",
                            "aria-label": "画布宽度",
                            min: "1",
                            step: "1",
                            value: unref(store).state.width,
                            onChange: _cache[3] || (_cache[3] = ($event) => setWH("width", $event.target.valueAsNumber))
                          }, null, 40, _hoisted_10)
                        ]),
                        createBaseVNode("button", {
                          class: "swap",
                          title: "Swap width & height (flip orientation)",
                          onClick: swapWH
                        }, [
                          createVNode(_component_MdiIcon, { class: "mdi mdi-swap-horizontal" })
                        ]),
                        createBaseVNode("label", null, [
                          _cache[12] || (_cache[12] = createBaseVNode("span", null, "高", -1)),
                          createBaseVNode("input", {
                            type: "number",
                            "aria-label": "画布高度",
                            min: "1",
                            step: "1",
                            value: unref(store).state.height,
                            onChange: _cache[4] || (_cache[4] = ($event) => setWH("height", $event.target.valueAsNumber))
                          }, null, 40, _hoisted_11)
                        ])
                      ]),
                      createBaseVNode("div", _hoisted_12, [
                        createBaseVNode("span", _hoisted_13, "≈ " + toDisplayString(mpActual.value) + " MP", 1)
                      ]),
                      outsideCount.value ? (openBlock(), createElementBlock("div", _hoisted_14, [
                        createBaseVNode("span", null, [
                          createVNode(_component_MdiIcon, { class: "mdi mdi-alert-outline" }),
                          createTextVNode(" " + toDisplayString(outsideCount.value) + " box" + toDisplayString(outsideCount.value === 1 ? "" : "es") + " outside", 1)
                        ]),
                        createBaseVNode("button", {
                          class: "refit",
                          title: "Clamp every box into the current canvas",
                          onClick: refitBoxes
                        }, "refit")
                      ])) : createCommentVNode("", true)
                    ])
                  ]),
                  _: 1
                })
              ]),
              trail: withCtx(() => [
                createVNode(UiButton, {
                  icon: "",
                  title: "布局模板：保存 / 加载",
                  onClick: _cache[5] || (_cache[5] = ($event) => libraryOpen.value = true)
                }, {
                  default: withCtx(() => [
                    createVNode(_component_MdiIcon, { class: "mdi mdi-bookshelf" })
                  ]),
                  _: 1
                }),
                createVNode(UiPopover, { align: "right" }, {
                  trigger: withCtx(() => [
                    createVNode(UiButton, {
                      icon: "",
                      title: "操作帮助"
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_MdiIcon, { class: "mdi mdi-help-circle-outline" })
                      ]),
                      _: 1
                    })
                  ]),
                  default: withCtx(() => [
                    createBaseVNode("div", _hoisted_15, [
                      _cache[22] || (_cache[22] = createBaseVNode("p", { class: "h" }, "Canvas", -1)),
                      _cache[23] || (_cache[23] = createBaseVNode("dl", null, [
                        createBaseVNode("dt", null, "B / V"),
                        createBaseVNode("dd", null, "切换画框 / 选择；选择模式拖空白处可框选，Shift 追加"),
                        createBaseVNode("dt", null, "ctrl / ⌘ + drag"),
                        createBaseVNode("dd", null, "draw a new box"),
                        createBaseVNode("dt", null, "drag a box"),
                        createBaseVNode("dd", null, "move it"),
                        createBaseVNode("dt", null, "drag a handle"),
                        createBaseVNode("dd", null, "resize"),
                        createBaseVNode("dt", null, "click"),
                        createBaseVNode("dd", null, "select; ctrl / shift click to multi-select"),
                        createBaseVNode("dt", null, "click again"),
                        createBaseVNode("dd", null, "cycle through stacked / overlapping boxes")
                      ], -1)),
                      _cache[24] || (_cache[24] = createBaseVNode("p", { class: "h" }, "Keyboard", -1)),
                      _cache[25] || (_cache[25] = createBaseVNode("dl", null, [
                        createBaseVNode("dt", null, "ctrl / ⌘ + C / V"),
                        createBaseVNode("dd", null, "copy / paste the selection (pastes at the cursor)"),
                        createBaseVNode("dt", null, "ctrl / ⌘ + G"),
                        createBaseVNode("dd", null, "group the selected boxes · + shift to ungroup"),
                        createBaseVNode("dt", null, "ctrl / ⌘ + Z"),
                        createBaseVNode("dd", null, "undo · + shift to redo"),
                        createBaseVNode("dt", null, "Delete / Backspace"),
                        createBaseVNode("dd", null, "remove the selected box(es)")
                      ], -1)),
                      _cache[26] || (_cache[26] = createBaseVNode("p", { class: "h" }, "Items", -1)),
                      _cache[27] || (_cache[27] = createBaseVNode("dl", null, [
                        createBaseVNode("dt", null, "物体 / 人物 / 文字"),
                        createBaseVNode("dd", null, "在画框工具旁选择区域类型；选中后也可修改"),
                        createBaseVNode("dt", null, "text items"),
                        createBaseVNode("dd", null, "carry the exact visible characters")
                      ], -1)),
                      _cache[28] || (_cache[28] = createBaseVNode("p", { class: "h" }, "Reference", -1)),
                      createBaseVNode("dl", null, [
                        createBaseVNode("dt", null, [
                          createVNode(_component_MdiIcon, { class: "mdi mdi-image-outline" }),
                          _cache[16] || (_cache[16] = createTextVNode(" image", -1))
                        ]),
                        _cache[19] || (_cache[19] = createBaseVNode("dd", null, "load an image to trace over (or drop one on the canvas)", -1)),
                        createBaseVNode("dt", null, [
                          createVNode(_component_MdiIcon, { class: "mdi mdi-sync" }),
                          _cache[17] || (_cache[17] = createTextVNode(" 结果同步", -1))
                        ]),
                        _cache[20] || (_cache[20] = createBaseVNode("dd", null, [
                          createTextVNode("将生成图像和本节点的布局接入 "),
                          createBaseVNode("b", null, "TK MOSS 布局预览"),
                          createTextVNode("，生成后同步参考图")
                        ], -1)),
                        createBaseVNode("dt", null, [
                          createVNode(_component_MdiIcon, { class: "mdi mdi-television-play" }),
                          _cache[18] || (_cache[18] = createTextVNode(" 采样实时预览", -1))
                        ]),
                        _cache[21] || (_cache[21] = createBaseVNode("dd", null, "显示连接到布局预览节点的上游采样预览；只同步本编辑器绑定的结果", -1))
                      ]),
                      _cache[29] || (_cache[29] = createBaseVNode("p", { class: "h" }, "Outputs", -1)),
                      _cache[30] || (_cache[30] = createBaseVNode("dl", null, [
                        createBaseVNode("dt", null, "prompt"),
                        createBaseVNode("dd", null, "compiled MOSS-Image JSON (center-origin yxyx) → your sampler's positive prompt"),
                        createBaseVNode("dt", null, "draft"),
                        createBaseVNode("dd", null, "the editable draft JSON — feed it back, save it, or edit it by script"),
                        createBaseVNode("dt", null, "辅助输出"),
                        createBaseVNode("dd", null, [
                          createBaseVNode("b", null, "TK MOSS 布局预览"),
                          createTextVNode(" 输出区域遮罩、叠框图、透明度、尺寸与框坐标")
                        ])
                      ], -1)),
                      _cache[31] || (_cache[31] = createBaseVNode("p", { class: "tip" }, "Tip: open the JSON card and paste a draft (or a compiled prompt) to import it.", -1)),
                      _cache[32] || (_cache[32] = createBaseVNode("p", { class: "credit" }, [
                        createTextVNode(" MOSS edition of "),
                        createBaseVNode("b", null, "ComfyUI-IdeogramHelper"),
                        createTextVNode(" by nynxz (GPLv3)"),
                        createBaseVNode("br"),
                        createBaseVNode("a", {
                          href: "https://github.com/OpenMOSS/MOSS-Image",
                          target: "_blank",
                          rel: "noopener noreferrer"
                        }, "MOSS-Image prompt spec ↗")
                      ], -1))
                    ])
                  ]),
                  _: 1
                }),
                createVNode(UiPopover, { align: "right" }, {
                  trigger: withCtx(() => [
                    createVNode(UiButton, {
                      icon: "",
                      title: "清空画布"
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_MdiIcon, { class: "mdi mdi-broom" })
                      ]),
                      _: 1
                    })
                  ]),
                  default: withCtx(({ close }) => [
                    createBaseVNode("div", _hoisted_16, [
                      createBaseVNode("p", _hoisted_17, [
                        createVNode(_component_MdiIcon, { class: "mdi mdi-alert-outline" }),
                        _cache[33] || (_cache[33] = createTextVNode(" 清空整张画布？", -1))
                      ]),
                      _cache[35] || (_cache[35] = createBaseVNode("p", { class: "rh" }, "删除全部区域及全局描述。可按 Ctrl+Z 撤销。", -1)),
                      createBaseVNode("div", _hoisted_18, [
                        createBaseVNode("button", {
                          class: "rno",
                          onClick: ($event) => close()
                        }, "取消", 8, _hoisted_19),
                        createBaseVNode("button", {
                          class: "ryes",
                          onClick: ($event) => {
                            resetAll();
                            close();
                          }
                        }, [
                          createVNode(_component_MdiIcon, { class: "mdi mdi-broom" }),
                          _cache[34] || (_cache[34] = createTextVNode(" 清空", -1))
                        ], 8, _hoisted_20)
                      ])
                    ])
                  ]),
                  _: 1
                }),
                createBaseVNode("span", _hoisted_21, [
                  createVNode(UiButton, {
                    icon: "",
                    title: panelOpen.value ? "收起属性" : "展开属性",
                    onClick: _cache[6] || (_cache[6] = ($event) => panelOpen.value = !panelOpen.value)
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_MdiIcon, { class: "mdi mdi-dock-right" })
                    ]),
                    _: 1
                  }, 8, ["title"])
                ])
              ]),
              _: 1
            }, 8, ["prepare-reference"])
          ], 512),
          createBaseVNode("div", {
            class: "right",
            ref_key: "rightEl",
            ref: rightEl
          }, [
            !unref(store).state.ui.jsonOpen ? (openBlock(), createBlock(ElementEditor, { key: 0 })) : createCommentVNode("", true),
            createVNode(SummaryPanel),
            createVNode(ElementList),
            createVNode(JsonControls)
          ], 512),
          createBaseVNode("div", {
            class: "drawer-backdrop",
            onClick: _cache[7] || (_cache[7] = ($event) => panelOpen.value = false)
          })
        ]),
        createVNode(JsonPreview),
        createVNode(ElementContextMenu),
        createVNode(StudioLibrary, {
          open: libraryOpen.value,
          "onUpdate:open": _cache[8] || (_cache[8] = ($event) => libraryOpen.value = $event)
        }, null, 8, ["open"])
      ], 34);
    };
  }
});
const Studio = /* @__PURE__ */ _export_sfc(_sfc_main$1, [["__scopeId", "data-v-36a1f786"]]);
const paths = {
  "mdi-account-outline": "M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,6A2,2 0 0,0 10,8A2,2 0 0,0 12,10A2,2 0 0,0 14,8A2,2 0 0,0 12,6M12,13C14.67,13 20,14.33 20,17V20H4V17C4,14.33 9.33,13 12,13M12,14.9C9.03,14.9 5.9,16.36 5.9,17V18.1H18.1V17C18.1,16.36 14.97,14.9 12,14.9Z",
  "mdi-alert": "M13 14H11V9H13M13 18H11V16H13M1 21H23L12 2L1 21Z",
  "mdi-alert-circle": "M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z",
  "mdi-alert-circle-outline": "M11,15H13V17H11V15M11,7H13V13H11V7M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20Z",
  "mdi-alert-outline": "M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16",
  "mdi-arrow-down": "M11,4H13V16L18.5,10.5L19.92,11.92L12,19.84L4.08,11.92L5.5,10.5L11,16V4Z",
  "mdi-arrow-up": "M13,20H11V8L5.5,13.5L4.08,12.08L12,4.16L19.92,12.08L18.5,13.5L13,8V20Z",
  "mdi-bookshelf": "M9 3V18H12V3H9M12 5L16 18L19 17L15 4L12 5M5 5V18H8V5H5M3 19V21H21V19H3Z",
  "mdi-broom": "M19.36,2.72L20.78,4.14L15.06,9.85C16.13,11.39 16.28,13.24 15.38,14.44L9.06,8.12C10.26,7.22 12.11,7.37 13.65,8.44L19.36,2.72M5.93,17.57C3.92,15.56 2.69,13.16 2.35,10.92L7.23,8.83L14.67,16.27L12.58,21.15C10.34,20.81 7.94,19.58 5.93,17.57Z",
  "mdi-check": "M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z",
  "mdi-check-circle": "M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z",
  "mdi-check-circle-outline": "M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M12 20C7.59 20 4 16.41 4 12S7.59 4 12 4 20 7.59 20 12 16.41 20 12 20M16.59 7.58L10 14.17L7.41 11.59L6 13L10 17L18 9L16.59 7.58Z",
  "mdi-checkbox-multiple-marked-outline": "M20,16V10H22V16A2,2 0 0,1 20,18H8C6.89,18 6,17.1 6,16V4C6,2.89 6.89,2 8,2H16V4H8V16H20M10.91,7.08L14,10.17L20.59,3.58L22,5L14,13L9.5,8.5L10.91,7.08M16,20V22H4A2,2 0 0,1 2,20V7H4V20H16Z",
  "mdi-chevron-down": "M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z",
  "mdi-chevron-right": "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z",
  "mdi-chevron-up": "M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z",
  "mdi-close": "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
  "mdi-content-copy": "M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z",
  "mdi-content-duplicate": "M11,17H4A2,2 0 0,1 2,15V3A2,2 0 0,1 4,1H16V3H4V15H11V13L15,16L11,19V17M19,21V7H8V13H6V7A2,2 0 0,1 8,5H19A2,2 0 0,1 21,7V21A2,2 0 0,1 19,23H8A2,2 0 0,1 6,21V19H8V21H19Z",
  "mdi-content-save-outline": "M17 3H5C3.89 3 3 3.9 3 5V19C3 20.1 3.89 21 5 21H19C20.1 21 21 20.1 21 19V7L17 3M19 19H5V5H16.17L19 7.83V19M12 12C10.34 12 9 13.34 9 15S10.34 18 12 18 15 16.66 15 15 13.66 12 12 12M6 6H15V10H6V6Z",
  "mdi-delete-outline": "M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H16V19H8V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z",
  "mdi-dock-right": "M20 4H4A2 2 0 0 0 2 6V18A2 2 0 0 0 4 20H20A2 2 0 0 0 22 18V6A2 2 0 0 0 20 4M15 18H4V6H15Z",
  "mdi-dots-horizontal": "M16,12A2,2 0 0,1 18,10A2,2 0 0,1 20,12A2,2 0 0,1 18,14A2,2 0 0,1 16,12M10,12A2,2 0 0,1 12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12M4,12A2,2 0 0,1 6,10A2,2 0 0,1 8,12A2,2 0 0,1 6,14A2,2 0 0,1 4,12Z",
  "mdi-drag-vertical": "M9,3H11V5H9V3M13,3H15V5H13V3M9,7H11V9H9V7M13,7H15V9H13V7M9,11H11V13H9V11M13,11H15V13H13V11M9,15H11V17H9V15M13,15H15V17H13V15M9,19H11V21H9V19M13,19H15V21H13V19Z",
  "mdi-flip-horizontal": "M15 21H17V19H15M19 9H21V7H19M3 5V19C3 20.1 3.9 21 5 21H9V19H5V5H9V3H5C3.9 3 3 3.9 3 5M19 3V5H21C21 3.9 20.1 3 19 3M11 23H13V1H11M19 17H21V15H19M15 5H17V3H15M19 13H21V11H19M19 21C20.1 21 21 20.1 21 19H19Z",
  "mdi-flip-vertical": "M3 15V17H5V15M15 19V21H17V19M19 3H5C3.9 3 3 3.9 3 5V9H5V5H19V9H21V5C21 3.9 20.1 3 19 3M21 19H19V21C20.1 21 21 20.1 21 19M1 11V13H23V11M7 19V21H9V19M19 15V17H21V15M11 19V21H13V19M3 19C3 20.1 3.9 21 5 21V19Z",
  "mdi-folder-image": "M5,17L9.5,11L13,15.5L15.5,12.5L19,17M20,6H12L10,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8A2,2 0 0,0 20,6Z",
  "mdi-format-list-bulleted": "M7,5H21V7H7V5M7,13V11H21V13H7M4,4.5A1.5,1.5 0 0,1 5.5,6A1.5,1.5 0 0,1 4,7.5A1.5,1.5 0 0,1 2.5,6A1.5,1.5 0 0,1 4,4.5M4,10.5A1.5,1.5 0 0,1 5.5,12A1.5,1.5 0 0,1 4,13.5A1.5,1.5 0 0,1 2.5,12A1.5,1.5 0 0,1 4,10.5M7,19V17H21V19H7M4,16.5A1.5,1.5 0 0,1 5.5,18A1.5,1.5 0 0,1 4,19.5A1.5,1.5 0 0,1 2.5,18A1.5,1.5 0 0,1 4,16.5Z",
  "mdi-format-text": "M18.5,4L19.66,8.35L18.7,8.61C18.25,7.74 17.79,6.87 17.26,6.43C16.73,6 16.11,6 15.5,6H13V16.5C13,17 13,17.5 13.33,17.75C13.67,18 14.33,18 15,18V19H9V18C9.67,18 10.33,18 10.67,17.75C11,17.5 11,17 11,16.5V6H8.5C7.89,6 7.27,6 6.74,6.43C6.21,6.87 5.75,7.74 5.3,8.61L4.34,8.35L5.5,4H18.5Z",
  "mdi-group": "M1,1V5H2V19H1V23H5V22H19V23H23V19H22V5H23V1H19V2H5V1M5,4H19V5H20V19H19V20H5V19H4V5H5M6,6V14H9V18H18V9H14V6M8,8H12V12H8M14,11H16V16H11V14H14",
  "mdi-help-circle-outline": "M11,18H13V16H11V18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,6A4,4 0 0,0 8,10H10A2,2 0 0,1 12,8A2,2 0 0,1 14,10C14,12 11,11.75 11,15H13C13,12.75 16,12.5 16,10A4,4 0 0,0 12,6Z",
  "mdi-image-outline": "M19,19H5V5H19M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M13.96,12.29L11.21,15.83L9.25,13.47L6.5,17H17.5L13.96,12.29Z",
  "mdi-label": "M17.63,5.84C17.27,5.33 16.67,5 16,5H5A2,2 0 0,0 3,7V17A2,2 0 0,0 5,19H16C16.67,19 17.27,18.66 17.63,18.15L22,12L17.63,5.84Z",
  "mdi-label-outline": "M16,17H5V7H16L19.55,12M17.63,5.84C17.27,5.33 16.67,5 16,5H5A2,2 0 0,0 3,7V17A2,2 0 0,0 5,19H16C16.67,19 17.27,18.66 17.63,18.15L22,12L17.63,5.84Z",
  "mdi-link-variant": "M10.59,13.41C11,13.8 11,14.44 10.59,14.83C10.2,15.22 9.56,15.22 9.17,14.83C7.22,12.88 7.22,9.71 9.17,7.76V7.76L12.71,4.22C14.66,2.27 17.83,2.27 19.78,4.22C21.73,6.17 21.73,9.34 19.78,11.29L18.29,12.78C18.3,11.96 18.17,11.14 17.89,10.36L18.36,9.88C19.54,8.71 19.54,6.81 18.36,5.64C17.19,4.46 15.29,4.46 14.12,5.64L10.59,9.17C9.41,10.34 9.41,12.24 10.59,13.41M13.41,9.17C13.8,8.78 14.44,8.78 14.83,9.17C16.78,11.12 16.78,14.29 14.83,16.24V16.24L11.29,19.78C9.34,21.73 6.17,21.73 4.22,19.78C2.27,17.83 2.27,14.66 4.22,12.71L5.71,11.22C5.7,12.04 5.83,12.86 6.11,13.65L5.64,14.12C4.46,15.29 4.46,17.19 5.64,18.36C6.81,19.54 8.71,19.54 9.88,18.36L13.41,14.83C14.59,13.66 14.59,11.76 13.41,10.59C13,10.2 13,9.56 13.41,9.17Z",
  "mdi-link-variant-off": "M2,5.27L3.28,4L20,20.72L18.73,22L13.9,17.17L11.29,19.78C9.34,21.73 6.17,21.73 4.22,19.78C2.27,17.83 2.27,14.66 4.22,12.71L5.71,11.22C5.7,12.04 5.83,12.86 6.11,13.65L5.64,14.12C4.46,15.29 4.46,17.19 5.64,18.36C6.81,19.54 8.71,19.54 9.88,18.36L12.5,15.76L10.88,14.15C10.87,14.39 10.77,14.64 10.59,14.83C10.2,15.22 9.56,15.22 9.17,14.83C8.12,13.77 7.63,12.37 7.72,11L2,5.27M12.71,4.22C14.66,2.27 17.83,2.27 19.78,4.22C21.73,6.17 21.73,9.34 19.78,11.29L18.29,12.78C18.3,11.96 18.17,11.14 17.89,10.36L18.36,9.88C19.54,8.71 19.54,6.81 18.36,5.64C17.19,4.46 15.29,4.46 14.12,5.64L10.79,8.97L9.38,7.55L12.71,4.22M13.41,9.17C13.8,8.78 14.44,8.78 14.83,9.17C16.2,10.54 16.61,12.5 16.06,14.23L14.28,12.46C14.23,11.78 13.94,11.11 13.41,10.59C13,10.2 13,9.56 13.41,9.17Z",
  "mdi-link-variant-plus": "M10.6 13.4A1 1 0 0 1 9.2 14.8A4.8 4.8 0 0 1 9.2 7.8L12.7 4.2A5.1 5.1 0 0 1 19.8 4.2A5.1 5.1 0 0 1 19.8 11.3L18.3 12.8A6.4 6.4 0 0 0 17.9 10.4L18.4 9.9A3.2 3.2 0 0 0 18.4 5.6A3.2 3.2 0 0 0 14.1 5.6L10.6 9.2A2.9 2.9 0 0 0 10.6 13.4M23 18V20H20V23H18V20H15V18H18V15H20V18M16.2 13.7A4.8 4.8 0 0 0 14.8 9.2A1 1 0 0 0 13.4 10.6A2.9 2.9 0 0 1 13.4 14.8L9.9 18.4A3.2 3.2 0 0 1 5.6 18.4A3.2 3.2 0 0 1 5.6 14.1L6.1 13.7A7.3 7.3 0 0 1 5.7 11.2L4.2 12.7A5.1 5.1 0 0 0 4.2 19.8A5.1 5.1 0 0 0 11.3 19.8L13.1 18A6 6 0 0 1 16.2 13.7Z",
  "mdi-loading": "M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z",
  "mdi-magnify": "M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z",
  "mdi-menu-down": "M7,10L12,15L17,10H7Z",
  "mdi-pencil-outline": "M14.06,9L15,9.94L5.92,19H5V18.08L14.06,9M17.66,3C17.41,3 17.15,3.1 16.96,3.29L15.13,5.12L18.88,8.87L20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18.17,3.09 17.92,3 17.66,3M14.06,6.19L3,17.25V21H6.75L17.81,9.94L14.06,6.19Z",
  "mdi-plus": "M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z",
  "mdi-record": "M19,12C19,15.86 15.86,19 12,19C8.14,19 5,15.86 5,12C5,8.14 8.14,5 12,5C15.86,5 19,8.14 19,12Z",
  "mdi-redo": "M18.4,10.6C16.55,9 14.15,8 11.5,8C6.85,8 2.92,11.03 1.54,15.22L3.9,16C4.95,12.81 7.95,10.5 11.5,10.5C13.45,10.5 15.23,11.22 16.62,12.38L13,16H22V7L18.4,10.6Z",
  "mdi-refresh": "M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z",
  "mdi-shape-outline": "M11,13.5V21.5H3V13.5H11M9,15.5H5V19.5H9V15.5M12,2L17.5,11H6.5L12,2M12,5.86L10.08,9H13.92L12,5.86M17.5,13C20,13 22,15 22,17.5C22,20 20,22 17.5,22C15,22 13,20 13,17.5C13,15 15,13 17.5,13M17.5,15A2.5,2.5 0 0,0 15,17.5A2.5,2.5 0 0,0 17.5,20A2.5,2.5 0 0,0 20,17.5A2.5,2.5 0 0,0 17.5,15Z",
  "mdi-swap-horizontal": "M21,9L17,5V8H10V10H17V13M7,11L3,15L7,19V16H14V14H7V11Z",
  "mdi-sync": "M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z",
  "mdi-sync-alert": "M11,13H13V7H11M21,4H15V10L17.24,7.76C18.32,8.85 19,10.34 19,12C19,14.61 17.33,16.83 15,17.65V19.74C18.45,18.85 21,15.73 21,12C21,9.79 20.09,7.8 18.64,6.36M11,17H13V15H11M3,12C3,14.21 3.91,16.2 5.36,17.64L3,20H9V14L6.76,16.24C5.68,15.15 5,13.66 5,12C5,9.39 6.67,7.17 9,6.35V4.26C5.55,5.15 3,8.27 3,12Z",
  "mdi-sync-off": "M20,4H14V10L16.24,7.76C17.32,8.85 18,10.34 18,12C18,13 17.75,13.94 17.32,14.77L18.78,16.23C19.55,15 20,13.56 20,12C20,9.79 19.09,7.8 17.64,6.36L20,4M2.86,5.41L5.22,7.77C4.45,9 4,10.44 4,12C4,14.21 4.91,16.2 6.36,17.64L4,20H10V14L7.76,16.24C6.68,15.15 6,13.66 6,12C6,11 6.25,10.06 6.68,9.23L14.76,17.31C14.5,17.44 14.26,17.56 14,17.65V19.74C14.79,19.53 15.54,19.2 16.22,18.78L18.58,21.14L19.85,19.87L4.14,4.14L2.86,5.41M10,6.35V4.26C9.2,4.47 8.45,4.8 7.77,5.22L9.23,6.68C9.5,6.56 9.73,6.44 10,6.35Z",
  "mdi-television-off": "M0.5,2.77L1.78,1.5L21,20.72L19.73,22L16.73,19H16V21H8V19H3A2,2 0 0,1 1,17V5C1,4.5 1.17,4.07 1.46,3.73L0.5,2.77M21,17V5H7.82L5.82,3H21A2,2 0 0,1 23,5V17C23,17.85 22.45,18.59 21.7,18.87L19.82,17H21M3,17H14.73L3,5.27V17Z",
  "mdi-television-play": "M21,3H3C1.89,3 1,3.89 1,5V17A2,2 0 0,0 3,19H8V21H16V19H21A2,2 0 0,0 23,17V5C23,3.89 22.1,3 21,3M21,17H3V5H21M16,11L9,15V7",
  "mdi-trash-can-outline": "M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z",
  "mdi-tune-variant": "M8 13C6.14 13 4.59 14.28 4.14 16H2V18H4.14C4.59 19.72 6.14 21 8 21S11.41 19.72 11.86 18H22V16H11.86C11.41 14.28 9.86 13 8 13M8 19C6.9 19 6 18.1 6 17C6 15.9 6.9 15 8 15S10 15.9 10 17C10 18.1 9.1 19 8 19M19.86 6C19.41 4.28 17.86 3 16 3S12.59 4.28 12.14 6H2V8H12.14C12.59 9.72 14.14 11 16 11S19.41 9.72 19.86 8H22V6H19.86M16 9C14.9 9 14 8.1 14 7C14 5.9 14.9 5 16 5S18 5.9 18 7C18 8.1 17.1 9 16 9Z",
  "mdi-undo": "M12.5,8C9.85,8 7.45,9 5.6,10.6L2,7V16H11L7.38,12.38C8.77,11.22 10.54,10.5 12.5,10.5C16.04,10.5 19.05,12.81 20.1,16L22.47,15.22C21.08,11.03 17.15,8 12.5,8Z",
  "mdi-ungroup": "M2,2H6V3H13V2H17V6H16V9H18V8H22V12H21V18H22V22H18V21H12V22H8V18H9V16H6V17H2V13H3V6H2V2M18,12V11H16V13H17V17H13V16H11V18H12V19H18V18H19V12H18M13,6V5H6V6H5V13H6V14H9V12H8V8H12V9H14V6H13M12,12H11V14H13V13H14V11H12V12Z",
  "mdi-vector-square": "M2,2H8V4H16V2H22V8H20V16H22V22H16V20H8V22H2V16H4V8H2V2M16,8V6H8V8H6V16H8V18H16V16H18V8H16M4,4V6H6V4H4M18,4V6H20V4H18M4,18V20H6V18H4M18,18V20H20V18H18Z"
};
const _hoisted_1 = {
  class: "tk-studio-icon",
  viewBox: "0 0 24 24",
  "aria-hidden": "true"
};
const _hoisted_2 = ["d"];
const _sfc_main = /* @__PURE__ */ defineComponent({
  __name: "MdiIcon",
  setup(__props) {
    const attrs = useAttrs();
    const path = computed(() => {
      const name = String(attrs.class || "").split(/\s+/).find((k) => k in paths);
      return name ? paths[name] : paths["mdi-vector-square"];
    });
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("svg", _hoisted_1, [
        createBaseVNode("path", { d: path.value }, null, 8, _hoisted_2)
      ]);
    };
  }
});
function mountStudio(container, value, onChange, prepareReference) {
  let stored = value;
  const widget = { get value() {
    return stored;
  }, set value(v) {
    stored = v;
    onChange(v);
  }, serializeValue: null, prepareReference };
  const app = createApp(Studio, { widget });
  app.component("MdiIcon", _sfc_main);
  const instance = app.mount(container);
  return {
    ready: nextTick(),
    payload: () => instance.exportPayload(),
    load: (v) => instance.loadPayload(v),
    selection: () => instance.selection(),
    captions: (draft) => instance.applyCaptions(draft),
    compiled: () => instance.compiled(),
    reference: (url, transient = false) => instance.reference(url, transient),
    destroy: () => app.unmount()
  };
}
export {
  mountStudio
};
