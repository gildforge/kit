// The request being answered, for code that reads its cookies or headers
// without being handed it (sessions, page reads). The Worker entry runs each
// request inside runWithRequest; the store lives on a global symbol so every
// copy of this module in one Worker (the entry's and a bundled Next server's)
// sees the same request.
import { AsyncLocalStorage } from 'node:async_hooks'

const KEY = Symbol.for('gild.request')
type Store = { als: AsyncLocalStorage<Request>; fallback?: () => Promise<Headers> }
const store = ((globalThis as { [KEY]?: Store })[KEY] ??= { als: new AsyncLocalStorage<Request>() })

/** Answer `run` with `request` as the current request. */
export const runWithRequest = <T>(request: Request, run: () => T): T => store.als.run(request, run)

/** Where headers come from outside a Worker request (e.g. `next dev`). */
export function provideRequestHeaders(fallback: () => Promise<Headers>) { store.fallback = fallback }

/** The current request's headers (empty outside a request). */
export async function requestHeaders(): Promise<Headers> {
  const request = store.als.getStore()
  if (request) return request.headers
  if (store.fallback) return store.fallback()
  // Queues, alarms and scheduled work answer no browser: no cookies, no session.
  return new Headers()
}

/** One cookie of the current request. */
export async function requestCookie(name: string): Promise<string | undefined> {
  for (const part of ((await requestHeaders()).get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) {
      const value = part.slice(at + 1).trim()
      try { return decodeURIComponent(value) } catch { return value }
    }
  }
  return undefined
}
