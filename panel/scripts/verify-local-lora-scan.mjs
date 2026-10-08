#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const store = readFileSync(resolve(root, 'src/store/localModels.ts'), 'utf8')
const hashing = readFileSync(resolve(root, 'src/services/fileHashWorker.ts'), 'utf8')
const worker = readFileSync(resolve(root, 'src/services/hashWorkerRuntime.ts'), 'utf8')
const shaSource = readFileSync(resolve(root, 'src/services/sha256.ts'), 'utf8')
const scannerSource = readFileSync(resolve(root, 'src/services/localLoraScanner.ts'), 'utf8')
const sessionSource = readFileSync(resolve(root, 'src/services/localScanSession.ts'), 'utf8')
const markup = readFileSync(resolve(root, 'index.html'), 'utf8')

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`PASS ${name}`)
}

assert('扫描使用分块哈希服务', store.includes('hashFileSha256'))
assert('扫描路径不再一次性读取整个模型', !store.includes('const buf = await file.arrayBuffer()'))
assert('哈希服务按 Blob 分块读取', worker.includes('file.slice(offset, end)'))
assert('小文件使用原生摘要加速', worker.includes('crypto.subtle.digest'))
assert('哈希服务支持取消', hashing.includes("type: 'cancel'"))
assert('进度条提供取消按钮', markup.includes('id="localProgressCancel"'))

const require = createRequire(import.meta.url)
const typescript = require('typescript')
function loadExports(source, dependencies = {}) {
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { target: typescript.ScriptTarget.ES2020, module: typescript.ModuleKind.CommonJS },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'exports', 'module', compiled)(name => dependencies[name], module.exports, module)
  return module.exports
}
const { IncrementalSha256 } = loadExports(shaSource)
const hash = (...chunks) => {
  const hasher = new IncrementalSha256()
  for (const chunk of chunks) hasher.update(new TextEncoder().encode(chunk))
  return hasher.digest()
}
assert('SHA-256 空串校验', hash('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
assert('SHA-256 增量校验', hash('a', 'bc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
// Verify the public scan interface without depending on private code location
// or the local-only comprehensive regression suite.
const { LocalScanSession } = loadExports(sessionSource, { './localLoraScanner': loadExports(scannerSource) })
const oldFile = { name: 'same.safetensors', path: 'same.safetensors', size: 32, lastModified: 1,
  sha256: 'cached', matched: true, matchData: { modelName: 'cached match' }, matchError: '', scanning: false }
let snapshot = { files: [oldFile], descriptions: {}, manifest: {
  [oldFile.name]: { name: oldFile.name, size: oldFile.size, lastModified: oldFile.lastModified, sha256: oldFile.sha256 },
} }
const hashes = [], lookupSignals = [], phases = []
const session = new LocalScanSession({
  read: () => snapshot,
  commit: update => { snapshot = { ...snapshot, ...update } },
  hash: async file => { hashes.push({ name: file.name, phase: phases.at(-1) }); return 'new hash' },
  match: async (_hash, signal) => { lookupSignals.push(signal); return { modelName: 'new match' } },
  persist: () => {}, removePreviews: () => {},
})
session.subscribe(progress => phases.push(progress.status))
await session.run({ kind: 'scan', list: async () => ({ directory: 'models', entries: [
  { name: oldFile.name, file: { name: oldFile.name, size: oldFile.size, lastModified: oldFile.lastModified } },
  { name: 'large.safetensors', file: { name: 'large.safetensors', size: 600 * 1024 * 1024, lastModified: 1 } },
] }) })
assert('增量扫描复用已缓存哈希与匹配', snapshot.files[0].sha256 === 'cached' && snapshot.files[0].matchData.modelName === 'cached match')
assert('超大文件在匹配阶段哈希', hashes.length === 1 && hashes[0].name === 'large.safetensors' && hashes[0].phase === 'matching')
assert('匹配请求接收取消信号', lookupSignals.length === 1 && lookupSignals[0] instanceof AbortSignal)
assert('扫描完成提交 manifest', snapshot.manifest['large.safetensors'].sha256 === 'new hash' && phases.at(-1) === 'done')
console.log('ALL PASS')
