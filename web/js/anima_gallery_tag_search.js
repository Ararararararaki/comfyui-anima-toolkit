// Website-style tag completion for the three native booru search sources.
const SOURCES = new Set(['safebooru', 'yandere', 'konachan']);
const LABELS = { safebooru: 'Safebooru', yandere: 'yande.re', konachan: 'Konachan.net' };
const TYPES = { general: '通用', artist: '画师', copyright: '作品', character: '角色', circle: '社团', style: '风格', faults: '标记', tag: '标签', syntax: '语法' };

export function booruTokenAt(raw, caret) {
  raw = String(raw ?? '');
  const at = Math.max(0, Math.min(raw.length, Number.isFinite(caret) ? caret : raw.length));
  let start = at, end = at;
  while (start > 0 && !/\s/.test(raw[start - 1])) start--;
  while (end < raw.length && !/\s/.test(raw[end])) end++;
  const token = raw.slice(start, end);
  const prefix = token.startsWith('-') ? '-' : '';
  const suffix = token.endsWith('~') ? '~' : '';
  return { start, end, prefix, suffix, query: token.slice(prefix.length, suffix ? -1 : undefined), token };
}

export function completeBooruToken(raw, context, tag) {
  raw = String(raw ?? '');
  const replacement = context.prefix + tag + context.suffix;
  const after = raw.slice(context.end);
  const gap = after && /\s/.test(after[0]) ? '' : ' ';
  return { value: raw.slice(0, context.start) + replacement + gap + after,
    caret: context.start + replacement.length + (gap ? 1 : after ? 1 : 0) };
}

export function booruSyntaxChoices(source, query) {
  const common = [
    ['rating:safe', '全年龄'], ['rating:questionable', '存疑分级'], ['rating:explicit', '成人分级'],
    ['width:>=1920', '宽度至少 1920'], ['height:>=1080', '高度至少 1080'], ['score:>=10', '评分至少 10'],
  ];
  const sorts = source === 'safebooru' ? [['sort:score:desc', '评分从高到低'], ['sort:id:desc', '最新优先']]
    : [['order:score', '评分从高到低'], ['order:id', '最新优先']];
  if (!query.includes(':')) return null;
  return [...common, ...sorts].filter(([tag]) => tag.startsWith(query.toLowerCase()))
    .map(([tag, note]) => ({ tag, note, category: 'syntax', postCount: null }));
}

