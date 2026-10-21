import { currentGalleryWorkflowId } from './anima_gallery_browse_state.js';

const STORAGE = 'anima.gallery.workspace.v1';
const clamp = (n, low, high) => Math.max(low, Math.min(n, Math.max(low, high)));
const make = (tag, cls, text = '') => {
  const el = document.createElement(tag); el.className = cls; el.textContent = text; return el;
};
function button(label, action) {
  const el = make('button', '', label); el.type = 'button'; el.onclick = action; return el;
}

/** One screen-space window. The node keeps its DOM widget shell and state owner. */
class GalleryWorkspace {
  open(ui, app) {
    if (ui.disposed) return;
    if (this.ui === ui && this.window) { this.minimize(false); return; }
    this.close();
    this.ui = ui; this.app = app;
    ui.workspaceAwaitingScroll = true;
    this.graph = app.graph;
    this.workflow = currentGalleryWorkflowId(app);
    this.nodeGraph = ui.node.graph;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const shell = this.window = make('section', 'adg-workspace');
    shell.setAttribute('role', 'dialog'); shell.setAttribute('aria-modal', 'false');
    shell.setAttribute('aria-label', '画廊素材浏览器');
    shell.dataset.captureWheel = 'true';
    // Prevent workflow shortcuts/pan without preventing native text editing/scroll.
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'keydown', 'keyup', 'wheel']) {
      shell.addEventListener(type, e => e.stopPropagation(), { signal });
    }
    const header = make('header', 'adg-workspace-header');
    this.title = make('strong', 'adg-workspace-title');
    header.append(this.title,
      button('最小化', () => this.minimize(!shell.classList.contains('is-minimized'))),
      button('最大化', () => this.maximize()),
      button('返回节点', () => this.close()));
    this.body = make('div', 'adg-workspace-body');
    this.stage = make('div', 'adg-workspace-stage');
    this.detail = make('aside', 'adg-workspace-detail'); this.detail.hidden = true;
    this.body.append(this.stage, this.detail); shell.append(header, this.body);
    document.body.append(shell);
    shell.addEventListener('pointerdown', e => {
      if (this.ui && !this.valid()) { e.preventDefault(); e.stopImmediatePropagation(); this.suspend(); }
    }, { capture: true, signal });
    const scroll = ui.grid.scrollTop;
    this.ui.root.classList.add('is-floating');
    this.stage.append(ui.root);
    ui.applyMasonryLayout(); ui.grid.scrollTop = scroll;
    ui.workspacePlaceholder.hidden = false;
    this.refreshSummary();
    this.restoreGeometry();
    let drag = null;
    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || e.button !== 0 || this.maximized) return;
      const rect = shell.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(e.pointerId); e.preventDefault();
    }, { signal });
    header.addEventListener('pointermove', e => {
      if (!drag) return;
      this.pendingPosition = { x: drag.left + e.clientX - drag.x, y: drag.top + e.clientY - drag.y };
      if (!this.dragFrame) this.dragFrame = requestAnimationFrame(() => {
        this.dragFrame = null;
        if (!this.pendingPosition || !this.window) return;
        const { x, y } = this.pendingPosition;
        shell.style.left = clamp(x, 8, innerWidth - shell.offsetWidth - 8) + 'px';
        shell.style.top = clamp(y, 8, innerHeight - shell.offsetHeight - 8) + 'px';
        ui.positionSuggestions();
      });
    }, { signal });
    const stopDrag = () => {
      drag = null;
      if (this.pendingPosition) {
        const { x, y } = this.pendingPosition;
        shell.style.left = clamp(x, 8, innerWidth - shell.offsetWidth - 8) + 'px';
        shell.style.top = clamp(y, 8, innerHeight - shell.offsetHeight - 8) + 'px';
        this.pendingPosition = null;
      }
      this.saveGeometry();
    };
    header.addEventListener('pointerup', stopDrag, { signal });
    header.addEventListener('pointercancel', stopDrag, { signal });
    header.addEventListener('lostpointercapture', stopDrag, { signal });
    window.addEventListener('resize', () => { this.clampGeometry(); }, { signal });
    // ResizeObserver only batches geometry and layout; never initiates a search.
    this.observer = new ResizeObserver(() => {
      if (this.resizeFrame) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = null;
        if (!this.ui || this.ui.workspacePaused) return;
        this.clampGeometry(); this.ui.scheduleMasonryLayout(); this.saveGeometry();
      });
    });
    this.observer.observe(shell);
    this.guardTimer = setInterval(() => this.checkBinding(), 300);
    ui.workspaceTransition = true;
    this.relayout();
  }

  valid() {
    return this.ui && !this.ui.disposed && this.app.graph === this.graph
      && this.ui.node.graph === this.nodeGraph
      && currentGalleryWorkflowId(this.app) === this.workflow
      && (!this.nodeGraph?.getNodeById || this.nodeGraph.getNodeById(this.ui.node.id) === this.ui.node);
  }

  checkBinding() {
    if (!this.ui) return;
    if (!this.valid()) { this.suspend(); return; }
    const title = `${this.ui.node.title || '画廊'} · #${this.ui.node.id}`;
    if (this.title.textContent !== title) this.title.textContent = title;
  }

  suspend() {
    const ui = this.ui;
    if (!ui) return;
    ui.hideSuggestions(); ui.hidePromptTooltip();
    ui.cancelBrowseRequest?.(); ui.controller?.abort();
    this.returnRoot();
    this.ui = null;
    this.clearDetail();
    this.stage.replaceChildren(make('p', 'adg-workspace-empty', '画廊绑定已暂停：工作流已切换或节点已删除。请从目标画廊节点重新展开。'));
    this.title.textContent = '画廊 · 未绑定';
    clearInterval(this.guardTimer); this.guardTimer = null;
  }

  refreshSummary() {
    const ui = this.ui;
    if (!ui) return;
    this.title.textContent = `${ui.node.title || '画廊'} · #${ui.node.id}`;
    const count = ui.selectedGallerySelections().length;
    ui.workspaceSummary.textContent = `悬浮窗浏览中 · 已选 ${count} 张`;
  }

  relayout() {
    const ui = this.ui;
    if (!ui) return;
    const scroll = ui.grid.scrollTop;
    cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = null;
      if (this.ui !== ui || ui.disposed) return;
      ui.applyMasonryLayout(); ui.grid.scrollTop = scroll;
      // Leave the transition guard through the ResizeObserver delivery.
      this.transitionFrame = requestAnimationFrame(() => { ui.workspaceTransition = false; });
    });
  }

  minimize(value) {
    if (!this.window) return;
    if (value && this.ui && !this.ui.workspacePaused) this.minimizedScroll = this.ui.grid.scrollTop;
    this.window.classList.toggle('is-minimized', value);
    this.window.querySelector('header button').textContent = value ? '恢复' : '最小化';
    if (this.ui) {
      this.ui.workspacePaused = value;
      if (value) { this.ui.hideSuggestions(); this.ui.hidePromptTooltip(); }
      else { this.ui.applyMasonryLayout(); this.ui.grid.scrollTop = this.minimizedScroll ?? this.ui.grid.scrollTop; this.relayout(); }
    }
    this.clampGeometry();
  }

  maximize() {
    if (!this.window) return;
    this.minimize(false);
    if (!this.maximized) this.normalGeometry = this.geometry();
    this.maximized = !this.maximized;
    if (this.maximized) this.applyGeometry({ x: 8, y: 8, width: innerWidth - 16, height: innerHeight - 16 });
    else this.applyGeometry(this.normalGeometry);
    this.window.classList.toggle('is-maximized', this.maximized);
    this.window.querySelectorAll('header button')[1].textContent = this.maximized ? '还原' : '最大化';
    this.relayout();
  }

  geometry() {
    const r = this.window.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  applyGeometry(g) {
    if (!g || !this.window) return;
    for (const [key, value] of Object.entries({ left: g.x, top: g.y, width: g.width, height: g.height })) {
      if (Number.isFinite(value)) this.window.style[key] = value + 'px';
    }
    this.clampGeometry();
  }
  clampGeometry() {
    if (!this.window) return;
    const w = Math.max(1, innerWidth - 16), h = Math.max(1, innerHeight - 16);
    this.window.style.maxWidth = w + 'px'; this.window.style.maxHeight = h + 'px';
    if (this.maximized) Object.assign(this.window.style, { width: w + 'px', height: h + 'px', left: '8px', top: '8px' });
    const r = this.window.getBoundingClientRect();
    this.window.style.left = clamp(r.left, 8, innerWidth - r.width - 8) + 'px';
    this.window.style.top = clamp(r.top, 8, innerHeight - r.height - 8) + 'px';
    this.ui?.positionSuggestions();
  }
  restoreGeometry() {
    let g;
    try { g = JSON.parse(localStorage.getItem(STORAGE)); } catch {}
    this.applyGeometry(g || { x: 48, y: 64, width: Math.min(1100, innerWidth - 96), height: Math.min(760, innerHeight - 112) });
  }
  saveGeometry() {
    if (!this.window || this.maximized || this.window.classList.contains('is-minimized')) return;
    try { localStorage.setItem(STORAGE, JSON.stringify(this.geometry())); } catch {}
  }

  showDetail(ui, url, title) {
    if (this.ui !== ui || !this.valid()) return false;
    this.clearDetail();
    const image = make('img', ''); image.alt = title; image.src = url;
    this.detail.append(button('关闭大图', () => { this.clearDetail(); this.relayout(); }), make('p', '', title), image);
    this.detail.hidden = false; this.relayout(); return true;
  }
  clearDetail() {
    if (!this.detail) return;
    this.detail.querySelectorAll('img').forEach(img => img.removeAttribute('src'));
    this.detail.replaceChildren(); this.detail.hidden = true;
  }

  returnRoot() {
    const ui = this.ui;
    if (!ui) return;
    const scroll = ui.workspacePaused ? this.minimizedScroll ?? ui.grid.scrollTop : ui.grid.scrollTop;
    ui.workspacePaused = false; ui.workspaceTransition = true;
    ui.workspaceAwaitingScroll = true;
    ui.workspaceMount.append(ui.root); ui.root.classList.remove('is-floating');
    ui.workspacePlaceholder.hidden = true;
    ui.grid.scrollTop = scroll;
    ui.applyMasonryLayout(); ui.grid.scrollTop = scroll;
    ui.workspaceTransition = false;
  }
  release(ui) { if (this.ui === ui) this.suspend(); }
  close() {
    if (!this.window) return;
    const ui = this.ui;
    this.saveGeometry();
    ui?.hideSuggestions(); ui?.hidePromptTooltip();
    this.returnRoot(); this.clearDetail();
    this.abort.abort(); this.observer.disconnect(); clearInterval(this.guardTimer);
    for (const key of ['layoutFrame', 'transitionFrame', 'resizeFrame', 'dragFrame']) { cancelAnimationFrame(this[key]); this[key] = null; }
    if (ui) ui.workspaceTransition = false;
    this.window.remove(); this.window = null; this.ui = null; this.maximized = false;
    this.guardTimer = null; this.observer = null; this.abort = null;
    this.stage = this.body = this.detail = this.title = null;
    this.app = this.graph = this.nodeGraph = null;
    this.pendingPosition = this.minimizedScroll = null;
  }
}

export const galleryWorkspace = new GalleryWorkspace();

export function mountGalleryWorkspace(ui, app) {
  const mount = ui.workspaceMount = make('div', 'adg-node-mount');
  const placeholder = ui.workspacePlaceholder = make('div', 'adg-workspace-placeholder');
  placeholder.hidden = true;
  ui.workspaceSummary = make('p', '');
  placeholder.append(ui.workspaceSummary,
    button('显示悬浮窗', () => galleryWorkspace.open(ui, app)),
    button('返回节点', () => galleryWorkspace.close()));
  mount.append(ui.root, placeholder);
  return mount;
}
