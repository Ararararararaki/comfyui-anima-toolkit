import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';

export async function packagePixivBridge(root) {
  const directory = join(root, 'integrations/pixiv-drop-bridge');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const zip = new JSZip();
  for (const name of readdirSync(directory).sort()) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Unexpected bridge package file: ' + name);
    zip.file(`TK-Pixiv接收桥-${manifest.version}/${name}`, readFileSync(join(directory, name)), { date: new Date('2026-10-17T00:00:00Z'), createFolders: false });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export function pixivBridgePlugin(root) {
  return {
    name: 'tk-pixiv-bridge-package',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'tk-pixiv-drop-bridge.zip', source: await packagePixivBridge(root) });
    },
    configureServer(server) {
      server.middlewares.use('/tk-pixiv-drop-bridge.zip', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        try {
          const bytes = await packagePixivBridge(root);
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Length', bytes.length);
          res.end(bytes);
        } catch (error) { next(error); }
      });
    },
  };
}
