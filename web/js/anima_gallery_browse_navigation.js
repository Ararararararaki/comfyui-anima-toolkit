// Small, responsive navigation shared by continuous and paged gallery browsing.
const STYLE_ID = "anima-gallery-browse-navigation-style";

function installStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.adg-browse-container { container: adg-browse / inline-size; width: 100%; flex: 1 1 auto; }
.adg-browse-nav { display: flex; width: 100%; align-items: center; gap: 5px; flex-wrap: wrap; position: relative; font-size: 11px; color: var(--fg-color, var(--adg-fg)); }
.adg-browse-nav button.adg-browse-button, .adg-browse-nav summary { width: auto; min-width: 0; margin: 0; padding: 4px 8px; border: 1px solid var(--border-color, var(--adg-border)); border-radius: 6px; background: var(--comfy-input-bg, var(--adg-bg)); color: inherit; font: inherit; white-space: nowrap; cursor: pointer; line-height: 1.35; }
.adg-browse-nav button:hover:not(:disabled), .adg-browse-nav summary:hover { border-color: var(--p-primary-color, var(--adg-go)); }
.adg-browse-nav button:focus-visible, .adg-browse-nav summary:focus-visible, .adg-browse-nav input:focus-visible { outline: 2px solid var(--p-primary-color, var(--adg-go)); outline-offset: 2px; }
.adg-browse-nav button:disabled { opacity: .4; cursor: default; }
.adg-browse-nav button[aria-current="page"] { border-color: var(--p-primary-color, var(--adg-go)); color: var(--p-primary-color, var(--adg-go)); font-weight: 600; }
.adg-browse-current { min-width: 42px; text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
.adg-browse-locator { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.adg-browse-nav input.adg-browse-input { width: 48px; min-width: 0; padding: 4px; border: 1px solid var(--border-color, var(--adg-border)); border-radius: 6px; background: var(--comfy-input-bg, var(--adg-bg)); color: inherit; font: inherit; line-height: 1.35; }
.adg-browse-nav .adg-browse-wide { display: none; }
.adg-browse-locate { position: static; }
.adg-browse-locate > summary { list-style: none; }
.adg-browse-locate > summary::-webkit-details-marker { display: none; }
.adg-browse-popover { position: absolute; left: 0; top: calc(100% + 6px); z-index: 50; width: max-content; max-width: min(250px, calc(100% - 22px)); padding: 10px; border: 1px solid var(--border-color, var(--adg-border)); border-radius: 8px; background: var(--comfy-input-bg, var(--adg-bg)); box-shadow: 0 4px 14px color-mix(in srgb, var(--fg-color, var(--adg-fg)) 15%, transparent); }
.adg-browse-label { color: var(--descrip-text, var(--adg-dim)); }
.adg-browse-nav .adg-browse-return { margin-left: auto; }
@container adg-browse (min-width: 560px) { .adg-browse-nav .adg-browse-wide { display: flex; } .adg-browse-nav .adg-browse-locate { display: none; } }
`;
  doc.head.append(style);
}

/** Render navigation; callbacks own fetching, progress, and scroll positioning. */
export function renderGalleryBrowseNavigation(container, {
  page = 1, pageNumbers = true, knownPages = [], canNext = true, hasReturn = false,
  onNavigate, onStart, onReturn,
} = {}) {
  if (!container) return;
  const doc = container.ownerDocument;
  installStyles(doc);
  const oldDetails = container.querySelector(".adg-browse-locate");
  const wasOpen = !!oldDetails?.open;
  const oldInput = container.contains(doc.activeElement) && doc.activeElement?.classList.contains("adg-browse-input")
    ? { value: doc.activeElement.value, location: doc.activeElement.dataset.location } : null;
  container.replaceChildren();
  container.classList.add("adg-browse-container");
  page = Math.max(1, Math.floor(Number(page) || 1));
  const known = [...new Set(knownPages.map(Number).filter(p => Number.isInteger(p) && p > 0))].sort((a, b) => a - b);
  const unit = pageNumbers ? "页" : "批次";
  const nav = doc.createElement("nav");
  nav.className = "adg-browse-nav";
  nav.setAttribute("aria-label", pageNumbers ? "画廊页码导航" : "画廊批次导航");
  const button = (text, action, title = text, disabled = false) => {
    const element = doc.createElement("button");
    element.type = "button";
    element.className = "adg-browse-button";
    element.textContent = text;
    element.title = title;
    element.setAttribute("aria-label", title);
    element.disabled = disabled;
    element.addEventListener("click", action);
    return element;
  };
  const navigate = target => {
    if (target < 1 || (!pageNumbers && !known.includes(target))) return;
    details.open = false;
    onNavigate?.(target);
  };
  nav.append(button(pageNumbers ? "上一页" : "上一批", () => navigate(page - 1), "上一" + unit,
    page <= 1 || (!pageNumbers && !known.includes(page - 1))));
  const current = doc.createElement("span");
  current.className = "adg-browse-current";
  current.textContent = pageNumbers ? "第 " + page + " 页" : "批次 " + page;
  current.title = "当前正在看的" + unit;
  nav.append(current, button(pageNumbers ? "下一页" : "下一批", () => {
    details.open = false;
    onNavigate?.(page + 1);
  }, "下一" + unit, !canNext || (!pageNumbers && !known.includes(page + 1))));

  const details = doc.createElement("details");
  details.className = "adg-browse-locate";
  details.open = wasOpen;
  const summary = doc.createElement("summary");
  summary.textContent = "定位";
  summary.title = pageNumbers ? "展开页码定位" : "定位到已访问批次";
  summary.setAttribute("aria-label", summary.title);
  details.append(summary);
  const knownIndex = known.findIndex(p => p >= page);
  const nearbyStart = Math.max(0, (knownIndex < 0 ? known.length : knownIndex) - 2);
  const nearby = pageNumbers ? Array.from({ length: 5 }, (_, i) => Math.max(1, page - 2) + i)
    : known.slice(nearbyStart, nearbyStart + 5);
  const locator = location => {
    const box = doc.createElement("div");
    box.className = "adg-browse-locator";
    for (const target of nearby) {
      const chip = button(String(target), () => navigate(target), "定位到第 " + target + " " + unit);
      if (target === page) chip.setAttribute("aria-current", "page");
      box.append(chip);
    }
    if (pageNumbers) {
      const input = doc.createElement("input");
      input.className = "adg-browse-input";
      input.dataset.location = location;
      input.type = "number";
      input.min = "1";
      input.step = "1";
      input.placeholder = "页码";
      input.title = "输入页码后按 Enter 定位";
      input.setAttribute("aria-label", "定位页码");
      input.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          const target = Number(input.value);
          if (Number.isSafeInteger(target) && target > 0) navigate(target);
          else input.reportValidity();
        }
        if (event.key === "Escape") { details.open = false; summary.focus(); }
      });
      box.append(input);
    }
    box.append(button("从头看", () => { details.open = false; onStart?.(); }, pageNumbers ? "从第一页重新浏览" : "从第一批重新浏览"));
    return box;
  };
  const wide = locator("wide");
  wide.classList.add("adg-browse-wide");
  const label = doc.createElement("span");
  label.className = "adg-browse-label";
  label.textContent = "定位";
  wide.prepend(label);
  const compact = locator("compact");
  compact.classList.add("adg-browse-popover");
  details.append(compact);
  nav.append(wide, details);
  if (hasReturn) {
    const back = button("回到跳转前", () => { details.open = false; onReturn?.(); });
    back.classList.add("adg-browse-return");
    nav.append(back);
  }
  nav.addEventListener("keydown", event => {
    if (event.key === "Escape" && details.open) { details.open = false; summary.focus(); }
  });
  container.append(nav);
  if (oldInput) {
    const input = nav.querySelector('[data-location="' + oldInput.location + '"]');
    if (input) { input.value = oldInput.value; input.focus({ preventScroll: true }); }
  }
  return nav;
}
