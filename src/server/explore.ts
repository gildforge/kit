import { getCloudflareContext } from './context.js'
import { logAt } from './repo.js'
// Public listings use the same read boundary and rich catalog as portal pages.
import { repoList, type RepoRow } from './repo-list.js'
import { store } from './backend.js'
export type PublicRepo = RepoRow

export interface PublicCommit {
  owner: string
  repo: string
  hash: string
  message: string
  author: string
  /** Unix seconds, when the commit was authored. */
  at: number | null
}

import { publicActivityLoader } from './public-activity.js'

export const publicActivity = publicActivityLoader({
  owners: async () => (await store()).owners(),
  repos: (owner, names, candidates) => repoList(owner, null, undefined, Date.now(), names, candidates),
  commits: async (repos) => {
    const logs = await Promise.all(
      repos.map(async (repo) => {
        const log = repo.tip ? await logAt(repo.owner, repo.name, repo.tip, 6) : []
        return log.map((c) => ({
          owner: repo.owner,
          repo: repo.name,
          hash: c.hash,
          message: c.message.split('\n')[0],
          author: c.author?.name ?? 'unknown',
          at: c.authoredAt ?? null,
        }))
      }),
    )
    return logs
      .flat()
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, 6)
  },
  // Outside a request (tests, scripts) there is no context; the caller then awaits.
  defer: (work) => getCloudflareContext().ctx.waitUntil(work),
  prepare: async () => {
    const { env } = await getCloudflareContext()
    await (env as unknown as { PUBLIC_PAGES: { sendBatch(jobs: {body:{route:string;origin:string}}[]): Promise<void> } }).PUBLIC_PAGES.sendBatch([{ body: { route: '/', origin: 'https://gild.gg' } }])
  },
})
