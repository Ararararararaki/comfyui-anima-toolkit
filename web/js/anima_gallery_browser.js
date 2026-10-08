import { GalleryBrowseState, GalleryProgressStore, galleryBrowseKey, currentGalleryWorkflowId } from './anima_gallery_browse_state.js';
import { fetchGalleryPage } from './anima_gallery_page_fetch.js';
import { renderGalleryBrowseNavigation } from './anima_gallery_browse_navigation.js';
import { GallerySourceAdapter } from './anima_gallery_source_adapter.js';

/** Each widget composes its own request owner; no UI prototype is modified. */
export class GalleryController {
  constructor(ui, app, { sourceAdapter = new GallerySourceAdapter() } = {}) {
    this.ui = ui;
    this.app = app;
    this.sourceAdapter = sourceAdapter;
    this.source = null;
    this.epoch = 0;
    this.requestController = null;
    this.disposed = false;
    this.legacy = {
      renderPosts: ui.renderPostsLegacy,
      renderPagination: ui.renderPaginationLegacy,
      scrollMode: ui.scrollModeLegacy,
      handleGridResize: ui.handleGridResizeLegacy,
      scheduleAutoFill: ui.scheduleAutoFillLegacy,
      appendNextBatch: ui.appendNextBatchLegacy,
      openPixivPages: ui.openPixivPagesLegacy,
      closePixivPages: ui.closePixivPagesLegacy,
      dispose: ui.disposeLegacy,
      selectedGallerySelections: ui.selectedGallerySelectionsLegacy,
      rememberCardSelection: ui.rememberCardSelectionLegacy,
      setLoadedCardsSelected: ui.setLoadedCardsSelectedLegacy,
      scheduleMasonryLayout: ui.scheduleMasonryLayoutLegacy,
      applyActiveCategory: ui.applyActiveCategoryLegacy,
      galleryBatchLabel: ui.galleryBatchLabelLegacy,
      growPool: ui.growPoolLegacy,
      rebuildPool: ui.rebuildPoolLegacy,
    };
  }

  mount() {
    if (this.disposed) return this;
    galleryBrowserView.ensureBrowse(this.ui);
    return this;
  }

  update(options = {}) {
    if (this.disposed) return Promise.resolve();
    this.mount();
    this.source = this.ui.activeSourceId();
    return galleryBrowserView.search(this.ui, options);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    galleryBrowserView.dispose(this.ui);
  }
}

