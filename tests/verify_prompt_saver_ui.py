"""真实 ComfyUI 页面检查 TK Prompt Saver 的自动保存链路。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
SCREENSHOT = Path(r"C:\Users\Toki\AppData\Local\Temp\tk-prompt-saver-after.png")


with sync_playwright() as playwright:
    profile = tempfile.TemporaryDirectory(prefix="tk-prompt-saver-ui-")
    context = playwright.chromium.launch_persistent_context(
        profile.name,
        executable_path=str(CHROME),
        headless=True,
        viewport={"width": 1440, "height": 900},
        args=["--no-first-run", "--disable-gpu"],
    )
    page = context.pages[0] if context.pages else context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(f"console.{message.type}: {message.text}") if message.type == "error" else None)
    page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
    page.wait_for_timeout(3_000)
    errors.clear()

    created = page.evaluate(
        """
        () => {
          window.app.graph.clear();
          const node = LiteGraph.createNode('AnimaTKPromptSaver');
          if (!node) return null;
          window.app.graph.add(node);
          node.pos = [80, 100];
          window.__tkPromptSaver = node;
          return node.type;
        }
        """
    )
    if created != "AnimaTKPromptSaver":
        raise AssertionError(f"node create failed: {created}")
    page.wait_for_selector(".tk-ps-panel", timeout=15_000)
    state = page.evaluate(
        """
        () => {
          const panel = document.querySelector('.tk-ps-panel');
          return {
            rows: panel?.querySelectorAll('.tk-ps-row').length || 0,
            hasCategory: Boolean(panel?.querySelector('.tk-ps-category')),
            hasSaveButton: [...(panel?.querySelectorAll('button') || [])].some(button => (button.textContent || '').includes('保存')),
            mode: panel?.querySelector('.tk-ps-mode')?.value || '',
            nodeSize: window.__tkPromptSaver?.size || null,
          };
        }
        """
    )
    print(json.dumps(state, ensure_ascii=False))
    if state["rows"] != 6 or not state["hasCategory"] or state["hasSaveButton"] or state["mode"] != "single":
        raise AssertionError(f"unexpected prompt saver UI: {state}")

    page.locator(".tk-ps-name").nth(0).fill("主提示")
    page.locator(".tk-ps-mode").select_option("multi")
    page.locator(".tk-ps-control").nth(1).check()
    page.locator(".tk-ps-control").nth(3).check()
    page.evaluate(
        """
        () => {
          const api = window.comfyAPI?.api?.api || window.api;
          window.__promptSaverExecutedEvents = [];
          api.addEventListener('executed', event => window.__promptSaverExecutedEvents.push(event.detail));
        }
        """
    )
    queued = page.evaluate(
        """
        async () => {
          const node = window.__tkPromptSaver;
          const settings = JSON.stringify({
            mode: 'multi',
            enabled: [true, true, false, true, false, false],
            selected: 0,
            names: ['主提示', '提示词 2', '3', '提示词 4', '5', '6'],
          });
          const response = await fetch('/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: (window.comfyAPI?.api?.api || window.api)?.clientId || window.app?.clientId || null,
              prompt: {
                [String(node.id)]: {
                  class_type: 'AnimaTKPromptSaver',
                  inputs: {
                    separator: '逗号 ,',
                    router_settings: settings,
                    prompt_category: 'uncategorized',
                    prompt_1: 'first prompt',
                    prompt_2: 'second prompt',
                    prompt_4: 'fourth prompt',
                  },
                },
              },
            }),
          });
          return { status: response.status, body: await response.text() };
        }
        """
    )
    if queued["status"] != 200:
        raise AssertionError(f"real ComfyUI queue failed: {queued}")
    try:
        page.wait_for_function("() => document.querySelector('.tk-ps-status')?.textContent === '已自动保存 3 条'", timeout=15_000)
    except Exception:
        debug = page.evaluate(
            """
            () => ({
              status: document.querySelector('.tk-ps-status')?.textContent || '',
              events: window.__promptSaverExecutedEvents || [],
              api: {
                hasComfyApi: Boolean(window.comfyAPI?.api?.api),
                hasWindowApi: Boolean(window.api),
              },
            })
            """
        )
        print(json.dumps(debug, ensure_ascii=False))
        raise
    page.wait_for_function(
        """
        () => new Promise(resolve => {
          const request = indexedDB.open('anima-lora');
          request.onsuccess = () => {
            const tx = request.result.transaction('prompts', 'readonly');
            const get = tx.objectStore('prompts').getAll();
            get.onsuccess = () => resolve(get.result.some(item => item.source === 'tk-prompt-saver' && item.prompt === 'fourth prompt'));
            get.onerror = () => resolve(false);
          };
          request.onerror = () => resolve(false);
        })
        """,
        timeout=15_000,
    )
    saved = page.evaluate(
        """
        () => new Promise(resolve => {
          const request = indexedDB.open('anima-lora');
          request.onsuccess = () => {
            const tx = request.result.transaction('prompts', 'readonly');
            const get = tx.objectStore('prompts').getAll();
            get.onsuccess = () => resolve(get.result.filter(item => item.source === 'tk-prompt-saver').map(item => ({ prompt: item.prompt, displayText: item.displayText, sourceInput: item.sourceInput })));
            get.onerror = () => resolve([]);
          };
          request.onerror = () => resolve([]);
        })
        """
    )
    print(json.dumps(saved, ensure_ascii=False))
    if {item["prompt"] for item in saved} != {"first prompt", "second prompt", "fourth prompt"}:
        raise AssertionError(f"automatic prompt library save failed: {saved}")
    page.evaluate(
        """
        () => {
          const node = window.__tkPromptSaver;
          const api = window.comfyAPI?.api?.api || window.api;
          api.dispatchEvent(new CustomEvent('executed', { detail: {
            node: String(node.id),
            output: { prompt_saver: [{
              prompt: 'preview prompt',
              displayText: '预览测试',
              categoryId: 'uncategorized',
              sourceInput: 'prompt_6',
              previewImage: 'data:image/png;base64,test-preview',
            }] }
          }}));
        }
        """
    )
    page.wait_for_function(
        """
        () => new Promise(resolve => {
          const request = indexedDB.open('anima-lora');
          request.onsuccess = () => {
            const tx = request.result.transaction('prompts', 'readonly');
            const get = tx.objectStore('prompts').getAll();
            get.onsuccess = () => resolve(get.result.some(item => item.prompt === 'preview prompt' && item.images?.[0] === 'data:image/png;base64,test-preview'));
            get.onerror = () => resolve(false);
          };
          request.onerror = () => resolve(false);
        })
        """,
        timeout=15_000,
    )
    page.screenshot(path=str(SCREENSHOT))
    print(f"SCREENSHOT {SCREENSHOT}")
    if errors:
        raise AssertionError(f"new node interaction errors: {errors[:5]}")
    context.close()
    profile.cleanup()
print("PASS UI: no save button, execution event writes shared anima-lora Prompt library")

