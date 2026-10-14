import type { D1Database } from '@cloudflare/workers-types'
import type { RenameJob } from './settings-rename.js'
import { ApiError } from '../engine/api/errors.js'

export interface Profile {
  displayName: string
  publicEmail: string
  description: string
  url: string
  socialLinks: string[]
  location: string
  picture: string | null
}
export const emptyProfile = (): Profile => ({
  displayName: '',
  publicEmail: '',
  description: '',
  url: '',
  socialLinks: [],
  location: '',
  picture: null,
})
export interface Entity {
  key: string
  id: string
  archived: boolean
  deletedAt: number | null
  moving: boolean
  description: string | null
  defaultBranch: string | null
  previous: string[]
}
export const entity = (key: string): Entity => ({
  key,
  id: key,
  archived: false,
  deletedAt: null,
  moving: false,
  description: null,
  defaultBranch: null,
  previous: [],
})
export interface SettingsStore {
  reserve(key: string, reclaimFrom?: string): Promise<void>
  renameJob(id: string): Promise<RenameJob | null>
  saveRename(job: RenameJob): Promise<void>
  finishRename(job: RenameJob): Promise<void>
  unreserve(key: string): Promise<void>
  garbage(): Promise<{ key: string; org: boolean }[]>
  clean(key: string): Promise<void>
  profile(name: string): Promise<Profile>
  saveProfile(name: string, profile: Profile): Promise<void>
  picture(hash: string): Promise<Uint8Array | null>
  savePicture(hash: string, bytes: Uint8Array): Promise<void>
  byId(id: string): Promise<Entity | null>
  state(key: string): Promise<Entity>
  putState(value: Entity): Promise<void>
  states(): Promise<Entity[]>
  /** Live catalog filter/state in one query; aliases and reservations omitted. */
  listed(owner: string, names: readonly string[]): Promise<Entity[]>
  canonical(key: string): Promise<string>
  reserved(key: string): Promise<boolean>
  rename(
    from: string,
    to: string,
    org: boolean,
    orgOwner?: boolean,
  ): Promise<void>
  forget(key: string, org: boolean): Promise<void>
  lock(key: string): Promise<void>
  unlock(key: string): Promise<void>
  lease(key: string): Promise<string | null>
  renew(id: string): Promise<boolean>
  release(id: string): Promise<void>
  drained(key: string): Promise<boolean>
}
const gone = (s: Entity) => s.archived || s.deletedAt !== null || s.moving
export function memorySettings(
  onForget: (key: string, org: boolean) => void = () => {},
): SettingsStore {
  const profiles = new Map<string, Profile>(),
    pictures = new Map<string, Uint8Array>(),
    states = new Map<string, Entity>(),
    aliases = new Map<string, string>(),
    leases = new Map<string, string>(),
    garbage = new Map<string, boolean>(),
    jobs = new Map<string, RenameJob>()
  return {
    async renameJob(id) {
      return structuredClone(jobs.get(id) ?? null)
    },
    async saveRename(job) {
      jobs.set(job.id, structuredClone(job))
    },
    async finishRename(job) {
      jobs.set(job.id, structuredClone(job))
      if (states.get(job.to)?.id.startsWith('reserve:')) states.delete(job.to)
      const key = job.phase === 'failed' ? job.from : job.to
      const state = structuredClone(states.get(key) ?? entity(key))
      state.moving = false
      states.set(key, state)
    },
    async reserve(k, reclaimFrom) {
      if (
        (await this.reserved(k)) &&
        !(reclaimFrom && aliases.get(k) === reclaimFrom && !states.has(k))
      )
        throw new ApiError(409, 'Name is reserved')
      states.set(k, {
        ...entity(k),
        id: 'reserve:' + crypto.randomUUID(),
        moving: true,
      })
    },
    async unreserve(k) {
      if (states.get(k)?.id.startsWith('reserve:')) states.delete(k)
    },
    async garbage() {
      return [...garbage].map(([key, org]) => ({ key, org }))
    },
    async clean(k) {
      garbage.delete(k)
    },
    async profile(n) {
      return profiles.get(n) ?? emptyProfile()
    },
    async saveProfile(n, p) {
      profiles.set(n, structuredClone(p))
    },
    async picture(h) {
      return pictures.get(h) ?? null
    },
    async savePicture(h, b) {
      pictures.set(h, b.slice())
    },
    async state(k) {
      return structuredClone(states.get(k) ?? entity(k))
    },
    async putState(s) {
      states.set(s.key, structuredClone(s))
    },
    async byId(id) { return structuredClone([...states.values()].find(s=>s.id===id) ?? (id.includes('/')?entity(id):null)) },
    async states() {
      return [...states.values()].map((s) => structuredClone(s))
    },
    async listed(owner, names) {
      if ((await this.state(owner)).deletedAt !== null) return []
      const rows = await Promise.all(names.map(name => this.state(`${owner}/${name}`)))
      return rows.filter(s => s.deletedAt === null && !s.id.startsWith('reserve:') && !aliases.has(s.key) && ![...aliases.keys()].some(k => k.toLowerCase() === s.key.toLowerCase()) && ![...states.keys()].some(k => k !== s.key && k.toLowerCase() === s.key.toLowerCase()))
    },
    async canonical(k) {
      const [owner, ...repo] = k.split('/')
      k = [owner.toLowerCase(), ...repo].join('/')
      for (let i = 0; i < 100; i++) {
        const alias = [...aliases.keys()].find(
          (name) => name.toLowerCase() === k.toLowerCase(),
        )
        if (!alias)
          return (
            [...states.keys()].find(
              (name) => name.toLowerCase() === k.toLowerCase(),
            ) ?? k
          )
        k = aliases.get(alias)!
      }
      throw new Error('Redirect chain exceeds 100 renames')
    },
    async reserved(k) {
      return (
        aliases.has(k) || [...aliases.values()].includes(k) || states.has(k)
      )
    },
    async rename(from, to, org, orgOwner = org) {
      const all = [
        from,
        ...(org
          ? [...states.keys()].filter((k) => k.startsWith(from + '/'))
          : []),
      ]
      for (const old of all) {
        const next = to + old.slice(from.length),
          s = await this.state(old)
        s.key = next
        aliases.delete(next)
        garbage.delete(next)
        s.previous = s.previous.filter((k) => k !== next)
        s.previous.push(old)
        states.delete(old)
        states.set(next, s)
        for (const [alias, target] of aliases)
          if (target === old) aliases.set(alias, next)
        aliases.set(old, next)
        if (old.includes('/')) garbage.set(old, orgOwner)
      }
      if (profiles.has(from)) {
        profiles.set(to, profiles.get(from)!)
        profiles.delete(from)
      }
    },
    async forget(k, org) {
      for (const key of [...states.keys()])
        if (key === k || (org && key.startsWith(k + '/'))) states.delete(key)
      profiles.delete(k)
      onForget(k, org)
    },
    async lock(k) {
      const s = await this.state(k)
      if (
        [...states.values()].some(
          (item) =>
            item.moving &&
            (item.key === k ||
              item.key === k.split('/')[0] ||
              item.key.startsWith(k + '/')),
        )
      )
        throw new ApiError(409, 'A settings operation is already in progress')
      s.moving = true
      states.set(k, s)
    },
    async unlock(k) {
      const s = await this.state(k)
      s.moving = false
      states.set(k, s)
    },
    async lease(k) {
      if (gone(await this.state(k)) || gone(await this.state(k.split('/')[0])))
        return null
      const id = crypto.randomUUID()
      leases.set(id, k)
      return id
    },
    async renew(id) {return leases.has(id)},
    async release(id) {
      leases.delete(id)
    },
    async drained(k) {
      return ![...leases.values()].some((v) => v === k || v.startsWith(k + '/'))
    },
  }
}
/** settings.listed: the live state of each listed name (?1 names JSON, ?2 owner). */
export const LISTED_SQL = `SELECT owner_name || '/' || n.value AS requested,s.* FROM json_each(?1) n
        CROSS JOIN (SELECT ?2 AS owner_name)
        LEFT JOIN settings_entities s ON s.key=owner_name || '/' || n.value COLLATE NOCASE
        WHERE NOT EXISTS (SELECT 1 FROM settings_entities WHERE key=owner_name AND deleted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM settings_aliases WHERE name=owner_name || '/' || n.value COLLATE NOCASE)
        AND s.deleted_at IS NULL AND (s.id IS NULL OR s.id NOT LIKE 'reserve:%')
        AND (s.key IS NULL OR s.key=owner_name || '/' || n.value)`
