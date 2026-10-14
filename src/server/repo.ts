import { LANGUAGES } from '../engine/languages.js'
export { LANGUAGES } from '../engine/languages.js'
// What the repo page reads, assembled from the Artifacts REST API plus git's
// own ref listing (the REST API has no branches or tags endpoint).
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { cache } from 'react'
import { readToken, repoBlob, repoCommit as repoCommitRaw, repoLog as repoLogRaw, repoRemote, repoTree as repoTreeRaw, type LogEntry, type TreeEntry } from './artifacts.js'
import { kept } from './kept.js'

import type { Refs } from '../engine/repo-refs.js'
import { listRefs } from './repo-refs-live.js'
import { indexRefs, readyIndex } from './repo-index.js'
export type { Refs } from '../engine/repo-refs.js'

/** Branches and tags, read the way `git ls-remote` does: one listing per
 *  request however many parts of the page ask. `_meta` is forge metadata,
 *  not code, so it is never offered as a branch, but its tip comes along. */
export const repoRefs = cache(async (owner: string, repo: string): Promise<Refs> => {
  const indexed = await indexRefs(owner, repo)
  if (indexed) return indexed
  return listRefs(owner, repo)
})

/** The commit a branch or tag name points at, if the listing has it. */
export const tipOf = (refs: Refs | null, name: string) =>
  refs?.branches.find((b) => b.name === name)?.oid ?? refs?.tags.find((t) => t.name === name)?.oid ?? (/^[0-9a-f]{40}$/.test(name) ? name : null)

// Everything below is keyed by a hash, so it is fetched once and kept (lib/kept.ts).

/** Index first; immutable fallback values are kept only while backfilling. */
export async function repoTree(owner: string, repo: string, hash: string) {
  const entries = await (await readyIndex(owner, repo))?.tree(hash)
  return entries?.map((e) => ({ name: e.name, type: e.type, mode: e.mode, hash: e.child }))
    ?? kept(`tree:${owner}/${repo}:${hash}`, () => repoTreeRaw(owner, repo, hash))
}
export async function repoCommit(owner: string, repo: string, hash: string) {
  const c = await (await readyIndex(owner, repo))?.commit(hash)
  return c ? commitView(c) : kept(`commit-info:${owner}/${repo}:${hash}`, () => repoCommitRaw(owner, repo, hash))
}
export async function logAt(owner: string, repo: string, tip: string, limit: number) {
  const log = await (await readyIndex(owner, repo))?.log(tip, limit)
  return log ? log.map(commitView) : kept(`log:${owner}/${repo}:${tip}:${limit}`, () => repoLogRaw(owner, repo, tip, limit))
}

/** Directories first, then files, each alphabetical (as editors list them). */
export function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1,
  )
}

/** The entries of each directory on the way to `path`, so the tree can open
 *  with the selected file's folders already expanded. */
export async function treesAlong(owner: string, repo: string, rootHash: string, path: string) {
  const levels: { dir: string; entries: TreeEntry[] }[] = []
  let hash = rootHash
  let dir = ''
  const parts = path.split('/').filter(Boolean)
  for (let i = 0; ; i++) {
    const entries = sortEntries(await repoTree(owner, repo, hash))
    levels.push({ dir, entries })
    if (i >= parts.length - 1) return { levels, file: entries.find((e) => e.name === parts[i]) ?? null }
    const next = entries.find((e) => e.name === parts[i] && e.type === 'tree')
    if (!next) return { levels, file: null }
    hash = next.hash
    dir = dir ? `${dir}/${parts[i]}` : parts[i]
  }
}

const TEXT_LIMIT = 512 * 1024

/** A file's text, or why it can't be shown as text. */
export async function fileText(owner: string, repo: string, hash: string): Promise<
  { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'large'; bytes: number }
> {
  const indexed = await (await readyIndex(owner, repo))?.blobText(hash)
  if (indexed) return indexed
  return kept(`blob-text:${owner}/${repo}:${hash}`, async () => {
    const bytes = await repoBlob(owner, repo, hash)
    if (bytes.length > TEXT_LIMIT) return { kind: 'large' as const, bytes: bytes.length }
    if (bytes.subarray(0, 8000).includes(0)) return { kind: 'binary' as const }
    return { kind: 'text' as const, text: new TextDecoder().decode(bytes) }
  })
}

/** Who has committed, most commits first, from the latest `limit` commits. */
export function contributors(log: LogEntry[]) {
  const counts = new Map<string, number>()
  for (const c of log) {
    const name = c.author?.name?.trim()
    if (name && name !== 'gild') counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, commits]) => ({ name, commits }))
}



/** Language mix by number of files. The API gives no file sizes, so this is
 *  files, not bytes, and the page says so. Walks at most `maxDirs` folders,
 *  a level at a time, and is kept per root tree. */
export async function languages(owner: string, repo: string, rootHash: string, maxDirs = 60) {
  const indexed = await (await readyIndex(owner, repo))?.languages(rootHash)
  if (indexed) return indexed
  return kept(`languages:${owner}/${repo}:${rootHash}:${maxDirs}`, async () => {
    const counts = new Map<string, { files: number; color: string }>()
    let level = [rootHash]
    let dirs = 0
    while (level.length && dirs < maxDirs) {
      const batch = level.slice(0, maxDirs - dirs)
      dirs += batch.length
      const next: string[] = []
      for (const entries of await Promise.all(batch.map((h) => repoTree(owner, repo, h)))) {
        for (const e of entries) {
          if (e.type === 'tree') {
            if (!['node_modules', 'vendor', 'dist', 'build', '.git'].includes(e.name)) next.push(e.hash)
            continue
          }
          const lang = LANGUAGES[e.name.split('.').pop()!.toLowerCase()]
          if (!lang) continue
          const cur = counts.get(lang[0]) ?? { files: 0, color: lang[1] }
          cur.files++
          counts.set(lang[0], cur)
        }
      }
      level = next
    }
    const total = [...counts.values()].reduce((n, l) => n + l.files, 0)
    return [...counts.entries()]
      .sort((a, b) => b[1].files - a[1].files)
      .map(([name, l]) => ({ name, color: l.color, share: total ? l.files / total : 0 }))
  })
}

export async function repoLog(owner: string, repo: string, ref = 'main', limit = 10) {
  const refs = await repoRefs(owner, repo).catch(() => null)
  const tip = tipOf(refs, ref)
  return tip ? logAt(owner, repo, tip, limit) : repoLogRaw(owner, repo, ref, limit)
}

function commitView(c: import('../engine/repo-index-store.js').Commit) {
  return { hash: c.hash, treeHash: c.tree, parents: c.parents, author: { name: c.author_name, email: c.author_email }, authoredAt: c.time, committedAt: c.time, message: c.message }
}
