// Orchestrator agents (Sami, 9 Oct).
//
// An owner or admin grants an agent `orchestrator` on a repo or an org. Under
// that grant the agent may:
//   - spawn child agents in the repo: an auto-approved join request, scopes
//     never wider than its own token, grants never wider than its own here,
//     at most `child_limit` live children;
//   - suspend and resume its children (and their children): a suspended agent
//     leaves the channel, gets no channel.mention and its tokens answer 403;
//   - read every agent's channel.mention events in the repo (the raw view).
// Revoking the grant revokes every child spawned under it, recursively.
// Neutrality holds: children run on the orchestrator's own machine; gild only
// grants identity and routes messages.
import type { Context, Result } from './api/dispatch.js'
import type { Agent, ForgeStore, OrchestratorGrant } from './backend.js'
import { repoAccess, type ReadServices } from './repo-read.js'
import { ApiError, requireFound } from '../engine/api/errors.js'
import { grantScopes, hasScope, type Principal, type Scope } from '../engine/api/scopes.js'
import { channelFrom, type ChannelBindings } from './channel/binding.js'
import type { ChildAgent } from '../engine/api/orchestrator-contract.js'
import { grantList, type Grant } from './access.js'

export const DEFAULT_CHILD_LIMIT = 10
type Store = Pick<ForgeStore, 'settings' | 'getAgent' | 'orgRole' | 'getOrg' | 'revokeAgent' | 'grantOrchestrator' | 'revokeOrchestrator' | 'orchestratorGrants' | 'orchestratorsIn' | 'createChildAgent' | 'childrenOf' | 'setSuspended'>

/** The grant scopes that cover owner/repo: the repo itself and its owner. */
export async function coveringScopes(st: Pick<ForgeStore, 'settings'>, owner: string, repo: string) {
  const [r, o] = await Promise.all([st.settings.state(`${owner}/${repo}`), st.settings.state(owner)])
  return { repoScope: `repo:${r.id}`, orgScope: `org:${o.id}`, repoId: r.id }
}

/** The agent's grant covering owner/repo (a repo grant wins over the org's). */
export async function grantIn(st: Store, agent: string, owner: string, repo: string): Promise<OrchestratorGrant | null> {
  if (!agent.includes('/')) return null
  const { repoScope, orgScope } = await coveringScopes(st, owner, repo)
  const grants = await st.orchestratorGrants(agent)
  return grants.find((g) => g.scope === repoScope) ?? grants.find((g) => g.scope === orgScope) ?? null
}

/** Orchestrators granted on owner/repo or its org, for the participants list. */
export async function orchestratorNames(st: Pick<ForgeStore, 'settings' | 'orchestratorsIn'>, owner: string, repo: string) {
  const { repoScope, orgScope } = await coveringScopes(st, owner, repo)
  return new Set((await st.orchestratorsIn([repoScope, orgScope])).map((g) => g.agent))
}

/** The raw view: of `repos`, those where `viewer` is an orchestrator. */
export async function orchestratedRepos(st: Pick<ForgeStore, 'settings' | 'orchestratorGrants'>, viewer: string, repos: string[]) {
  if (!viewer.includes('/')) return []
  const scopes = new Set((await st.orchestratorGrants(viewer)).map((g) => g.scope))
  if (!scopes.size) return []
  const raw: string[] = []
  for (const r of repos) {
    const [owner, repo] = r.split('/')
    const { repoScope, orgScope } = await coveringScopes(st, owner, repo)
    if (scopes.has(repoScope) || scopes.has(orgScope)) raw.push(r)
  }
  return raw
}

/** Revoke an agent and everything below it: its children, their children,
 *  and the orchestrator grants any of them held. Returns the descendants. */
