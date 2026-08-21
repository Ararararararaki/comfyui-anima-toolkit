// TK Prompt Cards 前端纯逻辑测试：在 node vm 中执行 IIFE，验证 splitTags / appendCardToPrompt / removePiece / langOf
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('E:/claude program/ComfyUI-Anima-Batch-LoRA/web/js/anima_prompt_cards_widget.js', 'utf-8');

// 最小浏览器环境
const sandbox = {
  window: {},
  document: {
    currentScript: { src: 'http://127.0.0.1:8188/extensions/ComfyUI-Anima-Batch-LoRA/js/anima_prompt_cards_widget.js' },
    createElement: () => ({ className: '', innerHTML: '', style: {}, appendChild() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll: () => [], setAttribute() {}, }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    querySelectorAll: () => [],
    getElementById: () => null,
  },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { clipboard: { readText: async () => '' } },
  setTimeout, clearTimeout, console, Promise, Date, JSON, Math, String, Array, Object, RegExp, Number, encodeURIComponent, decodeURIComponent,
};
sandbox.window = sandbox;
sandbox.comfyAPI = { app: { app: { registerExtension: (ext) => { if (typeof ext.setup === 'function') ext.setup(); } } } };
vm.createContext(sandbox);
vm.runInContext('window.comfyAPI = comfyAPI; window.__d = 1;', sandbox);
vm.runInContext(src, sandbox);
console.log('debug export check:', !!sandbox.window.__tkCardsDebug, !!sandbox.window.comfyAPI);

const dbg = sandbox.window.__tkCardsDebug;
if (!dbg || !dbg.splitTags) { console.error('FAIL: __tkCardsDebug.splitTags 未导出'); process.exit(1); }

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n    got: ${a}\n    exp: ${e}`); }
}

// ── splitTags ──
eq('中文顿号拆分', dbg.splitTags('单身, 白色过膝袜、绝对领域'), [{text:'单身',weight:''},{text:'白色过膝袜',weight:''},{text:'绝对领域',weight:''}]);
eq('英文逗号拆分', dbg.splitTags('masterpiece, best quality, 1girl'), [
  {text:'masterpiece',weight:''},{text:'best quality',weight:''},{text:'1girl',weight:''}]);
eq('长句不拆（>60 且含逗号）', (() => { const long = 'A cinematic wide-format anime illustration of an elegant silver-haired young woman crouching beside a long, shallow reflecting pool in a vast futuristic public plaza, viewed in profile.'; const r = dbg.splitTags(long); return r.length === 1 && r[0].text === long; })(), true);
eq('权重括号', dbg.splitTags('(long hair:1.2), solo'), [{text:'long hair',weight:'1.2'},{text:'solo',weight:''}]);
eq('换行拆分', dbg.splitTags('1girl\nsolo focus'), [{text:'1girl',weight:''},{text:'solo focus',weight:''}]);
eq('空输入', dbg.splitTags(''), []);

// ── appendCardToPrompt（智能去重）──
// 内层函数未从 IIFE 导出，此处复制等价实现测试（与源文件保持一致）；如需改逻辑请同步这里
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
function langOf(text) { const t = String(text||''); if(!t) return 'en'; let c=0; for(const ch of t) if(CJK_RE.test(ch)) c++; return c/t.length>0.3?'zh':'en'; }
function splitTags2(text) {
  const out = [];
  for (let rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim(); if (!line) continue;
    const cnParts = line.split(/[、，;；]/).map((s)=>s.trim()).filter(Boolean);
    for (let part of cnParts) {
      if (part.length > 60 && part.includes(',')) { out.push({text:part, weight:''}); continue; }
      const enParts = part.split(',').map((s)=>s.trim()).filter(Boolean);
      for (let p of enParts) {
        const m = p.match(/^\((.+):([0-9.]+)\)$/);
        if (m) { out.push({text:m[1].trim(), weight:m[2]}); continue; }
        out.push({text:p, weight:''});
      }
    }
  }
  return out;
}
function cardToText(c) { const en=String(c.en||'').trim(); if(!en) return ''; const w=String(c.weight||'').trim(); return w?`(${en}:${w})`:en; }
function appendCardToPrompt(cur, c, sep=', ') {
  const piece = cardToText(c); if (!piece) return cur;
  const analyst = splitTags2(cur).map(p=>p.text.toLowerCase().trim());
  const base = (c.en||'').toLowerCase().trim();
  if (analyst.includes(base)) return cur;
  const curT = String(cur||'').replace(/[,\s]+$/,'');
  return curT ? curT + sep + piece : piece;
}
function removePiece(cur, piece) {
  const target=(piece.text||'').trim();
  const parts = splitTags2(cur);
  const keep=[]; let removed=false;
  for (const p of parts) { if(!removed && p.text.trim()===target){removed=true;continue;} keep.push(p); }
  if(!removed) return cur;
  return keep.map(p=>p.weight?`(${p.text}:${p.weight})`:p.text).join(', ');
}

eq('追加到空', appendCardToPrompt('', {en:'long hair', weight:''}), 'long hair');
eq('追加到已有', appendCardToPrompt('1girl, solo', {en:'long hair', weight:'1.2'}), '1girl, solo, (long hair:1.2)');
eq('去重（已有相同 tag）', appendCardToPrompt('1girl, long hair', {en:'long hair', weight:''}), '1girl, long hair');
eq('去重（权重不同也算重复）', appendCardToPrompt('(long hair:1.2)', {en:'long hair', weight:'0.8'}), '(long hair:1.2)');
eq('尾部逗号规范化', appendCardToPrompt('1girl, ', {en:'solo'}), '1girl, solo');
eq('多卡连续追加', appendCardToPrompt(appendCardToPrompt('', {en:'a', weight:''}), {en:'b', weight:''}), 'a, b');

eq('removePiece 删除片段', removePiece('1girl, solo, long hair', {text:'solo'}), '1girl, long hair');
eq('removePiece 带权重', removePiece('1girl, (long hair:1.2)', {text:'long hair'}), '1girl');
eq('removePiece 未命中原样', removePiece('1girl', {text:'nope'}), '1girl');

eq('langOf 中文', langOf('金发双马尾少女'), 'zh');
eq('langOf 英文', langOf('1girl, long hair'), 'en');
eq('langOf 混合偏中', langOf('金发双马尾少女, solo focus'), 'zh');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);