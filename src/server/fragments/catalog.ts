import type { D1Database } from '@cloudflare/workers-types'
import type { PagePointer, TipManifest } from '../../engine/fragments.js'
import { fragmentKey, type Fragment } from '../../render/address.js'

/** Publish a complete address graph in one D1 transaction. A reader sees the
 * old branch projection or the new one, never a pointer into a partial graph. */
export async function publishHeads(db: D1Database, id: string,
  heads: { pointer: PagePointer; manifest: TipManifest; fragments?: Fragment[] }[], now = Date.now(), currentRefs?: string[],
  /** The fingerprint of the last publish; an identical graph writes nothing. */
  previous?: string | null): Promise<string> {
  if (currentRefs) {
    const old = (await db.prepare('SELECT pointer,manifest FROM fragment_heads WHERE id=?').bind(id)
      .all<{ pointer: string; manifest: string }>()).results
    const ready = new Set(heads.map(h => h.pointer.ref))
    for (const row of old) {
      const pointer = JSON.parse(row.pointer) as PagePointer
      if (currentRefs.includes(pointer.ref) && !ready.has(pointer.ref))
        heads.push({ pointer, manifest: JSON.parse(row.manifest) as TipManifest })
    }
  }
  const keys = new Set<string>()
  for (const { pointer: p, manifest: m, fragments = [] } of heads) {
    for (const f of [...fragments, p.home, p.manifest, p.selected, p.score, p.bundle,
      { kind: 'commit' as const, hash: p.tip },
      ...m.files.flatMap(f => [f.fragment, f.source, f.readme]),
      ...m.trees.map(t => ({ kind: 'tree' as const, hash: t.hash }))])
      if (f) keys.add(fragmentKey({ ...f, version: p.version }, p.scope))
  }
  // Every refresh of an unchanged repository arrives here with the same graph;
  // rewriting it cost ~1M D1 rows an hour (13 Oct). Publish only a change.
  const fingerprint = await publishedFingerprint(id, heads, keys)
  if (previous && previous === fingerprint) return fingerprint
  await db.batch([
    db.prepare('DELETE FROM fragment_reachable WHERE id=?').bind(id),
    db.prepare('INSERT INTO fragment_reachable SELECT ?,value FROM json_each(?)').bind(id, JSON.stringify([...keys])),
    db.prepare('DELETE FROM fragment_heads WHERE id=?').bind(id),
    ...heads.map(({ pointer, manifest }) => db.prepare('INSERT INTO fragment_heads VALUES (?,?,?,?)')
      .bind(id, pointer.ref, JSON.stringify(pointer), JSON.stringify(manifest))),
    db.prepare('UPDATE fragment_retention SET reachable=0,unreachable_at=? WHERE id=? AND reachable=1 AND fragment NOT IN (SELECT value FROM json_each(?))')
      .bind(now, id, JSON.stringify([...keys])),
    db.prepare('UPDATE fragment_retention SET reachable=1 WHERE id=? AND fragment IN (SELECT value FROM json_each(?))')
      .bind(id, JSON.stringify([...keys])),
  ])
  return fingerprint
}

async function publishedFingerprint(id: string, heads: { pointer: PagePointer; manifest: TipManifest }[], keys: Set<string>) {
  const graph = JSON.stringify([id, heads.map(h => [h.pointer, h.manifest]), [...keys].sort()])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(graph))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** One cheap read resolves a branch and its selected file, without transmitting
 * the whole manifest or calling either the repository DO or gild-render. */
export async function headPointer(db: D1Database, id: string, ref: string | undefined,
  path: string, page: string, publicAddress?: string): Promise<PagePointer | null> {
  const row = await db.prepare(`SELECT pointer,
    (SELECT value FROM json_each(h.manifest,'$.files') WHERE json_extract(value,'$.path')=? LIMIT 1) AS file,
    (SELECT value FROM json_each(h.manifest,'$.trees') WHERE json_extract(value,'$.path')=? LIMIT 1) AS tree,
    (SELECT value FROM json_each(h.manifest,'$.files') WHERE json_extract(value,'$.readme') IS NOT NULL LIMIT 1) AS readme
    FROM fragment_heads h
    ${publicAddress ? `JOIN repo_access a ON a.id=h.id
      LEFT JOIN settings_entities e ON e.id=h.id
      LEFT JOIN settings_entities org ON org.key=substr(?,1,instr(?,'/')-1)` : ''}
    WHERE h.id=${publicAddress ? 'coalesce((SELECT id FROM settings_entities WHERE key=?),?)' : '?'}
    AND ref=coalesce(?,json_extract(h.pointer,'$.defaultBranch'),'main')
    ${publicAddress ? `AND ${PUBLIC_GRANT} AND json_extract(h.pointer,'$.meta') IS a.meta
      AND NOT EXISTS(SELECT 1 FROM settings_aliases WHERE name=? OR name=substr(?,1,instr(?,'/')-1))` : ''}`)
    .bind(...(publicAddress ? [path, path, publicAddress, publicAddress, publicAddress, publicAddress, ref ?? null,
      publicAddress, publicAddress, publicAddress] : [path, path, id, ref ?? null]))
    .first<{ pointer: string; file: string | null; tree: string | null; readme: string | null }>()
  if (!row) return null
  const p = JSON.parse(row.pointer) as PagePointer
  if (page === 'score') return p.score ? { ...p, selected: p.score, path: '' } : null
  if (page !== 'code') return null
  const file = row.file ? JSON.parse(row.file) as TipManifest['files'][number] : null
  const tree = row.tree ? JSON.parse(row.tree) as TipManifest['trees'][number] : null
  const readme = row.readme ? JSON.parse(row.readme) as TipManifest['files'][number] : null
  return { ...p, path: path || readme?.path || '', score: null,
    selected: path ? file?.fragment ?? (tree ? { kind: 'tree', hash: tree.hash, version: p.version } : null)
      : readme?.readme ?? null }
}
// The same current-state gate protects public pointer and artifact reads.
// Missing state rows use the legacy entity id; current access must still exist.
export const PUBLIC_GRANT = `a.pending=0 AND coalesce(e.deleted_at,org.deleted_at) IS NULL
  AND coalesce(e.moving,0)=0 AND coalesce(org.moving,0)=0
  AND coalesce(json_extract(a.acl,'$.visibility'),'public')='public'
  AND coalesce(json_extract(a.acl,'$.private'),0)=0`
