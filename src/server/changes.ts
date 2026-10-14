export type { Change } from '../engine/types.js'
import type { Change } from '../engine/types.js'
// Diff facts are prepared once by RepoIndex's alarm and read by pages.
import { repoIndex } from './repo-index.js'
import type { FileDiff } from './compare.js'


export interface CommitChange extends Change {
  commit: { message: string; author: { name: string; timestamp: number }; parent: string | null }
}

export async function commitChange(owner: string, repo: string, sha: string, _ref: string): Promise<CommitChange | null> {
  const change = await (await repoIndex(owner, repo))?.pageChange('commit', sha) as CommitChange | null | undefined
  return change ?? null
}

export async function pullChange(owner: string, repo: string, head: string, base: string): Promise<Change | null> {
  const change = await (await repoIndex(owner, repo))?.pageChange('pull', head, base)
  return change ?? null
}
