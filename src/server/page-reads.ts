import { internalPrefixQuery } from '../engine/import/visibility.js'
import { entity, fromRow, type StateRow, type Entity } from './settings-store.js'
import type { ForgeStore, OrgRole } from './backend.js'
import type { RepoReads } from './repo-context.js'
import type { D1Database } from '@cloudflare/workers-types'

/** Who is asking, as far as the signed cookie says (verified, no I/O). */
export interface PageSession { publicKey: string; name?: string }

/** The signed-in viewer as the claims store knows them now. The claim's
 *  name wins over the cookie's (a rename keeps old cookies working). */
export interface PageViewer { name: string; email: string | null; profile: string | null }

/** Everything a repository page's policy, header and per-viewer parts read
 *  from D1, in ONE round trip. The Worker's privacy step reads it before any
 *  repository byte is touched and hands the same rows to the Next render
 *  (`x-gild-page-reads`), so the layout and the page never ask again. */
export interface PageReads extends RepoReads {
  address: string
  /** Authorized ingress inspected the published metadata snapshot already. */
  metadataReady?: boolean
  viewer: PageViewer | null
  /** `settings.canonical(owner)` without an alias hop. */
  ownerKey: string
  /** Any alias on the repository or owner: renamed addresses take the live path. */
  ownerAliased: boolean
  /** The owner's `orgs` row (null: a person, or no such org). */
  org: OrgRow | null
}
interface OrgRow { name: string; description: string | null; created_by: string; created_at: string }

const viewerCTE = `v AS (SELECT coalesce((SELECT name FROM claims WHERE public_key=?1),?2) AS name)`

/** Only the viewer (pages that are not a repository). */
export async function d1ViewerReads(db: D1Database, session: PageSession | null): Promise<PageViewer | null> {
  if (!session) return null
  const row = await db.prepare(`WITH ${viewerCTE} SELECT v.name,c.email,p.data AS profile FROM v
    LEFT JOIN claims c ON c.name=lower(v.name) LEFT JOIN profiles p ON p.name=v.name`)
    .bind(session.publicKey, session.name ?? null).first<PageViewer>()
  return row?.name ? row : null
}

export async function d1PageReads(db: D1Database, owner: string, repo: string, session: PageSession | null): Promise<PageReads> {
  const o = owner.toLowerCase(), key = `${o}/${repo}`
  const [states, access, aliases, canonical, viewer, ownerKey, org] = await db.batch<Record<string, unknown>>([
    // settings.state(owner/repo), settings.state(owner)
    db.prepare('SELECT * FROM settings_entities WHERE key IN (?,?)').bind(key, o),
    // getRepoAccess(state(owner/repo).id, owner/repo), with the import namespace
    db.prepare(`SELECT x.id,a.meta,a.acl,a.pending,(${internalPrefixQuery}) AS internal_prefix
      FROM (SELECT coalesce((SELECT id FROM settings_entities WHERE key=?),?) AS id) x LEFT JOIN repo_access a ON a.id=x.id`).bind(key, key, key),
    // settings.canonical(owner/repo) and (owner): their first alias hop
    db.prepare('SELECT name FROM settings_aliases WHERE name=? COLLATE NOCASE OR name=? COLLATE NOCASE').bind(key, o),
    // settings.state(canonical), starCount(id), starred(id, viewer)
    db.prepare(`WITH ${viewerCTE}, k AS (SELECT coalesce((SELECT key FROM settings_entities WHERE key=?3 COLLATE NOCASE),?3) AS ckey)
      SELECT k.ckey,s.*,(SELECT count(*) FROM stars WHERE repo=coalesce(s.id,k.ckey)) AS star_count,
      EXISTS(SELECT 1 FROM stars WHERE repo=coalesce(s.id,k.ckey) AND name=(SELECT name FROM v)) AS star_mine
      FROM k LEFT JOIN settings_entities s ON s.key=k.ckey`).bind(session?.publicKey ?? null, session?.name ?? null, key),
    // the viewer, their profile, and orgRole(owner, viewer)
    db.prepare(`WITH ${viewerCTE} SELECT v.name,c.email,p.data AS profile,
      (SELECT role FROM org_members WHERE org=?3 AND member=lower(v.name)) AS role FROM v
      LEFT JOIN claims c ON c.name=lower(v.name) LEFT JOIN profiles p ON p.name=v.name`).bind(session?.publicKey ?? null, session?.name ?? null, o),
    // settings.canonical(owner) without an alias
    db.prepare('SELECT key FROM settings_entities WHERE key=? COLLATE NOCASE').bind(o),
    // getOrg(owner)
    db.prepare('SELECT * FROM orgs WHERE name=?').bind(o),
  ])
  const rows = states.results as unknown as StateRow[],
    state = (k: string): Entity => { const r = rows.find((r) => r.key === k); return r ? fromRow(r) : entity(k) }
  const a = access.results[0] as { id: string; meta: string | null; acl: string | null; pending: number | null; internal_prefix: string | null },
    c = canonical.results[0] as unknown as StateRow & { ckey: string; star_count: number; star_mine: number },
    v = viewer.results[0] as unknown as PageViewer & { role: OrgRole | null }
  const aliasNames = (aliases.results as { name: string }[]).map((r) => r.name.toLowerCase())
  return {
    address: key,
    states: { [key]: state(key), [o]: state(o) },
    access: { id: a.id, value: a.acl === null ? null : { meta: a.meta, acl: JSON.parse(a.acl), pending: !!a.pending, ...(a.internal_prefix ? { internalPrefix: a.internal_prefix } : {}) } },
    aliased: aliasNames.includes(key.toLowerCase()),
    ownerAliased: aliasNames.length > 0,
    canonical: { state: c.key ? fromRow(c) : entity(c.ckey), stars: c.star_count, starred: !!c.star_mine },
    role: v?.name ? v.role ?? null : null,
    viewer: v?.name ? { name: v.name, email: v.email, profile: v.profile } : null,
    ownerKey: (ownerKey.results[0] as { key: string } | undefined)?.key ?? o,
    org: (org.results[0] as unknown as OrgRow | undefined) ?? null,
  }
}

