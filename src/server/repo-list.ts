import type { RepoInfo } from './artifacts.js'
import type { ForgeStore } from './backend.js'
import { activityBuckets } from '../engine/repo-summary.js'
import { mayRead } from './repo-read.js'
import type { ListingSnapshot } from './repo-list-snapshot.js'

export interface RepoRow extends RepoInfo {
  owner: string
  name: string
  description: string | null
  visibility: 'public' | 'private'
  archived: boolean
  language: { name: string; color: string } | null
  license: string | null
  stargazers_count: number
  issues: number
  pulls: number
  score: number | null
  /** Why a score is partial or missing (e.g. C-family outage); per-card note. */
  note?: string | null
  updated: number | null
  tip?: string | null
  activity: number[] | null
}
export interface ListServices {
  store: ForgeStore
  catalog(owner: string): Promise<RepoInfo[]>
  snapshots(
    repos: { id: string; name: string }[],
    owner: string,
  ): Promise<Record<string, ListingSnapshot>>
  scores(
    owner: string,
    repos: { name: string; tip: string | null; report?: string | null }[],
  ): Promise<Record<string, { score: number | null; note: string | null }>>
}

/** Live owner batch: published snapshots, stars and scores. Authorization is
 * evaluated after every read, including cached landing candidates. */
export async function repoList(
  owner: string,
  viewer: string | null,
  services?: ListServices,
  now = Date.now(),
  names?: readonly string[],
  candidates?: readonly RepoInfo[],
): Promise<RepoRow[]> {
  owner = owner.toLowerCase()
  viewer = viewer?.toLowerCase() ?? null
  const s = services ?? (await defaultServices())
  const catalog = (candidates ?? (await s.catalog(owner))).filter(
    (r) => !names || names.includes(r.name),
  )
  const states =
    candidates || catalog.some((r) => !r.listingState)
      ? await s.store.settings.listed(
          owner,
          catalog.map((r) => r.name),
        )
      : catalog.map((r) => r.listingState!)
  const byKey = new Map(states.map((state) => [state.key, state]))
  const repos = catalog.flatMap((r) => {
    const state = byKey.get(`${owner}/${r.name}`)
    return state ? [{ r, state }] : []
  })
  if (!repos.length) return []
  // Snapshots the catalog already read with its states are used as they are;
  // only the rest (none stored yet) go to the listing reader.
  // Shared (cached) candidates never carry request-time reads: re-read them.
  const prefetched = candidates ? {} : Object.fromEntries(repos.flatMap(({ r, state }) => (r.listingSnapshot ? [[state.id, r.listingSnapshot]] : [])))
  const rest = repos.filter(({ state }) => !prefetched[state.id])
  const snapshots = {
    ...prefetched,
    ...(rest.length ? await s.snapshots(rest.map(({ r, state }) => ({ id: state.id, name: r.name })), owner) : {}),
  }
  const visible = (
    await Promise.all(
      repos.map(async ({ r, state }) => {
        const snapshot = snapshots[state.id]
        if (
          !snapshot ||
          !(await mayRead({store:s.store,index:async()=>null}, owner, r.name, viewer, {meta:snapshot.meta,acl:snapshot.acl,pending:false}))
        )
          return null
        return { r, state, snapshot }
      }),
    )
  ).filter((r) => r !== null)
  const [stars, scores] = await Promise.all([
    !candidates && visible.every(({ r }) => r.listingStars !== undefined)
      ? Object.fromEntries(visible.map(({ r, state }) => [state.id, r.listingStars!]))
      : s.store.starCounts(visible.map(({ state }) => state.id)),
    s.scores(
      owner,
      visible.map(({ r, snapshot }) => ({ name: r.name, tip: snapshot.tip,
        // A report read with this very snapshot (same tip) needs no second read.
        ...(!candidates && r.listingSnapshot === snapshot && r.listingReport !== undefined ? { report: r.listingReport } : {}) })),
    ),
  ])
  return visible
    .map(({ r, state, snapshot }): RepoRow => {
      const { facts } = snapshot
      // Do not retain request-time settings inside the shared landing candidates.
      const { listingState, listingSnapshot, listingStars, listingReport, ...info } = r
      void listingState; void listingSnapshot; void listingStars; void listingReport
      return {
        ...info,
        owner,
        name: r.name,
        default_branch: state.defaultBranch ?? r.default_branch,
        description:
          state.description ??
          (r.catalogDescription !== undefined
            ? r.catalogDescription
            : r.description),
        visibility:
          snapshot.acl.visibility === 'private' || snapshot.acl.private === true
            ? 'private'
            : 'public',
        archived: state.archived,
        language: facts?.language ?? null,
        license: facts?.license ?? null,
        stargazers_count: stars[state.id] ?? 0,
        issues: snapshot.issues,
        pulls: snapshot.pulls,
        score: scores[r.name]?.score ?? null,
        note: scores[r.name]?.note ?? snapshot.note ?? null,
        tip: snapshot.tip,
        updated: snapshot.updated ?? facts?.updated ?? null,
        activity: facts ? activityBuckets(facts.weeks, now) : null,
      }
    })
    .sort(
      (a, b) =>
        (b.updated ?? 0) - (a.updated ?? 0) || a.name.localeCompare(b.name),
    )
}

