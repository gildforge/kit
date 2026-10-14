import type { ApiControl } from '../api/control-do.js'
export interface RenderLimiter {
  idFromName(key: string): unknown
  get(id: unknown): Pick<ApiControl, 'rate'>
}
export const HISTORY_IP_PER_HOUR = 120
export const HISTORY_ACCOUNT_PER_HOUR = 600
export function historyLimited(latest: string, retryAfter = '3600') {
  const safe = latest.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return new Response(`<!doctype html><html><head><title>History render limit</title></head><body><main><h1>History render limit reached</h1><p>This older commit needs a new render. Please try again after the Retry-After delay. Already rendered history and current branches remain available. Sign in for a higher allowance.</p><p><a href="${safe}">Browse the latest commit</a></p></main></body></html>`, {
    status: 429, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'retry-after': retryAfter },
  })
}
export async function historyRate(request: Request, ns: RenderLimiter, account: string | null, repo = '') {
  const ip = request.headers.get('cf-connecting-ip')
  // The link comes from the resolved repository only, never from the query, so the
  // 429 page cannot be made to point off-site (`?repo=/evil.example/x` → `//evil…`).
  const latest = /^[\w.-]+\/[\w.-]+$/.test(repo) ? '/' + repo.split('/').map(encodeURIComponent).join('/') : '/'
  // Authenticated viewers are independent of NAT. Unidentified anonymous cold
  // renders fail closed without allocating or sharing an "unknown" bucket.
  if (!account && !ip) return historyLimited(latest)
  const key = account ? 'account:' + account : 'ip:' + ip
  const rate = await ns.get(ns.idFromName('history-render:' + repo + ':' + key)).rate(Date.now(), account ? HISTORY_ACCOUNT_PER_HOUR : HISTORY_IP_PER_HOUR)
  if (!rate.allowed) {
    return historyLimited(latest, String(Math.max(1, rate.reset - Math.floor(Date.now() / 1000))))
  }
  return null
}
