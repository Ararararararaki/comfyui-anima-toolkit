// Live-preview bridge. ComfyUI streams in-progress sampler previews over the
// websocket as `b_preview` (JPEG Blob), the producing node identified by the
// preceding `executing` event. We accept only frames from a sampler that
// (transitively) feeds an enabled Ref Sync node, so unrelated KSamplers don't
// fight over the backdrop.

import { api } from '@comfy/api'
import { app } from '@comfy/app'
import { ref } from 'vue'

// Current in-progress preview as an object URL (null = no live frame).
export const previewSyncImage = ref<string | null>(null)

let watched = new Set<string>() // node ids whose previews we accept
let lastUrl: string | null = null
let currentIds: string[] = [] // node id(s) from the latest `executing` event

function clearPreview() {
  if (lastUrl) {
    URL.revokeObjectURL(lastUrl)
    lastUrl = null
  }
  previewSyncImage.value = null
}

function getNodes(graph: any): any[] {
  if (!graph) return []
  return Array.isArray(graph._nodes) ? graph._nodes : Array.isArray(graph.nodes) ? graph.nodes : []
}
// `graph.links` is a plain object in old LiteGraph, a Map in the newer fork.
function getLink(graph: any, id: any): any {
  const links = graph?.links
  if (!links) return null
  return typeof links.get === 'function' ? links.get(id) : links[id]
}

// A subgraph instance node exposes its inner graph as `node.subgraph`.
function subgraphOf(node: any): any {
  return node?.subgraph ?? null
}

// Add a node id, plus — if it's a subgraph instance — all of its inner node ids,
// recursively. Deliberately over-broad: only samplers emit `b_preview`, so watching
// every inner node just means "accept whichever sampler lives inside this subgraph".
function addNodeAndInner(node: any, out: Set<string>) {
  if (node?.id == null) return
  out.add(String(node.id))
  const sg = subgraphOf(node)
  if (sg) for (const inner of getNodes(sg)) addNodeAndInner(inner, out)
}

// Collect ancestor node ids by walking input wires upstream from `start`, within
// `graph`. When an upstream node is a subgraph, its inner nodes get pulled in too,
// so a sampler nested inside a subgraph still ends up watched.
function collectAncestors(graph: any, start: any, out: Set<string>) {
  const stack = [start]
  const visited = new Set<unknown>()
  while (stack.length) {
    const n = stack.pop()
    if (!n || visited.has(n.id)) continue
    visited.add(n.id)
    for (const inp of n.inputs ?? []) {
      if (inp?.link == null) continue
      const link = getLink(graph, inp.link)
      const srcId = link?.origin_id ?? link?.[1] // object form / serialized array form
      if (srcId == null) continue
      const src = graph.getNodeById?.(srcId)
      addNodeAndInner(src ?? { id: srcId }, out)
      if (src && !visited.has(src.id)) stack.push(src)
    }
  }
}

function isRefSync(n: any): boolean {
  const cls = n?.type ?? n?.comfyClass ?? n?.constructor?.comfyClass
  return cls === 'MossLayoutRefSync'
}

// Walk a graph and recurse into every subgraph, collecting ancestors of each enabled
// Ref Sync — so it works whether the Ref Sync (or its sampler) sits at the top level
// or nested inside a subgraph.
function rebuildWatchedIn(graph: any, out: Set<string>) {
  for (const n of getNodes(graph)) {
    if (isRefSync(n)) {
      const en = n.widgets?.find((w: any) => w?.name === 'enable')
      if (!(en && en.value === false)) collectAncestors(graph, n, out)
    }
    const sg = subgraphOf(n)
    if (sg) rebuildWatchedIn(sg, out)
  }
}

// Rebuild the watched set: ancestors of enabled Ref Sync nodes, across subgraphs.
function rebuildWatched() {
  const set = new Set<string>()
  rebuildWatchedIn((app as any)?.graph, set)
  watched = set
}

let inited = false
export function initPreviewSync() {
  if (inited) return
  inited = true
  try {
    const A = api as any

    A.addEventListener('execution_start', rebuildWatched)

    A.addEventListener('executing', (e: any) => {
      const d = e?.detail
      currentIds = d == null ? [] : typeof d === 'string' ? [d] : [d.node, d.display_node].filter(Boolean).map(String)
    })

    A.addEventListener('b_preview', (e: any) => {
      const blob = e?.detail
      if (!(blob instanceof Blob)) return
      if (!watched.size) rebuildWatched() // first frame / graph wasn't ready yet
      // Subgraph-internal nodes execute under a namespaced id ("<subgraph>:<inner>"),
      // so accept the frame if the full id OR any colon-separated segment is watched.
      const hit = currentIds.some((id) => watched.has(id) || id.split(':').some((s) => watched.has(s)))
      if (!hit) return
      const url = URL.createObjectURL(blob)
      if (lastUrl) URL.revokeObjectURL(lastUrl)
      lastUrl = url
      previewSyncImage.value = url
    })

    // Drop the live frame once Ref Sync broadcasts the final image.
    A.addEventListener('moss-layout.ref-sync', clearPreview)
  } catch (err) {
    console.warn('[MossLayoutStudio] live-preview listener failed to register', err)
  }
}
