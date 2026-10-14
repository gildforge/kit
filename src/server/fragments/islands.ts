import type { FragmentReads } from './http.js'
import { publicLeases, defaultEdge, type EdgeContext } from '../../engine/fragments/edge.js'
/** Public star/commit islands are independent of the first painted HTML.
 * Cookie/token responses remain private. Authorization is a separate short
 * lease and MUST precede the data cache, including for old commit islands. */
export async function publicIslandsHTTP(request: Request, reads: FragmentReads,
  ctx: EdgeContext, forward: (anonymous: Request) => Promise<Response>, now = Date.now) {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/islands$/)
  if (!match || request.method !== 'GET' || request.headers.has('authorization') ||
    /(?:^|;\s*)gild_session=/.test(request.headers.get('cookie') ?? '')) return null
  const pointer = await reads.publicPointer?.(request, match[1], match[2])
  if (!pointer || pointer.scope) return null
  const commit = url.searchParams.get('commit')
  if (commit && !/^[a-f0-9]{40}$/.test(commit)) return null
  const result = await publicLeases(request, ctx, defaultEdge(), now)(JSON.stringify(['islands', pointer.entity, pointer.tip, commit]), async () => {
    const headers = new Headers(request.headers)
    headers.delete('cookie'); headers.delete('authorization')
    const response = await forward(new Request(request, { headers }))
    if (!response.ok) return null
    const data = await response.json() as { name: string | null; starred: boolean; write: boolean }
    // Fail closed if this route ever starts personalizing an anonymous response.
    return !data.name && !data.starred && !data.write ? data : null
  }, value => !!value)
  return result ? Response.json(result, { headers: {
    'cache-control': 'public, max-age=0, must-revalidate',
    'server-timing': 'islands;desc="public edge data; viewer-independent"',
  } }) : null
}
