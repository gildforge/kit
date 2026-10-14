import type { SQL } from '../repo-index-store.js'
import type { ChannelMessage, ChannelQuery, ChannelPage } from '../api/channel-contract.js'
import { ApiError } from '../api/errors.js'
export class ChannelStore {
  readonly sql: SQL
  constructor(sql: SQL) {
    this.sql=sql
    sql.exec('CREATE TABLE IF NOT EXISTS channel_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT UNIQUE, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_rate(account TEXT PRIMARY KEY, minute INTEGER, count INTEGER); CREATE TABLE IF NOT EXISTS channel_mentions(id TEXT PRIMARY KEY, json TEXT NOT NULL);')
  }
  sequence() { return [...this.sql.exec<{ n: number }>('SELECT coalesce(max(seq),0) n FROM channel_log')][0].n }
  append(source: string, message: Omit<ChannelMessage, 'cursor'>) {
    this.sql.exec('INSERT OR IGNORE INTO channel_log(source,json) VALUES (?,?)', source, JSON.stringify(message))
    const row = [...this.sql.exec<{ seq: number; json: string }>('SELECT seq,json FROM channel_log WHERE source=?', source)][0]
    return { ...JSON.parse(row.json), cursor: String(row.seq) } as ChannelMessage
  }
  /** Consecutive agent-authored messages at the tip (system notes ignored), counted up to `max`. */
  agentRun(max: number) {
    let run = 0
    for (const row of this.sql.exec<{json:string}>("SELECT json FROM channel_log WHERE json_extract(json,'$.kind')='message' ORDER BY seq DESC LIMIT ?", max)) {
      if (JSON.parse(row.json).author.kind !== 'agent') break
      run++
    }
    return run
  }
  page(q: ChannelQuery): ChannelPage {
    const latest = this.sequence()
    for (const cursor of [q.before, q.after]) if (cursor && Number(cursor) > latest + 1) throw new ApiError(422, 'Invalid channel cursor')
    const rows = [...this.sql.exec<{seq:number; json:string}>(`SELECT seq,json FROM channel_log WHERE seq ${q.after ? '>' : '<'} ? ORDER BY seq ${q.after ? 'ASC' : 'DESC'} LIMIT ?`, Number(q.after ?? q.before ?? latest + 1), q.limit + 1)]
    const more = rows.length > q.limit
    const selected = rows.slice(0, q.limit)
    if (!q.after) selected.reverse()
    const messages = selected.map(r => ({ ...JSON.parse(r.json), cursor: String(r.seq) })) as ChannelMessage[]
    return { messages, cursor: String(latest), before: messages.length && (q.after ? Number(messages[0].cursor) > 1 : more) ? messages[0].cursor : null, after: messages.length && (q.after ? more : Number(messages.at(-1)!.cursor) < latest) ? messages.at(-1)!.cursor : null }
  }
  rate(account: string, now = Date.now()) {
    const minute = Math.floor(now / 60000)
    this.sql.exec('DELETE FROM channel_rate WHERE minute<?', minute - 1)
    this.sql.exec('INSERT INTO channel_rate VALUES (?,?,1) ON CONFLICT(account) DO UPDATE SET count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END,minute=excluded.minute', account, minute)
    if ([...this.sql.exec<{count:number}>('SELECT count FROM channel_rate WHERE account=?', account)][0].count > 30) throw new ApiError(429, 'Channel posting limit exceeded (30 per account per minute)')
  }
}
