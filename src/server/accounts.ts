/** Account lifecycle: active, trial, unpaid and deleted (migrations/0033).
 *
 *  trial    full access until trial_ends_at (30 days), then unpaid.
 *  unpaid   read-only for everyone: reads follow the usual visibility, every
 *           write (API, git push, channel post) is refused with 402, until
 *           delete_after (30 days), then the account is purged.
 *  deleted  hidden at once, the owner included, through the owner's settings
 *           row (deletedAt), which every read path already honours; the owner
 *           may restore it until delete_after (30 days). The settings purge
 *           cron (purgeDeleted) then removes its repositories, objects, name
 *           and rows.
 *
 *  Borrowed from zega-cloud's graph trials (zegadb/cloud#56): one status on
 *  the resource, its end dates on the row, and a scheduled job that moves an
 *  ended trial to unpaid and an expired one to purge. Billing (Stripe) will
 *  set these statuses through the same functions. */
import type { D1Database } from '@cloudflare/workers-types'
import type { ForgeStore } from './backend.js'
import { RESTORE_MS } from './settings-store.js'

export type AccountStatus = 'active' | 'trial' | 'unpaid' | 'deleted'
export const DAY_MS = 24 * 60 * 60 * 1000
export const TRIAL_MS = 30 * DAY_MS
/** Unpaid and deleted accounts are kept this long, then purged. */
export const ACCOUNT_RETENTION_MS = RESTORE_MS

export interface Account {
  name: string
  status: AccountStatus
  statusAt: number | null
  trialEndsAt: number | null
  deleteAfter: number | null
  previous: Exclude<AccountStatus, 'deleted'> | null
  reason: string | null
}
interface Row { name: string; status: AccountStatus; status_at: number; trial_ends_at: number | null; delete_after: number | null; previous: Account['previous']; reason: string | null }

export const ACCOUNT_SQL = 'SELECT * FROM accounts WHERE name=? COLLATE NOCASE'
const fromRow = (name: string, r: Row | null): Account => r
  ? { name: r.name, status: r.status, statusAt: r.status_at, trialEndsAt: r.trial_ends_at, deleteAfter: r.delete_after, previous: r.previous, reason: r.reason }
  : { name, status: 'active', statusAt: null, trialEndsAt: null, deleteAfter: null, previous: null, reason: null }

export async function account(db: D1Database, name: string): Promise<Account> {
  return fromRow(name, await db.prepare(ACCOUNT_SQL).bind(name).first<Row>())
}

/** May this account change anything? Reads are never refused here: an unpaid
 *  account stays readable, and a deleted one is already hidden. */
export function accountWrites(a: Account): { status: number; message: string } | null {
  if (a.status === 'unpaid')
    return { status: 402, message: `Payment required: @${a.name} is read-only until billing is settled${a.deleteAfter ? `, and is deleted on ${new Date(a.deleteAfter).toISOString().slice(0, 10)}` : ''}` }
  if (a.status === 'deleted')
    return { status: 403, message: `@${a.name} is deleted${a.deleteAfter ? `; it can be restored until ${new Date(a.deleteAfter).toISOString().slice(0, 10)}` : ''}` }
  return null
}

async function hide(st: ForgeStore, name: string, deletedAt: number | null) {
  const s = await st.settings.state(name.toLowerCase())
  if (s.deletedAt === deletedAt) return
  s.deletedAt = deletedAt
  await st.settings.putState(s)
}

/** Set an account's status, with the dates that status implies. */
export async function setAccount(db: D1Database, st: ForgeStore, name: string, status: AccountStatus,
  options: { by: string; reason?: string; now?: number } ) {
  const now = options.now ?? Date.now(), current = await account(db, name)
  const row: Row = { name: current.name, status, status_at: now, trial_ends_at: null, delete_after: null, previous: null, reason: options.reason ?? null }
  if (status === 'trial') row.trial_ends_at = now + TRIAL_MS
  if (status === 'unpaid') row.delete_after = now + ACCOUNT_RETENTION_MS
  if (status === 'deleted') {
    row.previous = current.status === 'deleted' ? current.previous : current.status
    // Kept so a restored trial ends when it would have.
    row.trial_ends_at = current.trialEndsAt
    row.delete_after = current.status === 'deleted' && current.deleteAfter ? current.deleteAfter : now + ACCOUNT_RETENTION_MS
  }
  await db.prepare(`INSERT INTO accounts(name,status,status_at,trial_ends_at,delete_after,previous,reason,updated_by) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET status=excluded.status,status_at=excluded.status_at,trial_ends_at=excluded.trial_ends_at,
      delete_after=excluded.delete_after,previous=excluded.previous,reason=excluded.reason,updated_by=excluded.updated_by`)
    .bind(row.name, row.status, row.status_at, row.trial_ends_at, row.delete_after, row.previous, row.reason, options.by).run()
  // Deletion hides the owner (and so every repository) through the settings
  // row every read path checks; any other status shows it again.
  await hide(st, name, status === 'deleted' ? (current.status === 'deleted' && current.statusAt ? current.statusAt : now) : null)
  return account(db, name)
}

