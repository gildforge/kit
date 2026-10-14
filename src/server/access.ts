// Who may do what in a repo.
//
// People: the repo's owner, or an owner/admin of the owning org, may do
// everything ("writer"). Anyone signed in may open issues, comment and open
// pull requests from branches that already exist.
//
// Agents (`<sponsor>/<label>`, e.g. sami/codex) may do only what the repo's
// `.gild/acl.json` on `_meta` grants them:
//   pr      push branches other than the default branch, claim issues
//   review  approve or request changes
//   queue   add approved pull requests to the merge queue
// Agents never push the default branch: their work lands through the queue.
import { csrfSafe } from '../engine/csrf.js'
import { type Principal } from '../engine/api/scopes.js'
import { permitsRequest } from '../engine/api/routing.js'
import { store, type ForgeStore } from './backend.js'
import { session } from './session.js'
import { verifyToken } from './tokens.js'
import { DIR, readJson, readMetaFile, writeJson, writeMeta } from './metastore.js'

export type Grant = 'pr' | 'review' | 'queue'
export const GRANTS: Grant[] = ['pr', 'review', 'queue']

export interface Acl {
  schema: 1
  visibility?: 'public'|'private'
  private?: boolean
  owners?: string[]
  org?: string
  write?: string[]
  read?: string[]
  /** "@sami/codex" → its grants in this repo. */
  agents?: Record<string, Grant[]>
}

export const isAgent = (name: string) => name.includes('/')

/** Owner, or an owner/admin of the owning org. Agents are never writers. */
export async function mayWrite(owner: string, name: string | null, st?: Pick<ForgeStore, 'orgRole'>): Promise<boolean> {
  if (!name || isAgent(name)) return false
  owner=owner.toLowerCase();name=name.toLowerCase()
  if (name === owner) return true
  const role = await (st ?? await store()).orgRole(owner, name)
  return role === 'owner' || role === 'admin'
}

export async function readAcl(owner: string, repo: string): Promise<Acl> {
  const raw = await readMetaFile(owner, repo, '.gild/acl.json')
  try { return raw ? JSON.parse(raw) as Acl : { schema: 1 } } catch { return { schema: 1 } }
}

export interface Capabilities { name: string | null; writer: boolean; grants: Set<Grant> }

/** Everything `name` may do in owner/repo. Writers hold every grant. */
export async function capabilities(owner: string, repo: string, name: string | null): Promise<Capabilities> {
  if (!name) return { name, writer: false, grants: new Set() }
  if (await mayWrite(owner, name)) return { name, writer: true, grants: new Set(GRANTS) }
  const acl = await readAcl(owner, repo)
  if (!isAgent(name)) {const writer=(acl.write??[]).some(n=>n.toLowerCase()===`@${name.toLowerCase()}`);return {name,writer,grants:new Set(writer?GRANTS:[])} }
  return { name, writer: false, grants: new Set(acl.agents?.[`@${name}`] ?? []) }
}

/** Set an agent's grants in a repo (an empty list removes it). Writers only;
 *  every change is a signed-off commit on `_meta`, so the history shows who
 *  granted what, and when. */
export async function setAgentGrants(owner: string, repo: string, by: string, agent: string, grants: Grant[], attach = false) {
  return writeMeta(owner, repo, `acl: @${agent} ${grants.length ? grants.join(', ') : attach ? 'attached' : 'removed'}`, by, async (fs) => {
    const path = `${DIR}/.gild/acl.json`
    const acl = (await readJson<Acl>(fs, path)) ?? { schema: 1 }
    acl.agents = { ...(acl.agents ?? {}) }
    // attach keeps an agent with no grants in the repo (a channel participant).
    if (grants.length || attach) acl.agents[`@${agent}`] = grants
    else delete acl.agents[`@${agent}`]
    await writeJson(fs, path, acl)
    return true
  })
}

/** Who is calling a JSON API: the browser session, or a gild API token
 *  (`Authorization: Bearer gf_…`, what the CLI and agents hold). */
export async function caller(request: Request): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? ''
  if (/^bearer\s+gf_/i.test(auth)) {
    const t = await verifyToken(auth.replace(/^bearer\s+/i, ''))
    if(!t?.name)return null
    const p:Principal={id:'',name:t.name,publicKey:t.publicKey,scopes:t.scopes,repos:t.repos}
    if(!permitsRequest(p, request.method, new URL(request.url).pathname))return null
    return t.name
  }
  return csrfSafe(request) ? (await session())?.name ?? null : null
}
