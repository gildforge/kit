import type { D1Database } from '@cloudflare/workers-types'
import type { ObjectSource } from '../../engine/repo-indexer.js'
import { d1Store } from '../drivers/d1.js'
import { artifactsApi, type AccountEnv } from '../account.js'
/** Alarm-side counterpart to lib/repo.ts. Uses the same tree/blob/commit REST
 * reads, with explicit Worker bindings; the RunQueue caches by object hash. */
export async function artifactSource(
  env: { DB: D1Database; ARTIFACTS_TOKEN?: string } & AccountEnv,
  owner: string,
  repo: string,
): Promise<ObjectSource> {
  if (!env.ARTIFACTS_TOKEN)
    throw new Error('Needs Sami: ARTIFACTS_TOKEN on gild-site/Worker')
  const namespace = `${(await d1Store(env.DB).getOrg(owner)) ? 'o' : 'u'}-${owner.toLowerCase()}`
  const base = `${artifactsApi(env)}/artifacts/namespaces/${namespace}/repos/${repo}`
  const read = async (kind: string, hash: string) => {
    const r = await fetch(`${base}/${kind}/${hash}`, {
      headers: { authorization: `Bearer ${env.ARTIFACTS_TOKEN}` },
    })
    if (!r.ok) throw new Error(`Actions could not read repository ${kind}`)
    return r
  }
  const json = async (kind: string, hash: string) => {
    const b = (await (await read(kind, hash)).json()) as {
      success: boolean
      result: any
    }
    if (!b.success) throw new Error(`Actions could not read repository ${kind}`)
    return b.result
  }
  return {
    commit: async (hash) => {
      const c = await json('commit', hash)
      return {
        hash,
        tree: c.treeHash,
        parents: c.parents ?? [],
        message: c.message,
        author_name: c.author?.name ?? '',
        author_email: c.author?.email ?? '',
        time: c.authoredAt ?? c.committedAt ?? 0,
      }
    },
    tree: async (hash) =>
      (
        (await json('tree', hash)) as {
          name: string
          hash: string
          type: 'tree' | 'blob' | 'commit'
          mode: string
        }[]
      ).map((e) => ({ ...e, child: e.hash })),
    blob: async (hash) =>
      new Uint8Array(await (await read('blob', hash)).arrayBuffer()),
  }
}
