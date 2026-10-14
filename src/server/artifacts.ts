// Artifacts REST client. The forge talks to Cloudflare Artifacts over the
// account token (Worker secret ARTIFACTS_TOKEN); users never see repo tokens
// — git access goes through minted repo-scoped tokens later (the git proxy).
import { getCloudflareContext } from './context.js'
import { cache } from 'react'
import { memo } from './kept.js'
import { ApiError } from '../engine/api/errors.js'

const ACCOUNT = '08b93c93f8b7adc43678e9afba31e4ee'
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/artifacts`

/** Per-owner namespaces: repo <name> of user <owner> lives in u-<owner>,
 *  of org <owner> in o-<owner>. The kind comes from the store, so a name
 *  means exactly one owner kind everywhere. */
export const nsFor = (owner: string, kind: 'user' | 'org' = 'user') =>
  `${kind === 'org' ? 'o' : 'u'}-${owner.toLowerCase()}`

// Whether a name is a user or an org is fixed once it is claimed, so the
// lookup is remembered for a few minutes instead of hitting D1 per API call.
const namespaces = memo<string>(5 * 60_000)
const nsForOwner = (owner: string) =>
  namespaces(owner.toLowerCase(), async () => {
    const { store } = await import('./backend.js')
    const st = await store(),
      org = await st.getOrg(owner)
    if (!org && !(await st.getClaim(owner)))
      namespaces.forget(owner.toLowerCase())
    return nsFor(owner, org ? 'org' : 'user')
  })

async function token(): Promise<string> {
  const { env } = await getCloudflareContext()
  const t = (env as Record<string, unknown>).ARTIFACTS_TOKEN
  if (typeof t !== 'string' || !t)
    throw new Error('ARTIFACTS_TOKEN is not set on this worker')
  return t
}

async function call<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  credential?: string,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credential ?? (await token())}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || !data.success) {
    throw new ApiError(
      res.status === 404 ? 404 : res.status === 409 ? 409 : 503,
      data.errors?.[0]?.message ??
        `artifacts ${method} ${path}: HTTP ${res.status}`,
    )
  }
  return data.result as T
}

export interface RepoInfo {
  id: string
  name: string
  description: string | null
  default_branch: string
  created_at: string
  updated_at: string
  last_push_at: string | null
  /** Live settings already loaded by the catalog's owner batch. */
  listingState?: import('./settings-store.js').Entity
  catalogDescription?: string | null
  /** The stored listing read with listingState (null: none stored yet). */
  listingSnapshot?: import('./repo-list-snapshot.js').ListingSnapshot | null
  listingStars?: number
  /** The stored cqx report at the listing's tip (null: none yet). */
  listingReport?: string | null
}

export async function createRepo(
  owner: string,
  name: string,
  description?: string,
  defaultBranch = 'main',
) {
  return call<RepoInfo>(
    `/namespaces/${await nsForOwner(owner)}/repos`,
    'POST',
    {
      name,
      description,
      default_branch: defaultBranch,
    },
  )
}

export async function listRepos(owner: string) {
  return visibleRepos(owner, await rawListRepos(await nsForOwner(owner)))
}
/** Listing-only variant carries the settings batch to the card hydrator. */
export async function listListingRepos(owner: string) {
  return visibleRepos(owner, await rawListRepos(await nsForOwner(owner)), true)
}

/** When the caller already knows the owner kind (public listings walk every
 *  owner and should not look each one up again). */
export const listReposFor = async (owner: string, kind: 'user' | 'org') =>
  visibleRepos(owner, await rawListRepos(nsFor(owner, kind)))

export const rawListRepos = (ns: string, credential?: string) =>
  call<RepoInfo[]>(
    `/namespaces/${ns}/repos?limit=200&sort=updated_at&direction=desc`, 'GET', undefined, credential,
  ).catch(e => {if (e instanceof ApiError && e.status === 404) return []; throw e}) // no namespace yet = no repos

/** The cqx score key suffix for the current analyzer build (lib/repo-list scores). */
async function scoreSuffix() {
  const [{ BUILD }, { READS_VERSION }] = await Promise.all([import('./cqx-wasm.js'), import('../engine/cqx-reads.js')])
  return `#${BUILD}:${READS_VERSION}`
}
type Listed = NonNullable<Awaited<ReturnType<NonNullable<import('./backend.js').ForgeStore['listedListings']>>>>
function listed(batch: Listed, id: string, address: string, suffix: string) {
  const snapshot = batch.listings[id] ?? null
  return { listingSnapshot: snapshot, listingStars: batch.stars[id] ?? 0,
    ...(snapshot?.tip ? { listingReport: batch.scores[`${address}@${snapshot.tip}${suffix}`] ?? null } : {}) }
}
async function visibleRepos(owner: string, repos: RepoInfo[], listing = false) {
  owner = owner.toLowerCase()
  const { store } = await import('./backend.js')
  const st = await store()
  // A listing also needs each repo's stored snapshot and star count: read
  // them in the same round trip as the live states when the store can.
  const names = repos.map(r => r.name)
  const suffix = listing && st.listedListings ? await scoreSuffix() : undefined
  const batch = listing && st.listedListings ? await st.listedListings(owner, names, suffix) : null
  const states = new Map((batch?.states ?? await st.settings.listed(owner, names)).map(s => [s.key, s]))
  const rows = repos.map(r => {
    const s = states.get(`${owner}/${r.name}`)
    return s ? { ...r, description: s.description ?? r.description, default_branch: s.defaultBranch ?? r.default_branch, ...(listing ? { listingState: s, catalogDescription: r.description, ...(batch ? listed(batch, s.id, `${owner}/${r.name}`, suffix!) : {}) } : {}) } : null
  })
  return rows.filter((r) => r !== null)
}
export const rawRemote = (ns: string, repo: string) =>
  `https://${ACCOUNT}.artifacts.cloudflare.net/git/${ns}/${repo}.git`
