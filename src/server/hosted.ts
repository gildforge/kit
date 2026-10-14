// The seam between the open gild and a hosted service that meters and bills.
// Open gild meters nothing: metering() is null until a host provides one.
// The registration lives on a global symbol, so every copy of this module in
// one Worker (the entry's and a bundled Next server's) sees the same answer.
import type { D1Database } from '@cloudflare/workers-types'

export type UsageSource = 'user' | 'artifacts'
export type UsageKind = 'pushed' | 'cloned' | 'fetched' | 'created' | 'imported' | 'forked'
export interface UsageRow { owner: string; repo: string; source: UsageSource; kind: UsageKind; count: number }

export interface Metering {
  recordUsage(db: D1Database, rows: UsageRow[], now?: number): Promise<void>
  recordStorage(db: D1Database, owner: string, repo: string, bytes: number, now?: number): Promise<void>
}

const KEY = Symbol.for('gild.hosted.metering')
type Global = { [KEY]?: Metering | null }

/** Called once by a hosted Worker entry. */
export function provideMetering(metering: Metering | null) { (globalThis as Global)[KEY] = metering }

/** The host's metering, or null when nothing is metered. */
export const metering = (): Metering | null => (globalThis as Global)[KEY] ?? null
