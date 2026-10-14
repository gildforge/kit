/** Public read grants are leases, never stale-while-revalidate. The deadline
 * starts BEFORE the primary read, so slow fills cannot extend revocation. */
export const PUBLIC_LEASE_MS = 1000
export interface EdgeContext { waitUntil(work: Promise<unknown>): void }
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<unknown>
}
export function defaultEdge(): EdgeCache | undefined {
  return typeof caches === 'undefined' ? undefined : (caches as unknown as { default: EdgeCache }).default
}
function generationKey(origin: string) { return new Request(origin + '/__gild-read-generation') }
/** Cache API deletes cannot purge other PoPs. The lease is the global bound;
 * a generation change additionally invalidates ALL local grants on a write,
 * including fills still in flight. No enumeration or isolate-local state. */
export async function invalidatePublicReads(origin: string, edge = defaultEdge()) {
  if (!edge) return
  await edge.put(generationKey(origin), new Response(crypto.randomUUID(), {
    headers: { 'cache-control': 'public, max-age=31536000' },
  }))
}
export function publicLeases(request: Request, ctx?: EdgeContext, edge = defaultEdge(), now = Date.now) {
  const origin = new URL(request.url).origin
  let generation: Promise<string> | undefined
  return async <T>(key: string, read: () => Promise<T>, publicValue: (value: T) => boolean): Promise<T> => {
    if (!edge || !ctx) return read()
    generation ??= (async () => {
      const cached = await edge.match(generationKey(origin))
      if (cached) return cached.text()
      // Eviction must not resurrect a grant from an earlier generation.
      // Persist a new epoch before reading the primary, even on a new PoP.
      const epoch = crypto.randomUUID()
      await edge.put(generationKey(origin), new Response(epoch, {
        headers: { 'cache-control': 'public, max-age=31536000' },
      }))
      return epoch
    })()
    const epoch = await generation
    const cacheKey = new Request(origin + '/__gild-read/' + encodeURIComponent(epoch) + '/' + encodeURIComponent(key))
    const cached = await edge.match(cacheKey)
    if (cached) {
      const lease = await cached.json() as { until: number; value: T }
      if (now() < lease.until && publicValue(lease.value)) return lease.value
    }
    const until = now() + PUBLIC_LEASE_MS
    const value = await read()
    // A slow primary read (a cold isolate or D1 after a deploy) is still this
    // request's own current answer: serve it, but never share it as a lease.
    // Throwing here turned every read slower than the lease into a 503.
    // Never cache denials, private data, incomplete projections, or expired fills.
    if (now() < until && publicValue(value))
      ctx.waitUntil(edge.put(cacheKey, Response.json({ until, value }, {
        headers: { 'cache-control': 'public, max-age=1' },
      })).catch(() => {}))
    return value
  }
}
