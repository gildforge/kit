import { getCloudflareContext } from './context.js'
import { cache } from 'react'
import type { ForgeStore } from './backend.js'
import type { RepoIndexRPC } from './repo-index.js'
import { channelAccessChanged, type ChannelBindings } from './channel/binding.js'
import { repoWrite } from './repo-write.js'
import { takeMetadataOperation, metadataOperationPath, metadataOperationSnapshot } from '../engine/metadata-operation.js'
import { metadataSnapshot, recordMetadataEvents } from './events/metadata.js'
import { readyIndex, pageIndex, repoIndex, scheduleIndex } from './repo-index.js'
import { awaitCurrentIndex } from '../engine/repo-index-ready.js'
import { listRefs } from './repo-refs-live.js'
// The repo's `_meta` branch as a store: read by commit hash over REST,
// written by cloning, changing, committing as gild and pushing.
//
// Only the forge writes `_meta` (the git proxy refuses user pushes to it).
// Two writes racing on one repo is a rejected push for one of them, which
// starts again on top of the winner, so writes are sequenced by git itself.
//
//   .gild/next                  next number (issues and PRs share it)
//   .gild/<n>/issue/…           an issue (see lib/issues.ts)
//   .gild/<n>/pr/…              a pull request (see lib/pulls.ts)
//   .gild/<n>/log/…             state changes of either
//   .gild/queue.json            the merge queue: PR numbers, in order
//   .gild/index.json            summary of everything above, rebuilt from the
//                               per-item files on every write
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { metaHttp } from '../engine/git-meta-http.js'
import { MemFS } from '../engine/memfs.js'
import { mintRepoToken, repoRemote } from './artifacts.js'

import { DIR, readJson, writeJson } from '../engine/meta-files.js'
export { DIR, readJson, writeJson } from '../engine/meta-files.js'
/** Alarm writes pass explicit bindings; request writes retain their defaults. */
export interface MetadataRuntime {
  store: ForgeStore
  connection(scope: 'read' | 'write'): Promise<{ token: string; url: string }>
  index: RepoIndexRPC | null
  channels: ChannelBindings
  /** Scoped live refs for writer-side preparation without Next request state. */
  liveRefs?(): Promise<import('../engine/repo-refs.js').Refs>
}
export interface MetadataOptions {
  codeRefs?: Record<string, string>
  deferProjection?: boolean
  historical?: boolean
  parents?: string[]
  runtime?: MetadataRuntime
}
const MAX_ATTEMPTS = 4

export const newId = () => crypto.randomUUID().slice(0, 8)
export const stamp = () => new Date().toISOString()

export interface Claim {
  by: string
  at: string
}

export interface IssueEntry {
  number: number
  title: string
  author: string
  createdAt: string
  updatedAt: string
  state: 'open' | 'closed'
  labels: string[]
  claim: Claim | null
  comments: number
}

export interface PullEntry {
  number: number
  title: string
  author: string
  createdAt: string
  updatedAt: string
  state: 'open' | 'merged' | 'closed'
  head: string
  base: string
  approvals: string[]
  changesRequested: string[]
  conflicts: boolean
  comments: number
}

export interface MetaIndex {
  schema: 1
  issues: IssueEntry[]
  pulls: PullEntry[]
  queue: number[]
}

const EMPTY: MetaIndex = { schema: 1, issues: [], pulls: [], queue: [] }

/** The `_meta` files a repository page reads (index, ACL, import source). */
const PAGE_META_FILES = ['.gild/index.json', '.gild/acl.json', '.gild/import/source.json']
// Content at one `_meta` commit never changes: kept per isolate by commit.
const metaAtCommit = new Map<string, Record<string, string | null>>()
/** The page's `_meta` files in one Durable Object round trip, or none at
 *  all when this isolate already read them at the commit D1 currently
 *  publishes for the repository (the Worker's page reads, this request). */
const pageMetaFiles = cache(async (owner: string, repo: string) => {
  const { pageMetaCommit } = await import('./page.js')
  const fence = await pageMetaCommit(owner, repo).catch(() => null)
  const key = fence && `${fence.id}:${fence.meta}`
  const hit = key ? metaAtCommit.get(key) : undefined
  if (hit) return hit
  const index = await pageIndex(owner, repo)
  const read = await index.metaFiles(PAGE_META_FILES)
  if (key && read.meta === fence.meta) {
    if (metaAtCommit.size > 500) metaAtCommit.delete(metaAtCommit.keys().next().value!)
    metaAtCommit.set(key, read.files)
  }
  return read.files
})

