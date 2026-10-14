export type { Commit, Entry, BlobInfo, IndexRef } from './types.js'
import type { Commit, Entry, BlobInfo, IndexRef } from './types.js'
// All repository SQL lives here. No Cloudflare dependency: the same store is
// exercised against node:sqlite and can be adapted to per-repo D1 later.
import { LANGUAGES } from './languages.js'
import { atoms, matches, parseQuery, snippets, type Query, type Document, type SearchLine } from './search-query.js'
export interface SQL { exec<T extends Record<string, unknown>>(query: string, ...args: (string | number | null)[]): Iterable<T> }
export interface SearchHit { repo: string; path: string; ref: string; language: string; lines: SearchLine[]; preview?: string }
export interface SearchResult { hits: SearchHit[]; count: number; languages: Record<string, number>; paths: Record<string, number>; fallback: boolean; /** The scan stopped at its budget, so counts are a lower bound. */ partial?: boolean }
const SCHEMA = `
CREATE TABLE IF NOT EXISTS object_sizes(hash TEXT PRIMARY KEY,size INTEGER);
CREATE TABLE IF NOT EXISTS blob_bytes(hash TEXT,part INTEGER,data TEXT,PRIMARY KEY(hash,part));
CREATE TABLE IF NOT EXISTS api_views(key TEXT PRIMARY KEY,json TEXT);
CREATE TABLE IF NOT EXISTS commit_extra(hash TEXT PRIMARY KEY,committer_name TEXT,committer_email TEXT,committer_time INTEGER);
CREATE TABLE IF NOT EXISTS api_hydration(sha TEXT,type TEXT,hash TEXT,path TEXT,PRIMARY KEY(sha,type,hash));
CREATE TABLE IF NOT EXISTS api_objects(kind TEXT,hash TEXT,state TEXT,at INTEGER,PRIMARY KEY(kind,hash));
CREATE TABLE IF NOT EXISTS api_history_jobs(root TEXT,hash TEXT,PRIMARY KEY(root,hash));
CREATE TABLE IF NOT EXISTS api_history_nodes(root TEXT,hash TEXT,time INTEGER,PRIMARY KEY(root,hash));
CREATE TABLE IF NOT EXISTS api_history_roots(root TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS hydrated_roots(hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS commits(hash TEXT PRIMARY KEY, tree TEXT NOT NULL, parents TEXT NOT NULL, author_name TEXT, author_email TEXT, time INTEGER, message TEXT);
CREATE TABLE IF NOT EXISTS trees(tree TEXT, name TEXT, type TEXT, mode TEXT, child TEXT, PRIMARY KEY(tree,name));
CREATE TABLE IF NOT EXISTS objects(hash TEXT PRIMARY KEY, type TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY, size INTEGER, lines INTEGER, language TEXT, binary INTEGER);
CREATE TABLE IF NOT EXISTS blob_text(hash TEXT PRIMARY KEY, content TEXT);
CREATE TABLE IF NOT EXISTS symbols(blob TEXT, name TEXT, kind TEXT, line INTEGER, PRIMARY KEY(blob,name,line));
CREATE INDEX IF NOT EXISTS symbol_name ON symbols(name);
CREATE TABLE IF NOT EXISTS files(root_tree TEXT, path TEXT, blob TEXT, PRIMARY KEY(root_tree,path));
CREATE INDEX IF NOT EXISTS files_blob ON files(blob);
CREATE TABLE IF NOT EXISTS tips(hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS roots(tree TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS summaries(tree TEXT PRIMARY KEY, sizes TEXT);
CREATE TABLE IF NOT EXISTS refs(name TEXT PRIMARY KEY, kind TEXT, hash TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS meta_roots(tip TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS language_mix(tree TEXT PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS meta_files(tip TEXT, path TEXT, json TEXT, PRIMARY KEY(tip,path));
CREATE TABLE IF NOT EXISTS jobs(hash TEXT PRIMARY KEY, type TEXT, name TEXT);
`
export class IndexStore {
  readonly trigram: boolean
  private sql: SQL
  constructor(sql: SQL) {
    this.sql = sql
    sql.exec(SCHEMA)
    // Persist the choice; don't replace the virtual table on cold starts.
    const choice = this.setting('tokenizer')
    if (!choice) {
      try { sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS blob_fts USING fts5(hash UNINDEXED, content, tokenize='trigram', content='blob_text', content_rowid='rowid')"); this.setting('tokenizer', 'trigram') }
      catch { sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS blob_fts USING fts5(hash UNINDEXED, content, tokenize='unicode61', content='blob_text', content_rowid='rowid')"); this.setting('tokenizer', 'unicode61') }
    }
    this.trigram = this.setting('tokenizer') === 'trigram'
  }
  rows<T extends Record<string, unknown>>(q: string, ...args: (string | number | null)[]) { return [...this.sql.exec<T>(q, ...args)] }
  setting(key: string, value?: string) {
    if (value !== undefined) this.sql.exec('INSERT OR REPLACE INTO settings VALUES (?,?)', key, value)
    return this.rows<{ value: string }>('SELECT value FROM settings WHERE key=?', key)[0]?.value ?? null
  }
  has(hash: string) { return this.rows('SELECT 1 FROM objects WHERE hash=?', hash).length > 0 }
  putCommit(c: Commit) {
    if(c.committer_name!==undefined)this.sql.exec('INSERT OR REPLACE INTO commit_extra VALUES (?,?,?,?)',c.hash,c.committer_name,c.committer_email ?? '',c.committer_time ?? c.time)
    this.sql.exec('INSERT OR IGNORE INTO commits VALUES (?,?,?,?,?,?,?)', c.hash, c.tree, JSON.stringify(c.parents), c.author_name, c.author_email, c.time, c.message)
    this.sql.exec('INSERT OR IGNORE INTO objects VALUES (?,?)', c.hash, 'commit')
  }
  putTree(hash: string, entries: Entry[]) {
    for (const e of entries) this.sql.exec('INSERT OR IGNORE INTO trees VALUES (?,?,?,?,?)', hash, e.name, e.type, e.mode, e.child)
    this.sql.exec('INSERT OR IGNORE INTO objects VALUES (?,?)', hash, 'tree')
  }
  putRaw(hash:string,raw:string) { for(let i=0;i<raw.length;i+=262144) this.sql.exec('INSERT OR IGNORE INTO blob_bytes VALUES (?,?,?)',hash,i/262144,raw.slice(i,i+262144)); if(!raw.length)this.sql.exec('INSERT OR IGNORE INTO blob_bytes VALUES (?,0,?)',hash,'') }
  snapshotReady(tree:string) {
    if(this.rows('SELECT 1 FROM hydrated_roots WHERE hash=?',tree).length)return true
    if(!this.tree(tree))return false
    const missing=this.rows(`WITH RECURSIVE paths(type,child) AS (
      SELECT type,child FROM trees WHERE tree=?
      UNION ALL SELECT trees.type,trees.child FROM paths JOIN trees ON paths.child=trees.tree WHERE paths.type='tree'
    ) SELECT 1 FROM paths WHERE (type='tree' AND NOT EXISTS (SELECT 1 FROM objects WHERE hash=child AND objects.type='tree'))
      OR (type='blob' AND NOT EXISTS (SELECT 1 FROM blob_bytes WHERE hash=child)) LIMIT 1`,tree)
    if(missing.length)return false
    this.sql.exec('INSERT OR IGNORE INTO hydrated_roots VALUES (?)',tree);return true
  }
  rawBlob(hash:string) { const parts=this.rows<{data:string}>('SELECT data FROM blob_bytes WHERE hash=? ORDER BY part',hash); return parts.length ? {content:parts.map(p=>p.data).join(''),size:this.rows<{size:number}>('SELECT size FROM blobs WHERE hash=?',hash)[0]?.size ?? 0} : null }
  view(key:string,value?:unknown) { if(value!==undefined)this.sql.exec('INSERT OR IGNORE INTO api_views VALUES (?,?)',key,JSON.stringify(value)); const row=this.rows<{json:string}>('SELECT json FROM api_views WHERE key=?',key)[0];return row ? JSON.parse(row.json) : null }
  putBlob(b: BlobInfo) {
    if(b.raw !== undefined) this.putRaw(b.hash,b.raw)
    if (this.has(b.hash)) return
    this.sql.exec('INSERT INTO blobs VALUES (?,?,?,?,?)', b.hash, b.size, b.lines, b.language, b.binary)
    if (b.content !== null) {
      this.sql.exec('INSERT INTO blob_text VALUES (?,?)', b.hash, b.content)
      this.sql.exec('INSERT INTO blob_fts(rowid,hash,content) SELECT rowid,hash,content FROM blob_text WHERE hash=?', b.hash)
    }
    for (const s of b.symbols) this.sql.exec('INSERT OR IGNORE INTO symbols VALUES (?,?,?,?)', b.hash, s.name, s.kind, s.line)
    this.sql.exec('INSERT INTO objects VALUES (?,?)', b.hash, 'blob')
  }
  commit(hash: string): Commit | null {
    const c = this.rows<{ hash: string; tree: string; parents: string; author_name: string; author_email: string; time: number; message: string }>('SELECT * FROM commits WHERE hash=?', hash)[0]
    return c ? { ...c, ...this.rows<{committer_name:string;committer_email:string;committer_time:number}>('SELECT committer_name,committer_email,committer_time FROM commit_extra WHERE hash=?',hash)[0], parents: JSON.parse(c.parents) } : null
  }
  tree(hash: string): Entry[] | null {
    return this.rows('SELECT 1 FROM objects WHERE hash=? AND type=?',hash,'tree').length ? this.rows<Entry & Record<string, unknown>>('SELECT name,type,mode,child FROM trees WHERE tree=? ORDER BY name', hash) : null
  }
  blobText(hash: string) {
    const b = this.rows<{ size: number; binary: number }>('SELECT size,binary FROM blobs WHERE hash=?', hash)[0]
    if (!b) return null
    if (b.size > 512 * 1024) return { kind: 'large' as const, bytes: b.size }
    if (b.binary) return { kind: 'binary' as const }
    const text = this.rows<{ content: string }>('SELECT content FROM blob_text WHERE hash=?', hash)[0]?.content
    return text === undefined ? null : { kind: 'text' as const, text }
  }
  refs() { return this.rows<IndexRef & Record<string, unknown>>("SELECT CASE kind WHEN 'branch' THEN substr(name,12) ELSE substr(name,11) END AS name,kind,hash FROM refs ORDER BY name") }
  resolve(ref?: string) {
    ref ??= this.setting('defaultBranch') ?? 'main'
    return this.rows<{ hash: string }>('SELECT hash FROM refs WHERE name IN (?,?,?) ORDER BY kind LIMIT 1', ref, `refs/heads/${ref}`, `refs/tags/${ref}`)[0]?.hash ?? (/^[a-f0-9]{40}$/.test(ref) ? ref : null)
  }
  root(ref?: string) { const hash = this.resolve(ref); return hash ? this.commit(hash)?.tree ?? null : null }
  file(path: string, ref?: string) {
    let hash = this.root(ref)
    if (!hash) return null
    const parts = path.split('/')
    for (const [i, name] of parts.entries()) {
      const e: Entry | undefined = this.tree(hash)?.find((e) => e.name === name)
      if (!e) return null
      if (i === parts.length - 1) return e.type === 'blob' ? { hash: e.child, content: this.blobText(e.child) } : null
      if (e.type !== 'tree') return null
      hash = e.child
    }
    return null
  }
  // Flatten just advertised (or formerly advertised) tips. Intermediate trees
  // stay shared; historical commits can still be navigated through tree().
  flatten(root: string) {
    if (this.rows('SELECT 1 FROM roots WHERE tree=?', root).length) return
    const walk = (tree: string, prefix: string) => {
      for (const e of this.tree(tree) ?? []) {
        const path = prefix + e.name
        if (e.type === 'tree') walk(e.child, path + '/')
        else if (e.type === 'blob') this.sql.exec('INSERT OR IGNORE INTO files VALUES (?,?,?)', root, path, e.child)
      }
    }
    walk(root, '')
    this.sql.exec('INSERT OR IGNORE INTO roots VALUES (?)', root)
  }
  rememberTip(hash: string) { this.sql.exec('INSERT OR IGNORE INTO tips VALUES (?)',hash) }
  isTip(hash: string) { return this.rows<{ n: number }>('SELECT 1 AS n FROM tips WHERE hash=?', hash).length > 0 }
  publish(refs: IndexRef[], defaultBranch: string, meta: string | null) {
    for (const r of refs) { const root = this.commit(r.hash)?.tree; if (!root) throw new Error('missing tip'); this.flatten(root) }
    for (const tip of this.rows<{ hash: string }>('SELECT hash FROM tips')) {
      const root = this.commit(tip.hash)?.tree
      if (root) this.flatten(root)
    }
    if (meta && !this.rows('SELECT 1 FROM meta_roots WHERE tip=?',meta).length) {
      const root = this.commit(meta)?.tree
      if (!root) throw new Error('missing meta tip')
      const walk = (tree: string, prefix: string) => {
        for (const e of this.tree(tree) ?? []) {
          const path = prefix + e.name
          if (e.type === 'tree') walk(e.child, path + '/')
          else if (e.type === 'blob' && path.startsWith('.gild/') && (path.endsWith('.json') || /^\.gild\/[0-9]+\/pr\/patch-[0-9]{6}\.patch$/.test(path))) {
            const b = this.blobText(e.child)
            if (b?.kind === 'text') { if(path.endsWith('.json')) JSON.parse(b.text); this.sql.exec('INSERT OR IGNORE INTO meta_files VALUES (?,?,?)', meta, path, b.text) }
          }
        }
      }
      walk(root, '')
      this.sql.exec('INSERT OR IGNORE INTO meta_roots VALUES (?)',meta)
    }
    this.sql.exec('DELETE FROM refs')
    for (const r of refs) this.sql.exec('INSERT INTO refs VALUES (?,?,?,?)', `${r.kind === 'branch' ? 'refs/heads/' : 'refs/tags/'}${r.name}`, r.kind, r.hash, Date.now())
    this.setting('defaultBranch', defaultBranch); this.setting('meta', meta ?? '')
    this.setting('ready', '1')
  }
  historyReady(root:string) {return this.rows('SELECT 1 FROM api_history_roots WHERE root=?',root).length>0}
  requestHistory(root:string) {if(!this.historyReady(root))this.sql.exec('INSERT OR IGNORE INTO api_history_jobs VALUES (?,?)',root,root)}
  apiLog(root:string,limit:number,offset:number) {
    const total=this.rows<{n:number}>('SELECT count(*) AS n FROM api_history_nodes WHERE root=?',root)[0].n
    const rows=this.rows<{hash:string}>('SELECT hash FROM api_history_nodes WHERE root=? ORDER BY time DESC,hash LIMIT ? OFFSET ?',root,limit,offset)
    return {total,commits:rows.map(r=>this.commit(r.hash)!)}
  }
  log(tip: string, limit = 100) {
    const queue = [tip], seen = new Set<string>(), out: Commit[] = []
    while (queue.length && out.length < Math.min(limit, 1000)) {
      queue.sort((a, b) => (this.commit(b)?.time ?? 0) - (this.commit(a)?.time ?? 0))
      const hash = queue.shift()!
      if (seen.has(hash)) continue
      seen.add(hash)
      const c = this.commit(hash)
      if (c) { out.push(c); queue.push(...c.parents) }
    }
    return out
  }
  sizes(root: string) {
    if (!this.has(root)) return null
    const cached = this.rows<{ sizes: string }>('SELECT sizes FROM summaries WHERE tree=?',root)[0]
    if (cached) return JSON.parse(cached.sizes) as { path: string; lines: number }[]
    // Historical commits aren't flattened into files. Traverse their shared
    // tree rows once, then keep the derived Glance sizes under the root hash.
    const sizes = this.rows<{ path: string; lines: number }>(`WITH RECURSIVE paths(path,type,child) AS (
      SELECT name,type,child FROM trees WHERE tree=?
      UNION ALL SELECT paths.path || '/' || trees.name,trees.type,trees.child FROM paths JOIN trees ON paths.child=trees.tree WHERE paths.type='tree'
    ) SELECT path,CASE WHEN binary=1 OR size>524288 THEN max(1,min(200,round(size/40.0))) ELSE max(1,lines) END AS lines FROM paths JOIN blobs ON child=hash WHERE type='blob' ORDER BY path`,root)
    this.sql.exec('INSERT OR IGNORE INTO summaries VALUES (?,?)',root,JSON.stringify(sizes))
    return sizes
  }
  languages(root: string) {
    const cached = this.rows<{ json: string }>('SELECT json FROM language_mix WHERE tree=?',root)[0]
    if (cached) return JSON.parse(cached.json) as { name: string; color: string; share: number }[]
    if (!this.rows('SELECT 1 FROM roots WHERE tree=?', root).length) return null
    const counts = new Map<string, number>()
    for (const f of this.rows<{ path: string }>('SELECT path FROM files WHERE root_tree=?', root)) {
      if (/(^|\/)(vendor|node_modules|dist|build|\.git)\//.test(f.path)) continue
      const name = LANGUAGES[f.path.split('.').pop()!.toLowerCase()]?.[0]
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    const mix = [...counts].sort((a, b) => b[1] - a[1]).map(([name, files]) => ({ name, color: Object.values(LANGUAGES).find(([n]) => n === name)![1], share: files / total }))
    this.sql.exec('INSERT OR IGNORE INTO language_mix VALUES (?,?)',root,JSON.stringify(mix))
    return mix
  }
  metaFile(path: string) { return this.rows<{ json: string }>('SELECT json FROM meta_files WHERE tip=? AND path=?', this.setting('meta'), path)[0]?.json ?? null }
  metaItem(number: number, kind: 'issue' | 'pr') {
    const base = `.gild/${number}/`
    const rows = this.rows<{ path: string; json: string }>('SELECT path,json FROM meta_files WHERE tip=? AND path LIKE ? ORDER BY path', this.setting('meta'), base + '%')
    const main = rows.find((r) => r.path === `${base}${kind}/${kind}.json`)
    if (!main) return null
    const list = (prefix: string) => rows.filter((r) => r.path.startsWith(base + prefix)).map((r) => JSON.parse(r.json))
    return { item: JSON.parse(main.json), comments: list(`${kind}/c-`), reviews: list(`${kind}/r-`), log: list('log/'), queue: JSON.parse(this.metaFile('.gild/queue.json') ?? '[]') }
  }
  counts() { return Object.fromEntries(['commits','trees','blobs','files','symbols','blob_fts','meta_files'].map((t) => [t, this.rows<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)[0].n])) }
  enqueue(hash: string, type: string, name = '') { if (!this.has(hash)) this.sql.exec('INSERT OR IGNORE INTO jobs VALUES (?,?,?)', hash, type, name) }
  jobs(limit: number) { return this.rows<{ hash: string; type: string; name: string }>('SELECT * FROM jobs ORDER BY CASE type WHEN \'blob\' THEN 0 WHEN \'tree\' THEN 1 ELSE 2 END LIMIT ?', limit) }
  finish(hash: string) { this.sql.exec('DELETE FROM jobs WHERE hash=?', hash) }
  pending() { return this.rows<{ n: number }>('SELECT count(*) AS n FROM jobs')[0].n }
  findFiles(query: string, ref?: string, limit = 10) {
    const root = this.root(ref)
    if (!root) return []
    const fuzzy = (path: string) => { let i = 0; for (const c of path.toLowerCase()) if (c === query.toLowerCase()[i]) i++; return i === query.length }
    return this.rows<{ path: string }>('SELECT path FROM files WHERE root_tree=? ORDER BY path', root)
      .filter((f) => fuzzy(f.path)).sort((a, b) => Number(!a.path.toLowerCase().includes(query.toLowerCase())) - Number(!b.path.toLowerCase().includes(query.toLowerCase())) || a.path.length - b.path.length).slice(0, Math.min(limit, 100))
  }
  findSymbols(query: string, ref?: string, limit = 10) {
    const root = this.root(ref)
    return root ? this.rows<{ path: string; name: string; line: number }>(`SELECT path,name,line FROM files JOIN symbols ON files.blob=symbols.blob WHERE root_tree=? AND lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`, root, query.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%', limit) : []
  }
  search(input: string, context: { repo: string; ownerKind: 'user' | 'org' }, ref?: string, limit = 20, offset = 0): SearchResult {
    const { query, fallback } = parseQuery(input)
    const selected = atoms(query).filter((a) => a.field === 'ref' || a.field === 'branch').map((a) => a.value)
    const scopes = [...new Set(ref ? [ref] : selected.length ? selected : [this.setting('defaultBranch') ?? 'main'])]
    const hits: SearchHit[] = [], languages: Record<string, number> = {}, paths: Record<string, number> = {}
    let count = 0
    const narrow = (q: Query): { sql: string; args: string[] } => {
      if (q.op === 'not') return { sql: '1', args: [] }
      if (q.op !== 'term') {
        const a = narrow(q.left), b = narrow(q.right)
        return { sql: `(${a.sql} ${q.op === 'and' ? 'AND' : 'OR'} ${b.sql})`, args: [...a.args, ...b.args] }
      }
      // Trigram MATCH narrows substring/punctuation queries by rowid,
      // without loading every matching external-content blob for its hash.
      // unicode61 cannot narrow substrings safely (foo matches foobar), so
      // use LIKE on its stored text and verify with the same evaluator.
      if ((q.field === '' || q.field === 'content') && q.form !== 'regex' && /^[\x20-\x7e]+$/.test(q.value)) {
        const like = '%' + q.value.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'
        const fulltext = this.trigram && q.value.length >= 3
          ? { sql: 'blob_text.rowid IN (SELECT rowid FROM blob_fts WHERE blob_fts MATCH ?)', args: ['"' + q.value.replaceAll('"','""') + '"'] }
          : { sql: `content LIKE ? ESCAPE '\\'`, args: [like] }
        return q.field === 'content' ? fulltext
          : { sql: `(${fulltext.sql} OR lower(path) LIKE ? ESCAPE '\\')`, args: [...fulltext.args, like] }
      }
      return { sql: '1', args: [] }
    }
    const n = narrow(query), advertised = this.refs()
    // One search can't hold the object (and every other reader) for long:
    // stop after SCAN_LIMIT files or TIME_LIMIT ms and say the result is partial.
    const SCAN_LIMIT = 20_000, TIME_LIMIT = 1500, started = Date.now()
    let scanned = 0, partial = false
    scopes: for (const requested of scopes) {
      const r = advertised.find((r) => r.name === requested) ?? advertised.find((r) => r.name.toLowerCase() === requested.toLowerCase())
      const scope = r?.name ?? requested
      const root = this.root(scope)
      if (!root) continue
      // Iterate, rather than materializing all blob texts in memory. One
      // file <=512KB is verified at a time even for a NOT-only query.
      for (const row of this.sql.exec<{ path: string; blob: string; content: string; language: string }>(`SELECT path,blob,content FROM files JOIN blob_text ON blob=hash WHERE root_tree=? AND ${n.sql} ORDER BY path`, root, ...n.args)) {
        if (++scanned > SCAN_LIMIT || Date.now() - started > TIME_LIMIT) { partial = true; break scopes }
        const language = LANGUAGES[row.path.split('.').pop()!.toLowerCase()]?.[0] ?? ''
        const d: Document = { ...context, ref: scope, refKind: r?.kind, path: row.path, language, content: row.content, symbols: this.rows<{ name: string; kind: string; line: number }>('SELECT name,kind,line FROM symbols WHERE blob=?', row.blob) }
        if (!matches(query, d)) continue
        count++; languages[language || 'Other'] = (languages[language || 'Other'] ?? 0) + 1
        const dir = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : '/'
        paths[dir] = (paths[dir] ?? 0) + 1
        if (count > offset && hits.length < Math.min(limit, 100)) {
          const term = atoms(query).find((a) => (!a.field || a.field === 'content') && a.form !== 'regex' && a.value.length >= 3)
          const preview = this.trigram && term ? this.rows<{ preview: string }>(`SELECT snippet(blob_fts,1,'','','…',30) AS preview FROM blob_fts WHERE blob_fts MATCH ? AND rowid=(SELECT rowid FROM blob_text WHERE hash=?) LIMIT 1`, '"' + term.value.replaceAll('"','""') + '"', row.blob)[0]?.preview : undefined
          hits.push({ repo: context.repo, path: row.path, ref: scope, language, lines: snippets(query, d), preview })
        }
      }
    }
    return { hits, count, languages, paths, fallback, ...(partial ? { partial } : {}) }
  }
}
