// Anima App Launcher - direct window.comfyAPI access
// No ES module imports needed.

(function() {
  const tryInit = setInterval(() => {
    const api = window.comfyAPI?.app?.app;
    if (!api) return;
    clearInterval(tryInit);

    const menu = document.querySelector(".comfy-menu");
    if (!menu) return;

    const btn = document.createElement("button");
    btn.textContent = "🎨 Anima";
    btn.onclick = () => window.open("/extensions/ComfyUI-Anima-Batch-LoRA/app/", "_blank");
    btn.style.cssText = "background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:600;margin:4px;";
    menu.prepend(btn);
  }, 500);
})();
