import type { SQL } from '../repo-index-store.js'
import type { Emission } from '../api/events-contract.js'
export class EventOutbox {
  readonly sql: SQL
  constructor(sql: SQL) {
    this.sql = sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS event_outbox(id TEXT PRIMARY KEY,event TEXT,done INTEGER DEFAULT 0)',
    )
  }
  put(event: Emission) {
    this.sql.exec(
      'INSERT OR IGNORE INTO event_outbox(id,event) VALUES (?,?)',
      event.id,
      JSON.stringify(event),
    )
  }
  async flush(send: (e: Emission) => Promise<unknown>, limit = 100) {
    const rows = [
      ...this.sql.exec<{ id: string; event: string }>(
        'SELECT id,event FROM event_outbox WHERE done=0 LIMIT ?',
        limit,
      ),
    ]
    for (const row of rows) {
      await send(JSON.parse(row.event))
      this.sql.exec(
        'UPDATE event_outbox SET done=1,event=NULL WHERE id=?',
        row.id,
      )
    }
    return (
      [...this.sql.exec('SELECT 1 FROM event_outbox WHERE done=0 LIMIT 1')]
        .length > 0
    )
  }
}