/** D1 projection hits never wake a DO. Pre-existing indexes are migrated lazily
 * with one parallel RPC each; missing/unpublished indexes fail closed. */
export async function listingBatch(
  store: ForgeStore,
  repos: { id: string; name: string }[],
  read: (id: string) => Promise<ListingSnapshot | null>,
) {
  const values = await store.getListings(repos.map((r) => r.id))
  const missing = repos.filter((r) => !values[r.id])
  if (missing.length) {
    await Promise.all(missing.map(r => read(r.id)))
    // RPC snapshots are not a permission authority: a pre-push fence or failed
    // publication can outlive the old indexed ACL. Join the live D1 policy again.
    Object.assign(values, await store.getListings(missing.map(r => r.id)))
  }
  return values
}

async function defaultServices(): Promise<ListServices> {
  const [{ store }, { listListingRepos }, { getCloudflareContext }] =
    await Promise.all([
      import('./backend.js'),
      import('./artifacts.js'),
      import('./context.js'),
    ])
  const st = await store()
  return {
    store: st,
    catalog: listListingRepos,
    snapshots: async (repos, owner) => {
      const { env } = await getCloudflareContext()
      const ns = (
        env as unknown as {
          REPO_INDEX: {
            idFromName(id: string): unknown
            get(id: unknown): {
              listing(
                id: string,
                owner: string,
                repo: string,
              ): Promise<ListingSnapshot | null>
            }
          }
        }
      ).REPO_INDEX
      // Legacy name-based DO IDs were normalized by repoIndex; newer stable
      // entity IDs are opaque. Stars/projection keys retain their original ID.
      const names = new Map(repos.map((r) => [r.id, r.name]))
      return listingBatch(st, repos, (id) =>
        ns
          .get(ns.idFromName(id.includes('/') ? id.toLowerCase() : id))
          .listing(id, owner, names.get(id)!),
      )
    },
    scores: async (owner, repos) => {
      const [{ BUILD, CATEGORIES, scoreNote }, { READS_VERSION }] =
        await Promise.all([import('./cqx-wasm.js'), import('../engine/cqx-reads.js')])
      const keys = repos
        .filter((r) => r.tip)
        .map((r) => ({
          name: r.name,
          key: `${owner}/${r.name}@${r.tip}#${BUILD}:${READS_VERSION}`,
        }))
      const given = new Map(repos.filter((r) => r.report !== undefined).map((r) => [r.name, r.report ?? null]))
      const missing = keys.filter((r) => !given.has(r.name))
      const values: Record<string, string> = {
        ...Object.fromEntries(keys.flatMap((r) => (given.get(r.name) ? [[r.key, given.get(r.name)!]] : []))),
        ...(missing.length ? await st.getScores(missing.map((r) => r.key)) : {}),
      }
      return Object.fromEntries(
        keys.map(({ name, key }) => {
          const report = values[key]
            ? (JSON.parse(values[key]) as import('./cqx-wasm.js').Report | null)
            : null
          return [
            name,
            {
              // No lines scored is no score, not a zero or a perfect one.
              score:
                report && report.lines > 0
                  ? Math.round(
                      CATEGORIES.reduce((n, k) => n + report.scores[k], 0) /
                        CATEGORIES.length,
                    )
                  : null,
              note: scoreNote(report),
            },
          ]
        }),
      )
    },
  }
}
