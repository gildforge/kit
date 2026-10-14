import { ApiError } from './api/errors.js'
import { sameTips, type Refs } from './repo-refs.js'

interface Readiness {
  status(): Promise<{ ready: boolean; refreshing: boolean }>
  refs(): Promise<{ refs: { kind: string; name: string; hash: string }[]; defaultBranch: string; meta: string | null }>
  refresh(owner: string, repo: string): Promise<unknown>
  /** status() and refs() in one round trip, when the index offers it. */
  readiness?(): Promise<{ status: { ready: boolean; refreshing: boolean }; refs: Awaited<ReturnType<Readiness['refs']>> }>
}

/** Keep authorization on a complete snapshot, including the current ACL.
 * A refresh cannot turn a known repository into a missing one. */
export async function awaitCurrentIndex<T extends Readiness>(
  index: T, owner: string, repo: string, live: Refs,
  readLive: () => Promise<Refs>,
  budgetMs = 5000,
) {
  const deadline = Date.now() + budgetMs
  let scheduled = false
  for (;;) {
    const both = index.readiness ? await index.readiness() : null
    const status = both?.status ?? await index.status()
    if (status.ready) {
      const r = both?.refs ?? await index.refs()
      const mine: Refs = {
        branches: r.refs.filter(x => x.kind === 'branch').map(x => ({ name: x.name, oid: x.hash })),
        tags: r.refs.filter(x => x.kind === 'tag').map(x => ({ name: x.name, oid: x.hash })),
        defaultBranch: r.defaultBranch,
        meta: r.meta || null,
      }
      if (sameTips(mine, live)) return index
      live = await readLive()
      if (sameTips(mine, live)) return index
    }
    if (Date.now() >= deadline)
      throw new ApiError(503, 'Repository is indexing; retry shortly')
    if (!scheduled && !status.refreshing) {
      await index.refresh(owner, repo)
      scheduled = true
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
