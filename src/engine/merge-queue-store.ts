import type { SQL } from './repo-index-store.js'

export type MergePlan = { intent:string; commit:string; head:string; base:string; before:string }
export type MergeIntent = { id: string; number: number }
/** A prepare is durable BEFORE Git can accept the queue metadata. Missing
 * receipts are uncertain, never auto-expired into a lost wake-up. */
export class MergeQueueStore {
  private readonly sql: SQL
  constructor(sql: SQL) {
    this.sql = sql
    sql.exec(`CREATE TABLE IF NOT EXISTS merge_intents(id TEXT PRIMARY KEY,number INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS merge_queue_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS merge_commits(intent TEXT NOT NULL,oid TEXT NOT NULL,head TEXT NOT NULL,base TEXT NOT NULL,before_oid TEXT NOT NULL,PRIMARY KEY(intent,oid));`)
  }
  pending(): MergeIntent[] { return [...this.sql.exec<MergeIntent>('SELECT id,number FROM merge_intents ORDER BY rowid')].map(row => ({id:row.id,number:row.number})) }
  prepare(number: number, id = crypto.randomUUID()) {
    if (!Number.isSafeInteger(number) || number < 1) throw Error('Invalid pull request number')
    if (this.pending().length >= 128) throw Error('Merge preparation limit reached; reconcile pending requests')
    this.sql.exec('INSERT INTO merge_intents VALUES (?,?)', id, number)
    return id
  }
  retire(ids: readonly string[]) { for (const id of ids) { this.sql.exec('DELETE FROM merge_intents WHERE id=?', id); this.sql.exec('DELETE FROM merge_commits WHERE intent=?', id) } }
  plan(plan: MergePlan) {
    if (![plan.commit,plan.head,plan.before].every(oid=>/^[a-f0-9]{40}$/.test(oid)) || !plan.intent || !plan.base) throw Error('Invalid merge plan')
    this.sql.exec('INSERT OR IGNORE INTO merge_commits VALUES (?,?,?,?,?)',plan.intent,plan.commit,plan.head,plan.base,plan.before)
  }
  planned(intent: string): MergePlan[] {
    return [...this.sql.exec<MergePlan>('SELECT intent,oid AS "commit",head,base,before_oid AS before FROM merge_commits WHERE intent=?',intent)]
      .map(row=>({intent:row.intent,commit:row.commit,head:row.head,base:row.base,before:row.before}))
  }
  scan(value?: boolean) {
    if (value !== undefined) this.sql.exec('INSERT OR REPLACE INTO merge_queue_state VALUES (?,?)', 'scan', value ? '1' : '0')
    return [...this.sql.exec<{value:string}>('SELECT value FROM merge_queue_state WHERE key=?', 'scan')][0]?.value === '1'
  }
  needed() { return this.scan() || this.pending().length > 0 }
}
