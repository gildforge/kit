import { channelState, type ChannelState } from './state.js'
import { sessionObservation, type SessionObservation } from '../sessions-contract.js'
import type { SQL } from '../repo-index-store.js'
export interface CurrentSession {state: ChannelState; session?: SessionObservation}
export function decodeCurrentSession(json: string): CurrentSession | null {
  const raw = JSON.parse(json)
  const state = channelState.safeParse(raw.state ?? raw)
  if (!state.success) return null
  const session = sessionObservation.safeParse(raw.session)
  return {state:state.data, ...(session.success ? {session:session.data} : {})}
}
/** Existing channel_states JSON projection, not a new task store or authority. */
export function saveCurrentSession(sql: SQL, receipt: Record<string, unknown>): boolean {
  if (typeof receipt.agent !== 'string' || !receipt.agent.includes('/')) return false
  const projection = sessionObservation.safeParse(Object.fromEntries(
    ['id','started_at','ended_at','updated_at','version','closed','runtime'].filter(k=>receipt[k] !== undefined).map(k=>[k,receipt[k]]),
  ))
  const state = channelState.safeParse(receipt.state ?? (projection.success ? {
    status: projection.data.closed ? 'ended' : 'unknown', last_activity:projection.data.runtime?.observed_at ?? projection.data.updated_at,
  } : undefined))
  if (!state.success) return false
  const row = [...sql.exec<{json:string}>('SELECT json FROM channel_states WHERE agent=?', receipt.agent)][0]
  const previous = row ? decodeCurrentSession(row.json) : null
  if (previous?.session) {
    if (!projection.success) return false // A legacy/delayed report cannot erase a bound session.
    const old=previous.session, next=projection.data
    const start=Date.parse(next.started_at)-Date.parse(old.started_at)
    if (start<0 || (start===0 && next.id!==old.id)) return false // Ambiguous equal starts keep the established session.
    if (next.id===old.id && (Date.parse(next.started_at)!==Date.parse(old.started_at) || next.version<=old.version || old.closed)) return false
  } else if (!projection.success && previous && Date.parse(state.data.last_activity)<Date.parse(previous.state.last_activity)) return false
  const current={state:state.data,...(projection.success ? {session:projection.data} : {})}
  sql.exec('INSERT INTO channel_states VALUES (?,?,?) ON CONFLICT(agent) DO UPDATE SET json=excluded.json,activity=excluded.activity', receipt.agent, JSON.stringify(current), Date.parse(state.data.last_activity))
  return true
}
