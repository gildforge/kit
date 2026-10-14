import { repoIndex } from '../repo-index.js'
import { store } from '../backend.js'
import { session } from '../session.js'
import { readSessionReceipts } from './read-access.js'
/** Viewer access is checked before reading mutable receipt collections. */
export async function sessionsFor(owner: string, repo: string, target: string) {
  return readSessionReceipts({store: await store(), index: repoIndex}, owner, repo, target, (await session())?.name ?? null)
}
