// Per-request page data for server components: every loader is React
// cache()d, so the portal layout, the repository layout and the page share
// one answer per request. On a repository address the Worker's privacy step
// already read the policy, the viewer, stars and role in ONE D1 batch and
// handed it over (PAGE_READS_HEADER): those reads then cost no round trip.
import { cache } from 'react'
import { requestCookie, requestHeaders } from './request.js'
import { binding, decorateStore, store } from './backend.js'
import { SESSION_COOKIE, verifySessionCookie } from '../engine/session-cookie.js'
import { d1PageReads, d1ViewerReads, pageStore, PAGE_READS_HEADER, type PageReads, type PageSession, type PageViewer } from './page-reads.js'
import { identityForPage, type PageIdentity } from './page-identity.js'
export type { PageIdentity } from './page-identity.js'
import { storeReads } from './repo-context.js'
import type { Entity } from './settings-store.js'

async function sessionSecret() {
  try {
    const { getCloudflareContext } = await import('./context.js')
    return ((await getCloudflareContext()).env as { SESSION_SECRET?: string }).SESSION_SECRET
  } catch {
    return undefined
  }
}

/** The verified session cookie (signature and expiry; no I/O). */
export const pageSession = cache(async (): Promise<PageSession | null> => {
  const raw = await requestCookie(SESSION_COOKIE)
  if (!raw) return null
  const s = await verifySessionCookie(raw, await sessionSecret())
  return s && { publicKey: s.publicKey, name: s.name }
})

const handed = cache(async (): Promise<PageReads | null> => {
  const raw = (await requestHeaders()).get(PAGE_READS_HEADER)
  if (!raw) return null
  try { return JSON.parse(decodeURIComponent(raw)) as PageReads } catch { return null }
})

// Within one page render (a GET), each settings state is read once: the
// listing's batched states also answer later per-repository lookups.
const renderStates = cache(() => new Map<string, Promise<Entity>>())
// Store reads for this request's page address answer from the handed batch.
decorateStore(async (st) => {
  const given = await handed()
  if (!given) return st
  const base = pageStore(st, given), states = renderStates()
  const seed = (rows: Entity[]) => { for (const row of rows) if (!states.has(row.key)) states.set(row.key, Promise.resolve(structuredClone(row))) }
  return {
    ...base,
    settings: {
      ...base.settings,
      state: async (k) => {
        let row = states.get(k)
        if (!row) { row = base.settings.state(k); states.set(k, row); row.catch(() => states.delete(k)) }
        return structuredClone(await row)
      },
      listed: async (owner, names) => { const rows = await base.settings.listed(owner, names); seed(rows); return rows },
    },
    ...(base.listedListings ? { listedListings: async (...args: Parameters<NonNullable<typeof base.listedListings>>) => { const r = await base.listedListings!(...args); seed(r.states); return r } } : {}),
  }
})

/** The repository page's policy, viewer, stars and role (one batch). */
export const pageReads = cache(async (owner: string, repo: string): Promise<PageReads> => {
  const address = `${owner.toLowerCase()}/${repo}`, given = await handed()
  if (given?.address === address) return given
  const db = await binding(), session = await pageSession()
  if (db) return d1PageReads(db, owner, repo, session)
  // In-memory store (unit tests, bare node): the same answers, unbatched.
  const viewer = await memoryViewer(session)
  const st = await store(), reads = await storeReads(st, owner, repo, viewer?.name ?? null), org = await st.getOrg(owner)
  return { ...reads, address, viewer, ownerKey: owner.toLowerCase(), ownerAliased: false,
    org: org && { name: org.name, description: org.description ?? null, created_by: org.createdBy, created_at: org.createdAt } }
})

async function memoryViewer(session: PageSession | null): Promise<PageViewer | null> {
  if (!session) return null
  const st = await store(), claim = await st.claimByKey(session.publicKey), name = claim?.name ?? session.name
  if (!name) return null
  const profile = await st.settings.profile(name)
  return { name, email: claim?.email ?? null, profile: JSON.stringify(profile) }
}

/** The signed-in viewer (claims + profile), or null. */
export const pageViewer = cache(async (): Promise<PageViewer | null> => {
  const given = await handed()
  if (given) return given.viewer
  const db = await binding(), session = await pageSession()
  return db ? d1ViewerReads(db, session) : memoryViewer(session)
})

/** What the header and sidebar show: name and resolved picture. A valid
 *  session whose key has no claim yet shows its key fingerprint. */
export const pageIdentity = cache(async (): Promise<PageIdentity | null> => {
  const viewer = await pageViewer()
  return identityForPage(viewer, viewer ? null : await pageSession())
})

/** The `_meta` commit D1 publishes for this request's repository (from the
 *  Worker's page reads), or null when it is fenced, unknown or another address. */
export async function pageMetaCommit(owner: string, repo: string): Promise<{ id: string; meta: string } | null> {
  const given = await handed()
  const access = given?.address === `${owner.toLowerCase()}/${repo}` ? given.access : null
  return access?.value && !access.value.pending && access.value.meta ? { id: access.id, meta: access.value.meta } : null
}
