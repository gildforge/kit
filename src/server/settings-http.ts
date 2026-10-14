import { ApiError } from '../engine/api/errors.js'
import { csrfSafe } from '../engine/csrf.js'
import type { ForgeStore } from './backend.js'
import { RESERVED_NAMES } from '../engine/backend-names.js'
import { matchRequest } from '../engine/api/routing.js'
/** The production Worker and local harness share redirect/read-only fencing. */
export async function settingsHTTP(
  request: Request,
  st: ForgeStore,
  forward: (r: Request) => Promise<Response>,
) {
  const fail = (status: number, message: string) =>
    Response.json(
      { message, error: message },
      { status, headers: { 'cache-control': 'no-store' } },
    )
  const url = new URL(request.url)
  let parts: string[], found: ReturnType<typeof matchRequest>
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    found = matchRequest(
      request.method,
      url.pathname.replace(/^\/api\/runner-settings(?=\/)/, '/api/v1'),
    )
  } catch (e) {
    if (e instanceof URIError || (e instanceof ApiError && e.status === 400))
      return fail(400, 'Malformed percent-encoding')
    throw e
  }
  let owner =
      found?.params.org ??
      found?.params.owner ??
      (found?.route.id.startsWith('userPool') ? found.params.name : undefined),
    repo = found?.params.repo,
    ownerAt = -1,
    repoAt = -1
  if (owner) {
    ownerAt = parts.indexOf(owner)
    if (repo) repoAt = parts.lastIndexOf(repo)
  } else if (parts[0] === 'git') {
    owner = parts[1]
    repo = parts[2]?.replace(/\.git$/, '')
    ownerAt = 1
    repoAt = 2
  } else if (parts[0] === 'orgs') {
    owner = parts[1]
    ownerAt = 1
  } else if (
    parts[0] &&
    !RESERVED_NAMES.includes(parts[0]) &&
    !parts[0].includes('.')
  ) {
    owner = parts[0]
    repo = parts[1]?.replace(/\.git$/, '')
    ownerAt = 0
    repoAt = 1
  }
  const settings =
    url.pathname.includes('/settings') ||
    /^\/(keys|runners)(\/|$)/.test(url.pathname)
  const git = /\/(?:info\/refs|git-(?:upload|receive)-pack)$/.test(url.pathname)
  const mutable = git
    ? url.pathname.endsWith('/git-receive-pack') ||
      url.searchParams.get('service') === 'git-receive-pack'
    : !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  const runnerRead =
    found &&
    ['runnerPoll', 'runnerHeartbeat', 'orgPoolPoll', 'userPoolPoll'].includes(
      found.route.id,
    )
  const lifecycle =
    found && /^(rename|archive|delete|restore)(Org|Repo)$/.test(found.route.id)
  let lease: string | null = null,
    banner = ''
  // Bearer/Basic calls authenticate independently and never fall back to cookies.
  // SETTINGS_CSRF_GUARD: gate before parsing bodies or touching lifecycle state.
  if (
    url.pathname.startsWith('/api/') &&
    !request.headers.has('authorization') &&
    /(?:^|;\s*)gild_session=/.test(request.headers.get('cookie') ?? '') &&
    !csrfSafe(request)
  )
    return fail(403, 'Cross-site mutation refused')
  if (owner) {
    const canonicalOwner = await st.settings.canonical(owner)
    const originalKey = repo ? `${owner}/${repo}` : owner
    const canonicalKey = repo
      ? await st.settings.canonical(
          (await st.settings.canonical(originalKey)) === originalKey
            ? `${canonicalOwner}/${repo}`
            : await st.settings.canonical(originalKey),
        )
      : canonicalOwner
    const [nextOwner, nextRepo] = canonicalKey.split('/')
    if (nextOwner !== owner || (repo && nextRepo !== repo)) {
      parts[ownerAt] = nextOwner
      if (repo)
        parts[repoAt] =
          nextRepo + (parts[repoAt].endsWith('.git') ? '.git' : '')
      url.pathname = '/' + parts.map(encodeURIComponent).join('/')
      return new Response(null, {
        status: 308,
        headers: { location: url.toString(), 'cache-control': 'no-store' },
      })
    }
    const org = await st.settings.state(owner),
      item = repo ? await st.settings.state(originalKey) : org
    if (item.id.startsWith('reserve:') || org.id.startsWith('reserve:'))
      return fail(404, 'Not Found')
    if ((item.deletedAt !== null || org.deletedAt !== null) && !lifecycle)
      return fail(404, 'Not Found')
    if (org.archived || item.archived)
      banner = org.archived
        ? 'This organization is archived. Its repositories are read-only.'
        : 'This repository is archived and read-only.'
    if (mutable && !lifecycle && !runnerRead) {
      lease = await st.settings.lease(originalKey)
      if (!lease)
        return fail(409, 'This repository or organization is read-only')
    }
  }
  const headers = new Headers(request.headers)
  headers.delete('x-gild-browser-proof-origin')
  if (/^\/api\/(?:auth\/(?:challenge|status|signout)|claim\/(?:prepare|status))$/.test(url.pathname))
    headers.set('x-gild-browser-proof-origin', url.origin)
  headers.delete('x-gild-archive')
  // OpenNext rebuilds the route Request URL. Record intent at the original
  // Worker boundary, stripping any caller-supplied marker first.
  headers.delete('x-gild-browser-intent')
  if (
    !request.headers.has('authorization') &&
    /(?:^|;\s*)gild_session=/.test(request.headers.get('cookie') ?? '') &&
    csrfSafe(request)
  )
    headers.set('x-gild-browser-intent', 'same-origin')
  if (banner) headers.set('x-gild-archive', banner)
  try {
    const response = await forward(new Request(request, { headers }))
    if (response.status!==101 && (settings || banner)) {
      const out = new Response(response.body, response)
      out.headers.set('cache-control', 'no-store')
      return out
    }
    return response
  } finally {
    if (lease) await st.settings.release(lease)
  }
}
