import { entity } from './settings-store.js'
import { repoNameAvailable } from '../engine/backend-names.js'
import { createRepo } from './artifacts.js'
import { initMeta } from './meta.js'
import { store } from './backend.js'
import { scheduleIndex } from './repo-index.js'
import { ApiError } from '../engine/api/errors.js'
export async function createRepository(
  by: string,
  owner: string,
  name: string,
  description?: string,
  privateRepo = false,
  seedCode = true,
) {
  if (by.includes('/'))
    throw new ApiError(403, 'Agents cannot create repositories')
  if (!repoNameAvailable(name))
    throw new ApiError(422, 'Invalid repository name')
  const st = await store(),
    org = await st.getOrg(owner)
  if (
    owner !== by &&
    (!org || !['owner', 'admin'].includes((await st.orgRole(owner, by)) ?? ''))
  )
    throw new ApiError(403, 'Repository owner or organization admin required')
  if (
    (await st.settings.state(owner)).archived ||
    (await st.settings.state(owner)).moving ||
    (await st.settings.state(owner)).deletedAt !== null
  )
    throw new ApiError(409, 'Organization is read-only')
  if (await st.settings.reserved(`${owner}/${name}`))
    throw new ApiError(409, 'Repository name is reserved')
  const key = `${owner}/${name}`
  await st.settings.reserve(key)
  let repo
  try {
    // Artifacts rejects _meta as a default branch. Imports leave main unborn;
    // the source's default is selected when the import finishes.
    repo = await createRepo(owner, name, description, 'main')
    await st.fenceRepoAccess(key,null)
    await initMeta(owner, repo.name, org ? 'org' : 'user',privateRepo,seedCode)
    // Publish without releasing the destination reservation between writes.
    await st.settings.putState({
      ...entity(key),
      description: description ?? null,
    })
  } finally {
    await st.settings.unreserve(key)
  }
  await scheduleIndex(owner, repo.name)
  return repo
}
