import { kept, recall, keep } from './kept.js'
import type { RepoRow } from './repo-list.js'
import type { PublicCommit } from './explore.js'

interface Services {
  owners(): Promise<{ name: string }[]>
  repos(
    owner: string,
    names?: readonly string[],
    candidates?: readonly RepoRow[],
  ): Promise<RepoRow[]>
  keep?: typeof kept
  commits(repos: RepoRow[]): Promise<PublicCommit[]>
  /** Runs work after the response (ctx.waitUntil); without it a refresh is awaited. */
  defer?(work: Promise<unknown>): void
  recall?: typeof recall
  store?: typeof keep
  /** Production pages enqueue a producer instead of scanning on a miss. */
  prepare?(): Promise<void>
}

/** Share ranking/commit candidates across isolates under a minute bucket.
 * Hydrate only six candidates on hits: ACLs, deletion and counts remain live.
 * Immutable per-tip summaries are kept by repoList across isolates. */
export function publicActivityLoader(s: Services, now = Date.now) {
  return async (publication?: string) => {
    // Production visitors read the latest snapshot or enqueue preparation.
    // Publication computes the owner graph under its immutable input. The
    // direct scan fallback is for callers without a production prepare service.
    const bucket = Math.floor(now() / 60_000),
      read = s.recall ?? recall,
      write = s.store ?? keep,
      compute = async () => {
        const owners = (await s.owners()).filter(
          (o) => !/^(e2e-|smoketest)/.test(o.name),
        )
        const rows = (
          await Promise.all(owners.map((o) => s.repos(o.name)))
        ).flat()
        const repos = rows
          .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
          .slice(0, 6)
        return { repos, commits: await s.commits(repos.slice(0, 4)) }
        },
      scan = () => (s.keep ?? kept)(`landing:rows-v2:${bucket}`, compute).then(async (value) => {
          await write('landing:rows-v2:latest', { bucket, value })
          return value
        })
    type Rows = { repos: RepoRow[]; commits: PublicCommit[] }
    const latest = await read<{ bucket: number; value: Rows }>('landing:rows-v2:latest')
    let candidates: Rows
    if (publication) {
      candidates = await (s.keep ?? kept)('landing:publication:' + publication, compute)
      await write('landing:rows-v2:latest', { bucket, value: candidates })
    }
    else if (!latest && s.prepare) {
      await s.prepare()
      return { repos: [], commits: [], pending: true }
    }
    else if (latest && latest.bucket === bucket) candidates = latest.value
    else if (latest && s.prepare) {
      await s.prepare()
      candidates = latest.value
    }
    else if (latest) {
      const refresh = scan().catch(() => null)
      let deferred = false
      if (s.defer)
        try {
          s.defer(refresh)
          deferred = true
        } catch {}
      candidates = deferred ? latest.value : ((await refresh) ?? latest.value)
    } else candidates = await scan()
    const owners = [...new Set(candidates.repos.map((r) => r.owner))]
    const repos = (
      await Promise.all(
        owners.map((owner) =>
          s.repos(
            owner,
            candidates.repos
              .filter((r) => r.owner === owner)
              .map((r) => r.name),
            candidates.repos.filter((r) => r.owner === owner),
          ),
        ),
      )
    )
      .flat()
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    const visible = new Set(repos.map((r) => `${r.owner}/${r.name}`))
    return {
      repos,
      commits: candidates.commits.filter((c) =>
        visible.has(`${c.owner}/${c.repo}`),
      ),
    }
  }
}
