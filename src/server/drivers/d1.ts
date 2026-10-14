import { internalPrefixQuery } from '../../engine/import/visibility.js'
import { ownerNameAvailable } from '../../engine/backend-names.js'
import { d1Settings, entity, fromRow, LISTED_SQL, type StateRow } from '../settings-store.js'
import type { RepoReads } from '../repo-context.js'
import { agentEvent } from '../events/agents-source.js'
import { ApiError } from '../../engine/api/errors.js'
import type { D1Database } from '@cloudflare/workers-types'
import type {
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

interface Row {
  challenge: string
  kind: string
  payload: string
  answer: string | null
  created_at: number
}

const fresh = (row: Row) => Date.now() - row.created_at <= TTL_MS

/** The repository layout's reads in ONE D1 round trip (a read-only batch).
 *  Each statement is the query the matching store method runs, so the
 *  shared policy functions see identical rows (lib/repo-context.ts). */
export async function d1RepoReads(db: D1Database, owner: string, repo: string, viewer: string | null): Promise<RepoReads> {
  const o = owner.toLowerCase(), key = `${o}/${repo}`
  const [states, access, alias, canonical, role] = await db.batch<Record<string, unknown>>([
    // settings.state(owner/repo), settings.state(owner)
    db.prepare('SELECT * FROM settings_entities WHERE key IN (?,?)').bind(key, o),
    // getRepoAccess(settings.state(owner/repo).id)
    db.prepare('SELECT x.id,a.meta,a.acl,a.pending FROM (SELECT coalesce((SELECT id FROM settings_entities WHERE key=?),?) AS id) x LEFT JOIN repo_access a ON a.id=x.id').bind(key, key),
    // settings.canonical(owner/repo): its first alias hop
    db.prepare('SELECT target FROM settings_aliases WHERE name=? COLLATE NOCASE').bind(key),
    // settings.state(canonical), starCount(id), starred(id, viewer)
    db.prepare(`WITH k AS (SELECT coalesce((SELECT key FROM settings_entities WHERE key=? COLLATE NOCASE),?) AS ckey)
      SELECT k.ckey,s.*,(SELECT count(*) FROM stars WHERE repo=coalesce(s.id,k.ckey)) AS star_count,
      EXISTS(SELECT 1 FROM stars WHERE repo=coalesce(s.id,k.ckey) AND name=?) AS star_mine
      FROM k LEFT JOIN settings_entities s ON s.key=k.ckey`).bind(key, key, viewer),
    // orgRole(owner, viewer)
    db.prepare('SELECT role FROM org_members WHERE org=? AND member=?').bind(o, viewer?.toLowerCase() ?? null),
  ])
  const rows = states.results as unknown as StateRow[],
    found = (k: string) => rows.find((r) => r.key === k),
    a = access.results[0] as { id: string; meta: string | null; acl: string | null; pending: number | null },
    c = canonical.results[0] as unknown as StateRow & { ckey: string; star_count: number; star_mine: number }
  const state = (k: string) => { const r = found(k); return r ? fromRow(r) : entity(k) }
  return {
    states: { [key]: state(key), [o]: state(o) },
    access: { id: a.id, value: a.acl === null ? null : { meta: a.meta, acl: JSON.parse(a.acl), pending: !!a.pending } },
    aliased: alias.results.length > 0,
    canonical: { state: c.key ? fromRow(c) : entity(c.ckey), stars: c.star_count, starred: !!c.star_mine },
    role: viewer ? ((role.results[0] as { role: OrgRole } | undefined)?.role ?? null) : null,
  }
}

type ListingRow = { id: string; data: string; access_meta: string|null; access_acl: string|null; access_pending: number|null }
const LISTING_SELECT = 'SELECT l.id,l.data,a.meta AS access_meta,a.acl AS access_acl,a.pending AS access_pending FROM repo_listing l LEFT JOIN repo_access a ON a.id=l.id'
/** A stored listing is shown only under the live, published policy it was built with. */
const listingEntry = (r: ListingRow) => {
  const snapshot = JSON.parse(r.data)
  snapshot.acl = r.access_acl===null || r.access_pending || r.access_meta !== snapshot.meta ? {visibility:'private'} : JSON.parse(r.access_acl)
  return [r.id,snapshot] as const
}

export function d1Store(db: D1Database): ForgeStore {
  const settings = d1Settings(db)
  return {
    settings,
    async channelFacts(owner,repo,acl,online) {
      const names=JSON.stringify([...new Set([...Object.keys(acl.agents ?? {}),...(acl.read ?? []),...(acl.write ?? []),...online].map(n=>n.replace(/^@/, '')).filter(n=>n.includes('/')))])
      const [org,members,agents,tokens,orchestrators]=await db.batch([
        db.prepare('SELECT name FROM orgs WHERE name=?').bind(owner),
        db.prepare('SELECT member,role FROM org_members WHERE org=?').bind(owner),
        db.prepare('SELECT name,sponsor,revoked_at AS revokedAt,suspended_at AS suspendedAt FROM agents WHERE name IN (SELECT value FROM json_each(?))').bind(names),
        db.prepare('SELECT name,expires_at AS expiresAt,scopes,repos FROM api_tokens WHERE name IN (SELECT value FROM json_each(?)) AND expires_at>?').bind(names,Date.now()),
        db.prepare("SELECT agent FROM orchestrators WHERE scope IN ('repo:'||coalesce((SELECT id FROM settings_entities WHERE key=?),?),'org:'||coalesce((SELECT id FROM settings_entities WHERE key=?),?))").bind(`${owner}/${repo}`,`${owner}/${repo}`,owner,owner),
      ])
      return {org:!!org.results.length,members:members.results as {member:string;role:string}[],agents:agents.results as {name:string;sponsor:string;revokedAt:string|null;suspendedAt:string|null}[],tokens:(tokens.results as {name:string;expiresAt:number;scopes:string|null;repos:string|null}[]).map(t=>({...t,scopes:t.scopes?JSON.parse(t.scopes):null,repos:t.repos?JSON.parse(t.repos):null})),orchestrators:(orchestrators.results as {agent:string}[]).map(g=>g.agent)}
    },
    async getRepoAccess(id, repository) {
      // Piggyback the live namespace on the ACL read: no extra D1 round trip,
      // no mutable cache that could hide source branches after completion.
      const query = repository ? `SELECT meta,acl,pending,(${internalPrefixQuery}) AS internal_prefix FROM repo_access WHERE id=?` : 'SELECT meta,acl,pending FROM repo_access WHERE id=?'
      const row = await db.prepare(query).bind(...(repository ? [repository,id] : [id])).first<{meta:string|null;acl:string;pending:number;internal_prefix?:string|null}>()
      return row ? {meta:row.meta,acl:JSON.parse(row.acl),pending:!!row.pending,...(row.internal_prefix ? {internalPrefix:row.internal_prefix} : {})} : null
    },
    async fenceRepoAccess(id, meta) {
      await db.prepare("INSERT INTO repo_access(id,meta,acl,pending) VALUES (?,?,'{}',1) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta,pending=1").bind(id,meta).run()
    },
    async publishRepoAccess(id, meta, acl) {
      const result = await db.prepare('INSERT INTO repo_access(id,meta,acl,pending) VALUES (?,?,?,0) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta,acl=excluded.acl,pending=0 WHERE repo_access.meta IS excluded.meta').bind(id,meta,JSON.stringify(acl)).run()
      return result.meta.changes > 0
    },
    async registerFragment(fragment,id) { await db.batch([db.prepare('INSERT OR IGNORE INTO fragment_repos VALUES (?,?)').bind(fragment,id), db.prepare('INSERT OR IGNORE INTO fragment_retention VALUES (?,?,EXISTS(SELECT 1 FROM fragment_reachable WHERE id=? AND fragment=?),?)').bind(fragment,id,id,fragment,Date.now())]) },
    async fragmentRepos(fragment) {
      return (await db.prepare("SELECT f.id FROM fragment_repos f JOIN repo_access a ON a.id=f.id WHERE f.fragment=? AND a.pending=0 AND coalesce(json_extract(a.acl,'$.visibility'),'public')='public' AND coalesce(json_extract(a.acl,'$.private'),0)=0").bind(fragment).all<{id:string}>()).results.map(r=>r.id)
    },
    async invitations(repo,invitee) {
      return (await db.prepare('SELECT id,repo,invitee,permission,inviter,created_at FROM repo_invitations WHERE (? IS NULL OR repo=?) AND (? IS NULL OR invitee=?) ORDER BY created_at').bind(repo??null,repo??null,invitee??null,invitee??null).all<import('../collaborators.js').Invitation>()).results
    },
    async inviteRepo(i) { await db.prepare('INSERT INTO repo_invitations VALUES (?,?,?,?,?,?) ON CONFLICT(repo,invitee) DO UPDATE SET permission=excluded.permission,inviter=excluded.inviter').bind(i.id,i.repo,i.invitee,i.permission,i.inviter,i.created_at).run() },
    async removeInvitation(id) { await db.prepare('DELETE FROM repo_invitations WHERE id=?').bind(id).run() },
    async star(repo, name) {
      await db
        .prepare('INSERT OR IGNORE INTO stars(repo,name,created_at) VALUES (?,?,?)')
        .bind(repo, name, new Date().toISOString())
        .run()
    },
    async unstar(repo, name) {
      await db.prepare('DELETE FROM stars WHERE repo=? AND name=?').bind(repo, name).run()
    },
    async starred(repo, name) {
      return !!await db.prepare('SELECT 1 FROM stars WHERE repo=? AND name=?').bind(repo, name).first()
    },
    async starCount(repo) {
      return (await db.prepare('SELECT count(*) AS n FROM stars WHERE repo=?').bind(repo).first<{ n: number }>())!.n
    },
    async starCounts(repos) {
      if (!repos.length) return {}
      const rows = await db.prepare('SELECT repo,count(*) AS n FROM stars WHERE repo IN (SELECT value FROM json_each(?)) GROUP BY repo').bind(JSON.stringify(repos)).all<{ repo: string; n: number }>()
      return Object.fromEntries(rows.results.map(r => [r.repo, r.n]))
    },
    async getListings(ids) {
      if (!ids.length) return {}
      const rows = await db.prepare(`${LISTING_SELECT} WHERE l.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<ListingRow>()
      return Object.fromEntries(rows.results.map(listingEntry))
    },
    async listedListings(owner, names, scoreSuffix) {
      if (!names.length) return { states: [], listings: {}, stars: {}, scores: {} }
      // The ids every listed name would resolve to (its entity, or its key).
      const ids = `(SELECT coalesce((SELECT id FROM settings_entities WHERE key=?2 || '/' || n.value),?2 || '/' || n.value) FROM json_each(?1) n)`
      const [states, listings, stars, scores] = await db.batch<Record<string, unknown>>([
        db.prepare(LISTED_SQL).bind(JSON.stringify(names), owner),
        db.prepare(`${LISTING_SELECT} WHERE l.id IN ${ids}`).bind(JSON.stringify(names), owner),
        db.prepare(`SELECT repo,count(*) AS n FROM stars WHERE repo IN ${ids} GROUP BY repo`).bind(JSON.stringify(names), owner),
        // cqx scores at each listed tip (key: owner/name@tip<suffix>), as getScores reads them
        db.prepare(`SELECT key,report FROM cqx_scores WHERE ?3 IS NOT NULL AND key IN (SELECT ?2 || '/' || n.value || '@' || json_extract(l.data,'$.tip') || ?3 FROM json_each(?1) n
          JOIN repo_listing l ON l.id=coalesce((SELECT id FROM settings_entities WHERE key=?2 || '/' || n.value),?2 || '/' || n.value))`).bind(JSON.stringify(names), owner, scoreSuffix ?? null),
      ])
      return {
        states: (states.results as unknown as (StateRow & { requested: string })[]).map(r => r.key ? fromRow(r) : entity(r.requested)),
        listings: Object.fromEntries((listings.results as unknown as ListingRow[]).map(listingEntry)),
        stars: Object.fromEntries((stars.results as { repo: string; n: number }[]).map(r => [r.repo, r.n])),
        scores: Object.fromEntries((scores.results as { key: string; report: string }[]).map(r => [r.key, r.report])),
      }
    },
    async putListing(id, revision, snapshot) {
      await db.prepare('INSERT INTO repo_listing(id,revision,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data WHERE excluded.revision>repo_listing.revision').bind(id, revision, JSON.stringify(snapshot)).run()
    },
    async deleteListing(id) { await db.prepare('DELETE FROM repo_listing WHERE id=?').bind(id).run() },
    async stargazers(repo) {
      return (await db.prepare('SELECT name,created_at FROM stars WHERE repo=? ORDER BY created_at,name').bind(repo).all<{ name: string; created_at: string }>()).results
    },
    async updateOrgDescription(org, description) {
      await db
        .prepare('UPDATE orgs SET description=? WHERE name=?')
        .bind(description, org)
        .run()
    },
    async removeOrgMember(org, member) {
      await db
        .prepare('DELETE FROM org_members WHERE org=? AND member=?')
        .bind(org, member)
        .run()
    },
    async renameOrg(from, to) {
      await settings.rename(from, to, true)
    },
    async createChallenge(challenge, browserState) {
      await db
        .prepare(
          'INSERT INTO challenges (challenge, kind, payload, created_at) VALUES (?, ?, ?, ?)',
        )
        .bind(challenge, 'auth', JSON.stringify({ browserState }), Date.now())
        .run()
    },

    async completeBrowserChallenge(kind, challenge, browserState) {
      // The conditional write is the completion lock across Worker isolates.
      // Keep the signed challenge for the CLI token proof; only browser issuance
      // is consumed. Old challenges without browser state fail closed.
      const row = await db.prepare(`UPDATE challenges
        SET payload=json_set(payload,'$.browserConsumed',1)
        WHERE challenge=? AND kind=? AND json_extract(payload,'$.browserState')=?
          AND coalesce(json_extract(payload,'$.browserConsumed'),0)=0
          AND created_at>=? AND answer IS NOT NULL
        RETURNING payload,answer`).bind(challenge, kind, browserState, Date.now() - (kind === 'auth' ? TTL_MS : CLAIMED_WINDOW_MS)).first<Row>()
      if (row) {
        const payload = JSON.parse(row.payload), answer = JSON.parse(row.answer!)
        return kind === 'auth'
          ? { status: 'complete', publicKey: answer.publicKey }
          : { status: 'complete', publicKey: payload.publicKey, name: payload.name }
      }
      const pending = await db.prepare(`SELECT 1 FROM challenges
        WHERE challenge=? AND kind=? AND json_extract(payload,'$.browserState')=?
          AND coalesce(json_extract(payload,'$.browserConsumed'),0)=0
          AND created_at>=? AND answer IS NULL`).bind(challenge, kind, browserState, Date.now() - TTL_MS).first()
      return pending ? { status: 'pending' } : null
    },

    async getChallenge(challenge) {
      const row = await db
        .prepare(
          "SELECT * FROM challenges WHERE challenge = ? AND kind = 'auth'",
        )
        .bind(challenge)
        .first<Row>()
      if (!row || !fresh(row)) return null
      const out: PendingAuth = { challenge, createdAt: row.created_at }
      if (row.answer) out.answered = JSON.parse(row.answer)
      return out
    },

    async answerChallenge(challenge, publicKey, signature) {
      const entry = await this.getChallenge(challenge)
      if (!entry) return null
      await db
        .prepare('UPDATE challenges SET answer = ? WHERE challenge = ?')
        .bind(JSON.stringify({ publicKey, signature }), challenge)
        .run()
      entry.answered = { publicKey, signature }
      return entry
    },

    async getClaim(name) {
      const row = await db
        .prepare('SELECT * FROM claims WHERE name = ?')
        .bind(name.toLowerCase())
        .first<{
          name: string
          public_key: string
          email: string
          email_verified: number
          claimed_at: string
        }>()
      if (!row) return null
      return {
        name: row.name,
        publicKey: row.public_key,
        email: row.email,
        emailVerified: row.email_verified === 1,
        claimedAt: row.claimed_at,
      }
    },

    async prepareClaim(name, publicKey, email, challenge, browserState) {
      await db
        .prepare(
          'INSERT INTO challenges (challenge, kind, payload, created_at) VALUES (?, ?, ?, ?)',
        )
        .bind(
          challenge,
          'claim',
          JSON.stringify({ name: name.toLowerCase(), publicKey, email, browserState }),
          Date.now(),
        )
        .run()
    },

    async getPendingClaim(challenge) {
      const row = await db
        .prepare(
          "SELECT * FROM challenges WHERE challenge = ? AND kind = 'claim' AND answer IS NULL",
        )
        .bind(challenge)
        .first<Row>()
      if (!row || !fresh(row)) return null
      const payload = JSON.parse(row.payload)
      return {
        challenge,
        ...payload,
        createdAt: row.created_at,
      } as PendingClaim
    },

    async finalizeClaim(challenge) {
      const row = await db
        .prepare(
          "SELECT * FROM challenges WHERE challenge = ? AND kind = 'claim'",
        )
        .bind(challenge)
        .first<Row>()
      if (!row || !fresh(row)) return null
      const payload = JSON.parse(row.payload)
      if (await this.nameTaken(payload.name)) return false
      const claim: Claim = {
        name: payload.name,
        publicKey: payload.publicKey,
        email: payload.email,
        emailVerified: false,
        claimedAt: new Date().toISOString(),
      }
      try {
        await db
          .prepare(
            'INSERT INTO claims (name, public_key, email, email_verified, claimed_at) VALUES (?, ?, ?, 0, ?)',
          )
          .bind(claim.name, claim.publicKey, claim.email, claim.claimedAt)
          .run()
      } catch (e) {
        if (/UNIQUE constraint/i.test(String(e))) return false
        throw e
      }
      await db
        .prepare('UPDATE challenges SET answer = ? WHERE challenge = ?')
        .bind(JSON.stringify({ claimed: true }), challenge)
        .run()
      return claim
    },

    async claimByKey(publicKey) {
      const row = await db
        .prepare('SELECT name FROM claims WHERE public_key = ?')
        .bind(publicKey)
        .first<{ name: string }>()
      return row ? this.getClaim(row.name) : null
    },

    async saveApiToken(hash, name, publicKey, expiresAt, options) {
      await db
        .prepare(
          'INSERT INTO api_tokens (token_hash,name,public_key,created_at,expires_at,scopes,repos,label) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(
          hash,
          name,
          publicKey,
          Date.now(),
          expiresAt,
          options?.scopes ? JSON.stringify(options.scopes) : null,
          options?.repos ? JSON.stringify(options.repos) : null,
          options?.label ?? '',
        )
        .run()
    },
    async getApiToken(hash) {
      const row = await db
        .prepare('SELECT * FROM api_tokens WHERE token_hash=?')
        .bind(hash)
        .first<TokenRow>()
      // Expiry is checked here, not in SQL, so the read is the same on every
      // call in a request and the request's primer can answer it.
      return row && row.expires_at > Date.now() ? tokenRow(row) : null
    },
    async listApiTokens(name) {
      const result = await db
        .prepare(
          'SELECT * FROM api_tokens WHERE name=? AND expires_at>? ORDER BY created_at DESC',
        )
        .bind(name, Date.now())
        .all<TokenRow>()
      return result.results.map((row) => ({
        id: row.token_hash,
        ...tokenRow(row),
      }))
    },
    async deleteApiToken(name, id) {
      const result = await db
        .prepare('DELETE FROM api_tokens WHERE name=? AND token_hash=?')
        .bind(name, id)
        .run()
      return result.meta.changes > 0
    },

    async claimedName(challenge) {
      const row = await db
        .prepare(
          "SELECT * FROM challenges WHERE challenge = ? AND kind = 'claim' AND answer IS NOT NULL",
        )
        .bind(challenge)
        .first<Row>()
      if (!row || Date.now() - row.created_at > CLAIMED_WINDOW_MS) return null
      return JSON.parse(row.payload).name ?? null
    },

    async createOrg(name, description, createdBy) {
      const now = new Date().toISOString()
      try {
        await db.batch([
          db
            .prepare(
              'INSERT INTO orgs (name, description, created_by, created_at) VALUES (?, ?, ?, ?)',
            )
            .bind(name, description, createdBy, now),
          db
            .prepare(
              "INSERT INTO org_members (org, member, role, added_at) VALUES (?, ?, 'owner', ?)",
            )
            .bind(name, createdBy, now),
        ])
      } catch (e) {
        if (/UNIQUE constraint/i.test(String(e)))
          throw new ApiError(409, 'Name is already taken')
        throw e
      }
    },

    async getOrg(name) {
      const row = await db
        .prepare('SELECT * FROM orgs WHERE name = ?')
        .bind(name.toLowerCase())
        .first<{
          name: string
          description: string | null
          created_by: string
          created_at: string
        }>()
      if (!row || (await settings.state(name.toLowerCase())).deletedAt !== null)
        return null
      return {
        name: row.name,
        description: row.description,
        createdBy: row.created_by,
        createdAt: row.created_at,
      }
    },

    async orgsFor(member) {
      const rows = await db
        .prepare(
          'SELECT o.name, o.description, o.created_by, o.created_at, m.role FROM org_members m JOIN orgs o ON o.name = m.org WHERE m.member = ? ORDER BY o.name',
        )
        .bind(member)
        .all<{
          name: string
          description: string | null
          created_by: string
          created_at: string
          role: OrgRole
        }>()
      return (
        await Promise.all(
          rows.results.map(async (r) =>
            (await settings.state(r.name)).deletedAt === null ? r : null,
          ),
        )
      )
        .filter((r) => r !== null)
        .map((r) => ({
          name: r.name,
          description: r.description,
          createdBy: r.created_by,
          createdAt: r.created_at,
          role: r.role,
        }))
    },

    async orgRole(org, member) {
      const row = await db
        .prepare('SELECT role FROM org_members WHERE org = ? AND member = ?')
        .bind(org.toLowerCase(), member)
        .first<{ role: OrgRole }>()
      return row?.role ?? null
    },

    async orgMembers(org) {
      const rows = await db
        .prepare('SELECT * FROM org_members WHERE org = ? ORDER BY added_at')
        .bind(org.toLowerCase())
        .all<{
          org: string
          member: string
          role: OrgRole
          added_at: string
        }>()
      return rows.results.map((r) => ({
        org: r.org,
        member: r.member,
        role: r.role,
        addedAt: r.added_at,
      }))
    },

    async addOrgMember(org, member, role) {
      await db
        .prepare(
          'INSERT INTO org_members (org, member, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(org,member) DO UPDATE SET role=excluded.role',
        )
        .bind(org.toLowerCase(), member, role, new Date().toISOString())
        .run()
    },

    async owners() {
      const [users, orgs] = await Promise.all([
        db.prepare('SELECT name FROM claims').all<{ name: string }>(),
        db
          .prepare(
            'SELECT name FROM orgs WHERE name NOT IN (SELECT key FROM settings_entities WHERE deleted_at IS NOT NULL)',
          )
          .all<{ name: string }>(),
      ])
      return [
        ...users.results.map((r) => ({ name: r.name, kind: 'user' as const })),
        ...orgs.results.map((r) => ({ name: r.name, kind: 'org' as const })),
      ]
    },

    async createAgent(sponsor, label, publicKey, approvedBy) {
      const agent = {
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
      await db
        .prepare(
          'INSERT INTO agents (name, sponsor, label, public_key, created_at, approved_by) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          agent.name,
          sponsor,
          label,
          publicKey,
          agent.createdAt,
          agent.approvedBy,
        )
        .run()
      return agent
    },

    async getAgent(name) {
      const r = await db
        .prepare('SELECT * FROM agents WHERE name = ?')
        .bind(name.toLowerCase())
        .first<AgentRow>()
      return r ? agentFrom(r) : null
    },

    async agentsFor(sponsor) {
      const rows = await db
        .prepare('SELECT * FROM agents WHERE sponsor = ? ORDER BY created_at')
        .bind(sponsor)
        .all<AgentRow>()
      return rows.results.map(agentFrom)
    },

    async revokeAgent(name) {
      await db
        .prepare(
          'UPDATE agents SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL',
        )
        .bind(new Date().toISOString(), name)
        .run()
    },

    async setApprover(name, approver) {
      await db
        .prepare('UPDATE agents SET approver = ? WHERE name = ?')
        .bind(approver ? 1 : 0, name)
        .run()
    },

    async grantOrchestrator(g) {
      const grantedAt = new Date().toISOString()
      await db
        .prepare(
          'INSERT INTO orchestrators(agent,scope,child_limit,granted_by,granted_at) VALUES (?,?,?,?,?) ON CONFLICT(agent,scope) DO UPDATE SET child_limit=excluded.child_limit',
        )
        .bind(g.agent, g.scope, g.childLimit, g.grantedBy, grantedAt)
        .run()
      const row = await db
        .prepare('SELECT * FROM orchestrators WHERE agent=? AND scope=?')
        .bind(g.agent, g.scope)
        .first<GrantRow>()
      return grantFrom(row!)
    },

    async revokeOrchestrator(agent, scope) {
      const r = await db
        .prepare('DELETE FROM orchestrators WHERE agent=? AND scope=?')
        .bind(agent, scope)
        .run()
      return (r.meta?.changes ?? 0) > 0
    },

    async orchestratorGrants(agent) {
      const rows = await db
        .prepare('SELECT * FROM orchestrators WHERE agent=? ORDER BY granted_at')
        .bind(agent.toLowerCase())
        .all<GrantRow>()
      return rows.results.map(grantFrom)
    },

    async orchestratorsIn(scopes) {
      if (!scopes.length) return []
      const rows = await db
        .prepare(
          'SELECT * FROM orchestrators WHERE scope IN (SELECT value FROM json_each(?)) ORDER BY granted_at',
        )
        .bind(JSON.stringify(scopes))
        .all<GrantRow>()
      return rows.results.map(grantFrom)
    },

    async createChildAgent(c) {
      const name = `${c.human}/${c.label}`
      if (await this.getAgent(name)) return 'taken'
      const at = new Date().toISOString(),
        request = {
          id: c.requestId,
          sponsor: c.human,
          label: c.label,
          publicKey: c.publicKey,
          repo: c.repo,
          grants: c.grants,
          note: c.note,
          status: 'approved' as const,
          createdAt: at,
          decidedAt: at,
          decidedBy: c.orchestrator,
          tokenIssued: true,
        },
        event = agentEvent(request, 'approved', c.orchestrator)
      // The limit check and the insert are one statement, so concurrent
      // spawns cannot overshoot; the request and event follow only on insert.
      const result = await db.batch([
        db
          .prepare(
            'INSERT OR IGNORE INTO agents(name,sponsor,label,public_key,created_at,approved_by,sponsored_by,child_scope,child_repo) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM agents WHERE sponsored_by=? AND revoked_at IS NULL)<?',
          )
          .bind(
            name, c.human, c.label, c.publicKey, at, c.orchestrator,
            c.orchestrator, c.scope, c.repoId, c.orchestrator, c.childLimit,
          ),
        db
          .prepare(
            "INSERT INTO agent_requests(id,sponsor,label,public_key,repo,grants,note,status,created_at,decided_at,decided_by,token_issued) SELECT ?,?,?,?,?,?,?,'approved',?,?,?,1 WHERE changes()>0",
          )
          .bind(
            c.requestId, c.human, c.label, c.publicKey, c.repo,
            JSON.stringify(c.grants), c.note, at, at, c.orchestrator,
          ),
        db
          .prepare(
            'INSERT OR IGNORE INTO event_outbox(id,payload) SELECT ?,? WHERE changes()>0',
          )
          .bind(event.id, JSON.stringify(event)),
      ])
      if (!result[0].meta.changes)
        return (await this.getAgent(name)) ? 'taken' : 'limit'
      return (await this.getAgent(name))!
    },

    async childrenOf(orchestrator) {
      const rows = await db
        .prepare('SELECT * FROM agents WHERE sponsored_by=? ORDER BY created_at')
        .bind(orchestrator.toLowerCase())
        .all<AgentRow>()
      return rows.results.map(agentFrom)
    },

    async setSuspended(name, by) {
      const r = await db
        .prepare(
          by
            ? 'UPDATE agents SET suspended_at=?,suspended_by=? WHERE name=? AND revoked_at IS NULL AND suspended_at IS NULL'
            : 'UPDATE agents SET suspended_at=NULL,suspended_by=NULL WHERE name=? AND revoked_at IS NULL AND suspended_at IS NOT NULL',
        )
        .bind(...(by ? [new Date().toISOString(), by, name] : [name]))
        .run()
      return (r.meta?.changes ?? 0) > 0
    },

    async createAgentRequest(r) {
      const createdAt = new Date().toISOString(),
        record = {
          ...r,
          status: 'pending' as const,
          createdAt,
          decidedAt: null,
          decidedBy: null,
          tokenIssued: false,
        },
        event = agentEvent(record, 'opened', `${r.sponsor}/${r.label}`)
      await db.batch([
        db
          .prepare(
            'INSERT INTO agent_requests (id,sponsor,label,public_key,repo,grants,note,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            r.id,
            r.sponsor,
            r.label,
            r.publicKey,
            r.repo,
            JSON.stringify(r.grants),
            r.note,
            'pending',
            createdAt,
          ),
        db
          .prepare(
            'INSERT OR IGNORE INTO event_outbox(id,payload) VALUES (?,?)',
          )
          .bind(event.id, JSON.stringify(event)),
      ])
      return record
    },

    async getAgentRequest(id) {
      const row = await db
        .prepare('SELECT * FROM agent_requests WHERE id = ?')
        .bind(id)
        .first<RequestRow>()
      return row ? requestFrom(row) : null
    },

    async pendingRequestsFor(sponsor) {
      const rows = await db
        .prepare(
          "SELECT * FROM agent_requests WHERE sponsor = ? AND status = 'pending' ORDER BY created_at DESC",
        )
        .bind(sponsor)
        .all<RequestRow>()
      return rows.results.map(requestFrom)
    },

    async decideAgentRequest(id, status, by, grants) {
      const old = await db
        .prepare('SELECT * FROM agent_requests WHERE id=?')
        .bind(id)
        .first<RequestRow>()
      if (!old) throw new ApiError(404, 'Agent request not found')
      const at = new Date().toISOString(),
        record = {
          ...requestFrom(old),
          status,
          decidedAt: at,
          decidedBy: by,
          grants,
        },
        event = agentEvent(record, status, by)
      const result = await db.batch([
        db
          .prepare(
            "UPDATE agent_requests SET status=?,decided_at=?,decided_by=?,grants=? WHERE id=? AND status='pending'",
          )
          .bind(status, at, by, JSON.stringify(grants), id),
        db
          .prepare(
            'INSERT OR IGNORE INTO event_outbox(id,payload) SELECT ?,? WHERE changes()>0',
          )
          .bind(event.id, JSON.stringify(event)),
      ])
      if (!result[0].meta.changes)
        throw new ApiError(409, 'Agent request has already been decided')
    },

    async getScore(key) {
      const row = await db
        .prepare('SELECT report FROM cqx_scores WHERE key = ?')
        .bind(key)
        .first<{ report: string }>()
      return row?.report ?? null
    },
    async getScores(keys) {
      if (!keys.length) return {}
      const rows = await db.prepare('SELECT key,report FROM cqx_scores WHERE key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(keys)).all<{ key: string; report: string }>()
      return Object.fromEntries(rows.results.map(r => [r.key, r.report]))
    },

    async putScore(key, report) {
      await db
        .prepare(
          'INSERT OR REPLACE INTO cqx_scores (key, report) VALUES (?, ?)',
        )
        .bind(key, report)
        .run()
    },

    async getChange(key) {
      const row = await db
        .prepare('SELECT data FROM change_cache WHERE key = ?')
        .bind(key)
        .first<{ data: ArrayBuffer | number[] }>()
      return row ? new Uint8Array(row.data) : null
    },

    async putChange(key, data) {
      await db
        .prepare(
          'INSERT OR REPLACE INTO change_cache (key, data) VALUES (?, ?)',
        )
        .bind(key, data)
        .run()
    },

    async takeRequestToken(id) {
      const res = await db
        .prepare(
          "UPDATE agent_requests SET token_issued = 1 WHERE id = ? AND status = 'approved' AND token_issued = 0",
        )
        .bind(id)
        .run()
      return (res.meta?.changes ?? 0) > 0
    },

    async nameTaken(name) {
      const n = name.toLowerCase()
      if (!ownerNameAvailable(n)) return true
      if (await settings.reserved(n)) return true
      if (await this.getClaim(n)) return true
      return (await this.getOrg(n)) !== null
    },
  }
}

interface AgentRow {
  name: string
  sponsor: string
  label: string
  public_key: string | null
  created_at: string
  revoked_at: string | null
  approver?: number
  approved_by?: string | null
  sponsored_by?: string | null
  child_scope?: string | null
  child_repo?: string | null
  suspended_at?: string | null
  suspended_by?: string | null
}
interface GrantRow {
  agent: string
  scope: string
  child_limit: number
  granted_by: string
  granted_at: string
}
const grantFrom = (r: GrantRow) => ({
  agent: r.agent,
  scope: r.scope,
  childLimit: r.child_limit,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
})
const agentFrom = (r: AgentRow) => ({
  name: r.name,
  sponsor: r.sponsor,
  label: r.label,
  publicKey: r.public_key,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
  approver: !!r.approver,
  approvedBy: r.approved_by ?? null,
  sponsoredBy: r.sponsored_by ?? null,
  childScope: r.child_scope ?? null,
  childRepo: r.child_repo ?? null,
  suspendedAt: r.suspended_at ?? null,
  suspendedBy: r.suspended_by ?? null,
})

interface RequestRow {
  id: string
  sponsor: string
  label: string
  public_key: string
  repo: string | null
  grants: string
  note: string | null
  status: 'pending' | 'approved' | 'denied'
  created_at: string
  decided_at: string | null
  decided_by: string | null
  token_issued: number
}
const requestFrom = (r: RequestRow) => ({
  id: r.id,
  sponsor: r.sponsor,
  label: r.label,
  publicKey: r.public_key,
  repo: r.repo,
  grants: JSON.parse(r.grants) as string[],
  note: r.note,
  status: r.status,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
  tokenIssued: !!r.token_issued,
})

interface TokenRow {
  token_hash: string
  name: string | null
  public_key: string
  created_at: number
  expires_at: number
  scopes: string | null
  repos: string | null
  label: string
}
function tokenRow(r: TokenRow) {
  return {
    name: r.name,
    publicKey: r.public_key,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    scopes: r.scopes ? (JSON.parse(r.scopes) as string[]) : null,
    repos: r.repos ? (JSON.parse(r.repos) as string[]) : null,
    label: r.label,
  }
}
