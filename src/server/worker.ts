// gild's own Worker entry: the API, git smart HTTP, sign-in and the Durable
// Objects, without Next. A desktop install deploys this; gild.gg mounts the
// same handlers in its Next app (app/api/*, app/git/*).
import { ROUTES } from './routes/index.js'
import * as clone from './routes/clone.js'
import { runWithCloudflareContext, type CloudflareContext } from './context.js'
import { runWithRequest } from './request.js'
import { scheduledJobs, queueJobs } from './jobs.js'
import { rememberAccount } from './account.js'
import { instanceHome } from './instance-home.js'
import type { MessageBatch } from '@cloudflare/workers-types'
// Workers can't compile WebAssembly from bytes at run time: the bundler
// compiles cqx's core module here and the scorer picks it up from globalThis.
import cqxWasm from '../../cqx/core.wasm'

globalThis.__cqxWasm = cqxWasm

type Handler = (request: Request, context: { params: Promise<Record<string, string | string[] | undefined>> }) => Response | Promise<Response>
interface Route { pattern: RegExp; names: { name: string; rest: boolean }[]; handler: Record<string, unknown> }

/** Next's file-route segments: [x] one segment, [...x] one or more, [[...x]] zero or more. */
function compile(path: string, handler: Record<string, unknown>): Route {
  const names: Route['names'] = []
  let source = ''
  for (const segment of path.split('/').filter(Boolean)) {
    const optional = segment.match(/^\[\[\.\.\.(\w+)\]\]$/), rest = segment.match(/^\[\.\.\.(\w+)\]$/), one = segment.match(/^\[(\w+)\]$/)
    if (optional) { names.push({ name: optional[1], rest: true }); source += '(?:/(.*))?' }
    else if (rest) { names.push({ name: rest[1], rest: true }); source += '/(.+)' }
    else if (one) { names.push({ name: one[1], rest: false }); source += '/([^/]+)' }
    else source += '/' + segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return { pattern: new RegExp('^' + source + '/?$'), names, handler }
}

// Fixed paths first, then fewer parameters, so /api/repos/new never reads as /api/repos/[owner].
const routes = [...ROUTES.map(r => compile(r.path, r.handler)), compile('/[owner]/[repo]/[...path]', clone)]
  .sort((a, b) => a.names.length - b.names.length || b.pattern.source.length - a.pattern.source.length)

export function match(pathname: string, method: string): { handler: Handler; params: Record<string, string | string[] | undefined> } | null {
  for (const route of routes) {
    const found = route.pattern.exec(pathname)
    if (!found) continue
    const handler = route.handler[method] ?? (method === 'HEAD' ? route.handler.GET : undefined)
    if (typeof handler !== 'function') continue
    const params: Record<string, string | string[] | undefined> = {}
    route.names.forEach(({ name, rest }, i) => {
      const value = found[i + 1]
      params[name] = rest ? (value === undefined ? undefined : value.split('/').map(decodeURIComponent)) : decodeURIComponent(value)
    })
    return { handler: handler as Handler, params }
  }
  return null
}

/** Answer one request with its bindings and request in context. */
export function answer(request: Request, env: CloudflareContext['env'], ctx: CloudflareContext['ctx']): Promise<Response> {
  rememberAccount(env)
  return runWithCloudflareContext({ env, ctx }, () => runWithRequest(request, async () => {
    const { pathname } = new URL(request.url)
    if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) return instanceHome(request)
    const found = match(pathname, request.method)
    if (!found) return Response.json({ message: 'Not Found' }, { status: 404 })
    return found.handler(request, { params: Promise.resolve(found.params) })
  }))
}

export default {
  fetch: answer,
  scheduled(event: { scheduledTime?: number }, env: CloudflareContext['env'], ctx: CloudflareContext['ctx']) {
    rememberAccount(env)
    return runWithCloudflareContext({ env, ctx }, () => scheduledJobs(event, env))
  },
  async queue(batch: MessageBatch<unknown>, env: CloudflareContext['env'], ctx: CloudflareContext['ctx']) {
    rememberAccount(env)
    await runWithCloudflareContext({ env, ctx }, () => queueJobs(batch, env))
  },
}

// Each Durable Object learns the account from its own bindings, since its
// isolate may never see a request through the entry above.
import { RepoIndex as RepoIndexBase } from './repo-index-do.js'
import { RunQueue as RunQueueBase } from './actions/queue-do.js'
import { ForgeEvents as ForgeEventsBase } from './events/hub-do.js'
import { ApiControl as ApiControlBase } from './api/control-do.js'
import { SettingsRename as SettingsRenameBase } from './settings-rename-do.js'
import { RunnerPool as RunnerPoolBase } from './actions/pool-do.js'
import { RepoImport as RepoImportBase } from './import/do.js'
import { RepoChannel as RepoChannelBase } from './channel/do.js'
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each class names its own state and env types
type Constructor = abstract new (...args: any[]) => object
function knowsAccount<C extends Constructor>(Base: C): C {
  abstract class Bound extends Base {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) { rememberAccount(args[1]); super(args[0], args[1]) }
  }
  return Bound
}
export const RepoIndex = knowsAccount(RepoIndexBase)
export const RunQueue = knowsAccount(RunQueueBase)
export const ForgeEvents = knowsAccount(ForgeEventsBase)
export const ApiControl = knowsAccount(ApiControlBase)
export const SettingsRename = knowsAccount(SettingsRenameBase)
export const RunnerPool = knowsAccount(RunnerPoolBase)
export const RepoImport = knowsAccount(RepoImportBase)
export const RepoChannel = knowsAccount(RepoChannelBase)
