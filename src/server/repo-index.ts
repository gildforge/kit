// Next-side typed RPC adapter. Only a cold repo schedules git work; ordinary
// indexed reads, including each search keystroke, stay entirely in SQLite.
import { cache } from 'react'
import type { RepoIndex } from './repo-index-do.js'
import type { Target } from '../engine/repo-indexer.js'
import type { Refs } from '../engine/repo-refs.js'
import { awaitCurrentIndex } from '../engine/repo-index-ready.js'
import { listRefs } from './repo-refs-live.js'
import { memo } from './kept.js'
import { ApiError } from '../engine/api/errors.js'
export type RepoIndexRPC = {
  [
    K in
      | 'address'
      | 'fragmentAccess'
      | 'fragmentPointer'
      | 'listing'
      | 'listingAcl'
      | 'storageBytes' | 'storageObjects' | 'recordStorageObjects' | 'deltaBase' | 'recordPush'
      | 'sessionList'
      | 'sessionGet'
      | 'sessionPut'
      | 'requestObject'
      | 'apiLog'
      | 'ensureHistory'
      | 'snapshotReady'
      | 'apiChanges'
      | 'apiHealth'
      | 'prepareScore'
      | 'pageChange'
      | 'rawBlob'
      | 'view'
      | 'hydrate'
      | 'refresh'
      | 'status'
      | 'refs'
      | 'tree'
      | 'commit'
      | 'file'
      | 'blobText'
      | 'log'
      | 'languages'
      | 'sizes'
      | 'metaFile'
      | 'metaFiles'
      | 'readiness'
      | 'metaItem'
      | 'findFiles'
      | 'findSymbols'
      | 'search'
  ]: (
    ...args: Parameters<RepoIndex[K]>
  ) => Promise<Awaited<ReturnType<RepoIndex[K]>>>
}
interface Namespace {
  idFromName(name: string): unknown
  get(id: unknown): RepoIndexRPC
}
const addressed = memo<void>(60_000)
export const repoIndex = cache(
  async (owner: string, repo: string): Promise<RepoIndexRPC | null> => {
    try {
      const { getCloudflareContext } = await import('./context.js')
      const { env } = await getCloudflareContext()
      const ns = (env as Record<string, unknown>).REPO_INDEX as
        Namespace | undefined
      const { store } = await import('./backend.js')
      const id = (
        await (await store()).settings.state(`${owner}/${repo}`.toLowerCase())
      ).id
      const index = ns?.get(ns.idFromName(id)) ?? null
      // The index learns its current address once a minute per isolate, not
      // on every page: one fewer Durable Object round trip on each read.
      if (index) await addressed(`${id}:${owner}/${repo}`, () => index.address(owner, repo))
      return index
    } catch {
      return null
    }
  },
)
// Names as gild issues them: no slashes, so `owner/repo` names one index.
const OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/i
const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/i

// What git advertises, checked at most every 30s per repo per isolate: a push
// that didn't come through gild (straight to Artifacts) is noticed within that.
const advertised = memo<Refs | null>(30_000)

/** The repo's current index, waiting briefly for an in-flight refresh.
 *  A refresh never means missing. Only a repo git actually knows gets an
 *  index: a typo or a made-up name never creates work. */
export const readyIndex = cache(async (owner: string, repo: string) => {
  if (!OWNER.test(owner) || !REPO.test(repo)) return null
  const index = await repoIndex(owner, repo)
  if (!index) return null
  const live = await advertised(`${owner}/${repo}`.toLowerCase(), () =>
    listRefs(owner, repo).catch(e => {
      if (e instanceof ApiError && e.status === 404) return null
      throw new ApiError(503, 'Repository refs are temporarily unavailable')
    }),
  )
  if (!live) return null
  return awaitCurrentIndex(index, owner, repo, live, async () => {
    // A completed refresh may be newer than the 30s advertisement memo.
    advertised.forget(`${owner}/${repo}`.toLowerCase())
    return listRefs(owner, repo)
  })
})

/** Page reads inspect one published snapshot. They never advertise Git refs
 * or wait for a refresh; writes keep the stricter readyIndex boundary above. */
export const pageIndex = cache(async (owner: string, repo: string) => {
  const index = await repoIndex(owner, repo)
  if (!index) throw new ApiError(503, 'Repository is being prepared')
  const { pageReads } = await import('./page.js')
  if ((await pageReads(owner, repo)).metadataReady === true) return index
  const { store } = await import('./backend.js')
  const st = await store(), state = await st.settings.state(`${owner}/${repo}`)
  const [access, snapshot] = await Promise.all([st.getRepoAccess(state.id), index.readiness()])
  if (!access || access.pending || !snapshot.status.ready || (snapshot.refs.meta || null) !== access.meta) {
    if (access && !snapshot.status.refreshing) await scheduleIndex(owner, repo)
    throw new ApiError(503, 'Repository is being prepared')
  }
  return index
})

export const pageRefs = cache(async (owner: string, repo: string): Promise<Refs> => {
  const result = await (await pageIndex(owner, repo)).refs()
  return {
    branches: result.refs.filter(r => r.kind === 'branch').map(r => ({ name: r.name, oid: r.hash })),
    tags: result.refs.filter(r => r.kind === 'tag').map(r => ({ name: r.name, oid: r.hash })),
    defaultBranch: result.defaultBranch, meta: result.meta || null,
  }
})

/** The index if it is ready, without ever starting work: for fan-out reads
 *  (site-wide search) that must not wake every cold repo. */
export async function indexIfReady(owner: string, repo: string) {
  const index = await repoIndex(owner, repo)
  if (!index) return null
  return (await index.status()).ready ? index : null
}
export async function indexRefs(
  owner: string,
  repo: string,
): Promise<Refs | null> {
  const index = await readyIndex(owner, repo)
  if (!index) return null
  const result = await index.refs()
  return {
    branches: result.refs
      .filter((r) => r.kind === 'branch')
      .map((r) => ({ name: r.name, oid: r.hash })),
    tags: result.refs
      .filter((r) => r.kind === 'tag')
      .map((r) => ({ name: r.name, oid: r.hash }))
      .sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true }),
      ),
    defaultBranch: result.defaultBranch,
    meta: result.meta || null,
  }
}
/** Durable alarm scheduling; errors do not change the outcome of a successful
 *  push. waitUntil holds only the scheduling RPC, never the backfill itself. */
export async function scheduleIndex(
  owner: string,
  repo: string,
  target?: Target,
  after?: Promise<unknown>,
) {
  advertised.forget(`${owner}/${repo}`.toLowerCase())
  const { getCloudflareContext } = await import('./context.js')
  try {
    const ctx = await getCloudflareContext()
    ctx.ctx.waitUntil(
      (async () => {
        await after
        const index = await repoIndex(owner, repo)
        await index?.refresh(owner, repo, target)
      })(),
    )
  } catch {
    /* Local contexts without a Worker binding have no index to wake. */
  }
}
