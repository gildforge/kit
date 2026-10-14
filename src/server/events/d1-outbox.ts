import type { D1Database } from '@cloudflare/workers-types'
import { emit, type EventBindings } from './binding.js'
import type { Emission } from '../../engine/api/events-contract.js'
export async function flushAgentEvents(
  env: EventBindings & { DB: D1Database },
) {
  const rows = (
    await env.DB.prepare(
      'SELECT id,payload FROM event_outbox WHERE sent=0 LIMIT 100',
    ).all<{ id: string; payload: string }>()
  ).results
  for (const row of rows) {
    await emit(JSON.parse(row.payload) as Emission, env)
    await env.DB.prepare('UPDATE event_outbox SET sent=1 WHERE id=?')
      .bind(row.id)
      .run()
  }
  return rows.length === 100
}
