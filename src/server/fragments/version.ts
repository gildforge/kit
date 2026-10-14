import type { D1Database } from '@cloudflare/workers-types'
/** Renderer-only deploys advance public pointers via the minute cron, rather
 * than a service fetch on every page read. Old assets survive that transition. */
export async function syncRendererVersion(env: {
  DB: D1Database
  GILD_RENDER: { fetch(url: string, init?: RequestInit): Promise<{ ok: boolean; json(): Promise<unknown> }> }
  REPO_INDEX: { idFromName(id: string): unknown; get(id: unknown): { rendererVersion(v: string, backfill?: boolean, shell?: string): Promise<unknown> } }
}) {
  const response = await env.GILD_RENDER.fetch('https://gild-render/version', { method: 'POST' })
  if (!response.ok) throw new Error('Renderer version unavailable')
  const manifest = await response.json() as string | { version: string; shell: string }
  const version = typeof manifest === 'string' ? manifest : manifest.version
  const shell = typeof manifest === 'string' ? undefined : manifest.shell
  if (!/^v[1-9][0-9]*$/.test(version)) throw new Error('Invalid renderer version')
  const ids = (await env.DB.prepare("SELECT a.id FROM repo_access a LEFT JOIN fragment_heads h ON h.id=a.id LEFT JOIN fragment_backfill b ON b.id=a.id WHERE (h.id IS NULL OR json_extract(h.pointer,'$.version')<>? OR (? IS NOT NULL AND json_extract(h.pointer,'$.shell.hash')<>?)) AND coalesce(b.next_attempt,0)<=unixepoch()*1000 GROUP BY a.id ORDER BY coalesce(b.next_attempt,0),a.id LIMIT 20")
    .bind(version, shell ?? null, shell ?? null).all<{ id: string }>()).results
  for (const { id } of ids) {
    await env.DB.prepare('INSERT INTO fragment_backfill VALUES (?,?) ON CONFLICT(id) DO UPDATE SET next_attempt=excluded.next_attempt').bind(id,Date.now()+60_000).run()
    await env.REPO_INDEX.get(env.REPO_INDEX.idFromName(id)).rendererVersion(version,true,shell)
  }
}
