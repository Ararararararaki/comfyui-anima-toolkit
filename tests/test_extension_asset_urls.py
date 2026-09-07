"""Regression checks for extension assets across clone directory names."""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_node_stylesheets_resolve_from_the_loaded_extension_module():
    gallery_js = (ROOT / "web" / "js" / "anima_danbooru_gallery_widget.js").read_text(encoding="utf-8")
    clothing_js = (ROOT / "web" / "js" / "anima_clothing_draw_widget.js").read_text(encoding="utf-8")

    assert 'new URL("../css/anima_danbooru_gallery.css", import.meta.url)' in gallery_js
    assert 'new URL("../css/anima_clothing_draw.css", import.meta.url)' in clothing_js
    assert "/extensions/ComfyUI-Anima-Batch-LoRA/css/" not in gallery_js
    assert "/extensions/ComfyUI-Anima-Batch-LoRA/css/" not in clothing_js


if __name__ == "__main__":
    test_node_stylesheets_resolve_from_the_loaded_extension_module()
    print("PASS: extension stylesheet URLs are clone-directory independent")
