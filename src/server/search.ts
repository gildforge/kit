import { mayRead } from './repo-read.js'
import { verifyToken } from './tokens.js'
import { hasScope,permitsRepo } from '../engine/api/scopes.js'
import { session } from './session.js'
import { cache } from 'react'
import { indexIfReady, readyIndex } from './repo-index.js'
import { listReposFor } from './artifacts.js'
import { store } from './backend.js'
import { memo } from './kept.js'
import { atoms, parseQuery, type Query } from '../engine/search-query.js'
import type { SearchResult } from '../engine/repo-index-store.js'
export interface Suggestion { repo: string; ref: string; path: string; line: number; name?: string; kind: 'file' | 'symbol' }
export interface SearchResponse extends SearchResult { suggestions: Suggestion[]; indexing: boolean }
interface SearchSnapshot {repository:string;ref:string;tip:string;meta:string|null}
async function searchBinding() {
  try {
    const { getCloudflareContext } = await import('./context.js')
    return ((await getCloudflareContext()).env as { SEARCH_DB?: import('@cloudflare/workers-types').D1Database }).SEARCH_DB ?? null
  } catch { return null }
}
const catalog = memo<{ owner: string; repo: string; kind: 'org' | 'user' }[]>(60_000)
const publicRepos = () => catalog('repos', async () => {
  const owners = await (await store()).owners()
  const repos: { owner: string; repo: string; kind: 'org' | 'user' }[] = []
  // Bounded fan-out, including owners whose repos aren't on the landing page.
  for (let i = 0; i < owners.length; i += 4) {
    const batch = await Promise.all(owners.slice(i, i + 4).map(async (o) => (await listReposFor(o.name, o.kind)).map((r) => ({ owner: o.name, repo: r.name, kind: o.kind }))))
    repos.push(...batch.flat())
  }
  return repos
})
function scopeMatch(q: Query, repo: string, kind: string): boolean | null {
  if (q.op === 'term') {
    if (q.field === 'repo') return repo.toLowerCase() === q.value.toLowerCase()
    if (q.field === 'org' || q.field === 'user') return kind === q.field && repo.split('/')[0].toLowerCase() === q.value.toLowerCase()
    return null
  }
  if (q.op === 'not') { const m = scopeMatch(q.child, repo, kind); return m === null ? null : !m }
  const a = scopeMatch(q.left, repo, kind), b = scopeMatch(q.right, repo, kind)
  if (q.op === 'and') return a === false || b === false ? false : a === true && b === true ? true : null
  return a === true || b === true ? true : a === false && b === false ? false : null
}
export const searchRepos = cache(async (q: string, scope?: { owner: string; repo: string }, page = 1, mode = 'code', viewer: string | null = null, allow: readonly string[] | null = null, snapshot: SearchSnapshot[] | null = null): Promise<SearchResponse> => {
  const parsed = parseQuery(q), result: SearchResponse = { hits: [], count: 0, languages: {}, paths: {}, fallback: parsed.fallback, suggestions: [], indexing: false }
  const st = await store()
  // Site-wide: one D1 query over every readable repository (lib/search-index.ts).
  const searchDB = !scope ? await searchBinding() : null
  if (searchDB) {
    const { searchCode, suggestFiles, readablePrivate, searchCurrent } = await import('./search-index.js')
    const { binding } = await import('./backend.js')
    const ids = await readablePrivate((await binding())!, viewer)
    const listed = allow ? new Set(allow.map(a => a.toLowerCase())) : null
    const readable = async (full: string) => {
      if (listed && !listed.has(full.toLowerCase())) return false
      const [o, r] = full.split('/'); return mayRead({ store: st, index: readyIndex }, o, r, viewer)
    }
    // A published-snapshot search is cached by its catalogue: say "indexing"
    // (never cached) until search rows match every snapshot tip.
    if (snapshot && !await searchCurrent(searchDB, snapshot.map(p => ({ repository: p.repository, ref: p.ref, tip: p.tip })))) result.indexing = true
    const term = mode === 'files' ? q : atoms(parsed.query).find((a) => !a.field || a.field === 'path')?.value ?? ''
    const suggestions = page === 1 ? await suggestFiles(searchDB, term, ids, 12, readable) : []
    if (!q.trim() || mode === 'files') return { ...result, suggestions }
    const found = await searchCode(searchDB, { q, page, limit: 20, readable: ids, mayRead: readable })
    return { ...result, ...found, indexing: result.indexing, hits: found.hits.map(({ blob: _b, commit: _c, private: _p, ...h }) => h), suggestions }
  }
  const repos = snapshot ? await Promise.all([...new Set(snapshot.map(p=>p.repository))].map(async address=>{
    const [owner,repo]=address.split('/');return {owner,repo,kind:await st.getOrg(owner)?'org' as const:'user' as const}
  })) : scope ? [{ ...scope, kind: (await st.getOrg(scope.owner)) ? 'org' as const : 'user' as const }] : await publicRepos()
  const limit = 20, offset = (Math.max(1, page) - 1) * limit
  for (const r of repos) {
    const fullName = `${r.owner}/${r.repo}`
    if(allow && !allow.some(a=>a.toLowerCase()===fullName.toLowerCase()))continue
    if (scopeMatch(parsed.query, fullName, r.kind) === false) continue
    // A scoped search may start indexing its one repo; a site-wide search
    // only reads indexes that are already built, so it can't wake every cold repo.
    if (!await mayRead({store:st,index:readyIndex},r.owner,r.repo,viewer)) continue
    const index = scope ? await readyIndex(r.owner, r.repo) : await indexIfReady(r.owner, r.repo)
    if (!index) { result.indexing = true; continue }
    const advertised=await index.refs()
    if(snapshot) {
      const refs=new Map<string,string>()
      for(const ref of advertised.refs.filter(r=>r.name!=='_meta'))if(!refs.has(ref.name)||ref.kind==='branch')refs.set(ref.name,ref.hash)
      const expected=snapshot.filter(p=>p.repository===fullName)
      if(advertised.meta!==expected[0]?.meta || refs.size!==expected.length || expected.some(p=>refs.get(p.ref)!==p.tip)) {result.indexing=true;continue}
    }
    const selectedRef = atoms(parsed.query).find((a) => a.field === 'ref' || a.field === 'branch')?.value
    const defaultRef = selectedRef ?? advertised.defaultBranch
    const term = mode === 'files' ? q : atoms(parsed.query).find((a) => !a.field || a.field === 'symbol' || a.field === 'path')?.value ?? ''
    if (page === 1 && result.suggestions.length < 12) {
      const [files, symbols] = await Promise.all([index.findFiles(term, defaultRef, 8), mode === 'files' ? [] : index.findSymbols(term, defaultRef)])
      result.suggestions.push(...files.map((f) => ({ ...f, repo: fullName, ref: defaultRef, line: 1, kind: 'file' as const })), ...symbols.map((f) => ({ ...f, repo: fullName, ref: defaultRef, kind: 'symbol' as const })))
      result.suggestions = result.suggestions.slice(0, 12)
    }
    if (!q.trim() || mode === 'files') continue
    const found = await index.search(q, { repo: fullName, ownerKind: r.kind }, undefined, Math.max(0, limit - result.hits.length), Math.max(0, offset - result.count))
    result.hits.push(...found.hits)
    result.count += found.count
    if (found.partial) result.partial = true
    for (const [k, n] of Object.entries(found.languages)) result.languages[k] = (result.languages[k] ?? 0) + n
    for (const [k, n] of Object.entries(found.paths)) result.paths[k] = (result.paths[k] ?? 0) + n
  }
  return result
})
export async function searchAPI(request: Request, scope?: { owner: string; repo: string }) {
  const url = new URL(request.url), q = url.searchParams.get('q') ?? ''
  if (q.length > 2048) return Response.json({ error: 'Query must be at most 2048 characters.' }, { status: 400 })
  const page = Math.min(10000, Math.max(1, Number(url.searchParams.get('page')) || 1))
  try {
    const auth=request.headers.get('authorization')
    const verified=auth?await verifyToken(auth.replace(/^(?:Bearer|token) /i,'')):null
    if(auth&&!verified?.name)return Response.json({error:'Invalid token'},{status:401})
    const principal=verified?.name?{...verified,id:'',name:verified.name}:null
    if(principal&&!hasScope(principal,'repo:read'))return Response.json({error:'Read scope required'},{status:403})
    if(scope&&principal&&!permitsRepo(principal,scope.owner,scope.repo))return Response.json({error:'Not found'},{status:404})
    const viewer=principal?.name??(await session())?.name??null
    const st=await store()
    if(scope&&!await mayRead({store:st,index:readyIndex},scope.owner,scope.repo,viewer))return Response.json({error:'Not found'},{status:404,headers:{'cache-control':'private, no-store'}})
    return Response.json(await searchRepos(q, scope, page, url.searchParams.get('mode') ?? 'code',viewer,principal?.repos ?? (!viewer && request.headers.has('x-gild-public-repos') ? JSON.parse(request.headers.get('x-gild-public-repos')!) as string[] : null), request.headers.has('x-gild-search-snapshot') ? JSON.parse(request.headers.get('x-gild-search-snapshot')!) as SearchSnapshot[] : null), { headers: { 'cache-control': 'private, no-store' } })
  }
  catch { return Response.json({ error: 'Search is temporarily unavailable.' }, { status: 503 }) }
}
