import { cache } from 'react'
import { getCloudflareContext } from '../context.js'
import { store } from '../backend.js'
import type { RunnerPool } from './pool-do.js'
export type PoolStub = {
  [
    K in
      | 'reserveImport'
      | 'candidate'
      | 'completed'
      | 'recent'
      | 'init'
      | 'overview'
      | 'groups'
      | 'group'
      | 'saveGroup'
      | 'removeGroup'
      | 'register'
      | 'registration'
      | 'authenticate'
      | 'poll'
      | 'touch'
      | 'remove'
      | 'patch'
  ]: (
    ...a: Parameters<RunnerPool[K]>
  ) => Promise<Awaited<ReturnType<RunnerPool[K]>>>
}
export const runnerPool = cache(
  async (owner: string, kind?: 'org' | 'user'): Promise<PoolStub> => {
    const st = await store(),
      org = await st.getOrg(owner),
      claim = await st.getClaim(owner)
    if (
      kind === 'org' ? !org : kind === 'user' ? !claim || !!org : !org && !claim
    )
      throw Object.assign(Error('Owner not found'), { status: 404 })
    const { env } = await getCloudflareContext(),
      ns = (
        env as unknown as {
          RUNNER_POOL: {
            idFromName(name: string): unknown
            get(id: unknown): PoolStub
          }
        }
      ).RUNNER_POOL
    const pool = ns.get(
      ns.idFromName((await st.settings.state(owner.toLowerCase())).id),
    )
    await pool.init(owner.toLowerCase())
    return pool
  },
)
