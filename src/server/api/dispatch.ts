import { type Route } from '../../engine/api/contract.js'
import { openapi } from '../../engine/api/openapi.js'
import { hasScope, permitsRepo, type Principal } from '../../engine/api/scopes.js'
import { ApiError, errorResponse } from '../../engine/api/errors.js'
import { accountGate } from '../accounts.js'
import type { ApiControl, SavedResponse } from './control-do.js'
import { withMetadataOperation, recoverableMetadataRoutes } from '../../engine/metadata-operation.js'
export interface Context {
  operationId?: string
  privateRead?: boolean
  request: Request
  route: Route
  params: Record<string, string>
  query: Record<string, any>
  body: Record<string, any>
  principal: Principal
}
export interface Result {
  response?: Response
  data: unknown
  status?: number
  headers?: Record<string, string>
  immutable?: boolean
  noStore?: boolean
}
export type Control = {
  [K in 'rate' | 'begin' | 'activate' | 'finish' | 'release']: (
    ...a: Parameters<ApiControl[K]>
  ) => ReturnType<ApiControl[K]> | Promise<Awaited<ReturnType<ApiControl[K]>>>
}
export interface Dependencies {
  readAccess?(principal:Principal,owner:string,repo:string,operation?:string,request?:Request):Promise<'public'|'private'>
  authenticate(request: Request): Promise<Principal | null>
  control(id: string): Promise<Control>
  authorize(context: Context): Promise<void>
  execute(context: Context): Promise<Result>
  /** Read a committed operation receipt; never repeat the side effect. */
  reconcile?(context: Context): Promise<Result | null>
  /** An owner's account status (lib/accounts.ts); unpaid and deleted
   *  accounts are refused writes. */
  account?(name: string): Promise<import('../accounts.js').Account>
}
export { match } from '../../engine/api/routing.js'
import { match, publicRead, anonymous } from '../../engine/api/routing.js'
export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
}
export async function dispatch(
  request: Request,
  deps: Dependencies,
): Promise<Response> {
  let control: Awaited<ReturnType<Dependencies['control']>> | undefined,
    key: string | undefined,
    started = false,
    executed = false,
    claim: string | undefined
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    vary: 'Authorization, Accept',
  }
  try {
    const url = new URL(request.url),
      found = match(request.method, url.pathname.replace(/^\/api\/v1/, ''))
    if (!found) throw new ApiError(404, 'Not Found')
    const { route, params } = found
    if (route.id === 'openapi')
      return Response.json(openapi(), {
        headers: { 'cache-control': 'public, max-age=300' },
      })
    const authenticated = await deps.authenticate(request)
    const principal =
      authenticated ??
      (!request.headers.has('authorization') && publicRead(route)
        ? await anonymous(request)
        : null)
    if (!principal)
      throw new ApiError(401, 'Requires authentication with a gild API token')
    control = await deps.control(principal.id)
    // The token's and the principal's limits are separate objects: ask both
    // at once rather than one after the other.
    const principalLimit = principal.anonymous ? null : (async () => {
      const identity = /^Bearer (?:gi|gr|gro|gc|grt)_/i.test(
        request.headers.get('authorization') ?? '',
      )
        ? `runner:${principal.id}`
        : principal.name.toLowerCase()
      return (await deps.control(`principal:${identity}`)).rate()
    })()
    const rates = [
      await control.rate(Date.now(), principal.anonymous ? 60 : 10000),
      ...(principalLimit ? [await principalLimit] : []),
    ]
    const rate = rates.reduce((a, b) => (b.remaining < a.remaining ? b : a))
    rate.allowed = rates.every((r) => r.allowed)
    Object.assign(headers, {
      'x-ratelimit-limit': String(rate.limit),
      'x-ratelimit-remaining': String(rate.remaining),
      'x-ratelimit-reset': String(rate.reset),
      'x-ratelimit-resource': 'core',
    })
    if (!rate.allowed) {
      headers['retry-after'] = String(
        Math.max(1, rate.reset - Math.floor(Date.now() / 1000)),
      )
      throw new ApiError(429, 'API rate limit exceeded')
    }
    const access = params.owner&&params.repo&&deps.readAccess ? await deps.readAccess(principal,params.owner,params.repo,route.id,request) : 'public'
    if(access==='private')headers['cache-control']='private, no-store'
    if (deps.account) {
      const refused = await accountGate(deps.account, principal, route, params, request.method)
      if (refused) throw new ApiError(refused.status, refused.message)
    }
    if (route.scope && !hasScope(principal, route.scope))
      throw new ApiError(403, `Requires ${route.scope} scope`)
    if (
      params.owner &&
      params.repo &&
      !permitsRepo(principal, params.owner, params.repo)
    )
      throw new ApiError(403, 'Repository is outside this token allow-list')
    const pathParams = route.params.safeParse(params)
    if (!pathParams.success) throw new ApiError(422, 'Invalid path parameters')
    const query = route.query.safeParse(Object.fromEntries(url.searchParams))
    if (!query.success) throw new ApiError(422, query.error.message)
    let body: unknown = {}
    if (request.method !== 'GET') {
      const raw = await request.text()
      if (new TextEncoder().encode(raw).length > 256 * 1024)
        throw new ApiError(413, 'Request exceeds 256 KiB')
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        throw new ApiError(400, 'Invalid JSON')
      }
    }
    const input = route.input.safeParse(body)
    if (!input.success) throw new ApiError(422, input.error.message)
    const context: Context = {
      request,
      route,
      params,
      query: query.data,
      body: input.data,
      principal,
      privateRead:access==='private',
    }
    await deps.authorize(context)
    if(context.privateRead)headers['cache-control']='private, no-store'
    const idempotency = request.headers.get('idempotency-key')
    let recovered: Result | null = null
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      idempotency
    ) {
      if (idempotency.length > 200)
        throw new ApiError(422, 'Idempotency-Key exceeds 200 characters')
      key = await digest(`${route.id}:${JSON.stringify(params)}:${idempotency}`)
      const fingerprint = await digest(JSON.stringify(input.data))
      context.operationId = await digest(`${principal.id}:${key}:${fingerprint}`)
      const state = await control.begin(
        key,
        fingerprint,
      )
      if (state.kind === 'conflict')
        throw new ApiError(409, 'Idempotency-Key was used with different input')
      if (state.kind === 'pending') {
        recovered = state.claim ? await deps.reconcile?.(context) ?? null : null
        if (!recovered) {
          headers['retry-after'] = '1'
          throw new ApiError(409, 'An operation with this Idempotency-Key has an unresolved outcome; retry to reconcile')
        }
        claim = state.claim
        started = true
        headers['idempotency-reconciled'] = 'true'
      }
      if (state.kind === 'replay')
        return new Response(state.response.status === 204 ? null : state.response.body, {
          status: state.response.status,
          headers: {
            ...state.response.headers,
            ...headers,
            'idempotency-replayed': 'true',
          },
        })
      if (state.kind === 'new') {
        claim = state.claim
        if (!(await control.activate(key, claim)))
          throw new ApiError(409, 'Idempotency lease expired; retry')
        started = true
        // A completed response may have aged out while its immutable receipt
        // remains. Recover it before allowing the create handler to run again.
        recovered = await deps.reconcile?.(context) ?? null
        if (recovered) headers['idempotency-reconciled'] = 'true'
      }
    }
    // Once the handler starts, an exception is not proof that nothing committed.
    executed = true
    const result = recovered ?? await withMetadataOperation(recoverableMetadataRoutes.has(route.id) ? context.operationId : undefined, () => deps.execute(context))
    const valid = route.output.safeParse(result.data)
    if (!valid.success)
      throw new ApiError(500, `Response contract violation: ${route.id}`)
    Object.assign(headers, result.headers)
    if(context.privateRead)headers['cache-control']='private, no-store'
    if (result.response) {
      if (result.response.status === 101) {
        return new Response(null, {status:101,headers:{...Object.fromEntries(result.response.headers),...headers},webSocket:(result.response as unknown as {webSocket:unknown}).webSocket} as ResponseInit)
      }
      for (const [key, value] of Object.entries(headers))
        result.response.headers.set(key, value)
      return result.response
    }
    const status = result.status ?? route.status,
      serialized = status === 204 ? '' : JSON.stringify(valid.data)
    if (request.method === 'GET' && !result.noStore && !context.privateRead) {
      const etag = '"' + (await digest(serialized)) + '"'
      headers.etag = etag
      headers['cache-control'] =
        route.cache === 'no-store'
          ? 'no-store'
          : result.immutable
            ? 'private, max-age=31536000, immutable'
            : 'private, no-cache'
      if (
        request.headers
          .get('if-none-match')
          ?.split(',')
          .some(
            (t) => t.trim().replace(/^W\//, '') === etag || t.trim() === '*',
          )
      )
        return new Response(null, { status: 304, headers })
    }
    if (status !== 204) headers['content-type'] = 'application/json; charset=utf-8'
    if (key && started) {
      // Minted secrets are shown once, never persisted in idempotency storage.
      const saved: SavedResponse = [
        'importClaim', 'importUserPoll', 'importOrgPoll', 'importCredentials',
        'createToken',
        'createChildAgent',
        'actionRegister',
        'actionRegistration',
        'orgPoolRegister',
        'userPoolRegister',
        'orgPoolRegistration',
        'userPoolRegistration',
      ].includes(route.id)
        ? {
            status: 409,
            body: JSON.stringify({
              message: 'Token already created; the secret was returned once',
              documentation_url: '/docs/api',
            }),
            headers,
          }
        : { status, body: serialized, headers }
      await control.finish(key, claim!, saved)
    }
    return new Response(status === 204 ? null : serialized, { status, headers })
  } catch (e) {
    // Only failures BEFORE execution may release a claim. Uncertain writes are
    // retained and resolved from a durable receipt, never retried blindly.
    if (key && started && !executed && control)
      await control.release(key, claim!)
    // Expected failures carry a status; anything else is a bug worth a log line.
    if (!(e instanceof ApiError) && !(e as { status?: number }).status)
      console.error('api: unexpected error', request.method, new URL(request.url).pathname, e instanceof Error ? e.stack ?? e.message : e)
    const response = errorResponse(
      e instanceof ApiError
        ? e.status
        : Number((e as { status?: number }).status) || 500,
      e instanceof ApiError || (e as { status?: number }).status
        ? (e as Error).message
        : 'Internal server error',
      e instanceof ApiError && e.code ? [{message:e.message,code:e.code}] : undefined,
    )
    for (const [name, value] of Object.entries(headers))
      response.headers.set(name, value)
    return response
  }
}
export function paginationOffset(context: Context) {
  const { per_page = 30, page = 1, cursor } = context.query
  let offset = (page - 1) * per_page
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString())
      if (
        parsed.route !== context.route.id ||
        parsed.repo !== `${context.params.owner}/${context.params.repo}` ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0
      )
        throw Error()
      offset = parsed.offset
    } catch {
      throw new ApiError(422, 'Invalid cursor')
    }
  }
  return offset
}
export function paginate<T>(
  items: T[],
  context: Context,
  total = items.length,
  alreadyPaged = false,
): { data: T[]; headers: Record<string, string> } {
  const per_page = context.query.per_page ?? 30,
    offset = paginationOffset(context)
  const next = new URL(context.request.url),
    links: string[] = []
  if (offset + per_page < total) {
    next.searchParams.delete('page')
    next.searchParams.set(
      'cursor',
      Buffer.from(
        JSON.stringify({
          route: context.route.id,
          repo: `${context.params.owner}/${context.params.repo}`,
          offset: offset + per_page,
        }),
      ).toString('base64url'),
    )
    links.push(`<${next}>; rel="next"`)
  }
  if (offset > 0) {
    const prev = new URL(context.request.url)
    prev.searchParams.delete('cursor')
    prev.searchParams.set(
      'page',
      String(Math.max(1, Math.ceil(offset / per_page))),
    )
    links.push(`<${prev}>; rel="prev"`)
  }
  return {
    data: alreadyPaged ? items : items.slice(offset, offset + per_page),
    headers: links.length ? { link: links.join(', ') } : {},
  }
}
