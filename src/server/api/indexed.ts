import {changeCacheKey} from '../../engine/api/change-version.js'
import { structuredPatch } from 'diff'
import type { RepoIndex } from '../repo-index-do.js'
import { ApiError, requireFound } from '../../engine/api/errors.js'
import type { Change } from '../changes.js'
import {refHash} from '../../engine/api/ref-resolution.js'
export {SHA} from '../../engine/api/ref-resolution.js'
export type Index = {
  [
    K in
      | 'sessionList'
      | 'sessionGet'
      | 'sessionPut'
      | 'requestObject'
      | 'apiLog'
      | 'ensureHistory'
      | 'snapshotReady'
      | 'apiChanges'
      | 'apiHealth'
      | 'file'
      | 'refs'
      | 'tree'
      | 'commit'
      | 'rawBlob'
      | 'log'
      | 'sizes'
      | 'metaFile'
      | 'metaItem'
      | 'search'
      | 'hydrate'
      | 'view'
  ]: (
    ...a: Parameters<RepoIndex[K]>
  ) => Promise<Awaited<ReturnType<RepoIndex[K]>>>
}
export async function resolve(index: Index, ref?: string) {
  const refs = await index.refs(),
    hash = refHash(refs.refs,refs.defaultBranch,ref)
  if (!hash) throw new ApiError(404, 'Ref or commit not found in the index')
  if (!(await index.commit(hash))) {
    const state = await index.requestObject('commit', hash)
    throw new ApiError(
      state === 'notfound' ? 404 : 503,
      state === 'notfound'
        ? 'Commit not found'
        : 'Commit is indexing; retry shortly',
    )
  }
  return hash
}
export async function snapshot(index: Index, sha: string) {
  const c = requireFound(await index.commit(sha)),
    tree = await index.tree(c.tree)
  if (
    !tree ||
    c.committer_name === undefined ||
    !(await index.snapshotReady(c.tree))
  ) {
    await index.hydrate(sha)
    throw new ApiError(503, 'Snapshot is indexing; retry shortly')
  }
  return c
}
export async function entries(
  index: Index,
  hash: string,
  recursive = false,
  prefix = '',
): Promise<
  {
    path: string
    mode: string
    type: 'tree' | 'blob' | 'commit'
    sha: string
  }[]
