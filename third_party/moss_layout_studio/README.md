# ComfyUI-MOSSLayout

A visual **studio** for composing [MOSS-Image](https://github.com/OpenMOSS/MOSS-Image)
Layout JSON box prompts inside ComfyUI — drag boxes on a canvas, write into them,
and get both the editable draft JSON and the exact compiled model prompt.

Forked from [ComfyUI-IdeogramHelper](https://github.com/nynxz/ComfyUI-IdeogramHelper)
by nynxz (GPLv3); the data model was rebuilt for MOSS-Image's official
[prompt-enhancer spec](https://github.com/OpenMOSS/MOSS-Image/tree/main/skills/moss-image-prompt-enhancer).

![MOSS Layout Studio - a coffee-shop poster built from four boxes, with the bbox overlay stamped onto the generation](.github/assets/result.jpg)

*A real run of the bundled example: natural-language request → four bbox items
(coffee cup · headline · date line · OPEN badge) → MOSS-Image generation.
The annotated copy stamps the boxes onto the result so you can see placement
drift at a glance.*

## Install

```bash
cd ComfyUI/custom_nodes
git clone <this repo> ComfyUI-MOSSLayout
```

The frontend ships pre-built in `web/`. Restart ComfyUI, then add **MOSS → MOSS Layout Studio**.

## The two JSON formats

| | draft (editable) | compiled prompt (model-facing) |
|---|---|---|
| bbox | `[x1,y1,x2,y2]` absolute pixels, top-left origin | integer, center-origin `yxyx` |
| canvas | `width`/`height` (multiples of 16) | not present |
| extra | — | `bbox_coord_space: "abs_centralized"`, `bbox_format: "yxyx"` |

The **draft** is the single source of truth. It is stored whole inside the
workflow (`widgets_values[0].draft`), shown and editable in the JSON panel, and
compiled server-side with the exact algorithm of the official
`compile_prompt.py` (floor mins / ceil maxs, then subtract the canvas center).

Scripts and agents read/write the workflow's `draft` directly, or wire the same
whole-segment JSON through the `draft` input / **MOSS Layout Studio JSON Sync** node —
the editor picks it up on the next load; the canvas always follows the JSON,
never the other way around.

## Nodes (category **MOSS**)

### MOSS Layout Studio
The editor: resolution (aspect × megapixels, snapped to /16), drag/resize/marquee
boxes, object/character/text items, summary caption + meta tags + canvas mode +
palette, undo/redo, groups, linked copies, reference backdrop, live preview.

![MOSS Layout Studio node - canvas, summary, item list, draft JSON](.github/assets/studio.png)

Outputs:

| port | type | content |
|---|---|---|
| `prompt` | STRING | compiled MOSS-Image prompt JSON (one line) — wire into your positive prompt |
| `draft` | STRING | pretty-printed whole draft JSON — save, feed back, or hand to a script |
| `extras` | MOSS_LAYOUT_EXTRAS | overlay / alpha / width / height / bboxes bundle |
| `draft` input (optional) | STRING | whole-segment draft (or compiled) JSON; non-empty overrides the editor |

**Nodes 2.0:** the widget marks its container `data-capture-wheel="true"` and stops
wheel forwarding from its scrollable children. Mouse wheel scrolls the JSON editor
and preview normally; canvas zoom still works outside those scrollable areas.

**Prompt-only PNGs:** when an imported image has only `prompt` metadata and the
Studio's `draft` STRING input contains the full layout, the editor rebuilds its
boxes/summary from that draft. The one-shot `draft` input is cleared afterwards so
later UI edits are not overridden by the stale import.

### MOSS Layout Studio Extras
`extras` → `overlay` (IMAGE), `alpha` (MASK), `width`, `height`, `bboxes`
(BOUNDING_BOX). Composite the overlay over your generation to check whether the
model placed things where your boxes were.

### MOSS Layout Studio Ref Sync
Route a generation into it and studios with *sync* on use it as a trace
backdrop. Passes the image through.

### MOSS Layout Studio JSON Sync
Validate, canonicalize and push a whole draft (or compiled) JSON to open
studios. `global` applies to every open Studio (ignoring the per-studio
*json sync* toggle); `force` overrides the toggle too. For compiled JSON
without `width`/`height`, set the node's `width`/`height` canvas. `bbox_mode`
defaults to `auto` (clamps edge overflow up to `bbox_tolerance`, default 2 px);
`reject` fails on any overflow, `clamp` clamps any overflow. Invalid labels,
missing `text` and unsupported `bbox_format` still raise with the item index
instead of silently rewriting the payload.

## Round-trip guarantee

`widgets_values[0] = {"draft": <official draft schema>, "studio": <editor-only state>}`

- The draft contains **only** official schema fields — no editor metadata.
- On load, if the saved `studio` state matches the saved `draft`, the editor
  restores exactly (colors, groups, links survive). If a script changed the
  draft, the draft wins and the canvas is rebuilt from it.
- Editor-only state that cannot round-trip through a script rewrite (custom box
  colors, links, groups) is regenerated deterministically.

## Example workflow

Open `example_workflows/moss-layout-t2i.json` (or drag it onto the canvas).
It ships with the official cup example draft pre-filled and the full MOSS-Image
t2i chain: **MOSS Layout Studio → CLIPTextEncode → KSampler (SLG block 22) →
VAE → SaveImage**, plus **Ref Sync** (feeds the result back as the studio's
trace backdrop) and **ImageCompositeMasked**, which stamps the bbox overlay
onto a second annotated copy of the output — placement check included, no
separate overlay image needed.

![The bundled workflow - Layout Studio, Model Loaders, Prompt Encoding, Layout Sampling, Overlay & Output groups](.github/assets/workflow.jpg)
Set your resolution in the studio (the chip in the canvas toolbar) and it
propagates automatically: **Extras `width`/`height` are wired into the latent
inputs**, so the bbox pixel space and the generation canvas can never drift
apart — the studio is the single resolution source. CJK captions render
on the overlay via system fonts (msyh / PingFang / Noto CJK).

## Scripted / agent access

The whole draft lives in the workflow file and is editable without opening the
UI, and a draft can be generated headlessly — see
[`skills/moss-layout-prompt/SKILL.md`](skills/moss-layout-prompt/SKILL.md)
(a complete playbook: write draft → validate → compile → deliver):

```bash
# read / rewrite the draft inside a saved workflow
python3 skills/moss-layout-prompt/scripts/layout_tool.py get  my_workflow.json --out draft.json
python3 skills/moss-layout-prompt/scripts/layout_tool.py set  my_workflow.json draft.json

# validate + compile to the one-line model prompt
python3 skills/moss-layout-prompt/scripts/layout_tool.py validate draft.json
python3 skills/moss-layout-prompt/scripts/layout_tool.py compile  draft.json

# headless generation: inject the draft, queue, print output files
python3 skills/moss-layout-prompt/scripts/submit.py draft.json --server http://127.0.0.1:7860
```

Programmatic surfaces: the workflow `draft` object, the node's `draft` input
(overrides the editor at execution time), the `draft`/`prompt` outputs, the
**MOSS Layout Studio JSON Sync** node, `POST /mosslayout/import`,
`POST /mosslayout/preview`, and the normal `/prompt` API
(`MossLayoutStudio.inputs.studio = {"draft": ..., "studio": {}}`).

## Global import (HTTP)

Image-parsing / VLM scripts can hand a raw layout JSON to every open Studio.
The importer accepts an **editor draft** (`abs`/`xyxy`, with or without
`width`/`height`), a **compiled prompt** (`abs_centralized`/`yxyx`), or a
caption-only payload, and returns a canonical `abs`/`xyxy` draft:

```bash
curl -X POST http://127.0.0.1:7860/mosslayout/import \
  -H 'Content-Type: application/json' \
  -d '{"json": "<compiled-or-draft-json>", "width": 1536, "height": 1024}'
```

Body fields:

| field | default | meaning |
|---|---|---|
| `json` | required | JSON string or object (code fences tolerated) |
| `width` / `height` | — | target canvas for compiled JSON without its own dims; both required together, multiples of 16 |
| `broadcast` | `true` | send `moss-layout.json-sync` after a successful import |
| `global` | `true` | event applies to every open Studio, regardless of its `jsonSync` toggle |
| `force` | `true` | override the toggle even when `global` is false |
| `bbox_mode` | `auto` | `auto` clamps edge overflow up to `bbox_tolerance`; `reject` errors on any overflow; `clamp` clamps any overflow and reports warnings |
| `bbox_tolerance` | `2.0` | Maximum pixel overflow accepted by `auto` before it errors |

The response contains the canonical `draft` / `draft_json`, `compiled`,
`warnings`, `errors`, `item_count` (input and output), `compiled`/`compilable`,
`broadcast`, and `importer` / `importer_version` for script compatibility.
On schema errors the HTTP status is 400, `draft` is `null`, and no event is
broadcast. External `width`/`height` take priority over the target canvas.
Unknown `bbox_coord_space` / `bbox_format` values are rejected, never silently
treated as `abs`/`xyxy`; invalid labels, text items without `text`, and
out-of-canvas boxes name the exact item index. Every valid item, including its
`caption`, `text`, `tags`, `palette` and `bbox`, survives the round trip.

The legacy per-studio behaviour is unchanged: a `moss-layout.json-sync` event
without `global`/`force` still only applies where `jsonSync` is on.

## Development

```bash
npm install
npm run build   # -> web/main.js (committed; ComfyUI serves it directly)
```

Hard-refresh the browser after a frontend build; restart ComfyUI after Python changes.

## Acknowledgements

This project is a fork of and would not exist without
**[ComfyUI-IdeogramHelper](https://github.com/nynxz/ComfyUI-IdeogramHelper)** by
**Henry Lee (@nynxz)** — the visual studio concept, the canvas/editor UX, the
node architecture and large parts of the codebase are theirs; this fork
re-targets that work onto the MOSS-Image Layout format. Thank you for building
and sharing it.

MOSS-Image and its Layout prompt specification are by
[OpenMOSS](https://github.com/OpenMOSS/MOSS-Image).

## License

GPLv3, following upstream ComfyUI-IdeogramHelper. MOSS-Image prompt format by
OpenMOSS; see their repo for the model and spec.
