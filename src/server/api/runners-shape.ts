import { numericId } from './shapes.js'
import type { PoolRunner } from '../../engine/actions/pool-store.js'
export function runnerShape(
  r: PoolRunner & {
    group_name?: string
    inherited?: boolean
    eligible?: boolean
    ineligible_reason?: string | null
  },
) {
  return {
    id: numericId(r.id),
    gild_id: r.id,
    name: r.name,
    os: r.os,
    arch: r.arch,
    status: Date.now() - r.lastSeen < 120000 ? 'online' : 'offline',
    busy: !!r.assignment,
    labels: r.labels.map((name) => ({
      id: numericId(name),
      name,
      type: 'custom',
    })),
    last_seen: r.lastSeen,
    group: r.group,
    group_name: r.group_name,
    assignment: r.assignment,
    inherited: r.inherited ?? false,
    eligible: r.eligible ?? true,
    ineligible_reason: r.ineligible_reason ?? null,
  }
}
