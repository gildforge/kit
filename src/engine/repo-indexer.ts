import * as git from 'isomorphic-git'
import { languageFor } from './languages.js'
import { IndexStore, type Commit, type Entry, type BlobInfo, type IndexRef } from './repo-index-store.js'
export interface ObjectSource {
  raw?(hash: string): Promise<{ type: string; bytes: Uint8Array }>
  commit(hash: string): Promise<Commit>
  tree(hash: string): Promise<Entry[]>
  blob(hash: string): Promise<Uint8Array>
}
export function gitSource(fs: unknown, dir: string, cache: object): ObjectSource & Required<Pick<ObjectSource, 'raw'>> {
  const args = { fs: fs as never, dir, cache }
  return {
    async raw(hash) { const o = await git.readObject({ ...args, oid: hash, format: 'content' }); return { type: o.type, bytes: o.object as Uint8Array } },
    async commit(hash) {
      const { commit: c } = await git.readCommit({ ...args, oid: hash })
      return { hash, tree: c.tree, parents: c.parent, author_name: c.author.name, author_email: c.author.email, time: c.author.timestamp, message: c.message,committer_name:c.committer.name,committer_email:c.committer.email,committer_time:c.committer.timestamp }
    },
    async tree(hash) { return (await git.readTree({ ...args, oid: hash })).tree.map((e) => ({ name: e.path, type: e.type, mode: e.mode, child: e.oid })) },
    async blob(hash) { return (await git.readBlob({ ...args, oid: hash })).blob },
  }
}
export function describeBlob(hash: string, bytes: Uint8Array, path: string): BlobInfo {
  const binary = bytes.subarray(0, 8000).includes(0) ? 1 : 0
  const content = !binary && bytes.length <= 512 * 1024 ? new TextDecoder().decode(bytes) : null
  let lines = 0
  if (!binary && bytes.length) { for (const b of bytes) if (b === 10) lines++; if (bytes[bytes.length - 1] !== 10) lines++ }
  const language = languageFor(path), symbols: BlobInfo['symbols'] = []
  if (content && ['TypeScript', 'JavaScript', 'Rust', 'Go'].includes(language)) {
    const pattern = language === 'Rust' ? /\b(fn|struct|enum|trait)\s+([\p{L}\w]+)/gu
      : language === 'Go' ? /\b(func)\s+(?:\([^)]*\)\s*)?([\p{L}\w]+)|\btype\s+([\p{L}\w]+)\s+(struct|interface)/gu
      : /\b(function|class|interface)\s+([\p{L}\w]+)|\b(?:const|let)\s+([\p{L}\w]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w]+)\s*=>/gu
    for (const [i, line] of content.split('\n').entries()) {
      for (const m of line.matchAll(pattern)) symbols.push({ name: m[2] ?? m[3], kind: m[1] ?? m[4] ?? 'function', line: i + 1 })
    }
  }
  return { hash, raw: Buffer.from(bytes).toString("base64"), size: bytes.length, lines, binary, content, language, symbols }
}
export interface Target { refs: IndexRef[]; defaultBranch: string; meta: string | null }
/** Queue only unknown commits. A known commit's ancestors/objects have all
 *  completed, so incremental walks stop there. Publishing waits for the queue. */
export function startIndex(store: IndexStore, target: Target) {
  store.setting('target', JSON.stringify(target))
  for (const r of target.refs) { store.rememberTip(r.hash); store.enqueue(r.hash, 'commit') }
  if (target.meta) store.enqueue(target.meta, 'commit')
}
/** A resumable, bounded object batch. Caller supplies one shallow clone of
 *  the active commit. Its pack cache is shared for every read; each unknown
 *  blob is read once. No working tree and no array of all decoded file texts. */
/** Ancestors beyond this many are left to git (the commit pages read git
 *  and cache by hash); the index is for tips, and enough history to list. */
export const HISTORY_LIMIT = 500

export async function indexStep(store: IndexStore, sourceFor: (hash: string) => Promise<ObjectSource>, budget = 300, maxCommits = Infinity, commitInfo?: (hash: string) => Promise<Commit>) {
  let active: string | null = store.setting('active') || null, source: ObjectSource | null = null
  let remaining = budget, completed = 0
  const meta = (JSON.parse(store.setting('target') ?? 'null') as Target | null)?.meta ?? null
  while (remaining-- > 0) {
    if (!active) {
      const next = store.jobs(1)[0]
      if (!next) break
      if (store.has(next.hash)) { store.finish(next.hash); continue }
      // Only branch/tag tips (and `_meta`) need their files: search and browse
      // read tips. An ancestor needs just its commit record for history, which
      // one small read gives, instead of fetching and walking a whole snapshot.
      if (commitInfo && !store.isTip(next.hash) && next.hash !== meta) {
        const c = await commitInfo(next.hash)
        const seen = Number(store.setting('history') ?? '0') + 1
        store.setting('history', String(seen))
        if (seen < HISTORY_LIMIT) for (const p of c.parents) store.enqueue(p, 'commit')
        store.putCommit(c); store.finish(next.hash)
        continue
      }
      active = next.hash
      source = await sourceFor(active)
      const c = await source.commit(active)
      store.setting('active', active); store.setting('activeCommit', JSON.stringify(c))
      store.finish(active); store.enqueue(c.tree, 'tree')
    }
    source ??= await sourceFor(active)
    const job = store.jobs(1)[0]
    if (job && job.type !== 'commit') {
      if (!store.has(job.hash)) {
        if (job.type === 'tree') {
          const entries = await source.tree(job.hash)
          for (const e of entries) if (e.type !== 'commit') store.enqueue(e.child, e.type, job.name ? `${job.name}/${e.name}` : e.name)
          store.putTree(job.hash, entries)
        } else store.putBlob(describeBlob(job.hash, await source.blob(job.hash), job.name))
      }
      store.finish(job.hash)
      continue
    }
    // Only mark the commit known once every tree/blob has been durably written.
    const c = JSON.parse(store.setting('activeCommit')!) as Commit
    for (const p of c.parents) store.enqueue(p, 'commit')
    store.putCommit(c); store.setting('active', ''); active = null; source = null
    if (++completed >= maxCommits) break
  }
  const done = !store.pending() && !store.setting('active')
  if (done) {
    const target = JSON.parse(store.setting('target')!) as Target
    store.publish(target.refs, target.defaultBranch, target.meta)
  }
  return { done, pending: store.pending(), counts: store.counts() }
}
