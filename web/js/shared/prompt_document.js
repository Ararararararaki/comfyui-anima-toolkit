// Prompt pieces and workflow v1 state. No host widgets, DOM, storage or callbacks belong here.
const STATE_VERSION = 1;
const pieceKey = text => String(text || '').replace(/\\([()])/g, '$1').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function parseToken(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const match = value.match(/^\((.+):([+-]?(?:\d+(?:\.\d*)?|\.\d+))\)$/);
  return match ? { text: match[1].trim(), weight: match[2] } : { text: value, weight: '' };
}

export function splitPromptPieces(text) {
  const source = String(text || ''), pieces = [];
  let tokenStart = 0, separatorBefore = '', i = 0;
  const push = raw => {
    const parsed = parseToken(raw);
    if (!parsed) return;
    pieces.push({ ...parsed, separatorBefore, hidden: false });
    separatorBefore = '';
  };
  while (i < source.length) {
    if (!/[、，,;；\r\n]/.test(source[i])) { i++; continue; }
    push(source.slice(tokenStart, i));
    const separatorStart = i++;
    while (i < source.length && /[ \t\r\n]/.test(source[i])) i++;
    separatorBefore += source.slice(separatorStart, i);
    tokenStart = i;
  }
  push(source.slice(tokenStart));
  if (separatorBefore && pieces.length) pieces[pieces.length - 1].trailingSeparator = separatorBefore;
  return pieces;
}

export function splitTags(text) {
  return splitPromptPieces(text).map(({ text, weight }) => ({ text, weight }));
}

export function formatWeightedPromptText(text, weight) {
  const value = String(text || '').trim(), rawWeight = String(weight ?? '').trim();
  if (!value) return '';
  if (!rawWeight) return value;
  const numericWeight = Number(rawWeight);
  if (Number.isFinite(numericWeight) && Math.abs(numericWeight - 1) < 1e-9) return value;
  return `(${value}:${rawWeight})`;
}

export function serializePromptPieces(parts) {
  const visible = (parts || []).filter(piece => piece && !piece.hidden && formatWeightedPromptText(piece.text, piece.weight));
  const body = visible.map((piece, index) => (index ? (typeof piece.separatorBefore === 'string' && piece.separatorBefore ? piece.separatorBefore : ', ') : '') + formatWeightedPromptText(piece.text, piece.weight)).join('');
  return body + (visible.length ? String(visible[visible.length - 1].trailingSeparator || '') : '');
}

export function ensureTrailingSeparator(pieces, separator = ', ') {
  const visible = (pieces || []).filter(piece => piece && !piece.hidden);
  const last = visible.at(-1);
  if (!last || /[,，、;；]|\r?\n/.test(String(last.trailingSeparator || ''))) return false;
  last.trailingSeparator = separator;
  return true;
}

function normalizePiece(piece, index = 0) {
  if (!piece || typeof piece !== 'object') return null;
  const text = String(piece.text || '').trim();
  if (!text) return null;
  return { text, weight: String(piece.weight ?? '').trim(), hidden: Boolean(piece.hidden),
    separatorBefore: typeof piece.separatorBefore === 'string' ? piece.separatorBefore : (index ? ', ' : ''),
    trailingSeparator: typeof piece.trailingSeparator === 'string' ? piece.trailingSeparator : '' };
}

function parseState(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const source = Array.isArray(parsed) ? parsed : parsed?.pieces;
    if (!Array.isArray(source)) return null;
    const pieces = source.map(normalizePiece).filter(Boolean);
    if (!pieces.length && source.length) return null;
    return { pieces, visibleText: String(typeof parsed?.visibleText === 'string' ? parsed.visibleText : serializePromptPieces(pieces)).trim() };
  } catch { return null; }
}