/** One file from the latest `_meta`, or null. */
export async function readMetaFile(
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  if (PAGE_META_FILES.includes(path)) {
    const files = await pageMetaFiles(owner, repo)
    if (files) return files[path] ?? null
  }
  return (await pageIndex(owner, repo)).metaFile(path)
}

export async function readIndex(
  owner: string,
  repo: string,
): Promise<MetaIndex> {
  const raw = await readMetaFile(owner, repo, '.gild/index.json')
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw) as Partial<MetaIndex>
    return {
      schema: 1,
      issues: parsed.issues ?? [],
      pulls: parsed.pulls ?? [],
      queue: parsed.queue ?? [],
    }
  } catch {
    return EMPTY
  }
}

const auth = new WeakMap<MemFS, string>()
export const authFor = (fs: MemFS) => () => ({
  username: 'x',
  password: auth.get(fs)!,
})

/** A clone of one branch (default `_meta`) into memory. `depth` 1 is the
 *  latest commit only; 0 is the whole history (merges need it). */
/** `checkout: false` keeps only git's objects: enough to read any commit, and
 *  without a second copy of every file in memory (code reads never need it). */
export async function cloneBranch(
  owner: string,
  repo: string,
  scope: 'read' | 'write',
  ref = '_meta',
  depth = 1,
  checkout = true,
  runtime?: MetadataRuntime,
) {
  if(scope==='write'){const {store}=await import('./backend.js');const st=runtime?.store ?? await store(),item=await st.settings.state(`${owner}/${repo}`),org=await st.settings.state(owner);if(item.archived||item.deletedAt!==null||item.moving||org.archived||org.deletedAt!==null||org.moving)throw new Error('Repository is read-only')}
  const connection = runtime ? await runtime.connection(scope) : null
  const token = connection?.token ?? (await mintRepoToken(owner, repo, scope, 300)).plaintext.split('?')[0]
  const fs = new MemFS()
  auth.set(fs, token)
  await fs.mkdir(DIR)
  await git.clone({
    cache: fs.gitCache,
    fs: fs as never,
    http: metaHttp,
    dir: DIR,
    url: connection?.url ?? await repoRemote(owner, repo),
    ref,
    singleBranch: true,
    // Metadata is independent of code tags. Automatic tag following would
    // download code packs on every metadata read/write, even at depth one.
    ...(ref === '_meta' ? { noTags: true } : {}),
    noCheckout: !checkout,
    ...(depth ? { depth } : {}),
    onAuth: authFor(fs),
  })
  return fs
}

/** Clone `_meta`, apply `change`, rebuild the index, commit and push. A
 *  `change` that returns `false` means "nothing to do" and writes nothing. */
export function writeMeta<T>(owner:string,repo:string,message:string,onBehalfOf:string,change:(fs:MemFS)=>Promise<T>,options:MetadataOptions={}):Promise<T>{
  const operation = takeMetadataOperation()
  return repoWrite(owner,repo,()=>writeMetaRecord(owner,repo,message,onBehalfOf,change,options,operation),options.runtime?.store)
}

