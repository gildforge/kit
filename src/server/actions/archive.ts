import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import type { D1Database } from '@cloudflare/workers-types'
import { d1Store } from '../drivers/d1.js'
import { MemFS } from '../../engine/memfs.js'
interface Env {
  DB: D1Database
  ARTIFACTS_TOKEN?: string
}
const ACCOUNT = '08b93c93f8b7adc43678e9afba31e4ee'
/** Explicit bindings, so DO alarms never depend on Next's request context. */
export async function archiveConnection(
  env: Env,
  owner: string,
  repo: string,
  scope = 'write',
) {
  if (!env.ARTIFACTS_TOKEN)
    throw new Error('Needs Sami: ARTIFACTS_TOKEN on gild-site/Worker')
  const namespace = `${(await d1Store(env.DB).getOrg(owner)) ? 'o' : 'u'}-${owner.toLowerCase()}`
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/${namespace}/tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.ARTIFACTS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ repo, scope, ttl: 300 }),
    },
  )
  const body = (await r.json()) as {
    success: boolean
    result: { plaintext: string }
  }
  if (!r.ok || !body.success)
    throw new Error('actions archive could not obtain repo write access')
  const token = body.result.plaintext.split('?')[0],
    url = `https://${ACCOUNT}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`
  return { token, url }
}
export async function writeRunRecord(
  env: Env,
  owner: string,
  repo: string,
  id: number,
  summary: unknown,
  connection?: { token: string; url: string },
) {
  const st = d1Store(env.DB),
    lease = await st.settings.lease(`${owner}/${repo}`)
  if (!lease) throw new Error('Repository is read-only')
  try {
    return await writeRecord(env, owner, repo, id, summary, connection)
  } finally {
    await st.settings.release(lease)
  }
}

async function writeRecord(
  env: Env,
  owner: string,
  repo: string,
  id: number,
  summary: unknown,
  connection?: { token: string; url: string },
) {
  const { token, url } =
    connection ?? (await archiveConnection(env, owner, repo))
  for (let attempt = 0; attempt < 4; attempt++) {
    const fs = new MemFS(),
      dir = '/repo'
    await fs.mkdir(dir)
    const onAuth = () => ({ username: 'x', password: token })
    await git.clone({
      fs: fs as never,
      http,
      dir,
      url,
      ref: '_meta',
      singleBranch: true,
      depth: 1,
      onAuth,
    })
    const path = `.gild/actions/${id}.json`,
      text = JSON.stringify(summary, null, 2) + '\n'
    if (
      (await fs
        .readFile(`${dir}/${path}`, { encoding: 'utf8' })
        .catch(() => null)) === text
    )
      return
    await fs.writeFile(`${dir}/${path}`, text)
    await git.add({ fs: fs as never, dir, filepath: path })
    await git.commit({
      fs: fs as never,
      dir,
      author: { name: 'gild', email: 'forge@gild.gg' },
      message: `actions: run #${id}\n`,
    })
    try {
      await git.push({ fs: fs as never, http, dir, url, ref: '_meta', onAuth })
      return
    } catch (e) {
      if (attempt === 3) throw e
    }
  }
}
