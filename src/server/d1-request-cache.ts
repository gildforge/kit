/** One request's D1 reads: an identical SELECT (same SQL, same values) is
 * answered once per request, and any write clears what was read. The repo
 * primer answers a repository request's address, access and token reads in a
 * single batch up front, so the privacy layer and the API stop asking D1 the
 * same questions one round trip at a time (18 sequential reads per call,
 * 13 Oct trace). A fresh cache is made for every request: nothing is shared
 * between requests or viewers. */
import type { D1Database } from '@cloudflare/workers-types'
import { internalPrefixQuery } from '../engine/import/visibility.js'
import { ACCOUNT_SQL } from './accounts.js'

type Result = { results: unknown[]; success: boolean; meta: unknown }
const READ = /^\s*(SELECT|WITH)\b/i
const keyOf = (sql: string, values: unknown[]) => sql + '\u0000' + JSON.stringify(values)
const copy = <T>(v: T): T => (v === null || typeof v !== 'object' ? v : structuredClone(v))

export class RequestReads {
  private readonly reads = new Map<string, Promise<Result>>()
  /** Reads wait for the primer (one batch) before asking D1 themselves. */
  private priming: Promise<unknown> = Promise.resolve()
  readonly db: D1Database
  private readonly raw: D1Database
  constructor(raw: D1Database) {
    this.raw = raw
    const cache = this
    // D1's own statement objects, with their read and write methods replaced:
    // a statement made here stays a real D1 statement, so any D1 handle's
    // batch() accepts it.
    const patch = <S extends object>(s: S, sql: string, values: unknown[]): S => {
      const own = s as unknown as Record<string, (...a: unknown[]) => unknown>
      const bind = own.bind.bind(s), first = own.first.bind(s), all = own.all.bind(s), run = own.run.bind(s), raw = own.raw?.bind(s)
      const set = (k: string, f: (...a: unknown[]) => unknown) => Object.defineProperty(s, k, { value: f, configurable: true, writable: true })
      set('bind', (...args: unknown[]) => patch(bind(...args) as object, sql, args))
      if (READ.test(sql)) {
        set('all', () => cache.read(sql, values, () => all() as Promise<Result>).then(copy))
        set('first', (column?: unknown) => column !== undefined ? first(column)
          : cache.read(sql, values, () => all() as Promise<Result>).then(r => copy(r.results[0] ?? null)))
      } else {
        const write = (f: (...a: unknown[]) => unknown) => async (...a: unknown[]) => { await cache.settled(); cache.clear(); return f(...a) }
        set('run', write(run)); set('all', write(all)); set('first', write(first)); if (raw) set('raw', write(raw))
      }
      return s
    }
    this.db = new Proxy(raw as object, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        if (key === 'prepare') return (sql: string) => patch(value.call(target, sql), sql, [])
        if (key === 'batch' || key === 'exec') return async (arg: unknown) => {
          await cache.settled()
          cache.clear()
          return value.call(target, arg)
        }
        return value.bind(target)
      },
    }) as D1Database
  }
  settled() { return this.priming.catch(() => undefined) }
  private async read(sql: string, values: unknown[], run: () => Promise<Result>) {
    await this.settled()
    const key = keyOf(sql, values)
    let hit = this.reads.get(key)
    if (!hit) {
      hit = run()
      this.reads.set(key, hit)
      hit.catch(() => this.reads.delete(key))
    }
    return hit
  }
  clear() { this.reads.clear() }
  /** Answers already read in one batch, under the exact SQL and values the
   * store's own methods use, so their later calls are served from here. */
  seed(sql: string, values: unknown[], result: Result) {
    this.reads.set(keyOf(sql, values), Promise.resolve(result))
  }

  /** One round trip for a repository request: the owner's and repository's
   * rename hops, entity rows and access policy, and the caller's token. */
  primeRepository(owner: string, repo: string, tokenHash: Promise<string | null>) {
    this.priming = this.prime(owner, repo, tokenHash)
    return this.priming
  }
  private async prime(owner: string, repo: string, hashed: Promise<string | null>) {
    const tokenHash = await hashed
    owner = owner.toLowerCase()
    const full = `${owner}/${repo}`
    const ALIAS = 'SELECT target FROM settings_aliases WHERE name=? COLLATE NOCASE'
    const KEY = 'SELECT key FROM settings_entities WHERE key=? COLLATE NOCASE'
    const STATE = 'SELECT * FROM settings_entities WHERE key=?'
    const ACCESS = `SELECT meta,acl,pending,(${internalPrefixQuery}) AS internal_prefix FROM repo_access WHERE id=?`
    const TOKEN = 'SELECT * FROM api_tokens WHERE token_hash=?'
    const plain: [string, unknown[]][] = [
      [ALIAS, [owner]], [KEY, [owner]], [ALIAS, [full]], [KEY, [full]], [STATE, [owner]], [STATE, [full]], [ACCOUNT_SQL, [owner]],
      ...(tokenHash ? [[TOKEN, [tokenHash]] as [string, unknown[]]] : []),
    ]
    // The access row is keyed by the repository's id, which the same batch reads.
    const accessByKey = `SELECT a.meta,a.acl,a.pending,(${internalPrefixQuery}) AS internal_prefix, x.id AS access_id
      FROM (SELECT coalesce((SELECT id FROM settings_entities WHERE key=?),?) AS id) x JOIN repo_access a ON a.id=x.id`
    // The caller's role in the owning org, for the token's name (private reads).
    const ROLE = 'SELECT role FROM org_members WHERE org = ? AND member = ?'
    const roleByToken = 'SELECT t.name, m.role FROM api_tokens t LEFT JOIN org_members m ON m.org=? AND m.member=lower(t.name) WHERE t.token_hash=?'
    const results = await this.raw.batch([
      ...plain.map(([sql, values]) => this.raw.prepare(sql).bind(...values)),
      this.raw.prepare(accessByKey).bind(full, full, full),
      ...(tokenHash ? [this.raw.prepare(roleByToken).bind(owner, tokenHash)] : []),
    ]) as unknown as Result[]
    plain.forEach(([sql, values], i) => this.seed(sql, values, results[i]))
    const caller = tokenHash ? results[plain.length + 1].results[0] as { name: string | null; role: string | null } | undefined : undefined
    if (caller?.name) this.seed(ROLE, [owner, caller.name.toLowerCase()], { results: caller.role ? [{ role: caller.role }] : [], success: true, meta: {} })
    // Only a repository with no rename hop resolves to `full`; anything else
    // is left to the store's own reads.
    const aliased = results[0].results.length > 0 || results[2].results.length > 0
    const state = results[5].results[0] as { id?: string } | undefined
    const access = results[plain.length].results[0] as { access_id: string } | undefined
    if (!aliased) {
      const id = state?.id ?? full
      const row = access && access.access_id === id ? (({ access_id: _, ...rest }) => rest)(access) : null
      this.seed(ACCESS, [full, id], { results: row ? [row] : [], success: true, meta: {} })
    }
  }
}
