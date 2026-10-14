import type { IndexStore } from '../../engine/repo-index-store.js'
import type { TipManifest, HomeData, RenderItem } from '../../engine/fragments.js'
import { blobFragment, bundlePath } from '../../render/language.js'
import { digest, RENDER_VERSION } from '../../render/address.js'
import { type Report } from '../cqx-wasm.js'

/** Immutable browse addresses are built beside the index, not on requests. */
export function manifestAt(index: IndexStore, sha: string): TipManifest | null {
  const version = index.setting('fragments:version') ?? RENDER_VERSION
  const commit = index.commit(sha)
  if (!commit || !index.snapshotReady(commit.tree)) return null
  const cached = index.view(
    `fragments:${version}:manifest:${commit.tree}`,
  ) as TipManifest | null
  if (cached) return cached
  index.flatten(commit.tree)
  const files = index
    .rows<{ path: string; blob: string; size: number; binary: number }>(
      'SELECT path,blob,size,binary FROM files JOIN blobs ON blob=hash WHERE root_tree=? ORDER BY path',
      commit.tree,
    )
    .map((f) => ({
      path: f.path,
      blob: f.blob,
      fragment: blobFragment(f.blob, f.path),
      ...(/^readme(?:\.md|\.markdown|\.txt)?$/i.test(f.path)
        ? { readme: blobFragment(f.blob, f.path, true) }
        : {}),
      source: { kind: 'source' as const, hash: f.blob },
      bytes: f.size,
      text: !f.binary,
    }))
  const trees = [
    { path: '', hash: commit.tree },
    ...index.rows<{ path: string; hash: string }>(
      `WITH RECURSIVE dirs(path,hash) AS (
    SELECT name,child FROM trees WHERE tree=? AND type='tree'
    UNION ALL SELECT dirs.path || '/' || trees.name,trees.child FROM dirs JOIN trees ON dirs.hash=trees.tree WHERE trees.type='tree'
  ) SELECT path,hash FROM dirs ORDER BY path`,
      commit.tree,
    ),
  ]
  // The compressed cap is also checked in gild-render. Bound pre-compression
  // memory in the Worker; huge tips use immutable per-file reads.
  const autoBytes = files
    .filter((f) => f.text && f.bytes <= 1024 * 1024 && bundlePath(f.path))
    .reduce((n, f) => n + f.bytes, 0)
  const manifest: TipManifest = {
    tree: commit.tree,
    files,
    trees,
    bundle:
      autoBytes <= 20 * 1024 * 1024
        ? { kind: 'bundle', hash: commit.tree }
        : null,
  }
  index.view(`fragments:${version}:manifest:${commit.tree}`, manifest)
  return manifest
}
export async function publishHome(
  index: IndexStore,
  ref: string,
  score: Report | null,
  description: string,
  archived: boolean,
  pictures: Map<string, import('../../engine/profile.js').ProfilePicture> = new Map(),
) {
  const version = index.setting('fragments:version') ?? RENDER_VERSION
  const sha = index.resolve(ref) ?? (/^[a-f0-9]{40}$/.test(ref) ? ref : null),
    commit = sha ? index.commit(sha) : null
  if (!commit && index.refs().length) return null
  const refs = index.refs(),
    meta = index.setting('meta') || null,
    metadata = JSON.parse(
      index.metaFile('.gild/index.json') ?? '{"issues":[],"pulls":[]}',
    ) as { issues: { state: string }[]; pulls: { state: string }[] }
  const log = commit ? index.log(commit.hash, 100) : [],
    people = new Map<string, number>()
  for (const c of log)
    people.set(c.author_name, (people.get(c.author_name) ?? 0) + 1)
  const home: HomeData = {
    repository: `${index.setting('owner')}/${index.setting('repo')}`,
    ref,
    commit,
    meta,
    branches: refs.filter((r) => r.kind === 'branch').map((r) => r.name),
    tags: refs
      .filter((r) => r.kind === 'tag')
      .map((r) => r.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
    description,
    archived,
    acl: JSON.parse(index.metaFile('.gild/acl.json') ?? '{}'),
    issues: metadata.issues.filter((i) => i.state === 'open').length,
    pulls: metadata.pulls.filter((p) => p.state === 'open').length,
    tree: commit ? (index.tree(commit.tree) ?? []) : [],
    languages: commit ? (index.languages(commit.tree) ?? []) : [],
    contributors: [...people]
      .map(([name, count]) => ({ name, count, picture: pictures.get(name) }))
      .sort((a, b) => b.count - a.count),
    commits: log.length,
    score,
  }
  // Include presentation inputs: the same commit may appear in two repos,
  // and refs/settings can change without changing its code or metadata tip.
  const hash = `${commit?.hash ?? 'empty'}.${meta ?? 'empty'}.${(await digest(JSON.stringify(home))).slice(0, 24)}`
  index.view(`fragments:${version}:home:${hash}`, home)
  index.setting(`fragments:${version}:home:${ref}`, hash)
  return { kind: 'home' as const, hash }
}
export function changedItems(
  index: IndexStore,
  oldTip: string | null,
  newTip: string,
  home: string,
): RenderItem[] {
  const manifest = manifestAt(index, newTip)
  if (!manifest) return []
  const old = oldTip ? manifestAt(index, oldTip) : null,
    known = new Set(old?.files.map((f) => f.fragment.hash)),
    trees = new Set(old?.trees.map((t) => t.hash)),
    items: RenderItem[] = [
      { fragment: { kind: 'home', hash: home }, sha: newTip },
      { fragment: { kind: 'manifest', hash: manifest.tree }, sha: newTip },
    ]
  for (const f of manifest.files)
    if (!known.has(f.fragment.hash)) {
      items.push(
        { fragment: f.fragment, path: f.path, sha: newTip },
        { fragment: f.source, path: f.path, sha: newTip },
      )
      if (/^readme(?:\.md|\.markdown|\.txt)?$/i.test(f.path))
        items.push({
          fragment: blobFragment(f.blob, f.path, true),
          path: f.path,
          sha: newTip,
        })
    }
  for (const t of manifest.trees)
    if (!trees.has(t.hash))
      items.push({
        fragment: { kind: 'tree', hash: t.hash },
        sha: newTip,
        path: t.path,
      })
  for (const variant of ['score', 'review']) {
    const hash = index.setting(
      `fragments:${index.setting('fragments:version') ?? RENDER_VERSION}:${variant}:${newTip}`,
    )
    if (hash) items.push({ fragment: { kind: 'score', hash }, sha: newTip })
  }
  items.push({ fragment: { kind: 'commit', hash: newTip }, sha: newTip })
  const parent = index.commit(newTip)?.parents[0]
  items.push({
    fragment: { kind: 'glance', hash: `${parent ?? 'root'}.${newTip}` },
    sha: newTip,
  })
  if (manifest.bundle) items.push({ fragment: manifest.bundle, sha: newTip })
  return [
    ...new Map(
      items.map((i) => [`${i.fragment.kind}/${i.fragment.hash}`, i]),
    ).values(),
  ]
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const emptyManifest = (): TipManifest => ({
  tree: EMPTY_TREE,
  files: [],
  trees: [],
  bundle: null,
})
