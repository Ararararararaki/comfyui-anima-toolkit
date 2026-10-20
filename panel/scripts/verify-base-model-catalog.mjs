#!/usr/bin/env node

/**
 * 底模口径一致性校验（2026-10-19 随 MOSS 底模拓展建立）。
 *
 * 三处最容易静默漂移、而且 tsc 一个错都不会报的地方：
 *   ① index.html 的基座下拉  vs  src/services/baseModelCatalog.ts 的 BASE_MODEL_OPTIONS
 *      —— 漏一项只是少一个可筛选底模，运行时毫无提示；
 *   ② 本地 ss_base_model_version 的归一化 —— 实测同一底模存在大小写/写法差异（krea2 vs KREA2）；
 *   ③ src/store/models.ts 选 LoRA 版本的底模硬编码（曾写死 'Anima'，筛 MOSS 时仍会挑 Anima 版本）。
 *
 * 另含 MOSS 的取值本身：Civitai 用的是**带空格**的 "MOSS Image" / "MOSS Image Base"，
 * 写成 MOSS / MOSS-Image 都会安静地返回 0 条结果，所以这里把字面量钉死。
 */

import { readFileSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = path => readFileSync(resolve(root, path), 'utf8')

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`PASS ${name}`)
}

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

const catalogSource = read('src/services/baseModelCatalog.ts')
const catalog = loadExports(catalogSource)
const metaSource = read('src/services/safetensorsMeta.ts')
const { readSafetensorsLoraMeta, isSafetensorsName } = loadExports(metaSource, { './baseModelCatalog': catalog })
const { BASE_MODEL_OPTIONS, normalizeLocalBaseModel, resolveFileBaseModel, baseModelKey } = catalog

// ── ① index.html 下拉与 BASE_MODEL_OPTIONS 逐项一致 ──────────────────────────
const markup = read('index.html')
const selectMatch = markup.match(/<select id="baseModelFilter"[\s\S]*?<\/select>/)
assert('index.html 存在基座下拉', !!selectMatch)
const select = selectMatch[0]

assert('下拉保留「全部基座」空值项', /<option value=""[^>]*>[^<]*全部基座<\/option>/.test(select))

const optionValues = [...select.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(Boolean)
const expectedValues = BASE_MODEL_OPTIONS.map(o => o.value)
assert('下拉选项值与 BASE_MODEL_OPTIONS 完全一致（含顺序）',
  optionValues.join('|') === expectedValues.join('|'),
  `下拉=${optionValues.join('|')} / 目录=${expectedValues.join('|')}`)

for (const option of BASE_MODEL_OPTIONS) {
  // 注意 [^>]* ：默认选中项写作 <option value="Anima" selected>，不能假设 value 后直接跟 >
  const line = new RegExp(`<option value="${option.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([^<]*)</option>`)
  const match = select.match(line)
  assert(`下拉项「${option.value}」文案一致`, !!match && match[1].trim() === option.label,
    match ? `实际=${match[1].trim()} 期望=${option.label}` : '未找到该选项')
}

// ── ② MOSS 取值字面量（Civitai 口径，带空格）────────────────────────────────
assert('目录含 MOSS Image', expectedValues.includes('MOSS Image'))
assert('目录含 MOSS Image Base', expectedValues.includes('MOSS Image Base'))
assert('MOSS 取值不带连字符（实测 MOSS-Image 返回 0 条）',
  !expectedValues.some(v => /moss-/i.test(v)))
assert('两个 MOSS 项是独立单选值（Civitai baseModels 不接受逗号多值）',
  !expectedValues.some(v => v.includes(',')))

// ── ③ 本地元数据归一化 ───────────────────────────────────────────────────────
assert('归一化忽略大小写/下划线/连字符/空格',
  baseModelKey('moss_image') === baseModelKey('MOSS IMAGE') &&
  baseModelKey('Krea 2') === baseModelKey('krea2') &&
  baseModelKey('krea2') === baseModelKey('krea-2'))

assert('moss_image → MOSS Image', normalizeLocalBaseModel('moss_image') === 'MOSS Image')
assert('MOSS_IMAGE（大写）→ MOSS Image', normalizeLocalBaseModel('MOSS_IMAGE') === 'MOSS Image')
assert('moss_image_base → MOSS Image Base', normalizeLocalBaseModel('moss_image_base') === 'MOSS Image Base')
assert('anima → Anima', normalizeLocalBaseModel('anima') === 'Anima')
// 实测本机同时存在 krea2 与 KREA2 两种写法，必须归成同一个底模，否则「按底模」面板会出现两行
assert('krea2 / KREA2 归一化到同一项',
  normalizeLocalBaseModel('krea2') === 'Krea 2' && normalizeLocalBaseModel('KREA2') === 'Krea 2')
assert('sdxl_base_v1-0 → SDXL 1.0（本地下拉外底模）',
  normalizeLocalBaseModel('sdxl_base_v1-0') === 'SDXL 1.0')
assert('空值与未知值不臆造底模',
  normalizeLocalBaseModel('') === '' && normalizeLocalBaseModel('   ') === '' &&
  normalizeLocalBaseModel('some_unknown_base') === '')

// ── ④ 合并口径：C 站匹配优先，其次本地元数据 ─────────────────────────────────
assert('C 站值优先于本地值',
  resolveFileBaseModel('MOSS Image Base', 'MOSS Image') === 'MOSS Image Base')
assert('无 C 站值时回退本地元数据',
  resolveFileBaseModel('', 'MOSS Image') === 'MOSS Image' &&
  resolveFileBaseModel(null, 'Anima') === 'Anima')
assert('两者都无时为空串（= 未匹配）',
  resolveFileBaseModel(undefined, undefined) === '' && resolveFileBaseModel('', '') === '')

// ── ⑤ safetensors 头部读取 ──────────────────────────────────────────────────
function fakeSafetensors(metadata, { declaredLength, rawHeader } = {}) {
  const headerBytes = Buffer.from(JSON.stringify(rawHeader ?? { __metadata__: metadata }), 'utf8')
  const lengthField = Buffer.alloc(8)
  lengthField.writeBigUInt64LE(BigInt(declaredLength ?? headerBytes.length))
  const buf = Buffer.concat([lengthField, headerBytes, Buffer.alloc(16)])
  return {
    size: buf.length,
    slice: (start, end) => ({
      arrayBuffer: async () => {
        const sub = buf.subarray(start, end)
        return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength)
      },
    }),
  }
}