/** The owner restores a deleted account to what it was, within the window. */
export async function restoreAccount(db: D1Database, st: ForgeStore, name: string, by: string, now = Date.now()) {
  const current = await account(db, name)
  if (current.status !== 'deleted') return current
  if (current.deleteAfter !== null && current.deleteAfter <= now) throw new Error('The restore window has passed')
  const previous = current.previous ?? 'active'
  if (previous === 'unpaid') {
    // Restored unpaid: read-only again, keeping the original purge date.
    await setAccount(db, st, name, 'unpaid', { by, reason: 'restored', now })
    await db.prepare('UPDATE accounts SET delete_after=? WHERE name=?').bind(current.deleteAfter, name).run()
    return account(db, name)
  }
  if (previous === 'trial') {
    // A trial keeps its original end, which may already have passed.
    const ends = (await db.prepare('SELECT trial_ends_at FROM accounts WHERE name=?').bind(name).first<{ trial_ends_at: number | null }>())?.trial_ends_at
    await setAccount(db, st, name, 'trial', { by, reason: 'restored', now })
    if (ends) await db.prepare('UPDATE accounts SET trial_ends_at=? WHERE name=?').bind(ends, name).run()
    return account(db, name)
  }
  return setAccount(db, st, name, 'active', { by, reason: 'restored', now })
}

/** Scheduled: an ended trial becomes unpaid (30 days to pay); an unpaid
 *  account past its date is deleted and handed to the settings purge, which
 *  removes it on the same run. Returns what changed. */
export async function accountLifecycle(db: D1Database, st: ForgeStore, now = Date.now()) {
  const ended = (await db.prepare("SELECT name, trial_ends_at FROM accounts WHERE status='trial' AND trial_ends_at<=?").bind(now).all<{ name: string; trial_ends_at: number }>()).results
  for (const t of ended)
    await db.prepare("UPDATE accounts SET status='unpaid', status_at=?, delete_after=?, reason='trial_ended', updated_by='lifecycle' WHERE name=? AND status='trial'")
      .bind(now, t.trial_ends_at + ACCOUNT_RETENTION_MS, t.name).run()
  const expired = (await db.prepare("SELECT name FROM accounts WHERE status='unpaid' AND delete_after<=?").bind(now).all<{ name: string }>()).results
  for (const u of expired) {
    await db.prepare("UPDATE accounts SET status='deleted', status_at=?, previous='unpaid', reason='unpaid', updated_by='lifecycle' WHERE name=? AND status='unpaid'").bind(now, u.name).run()
    // Already past its retention: purge-eligible now (settings purge runs after this).
    await hide(st, u.name, now - RESTORE_MS)
  }
  return { trialsEnded: ended.map(t => t.name), unpaidExpired: expired.map(u => u.name) }
}

export async function isSiteAdmin(db: D1Database, name: string | null) {
  return !!name && !!(await db.prepare('SELECT 1 FROM site_admins WHERE name=?').bind(name).first())
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
export function accountShape(a: Account) {
  return { name: a.name, status: a.status, trial_ends_at: iso(a.trialEndsAt), delete_after: iso(a.deleteAfter), writable: accountWrites(a) === null }
}
export const ACCOUNT_OPERATIONS = ['account', 'deleteAccount', 'restoreAccount', 'setAccount'] as const

/** The account API: your own status, delete (confirm with your name), restore,
 *  and a site admin setting any account's status. Agents act for a sponsor
 *  and never manage an account. */
export async function accountOperation(
  c: { route: { id: string }; params: Record<string, string>; body: Record<string, unknown>; principal: { name: string; anonymous?: boolean } },
  deps: { db: D1Database; store: ForgeStore },
  fail: (status: number, message: string) => never,
) {
  const me = c.principal.name
  if (!me || c.principal.anonymous || me.includes('/')) fail(403, 'Accounts are managed by their owner')
  const { db, store } = deps
  switch (c.route.id) {
    case 'account': return accountShape(await account(db, me))
    case 'deleteAccount':
      if (c.body.confirm !== me) fail(422, `Type ${me} to confirm deletion`)
      return accountShape(await setAccount(db, store, me, 'deleted', { by: me, reason: 'user' }))
    case 'restoreAccount':
      try { return accountShape(await restoreAccount(db, store, me, me)) }
      catch (e) { return fail(409, e instanceof Error ? e.message : 'Cannot restore') }
    case 'setAccount':
      if (!(await isSiteAdmin(db, me))) fail(404, 'Not Found')
      return accountShape(await setAccount(db, store, c.params.name, c.body.status as AccountStatus, { by: me, reason: typeof c.body.reason === 'string' ? c.body.reason : 'admin' }))
  }
  return fail(404, 'Not Found')
}

/** The pipeline's account check (lib/api/dispatch.ts): a deleted caller may
 *  only see and restore their account; an unpaid caller, and anyone writing
 *  to an unpaid owner's repositories, is refused every write with 402. */
export async function accountGate(
  lookup: (name: string) => Promise<Account>,
  principal: { id: string; name: string; anonymous?: boolean },
  route: { id: string },
  params: Record<string, string>,
  method: string,
): Promise<{ status: number; message: string } | null> {
  if ((ACCOUNT_OPERATIONS as readonly string[]).includes(route.id)) return null
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const service = ['runner', 'registration', 'import-runner'].includes(principal.name) || principal.id.startsWith('import:')
  if (!principal.anonymous && !service && principal.name) {
    const own = await lookup(principal.name.split('/')[0])
    if (own.status === 'deleted') return accountWrites(own)
    if (own.status === 'unpaid' && write) return accountWrites(own)
  }
  const owner = params.owner ?? params.org
  if (owner && write) return accountWrites(await lookup(owner))
  return null
}
