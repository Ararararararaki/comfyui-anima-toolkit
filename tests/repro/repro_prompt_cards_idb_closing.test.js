// TK Prompt Cards IndexedDB 回归：缓存连接关闭后，重新读取不得复用失效连接。
const fs = require("fs");
const vm = require("vm");

const sourcePath = "E:/claude program/ComfyUI-Anima-Batch-LoRA/web/js/anima_prompt_cards_widget.js";
const source = fs.readFileSync(sourcePath, "utf8");

class FakeStore {
  getAll() {
    const request = {};
    setTimeout(() => request.onsuccess?.({ target: request }), 0);
    return request;
  }
  put() { return {}; }
  delete() { return {}; }
}

class FakeTransaction {
  objectStore() { return new FakeStore(); }
}

class FakeDatabase {
  constructor() {
    this.name = "anima-lora";
    this.closed = false;
    this.objectStoreNames = { contains: () => true };
  }
  createObjectStore() { return new FakeStore(); }
  transaction() {
    if (this.closed) {
      throw new DOMException("The database connection is closing.", "InvalidStateError");
    }
    return new FakeTransaction();
  }
  close() {
    this.closed = true;
    this.onclose?.({ target: this });
  }
}

const indexedDB = {
  open() {
    const request = {};
    setTimeout(() => {
      request.result = new FakeDatabase();
      request.onupgradeneeded?.({ target: request });
      request.onsuccess?.({ target: request });
    }, 0);
    return request;
  },
};

const sandbox = {
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { clipboard: { readText: async () => "" } },
  document: {
    currentScript: { src: "http://127.0.0.1:8188/extensions/ComfyUI-Anima-Batch-LoRA/js/anima_prompt_cards_widget.js" },
    createElement: () => ({ className: "", innerHTML: "", style: {}, appendChild() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll: () => [], setAttribute() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    querySelectorAll: () => [],
    getElementById: () => null,
  },
  setTimeout,
  clearTimeout,
  console,
  Promise,
  Date,
  JSON,
  Math,
  String,
  Array,
  Object,
  RegExp,
  Number,
  DOMException,
  encodeURIComponent,
  decodeURIComponent,
  indexedDB,
};
sandbox.window = sandbox;
sandbox.comfyAPI = { app: { app: { registerExtension: (extension) => { extension.setup?.(); } } } };
vm.createContext(sandbox);

// 仅为测试暴露闭包内的 DB seam，不修改生产文件。
const marker = "window.__tkCardsDebug.appendPromptBlock = appendPromptBlock;";
const instrumented = source.replace(
  marker,
  `${marker}\n        window.__tkCardsDebug.openDB = openDB;\n        window.__tkCardsDebug.storeAll = storeAll;`,
);
if (instrumented === source) throw new Error("debug export marker not found");
vm.runInContext(instrumented, sandbox);

(async () => {
  const debug = sandbox.window.__tkCardsDebug;
  const first = await debug.openDB();
  first.close();
  const second = await debug.openDB();
  if (first === second) {
    throw new Error("REGRESSION: openDB reused the closed anima-lora connection");
  }
  await debug.storeAll(second, "prompts");
  // 真实浏览器对手动 close() 不保证派发 close 事件，事务层也必须能自愈。
  second.onclose = null;
  second.close();
  await debug.storeAll(second, "prompts");
  console.log("PASS: closed IndexedDB connection is reopened before prompt reload");
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
