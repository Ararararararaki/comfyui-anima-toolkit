// FileSystemDirectoryHandle manager
// Handles are kept in memory (not IndexedDB) to avoid serialization bugs.
// Directory name is persisted in localStorage for display hints on reload.

const HANDLE_KEYS = {
  comfyBridge: 'anima_comfy_bridge',   // ComfyUI-Anima-Batch-LoRA dir
  scanDir: 'anima_scan_dir',           // Outputs scan dir
  localDir: 'anima_local_dir',         // Local LoRA scan dir
} as const

type HandleKey = keyof typeof HANDLE_KEYS
const store = new Map<HandleKey, FileSystemDirectoryHandle>()

export function getHandle(key: HandleKey): FileSystemDirectoryHandle | null {
  return store.get(key) ?? null
}

export function setHandle(key: HandleKey, dh: FileSystemDirectoryHandle | null) {
  if (dh) {
    store.set(key, dh)
    try { localStorage.setItem(HANDLE_KEYS[key], dh.name) } catch {}
  } else {
    store.delete(key)
    try { localStorage.removeItem(HANDLE_KEYS[key]) } catch {}
  }
}

/** Returns the previously stored directory name (for display), or null */
export function getStoredDirName(key: HandleKey): string | null {
  try { return localStorage.getItem(HANDLE_KEYS[key]) } catch { return null }
}
