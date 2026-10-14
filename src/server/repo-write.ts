import { store, type ForgeStore } from './backend.js'
import { ApiError } from '../engine/api/errors.js'
/** Background forge writes use the same fence as HTTP, so lifecycle operations
 * drain them before copying, archiving, or deleting a repository. */
export async function repoWrite<T>(
  owner: string,
  repo: string,
  work: () => Promise<T>,
  suppliedStore?: ForgeStore,
): Promise<T> {
  const st = suppliedStore ?? await store(),
    lease = await st.settings.lease(`${owner}/${repo}`)
  if (!lease) throw new ApiError(409, 'Repository is read-only')
  const timer=setInterval(()=>{void st.settings.renew(lease).catch(()=>{})},60000)
  try {
    return await work()
  } finally {
    clearInterval(timer)
    await st.settings.release(lease)
  }
}
