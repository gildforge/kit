import type { D1Database } from '@cloudflare/workers-types'
import { d1Store } from './drivers/d1.js'
import { purgeDeleted, type LifecycleTransport } from './settings.js'
export const PICTURE_GRACE_MS = 60 * 60 * 1000
/** Production cron orchestration. Independent tasks must survive each other. */
export async function settingsScheduled(
  db: D1Database,
  transport: () => Promise<LifecycleTransport>,
  flush: () => Promise<unknown>,
  now = Date.now(),
) {
  try {
    await flush()
  } catch (e) {
    console.error('Agent event flush failed', e)
  }
  let t: LifecycleTransport | null = null
  const st = d1Store(db)
  try {
    t = await transport()
  } catch (e) {
    console.error('Lifecycle transport unavailable', e)
  }
  try {
    // Ended trials become unpaid; expired unpaid accounts are handed to the purge below.
    const changed = await (await import('./accounts.js')).accountLifecycle(db, st, now)
    if (changed.trialsEnded.length || changed.unpaidExpired.length) console.log('Account lifecycle', JSON.stringify(changed))
  } catch (e) {
    console.error('Account lifecycle failed', e)
  }
  if (t) {
    try {
      await purgeDeleted(st, t, now)
    } catch (e) {
      console.error('Settings purge failed', e)
    }
    try {
      for (const state of await st.settings.states()) {
        if (!state.moving || state.id.startsWith('reserve:')) continue
        try {
          const job = await st.settings.renameJob(state.id)
          if (job && !['complete', 'failed'].includes(job.phase))
            await t.resumeRename(job.id)
        } catch (e) {
          console.error('Rename alarm recovery failed', state.key, e)
        }
      }
    } catch (e) {
      console.error('Rename recovery scan failed', e)
    }
  }
  await db
    .prepare("DELETE FROM change_cache WHERE (key GLOB 'landing:[0-9]*' AND CAST(substr(key,9) AS INTEGER)<?) OR (key GLOB 'landing:rows-v2:[0-9]*' AND CAST(substr(key,17) AS INTEGER)<?)")
    .bind(Math.floor(now / 60_000) - 2,Math.floor(now / 60_000) - 2)
    .run()
  await db
    .prepare(
      "DELETE FROM profile_pictures WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM profiles WHERE json_extract(data,'$.picture')='/avatars/' || profile_pictures.hash)",
    )
    .bind(now - PICTURE_GRACE_MS)
    .run()
}
