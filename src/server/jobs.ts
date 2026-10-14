// gild's background work, shared by every gild Worker: Artifacts events and
// their daily repair, webhook delivery, and the scheduled sweeps.
import type { D1Database, MessageBatch } from '@cloudflare/workers-types'
import { ARTIFACTS_EVENTS_QUEUE, handleArtifactsEvents, ensureRepoSubscription, type ArtifactsEvent, type EventEffects } from './artifacts-events.js'
import { reconcileOwnerCatalogue } from './prepared-catalogue-producer.js'
import { observedOwnerCatalogue } from './prepared-catalogue-source.js'
import { d1Store } from './drivers/d1.js'
import { sweepFragments } from './fragments/sweep.js'
import { syncRendererVersion } from './fragments/version.js'
import { settingsScheduled } from './settings-scheduled.js'
import { lifecycleTransport } from './settings-production.js'
import { consumeWebhooks } from './events/consumer.js'
import { flushAgentEvents } from './events/d1-outbox.js'
import type { EventBindings } from './events/binding.js'
import type { EventEnv } from './events/hub-do.js'

export type ArtifactsEnv = { DB: D1Database; ARTIFACTS_TOKEN?: string; EVENTS_TOKEN?: string; ARTIFACTS_EVENTS_QUEUE_ID?: string;
  REPO_INDEX: { idFromName(s: string): unknown; get(id: unknown): { refresh(owner: string, repo: string): Promise<void> } } }

/** What an Artifacts event does: re-index a repository (following renames
 *  to its current name), or re-observe an owner's catalogue. */
export function artifactsEffects(env: ArtifactsEnv): EventEffects {
  return {
    async refresh(owner, physical) {
      const st = d1Store(env.DB), key = await st.settings.canonical(`${owner}/${physical}`), state = await st.settings.state(key)
      if (state.deletedAt !== null || !key.includes('/')) return
      const [o, r] = key.split('/')
      await env.REPO_INDEX.get(env.REPO_INDEX.idFromName(state.id)).refresh(o, r)
    },
    catalogue: owner => reconcileOwnerCatalogue(env.DB, owner, (o, kind) => observedOwnerCatalogue(env.DB, o, kind, env.ARTIFACTS_TOKEN)),
  }
}

/** Daily repair: re-observe every owner and subscribe repositories that have
 *  no event subscription (also the first-run backfill). */
export async function repairArtifactsEvents(env: ArtifactsEnv) {
  const { rawListRepos, nsFor } = await import('./artifacts.js')
  const owners = (await env.DB.prepare("SELECT name, kind FROM owner_names WHERE kind IN ('user','org')").all<{ name: string; kind: 'user' | 'org' }>()).results
  let subscribed = 0, failed = 0
  for (const o of owners) {
    try {
      const ns = nsFor(o.name, o.kind)
      for (const r of await rawListRepos(ns, env.ARTIFACTS_TOKEN)) if (await ensureRepoSubscription(env, ns, r.name)) subscribed++
      await artifactsEffects(env).catalogue(o.name)
    } catch (error) { failed++; console.error('Artifacts repair failed for owner', o.name, error) }
  }
  return { owners: owners.length, subscribed, failed }
}

/** The scheduled sweeps every gild runs (a host may add its own before them). */
export async function scheduledJobs(event: { scheduledTime?: number }, env: ArtifactsEnv & EventBindings & { DB: D1Database; SEARCH_DB?: D1Database }) {
  const at = new Date(event.scheduledTime ?? Date.now())
  try {
    const daily = at.getUTCHours() === 4 && at.getUTCMinutes() === 10
    if (daily || !(await env.DB.prepare('SELECT 1 FROM artifacts_subscriptions LIMIT 1').first()))
      console.log('Artifacts event repair', JSON.stringify(await repairArtifactsEvents(env)))
  } catch (error) { console.error('Artifacts event repair failed', error) }
  // Daily at 04:00 UTC: drop search versions replaced over a day ago.
  if (env.SEARCH_DB && at.getUTCHours() === 4 && at.getUTCMinutes() === 0)
    try { console.log('Search cleanup', await (await import('./search-index.js')).cleanSearch(env.SEARCH_DB)) } catch (error) { console.error('Search cleanup failed', error) }
  try { await syncRendererVersion(env as never) } catch (error) { console.error('Renderer version sync failed', error) }
  try { await sweepFragments(env as never) } catch (error) { console.error('Fragment sweep failed', error) }
  await settingsScheduled(env.DB, () => lifecycleTransport(env as never), () => flushAgentEvents(env as never))
}

/** Answer a queue batch gild owns; false when the batch belongs to the host. */
export async function queueJobs(batch: MessageBatch<unknown>, env: ArtifactsEnv & EventBindings): Promise<boolean> {
  // An install names its queues <worker>-…; gild.gg's are gild-….
  if (batch.queue.endsWith(ARTIFACTS_EVENTS_QUEUE.slice('gild'.length))) {
    const events = batch.messages.map(m => (typeof m.body === 'string' ? JSON.parse(m.body) : m.body) as ArtifactsEvent)
    const result = await handleArtifactsEvents(events, env as never, artifactsEffects(env))
    if (result.refreshed || result.subscribed || result.unsubscribed) console.log('Artifacts events', JSON.stringify(result))
    return true
  }
  if (batch.queue.endsWith('-public-pages')) return false
  await consumeWebhooks(batch as MessageBatch<{ delivery: string }>, env as unknown as EventBindings & EventEnv)
  return true
}
