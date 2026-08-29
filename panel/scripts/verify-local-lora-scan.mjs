#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const store = readFileSync(resolve(root, 'src/store/localModels.ts'), 'utf8')
const hashing = readFileSync(resolve(root, 'src/services/fileHashWorker.ts'), 'utf8')
const worker = readFileSync(resolve(root, 'src/services/hashWorkerRuntime.ts'), 'utf8')
const shaSource = readFileSync(resolve(root, 'src/services/sha256.ts'), 'utf8')
const markup = readFileSync(resolve(root, 'index.html'), 'utf8')

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`PASS ${name}`)
}

assert('扫描使用分块哈希服务', store.includes('hashFileSha256'))
assert('扫描路径不再一次性读取整个模型', !store.includes('const buf = await file.arrayBuffer()'))
assert('保留按大小和时间的增量判断', store.includes('cached.size === file.size && cached.lastModified === file.lastModified'))
assert('增量扫描复用已缓存 SHA-256', store.includes('sha256: cached.sha256') && store.includes('newManifest[relativeName] = { ...cached, name: relativeName }'))
assert('超大文件延后精确哈希', store.includes('LARGE_HASH_DEFER_BYTES') && store.includes('file.size > LARGE_HASH_DEFER_BYTES'))
assert('哈希服务按 Blob 分块读取', worker.includes('file.slice(offset, end)'))
assert('小文件使用原生摘要加速', worker.includes('crypto.subtle.digest'))
assert('哈希服务支持取消', hashing.includes("type: 'cancel'"))
assert('进度条提供取消按钮', markup.includes('id="localProgressCancel"'))

const require = createRequire(import.meta.url)
const typescript = require('typescript')
const compiled = typescript.transpileModule(shaSource, {
  compilerOptions: { target: typescript.ScriptTarget.ES2020, module: typescript.ModuleKind.CommonJS },
}).outputText
const module = { exports: {} }
new Function('exports', 'module', compiled)(module.exports, module)
const { IncrementalSha256 } = module.exports
const hash = (...chunks) => {
  const hasher = new IncrementalSha256()
  for (const chunk of chunks) hasher.update(new TextEncoder().encode(chunk))
  return hasher.digest()
}
assert('SHA-256 空串校验', hash('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
assert('SHA-256 增量校验', hash('a', 'bc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
console.log('ALL PASS')
