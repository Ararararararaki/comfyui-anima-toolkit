import { uiText } from "./anima_node_i18n.js";
// Website-style tag completion for the three native booru search sources.
const SOURCES = new Set(['safebooru', 'yandere', 'konachan']);
const LABELS = { safebooru: 'Safebooru', yandere: 'yande.re', konachan: 'Konachan.net' };
const TYPES = { general: uiText('通用', "General"), artist: uiText('画师', "Artist"), copyright: uiText('作品', 'Series'), character: uiText('角色', "Character"), circle: uiText('社团', "Circle"), style: uiText('风格', "Style"), faults: uiText('标记', "Flags"), tag: uiText('标签', "Tag"), syntax: uiText('语法', "Syntax") };

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
    ['rating:safe', uiText('全年龄', "Safe")], ['rating:questionable', uiText('存疑分级', "Questionable")], ['rating:explicit', uiText('成人分级', "Explicit")],
    ['width:>=1920', uiText('宽度至少 1920', "Width at least 1920")], ['height:>=1080', uiText('高度至少 1080', "Height at least 1080")], ['score:>=10', uiText('评分至少 10', "Score at least 10")],
  ];
  const sorts = source === 'safebooru' ? [['sort:score:desc', uiText('评分从高到低', "Highest score first")], ['sort:id:desc', uiText('最新优先', "Newest first")]]
    : [['order:score', uiText('评分从高到低', "Highest score first")], ['order:id', uiText('最新优先', "Newest first")]];
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
    if (this._queryComposing) {this.hideSuggestions();return;}
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
        this.renderBooruSuggestions(state, uiText('标签联想暂不可用，可直接回车搜索', "Suggestions are unavailable. Press Enter to search."));
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
    box.setAttribute('aria-label',LABELS[state.source] + uiText(' 标签联想', " tag suggestions"));
    const input = this.queryInput;
    input.setAttribute('role','combobox');
    input.setAttribute('aria-autocomplete','list');
    input.setAttribute('aria-controls',box.id);
    input.setAttribute('aria-expanded','true');
    const title = doc.createElement('div');
    title.className = 'adg-booru-heading';
    title.textContent = LABELS[state.source] + uiText(' · 标签联想', " · Tag suggestions");
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
      kind.textContent = item.note || TYPES[item.category] || uiText('标签', "Tag");
      const count = doc.createElement('span'); count.className = 'adg-booru-count';
      count.textContent = item.postCount == null ? '' : Number(item.postCount).toLocaleString();
      count.title = LABELS[state.source] + uiText(' 标签数量（官网接口，非 D站 数量）', " post count (official API, not Danbooru)");
      const main = doc.createElement('span'); main.className = 'adg-suggestion-main'; main.append(tag,count);
      const secondary = doc.createElement('span'); secondary.className = 'adg-suggestion-secondary'; secondary.append(kind);
      row.append(main,secondary);
      row.onpointerdown = row.onmousedown = event => { event.preventDefault(); event.stopPropagation(); };
      row.onclick = event => {event.stopPropagation();this.chooseBooruSuggestion(index);};
      row.onpointerenter = () => this.markBooruSuggestion(index);
      box.append(row);
    }
    const hint = doc.createElement('div'); hint.className = 'adg-booru-hint';
    hint.textContent = warning || (state.choices.length ? uiText('↑↓ 选择 · Tab / Enter 补全 · 再按 Enter 搜索', "↑↓ select · Tab / Enter complete · Enter again to search")
      : uiText('暂无标签联想，可直接回车搜索', "No suggestions. Press Enter to search."));
    box.append(hint);
    const syntax = doc.createElement('div'); syntax.className = 'adg-booru-hint';
    syntax.textContent = uiText('空格组合标签 · -标签 排除 · * 通配 · rating: 分级', "Space combines tags · -tag excludes · * wildcard · rating: rating");
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
    if (!input || this._tagSearchInput === input) return result;
    this._tagSearchInput = input;
    const keydown = input.onkeydown;
    input.onkeydown = event => {
      if (this._queryComposing || event.isComposing || event.keyCode === 229) return;
      if (!this.handleBooruSuggestionKey(event)) keydown?.call(input,event);
    };
    input.addEventListener('compositionstart',() => {this._queryComposing=true;this.hideSuggestions();});
    input.addEventListener('compositionend',() => {this._queryComposing=false;this.scheduleSuggestions(input.value);});
    input.addEventListener('click',() => this.scheduleSuggestions(input.value));
    input.addEventListener('keyup',event => {if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) this.scheduleSuggestions(input.value);});
    return result;
  };
  p.positionSuggestions = function () {
    old.positionSuggestions.call(this);
  };}