// View coordination consumes the widget's DOM ports and the existing state /
// navigation modules. It never installs methods or changes workflow widgets.
export const galleryBrowserView = {
  ensureBrowse(ui) {
    const owner = ui.galleryController;

    if (ui._browseInitialized) return;
    ui._browseInitialized = true;
    ui._browseEpoch = owner.epoch;
    ui._browsePages = [];
    ui._browsePostPages = new Map();
    ui._browseSelected = new Map();
    ui._browseSelectedPosts = new Map();
    ui._browseMode = ui.settings.galleryScrollMode;
    ui._browsePageHide = () => ui.saveBrowseProgress();
    window.addEventListener('pagehide', ui._browsePageHide);

  },
  browseStore(ui) {
    const app = ui.galleryController.app;

    const namespace = 'anima.gallery.progress.v1:' + currentGalleryWorkflowId(app, ui.node) + ':' + String(ui.node.id);
    if (ui._browseStore?.namespace !== namespace) {
      let storage;
      try { storage = localStorage; } catch { storage = null; }
      ui._browseStore = new GalleryProgressStore({ storage, namespace });
    }
    return ui._browseStore;

  },
  galleryBatchLabel(ui) {
    const old = ui.galleryController.legacy;
    return ui.browseState ? `第 ${ui.browseState.visiblePage} ${ui.browseState.pageNumbers ? "页" : "批"}` : old.galleryBatchLabel.call(ui);
  },
  browseActive(ui) {

    return !!ui.browseState && !ui.settings.activeCategory && !ui.pixivDetail && !ui.diffContext;

  },
  cancelBrowseRequest(ui) {
    const owner = ui.galleryController;

    owner.epoch += 1;
    ui._browseEpoch = owner.epoch;
    owner.requestController?.abort();
    owner.requestController = null;
    ui._browseBusy = ui._browseNavigating = false;
    ui.grid?.removeAttribute("aria-busy");
    ui.fillMoreBusy = false;
    ui._scrollLoading = false;
    ui.controller?.abort();
    ui.requestId += 1;

  },
  browseLocation(ui) {

    const state = ui.browseState;
    if (!state) return null;
    const anchor = ui.captureScrollAnchor();
    const page = anchor ? ui._browsePostPages.get(anchor.key) || state.visiblePage : state.visiblePage;
    return { page, anchor, pageLimit: state.pageLimit, cursor: state.cursorFor(page) ?? null,
      records: state.knownPages().filter(n => Math.abs(n - page) <= 6).map(n => ({page:n, cursor:state.cursorFor(n)})).filter(r => typeof r.cursor === 'string') };

  },
  saveBrowseProgress(ui) {

    clearTimeout(ui._browseSaveTimer);
    ui._browseSaveTimer = null;
    if (!ui.browseActive() || ui._browseRandom || ui._browseNavigating) return;
    const record = ui.browseLocation();
    if (record) (ui._browseProgressStore || ui.browseStore()).save(ui.browseState.key, record);

  },
  queueBrowseProgress(ui) {

    clearTimeout(ui._browseSaveTimer);
    ui._browseSaveTimer = setTimeout(() => ui.saveBrowseProgress(), 500);

  },
  browseSnapshot(ui) {

    const source = ui.activeSourceId();
    const query = String(ui.queryInput?.value ?? ui.queryWidget?.value ?? ui.settings.lastQuery ?? '').trim();
    return { source, query, filters: {...(source === 'danbooru' ? ui.settings.filters : ui.gallerySourceFilters(source))},
      limit: Number(ui.settings.limit) || 0,
      extra: { excluded: [...(ui.settings.excludeTags || [])], favorites: !!ui.settings.favoritesOnly,
        favoriteQuery: ui.settings.favoritesOnly ? ui.favoriteMeta?.query_tag || '' : '',
        pool: source==='civitai' ? {...ui.settings.civitaiPool} : null } };

  },
  async search(ui, options = {}) {
    const owner = ui.galleryController;
    const old = owner.legacy;

    ui.ensureBrowse();
    ui.saveBrowseProgress();
    ui.cancelBrowseRequest();
    if (ui.diffContext) {
      ui.browseState = null;
      return ui.searchDifference(options);
    }
    const snapshot = ui.browseSnapshot();
    const submittedInput = ui.queryInput?.value ?? ui.queryWidget?.value;
    ui.hideSuggestions();
    if (!snapshot.query && (snapshot.source === 'pixiv' || (snapshot.source === 'danbooru' && !ui.currentQuery()))) {
      ui.setStatus(snapshot.source === 'pixiv' ? 'P站：请输入关键词后搜索' : '输入 Danbooru 标签后搜索');
      return;
    }
    const key = galleryBrowseKey(snapshot);
    const random = snapshot.source === 'danbooru' && /order:random/.test(ui.currentQuery());
    const progressStore = ui.browseStore();
    const saved = !options.force && !random ? progressStore.load(key) : null;
    const previous = ui.browseState;
    const state = new GalleryBrowseState({pageLimit:saved?.pageLimit || (snapshot.source === 'pixiv' ? 30 : Math.max(1, Number(ui.resolveLimit()) || 30)), pageNumbers:ui.pageMode(snapshot.source)});
    state.reset({key});
    if (saved) {
      for (const r of saved.records || []) state.cursors.set(r.page, r.cursor);
      if (typeof saved.cursor === 'string') state.cursors.set(saved.page, saved.cursor);
    }
    const target = saved && (state.pageNumbers || state.cursorFor(saved.page) !== undefined) ? saved.page : 1;
    const epoch = owner.epoch;
    const controller = new AbortController();
    owner.requestController = controller;
    ui._browseBusy = ui._browseNavigating = true;
    ui.setStatus(saved ? '正在恢复上次浏览位置…' : '正在搜索：' + snapshot.query);
    ui.grid?.setAttribute('aria-busy', 'true');
    const valid = () => !ui.disposed && epoch === owner.epoch;
    try {
      const result = await fetchGalleryPage(ui, {...snapshot,page:target,cursor:state.cursorFor(target) ?? '',limit:state.pageLimit,force:!!options.force,allowFuzzy:target===1},controller.signal);
      if (!valid()) return;
      if (!saved?.anchor && !result.posts.length && ui.posts.length) {
        ui.setStatus('这一页没有结果，已保留原来的图片和位置；可以重试或从头看', 'warning');
        return;
      }
      if (!state.putPage(target,{...result,cursor:result.cursor ?? state.cursorFor(target) ?? '',exhausted:!result.posts.length})) throw new Error('该页图片数量超出缓存上限');
      let restorePage = target;
      let updated = false;
      if (saved?.anchor && !result.posts.some(post => ui.postKeyOf(post) === saved.anchor.key)) {
        for (const n of [target-1,target+1]) {
          if (n < 1 || (!state.pageNumbers && state.cursorFor(n) === undefined)) continue;
          try {
            const nearby = await fetchGalleryPage(ui,{...snapshot,page:n,cursor:state.cursorFor(n)||'',limit:state.pageLimit},controller.signal);
            if (!valid()) return;
            if (nearby.posts.length) state.putPage(n,{...nearby,cursor:nearby.cursor ?? state.cursorFor(n) ?? ''});
            if (nearby.posts.some(post => ui.postKeyOf(post) === saved.anchor.key)) {restorePage=n; break;}
          } catch (error) { if (error.name === 'AbortError') throw error; }
        }
        updated = ![...state.pages.values()].some(e => e.posts.some(post => ui.postKeyOf(post) === saved.anchor.key));
      }
      if (!valid()) return;
      if (!state.getPage(restorePage)?.posts.length && ui.posts.length) {ui.setStatus("记录页暂时没有结果，已保留原图片和位置；可从头看或重试", "warning");return;}
      // Query preparation (quota/fuzzy correction) is committed only after success.
      if (snapshot.source === 'danbooru') ui.settings.filters = result.settings.filters;
      ui.settings.lastQuery = result.query;
      ui.settings.sourceQueries = {...ui.settings.sourceQueries,[snapshot.source]:result.query};
      // Results belong to the submitted search; a newer input is still a draft.
      // Avoid rewriting even identical input: assigning .value resets the caret.
      const liveInput = ui.queryInput?.value ?? ui.queryWidget?.value;
      if (liveInput === submittedInput && liveInput !== result.query && !ui._queryComposing) ui.setQuery(result.query);
      if (result.account.registered != null) ui.registered = result.account.registered;
      if (result.account.tag_limit != null) ui.tagLimitValue = result.account.tag_limit;
      ui.settings.activeCategory = '';
      ui.pixivDetail = null;
      ui.sourcePool = null;
      ui._searchSnapshot = null;
      ui.pixivReturnAnchor = null;
      ui.browseState = state;
      ui._browseProgressStore = progressStore;
      ui._browseSnapshot = {...snapshot,query:result.query};
      ui._browseRandom = random;
      state.setVisiblePage(restorePage);
      ui.fillMoreExhausted = false;
      ui.syncReturnButton();
      ui.filterControls?.refresh();
      ui.saveSettings();
      ui.showBrowseWindow(restorePage);
      if (!saved?.anchor || updated || !ui.restoreScrollAnchor(saved.anchor)) ui.scrollToBrowsePage(restorePage);
      ui.setStatus(updated ? '搜索结果已更新，已回到记录页顶部' : (saved ? '已接着上次的位置浏览 · ' + ui.galleryBatchLabel() : result.status));
      // Auto-match operates on committed cards; older search responses never reach it.
      if (random) ui.rememberRandomResults(ui.currentQuery());
      void ui.autoMatchPixiv(result.posts);
    } catch (error) {
      if (valid() && error.name !== 'AbortError') ui.setStatus('搜索失败，已保留原图片和位置：' + error.message, 'error');
      if (valid()) ui.browseState = previous;
    } finally {
      if (valid()) {
        ui._browseBusy = ui._browseNavigating = false;
        ui.grid?.removeAttribute('aria-busy');
        ui.renderPagination();
        if (ui.browseState === state) { ui.saveBrowseProgress(); ui.scheduleScrollFill(); }
      }
    }

  },
  showBrowseWindow(ui, page, {preserve=false, append=false}={}) {

    const state = ui.browseState;
    ui._browsePages = state.windowPages(page,{continuous:ui.settings.galleryScrollMode==='infinite'});
    ui._browsePostPages = new Map();
    const seen = new Set();
    ui.posts = [];
    const groups = new Map();
    for (const entry of ui._browsePages) {
      for (const [key,pages] of entry.groups || []) groups.set(key,pages);
      for (const post of entry.posts) {
        const key = ui.postKeyOf(post);
        if (seen.has(key)) continue;
        seen.add(key);
        ui._browsePostPages.set(key,entry.page);
        ui.posts.push(post);
      }
    }
    ui.pixivPageGroups = groups.size ? groups : null;
    ui.renderPosts({preserveScroll:preserve,appendOnly:append});
    ui.renderPagination();

  },
  scrollToBrowsePage(ui, page) {

    const marker = [...(ui.grid?.querySelectorAll('.adg-page-boundary') || [])].find(el => Number(el.dataset.page)===page);
    if (ui.grid) ui.grid.scrollTop = Math.max(0, Number.parseFloat(marker?.style.top) || 0);
    ui.browseState?.setVisiblePage(page);
    ui.page = page;
    ui.renderPagination();

  },
  async navigateBrowse(ui, page, {anchor=null,returning=false,start=false}={}) {
    const owner = ui.galleryController;

    const state = ui.browseState;
    page = Number(page);
    if (!ui.browseActive() || !Number.isSafeInteger(page) || page<1) return false;
    if (!state.pageNumbers && state.cursorFor(page) === undefined) {ui.setStatus('只能定位已访问或已有游标的批次','warning'); return false;}
    const before = ui.browseLocation();
    ui.saveBrowseProgress();
    ui.cancelBrowseRequest();
    state.beginNavigation();
    const token=state.token(), epoch=owner.epoch;
    const valid=()=>!ui.disposed && state===ui.browseState && state.isCurrent(token) && epoch===owner.epoch;
    ui._browseNavigating=true;
    try {
      let entry = !start ? state.getPage(page) : null;
      if (!entry) {
        ui._browseBusy=true;
        const controller=new AbortController(); owner.requestController=controller;
        ui.setStatus('正在定位第 '+page+(state.pageNumbers?' 页…':' 批…'));
        ui.grid?.setAttribute('aria-busy','true');
        const result=await fetchGalleryPage(ui,{...ui._browseSnapshot,page,cursor:state.cursorFor(page)||'',limit:state.pageLimit,force:start},controller.signal);
        if (!valid()) return false;
        if (!result.posts.length) {ui.setStatus('这一页没有结果，已保留原图片和位置；可再次定位重试','warning'); return false;}
        entry=state.putPage(page,{...result,cursor:result.cursor ?? state.cursorFor(page) ?? ''});
        if (!entry) throw new Error('该页图片数量超出缓存上限');
      }
      if (!valid()) return false;
      if (start) state.returnLocation=null;
      else if (!returning) state.returnLocation=before;
      // Cached cards already mounted need only a scroll; detached pages use a bounded window.
      if (!ui._browsePages.some(e=>e.page===page) || ui.settings.galleryScrollMode==='pager' || start) ui.showBrowseWindow(page);
      ui.scrollToBrowsePage(page);
      if (anchor) ui.restoreScrollAnchor(anchor);
      ui.page=page;
      state.setVisiblePage(page);
      ui.fillMoreExhausted=false;
      ui.renderPagination();
      ui.setStatus('已定位 · '+ui.galleryBatchLabel());
      ui.grid?.focus?.({preventScroll:true});
      return true;
    } catch(error) {
      if(valid() && error.name!=='AbortError') ui.setStatus('定位失败，已保留原图片和位置：'+error.message,'error');
      return false;
    } finally {
      if(valid()) {ui._browseBusy=ui._browseNavigating=false;ui.grid?.removeAttribute('aria-busy');ui.saveBrowseProgress();ui.scheduleScrollFill();}
    }

  },
  updateBrowseVisible(ui) {

    if(!ui.browseActive() || ui._browseNavigating) return;
    const state=ui.browseState;
    const top=Number(ui.grid.scrollTop)||0;
    let page=ui._browsePages[0]?.page || state.visiblePage;
    for(const marker of ui.grid.querySelectorAll('.adg-page-boundary')) {
      if((Number.parseFloat(marker.style.top)||0)<=top+2) page=Number(marker.dataset.page);
    }
    if(page!==state.visiblePage) {state.setVisiblePage(page);ui.page=page;ui.renderPagination();}
    ui.queueBrowseProgress();

  },
  async appendNextBatch(ui) {
    const owner = ui.galleryController;
    const old = owner.legacy;

    if(!ui.browseActive()) return old.appendNextBatch.call(ui);
    if(ui._browseBusy || ui._browseNavigating || ui.fillMoreExhausted || !ui.posts.length) return false;
    const state=ui.browseState;
    const last=ui._browsePages.at(-1)?.page || state.visiblePage;
    const page=last+1;
    if(!state.pageNumbers && state.cursorFor(page)===undefined) {ui.fillMoreExhausted=true;return false;}
    const epoch=owner.epoch, token=state.token();
    const valid=()=>!ui.disposed && ui.browseActive() && state===ui.browseState && epoch===owner.epoch && state.isCurrent(token);
    ui._browseBusy=ui.fillMoreBusy=true;
    try {
      let entry=state.getPage(page);
      if(!entry) {
        const controller=new AbortController();owner.requestController=controller;
        const result=await fetchGalleryPage(ui,{...ui._browseSnapshot,page,cursor:state.cursorFor(page)||'',limit:state.pageLimit},controller.signal);
        if(!valid()) return false;
        if(!result.posts.length || result.posts.every(post=>ui._browsePostPages.has(ui.postKeyOf(post)))) {
          ui.fillMoreExhausted=true;ui.setStatus('已到当前结果末尾');return false;
        }
        entry=state.putPage(page,{...result,cursor:result.cursor ?? state.cursorFor(page) ?? ''});
        if(!entry) throw new Error('该页图片数量超出缓存上限');
      }
      if(!valid()) return false;
      ui.showBrowseWindow(state.visiblePage,{preserve:true,append:true});
      if(ui._browseRandom)ui.rememberRandomResults(ui.currentQuery());
      return ui._browsePages.some(e=>e.page===page);
    } catch(error) {
      if(valid() && error.name!=='AbortError') ui.setStatus('加载失败，图片和位置已保留；继续滚动可重试：'+error.message,'error');
      return false;
    } finally {if(valid()) ui._browseBusy=ui.fillMoreBusy=false;}

  },
  growPool(ui, ...args) {
    const old = ui.galleryController.legacy;
    return ui.browseActive() ? ui.appendNextBatch() : old.growPool.call(ui,...args);
  },
  rebuildPool(ui) {
    const old = ui.galleryController.legacy;
    return ui.browseState ? ui.search({resetPage:true,force:true}) : old.rebuildPool.call(ui);
  },
  scrollMode(ui) {
    const old = ui.galleryController.legacy;
    return ui.browseActive() ? ui.settings.galleryScrollMode==='infinite' : old.scrollMode.call(ui);
  },
  renderPagination(ui) {
    const old = ui.galleryController.legacy;

    if(!ui.browseActive()) return old.renderPagination.call(ui);
    const state=ui.browseState;
    if(ui._browseMode!==ui.settings.galleryScrollMode) {
      const location=ui.browseLocation();
      ui._browseMode=ui.settings.galleryScrollMode;
      if(location) {ui.showBrowseWindow(location.page);if(location.anchor)ui.restoreScrollAnchor(location.anchor);}
      return;
    }
    ui.page=state.visiblePage;
    const last=state.getPage(state.visiblePage);
    renderGalleryBrowseNavigation(ui.pagination,{page:state.visiblePage,pageNumbers:state.pageNumbers,knownPages:state.knownPages(),
      canNext:state.pageNumbers ? !last?.exhausted : state.cursorFor(state.visiblePage+1)!==undefined,
      hasReturn:!!state.returnLocation,
      onNavigate:page=>void ui.navigateBrowse(page),
      onStart:()=>void ui.navigateBrowse(1,{start:true}),
      onReturn:()=>{const r=state.returnLocation;if(r)void ui.navigateBrowse(r.page,{anchor:r.anchor,returning:true});}});

  },
  handleGridResize(ui) {
    const old = ui.galleryController.legacy;

    if(!ui.browseState) return old.handleGridResize.call(ui);
    ui.scheduleMasonryLayout();
    ui.scheduleScrollFill();

  },
  scheduleMasonryLayout(ui) {
    const old = ui.galleryController.legacy;

    if(!ui.browseActive()) return old.scheduleMasonryLayout.call(ui);
    if(ui.masonryLayoutFrame || !ui.grid) return;
    const anchor=ui.captureScrollAnchor();
    ui.masonryLayoutFrame=requestAnimationFrame(()=>{ui.masonryLayoutFrame=null;ui.applyMasonryLayout();if(anchor)ui.restoreScrollAnchor(anchor);});

  },
  scheduleAutoFill(ui) {
    const old = ui.galleryController.legacy;
    if(!ui.browseState) old.scheduleAutoFill.call(ui);
  },
  renderPosts(ui, options) {
    const old = ui.galleryController.legacy;

    ui.ensureBrowse();
    ui.captureBrowseSelections();
    ui._browseRendering = true;
    try {old.renderPosts.call(ui,options);} finally {ui._browseRendering=false;}
    ui.restoreBrowseSelections();
    if(ui.browseActive() && ui._postKeyIndex) {
      const keep=new Map(ui._browseSelectedPosts);
      for(const entry of ui.browseState.pages.values()) for(const post of entry.posts) keep.set(ui.postKeyOf(post),post);
      for(const post of ui.displayPosts()) keep.set(ui.postKeyOf(post),post);
      ui._postKeyIndex=keep;
    }

  },
  captureBrowseSelections(ui) {

    if(!ui._browseSelected) return;
    for(const card of ui.grid?.querySelectorAll('.adg-card.is-selected') || []) {
      const key=ui.selectionKey(card);
      ui._browseSelected.set(key,ui.selectionFromCard(card));
      const post=ui.displayPosts().find(p=>ui.postKeyOf(p)===key);
      if(post)ui._browseSelectedPosts.set(key,post);
      if(!ui.selectionOrder.includes(key)) ui.selectionOrder.push(key);
    }

  },
  restoreBrowseSelections(ui) {

    for(const card of ui.grid?.querySelectorAll('.adg-card') || []) {
      const selected=ui._browseSelected?.has(ui.selectionKey(card)) || false;
      card.classList.toggle('is-selected',selected);
      card.querySelector('.adg-card-select')?.setAttribute('aria-pressed',String(selected));
    }

  },
  selectionKey(ui, card) {
    return String(card?.dataset?.postKey || card?.dataset?.postId || card?.dataset?.imageUrl || '').trim();
  },
  rememberCardSelection(ui, card, selected) {
    const old = ui.galleryController.legacy;

    ui.ensureBrowse();
    old.rememberCardSelection.call(ui,card,selected);
    const key=ui.selectionKey(card);
    if(selected){ui._browseSelected.set(key,ui.selectionFromCard(card));const post=ui.displayPosts().find(p=>ui.postKeyOf(p)===key);if(post)ui._browseSelectedPosts.set(key,post);}
    else {ui._browseSelected.delete(key);ui._browseSelectedPosts.delete(key);}

  },
  selectedGallerySelections(ui) {

    ui.ensureBrowse();
    ui.captureBrowseSelections();
    const live=new Map([...(ui.grid?.querySelectorAll('.adg-card') || [])].map(card=>[ui.selectionKey(card),card]));
    if(!ui._browseRendering) for(const [key,card] of live) if(!card.classList.contains('is-selected')) ui._browseSelected.delete(key);
    ui.selectionOrder=[...new Set(ui.selectionOrder)].filter(key=>ui._browseSelected.has(key));
    for(const key of ui._browseSelectedPosts.keys()) if(!ui._browseSelected.has(key)) ui._browseSelectedPosts.delete(key);
    return ui.selectionOrder.map(key=>{
      const selection=ui._browseSelected.get(key), post=ui._browseSelectedPosts.get(key);
      if(!post) return ui.settings.promptOutputEnabled === false ? {...selection,prompt:""} : selection;
      const built=ui.buildPromptForPost(post);
      const edit=ui.promptEdits.get(key) || ui.promptEdits.get(String(post.id || ""));
      return {...selection,prompt:ui.settings.promptOutputEnabled===false ? "" : String(edit?.prompt ?? built.prompt ?? ""),tags:edit?.tags || built.tags,prompt_groups:built.groups};
    }).filter(s=>s.image_url);

  },
  setLoadedCardsSelected(ui, selected) {
    const old = ui.galleryController.legacy;

    ui.ensureBrowse();
    if(!selected)ui._browseSelected.clear();
    old.setLoadedCardsSelected.call(ui,selected);

  },
  openPixivPages(ui, post) {
    const old = ui.galleryController.legacy;

    ui.saveBrowseProgress();ui.cancelBrowseRequest();
    old.openPixivPages.call(ui,post);

  },
  closePixivPages(ui) {
    const old = ui.galleryController.legacy;
    old.closePixivPages.call(ui);ui.renderPagination();ui.queueBrowseProgress();
  },
  applyActiveCategory(ui, ...args) {
    const old = ui.galleryController.legacy;
    ui.saveBrowseProgress();ui.cancelBrowseRequest();return old.applyActiveCategory.apply(ui,args);
  },
  dispose(ui) {
    const old = ui.galleryController.legacy;

    ui.saveBrowseProgress();ui.cancelBrowseRequest();
    clearTimeout(ui._browseSaveTimer);
    window.removeEventListener('pagehide',ui._browsePageHide);
    old.dispose.call(ui);

  },
};