/** An owner page's reads (no repository): the owner's state and canonical
 *  key, its aliases, and the viewer with their role in it, in one batch. */
export async function d1OwnerReads(db: D1Database, owner: string, session: PageSession | null): Promise<PageReads> {
  const o = owner.toLowerCase()
  const [states, aliases, viewer, ownerKey, org] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM settings_entities WHERE key=?').bind(o),
    db.prepare('SELECT name FROM settings_aliases WHERE name=? COLLATE NOCASE').bind(o),
    db.prepare(`WITH ${viewerCTE} SELECT v.name,c.email,p.data AS profile,
      (SELECT role FROM org_members WHERE org=?3 AND member=lower(v.name)) AS role FROM v
      LEFT JOIN claims c ON c.name=lower(v.name) LEFT JOIN profiles p ON p.name=v.name`).bind(session?.publicKey ?? null, session?.name ?? null, o),
    db.prepare('SELECT key FROM settings_entities WHERE key=? COLLATE NOCASE').bind(o),
    db.prepare('SELECT * FROM orgs WHERE name=?').bind(o),
  ])
  const row = states.results[0] as unknown as StateRow | undefined, state = row ? fromRow(row) : entity(o)
  const v = viewer.results[0] as unknown as PageViewer & { role: OrgRole | null }
  const key = (ownerKey.results[0] as { key: string } | undefined)?.key ?? o
  return {
    address: o,
    states: { [o]: state },
    access: { id: '', value: null },
    aliased: aliases.results.length > 0,
    ownerAliased: aliases.results.length > 0,
    canonical: { state: key === o ? state : entity(key), stars: 0, starred: false },
    role: v?.name ? v.role ?? null : null,
    viewer: v?.name ? { name: v.name, email: v.email, profile: v.profile } : null,
    ownerKey: key,
    org: (org.results[0] as unknown as OrgRow | undefined) ?? null,
  }
}

/** A store whose privacy/policy reads answer from `r` (no round trips) for
 *  this one address and viewer; every other read stays live. Renamed
 *  addresses (any alias) answer nothing from `r`. */
export function pageStore(st: ForgeStore, r: PageReads): ForgeStore {
  if (r.ownerAliased) return st
  const [o] = r.address.split('/'), name = r.viewer?.name.toLowerCase() ?? null, repository = r.address.includes('/')
  const states: Record<string, Entity> = { ...r.states, ...(repository ? { [r.canonical.state.key]: r.canonical.state } : {}) }
  const lower = (k: string) => { const [first, ...rest] = k.split('/'); return [first.toLowerCase(), ...rest].join('/') }
  return {
    ...st,
    settings: {
      ...st.settings,
      state: async (k) => (k in states ? structuredClone(states[k]) : st.settings.state(k)),
      canonical: async (k) => {
        const n = lower(k)
        if (n === o) return r.ownerKey
        if (repository && n === r.address) return r.canonical.state.key
        return st.settings.canonical(k)
      },
    },
    getRepoAccess: async (id, address) =>
      repository && id === r.access.id && (!address || lower(address) === r.address) ? structuredClone(r.access.value) : st.getRepoAccess(id, address),
    // getOrg: the row, unless the owner entity is deleted (as the D1 store does).
    getOrg: async (n) => n.toLowerCase() === o
      ? (r.org && r.states[o]?.deletedAt === null ? { name: r.org.name, description: r.org.description, createdBy: r.org.created_by, createdAt: r.org.created_at } : null)
      : st.getOrg(n),
    orgRole: async (org, member) => (name && org.toLowerCase() === o && member.toLowerCase() === name ? r.role : st.orgRole(org, member)),
  }
}

/** Header that carries the Worker's PageReads into the Next render. Inbound
 *  copies are always deleted at the Worker entry: only the Worker sets it. */
export const PAGE_READS_HEADER = 'x-gild-page-reads'
