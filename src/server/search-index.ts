/** Code search over every repository's default branch, in its own D1
 * database (SEARCH_DB). Git (Artifacts) is the record: a sync compares the
 * live rows with the tree at the branch tip and writes only the difference,
 * so any drift (an interrupted sync, a missed push) is repaired by the next
 * one. A changed or deleted file's old version is marked replaced, not
 * deleted; the daily cleanup removes replaced versions and unused text. */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { matches, parseQuery, snippets, type Query, type Document } from '../engine/search-query.js'
import { contributorAcl, privateAcl } from './repo-read.js'
import type { ListingSnapshot } from './repo-list-snapshot.js'
import type { SearchHit, SearchResult } from '../engine/repo-index-store.js'

export interface SearchText { content: string; language: string; size: number; symbols: Document['symbols'] }
export interface SearchSync {
  repoId: string
  repository: string
  ownerKind: 'user' | 'org'
  branch: string
  tip: string
  acl: ListingSnapshot['acl']
  /** The ACL revision the visibility was read from. */
  accessMeta: string | null
  pending: boolean
  /** Every file in the tree at `tip`. */
  files: { path: string; blob: string }[]
  /** A file's text, or null for binary or oversized files (not searchable). */
  text(blob: string): SearchText | null
}

/** Rows a single sync writes at most; the rest wait for the next run. */
export const SYNC_BUDGET = 200
const CHUNK = 50
/** Replaced versions are kept this long, then the cleanup removes them. */
export const REPLACED_RETENTION_MS = 24 * 60 * 60 * 1000
const CANDIDATE_LIMIT = 500

/** The private repositories `viewer` may read, from the live access policy
 * in the main database: a broad SQL prefilter, then the pages' own rule
 * (contributorAcl) on each candidate. Read per query, so a grant or a
 * revocation applies to the very next search. */
export async function readablePrivate(main: D1Database, viewer: string | null): Promise<string[]> {
  if (!viewer) return []
  const name = viewer.toLowerCase()
  // A repository without a settings row is keyed by its own address
  // (settings.state's default entity), so its policy row's id is 'owner/repo'.
  const rows = (await main.prepare(`WITH r AS (
      SELECT coalesce(e.key, a.id) AS key, a.id, a.acl, a.pending FROM repo_access a LEFT JOIN settings_entities e ON e.id = a.id
      WHERE e.deleted_at IS NULL AND instr(coalesce(e.key, a.id), '/') > 0),
    o AS (SELECT r.*, substr(r.key, 1, instr(r.key, '/') - 1) AS owner FROM r)
    SELECT o.key, o.id, o.acl, o.pending, (SELECT role FROM org_members m WHERE m.org = lower(o.owner) AND m.member = ?1) AS role
    FROM o WHERE lower(o.owner) = ?1 OR instr(lower(o.acl), ?2) > 0
      OR EXISTS (SELECT 1 FROM org_members m WHERE m.org = lower(o.owner) AND m.member = ?1)`)
    .bind(name, '"@' + name + '"').all<{ key: string; id: string; acl: string; pending: number; role: string | null }>()).results
  // A policy still being published reads as private, as mayRead does.
  return rows.filter(r => contributorAcl(r.key.split('/')[0], name, r.role,
    r.pending ? { visibility: 'private' } as ListingSnapshot['acl'] : JSON.parse(r.acl) as ListingSnapshot['acl'])).map(r => r.id)
}

async function run(db: D1Database, statements: D1PreparedStatement[]) {
  for (let i = 0; i < statements.length; i += CHUNK) await db.batch(statements.slice(i, i + CHUNK))
}

/** Bring one repository's rows in line with the tree at its branch tip.
 * Returns done=false when more than SYNC_BUDGET files differ; call again. */
