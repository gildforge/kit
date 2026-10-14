// The forge backend port. Drivers:
//   d1      — Cloudflare D1 (sqlite; production and `next dev` via local bindings)
//   memory  — in-process fallback (unit tests, bare node)
//
// Self-hosted gild runs the same Next app; there the d1 driver is swapped for
// gild-server's sqlite file. The interface is async everywhere because D1 is.
import type { D1Database } from '@cloudflare/workers-types'
import { d1Store } from './drivers/d1.js'
import { memoryStore } from './drivers/memory.js'

export { NAME_RE,AGENT_LABEL_RE } from '../engine/backend-names.js'

export interface Claim {
  name: string
  publicKey: string
  email: string
  emailVerified: boolean
  claimedAt: string
}

export interface PendingClaim {
  challenge: string
  name: string
  publicKey: string
  email: string
  createdAt: number
}

export interface PendingAuth {
  challenge: string
  createdAt: number
  answered?: { publicKey: string; signature: string }
}

export type BrowserCompletion = { status: 'pending' } | { status: 'complete'; publicKey: string; name?: string }

export type OrgRole = 'owner' | 'admin' | 'member'

export interface Org {
  name: string
  description: string | null
  createdBy: string
  createdAt: string
}

export interface OrgMembership {
  org: string
  member: string
  role: OrgRole
  addedAt: string
}

export interface Agent {
  name: string
  sponsor: string
  label: string
  publicKey: string | null
  createdAt: string
  revokedAt: string | null
  /** May approve new agents for its sponsor. */
  approver: boolean
  /** Who let it in: the sponsor, or one of their approver agents. */
  approvedBy: string | null
  /** The orchestrator agent that spawned it (null for joined agents). */
  sponsoredBy: string | null
  /** The orchestrator grant it was spawned under ('repo:<id>' | 'org:<id>'). */
  childScope: string | null
  /** Settings id of the repo it was spawned in. */
  childRepo: string | null
  suspendedAt: string | null
  suspendedBy: string | null
}

/** An agent's orchestrator grant on a repo or org (scope 'repo:<id>' | 'org:<id>'). */
export interface OrchestratorGrant {
  agent: string
  scope: string
  childLimit: number
  grantedBy: string
  grantedAt: string
}

/** What an orchestrator files for a child: an auto-approved join request. */
export interface ChildAgentInput {
  requestId: string
  human: string
  label: string
  publicKey: string
  repo: string
  repoId: string
  grants: string[]
  note: string | null
  orchestrator: string
  scope: string
  childLimit: number
}

export interface AgentRequest {
  id: string
  sponsor: string
  label: string
  publicKey: string
  repo: string | null
  grants: string[]
  note: string | null
  status: 'pending' | 'approved' | 'denied'
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  tokenIssued: boolean
}



export interface ApiToken {
  name: string | null; publicKey: string; scopes: string[] | null; repos: string[] | null
  label: string; createdAt: number; expiresAt: number
}

export interface ForgeStore {
  channelFacts?(owner:string,repo:string,acl: import('./repo-list-snapshot.js').ListingSnapshot['acl'],online:string[]):Promise<import('./channel/participants.js').ParticipantFacts>

  getRepoAccess(id: string, repository?: string): Promise<import('./repo-read.js').RepoAccess | null>
  fenceRepoAccess(id: string, meta: string | null): Promise<void>
  publishRepoAccess(id: string, meta: string | null, acl: import('./repo-list-snapshot.js').ListingSnapshot['acl']): Promise<boolean>
  registerFragment(fragment: string, id: string): Promise<void>
  fragmentRepos(fragment: string): Promise<string[]>
  invitations(repo?: string, invitee?: string): Promise<import('./collaborators.js').Invitation[]>
  inviteRepo(invitation: import('./collaborators.js').Invitation): Promise<void>
  removeInvitation(id: string): Promise<void>
  star(repo: string, name: string): Promise<void>
  unstar(repo: string, name: string): Promise<void>
  starred(repo: string, name: string): Promise<boolean>
  starCount(repo: string): Promise<number>
  starCounts(repos: readonly string[]): Promise<Record<string, number>>
  stargazers(repo: string): Promise<{ name: string; created_at: string }[]>
  settings: import('./settings-store.js').SettingsStore
  updateOrgDescription(org:string,description:string):Promise<void>
  removeOrgMember(org: string, member: string): Promise<void>
  renameOrg(from: string, to: string): Promise<void>

  createChallenge(challenge: string, browserState?: string): Promise<void>
  /** Match the browser's state hash and consume an answered proof atomically. */
  completeBrowserChallenge(kind: 'auth' | 'claim', challenge: string, browserState: string): Promise<BrowserCompletion | null>
  getChallenge(challenge: string): Promise<PendingAuth | null>
  answerChallenge(challenge: string, publicKey: string, signature: string): Promise<PendingAuth | null>

  getClaim(name: string): Promise<Claim | null>
  prepareClaim(name: string, publicKey: string, email: string, challenge: string, browserState?: string): Promise<void>
  getPendingClaim(challenge: string): Promise<PendingClaim | null>
  /** null = unknown/expired; false = name taken in the meantime. */
  finalizeClaim(challenge: string): Promise<Claim | false | null>
  claimedName(challenge: string): Promise<string | null>

  /** Look up a claim by the key that signed for it. */
  claimByKey(publicKey: string): Promise<Claim | null>

