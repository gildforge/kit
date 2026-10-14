import { ApiError } from '../engine/api/errors.js'
import type { MergeIntent } from '../engine/merge-queue-store.js'
import type { MergeRuntime } from './merge-queue-runtime.js'
import type {z} from 'zod'
import type {provenance} from '../engine/api/import-contract.js'
import { getCloudflareContext } from './context.js'
import { repoWrite } from './repo-write.js'
import { closingReferences } from '../engine/closing.js'
import {
  runQueue,
  scheduleActions,
  triggerPull,
  triggerPush,
} from './actions/service.js'
import { repoIndex, pageIndex, scheduleIndex } from './repo-index.js'
// Pull requests on the `_meta` branch (layout and write rules: lib/metastore.ts):
//
//   .gild/<n>/pr/pr.json               title, body, author, head, base, state
//   .gild/<n>/pr/r-<time>-<id>.json    reviews: approve, changes, comment
//   .gild/<n>/pr/c-<time>-<id>.json    comments
//   .gild/<n>/log/<time>-<id>.json     queued, merged, conflicts, closed, …
//   .gild/queue.json                   the merge queue, in order
//
// Merging happens here, in the Worker: clone the repo into memory, merge the
// PR's branch into its base with a merge commit by gild, push the base. The
// merge queue does this one PR at a time, so every PR merges onto the main
// the previous one left behind; a PR that no longer merges cleanly is marked
// as conflicting and leaves the queue instead of landing broken.
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import {
  DIR,
  authFor,
  cloneBranch,
  logEvent,
  newId,
  nextNumber,
  readAll,
  readIndex,
  type MetaIndex,
  readJson,
  stamp,
  writeJson,
  writeMeta,
} from './metastore.js'
import { repoRemote } from './artifacts.js'
import type { FileDiff } from './compare.js'
import { repoRefs } from './repo.js'
import type { MemFS } from '../engine/memfs.js'

export interface Pull {
  schema: 1
  number: number
  title: string
  body: string
  author: string
  createdAt: string
  head: string
  base: string
  state: 'open' | 'merged' | 'closed'
  imported?:z.infer<typeof provenance>
  labels?: string[]
  sourceHead?: { ref: string; sha: string | null; repository: string | null }
  patchParts?: number
  conflicts?: boolean
  conflictFiles?: string[]
  merged?: { by: string; at: string; commit: string }
  queueIntent?: { id: string; headOid: string; head?: string; base?: string }
}

export type Verdict = 'approve' | 'changes' | 'comment'
export interface Review {
  imported?:z.infer<typeof provenance>
  id: string
  author: string
  verdict: Verdict
  body: string
  createdAt: string
  headOid: string | null
}
export interface PullComment {
  id: string
  author: string
  createdAt: string
  body: string
}
export interface PullEvent {
  kind: string
  by: string
  at: string
  commit?: string
  files?: string[]
}

export async function listPulls(owner: string, repo: string) {
  const index = await readIndex(owner, repo)
  return {
    pulls: index.pulls.sort((a, b) => b.number - a.number),
    queue: index.queue,
  }
}

export async function readPull(owner: string, repo: string, number: number) {
  const index = await pageIndex(owner, repo)
  if (index) {
    const item = await index.metaItem(number, 'pr')
    return item
      ? {
          pull: item.item as Pull,
          comments: item.comments as PullComment[],
          reviews: item.reviews as Review[],
          log: item.log as PullEvent[],
          queue: item.queue as number[],
        }
      : null
  }
  throw new ApiError(503, 'Repository metadata is being prepared; retry shortly')
}

export async function createPull(
  owner: string,
  repo: string,
  author: string,
  title: string,
  body: string,
  head: string,
  base: string,
) {
  if (head === base)
    throw new PullError('the branch to merge must differ from the base', 400)
  const refs = await repoRefs(owner, repo)
  const branches = new Set(refs.branches.map((b) => b.name))
  if (!branches.has(head)) throw new PullError(`no branch named ${head}`, 400)
  if (!branches.has(base)) throw new PullError(`no branch named ${base}`, 400)
  const number = await writeMeta(
    owner,
    repo,
    `pr: open "${title}" (${head} → ${base})`,
    author,
    async (fs) => {
      const number = await nextNumber(fs)
      const pull: Pull = {
        schema: 1,
        number,
        title,
        body,
        author,
        createdAt: stamp(),
        head,
        base,
        state: 'open',
      }
      await writeJson(fs, `${DIR}/.gild/${number}/pr/pr.json`, pull)
      return number
    },
  )
  await scheduleActions(() =>
    triggerPull(owner, repo, { number, head, base, title, author }),
  )
  return number
}

