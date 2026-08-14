// Anima App Launcher — adds a "🎨 Anima" button to the ComfyUI menu.
// The panel app is served by ComfyUI itself (no separate process needed), so
// "startup" just means clicking this button. The app path is derived
// dynamically from this script's URL, so it works under ANY clone directory name.

(function () {
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
    btn.textContent = "🎨 TK";
    btn.title = "打开本地 LoRA 管理面板（由 ComfyUI 直接提供，无需单独启动）";
    btn.onclick = () => window.open(base, "_blank");
    btn.style.cssText = "background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:600;margin:4px;";
    menu.prepend(btn);
  }, 500);
})();