export const rawToken = (ns: string, repo: string, scope: 'read' | 'write', credential?: string) =>
  call<{ plaintext: string }>(`/namespaces/${ns}/tokens`, 'POST', {
    repo,
    scope,
    ttl: 600,
  }, credential)
export const rawRepo = (
  ns: string,
  repo: string,
  method = 'GET',
  body?: unknown,
  credential?: string,
) =>
  call<RepoInfo>(
    `/namespaces/${ns}/repos${method === 'POST' ? '' : '/' + repo}`,
    method,
    body,
    credential,
  )

export interface LogEntry {
  hash: string
  treeHash?: string
  message: string
  author?: { name?: string; email?: string }
  /** Unix seconds. */
  authoredAt?: number
  committedAt?: number
}

export const repoLog = async (
  owner: string,
  repo: string,
  ref = 'main',
  limit = 10,
) =>
  call<LogEntry[]>(
    `/namespaces/${await nsForOwner(owner)}/repos/${repo}/log?ref=${ref}&limit=${limit}`,
  )

export async function repoFile(
  owner: string,
  repo: string,
  path: string,
  ref = 'main',
): Promise<string | null> {
  const res = await fetch(
    `${BASE}/namespaces/${await nsForOwner(owner)}/repos/${repo}/file?ref=${ref}&path=${encodeURIComponent(path)}`,
    {
      headers: { Authorization: `Bearer ${await token()}` },
    },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`artifacts file ${path}: HTTP ${res.status}`)
  return res.text()
}

export interface TreeEntry {
  name: string
  mode: string
  hash: string
  type: 'blob' | 'tree' | 'commit'
}

/** One directory level (the API has no recursive listing). Trees are
 *  content-addressed, so a hash always names the same entries. */
export const repoTree = async (owner: string, repo: string, hash: string) =>
  call<TreeEntry[]>(
    `/namespaces/${await nsForOwner(owner)}/repos/${repo}/tree/${hash}`,
  )

export const repoCommit = async (owner: string, repo: string, hash: string) =>
  call<LogEntry & { treeHash: string; parents: string[] }>(
    `/namespaces/${await nsForOwner(owner)}/repos/${repo}/commit/${hash}`,
  )

// The forge's own record of a repository (name, created_at, ...) barely
// changes; liveness (deleted, reserved) and the editable fields come from D1
// on every read. Re-read upstream at most once a minute per isolate.
const upstreamInfo = memo<RepoInfo>(60000)
const readRepoInfo = async (owner: string, repo: string, fresh = false) => {
  const { store } = await import('./backend.js'),
    st = await store(),
    [s, o] = await Promise.all([st.settings.state(`${owner}/${repo}`), st.settings.state(owner)])
  if (
    s.id.startsWith('reserve:') ||
    s.deletedAt !== null ||
    o.deletedAt !== null
  )
    throw new ApiError(404, 'Repository not found')
  const read = async () => call<RepoInfo>(`/namespaces/${await nsForOwner(owner)}/repos/${repo}`)
  const key = `${owner.toLowerCase()}/${repo}`
  if (fresh) upstreamInfo.forget(key)
  const info = await upstreamInfo(key, read)
  return { ...info, description: s.description ?? info.description, default_branch: s.defaultBranch ?? info.default_branch }
}
/** Read once per request, however many parts of the page ask (layout + tab).
 *  `.uncached` is for a retry after a passing failure. */
export const repoInfo = Object.assign(cache((owner: string, repo: string) => readRepoInfo(owner, repo)), {
  uncached: (owner: string, repo: string) => readRepoInfo(owner, repo, true),
})

/** Raw blob bytes by hash. */
export async function repoBlob(
  owner: string,
  repo: string,
  hash: string,
): Promise<Uint8Array> {
  const res = await fetch(
    `${BASE}/namespaces/${await nsForOwner(owner)}/repos/${repo}/blob/${hash}`,
    {
      headers: { Authorization: `Bearer ${await token()}` },
    },
  )
  if (!res.ok) throw new Error(`artifacts blob ${hash}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Mint a repo-scoped git token (the proxy trades gild tokens for these). */
export async function mintRepoToken(
  owner: string,
  repo: string,
  scope: 'read' | 'write',
  ttl = 600,
) {
  return call<{ plaintext: string }>(
    `/namespaces/${await nsForOwner(owner)}/tokens`,
    'POST',
    { repo, scope, ttl },
  )
}

// Reading refs needs a token each time; a read token lives an hour and is
// reused while it has at least five minutes left. Each mint is a billed
// Artifacts operation (from 14 Oct 2026).
const readTokens = memo<{ plaintext: string }>(55 * 60_000)
/** A read token with at least five minutes of life left, reused across requests. */
export const readToken = (owner: string, repo: string) =>
  readTokens(`${owner}/${repo}`.toLowerCase(), () =>
    mintRepoToken(owner, repo, 'read', 3600),
  )

export const repoRemote = async (owner: string, repo: string) =>
  `https://${ACCOUNT}.artifacts.cloudflare.net/git/${await nsForOwner(owner)}/${repo}.git`