const mossFile = fakeSafetensors({ ss_base_model_version: 'moss_image', ss_output_name: 'anireal_moss_lora_v1' })
const mossMeta = await readSafetensorsLoraMeta(mossFile, { fileName: 'anireal_moss_lora_v1.safetensors' })
assert('读出头部的 MOSS 底模并归一化',
  !!mossMeta && mossMeta.baseModelVersion === 'moss_image' && mossMeta.baseModel === 'MOSS Image',
  JSON.stringify(mossMeta))

const rawFile = fakeSafetensors({ ss_network_dim: '32' })
const rawMeta = await readSafetensorsLoraMeta(rawFile, { fileName: 'converted.safetensors' })
assert('头部无底模字段时不臆造（返回空 baseModel）',
  !!rawMeta && rawMeta.baseModel === '' && rawMeta.baseModelVersion === '')

// 合并 / 部分转换工具产出的 LoRA 头部**根本没有 __metadata__**（本机 371 个里有 14 个）。
// 这是正常文件，不是读取失败 —— 必须返回空读数，否则界面会把「没写元数据」误报成损坏。
const headerlessMeta = await readSafetensorsLoraMeta(
  fakeSafetensors(null, { rawHeader: { 'tensor.a': { dtype: 'F32', shape: [1], data_offsets: [0, 4] } } }),
  { fileName: 'merged.safetensors' })
assert('头部无 __metadata__ 时返回空读数而非 null（区分「没写元数据」与「读不了」）',
  !!headerlessMeta && headerlessMeta.baseModelVersion === '' && headerlessMeta.baseModel === '',
  JSON.stringify(headerlessMeta))

assert('非 safetensors 直接跳过', !isSafetensorsName('a.pt') && isSafetensorsName('a.safetensors'))
assert('非 safetensors 文件返回 null',
  (await readSafetensorsLoraMeta(fakeSafetensors({ ss_base_model_version: 'moss_image' }), { fileName: 'a.pt' })) === null)

const brokenLength = fakeSafetensors({ ss_base_model_version: 'moss_image' }, { declaredLength: 1 << 40 })
assert('头部长度异常（超上限）返回 null 而非抛错', (await readSafetensorsLoraMeta(brokenLength, { fileName: 'x.safetensors' })) === null)
assert('头部长度超出文件大小返回 null', (await readSafetensorsLoraMeta(
  fakeSafetensors({ a: 'b' }, { declaredLength: 4096 }), { fileName: 'x.safetensors' })) === null)
