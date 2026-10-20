# TK Toolkit

[简体中文](README.md) | [English](README.en.md)

A ComfyUI custom-node pack and local toolbox for LoRAs, prompts, reference images and generated outputs. Built for Anima workflows, with other model families supported by individual tools. It manages inference workflows; it does not train LoRAs.

Current release: **2.34.0**. By 时运Toki. MIT license. QQ community: **758086740**.

## Language coverage

Choose Simplified Chinese or English in the toolbox Settings. Version 2.34.0 covers the toolbox only; translation is not complete across the plugin. Workflow nodes and remaining interfaces are planned for a later release. User prompts, tags and saved data are not translated when changing the interface language.

## Install

Search for **TK Toolkit** in ComfyUI-Manager. Its Registry ID is `anima-toolkit` ([Registry page](https://registry.comfy.org/nodes/anima-toolkit)).

Or clone it into your ComfyUI installation:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ararararararaki/comfyui-anima-toolkit ComfyUI-Anima-Batch-LoRA
```

Restart ComfyUI. If dependencies are missing, install `requirements.txt` with the Python environment that runs ComfyUI. Optional dependencies are in `requirements-optional.txt`.

The built `app/` toolbox is included. Normal use requires neither Node.js nor a frontend build.

## Open the toolbox and choose English

English toolbox support is implemented in the local source and has not yet been published. The current public release may still display the Chinese interface.

Click **TK Toolkit / 本地工具箱** in ComfyUI's toolbar, or the panel button in the batch LoRA loader. Search for `TK` in the node menu to find the workflow nodes.

For the folder above, the direct entry is [the local toolbox](http://localhost:8188/extensions/ComfyUI-Anima-Batch-LoRA/app/). Use your actual ComfyUI address/port if different. Chrome or Edge on localhost provides the fullest folder-access support.

Open **Settings (设置) → Language / 语言 → English**. The choice is saved in this browser and the toolbox reloads. Switch back to 简体中文 from the same control.

Some workflow-node labels/tooltips, historical changelog entries and detailed documentation remain in Chinese. The language control does not translate your prompts, model names, paths or notes.

## Core features

| Task | Tools |
|---|---|
| LoRAs | Batch loading, individual weights and trigger words; recursive local scans, subfolder categories, Civitai matching and downloads |
| Prompts | Prompt Library and Prompt Cards, bilingual tags, translation, normalization and autocomplete |
| Image analysis | Read saved prompts, workflows and generation parameters from PNG, JPEG and WebP metadata |
| Outputs | Multiple folders, work/character browsing, search, favorites, ratings, preview edits and export metadata controls |
| References | Multi Gallery: Danbooru, Civitai, Pixiv, Safebooru, yande.re and Konachan.net |
| Workflow helpers | TK Prompt Agent for Anima / Krea 2, sequential prompt batches, camera/pose tools and text/image routing |

Prompt Agent requires your own compatible model API connection. Models, personal credentials and derived recognition caches are not bundled. See the [English feature summary](FEATURES.en.md), [full Chinese manual](https://github.com/Ararararararaki/comfyui-anima-toolkit/blob/main/docs/FEATURES.md) and [Prompt Agent guide](https://github.com/Ararararararaki/comfyui-anima-toolkit/blob/main/services/prompt_agent/README.md).

## Pixiv receiver bridge

The optional **TK → Pixiv receiver bridge 0.2.0** transfers an Outputs image or edited preview into Pixiv's image upload control.

1. Download the archive from **Updates & QQ group** in the toolbox, or obtain it from [integrations/pixiv-drop-bridge](integrations/pixiv-drop-bridge/README.md). Extract it into a permanent folder.
2. Open `chrome://extensions/` or `edge://extensions/`. Enable **Developer mode**, choose **Load unpacked**, and select the folder directly containing `manifest.json`. This first installation is manual.
3. Use the **same browser profile** for the toolbox and Pixiv upload page, then **refresh both pages**. After an extension update, reload the extension and refresh both pages again.
4. Hover over an Outputs image until its copy is ready, or use **Drag current image** in the preview. Drag it onto Pixiv's upload area or the bridge box. If cross-tab dropping is missed, drag once in the toolbox and use the bridge's receive button on Pixiv.
5. Check that **Pixiv itself shows the image preview**. You review and submit the post yourself.

The local toolbox port is detected automatically; no address, port or API key is entered. Supported scope: Chrome/Edge, local HTTP `localhost` / `127.0.0.1`, one image at a time, up to 32 MiB. Remote/LAN addresses, HTTPS toolboxes and other browsers are outside this scope. Exported bytes follow the toolbox's metadata and attribution settings. The [bridge guide](integrations/pixiv-drop-bridge/README.md) records testing limits and troubleshooting.

## Update and keep your data

Use the loader's **Update (更新)** button or ComfyUI-Manager. For Git installations, run `git pull` inside the existing plugin folder. Finish active generation work, restart ComfyUI through your usual launcher, then hard-refresh with `Ctrl+Shift+R`.

The built-in updater preserves `data/`, models, input/output folders, credentials and user configuration. The [changelog](CHANGELOG.md) contains the full release history in Chinese.

Browser storage is separate. Keep the same browser profile and address/port: `localhost`, `127.0.0.1` and different ports are different browser sites. Language, appearance and browser databases belong to that site. Export outfit cards with the Outfit Library's own **Export** control before clearing site data or switching browsers, and retain the plugin's `data/` folder. Folder permissions may need to be granted again after moving or importing data.

[Repository](https://github.com/Ararararararaki/comfyui-anima-toolkit) · [Issues](https://github.com/Ararararararaki/comfyui-anima-toolkit/issues) · [Machine-readable summary](llms.txt)
