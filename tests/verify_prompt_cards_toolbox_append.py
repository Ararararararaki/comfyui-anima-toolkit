"""真实 ComfyUI 回归：①区工具箱 prompt 条目点击后应追加到②区末尾。"""
from __future__ import annotations

import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BASE = "http://127.0.0.1:8188"


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


def put_prompt(page, record: dict) -> None:
    page.evaluate(
        """
        async (record) => {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('anima-lora');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          await new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readwrite');
            tx.objectStore('prompts').put(record);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
          db.close();
        }
        """,
        record,
    )


with tempfile.TemporaryDirectory(prefix="tk-cards-toolbox-append-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(CHROME),
            headless=True,
            viewport={"width": 1600, "height": 1000},
            args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(3_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TKPromptCards');
              if (!node) return null;
              window.app.graph.add(node);
              return node.type;
            }
            """
        )
        check("TK Prompt Cards 节点创建", created == "TKPromptCards", created)
        page.wait_for_selector(".tk-cards-ui", timeout=15_000)
        page.evaluate(
            "() => { const el = document.getElementById('comfyui-body-bottom'); if (el) el.style.display='none'; document.querySelectorAll('.pysssss-image-feed').forEach(x => x.style.display='none'); }"
        )

        record = {
            "id": "__regression_toolbox_append__",
            "prompt": "toolbox prompt block",
            "displayText": "回归：工具箱追加",
            "notes": "",
            "tags": [],
            "images": [],
            "primaryImage": "",
            "categoryId": "uncategorized",
            "isFavorite": False,
            "kind": "prompt",
            "createdAt": 9_999_999_999_999,
            "updatedAt": 9_999_999_999_999,
        }
        put_prompt(page, record)
        page.evaluate("() => [...document.querySelectorAll('button')].find(x => x.textContent.includes('重新读取'))?.click()")
        item = page.locator('.tk-cards-lib-item').filter(has_text="回归：工具箱追加")
        item.wait_for(timeout=15_000)
        textarea = page.locator(".tk-cards-textarea").first
        textarea.fill("portrait, white hair")
        page.wait_for_timeout(250)
        item.evaluate("el => el.click()")
        page.wait_for_timeout(500)
        result = textarea.input_value()
        check("工具箱条目追加而非覆盖", result == "portrait, white hair\n\ntoolbox prompt block", result)
        check("追加使用两次换行", "white hair\n\ntoolbox" in result, repr(result))
        check("页面无 JS 异常", not page_errors, page_errors[:5])
        print("ALL PASS")
        context.close()
