import { esc, showToast, copyText } from '../utils'
import { useOutputStore } from '../store/outputStore'
import { addPrompt, generatePromptId } from '../store/prompts'
import type { PromptEntry } from '../types'
import { openLightbox } from '../components/Lightbox'
import { outputsDb } from '../db/outputsDb'
import { hashPath } from '../services/outputManifest'
import type { OutputFile, OutputMetadata } from '../types/outputs'

let _limit = 50
// 高频词区折叠状态（重渲染后保持）
let _freqCollapsed = true
// 翻译内存缓存（MyMemory 免费配额有限）
const _transCache = new Map<string, string>()

// ── PNG 元数据解析 ──

interface UploadedPng {
  id: string
  fileName: string
  positive: string
  negative: string
  seed: string
  steps: string
  cfg: string
  sampler: string
  model: string
  loras: string[]
  loraTags: string[]
  workflowJson: string
  uiWorkflow: string
  previewThumb: string
  file: File
  hasMeta?: boolean
  saved?: boolean
  sent?: boolean
}

function genUploadedId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

let _uploadedPngs: UploadedPng[] = []

function parsePngFile(file: File): Promise<UploadedPng | null> {
  return new Promise((resolve) => {
    // 兜底定时器：解析卡住（异常/未知浏览器行为）时也放行，避免界面永久残留旧卡片
    const timer = setTimeout(() => resolve(null), 8000)
    const done = (v: UploadedPng | null) => { clearTimeout(timer); resolve(v) }

    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const buf = reader.result as ArrayBuffer
        const meta = await parsePngChunks(buf)
        if (meta) {
          // 生成压缩缩略图（保存到 Prompt 库用；失败不阻断解析）
          let previewThumb = ''
          try {
            const { createThumbnailFromBlob } = await import('../services/outputThumbnail')
            const thumb = await createThumbnailFromBlob(file)
            previewThumb = thumb?.dataUrl || ''
          } catch { /* 忽略缩略图失败 */ }
          done({
            id: genUploadedId(),
            fileName: file.name,
            positive: meta.prompt || '',
            negative: meta.negativePrompt || '',
            seed: meta.seed || '',
            steps: meta.steps || '',
            cfg: meta.cfg || '',
            sampler: meta.sampler || '',
            model: meta.model || '',
            loras: meta.loras || [],
            loraTags: meta.loraTags || [],
            workflowJson: meta.workflowJson || '',
            uiWorkflow: meta.uiWorkflow || '',
            previewThumb,
            file,
            hasMeta: !!(meta.prompt || meta.negativePrompt || meta.workflowJson || meta.seed || meta.steps || meta.cfg || meta.sampler || meta.model || (meta.loras || []).length),
            sent: false,
          })
        } else {
          done(null)
        }
      } catch (e) {
        console.warn('[PromptFreq] parsePngFile 解析异常，跳过该文件:', file.name, e)
        done(null)
      }
    }
    reader.onerror = () => done(null)
    reader.readAsArrayBuffer(file)
  })
}