export async function syncSearch(db: D1Database, s: SearchSync, now = Date.now()): Promise<{ done: boolean; changed: number }> {
  const visibility = s.pending || privateAcl(s.acl) ? 'private' : 'public'
  const [liveRows, headRows] = await db.batch([
    db.prepare('SELECT path, blob_sha FROM search_files WHERE repo_id=? AND replaced_at IS NULL').bind(s.repoId),
    db.prepare('SELECT * FROM search_heads WHERE repo_id=?').bind(s.repoId),
  ])
  const live = new Map((liveRows.results as { path: string; blob_sha: string }[]).map(r => [r.path, r.blob_sha]))
  const head = headRows.results[0] as { commit_sha: string; visibility: string; access_meta: string | null } | undefined
  const tree = new Map(s.files.map(f => [f.path, f.blob]))
  const statements: D1PreparedStatement[] = []

  // Visibility first: a repository made private is hidden before anything
  // else is written.
  if (!head || head.visibility !== visibility)
    statements.push(db.prepare('UPDATE search_files SET visibility=? WHERE repo_id=?').bind(visibility, s.repoId))
  let changed = 0, more = false
  const replace = (path: string) => statements.push(
    db.prepare('UPDATE search_files SET replaced_at=?, replaced_by=? WHERE repo_id=? AND path=? AND replaced_at IS NULL').bind(now, s.tip, s.repoId, path))
  for (const [path, blob] of live) {
    if (tree.get(path) === blob) continue
    if (changed >= SYNC_BUDGET) { more = true; break }
    replace(path); changed++
  }
  for (const [path, blob] of tree) {
    if (live.get(path) === blob) continue
    if (changed >= SYNC_BUDGET) { more = true; break }
    const text = s.text(blob)
    if (!text) continue
    if (live.has(path)) replace(path)
    statements.push(
      db.prepare('INSERT OR IGNORE INTO search_blobs(blob_sha, content, lower, symbols) VALUES (?,?,?,?)')
        .bind(blob, text.content, text.content.toLowerCase(), JSON.stringify(text.symbols)),
      db.prepare(`INSERT INTO search_files(repo_id, repository, path, blob_sha, commit_sha, visibility, language, size, indexed_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(repo_id, path, commit_sha) DO UPDATE SET blob_sha=excluded.blob_sha, visibility=excluded.visibility,
          language=excluded.language, size=excluded.size, indexed_at=excluded.indexed_at, replaced_at=NULL, replaced_by=NULL`)
        .bind(s.repoId, s.repository, path, blob, s.tip, visibility, text.language, text.size, now),
    )
    changed++
  }
  if (!more)
    statements.push(db.prepare(`INSERT INTO search_heads(repo_id, repository, owner_kind, branch, commit_sha, access_meta, visibility, indexed_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET repository=excluded.repository, owner_kind=excluded.owner_kind,
      branch=excluded.branch, commit_sha=excluded.commit_sha, access_meta=excluded.access_meta, visibility=excluded.visibility, indexed_at=excluded.indexed_at`)
      .bind(s.repoId, s.repository, s.ownerKind, s.branch, s.tip, s.accessMeta, visibility, now))
  else if (head && head.visibility !== visibility)
    statements.push(db.prepare('UPDATE search_heads SET visibility=?, access_meta=? WHERE repo_id=?').bind(visibility, s.accessMeta, s.repoId))
  await run(db, statements)
  return { done: !more, changed }
}

/** A repository that no longer exists leaves search at once. */
export async function removeSearch(db: D1Database, repoId: string) {
  await db.batch([
    db.prepare('DELETE FROM search_files WHERE repo_id=?').bind(repoId),
    db.prepare('DELETE FROM search_heads WHERE repo_id=?').bind(repoId),
  ])
}

/** Daily: drop versions replaced more than a day ago, then text no file uses. */
export async function cleanSearch(db: D1Database, now = Date.now()) {
  const [files, blobs] = await db.batch([
    db.prepare('DELETE FROM search_files WHERE replaced_at IS NOT NULL AND replaced_at < ?').bind(now - REPLACED_RETENTION_MS),
    db.prepare('DELETE FROM search_blobs WHERE NOT EXISTS (SELECT 1 FROM search_files f WHERE f.blob_sha = search_blobs.blob_sha)'),
  ])
  return { files: files.meta.changes ?? 0, blobs: blobs.meta.changes ?? 0 }
}

interface Narrow { sql: string; args: string[] }
function narrow(q: Query): Narrow {
  if (q.op === 'not') return { sql: '1', args: [] }
  if (q.op !== 'term') {
    const a = narrow(q.left), b = narrow(q.right)
    return { sql: `(${a.sql} ${q.op === 'and' ? 'AND' : 'OR'} ${b.sql})`, args: [...a.args, ...b.args] }
  }
  if (q.form === 'regex' || !['', 'content', 'path'].includes(q.field)) return { sql: '1', args: [] }
  const value = q.value.toLowerCase()
  const path = { sql: `lower(f.path) LIKE ? ESCAPE '\\'`, args: ['%' + value.replace(/[\\%_]/g, '\\$&') + '%'] }
  if (q.field === 'path') return /[*?]/.test(value) ? { sql: '1', args: [] } : path
  if ([...value].length < 3) return { sql: '1', args: [] }
  const content = { sql: 'b.id IN (SELECT rowid FROM search_text WHERE search_text MATCH ?)', args: ['"' + value.replaceAll('"', '""') + '"'] }
  return q.field === 'content' ? content : { sql: `(${content.sql} OR ${path.sql})`, args: [...content.args, ...path.args] }
}

interface Row { repository: string; path: string; language: string; branch: string; owner_kind: 'user' | 'org'; content: string; symbols: string; blob_sha: string; commit_sha: string; visibility: string }
/** A hit, with the immutable keys the API links to. */
export type IndexedHit = SearchHit & { blob: string; commit: string; private: boolean }
export type IndexedResult = Omit<SearchResult, 'hits'> & { hits: IndexedHit[] }

