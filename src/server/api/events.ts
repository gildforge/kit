import type { Context, Result } from './dispatch.js'
import { paginate } from './dispatch.js'
import { ApiError } from '../../engine/api/errors.js'
import { eventPage, type HookInput, type HookPatch } from '../../engine/api/events-contract.js'
import type { Hub } from '../events/emit.js'
export function eventHandler(
  getHub: () => Promise<Hub>,
  repositories: (c: Context) => Promise<string[]>,
) {
  return async (c: Context): Promise<Result> => {
    c.privateRead=true // Streams and hook deliveries can carry private payloads.
    const hub = await getHub(),
      id = c.route.id,
      origin = new URL(c.request.url).origin
    if (id === 'events') {
      const repos = await repositories(c),
        since =
          c.query.since ??
          c.request.headers.get('last-event-id') ??
          (await hub.sequence()),
        page = eventPage.parse(
          await hub.read(
            repos,
            since,
            c.principal.name,
            c.query.wait,
            c.principal.repos === null,
          ),
        )
      if (c.request.headers.get('accept')?.includes('text/event-stream')) {
        const body =
          page.events
            .map(
              (e) =>
                `id: ${e.cursor}\nevent: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`,
            )
            .join('') +
          `id: ${page.cursor}\nevent: cursor\ndata: ${JSON.stringify({ cursor: page.cursor })}\n\n`
        return {
          data: page,
          response: new Response(body, {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
            },
          }),
        }
      }
      return { data: page }
    }
    const scope = c.params.org
        ? `org:${c.params.org}`
        : `repo:${c.params.owner}/${c.params.repo}`,
      hook = Number(c.params.hook)
    try {
      if (id.endsWith('Hooks'))
        return paginate(await hub.list(scope, origin), c)
      if (id.endsWith('CreateHook'))
        return {
          data: await hub.create(
            scope,
            c.body as HookInput,
            origin,
            c.principal.name,
          ),
        }
      if (id.endsWith('UpdateHook'))
        return {
          data: await hub.patch(scope, hook, c.body as HookPatch, origin),
        }
      if (id.endsWith('DeleteHook'))
        return { data: await hub.remove(scope, hook) }
      if (id.endsWith('HookDeliveries'))
        return paginate(await hub.deliveries(scope, hook), c)
      if (id.endsWith('HookDelivery'))
        return {
          data: await hub.delivery(scope, hook, Number(c.params.delivery)),
        }
      if (id.endsWith('RedeliverHook'))
        return {
          data: await hub.redeliver(scope, hook, Number(c.params.delivery)),
        }
      if (id.endsWith('PingHook'))
        return { data: await hub.ping(scope, hook, origin) }
      if (id.endsWith('Hook'))
        return { data: await hub.get(scope, hook, origin) }
    } catch (e) {
      if (e instanceof ApiError || (e as { status?: number }).status) throw e
      const message = (e as Error).message
      if (/Hook URLs|Hook destination|Hooks use|DNS must/.test(message))
        throw new ApiError(422, message)
      throw e
    }
    throw new ApiError(404, 'Event endpoint not found')
  }
}