export async function revokeTree(st: Pick<Store, 'revokeAgent' | 'childrenOf' | 'orchestratorGrants' | 'revokeOrchestrator'>, name: string) {
  const revoked: string[] = []
  const queue = [name], seen = new Set<string>()
  while (queue.length) {
    const next = queue.shift()!
    if (seen.has(next)) continue
    seen.add(next)
    await st.revokeAgent(next)
    for (const g of await st.orchestratorGrants(next)) await st.revokeOrchestrator(next, g.scope)
    if (next !== name) revoked.push(next)
    for (const child of await st.childrenOf(next)) if (!child.revokedAt) queue.push(child.name)
  }
  return revoked
}

/** Revoke one orchestrator grant and every child spawned under it. */
export async function revokeGrant(st: Store, agent: string, scope: string) {
  if (!(await st.revokeOrchestrator(agent, scope))) return null
  const revoked: string[] = []
  for (const child of await st.childrenOf(agent))
    if (!child.revokedAt && child.childScope === scope) revoked.push(child.name, ...(await revokeTree(st, child.name)))
  return revoked
}

/** Keep the repo's orchestrator record in step with the agent's coordinate grant. */
export async function syncCoordinate(st: Pick<ForgeStore, 'settings' | 'orchestratorGrants' | 'grantOrchestrator' | 'revokeOrchestrator' | 'childrenOf' | 'revokeAgent'>, owner: string, repo: string, agent: string, coordinate: boolean, by: string) {
  if (!agent.includes('/')) return
  const { repoScope } = await coveringScopes(st, owner, repo)
  const held = (await st.orchestratorGrants(agent)).some((g) => g.scope === repoScope)
  if (coordinate && !held) await st.grantOrchestrator({ agent, scope: repoScope, childLimit: DEFAULT_CHILD_LIMIT, grantedBy: by })
  else if (!coordinate && held) await revokeGrant(st as Store, agent, repoScope)
}

/** Repo owner, or an owner/admin of the owning org. Agents never are. */
async function repoAdmin(st: Pick<ForgeStore, 'orgRole'>, owner: string, name: string) {
  if (!name || name.includes('/')) return false
  return name.toLowerCase() === owner.toLowerCase() || ['owner', 'admin'].includes((await st.orgRole(owner, name)) ?? '')
}

/** Channel posting is implied by repo:write, so a child may carry
 *  channel:write when the orchestrator holds either; every other scope must
 *  be held exactly. The child is never wider than the orchestrator. */
export function covers(p: Principal, scope: Scope) {
  return hasScope(p, scope) || (scope === 'channel:write' && hasScope(p, 'repo:write'))
}
export const childScopes = (grants: readonly string[]): Scope[] => [...new Set<Scope>([...grantScopes(grants), 'channel:write'])]

/** Is `ancestor` the orchestrator above `name` (directly or further up)? */
async function sponsors(st: Pick<ForgeStore, 'getAgent'>, ancestor: string, agent: Agent) {
  let current: Agent | null = agent
  for (let depth = 0; current?.sponsoredBy && depth < 32; depth++) {
    if (current.sponsoredBy === ancestor) return true
    current = await st.getAgent(current.sponsoredBy)
  }
  return false
}

export interface OrchestratorDeps {
  bindings(): Promise<ChannelBindings>
  createToken(name: string, key: string, options: { scopes: string[]; repos?: string[]; label: string }): Promise<string>
  /** Attach the agent to the repo's acl (an empty grant list still attaches). */
  attach(owner: string, repo: string, by: string, agent: string, grants: Grant[]): Promise<unknown>
}

