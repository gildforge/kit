import { jobLogs } from '../../engine/actions/logs.js'
import type { ActionDependencies } from './api-types.js'
import { deleteSecret, putSecret, secretNames } from './secrets.js'
export interface ActionParams {
  owner: string
  repo: string
  path?: string[]
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
/** Both Next and the local Worker harness invoke this exact protocol handler.
 * The harness injects auth/storage, never bypasses the production route logic. */
export async function actionsAPI(
  request: Request,
  p: ActionParams,
  deps: ActionDependencies,
) {
  try {
    const [area, id, op, jobId, jobOp, ...extra] = p.path ?? [],
      q = await deps.runQueue(p.owner, p.repo)
    if (
      area === 'runners' &&
      request.method === 'POST' &&
      ['poll', 'heartbeat', 'logs', 'step', 'finish'].includes(id)
    ) {
      const token =
        request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? ''
      if (!token.startsWith('gr_') && !token.startsWith('gc_'))
        return json({ error: 'repo-scoped runner token required' }, 401)
      await q.readRepo(token)
      const b = await body(request)
      if (id === 'poll')
        return json({
          job: await q.poll(
            token,
            typeof b.wait === 'number' && b.wait >= 0 && b.wait <= 20000
              ? b.wait
              : 20000,
          ),
        })
      if (id === 'heartbeat')
        return json(await q.heartbeat(token, b.job ?? null, b.lease ?? null))
      if (id === 'logs') await q.append(token, b)
      if (id === 'step') await q.step(token, b)
      if (id === 'finish') await q.finish(token, b)
      return json({ ok: true })
    }
    if (
      request.method === 'GET' &&
      area === 'commits' &&
      /^[a-f0-9]{40}$/.test(id)
    )
      return json(await q.commitRuns(id))
    if (request.method === 'GET' && !area) return json(await q.overview())
    if (request.method === 'GET' && area === 'runs') {
      const n = number(id)
      if (op === 'jobs' && jobOp === 'logs' && !extra.length) {
        const detail = await q.detail(n),
          job = detail?.jobs.find((j) => j.id === number(jobId))
        return job
          ? json({ logs: await jobLogs(q, job) })
          : json({ error: 'job not found' }, 404)
      }
      if (jobId !== undefined || (op !== undefined && op !== 'logs'))
        return json({ error: 'unknown Actions operation' }, 404)
      if (op === 'logs') {
        const u = new URL(request.url),
          job = number(u.searchParams.get('job') ?? ''),
          step = Number(u.searchParams.get('step')),
          after = Number(u.searchParams.get('after') ?? '-1')
        const detail = await q.detail(n)
        if (
          !detail?.jobs.some(
            (j) => j.id === job && j.steps.some((s) => s.position === step),
          ) ||
          !Number.isInteger(step) ||
          step < 0 ||
          !Number.isInteger(after)
        )
          return json({ error: 'unknown job or step' }, 404)
        return json({ chunks: await q.logs(job, step, after) })
      }
      const detail = await q.detail(n)
      return detail ? json(detail) : json({ error: 'run not found' }, 404)
    }
    const by = await deps.caller(request)
    if (!by) return json({ error: 'sign in or send a gild API token' }, 401)
    const can = await deps.capabilities(p.owner, p.repo, by)
    if (area === 'runners' && !id && request.method === 'POST') {
      if (!can.writer)
        return json(
          { error: 'repo owner or org admin required to register a machine' },
          403,
        )
      return json(await q.register(by, await body(request)), 201)
    }
    if (area === 'runners' && id && request.method === 'DELETE') {
      const runner = (await q.overview()).runners.find((r) => r.id === id)
      if (
        !runner ||
        (!can.writer && (runner.owner !== by || !can.grants.has('pr')))
      )
        return json(
          { error: 'only a repo writer or this runner owner may remove it' },
          403,
        )
      await q.remove(id)
      return json({ ok: true })
    }
    if (!can.writer)
      return json({ error: 'repo owner or org admin required' }, 403)
    if (area === 'secrets') {
      const env = await deps.actionEnv(),
        repo = `${p.owner}/${p.repo}`.toLowerCase()
      if (request.method === 'GET')
        return json({ secrets: await secretNames(env, repo) })
      if (request.method === 'PUT' && id) {
        const b = await body(request)
        await putSecret(env, repo, id, b.value)
        return json({ ok: true })
      }
      if (request.method === 'DELETE' && id) {
        await deleteSecret(env, repo, id)
        return json({ ok: true })
      }
    }
    if (area === 'settings' && request.method === 'PUT') {
      const { required } = await body(request)
      if (
        !Array.isArray(required) ||
        required.length > 64 ||
        required.some(
          (s) => typeof s !== 'string' || !/^[\w.-]+\.ya?ml$/.test(s),
        )
      )
        return json(
          { error: 'required must be a list of workflow filenames' },
          400,
        )
      return json({ required: await q.required(required) })
    }
    if (area === 'dispatch' && request.method === 'POST') {
      const b = await body(request)
      return json(
        { id: await deps.dispatch(p.owner, p.repo, b.file, b.ref, by) },
        201,
      )
    }
    if (area === 'runs' && request.method === 'POST') {
      if (op === 'rerun')
        return json({ id: await q.rerun(number(id), by) }, 201)
      if(op==='approve'){await q.approve(number(id),by);return json({ok:true})}
      if (op === 'cancel') {
        await q.cancel(number(id))
        return json({ ok: true })
      }
    }
    return json({ error: 'unknown Actions operation' }, 404)
  } catch (e) {
    const message = (e as Error).message
    return json(
      { error: message.startsWith('Needs Sami:') ? message : message },
      message.includes('runner token') ? 401 : 400,
    )
  }
}
async function body(request: Request): Promise<any> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('JSON body required')
  const parts: Uint8Array[] = [],
    limit = 256 * 1024
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.length
    if (size > limit) {
      await reader.cancel()
      throw new Error('request exceeds 256 KiB')
    }
    parts.push(next.value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    all.set(part, offset)
    offset += part.length
  }
  return JSON.parse(new TextDecoder().decode(all))
}
function number(s: string) {
  const n = Number(s)
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n <= 0)
    throw new Error('invalid run or job number')
  return n
}
