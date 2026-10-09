// Browser choices belong to a workflow and gallery instance. A workflow's saved
// settings remain the fallback for a browser that has never used that gallery.
const PREFIX = 'anima.gallery.source.v1:';
const key = (workflow, node) => PREFIX + JSON.stringify([String(workflow), String(node)]);

export function loadGallerySourcePreference(storage, workflow, node) {
  try { return storage.getItem(key(workflow, node)) || ''; }
  catch { return ''; }
}

export function saveGallerySourcePreference(storage, workflow, node, source) {
  try { storage.setItem(key(workflow, node), String(source)); }
  catch { /* A blocked browser store must not prevent switching sources. */ }
}
