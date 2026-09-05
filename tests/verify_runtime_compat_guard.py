from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page_errors = []
        console_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("() => window.LiteGraph?.registered_node_types?.['easy imageInsetCrop']", timeout=30000)
        page.wait_for_function(
            "() => window.__tkAnimaRuntimeCompatGuardsInstalled && window.LiteGraph.registered_node_types['easy imageInsetCrop'].prototype.onAdded?.__tkAnimaOptionsGuard",
            timeout=30000,
        )
        result = page.evaluate(
            """
            () => {
              const type = window.LiteGraph.registered_node_types['easy imageInsetCrop'];
              const app = window.app || window.comfyAPI?.app?.app;
              const node = window.LiteGraph.createNode('easy imageInsetCrop');
              node.widgets[2].options = undefined;
              const before = node.widgets.map(w => Boolean(w?.options));
              app.graph.add(node);
              const after = node.widgets.map(w => Boolean(w?.options));
              let leaked = false;
              window.addEventListener("error", () => { leaked = true; }, false);
              const probe = new ErrorEvent("error", {
                message: "Cannot read properties of undefined (reading 'step2')",
                error: { message: "Cannot read properties of undefined (reading 'step2')", stack: "at http://127.0.0.1:8188/extensions/ComfyUI-Easy-Use/assets/extensions.js:1:1" },
                filename: "http://127.0.0.1:8188/extensions/ComfyUI-Easy-Use/assets/extensions.js",
                cancelable: true,
              });
              const dispatchResult = window.dispatchEvent(probe);
              return {
                prototypeGuarded: Boolean(type.prototype.onAdded?.__tkAnimaOptionsGuard),
                before,
                after,
                shielded: probe.defaultPrevented && !dispatchResult && !leaked,
              };
            }
            """
        )
        assert result["prototypeGuarded"], result
        # The guard's accessor intentionally converts an undefined assignment
        # back to an empty options object before EasyUse can read step2.
        assert all(result["before"]), result
        assert all(result["after"]), result
        assert result["shielded"], result
        assert not [error for error in page_errors if "step2" in error], page_errors
        assert not [error for error in console_errors if "step2" in error], console_errors
        browser.close()
    print("runtime compatibility guard passed")


if __name__ == "__main__":
    main()
