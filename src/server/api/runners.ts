import { runnerShape } from './runners-shape.js'
import type { Context, Result } from './dispatch.js'
import { ApiError } from '../../engine/api/errors.js'
import { numericId } from './shapes.js'
import type { PoolStub } from '../actions/pool-service.js'
export function runnerHandler(deps: {
  pool(owner: string, kind: 'org' | 'user'): Promise<PoolStub>
  mayWrite(owner: string, by: string): Promise<boolean>
}) {
  return async function apiRunners(c: Context): Promise<Result> {
    try {
      const owner = c.params.org ?? c.params.name,
        kind = c.params.org ? 'org' : 'user',
        pool = await deps.pool(owner, kind),
        b = c.body,
        id = c.route.id.replace(/^(org|user)Pool/, '')
      const token =
        c.request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? ''
      if (id === 'Poll') {
        if (!token.startsWith('gro_'))
          throw new ApiError(401, 'Owner runner token required')
        return { data: { job: await pool.poll(token, b.wait) } }
      }
      if (id === 'Register' && token.startsWith('grt_'))
        return { data: await pool.register('', b as never, b.group, token) }
      // Administration never inherits authority from a runner token, an agent or
      // a repo-restricted API token.
      if (
        c.principal.repos !== null ||
        c.principal.name.includes('/') ||
        !(await deps.mayWrite(owner, c.principal.name))
      )
        throw new ApiError(
          403,
          'Owner administrator with unrestricted token required',
        )
      const runnerId = c.params.runner
        ? ((await pool.overview()).runners.find(
            (r) =>
              r.id === c.params.runner ||
              String(numericId(r.id)) === c.params.runner,
          )?.id ?? c.params.runner)
        : ''
      if (id === 'Recent') return { data: { jobs: await pool.recent(runnerId) } }
      if (id === 'Runners') {
        const v = await pool.overview()
        return {
          data: {
            total_count: v.runners.length,
            runners: v.runners.map(runnerShape),
          },
        }
      }
      if (id === 'Registration') return { data: await pool.registration(b.group) }
      if (id === 'Register')
        return {
          data: await pool.register(c.principal.name, b as never, b.group),
        }
      if (id === 'Remove') {
        await pool.remove(runnerId)
        return { data: { ok: true } }
      }
      if (id === 'PatchRunner')
        return { data: runnerShape(await pool.patch(runnerId, b)) }
      if (id === 'Groups') {
        const groups = await pool.groups()
        return { data: { total_count: groups.length, runner_groups: groups } }
      }
      if (id === 'Group') return { data: await pool.group(c.params.group) }
      if (id === 'CreateGroup' || id === 'PatchGroup')
        return {
          data: await pool.saveGroup(
            b,
            id === 'PatchGroup' ? c.params.group : undefined,
          ),
        }
      if (id === 'DeleteGroup') {
        await pool.removeGroup(c.params.group)
        return { data: { ok: true } }
      }
      const g = await pool.group(c.params.group)
      if (id === 'Repositories') return { data: { repositories: g.repositories } }
      if (id === 'ClearRepositories') {
        await pool.saveGroup({ visibility: 'selected', repositories: [] }, g.id)
        return { data: { ok: true } }
      }
      if (id === 'PutRepositories') {
        await pool.saveGroup({ repositories: b.repositories }, g.id)
        return { data: { ok: true } }
      }
      const full = `${owner}/${c.params.repo}`.toLowerCase()
      if (id === 'AddRepository') {
        await pool.saveGroup(
          { repositories: [...new Set([...g.repositories, full])] },
          g.id,
        )
      } else if (id === 'RemoveRepository')
        await pool.saveGroup(
          { repositories: g.repositories.filter((r) => r !== full) },
          g.id,
        )
      else throw new ApiError(404, 'Not Found')
      return { data: { ok: true } }
    } catch (e) {
      if (e instanceof ApiError) throw e
      if ((e as { status?: number }).status === 422) throw new ApiError(422, (e as Error).message)
      const message = (e as Error).message
      if (/not found/.test(message)) throw new ApiError(404, message)
      if (/token/.test(message)) throw new ApiError(401, message)
      if (/already|cannot|still has/.test(message))
        throw new ApiError(409, message)
      throw e
    }
  }

}
export async function apiRunners(c: Context): Promise<Result> {
  const { runnerPool } = await import('../actions/pool-service.js')
  const { mayWrite } = await import('../access.js')
  return runnerHandler({ pool: runnerPool, mayWrite })(c)
}
