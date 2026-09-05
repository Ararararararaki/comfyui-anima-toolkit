"""Regression checks for clothing-card clearing and category cascade deletion."""
from __future__ import annotations

from playwright.sync_api import sync_playwright


URL = "http://127.0.0.1:8188/extensions/ComfyUI-Anima-Batch-LoRA/app/index.html"
CATEGORY_ID = "__codex_clothing_delete_category__"
CARD_IDS = ["__codex_clothing_card_a__", "__codex_clothing_card_b__"]


def idb(page, action: str):
    return page.evaluate(
        """({ action, categoryId, cardIds }) => new Promise((resolve, reject) => {
          const request = indexedDB.open('clothing-db');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(['cards', 'categories'], 'readwrite');
            const cards = tx.objectStore('cards');
            const categories = tx.objectStore('categories');
            if (action === 'seed') {
              categories.put({ id: categoryId, name: 'Codex 测试分类', sortOrder: 999999 });
              for (const id of cardIds) cards.put({
                id, name: id, prompt: 'test outfit', categoryId, tags: ['test outfit'],
                favorite: false, useCount: 0, source: 'manual', createdAt: Date.now(), updatedAt: Date.now(),
              });
            } else if (action === 'read') {
              cards.getAll().onsuccess = (event) => {
                const all = event.target.result;
                resolve({
                  categoryExists: true,
                  cards: all.filter((card) => cardIds.includes(card.id)),
                });
              };
            } else if (action === 'cleanup') {
              categories.delete(categoryId);
              for (const id of cardIds) cards.delete(id);
            }
            tx.oncomplete = () => { db.close(); if (action !== 'read') resolve(true); };
            tx.onerror = () => reject(tx.error);
          };
        })""",
        {"action": action, "categoryId": CATEGORY_ID, "cardIds": CARD_IDS},
    )


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.locator('[data-section="clothing"]').click()
        page.wait_for_function("() => Boolean(window.__clothingDeleteCategory)", timeout=30000)
        assert page.locator("#clothingClearBtn").count() == 1
        idb(page, "seed")
        try:
            page.evaluate(
                """(id) => {
                  window.__codexDeleteDone = false;
                  window.__clothingDeleteCategory(id).then(
                    () => { window.__codexDeleteDone = true; },
                    (error) => { window.__codexDeleteError = String(error); }
                  );
                }""",
                CATEGORY_ID,
            )
            page.locator("#customConfirmModal.open").wait_for(timeout=3000)
            page.locator("#ccmConfirmBtn").click()
            page.wait_for_function("() => window.__codexDeleteDone === true", timeout=30000)
            result = idb(page, "read")
            assert not result["cards"], result
        finally:
            idb(page, "cleanup")
        browser.close()
    print("clothing library actions passed")


if __name__ == "__main__":
    main()
