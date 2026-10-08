import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

function digest(data) { return createHash('sha256').update(data).digest('hex'); }
function filesIn(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}
export function sourceFingerprint(panelRoot, sharedRoot) {
  const inputs = [
    ...filesIn(join(panelRoot, 'src')).map(path => ['panel/src/' + relative(join(panelRoot, 'src'), path).replaceAll('\\', '/'), path]),
    ...filesIn(join(panelRoot, 'public')).map(path => ['panel/public/' + relative(join(panelRoot, 'public'), path).replaceAll('\\', '/'), path]),
    ...filesIn(sharedRoot).map(path => ['web/js/shared/' + relative(sharedRoot, path).replaceAll('\\', '/'), path]),
    ['panel/index.html', join(panelRoot, 'index.html')],
    ...['vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'].map(name => ['panel/' + name, join(panelRoot, name)]),
    ['panel/build/source_fingerprint.mjs', new URL(import.meta.url)],
  ].sort(([a], [b]) => a.localeCompare(b, 'en'));
  const files = inputs.map(([path, diskPath]) => {
    const bytes = readFileSync(diskPath);
    const normalized = /\.(?:[cm]?[jt]sx?|css|json|html|svg)$/.test(path)
      ? Buffer.from(bytes.toString('utf8').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n')) : bytes;
    return { path, sha256: digest(normalized) };
  });
  return { schema: 1, sha256: digest(JSON.stringify(files)), files };
}
export function sourceFingerprintPlugin(panelRoot, sharedRoot) {
  let start;
  return {
    name: 'tk-source-fingerprint',
    buildStart() { start = sourceFingerprint(panelRoot, sharedRoot); },
    generateBundle() {
      const end = sourceFingerprint(panelRoot, sharedRoot);
      if (start.sha256 !== end.sha256) throw new Error('Panel sources changed during build');
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(end, null, 2) + '\n' });
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , panelRoot, sharedRoot, manifest] = process.argv;
  const actual = JSON.parse(readFileSync(manifest, 'utf8'));
  const expected = sourceFingerprint(resolve(panelRoot), resolve(sharedRoot));
  if (actual.schema !== 1 || actual.sha256 !== expected.sha256 || JSON.stringify(actual.files) !== JSON.stringify(expected.files)) {
    throw new Error('Built panel fingerprint does not match current sources');
  }
  console.log(`PASS panel source fingerprint ${expected.sha256} (${expected.files.length} files)`);
}