export interface StateRow {
  key: string
  id: string
  archived: number
  deleted_at: number | null
  moving: number
  description: string | null
  previous: string
  default_branch: string | null
}
export const fromRow = (r: StateRow): Entity => ({
  key: r.key,
  id: r.id,
  archived: !!r.archived,
  deletedAt: r.deleted_at,
  moving: !!r.moving,
  description: r.description,
  defaultBranch: r.default_branch,
  previous: JSON.parse(r.previous),
})
export function d1Settings(db: D1Database): SettingsStore {
  const upsert = (s: Entity) =>
    db
      .prepare(
        "INSERT INTO settings_entities(key,id,archived,deleted_at,moving,description,previous,default_branch) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET id=CASE WHEN settings_entities.id LIKE 'reserve:%' THEN excluded.id ELSE settings_entities.id END,archived=excluded.archived,deleted_at=excluded.deleted_at,moving=excluded.moving,description=excluded.description,previous=excluded.previous,default_branch=excluded.default_branch",
      )
      .bind(
        s.key,
        s.id,
        +s.archived,
        s.deletedAt,
        +s.moving,
        s.description,
        JSON.stringify(s.previous),
        s.defaultBranch,
      )
  return {
    async renameJob(id) {
      const row = await db
        .prepare('SELECT data FROM settings_renames WHERE id=?')
        .bind(id)
        .first<{ data: string }>()
      return row ? JSON.parse(row.data) : null
    },
    async saveRename(job) {
      await db
        .prepare(
          'INSERT INTO settings_renames(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .bind(job.id, JSON.stringify(job))
        .run()
    },
    async finishRename(job) {
      // Terminal progress, reservation release and source unlock are one commit.
      // A retried alarm can never clean a destination claimed by a later job.
      await db.batch([
        db
          .prepare("DELETE FROM owner_names WHERE name=? AND kind='reserved'")
          .bind(job.to),
        db
          .prepare(
            "DELETE FROM settings_entities WHERE key=? AND id LIKE 'reserve:%'",
          )
          .bind(job.to),
        db
          .prepare('UPDATE settings_renames SET data=? WHERE id=?')
          .bind(JSON.stringify(job), job.id),
        db
          .prepare('UPDATE settings_entities SET moving=0 WHERE key=?')
          .bind(job.phase === 'failed' ? job.from : job.to),
      ])
    },
    async reserve(k, reclaimFrom) {
      if (
        (await this.reserved(k)) &&
        !(
          reclaimFrom &&
          (await this.canonical(k)) === reclaimFrom &&
          (await this.state(k)).id === k &&
          (await this.state(reclaimFrom)).previous.includes(k)
        )
      )
        throw new ApiError(409, 'Name is already taken or reserved')
      const statements = [
        db
          .prepare(
            'INSERT INTO settings_entities(key,id,moving) VALUES (?,?,1)',
          )
          .bind(k, 'reserve:' + crypto.randomUUID()),
      ]
      if (!k.includes('/'))
        statements.push(
          db
            .prepare("INSERT INTO owner_names(name,kind) VALUES (?,'reserved')")
            .bind(k),
        )
      try {
        await db.batch(statements)
      } catch {
        throw new ApiError(409, 'Name is already taken or reserved')
      }
    },
    async unreserve(k) {
      await db.batch([
        db
          .prepare(
            "DELETE FROM settings_entities WHERE key=? AND id LIKE 'reserve:%'",
          )
          .bind(k),
        db
          .prepare("DELETE FROM owner_names WHERE name=? AND kind='reserved'")
          .bind(k),
      ])
    },
    async garbage() {
      return (
        await db
          .prepare('SELECT key,org FROM settings_cleanup')
          .all<{ key: string; org: number }>()
      ).results.map((r) => ({ ...r, org: !!r.org }))
    },
    async clean(k) {
      await db.prepare('DELETE FROM settings_cleanup WHERE key=?').bind(k).run()
    },
    async profile(n) {
      const r = await db
        .prepare('SELECT data FROM profiles WHERE name=?')
        .bind(n)
        .first<{ data: string }>()
      return r ? JSON.parse(r.data) : emptyProfile()
    },
    async saveProfile(n, p) {
      await db
        .prepare(
          'INSERT INTO profiles(name,data) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data',
        )
        .bind(n, JSON.stringify(p))
        .run()
    },
    async picture(h) {
      const r = await db
        .prepare('SELECT bytes FROM profile_pictures WHERE hash=?')
        .bind(h)
        .first<{ bytes: ArrayBuffer }>()
      return r ? new Uint8Array(r.bytes) : null
    },
    async savePicture(h, b) {
      await db
        .prepare(
          'INSERT INTO profile_pictures(hash,bytes,created_at) VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET created_at=excluded.created_at',
        )
        .bind(h, b, Date.now())
        .run()
    },
    async state(k) {
      const r = await db
        .prepare('SELECT * FROM settings_entities WHERE key=?')
        .bind(k)
        .first<Parameters<typeof fromRow>[0]>()
      return r ? fromRow(r) : entity(k)
    },
    async putState(s) {
      await upsert(s).run()
    },
    async byId(id) { const row=await db.prepare('SELECT * FROM settings_entities WHERE id=?').bind(id).first<Parameters<typeof fromRow>[0]>(); return row?fromRow(row):id.includes('/')?entity(id):null },
    async states() {
      return (
        await db.prepare('SELECT * FROM settings_entities').all<StateRow>()
      ).results.map(fromRow)
    },
    async listed(owner, names) {
      if (!names.length) return []
      const rows = await db.prepare(LISTED_SQL).bind(JSON.stringify(names), owner).all<StateRow & { requested: string }>()
      return rows.results.map(r => r.key ? fromRow(r) : entity(r.requested))
    },
    async canonical(k) {
      const [owner, ...repo] = k.split('/')
      k = [owner.toLowerCase(), ...repo].join('/')
      for (let i = 0; i < 100; i++) {
        const r = await db
          .prepare(
            'SELECT target FROM settings_aliases WHERE name=? COLLATE NOCASE',
          )
          .bind(k)
          .first<{ target: string }>()
        if (!r)
          return (
            (
              await db
                .prepare(
                  'SELECT key FROM settings_entities WHERE key=? COLLATE NOCASE',
                )
                .bind(k)
                .first<{ key: string }>()
            )?.key ?? k
          )
        k = r.target
      }
      throw new Error('Redirect chain exceeds 100 renames')
    },
    async reserved(k) {
      return !!(await db
        .prepare(
          'SELECT name FROM settings_aliases WHERE name=? OR target=? UNION ALL SELECT key FROM settings_entities WHERE key=? UNION ALL SELECT name FROM owner_names WHERE name=? LIMIT 1',
        )
        .bind(k, k, k, k)
        .first())
    },
    async rename(from, to, org, orgOwner = org) {
      const rows = (await this.states()).filter(
        (s) => s.key === from || (org && s.key.startsWith(from + '/')),
      )
      const statements = [
        db
          .prepare(
            "DELETE FROM settings_entities WHERE key=? AND id LIKE 'reserve:%'",
          )
          .bind(to),
        db
          .prepare("DELETE FROM owner_names WHERE name=? AND kind='reserved'")
          .bind(to),
      ]
      if (org) {
        const o = await db
          .prepare('SELECT * FROM orgs WHERE name=?')
          .bind(from)
          .first<{
            description: string | null
            created_by: string
            created_at: string
          }>()
        if (!o) throw new ApiError(404, 'Not Found')
        statements.push(
          db
            .prepare(
              'INSERT INTO orgs(name,description,created_by,created_at) VALUES (?,?,?,?)',
            )
            .bind(to, o.description, o.created_by, o.created_at),
          db.prepare('UPDATE org_members SET org=? WHERE org=?').bind(to, from),
          db.prepare('DELETE FROM orgs WHERE name=?').bind(from),
          db.prepare('DELETE FROM owner_names WHERE name=?').bind(from),
        )
      }
      for (const s of rows) {
        if (s.key.includes('/'))
          statements.push(
            db
              .prepare(
                'INSERT OR IGNORE INTO settings_cleanup(key,org) VALUES (?,?)',
              )
              .bind(s.key, +orgOwner),
          )
        const next = to + s.key.slice(from.length)
        statements.push(
          db
            .prepare('DELETE FROM settings_aliases WHERE name=? COLLATE NOCASE')
            .bind(next),
          db.prepare('DELETE FROM settings_cleanup WHERE key=?').bind(next),
          db
            .prepare('UPDATE settings_aliases SET target=? WHERE target=?')
            .bind(next, s.key),
          db
            .prepare('INSERT INTO settings_aliases(name,target) VALUES (?,?)')
            .bind(s.key, next),
          db
            .prepare(
              'UPDATE settings_entities SET key=?,previous=? WHERE key=?',
            )
            .bind(
              next,
              JSON.stringify([...s.previous.filter((k) => k !== next), s.key]),
              s.key,
            ),
        )
      }
      statements.push(
        db.prepare('UPDATE profiles SET name=? WHERE name=?').bind(to, from),
        db
          .prepare(
            'UPDATE cqx_scores SET key=? || substr(key,?) WHERE substr(key,1,?)=?',
          )
          .bind(to, from.length + 1, from.length + 1, from + (org ? '/' : '@')),
        db
          .prepare(
            'UPDATE change_cache SET key=replace(key,?,?) WHERE instr(key,?)>0',
          )
          .bind(
            ':' + from + (org ? '/' : ':'),
            ':' + to + (org ? '/' : ':'),
            ':' + from + (org ? '/' : ':'),
          ),
      )
      await db.batch(statements)
    },
    async forget(k, org) {
      const statements = [
        db.prepare('DELETE FROM profiles WHERE name=?').bind(k),
        db
          .prepare(
            'DELETE FROM settings_renames WHERE id IN (SELECT id FROM settings_entities WHERE key=? OR (?=1 AND key LIKE ?))',
          )
          .bind(k, +org, k + '/%'),
      ]
      if (org)
        statements.push(
          db.prepare('DELETE FROM org_members WHERE org=?').bind(k),
          db.prepare('DELETE FROM orgs WHERE name=?').bind(k),
        )
      statements.push(
        db
          .prepare(
            'DELETE FROM settings_entities WHERE key=? OR (?=1 AND key LIKE ?)',
          )
          .bind(k, +org, k + '/%'),
      )
      // Revoke every token scoped to this repo/owner, including multi-repo tokens.
      statements.push(
        db
          .prepare(
            'DELETE FROM api_tokens WHERE EXISTS (SELECT 1 FROM json_each(api_tokens.repos) WHERE value=? COLLATE NOCASE OR (?=1 AND substr(lower(value),1,?)=?))',
          )
          .bind(k, +org, k.length + 1, k.toLowerCase() + '/'),
      )
      // An account (a user owner): its claim, its own and its agents' tokens,
      // agents, requests, memberships, stars, invitations and lifecycle row.
      if (org)
        statements.push(
          db.prepare('DELETE FROM claims WHERE name=?').bind(k),
          db.prepare("DELETE FROM api_tokens WHERE name=? COLLATE NOCASE OR name LIKE ? || '/%'").bind(k, k),
          db.prepare('DELETE FROM agents WHERE sponsor=? COLLATE NOCASE').bind(k),
          db.prepare('DELETE FROM agent_requests WHERE sponsor=? COLLATE NOCASE').bind(k),
          db.prepare("DELETE FROM orchestrators WHERE agent LIKE ? || '/%'").bind(k),
          db.prepare('DELETE FROM org_members WHERE member=? COLLATE NOCASE').bind(k),
          db.prepare('DELETE FROM stars WHERE name=? COLLATE NOCASE').bind(k),
          db.prepare('DELETE FROM repo_invitations WHERE invitee=? COLLATE NOCASE OR inviter=? COLLATE NOCASE').bind(k, k),
          db.prepare('DELETE FROM accounts WHERE name=?').bind(k),
        )
      statements.push(
        db.prepare('DELETE FROM owner_names WHERE name=?').bind(k),
      )
      await db.batch(statements)
    },
    async lock(k) {
      await db
        .prepare('INSERT OR IGNORE INTO settings_entities(key,id) VALUES (?,?)')
        .bind(k, k)
        .run()
      const r = await db
        .prepare(
          'UPDATE settings_entities SET moving=1 WHERE key=? AND moving=0 AND NOT EXISTS (SELECT 1 FROM settings_entities WHERE moving=1 AND (key=? OR key LIKE ?))',
        )
        .bind(k, k.split('/')[0], k + '/%')
        .run()
      if (!r.meta.changes)
        throw new ApiError(409, 'A settings operation is already in progress')
    },
    async unlock(k) {
      await db
        .prepare('UPDATE settings_entities SET moving=0 WHERE key=?')
        .bind(k)
        .run()
    },
    async lease(k) {
      const id = crypto.randomUUID(),
        owner = k.split('/')[0]
      const r = await db
        .prepare(
          'INSERT INTO settings_leases(id,key,expires) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM settings_entities WHERE key IN (?,?) AND (archived=1 OR deleted_at IS NOT NULL OR moving=1))',
        )
        .bind(id, k, Date.now() + 300_000, k, owner)
        .run()
      return r.meta.changes ? id : null
    },
    async renew(id) {const result=await db.prepare('UPDATE settings_leases SET expires=? WHERE id=? AND expires>=?').bind(Date.now()+300000,id,Date.now()).run();return !!result.meta.changes},
    async release(id) {
      await db.prepare('DELETE FROM settings_leases WHERE id=?').bind(id).run()
    },
    async drained(k) {
      await db
        .prepare('DELETE FROM settings_leases WHERE expires<?')
        .bind(Date.now())
        .run()
      return !(await db
        .prepare(
          'SELECT id FROM settings_leases WHERE key=? OR key LIKE ? LIMIT 1',
        )
        .bind(k, k + '/%')
        .first())
    },
  }
}
/** Deleted owners, repositories and accounts stay restorable this long, then are purged. */
export const RESTORE_MS = 30 * 24 * 60 * 60 * 1000