export function installGalleryTagSearch(UI) {
  const p = UI.prototype;
  const old = Object.fromEntries(['build', 'scheduleSuggestions', 'hideSuggestions', 'resetSuggestionMode', 'positionSuggestions'].map(k => [k, p[k]]));
  p.resetSuggestionMode = function () {
    if (this.suggestions?.classList.contains('is-booru')) this.suggestions.style.maxHeight = '';
    old.resetSuggestionMode.call(this);
    this._booruCompletion = null;
    this.suggestions?.classList.remove('is-booru');
    this.suggestions?.removeAttribute('role');
    this.suggestions?.removeAttribute('aria-label');
    this.queryInput?.removeAttribute('aria-activedescendant');
    this.queryInput?.removeAttribute('aria-controls');
    this.queryInput?.removeAttribute('aria-autocomplete');
    this.queryInput?.removeAttribute('role');
    this.queryInput?.removeAttribute('aria-expanded');
  };
  p.hideSuggestions = function () { old.hideSuggestions.call(this); this._booruCompletion = null; };
  p.scheduleSuggestions = function (value) {
    const source = this.activeSourceId();
    const raw = String(value ?? '');
    const context = booruTokenAt(raw, this.queryInput?.selectionStart ?? raw.length);
    if (!SOURCES.has(source) || !raw.trim() || context.token.startsWith('@')) {
      return old.scheduleSuggestions.call(this, value);
    }
    this.hideSuggestions(); // Cancel immediately, including during the debounce window.
    if (!context.query || /^[()~]+$/.test(context.query)) return;
    const input = this.queryInput;
    const requestId = this.suggestionRequestId;
    this.suggestionTimer = setTimeout(() => {
      this.suggestionTimer = null;
      if (requestId !== this.suggestionRequestId) return;
      void this.fetchBooruSuggestions(source, raw, context, input);
    }, 180);
  };
  p.booruCompletionCurrent = function (state) {
    const input = this.queryInput;
    if (!state || this.disposed || state.source !== this.activeSourceId() || input?.value !== state.raw) return false;
    const context = booruTokenAt(input.value, input.selectionStart ?? input.value.length);
    return context.start === state.context.start && context.end === state.context.end && context.token === state.context.token;
  };
  p.fetchBooruSuggestions = async function (source, raw, context, input) {
    const requestId = ++this.suggestionRequestId;
    const state = { source, raw, context, choices: [], index: 0 };
    if (!this.booruCompletionCurrent(state)) return;
    const controller = new AbortController();
    this.suggestionController = controller;
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const syntax = booruSyntaxChoices(source, context.query);
      let data;
      if (syntax !== null) data = { suggestionDetails: syntax };
      else {
        const response = await fetch('/anima/gallery/' + source + '/suggest?q=' + encodeURIComponent(context.query), { signal: controller.signal });
        if (!response.ok) throw new Error('Tag lookup failed');
        data = await response.json();
      }
      if (requestId !== this.suggestionRequestId || !this.booruCompletionCurrent(state)
        || input.ownerDocument.activeElement !== input) return;
      const rows = Array.isArray(data?.suggestionDetails) ? data.suggestionDetails : [];
      state.choices = this.sortSuggestionsByUsage(rows.filter(row => typeof row?.tag === 'string' && row.tag && !/\s/.test(row.tag))).slice(0,20);
      this.renderBooruSuggestions(state, data?.warnings?.[0]);
    } catch (error) {
      if (requestId === this.suggestionRequestId && this.booruCompletionCurrent(state)
        && input.ownerDocument.activeElement === input) {
        console.debug('[TK gallery] Tag completion unavailable:', source, error?.name, error?.message);
        this.renderBooruSuggestions(state, '标签联想暂不可用，可直接回车搜索');
      }
    } finally {
      clearTimeout(timer);
      if (this.suggestionController === controller) this.suggestionController = null;
    }
  };
  p.renderBooruSuggestions = function (state, warning = '') {
    const box = this.suggestions;
    if (!box) return;
    const doc = box.ownerDocument;
    if (!box.isConnected) doc.body.append(box);
    this.resetSuggestionMode();
    this._booruCompletion = state;
    box.replaceChildren();
    box.classList.add('is-booru');
    box.style.display = 'flex';
    box.id ||= 'adg-booru-suggestions-' + this.node.id + '-' + Math.random().toString(36).slice(2);
    box.setAttribute('role','listbox');
    box.setAttribute('aria-label',LABELS[state.source] + ' 标签联想');
    const input = this.queryInput;
    input.setAttribute('role','combobox');
    input.setAttribute('aria-autocomplete','list');
    input.setAttribute('aria-controls',box.id);
    input.setAttribute('aria-expanded','true');
    const title = doc.createElement('div');
    title.className = 'adg-booru-heading';
    title.textContent = LABELS[state.source] + ' · 标签联想';
    box.append(title);
    for (const [index, item] of state.choices.entries()) {
      const row = doc.createElement('button');
      row.type = 'button'; row.className = 'adg-booru-choice';
      row.id = box.id + '-' + index;
      row.setAttribute('role','option');
      row.setAttribute('aria-selected',index === state.index ? 'true' : 'false');
      row.dataset.category = item.category || 'tag';
      row.classList.toggle('is-active',index === state.index);
      const tag = doc.createElement('span'); tag.className = 'adg-booru-tag';
      tag.textContent = state.context.prefix + item.tag + state.context.suffix;
      const kind = doc.createElement('span'); kind.className = 'adg-booru-kind';
      kind.textContent = item.note || TYPES[item.category] || '标签';
      const count = doc.createElement('span'); count.className = 'adg-booru-count';
      count.textContent = item.postCount == null ? '' : Number(item.postCount).toLocaleString();
      count.title = LABELS[state.source] + ' 标签数量（官网接口，非 D站 数量）';
      row.append(tag,kind,count);
      row.onpointerdown = row.onmousedown = event => { event.preventDefault(); event.stopPropagation(); };
      row.onclick = event => {event.stopPropagation();this.chooseBooruSuggestion(index);};
      row.onpointerenter = () => this.markBooruSuggestion(index);
      box.append(row);
    }
    const hint = doc.createElement('div'); hint.className = 'adg-booru-hint';
    hint.textContent = warning || (state.choices.length ? '↑↓ 选择 · Tab / Enter 补全 · 再按 Enter 搜索'
      : '暂无标签联想，可直接回车搜索');
    box.append(hint);
    const syntax = doc.createElement('div'); syntax.className = 'adg-booru-hint';
    syntax.textContent = '空格组合标签 · -标签 排除 · * 通配 · rating: 分级';
    box.append(syntax);
    this.positionSuggestions();
    this.markBooruSuggestion(state.index);
  };
  p.markBooruSuggestion = function (index) {
    const state = this._booruCompletion;
    if (!state?.choices.length) return;
    state.index = (index + state.choices.length) % state.choices.length;
    const rows = [...this.suggestions.querySelectorAll('.adg-booru-choice')];
    rows.forEach((row,i) => {row.classList.toggle('is-active',i === state.index);row.setAttribute('aria-selected',i === state.index ? 'true' : 'false');});
    const active = rows[state.index];
    if (active) {this.queryInput.setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'});}
  };
  p.chooseBooruSuggestion = function (index) {
    const state = this._booruCompletion;
    if (!this.booruCompletionCurrent(state)) {this.hideSuggestions();return;}
    const item = state.choices[index];
    if (!item) return;
    const completed = completeBooruToken(state.raw,state.context,item.tag);
    this.recordTagUsage(item.tag);
    this.setQuery(completed.value);
    this.hideSuggestions(); // setQuery schedules again; typing the next token will reopen.
    this.queryInput.focus({preventScroll:true});
    this.queryInput.setSelectionRange(completed.caret,completed.caret);
  };
  p.handleBooruSuggestionKey = function (event) {
    const state = this._booruCompletion;
    if (!state || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (!this.booruCompletionCurrent(state)) {this.hideSuggestions();return false;}
    if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();this.hideSuggestions();return true;}
    if (!state.choices.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();event.stopPropagation();this.markBooruSuggestion(state.index + (event.key === 'ArrowDown' ? 1 : -1));return true;
    }
    if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();event.stopPropagation();this.chooseBooruSuggestion(state.index);return true;
    }
    return false;
  };
  p.build = function (...args) {
    const result = old.build.apply(this,args);
    const input = this.queryInput;
    const keydown = input.onkeydown;
    input.onkeydown = event => {if (!this.handleBooruSuggestionKey(event)) keydown?.call(input,event);};
    input.addEventListener('click',() => {if (SOURCES.has(this.activeSourceId())) this.scheduleSuggestions(input.value);});
    input.addEventListener('keyup',event => {if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key) && SOURCES.has(this.activeSourceId())) this.scheduleSuggestions(input.value);});
    return result;
  };
  p.positionSuggestions = function () {
    old.positionSuggestions.call(this);
    if (!this.suggestions?.classList.contains('is-booru')) return;
    const rect = this.queryInput.getBoundingClientRect();
    const view = this.queryInput.ownerDocument.defaultView;
    const width = Math.min(Math.max(rect.width,260),Math.max(0,view.innerWidth-16));
    this.suggestions.style.left = Math.max(8,Math.min(rect.left,view.innerWidth-width-8)) + 'px';
    this.suggestions.style.width = width + 'px';
    const below = Math.max(0, view.innerHeight - rect.bottom - 12);
    const above = Math.max(0, rect.top - 12);
    const openAbove = below < 180 && above > below;
    this.suggestions.style.maxHeight = Math.max(0, Math.min(400, openAbove ? above : below)) + 'px';
    // Keep the body portal aligned with the screen-space input under canvas zoom.
    this.suggestions.style.top = Math.max(8, openAbove
      ? rect.top - this.suggestions.offsetHeight - 3 : rect.bottom + 3) + 'px';
  };
}