export function escapeAnimaBrackets(text) {
  return String(text || '').replace(/\\([()])/g, '$1').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function cardToText(card, { escapeBrackets = true } = {}) {
  const text = String(card.prompt || card.en || '').trim();
  return formatWeightedPromptText(escapeBrackets ? escapeAnimaBrackets(text) : text, card.weight);
}

export function appendCardToPrompt(cur, card, separator = ', ', options) {
  const piece = cardToText(card, options);
  if (!piece) return cur;
  const existing = splitTags(cur).map(row => row.text.toLowerCase().trim());
  if (existing.includes(String(card.prompt || card.en || '').toLowerCase().trim())) return cur;
  const current = String(cur || '').replace(/[ \t]+$/, '');
  if (/\r?\n\s*$/.test(current)) return current + piece;
  const compact = current.replace(/,\s*$/, '');
  return compact ? compact + separator + piece : piece;
}

export function appendPromptBlock(cur, block) {
  const current = String(cur || '').replace(/\s+$/, ''), addition = String(block || '').trim();
  if (!addition) return current;
  if (!current) return addition;
  if (current === addition || current.endsWith(`\n\n${addition}`)) return current;
  return `${current}\n\n${addition}`;
}

export class PromptDocument {
  #text;
  #pieces;
  #restored;
  #stateMismatch;
  constructor(visibleText = '') {
    this.#text = String(visibleText || '');
    this.#pieces = splitPromptPieces(this.#text);
    this.#restored = false;
    this.#stateMismatch = false;
  }

  restore(raw, hostText = '') {
    const state = parseState(raw);
    this.#text = String(hostText || '');
    this.#stateMismatch = Boolean(state && state.visibleText !== this.#text.trim());
    this.#restored = Boolean(state && !this.#stateMismatch);
    this.#pieces = this.#restored ? state.pieces : splitPromptPieces(this.#text);
    return this.snapshot();
  }

  _editText(text, preserveHidden) {
    const next = splitPromptPieces(text);
    if (preserveHidden) {
      const used = new Set();
      const hidden = this.#pieces.filter(piece => piece.hidden).filter(piece => {
        const index = next.findIndex((candidate, i) => !used.has(i) && pieceKey(candidate.text) === pieceKey(piece.text));
        if (index < 0) return true;
        used.add(index); return false;
      });
      next.push(...hidden);
    }
    this.#pieces = next;
    this.#text = String(text || '');
  }

  apply(change) {
    const piece = this.#pieces[change.index];
    switch (change.type) {
      case 'sync': this._editText(change.text, true); return this.snapshot();
      case 'setText': this._editText(change.text, Boolean(change.preserveHidden)); break;
      case 'toggle': if (piece) piece.hidden = !piece.hidden; break;
      case 'remove': if (piece) this.#pieces.splice(change.index, 1); break;
      case 'weight': if (piece) piece.weight = String(change.weight ?? '').trim(); break;
      case 'replace': {
        const text = String(change.text || '').trim();
        if (piece && text) { piece.text = text; if (text.includes(',')) piece.weight = ''; }
        break;
      }
      case 'trailingSeparator': ensureTrailingSeparator(this.#pieces, change.separator); break;
      case 'appendBlock': {
        const next = appendPromptBlock(this.#text, change.text);
        if (next !== this.#text) this._editText(next, true);
        return this.snapshot();
      }
      case 'appendCard': this._editText(appendCardToPrompt(this.#text, change.card, change.separator, change.options), true); break;
      case 'append': {
        const additions = splitPromptPieces(change.text), seen = new Set(this.#pieces.map(row => row.text.toLowerCase().trim()));
        const firstSeparator = this.#pieces.length ? (/\r?\n\s*$/.test(this.#text) ? '' : ', ') : '';
        let count = 0;
        for (const addition of additions) {
          const key = addition.text.toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          this.#pieces.push({ ...addition, separatorBefore: count === 0 ? firstSeparator : addition.separatorBefore });
          seen.add(key); count++;
        }
        if (count) ensureTrailingSeparator(this.#pieces);
        break;
      }
      case 'commit': break;
      default: throw new Error(`Unknown prompt change: ${change.type}`);
    }
    this.#text = serializePromptPieces(this.#pieces);
    return this.snapshot();
  }

  snapshot() {
    const pieces = this.#pieces.map(normalizePiece).filter(Boolean);
    return { visibleText: this.#text, pieces, restored: this.#restored, stateMismatch: this.#stateMismatch,
      serializedState: JSON.stringify({ version: STATE_VERSION, visibleText: this.#text.trim(), pieces }) };
  }
}
