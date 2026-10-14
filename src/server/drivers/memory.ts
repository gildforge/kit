import { ownerNameAvailable } from '../../engine/backend-names.js'
import { memorySettings } from '../settings-store.js'
import type {
  ApiToken,
  Agent,
  AgentRequest,
  OrchestratorGrant,
  Claim,
  ForgeStore,
  Org,
  OrgMembership,
  OrgRole,
  PendingAuth,
  PendingClaim,
} from '../backend.js'

const TTL_MS = 5 * 60 * 1000
const CLAIMED_WINDOW_MS = 10 * 60 * 1000

/** In-process fallback (unit tests, bare node). Single-isolate only. */
export function memoryStore(): ForgeStore {
  const access = new Map<string, import('../repo-read.js').RepoAccess>()
  const fragments = new Map<string, Set<string>>()
  const invitations = new Map<string, import('../collaborators.js').Invitation>()
  const auth = new Map<string, PendingAuth>()
  const pending = new Map<string, PendingClaim>()
  const claims = new Map<string, Claim>()
  const claimed = new Map<string, { name: string; at: number }>()
  const browserProofs = new Map<string, { kind: 'auth' | 'claim'; state: string; createdAt: number; consumed: boolean }>()
  const apiTokens = new Map<string, ApiToken>()
  const orgs = new Map<string, Org>()
  const members = new Map<string, OrgMembership>()
  const agents = new Map<string, Agent>()
  const requests = new Map<string, AgentRequest>()
  const grants = new Map<string, OrchestratorGrant>()
  const scores = new Map<string, string>()
  const stars = new Map<string, Map<string, string>>()
  const changes = new Map<string, Uint8Array>()
  const listings = new Map<string, { revision: number; data: import('../repo-list-snapshot.js').ListingSnapshot }>()

  const live = <T extends { createdAt: number }>(
    map: Map<string, T>,
    key: string,
  ) => {
    const v = map.get(key)
    if (v && Date.now() - v.createdAt > TTL_MS) {
      map.delete(key)
      return null
    }
    return v ?? null
  }

  const settings = memorySettings((key, org) => {
    if (org) {
      orgs.delete(key)
      for (const [id, m] of members) if (m.org === key) members.delete(id)
    }
  })
  return {
    settings,
    async getRepoAccess(id) { return structuredClone(access.get(id) ?? null) },
    async fenceRepoAccess(id,meta) { access.set(id,{meta,acl:access.get(id)?.acl??{},pending:true}) },
    async publishRepoAccess(id,meta,acl) {
      const current=access.get(id)
      if(current && current.meta!==meta)return false
      access.set(id,{meta,acl:structuredClone(acl),pending:false});return true
    },
    async registerFragment(fragment,id) { const ids=fragments.get(fragment)??new Set();ids.add(id);fragments.set(fragment,ids) },
    async fragmentRepos(fragment) { return [...fragments.get(fragment)??[]].filter(id=>{const a=access.get(id);return a&&!a.pending&&a.acl.visibility!=='private'&&!a.acl.private}) },
    async invitations(repo,invitee) { return [...invitations.values()].filter(i=>(!repo||i.repo===repo)&&(!invitee||i.invitee===invitee)).map(i=>({...i})) },
    async inviteRepo(i) { const old=[...invitations.values()].find(v=>v.repo===i.repo&&v.invitee===i.invitee);invitations.set(old?.id??i.id,{...i,id:old?.id??i.id}) },
    async removeInvitation(id) { invitations.delete(id) },
    async star(repo, name) {
      const rows = stars.get(repo) ?? new Map<string, string>()
      if (!rows.has(name)) rows.set(name, new Date().toISOString())
      stars.set(repo, rows)
    },
    async unstar(repo, name) { stars.get(repo)?.delete(name) },
    async starred(repo, name) { return stars.get(repo)?.has(name) ?? false },
    async starCount(repo) { return stars.get(repo)?.size ?? 0 },
    async starCounts(repos) { return Object.fromEntries(repos.map(repo => [repo, stars.get(repo)?.size ?? 0])) },
    async getListings(ids) { return Object.fromEntries(ids.filter(id => listings.has(id)).map(id => {
      const snapshot=structuredClone(listings.get(id)!.data),a=access.get(id)
      snapshot.acl=!a||a.pending||a.meta!==snapshot.meta?{visibility:'private'}:structuredClone(a.acl)
      return [id,snapshot]
    })) },
    async putListing(id, revision, data) { if (revision > (listings.get(id)?.revision ?? -1)) listings.set(id, { revision, data: structuredClone(data) }) },
    async deleteListing(id) { listings.delete(id) },
    async stargazers(repo) { return [...(stars.get(repo) ?? [])].map(([name, created_at]) => ({ name, created_at })).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name)) },
    async updateOrgDescription(org, description) {
      const o = orgs.get(org)
      if (o) o.description = description
    },
    async removeOrgMember(org, member) {
      members.delete(`${org}${member}`)
    },
    async renameOrg(from, to) {
      const o = orgs.get(from)!
      orgs.delete(from)
      orgs.set(to, { ...o, name: to })
      for (const [k, m] of members)
        if (m.org === from) {
          members.delete(k)
          members.set(`${to}${m.member}`, { ...m, org: to })
        }
      await settings.rename(from, to, true)
    },
    async createChallenge(challenge, browserState) {
      auth.set(challenge, { challenge, createdAt: Date.now() })
      if (browserState) browserProofs.set(challenge, { kind: 'auth', state: browserState, createdAt: Date.now(), consumed: false })
    },
    async completeBrowserChallenge(kind, challenge, browserState) {
      const proof = browserProofs.get(challenge)
      if (!proof || proof.kind !== kind || proof.state !== browserState || proof.consumed) return null
      const age = Date.now() - proof.createdAt
      const answer = kind === 'auth' ? auth.get(challenge)?.answered : claimed.get(challenge)
      if (!answer) return age <= TTL_MS ? { status: 'pending' } : null
      if (age > (kind === 'auth' ? TTL_MS : CLAIMED_WINDOW_MS)) return null
      // No await between checking and consuming: single-isolate atomicity.
      proof.consumed = true
      if (kind === 'auth' && 'publicKey' in answer) return { status: 'complete', publicKey: answer.publicKey }
      const claim = claims.get((answer as { name: string }).name)!
      return { status: 'complete', publicKey: claim.publicKey, name: claim.name }
    },
    async getChallenge(challenge) {
      return live(auth, challenge)
    },
    async answerChallenge(challenge, publicKey, signature) {
      const entry = live(auth, challenge)
      if (!entry) return null
      entry.answered = { publicKey, signature }
      return entry
    },
    async getClaim(name) {
      return claims.get(name.toLowerCase()) ?? null
    },
    async prepareClaim(name, publicKey, email, challenge, browserState) {
      pending.set(challenge, {
        challenge,
        name: name.toLowerCase(),
        publicKey,
        email,
        createdAt: Date.now(),
      })
      if (browserState) browserProofs.set(challenge, { kind: 'claim', state: browserState, createdAt: Date.now(), consumed: false })
    },
    async getPendingClaim(challenge) {
      return live(pending, challenge)
    },
    async finalizeClaim(challenge) {
      const entry = live(pending, challenge)
      if (!entry) return null
      if (await this.nameTaken(entry.name)) return false
      const claim: Claim = {
        name: entry.name,
        publicKey: entry.publicKey,
        email: entry.email,
        emailVerified: false,
        claimedAt: new Date().toISOString(),
      }
      claims.set(entry.name, claim)
      pending.delete(challenge)
      claimed.set(challenge, { name: entry.name, at: Date.now() })
      return claim
    },
    async claimByKey(publicKey) {
      for (const c of claims.values()) if (c.publicKey === publicKey) return c
      return null
    },
    async saveApiToken(hash, name, publicKey, expiresAt, options) {
      apiTokens.set(hash, {
        name,
        publicKey,
        expiresAt,
        scopes: options?.scopes ?? null,
        repos: options?.repos ?? null,
        label: options?.label ?? '',
        createdAt: Date.now(),
      })
    },
    async getApiToken(hash) {
      const t = apiTokens.get(hash)
      return t && Date.now() <= t.expiresAt ? { ...t } : null
    },
    async listApiTokens(name) {
      return [...apiTokens]
        .filter(([, t]) => t.name === name && t.expiresAt > Date.now())
        .map(([id, t]) => ({ id, ...t }))
    },
    async deleteApiToken(name, id) {
      if (apiTokens.get(id)?.name !== name) return false
      return apiTokens.delete(id)
    },
    async claimedName(challenge) {
      const c = claimed.get(challenge)
      return c && Date.now() - c.at <= CLAIMED_WINDOW_MS ? c.name : null
    },

    async createOrg(name, description, createdBy) {
      const now = new Date().toISOString()
      orgs.set(name, { name, description, createdBy, createdAt: now })
      members.set(`${name}${createdBy}`, {
        org: name,
        member: createdBy,
        role: 'owner',
        addedAt: now,
      })
    },
    async getOrg(name) {
      return (await settings.state(name.toLowerCase())).deletedAt !== null
        ? null
        : (orgs.get(name.toLowerCase()) ?? null)
    },
    async orgsFor(member) {
      const out: (Org & { role: OrgRole })[] = []
      for (const m of members.values()) {
        if (m.member !== member) continue
        const o = orgs.get(m.org)
        if (o && (await settings.state(o.name)).deletedAt === null)
          out.push({ ...o, role: m.role })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },
    async orgRole(org, member) {
      return members.get(`${org.toLowerCase()}${member}`)?.role ?? null
    },
    async orgMembers(org) {
      return [...members.values()].filter((m) => m.org === org.toLowerCase())
    },
    async addOrgMember(org, member, role) {
      members.set(`${org.toLowerCase()}${member}`, {
        org: org.toLowerCase(),
        member,
        role,
        addedAt: new Date().toISOString(),
      })
    },
    async owners() {
      return [
        ...[...claims.keys()].map((name) => ({ name, kind: 'user' as const })),
        ...(
          await Promise.all(
            [...orgs.keys()].map(async (name) =>
              (await settings.state(name)).deletedAt === null ? name : null,
            ),
          )
        )
          .filter((name) => name !== null)
          .map((name) => ({ name, kind: 'org' as const })),
      ]
    },

    async createAgent(sponsor, label, publicKey, approvedBy) {
      const agent: Agent = {
        name: `${sponsor}/${label}`,
        sponsor,
        label,
        publicKey,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        approver: false,
        approvedBy: approvedBy ?? null,
        sponsoredBy: null,
        childScope: null,
        childRepo: null,
        suspendedAt: null,
        suspendedBy: null,
      }
      if (agents.has(agent.name)) throw new Error('agent exists')
      agents.set(agent.name, agent)
      return agent
    },
    async getAgent(name) {
      return agents.get(name.toLowerCase()) ?? null
    },
    async agentsFor(sponsor) {
      return [...agents.values()].filter((a) => a.sponsor === sponsor)
    },
    async revokeAgent(name) {
      const a = agents.get(name)
      if (a && !a.revokedAt) a.revokedAt = new Date().toISOString()
    },

    async setApprover(name, approver) {
      const a = agents.get(name)
      if (a) a.approver = approver
    },
    async grantOrchestrator(g) {
      const key = `${g.agent}\n${g.scope}`
      const row = { ...g, grantedBy: grants.get(key)?.grantedBy ?? g.grantedBy, grantedAt: grants.get(key)?.grantedAt ?? new Date().toISOString() }
      grants.set(key, row)
      return { ...row }
    },
    async revokeOrchestrator(agent, scope) {
      return grants.delete(`${agent}\n${scope}`)
    },
    async orchestratorGrants(agent) {
      return [...grants.values()].filter((g) => g.agent === agent.toLowerCase())
    },
    async orchestratorsIn(scopes) {
      return [...grants.values()].filter((g) => scopes.includes(g.scope))
    },
    async createChildAgent(c) {
      const name = `${c.human}/${c.label}`
      if (agents.has(name)) return 'taken'
      if ([...agents.values()].filter((a) => a.sponsoredBy === c.orchestrator && !a.revokedAt).length >= c.childLimit) return 'limit'
      const at = new Date().toISOString()
      const agent: Agent = { name, sponsor: c.human, label: c.label, publicKey: c.publicKey, createdAt: at, revokedAt: null, approver: false, approvedBy: c.orchestrator, sponsoredBy: c.orchestrator, childScope: c.scope, childRepo: c.repoId, suspendedAt: null, suspendedBy: null }
      agents.set(name, agent)
      requests.set(c.requestId, { id: c.requestId, sponsor: c.human, label: c.label, publicKey: c.publicKey, repo: c.repo, grants: c.grants, note: c.note, status: 'approved', createdAt: at, decidedAt: at, decidedBy: c.orchestrator, tokenIssued: true })
      return { ...agent }
    },
    async childrenOf(orchestrator) {
      return [...agents.values()].filter((a) => a.sponsoredBy === orchestrator.toLowerCase())
    },
    async setSuspended(name, by) {
      const a = agents.get(name)
      if (!a || a.revokedAt || !!a.suspendedAt === !!by) return false
      a.suspendedAt = by ? new Date().toISOString() : null
      a.suspendedBy = by
      return true
    },
    async createAgentRequest(r) {
      const req: AgentRequest = {
        ...r,
        status: 'pending',
        createdAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        tokenIssued: false,
      }
      requests.set(r.id, req)
      return req
    },
    async getAgentRequest(id) {
      return requests.get(id) ?? null
    },
    async pendingRequestsFor(sponsor) {
      return [...requests.values()].filter(
        (r) => r.sponsor === sponsor && r.status === 'pending',
      )
    },
    async decideAgentRequest(id, status, by, grants) {
      const r = requests.get(id)
      if (r && r.status === 'pending')
        Object.assign(r, {
          status,
          decidedAt: new Date().toISOString(),
          decidedBy: by,
          grants,
        })
    },
    async getScore(key) {
      return scores.get(key) ?? null
    },
    async getScores(keys) { return Object.fromEntries(keys.filter(key => scores.has(key)).map(key => [key, scores.get(key)!])) },

    async putScore(key, report) {
      scores.set(key, report)
    },

    async getChange(key) {
      return changes.get(key) ?? null
    },

    async putChange(key, data) {
      changes.set(key, data)
    },

    async takeRequestToken(id) {
      const r = requests.get(id)
      if (!r || r.status !== 'approved' || r.tokenIssued) return false
      r.tokenIssued = true
      return true
    },

    async nameTaken(name) {
      const n = name.toLowerCase()
      if (!ownerNameAvailable(n)) return true
      return (await settings.reserved(n)) || claims.has(n) || orgs.has(n)
    },
  }
}
