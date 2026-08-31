"""TK 相机/ D站画廊 Prompt 输出控制的真实 ComfyUI 页面验证。"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import base64
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BROWSER = Path(os.environ.get("TK_BROWSER_EXECUTABLE", str(CHROME)))
sys.stdout.reconfigure(encoding="utf-8")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


def main() -> None:
    page_errors: list[str] = []
    console_errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="tk-prompt-output-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=str(BROWSER),
                headless=True,
                viewport={"width": 1600, "height": 1000},
                args=["--no-first-run", "--disable-gpu"],
            )
            page = context.pages[0] if context.pages else context.new_page()
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                and "Failed to load resource" not in message.text
                and "ComfyApp graph accessed before initialization" not in message.text
                and "[bsk_prompt_hint] CodeMirror 未加载" not in message.text
                and "[bsk_prompt_mode] CodeMirror 未加载" not in message.text
                and "CodeMirror is not defined" not in message.text
                and "[vite:preloadError]" not in message.text
                and "vs_state.js 未加载" not in message.text
                and "[VS " not in message.text
                and "[BSK Video Studio]" not in message.text
                else None,
            )
            cards_library = {
                "version": 2,
                "updated": 1,
                "categories": [
                    {"id": "card_all", "name": "通用", "icon": "", "sortOrder": 0},
                    {"id": "card_char", "name": "角色", "icon": "", "sortOrder": 1},
                    {"id": "card_style", "name": "画风", "icon": "", "sortOrder": 2},
                    {"id": "card_pose", "name": "姿势", "icon": "", "sortOrder": 3},
                    {"id": "card_scene", "name": "场景", "icon": "", "sortOrder": 4},
                    {"id": "card_quality", "name": "质量词", "icon": "", "sortOrder": 5},
                    {"id": "card_lora", "name": "LoRA 触发词", "icon": "", "sortOrder": 6},
                ],
                "cards": [],
            }
            cards_posts: list[dict] = []
            tiny_png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")

            def fake_cards(route):
                if route.request.method == "POST":
                    cards_library.clear()
                    cards_library.update(json.loads(route.request.post_data or "{}"))
                    cards_posts.append(json.loads(json.dumps(cards_library)))
                    route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "count": len(cards_library.get("cards", [])), "version": 2}))
                    return
                route.fulfill(status=200, content_type="application/json", body=json.dumps(cards_library))

            def fake_translate(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({
                    "translations": {
                        "sample_character": "示例角色",
                        "sample_series": "示例作品",
                        "long_hair": "长发",
                        "(smile)": "微笑",
                    }
                }))

            def fake_image(route):
                route.fulfill(status=200, content_type="image/png", body=tiny_png)

            def fake_posts(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"posts": [], "tag_limit": 2}))

            def fake_account(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"logged_in": False, "tag_limit": 2}))

            def fake_suggest(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"suggestions": [], "didYouMean": [], "rewrites": []}))

            def fake_fuzzy(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"changed": False, "corrected": route.request.url.split("tags=")[-1], "replacements": {}}))

            page.route("**/anima/cards", fake_cards)
            page.route("**/anima/danbooru/translate", fake_translate)
            page.route("**/anima/danbooru/image**", fake_image)
            page.route("**/anima/danbooru/posts**", fake_posts)
            page.route("**/anima/danbooru/account", fake_account)
            page.route("**/anima/danbooru/suggest**", fake_suggest)
            page.route("**/anima/danbooru/fuzzy**", fake_fuzzy)
            page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
            page.wait_for_timeout(5_000)

            created = page.evaluate(
                """
                () => {
                  const gallery = LiteGraph.createNode('DanbooruGallery');
                  const camera = LiteGraph.createNode('TK Camera Control');
                  if (!gallery || !camera) return null;
                  window.app.graph.add(gallery);
                  window.app.graph.add(camera);
                  gallery.pos = [40, 40];
                  camera.pos = [2000, 40];
                  window.__adgNode = gallery;
                  window.__camNode = camera;
                  return { gallery: gallery.type, camera: camera.type };
                }
                """
            )
            check("节点注册并创建", created == {"gallery": "DanbooruGallery", "camera": "TK Camera Control"}, created)
            page.wait_for_selector(".anima-danbooru-gallery", timeout=15_000)
            page.wait_for_selector(".anima-cam-canvas", timeout=15_000)

            camera_state = page.evaluate(
                """
                () => ({
                  nlRows: document.querySelectorAll('.anima-cam-nl').length,
                  nlLabels: [...document.querySelectorAll('.anima-cam-row')].filter(x => (x.textContent || '').includes('自然语言')).length,
                  canvas: document.querySelectorAll('.anima-cam-canvas').length,
                  canvasLabel: document.querySelector('.anima-cam-canvas')?.getAttribute('aria-label') || '',
                  spaceHint: document.querySelector('.anima-cam-space-hint')?.textContent || '',
                  dragModes: [...document.querySelectorAll('.anima-cam-drag-mode button')].map(x => x.textContent.trim()),
                })
                """
            )
            check("相机自然语言输入已移除", camera_state["nlRows"] == 0 and camera_state["nlLabels"] == 0, camera_state)
            check("相机 3D 画布仍存在", camera_state["canvas"] == 1, camera_state)
            check("相机画布明确为球面参照", "球面" in camera_state["canvasLabel"] and "法线" in camera_state["spaceHint"], camera_state)
            check("相机拖拽模式按钮齐全", camera_state["dragModes"] == ["相对", "绝对", "融合"], camera_state)

            drag_mode_state = page.evaluate(
                """
                () => {
                  const ui = window.__camNode?._animaCam;
                  const buttons = [...document.querySelectorAll('.anima-cam-drag-mode button')];
                  if (!ui || buttons.length !== 3) return null;
                  const result = buttons.map((button) => {
                    button.click();
                    return {
                      label: button.textContent.trim(),
                      mode: ui.dragMode,
                      pressed: button.getAttribute('aria-pressed'),
                    };
                  });
                  const rect = ui.canvas.getBoundingClientRect();
                  const center = { x: rect.left + rect.width * 0.50, y: rect.top + rect.height * 0.50 };
                  const outside = { x: rect.left + rect.width * 0.02, y: rect.top + rect.height * 0.50 };
                  const original = { x: ui.w.px?.value, y: ui.w.py?.value };
                  const dragBranches = {};
                  for (const mode of ['relative', 'absolute', 'hybrid']) {
                    buttons.find(button => button.dataset.mode === mode)?.click();
                    ui._canvasDrag({ type: 'pointerdown', clientX: center.x, clientY: center.y });
                    dragBranches[mode] = ui._dragMode;
                    ui._finishDrag();
                    ui._setW(ui.w.px, original.x);
                    ui._setW(ui.w.py, original.y);
                    ui._syncControls();
                  }
                  buttons.find(button => button.dataset.mode === 'absolute')?.click();
                  ui._canvasDrag({ type: 'pointerdown', clientX: outside.x, clientY: outside.y });
                  const absoluteOutsideDown = ui._dragMode;
                  const beforeOutside = { x: Number(ui.w.px?.value), y: Number(ui.w.py?.value) };
                  ui._canvasDrag({ type: 'pointermove', clientX: outside.x + rect.width * 0.03, clientY: outside.y });
                  const afterOutside = { x: Number(ui.w.px?.value), y: Number(ui.w.py?.value) };
                  ui._finishDrag();
                  ui._setW(ui.w.px, original.x);
                  ui._setW(ui.w.py, original.y);
                  ui._syncControls();
                  [...document.querySelectorAll('.anima-cam-drag-mode button')].find(button => button.dataset.mode === 'hybrid')?.click();
                  return { result, final: ui.dragMode, dragBranches, absoluteOutsideDown, outsideHeld: beforeOutside.x === afterOutside.x && beforeOutside.y === afterOutside.y };
                }
                """
            )
            check(
                "相机拖拽模式可切换",
                drag_mode_state
                and [item["mode"] for item in drag_mode_state["result"]] == ["relative", "absolute", "hybrid"]
                and all(item["pressed"] == "true" for item in drag_mode_state["result"])
                and drag_mode_state["final"] == "hybrid",
                drag_mode_state,
            )
            check(
                "相机三种拖拽方式使用稳定坐标模型",
                drag_mode_state
                and drag_mode_state["dragBranches"] == {"relative": "relative", "absolute": "absolute", "hybrid": "hybrid"}
                and drag_mode_state["absoluteOutsideDown"] == "absolute"
                and not drag_mode_state["outsideHeld"],
                drag_mode_state,
            )

            absolute_geometry_state = page.evaluate(
                """
                () => {
                  const ui = window.__camNode?._animaCam;
                  const button = [...document.querySelectorAll('.anima-cam-drag-mode button')].find(x => x.dataset.mode === 'absolute');
                  if (!ui?.canvas || !button) return null;
                  const rect = ui.canvas.getBoundingClientRect();
                  const original = { x: ui.w.px?.value, y: ui.w.py?.value };
                  button.click();
                  const x = rect.left + rect.width * 0.50;
                  const y = rect.top + rect.height * 0.50;
                  ui._canvasDrag({ type: 'pointerdown', clientX: x, clientY: y });
                  const center = { x: Number(ui.w.px?.value), y: Number(ui.w.py?.value) };
                  ui._finishDrag();

                  const start = { x: rect.left + rect.width * 0.50, y: rect.top + rect.height * 0.50 };
                  const back = { x: rect.left + rect.width * 0.98, y: rect.top + rect.height * 0.50 };
                  ui._canvasDrag({ type: 'pointerdown', clientX: start.x, clientY: start.y });
                  const startBranch = ui._dragMode;
                  ui._canvasDrag({ type: 'pointermove', clientX: back.x, clientY: back.y });
                  const rear = { x: Number(ui.w.px?.value), y: Number(ui.w.py?.value) };
                  ui._finishDrag();
                  ui._setW(ui.w.px, original.x);
                  ui._setW(ui.w.py, original.y);
                  ui._syncControls();
                  [...document.querySelectorAll('.anima-cam-drag-mode button')].find(button => button.dataset.mode === 'hybrid')?.click();
                  return { center, startBranch, rear };
                }
                """
            )
            check(
                "绝对映射的屏幕坐标方向正确",
                absolute_geometry_state
                and abs(absolute_geometry_state["center"]["x"]) <= 0.05
                and abs(absolute_geometry_state["center"]["y"]) <= 0.05,
                absolute_geometry_state,
            )
            check(
                "绝对拖拽可从前方连续到后方",
                absolute_geometry_state
                and abs(absolute_geometry_state["center"]["x"]) <= 0.05
                and abs(absolute_geometry_state["center"]["y"]) <= 0.05
                and absolute_geometry_state["startBranch"] == "absolute"
                and absolute_geometry_state["rear"]["x"] >= 0.90,
                absolute_geometry_state,
            )

            hybrid_state = page.evaluate(
                """
                () => {
                  const ui = window.__camNode?._animaCam;
                  if (!ui?.canvas) return null;
                  const rect = ui.canvas.getBoundingClientRect();
                  const original = { x: ui.w.px?.value, y: ui.w.py?.value };
                  const x = rect.left + rect.width * 0.50;
                  const y = rect.top + rect.height * 0.50;
                  ui._canvasDrag({ type: 'pointerdown', clientX: x, clientY: y });
                  const mode = ui._dragMode;
                  ui._canvasDrag({ type: 'pointermove', clientX: x + rect.width * 0.12, clientY: y - rect.height * 0.10 });
                  const changed = { x: Number(ui.w.px?.value), y: Number(ui.w.py?.value) };
                  ui._finishDrag();
                  ui._setW(ui.w.px, original.x);
                  ui._setW(ui.w.py, original.y);
                  ui._syncControls();
                  return { mode, changed, moved: changed.x !== Number(original.x) || changed.y !== Number(original.y) };
                }
                """
            )
            check("融合拖拽按绝对起点后连续跟手", hybrid_state and hybrid_state["mode"] == "hybrid" and hybrid_state["moved"], hybrid_state)

            camera_weights = page.evaluate(
                """
                () => {
                  const ui = window.__camNode?._animaCam;
                  if (!ui) return null;
                  const original = ui.w.config?.value || '';
                  const cfg = JSON.parse(original);
                  cfg.weight_max = 5;
                  cfg.elevation.enabled = false;
                  cfg.distance.enabled = false;
                  cfg.tilt.enabled = false;
                  ui._setW(ui.w.config, JSON.stringify(cfg));
                  const read = (x, tag) => {
                    ui._setW(ui.w.px, x);
                    ui._syncControls();
                    const match = new RegExp('\\\\(' + tag.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + ':([0-9.]+)\\\\)').exec(ui.previewEl?.textContent || '');
                    return match ? Number(match[1]) : null;
                  };
                  const result = {
                    left: [0.25, 0.35, 0.45, 0.50].map(x => read(x, 'from left')),
                    right: [0.25, 0.35, 0.45, 0.50].map(x => read(-x, 'from right')),
                    behind: [0.75, 0.85, 0.95, 1.00].map(x => read(x, 'from behind')),
                  };
                  ui._setW(ui.w.config, original);
                  ui._syncControls();
                  return result;
                }
                """
            )
            check(
                "相机前端左右/背面权重连续变化",
                camera_weights
                and all(camera_weights[key] == sorted(camera_weights[key]) and len(set(camera_weights[key])) == 4 for key in ("left", "right", "behind"))
                and camera_weights["left"][-1] == camera_weights["right"][-1] == camera_weights["behind"][-1] == 5,
                camera_weights,
            )

            roll_visual_state = page.evaluate(
                """
                () => {
                  const ui = window.__camNode?._animaCam;
                  if (!ui?.canvas) return null;
                  const original = {
                    x: ui.w.px?.value,
                    y: ui.w.py?.value,
                    z: ui.w.pz?.value,
                    roll: ui.w.roll?.value,
                  };
                  ui._setW(ui.w.px, 0.35);
                  ui._setW(ui.w.py, 0);
                  ui._setW(ui.w.pz, 0);
                  const pixels = () => ui.canvas.getContext('2d').getImageData(0, 60, ui.canvas.width, ui.canvas.height - 60).data;
                  ui._setW(ui.w.roll, 0);
                  ui._syncControls();
                  const level = pixels();
                  ui._setW(ui.w.roll, 0.8);
                  ui._syncControls();
                  const tilted = pixels();
                  const tiltedPrompt = ui.previewEl?.textContent || '';
                  let changed = 0;
                  for (let i = 0; i < level.length; i++) if (level[i] !== tilted[i]) changed++;
                  ui._setW(ui.w.px, original.x);
                  ui._setW(ui.w.py, original.y);
                  ui._setW(ui.w.pz, original.z);
                  ui._setW(ui.w.roll, original.roll);
                  ui._syncControls();
                  return { changedPixels: changed, comparedBytes: level.length, tiltedPrompt };
                }
                """
            )
            check("角度不改变 3D 方位画布", roll_visual_state and roll_visual_state["changedPixels"] == 0, roll_visual_state)
            check("角度输出仍保留", roll_visual_state and "dutch angle" in roll_visual_state["tiltedPrompt"], roll_visual_state)

            gallery_state = page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  ui.posts = [{
                    id: 123,
                    large_file_url: 'https://danbooru.donmai.us/data/test.png',
                    file_url: 'https://danbooru.donmai.us/data/test.png',
                    preview_file_url: 'https://danbooru.donmai.us/data/test-preview.jpg',
                    tag_string_artist: 'sample_artist',
                    tag_string_copyright: 'sample_series',
                    tag_string_character: 'sample_character',
                    tag_string_general: 'long_hair (smile)',
                    tag_string_meta: 'absurdres',
                    rating: 'g', score: 12, fav_count: 4, image_width: 512, image_height: 768,
                    file_ext: 'png', source: 'danbooru',
                  }];
                  ui.renderPosts();
                  return {
                    hasPromptSettings: [...ui.root.querySelectorAll('button')].some(b => (b.textContent || '').includes('Prompt设置')),
                    defaultPrompt: ui.grid.querySelector('.adg-card')?.dataset.prompt || '',
                    defaultGroups: ui.grid.querySelector('.adg-card')?.dataset.promptGroups || '',
                  };
                }
                """
            )
            check("画廊出现 Prompt 设置入口", gallery_state["hasPromptSettings"], gallery_state)
            check("默认 Prompt 保持旧三类输出", gallery_state["defaultPrompt"] == "sample character, sample series, long hair, (smile)", gallery_state)
            default_groups = json.loads(gallery_state["defaultGroups"])
            check("默认分组包含角色/版权/通用", default_groups["character"] == ["sample_character"] and default_groups["copyright"] == ["sample_series"] and default_groups["general"] == ["long_hair", "(smile)"], default_groups)
            gallery_layout = page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  const root = ui.root;
                  const grid = ui.grid;
                  const hasResizeHandle = Boolean(root?.querySelector('.adg-gallery-resize-handle'));
                  const pagination = ui.pagination;
                  const widget = root?.closest('.lg-node-widget');
                  const widgetGrid = root?.closest('.lg-node-widgets');
                  const rect = (el) => {
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    const s = getComputedStyle(el);
                    return { x: r.x, y: r.y, width: r.width, height: r.height, clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, overflowX: s.overflowX, overflowY: s.overflowY, flex: s.flex, minHeight: s.minHeight, maxHeight: s.maxHeight };
                  };
                  ui.settings.gridHeight = 620;
                  ui.applyGridHeight();
                  const beforeHeight = ui.settings.gridHeight;
                  const nodeWidth = ui.node.size[0];
                  ui.node.setSize([nodeWidth, 760]);
                  const outerSmallHeight = root.offsetHeight;
                  ui.node.setSize([nodeWidth, 960]);
                  const outerLargeHeight = root.offsetHeight;
                  const outerResizeDelta = outerLargeHeight - outerSmallHeight;
                  ui.settings.gridHeight = beforeHeight;
                  ui.applyGridHeight();
                  const originalPosts = ui.posts;
                  ui.posts = Array.from({ length: 8 }, (_, index) => ({ ...originalPosts[0], id: 9000 + index }));
                  ui.renderPosts();
                  const manyCards = ui.grid.querySelectorAll('.adg-card').length;
                  const manyGrid = rect(ui.grid);
                  ui.posts = originalPosts;
                  ui.renderPosts();
                  return { nodeSize: ui.node.size, beforeHeight, root: rect(root), grid: rect(grid), hasResizeHandle, pagination: rect(pagination), paginationRow: rect(pagination?.parentElement), paginationButtonCount: pagination?.querySelectorAll('button').length || 0, restoredHeight: ui.settings.gridHeight, outerResizeDelta, manyCards, manyGrid, widget: rect(widget), widgetGrid: rect(widgetGrid) };
                }
                """
            )
            check("Chrome 画廊卡片区关闭横向溢出", gallery_layout["grid"]["overflowX"] == "hidden", gallery_layout)
            check("多张卡片在 Chrome 中保持网格布局", gallery_layout["manyCards"] == 8 and gallery_layout["manyGrid"]["scrollWidth"] <= gallery_layout["manyGrid"]["clientWidth"] + 1, gallery_layout)
            check("画廊不再添加内部高度调整条", gallery_layout["hasResizeHandle"] is False, gallery_layout)
            check("节点外框变化同步画廊高度", gallery_layout["outerResizeDelta"] >= 150, gallery_layout)
            check("分页按钮独立显示", gallery_layout["paginationButtonCount"] >= 5 and gallery_layout["paginationRow"]["height"] > 0, gallery_layout)
            prompt_toggle = page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  const card = ui.grid.querySelector('.adg-card');
                  card.classList.add('is-selected');
                  card.querySelector('.adg-card-select')?.setAttribute('aria-pressed', 'true');
                  ui.updateSelection();
                  const enabled = JSON.parse(ui.selectionWidget.value || '{}');
                  const button = [...ui.root.querySelectorAll('button')].find(x => (x.textContent || '').startsWith('Prompt 输出'));
                  const hasButton = Boolean(button);
                  button?.click();
                  const disabled = JSON.parse(ui.selectionWidget.value || '{}');
                  button?.click();
                  const enabledAgain = JSON.parse(ui.selectionWidget.value || '{}');
                  return { hasButton, enabledPrompt: enabled.selections?.[0]?.prompt || '', disabledPrompt: disabled.selections?.[0]?.prompt || '', disabledFlag: disabled.prompt_output_enabled, enabledImage: enabled.image_selections?.[0]?.image_url || enabled.selections?.[0]?.image_url || '', disabledImage: disabled.image_selections?.[0]?.image_url || disabled.selections?.[0]?.image_url || '', enabledAgainPrompt: enabledAgain.selections?.[0]?.prompt || '', enabledAgainFlag: enabledAgain.prompt_output_enabled, enabledAgainImage: enabledAgain.image_selections?.[0]?.image_url || enabledAgain.selections?.[0]?.image_url || '' };
                }
                """
            )
            check("Prompt 输出开关存在", prompt_toggle["hasButton"], prompt_toggle)
            check("关闭 Prompt 输出后只关闭 Prompt、不关闭图片", prompt_toggle["disabledPrompt"] == "" and prompt_toggle["disabledFlag"] is False and prompt_toggle["enabledPrompt"] and prompt_toggle["disabledImage"] == prompt_toggle["enabledImage"] and prompt_toggle["disabledImage"], prompt_toggle)
            check("重新开启 Prompt 输出后恢复 Prompt", prompt_toggle["enabledAgainFlag"] is True and prompt_toggle["enabledAgainPrompt"] == prompt_toggle["enabledPrompt"] and prompt_toggle["enabledAgainImage"] == prompt_toggle["enabledImage"], prompt_toggle)
            page.evaluate("() => { const keep = window.__adgNode; for (const item of [...(window.app.graph._nodes || [])]) if (item !== keep) window.app.graph.remove(item); window.app.graph.setDirtyCanvas?.(true, true); }")
            page.wait_for_timeout(250)
            page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  const card = ui.grid.querySelector('.adg-card');
                  card?.classList.add('is-selected');
                  card?.querySelector('.adg-card-select')?.setAttribute('aria-pressed', 'true');
                  ui.updateSelection();
                }
                """
            )
            hit_test = page.evaluate(
                """
                () => {
                  const button = document.querySelector('.anima-danbooru-gallery .adg-toolbar-main button[aria-pressed]');
                  if (!button) return null;
                  const r = button.getBoundingClientRect();
                  return { button: r.toJSON() };
                }
                """
            )
            page.mouse.click(hit_test["button"]["x"] + hit_test["button"]["width"] / 2, hit_test["button"]["y"] + hit_test["button"]["height"] / 2)
            page.wait_for_timeout(100)
            pointer_disabled = page.evaluate("() => JSON.parse(window.__adgNode._animaDanbooruGallery.selectionWidget.value || '{}')")
            page.mouse.click(hit_test["button"]["x"] + hit_test["button"]["width"] / 2, hit_test["button"]["y"] + hit_test["button"]["height"] / 2)
            page.wait_for_timeout(100)
            pointer_enabled = page.evaluate("() => JSON.parse(window.__adgNode._animaDanbooruGallery.selectionWidget.value || '{}')")
            check("真实鼠标点击关闭后清空 Prompt", pointer_disabled.get("prompt_output_enabled") is False and pointer_disabled.get("selections", [{}])[0].get("prompt", "") == "", pointer_disabled)
            check("真实鼠标点击重新开启后恢复 Prompt", pointer_enabled.get("prompt_output_enabled") is True and pointer_enabled.get("selections", [{}])[0].get("prompt", "") == prompt_toggle["enabledPrompt"], pointer_enabled)

            cards_created = page.evaluate(
                """
                () => {
                  const node = LiteGraph.createNode('TKPromptCards');
                  if (!node) return null;
                  window.app.graph.add(node);
                  window.__cardsNode = node;
                  return node.type;
                }
                """
            )
            check("TK Prompt Cards 节点创建", cards_created == "TKPromptCards", cards_created)
            page.wait_for_selector(".tk-cards-ui", timeout=15_000)

            save_state = page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  ui.settings.promptOutput = { categories: ['character', 'copyright', 'general'], replaceUnderscores: true, escapeBrackets: false };
                  const card = ui.grid.querySelector('.adg-card');
                  const button = [...(card?.querySelectorAll('.adg-card-actions button') || [])]
                    .find(item => (item.textContent || '').trim() === '入库');
                  button?.click();
                  return Boolean(button);
                }
                """
            )
            check("D 站入库打开选项弹层", save_state, save_state)
            page.wait_for_selector(".adg-save-options", timeout=5_000)
            page.wait_for_function("() => [...document.querySelectorAll('.adg-save-bilingual-zh')].some(el => (el.value || '').includes('长发'))", timeout=5_000)
            page.evaluate(
                """
                () => {
                  const panel = document.querySelector('.adg-save-options');
                  panel.querySelector('select').value = 'cat_faces';
                  panel.querySelector('.adg-save-exclude-input').value = 'series';
                  panel.querySelector('.adg-save-title-input').value = '自定义标题';
                  const prompt = panel.querySelector('.adg-save-prompt-input');
                  prompt.value = 'sample character, long hair';
                  prompt.dispatchEvent(new Event('input', { bubbles: true }));
                }
                """
            )
            page.wait_for_function("() => [...document.querySelectorAll('.adg-save-bilingual-en')].some(el => el.value === 'sample character')", timeout=5_000)
            save_options = page.evaluate(
                """
                () => {
                  const panel = document.querySelector('.adg-save-options');
                  const selected = [...panel.querySelectorAll('input[type=checkbox]:checked')].map(x => x.name);
                  const counts = [...panel.querySelectorAll('.adg-prompt-category-choice input')].map(x => ({ name: x.name, disabled: x.disabled }));
                  const row = [...panel.querySelectorAll('.adg-save-bilingual-card')]
                    .find(item => item.querySelector('.adg-save-bilingual-en')?.value === 'long hair');
                  const en = row?.querySelector('.adg-save-bilingual-en');
                  const zh = row?.querySelector('.adg-save-bilingual-zh');
                  if (!en || !zh) throw new Error('入库双语卡片缺少可编辑语言框');
                  en.value = 'long hair edited';
                  en.dispatchEvent(new Event('input', { bubbles: true }));
                  zh.value = '自定义长发';
                  zh.dispatchEvent(new Event('input', { bubbles: true }));
                  panel.querySelector('input[name=copyright]').checked = false;
                  panel.closest('.adg-dialog')?.querySelector('.adg-dialog-actions .primary')?.click();
                  return { selected, counts, excludePattern: panel.querySelector('.adg-save-exclude-input')?.value || '', title: panel.querySelector('.adg-save-title-input')?.value || '', prompt: panel.querySelector('.adg-save-prompt-input')?.value || '', en: en.value, zh: zh.value };
                }
                """
            )
            check("入库弹层默认勾选当前三类", set(save_options["selected"]) == {"character", "copyright", "general"}, save_options)
            check("入库弹层显示各类条数", all(item["name"] in {"artist", "copyright", "character", "general", "meta"} for item in save_options["counts"]), save_options)
            check("入库弹层支持正则排除", save_options["excludePattern"] == "series", save_options)
            check("入库弹层支持自定义标题和 Prompt", save_options["title"] == "自定义标题" and save_options["prompt"] == "sample character, long hair edited" and save_options["en"] == "long hair edited" and save_options["zh"] == "自定义长发", save_options)
            page.wait_for_function("() => Boolean(document.querySelector('.adg-status')?.textContent?.includes('卡片库'))", timeout=15_000)
            check("D 站入库触发卡片库同步", bool(cards_posts), {"status": save_state, "posts": len(cards_posts)})
            prompt_record = page.evaluate(
                """
                async () => await new Promise((resolve) => {
                  const request = indexedDB.open('anima-lora');
                  request.onsuccess = () => {
                    const db = request.result;
                    const getAll = db.transaction('prompts', 'readonly').objectStore('prompts').getAll();
                    getAll.onsuccess = () => { const rows = getAll.result || []; resolve(rows[rows.length - 1] || null); };
                    getAll.onerror = () => resolve(null);
                  };
                  request.onerror = () => resolve(null);
                })
                """
            )
            check("Prompt 库条目保留 tag 翻译索引", prompt_record and prompt_record.get("displayText") == "自定义标题" and prompt_record.get("prompt") == "sample character, long hair edited" and prompt_record.get("tagTranslations", {}).get("long hair edited") == "自定义长发" and "sample series" not in prompt_record.get("tagTranslations", {}), prompt_record)
            card_zh = {str(card.get("en")): str(card.get("zh")) for card in cards_library.get("cards", [])}
            check("入库生成英文中文对应卡片", card_zh.get("sample character") == "示例角色" and card_zh.get("long hair edited") == "自定义长发" and "sample series" not in card_zh, card_zh)
            page.wait_for_function("() => [...document.querySelectorAll('.tk-cards-lib-item')].some(el => (el.textContent || '').includes('自定义标题'))", timeout=10_000)
            page.locator(".tk-cards-lib-item").filter(has_text="自定义标题").first.evaluate("el => el.click()")
            page.wait_for_timeout(500)
            imported_prompt = page.locator(".tk-cards-textarea").first.input_value()
            imported_prompt_zh = page.locator(".tk-cards-chip-zh").all_text_contents()
            check("Prompt 库条目可导入正面 prompt", imported_prompt == "sample character, long hair edited", imported_prompt)
            check("Prompt 库导入直接显示已有译文", "自定义长发" in imported_prompt_zh, imported_prompt_zh)
            check("Prompt 库展示双语卡片", page.locator(".tk-cards-lib-bilingual-card").count() >= 2 and "长发" in page.locator(".tk-cards-lib-item").filter(has_text="自定义标题").first.inner_text(), page.locator(".tk-cards-lib-item").filter(has_text="自定义标题").first.inner_text())
            page.evaluate(
                """
                () => {
                  const ui = window.__cardsNode._cardsUI;
                  ui._setW(ui.w.positive, '');
                  ui.curTextEl.value = '';
                  ui._renderChips();
                }
                """
            )
            page.wait_for_function("() => document.querySelectorAll('.tk-cards-card-en').length >= 2", timeout=10_000)
            page.locator(".tk-cards-card").filter(has_text="long hair edited").first.evaluate("el => el.click()")
            page.wait_for_timeout(500)
            cards_prompt = page.locator(".tk-cards-textarea").first.input_value()
            cards_zh = page.locator(".tk-cards-chip-zh").all_text_contents()
            check("导入卡片追加到正面 prompt", cards_prompt == "long hair edited", cards_prompt)
            check("导入后直接显示已保存中文译文", "自定义长发" in cards_zh, cards_zh)
            chinese_input = page.locator(".tk-cards-translate-input").first
            chinese_input.fill("长")
            page.wait_for_selector(".tk-cards-translate-suggest .tk-cards-suggest-item", timeout=5_000)
            chinese_suggest = page.locator(".tk-cards-translate-suggest .tk-cards-suggest-item").first
            chinese_suggest_text = chinese_suggest.inner_text()
            chinese_suggest.dispatch_event("mousedown")
            page.wait_for_timeout(300)
            chinese_prompt = page.locator(".tk-cards-textarea").first.input_value()
            check("②区中文输入可联想双语卡片", "长发" in chinese_suggest_text and "long hair" in chinese_suggest_text, chinese_suggest_text)
            check("中文联想可直接追加英文到正面 prompt", chinese_prompt == "long hair edited", chinese_prompt)
            card_search = page.locator(".tk-cards-card-search").first
            card_search.fill("长发")
            page.wait_for_timeout(250)
            zh_search_count = page.locator(".tk-cards-grid .tk-cards-card").count()
            zh_search_text = page.locator(".tk-cards-grid").inner_text()
            card_search.fill("lnghar")
            page.wait_for_timeout(250)
            en_search_count = page.locator(".tk-cards-grid .tk-cards-card").count()
            card_search.fill("不存在的卡片")
            page.wait_for_timeout(250)
            miss_search_text = page.locator(".tk-cards-grid").inner_text()
            card_search.fill("")
            check("③区支持中文双语搜索", zh_search_count == 1 and "long hair" in zh_search_text and "长发" in zh_search_text, {"count": zh_search_count, "text": zh_search_text})
            check("③区支持英文模糊搜索", en_search_count == 1, en_search_count)
            check("③区无匹配时显示空结果", "没有匹配的双语卡片" in miss_search_text, miss_search_text)

            page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  const button = [...ui.root.querySelectorAll('button')].find(b => (b.textContent || '').includes('Prompt设置'));
                  button.click();
                }
                """
            )
            page.wait_for_selector(".adg-prompt-settings", timeout=5_000)
            dialog_state = page.evaluate(
                """
                () => {
                  const dialog = document.querySelector('.adg-dialog');
                  return {
                    text: dialog?.textContent || '',
                    categories: [...dialog.querySelectorAll('.adg-prompt-category-choice input')].map(x => ({ name: x.name, checked: x.checked })),
                  };
                }
                """
            )
            check("Prompt 设置弹层可见", "画师" in dialog_state["text"] and "元数据" in dialog_state["text"], dialog_state)
            check("默认类别仍为角色/版权/通用", {x["name"] for x in dialog_state["categories"] if x["checked"]} == {"character", "copyright", "general"}, dialog_state)

            configured = page.evaluate(
                """
                () => {
                  const dialog = document.querySelector('.adg-dialog');
                  const categories = new Set(['artist', 'general']);
                  for (const input of dialog.querySelectorAll('.adg-prompt-category-choice input')) input.checked = categories.has(input.name);
                  const formats = dialog.querySelectorAll('.adg-prompt-format-choice input');
                  formats[0].checked = true;
                  formats[1].checked = true;
                  [...dialog.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '应用').click();
                  const ui = window.__adgNode._animaDanbooruGallery;
                  const card = ui.grid.querySelector('.adg-card');
                  card.classList.add('is-selected');
                  card.querySelector('.adg-card-select')?.setAttribute('aria-pressed', 'true');
                  ui.updateSelection();
                  return {
                    settings: ui.settings.promptOutput,
                    prompt: card.dataset.prompt,
                    groups: JSON.parse(card.dataset.promptGroups || '{}'),
                    selection: JSON.parse(ui.selectionWidget.value || '{}'),
                  };
                }
                """
            )
            check("类别设置保存", configured["settings"]["categories"] == ["artist", "general"], configured)
            check("类别设置控制 Prompt 输出", configured["prompt"] == r"sample artist, long hair, \(smile\)", configured)
            check("格式设置转义括号并保留分组", configured["groups"]["artist"] == ["sample_artist"] and configured["groups"]["general"] == ["long_hair", "(smile)"], configured)
            check("选择数据携带 Prompt 设置", configured["selection"]["prompt_settings"]["categories"] == ["artist", "general"] and configured["selection"]["prompt_settings"]["escapeBrackets"] is True, configured)
            check("选择数据携带 Prompt 分组", configured["selection"]["selections"][0]["prompt_groups"]["artist"] == ["sample_artist"], configured)

            page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  const card = ui.grid.querySelector('.adg-card');
                  const promptButton = [...(card?.querySelectorAll('.adg-card-actions button') || [])]
                    .find(button => (button.textContent || '').trim() === 'Prompt');
                  promptButton?.click();
                }
                """
            )
            page.wait_for_selector(".adg-prompt-bilingual-editor", timeout=5_000)
            prompt_editor_state = page.evaluate(
                """
                async () => {
                  const dialog = document.querySelector('.adg-dialog');
                  const rows = [...(dialog?.querySelectorAll('.adg-prompt-bilingual-card') || [])];
                  const row = rows.find(item => item.querySelector('.adg-prompt-bilingual-en')?.value === 'sample artist');
                  const en = row?.querySelector('.adg-prompt-bilingual-en');
                  const zh = row?.querySelector('.adg-prompt-bilingual-zh');
                  if (!en || !zh) throw new Error('查看 Prompt 双语编辑行缺失');
                  const groupText = dialog?.querySelector('.adg-prompt-groups')?.textContent || '';
                  const clearRow = rows.find(item => item.querySelector('.adg-prompt-bilingual-en')?.value === 'long hair');
                  const clearButton = clearRow?.querySelector('.adg-prompt-bilingual-clear');
                  if (!clearButton) throw new Error('双语卡片缺少清除按钮');
                  clearButton.click();
                  const clearedVisual = {
                    className: clearRow.className,
                    state: clearRow.querySelector('.adg-prompt-bilingual-clear-state')?.textContent || '',
                    button: clearButton.textContent || '',
                    disabled: Boolean(clearRow.querySelector('.adg-prompt-bilingual-en')?.disabled && clearRow.querySelector('.adg-prompt-bilingual-zh')?.disabled),
                  };
                  en.value = 'sample artist edited';
                  en.dispatchEvent(new Event('input', { bubbles: true }));
                  zh.value = '修改后的画师';
                  zh.dispatchEvent(new Event('input', { bubbles: true }));
                  dialog.querySelector('.adg-dialog-actions .primary')?.click();
                  const card = window.__adgNode._animaDanbooruGallery.grid.querySelector('.adg-card');
                  const clearedOutput = { prompt: card?.dataset.prompt || '', tags: JSON.parse(card?.dataset.tags || '[]') };
                  await window.__adgNode._animaDanbooruGallery.openPromptEditor(card, window.__adgNode._animaDanbooruGallery.posts[0]);
                  const restoredRow = [...document.querySelectorAll('.adg-prompt-bilingual-card')]
                    .find(item => item.querySelector('.adg-prompt-bilingual-en')?.value === 'long hair');
                  restoredRow?.querySelector('.adg-prompt-bilingual-clear')?.click();
                  document.querySelector('.adg-dialog-actions .primary')?.click();
                  const restoredOutput = { prompt: card?.dataset.prompt || '', tags: JSON.parse(card?.dataset.tags || '[]') };
                  return { rowCount: rows.length, groupText, en: en.value, zh: zh.value, clearedVisual, clearedOutput, restoredOutput };
                }
                """
            )
            check("Prompt 编辑器显示分组摘要", "画师 1" in prompt_editor_state["groupText"] and "通用 2" in prompt_editor_state["groupText"], prompt_editor_state)
            check("查看 Prompt 支持双语逐行修改", prompt_editor_state["rowCount"] >= 2 and prompt_editor_state["en"] == "sample artist edited" and prompt_editor_state["zh"] == "修改后的画师", prompt_editor_state)
            check("单卡清除状态在界面可见", "is-cleared" in prompt_editor_state["clearedVisual"]["className"] and "已清除" in prompt_editor_state["clearedVisual"]["state"] and prompt_editor_state["clearedVisual"]["button"] == "恢复" and prompt_editor_state["clearedVisual"]["disabled"], prompt_editor_state)
            check("清除的提示词不会进入输出", "long hair" not in prompt_editor_state["clearedOutput"]["prompt"] and "long hair" not in prompt_editor_state["clearedOutput"]["tags"], prompt_editor_state)
            check("恢复后提示词重新进入输出", "long hair" in prompt_editor_state["restoredOutput"]["prompt"] and "long hair" in prompt_editor_state["restoredOutput"]["tags"], prompt_editor_state)
            edited_card = page.evaluate(
                """
                () => {
                  const card = window.__adgNode._animaDanbooruGallery.grid.querySelector('.adg-card');
                  return { prompt: card?.dataset.prompt || '', translations: JSON.parse(card?.dataset.promptTranslations || '{}') };
                }
                """
            )
            check("查看 Prompt 修改同步到卡片", edited_card["prompt"].startswith("sample artist edited") and edited_card["translations"].get("sample artist edited") == "修改后的画师", edited_card)
            page.evaluate("() => window.__adgNode._animaDanbooruGallery.removeDialog()")

            toolbar_state = page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  const texts = [...ui.root.querySelectorAll('.adg-toolbar button')].map(button => (button.textContent || '').trim());
                  return {
                    texts,
                    groups: ui.root.querySelectorAll('.adg-toolbar-group').length,
                    presetManageCount: texts.filter(text => text === '预设管理').length,
                    oldSaveCount: texts.filter(text => text === '存预设').length,
                    oldDeleteCount: texts.filter(text => text === '删预设').length,
                  };
                }
                """
            )
            check("工具栏按操作域分组", toolbar_state["groups"] == 4, toolbar_state)
            check("预设保存/删除合并为单一入口", toolbar_state["presetManageCount"] == 1 and toolbar_state["oldSaveCount"] == 0 and toolbar_state["oldDeleteCount"] == 0, toolbar_state)
            page.screenshot(path=str(ROOT / ".scratch" / "tk-gallery-toolbar-optimized.png"), full_page=True)

            page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  [...ui.root.querySelectorAll('button')].find(button => (button.textContent || '').trim() === '预设管理').click();
                }
                """
            )
            page.wait_for_selector(".adg-preset-manager", timeout=5_000)
            preset_dialog = page.evaluate(
                """
                () => {
                  const dialog = document.querySelector('.adg-dialog');
                  return {
                    hasSaveRow: Boolean(dialog?.querySelector('.adg-preset-save-row')),
                    footerButtons: [...(dialog?.querySelectorAll('.adg-dialog-actions button') || [])].map(button => (button.textContent || '').trim()),
                  };
                }
                """
            )
            check("预设管理弹层包含保存当前", preset_dialog["hasSaveRow"], preset_dialog)
            check("预设管理去掉空应用按钮", preset_dialog["footerButtons"] == ["取消"], preset_dialog)
            page.locator(".adg-preset-name-input").fill("页面验证预设")
            page.get_by_role("button", name="保存当前").click()
            check("预设管理可保存当前搜索", page.evaluate("() => window.__adgNode._animaDanbooruGallery.settings.presets.some(p => p.name === '页面验证预设')"))
            page.locator(".adg-preset-remove").click()
            check("预设管理可删除预设", not page.evaluate("() => window.__adgNode._animaDanbooruGallery.settings.presets.some(p => p.name === '页面验证预设')"))
            page.evaluate("() => window.__adgNode._animaDanbooruGallery.removeDialog()")

            page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  [...ui.root.querySelectorAll('button')].find(button => (button.textContent || '').includes('分级')).click();
                }
                """
            )
            page.wait_for_selector(".adg-rating-menu-content", timeout=5_000)
            rating_state = page.evaluate(
                """
                () => ({
                  menu: Boolean(document.querySelector('.adg-rating-menu-content')),
                  choices: document.querySelectorAll('.adg-rating-menu-content .adg-menu-choice').length,
                  actionButtons: [...document.querySelectorAll('.adg-rating-menu-content .adg-menu-actions button')].map(button => (button.textContent || '').trim()),
                })
                """
            )
            check("分级弹层采用统一菜单结构", rating_state["menu"] and rating_state["choices"] == 5 and rating_state["actionButtons"] == ["重置", "应用筛选"], rating_state)
            page.screenshot(path=str(ROOT / ".scratch" / "tk-gallery-rating-optimized.png"), full_page=True)
            page.evaluate("() => window.__adgNode._animaDanbooruGallery.filterControls.ratingDropdown.close()")

            page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  [...ui.root.querySelectorAll('button')].find(button => (button.textContent || '').includes('筛选')).click();
                }
                """
            )
            page.wait_for_selector(".adg-filter-grid", timeout=5_000)
            filter_state = page.evaluate(
                """
                () => ({
                  grid: Boolean(document.querySelector('.adg-filter-grid')),
                  cascadeRows: document.querySelectorAll('.adg-filter-grid .adg-cascade-row').length,
                  quickPresets: document.querySelectorAll('.adg-quick-preset').length,
                })
                """
            )
            check("筛选弹层采用两列级联布局", filter_state["grid"] and filter_state["cascadeRows"] == 7 and filter_state["quickPresets"] == 4, filter_state)
            page.screenshot(path=str(ROOT / ".scratch" / "tk-gallery-filter-optimized.png"), full_page=True)
            page.evaluate("() => window.__adgNode._animaDanbooruGallery.filterControls.filterDropdown.close()")

            page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  [...ui.root.querySelectorAll('button')].find(button => (button.textContent || '').trim() === '设置').click();
                }
                """
            )
            page.wait_for_selector(".adg-settings-dialog", timeout=5_000)
            settings_state = page.evaluate(
                """
                () => {
                  const dialog = document.querySelector('.adg-dialog');
                  return {
                    sections: dialog?.querySelectorAll('.adg-settings-section').length || 0,
                    viewGrid: Boolean(dialog?.querySelector('.adg-settings-grid')),
                    excludeRow: Boolean(dialog?.querySelector('.adg-settings-inline-row')),
                    footerButtons: [...(dialog?.querySelectorAll('.adg-dialog-actions button') || [])].map(button => (button.textContent || '').trim()),
                  };
                }
                """
            )
            check("设置弹层按功能分区", settings_state["sections"] == 3 and settings_state["viewGrid"] and settings_state["excludeRow"], settings_state)
            check("设置弹层保留明确的取消/应用", settings_state["footerButtons"] == ["取消", "应用"], settings_state)
            page.screenshot(path=str(ROOT / ".scratch" / "tk-gallery-settings-optimized.png"), full_page=True)

            page.screenshot(path=str(ROOT / ".scratch" / "tk-prompt-output.png"), full_page=True)
            check("浏览器无页面异常", not page_errors, page_errors[:5])
            check("浏览器无 console.error", not console_errors, console_errors[:5])
            context.close()


if __name__ == "__main__":
    main()
