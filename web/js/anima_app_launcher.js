// Anima App Launcher — adds a "🎨 Anima" button to the ComfyUI menu.
// The panel app is served by ComfyUI itself (no separate process needed), so
// "startup" just means clicking this button. The app path is derived
// dynamically from this script's URL, so it works under ANY clone directory name.

(function () {
  // TK 节点统一黑白灰主题：只覆盖外框/控件/状态色，不改各节点单卡或单行布局。
  function installMonochromeTheme() {
    if (document.getElementById("anima-monochrome-theme")) return;
    const style = document.createElement("style");
    style.id = "anima-monochrome-theme";
    style.textContent = `
      :root {
        --anima-mono-bg: #121416;
        --anima-mono-surface: #191c1f;
        --anima-mono-surface-2: #24282b;
        --anima-mono-line: #3c4246;
        --anima-mono-line-strong: #596166;
        --anima-mono-text: #e8e5df;
        --anima-mono-muted: #9a9b98;
        --anima-mono-active: #d0cbc2;
        --anima-mono-info: #b0c0c2;
        --anima-mono-danger: #c78484;
      }

      .anima-lora-widget,
      .anima-batch-ui,
      .anima-cam-ui,
      .anima-tw-widget,
      .anima-preset-latent,
      .anima-danbooru-gallery,
      .tk-cards-ui {
        color: var(--anima-mono-text) !important;
        background: var(--anima-mono-bg) !important;
        background-image: none !important;
        border-color: var(--anima-mono-line) !important;
        box-shadow: none !important;
      }

      .anima-lora-widget button,
      .anima-batch-ui button,
      .anima-cam-ui button,
      .anima-tw-widget button,
      .anima-preset-latent button,
      .anima-danbooru-gallery button,
      .tk-cards-ui button {
        background: var(--anima-mono-surface-2) !important;
        background-image: none !important;
        border-color: var(--anima-mono-line) !important;
        color: var(--anima-mono-text) !important;
        box-shadow: none !important;
        text-shadow: none !important;
        transform: none !important;
      }

      .anima-lora-widget button:hover,
      .anima-batch-ui button:hover,
      .anima-cam-ui button:hover,
      .anima-tw-widget button:hover,
      .anima-preset-latent button:hover,
      .anima-danbooru-gallery button:hover,
      .tk-cards-ui button:hover {
        background: #303538 !important;
        border-color: var(--anima-mono-line-strong) !important;
        color: #fff !important;
      }

      .anima-lora-widget .btn-verify,
      .anima-batch-ui .anima-batch-parse-btn,
      .anima-batch-ui .anima-batch-start-btn,
      .anima-tw-widget .atw-toolbar button,
      .anima-preset-latent button.is-active,
      .anima-danbooru-gallery .primary,
      .tk-cards-ui .tk-cards-btn-main {
        background: var(--anima-mono-active) !important;
        border-color: var(--anima-mono-active) !important;
        color: #17191b !important;
        font-weight: 650 !important;
      }

      .anima-lora-widget input,
      .anima-lora-widget select,
      .anima-batch-ui input,
      .anima-batch-ui select,
      .anima-batch-ui textarea,
      .anima-cam-ui input,
      .anima-cam-ui select,
      .anima-tw-widget input,
      .anima-preset-latent input,
      .anima-danbooru-gallery input,
      .anima-danbooru-gallery select,
      .tk-cards-ui input,
      .tk-cards-ui select,
      .tk-cards-ui textarea {
        background: var(--anima-mono-surface) !important;
        background-image: none !important;
        border-color: var(--anima-mono-line) !important;
        color: var(--anima-mono-text) !important;
        box-shadow: none !important;
      }

      .anima-lora-widget .lora-row,
      .anima-batch-ui .anima-batch-group,
      .anima-batch-ui .anima-batch-file,
      .anima-batch-ui .anima-batch-report,
      .anima-tw-widget .atw-card,
      .anima-preset-latent .apl-item,
      .anima-danbooru-gallery .adg-card,
      .tk-cards-ui .tk-cards-card,
      .tk-cards-ui .tk-cards-lib-item {
        background: var(--anima-mono-surface) !important;
        background-image: none !important;
        border-color: var(--anima-mono-line) !important;
        box-shadow: none !important;
      }

      .anima-lora-widget .lora-row:hover,
      .anima-batch-ui .anima-batch-group:hover,
      .anima-batch-ui .anima-batch-file:hover,
      .anima-tw-widget .atw-card:hover,
      .anima-danbooru-gallery .adg-card:hover,
      .tk-cards-ui .tk-cards-card:hover,
      .tk-cards-ui .tk-cards-lib-item:hover {
        background: var(--anima-mono-surface-2) !important;
        border-color: var(--anima-mono-line-strong) !important;
      }

      .anima-lora-widget .lora-toggle.on { background: var(--anima-mono-info) !important; box-shadow: none !important; }
      .anima-lora-widget .weight-step { background: var(--anima-mono-surface-2) !important; color: var(--anima-mono-muted) !important; box-shadow: none !important; }
      .anima-lora-widget .lora-name,
      .anima-batch-ui .anima-batch-file-name,
      .anima-tw-widget .atw-card-name,
      .anima-cam-ui .anima-cam-preview { color: var(--anima-mono-text) !important; }
      .anima-lora-widget .status,
      .anima-batch-ui .anima-batch-hint,
      .anima-cam-ui .anima-cam-state,
      .anima-tw-widget .atw-empty,
      .anima-preset-latent .apl-hint,
      .anima-danbooru-gallery .adg-status { color: var(--anima-mono-muted) !important; }

      .anima-cam-ui .anima-cam-canvas,
      .anima-cam-ui .anima-cam-track { background: var(--anima-mono-surface) !important; background-image: none !important; border-color: var(--anima-mono-line) !important; box-shadow: none !important; }
      .anima-cam-ui .anima-cam-fill { background: var(--anima-mono-info) !important; box-shadow: none !important; }
      .anima-cam-ui input[type=range] { accent-color: var(--anima-mono-active) !important; }

      .anima-lora-widget .modal,
      .anima-lora-widget .modal-overlay,
      .anima-tw-widget .atw-modal,
      .anima-preset-latent .apl-modal,
      .anima-preset-latent .apl-modal-backdrop,
      .anima-danbooru-gallery .adg-dialog,
      .anima-danbooru-gallery .adg-dialog-overlay,
      .tk-cards-ui .tk-cards-overlay-box {
        background: var(--anima-mono-surface) !important;
        background-image: none !important;
        border-color: var(--anima-mono-line) !important;
        box-shadow: none !important;
        color: var(--anima-mono-text) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  installMonochromeTheme();

  // Capture synchronously: document.currentScript is only valid while the
  // script is being parsed, not inside the setInterval callback below.
  let base = "/extensions/ComfyUI-Anima-Batch-LoRA/app/"; // fallback
  try {
    const src = document.currentScript && document.currentScript.src;
    const m = src && src.match(/\/extensions\/([^/]+)\/js\//);
    if (m) base = "/extensions/" + m[1] + "/app/";
  } catch (e) {}

  const tryInit = setInterval(() => {
    const api = window.comfyAPI?.app?.app;
    if (!api) return;
    const menu = document.querySelector(".comfy-menu");
    if (!menu) return;
    clearInterval(tryInit);

    const btn = document.createElement("button");
    btn.textContent = "TK";
    btn.title = "打开本地 LoRA 管理面板（由 ComfyUI 直接提供，无需单独启动）";
    btn.onclick = () => window.open(base, "_blank");
    btn.style.cssText = "background:#d0cbc2;color:#17191b;border:1px solid #3c4246;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:650;margin:4px;";
    menu.prepend(btn);
  }, 500);
})();
