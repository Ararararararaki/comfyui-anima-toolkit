"""TK D站画廊：多个节点的设置必须按节点实例隔离。"""
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "web" / "js" / "anima_danbooru_gallery_widget.js"


def test_gallery_settings_use_node_scoped_storage_key():
    js = SOURCE.read_text(encoding="utf-8")
    load_start = js.index("function loadSettings")
    constructor_start = js.index("class DanbooruGalleryUI")
    settings_code = js[load_start:constructor_start]
    # ⚠️ 必须锚定**方法定义**：`saveSettings()` 也会作为调用点出现在别处
    # （如 discoverRandom 里），裸 index('saveSettings()') 会命中调用点而不是定义，
    # 抽出错误的区间导致误报（2026-09-13 新增随机发现后踩到）。
    save_start = js.index("\n    saveSettings() {")
    save_end = js.index("applyGridHeight()", save_start)
    save_code = js[save_start:save_end]
    assert "localStorage.setItem(this.settingsKey()" in save_code

    assert "STORAGE_KEY_PREFIX" in js
    assert "function loadSettings(nodeId)" in settings_code
    assert "getNodeStorageKey(nodeId)" in settings_code
    assert "localStorage.getItem(STORAGE_KEY)" not in settings_code
    assert "this.settings = loadSettings(node.id)" in js
    assert "WORKFLOW_SETTINGS_PROPERTY" in js
    assert "this.node.properties[WORKFLOW_SETTINGS_PROPERTY] = serialized" in save_code
    assert "nodeType.prototype.onConfigure" in js
    assert "loadWorkflowSettings()" in js


if __name__ == "__main__":
    test_gallery_settings_use_node_scoped_storage_key()
    print("PASS: Danbooru gallery settings are node-scoped")
