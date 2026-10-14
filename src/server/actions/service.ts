import { store } from '../backend.js'
import { loadWorkflows } from '../../engine/actions/source.js'
import { cache } from 'react'
import { getCloudflareContext } from '../context.js'
import type { RunQueue, ActionEnv } from './queue-do.js'
import { kept, memo } from '../kept.js'
import { repoInfo } from '../artifacts.js'
import { fileText, repoCommit, repoRefs, repoTree, tipOf } from '../repo.js'
import { listPulls } from '../pulls.js'
import { type Workflow, type Event } from '../../engine/actions/workflow.js'
import { ApiError } from '../../engine/api/errors.js'
type Stub = {
  [
    K in
      | 'runnerJobs'
      | 'registration'
      | 'approve'
      | 'apiRuns'
      | 'apiJob'
      | 'commitRuns'
      | 'cacheWorkflows'
      | 'prepareWorkflows'
      | 'deliver'
      | 'readRepo'
      | 'init'
      | 'overview'
      | 'detail'
      | 'logs'
      | 'enqueue'
      | 'rerun'
      | 'cancel'
      | 'required'
      | 'gate'
      | 'register'
      | 'remove'
      | 'patch'
      | 'poll'
      | 'heartbeat'
      | 'append'
      | 'step'
      | 'finish'
      | 'planMerge'
      | 'plannedMerge'
      | 'prepareMerge'
      | 'rejectMerge'
      | 'requestMergeScan'
  ]: (
    ...args: Parameters<RunQueue[K]>
  ) => Promise<Awaited<ReturnType<RunQueue[K]>>>
}
interface Namespace {
  idFromName(s: string): unknown
  get(id: unknown): Stub
}
// Existence is mutable, so check it briefly rather than creating durable state
// for misspelled repositories. Run/log data itself always comes from the DO.
const existingRepos = memo<unknown>(30_000)
// The DO id is immutable per repository and a rename rebinds the queue itself
// (settings-production `rebind`), so the address written by `init` only needs
// a round trip when this isolate has not sent that id/address pair recently.
// Without this, every page view and 3 s board poll paid two serial DO calls.
// The TTL only bounds a purge (week-old deletions) racing a warm isolate.
const initialized = memo<void>(600_000)
export const runQueue = cache(
  async (owner: string, repo: string): Promise<Stub> => {
    if (
      !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner) ||
      !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(repo)
    )
      throw new Error('invalid repository name')
    await existingRepos(`${owner}/${repo}`.toLowerCase(), () =>
      repoInfo(owner, repo),
    )
    const { env } = await getCloudflareContext(),
      ns = (env as Record<string, unknown>).RUN_QUEUE as Namespace | undefined
    if (!ns) throw new Error('Actions storage is not bound on this forge')
    const id = (
      await (await store()).settings.state(`${owner}/${repo}`.toLowerCase())
    ).id
    const q = ns.get(ns.idFromName(id)),
      address = `${owner}/${repo}`.toLowerCase()
    await initialized(`${id}:${address}`, () =>
      q.init(owner.toLowerCase(), repo.toLowerCase()),
    )
    return q
  },
)
export async function actionEnv(): Promise<ActionEnv> {
  return (await getCloudflareContext()).env as unknown as ActionEnv
}
/** The Actions page never parses YAML or walks Git on a cache miss. */
export async function pageWorkflows(owner: string, repo: string, sha: string): Promise<Workflow[]> {
  return kept(`actions-workflows:v1:${owner}/${repo}:${sha}`, async () => {
    const queue = await runQueue(owner, repo), hit = await queue.cacheWorkflows(sha)
    if (hit) return hit
    await queue.prepareWorkflows(sha)
    throw new ApiError(503, 'Workflows are being prepared')
  })
}
/** Branch names must be resolved before this call. YAML parsing and indexed
 * or fallback tree/blob reads are stored once per immutable commit in D1. */