async function writeMetaRecord<T>(
  owner: string,
  repo: string,
  message: string,
  onBehalfOf: string,
  change: (fs: MemFS) => Promise<T>,
  options: MetadataOptions,
  operation?: string,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let stage = 'clone'
    const timings:Record<string,number>={},started=Date.now()
    let prior=started
    const mark=(next:string)=>{const now=Date.now();timings[stage]=(timings[stage]??0)+now-prior;prior=now;stage=next}
    try {
    const fs = await cloneBranch(owner, repo, 'write', '_meta', 1, true, options.runtime)
    fs.writtenPaths.clear()
    if (operation) {
      const receipt = await readJson<{ result: T }>(fs, `${DIR}/${metadataOperationPath(operation)}`)
      if (receipt) return receipt.result
    }
    mark('snapshot')
    const before = options.historical ? null : await metadataSnapshot(fs)
    mark('apply')
    const result = await change(fs)
    if (result === false) return result
    // Committed in the SAME _meta update as the record, before any post-push
    // ACL/index work. A lost response can be reconciled without another write.
    if (operation) await writeJson(fs, `${DIR}/${metadataOperationPath(operation)}`, { result, ...await metadataOperationSnapshot(result, fs) })
    mark('rebuild index')
    await rebuildIndex(fs)
    const indexed = options.codeRefs ? null : options.runtime ? options.runtime.index : await readyIndex(owner, repo),
      refs = options.codeRefs ?? (indexed
        ? Object.fromEntries(
            (await indexed.refs()).refs.map((r) => [r.name, r.hash]),
          )
        : {})
    mark('events')
    if(before)await recordMetadataEvents(fs, before, `${owner}/${repo}`, onBehalfOf, refs)
    mark('git add')
    if(options.historical) {
      // Import records never delete files. Stage only the files this batch
      // wrote, avoiding a full metadata-tree rehash on every bounded batch.
      for(const path of [...fs.writtenPaths].filter(p=>p.startsWith(DIR+'/')&&!p.startsWith(DIR+'/.git/')))
        await git.add({cache:fs.gitCache,fs:fs as never,dir:DIR,filepath:path.slice(DIR.length+1)})
    } else await git.add({ cache: fs.gitCache, fs: fs as never, dir: DIR, filepath: '.' })
    mark('git commit')
    const meta = await git.commit({
      cache: fs.gitCache,
      fs: fs as never,
      dir: DIR,
      author: { name: 'gild', email: 'forge@gild.gg' },
      message: `${message}\n\nOn-behalf-of: @${onBehalfOf}\n`,
      ...(options.parents?.length ? {parent:[await git.resolveRef({fs:fs as never,dir:DIR,ref:'_meta'}),...options.parents]} : {}),
    })
    // A durable fence must precede the upstream commit. If this D1 write
    // fails, nothing is pushed. If anything after it fails, reads stay closed.
    mark('fence')
    const st=options.runtime?.store ?? await (await import('./backend.js')).store(), state=await st.settings.state(`${owner}/${repo}`)
    const previousAccess = await st.getRepoAccess(state.id)
    await st.fenceRepoAccess(state.id,meta)
    const index=options.deferProjection ? null : options.runtime ? options.runtime.index : await repoIndex(owner,repo)
    await index?.refresh(owner,repo)
    try {
      mark('push')
      await git.push({
        cache: fs.gitCache,
        fs: fs as never,
        http,
        dir: DIR,
        url: options.runtime ? (await options.runtime.connection('write')).url : await repoRemote(owner, repo),
        ref: '_meta',
        remoteRef: '_meta',
        onAuth: authFor(fs),
      })
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw e // someone else kept winning
      continue
    }
    // Publish access changes before returning the successful metadata write;
    // list pages can keep serving code summaries without readiness waits.
    try {
      const acl=(await readJson<import('./repo-list-snapshot.js').ListingSnapshot['acl']>(fs, `${DIR}/.gild/acl.json`)) ?? {}
      mark('publish ACL')
      if(index) await index.listingAcl(meta,acl)
      const published = await st.publishRepoAccess(state.id,meta,acl)
      if (published && JSON.stringify(previousAccess?.acl) !== JSON.stringify(acl))
        await channelAccessChanged(options.runtime?.channels ?? (await getCloudflareContext()).env as unknown as ChannelBindings,state.id)
    } finally {
      // Even a failed listing RPC leaves the access fence in place. Its durable
      // dirty/alarm record was made BEFORE the upstream push.
      if(!options.deferProjection) { if(options.runtime) await options.runtime.index?.refresh(owner,repo); else await scheduleIndex(owner,repo) }
    }
    // A save prepares its committed read model before refreshing controls.
    // This synchronization belongs to the writer, never a page request. A
    // transient publication failure cannot undo an already accepted push.
    const readLive = options.runtime ? options.runtime.liveRefs : () => listRefs(owner, repo)
    if (index && readLive) {
      try { await awaitCurrentIndex(index, owner, repo, await readLive(), readLive) }
      catch (error) { console.error('Accepted metadata awaiting projection', owner, repo, error instanceof Error ? error.message : 'Unavailable') }
    }
    return result
    } catch (error) {
      if(options.codeRefs) console.error('Import metadata failed', stage, error instanceof Error ? error.name : 'Unknown', error instanceof Error ? error.stack?.split('\n').slice(1,6).join('\n') : '')
      throw error
    } finally {
      if(options.historical){mark('done');console.info('Import metadata timings',JSON.stringify(timings),'total_ms',Date.now()-started)}
    }
  }
}

