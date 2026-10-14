import { whoIsCalling } from '../caller.js'
import { dependencies } from './production.js'
import { anonymous, publicRead } from '../../engine/api/routing.js'
import { digest } from './dispatch.js'
import { dispatch } from './dispatch.js'
import { routes, type Operation } from '../../engine/api/contract.js'
import { session } from '../session.js'
import { csrfSafe } from '../../engine/csrf.js'
import { readyIndex } from '../repo-index.js'
// Compatibility adapters change URL/body/envelope only. Auth, validation,
// permissions, reads and writes use the exact v1 handlers.
export async function legacy(
  request: Request,
  operation: Operation,
  params: Record<string, string>,
  body?: unknown,
) {
  const proofRequest = request.clone()
  let viewer = 'visitor'
  const route = routes.find((r) => r.id === operation)!,
    url = new URL(request.url)
  url.pathname =
    '/api/v1' + route.path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(params[key]))
  url.search = new URL(request.url).search
  url.searchParams.delete('hash')
  const headers = new Headers(request.headers)
  headers.delete('if-none-match')
  const payload =
    body ??
    (route.method !== 'GET'
      ? await request.json().catch(() => ({}))
      : undefined)
  const adapted = new Request(url, {
      method: route.method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    deps = await dependencies()
  const response = await dispatch(adapted, {
    ...deps,
    authenticate: async (r) => {
      if (r.headers.has('authorization')) {
        const p = await deps.authenticate(r)
        viewer = p?.name ?? 'visitor'
        return p
      }
      const s = await session()
      let name = s?.name,
        publicKey = s?.publicKey ?? ''
      if (route.method !== 'GET') {
        const caller = await whoIsCalling(proofRequest)
        if (!caller) return null
        name = caller.name
      } else if (!csrfSafe(request)) return null
      if (!name && ['orgs', 'agents', 'tokens'].includes(operation)) return null
      if (!name) return publicRead(route) ? anonymous(request) : null
      viewer = name
      return {
        id: `browser:${viewer}`,
        name: viewer,
        publicKey,
        scopes: null,
        repos: null,
      }
    },
  })
  if (response.status === 204) return response
  if (response.status === 304) return response
  // Patch downloads keep the v1 stream and attachment headers after the same
  // browser/session authentication; there is no JSON envelope to adapt.
  if (operation === 'importPatch' && response.ok) return response
  const data = await response.json()
  if (!response.ok)
    return Response.json(
      { ...data, error: data.message },
      { status: response.status, headers: response.headers },
    )
  let result: unknown = data
  if (operation === 'orgs') result = { me: viewer, orgs: data }
  if (operation === 'agents') result = { agents: data }
  if (operation === 'createOrg') result = { ok: true, name: data.name }
  if (operation === 'createRepository' || operation === 'createOrgRepository')
    result = { ok: true, name: data.name, owner: data.owner.login }
  if (
    [
      'issues',
      'pulls',
      'issue',
      'pull',
      'issueComments',
      'pullReviews',
      'pullComments',
    ].includes(operation)
  ) {
    const index = await readyIndex(params.owner, params.repo)
    if (!index)
      return Response.json(
        { error: 'Repository is indexing; retry shortly' },
        { status: 503 },
      )
    if (operation === 'issues' || operation === 'pulls') {
      const meta = JSON.parse(
        (await index.metaFile('.gild/index.json')) ??
          '{"issues":[],"pulls":[],"queue":[]}',
      )
      result =
        operation === 'issues'
          ? {
              issues: meta.issues.sort(
                (a: { number: number }, b: { number: number }) =>
                  b.number - a.number,
              ),
            }
          : {
              pulls: meta.pulls.sort(
                (a: { number: number }, b: { number: number }) =>
                  b.number - a.number,
              ),
              queue: meta.queue,
            }
    } else {
      const kind =
          operation.startsWith('issue') &&
          !new URL(request.url).pathname.includes('/pulls/')
            ? 'issue'
            : 'pr',
        found = await index.metaItem(Number(params.number), kind)
      if (!found) return Response.json({ error: 'Not found' }, { status: 404 })
      result =
        operation === 'issue'
          ? { issue: found.item, comments: found.comments, log: found.log }
          : operation === 'pull'
            ? {
                pull: found.item,
                comments: found.comments,
                reviews: found.reviews,
                log: found.log,
                queue: found.queue,
              }
            : operation === 'pullReviews'
              ? { reviews: found.reviews }
              : { comments: found.comments }
    }
  } else if (operation === 'tree')
    result = data.tree
      .map((e: { path: string; sha: string; type: string }) => ({
        name: e.path,
        hash: e.sha,
        type: e.type,
      }))
      .sort((a: { name: string; type: string }, b: typeof a) =>
        a.type === 'tree' && b.type !== 'tree'
          ? -1
          : a.type !== 'tree' && b.type === 'tree'
            ? 1
            : a.name.localeCompare(b.name),
      )
  else if (operation === 'pullChanges')
    result = {
      base: data.from,
      head: data.to,
      files: data.files,
      truncated: data.truncated,
      total: data.total,
    }
  else if (operation === 'updateIssue' || operation === 'updatePull')
    result = { ok: true }
  else if (operation === 'createIssue' || operation === 'createPull')
    result = { number: data.number }
  else if (operation === 'createIssueComment' || operation === 'createReview')
    result = { id: data.node_id ?? data.id }
  if (route.method === 'GET') {
    const etag = '"' + (await digest(JSON.stringify(result))) + '"'
    response.headers.set('etag', etag)
    if (request.headers.get('if-none-match') === etag)
      return new Response(null, { status: 304, headers: response.headers })
  }
  return Response.json(result, {
    status: response.status,
    headers: response.headers,
  })
}
