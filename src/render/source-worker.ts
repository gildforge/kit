/// <reference lib="webworker" />
import { bundlePath } from './language.ts'
import { fragmentURL, RENDER_VERSION } from './address.ts'
import type { PagePointer, TipManifest } from '../engine/fragments.ts'
const MAX_BYTES = 200 * 1024 * 1024,
  DB_NAME = 'gild-source-v1'
interface Record {
  key: string
  bytes: number
  at: number
  private: boolean
  body?: string
  opfs?: boolean
}
let database: Promise<IDBDatabase> | undefined,
  directory: Promise<FileSystemDirectoryHandle | null> | undefined
function db() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore('entries', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return database
}
function opfs() {
  directory ??= Promise.resolve()
    .then(() => navigator.storage.getDirectory())
    .then((d) => d.getDirectoryHandle(DB_NAME, { create: true }))
    .catch(() => null)
  return directory
}
async function records<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await db()
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction('entries', mode),
      request = work(tx.objectStore('entries'))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
const nameOf = (key: string) => encodeURIComponent(key)
async function read(key: string) {
  const entry = await records<Record | undefined>('readonly', (s) => s.get(key))
  if (!entry) return null
  let body = entry.body ?? null
  if (entry.opfs)
    try {
      body = await (
        await (await opfs())!.getFileHandle(nameOf(key))
      )
        .getFile()
        .then((f) => f.text())
    } catch {
      return null
    }
  entry.at = Date.now()
  await records('readwrite', (s) => s.put(entry))
  return body
}
async function remove(entry: Record) {
  if (entry.opfs)
    try {
      await (await opfs())?.removeEntry(nameOf(entry.key))
    } catch {}
  await records('readwrite', (s) => s.delete(entry.key))
}
async function write(key: string, body: string, privateData: boolean) {
  const entry: Record = {
    key,
    bytes: new TextEncoder().encode(body).length,
    at: Date.now(),
    private: privateData,
    body,
  }
  if (entry.bytes > MAX_BYTES) return
  const dir = await opfs()
  if (dir)
    try {
      const stream = await (
        await dir.getFileHandle(nameOf(key), { create: true })
      ).createWritable()
      await stream.write(body)
      await stream.close()
      entry.opfs = true
      delete entry.body
    } catch {
      /* Quota or OPFS unavailable: IndexedDB is the same cache. */
    }
  await records('readwrite', (s) => s.put(entry))
  const all = await records<Record[]>('readonly', (s) => s.getAll())
  let bytes = all.reduce((n, e) => n + e.bytes, 0)
  for (const row of all.sort((a, b) => a.at - b.at)) {
    if (bytes <= MAX_BYTES) break
    await remove(row)
    bytes -= row.bytes
  }
}
const scopeOf = (p: PagePointer, principal: string) =>
  `${RENDER_VERSION}/` +
  (p.scope ? `private/${principal}/${p.scope}` : `public/${p.repository}`)