assert('空文件/无 slice 能力返回 null',
  (await readSafetensorsLoraMeta({ size: 0 }, { fileName: 'x.safetensors' })) === null &&
  (await readSafetensorsLoraMeta(null, { fileName: 'x.safetensors' })) === null)

// ── ⑥ 选版本不再硬编码 Anima ────────────────────────────────────────────────
const modelStore = read('src/store/models.ts')
assert('models.ts 不再把底模硬编码成 Anima 选版本',
  !/baseModel === 'Anima'/.test(modelStore),
  '仍存在 baseModel === \'Anima\'，筛 MOSS 时会挑到 Anima 版本')

console.log('ALL PASS')

// ── ⑦ 可选：真实 LoRA 库端到端（LORA_DIR=<绝对路径> 时启用）──────────────────
// 逻辑断言只能证明口径自洽；这一节用**真实文件头**跑一遍「后端读头部 → 前端归一化 → 按底模计数」，
// 回答真正要验证的问题：本机的 MOSS LoRA 到底能不能被筛出来、有几个。
// 默认不跑（CI / 其他机器没有这个目录），只读文件、不写任何东西。
const loraDir = process.env.LORA_DIR
if (!loraDir) {
  console.log('SKIP 真实库校验（未设置 LORA_DIR）')
} else {
  console.log(`\n── 真实库端到端：${loraDir}`)
  const walk = dir => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (entry.name.toLowerCase().endsWith('.safetensors')) out.push(full)
    }
    return out
  }

  // 只把头部切进 Blob 交给真实模块，避免把上百 MB 权重读进内存。
  // 注意 Blob 必须覆盖 [0, headerEnd)：模块内部有 `8 + headerLength > file.size` 的越界检查。
  // readSync 不保证一次读满（头部可达数百 KB），必须循环读 —— 否则大批文件会被误判为「读取失败」。
  const readFully = (fd, buf, position) => {
    let offset = 0
    while (offset < buf.length) {
      const read = readSync(fd, buf, offset, buf.length - offset, position + offset)
      if (read <= 0) return false
      offset += read
    }
    return true
  }
  const readHeaderBlob = path => {
    const fd = openSync(path, 'r')
    try {
      const lengthField = Buffer.alloc(8)
      if (!readFully(fd, lengthField, 0)) return null
      const headerLength = Number(lengthField.readBigUInt64LE(0))
      if (!Number.isFinite(headerLength) || headerLength <= 0 || headerLength > 16 * 1024 * 1024) return null
      const buf = Buffer.alloc(8 + headerLength)
      if (!readFully(fd, buf, 0)) return null
      return new Blob([buf])
    } finally { closeSync(fd) }
  }

  const baseCounts = new Map()
  const samples = new Map()
  let total = 0, unreadable = 0, noMeta = 0
  const byOriginalValue = new Map()

  for (const file of walk(loraDir)) {
    total++
    const blob = readHeaderBlob(file)
    const meta = blob ? await readSafetensorsLoraMeta(blob, { fileName: file }) : null
    if (!meta) { unreadable++; baseCounts.set('（读取失败）', (baseCounts.get('（读取失败）') || 0) + 1); continue }
    if (meta.baseModelVersion) byOriginalValue.set(meta.baseModelVersion, (byOriginalValue.get(meta.baseModelVersion) || 0) + 1)
    if (!meta.baseModel) { noMeta++; baseCounts.set('（无底模元数据）', (baseCounts.get('（无底模元数据）') || 0) + 1); continue }
    baseCounts.set(meta.baseModel, (baseCounts.get(meta.baseModel) || 0) + 1)
    if (!samples.has(meta.baseModel)) samples.set(meta.baseModel, file.replace(loraDir, '').replace(/^[\\/]/, ''))
  }

  console.log(`  扫描 safetensors：${total} 个（读取失败 ${unreadable} / 无底模字段 ${noMeta}）`)
  console.log('  归一化后的底模分布：')
  for (const [name, count] of [...baseCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const sample = samples.get(name)
    console.log(`    ${String(count).padStart(4)}  ${name}${sample ? `   e.g. ${sample}` : ''}`)
  }
  console.log('  ss_base_model_version 原值（体现归一化的必要性）：')
  for (const [raw, count] of [...byOriginalValue.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${raw}  →  ${normalizeLocalBaseModel(raw) || '（未识别）'}`)
  }
  const mossCount = (baseCounts.get('MOSS Image') || 0) + (baseCounts.get('MOSS Image Base') || 0)
  assert('真实库中 MOSS LoRA 能被识别（> 0，即本次补全的目标场景成立）', mossCount > 0, `实测 ${mossCount} 个`)
}