export async function commentOnPull(
  owner: string,
  repo: string,
  number: number,
  author: string,
  body: string,
) {
  return writeMeta(
    owner,
    repo,
    `pr #${number}: comment`,
    author,
    async (fs) => {
      await requirePull(fs, number)
      const c: PullComment = { id: newId(), author, createdAt: stamp(), body }
      await writeJson(
        fs,
        `${DIR}/.gild/${number}/pr/c-${Date.now()}-${c.id}.json`,
        c,
      )
      return c.id
    },
  )
}

/** A review records the head commit it looked at, so the page can say when
 *  an approval predates later pushes. Authors cannot approve their own PR. */
export async function reviewPull(
  owner: string,
  repo: string,
  number: number,
  author: string,
  verdict: Verdict,
  body: string,
) {
  const headOid = await branchOid(owner, repo, number)
  return writeMeta(
    owner,
    repo,
    `pr #${number}: review (${verdict})`,
    author,
    async (fs) => {
      const pull = await requirePull(fs, number)
      if (pull.state !== 'open')
        throw new PullError(`#${number} is ${pull.state}`, 409)
      if (verdict === 'approve' && pull.author === author)
        throw new PullError("you can't approve your own pull request", 403)
      const r: Review = {
        id: newId(),
        author,
        verdict,
        body,
        createdAt: stamp(),
        headOid,
      }
      await writeJson(
        fs,
        `${DIR}/.gild/${number}/pr/r-${Date.now()}-${r.id}.json`,
        r,
      )
      return r.id
    },
  )
}

export async function setPullState(
  owner: string,
  repo: string,
  number: number,
  by: string,
  state: 'open' | 'closed',
) {
  const result = await writeMeta(
    owner,
    repo,
    `pr #${number}: ${state === 'open' ? 'reopen' : 'close'}`,
    by,
    async (fs) => {
      const pull = await requirePull(fs, number)
      if (pull.state === 'merged' || pull.state === state) return false
      pull.state = state
      await writeJson(fs, `${DIR}/.gild/${number}/pr/pr.json`, pull)
      await removeFromQueue(fs, number)
      await logEvent(fs, number, {
        kind: state === 'open' ? 'reopened' : 'closed',
        by,
      })
      return true
    },
  )
  if (state === 'open' && result) {
    const found = await readPull(owner, repo, number)
    if (found)
      await scheduleActions(() =>
        triggerPull(owner, repo, found.pull, 'reopened', by),
      )
  }
  return result
}

/** Add an approved PR to the merge queue. Approved means: at least one
 *  approval from someone other than the author, and nobody's latest review
 *  asks for changes. */
async function requireApprovalForHead(fs: MemFS, pull: Pull, headOid: string) {
  const latest = new Map<string, Review>()
  for (const review of await readAll<Review>(fs, `${DIR}/.gild/${pull.number}/pr`, 'r-'))
    if (!review.imported) latest.set(review.author, review)
  if (![...latest].some(([author, review]) => author !== pull.author && review.verdict === 'approve' && review.headOid === headOid))
    throw new PullError('needs an approval from someone other than the author at the current PR head', 409)
  const blocking = [...latest].filter(([, review]) => review.verdict === 'changes').map(([author]) => `@${author}`)
  if (blocking.length) throw new PullError(`${blocking.join(', ')} asked for changes`, 409)
}

