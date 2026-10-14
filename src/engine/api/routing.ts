import { routes, type Route } from './contract.js'
import { ApiError } from './errors.js'
import { hasScope, permitsRepo, type Principal } from './scopes.js'
function decodeParam(value: string) {
  try { return decodeURIComponent(value) } catch { throw new ApiError(400, 'Malformed percent-encoding') }
}
function pattern(path: string) {
  return new RegExp(
    '^' +
      path
        .split(/(\{\w+\})/)
        .map((p) =>
          p.startsWith('{')
            ? p === '{path}' || p === '{ref}'
              ? '(.+)'
              : '([^/]+)'
            : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('') +
      '/?$',
  )
}
export function match(method: string, path: string) {
  try { decodeURI(path) } catch { throw new ApiError(400, 'Malformed percent-encoding') }
  for (const route of routes) {
    if (route.method !== method) continue
    const m = pattern(route.path).exec(path)
    if (m)
      return {
        route,
        params: Object.fromEntries(
          [...route.path.matchAll(/\{(\w+)\}/g)].map((p, i) => [
            p[1],
            decodeParam(m[i + 1]),
          ]),
        ),
      }
  }
  return null
}

// Legacy aliases identify operations, never permissions inferred from names.
export function matchRequest(method: string, path: string) {
  if (path.startsWith('/api/v1/')) return match(method, path.slice(7))
  if (!path.startsWith('/api/')) return null
  let canonical = path.slice(4), verb = method
  canonical=canonical.replace(/^\/account\/profile$/, '/user/profile').replace(/^\/account\/picture$/, '/user/picture').replace(/^\/account\/tokens/, '/user/tokens').replace(/^\/account\/orgs\//, '/user/memberships/orgs/')
  if(canonical==='/search')canonical='/search/code'
  canonical=canonical.replace(/^\/account\/invitations/, '/user/repository_invitations')
  if (canonical === '/repos') canonical = '/user/repos'
  if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/(issues|pulls)\/[^/]+\/?$/.test(canonical)) verb = 'PATCH'
  if (method === 'POST' && /^\/agents\/requests\/[^/]+\/?$/.test(canonical)) verb = 'PATCH'
  if (method === 'POST' && /^\/agents\/[^/]+\/?$/.test(canonical)) verb = 'PATCH'
  canonical = canonical.replace(/(\/actions)\/secrets(?=\/|$)/, '$1/settings/secrets')
  if (method === 'POST') canonical = canonical.replace(/\/actions\/dispatch\/?$/, '/actions/workflows/legacy/dispatches')
  canonical = canonical.replace(/\/pulls\/([^/]+)\/diff\/?$/, '/pulls/$1/changes')
  canonical = canonical.replace(/\/tree\/?$/, '/git/trees/legacy')
  return match(verb, canonical)
}
export function permitsRequest(p: Principal, method: string, path: string) {
  const found = matchRequest(method, path)
  return !!found && (!found.route.scope || hasScope(p, found.route.scope)) &&
    (!found.params.owner || !found.params.repo || permitsRepo(p, found.params.owner, found.params.repo))
}
export function publicRead(route: Route) {
  return route.method === 'GET' && route.scope === 'repo:read' &&
    ((route.github && route.id !== 'repos') || ['ownerRepoCards','publicDisplayProfile','searchCode','importStatus','importPatch','channelMessages','channelParticipants','channelStream'].includes(route.id))
}
export async function anonymous(request: Request): Promise<Principal> {
  const ip = request.headers.get('cf-connecting-ip')?.trim()
  if (!ip) throw new ApiError(400, 'Cloudflare connecting IP is required for anonymous requests')
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  const id = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
  return { id: `anonymous:${id}`, name: '', publicKey: '', scopes: ['repo:read'], repos: null, anonymous: true }
}
