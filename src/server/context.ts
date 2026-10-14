// The request's Cloudflare bindings, read the way OpenNext publishes them: on
// a global symbol that the Worker entry points at the current request. A
// Next.js host (gild.gg) gets this from OpenNext unchanged; the kit's own
// Worker entry (runWithCloudflareContext) sets the same symbol, so backend
// code reads its env identically in both.
import { AsyncLocalStorage } from 'node:async_hooks'

export interface CloudflareContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each module narrows env to the bindings it uses
  env: any
  ctx: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }
  cf?: unknown
}

const KEY = Symbol.for('__cloudflare-context__')
type Global = { [KEY]?: CloudflareContext }

export function getCloudflareContext(options: { async: true }): Promise<CloudflareContext>
export function getCloudflareContext(options?: { async?: false }): CloudflareContext
export function getCloudflareContext(options?: { async?: boolean }): CloudflareContext | Promise<CloudflareContext> {
  const context = (globalThis as Global)[KEY]
  if (context) return options?.async ? Promise.resolve(context) : context
  if (!options?.async) throw new Error('gild: no Cloudflare context for this request')
  // `next dev` and static builds: OpenNext builds a context on demand.
  const openNext = '@opennextjs/cloudflare'
  return import(/* webpackIgnore: true */ openNext).then(m => m.getCloudflareContext({ async: true }))
}

const requests = new AsyncLocalStorage<CloudflareContext>()
let installed = false
/** The kit Worker entry: run one request (or batch) with its bindings. */
export function runWithCloudflareContext<T>(context: CloudflareContext, run: () => T): T {
  if (!installed) {
    Object.defineProperty(globalThis, KEY, { get: () => requests.getStore(), configurable: true })
    installed = true
  }
  return requests.run(context, run)
}
