import type { D1Database, R2Bucket } from '@cloudflare/workers-types'
import { PUBLIC_EDGE_SECONDS } from '../../render/address.js'
export const HISTORY_GRACE_MS = 30 * 24 * 60 * 60 * 1000
/** Incremental cron sweep, including v1 public objects. Keep shared hashes
 * while any live public repository references them. Edge copies expire in 60s
 * globally; local deletes are only an optimization, never the access guard. */
export async function sweepFragments(env: { DB: D1Database; FRAGMENTS: R2Bucket },
  origin = 'https://gild.gg', now = Date.now()) {
  // v1 producers can still register while the new schema rolls out. Give
  // those rows the same grace period, without changing their INSERT arity.
  await env.DB.prepare('INSERT OR IGNORE INTO fragment_retention SELECT fragment,id,0,? FROM fragment_repos').bind(now).run()
  const rows = (await env.DB.prepare(`SELECT DISTINCT f.fragment FROM fragment_repos f
    WHERE NOT EXISTS (SELECT 1 FROM fragment_retention live
      JOIN repo_access a ON a.id=live.id
      LEFT JOIN settings_entities e ON e.id=live.id
      LEFT JOIN settings_entities org ON org.key=substr(coalesce(e.key,live.id),1,instr(coalesce(e.key,live.id),'/')-1)
      WHERE live.fragment=f.fragment AND coalesce(e.deleted_at,org.deleted_at) IS NULL
        AND (live.fragment LIKE 'private/%' OR
          (a.pending=0 AND coalesce(json_extract(a.acl,'$.visibility'),'public')='public' AND coalesce(json_extract(a.acl,'$.private'),0)=0))
        AND (live.reachable=1 OR live.unreachable_at>?)) LIMIT 100`)
    .bind(now - HISTORY_GRACE_MS).all<{ fragment: string }>()).results
  for (const { fragment } of rows) {
    await env.FRAGMENTS.delete(fragment)
    if (fragment.startsWith('f/')) {
      // Cache API eviction affects this PoP only. Other PoPs have the bounded
      // PUBLIC_EDGE_SECONDS TTL and still gate reads through current visibility.
      await (caches as unknown as { default: Cache }).default.delete(new Request(`${origin}/${fragment}`, {
        headers: { 'accept-encoding': 'gzip' },
      }))
    }
    await env.DB.prepare('DELETE FROM fragment_repos WHERE fragment=?').bind(fragment).run()
  }
  // A terminated request may leave completed staging objects. Timestamp keys
  // sort oldest first; the same cron collects at most 100 abandoned objects.
  const staged = await env.FRAGMENTS.list({prefix:'push-staging/',limit:100})
  const abandoned = staged.objects.filter(o => o.uploaded.getTime() < now - 3600_000).map(o => o.key)
  if (abandoned.length) await env.FRAGMENTS.delete(abandoned)
  return { deleted: rows.length, edgeExpirySeconds: PUBLIC_EDGE_SECONDS }
}
