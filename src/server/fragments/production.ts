import { publicLeases, defaultEdge, type EdgeContext } from '../../engine/fragments/edge.js'
import { verifyStoredToken, hashToken } from '../token-verifier.js'
import { hasScope, permitsRepo } from '../../engine/api/scopes.js'
import type { D1Database } from '@cloudflare/workers-types'
import type { RepoIndex } from '../repo-index-do.js'
import { d1Store } from '../drivers/d1.js'
import { mayRead, repoAccess, privateAcl } from '../repo-read.js'
import { verifySessionCookie } from '../../engine/session-cookie.js'
import type { FragmentReads } from './http.js'
import { headPointer, PUBLIC_GRANT } from './catalog.js'
import { historyRate, type RenderLimiter } from './rate.js'
type Index = {
  [K in 'fragmentAccess' | 'fragmentPointer' | 'readiness' | 'refresh']: (
    ...args: Parameters<RepoIndex[K]>
  ) => Promise<Awaited<ReturnType<RepoIndex[K]>>>
}
export interface ReadEnv {
  API_CONTROL: RenderLimiter
  GILD_RENDER: { fetch(url: string, init: RequestInit): Promise<Response> }
  DB: D1Database
  SESSION_SECRET?: string
  REPO_INDEX: { idFromName(id: string): unknown; get(id: unknown): Index }
}
export async function requestViewer(request: Request, env: Pick<ReadEnv,'DB'|'SESSION_SECRET'>) {
  const st = d1Store(env.DB),
    authorization = request.headers.get('authorization')
  if (authorization) {
    let token = authorization.match(/^(?:Bearer|token) (.+)$/i)?.[1]
    if (/^Basic /i.test(authorization))
      try {
        token = atob(authorization.slice(6)).split(':').slice(1).join(':')
      } catch {
        return null
      }
    const verified = token ? await verifyStoredToken(token, st) : null
    return verified?.name ? { ...verified, name: verified.name, id: await hashToken(token!) } : null
  }
  const raw = request.headers
      .get('cookie')
      ?.match(/(?:^|;\s*)gild_session=([^;]+)/)?.[1],
    session = await verifySessionCookie(raw, env.SESSION_SECRET)
  const name = session
    ? ((await st.claimByKey(session.publicKey))?.name ?? session.name)
    : null
  return name
    ? { id: '', name, publicKey: session!.publicKey, scopes: null, repos: null }
    : null
}
export function fragmentReads(env: ReadEnv, ctx?: EdgeContext, now = Date.now): FragmentReads {
  const st = d1Store(env.DB)
  // Only successful anonymous grants are cached; tokens never affect these keys.
  const lease = (request: Request) => publicLeases(request, ctx, defaultEdge(), now)
  async function publicHead(request: Request, owner: string, repo: string, ref: string | undefined, path: string, page: string) {
    const address = `${owner.toLowerCase()}/${repo}`
    return lease(request)(JSON.stringify(['pointer', address, ref ?? '', path, page]),
      () => headPointer(env.DB, '', ref || undefined, path, page, address), p => !!p && !p.scope)
  }
  async function coldHistory(request: Request, address: { entity: string; repository?: string }, sha: string) {
    if (!/^[a-f0-9]{40}$/.test(sha)) return null
    const current = await env.DB.prepare("SELECT 1 FROM fragment_reachable WHERE id=? AND fragment LIKE ? LIMIT 1")
      .bind(address.entity, `%/commit/${sha}`).first()
    if (current) return null
    const warm = await env.DB.prepare("SELECT 1 FROM fragment_repos WHERE id=? AND fragment LIKE ? LIMIT 1")
        .bind(address.entity, `%/commit/${sha}`).first()
    if (warm) return null
    return historyRate(request, env.API_CONTROL, (await requestViewer(request, env))?.name ?? null, address.repository ?? address.entity)
  }
  async function authorized(request: Request, owner: string, repo: string) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner) ||
      !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(repo)
    )
      return null
    const state = await st.settings.state(`${owner}/${repo}`),
      org = await st.settings.state(owner)
    if (
      state.id.startsWith('reserve:') ||
      org.id.startsWith('reserve:') ||
      state.deletedAt !== null ||
      org.deletedAt !== null || state.moving || org.moving
    )
      return null
    const index = env.REPO_INDEX.get(
      env.REPO_INDEX.idFromName(
        state.id.includes('/') ? state.id.toLowerCase() : state.id,
      ),
    )
    const services = { store: st, index: async () => index },
      policy = await repoAccess(services, owner, repo)
    if (!policy || policy.pending) return null
    const viewer = privateAcl(policy.acl) ? await requestViewer(request, env) : null
    if (
      (policy.pending || privateAcl(policy.acl)) &&
      (!viewer ||
        !hasScope(viewer, 'repo:read') ||
        !permitsRepo(viewer, owner, repo))
    )
      return null
    if (!(await mayRead(services, owner, repo, viewer?.name ?? null, policy)))
      return null
    // The current D1 policy already grants anonymous reads. Warm public pages
    // do not need to wake a DO just to ask it the same visibility question.
    if (!privateAcl(policy.acl))
      return { entity: state.id, repository: `${owner}/${repo}`, scope: '', index }
    let access: Awaited<ReturnType<Index['fragmentAccess']>>
    try {
      access = await index.fragmentAccess(owner, repo)
    } catch (error) {
      if ((error as { message?: string })?.message === 'Repository not found')
        return null
      throw error
    }
    if (
      access.owner.toLowerCase() !== owner.toLowerCase() ||
      access.repo !== repo
    )
      return null
    return {
      entity: state.id,
      repository: `${owner}/${repo}`,
      scope: access.scope,
      index,
    }
  }
  return {
    coldHistory,
    async publicPointer(request, owner, repo, ref, path = '', page = 'code', sha) {
      if (!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner) || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(repo)) return null
      if (page === 'commit') {
        const key = JSON.stringify(['commit', owner.toLowerCase(), repo, ref ?? '', sha ?? ''])
        return lease(request)(key, async () => {
          // Mutable visibility/chrome still has a short primary lease. The
          // commit presentation pointer is immutable under that complete input,
          // and need not be recomputed each time an access lease expires.
          const access = await publicHead(request, owner, repo, ref, '', 'code')
          if (!access || access.scope) return null
          const { digest, PUBLIC_EDGE_CACHE } = await import('../../render/address.js')
          const edge = ctx && defaultEdge()
          const artifact = new Request(new URL('/__gild-commit-pointer/' + await digest(JSON.stringify([access,sha,path])),request.url))
          const cached = await edge?.match(artifact)
          if (cached) return cached.json() as Promise<import('../../engine/fragments.js').PagePointer>
          const response = await env.GILD_RENDER.fetch('https://gild-render/pointer', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity: access.entity, ref, path, page, sha }) })
          if (!response.ok) throw new Error('Pointer unavailable')
          const pointer = await response.json() as import('../../engine/fragments.js').PagePointer | null
          if (!pointer || pointer.scope || pointer.entity !== access.entity) return null
          if (pointer.tip === access.tip && pointer.meta === access.meta && pointer.shell.hash === access.shell.hash && edge)
            ctx!.waitUntil(edge.put(artifact,Response.json(pointer,{headers:{'cache-control':PUBLIC_EDGE_CACHE}})).catch(()=>{}))
          return pointer
        }, p => !!p && !p.scope)
      }
      return publicHead(request, owner, repo, ref, path.replace(/^\/+|\/+$/g, ''), page)
    },
    async publicAccess(request, fragment) {
      if (fragment.kind === 'shell') return true // Identity-free shared chrome.
      const { fragmentKey } = await import('../../render/address.js')
      return lease(request)('grant:' + fragmentKey(fragment), async () => !!await env.DB.prepare(`SELECT 1 FROM fragment_repos f JOIN repo_access a ON a.id=f.id
        LEFT JOIN settings_entities e ON e.id=f.id
        LEFT JOIN settings_entities org ON org.key=substr(coalesce(e.key,f.id),1,instr(coalesce(e.key,f.id),'/')-1)
        WHERE f.fragment=? AND ${PUBLIC_GRANT} LIMIT 1`).bind(fragmentKey(fragment)).first(), value => value)
    },
    async access(request, owner, repo) {
      return authorized(request, owner, repo)
    },
    async pointer(request, owner, repo, ref, path, page, sha) {
      if (!sha && page !== 'commit') {
        const published = await publicHead(request, owner, repo, ref, (path ?? '').replace(/^\/+|\/+$/g, ''), page ?? 'code')
        if (published) return published
      }
      const access = await authorized(request, owner, repo)
      if (!access) return null
      const stored = await headPointer(env.DB, access.entity, ref || undefined,
        (path ?? '').replace(/^\/+|\/+$/g, ''), page ?? 'code')
      if (stored && page !== 'commit' && !sha) return { ...stored, scope: access.scope }
      const response = await env.GILD_RENDER.fetch(
        'https://gild-render/pointer',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entity: access.entity, ref, path, page, sha }),
        },
      )
      if (!response.ok) throw new Error('Pointer unavailable')
      return response.json()
    },
  }
}
