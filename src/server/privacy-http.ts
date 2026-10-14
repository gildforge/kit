import { RESERVED_NAMES } from '../engine/backend-names.js'
import {
  mayRead,
  mayContribute,
  repoAccess,
  privateAcl,
  type ReadServices,
} from './repo-read.js'
import { hasScope, permitsRepo, type Principal } from '../engine/api/scopes.js'
export interface PrivacyServices extends ReadServices {
  viewer(request: Request): Promise<Principal | null>
  runnerRead?(request: Request, owner: string, repo: string): Promise<boolean>
  pendingImportRead?(request: Request, owner: string, repo: string): Promise<boolean>
  /** The site's 404 document for browser navigations (gild-site#64). */
  missingPage?(request: Request): Promise<Response>
}
export function repositoryPath(
  path: string,
): { owner: string; repo: string } | null {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  let at = 0
  if (parts[0] === 'api') {
    if (parts[1] === 'v1' && parts[2] === 'repos') at = 3
    else if (['repos', 'fragments'].includes(parts[1])) at = 2
    else if (parts[1] === 'user' && parts[2] === 'starred') at = 3
    else return null
  } else if (['git', 'pf'].includes(parts[0])) at = 1
  else if (
    RESERVED_NAMES.includes(parts[0]) ||
    parts[0]?.includes('.')
  )
    return null
  const owner = parts[at],
    repo = parts[at + 1]?.replace(/\.git$/, '')
  return owner &&
    repo &&
    /^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner) &&
    /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(repo)
    ? { owner, repo }
    : null
}
/** Actions, Agents (the channel, sessions, orchestrators) and Score belong to
 * a repository's contributors only: the owner, the owning org's members and
 * everyone its ACL names. Pages and every API (web and /api/v1) under these
 * paths are read as if the repository were private, through this one rule. */
const CONTRIBUTOR_SECTIONS = new Set(['actions', 'agents', 'score', 'health', 'channel', 'orchestrators', 'agent-package', 'collaborators'])
export function contributorPath(url: URL) {
  const address = repositoryPath(url.pathname)
  if (!address) return false
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const at = parts.findIndex((p, i) => p === address.owner && parts[i + 1]?.replace(/\.git$/, '') === address.repo)
  const rest = parts.slice(at + 2)
  if (CONTRIBUTOR_SECTIONS.has(rest[0])) return true
  // Agent session receipts on a pull or commit, and the channel's islands read.
  if (['pulls', 'commits'].includes(rest[0]) && rest[2] === 'sessions') return true
  // The Score view of the fragment reads.
  if (url.searchParams.get('page') === 'score') return true
  return rest[0] === 'islands' && url.searchParams.has('channel')
}
declare const HTMLRewriter: typeof import('@cloudflare/workers-types').HTMLRewriter
/** An anonymous reader is never a contributor. Stored and published copies
 * rendered before the contributor rule still carry these tabs, so every
 * anonymous repository page drops them as it is served. */
export function withoutContributorTabs(request: Request, response: Response): Response {
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/') || !repositoryPath(url.pathname)) return response
  if (/(?:^|;\s*)gild_session=/.test(request.headers.get('cookie') ?? '') || request.headers.has('authorization')) return response
  if (!response.body || !response.headers.get('content-type')?.includes('text/html')) return response
  const remove = { element(e: { remove(): void }) { e.remove() } }
  return new HTMLRewriter()
    .on('nav[aria-label="Repository"] a[data-tab="actions"]', remove)
    .on('nav[aria-label="Repository"] a[data-tab="agents"]', remove)
    .on('nav[aria-label="Repository"] a[data-tab="score"]', remove)
    .transform(response as never) as unknown as Response
}
/** Defense before lifecycle redirects, RSC, legacy routes, and DO RPCs. */
export async function privacyHTTP(
  request: Request,
  s: PrivacyServices,
  forward: (request: Request) => Promise<Response>,
) {
  let address: ReturnType<typeof repositoryPath>
  try {
    address = repositoryPath(new URL(request.url).pathname)
  } catch {
    return new Response('Not found', {
      status: 404,
      headers: { 'cache-control': 'private, no-store' },
    })
  }
  if (!address) return forward(request)
  let { owner, repo } = address
  if (s.store.settings) {
    const original = `${owner}/${repo}`,
      direct = await s.store.settings.canonical(original),
      canonicalOwner = await s.store.settings.canonical(owner)
    ;[owner, repo] = (
      direct === original
        ? await s.store.settings.canonical(`${canonicalOwner}/${repo}`)
        : direct
    ).split('/')
  }
  const access = await repoAccess(s, owner, repo)
  // Existing public routes keep their previous not-found/indexing semantics.
  const gitPath = /\/(?:info\/refs|git-(?:upload|receive)-pack)$/.test(
    new URL(request.url).pathname,
  )
  // Git asks for credentials on missing and private repos alike (as GitHub
  // does), so an anonymous clone cannot tell the two apart.
  // Browsers get the site's 404 page: the same bytes for missing and private.
  const notFound = () =>
    !gitPath && s.missingPage ? s.missingPage(request) : new Response('Not found', {
      status: gitPath && !request.headers.has('authorization') ? 401 : 404,
      headers: {
        'cache-control': 'private, no-store',
        ...(gitPath ? { 'www-authenticate': 'Basic realm="gild"' } : {}),
      },
    })
  if (!access) return notFound()
  const contributorOnly = contributorPath(new URL(request.url))
  const privateRead = access.pending || privateAcl(access.acl) || contributorOnly
  if (privateRead) {
    const viewer = await s.viewer(request),
      allowed =
        viewer &&
        hasScope(viewer, 'repo:read') &&
        permitsRepo(viewer, owner, repo) &&
        (contributorOnly ? await mayContribute(s, owner, repo, viewer.name, access) : await mayRead(s, owner, repo, viewer.name, access))
    const runner =
      access.pending
        ? await s.pendingImportRead?.(request, owner, repo)
        : await s.runnerRead?.(request, owner, repo)
    if (!allowed && !runner) return notFound()
  } else if (!(await mayRead(s, owner, repo, null, access))) return notFound()
  const response = await forward(request)
  if (!privateRead) {
    const cache = response.headers.get('cache-control') ?? ''
    if (!/immutable|max-age=[1-9]/.test(cache)) return response
    const out = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      ...{ encodeBody: 'manual' },
    })
    // Repository content can become private. Revalidation must reach this
    // boundary even for immutable commits; edge/R2 objects remain immutable.
    out.headers.set(
      'cache-control',
      `${cache.includes('private') ? 'private' : 'public'}, max-age=0, must-revalidate`,
    )
    return out
  }
  const out = new Response(response.body, {
    ...response,
    ...(response.status===101 ? {webSocket:(response as unknown as {webSocket:unknown}).webSocket} : {}),
    status: response.status,
    headers: response.headers,
    ...{ encodeBody: 'manual' },
  })
  out.headers.set('cache-control', 'private, no-store')
  out.headers.set('vary', 'Cookie, Authorization')
  out.headers.delete('expires')
  return out
}