async function parsePngChunks(buf: ArrayBuffer): Promise<{
  prompt: string; negativePrompt: string; seed: string; steps: string;
  cfg: string; sampler: string; model: string; loras: string[]; loraTags: string[]; workflowJson: string; uiWorkflow: string
} | null> {
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) { if (bytes[i] !== pngSig[i]) return null }

  const raw: Record<string, string> = {}
  let offset = 8
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) break
    const len = view.getUint32(offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const isText = type === 'tEXt' || type === 'zTXt' || type === 'iTXt'
    if (isText) {
      const dataStart = offset + 8
      const dataEnd = dataStart + len
      if (dataEnd > bytes.length) break
      let keyEnd = dataStart
      while (keyEnd < dataEnd && bytes[keyEnd] !== 0) keyEnd++
      const key = String.fromCharCode(...bytes.slice(dataStart, keyEnd))
      let val: string
      if (type === 'zTXt') {
        try {
          const compData = bytes.slice(keyEnd + 2, dataEnd)
          const { decompressZlibAsync } = await import('../services/outputMetadata')
          val = await decompressZlibAsync(compData)
        } catch { val = new TextDecoder().decode(bytes.slice(keyEnd + 1, dataEnd)) }
      } else {
        val = new TextDecoder().decode(bytes.slice(keyEnd + 1, dataEnd))
      }
      raw[key] = val
    }
    offset += 12 + len
  }

  // workflow：优先 prompt chunk（API 格式，图实际执行的提示词）；workflow chunk（UI）兜底。
  const { safeParseJSON } = await import('../services/outputMetadata')
  // 提示词解析源：prompt chunk（API，图实际执行的提示词）优先；workflow chunk（UI）兜底
  let workflowJson = ''
  if (raw['prompt'] && safeParseJSON(raw['prompt'])) {
    workflowJson = raw['prompt']
  }
  if (!workflowJson && raw['workflow']) {
    workflowJson = raw['workflow']
  }
  // 复制工作流必须用真正 UI 格式（workflow chunk）——ComfyUI 前端「导入工作流」只认 UI 格式；
  // 无 workflow chunk 时留空，由复制按钮走 API 转换/明确提示，避免把 API 格式当 UI 复制导致粘贴被忽略
  const uiWorkflow = raw['workflow'] || ''
  const params = raw['parameters'] || ''
  const userComment = raw['user_comment'] || ''
  const description = raw['Description'] || ''

  let result: any = {}

  // 复用 Outputs 的解析引擎
  try {
    const { parseComfyUIWorkflow, safeParseJSON } = await import('../services/outputMetadata')
    if (workflowJson) {
      const wf = safeParseJSON(workflowJson)
      if (wf) result = parseComfyUIWorkflow(wf)
      console.log('[PromptFreq] parseComfyUIWorkflow result:', {
        promptLen: result.prompt?.length,
        negativeLen: result.negativePrompt?.length,
        promptPreview: result.prompt?.slice(0, 80),
        negativePreview: result.negativePrompt?.slice(0, 80),
        seed: result.seed,
        steps: result.steps,
        hasWorkflow: !!workflowJson,
      })
    }
  } catch (e) {
    console.warn('[PromptFreq] parseComfyUIWorkflow error:', e)
  }

  // 手动兜底：仅当解析引擎完全没提取到时，从 workflow 原始节点取第一个文本
  if (!result.prompt && workflowJson) {
    try {
      const { safeParseJSON: sp } = await import('../services/outputMetadata')
      const wf = sp(workflowJson)
      const nodes: any[] = wf?.nodes || (Array.isArray(wf) ? wf : Object.values(wf || {}))
      for (const node of nodes) {
        if (!node) continue
        if (node.class_type !== 'CLIPTextEncode' && node.type !== 'CLIPTextEncode') continue
        let t = ''
        if (Array.isArray(node.widgets_values)) {
          for (const w of node.widgets_values) {
            if (typeof w === 'string' && w.length > 3) { t = w; break }
          }
        } else if (node.inputs?.text && typeof node.inputs.text === 'string') {
          t = node.inputs.text
        }
        if (t) { result.prompt = t; break }
      }
    } catch {}
  }

  // 最终 fallback
  if (!result.prompt) {
    result.prompt = userComment || description || ''
  }  // 提取 LoRA：名称 + <lora:name:weight> 标签（含权重）；兜底从提示词文本提取 <lora:...> 标签
  let loras: string[] = []
  let loraTags: string[] = []
  if (workflowJson) {
    const { extractLorasFromWorkflow, extractLoraTagsFromWorkflow } = await import('../services/outputMetadata')
    loras = extractLorasFromWorkflow(workflowJson)
    loraTags = extractLoraTagsFromWorkflow(workflowJson)
  }
  if (loras.length === 0) {
    const allText = (result.prompt || '') + ' ' + (result.negativePrompt || '')
    const loraMatches = allText.match(/<lora:([^:>]+)/g)
    if (loraMatches) loras.push(...loraMatches.map((l: string) => l.replace('<lora:', '')))
  }
  if (loraTags.length === 0 && loras.length) {
    loraTags = loras.map((n) => `<lora:${n}:0.80>`)
  }

  return {
    prompt: result.prompt || '',
    negativePrompt: result.negativePrompt || '',
    seed: result.seed || raw['seed'] || '',
    steps: result.steps || raw['steps'] || '',
    cfg: result.cfg || raw['cfg'] || '',
    sampler: result.sampler || raw['sampler'] || '',
    model: result.model || raw['model'] || '',
    loras: [...new Set(loras)],
    loraTags: [...new Set(loraTags)],
    workflowJson,
    uiWorkflow,
  }
}

