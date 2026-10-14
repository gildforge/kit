export type { FileDiff } from '../engine/types.js'
import type { FileDiff } from '../engine/types.js'
// Comparing two trees in an in-memory clone: the file diffs a reviewer reads,
// and the line counts of every file at the newer side, which Glance needs to
// size its boxes. Shared by pull requests and single commits.
import { CQX_MAX_SOURCE_FILE_BYTES } from './cqx-heavy-limits.js'
import * as git from 'isomorphic-git'
import { structuredPatch } from 'diff'
import { DIR } from './metastore.js'
import type { MemFS } from '../engine/memfs.js'


/** Files counted for Glance; hunks are kept for the first SHOWN of them. */
const COUNTED = 300
const SHOWN = 60
const MAX_BLOB = 256 * 1024

async function blobBytes(fs: MemFS, oid: string | null): Promise<Uint8Array | null> {
  if (!oid) return new Uint8Array()
  return (await git.readBlob({ fs: fs as never, dir: DIR, oid, cache: fs.gitCache })).blob
}

const isText = (b: Uint8Array) => b.length <= MAX_BLOB && !b.subarray(0, 8000).includes(0)

function lineCount(b: Uint8Array) {
  if (!b.length) return 0
  let n = 0
  for (const c of b) if (c === 10) n++
  return b[b.length - 1] === 10 ? n : n + 1
}

/** Diffs from `from` to `to` (commit oids; `from` null means an empty tree). */
export async function compareCommits(fs: MemFS, from: string | null, to: string) {
  const changed: { path: string; a: string | null; b: string | null }[] = []
  await git.walk({
    fs: fs as never, dir: DIR, cache: fs.gitCache, trees: from ? [git.TREE({ ref: from }), git.TREE({ ref: to })] : [git.TREE({ ref: to })],
    map: async (path, entries) => {
      if (path === '.') return true
      const [a, b] = from ? entries : [null, entries[0]]
      const [ta, tb] = [await a?.type(), await b?.type()]
      if (ta === 'tree' || tb === 'tree') return true
      const [oa, ob] = [await a?.oid(), await b?.oid()]
      if (oa !== ob) changed.push({ path, a: oa ?? null, b: ob ?? null })
      return true
    },
  })
  const files: FileDiff[] = []
  for (const [i, c] of changed.slice(0, COUNTED).entries()) {
    const [before, after] = await Promise.all([blobBytes(fs, c.a), blobBytes(fs, c.b)])
    const status = !c.a ? 'added' : !c.b ? 'removed' : 'modified'
    if (!before || !after || !isText(before) || !isText(after)) {
      files.push({ path: c.path, status, additions: 0, deletions: 0, hunks: [], note: 'Binary or very large file; not shown.' })
      continue
    }
    const dec = new TextDecoder()
    const patch = structuredPatch(c.path, c.path, dec.decode(before), dec.decode(after), '', '', { context: 3 })
    let additions = 0
    let deletions = 0
    for (const h of patch.hunks) for (const l of h.lines) { if (l[0] === '+') additions++; else if (l[0] === '-') deletions++ }
    files.push({
      path: c.path, status, additions, deletions,
      hunks: i < SHOWN ? patch.hunks.map((h) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines })) : [],
      ...(i < SHOWN ? {} : { note: 'Counted in Glance; the diff is past the first 60 files.' }),
    })
  }
  return { files, truncated: changed.length > COUNTED, total: changed.length }
}

/** What one blob is worth knowing, read once per clone: its size in lines,
 *  and its text when it's a text file cqx might read. Binary files count as
 *  bytes / 40 (about a line's worth each), capped at 200, so an image takes
 *  up some room without swamping the code. */
export interface BlobInfo { size: number; lines: number; text: string | null }

const MAX_TEXT = CQX_MAX_SOURCE_FILE_BYTES

const seen = new WeakMap<MemFS, Map<string, BlobInfo>>()

async function blobInfo(fs: MemFS, oid: string): Promise<BlobInfo> {
  let cache = seen.get(fs)
  if (!cache) seen.set(fs, (cache = new Map()))
  const hit = cache.get(oid)
  if (hit) return hit
  const b = (await git.readBlob({ fs: fs as never, dir: DIR, oid, cache: fs.gitCache })).blob
  let info: BlobInfo
  if (b.length <= MAX_TEXT && !b.subarray(0, 8000).includes(0)) {
    let text: string | null = null
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(b) } catch { /* not UTF-8 */ }
    info = { size: b.length, lines: Math.max(1, lineCount(b)), text }
  } else {
    info = { size: b.length, lines: Math.max(1, Math.min(200, Math.round(b.length / 40))), text: null }
  }
  cache.set(oid, info)
  return info
}

/** Every file at `commit` with what we know about it. Blobs shared between
 *  commits (most of them) are read once per clone. */
export async function treeAt(fs: MemFS, commit: string, limit = 4000) {
  const files: ({ path: string } & BlobInfo)[] = []
  await git.walk({
    fs: fs as never, dir: DIR, cache: fs.gitCache, trees: [git.TREE({ ref: commit })],
    map: async (path, [e]) => {
      if (path === '.' || !e) return true
      if ((await e.type()) === 'tree') return files.length < limit
      if (files.length >= limit) return false
      files.push({ path, ...(await blobInfo(fs, (await e.oid())!)) })
      return true
    },
  })
  return files
}

/** Every file at `commit` with its size in lines, for Glance. */
export async function fileSizes(fs: MemFS, commit: string) {
  return (await treeAt(fs, commit)).map(({ path, lines }) => ({ path, lines }))
}