export async function enqueuePull(owner: string, repo: string, number: number, by: string) {
  const headOid = await branchOid(owner, repo, number)
  if (!headOid) throw new PullError('PR head branch is unavailable', 409)
  const queue = await runQueue(owner, repo)
  const intent = await queue.prepareMerge(number)
  let rejectedBeforeCommit = false, mayHaveCommitted = false, recoveredAdded = false
  try {
    const result = await writeMeta(owner, repo, `pr #${number}: queue`, by, async fs => {
      const previous = await readJson<{id:string;number:number;added:boolean}>(fs, `${DIR}/.gild/merge-requests/${intent}.json`)
      if (previous?.id === intent && previous.number === number) {
        mayHaveCommitted = true; recoveredAdded = previous.added === true
        return false // Git already accepted this exact queue request
      }
      const pull = await requirePull(fs, number)
      try {
        if (pull.state !== 'open') throw new PullError(`#${number} is ${pull.state}`, 409)
        await requireApprovalForHead(fs, pull, headOid)
      } catch (error) { rejectedBeforeCommit = true; throw error }
      mayHaveCommitted = true
      const pending = await readJson<number[]>(fs, `${DIR}/.gild/queue.json`) ?? []
      const added = !pending.includes(number)
      if (added) pending.push(number)
      if (!pull.queueIntent || pull.queueIntent.headOid !== headOid || pull.queueIntent.head !== pull.head || pull.queueIntent.base !== pull.base || added) pull.queueIntent = { id: intent, headOid, head:pull.head, base:pull.base }
      pull.conflicts = false; pull.conflictFiles = []
      await writeJson(fs, `${DIR}/.gild/${number}/pr/pr.json`, pull)
      await writeJson(fs, `${DIR}/.gild/queue.json`, pending)
      await fs.mkdir(`${DIR}/.gild/merge-requests`).catch(() => {})
      // This receipt and queue membership are committed in the same Git write.
      await writeJson(fs, `${DIR}/.gild/merge-requests/${intent}.json`, { id:intent, number, headOid, added })
      if (added) await logEvent(fs, number, { kind:'queued', by })
      return { added }
    })
    return result === false ? recoveredAdded : result.added
  } catch (error) {
    // Only rejection before any successful callback application is known not
    // to have reached Git. An earlier push retry may already have committed. Transport,
    // push/ACL/index errors retain their durable preparation for reconciliation.
    if (rejectedBeforeCommit && !mayHaveCommitted) await queue.rejectMerge(intent)
    throw error
  }
}

export async function dequeuePull(
  owner: string,
  repo: string,
  number: number,
  by: string,
) {
  return writeMeta(
    owner,
    repo,
    `pr #${number}: leave queue`,
    by,
    async (fs) => {
      if (!(await removeFromQueue(fs, number))) return false
      await logEvent(fs, number, { kind: 'dequeued', by })
      return true
    },
  )
}

/** API merge: queue the PR and drain the queue after the response. The
 *  merge button drains at once; before 10 Oct the API answered 202 and left
 *  the PR queued forever. Shared by the production and test workers. */
export async function enqueueAndDrain(
  ...args: Parameters<typeof enqueuePull>
) {
  const queued = await enqueuePull(...args)
  const [owner, repo] = args
  ;(await getCloudflareContext()).ctx.waitUntil(
    processQueue(owner, repo).catch((e) =>
      console.error('merge queue', owner, repo, e),
    ),
  )
  return queued
}

/** Work through the queue until it is empty. Each PR merges onto whatever
 *  the base became after the one before it. Safe to call concurrently: the
 *  merge push and the `_meta` write both lose races cleanly and retry. */
