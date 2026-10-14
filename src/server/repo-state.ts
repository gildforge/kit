import type { ForgeStore } from './backend.js'
// Repository names retain their case. Resolve aliases before reading the stable
// entity id shared by stars and immutable summaries (including after a rename).
export async function repoState(
  store: Pick<ForgeStore, 'settings'>,
  owner: string,
  repo: string,
) {
  const key = await store.settings.canonical(`${owner.toLowerCase()}/${repo}`)
  return store.settings.state(key)
}
