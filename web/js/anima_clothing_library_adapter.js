// Thin browser-side adapter for the existing TK Toolkit clothing library.
//
// The panel uses Dexie, but ComfyUI node extensions are standalone modules and
// must not bundle the whole panel.  This adapter intentionally mirrors only
// the stable IndexedDB contract: database ``clothing-db`` and stores
// ``cards``/``categories``.  It never creates a second source of truth.

const DB_NAME = "clothing-db";
const CARD_STORE = "cards";
const CATEGORY_STORE = "categories";

let dbPromise = null;

const asText = (value) => String(value ?? "").trim();

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function ensureCardIndexes(store) {
  const indexes = [
    ["categoryId", "categoryId"],
    ["favorite", "favorite"],
    ["source", "source"],
    ["createdAt", "createdAt"],
  ];
  indexes.forEach(([name, keyPath]) => {
    if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
  });
  if (!store.indexNames.contains("tags")) store.createIndex("tags", "tags", { unique: false, multiEntry: true });
}

function openLibrary() {
  if (dbPromise) return dbPromise;
  if (!window.indexedDB) return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
  dbPromise = new Promise((resolve, reject) => {
    // Do not force a version when opening the user's existing database.  The
    // panel currently owns version 2; forcing an upgrade here could race with
    // a future panel migration.  A fresh database gets the compatible shape.
    const request = window.indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      const db = request.result;
      let cards;
      if (db.objectStoreNames.contains(CARD_STORE)) {
        cards = request.transaction.objectStore(CARD_STORE);
      } else {
        cards = db.createObjectStore(CARD_STORE, { keyPath: "id" });
      }
      ensureCardIndexes(cards);
      if (!db.objectStoreNames.contains(CATEGORY_STORE)) {
        const categories = db.createObjectStore(CATEGORY_STORE, { keyPath: "id" });
        categories.createIndex("name", "name", { unique: false });
        categories.createIndex("sortOrder", "sortOrder", { unique: false });
      } else {
        const categories = request.transaction.objectStore(CATEGORY_STORE);
        if (!categories.indexNames.contains("name")) categories.createIndex("name", "name", { unique: false });
        if (!categories.indexNames.contains("sortOrder")) categories.createIndex("sortOrder", "sortOrder", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CARD_STORE) || !db.objectStoreNames.contains(CATEGORY_STORE)) {
        db.close();
        reject(new Error("服装库数据库结构不完整，请先打开 TK Toolkit 服装库初始化"));
        return;
      }
      db.onversionchange = () => {
        db.close();
        // A closed connection must never be returned by the cached promise.
        // The next node request will open a fresh connection after the panel migration.
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("无法打开 TK Toolkit 服装库"));
    request.onblocked = () => reject(new Error("服装库正在被其他页面升级，请关闭旧的工具箱标签后重试"));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function storeRequest(storeName, mode, callback) {
  return openLibrary().then((db) => new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(storeName, mode);
      const request = callback(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    } catch (error) {
      reject(error);
    }
  }));
}

function toCardSnapshot(card, categoryMap) {
  if (!card || typeof card !== "object") return null;
  const prompt = asText(card.prompt);
  if (!prompt) return null;
  const categoryId = asText(card.categoryId);
  const imageUrl = asText(card.imageUrl);
  return {
    id: asText(card.id),
    name: asText(card.name) || prompt.slice(0, 20),
    prompt,
    categoryId,
    categoryName: categoryMap?.get(categoryId) || (categoryId === "uncategorized" ? "未分类" : "未分类"),
    tags: Array.isArray(card.tags) ? card.tags.map(asText).filter(Boolean) : [],
    favorite: card.favorite === true,
    useCount: Number(card.useCount) || 0,
    createdAt: Number(card.createdAt) || 0,
    hasImage: Boolean(card.imageBlob || imageUrl),
    imageUrl,
  };
}

async function readAll(storeName) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      if (typeof store.getAll === "function") {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
        return;
      }
      const values = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          values.push(cursor.value);
          cursor.continue();
        } else {
          resolve(values);
        }
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB cursor failed"));
    } catch (error) {
      reject(error);
    }
  });
}

export async function getClothingCategories() {
  const categories = await readAll(CATEGORY_STORE);
  return categories
    .filter((category) => category && asText(category.id))
    .map((category) => ({ id: asText(category.id), name: asText(category.name) || "未分类", sortOrder: Number(category.sortOrder) || 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "zh"));
}

export async function getClothingCards({ categoryId = "", favorite = false, keyword = "" } = {}) {
  const [records, categories] = await Promise.all([readAll(CARD_STORE), getClothingCategories()]);
  const categoryMap = new Map(categories.map((category) => [category.id, category.name]));
  const tokens = asText(keyword).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return records
    .map((card) => toCardSnapshot(card, categoryMap))
    .filter(Boolean)
    .filter((card) => {
      if (favorite && !card.favorite) return false;
      if (categoryId && card.categoryId !== categoryId) return false;
      if (!tokens.length) return true;
      const haystack = [card.name, card.prompt, card.categoryName, ...card.tags].join(" ").toLocaleLowerCase();
      return tokens.every((token) => haystack.includes(token));
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name, "zh"));
}

export async function getClothingCard(id) {
  const record = await storeRequest(CARD_STORE, "readonly", (store) => store.get(id));
  return record || null;
}

export async function getClothingCardPreview(id) {
  const record = await getClothingCard(id);
  if (!record) return null;
  if (record.imageBlob instanceof Blob) {
    return { url: URL.createObjectURL(record.imageBlob), revoke: true };
  }
  const imageUrl = asText(record.imageUrl);
  return imageUrl ? { url: imageUrl, revoke: false } : null;
}

export async function renameClothingCard(id, name) {
  const cleanName = asText(name);
  if (!cleanName) throw new Error("服装名称不能为空");
  const record = await getClothingCard(id);
  if (!record) throw new Error("服装卡片不存在，可能已被工具箱删除");
  record.name = cleanName;
  record.updatedAt = Date.now();
  await storeRequest(CARD_STORE, "readwrite", (store) => store.put(record));
  return record;
}

export function makeSelectionCard(card, categoryName) {
  if (!card) return null;
  return {
    id: asText(card.id),
    name: asText(card.name),
    prompt: asText(card.prompt),
    categoryId: asText(card.categoryId),
    categoryName: asText(categoryName) || asText(card.categoryName) || "未分类",
    imageUrl: asText(card.imageUrl),
    hasImage: card.hasImage !== undefined ? Boolean(card.hasImage) : Boolean(card.imageBlob || card.imageUrl),
  };
}

export function stablePick(cards, seed) {
  const ordered = [...(cards || [])].sort((a, b) => asText(a.id).localeCompare(asText(b.id)) || asText(a.name).localeCompare(asText(b.name), "zh"));
  if (!ordered.length) return null;
  // Keep the browser preview in lockstep with the Python node's seeded
  // selection without depending on Math.random or browser-specific RNG.
  let value = (Number(seed) >>> 0) || 0;
  value = (value ^ 0x9e3779b9) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return ordered[value % ordered.length];
}

export function libraryErrorMessage(error) {
  const message = asText(error?.message || error);
  if (/IndexedDB|数据库|服装库/.test(message)) return `${message}。请确认 TK Toolkit 与 ComfyUI 使用同一个浏览器地址和端口。`;
  return message || "无法读取 TK Toolkit 服装库";
}
