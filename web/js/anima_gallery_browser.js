import { GalleryBrowseState, GalleryProgressStore, galleryBrowseKey, currentGalleryWorkflowId } from './anima_gallery_browse_state.js';
import { fetchGalleryPage } from './anima_gallery_page_fetch.js';
import { renderGalleryBrowseNavigation } from './anima_gallery_browse_navigation.js';

// The controller owns commits; the request adapter never writes to the live node.
export function installGalleryBrowser(UI, app) {
  const p = UI.prototype;
  const old = Object.fromEntries(['search', 'renderPosts', 'renderPagination', 'scrollMode', 'handleGridResize', 'scheduleAutoFill', 'appendNextBatch', 'openPixivPages', 'closePixivPages', 'dispose', 'selectedGallerySelections', 'rememberCardSelection', 'setLoadedCardsSelected', 'scheduleMasonryLayout', 'applyActiveCategory', 'galleryBatchLabel', 'growPool', 'rebuildPool'].map(k => [k, p[k]]));
  p.legacySearch = old.search;
  p.ensureBrowse = function () {
    if (this._browseInitialized) return;
    this._browseInitialized = true;
    this._browseEpoch = 0;
    this._browsePages = [];
    this._browsePostPages = new Map();
    this._browseSelected = new Map();
    this._browseSelectedPosts = new Map();
    this._browseMode = this.settings.galleryScrollMode;
    this._browsePageHide = () => this.saveBrowseProgress();
    window.addEventListener('pagehide', this._browsePageHide);
  };
  p.browseStore = function () {
    const namespace = 'anima.gallery.progress.v1:' + currentGalleryWorkflowId(app, this.node) + ':' + String(this.node.id);
    if (this._browseStore?.namespace !== namespace) {
      let storage;
      try { storage = localStorage; } catch { storage = null; }
      this._browseStore = new GalleryProgressStore({ storage, namespace });
    }
    return this._browseStore;
  };
  p.galleryBatchLabel = function () {return this.browseState ? `第 ${this.browseState.visiblePage} ${this.browseState.pageNumbers ? "页" : "批"}` : old.galleryBatchLabel.call(this);};
  p.browseActive = function () {
    return !!this.browseState && !this.settings.activeCategory && !this.pixivDetail && !this.diffContext;
  };
  p.cancelBrowseRequest = function () {
    this._browseEpoch = (this._browseEpoch || 0) + 1;
    this._browseController?.abort();
    this._browseController = null;
    this._browseBusy = this._browseNavigating = false;
    this.grid?.removeAttribute("aria-busy");
    this.fillMoreBusy = false;
    this._scrollLoading = false;
    this.controller?.abort();
    this.requestId += 1;
  };
  p.browseLocation = function () {
    const state = this.browseState;
    if (!state) return null;
    const anchor = this.captureScrollAnchor();
    const page = anchor ? this._browsePostPages.get(anchor.key) || state.visiblePage : state.visiblePage;
    return { page, anchor, pageLimit: state.pageLimit, cursor: state.cursorFor(page) ?? null,
      records: state.knownPages().filter(n => Math.abs(n - page) <= 6).map(n => ({page:n, cursor:state.cursorFor(n)})).filter(r => typeof r.cursor === 'string') };
  };
  p.saveBrowseProgress = function () {
    clearTimeout(this._browseSaveTimer);
    this._browseSaveTimer = null;
    if (!this.browseActive() || this._browseRandom || this._browseNavigating) return;
    const record = this.browseLocation();
    if (record) (this._browseProgressStore || this.browseStore()).save(this.browseState.key, record);
  };
  p.queueBrowseProgress = function () {
    clearTimeout(this._browseSaveTimer);
    this._browseSaveTimer = setTimeout(() => this.saveBrowseProgress(), 500);
  };
  p.browseSnapshot = function () {
    const source = this.activeSourceId();
    const query = String(this.queryInput?.value ?? this.queryWidget?.value ?? this.settings.lastQuery ?? '').trim();
    return { source, query, filters: source === 'danbooru' ? this.settings.filters : this.gallerySourceFilters(source),
      limit: Number(this.settings.limit) || 0,
      extra: { excluded: this.settings.excludeTags, favorites: !!this.settings.favoritesOnly,
        favoriteQuery: this.settings.favoritesOnly ? this.favoriteMeta?.query_tag || '' : '',
        pool: source==='civitai' ? this.settings.civitaiPool : null } };
  };
  p.search = async function (options = {}) {
    this.ensureBrowse();
    this.saveBrowseProgress();
    this.cancelBrowseRequest();
    if (this.diffContext) {
      this.browseState = null;
      return old.search.call(this, options);
    }
    const snapshot = this.browseSnapshot();
    this.hideSuggestions();
    if (!snapshot.query && (snapshot.source === 'pixiv' || (snapshot.source === 'danbooru' && !this.currentQuery()))) {
      this.setStatus(snapshot.source === 'pixiv' ? 'P站：请输入关键词后搜索' : '输入 Danbooru 标签后搜索');
      return;
    }
    const key = galleryBrowseKey(snapshot);
    const random = snapshot.source === 'danbooru' && /order:random/.test(this.currentQuery());
    const progressStore = this.browseStore();
    const saved = !options.force && !random ? progressStore.load(key) : null;
    const previous = this.browseState;
    const state = new GalleryBrowseState({pageLimit:saved?.pageLimit || (snapshot.source === 'pixiv' ? 30 : Math.max(1, Number(this.resolveLimit()) || 30)), pageNumbers:this.pageMode(snapshot.source)});
    state.reset({key});
    if (saved) {
      for (const r of saved.records || []) state.cursors.set(r.page, r.cursor);
      if (typeof saved.cursor === 'string') state.cursors.set(saved.page, saved.cursor);
    }
    const target = saved && (state.pageNumbers || state.cursorFor(saved.page) !== undefined) ? saved.page : 1;
    const epoch = this._browseEpoch;
    const controller = new AbortController();
    this._browseController = controller;
    this._browseBusy = this._browseNavigating = true;
    this.setStatus(saved ? '正在恢复上次浏览位置…' : '正在搜索：' + snapshot.query);
    this.grid?.setAttribute('aria-busy', 'true');
    const valid = () => !this.disposed && epoch === this._browseEpoch;
    try {
      const result = await fetchGalleryPage(this, {...snapshot,page:target,cursor:state.cursorFor(target) ?? '',limit:state.pageLimit,force:!!options.force,allowFuzzy:target===1},controller.signal);
      if (!valid()) return;
      if (!saved?.anchor && !result.posts.length && this.posts.length) {
        this.setStatus('这一页没有结果，已保留原来的图片和位置；可以重试或从头看', 'warning');
        return;
      }
      if (!state.putPage(target,{...result,cursor:result.cursor ?? state.cursorFor(target) ?? '',exhausted:!result.posts.length})) throw new Error('该页图片数量超出缓存上限');
      let restorePage = target;
      let updated = false;
      if (saved?.anchor && !result.posts.some(post => this.postKeyOf(post) === saved.anchor.key)) {
        for (const n of [target-1,target+1]) {
          if (n < 1 || (!state.pageNumbers && state.cursorFor(n) === undefined)) continue;
          try {
            const nearby = await fetchGalleryPage(this,{...snapshot,page:n,cursor:state.cursorFor(n)||'',limit:state.pageLimit},controller.signal);
            if (!valid()) return;
            if (nearby.posts.length) state.putPage(n,{...nearby,cursor:nearby.cursor ?? state.cursorFor(n) ?? ''});
            if (nearby.posts.some(post => this.postKeyOf(post) === saved.anchor.key)) {restorePage=n; break;}
          } catch (error) { if (error.name === 'AbortError') throw error; }
        }
        updated = ![...state.pages.values()].some(e => e.posts.some(post => this.postKeyOf(post) === saved.anchor.key));
      }
      if (!valid()) return;
      if (!state.getPage(restorePage)?.posts.length && this.posts.length) {this.setStatus("记录页暂时没有结果，已保留原图片和位置；可从头看或重试", "warning");return;}
      // Query preparation (quota/fuzzy correction) is committed only after success.
      this.settings.filters = result.settings.filters;
      this.settings.lastQuery = result.query;
      this.settings.sourceQueries = {...this.settings.sourceQueries,[snapshot.source]:result.query};
      this.setQuery(result.query);
      if (result.account.registered != null) this.registered = result.account.registered;
      if (result.account.tag_limit != null) this.tagLimitValue = result.account.tag_limit;
      this.settings.activeCategory = '';
      this.pixivDetail = null;
      this.sourcePool = null;
      this._searchSnapshot = null;
      this.pixivReturnAnchor = null;
      this.browseState = state;
      this._browseProgressStore = progressStore;
      this._browseSnapshot = {...snapshot,query:result.query};
      this._browseRandom = random;
      state.setVisiblePage(restorePage);
      this.fillMoreExhausted = false;
      this.syncReturnButton();
      this.filterControls?.refresh();
      this.saveSettings();
      this.showBrowseWindow(restorePage);
      if (!saved?.anchor || updated || !this.restoreScrollAnchor(saved.anchor)) this.scrollToBrowsePage(restorePage);
      this.setStatus(updated ? '搜索结果已更新，已回到记录页顶部' : (saved ? '已接着上次的位置浏览 · ' + this.galleryBatchLabel() : result.status));
      // Auto-match operates on committed cards; older search responses never reach it.
      if (random) this.rememberRandomResults(this.currentQuery());
      void this.autoMatchPixiv(result.posts);
    } catch (error) {
      if (valid() && error.name !== 'AbortError') this.setStatus('搜索失败，已保留原图片和位置：' + error.message, 'error');
      if (valid()) this.browseState = previous;
    } finally {
      if (valid()) {
        this._browseBusy = this._browseNavigating = false;
        this.grid?.removeAttribute('aria-busy');
        this.renderPagination();
        if (this.browseState === state) { this.saveBrowseProgress(); this.scheduleScrollFill(); }
      }
    }
  };
  p.showBrowseWindow = function (page, {preserve=false, append=false}={}) {
    const state = this.browseState;
    this._browsePages = state.windowPages(page,{continuous:this.settings.galleryScrollMode==='infinite'});
    this._browsePostPages = new Map();
    const seen = new Set();
    this.posts = [];
    const groups = new Map();
    for (const entry of this._browsePages) {
      for (const [key,pages] of entry.groups || []) groups.set(key,pages);
      for (const post of entry.posts) {
        const key = this.postKeyOf(post);
        if (seen.has(key)) continue;
        seen.add(key);
        this._browsePostPages.set(key,entry.page);
        this.posts.push(post);
      }
    }
    this.pixivPageGroups = groups.size ? groups : null;
    this.renderPosts({preserveScroll:preserve,appendOnly:append});
    this.renderPagination();
  };
  p.scrollToBrowsePage = function (page) {
    const marker = [...(this.grid?.querySelectorAll('.adg-page-boundary') || [])].find(el => Number(el.dataset.page)===page);
    if (this.grid) this.grid.scrollTop = Math.max(0, Number.parseFloat(marker?.style.top) || 0);
    this.browseState?.setVisiblePage(page);
    this.page = page;
    this.renderPagination();
  };
  p.navigateBrowse = async function (page, {anchor=null,returning=false,start=false}={}) {
    const state = this.browseState;
    page = Number(page);
    if (!this.browseActive() || !Number.isSafeInteger(page) || page<1) return false;
    if (!state.pageNumbers && state.cursorFor(page) === undefined) {this.setStatus('只能定位已访问或已有游标的批次','warning'); return false;}
    const before = this.browseLocation();
    this.saveBrowseProgress();
    this.cancelBrowseRequest();
    state.beginNavigation();
    const token=state.token(), epoch=this._browseEpoch;
    const valid=()=>!this.disposed && state===this.browseState && state.isCurrent(token) && epoch===this._browseEpoch;
    this._browseNavigating=true;
    try {
      let entry = !start ? state.getPage(page) : null;
      if (!entry) {
        this._browseBusy=true;
        const controller=new AbortController(); this._browseController=controller;
        this.setStatus('正在定位第 '+page+(state.pageNumbers?' 页…':' 批…'));
        this.grid?.setAttribute('aria-busy','true');
        const result=await fetchGalleryPage(this,{...this._browseSnapshot,page,cursor:state.cursorFor(page)||'',limit:state.pageLimit,force:start},controller.signal);
        if (!valid()) return false;
        if (!result.posts.length) {this.setStatus('这一页没有结果，已保留原图片和位置；可再次定位重试','warning'); return false;}
        entry=state.putPage(page,{...result,cursor:result.cursor ?? state.cursorFor(page) ?? ''});
        if (!entry) throw new Error('该页图片数量超出缓存上限');
      }
      if (!valid()) return false;
      if (start) state.returnLocation=null;
      else if (!returning) state.returnLocation=before;
      // Cached cards already mounted need only a scroll; detached pages use a bounded window.
      if (!this._browsePages.some(e=>e.page===page) || this.settings.galleryScrollMode==='pager' || start) this.showBrowseWindow(page);
      this.scrollToBrowsePage(page);
      if (anchor) this.restoreScrollAnchor(anchor);
      this.page=page;
      state.setVisiblePage(page);
      this.fillMoreExhausted=false;
      this.renderPagination();
      this.setStatus('已定位 · '+this.galleryBatchLabel());
      this.grid?.focus?.({preventScroll:true});
      return true;
    } catch(error) {
      if(valid() && error.name!=='AbortError') this.setStatus('定位失败，已保留原图片和位置：'+error.message,'error');
      return false;
    } finally {
      if(valid()) {this._browseBusy=this._browseNavigating=false;this.grid?.removeAttribute('aria-busy');this.saveBrowseProgress();this.scheduleScrollFill();}
    }
  };
  p.updateBrowseVisible = function () {
    if(!this.browseActive() || this._browseNavigating) return;
    const state=this.browseState;
    const top=Number(this.grid.scrollTop)||0;
    let page=this._browsePages[0]?.page || state.visiblePage;
    for(const marker of this.grid.querySelectorAll('.adg-page-boundary')) {
      if((Number.parseFloat(marker.style.top)||0)<=top+2) page=Number(marker.dataset.page);
    }
    if(page!==state.visiblePage) {state.setVisiblePage(page);this.page=page;this.renderPagination();}
    this.queueBrowseProgress();
  };
  p.appendNextBatch = async function () {
    if(!this.browseActive()) return old.appendNextBatch.call(this);
    if(this._browseBusy || this._browseNavigating || this.fillMoreExhausted || !this.posts.length) return false;
    const state=this.browseState;
    const last=this._browsePages.at(-1)?.page || state.visiblePage;
    const page=last+1;
    if(!state.pageNumbers && state.cursorFor(page)===undefined) {this.fillMoreExhausted=true;return false;}
    const epoch=this._browseEpoch, token=state.token();
    const valid=()=>!this.disposed && this.browseActive() && state===this.browseState && epoch===this._browseEpoch && state.isCurrent(token);
    this._browseBusy=this.fillMoreBusy=true;
    try {
      let entry=state.getPage(page);
      if(!entry) {
        const controller=new AbortController();this._browseController=controller;
        const result=await fetchGalleryPage(this,{...this._browseSnapshot,page,cursor:state.cursorFor(page)||'',limit:state.pageLimit},controller.signal);
        if(!valid()) return false;
        if(!result.posts.length || result.posts.every(post=>this._browsePostPages.has(this.postKeyOf(post)))) {
          this.fillMoreExhausted=true;this.setStatus('已到当前结果末尾');return false;
        }
        entry=state.putPage(page,{...result,cursor:result.cursor ?? state.cursorFor(page) ?? ''});
        if(!entry) throw new Error('该页图片数量超出缓存上限');
      }
      if(!valid()) return false;
      this.showBrowseWindow(state.visiblePage,{preserve:true,append:true});
      if(this._browseRandom)this.rememberRandomResults(this.currentQuery());
      return this._browsePages.some(e=>e.page===page);
    } catch(error) {
      if(valid() && error.name!=='AbortError') this.setStatus('加载失败，图片和位置已保留；继续滚动可重试：'+error.message,'error');
      return false;
    } finally {if(valid()) this._browseBusy=this.fillMoreBusy=false;}
  };
  p.growPool = function () {return this.browseActive() ? this.appendNextBatch() : old.growPool.call(this,...arguments);};
  p.rebuildPool = function () {return this.browseState ? this.search({resetPage:true,force:true}) : old.rebuildPool.call(this);};
  p.scrollMode = function () {return this.browseActive() ? this.settings.galleryScrollMode==='infinite' : old.scrollMode.call(this);};
  p.renderPagination = function () {
    if(!this.browseActive()) return old.renderPagination.call(this);
    const state=this.browseState;
    if(this._browseMode!==this.settings.galleryScrollMode) {
      const location=this.browseLocation();
      this._browseMode=this.settings.galleryScrollMode;
      if(location) {this.showBrowseWindow(location.page);if(location.anchor)this.restoreScrollAnchor(location.anchor);}
      return;
    }
    this.page=state.visiblePage;
    const last=state.getPage(state.visiblePage);
    renderGalleryBrowseNavigation(this.pagination,{page:state.visiblePage,pageNumbers:state.pageNumbers,knownPages:state.knownPages(),
      canNext:state.pageNumbers ? !last?.exhausted : state.cursorFor(state.visiblePage+1)!==undefined,
      hasReturn:!!state.returnLocation,
      onNavigate:page=>void this.navigateBrowse(page),
      onStart:()=>void this.navigateBrowse(1,{start:true}),
      onReturn:()=>{const r=state.returnLocation;if(r)void this.navigateBrowse(r.page,{anchor:r.anchor,returning:true});}});
  };
  p.handleGridResize = function () {
    if(!this.browseState) return old.handleGridResize.call(this);
    this.scheduleMasonryLayout();
    this.scheduleScrollFill();
  };
  p.scheduleMasonryLayout = function () {
    if(!this.browseActive()) return old.scheduleMasonryLayout.call(this);
    if(this.masonryLayoutFrame || !this.grid) return;
    const anchor=this.captureScrollAnchor();
    this.masonryLayoutFrame=requestAnimationFrame(()=>{this.masonryLayoutFrame=null;this.applyMasonryLayout();if(anchor)this.restoreScrollAnchor(anchor);});
  };
  p.scheduleAutoFill = function () {if(!this.browseState) old.scheduleAutoFill.call(this);};
  p.renderPosts = function (options) {
    this.ensureBrowse();
    this.captureBrowseSelections();
    this._browseRendering = true;
    try {old.renderPosts.call(this,options);} finally {this._browseRendering=false;}
    this.restoreBrowseSelections();
    if(this.browseActive() && this._postKeyIndex) {
      const keep=new Map(this._browseSelectedPosts);
      for(const entry of this.browseState.pages.values()) for(const post of entry.posts) keep.set(this.postKeyOf(post),post);
      for(const post of this.displayPosts()) keep.set(this.postKeyOf(post),post);
      this._postKeyIndex=keep;
    }
  };
  p.captureBrowseSelections = function () {
    if(!this._browseSelected) return;
    for(const card of this.grid?.querySelectorAll('.adg-card.is-selected') || []) {
      const key=this.selectionKey(card);
      this._browseSelected.set(key,this.selectionFromCard(card));
      const post=this.displayPosts().find(p=>this.postKeyOf(p)===key);
      if(post)this._browseSelectedPosts.set(key,post);
      if(!this.selectionOrder.includes(key)) this.selectionOrder.push(key);
    }
  };
  p.restoreBrowseSelections = function () {
    for(const card of this.grid?.querySelectorAll('.adg-card') || []) {
      const selected=this._browseSelected?.has(this.selectionKey(card)) || false;
      card.classList.toggle('is-selected',selected);
      card.querySelector('.adg-card-select')?.setAttribute('aria-pressed',String(selected));
    }
  };
  p.selectionKey = function(card) {return String(card?.dataset?.postKey || card?.dataset?.postId || card?.dataset?.imageUrl || '').trim();};
  p.rememberCardSelection = function (card,selected) {
    this.ensureBrowse();
    old.rememberCardSelection.call(this,card,selected);
    const key=this.selectionKey(card);
    if(selected){this._browseSelected.set(key,this.selectionFromCard(card));const post=this.displayPosts().find(p=>this.postKeyOf(p)===key);if(post)this._browseSelectedPosts.set(key,post);}
    else {this._browseSelected.delete(key);this._browseSelectedPosts.delete(key);}
  };
  p.selectedGallerySelections = function () {
    this.ensureBrowse();
    this.captureBrowseSelections();
    const live=new Map([...(this.grid?.querySelectorAll('.adg-card') || [])].map(card=>[this.selectionKey(card),card]));
    if(!this._browseRendering) for(const [key,card] of live) if(!card.classList.contains('is-selected')) this._browseSelected.delete(key);
    this.selectionOrder=[...new Set(this.selectionOrder)].filter(key=>this._browseSelected.has(key));
    for(const key of this._browseSelectedPosts.keys()) if(!this._browseSelected.has(key)) this._browseSelectedPosts.delete(key);
    return this.selectionOrder.map(key=>{
      const selection=this._browseSelected.get(key), post=this._browseSelectedPosts.get(key);
      if(!post) return this.settings.promptOutputEnabled === false ? {...selection,prompt:""} : selection;
      const built=this.buildPromptForPost(post);
      const edit=this.promptEdits.get(key) || this.promptEdits.get(String(post.id || ""));
      return {...selection,prompt:this.settings.promptOutputEnabled===false ? "" : String(edit?.prompt ?? built.prompt ?? ""),tags:edit?.tags || built.tags,prompt_groups:built.groups};
    }).filter(s=>s.image_url);
  };
  p.setLoadedCardsSelected = function(selected) {
    this.ensureBrowse();
    if(!selected)this._browseSelected.clear();
    old.setLoadedCardsSelected.call(this,selected);
  };
  p.openPixivPages = function(post) {
    this.saveBrowseProgress();this.cancelBrowseRequest();
    old.openPixivPages.call(this,post);
  };
  p.closePixivPages = function() {old.closePixivPages.call(this);this.renderPagination();this.queueBrowseProgress();};
  if(old.applyActiveCategory) p.applyActiveCategory = function(...args) {this.saveBrowseProgress();this.cancelBrowseRequest();return old.applyActiveCategory.apply(this,args);};
  p.dispose = function() {
    this.saveBrowseProgress();this.cancelBrowseRequest();
    clearTimeout(this._browseSaveTimer);
    window.removeEventListener('pagehide',this._browsePageHide);
    old.dispose.call(this);
  };
}
