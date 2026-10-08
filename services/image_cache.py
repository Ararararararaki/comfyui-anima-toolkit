"""One bounded image cache shared by proxy routes and gallery adapters."""
from collections import OrderedDict
import threading


class ImageCache:
    def __init__(self, max_items=200, max_bytes=256 * 1024 * 1024, max_item_bytes=16 * 1024 * 1024):
        self._items = OrderedDict()
        self._bytes = 0
        self._lock = threading.RLock()
        self.max_items, self.max_bytes, self.max_item_bytes = max_items, max_bytes, max_item_bytes

    def get(self, key):
        with self._lock:
            return self._items.get(key)

    def store(self, key, body, content_type):
        if len(body) > min(self.max_item_bytes, self.max_bytes):
            return
        with self._lock:
            previous = self._items.pop(key, None)
            if previous:
                self._bytes -= len(previous[0])
            while self._items and (len(self._items) >= self.max_items or self._bytes + len(body) > self.max_bytes):
                _, old = self._items.popitem(last=False)
                self._bytes -= len(old[0])
            self._items[key] = (body, content_type)
            self._bytes += len(body)


image_cache = ImageCache()
