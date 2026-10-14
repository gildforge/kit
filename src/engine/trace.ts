/** Opt-in request trace (`x-gild-trace: 1`): every D1 query, Durable Object
 * call and outbound fetch the request makes, in order, with start offsets
 * and durations, returned as JSON in the `x-gild-trace` response header.
 * Timings only: never query parameters, bodies or results. Without the
 * header the Worker's env is used unchanged. */
export interface TraceStep { kind: 'd1' | 'do' | 'fetch'; what: string; at: number; ms: number }
export interface Trace { steps: TraceStep[]; start: number }

const label = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 90)

function timed<T>(trace: Trace, kind: TraceStep['kind'], what: string, work: () => Promise<T>): Promise<T> {
  const at = Date.now()
  const done = () => { trace.steps.push({ kind, what, at: at - trace.start, ms: Date.now() - at }) }
  return work().then(v => { done(); return v }, e => { done(); throw e })
}

const unwrapped = new WeakMap<object, object>()
function d1<T extends object>(db: T, trace: Trace): T {
  const statement = (s: object, sql: string): object => { const p = new Proxy(s, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'bind') return (...args: unknown[]) => statement(value.apply(target, args), sql)
      if (['first', 'all', 'run', 'raw'].includes(key as string))
        return (...args: unknown[]) => timed(trace, 'd1', `${String(key)} ${label(sql)}`, () => value.apply(target, args))
      return value.bind(target)
    },
  }); unwrapped.set(p, s); return p }
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'prepare') return (sql: string) => statement(value.call(target, sql), sql)
      if (key === 'batch') return (list: unknown[]) => timed(trace, 'd1', `batch ×${list.length}`, () => value.call(target, list.map(x => unwrapped.get(x as object) ?? x)))
      if (key === 'exec') return (sql: string) => timed(trace, 'd1', `exec ${label(sql)}`, () => value.call(target, sql))
      return value.bind(target)
    },
  })
}

function namespace<T extends object>(ns: T, name: string, trace: Trace): T {
  return new Proxy(ns, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key !== 'get') return value.bind(target)
      return (...args: unknown[]) => {
        const stub = value.apply(target, args) as object
        return new Proxy(stub, {
          get(s, method) {
            const call = Reflect.get(s, method)
            if (typeof call !== 'function' || method === 'then') return call
            return (...a: unknown[]) => timed(trace, 'do', `${name}.${String(method)}`, async () => call.apply(s, a))
          },
        })
      }
    },
  })
}

/** A traced copy of `env` when the request asks for a trace, else null. */
export function traceEnv<E extends object>(request: Request, env: E): { env: E; trace: Trace } | null {
  if (request.headers.get('x-gild-trace') !== '1') return null
  const trace: Trace = { steps: [], start: Date.now() }
  const copy: Record<string, unknown> = { ...(env as Record<string, unknown>) }
  for (const [key, value] of Object.entries(env)) {
    if (!value || typeof value !== 'object') continue
    if (key === 'DB' || key.endsWith('_DB')) copy[key] = d1(value as object, trace)
    else if ('idFromName' in (value as object)) copy[key] = namespace(value as object, key, trace)
  }
  return { env: copy as E, trace }
}

/** Outbound fetches made while `work` runs, attributed to this trace. */
export async function traceFetches<T>(trace: Trace, work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return timed(trace, 'fetch', `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.host}${url.pathname.slice(0, 80)}`, () => original(input, init))
  }) as typeof fetch
  try { return await work() } finally { globalThis.fetch = original }
}

export function traceHeader(trace: Trace) {
  const by = (k: string) => trace.steps.filter(s => s.kind === k)
  const sum = (k: string) => by(k).reduce((n, s) => n + s.ms, 0)
  return JSON.stringify({
    total: Date.now() - trace.start,
    counts: { d1: by('d1').length, do: by('do').length, fetch: by('fetch').length },
    ms: { d1: sum('d1'), do: sum('do'), fetch: sum('fetch') },
    steps: trace.steps.sort((a, b) => a.at - b.at).slice(0, 150).map(s => `${s.at}+${s.ms} ${s.kind} ${s.what}`),
  })
}
