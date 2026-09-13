"""Minimal browser repro for the clothing-node/EasyUse ``step2`` crash.

This intentionally exercises both a visible and a NEVER-mode clothing node
inside a real ComfyUI page, then reloads the serialized graph and queues it.
It fails on the user's reported browser symptom rather than merely checking
that the node exists.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BASE_URL = "http://127.0.0.1:8188/"


def run() -> None:
    with tempfile.TemporaryDirectory(prefix="tk-clothing-step2-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=str(CHROME),
                headless=True,
                viewport={"width": 1600, "height": 1000},
                args=["--no-first-run", "--disable-gpu"],
            )
            page = context.pages[0] if context.pages else context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
            page.on(
                "console",
                lambda message: errors.append(f"console: {message.text}")
                if message.type == "error"
                else None,
            )
            page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_function(
                "() => Boolean(window.app?.graph && window.LiteGraph?.registered_node_types?.AnimaClothingDraw)",
                timeout=30_000,
            )
            page.wait_for_timeout(1_500)
            result = page.evaluate(
                """
                async () => {
                  const app = window.app;
                  const cases = {};
                  for (const [name, modes] of Object.entries({none: [], visible: [0], hidden: [4], both: [0, 4]})) {
                    app.graph.clear();
                    for (const mode of modes) {
                      const node = LiteGraph.createNode('AnimaClothingDraw');
                      if (!node) throw new Error('AnimaClothingDraw unavailable');
                      node.mode = mode;
                      node.pos = [100, 100 + app.graph._nodes.length * 450];
                      app.graph.add(node);
                    }
                    const serialized = app.graph.serialize();
                    await app.loadGraphData(serialized);
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    let queueError = null;
                    try { await app.queuePrompt(0, 1); } catch (error) {
                      queueError = String(error?.stack || error);
                    }
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    cases[name] = {
                      nodeCount: app.graph._nodes.filter((item) => item.type === 'AnimaClothingDraw').length,
                      queueError,
                    };
                  }
                  return cases;
                }
                """
            )
            # The user-visible failure is the rejection returned by
            # `queuePrompt`; unrelated extension console noise must not make
            # this regression flaky.
            step2 = []
            for case in result.values():
                if case.get("queueError") and "step2" in case["queueError"]:
                    step2.append(case["queueError"])
            print(json.dumps({"result": result, "step2": step2, "all_errors": errors}, ensure_ascii=False, indent=2))
            assert not step2, f"step2 regression remains: {step2}"
            assert all(case["queueError"] is None for case in result.values()), result
            assert result["visible"]["nodeCount"] == 1, result
            assert result["hidden"]["nodeCount"] == 1, result
            assert result["both"]["nodeCount"] == 2, result
            print("clothing draw step2 regression passed")
            context.close()


if __name__ == "__main__":
    run()
