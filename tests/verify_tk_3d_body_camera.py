"""在真实 ComfyUI 页面验证 TK 可动素体相机（Chrome + Edge）。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


NODE_NAME = "TK 3D Body Camera"


def run_browser(browser_type, executable: str, base_url: str, screenshot: Path) -> dict:
    errors: list[str] = []
    browser = browser_type.launch(
        headless=True,
        executable_path=executable,
        args=["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader"],
    )
    page = browser.new_page(viewport={"width": 1440, "height": 1400}, device_scale_factor=1)
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    # ComfyUI 当前工作区本身会加载一些缺失的第三方扩展；只收集本节点相关错误，
    # 避免把环境基线噪音误判为新节点回归失败。
    page.on("console", lambda message: errors.append(f"console: {message.text}") if message.type == "error" and any(key in message.text.lower() for key in ("tk-3d-body-camera", "anima_3d_body_camera", "three.module.js")) else None)
    try:
        page.goto(base_url, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("(name) => Boolean(window.LiteGraph?.registered_node_types?.[name])", arg=NODE_NAME, timeout=30_000)
        page.wait_for_timeout(2500)
        page.evaluate(
            """(name) => {
                const api = window.comfyAPI?.app?.app || window.app;
                const node = window.LiteGraph.createNode(name);
                if (!api?.graph || !node) throw new Error('无法创建新节点');
                api.graph.clear();
                node.pos = [100, 100];
                api.graph.add(node);
                window.__tk3dCreatedNode = node;
            }""",
            NODE_NAME,
        )
        page.wait_for_selector(".tk-3d-body-camera-ui", state="attached", timeout=10_000)
        page.wait_for_function("() => document.querySelector('[data-status]')?.textContent.includes('就绪')", timeout=30_000)
        page.screenshot(path=str(screenshot), full_page=False)

        initial = page.evaluate(
            """(name) => {
                const api = window.comfyAPI?.app?.app || window.app;
                const node = api.graph._nodes.find((item) => item.type === name);
                const ui = node._tk3dBodyCamera;
                const root = document.querySelector('.tk-3d-body-camera-ui');
                const viewport = root.querySelector('[data-viewport]');
                return {
                    status: root.querySelector('[data-status]')?.textContent,
                    joints: root.querySelectorAll('[data-joint] option').length,
                    axisControls: root.querySelectorAll('[data-axis]').length,
                    hasCanvas: Boolean(root.querySelector('canvas')),
                    rootHeight: root.getBoundingClientRect().height,
                    viewportHeight: viewport.getBoundingClientRect().height,
                    nodeSize: node.size,
                    widgetSizes: (node.widgets || []).map((widget) => ({ name: widget.name, size: widget.computeSize?.(node.size?.[0]) })),
                    ancestors: (() => { const list=[]; let el=root; for(let i=0; el && i<5; i++,el=el.parentElement){ const r=el.getBoundingClientRect(); list.push({tag:el.tagName, cls:String(el.className||''), h:r.height, display:getComputedStyle(el).display, overflow:getComputedStyle(el).overflow}); } return list; })(),
                    gridChildren: [...root.parentElement.parentElement.children].map((el) => ({ cls: String(el.className || ''), h: el.getBoundingClientRect().height, text: (el.textContent || '').trim().slice(0, 40) })),
                    live: Object.fromEntries([...root.querySelectorAll('[data-camera-live]')].map((item) => [item.dataset.cameraLive, item.textContent])),
                    weightControls: root.querySelectorAll('[data-prompt-weight]').length,
                    weightInputs: root.querySelectorAll('[data-prompt-weight-number]').length,
                    promptPreview: root.querySelector('[data-prompt-preview]')?.textContent,
                    distanceCategories: [...root.querySelectorAll('[data-distance-category]')].map((item) => item.textContent),
                    distanceOutput: root.querySelector('[data-camera-output="pz"]')?.textContent,
                    state: { px: ui.state.px, py: ui.state.py, pz: ui.state.pz, fov: ui.state.fov, arm: ui.state.pose.left_shoulder.z },
                };
            }""",
            NODE_NAME,
        )
        if initial["joints"] != 13 or initial["axisControls"] != 3 or not initial["hasCanvas"]:
            raise AssertionError(f"素体 UI 未完整挂载: {initial}")
        if not all(initial["live"].get(key) for key in ("yaw", "pitch", "roll", "distance", "fov")):
            raise AssertionError(f"实时相机参数没有显示: {initial['live']}")
        if initial["weightControls"] != 4 or initial["weightInputs"] != 4 or "from front" not in (initial["promptPreview"] or ""):
            raise AssertionError(f"BSK 提示词权重面板没有完整显示: {initial['weightControls']}, {initial['weightInputs']}, {initial['promptPreview']}")
        if initial["distanceCategories"] != ["远景", "全身", "中景", "近景", "特写"] or "中景" not in (initial["distanceOutput"] or "") or "权重 1.00" not in (initial["distanceOutput"] or ""):
            raise AssertionError(f"距离五档/当前权重显示异常: {initial['distanceCategories']}, {initial['distanceOutput']}")

        canvas = page.locator(".tk-3d-body-camera-canvas")
        box = canvas.bounding_box()
        if not box or box["width"] < 100 or box["height"] < 100:
            raise AssertionError(f"3D 画布尺寸异常: {box}")

        # 画布拖拽验证相机 yaw/pitch，滚轮验证距离。
        # 从模型外的空白区域拖拽，避免命中根部关节而进入 FK 操作。
        camera_start = {"x": box["x"] + box["width"] * 0.12, "y": box["y"] + box["height"] * 0.18}
        page.mouse.move(camera_start["x"], camera_start["y"])
        page.mouse.down()
        page.mouse.move(camera_start["x"] + box["width"] * 0.22, camera_start["y"] - box["height"] * 0.16)
        page.mouse.up()
        after_camera_drag = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state", NODE_NAME)
        if after_camera_drag["px"] == initial["state"]["px"] and after_camera_drag["py"] == initial["state"]["py"]:
            raise AssertionError(f"画布拖拽没有改变相机: {initial['state']} -> {after_camera_drag}")
        if after_camera_drag["px"] >= initial["state"]["px"] or after_camera_drag["py"] >= initial["state"]["py"]:
            raise AssertionError(f"画布拖拽方向仍然反向: {initial['state']} -> {after_camera_drag}")
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.wheel(0, 120)
        after_wheel = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state.pz", NODE_NAME)
        if after_wheel == after_camera_drag["pz"]:
            wheel_debug = page.evaluate("""() => { const c = document.querySelector('.tk-3d-body-camera-canvas'); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: {w:r.width,h:r.height}, top: document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).slice(0,4).map(x=>x.className||x.tagName), overflow: getComputedStyle(c).pointerEvents, nodeState: (window.comfyAPI?.app?.app || window.app).graph._nodes.at(-1)._tk3dBodyCamera.state }; }""")
            raise AssertionError(f"滚轮没有改变距离: {wheel_debug}")
        # deltaY 为正代表向下滚；按常见缩放手感，向下滚应远离模型，
        # 即 pos_z 变小（实际距离 = 5 - pos_z * 3.4 变大）。
        if after_wheel >= after_camera_drag["pz"]:
            raise AssertionError(f"滚轮距离方向反了：向下滚应远离模型: {after_camera_drag['pz']} -> {after_wheel}")
        after_wheel_output = page.locator('[data-camera-output="pz"]').inner_text()
        if "全身" not in after_wheel_output or after_wheel_output == initial["distanceOutput"]:
            raise AssertionError(f"距离滑块没有切换五档或权重没有随滑块变化: {after_wheel_output}")

        # 最远机位必须能在画布内完整容纳低模素体，并同步显示实时距离。
        page.locator('[data-camera-preset]').select_option("远景")
        page.wait_for_timeout(100)
        far_frame = page.evaluate(
            """(name) => {
                const node = (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name);
                const ui = node._tk3dBodyCamera;
                const bounds = new ui.THREE.Box3().setFromObject(ui.modelRoot);
                const points = [];
                for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
                    points.push(new ui.THREE.Vector3(x, y, z).project(ui.displayCamera));
                }
                return { pz: ui.state.pz, distance: document.querySelector('[data-camera-live="distance"]').textContent, maxX: Math.max(...points.map((point) => Math.abs(point.x))), maxY: Math.max(...points.map((point) => Math.abs(point.y))) };
            }""",
            NODE_NAME,
        )
        if far_frame["pz"] != -1 or float(far_frame["distance"]) < 8 or far_frame["maxX"] >= 0.95 or far_frame["maxY"] >= 0.95:
            raise AssertionError(f"最远机位未完整显示素体或实时距离异常: {far_frame}")

        # FOV 输入同步到节点原生 widget。
        page.locator('[data-camera="fov"]').fill("72")
        fov_state = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state.fov", NODE_NAME)
        if fov_state != 72:
            raise AssertionError(f"FOV 没有同步: {fov_state}")

        # 方位独立权重 + 统一距离权重既要实时显示，也要写回节点 config，供后端 BSK 算法执行。
        page.locator('[data-camera-preset]').select_option("中景")
        page.locator('[data-prompt-weight="azimuth.weight"]').fill("1.3")
        page.locator('[data-prompt-weight-number="distance.weight"]').fill("0.7")
        page.locator('[data-prompt-weight-number="distance.weight"]').press("Enter")
        prompt_weight_state = page.evaluate(
            """(name) => {
                const node = (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name);
                const ui = node._tk3dBodyCamera;
                const config = JSON.parse(node.widgets.find((widget) => widget.name === 'config').value);
                return {
                    azimuth: config.azimuth.weight,
                    distance: config.distance.weight,
                    preview: document.querySelector('[data-prompt-preview]')?.textContent,
                    distanceOutput: document.querySelector('[data-camera-output="pz"]')?.textContent,
                    distanceMeta: ui._readPromptConfig().distance,
                };
            }""",
            NODE_NAME,
        )
        if prompt_weight_state["azimuth"] != 1.3 or prompt_weight_state["distance"] != 0.7 or "1.30" not in (prompt_weight_state["preview"] or "") or "中景" not in (prompt_weight_state["distanceOutput"] or "") or "0.70" not in (prompt_weight_state["distanceOutput"] or "") or not prompt_weight_state["distanceMeta"].get("follow_slider"):
            raise AssertionError(f"独立权重没有同步到 config/BSK 预览: {prompt_weight_state}")

        # 关节选择 + XYZ 控件验证 FK 状态链路。
        page.locator("[data-joint]").select_option("left_elbow")
        page.locator('[data-axis="x"]').fill("35")
        pose_after_axis = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state.pose.left_elbow.x", NODE_NAME)
        if pose_after_axis != 35:
            raise AssertionError(f"关节 X 轴没有同步: {pose_after_axis}")

        # 直接点击模型关节并拖拽，验证鼠标 FK 入口（命中点从 Three 场景投影得到）。
        joint_point = page.evaluate(
            """(name) => {
                const node = (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name);
                const ui = node._tk3dBodyCamera;
                const joint = ui.jointMap.get('left_elbow');
                const world = new ui.THREE.Vector3(); joint.getWorldPosition(world); world.project(ui.displayCamera);
                const rect = ui.canvas.getBoundingClientRect();
                return { x: rect.left + (world.x + 1) * rect.width / 2, y: rect.top + (-world.y + 1) * rect.height / 2 };
            }""",
            NODE_NAME,
        )
        before_joint_drag = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state.pose.left_elbow.y", NODE_NAME)
        page.mouse.move(joint_point["x"], joint_point["y"])
        page.mouse.down()
        page.mouse.move(joint_point["x"] + 24, joint_point["y"] - 14)
        page.mouse.up()
        after_joint_drag = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state.pose.left_elbow.y", NODE_NAME)
        if after_joint_drag == before_joint_drag:
            raise AssertionError(f"鼠标关节拖拽没有改变 FK 状态: {before_joint_drag} -> {after_joint_drag}")

        # 保存/修改/恢复姿势。
        saved_left_elbow_x = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state.pose.left_elbow.x", NODE_NAME)
        page.locator("[data-pose-name]").fill("回归姿势")
        page.locator('[data-pose-action="save"]').click()
        page.locator('[data-axis="x"]').fill("-40")
        page.locator('[data-pose-action="restore"]').click()
        restored = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state.pose.left_elbow.x", NODE_NAME)
        if restored != saved_left_elbow_x:
            raise AssertionError(f"姿势恢复不正确: {restored}")

        page.locator('[data-pose="reset"]').click()
        reset_state = page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name)._tk3dBodyCamera.state.pose.left_shoulder.z", NODE_NAME)
        if reset_state != -28:
            raise AssertionError(f"重置姿势不正确: {reset_state}")

        page.evaluate("(name) => (window.comfyAPI?.app?.app || window.app).graph._nodes.find((item) => item.type === name).setSize([520, 520])", NODE_NAME)
        page.wait_for_timeout(250)
        resized = page.evaluate("() => { const root = document.querySelector('.tk-3d-body-camera-ui'); const viewport = root.querySelector('[data-viewport]'); const node = (window.comfyAPI?.app?.app || window.app).graph._nodes.at(-1); return { root: root.getBoundingClientRect().height, viewport: viewport.getBoundingClientRect().height, nodeHeight: node.size[1] }; }")
        if resized["viewport"] <= 0 or resized["root"] <= resized["viewport"] or resized["root"] >= initial["rootHeight"] or resized["nodeHeight"] >= initial["nodeSize"][1]:
            raise AssertionError(f"节点尺寸同步异常: {resized}")

        # 删除节点后，资源/状态对象应标记为已释放。
        disposed = page.evaluate(
            """(name) => {
                const api = window.comfyAPI?.app?.app || window.app;
                const node = api.graph._nodes.find((item) => item.type === name);
                node.onRemoved();
                return node._tk3dBodyCamera.disposed;
            }""",
            NODE_NAME,
        )
        if not disposed:
            raise AssertionError("节点删除后没有释放前端资源")
        if errors:
            raise AssertionError("浏览器控制台存在错误: " + " | ".join(errors))
        return {"browser": browser_type.name, "initial": initial, "afterCameraDrag": after_camera_drag, "afterWheel": after_wheel, "fov": fov_state, "promptWeights": prompt_weight_state, "jointBefore": before_joint_drag, "jointAfter": after_joint_drag, "resized": resized, "disposed": disposed}
    finally:
        browser.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8188")
    parser.add_argument("--chrome", default="C:/Program Files/Google/Chrome/Application/chrome.exe")
    parser.add_argument("--edge", default="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    parser.add_argument("--output", default="C:/Users/Toki/AppData/Local/Temp/tk-3d-body-camera-regression.json")
    args = parser.parse_args()
    output = Path(args.output)
    with sync_playwright() as playwright:
        results = []
        for name, executable in (("Chrome", args.chrome), ("Edge", args.edge)):
            shot = output.with_name(f"{output.stem}-{name.lower()}.png")
            result = run_browser(playwright.chromium, executable, args.url, shot)
            result["browser"] = name
            results.append(result)
    output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps([{
        "browser": result["browser"],
        "initial_node": result["initial"]["nodeSize"],
        "wheel_pz": result["afterWheel"],
        "fov": result["fov"],
        "prompt_weights": result["promptWeights"],
        "joint_delta": result["jointAfter"] - result["jointBefore"],
        "resized_node": result["resized"]["nodeHeight"],
        "disposed": result["disposed"],
    } for result in results], ensure_ascii=False))


if __name__ == "__main__":
    main()
