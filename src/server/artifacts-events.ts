/** Artifacts events drive gild: nothing polls Artifacts for changes.
 *
 *  Account subscription (source `artifacts`): repo.created, .deleted,
 *  .forked, .imported keep the owner's catalogue and each repository's own
 *  subscription in step.
 *  Repository subscription (source `artifacts.repo`, one per repository):
 *  pushed re-indexes that repository once; every operation is counted per
 *  repository and day by the hosted service's metering (lib/hosted), source
 *  'artifacts'; a self-hosted gild counts nothing.
 *
 *  Both deliver to the gild-artifacts-events queue (worker.ts queue()). An
 *  event carries no actor, so billing counts the operations a person makes
 *  at gild's git proxy; these counts are what Artifacts itself recorded. */
import type { D1Database } from '@cloudflare/workers-types'
import { metering } from './hosted.js'
import { artifactsApi, type AccountEnv } from './account.js'
import type { UsageKind } from './hosted.js'

export const ARTIFACTS_EVENTS_QUEUE = 'gild-artifacts-events'
export const REPO_EVENTS = ['pushed', 'cloned', 'fetched'] as const

export interface ArtifactsEvent {
  type: string
  source: { type: string; namespace?: string; repoName?: string }
  payload?: { namespace?: string; repoName?: string; ref?: string; before?: string; after?: string }
  metadata?: { eventTimestamp?: string }
}
export interface EventBindings extends AccountEnv {
  DB: D1Database
  /** Queues Write only: creates and deletes event subscriptions. */
  EVENTS_TOKEN?: string
  ARTIFACTS_EVENTS_QUEUE_ID?: string
}
export interface EventEffects {
  /** Re-index one repository (its RepoIndex refresh). */
  refresh(owner: string, repo: string): Promise<void>
  /** Re-observe an owner's repository list. */
  catalogue(owner: string): Promise<void>
}

/** 'u-acme' → acme, 'o-team' → team. Other namespaces are not gild's. */
export function ownerOf(namespace: string): string | null {
  const m = /^[uo]-([a-z0-9][a-z0-9-]{0,38})$/.exec(namespace)
  return m ? m[1] : null
}
const kindOf = (type: string) => type.replace(/^cf\.artifacts\.repo\./, '').replace(/^cf\.artifacts\./, '')

async function subscriptions(env: EventBindings, method: string, path = '', body?: unknown) {
  if (!env.EVENTS_TOKEN || !env.ARTIFACTS_EVENTS_QUEUE_ID) throw new Error('Event subscriptions are not configured')
  const res = await fetch(`${artifactsApi(env)}/event_subscriptions/subscriptions${path}`, {
    method, headers: { authorization: `Bearer ${env.EVENTS_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json() as { success: boolean; result?: { id: string }; errors?: { message: string }[] }
  if (!res.ok || !json.success) {
    if (method === 'DELETE' && res.status === 404) return null
    throw new Error(`event subscription ${method} failed: ${json.errors?.map(e => e.message).join('; ') ?? res.status}`)
  }
  return json.result ?? null
}

/** One subscription per repository, created once. */
export async function ensureRepoSubscription(env: EventBindings, namespace: string, repo: string, now = Date.now()) {
  if (await env.DB.prepare('SELECT 1 FROM artifacts_subscriptions WHERE namespace=? AND repo=?').bind(namespace, repo).first()) return false
  const created = await subscriptions(env, 'POST', '', {
    name: `gild ${namespace}/${repo}`.slice(0, 100), enabled: true,
    source: { type: 'artifacts.repo', namespace, repo_name: repo },
    destination: { type: 'queues.queue', queue_id: env.ARTIFACTS_EVENTS_QUEUE_ID },
    events: [...REPO_EVENTS],
  })
  await env.DB.prepare('INSERT OR IGNORE INTO artifacts_subscriptions VALUES (?,?,?,?)').bind(namespace, repo, created!.id, now).run()
  return true
}
export async function removeRepoSubscription(env: EventBindings, namespace: string, repo: string) {
  const row = await env.DB.prepare('SELECT subscription_id FROM artifacts_subscriptions WHERE namespace=? AND repo=?').bind(namespace, repo).first<{ subscription_id: string }>()
  if (!row) return false
  await subscriptions(env, 'DELETE', '/' + row.subscription_id)
  await env.DB.prepare('DELETE FROM artifacts_subscriptions WHERE namespace=? AND repo=?').bind(namespace, repo).run()
  return true
}

/** Apply a batch of events: count them, then act once per repository. */
export async function handleArtifactsEvents(events: ArtifactsEvent[], env: EventBindings, effects: EventEffects, now = Date.now()) {
  const counts = new Map<string, { owner: string; repo: string; kind: UsageKind; n: number }>()
  const refresh = new Map<string, { owner: string; repo: string }>(), owners = new Set<string>()
  const subscribe: { namespace: string; repo: string }[] = [], unsubscribe: { namespace: string; repo: string }[] = []
  for (const e of events) {
    const kind = kindOf(e.type)
    // Forks name their new repository in the payload; everything else in the source.
    const namespace = (kind === 'forked' ? e.payload?.namespace : e.source.namespace) ?? ''
    const repo = (kind === 'forked' ? e.payload?.repoName : e.source.repoName) ?? ''
    const owner = ownerOf(namespace)
    if (!owner || !repo) continue
    if (['pushed', 'cloned', 'fetched', 'created', 'imported', 'forked'].includes(kind)) {
      const key = `${namespace}/${repo}/${kind}`
      const c = counts.get(key) ?? { owner, repo, kind: kind as UsageKind, n: 0 }
      c.n++; counts.set(key, c)
    }
    if (kind === 'pushed' || kind === 'created' || kind === 'imported' || kind === 'forked') refresh.set(`${owner}/${repo}`, { owner, repo })
    if (kind === 'created' || kind === 'imported' || kind === 'forked') { subscribe.push({ namespace, repo }); owners.add(owner) }
    if (kind === 'deleted') { unsubscribe.push({ namespace, repo }); owners.add(owner); refresh.delete(`${owner}/${repo}`) }
  }
  await metering()?.recordUsage(env.DB, [...counts.values()].map(c => ({ owner: c.owner, repo: c.repo, source: 'artifacts', kind: c.kind, count: c.n })), now)
  for (const s of subscribe) await ensureRepoSubscription(env, s.namespace, s.repo, now)
  for (const s of unsubscribe) await removeRepoSubscription(env, s.namespace, s.repo)
  for (const owner of owners) await effects.catalogue(owner)
  for (const r of refresh.values()) await effects.refresh(r.owner, r.repo)
  return { counted: [...counts.values()].reduce((n, c) => n + c.n, 0), refreshed: refresh.size, subscribed: subscribe.length, unsubscribed: unsubscribe.length }
}