> {
  const tree = await index.tree(hash)
  if (!tree) {
    const state = await index.requestObject('tree', hash)
    throw new ApiError(
      state === 'notfound' ? 404 : 503,
      'Tree is indexing or unavailable',
    )
  }
  const out: {
    path: string
    mode: string
    type: 'tree' | 'blob' | 'commit'
    sha: string
  }[] = []
  for (const e of tree) {
    const path = prefix + e.name
    out.push({
      path,
      mode: e.mode.padStart(6, '0'),
      type: e.type,
      sha: e.child,
    })
    if (recursive && e.type === 'tree')
      out.push(...(await entries(index, e.child, true, path + '/')))
    if (out.length > 100000)
      throw new ApiError(
        413,
        'Tree exceeds 100000 entries; use non-recursive reads',
      )
  }
  return out
}
export async function raw(index: Index, hash: string, commit?: string) {
  const value = await index.rawBlob(hash)
  if (!value) {
    if (commit) {
      await index.hydrate(commit)
      throw new ApiError(503, 'Blob is indexing; retry shortly')
    }
    for (const ref of (await index.refs()).refs) {
      const c = await index.commit(ref.hash)
      if (!c || !(await index.tree(c.tree))) continue
      if (
        (await entries(index, c.tree, true)).some(
          (e) => e.sha === hash && e.type === 'blob',
        )
      ) {
        await index.hydrate(ref.hash)
        throw new ApiError(503, 'Blob is indexing; retry shortly')
      }
    }
    const state = await index.requestObject('blob', hash)
    throw new ApiError(
      state === 'notfound' ? 404 : 503,
      state === 'notfound'
        ? 'Blob not found'
        : 'Blob is indexing; retry shortly',
    )
  }
  return value
}
export async function ancestors(index: Index, sha: string) {
  const seen = new Map<string, number>(),
    queue: [string, number][] = [[sha, 0]]
  while (queue.length) {
    const [h, depth] = queue.shift()!
    if (seen.has(h)) continue
    const c = await index.commit(h)
    if (!c) throw new ApiError(503, 'Commit history is incomplete in the index')
    seen.set(h, depth)
    for (const p of c.parents) queue.push([p, depth + 1])
  }
  return seen
}
export async function comparison(index: Index, base: string, head: string) {
  if (!(await index.ensureHistory(base)) || !(await index.ensureHistory(head)))
    throw new ApiError(503, 'Commit history is indexing; retry shortly')
  const [a, b] = await Promise.all([
    ancestors(index, base),
    ancestors(index, head),
  ])
  const common = [...a.keys()]
    .filter((h) => b.has(h))
    .sort((x, y) => a.get(x)! + b.get(x)! - a.get(y)! - b.get(y)!)
  if (!common.length) throw new ApiError(409, 'Commits have no common ancestor')
  const ahead = [...b.keys()].filter((h) => !a.has(h)),
    behind = [...a.keys()].filter((h) => !b.has(h))
  const commits = await Promise.all(ahead.map((h) => index.commit(h)))
  const metadata = [
    ...commits,
    await index.commit(base),
    await index.commit(common[0]),
  ].filter((c) => c && c.committer_name === undefined)
  if (metadata.length) {
    for (const c of metadata) await index.hydrate(c!.hash)
    throw new ApiError(503, 'Commit records are indexing; retry shortly')
  }
  return {
    mergeBase: common[0],
    ahead: ahead.length,
    behind: behind.length,
    commits: commits.filter((c) => c !== null).sort((x, y) => x.time - y.time),
  }
}
export async function changes(
  index: Index,
  from: string | null,
  to: string,
): Promise<Change> {
  return index.apiChanges(from, to)
}
export async function computeChanges(
  index: Index,
  from: string | null,
  to: string,
): Promise<Change> {
  const key = changeCacheKey(from,to),
    hit = await index.view(key)
  if (hit) return hit as Change
  const [before, after] = await Promise.all([
    from ? snapshot(index, from) : null,
    snapshot(index, to),
  ])
  const [oldFiles, newFiles] = await Promise.all([
    before ? entries(index, before.tree, true) : [],
    entries(index, after.tree, true),
  ])
  const a = new Map(
      oldFiles.filter((f) => f.type !== 'tree').map((f) => [f.path, f]),
    ),
    b = new Map(
      newFiles.filter((f) => f.type !== 'tree').map((f) => [f.path, f]),
    )
  const paths = [...new Set([...a.keys(), ...b.keys()])]
      .filter((p) => a.get(p)?.sha !== b.get(p)?.sha)
      .sort(),
    files: Change['files'] = []
  for (const path of paths.slice(0, 300)) {
    const aa = a.get(path),
      bb = b.get(path),
      [old, newer] = await Promise.all([
        aa?.type === 'blob' ? raw(index, aa.sha, from ?? undefined) : null,
        bb?.type === 'blob' ? raw(index, bb.sha, to) : null,
      ])
    const beforeBytes = Buffer.from(old?.content ?? '', 'base64'),
      afterBytes = Buffer.from(newer?.content ?? '', 'base64')
    const status = !aa ? 'added' : !bb ? 'removed' : 'modified'
    if (
      beforeBytes.length > 256 * 1024 ||
      afterBytes.length > 256 * 1024 ||
      beforeBytes.subarray(0, 8000).includes(0) ||
      afterBytes.subarray(0, 8000).includes(0) ||
      aa?.type === 'commit' ||
      bb?.type === 'commit'
    ) {
      files.push({
        path,
        status,
        additions: 0,
        deletions: 0,
        hunks: [],
        note: 'Binary, submodule or large file',
      })
      continue
    }
    const patch = structuredPatch(
      path,
      path,
      beforeBytes.toString(),
      afterBytes.toString(),
      '',
      '',
      { context: 3 },
    )
    const additions = patch.hunks.reduce(
        (n, h) => n + h.lines.filter((l) => l.startsWith('+')).length,
        0,
      ),
      deletions = patch.hunks.reduce(
        (n, h) => n + h.lines.filter((l) => l.startsWith('-')).length,
        0,
      )
    files.push({
      path,
      status,
      additions,
      deletions,
      hunks: patch.hunks.map((h) => ({
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines,
      })),
    })
  }
  const result: Change = {
    from,
    to,
    files,
    truncated: paths.length > 300,
    total: paths.length,
    sizes: (await index.sizes(after.tree)) ?? [],
  }
  await index.view(key, result)
  return result
}
