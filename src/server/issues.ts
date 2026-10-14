import { ApiError } from '../engine/api/errors.js'
import type {z} from 'zod'
import type {provenance} from '../engine/api/import-contract.js'
import { pageIndex } from './repo-index.js'
// Issues on the `_meta` branch (layout and write rules: lib/metastore.ts):
//
//   .gild/<n>/issue/issue.json         title, body, author, state, labels, claim
//   .gild/<n>/issue/c-<time>-<id>.json one file per comment
//   .gild/<n>/log/<time>-<id>.json     closed, reopened, claimed, unclaimed
import {
  DIR, cloneBranch, logEvent, newId, nextNumber, readAll, readIndex, readJson, stamp, writeJson, writeMeta,
  type Claim, type IssueEntry,
} from './metastore.js'
import type { MemFS } from '../engine/memfs.js'

export type { Claim }
export type IndexEntry = IssueEntry

export interface Issue {
  imported?:z.infer<typeof provenance>
  schema: 1
  number: number
  title: string
  body: string
  author: string
  createdAt: string
  state: 'open' | 'closed'
  labels: string[]
  claim: Claim | null
}

export interface Comment { imported?:z.infer<typeof provenance>; id: string; author: string; createdAt: string; body: string }

export interface LogEvent { kind: string; by: string; at: string; [k: string]: unknown }

export async function listIssues(owner: string, repo: string): Promise<IssueEntry[]> {
  return (await readIndex(owner, repo)).issues.sort((a, b) => b.number - a.number)
}

/** One issue with its comments and log, from a shallow clone of `_meta`
 *  (the REST API reads one file per call; the clone gets the folder at once). */
export async function readIssue(owner: string, repo: string, number: number) {
  const index = await pageIndex(owner, repo)
  if (index) {
    const item = await index.metaItem(number, 'issue')
    return item ? { issue: item.item as Issue, comments: item.comments as Comment[], log: item.log as LogEvent[] } : null
  }
  throw new ApiError(503, 'Repository metadata is being prepared; retry shortly')
}

export async function createIssue(owner: string, repo: string, author: string, title: string, body: string, labels: string[] = []) {
  const { createIssueRecord } = await import('./api/metadata.js')
  return (await createIssueRecord(owner,repo,author,title,body,labels)).number
}

export async function addComment(owner: string, repo: string, number: number, author: string, body: string) {
  return writeMeta(owner, repo, `issue #${number}: comment`, author, async (fs) => {
    await requireIssue(fs, number)
    const c: Comment = { id: newId(), author, createdAt: stamp(), body }
    await writeJson(fs, `${DIR}/.gild/${number}/issue/c-${Date.now()}-${c.id}.json`, c)
    return c.id
  })
}

/** Close, reopen, claim or release. Returns false when there was nothing to
 *  change (already closed, or already claimed). */
export async function changeIssue(
  owner: string, repo: string, number: number, by: string,
  change: 'close' | 'reopen' | 'claim' | 'unclaim',
) {
  return writeMeta(owner, repo, `issue #${number}: ${change}`, by, async (fs) => {
    const issue = await requireIssue(fs, number)
    let kind: string
    if (change === 'close') { if (issue.state === 'closed') return false; issue.state = 'closed'; kind = 'closed' }
    else if (change === 'reopen') { if (issue.state === 'open') return false; issue.state = 'open'; kind = 'reopened' }
    else if (change === 'claim') { if (issue.claim) return false; issue.claim = { by, at: stamp() }; kind = 'claimed' }
    else { if (!issue.claim) return false; issue.claim = null; kind = 'unclaimed' }
    await writeJson(fs, `${DIR}/.gild/${number}/issue/issue.json`, issue)
    await logEvent(fs, number, { kind, by })
    return true
  })
}

async function requireIssue(fs: MemFS, number: number) {
  const issue = await readJson<Issue>(fs, `${DIR}/.gild/${number}/issue/issue.json`)
  if (!issue) throw new Error(`issue #${number} does not exist`)
  return issue
}