const sourceKey = (scope: string, hash: string) => `${scope}/blob/${hash}`
function urlOf(
  pointer: PagePointer,
  kind: 'manifest' | 'bundle' | 'blob' | 'source',
  hash: string,
  path?: string,
) {
  const url = new URL(
    fragmentURL(
      { kind, hash, version: pointer.version },
      pointer.scope ? pointer.repository : undefined,
    ),
    self.location.origin,
  )
  url.search = new URLSearchParams({
    repo: pointer.repository,
    sha: pointer.tip,
    ...(path ? { path } : {}),
  }).toString()
  return url.toString()
}
async function fetchOK(url: string) {
  const r = await fetch(url)
  if (r.status === 202) throw new Error('Pending')
  if (!r.ok) throw new Error(`Source fetch ${r.status}`)
  return r
}
async function preload(pointer: PagePointer, principal: string) {
  const scope = scopeOf(pointer, principal),
    manifestKey = `${scope}/manifest/${pointer.manifest.hash}`,
    cached = await read(manifestKey)
  if (cached) return JSON.parse(cached) as TipManifest
  const manifest = (await (
      await fetchOK(urlOf(pointer, 'manifest', pointer.manifest.hash))
    ).json()) as TipManifest,
    latest = await read(`${scope}/tip/${pointer.repository}`),
    previous = latest
      ? (JSON.parse((await read(latest)) ?? 'null') as TipManifest | null)
      : null
  // A previous tip means a delta: fetch only missing content-addressed blobs.
  // Never download the full new bundle just to throw its unchanged files away.
  if (previous?.bundle && pointer.bundle) {
    const todo = manifest.files.filter((f) => f.text && bundlePath(f.path))
    let cursor = 0
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (cursor < todo.length) {
          const file = todo[cursor++],
            key = sourceKey(scope, file.fragment.hash)
          if (await read(key)) continue
          const [html, content] = await Promise.all([
            fetchOK(urlOf(pointer, 'blob', file.fragment.hash, file.path)).then(
              (r) => r.text(),
            ),
            fetchOK(urlOf(pointer, 'source', file.blob, file.path)).then((r) =>
              r.text(),
            ),
          ])
          await write(key, JSON.stringify({ html, content }), !!pointer.scope)
          if (file.readme) {
            const html = await fetchOK(
              urlOf(pointer, 'blob', file.readme.hash, file.path),
            ).then((r) => r.text())
            await write(
              sourceKey(scope, file.readme.hash),
              JSON.stringify({ html, content }),
              !!pointer.scope,
            )
          }
        }
      }),
    )
  } else if (pointer.bundle) {
    const bundle = (await (
      await fetchOK(urlOf(pointer, 'bundle', pointer.bundle.hash))
    ).json()) as {
      files: {
        path: string
        blob: string
        html: string
        content: string
        readmeHTML?: string
      }[]
      oversized?: boolean
    }
    if (bundle.oversized) manifest.bundle = null
    if (!bundle.oversized)
      for (const f of bundle.files) {
        const address = manifest.files.find((a) => a.path === f.path)
        if (address)
          await write(
            sourceKey(scope, address.fragment.hash),
            JSON.stringify({ html: f.html, content: f.content }),
            !!pointer.scope,
          )
        if (address?.readme && f.readmeHTML !== undefined)
          await write(
            sourceKey(scope, address.readme.hash),
            JSON.stringify({ html: f.readmeHTML, content: f.content }),
            !!pointer.scope,
          )
      }
  }
  await write(manifestKey, JSON.stringify(manifest), !!pointer.scope)
  await write(
    `${scope}/tip/${pointer.repository}`,
    manifestKey,
    !!pointer.scope,
  )
  return manifest
}
async function clearPrivate() {
  for (const row of await records<Record[]>('readonly', (s) => s.getAll()))
    await remove(row)
}
const channel = new BroadcastChannel('gild-private-source')
let chain = Promise.resolve()
channel.onmessage = (e) => {
  if (e.data === 'clear')
    chain = chain.then(async () => {
      await clearPrivate()
      active.clear()
    })
}
const active = new Map<string, TipManifest>()
async function ask(input: {
  op: string
  pointer: PagePointer
  principal?: string
  path?: string
  query?: string
}) {
  const principal = input.principal ?? '',
    scope = scopeOf(input.pointer, principal)
  if (input.pointer.scope && !principal)
    throw new Error('Private cache requires the signed-in identity')
  if (input.op === 'preload') {
    const manifest = await preload(input.pointer, principal)
    active.set(scope + '/' + manifest.tree, manifest)
    return manifest
  }
  const manifest = active.get(scope + '/' + input.pointer.manifest.hash)
  if (!manifest) return null
  if (input.op === 'file') {
    const file = manifest.files.find((f) => f.path === input.path)
    if (!file) return null
    const cached = await read(
      sourceKey(
        scope,
        input.pointer.selected?.hash === file.readme?.hash
          ? file.readme!.hash
          : file.fragment.hash,
      ),
    )
    return cached ? { ...JSON.parse(cached), file } : null
  }
  if (input.op === 'search') {
    const matches: { path: string; line: number; text: string }[] = [],
      query = (input.query ?? '').toLowerCase()
    for (const file of manifest.files) {
      const entry = await read(sourceKey(scope, file.fragment.hash))
      if (!entry) continue
      const { content } = JSON.parse(entry) as { content: string }
      for (const [i, line] of content.split('\n').entries())
        if (line.toLowerCase().includes(query)) {
          matches.push({ path: file.path, line: i + 1, text: line })
          if (matches.length >= 100) return matches
        }
    }
    return matches
  }
  return null
}
self.onmessage = (event) => {
  const { id, ...input } = event.data
  chain = chain.then(async () => {
    try {
      if (input.op === 'clear-private') {
        await clearPrivate()
        active.clear()
        channel.postMessage('clear')
        self.postMessage({ id, value: true })
        return
      }
      self.postMessage({ id, value: await ask(input) })
    } catch (error) {
      self.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}