// ── 翻译 ──

async function translateText(text: string): Promise<string> {
  if (!text) return ''
  if (_transCache.has(text)) return _transCache.get(text)!
  try {
    const url = `/api/translate?q=${encodeURIComponent(text.slice(0, 500))}&langpair=en|zh-CN`
    const resp = await fetch(url)
    const data = await resp.json()
    const translated = data?.responseData?.translatedText || ''
    _transCache.set(text, translated)
    return translated
  } catch { return '' }
}

// ── 保存到 Prompt 库 ──

async function savePngToLibrary(p: UploadedPng): Promise<void> {
  if (!p.positive.trim()) { showToast('⚠️ 该图片未解析出 Prompt'); return }

  const displayName = p.fileName.replace(/\.png$/i, '') || 'PNG Prompt'
  const params = [
    p.model && `模型: ${p.model}`,
    p.seed && `Seed: ${p.seed}`,
    p.steps && `Steps: ${p.steps}`,
    p.cfg && `CFG: ${p.cfg}`,
    p.sampler && `采样器: ${p.sampler}`,
  ].filter(Boolean).join(' | ')
  const notes = [
    p.negative && `负 Prompt: ${p.negative}`,
    params && `参数: ${params}`,
  ].filter(Boolean).join('\n')

  const entry: PromptEntry = {
    id: generatePromptId(),
    prompt: p.positive,
    displayText: displayName,
    images: p.previewThumb ? [p.previewThumb] : [],
    primaryImage: p.previewThumb || '',
    tags: [],
    loras: p.loras.map(l => l.trim()).filter(Boolean),
    categoryId: 'uncategorized',
    notes,
    isFavorite: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await addPrompt(entry)
  p.saved = true
  renderPromptFreq()
  showToast('✅ 已保存到 Prompt 库，可在「📖 Prompt 库」查看')
}

// ── 发送到 Outputs ──

/** 发送 PNG 到 Outputs：先选分类，再保存文件到输出目录并注册记录 */
function sendPngToOutputs(p: UploadedPng) {
  const state = useOutputStore.getState()
  if (!state.dirHandle) {
    showToast('⚠️ 请先在 Outputs 中选择输出目录')
    return
  }
  showCategoryPick(async (cat) => {
    try {
      await doSendPngToOutputs(p, cat)
      p.sent = true
      renderPromptFreq()
      showToast(cat ? `✅ 已发送到 Outputs（分类：${cat}）` : '✅ 已发送到 Outputs')
    } catch (e: any) {
      showToast('❌ 发送失败: ' + (e?.message || e))
    }
  })
}

async function doSendPngToOutputs(p: UploadedPng, category: string): Promise<void> {
  const dirHandle = useOutputStore.getState().dirHandle
  if (!dirHandle) throw new Error('未选择输出目录')

  // 文件名去重（避免覆盖已有文件）
  const used = new Set(useOutputStore.getState().files.map(f => f.filename))
  let name = p.fileName
  let i = 1
  while (used.has(name)) {
    const dot = p.fileName.lastIndexOf('.')
    name = dot > 0 ? p.fileName.slice(0, dot) + '_' + i + p.fileName.slice(dot) : p.fileName + '_' + i
    i++
  }

  const handle = await dirHandle.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(p.file)
  await writable.close()

  const path = name
  const id = hashPath(path)
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const outputFile: OutputFile = {
    id, path, filename: name, extension: ext,
    size: p.file.size, mtime: Date.now(), width: 0, height: 0,
    favorite: false, rating: 0, notes: '', tags: [], category,
    status: '', pinned: false, createdAt: Date.now(),
  }
  await outputsDb.files.put(outputFile)
  const outputMeta: OutputMetadata = {
    imageId: id, model: p.model, seed: p.seed, steps: p.steps, cfg: p.cfg,
    sampler: p.sampler, vae: '', clipSkip: 0,
    prompt: p.positive, negativePrompt: p.negative, workflowJson: p.uiWorkflow || p.workflowJson,
    rawMetadata: {},
  }
  await outputsDb.metadata.put(outputMeta)
  try {
    const { createThumbnailFromBlob } = await import('../services/outputThumbnail')
    const thumb = await createThumbnailFromBlob(p.file)
    if (thumb?.dataUrl) {
      await outputsDb.thumbnails.put({ id, dataUrl: thumb.dataUrl, width: thumb.width, height: thumb.height, createdAt: Date.now() })
    }
  } catch { /* 缩略图失败不阻断 */ }

  useOutputStore.setState(s => ({ files: [...s.files, outputFile] }))
  useOutputStore.getState().applyFilters()
}

/** 分类选择弹窗（发送到 Outputs 时选择分类：已有分类 / 未分类 / 新建） */
function showCategoryPick(onPick: (cat: string) => void) {
  const s = useOutputStore.getState()
  const cats = Array.from(new Set(s.files.map(f => f.category).filter(Boolean))).sort()
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:#1b1d22;color:#e6e6e6;border:1px solid #333;border-radius:10px;padding:14px;width:250px;max-height:70vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.5);'
  panel.innerHTML = '<h4 style="margin:0 0 8px;font-size:13px">选择分类</h4>'
  const mk = (label: string, val: string) => {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.style.cssText = 'display:block;width:100%;padding:7px 10px;margin-bottom:4px;border:1px solid #333;border-radius:6px;cursor:pointer;font-size:12px;background:transparent;color:#e6e6e6;text-align:left;'
    btn.onmouseenter = () => { btn.style.background = '#262a32' }
    btn.onmouseleave = () => { btn.style.background = 'transparent' }
    btn.onclick = () => { overlay.remove(); onPick(val) }
    panel.appendChild(btn)
  }
  mk('未分类', '')
  cats.forEach(c => mk(c, c))
  const newWrap = document.createElement('div')
  newWrap.style.cssText = 'display:flex;gap:6px;margin-top:8px;'
  const input = document.createElement('input')
  input.placeholder = '新建分类…'
  input.style.cssText = 'flex:1;padding:6px;background:#0f1013;color:#e6e6e6;border:1px solid #333;border-radius:6px;font-size:12px;outline:none;'
  const addBtn = document.createElement('button')
  addBtn.textContent = '新建'
  addBtn.style.cssText = 'padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;background:#5E6AD2;color:#fff;'
  addBtn.onclick = () => { const v = input.value.trim(); if (v) { overlay.remove(); onPick(v) } }
  input.onkeydown = (e) => { if (e.key === 'Enter') addBtn.click() }
  newWrap.append(input, addBtn)
  panel.appendChild(newWrap)
  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
  input.focus()
}

// ── 渲染 ──

/** 进入图片 Prompt 解析页面：清空上次上传的 PNG，避免残留旧数据 */
export function activatePromptFreq() {
  _uploadedPngs = []
  renderPromptFreq()
}

export function renderPromptFreq() {
  const el = document.getElementById('promptFreqContent')
  const limitEl = document.getElementById('promptFreqLimit') as HTMLSelectElement
  if (!el) return

  const state = useOutputStore.getState()
  let html = ''

  // 从 Outputs 提取高频词
  if (state.files.length > 0 && state.metadataCache.size > 0) {
    if (limitEl) _limit = parseInt(limitEl.value) || 50
    const files = [...state.files].sort((a, b) => b.mtime - a.mtime)
    const recent = _limit > 0 ? files.slice(0, _limit) : files
    const freq = new Map<string, number>()
    for (const f of recent) {
      const meta = state.metadataCache.get(f.id)
      if (!meta?.prompt) continue
      const tokens = meta.prompt.split(/[,，]/).map(t => t.trim()).filter(Boolean)
      for (const t of tokens) {
        const clean = t.replace(/\(|\):\d+(\.\d+)?|\)/g, '').trim().toLowerCase()
        if (clean && clean.length > 1 && !clean.startsWith('<lora:')) {
          freq.set(clean, (freq.get(clean) || 0) + 1)
        }
      }
    }

    if (freq.size > 0) {
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100)
      const maxCount = sorted[0][1]
      html += `<details class="prompt-freq-freq" ${_freqCollapsed ? '' : 'open'}>
        <summary>📊 高频词统计（${sorted.length} 个 · 基于最近 ${_limit || '全部'} 张图片）</summary>
        <div class="prompt-freq-tags">
          ${sorted.map(([tag, count]) => {
            const pct = count / maxCount
            const fs = 12 + pct * 10
            return `<span class="prompt-freq-tag" style="font-size:${fs.toFixed(1)}px" data-copy="${esc(tag)}" title="出现 ${count} 次 · 点击复制">${esc(tag)}, <small>${count}</small></span>`
          }).join('')}
        </div>
      </details>`
    }
  }

  // 已上传的 PNG 提示词
  if (_uploadedPngs.length > 0) {
    html += `<div class="prompt-freq-png-section"><h4>📤 上传的 PNG (${_uploadedPngs.length})</h4>`
    for (const p of _uploadedPngs) {
      const pngId = esc(p.id)
      const posSegments = p.positive ? p.positive.split(/[,，]/).map(t => t.trim()).filter(Boolean) : []
      const negSegments = p.negative ? p.negative.split(/[,，]/).map(t => t.trim()).filter(Boolean) : []

      html += `<div class="prompt-freq-png-card">
        <div class="prompt-freq-png-header">
          ${p.previewThumb ? `<img class="prompt-freq-png-thumb" src="${esc(p.previewThumb)}" alt="" data-pid="${esc(p.id)}" title="点击放大预览">` : ''}
          <span>${esc(p.fileName)}${p.uiWorkflow ? '<span class="prompt-freq-png-flow" title="已内嵌 UI 格式工作流，可导入 ComfyUI"> 📄UI</span>' : (p.workflowJson ? '<span class="prompt-freq-png-flow" title="仅 API 执行参数，无画布工作流"> 📄API</span>' : '')}</span>
          <span>
            <button class="prompt-freq-png-send ${p.sent ? 'sent' : ''}" data-pid="${esc(p.id)}" title="发送到 Outputs">${p.sent ? '✅ 已发送' : '📤 发送到 Outputs'}</button>
            <button class="prompt-freq-png-save ${p.saved ? 'saved' : ''}" data-pid="${esc(p.id)}">${p.saved ? '✅ 已保存' : '💾 保存到 Prompt 库'}</button>
            <button class="prompt-freq-png-del" data-pid="${esc(p.id)}" title="移除">✕</button>
          </span>
        </div>
        ${p.hasMeta === false ? `<div class="prompt-freq-png-nometa" style="padding:10px;text-align:center;color:#8A8F98;font-size:12px;background:rgba(255,255,255,0.03);border-radius:6px;margin-top:6px;">
          ⚠️ 该 PNG 无元数据，无法提取 Prompt / 工作流<br>
          <small style="color:rgba(255,255,255,0.35);line-height:1.7">原因：图片经 QQ/微信传输、截图或二次保存后，内嵌的生成数据会被清除。<br>想要别人的工作流，需让对方发送 <b>未压缩的原始 PNG</b>（直接发原图/文件）。</small>
        </div>` : ''}`

      // 正面提示词 — 每个逗号片段独立卡片
      if (posSegments.length > 0) {
        html += `<div class="prompt-freq-png-label-bar">正 Prompt</div>
          <div class="prompt-freq-png-segments" id="seg_pos_${pngId}" data-role="pos">
            ${posSegments.map((seg, si) => {
              const safe = esc(seg)
              return `<div class="prompt-freq-png-unit">
                <span class="prompt-freq-png-seg" data-copy="${safe}" data-idx="${si}">${safe},</span>
                <div class="prompt-freq-png-seg-trans" id="tr_pos_${pngId}_${si}"></div>
              </div>`
            }).join('')}
          </div>
          <div class="prompt-freq-png-actions">
            <button class="prompt-freq-png-copyall" data-text="${esc(p.positive)}">📋 复制全部</button>
            <button class="prompt-freq-png-transall" data-role="pos">🌐 翻译全部</button>
          </div>`
      }

      // 负面提示词
      if (negSegments.length > 0) {
        html += `<div class="prompt-freq-png-label-bar" style="margin-top:8px">负 Prompt</div>
          <div class="prompt-freq-png-segments" id="seg_neg_${pngId}" data-role="neg">
            ${negSegments.map((seg, si) => {
              const safe = esc(seg)
              return `<div class="prompt-freq-png-unit">
                <span class="prompt-freq-png-seg" data-copy="${safe}" data-idx="${si}">${safe},</span>
                <div class="prompt-freq-png-seg-trans" id="tr_neg_${pngId}_${si}"></div>
              </div>`
            }).join('')}
          </div>
          <div class="prompt-freq-png-actions">
            <button class="prompt-freq-png-copyall" data-text="${esc(p.negative)}">📋 复制全部</button>
            <button class="prompt-freq-png-transall" data-role="neg">🌐 翻译全部</button>
          </div>`
      }

      // LoRA 标签（点击复制）
      if (p.loras.length > 0) {
        html += `<div class="prompt-freq-png-label-bar" style="margin-top:8px">🧩 LoRA（点击复制 ${p.loraTags?.length ? '标签' : '名称'}）</div>
          <div class="prompt-freq-png-loras">${(p.loraTags?.length ? p.loraTags : p.loras).map(l => `<code class="local-tw-item lora" data-copy="${esc(l)}">${esc(l)}</code>`).join('')}</div>`
      }

      // 参数
      if (p.seed || p.steps || p.cfg || p.sampler || p.model) {
        html += `<div class="prompt-freq-png-params">
          ${p.model ? `<span>🧠 ${esc(p.model)}</span>` : ''}
          ${p.seed ? `<span>🌰 ${esc(p.seed)}</span>` : ''}
          ${p.steps ? `<span>👣 ${esc(p.steps)}</span>` : ''}
          ${p.cfg ? `<span>⚙️ CFG ${esc(p.cfg)}</span>` : ''}
          ${p.sampler ? `<span>🔬 ${esc(p.sampler)}</span>` : ''}
        </div>`
      }

      // 工作流操作
      if (p.uiWorkflow || p.workflowJson) {
        html += `<div class="prompt-freq-png-actions" style="margin-top:8px">
          <button class="prompt-freq-png-copyflow" data-pid="${esc(p.id)}" title="复制后请在 ComfyUI 用 Load 或拖入 .json 导入（画布 Ctrl+V 无效）">📄 复制工作流</button>
          <button class="prompt-freq-png-dlflow" data-pid="${esc(p.id)}" title="保存为 .json 文件，拖入 ComfyUI 画布即可导入">⬇️ 下载 .json</button>
          <button class="prompt-freq-png-golib" data-pid="${esc(p.id)}">📖 去 Prompt 库</button>
        </div>`
      }

      html += `</div>`
    }
    html += `</div>`
  }

  // PNG 上传区域（无论有无数据都渲染，保证上传入口始终可用）
  html += `<div class="prompt-freq-upload" id="promptFreqUpload">
    <span>📤 拖拽或点击上传 PNG 图片</span>
  </div>`

  if (!html && state.files.length === 0 && _uploadedPngs.length === 0) {
    // 无任何数据：显示空态提示 + 上传区
    el.innerHTML = '<div class="prompt-freq-empty"><div class="big">📝</div><p>暂无数据</p><p class="sub">请先在 Outputs 中扫描图片目录，或上传 PNG 文件</p></div>' + html
    return
  }

  el.innerHTML = html
}

