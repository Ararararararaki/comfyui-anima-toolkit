// TK Prompt Cards 前端纯逻辑测试（vm 执行 IIFE 后调用导出的调试函数）
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('E:/claude program/ComfyUI-Anima-Batch-LoRA/web/js/anima_prompt_cards_widget.js', 'utf-8');

const sandbox = {
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { clipboard: { readText: async () => '' } },
  document: {
    currentScript: { src: 'http://127.0.0.1:8188/extensions/ComfyUI-Anima-Batch-LoRA/js/anima_prompt_cards_widget.js' },
    createElement: () => ({ className: '', innerHTML: '', style: {}, appendChild() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll: () => [], setAttribute() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    querySelectorAll: () => [],
    getElementById: () => null,
  },
  setTimeout, clearTimeout, console, Promise, Date, JSON, Math, String, Array, Object, RegExp, Number, encodeURIComponent, decodeURIComponent, indexedDB: undefined,
};
sandbox.window = sandbox;
sandbox.comfyAPI = { app: { app: { registerExtension: (ext) => { if (typeof ext.setup === 'function') ext.setup(); } } } };
vm.createContext(sandbox);
vm.runInContext('window.comfyAPI = comfyAPI;', sandbox);
vm.runInContext(src, sandbox);

const dbg = sandbox.window.__tkCardsDebug;
if (!dbg || !dbg.splitTags) { console.error('FAIL: debug exports missing'); process.exit(1); }

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}\n    got: ${a}\n    exp: ${e}`); }
}

eq('中文顿号拆分', dbg.splitTags('单身, 白色过膝袜、绝对领域'), [{text:'单身',weight:''},{text:'白色过膝袜',weight:''},{text:'绝对领域',weight:''}]);
eq('英文逗号拆分', dbg.splitTags('masterpiece, best quality, 1girl'), [
  {text:'masterpiece',weight:''},{text:'best quality',weight:''},{text:'1girl',weight:''}]);
eq('长句也全拆（用户要求所有逗号都分割）', (() => {
  const long = 'A cinematic illustration of a girl, long hair, blue eyes, in a park';
  const r = dbg.splitTags(long);
  return r.length === 4 && r[0].text === 'A cinematic illustration of a girl';
})(), true);
eq('权重括号', dbg.splitTags('(long hair:1.2), solo'), [{text:'long hair',weight:'1.2'},{text:'solo',weight:''}]);
eq('换行拆分', dbg.splitTags('1girl\nsolo focus'), [{text:'1girl',weight:''},{text:'solo focus',weight:''}]);
eq('空输入', dbg.splitTags(''), []);

// appendCardToPrompt（智能去重）—— 卡片对象用 PromptEntry 结构 {prompt, weight}
eq('追加到空', dbg.appendCardToPrompt('', {prompt:'long hair', weight:''}), 'long hair');
eq('追加到已有', dbg.appendCardToPrompt('1girl, solo', {prompt:'long hair', weight:'1.2'}), '1girl, solo, (long hair:1.2)');
eq('去重', dbg.appendCardToPrompt('1girl, long hair', {prompt:'long hair', weight:''}), '1girl, long hair');
eq('权重不同算重复', dbg.appendCardToPrompt('(long hair:1.2)', {prompt:'long hair', weight:'0.8'}), '(long hair:1.2)');
eq('尾部逗号规范化', dbg.appendCardToPrompt('1girl, ', {prompt:'solo'}), '1girl, solo');
eq('多卡连续追加', dbg.appendCardToPrompt(dbg.appendCardToPrompt('', {prompt:'a'}), {prompt:'b'}), 'a, b');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);