export function workflowsAt(
  owner: string,
  repo: string,
  sha: string,
): Promise<Workflow[]> {
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error('workflow reads require a full commit hash')
  return kept(`actions-workflows:v1:${owner}/${repo}:${sha}`, async () => {
    const queue = await runQueue(owner, repo),
      cached = await queue.cacheWorkflows(sha)
    if (cached) return cached
    const parsed = await loadWorkflows(
      {
        commit: async (h) => ({
          tree: (await repoCommit(owner, repo, h)).treeHash,
        }),
        tree: async (h) =>
          (await repoTree(owner, repo, h)).map((e) => ({
            ...e,
            child: e.hash,
          })),
        blob: async (h) => {
          const content = await fileText(owner, repo, h)
          return content.kind === 'text'
            ? new TextEncoder().encode(content.text)
            : new Uint8Array([0])
        },
      },
      sha,
    )
    await queue.cacheWorkflows(sha, parsed)
    return parsed
  })
}
export async function dispatch(
  owner: string,
  repo: string,
  file: string,
  ref: string,
  actor: string,
) {
  const refs = await repoRefs(owner, repo),
    sha = tipOf(refs, ref)
  if (!sha) throw new Error('branch or tag not found')
  const workflow = (await workflowsAt(owner, repo, sha)).find(
    (w) => w.file === file,
  )
  if (!workflow?.triggers.workflow_dispatch)
    throw new Error('this workflow has no workflow_dispatch trigger')
  const event: Event = {
    name: 'workflow_dispatch',
    sha,
    ref: `refs/${refs.tags.some((t) => t.name === ref) ? 'tags' : 'heads'}/${ref}`,
    actor,
    title: (await repoCommit(owner, repo, sha)).message.split('\n')[0],
    repository: `${owner}/${repo}`,
    key: crypto.randomUUID(),
  }
  return (await runQueue(owner, repo)).enqueue(workflow, event)
}
export async function trigger(owner: string, repo: string, event: Event) {
  await (await runQueue(owner, repo)).deliver(event)
}
export async function triggerPull(
  owner: string,
  repo: string,
  pull: {
    number: number
    head: string
    base: string
    title: string
    author: string
  },
  action = 'opened',
  actor = pull.author,
  headSha?: string,
) {
  const refs = await repoRefs(owner, repo),
    sha = headSha ?? tipOf(refs, pull.head),
    base = tipOf(refs, pull.base)
  if (!sha) return
  await trigger(owner, repo, {
    name: 'pull_request',
    sha,
    ref: `refs/heads/${pull.head}`,
    headRef: pull.head,
    baseRef: pull.base,
    before: base ?? undefined,
    actor,
    title: pull.title,
    repository: `${owner}/${repo}`,
    action,
    pull: pull.number,
    key: `pr:${pull.number}:${action}:${sha}`,
  })
}
export async function triggerPush(
  owner: string,
  repo: string,
  update: { ref: string; before: string; sha: string },
  actor: string,
) {
  if (
    !/^[a-f0-9]{40}$/.test(update.sha) ||
    /^0+$/.test(update.sha) ||
    update.ref === 'refs/heads/_meta'
  )
    return
  const branch = update.ref.replace(/^refs\/(heads|tags)\//, '')
  await trigger(owner, repo, {
    name: 'push',
    sha: update.sha,
    before: update.before,
    ref: update.ref,
    actor,
    title: '',
    repository: `${owner}/${repo}`,
    key: `push:${update.ref}:${update.before}:${update.sha}`,
  })
  if (update.ref.startsWith('refs/heads/')) {
    for (const p of (await listPulls(owner, repo)).pulls.filter(
      (p) => p.state === 'open' && p.head === branch,
    ))
      await triggerPull(owner, repo, p, 'synchronize', actor, update.sha)
  }
}
export async function scheduleActions(work: () => Promise<unknown>) {
  const { ctx } = await getCloudflareContext()
  ctx.waitUntil(work())
}
export async function actionsForCommit(
  owner: string,
  repo: string,
  sha: string,
) {
  return (await runQueue(owner, repo)).commitRuns(sha)
}
