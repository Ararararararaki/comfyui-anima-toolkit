let activeDropdown = null;

function stopCanvasEvents(element) {
  for (const type of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
    element.addEventListener(type, (event) => event.stopPropagation(), { passive: type === "wheel" });
  }
}

function focusableItems(root) {
  return [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
    .filter((element) => element.offsetParent !== null);
}

export class PortalDropdown {
  constructor({ label, title = "", content, menuClass = "", onClose = null }) {
    this.contentFactory = content;
    this.menuClass = menuClass;
    this.onClose = onClose;
    this.menu = null;
    this.cascadeCleanup = [];
    this.element = document.createElement("button");
    this.element.type = "button";
    this.element.className = "adg-dropdown-trigger";
    this.element.title = title;
    this.element.setAttribute("aria-haspopup", "menu");
    this.element.setAttribute("aria-expanded", "false");
    this.labelElement = document.createElement("span");
    this.labelElement.className = "adg-dropdown-trigger-label";
    this.badgeElement = document.createElement("span");
    this.badgeElement.className = "adg-dropdown-trigger-badge";
    this.chevronElement = document.createElement("span");
    this.chevronElement.className = "adg-dropdown-chevron";
    this.chevronElement.textContent = "▾";
    this.element.append(this.labelElement, this.badgeElement, this.chevronElement);
    this.setSummary(label);

    this.handleTriggerClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
    };
    this.handleTriggerKeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.open({ focusFirst: true });
      }
    };
    this.element.addEventListener("click", this.handleTriggerClick);
    this.element.addEventListener("keydown", this.handleTriggerKeydown);
    stopCanvasEvents(this.element);
  }

  setSummary(label, activeCount = 0) {
    this.labelElement.textContent = label;
    this.badgeElement.textContent = activeCount > 0 ? String(activeCount) : "";
    this.badgeElement.hidden = activeCount <= 0;
    this.element.classList.toggle("is-active", activeCount > 0);
  }

  toggle() {
    if (this.menu) this.close();
    else this.open();
  }

  open({ focusFirst = false } = {}) {
    if (this.menu) return;
    activeDropdown?.close();
    activeDropdown = this;
    const content = this.contentFactory?.();
    if (!content) return;
    const menu = document.createElement("div");
    menu.className = `adg-portal-menu ${this.menuClass}`.trim();
    menu.setAttribute("role", "menu");
    menu.append(content);
    stopCanvasEvents(menu);
    document.body.append(menu);
    this.menu = menu;
    this.element.classList.add("is-open");
    this.element.setAttribute("aria-expanded", "true");
    this.wireCascades(menu);
    this.position();

    this.handleOutsidePointer = (event) => {
      if (!menu.contains(event.target) && !this.element.contains(event.target)) this.close();
    };
    this.handleDocumentKeydown = (event) => {
      if (!this.menu) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.close({ restoreFocus: true });
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = focusableItems(menu);
      if (!items.length) return;
      const current = items.indexOf(document.activeElement);
      const next = event.key === "ArrowDown"
        ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
      event.preventDefault();
      items[next].focus();
    };
    this.handleViewportChange = (event) => {
      if (event?.type === "scroll" && this.menu?.contains(event.target)) return;
      this.close();
    };
    queueMicrotask(() => {
      if (this.menu === menu) document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    });
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    window.addEventListener("resize", this.handleViewportChange, { once: true });
    window.addEventListener("scroll", this.handleViewportChange, { capture: true, once: true });
    if (focusFirst) requestAnimationFrame(() => focusableItems(menu)[0]?.focus());
  }

  position() {
    if (!this.menu) return;
    const triggerRect = this.element.getBoundingClientRect();
    const menuRect = this.menu.getBoundingClientRect();
    const gap = 5;
    let left = triggerRect.left;
    let top = triggerRect.bottom + gap;
    if (left + menuRect.width > window.innerWidth - 8) left = Math.max(8, triggerRect.right - menuRect.width);
    if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, triggerRect.top - menuRect.height - gap);
    this.menu.style.left = `${Math.round(left)}px`;
    this.menu.style.top = `${Math.round(top)}px`;
  }

  wireCascades(menu) {
    const rows = [...menu.querySelectorAll(".adg-cascade-row")];
    const closeOtherRows = (current) => rows.forEach((row) => {
      if (row !== current && !row.classList.contains("is-pinned")) row.classList.remove("is-open");
    });
    for (const row of rows) {
      const trigger = row.querySelector(":scope > .adg-menu-row-button");
      const submenu = row.querySelector(":scope > .adg-submenu");
      if (!trigger || !submenu) continue;
      let openTimer = 0;
      let closeTimer = 0;
      const open = ({ pin = false } = {}) => {
        clearTimeout(closeTimer);
        closeOtherRows(row);
        row.classList.add("is-open");
        row.classList.toggle("is-pinned", pin || row.classList.contains("is-pinned"));
        requestAnimationFrame(() => {
          const rect = submenu.getBoundingClientRect();
          row.classList.toggle("opens-left", rect.right > window.innerWidth - 8);
        });
      };
      const close = () => {
        if (row.classList.contains("is-pinned")) return;
        row.classList.remove("is-open");
      };
      const onEnter = () => { clearTimeout(closeTimer); openTimer = window.setTimeout(() => open(), 150); };
      const onLeave = () => { clearTimeout(openTimer); closeTimer = window.setTimeout(close, 220); };
      const onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const willOpen = !row.classList.contains("is-open") || !row.classList.contains("is-pinned");
        rows.forEach((other) => { other.classList.remove("is-open", "is-pinned"); });
        if (willOpen) open({ pin: true });
      };
      const onKeydown = (event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          open({ pin: true });
          requestAnimationFrame(() => focusableItems(submenu)[0]?.focus());
        }
      };
      const onSubmenuKeydown = (event) => {
        if (event.key !== "ArrowLeft") return;
        event.preventDefault();
        row.classList.remove("is-open", "is-pinned");
        trigger.focus();
      };
      row.addEventListener("mouseenter", onEnter);
      row.addEventListener("mouseleave", onLeave);
      trigger.addEventListener("click", onClick);
      trigger.addEventListener("keydown", onKeydown);
      submenu.addEventListener("keydown", onSubmenuKeydown);
      this.cascadeCleanup.push(() => {
        clearTimeout(openTimer);
        clearTimeout(closeTimer);
        row.removeEventListener("mouseenter", onEnter);
        row.removeEventListener("mouseleave", onLeave);
        trigger.removeEventListener("click", onClick);
        trigger.removeEventListener("keydown", onKeydown);
        submenu.removeEventListener("keydown", onSubmenuKeydown);
      });
    }
  }

  close({ restoreFocus = false } = {}) {
    if (!this.menu) return;
    this.cascadeCleanup.splice(0).forEach((cleanup) => cleanup());
    this.menu.remove();
    this.menu = null;
    this.element.classList.remove("is-open");
    this.element.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    window.removeEventListener("resize", this.handleViewportChange);
    window.removeEventListener("scroll", this.handleViewportChange, true);
    if (activeDropdown === this) activeDropdown = null;
    this.onClose?.();
    if (restoreFocus) this.element.focus();
  }

  destroy() {
    this.close();
    this.element.removeEventListener("click", this.handleTriggerClick);
    this.element.removeEventListener("keydown", this.handleTriggerKeydown);
  }
}
