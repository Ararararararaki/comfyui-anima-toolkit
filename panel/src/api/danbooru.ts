import { sleep } from '../utils'
import type { DanbooruResult } from '../types'

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? '/api/danbooru'
  : 'https://danbooru.donmai.us'

const MAX_RETRIES = 2
const RETRY_DELAY = 3000

class RateLimiter {
  private rate: number
  private tokens: number
  private last: number

  constructor(r: number) {
    this.rate = r
    this.tokens = r
    this.last = performance.now()
  }

  async acquire() {
    while (true) {
      const now = performance.now()
      this.tokens = Math.min(this.rate, this.tokens + (now - this.last) / 1000 * this.rate)
      this.last = now
      if (this.tokens >= 1) { this.tokens--; return }
      await new Promise(r => setTimeout(r, 60))
    }
  }
}

let limiter = new RateLimiter(3)

export function normalizeTag(tag: string): string {
  return tag.trim()
    .replace(/^,?\s*a?rt?ist:\s*/i, '')
    .replace(/ /g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

export function getSocialIcon(url: string): string {
  const u = url.toLowerCase()
  if (u.includes('pixiv.net')) return 'Px'
  if (u.includes('twitter.com') || u.includes('x.com')) return 'X'
  if (u.includes('skeb.jp')) return 'Sk'
  if (u.includes('fanbox.cc') || u.includes('pixiv.net/fanbox')) return 'Fb'
  if (u.includes('patreon.com')) return 'Pa'
  if (u.includes('deviantart.com')) return 'DA'
  if (u.includes('tumblr.com')) return 'Tu'
  if (u.includes('instagram.com')) return 'Ig'
  if (u.includes('artstation.com')) return 'AS'
  if (u.includes('furaffinity.net')) return 'FA'
  if (u.includes('nicovideo.jp') || u.includes('nico.ms')) return 'Nc'
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'Yt'
  if (u.includes('reddit.com')) return 'Re'
  if (u.includes('github.com')) return 'Gh'
  if (u.includes('lofter.com')) return 'Lo'
  if (u.includes('weibo.com') || u.includes('weibo.cn')) return 'Wb'
  if (u.includes('bilibili.com')) return 'Bi'
  if (u.includes('booth.pm')) return 'Bo'
  if (u.includes('misskey') || u.includes('mastodon')) return 'Ms'
  if (u.includes('bsky.app')) return 'Bs'
  if (u.includes('newgrounds.com')) return 'NG'
  if (u.includes('ko-fi.com')) return 'Ko'
  if (u.includes('linktr.ee') || u.includes('lit.link')) return 'Lk'
  try { const h = new URL(url).hostname.replace('www.', ''); return h.slice(0, 2).toUpperCase() } catch { return '?' }
}

async function _fetch(url: string, signal?: AbortSignal) {
  await limiter.acquire()
  const resp = await fetch(API_BASE + url, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!resp.ok) {
    const err = new Error('HTTP ' + resp.status) as any
    err.status = resp.status
    throw err
  }
  return resp.json()
}

async function _req(url: string, signal?: AbortSignal): Promise<[any, string | null]> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return [await _fetch(url, signal), null]
    } catch (e) {
      if ((e as Error).name === 'AbortError') return [null, 'cancelled']
      if ((e as any).status === 429) {
        await sleep(RETRY_DELAY * (i + 2))
        continue
      }
      if (i < MAX_RETRIES - 1) await sleep(RETRY_DELAY)
      else return [null, (e as Error).message || 'error']
    }
  }
  return [null, 'max_retries']
}

export async function getDanbooruCount(tag: string, signal?: AbortSignal): Promise<DanbooruResult> {
  const n = normalizeTag(tag)
  if (!n) return { count: 0, name: null, category: 'empty' }

  let [d, e] = await _req('/tags.json?search[name]=' + encodeURIComponent(n) + '&search[category]=1&limit=1', signal)
  if (e) return { count: 0, name: null, category: 'error', error: e }
  if (d && d.length > 0) return { count: d[0].post_count, name: d[0].name, category: 'artist' }

  ;[d, e] = await _req('/tags.json?search[name]=' + encodeURIComponent(n) + '&limit=1', signal)
  if (e) return { count: 0, name: null, category: 'error', error: e }
  if (d && d.length > 0) return { count: d[0].post_count, name: d[0].name, category: 'any' }

  return { count: 0, name: null, category: 'not_found' }
}

export async function getDanbooruUrls(tag: string, signal?: AbortSignal): Promise<string[]> {
  const n = normalizeTag(tag)
  if (!n) return []

  const [ad, e1] = await _req('/artists.json?search[name]=' + encodeURIComponent(n) + '&limit=1', signal)
  if (e1 || !ad || !ad.length || !ad[0]?.id) return []

  const [ud, e2] = await _req('/artist_urls.json?search[artist_id]=' + ad[0].id, signal)
  if (e2 || !ud) return []

  const seen = new Set<string>()
  const out: string[] = []
  for (const it of ud) {
    const u = typeof it === 'string' ? it : (it?.is_active !== false ? it?.url : null)
    if (u) {
      const k = u.trim().replace(/\/+$/, '')
      if (!seen.has(k)) { seen.add(k); out.push(u.trim()) }
    }
  }
  return out
}

export async function pool<T>(
  limit: number,
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
  onCancelled: () => boolean,
) {
  const exec = new Set<Promise<void>>()
  for (let i = 0; i < items.length; i++) {
    if (onCancelled()) break
    const p = fn(items[i], i).finally(() => exec.delete(p))
    exec.add(p)
    if (exec.size >= limit) await Promise.race(exec)
  }
  if (exec.size > 0) await Promise.allSettled([...exec])
}

export function resetDanbooruLimiter(rate: number) {
  limiter = new RateLimiter(rate)
}