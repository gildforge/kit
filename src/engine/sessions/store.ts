import { redactReceipt } from './redact.js'
import type { SQL } from '../repo-index-store.js'
import type { Receipt } from '../sessions-contract.js'
import { receiptSchema } from '../sessions-contract.js'
import { ApiError } from '../api/errors.js'
export class SessionStore {
  readonly sql: SQL
  constructor(sql: SQL) {
    this.sql = sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS session_receipts(id TEXT PRIMARY KEY,target TEXT,agent TEXT,version INTEGER,closed INTEGER,json TEXT);CREATE INDEX IF NOT EXISTS session_target ON session_receipts(target,id)',
    )
  }
  get(id: string) {
    const row = [
      ...this.sql.exec<{ json: string }>(
        'SELECT json FROM session_receipts WHERE id=?',
        id,
      ),
    ][0]
    return row ? redactReceipt(receiptSchema.parse(JSON.parse(row.json))) : null
  }
  list(target: string, limit = 100, offset = 0) {
    const total = [
      ...this.sql.exec<{ n: number }>(
        'SELECT count(*) AS n FROM session_receipts WHERE target=?',
        target,
      ),
    ][0].n
    return {
      total,
      receipts: [
        ...this.sql.exec<{ json: string }>(
          "SELECT json FROM session_receipts WHERE target=? ORDER BY json_extract(json,'$.started_at'),id LIMIT ? OFFSET ?",
          target,
          Math.min(100, limit),
          offset,
        ),
      ].map((row) => redactReceipt(receiptSchema.parse(JSON.parse(row.json)))),
    }
  }
  put(data: Receipt, expected: number) {
    const receipt = redactReceipt(receiptSchema.parse(data)),
      old = this.get(receipt.id)
    if (old?.closed)
      throw new ApiError(409, 'Closed session receipts are immutable')
    if (old && (old.agent !== receipt.agent || old.target !== receipt.target))
      throw new ApiError(
        403,
        'A session belongs to its original agent and target',
      )
    if (old && Date.parse(old.started_at) !== Date.parse(receipt.started_at))
      throw new ApiError(409, 'Session start is immutable')
    if (old?.state && receipt.state && Date.parse(receipt.state.last_activity) < Date.parse(old.state.last_activity))
      throw new ApiError(409, 'Session activity cannot move backwards')
    if (old?.runtime && (!receipt.runtime || JSON.stringify({...old.runtime, observed_at:undefined, guest:undefined}) !== JSON.stringify({...receipt.runtime, observed_at:undefined, guest:undefined})))
      throw new ApiError(409, 'Session runtime identity is immutable')
    if (old?.runtime?.mode === 'VM' && old.runtime.guest !== null && (receipt.runtime?.mode !== 'VM' || JSON.stringify(old.runtime.guest) !== JSON.stringify(receipt.runtime.guest)))
      throw new ApiError(409, 'Observed guest identity is immutable')
    if (old) receipt.started_at=old.started_at
    if (old?.runtime && receipt.runtime && Date.parse(receipt.runtime.observed_at) < Date.parse(old.runtime.observed_at))
      throw new ApiError(409, 'Runtime observation cannot move backwards')
    if (old?.version !== expected && !(expected === 0 && !old))
      throw new ApiError(409, 'Session changed; read the receipt and retry')
    if (receipt.version !== expected + 1)
      throw new ApiError(409, 'Invalid session revision')
    if (
      !old &&
      [
        ...this.sql.exec<{ n: number }>(
          'SELECT count(*) AS n FROM session_receipts WHERE target=?',
          receipt.target,
        ),
      ][0].n >= 1000
    )
      throw new ApiError(422, 'Maximum 1000 sessions per target')
    if (!old && [...this.sql.exec<{n: number}>(
      'SELECT count(*) AS n FROM session_receipts WHERE target=? AND agent=?', receipt.target, receipt.agent,
    )][0].n >= 100) throw new ApiError(422, 'Maximum 100 sessions per agent per target')
    this.sql.exec(
      'INSERT INTO session_receipts VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,closed=excluded.closed,json=excluded.json',
      receipt.id,
      receipt.target,
      receipt.agent,
      receipt.version,
      Number(receipt.closed),
      JSON.stringify(receipt),
    )
    return receipt
  }
}