  /** API tokens (git push auth). Stored as sha256 hashes, never plaintext. */
  saveApiToken(hash: string, name: string | null, publicKey: string, expiresAt: number, options?: { scopes?: string[]; repos?: string[]; label?: string }): Promise<void>
  getApiToken(hash: string): Promise<ApiToken | null>
  listApiTokens(name: string): Promise<(ApiToken & { id: string })[]>
  deleteApiToken(name: string, id: string): Promise<boolean>

  /** Orgs. Names share the claim namespace — nameTaken() is the guard both
   *  sides check before reserving one. */
  createOrg(name: string, description: string | null, createdBy: string): Promise<void>
  getOrg(name: string): Promise<Org | null>
  orgsFor(member: string): Promise<(Org & { role: OrgRole })[]>
  orgRole(org: string, member: string): Promise<OrgRole | null>
  orgMembers(org: string): Promise<OrgMembership[]>
  addOrgMember(org: string, member: string, role: OrgRole): Promise<void>
  /** true if the name is reserved by a claim or an org. */
  nameTaken(name: string): Promise<boolean>

  /** Every repo owner on this forge (claimed names and orgs), for public
   *  listings. Hosted repos are public, so this is not a privacy boundary. */
  owners(): Promise<{ name: string; kind: 'user' | 'org' }[]>

  /** cqx score reports, keyed by repo, commit, cqx version and reads version. */
  getScore(key: string): Promise<string | null>
  getScores(keys: readonly string[]): Promise<Record<string, string>>
  getListings(ids: readonly string[]): Promise<Record<string, import('./repo-list-snapshot.js').ListingSnapshot>>
  /** settings.listed + getListings + starCounts (+ getScores at each listed
   *  tip, keys `owner/name@tip<scoreSuffix>`) for those names in one round trip (D1). */
  listedListings?(owner: string, names: readonly string[], scoreSuffix?: string): Promise<{ states: import('./settings-store.js').Entity[]; listings: Record<string, import('./repo-list-snapshot.js').ListingSnapshot>; stars: Record<string, number>; scores: Record<string, string> }>
  putListing(id: string, revision: number, snapshot: import('./repo-list-snapshot.js').ListingSnapshot): Promise<void>
  deleteListing(id: string): Promise<void>
  putScore(key: string, report: string): Promise<void>
  /** Computed commit and pull request views (gzipped JSON), keyed by commit hashes. */
  getChange(key: string): Promise<Uint8Array | null>
  putChange(key: string, data: Uint8Array): Promise<void>

  /** Agents (subaccounts). `name` is `<sponsor>/<label>`. */
  createAgent(sponsor: string, label: string, publicKey: string | null, approvedBy?: string): Promise<Agent>
  getAgent(name: string): Promise<Agent | null>
  agentsFor(sponsor: string): Promise<Agent[]>
  revokeAgent(name: string): Promise<void>
  setApprover(name: string, approver: boolean): Promise<void>
  /** Orchestrator grants. grant() upserts; revoke() reports whether one existed. */
  grantOrchestrator(g: Omit<OrchestratorGrant, 'grantedAt'>): Promise<OrchestratorGrant>
  revokeOrchestrator(agent: string, scope: string): Promise<boolean>
  orchestratorGrants(agent: string): Promise<OrchestratorGrant[]>
  orchestratorsIn(scopes: readonly string[]): Promise<OrchestratorGrant[]>
  /** Atomically files the approved request and creates the child, unless the
   *  orchestrator already holds `childLimit` live children ('limit') or the
   *  name is taken ('taken'). */
  createChildAgent(input: ChildAgentInput): Promise<Agent | 'limit' | 'taken'>
  /** Live and revoked agents an orchestrator spawned. */
  childrenOf(orchestrator: string): Promise<Agent[]>
  /** Suspend (by = who) or resume (by = null). false when nothing changed. */
  setSuspended(name: string, by: string | null): Promise<boolean>

  /** Join requests filed by agents. */
  createAgentRequest(r: Omit<AgentRequest, 'status' | 'createdAt' | 'decidedAt' | 'decidedBy' | 'tokenIssued'>): Promise<AgentRequest>
  getAgentRequest(id: string): Promise<AgentRequest | null>
  pendingRequestsFor(sponsor: string): Promise<AgentRequest[]>
  decideAgentRequest(id: string, status: 'approved' | 'denied', by: string, grants: string[]): Promise<void>
  /** Marks the token as handed over; false if it already was. */
  takeRequestToken(id: string): Promise<boolean>
}

let memory: ForgeStore | null = null

/** The D1 binding, or null outside a Worker (memory store). */
export async function binding(): Promise<D1Database | null> {
  try {
    const { getCloudflareContext } = await import('./context.js')
    const ctx = await getCloudflareContext()
    return (ctx.env as Record<string, unknown>).DB as D1Database | null ?? null
  } catch {
    return null
  }
}

/** The Next render registers a decorator (lib/page.ts): on a request that
 *  carries the Worker's page reads, those reads answer the page address's
 *  policy lookups without a round trip. Everything else stays live. */
let decorate: ((st: ForgeStore) => Promise<ForgeStore>) | null = null
export function decorateStore(fn: (st: ForgeStore) => Promise<ForgeStore>) { decorate = fn }

export async function store(): Promise<ForgeStore> {
  const db = await binding()
  if (db) {
    const st = d1Store(db)
    if (!decorate) return st
    try { return await decorate(st) } catch { return st }
  }
  if (!memory) memory = memoryStore()
  return memory
}
