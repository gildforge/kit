// Values derived from content-addressed input (a tree, blob or commit hash),
// computed once and kept: in this isolate's memory for the next request, and
// gzipped in D1 for every other isolate. A hash always names the same content,
// so nothing kept here ever goes stale. Keys must include every hash the value
// depends on.
import { store } from './backend.js'

/** D1 rows top out at 2 MB; a value bigger than this is recomputed instead. */
const MAX_ROW = 1_900_000
/** Entries held in memory per isolate; the oldest go first. */
const MAX_MEMORY = 2000

const memory = new Map<string, unknown>()
const pending = new Map<string, Promise<unknown>>()

function remember(key: string, value: unknown) {
  memory.delete(key)
  memory.set(key, value)
  if (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value!)
}

async function gz(value: unknown) {
  const body = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(body).arrayBuffer())
}

async function gunzip<T>(bytes: Uint8Array): Promise<T> {
  const body = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))
  return JSON.parse(await new Response(body).text()) as T
}

/** The kept value for `key`, or null. */
export async function recall<T>(key: string): Promise<T | null> {
  if (memory.has(key)) {
    const value = memory.get(key) as T
    remember(key, value)
    return value
  }
  const bytes = await (await store()).getChange(key)
  if (!bytes) return null
  const value = await gunzip<T>(bytes)
  remember(key, value)
  return value
}

export async function keep(key: string, value: unknown) {
  remember(key, value)
  const bytes = await gz(value)
  if (bytes.length <= MAX_ROW) await (await store()).putChange(key, bytes)
}

/** `compute()` once per key, ever. */
export async function kept<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const inFlight = pending.get(key)
  if (inFlight) return inFlight as Promise<T>
  const value = (async () => {
    const hit = await recall<T>(key)
    if (hit !== null) return hit
    const computed = await compute()
    await keep(key, computed)
    return computed
  })()
  pending.set(key, value)
  try { return await value } finally { pending.delete(key) }
}

/** A short-lived per-isolate memo for things that do change, but rarely and
 *  harmlessly (which namespace an owner lives in, a minted read token). */
export function memo<T>(ttlMs: number) {
  const entries = new Map<string, { at: number; value: Promise<T> }>()
  const get = (key: string, compute: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.value
    const value = compute()
    entries.set(key, { at: Date.now(), value })
    value.catch(() => entries.delete(key))
    return value
  }
  return Object.assign(get, { forget: (key:string) => entries.delete(key) })
}
