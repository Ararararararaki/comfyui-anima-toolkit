"""Static regression checks for TK D gallery image rendering efficiency."""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "js" / "anima_danbooru_gallery_widget.js"
STYLES = ROOT / "web" / "css" / "anima_danbooru_gallery.css"
BACKEND = ROOT / "anima_danbooru_gallery.py"


def test_gallery_reserves_masonry_space_and_loads_images_against_internal_viewport():
    js = SOURCE.read_text(encoding="utf-8")
    css = STYLES.read_text(encoding="utf-8")

    assert "grid-auto-rows: 10px" in css
    assert "grid-row-end: span 1" in css
    assert "this.imageLoadObserver = new IntersectionObserver" in js
    assert "root: this.grid" in js
    assert 'rootMargin: "260px 0px"' in js
    assert "this.setupImageLoading()" in js
    assert "preview.dataset.src" in js
    assert "preview.width = imageWidth" in js
    assert "this.scheduleMasonryLayout()" in js


def test_gallery_image_proxy_has_bounded_concurrency_and_day_cache():
    py = BACKEND.read_text(encoding="utf-8")

    assert "IMAGE_PROXY_CONCURRENCY = 3" in py
    assert "async with _get_image_proxy_semaphore()" in py
    assert '"Cache-Control": "public, max-age=86400"' in py


if __name__ == "__main__":
    test_gallery_reserves_masonry_space_and_loads_images_against_internal_viewport()
    test_gallery_image_proxy_has_bounded_concurrency_and_day_cache()
    print("PASS: Danbooru gallery image efficiency safeguards")
