import type { SQL } from '../../engine/repo-index-store.js'
import type { SavedResponse } from './control-do.js'
export class ApiControlStore {
  private sql: SQL
  constructor(sql: SQL) {
    this.sql = sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS idem(key TEXT PRIMARY KEY,fingerprint TEXT,state TEXT,response TEXT,expires INTEGER); CREATE TABLE IF NOT EXISTS rate(window INTEGER PRIMARY KEY,used INTEGER); CREATE TABLE IF NOT EXISTS byte_budget(id TEXT PRIMARY KEY,bytes INTEGER)',
    )
    sql.exec('CREATE TABLE IF NOT EXISTS budget_objects(hash TEXT PRIMARY KEY,size INTEGER); CREATE TABLE IF NOT EXISTS budget_pending(id TEXT,hash TEXT,size INTEGER,PRIMARY KEY(id,hash))')
  }
  reserveBytes(id: string, bytes: number, initial: number, limit: number) {
    const total = [...this.sql.exec<{ n: number }>('SELECT coalesce(sum(bytes),0) AS n FROM byte_budget')][0].n
    const baseline = [...this.sql.exec('SELECT 1 FROM byte_budget WHERE id=?', 'baseline')].length ? 0 : initial
    if (total + baseline + bytes > limit) return false
    this.sql.exec('INSERT OR IGNORE INTO byte_budget VALUES (?,?)', 'baseline', baseline)
    this.sql.exec('INSERT INTO byte_budget VALUES (?,?)', id, bytes)
    return true
  }
  releaseBytes(id: string) { this.sql.exec('DELETE FROM byte_budget WHERE id=?', id) }
  reserveObjects(id: string, objects: { hash: string; size: number }[], initial: { hash: string; size: number }[], limit: number) {
    for (const o of initial) this.sql.exec('INSERT OR IGNORE INTO budget_objects VALUES (?,?)', o.hash, o.size)
    const unique = new Map(objects.map(o => [o.hash, o.size]))
    const old = [...this.sql.exec<{ hash: string; size: number }>('SELECT hash,max(size) AS size FROM (SELECT hash,size FROM budget_objects UNION ALL SELECT hash,size FROM budget_pending) GROUP BY hash')]
    let total = 0
    for (const o of old) { total += o.size; unique.delete(o.hash) }
    if (total + [...unique.values()].reduce((a,b) => a+b,0) > limit) return false
    for (const o of objects) this.sql.exec('INSERT OR REPLACE INTO budget_pending VALUES (?,?,?)', id, o.hash, o.size)
    return true
  }
  finishObjects(id: string, accepted: boolean) {
    if (accepted) this.sql.exec('INSERT OR IGNORE INTO budget_objects SELECT hash,size FROM budget_pending WHERE id=?', id)
    this.sql.exec('DELETE FROM budget_pending WHERE id=?', id)
  }
  rate(now = Date.now(), limit = 10000) {
    const window = Math.floor(now / 3600000),
      sql = this.sql
    sql.exec('DELETE FROM rate WHERE window<?', window)
    sql.exec(
      'INSERT INTO rate VALUES (?,1) ON CONFLICT(window) DO UPDATE SET used=used+1',
      window,
    )
    const used = [
      ...sql.exec<{ used: number }>(
        'SELECT used FROM rate WHERE window=?',
        window,
      ),
    ][0].used
    return {
      limit,
      remaining: Math.max(0, limit - used),
      reset: (window + 1) * 3600,
      allowed: used <= limit,
    }
  }
  begin(key: string, fingerprint: string, now = Date.now()) {
    const sql = this.sql
    // Unknown execution outcomes cannot expire into permission to write again.
    sql.exec("DELETE FROM idem WHERE expires<=? AND state!='running'", now)
    const old = [
      ...sql.exec<{ fingerprint: string; state: string; response: string }>(
        'SELECT * FROM idem WHERE key=?',
        key,
      ),
    ][0]
    if (old)
      return old.fingerprint !== fingerprint
        ? { kind: 'conflict' as const }
        : old.state === 'done'
          ? {
              kind: 'replay' as const,
              response: JSON.parse(old.response) as SavedResponse,
            }
          : { kind: 'pending' as const, ...(old.state === 'running' ? { claim: old.response } : {}) }
    const claim = crypto.randomUUID()
    sql.exec(
      'INSERT INTO idem VALUES (?,?,?,?,?)',
      key,
      fingerprint,
      'pending',
      claim,
      now + 60000,
    )
    return { kind: 'new' as const, claim }
  }
  // Reserve uncertain writes before their side effect. A crash during execution or
  // response persistence cannot safely be retried; running reservations remain
  // until reconciled. Completed responses retain their normal 24-hour window.
  activate(key: string, claim: string, now = Date.now()) {
    const row = [...this.sql.exec<{state: string; response: string; expires: number}>('SELECT * FROM idem WHERE key=?', key)][0]
    if (!row || row.state !== 'pending' || row.response !== claim || row.expires <= now) return false
    this.sql.exec("UPDATE idem SET state='running',expires=? WHERE key=?", now + 86400000, key)
    return true
  }
  finish(key: string, claim: string, response: SavedResponse) {
    this.sql.exec(
      'UPDATE idem SET state=?,response=?,expires=? WHERE key=? AND response=? AND state=?',
      'done',
      JSON.stringify(response),
      Date.now() + 86400000,
      key,
      claim,
      'running',
    )
  }
  release(key: string, claim: string) {
    this.sql.exec(
      'DELETE FROM idem WHERE key=? AND response=? AND state IN (?,?)',
      key,
      claim,
      'pending',
      'running',
    )
  }
}
