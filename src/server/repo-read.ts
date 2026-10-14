import type { ForgeStore } from './backend.js'
import type { ListingSnapshot } from './repo-list-snapshot.js'
export interface RepoAccess {
  meta: string | null
  acl: ListingSnapshot['acl']
  internalPrefix?: string
  pending: boolean
}
export interface ReadServices {
  store: Pick<ForgeStore, 'orgRole'> &
    Partial<Pick<ForgeStore, 'settings' | 'getRepoAccess'>>
  index(
    owner: string,
    repo: string,
  ): Promise<{
    metaFile?: (path: string) => Promise<string | null>
    fragmentAccess?: (
      owner?: string,
      repo?: string,
    ) => Promise<{ acl: ListingSnapshot['acl'] }>
  } | null>
}
export const privateAcl = (acl: ListingSnapshot['acl']) =>
  acl.visibility === 'private' || acl.private === true
// Parsed policies are immutable per ACL revision. The current D1 fence is
// ALWAYS read first; a TTL memo of mutable visibility would permit leaks.
const policies = new Map<string, { at: number; acl: ListingSnapshot['acl'] }>()
export async function repoAccess(
  s: ReadServices,
  owner: string,
  repo: string,
): Promise<RepoAccess | null> {
  owner = owner.toLowerCase()
  if (s.store.getRepoAccess && s.store.settings) {
    const state = await s.store.settings.state(`${owner}/${repo}`),
      org = await s.store.settings.state(owner)
    if (
      state.deletedAt !== null ||
      org.deletedAt !== null ||
      state.id.startsWith('reserve:') ||
      org.id.startsWith('reserve:')
    )
      return null
    const access = await s.store.getRepoAccess(state.id, `${owner}/${repo}`)
    if (access) {
      const key = `${state.id}:${access.meta}:${JSON.stringify(access.acl)}`,
        now = Date.now(),
        cached = policies.get(key)
      if (cached && now - cached.at < 2000) access.acl = cached.acl
      else {
        if (policies.size > 256) policies.clear()
        policies.set(key, { at: now, acl: access.acl })
      }
      return access
    }
  }
  const index = await s.index(owner, repo)
  if (!index) return null
  try {
    const acl = index.fragmentAccess
      ? (await index.fragmentAccess(owner, repo)).acl
      : index.metaFile
        ? JSON.parse((await index.metaFile('.gild/acl.json')) ?? '{}')
        : null
    return acl ? { meta: null, acl, pending: false } : null
  } catch {
    return null
  }
}
/** Every read boundary calls this, including a cached projection (policy).
 * A pending ACL grants only structural owners/org members until publication.
 * Prior collaborators and agents are closed, so revocations cannot be delayed. */
export async function mayRead(
  s: ReadServices,
  owner: string,
  repo: string,
  name: string | null,
  policy?: RepoAccess,
) {
  const access = policy ?? (await repoAccess(s, owner, repo))
  return (
    !!access &&
    (await mayReadAcl(
      s.store,
      owner,
      name,
      access.pending ? { visibility: 'private' } : access.acl,
    ))
  )
}
/** May `name` see a repository's Actions, Agents, Score and event stream:
 *  the private-read rule, whatever the repository's visibility. */
export async function mayContribute(s: ReadServices, owner: string, repo: string, name: string | null, policy?: RepoAccess | null) {
  const access = policy ?? (await repoAccess(s, owner, repo))
  if (!access || !name) return false
  // Never wider than reading the repository itself (a private repository's
  // agent still needs its grants).
  if (!(await mayReadAcl(s.store, owner, name, access.pending ? { visibility: 'private' } : access.acl))) return false
  // An agent contributes once attached to the repository, as the channel admits it.
  if (name.includes('/')) return agentAttached(access.acl, name)
  return mayReadAcl(s.store, owner, name, { ...access.acl, visibility: 'private' })
}
/** An agent attached to a repository: named in its ACL, with or without grants. */
export function agentAttached(acl: ListingSnapshot['acl'], name: string) {
  const handle = `@${name}`.toLowerCase()
  return Object.keys(acl.agents ?? {}).some((n) => n.toLowerCase() === handle) ||
    [...(acl.read ?? []), ...(acl.write ?? [])].some((n) => n.toLowerCase() === handle)
}
export async function mayReadAcl(
  store: Pick<ForgeStore, 'orgRole'>,
  owner: string,
  name: string | null,
  acl: ListingSnapshot['acl'],
) {
  if (!privateAcl(acl)) return true
  owner = owner.toLowerCase()
  name = name?.toLowerCase() ?? null
  if (!name) return false
  return contributorAcl(owner, name, name.includes('/') || name === owner ? null : await store.orgRole(owner, name), acl)
}
/** A repository's contributors: its owner, the owning org's members, and
 *  everyone the ACL names (agents only by name or grant, never inherited).
 *  The private-read rule, and the gate on Actions, Agents and Score. */
export function contributorAcl(owner: string, name: string | null, role: unknown, acl: ListingSnapshot['acl']) {
  owner = owner.toLowerCase()
  name = name?.toLowerCase() ?? null
  if (!name) return false
  // Agents never inherit the sponsor's or organization member's access.
  if (name.includes('/'))
    return (
      (Array.isArray(acl.agents?.[`@${name}`]) &&
        (acl.agents![`@${name}`] as unknown[]).length > 0) ||
      [...(acl.read ?? []), ...(acl.write ?? [])].some(
        (n) => n.toLowerCase() === `@${name}`,
      )
    )
  if (name === owner || role) return true
  return [
    ...(acl.read ?? []),
    ...(acl.write ?? []),
    ...(acl.owners ?? []),
  ].some((n) => n.toLowerCase() === `@${name}`)
}