export async function processQueue(owner: string, repo: string, runtime?: MergeRuntime, intents: readonly MergeIntent[] = []) {
  const clone = () => cloneBranch(owner, repo, 'read', '_meta', 1, true, runtime)
  const completed = new Set<string>()
  for (let guard = 0; guard < 20; guard++) {
    const meta = await clone()
    const queue = await readJson<number[]>(meta, `${DIR}/.gild/queue.json`) ?? []
    for (const intent of intents) {
      const receipt = await readJson<MergeIntent>(meta, `${DIR}/.gild/merge-requests/${intent.id}.json`)
      if (receipt?.id === intent.id && receipt.number === intent.number && !queue.includes(intent.number)) completed.add(intent.id)
    }
    if (!queue.length) return { queued:false, completed:[...completed] }
    const number = queue[0]
    const pull = await readJson<Pull>(meta, `${DIR}/.gild/${number}/pr/pr.json`)
    if (!pull || pull.state !== 'open') {
      await writeMeta(owner, repo, `queue: drop #${number}`, 'gild', fs => removeFromQueue(fs, number), { runtime })
      continue
    }
    const result = await mergeBranch(owner, repo, pull, runtime)
    if ('pending' in result) return { queued:true, completed:[...completed] }
    await writeMeta(owner, repo, `queue: #${number} ${result.ok ? 'merged' : 'conflicts'}`, 'gild', async fs => {
      const p = await requirePull(fs, number)
      // Another drain may have finalized, or an explicit newer queue request
      // may now own this slot. Never finalize/remove that newer selection.
      if (p.state === 'merged' || (p.queueIntent && p.queueIntent.id !== result.intent)) return false
      await removeFromQueue(fs, number)
      if (result.ok) {
        p.state = 'merged'
        p.merged = { by:'merge queue', at:stamp(), commit:result.commit }
        await logEvent(fs, number, {kind:'merged',by:'gild',commit:result.commit})
        for (const ref of closingReferences(`${p.title}\n${p.body ?? ''}`)) {
          const path = `${DIR}/.gild/${ref}/issue/issue.json`
          const issue = await readJson<{state:string}>(fs, path)
          if (ref === number || !issue || issue.state !== 'open') continue
          issue.state = 'closed'; await writeJson(fs,path,issue)
          await logEvent(fs,ref,{kind:'closed',by:p.author,pull:number})
        }
      } else {
        p.conflicts = true; p.conflictFiles = result.files
        await logEvent(fs,number,{kind:'conflicts',by:'gild',files:result.files})
      }
      await writeJson(fs,`${DIR}/.gild/${number}/pr/pr.json`,p)
      return true
    }, { runtime })
  }
  return { queued:true, completed:[...completed] }
}

type MergeResult = { ok:true; commit:string; intent:string } | { ok:false; files:string[]; intent:string } | { pending:true }

async function mergeCiAllowed(owner: string, repo: string, sha: string, runtime?: MergeRuntime) {
  const gate = runtime ? await runtime.gate(sha) : await (await runQueue(owner,repo)).gate(sha)
  return gate.ok
}