export function orchestratorHandler(s: ReadServices & { store: ForgeStore }, deps: OrchestratorDeps) {
  const st = s.store
  const aclGrants = async (owner: string, repo: string, agent: string) =>
    grantList(((await repoAccess(s, owner, repo))?.acl as { agents?: Record<string, string[]> } | undefined)?.agents?.[`@${agent}`])
  const childView = async (owner: string, repo: string, a: Agent): Promise<ChildAgent> => ({
    name: a.name,
    label: a.label,
    sponsor: a.sponsoredBy ?? '',
    human: a.sponsor,
    repo: `${owner}/${repo}`,
    grants: await aclGrants(owner, repo, a.name),
    suspended: !!a.suspendedAt,
    suspended_at: a.suspendedAt,
    suspended_by: a.suspendedBy,
    created_at: a.createdAt,
    revoked_at: a.revokedAt,
  })
  const grantView = async (g: OrchestratorGrant) => ({
    agent: g.agent,
    scope: g.scope.startsWith('org:') ? ('org' as const) : ('repo' as const),
    child_limit: g.childLimit,
    children: (await st.childrenOf(g.agent)).filter((c) => !c.revokedAt).length,
    granted_by: g.grantedBy,
    granted_at: g.grantedAt,
  })
  const person = (c: Context) => {
    if (!c.principal.name || c.principal.name.includes('/')) throw new ApiError(403, 'A person is required')
  }
  const target = (c: Context) => `${c.params.sponsor}/${c.params.label}`.replace(/^@/, '').toLowerCase()
  const grantable = async (name: string) => {
    const agent = await st.getAgent(name.replace(/^@/, '').toLowerCase())
    if (!agent || agent.revokedAt) throw new ApiError(404, 'Agent not found')
    return agent
  }

  return async (c: Context): Promise<Result> => {
    const id = c.route.id, name = c.principal.name, { owner, repo, org } = c.params

    if (id === 'orgOrchestrators' || id === 'setOrgOrchestrator' || id === 'deleteOrgOrchestrator') {
      person(c)
      if (c.principal.repos !== null) throw new ApiError(403, 'Organization and agent administration requires an unrestricted token')
      requireFound(await st.getOrg(org), 'Organization not found')
      const role = await st.orgRole(org, name)
      if (!role) throw new ApiError(404, 'Organization not found')
      const scope = `org:${(await st.settings.state(org)).id}`
      if (id === 'orgOrchestrators') return { data: { orchestrators: await Promise.all((await st.orchestratorsIn([scope])).map(grantView)) }, noStore: true }
      if (!['owner', 'admin'].includes(role)) throw new ApiError(403, 'Organization owner or admin required')
      if (id === 'setOrgOrchestrator') {
        const agent = await grantable(c.body.agent)
        return { data: await grantView(await st.grantOrchestrator({ agent: agent.name, scope, childLimit: c.body.child_limit, grantedBy: name })) }
      }
      const agent = target(c), revoked = await revokeGrant(st, agent, scope)
      if (!revoked) throw new ApiError(404, 'Orchestrator grant not found')
      return { data: { ok: true as const, agent, revoked } }
    }

    const { repoScope, orgScope, repoId } = await coveringScopes(st, owner, repo)
    if (id === 'repoOrchestrators')
      return { data: { orchestrators: await Promise.all((await st.orchestratorsIn([repoScope, orgScope])).map(grantView)) }, noStore: true }
    if (id === 'setRepoOrchestrator' || id === 'deleteRepoOrchestrator') {
      person(c)
      if (!(await repoAdmin(st, owner, name))) throw new ApiError(403, 'Only a repository owner or admin can grant orchestrator')
      if (id === 'setRepoOrchestrator') {
        const agent = await grantable(c.body.agent)
        return { data: await grantView(await st.grantOrchestrator({ agent: agent.name, scope: repoScope, childLimit: c.body.child_limit, grantedBy: name })) }
      }
      const agent = target(c), revoked = await revokeGrant(st, agent, repoScope)
      if (!revoked) throw new ApiError(404, 'Orchestrator grant not found')
      return { data: { ok: true as const, agent, revoked } }
    }

    // Agent-facing operations: the orchestrator grant is the authority.
    const grant = await grantIn(st, name, owner, repo)
    const admin = await repoAdmin(st, owner, name)
    if (!name.includes('/') && c.principal.scopes !== null && !hasScope(c.principal, 'agents'))
      throw new ApiError(403, 'Requires agents scope')

    if (id === 'childAgents') {
      if (!grant && !admin) throw new ApiError(403, 'Requires the coordinate grant on this repository')
      const parents = grant ? [name] : (await st.orchestratorsIn([repoScope, orgScope])).map((g) => g.agent)
      const children = (await Promise.all([...new Set(parents)].map((o) => st.childrenOf(o)))).flat().filter((a) => a.childRepo === repoId)
      return { data: await Promise.all(children.map((a) => childView(owner, repo, a))), noStore: true }
    }

    if (id === 'createChildAgent') {
      if (!name.includes('/')) throw new ApiError(403, 'Agents with the coordinate grant launch agents; people approve join requests')
      if (!grant) throw new ApiError(403, 'Requires the coordinate grant on this repository')
      const orchestrator = requireFound(await st.getAgent(name), 'Agent not found')
      const own = await aclGrants(owner, repo, name)
      c.body.grants = grantList(c.body.grants)
      if (c.body.grants.includes('coordinate')) throw new ApiError(403, 'Only a person grants coordinate')
      const extra = c.body.grants.filter((g: Grant) => !own.includes(g))
      if (extra.length) throw new ApiError(403, `@${name} doesn't hold ${extra.join(', ')} in ${owner}/${repo}, so it can't grant it`)
      const scopes = childScopes(c.body.grants)
      const wider = scopes.filter((scope) => !covers(c.principal, scope))
      if (wider.length) throw new ApiError(403, `Cannot grant scopes you do not hold: ${wider.join(', ')}`)
      const requestId = crypto.randomUUID().replaceAll('-', '').slice(0, 20)
      const created = await st.createChildAgent({
        requestId,
        human: orchestrator.sponsor,
        label: c.body.label,
        publicKey: c.body.publicKey,
        repo: `${owner}/${repo}`,
        repoId,
        grants: c.body.grants,
        note: c.body.note ?? null,
        orchestrator: name,
        scope: grant.scope,
        childLimit: grant.childLimit,
      })
      if (created === 'taken') throw new ApiError(409, `@${orchestrator.sponsor}/${c.body.label} already exists; pick another label`)
      if (created === 'limit') throw new ApiError(403, `@${name} has launched its limit of ${grant.childLimit} agents`)
      await deps.attach(owner, repo, name, created.name, c.body.grants)
      const token = await deps.createToken(created.name, c.body.publicKey, { scopes, repos: [`${owner}/${repo}`], label: `launched by @${name}` })
      return {
        data: { ...(await childView(owner, repo, created)), grants: c.body.grants, scopes, token, request_id: requestId },
        status: 201,
      }
    }

    // suspendAgent / resumeAgent
    const agent = await st.getAgent(target(c))
    if (!agent || agent.revokedAt) throw new ApiError(404, 'Agent not found')
    const allowed = name.includes('/')
      ? !!grant && agent.name !== name && (await sponsors(st, name, agent))
      : agent.sponsor === name || (admin && (agent.childRepo === repoId || (await grantIn(st, agent.name, owner, repo)) !== null))
    if (!allowed) throw new ApiError(403, name.includes('/') ? 'Agents with the coordinate grant take offline only the agents they launched' : 'Repository owner or admin required')
    const suspend = id === 'suspendAgent'
    if (!(await st.setSuspended(agent.name, suspend ? name : null)))
      throw new ApiError(409, `@${agent.name} is ${suspend ? 'already suspended' : 'not suspended'}`)
    const after = requireFound(await st.getAgent(agent.name))
    const channel = channelFrom(await deps.bindings(), repoId)
    await channel.note(`${suspend ? 'suspend' : 'resume'}:${agent.name}:${after.suspendedAt ?? new Date().toISOString()}`, name, `${suspend ? 'suspended' : 'resumed'} @${agent.name}`)
    await channel.accessChanged()
    return { data: { agent: agent.name, suspended: !!after.suspendedAt, suspended_at: after.suspendedAt, suspended_by: after.suspendedBy } }
  }
}
