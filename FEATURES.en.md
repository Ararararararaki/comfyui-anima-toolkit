# Feature summary

[English quick start](README.en.md) | [Full Chinese manual](https://github.com/Ararararararaki/comfyui-anima-toolkit/blob/main/docs/FEATURES.md)

The English toolbox interface is implemented locally and has not yet been published. In this local implementation, choose **Settings → Language / 语言 → English**. The choice is saved and the page reloads. Some workflow-node labels/tooltips and historical release notes remain in Chinese. Saved user content is kept as written.

## Core tools

| Tool | Main uses |
|---|---|
| Batch LoRA loader | Parse `<lora:name:weight>` syntax, visually choose local models, adjust weights, enable/reorder entries, reuse groups and output activated trigger words |
| Local LoRA | Recursive scans with relative paths, subfolder categories, Civitai matching, previews, metadata, editable trigger words and sending models to ComfyUI |
| LoRA Explorer | Browse, filter, discover and download Civitai models |
| Prompt Library / Cards | Save, search, categorize and edit prompts; bilingual tag cards, hide/restore fragments, translation, normalization and Chinese/English autocomplete |
| Prompt Agent | Anima / Krea 2 prompt creation and iterative edits, locks, undo/history and image interrogation/expansion through configured services |
| Prompt Batch | Sequential groups from `input/prompts/`, with server-side progress, pause/resume, retry, skip and cancel |
| Other nodes | Camera/pose references, outfit selection, prompt saving, text joining, string/image routing and Anima/Cosmos empty latent presets |

Prompt Agent requires your own compatible model API. Optional DSH integration is separate from normal API use. Models and personal credentials are not included.

Multi Gallery supports **Danbooru, Civitai, Pixiv, Safebooru, yande.re and Konachan.net**, with source-specific search, filters, previews, downloads and image/metadata output. Authorization requirements differ by source. Pixiv reference images do not provide generation prompts. The separate local AnimaDex picker inserts character prompt tags without an LLM.

## Images and Outputs

- **Image analysis:** read saved prompts, workflow graphs and generation parameters from PNG, JPEG and WebP, including common ComfyUI, A1111 and NovelAI metadata. Metadata presence does not guarantee that the original prompt text was recorded. Interrogation results have a separate source label.
- **Browse:** register multiple folders, browse by folder or work/character, and combine character, work, tag and filename search terms. Browser folders need permission. Removing a source registration does not delete images.
- **Organize:** explicitly categorize enabled folders from saved prompts. Pending processing and unrecognized characters are separate states. Optional WD14 tagging uses an installed ONNX+CSV model and configurable thresholds; missing models are not downloaded automatically.
- **Edit:** zoom, pan, rotate, flip, crop, draw, cover areas, apply adjustable mosaic blocks and undo. Preview edits do not automatically change originals. Save a copy, or confirm an overwrite that checks and backs up the source first.
- **Export:** copy, download or drag using global generation-metadata and attribution settings. Removing generation data prevents workflow recovery from the exported copy.
- **Pixiv bridge:** an optional, manually installed Chrome/Edge extension accepts local HTTP toolbox exports without entering an address or key. Refresh both the toolbox and Pixiv pages after installation. See the [English installation steps](README.en.md#pixiv-receiver-bridge) and [bridge details](integrations/pixiv-drop-bridge/README.md).

## Settings and local data

Settings includes language, appearance, typography, custom CSS and data-transfer controls. The toolbox menu reopens release notes and the bridge download.

| Data | Location |
|---|---|
| Language, appearance and browser preferences | Current browser profile and site storage |
| Outfit cards | Browser `clothing-db` IndexedDB; use the library's own export/import |
| Prompt Library | IndexedDB plus `data/prompt_library.json` and its backup |
| LoRA groups/categories and shared metadata | `data/anima_meta.json` |
| Source credentials/provider configuration | Local files under `data/`; not shipped with the plugin |
| Prompt batch manifests | `data/batches/` |

Use a consistent browser profile and address/port. `localhost`, `127.0.0.1` and different ports use separate browser storage. Export the relevant settings/libraries before clearing site data, and keep `data/` when updating or moving an installation. Directory permissions may need to be granted again.


## 2.34.0 coverage limits

The interface language switch currently covers the toolbox only. Workflow nodes and remaining plugin interfaces are deferred to a later release. Prompt Agent translation checks are advisory: a valid layout can continue with a visible quality warning, and translation completion is not guaranteed. Layered region painting and mask-to-bbox editing are not included in this release.
