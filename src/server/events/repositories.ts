import type { Context } from '../api/dispatch.js'
import { permitsRepo, hasScope } from '../../engine/api/scopes.js'
import { ApiError } from '../../engine/api/errors.js'
export async function eventRepositories(c: Context, catalog: () => Promise<string[]>, read: (owner: string, repo: string, viewer: string) => Promise<boolean>) {
  const requested = c.query.repos?.split(',').filter(Boolean) as string[] | undefined
  const candidates = requested ?? c.principal.repos ?? await catalog()
  const allowed: string[] = []
  for (const r of candidates) {
    const [owner, repo] = r.split('/')
    const permitted = hasScope(c.principal,'repo:read') && /^[-a-z0-9]+\/[-a-z0-9._]+$/i.test(r) && permitsRepo(c.principal, owner, repo) && await read(owner, repo, c.principal.name)
    if (!permitted && requested) throw new ApiError(404, 'Event repository is not readable by this caller')
    if (permitted) allowed.push(r)
  }
  return allowed
}