/** Files in a folder whose names start with `prefix`, read as JSON, oldest first. */
export async function readAll<T>(
  fs: MemFS,
  dir: string,
  prefix: string,
): Promise<T[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.startsWith(prefix))
    .sort()
  return (
    await Promise.all(names.map((f) => readJson<T>(fs, `${dir}/${f}`)))
  ).filter((x): x is Awaited<T> => !!x) as T[]
}

export async function nextNumber(fs: MemFS) {
  const n =
    parseInt(
      (
        (await fs.readFile(`${DIR}/.gild/next`, { encoding: 'utf8' })) as string
      ).trim(),
      10,
    ) || 1
  await fs.writeFile(`${DIR}/.gild/next`, `${n + 1}\n`)
  return n
}

export async function logEvent(
  fs: MemFS,
  number: number,
  event: Record<string, unknown>,
) {
  await writeJson(
    fs,
    `${DIR}/.gild/${number}/log/${Date.now()}-${newId()}.json`,
    { ...event, at: stamp() },
  )
}

/** Recomputes index.json from the per-item files, so it can never drift. */
async function rebuildIndex(fs: MemFS) {
  const index: MetaIndex = { schema: 1, issues: [], pulls: [], queue: [] }
  for (const name of await fs
    .readdir(`${DIR}/.gild`)
    .catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue
    const base = `${DIR}/.gild/${name}`
    const logs = await fs.readdir(`${base}/log`).catch(() => [] as string[])
    const lastLog = logs
      .map((f) => Number(f.split('-')[0]))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0]
    const issue = await readJson<{
      number: number
      title: string
      author: string
      createdAt: string
      updatedAt?: string
      state: 'open' | 'closed'
      labels: string[]
      claim: Claim | null
    }>(fs, `${base}/issue/issue.json`)
    if (issue) {
      const comments = (await fs.readdir(`${base}/issue`)).filter((f) =>
        f.startsWith('c-'),
      )
      const last = Math.max(
        lastLog ?? 0,
        ...comments.map((f) => Number(f.split('-')[1])).filter(Number.isFinite),
      )
      index.issues.push({
        number: issue.number,
        title: issue.title,
        author: issue.author,
        createdAt: issue.createdAt,
        updatedAt: new Date(Math.max(last || 0,Date.parse(issue.updatedAt ?? issue.createdAt))).toISOString(),
        state: issue.state,
        labels: issue.labels,
        claim: issue.claim,
        comments: comments.length,
      })
      continue
    }
    const pull = await readJson<{
      number: number
      title: string
      author: string
      createdAt: string
      updatedAt?: string
      state: 'open' | 'merged' | 'closed'
      head: string
      base: string
      conflicts?: boolean
    }>(fs, `${base}/pr/pr.json`)
    if (pull) {
      const files = await fs.readdir(`${base}/pr`)
      const reviews = await readAll<{
        author: string
        verdict: string
        imported?: unknown
        createdAt: string
      }>(fs, `${base}/pr`, 'r-')
      const latest = new Map<string, string>() // each reviewer's latest verdict counts
      for (const r of reviews) if(!r.imported) latest.set(r.author, r.verdict)
      const comments = files.filter((f) => f.startsWith('c-'))
      const last = Math.max(
        lastLog ?? 0,
        ...[...comments, ...files.filter((f) => f.startsWith('r-'))]
          .map((f) => Number(f.split('-')[1]))
          .filter(Number.isFinite),
      )
      index.pulls.push({
        number: pull.number,
        title: pull.title,
        author: pull.author,
        createdAt: pull.createdAt,
        updatedAt: new Date(Math.max(last || 0,Date.parse(pull.updatedAt ?? pull.createdAt))).toISOString(),
        state: pull.state,
        head: pull.head,
        base: pull.base,
        conflicts: !!pull.conflicts,
        approvals: [...latest]
          .filter(([, v]) => v === 'approve')
          .map(([a]) => a),
        changesRequested: [...latest]
          .filter(([, v]) => v === 'changes')
          .map(([a]) => a),
        comments: comments.length,
      })
    }
  }
  index.queue = (await readJson<number[]>(fs, `${DIR}/.gild/queue.json`)) ?? []
  await writeJson(fs, `${DIR}/.gild/index.json`, index)
}
