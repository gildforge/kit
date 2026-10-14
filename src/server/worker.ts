// gild's own Worker entry: the API, git smart HTTP, sign-in and the Durable
// Objects, without Next. A desktop install deploys this; gild.gg mounts the
// same handlers in its Next app (app/api/*, app/git/*).
import { ROUTES } from './routes/index.js'
import * as clone from './routes/clone.js'
import { runWithCloudflareContext, type CloudflareContext } from './context.js'
import { runWithRequest } from './request.js'
import { scheduledJobs, queueJobs } from './jobs.js'
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
  return runWithCloudflareContext({ env, ctx }, () => runWithRequest(request, async () => {
    const found = match(new URL(request.url).pathname, request.method)
    if (!found) return Response.json({ message: 'Not Found' }, { status: 404 })
    return found.handler(request, { params: Promise.resolve(found.params) })
  }))
}

export default {
  fetch: answer,
  scheduled(event: { scheduledTime?: number }, env: CloudflareContext['env'], ctx: CloudflareContext['ctx']) {
    return runWithCloudflareContext({ env, ctx }, () => scheduledJobs(event, env))
  },
  async queue(batch: MessageBatch<unknown>, env: CloudflareContext['env'], ctx: CloudflareContext['ctx']) {
    await runWithCloudflareContext({ env, ctx }, () => queueJobs(batch, env))
  },
}

export { RepoIndex } from './repo-index-do.js'
export { RunQueue } from './actions/queue-do.js'
export { ForgeEvents } from './events/hub-do.js'
export { ApiControl } from './api/control-do.js'
export { SettingsRename } from './settings-rename-do.js'
export { RunnerPool } from './actions/pool-do.js'
export { RepoImport } from './import/do.js'
export { RepoChannel } from './channel/do.js'
