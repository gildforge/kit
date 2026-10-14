import type { ForgeStore, OrgRole } from './backend.js'
import type { MetaIndex } from './metastore.js'
import type { RepoInfo } from './artifacts.js'
import type { Entity, SettingsStore } from './settings-store.js'
import { mayRead, contributorAcl, type RepoAccess } from './repo-read.js'
import { repoState } from './repo-state.js'

/** Every D1 row the repository layout needs, read in one round trip.
 *  Keys are the ones the shared policy functions ask for, so they answer
 *  from here instead of the database; any other key falls through. */
export interface RepoReads {
  /** Exact-key `settings.state` rows: `owner/repo` and `owner`, owner lowercased. */
  states: Record<string, Entity>
  /** `getRepoAccess` for the `owner/repo` entity id. */
  access: { id: string; value: RepoAccess | null }
  /** Whether `settings.canonical(owner/repo)` follows an alias (then it is not prefetched). */
  aliased: boolean
  /** `repoState(owner, repo)` when not aliased, with its star count and the viewer's star. */
  canonical: { state: Entity; stars: number; starred: boolean }
  /** `orgRole(owner, viewer)`, both lowercased; null without a viewer. */
  role: OrgRole | null
}

export interface RepoContextDeps {
  store: ForgeStore
  /** One batched read (D1), or the same answers composed from the store. */
  reads(owner: string, repo: string, viewer: string | null): Promise<RepoReads>
  viewer(): Promise<{ name?: string | null } | null>
  info(owner: string, repo: string): Promise<RepoInfo | null>
  /** The repo's ready index (`readyIndex`): the policy fallback and `_meta` files. */
  index(owner: string, repo: string): Promise<{ metaFile(path: string): Promise<string | null> } | null>
  readIndex(owner: string, repo: string): Promise<MetaIndex>
  mayWrite(owner: string, name: string | null, st: Pick<ForgeStore, 'orgRole'>): Promise<boolean>
}

export interface RepoContext {
  info: RepoInfo
  viewer: string | null
  state: Entity
  stars: number
  starred: boolean
  acl: { visibility?: string; private?: boolean }
  imported: { url: string; readOnly?: boolean; mirror?: boolean } | null
  index: MetaIndex
  write: boolean
  /** May see Actions, Agents and Score (the private-read rule). */
  contributor: boolean
}

/** The same answers as `repoReads` without a D1 binding: the store's own
 *  methods, independent ones in parallel. */
export async function storeReads(st: ForgeStore, owner: string, repo: string, viewer: string | null): Promise<RepoReads> {
  const o = owner.toLowerCase(), key = `${o}/${repo}`
  const [state, ownerState, canonicalKey, role] = await Promise.all([
    st.settings.state(key), st.settings.state(o), st.settings.canonical(key),
    viewer ? st.orgRole(o, viewer.toLowerCase()) : null,
  ])
  const canonical = await st.settings.state(canonicalKey)
  const [value, stars, starred] = await Promise.all([
    st.getRepoAccess(state.id), st.starCount(canonical.id), viewer ? st.starred(canonical.id, viewer) : false,
  ])
  return { states: { [key]: state, [o]: ownerState }, access: { id: state.id, value }, aliased: false, canonical: { state: canonical, stars, starred }, role }
}

/** A store whose policy reads answer from `r`; every other read is live. */
export function prefetched(st: ForgeStore, r: RepoReads, owner: string, repo: string, viewer: string | null) {
  const o = owner.toLowerCase(), key = `${o}/${repo}`, name = viewer?.toLowerCase() ?? null
  const states = { ...r.states, ...(r.aliased ? {} : { [r.canonical.state.key]: r.canonical.state }) }
  const settings: SettingsStore = {
    ...st.settings,
    state: async (k) => (k in states ? structuredClone(states[k]) : st.settings.state(k)),
    canonical: async (k) => {
      const [first, ...rest] = k.split('/')
      return !r.aliased && [first.toLowerCase(), ...rest].join('/') === key ? r.canonical.state.key : st.settings.canonical(k)
    },
  }
  return {
    settings,
    getRepoAccess: async (id: string) => (id === r.access.id ? structuredClone(r.access.value) : st.getRepoAccess(id)),
    orgRole: async (org: string, member: string) => (name && org.toLowerCase() === o && member === name ? r.role : st.orgRole(org, member)),
  }
}

/** Everything the repository layout renders. null = 404: a missing repo and
 *  an unreadable private one are indistinguishable. Policy decides before
 *  any repository data leaves this function. */
export async function repoContext(d: RepoContextDeps, owner: string, repo: string): Promise<RepoContext | null> {
  // Independent work starts together: metadata, the viewer, the index.
  const infoP = d.info(owner, repo), viewerP = d.viewer(), indexP = d.index(owner, repo)
  for (const p of [infoP, indexP]) p.catch(() => {}) // awaited below unless an earlier step throws
  const viewer = (await viewerP)?.name ?? null
  const readsP = d.reads(owner, repo, viewer)
  readsP.catch(() => {})
  // Only a repo that really doesn't exist is a 404; an API error stays an error.
  const info = await infoP
  if (!info) return null
  const reads = await readsP, pre = prefetched(d.store, reads, owner, repo, viewer)
  if (!(await mayRead({ store: pre, index: d.index }, owner, repo, viewer))) return null
  const state = await repoState(pre, owner, repo)
  const same = state.id === reads.canonical.state.id
  const [stars, starred, aclText, importText, index, write] = await Promise.all([
    same ? reads.canonical.stars : d.store.starCount(state.id),
    !viewer ? false : same ? reads.canonical.starred : d.store.starred(state.id, viewer),
    indexP.then((i) => i?.metaFile('.gild/acl.json') ?? null),
    indexP.then((i) => i?.metaFile('.gild/import/source.json') ?? null),
    d.readIndex(owner, repo),
    d.mayWrite(owner, viewer, pre),
  ])
  const acl = JSON.parse(aclText ?? '{}')
  return {
    info, viewer, state, stars, starred, index, write,
    contributor: write || contributorAcl(owner, viewer, reads.role, reads.access.value?.acl ?? acl),
    acl,
    imported: importText ? JSON.parse(importText) : null,
  }
}
