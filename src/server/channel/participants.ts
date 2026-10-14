import type { ForgeStore } from '../backend.js'
import type { Principal } from '../../engine/api/scopes.js'
import { SCOPES, hasScope, permitsRepo } from '../../engine/api/scopes.js'
import { repoAccess, mayRead, agentAttached, type ReadServices, type RepoAccess } from '../repo-read.js'
import { ApiError } from '../../engine/api/errors.js'
import type { ChannelParticipant } from '../../engine/api/channel-contract.js'
import { orchestratorNames } from '../orchestrators.js'
export async function channelAccess(s: ReadServices, owner: string, repo: string, p: Principal) {
  const policy = await repoAccess(s, owner, repo)
  if (!policy || !(await mayRead(s, owner, repo, p.name || null, policy))) throw new ApiError(404, 'Repository not found')
  const acl = policy.acl
  const writer = !p.anonymous && !p.name.includes('/') && (p.name === owner || ['owner','admin'].includes(await s.store.orgRole(owner,p.name) ?? '') || (acl.write ?? []).includes(`@${p.name}`) || (acl.owners ?? []).includes(`@${p.name}`))
  const canPost = channelPermission(p,owner,repo,acl,writer)
  return { policy, canPost }
}
/** One posting decision for initial HTML, REST islands and live socket presence. */
export function channelPermission(p:Principal,owner:string,repo:string,acl:RepoAccess['acl'],writer:boolean) {
  const attached = agentAttached(acl, p.name)
  return !p.anonymous && permitsRepo(p, owner, repo) && (hasScope(p,'repo:write') || hasScope(p,'channel:write')) && (p.name.includes('/') ? attached : writer)
}
export async function participantList(st: ForgeStore, owner: string, repo: string, acl: Awaited<ReturnType<typeof channelAccess>>['policy']['acl'], online: string[]): Promise<ChannelParticipant[]> {
  const facts = st.channelFacts ? await st.channelFacts(owner,repo,acl,online) : await participantFacts(st,owner,repo,acl,online)
  return participantsFrom(facts,owner,repo,acl,online)
}
export interface ParticipantFacts {
  org: boolean
  members: {member:string;role:string}[]
  agents: {name:string;sponsor:string;revokedAt:string|null;suspendedAt:string|null}[]
  tokens: {name:string;expiresAt:number;repos:string[]|null;scopes:string[]|null}[]
  orchestrators: string[]
}
export async function participantFacts(st: ForgeStore,owner:string,repo:string,acl: Awaited<ReturnType<typeof channelAccess>>['policy']['acl'],online:string[]):Promise<ParticipantFacts> {
  const names=[...new Set([...Object.keys(acl.agents ?? {}),...(acl.read ?? []),...(acl.write ?? []),...online].map(n=>n.replace(/^@/, '')).filter(n=>n.includes('/')))]
  const [members,org,orchestrators,agents,tokens]=await Promise.all([st.orgMembers(owner),st.getOrg(owner),orchestratorNames(st,owner,repo),Promise.all(names.map(n=>st.getAgent(n))),Promise.all(names.map(n=>st.listApiTokens(n)))])
  return {members,org:!!org,orchestrators:[...orchestrators],agents:agents.filter(a=>a!==null),tokens:tokens.flat().filter(t=>t.name!==null) as ParticipantFacts['tokens']}
}
export function participantsFrom(facts:ParticipantFacts,owner:string,repo:string,acl: Awaited<ReturnType<typeof channelAccess>>['policy']['acl'],online:string[]):ChannelParticipant[] {
  const {members}=facts
  const humans = new Set([...(facts.org ? [] : [owner]), ...members.map(m=>m.member), ...(acl.owners ?? []), ...(acl.write ?? []), ...(acl.read ?? []), ...online].map(n=>n.replace(/^@/, '')).filter(n=>!n.includes('/')))
  const agents = new Set([...Object.keys(acl.agents ?? {}), ...(acl.read ?? []), ...(acl.write ?? []), ...online].map(n=>n.replace(/^@/, '')).filter(n=>n.includes('/')))
  const rows: ChannelParticipant[] = []
  const orchestrators = new Set(facts.orchestrators)
  for (const name of [...humans, ...agents]) {
    const agent = name.includes('/') ? facts.agents.find(a=>a.name===name) : null
    // Suspended agents leave the channel: not listed, so never mentioned.
    if (name.includes('/') && (!agent || agent.revokedAt || agent.suspendedAt)) continue
    const scopes = agent ? [...new Set(facts.tokens.filter(t=>t.name===name).filter(t=>t.expiresAt>Date.now() && (t.repos === null || t.repos.includes(`${owner}/${repo}`))).flatMap(t=>t.scopes ?? SCOPES))].sort() : []
    const admin = agent ? scopes.includes('admin') : name === owner || ['owner','admin'].includes(members.find(m=>m.member===name)?.role ?? '') || (acl.owners ?? []).includes(`@${name}`)
    const write = agent ? scopes.includes('repo:write') || scopes.includes('channel:write') : admin || (acl.write ?? []).includes(`@${name}`)
    // IRC ranks: @ op, % halfop, + voice. An orchestrator runs agents, not the repo.
    rows.push({ name, kind: agent ? 'agent' : 'human', prefix: admin ? '@' : agent && orchestrators.has(name) ? '%' : write ? '+' : '', scopes, sponsor: agent?.sponsor ?? null, online: online.includes(name) })
  }
  return rows.sort((a,b)=>Number(a.kind==='agent')-Number(b.kind==='agent') || a.name.localeCompare(b.name))
}
export function mentionedAgents(body: string, attached: string[]) {
  const tags = new Set([...body.matchAll(/(?:^|[^\w/@])@([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)(?![\w/-])/gi)].map(m=>m[1].toLowerCase()))
  // Short labels notify only when unambiguous in this repo.
  return attached.filter(name=>tags.has(name.toLowerCase()) || (tags.has(name.split('/')[1].toLowerCase()) && attached.filter(n=>n.split('/')[1].toLowerCase()===name.split('/')[1].toLowerCase()).length===1))
}
