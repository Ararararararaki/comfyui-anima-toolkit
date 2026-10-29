"""Package corresponding editor source for legacy updaters that only accept web/."""
from pathlib import Path
import hashlib
import json
import zipfile

vendor = Path(__file__).resolve().parent
root = vendor.parent.parent
destination = root / 'web/licenses/moss-layout-studio-source.zip'
files = [p for p in vendor.rglob('*') if p.is_file() and not any(
    part in {'node_modules', 'web', '.git', '__pycache__'} for part in p.relative_to(vendor).parts)]
files += [root/'LICENSE', root/'licenses/Toolkit-original-MIT.txt', root/'licenses/README.md']
bundle = root/'web/js/vendor/moss_layout_studio/studio.js'
assert bundle.is_file()
destination.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(files):
        # Deterministic metadata: rebuilding unchanged source gives the same ZIP.
        info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 10, 27, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, path.read_bytes())
    info = zipfile.ZipInfo('BUILD-INFO.json', (2026, 10, 27, 0, 0, 0))
    archive.writestr(info, json.dumps({'bundle':bundle.relative_to(root).as_posix(),
        'sha256':hashlib.sha256(bundle.read_bytes()).hexdigest()}, indent=2))
print(f'Corresponding source: {destination} ({destination.stat().st_size} bytes)')