// ── 事件绑定 ──

export function bindPromptFreqEvents() {
  document.getElementById('promptFreqLimit')?.addEventListener('change', () => renderPromptFreq())

  // 高频词折叠状态同步（重渲染后保持）
  document.getElementById('promptFreqContent')?.addEventListener('toggle', (e) => {
    const el = e.target as HTMLDetailsElement
    if (el.classList.contains('prompt-freq-freq')) _freqCollapsed = !el.open
  }, true)

  document.getElementById('promptFreqContent')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement

    // 点击 tag 复制
    const tag = target.closest('.prompt-freq-tag') as HTMLElement
    if (tag) {
      const word = tag.dataset.copy
      if (word) { copyText(word + ', '); showToast(`已复制: ${word},`) }
      return
    }

    // 点击单个 prompt 片段复制
    const seg = target.closest('.prompt-freq-png-seg') as HTMLElement
    if (seg) {
      const txt = seg.dataset.copy
      if (txt) { copyText(txt + ', '); showToast(`已复制: ${txt},`) }
      return
    }

    // 复制全部
    const copyAllBtn = target.closest('.prompt-freq-png-copyall') as HTMLElement
    if (copyAllBtn) {
      const txt = copyAllBtn.dataset.text
      if (txt) { copyText(txt + ','); showToast('已复制全部') }
      return
    }

    // 翻译 — 只翻译当前区（正或负），不混翻译整卡
    const transAllBtn = target.closest('.prompt-freq-png-transall') as HTMLElement
    if (transAllBtn) {
      const actions = transAllBtn.closest('.prompt-freq-png-actions') as HTMLElement | null
      const segWrap = actions?.previousElementSibling as HTMLElement | null
      if (!segWrap || !segWrap.classList.contains('prompt-freq-png-segments')) return

      const slots = segWrap.querySelectorAll<HTMLElement>('.prompt-freq-png-seg-trans')

      // 本区已有翻译 → 只折叠/展开本区
      if (segWrap.dataset.translated === '1') {
        slots.forEach(s => { s.style.display = s.style.display === 'none' ? 'block' : 'none' })
        return
      }

      // 只收集本区片段
      const units = segWrap.querySelectorAll<HTMLElement>('.prompt-freq-png-unit')
      const texts: string[] = []
      const els: HTMLElement[] = []
      for (const unit of units) {
        const seg = unit.querySelector<HTMLElement>('.prompt-freq-png-seg')
        const slot = unit.querySelector<HTMLElement>('.prompt-freq-png-seg-trans')
        if (seg && slot) {
          texts.push(seg.dataset.copy || '')
          els.push(slot)
          slot.textContent = '⏳'
          slot.style.display = 'block'
        }
      }
      if (texts.length === 0) return

      transAllBtn.textContent = '⏳'

      // 并行翻译本区片段（带内存缓存，节省配额）
      const results = await Promise.all(texts.map(t => translateText(t)))

      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        els[i].textContent = r || ''
        els[i].style.display = r ? 'block' : 'none'
        els[i].dataset.translated = '1'
      }

      transAllBtn.textContent = '🌐 翻译全部'
      segWrap.dataset.translated = '1'
      return
    }

    // 删除 PNG
    const delBtn = target.closest('.prompt-freq-png-del') as HTMLElement
    if (delBtn) {
      const pid = delBtn.dataset.pid
      if (pid) {
        _uploadedPngs = _uploadedPngs.filter(p => p.id !== pid)
        renderPromptFreq()
      }
      return
    }

    // 点击缩略图放大预览
    const thumbImg = target.closest('.prompt-freq-png-thumb') as HTMLElement
    if (thumbImg) {
      const p = _uploadedPngs.find(x => x.id === thumbImg.dataset.pid)
      if (p?.file) openLightbox([URL.createObjectURL(p.file)], 0)
      return
    }

    // 发送到 Outputs
    const sendBtn = target.closest('.prompt-freq-png-send') as HTMLElement
    if (sendBtn) {
      const p = _uploadedPngs.find(x => x.id === sendBtn.dataset.pid)
      if (p && !p.sent) sendPngToOutputs(p)
      return
    }

    // 点击 LoRA 标签复制
    const loraChip = target.closest('.prompt-freq-png-loras code[data-copy]') as HTMLElement
    if (loraChip) {
      const l = loraChip.dataset.copy
      if (l) { copyText(l); showToast(`已复制 LoRA: ${l}`) }
      return
    }

    // 保存到 Prompt 库
    const saveBtn = target.closest('.prompt-freq-png-save') as HTMLElement
    if (saveBtn) {
      const p = _uploadedPngs.find(x => x.id === saveBtn.dataset.pid)
      if (p && !p.saved) await savePngToLibrary(p)
      return
    }

    // 复制工作流
    const copyFlowBtn = target.closest('.prompt-freq-png-copyflow') as HTMLElement
    if (copyFlowBtn) {
      const p = _uploadedPngs.find(x => x.id === copyFlowBtn.dataset.pid)
      if (!p) return
      // 有 UI 格式（workflow chunk）→ 直接复制；仅 API 参数 → 尝试转换为 UI，失败则明确提示（不再误导可还原）
      if (p.uiWorkflow) {
        copyText(p.uiWorkflow)
        showToast('📄 工作流已复制；ComfyUI 请用 Load 或拖入 .json 导入（画布 Ctrl+V 无效）')
      } else if (p.workflowJson) {
        try {
          const { apiWorkflowToUI } = await import('../services/outputMetadata')
          const ui = apiWorkflowToUI(p.workflowJson)
          if (ui) {
            copyText(ui)
            showToast('📄 已从 API 参数转换为 UI 工作流并复制（布局可能需微调）')
          } else {
            copyText(p.workflowJson)
            showToast('⚠️ 该图仅 API 执行参数、无画布工作流，ComfyUI 前端导入会被忽略')
          }
        } catch {
          copyText(p.workflowJson)
          showToast('⚠️ 该图仅 API 执行参数、无画布工作流，ComfyUI 前端导入会被忽略')
        }
      } else {
        showToast('⚠️ 该图片无工作流数据')
      }
      return
    }

    // 下载工作流 .json（ComfyUI 用 Load 或拖入画布导入）
    const dlFlowBtn = target.closest('.prompt-freq-png-dlflow') as HTMLElement
    if (dlFlowBtn) {
      const p = _uploadedPngs.find(x => x.id === dlFlowBtn.dataset.pid)
      const wf = p?.uiWorkflow || p?.workflowJson
      if (!p || !wf) { showToast('⚠️ 该图片无工作流数据'); return }
      try {
        const baseName = (p.fileName || 'workflow').replace(/\.png$/i, '')
        const blob = new Blob([wf], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = baseName + '.json'
        a.click()
        URL.revokeObjectURL(url)
        showToast('⬇️ 工作流 .json 已下载，拖入 ComfyUI 画布即可导入')
      } catch {
        showToast('⚠️ 下载失败')
      }
      return
    }

    // 去 Prompt 库
    const goLibBtn = target.closest('.prompt-freq-png-golib') as HTMLElement
    if (goLibBtn) {
      ;(document.querySelector('.main-tab[data-section="prompt"]') as HTMLElement)?.click()
      return
    }

    // 点击上传区域
    if (target.closest('#promptFreqUpload')) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.png'
      input.multiple = true
      input.onchange = async (e) => {
        const files = (e.target as HTMLInputElement).files
        if (!files) return
        try {
          // 追加到已有列表（多张 PNG 共存）；按 文件名+大小 去重，同名不同内容不重复跳过
          const existingKeys = new Set(_uploadedPngs.map(p => `${p.fileName}:${p.file?.size ?? ''}`))
          for (const f of Array.from(files)) {
            const key = `${f.name}:${f.size}`
            if (existingKeys.has(key)) continue
            const png = await parsePngFile(f)
            if (png) { _uploadedPngs.push(png); existingKeys.add(key) }
          }
          showToast(`已上传 ${files.length} 个 PNG`)
        } catch (err) {
          console.warn('[PromptFreq] 上传解析出错:', err)
        } finally {
          renderPromptFreq()
        }
      }
      input.click()
    }
  })

  // 拖拽上传
  document.getElementById('promptFreqContent')?.addEventListener('dragover', (e) => {
    e.preventDefault()
    const zone = document.getElementById('promptFreqUpload')
    if (zone) zone.classList.add('drag-over')
  })
  document.getElementById('promptFreqContent')?.addEventListener('dragleave', () => {
    const zone = document.getElementById('promptFreqUpload')
    if (zone) zone.classList.remove('drag-over')
  })
  document.getElementById('promptFreqContent')?.addEventListener('drop', async (e) => {
    e.preventDefault()
    const zone = document.getElementById('promptFreqUpload')
    if (zone) zone.classList.remove('drag-over')
    const items = e.dataTransfer?.files
    if (!items) return
    try {
      // 追加到已有列表（多张 PNG 共存）；按 文件名+大小 去重
      const existingKeys = new Set(_uploadedPngs.map(p => `${p.fileName}:${p.file?.size ?? ''}`))
      for (const f of Array.from(items)) {
        if (!f.name.toLowerCase().endsWith('.png')) continue
        const key = `${f.name}:${f.size}`
        if (existingKeys.has(key)) continue
        const png = await parsePngFile(f)
        if (png) { _uploadedPngs.push(png); existingKeys.add(key) }
      }
      showToast(`已上传 PNG 文件`)
    } catch (err) {
      console.warn('[PromptFreq] 拖拽解析出错:', err)
    } finally {
      renderPromptFreq()
    }
  })
}