async function mergeBranch(owner: string, repo: string, pull: Pull, runtime?: MergeRuntime): Promise<MergeResult> {
  return repoWrite(owner, repo, async () => {
    for (let attempt = 1; ; attempt++) {
      const { head, base, number } = pull
      const fs = await cloneBranch(owner,repo,'write',base,0,true,runtime)
      const url = runtime ? (await runtime.connection('write')).url : await repoRemote(owner,repo)
      const meta = await cloneBranch(owner,repo,'read','_meta',1,true,runtime)
      const current = await readJson<Pull>(meta,`${DIR}/.gild/${number}/pr/pr.json`)
      const queued = await readJson<number[]>(meta,`${DIR}/.gild/queue.json`) ?? []
      if (!current || current.state !== 'open' || !queued.includes(number) || current.head !== head || current.base !== base) return {pending:true}
      if (current.queueIntent?.head && current.queueIntent.head !== head || current.queueIntent?.base && current.queueIntent.base !== base) return {pending:true}
      const publish = async (commit: string, before: string) => {
        const update = {ref:`refs/heads/${base}`,before,sha:commit}
        if (runtime) {
          const index = await readJson<MetaIndex>(meta,`${DIR}/.gild/index.json`)
          await runtime.pushed(update,index?.pulls ?? [])
        } else {
          await (await repoIndex(owner,repo))?.recordPush(`merge:${commit}`,[update],'merge queue')
          await scheduleIndex(owner,repo)
          await scheduleActions(() => triggerPush(owner,repo,update,'merge queue'))
        }
      }
      const marker = current.queueIntent ? `Gild-Merge-Intent: ${current.queueIntent.id}` : `Gild-Pull: ${number}`
      const intentKey = current.queueIntent?.id ?? `legacy:${number}`
      const plans = runtime ? await runtime.planned(intentKey) : await (await runQueue(owner,repo)).plannedMerge(intentKey)
      if (plans.length) {
        const log = await git.log({fs:fs as never,dir:DIR,ref:base})
        const plan = plans.find(plan => plan.base === base && log.some(entry => entry.oid === plan.commit && entry.commit.parent.includes(plan.head)))
        if (plan) {
          // Only a server-recorded plan can prove this accepted merge. A Git
          // message/author is user-controlled and cannot bypass fresh CI.
          await publish(plan.commit,plan.before)
          return {ok:true,commit:plan.commit,intent:intentKey}
        }
      }
      await git.fetch({fs:fs as never,http,dir:DIR,url,ref:head,singleBranch:true,onAuth:authFor(fs)})
      const headSha = await git.resolveRef({fs:fs as never,dir:DIR,ref:`refs/remotes/origin/${head}`})
      if (current.queueIntent && current.queueIntent.headOid !== headSha) return {pending:true}
      try { await requireApprovalForHead(meta,current,headSha) } catch (error) {
        if (error instanceof PullError) return {pending:true}
        throw error
      }
      if (!(await mergeCiAllowed(owner,repo,headSha,runtime))) return {pending:true}
      let accepted = false
      try {
        const prior = await git.resolveRef({fs:fs as never,dir:DIR,ref:`refs/remotes/origin/${base}`})
        const merged = await git.merge({fs:fs as never,dir:DIR,ours:base,theirs:`refs/remotes/origin/${head}`,fastForward:false,
          message:`Merge #${number}: ${current.title}\n\n${marker}\nGild-Merge-Attestation: ${crypto.randomUUID()}`,author:{name:'gild',email:'forge@gild.gg'}})
        let commit = merged.oid!, before = prior
        if (merged.alreadyMerged) {
          // A crash after the base push must recover its original commit, not
          // manufacture another merge or relabel a later base tip as this PR.
        } else {
          const refs = await git.listServerRefs({http,url,onAuth:authFor(fs)})
          if (refs.find(ref => ref.ref === `refs/heads/${head}`)?.oid !== headSha) return {pending:true}
          const checkpoint = await cloneBranch(owner,repo,'read','_meta',1,true,runtime)
          const latest = await readJson<Pull>(checkpoint,`${DIR}/.gild/${number}/pr/pr.json`)
          const pending = await readJson<number[]>(checkpoint,`${DIR}/.gild/queue.json`) ?? []
          if (!latest || latest.state !== 'open' || !pending.includes(number) || latest.head !== head || latest.base !== base || latest.queueIntent?.id !== current.queueIntent?.id) return {pending:true}
          try { await requireApprovalForHead(checkpoint,latest,headSha) } catch (error) {
            if (error instanceof PullError) return {pending:true}
            throw error
          }
          if (!(await mergeCiAllowed(owner,repo,headSha,runtime))) return {pending:true}
          const plan = {intent:intentKey,commit,head:headSha,base,before:prior}
          if (runtime) await runtime.plan(plan)
          else await (await runQueue(owner,repo)).planMerge(plan)
          await git.push({fs:fs as never,http,dir:DIR,url,ref:base,remoteRef:base,onAuth:authFor(fs)})
        }
        accepted = true
        await publish(commit,before)
        return {ok:true,commit,intent:intentKey}
      } catch (error) {
        if (accepted) throw error // uncertain post-push work resumes from its durable receipt
        const err = error as {code?:string;data?:{filepaths?:string[]}}
        if (err.code === 'MergeConflictError') return {ok:false,files:err.data?.filepaths ?? [],intent:intentKey}
        if (err.code === 'MergeNotSupportedError' || attempt >= 3) throw error
      }
    }
  }, runtime?.store)
}

export type { FileDiff }

async function branchOid(
  owner: string,
  repo: string,
  number: number,
): Promise<string | null> {
  try {
    const found = await readPull(owner, repo, number)
    if (!found) return null
    const refs = await repoRefs(owner, repo)
    return found.pull.imported && /^[a-f0-9]{40}$/.test(found.pull.head) ? found.pull.head : refs.branches.find((b) => b.name === found.pull.head)?.oid ?? null
  } catch {
    return null
  }
}

async function removeFromQueue(fs: MemFS, number: number) {
  const queue = (await readJson<number[]>(fs, `${DIR}/.gild/queue.json`)) ?? []
  if (!queue.includes(number)) return false
  await writeJson(
    fs,
    `${DIR}/.gild/queue.json`,
    queue.filter((n) => n !== number),
  )
  return true
}

async function requirePull(fs: MemFS, number: number) {
  const pull = await readJson<Pull>(fs, `${DIR}/.gild/${number}/pr/pr.json`)
  if (!pull) throw new PullError(`pull request #${number} does not exist`, 404)
  return pull
}

export class PullError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