/** One query over every repository the viewer may read. The trigram index
 * only narrows candidates; each is then evaluated with the query itself,
 * and every repository in the result is re-checked with the live access
 * rule (`mayRead`), so a just-changed ACL never shows code it should hide. */
export async function searchCode(db: D1Database, input: {
  q: string; page?: number; limit?: number
  /** Private repository ids the viewer may read (readablePrivate). */
  readable: string[]
  mayRead(repository: string): Promise<boolean>
}): Promise<IndexedResult> {
  const { query, fallback } = parseQuery(input.q)
  const limit = Math.min(100, input.limit ?? 20), offset = (Math.max(1, input.page ?? 1) - 1) * limit
  const n = narrow(query)
  const rows = (await db.prepare(`SELECT f.repository, f.path, f.language, f.blob_sha, f.commit_sha, f.visibility, h.branch, h.owner_kind, b.content, b.symbols
    FROM search_files f JOIN search_blobs b ON b.blob_sha = f.blob_sha JOIN search_heads h ON h.repo_id = f.repo_id
    WHERE f.replaced_at IS NULL
      AND (f.visibility = 'public' OR f.repo_id IN (SELECT value FROM json_each(?)))
      AND ${n.sql}
    ORDER BY f.repository, f.path LIMIT ${CANDIDATE_LIMIT + 1}`).bind(JSON.stringify(input.readable), ...n.args).all<Row>()).results
  const partial = rows.length > CANDIDATE_LIMIT
  const allowed = new Map<string, boolean>()
  for (const r of new Set(rows.map(r => r.repository))) allowed.set(r, await input.mayRead(r))
  const hits: IndexedHit[] = [], languages: Record<string, number> = {}, paths: Record<string, number> = {}
  let count = 0
  for (const r of rows.slice(0, CANDIDATE_LIMIT)) {
    if (!allowed.get(r.repository)) continue
    const d: Document = { repo: r.repository, ownerKind: r.owner_kind, ref: r.branch, refKind: 'branch', path: r.path, language: r.language, content: r.content, symbols: JSON.parse(r.symbols) }
    if (!matches(query, d)) continue
    count++
    languages[r.language || 'Other'] = (languages[r.language || 'Other'] ?? 0) + 1
    const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '/'
    paths[dir] = (paths[dir] ?? 0) + 1
    if (count > offset && hits.length < limit) hits.push({ repo: r.repository, path: r.path, ref: r.branch, language: r.language, lines: snippets(query, d), blob: r.blob_sha, commit: r.commit_sha, private: r.visibility === 'private' })
  }
  return { hits, count, languages, paths, fallback, ...(partial ? { partial } : {}) }
}


/** Files whose path contains `term`, across readable repositories (the
 * search box's jump-to-file suggestions). */
export async function suggestFiles(db: D1Database, term: string, readable: string[], limit: number, mayRead: (repository: string) => Promise<boolean>) {
  if (!term.trim()) return []
  const rows = (await db.prepare(`SELECT f.repository, f.path, h.branch FROM search_files f JOIN search_heads h ON h.repo_id = f.repo_id
    WHERE f.replaced_at IS NULL AND lower(f.path) LIKE ? ESCAPE '\\'
      AND (f.visibility = 'public' OR f.repo_id IN (SELECT value FROM json_each(?)))
    ORDER BY length(f.path), f.path LIMIT ?`).bind('%' + term.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%', JSON.stringify(readable), limit * 2).all<{ repository: string; path: string; branch: string }>()).results
  const allowed = new Map<string, boolean>()
  for (const r of new Set(rows.map(r => r.repository))) allowed.set(r, await mayRead(r))
  return rows.filter(r => allowed.get(r.repository)).slice(0, limit).map(r => ({ repo: r.repository, ref: r.branch, path: r.path, line: 1, kind: 'file' as const }))
}

/** Whether every listed repository's search rows were built from the given
 * tip of its indexed branch (a cached public answer must never outlive them). */
export async function searchCurrent(db: D1Database, tips: { repository: string; ref: string; tip: string }[]) {
  if (!tips.length) return true
  const heads = (await db.prepare('SELECT repository, branch, commit_sha FROM search_heads WHERE repository IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(tips.map(t => t.repository))])).all<{ repository: string; branch: string; commit_sha: string }>()).results
  return [...new Set(tips.map(t => t.repository))].every(repository => {
    const head = heads.find(h => h.repository.toLowerCase() === repository.toLowerCase())
    const tip = head && tips.find(t => t.repository === repository && t.ref === head.branch)
    return !!tip && tip.tip === head.commit_sha
  })
}
