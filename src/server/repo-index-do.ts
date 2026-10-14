import { createHash } from 'node:crypto'
import {beginPreparedConversations,stagePreparedConversationThreads,stagePreparedConversationComments,stagePreparedConversationReviews,finishPreparedConversations,type ConversationThread,type ConversationComment,type ConversationReview} from './prepared-conversations-producer.js'
import {CONTENT_VERSION} from './prepared-repository-content.js'
import {publishPreparedContentSnapshot,publishPreparedContentBlob} from './prepared-repository-content-producer.js'
import {preparedChangePage,PreparationQueueFull} from '../engine/prepared-change-walk.js'
import {ensurePreparedOwnerCatalogue} from './prepared-catalogue-source.js'
import { channelAccessChanged, type ChannelBindings } from './channel/binding.js'
import { publishHeads } from './fragments/catalog.js'
import { SessionStore } from '../engine/sessions/store.js'
import type { Receipt } from '../engine/sessions-contract.js'
import { emit, type EventBindings } from './events/binding.js'
import { EventOutbox } from '../engine/events/outbox.js'
import { pushEvent, pullPayload, common, healthEvent } from './events/payloads.js'
import type { Emission } from '../engine/api/events-contract.js'
import { ApiError } from '../engine/api/errors.js'
import {
  computeChanges,
  comparison,
  entries,
  raw,
  snapshot,
  type Index,
} from './api/indexed.js'
import { BUILD, scoreNote, scoreFiles, type Report } from './cqx-wasm.js'
import { READS } from '../engine/cqx-input.js'
import { moduleFor } from '../engine/cqx-reads.js'
import {
  CQX_MAX_SOURCE_FILE_BYTES,
  type CFamilyIssue,
} from './cqx-heavy-limits.js'
import { scoreCacheKey } from './cqx-score-cache.js'
import {fencePreparedRefs,preparedRefsEpoch,publishPreparedRefs,publishPreparedHealth,publishPreparedDiff,publishPreparedPullHeads} from './prepared-repository-producer.js'
import type { HeavyBinding } from './cqx-module.js'
import type { Change, CommitChange } from './changes.js'
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState, D1Database } from '@cloudflare/workers-types'
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { snapshotSource } from '../engine/repo-index-source.js'
import type { Commit, Entry } from '../engine/repo-index-store.js'
import { d1Store } from './drivers/d1.js'
import type { ObjectSource } from '../engine/repo-indexer.js'
import { IndexStore, type SQL } from '../engine/repo-index-store.js'
import { indexStep, startIndex, type Target } from '../engine/repo-indexer.js'
import { listingSnapshot, type ListingSnapshot } from './repo-list-snapshot.js'
import type { Queue } from '@cloudflare/workers-types'
import type {
  RenderJob,
  RenderItem,
  RenderData,
  RenderPlan,
  PagePointer,
  HomeData,
  TipManifest,
} from '../engine/fragments.js'
import {
  changedItems,
  manifestAt,
  publishHome,
  emptyManifest,
  EMPTY_TREE,
} from './fragments/projection.js'
import {
  blobFragment,
  bundlePath,
  languageFor,
} from '../render/language.js'
import { profileView } from './profile-view.js'
import { digest, fragmentKey, RENDER_VERSION, type Fragment } from '../render/address.js'
import { artifactsApi, artifactsGit } from './account.js'

interface Env extends EventBindings, ChannelBindings {
  RUN_QUEUE?: { idFromName(name:string):unknown; get(id:unknown):{init(owner:string,repo:string):Promise<void>;requestMergeScan():Promise<void>} }
  CQX_HEAVY?: HeavyBinding
  ARTIFACTS_TOKEN?: string
  CLOUDFLARE_ACCOUNT_ID?: string
  DB: D1Database
  /** Code search (lib/search-index.ts), derived from the default branch. */
  SEARCH_DB?: D1Database
  RENDER_QUEUE?: Queue<RenderJob & { cursor?: number }>
}
/** Waits that the work loop itself resolves (see wake()). */
const TRIGGERED_WAITS = new Set(['content:refs', 'content:observed', 'content:tips', 'conversations:finish'])
/** One SQLite database per owner/repo. No tokens in SQL, jobs, RPC results or
 *  logs. Alarms mint a short-lived repo token from their own Worker binding. */
export class RepoIndex extends DurableObject<Env> {
  protected index: IndexStore
  private sessions: SessionStore
  private outbox: EventOutbox
  private searches = new Map<string, ReturnType<IndexStore['search']>>()
  private running: Promise<void> | null = null
  address(owner: string, repo: string) {
    if (
      this.index.setting('owner') !== owner ||
      this.index.setting('repo') !== repo
    )
      this.conn = null
    this.index.setting('owner', owner)
    this.index.setting('repo', repo)
  }
  async purge() {
    if (this.running) await this.running
    const st = d1Store(this.env.DB)
    const id =
      this.index.setting('repo-list:entity') ??
      (
        await st.settings.state(
          `${this.index.setting('owner')}/${this.index.setting('repo')}`,
        )
      ).id
    await st.deleteListing(id)
    this.conn = null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.index = new IndexStore(this.ctx.storage.sql as unknown as SQL)
    this.sessions = new SessionStore(this.ctx.storage.sql as unknown as SQL)
    this.outbox = new EventOutbox(this.ctx.storage.sql as unknown as SQL)
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS push_events(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE IF NOT EXISTS health_events(sha TEXT PRIMARY KEY,before_sha TEXT)',
    )
    this.searches.clear()
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as never, env)
    this.index = new IndexStore(ctx.storage.sql as unknown as SQL)
    this.sessions = new SessionStore(ctx.storage.sql as unknown as SQL)
    this.outbox = new EventOutbox(ctx.storage.sql as unknown as SQL)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS push_events(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE IF NOT EXISTS health_events(sha TEXT PRIMARY KEY,before_sha TEXT)',
    )
  }
  sessionList(target: string, limit = 100, offset = 0) {
    return this.sessions.list(target, limit, offset)
  }
  sessionGet(id: string) {
    return this.sessions.get(id)
  }
  async sessionPut(receipt: Receipt, expected: number) {
    const result = this.ctx.storage.transactionSync(() => {
      const previous = this.sessions.get(receipt.id)
      const saved = this.sessions.put(receipt, expected)
      const state = saved.state
      const actions = [...(!previous ? ['started'] : []), ...(receipt.closed && !previous?.closed ? ['ended'] : previous && (state || saved.runtime) ? ['updated'] : [])]
      for (const action of actions) {
        this.outbox.put({id:`session:${receipt.id}:${saved.version}:${action}`,event:'session',repository:receipt.repository,payload:{action,actor:receipt.agent,receipt:{id:receipt.id,target:receipt.target,agent:receipt.agent,...(state ? {state} : {}),started_at:saved.started_at,ended_at:saved.ended_at,updated_at:saved.updated_at,version:saved.version,closed:saved.closed,...(saved.runtime ? {runtime:saved.runtime} : {})}}})
      }
      return saved
    })
    await this.ctx.storage.setAlarm(Date.now()+1)
    return result
  }
  async recordPush(
    id: string,
    updates: { ref: string; before: string; sha: string }[],
    actor: string,
    imported = false,
  ) {
    this.resetWaits()
    if(updates.length){
      const state=await d1Store(this.env.DB).settings.state(`${this.index.setting('owner')}/${this.index.setting('repo')}`)
      await fencePreparedRefs(this.env.DB,state.id)
    }
    const metaUpdate = updates.find(u=>u.ref==='refs/heads/_meta')
    if(metaUpdate) {
      const st=d1Store(this.env.DB),state=await st.settings.state(`${this.index.setting('owner')}/${this.index.setting('repo')}`)
      await st.fenceRepoAccess(state.id,metaUpdate.sha)
      await channelAccessChanged(this.env,state.id)
      this.index.setting('dirty','1')
    }
    // Keep the published branch pointer until its successor has a complete
    // projection. Pending ACL fences remain independent and fail closed.
    const pointers = JSON.parse(
      this.index.setting('fragments:pending-refs') ?? '{}',
    ) as Record<string, string>
    for (const update of updates)
      pointers[update.ref.replace(/^refs\/(heads|tags)\//, '')] = update.sha
    this.index.setting('fragments:pending-refs', JSON.stringify(pointers))
    if(!imported)this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO push_events VALUES (?,?)',
      id,
      JSON.stringify({ updates, actor }),
    )
    if(!imported)await this.wake(Date.now() + 1)
  }
  private async eventWork() {
    const repository = `${this.index.setting('owner')}/${this.index.setting('repo')}`,
      meta = this.index.setting('meta')
    if (meta && meta !== this.index.setting('event-meta')) {
      for (const row of this.index.rows<{ json: string }>(
        "SELECT json FROM meta_files WHERE tip=? AND path LIKE '.gild/events/%'",
        meta,
      ))
        this.outbox.put(JSON.parse(row.json) as Emission)
      this.index.setting('event-meta', meta)
    }
    for (const row of this.index.rows<{ id: string; json: string }>(
      'SELECT id,json FROM push_events LIMIT 20',
    )) {
      const push = JSON.parse(row.json) as {
        updates: { ref: string; before: string; sha: string }[]
        actor: string
      }
      let ready = true
      for (const [i, update] of push.updates.entries()) {
        const zero = '0'.repeat(40),
          commit = update.sha === zero ? null : this.index.commit(update.sha)
        if (update.sha !== zero && !commit) {
          await this.requestObject('commit', update.sha)
          ready = false
          continue
        }
        try {
          const commits: {
              commit: Commit
              files: import('./compare.js').FileDiff[]
            }[] = [],
            seen = new Set<string>(),
            walk = (root: string) => {
              const ids = new Set<string>(),
                todo = [root]
              while (todo.length) {
                const sha = todo.pop()!
                if (ids.has(sha)) continue
                const c = this.index.commit(sha)
                if (!c) throw new ApiError(503, 'Push history is indexing')
                ids.add(sha)
                todo.push(...c.parents)
              }
              return ids
            }
          if (update.sha !== zero) {
            await this.ensureHistory(update.sha)
            if (update.before !== zero) await this.ensureHistory(update.before)
            const old = update.before === zero ? seen : walk(update.before),
              next = walk(update.sha)
            for (const sha of next)
              if (!old.has(sha) && commits.length < 2048) {
                const c = this.index.commit(sha)!
                commits.push({
                  commit: c,
                  files: (await this.apiChanges(c.parents[0] ?? null, sha))
                    .files,
                })
              }
            this.outbox.put(
              pushEvent(
                repository,
                `${row.id}:${i}`,
                update,
                push.actor,
                commit,
                commits,
                update.before !== zero && !next.has(update.before),
              ),
            )
          } else
            this.outbox.put(
              pushEvent(
                repository,
                `${row.id}:${i}`,
                update,
                push.actor,
                null,
                [],
                false,
              ),
            )
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 503) throw e
          ready = false
          await this.wake(Date.now() + 250)
          continue
        }
        const metadata = JSON.parse(
            this.index.metaFile('.gild/index.json') ?? '{"pulls":[]}',
          ) as { pulls: import('./pulls.js').Pull[] },
          refs = Object.fromEntries(
            this.index.refs().map((r) => [r.name, r.hash]),
          )
        for (const pull of metadata.pulls.filter(
          (p) => p.state === 'open' && `refs/heads/${p.head}` === update.ref,
        ))
          this.outbox.put({
            id: `${row.id}:${i}:pr:${pull.number}`,
            event: 'pull_request',
            repository,
            payload: {
              ...common(repository, push.actor),
              action: 'synchronize',
              number: pull.number,
              before: update.before,
              after: update.sha,
              pull_request: pullPayload(
                repository,
                this.index.metaItem(pull.number, 'pr')!
                  .item as import('./pulls.js').Pull,
                { ...refs, [pull.head]: update.sha },
              ),
            },
          })
        if (
          update.ref === `refs/heads/${this.index.setting('defaultBranch')}` &&
          update.sha !== zero
        )
          this.ctx.storage.sql.exec(
            'INSERT OR IGNORE INTO health_events VALUES (?,?)',
            update.sha,
            update.before === zero ? null : update.before,
          )
      }
      if (ready)
        this.ctx.storage.sql.exec('DELETE FROM push_events WHERE id=?', row.id)
    }
    for (const row of this.index.rows<{
      sha: string
      before_sha: string | null
    }>('SELECT sha,before_sha FROM health_events LIMIT 1')) {
      try {
        const current = await this.apiHealth(row.sha),
          before = row.before_sha ? await this.apiHealth(row.before_sha) : null,
          event = healthEvent(
            repository,
            row.sha,
            row.before_sha,
            current,
            before,
            BUILD,
          )
        if (
          event.payload.scores instanceof Array &&
          event.payload.scores.length
        )
          this.outbox.put(event)
        this.ctx.storage.sql.exec(
          'DELETE FROM health_events WHERE sha=?',
          row.sha,
        )
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 503) throw e
        await this.wake(Date.now() + 250)
      }
    }
    if (this.env.EVENTS) {
      if (await this.outbox.flush((event) => emit(event, this.env)))
        await this.wake(Date.now() + 250)
    }
  }
  /** A pulls or issues read found nothing prepared. Repositories untouched
   *  since conversation reads began were never prepared, because the producer
   *  runs after an index pass; run one, at most every five minutes. */
  async conversationsPending(owner: string, repo: string) {
    const last = Number(this.index.setting('conversations:nudged') ?? 0)
    if (Date.now() - last < 5 * 60_000) return
    this.index.setting('conversations:nudged', String(Date.now()))
    if (!this.index.setting('owner')) return this.refresh(owner, repo)
    await this.wake(Date.now() + 1)
  }
  async refresh(owner: string, repo: string, target?: Target) {
    this.resetWaits()
    this.index.setting('owner', owner)
    this.index.setting('repo', repo)
    const state=await d1Store(this.env.DB).settings.state(`${owner}/${repo}`)
    await fencePreparedRefs(this.env.DB,state.id)
    if (target) startIndex(this.index, target)
    this.index.setting(
      'revision',
      String(Number(this.index.setting('revision') ?? 0) + 1),
    )
    this.index.setting('dirty', '1')
    await this.wake(Date.now() + 1)
  }
  status() {
    return {
      refreshing:
        this.index.setting('dirty') === '1' ||
        !!this.index.setting('active') ||
        !!this.index.pending(),
      ready:
        this.index.setting('ready') === '1' &&
        this.index.setting('dirty') !== '1' &&
        !this.index.pending() &&
        !this.index.setting('active'),
      pending: this.index.pending(),
      counts: this.index.counts(),
    }
  }
  async renderSettings() {
    await this.renderWork()
  }
  async defaultBranch(branch: string) {
    this.index.setting('defaultBranch', branch)
    await this.listing()
  }
  /** Successful metadata writes publish the committed ACL before responding,
   * so a revocation cannot expose a stale public card during a refresh. Code
   * facts/counts still come from the last indexed snapshot. */
  async listingAcl(meta: string, acl: ListingSnapshot['acl']) {
    this.index.setting('repo-list:acl', JSON.stringify({ meta, acl }))
    this.index.setting('dirty', '1')
    await this.wake(Date.now() + 1)
    try { await this.listing() } finally { await this.wake(Date.now()+1) }
  }
  /** A push fence is satisfied by authoritative indexed refs, independently
   * of HTML rendering. Never clear a newer/unobserved ref or metadata push. */
  protected acknowledgeIndexedRefs(){
    const raw=this.index.setting('fragments:pending-refs')??'{}'
    const pending=JSON.parse(raw) as Record<string,string>
    for(const [ref,sha] of Object.entries(pending)){
      const observed=ref==='_meta'?this.index.setting('meta'):this.index.resolve(ref)
      if(observed===sha||/^0+$/.test(sha)&&!observed)delete pending[ref]
    }
    const next=JSON.stringify(pending)
    if(next!==raw)this.index.setting('fragments:pending-refs',next)
  }
  /** Bootstrap old indexes once. Listings never wait for a refresh or read git.
   * All subsequent pages read this projection in one D1 owner batch. */
  async listing(id?: string, owner?: string, repo?: string) {
    if (id) this.index.setting('repo-list:entity', id)
    if (owner && repo) this.address(owner, repo)
    const st=d1Store(this.env.DB),state=await st.settings.state(`${this.index.setting('owner')}/${this.index.setting('repo')}`)
    const identity=this.index.setting('repo-list:entity')??state.id
    const refsEpoch=await preparedRefsEpoch(this.env.DB,identity)
    const snapshot = listingSnapshot(this.index)
    if (!snapshot) {
      // Catalog membership establishes existence, but not public access. Start
      // the cold index in the background and omit it until its ACL is known.
      if (owner && repo && !this.status().refreshing)
        await this.refresh(owner, repo)
      return null
    }
    const pendingAcl = this.index.setting('repo-list:acl')
    if (pendingAcl) {
      const pending = JSON.parse(pendingAcl) as {
        meta: string
        acl: ListingSnapshot['acl']
      }
      if (snapshot.meta === pending.meta)
        this.index.setting('repo-list:acl', '')
      else { snapshot.acl = pending.acl; snapshot.meta = pending.meta }
    }
    if (snapshot.tip && !this.index.historyReady(snapshot.tip)) {
      this.index.requestHistory(snapshot.tip)
      await this.wake(Date.now() + 1)
    }
    const pendingRefs = JSON.parse(this.index.setting('fragments:pending-refs') ?? '{}') as Record<string,string>
    // Direct _meta pushes cannot leave an older ACL publicly listed.
    if(pendingRefs._meta && pendingRefs._meta!==snapshot.meta) snapshot.acl={visibility:'private'}
    if(!pendingRefs._meta || pendingRefs._meta===snapshot.meta)
      await st.publishRepoAccess(this.index.setting('repo-list:entity') ?? state.id,snapshot.meta,snapshot.acl)
    const raw = JSON.stringify(snapshot)
    if (
      raw !== this.index.setting('repo-list:published') ||
      (id && id !== this.index.setting('repo-list:published-entity'))
    ) {
      const revision = Number(this.index.setting('repo-list:revision') ?? 0) + 1
      this.index.setting('repo-list:revision', String(revision))
      const st = d1Store(this.env.DB)
      const entity =
        this.index.setting('repo-list:entity') ??
        (
          await st.settings.state(
            `${this.index.setting('owner')}/${this.index.setting('repo')}`,
          )
        ).id
      this.index.setting('repo-list:entity', entity)
      await st.putListing(entity, revision, snapshot)
      // A failed D1 write leaves this unset and is retried by the next alarm.
      if (this.index.setting('repo-list:revision') === String(revision)) {
        this.index.setting('repo-list:published', raw)
        this.index.setting('repo-list:published-entity', entity)
      }
    }
    if(this.status().ready&&!Object.keys(pendingRefs).length&&snapshot.meta===(this.refs().meta||null)){
      const metadata=JSON.parse(this.index.metaFile('.gild/index.json')??'{"pulls":[]}') as {pulls:{number:number;head:string;base:string}[]}
      await publishPreparedPullHeads(this.env.DB,identity,refsEpoch,snapshot.meta,metadata.pulls)
      await publishPreparedRefs(this.env.DB,identity,refsEpoch,this.refs())
      // Index ingestion owns catalogue readiness too. API reads never trigger
      // inventory observation, including legacy/import completion.
      await ensurePreparedOwnerCatalogue(this.env.DB,this.index.setting('owner')!,Date.now(),this.env.ARTIFACTS_TOKEN,this.index.setting('repo')!)
    }
    return snapshot
  }
  storageObjects() {
    return this.index.rows<{ hash: string; size: number }>('SELECT hash,max(size) AS size FROM (SELECT hash,size FROM blobs UNION ALL SELECT hash,size FROM object_sizes) GROUP BY hash')
  }
  recordStorageObjects(objects: { hash: string; size: number }[]) {
    for (const o of objects) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO object_sizes VALUES (?,?)',o.hash,o.size)
  }
  storageBytes() { return this.storageObjects().reduce((sum,o) => sum + o.size,0) }
  async deltaBase(hash: string, tips: string[]) {
    const raw = this.index.rawBlob(hash)
    if (raw) return { type: 'blob', bytes: new Uint8Array(Buffer.from(raw.content,'base64')) }
    // A thin pack's base can be any object in history (the boundary commits'
    // trees), not only one in a tip's tree: read it by hash from Artifacts.
    const exact = await this.objectByHash(hash).catch(() => null)
    if (exact) return exact
    const { token,url } = await this.connection()
    for (const tip of tips) {
      const source = await snapshotSource(url,tip,token)
      try { return await source.raw(hash) } catch { /* A thin base may belong to another updated ref. */ }
    }
    throw new ApiError(400,'Delta base unavailable')
  }
  refs() {
    return {
      refs: this.index.refs(),
      defaultBranch: this.index.setting('defaultBranch') ?? 'main',
      meta: this.index.setting('meta'),
      ready: this.index.setting('ready') === '1',
    }
  }
  async fragmentAccess(owner?: string, repo?: string) {
    if (owner && repo) this.address(owner, repo)
    if (this.index.setting('ready') !== '1') {
      if (owner && repo && !this.status().refreshing) {
        // A cold legacy repository needs a job; a typo must remain Missing and
        // must not enqueue work. Normal indexed pointers never touch Git.
        try {
          const { url, token } = await this.connection()
          await git.listServerRefs({
            http,
            url,
            ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
          })
        } catch (error) {
          if (
            (error instanceof ApiError && error.status === 404) ||
            (error as { data?: { statusCode?: number } })?.data?.statusCode ===
              404
          )
            throw new ApiError(404, 'Repository not found')
          throw error
        }
        await this.refresh(owner, repo)
      }
      throw new ApiError(503, 'Repository is indexing')
    }
    const pendingRefs = JSON.parse(
      this.index.setting('fragments:pending-refs') ?? '{}',
    ) as Record<string, string>
    if (pendingRefs._meta && pendingRefs._meta !== this.index.setting('meta'))
      throw new ApiError(503, 'Committed ACL is indexing')
    const pending = this.index.setting('repo-list:acl')
    const acl = pending
      ? (JSON.parse(pending) as { acl: ListingSnapshot['acl'] }).acl
      : (JSON.parse(
          this.index.metaFile('.gild/acl.json') ?? '{}',
        ) as ListingSnapshot['acl'])
    let scope = this.index.setting('fragments:private-scope')
    if (!scope)
      this.index.setting(
        'fragments:private-scope',
        (scope = crypto.randomUUID()),
      )
    return {
      owner: this.index.setting('owner')!,
      repo: this.index.setting('repo')!,
      acl,
      scope: acl.private || acl.visibility === 'private' ? scope : '',
    }
  }
  /** Provenance of every hash, including preexisting R2 hits. Public HTTP
   * consults this registry before its edge cache. Private keys register only
   * under their ACL scope, so retention can sweep them without exposing them. */
  async registerFragment(fragment: Fragment) {
    const {scope}=await this.fragmentAccess()
    const st=d1Store(this.env.DB),state=await st.settings.state(`${this.index.setting('owner')}/${this.index.setting('repo')}`)
    await st.registerFragment(fragmentKey(fragment, scope),state.id)
  }
  /** Mutable names resolve to stored addresses in one RPC. No git, score,
   * markdown, highlighting, or per-field remote reads on this path. */
  async fragmentPointer(
    ref?: string,
    path = '',
    page = 'code',
    sha?: string,
    renderVersion?: string,
  ): Promise<PagePointer | null> {
    if (renderVersion) await this.rendererVersion(renderVersion)
    const { scope } = await this.fragmentAccess(),
      current = ref ?? this.index.setting('defaultBranch') ?? 'main',
      tip =
        this.index.resolve(current) ??
        (/^[a-f0-9]{40}$/.test(current) ? current : null)
    if (!tip || /^0+$/.test(tip)) {
      if (this.index.refs().length) return null
      const version = this.index.setting('fragments:version') ?? RENDER_VERSION,
        home = this.index.setting(`fragments:${version}:home:${current}`)
      if (!home) throw new ApiError(503, 'Empty home is being prepared')
      return {
        version,
        defaultBranch: this.index.setting('defaultBranch') ?? 'main',
        entity:
          this.index.setting('repo-list:entity') ??
          `${this.index.setting('owner')}/${this.index.setting('repo')}`,
        repository: `${this.index.setting('owner')}/${this.index.setting('repo')}`,
        scope,
        tip: 'empty',
        meta: this.index.setting('meta') || null,
        ref: current,
        path: '',
        home: { kind: 'home', hash: home, version },
        selected: null,
        manifest: { kind: 'manifest', hash: EMPTY_TREE, version },
        bundle: null,
        shell: { kind: 'shell', hash: this.index.setting(`fragments:shell:${version}`) ?? version, version },
      }
    }
    if (this.index.setting('repo-list:acl'))
      throw new ApiError(503, 'Metadata is indexing')
    const version = this.index.setting('fragments:version') ?? RENDER_VERSION
    if (page === 'commit' && sha && /^[a-f0-9]{4,39}$/.test(sha)) {
      const matches = this.index.rows<{ hash: string }>(
        'SELECT hash FROM commits WHERE hash LIKE ? LIMIT 2',
        sha + '%',
      )
      if (matches.length !== 1) return null
      sha = matches[0].hash
    }
    if (/^[a-f0-9]{40}$/.test(current) || (page === 'commit' && sha)) {
      const historical = JSON.parse(
        this.index.setting('fragments:history') ?? '[]',
      ) as string[]
      const target = page === 'commit' ? sha! : current
      if (!historical.includes(target)) {
        this.index.setting(
          'fragments:history',
          JSON.stringify([...historical.slice(-99), target]),
        )
        await this.requestObject('commit', target)
        await this.hydrate(target)
        await this.wake(Date.now() + 1)
      }
    }
    const home = this.index.setting(`fragments:${version}:home:${current}`),
      commit = this.index.commit(tip),
      manifest = commit
        ? (this.index.view(
            `fragments:${version}:manifest:${commit.tree}`,
          ) as TipManifest | null)
        : null
    if (!home || !manifest || !home.startsWith(tip + '.')) {
      await this.wake(Date.now() + 1)
      throw new ApiError(503, 'Fragments are being prepared')
    }
    let selected: PagePointer['selected'] = null
    path = path.replace(/^\/+|\/+$/g, '')
    if (page === 'commit') {
      if (!sha || !/^[a-f0-9]{40}$/.test(sha)) return null
      selected = { kind: 'commit', hash: sha }
    } else if (page === 'score') {
      const hash = this.index.setting(`fragments:${version}:score:${tip}`)
      if (!hash) throw new ApiError(503, 'Score is being prepared')
      selected = { kind: 'score', hash }
    } else if (path)
      selected =
        manifest.files.find((f) => f.path === path)?.fragment ??
        (manifest.trees.some((t) => t.path === path)
          ? {
              kind: 'tree',
              hash: manifest.trees.find((t) => t.path === path)!.hash,
            }
          : null)
    else {
      const readme = manifest.files.find((f) =>
        /^readme(?:\.md|\.markdown|\.txt)?$/i.test(f.path),
      )
      if (readme) {
        selected = blobFragment(readme.blob, readme.path, true)
        path = readme.path
      }
    }
    return {
      version,
      defaultBranch: this.index.setting('defaultBranch') ?? 'main',
      entity:
        this.index.setting('repo-list:entity') ??
        `${this.index.setting('owner')}/${this.index.setting('repo')}`,
      repository: `${this.index.setting('owner')}/${this.index.setting('repo')}`,
      scope,
      tip,
      meta: this.index.setting('meta') || null,
      ref: current,
      path,
      score:
        page === 'commit' &&
        this.index.setting(`fragments:${version}:review:${sha}`)
          ? {
              kind: 'score',
              hash: this.index.setting(`fragments:${version}:review:${sha}`)!,
              version,
            }
          : null,
      home: { kind: 'home', hash: home, version },
      selected: selected ? { ...selected, version } : null,
      manifest: { kind: 'manifest', hash: manifest.tree, version },
      bundle: manifest.bundle ? { ...manifest.bundle, version } : null,
      shell: { kind: 'shell', hash: this.index.setting(`fragments:shell:${version}`) ?? version, version },
    }
  }
  async rendererVersion(version: string, backfill = false, shell?: string) {
    if (!/^v[1-9][0-9]*$/.test(version))
      throw new ApiError(400, 'Invalid render version')
    if (
      (this.index.setting('fragments:version') ?? RENDER_VERSION) !== version
    ) {
      this.index.setting('fragments:version', version)
      backfill = true
    }
    if (shell && shell !== this.index.setting(`fragments:shell:${version}`)) {
      if (!new RegExp('^' + version + '\\.[a-f0-9]{64}$').test(shell)) throw new ApiError(400, 'Invalid shell hash')
      this.index.setting(`fragments:shell:${version}`, shell)
      backfill = true
    }
    if (backfill) await this.renderWork()
  }
  async renderPlan(job: RenderJob, cursor = 0): Promise<RenderPlan> {
    const { scope } = await this.fragmentAccess()
    if (job.newTip === 'empty') {
      const version = this.index.setting('fragments:version') ?? RENDER_VERSION,
        home = this.index.setting(
          `fragments:${version}:home:${this.index.setting('defaultBranch') ?? 'main'}`,
        )
      if (!home) return { scope, items: [], cursor: null }
      return {
        scope,
        items: [
          { fragment: { kind: 'home', hash: home, version }, sha: 'empty' },
          {
            fragment: { kind: 'manifest', hash: EMPTY_TREE, version },
            sha: 'empty',
          },
        ],
        cursor: null,
      }
    }
    const refs = this.index.refs().filter((r) => r.hash === job.newTip)
    if (
      this.index.setting(
        `fragments:${this.index.setting('fragments:version') ?? RENDER_VERSION}:home:${job.newTip}`,
      )
    )
      refs.push({ name: job.newTip, hash: job.newTip, kind: 'branch' })
    if (!refs.length) return { scope, items: [], cursor: null } // superseded tip: cold-history renderer handles it
    const all = refs.flatMap((r) => {
      const home = this.index.setting(
        `fragments:${this.index.setting('fragments:version') ?? RENDER_VERSION}:home:${r.name}`,
      )
      return home ? changedItems(this.index, job.oldTip, job.newTip, home) : []
    })
    if (!all.length) throw new ApiError(503, 'Render projection is pending')
    return {
      scope,
      items: all.slice(cursor, cursor + 50).map((item) => ({
        ...item,
        fragment: {
          ...item.fragment,
          version: this.index.setting('fragments:version') ?? RENDER_VERSION,
        },
      })),
      cursor: cursor + 50 < all.length ? cursor + 50 : null,
    }
  }
  async renderData(
    item: RenderItem,
  ): Promise<{ scope: string; data: RenderData }> {
    const { scope } = await this.fragmentAccess(),
      f = item.fragment
    const manifest =
      item.sha === 'empty' && !this.index.refs().length
        ? emptyManifest()
        : manifestAt(this.index, item.sha)
    if (!manifest) {
      await this.requestObject('commit', item.sha)
      await this.hydrate(item.sha)
      throw new ApiError(503, 'History snapshot is indexing')
    }
    let data: RenderData
    if (f.kind === 'home') {
      const home = this.index.view(
        `fragments:${this.index.setting('fragments:version') ?? RENDER_VERSION}:home:${f.hash}`,
      ) as HomeData | null
      if (
        !home ||
        home.repository !==
          `${this.index.setting('owner')}/${this.index.setting('repo')}` ||
        (home.commit?.hash ?? 'empty') !== item.sha
      )
        throw new ApiError(404, 'Home not found')
      data = { kind: 'home', home }
    } else if (f.kind === 'tree') {
      if (!manifest.trees.some((t) => t.hash === f.hash))
        throw new ApiError(404, 'Tree not in snapshot')
      data = { kind: 'tree', entries: this.index.tree(f.hash)! }
    } else if (f.kind === 'manifest') {
      if (manifest.tree !== f.hash)
        throw new ApiError(404, 'Manifest not found')
      data = { kind: 'manifest', manifest }
    } else if (f.kind === 'blob' || f.kind === 'source') {
      const file = manifest.files.find((file) => file.path === item.path)
      if (
        !file ||
        (f.kind === 'source'
          ? f.hash !== file.blob
          : f.hash !== file.fragment.hash &&
            f.hash !== blobFragment(file.blob, file.path, true).hash)
      )
        throw new ApiError(404, 'File not in snapshot')
      const raw = this.index.rawBlob(file.blob)
      if (!raw) throw new ApiError(503, 'Blob is indexing')
      if (f.kind === 'source')
        data = {
          kind: 'source',
          content: raw.content,
          binary: !!this.index.rows<{ binary: number }>(
            'SELECT binary FROM blobs WHERE hash=?',
            file.blob,
          )[0]?.binary,
        }
      else
        data = {
          kind: 'blob',
          text: file.text
            ? Buffer.from(raw.content, 'base64').toString()
            : null,
          bytes: file.bytes,
          binary: !file.text && file.bytes <= 1024 * 1024,
          language: languageFor(file.path),
          markdown:
            f.hash.endsWith('.readme') && /\.(md|markdown)$/i.test(file.path),
        }
    } else if (f.kind === 'bundle') {
      if (!manifest.bundle || f.hash !== manifest.tree)
        throw new ApiError(404, 'Bundle not found')
      data = {
        kind: 'bundle',
        manifest,
        files: manifest.files
          .filter((file) => file.text && bundlePath(file.path))
          .map((file) => ({
            blob: file.blob,
            content: Buffer.from(
              this.index.rawBlob(file.blob)!.content,
              'base64',
            ).toString(),
            html: '',
          })),
      }
    } else if (f.kind === 'score') {
      const stored = this.index.view(
        `fragments:${this.index.setting('fragments:version') ?? RENDER_VERSION}:score-data:${f.hash}`,
      ) as Extract<RenderData, { kind: 'score' }> | null
      if (!stored || stored.sha !== item.sha)
        throw new ApiError(404, 'Score build not found')
      data = stored
    } else if (f.kind === 'commit' || f.kind === 'glance') {
      const commit = this.index.commit(item.sha)!,
        parent = commit.parents[0] ?? null
      if (
        f.hash !==
        (f.kind === 'commit' ? item.sha : `${parent ?? 'root'}.${item.sha}`)
      )
        throw new ApiError(404, 'Commit address not found')
      const change = await this.apiChanges(parent, item.sha)
      data =
        f.kind === 'glance'
          ? { kind: 'glance', change }
          : { kind: 'commit', commit, change, report: null, before: null }
    } else throw new ApiError(404, 'Unknown fragment')
    return { scope, data }
  }
  async renderProjection() {
    return this.renderWork()
  }
  protected async renderWork() {
    try {
      const complete = await this.publishProjection()
      const attempt = complete ? 0 : Number(this.index.setting('fragments:retry') ?? 0) + 1
      this.index.setting('fragments:retry', String(attempt))
      if (!complete) await this.wake(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6)))
      return complete
    } catch (error) {
      const attempt = Number(this.index.setting('fragments:retry') ?? 0) + 1
      this.index.setting('fragments:retry', String(attempt))
      await this.wake(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6)))
      throw error
    }
  }
  private async publishProjection() {
    if (!this.env.RENDER_QUEUE) return true
    let complete = true
    const owner = this.index.setting('owner')!,
      repo = this.index.setting('repo')!,
      st = d1Store(this.env.DB),
      state = await st.settings.state(`${owner}/${repo}`),
      version = this.index.setting('fragments:version') ?? RENDER_VERSION,
      meta = this.index.setting('meta') || null
    if (!this.index.refs().length) {
      const home = await publishHome(
          this.index,
          this.index.setting('defaultBranch') ?? 'main',
          null,
          state.description ?? '',
          state.archived,
        ),
        signature = JSON.stringify([version, home])
      if (
        home &&
        signature !== this.index.setting('fragments:empty-enqueued')
      ) {
        await this.env.RENDER_QUEUE.send({
          entity: state.id,
          repository: `${owner}/${repo}`,
          oldTip: null,
          newTip: 'empty',
          meta,
        })
        this.index.setting('fragments:empty-enqueued', signature)
      }
      const pointer = await this.fragmentPointer()
      if (pointer) this.index.setting('fragments:published', await publishHeads(this.env.DB, state.id, [{ pointer, manifest: emptyManifest() }], Date.now(), undefined, this.index.setting('fragments:published')))
      return true
    }
    const historical = JSON.parse(
      this.index.setting('fragments:history') ?? '[]',
    ) as string[]
    for (const ref of [
      ...this.index.refs(),
      ...historical.map((hash) => ({
        name: hash,
        hash,
        kind: 'branch' as const,
      })),
    ]) {
      if (!manifestAt(this.index, ref.hash)) { complete = false; continue }
      try {
        const report = await this.apiHealth(ref.hash),
          parent = this.index.commit(ref.hash)?.parents[0]
        if (ref.name === (this.index.setting('defaultBranch') ?? 'main'))
          this.index.setting('fragments:score-note', scoreNote(report) ?? '')
        let before: Report | null = null
        if (parent)
          try {
            before = await this.apiHealth(parent)
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 503) throw error
          complete = false
        }
      if (
        report?.incomplete === 'c-family-unavailable' ||
        before?.incomplete === 'c-family-unavailable'
      )
        complete = false
      for (const review of [false, true]) {
        const data = {
            kind: 'score' as const,
            sha: ref.hash,
            report,
            ...(review ? { before, review } : {}),
          },
          hash = `${ref.hash}.${BUILD}.${(await digest(JSON.stringify(data))).slice(0, 24)}`,
          variant = review ? 'review' : 'score'
        this.index.view(`fragments:${version}:score-data:${hash}`, data)
        this.index.setting(`fragments:${version}:${variant}:${ref.hash}`, hash)
      }
      const signature = JSON.stringify([
          version,
          BUILD,
          owner,
          repo,
          ref.hash,
          meta,
          this.index.refs(),
          state.description,
          state.archived,
          report,
          before,
        ]),
        key = `fragments:enqueued:${ref.kind}:${ref.name}`
      if (this.index.setting(key) === signature) continue
      if (!manifestAt(this.index, ref.hash)) continue
      const people = [
          ...new Set(this.index.log(ref.hash, 100).map((c) => c.author_name)),
        ].slice(0, 8),
        pictures = new Map(
          await Promise.all(
            people.map(
              async (name) =>
                [
                  name,
                  (await profileView(st, name.replace(/^@/, '').toLowerCase()))
                    .picture,
                ] as const,
            ),
          ),
        )
      const home = await publishHome(
        this.index,
        ref.name,
        report,
        state.description ?? '',
        state.archived,
        pictures,
      )
      if (!home) continue
      const oldTip = this.index.setting(`fragments:tip:${ref.kind}:${ref.name}`)
      // Queue send is awaited before recording publication. An interrupted alarm
      // resends idempotent immutable jobs; a send failure is never lost.
      await this.env.RENDER_QUEUE.send({
        entity: state.id,
        repository: `${owner}/${repo}`,
        oldTip,
        newTip: ref.hash,
        meta,
      })
      this.index.setting(key, signature)
      this.index.setting(`fragments:tip:${ref.kind}:${ref.name}`, ref.hash)
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 503) throw error
        complete = false
      }
    }
    this.acknowledgeIndexedRefs()
    await this.listing()
    // Published branch names are the read path, independent of hydration. The
    // immutable objects may render on demand; no reader sees pending addresses.
    const heads: { pointer: PagePointer; manifest: TipManifest; fragments?: Fragment[] }[] = []
    const currentRefs = this.index.refs().filter(r => r.name !== '_meta')
    // Git can have a branch and tag with the same short name. Match resolve's
    // branch preference without publishing duplicate primary keys.
    const resolvedRefs = [...new Map(currentRefs.filter(r => this.index.resolve(r.name) === r.hash).map(r => [r.name, r])).values()]
    for (const ref of resolvedRefs) {
      const manifest = manifestAt(this.index, ref.hash)
      if (!manifest) { complete = false; continue }
      try {
        const pointer = await this.fragmentPointer(ref.name)
        if (pointer) {
          const score = this.index.setting(`fragments:${version}:score:${pointer.tip}`)
          heads.push({ pointer: { ...pointer, score: score ? { kind: 'score', hash: score, version } : null }, manifest,
            fragments: changedItems(this.index, null, ref.hash, pointer.home.hash).map(item => item.fragment) })
        }
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 503) throw error
        complete = false
      }
    }
    if (heads.length !== resolvedRefs.length) complete = false
    if (heads[0]) heads[0].fragments!.push(...currentRefs.flatMap(ref =>
      changedItems(this.index, null, ref.hash, heads[0].pointer.home.hash).map(item => item.fragment)))
    const published = await publishHeads(this.env.DB, state.id, heads, Date.now(), resolvedRefs.map(r => r.name), this.index.setting('fragments:published'))
    this.index.setting('fragments:published', published)
    return complete
  }
  private computed = new Map<string, Promise<unknown>>()
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = this.computed.get(key)
    if (pending) return pending as Promise<T>
    const promise = work().finally(() => this.computed.delete(key))
    this.computed.set(key, promise)
    return promise
  }
  private apiIndex(): Index {
    const keys = [
      'sessionList',
      'sessionGet',
      'sessionPut',
      'requestObject',
      'apiLog',
      'ensureHistory',
      'apiChanges',
      'apiHealth',
      'file',
      'refs',
      'tree',
      'commit',
      'rawBlob',
      'snapshotReady',
      'log',
      'sizes',
      'metaFile',
      'metaItem',
      'search',
      'hydrate',
      'view',
    ] as const
    return Object.fromEntries(
      keys.map((key) => [
        key,
        async (...args: unknown[]) => Reflect.apply(this[key], this, args),
      ]),
    ) as Index
  }
  apiChanges(from: string | null, to: string): Promise<Change> {
    return this.once(`changes:${from}:${to}`, () =>
      computeChanges(this.apiIndex(), from, to),
    )
  }
  apiHealth(sha: string): Promise<Report | null> {
    return this.once(`health:${sha}`, async () => {
      const owner = this.index.setting('owner')!,
        repo = this.index.setting('repo')!,
        key = scoreCacheKey(owner, repo, sha),
        st = d1Store(this.env.DB),
        cached = await st.getScore(key)
      const state=await st.settings.state(`${owner}/${repo}`)
      if (cached) {
        const report=JSON.parse(cached) as Report|null
        await publishPreparedHealth(this.env.DB,state.id,key,sha,report)
        return report
      }
      const index = this.apiIndex(),
        commit = await snapshot(index, sha),
        files: { path: string; text: string }[] = []
      let omittedHeavy: CFamilyIssue | undefined
      for (const e of await entries(index, commit.tree, true)) {
        if (e.type !== 'blob' || !READS.test(e.path)) continue
        const b = Buffer.from((await raw(index, e.sha, sha)).content, 'base64')
        if (
          moduleFor(e.path) !== 'core' &&
          b.length > CQX_MAX_SOURCE_FILE_BYTES
        )
          omittedHeavy = 'c-family-too-large'
        if (
          b.length <= CQX_MAX_SOURCE_FILE_BYTES &&
          !b.subarray(0, 8000).includes(0)
        )
          files.push({ path: e.path, text: b.toString() })
      }
      let report: Report | null = null
      try {
        const r = await scoreFiles(
          files,
          files.find((f) => f.path === 'cqx.json')?.text ?? null,
          `${owner}/${repo}`,
          this.env.CQX_HEAVY,
          omittedHeavy,
        )
        report = r.lines || r.incomplete ? r : null
      } catch (e) {
        if (!/no Cargo\.toml/.test((e as Error).message)) throw e
      }
      if (!report?.incomplete) await st.putScore(key, JSON.stringify(report))
      await publishPreparedHealth(this.env.DB,state.id,key,sha,report)
      return report
    })
  }
  /** A page can request preparation, but cannot run the scorer itself. */
  async prepareScore(sha: string) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new ApiError(400, 'Invalid commit')
    const history = JSON.parse(this.index.setting('fragments:history') ?? '[]') as string[]
    if (!history.includes(sha)) this.index.setting('fragments:history', JSON.stringify([...history.slice(-99), sha]))
    await this.requestObject('commit', sha)
    await this.hydrate(sha)
    await this.wake(Date.now() + 1)
  }
  /** Cached immutable diff facts, prepared by the alarm rather than a clone
   * or tree walk in Next's request. Moving branch names resolve here first. */
  async pageChange(kind: 'commit' | 'pull', head: string, base?: string): Promise<Change | CommitChange | null> {
    let to = this.index.resolve(head)
    if (!to && kind === 'commit' && /^[a-f0-9]{4,39}$/.test(head)) {
      const matches = this.index.rows<{ hash: string }>('SELECT hash FROM commits WHERE hash LIKE ? LIMIT 2', head + '%')
      if (matches.length === 1) to = matches[0].hash
    }
    const from = kind === 'pull' && base ? this.index.resolve(base) : null
    if (!to || (kind === 'pull' && !from)) return null
    const key = `page-change:v1:${kind}:${from ?? 'parent'}:${to}`
    const hit = this.index.view(key) as Change | CommitChange | null
    if (hit) return hit
    const pending = JSON.parse(this.index.setting('page:changes') ?? '{}') as Record<string, {kind: 'commit'|'pull';to:string;from:string|null}>
    // Bound requests awaiting historical preparation without dropping a
    // previous request's alarm. The consumer removes only completed entries.
    if (!pending[key] && Object.keys(pending).length >= 100) throw new PreparationQueueFull()
    pending[key] = { kind, to, from }
    this.index.setting('page:changes', JSON.stringify(pending))
    await this.requestObject('commit', to)
    if (from) await this.requestObject('commit', from)
    await this.wake(Date.now() + 1)
    throw new ApiError(503, 'Diff is being prepared; retry shortly')
  }
  /** Current complete _meta inventory, prepared after strict refs publication.
   * Stage at most100 total thread/comment/review rows per alarm invocation. */
  protected async prepareConversationReads(){
    const meta=this.index.setting('meta')||null,owner=this.index.setting('owner')!,repo=this.index.setting('repo')!
    const store=d1Store(this.env.DB),state=await store.settings.state(`${owner}/${repo}`)
    const refs=await this.env.DB.prepare('SELECT epoch,meta,pending,data FROM prepared_repository_refs WHERE id=?').bind(state.id)
      .first<{epoch:number;meta:string|null;pending:number;data:string|null}>()
    if(!refs||refs.pending||refs.meta!==meta||!refs.data){await this.wake(Date.now()+250,'content:refs');return}
    const observed=await this.env.DB.prepare('SELECT description,default_branch,created_at,updated_at FROM prepared_repositories WHERE id=? AND active=1').bind(state.id)
      .first<{description:string|null;default_branch:string;created_at:string|null;updated_at:string|null}>()
    if(!observed){await this.wake(Date.now()+250,'content:observed');return}
    // Capture immutable metadata bytes synchronously before any staging awaits.
    const rows=meta?this.index.rows<{path:string;json:string}>('SELECT path,json FROM meta_files WHERE tip=? ORDER BY path',meta):[]
    const files=new Map(rows.map(r=>[r.path,r.json])),rawIndex=files.get('.gild/index.json')
    // A tip whose files are not loaded yet cannot certify empty; a loaded tip
    // without an index (a new repository's _meta holds only its ACL) has no
    // issues or pulls yet.
    if(meta&&!rawIndex&&!rows.length)return
    const summary=rawIndex?JSON.parse(rawIndex) as import('./metastore.js').MetaIndex:{issues:[],pulls:[]}
    const threads:ConversationThread[]=[],comments:ConversationComment[]=[],reviews:ConversationReview[]=[]
    for(const [kind,items] of [['issue',summary.issues],['pr',summary.pulls]] as const){
      for(const summaryItem of items){
        const prefix=`.gild/${summaryItem.number}/${kind}/`,rawItem=files.get(prefix+kind+'.json')
        if(!rawItem)return // An incomplete source inventory cannot certify empty.
        const item=JSON.parse(rawItem),childComments=rows.filter(r=>r.path.startsWith(prefix+'c-')).map(r=>JSON.parse(r.json))
        const childReviews=kind==='pr'?rows.filter(r=>r.path.startsWith(prefix+'r-')).map(r=>JSON.parse(r.json)):[]
        if(summaryItem.comments!==childComments.length)return
        childComments.forEach((item,ordinal)=>comments.push({number:summaryItem.number,kind,ordinal,item}))
        childReviews.forEach((item,ordinal)=>reviews.push({number:summaryItem.number,ordinal,item}))
        if(kind==='issue')threads.push({kind,item,updatedAt:summaryItem.updatedAt,comments:childComments.length,reviews:0})
        else{
          const head=this.index.resolve(item.head),base=this.index.resolve(item.base)
          if(!head||!base)return
          threads.push({kind,item,updatedAt:summaryItem.updatedAt,comments:childComments.length,reviews:childReviews.length,head,base})
        }
      }
    }
    const repository={defaultBranch:state.defaultBranch??observed.default_branch,description:state.description??observed.description,
      stars:await store.starCount(state.id),createdAt:observed.created_at,updatedAt:observed.updated_at}
    const generation=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([state.id,refs.epoch,meta,refs.data,repository])))).toString('hex')
    const ticket={id:state.id,generation,epoch:refs.epoch,meta,refs:refs.data},marker=`conversations:${generation}`
    if(this.index.setting(marker)==='ready')return
    if(!await beginPreparedConversations(this.env.DB,ticket,repository,{threads:threads.length,comments:comments.length,reviews:reviews.length}))return
    const total=threads.length+comments.length+reviews.length,start=Number(this.index.setting(marker)??0),end=Math.min(start+100,total)
    await stagePreparedConversationThreads(this.env.DB,ticket,threads.slice(start,Math.min(end,threads.length)))
    await stagePreparedConversationComments(this.env.DB,ticket,comments.slice(Math.max(0,start-threads.length),Math.max(0,end-threads.length)))
    await stagePreparedConversationReviews(this.env.DB,ticket,reviews.slice(Math.max(0,start-threads.length-comments.length),Math.max(0,end-threads.length-comments.length)))
    this.index.setting(marker,String(end))
    if(end===total&&await finishPreparedConversations(this.env.DB,ticket)){this.index.setting(marker,'ready');return}
    await this.wake(Date.now()+250,end===total?'conversations:finish':undefined)
  }
  /** Bring code search in line with the default branch's tree: git is the
   *  record and search rows are derived from it (lib/search-index.ts). Runs
   *  after every completed refresh, so a missed push or an interrupted sync is
   *  repaired the next time the repository is indexed. */
  protected async prepareSearch() {
    const db = this.env.SEARCH_DB
    const owner = this.index.setting('owner'), repo = this.index.setting('repo')
    if (!db || !owner || !repo) return
    const st = d1Store(this.env.DB), state = await st.settings.state(`${owner}/${repo}`)
    const { syncSearch, removeSearch } = await import('./search-index.js')
    if (state.deletedAt !== null) return removeSearch(db, state.id)
    const branch = this.index.setting('defaultBranch') ?? 'main', tip = this.index.resolve(branch)
    const root = tip ? this.index.commit(tip)?.tree : null
    const access = await st.getRepoAccess(state.id)
    if (!tip || !root || !access) return
    this.index.flatten(root)
    const org = await st.getOrg(owner)
    const result = await syncSearch(db, {
      repoId: state.id, repository: `${owner}/${repo}`, ownerKind: org ? 'org' : 'user', branch, tip,
      acl: access.acl, accessMeta: access.meta, pending: access.pending,
      files: this.index.rows<{ path: string; blob: string }>('SELECT path, blob FROM files WHERE root_tree=?', root),
      text: hash => {
        const b = this.index.blobText(hash)
        if (b?.kind !== 'text') return null
        const info = this.index.rows<{ size: number; language: string | null }>('SELECT size, language FROM blobs WHERE hash=?', hash)[0]
        return {
          content: b.text, language: info?.language ?? '', size: info?.size ?? b.text.length,
          symbols: this.index.rows<{ name: string; kind: string; line: number }>('SELECT name, kind, line FROM symbols WHERE blob=?', hash),
        }
      },
    })
    if (!result.done) await this.wake(Date.now() + 1000)
  }
  /** Background only: hydrate advertised snapshots before any content GET.
   * One snapshot and at most64 blob publications per invocation. Immutable
   * receipts survive moving refs; current D1 policy still guards every read. */
  protected async prepareContentReads(){
    const owner=this.index.setting('owner')!,repo=this.index.setting('repo')!
    const id=(await d1Store(this.env.DB).settings.state(`${owner}/${repo}`)).id
    const tips=[...new Set([...this.index.refs().map(r=>r.hash),...(this.index.setting('meta')?[this.index.setting('meta')!]:[])])]
    const position=Number(this.index.setting('content:cursor')??0)%Math.max(1,tips.length)
    for(let step=0;step<tips.length;step++){
      const slot=(position+step)%tips.length,sha=tips[slot]
      const marker=`content:${CONTENT_VERSION}:${id}:${sha}`
      if(['ready','unsupported'].includes(this.index.setting(marker)??''))continue
      this.index.setting('content:cursor',String((slot+1)%tips.length))
      const commit=this.index.commit(sha)
      if(!commit){await this.requestObject('commit',sha);await this.wake(Date.now()+250,'content:commit');return}
      if(!this.index.snapshotReady(commit.tree)){await this.hydrate(sha);await this.wake(Date.now()+250,'content:hydrate');return}
      let inventory:Awaited<ReturnType<typeof entries>>
      try{inventory=await entries(this.apiIndex(),commit.tree,true)}
      catch(error){if(!(error instanceof ApiError)||error.status!==413)throw error;this.index.setting(marker,'unsupported');await this.wake(Date.now()+250,'content:unsupported');return}
      const blobs=inventory.filter(e=>e.type==='blob'),offset=Number(this.index.setting(marker)??0)
      for(const item of blobs.slice(offset,offset+64)){
        const bytes=this.index.rawBlob(item.sha)
        if(!bytes)throw new Error('Ready content snapshot lost hydrated blob')
        // D1 has a bounded individual value size. Oversized content remains
        // honestly Pending; directory/tree facts and other files still publish.
        if(bytes.content.length<=700000)await publishPreparedContentBlob(this.env.DB,id,item.sha,{content:bytes.content,size:Buffer.from(bytes.content,'base64').length})
      }
      const next=Math.min(offset+64,blobs.length)
      this.index.setting(marker,String(next))
      if(next<blobs.length){await this.wake(Date.now()+250);return}
      try{await publishPreparedContentSnapshot(this.env.DB,id,{sha,tree:commit.tree,complete:true,
        entries:inventory.map(e=>({...e,size:e.type==='blob'?Buffer.from(this.index.rawBlob(e.sha)!.content,'base64').length:0}))})}
      catch(error){if(!(error instanceof ApiError)||error.status!==413)throw error;this.index.setting(marker,'unsupported');await this.wake(Date.now()+250,'content:unsupported');return}
      this.index.setting(marker,'ready')
      if(tips.some(t=>!['ready','unsupported'].includes(this.index.setting(`content:${CONTENT_VERSION}:${id}:${t}`)??'')))await this.wake(Date.now()+250,'content:tips')
      return
    }
  }
  protected async preparePageChanges() {
    const metadata = JSON.parse(this.index.metaFile('.gild/index.json') ?? '{"pulls":[]}') as {pulls: {number:number;state:string;head:string;base:string}[]}
    const owner=this.index.setting('owner')!,repo=this.index.setting('repo')!,meta=this.index.setting('meta')||null
    const state=await d1Store(this.env.DB).settings.state(`${owner}/${repo}`)
    const page=await preparedChangePage(this.index.refs().filter(r=>r.name!=='_meta'),metadata.pulls,meta,this.index.setting('page:prepared-walk'))
    let submittedRefs=0,submittedPulls=0
    for(const ref of page.refs){
      try {
        const change=await this.pageChange('commit',ref.hash)
        if(change)await publishPreparedDiff(this.env.DB,state.id,'commit',ref.hash,ref.hash,change.from,null,change)
      }catch(error){if(error instanceof PreparationQueueFull)break;if(!(error instanceof ApiError)||error.status!==503)throw error}
      submittedRefs++
    }
    for (const pull of submittedRefs===page.refs.length?page.pulls:[]) {
      try {
        const change=await this.pageChange('pull', pull.head, pull.base)
        const base=this.index.resolve(pull.base)
        if(change&&base)await publishPreparedDiff(this.env.DB,state.id,'pull',String(pull.number),change.to,base,meta,change)
      }
      catch (error) { if(error instanceof PreparationQueueFull)break;if (!(error instanceof ApiError) || error.status !== 503) throw error }
      submittedPulls++
    }
    const next={...page.next,refs:page.next.refs-page.refs.length+submittedRefs,pulls:page.next.pulls-page.pulls.length+submittedPulls}
    this.index.setting('page:prepared-walk',JSON.stringify(next))
    if(!page.done||submittedRefs!==page.refs.length||submittedPulls!==page.pulls.length)await this.wake(Date.now()+250,'pages')
    const pending = JSON.parse(this.index.setting('page:changes') ?? '{}') as Record<string, {kind: 'commit'|'pull';to:string;from:string|null}>
    for (const [key, job] of Object.entries(pending).slice(0, 1)) {
      try {
        const commit = this.index.commit(job.to)
        if (!commit) { await this.requestObject('commit', job.to); throw new ApiError(503, 'Commit is indexing') }
        let from: string | null = commit.parents[0] ?? null
        if (job.kind === 'pull') {
          from = job.from
          try { from = (await comparison(this.apiIndex(), job.from!, job.to)).mergeBase }
          catch (error) { if (!(error instanceof ApiError) || error.status !== 409) throw error }
        }
        const change = await this.apiChanges(from, job.to)
        this.index.view(key, job.kind === 'pull' ? change : { ...change,
          commit: { message: commit.message, author: { name: commit.author_name, timestamp: commit.time }, parent: from } })
        if(job.kind==='commit')await publishPreparedDiff(this.env.DB,state.id,'commit',job.to,job.to,from,null,change)
        else for(const pull of metadata.pulls.filter(p=>this.index.resolve(p.head)===job.to&&this.index.resolve(p.base)===job.from))
          await publishPreparedDiff(this.env.DB,state.id,'pull',String(pull.number),job.to,job.from,meta,change)
        // RPC reads can enqueue while this alarm awaits its indexed inputs.
        // Remove only this job from the latest map, preserving those requests.
        const remaining = JSON.parse(this.index.setting('page:changes') ?? '{}')
        delete remaining[key]
        this.index.setting('page:changes', JSON.stringify(remaining))
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 503) throw error
      }
    }
    if (Object.keys(JSON.parse(this.index.setting('page:changes') ?? '{}')).length) await this.wake(Date.now() + 250, 'page-changes')
  }
  snapshotReady(tree: string) {
    return this.index.snapshotReady(tree)
  }
  async requestObject(kind: 'commit' | 'tree' | 'blob', hash: string) {
    if (!/^[a-f0-9]{40}$/.test(hash)) return 'notfound' as const
    if (
      (kind === 'commit' && this.index.commit(hash)) ||
      (kind === 'tree' && this.index.tree(hash)) ||
      (kind === 'blob' && this.index.rawBlob(hash))
    )
      return 'ready' as const
    const row = this.index.rows<{ state: string; at: number }>(
      'SELECT state,at FROM api_objects WHERE kind=? AND hash=?',
      kind,
      hash,
    )[0]
    if (row?.state === 'notfound' && Date.now() - row.at < 30000)
      return 'notfound' as const
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO api_objects VALUES (?,?,?,?)',
      kind,
      hash,
      'pending',
      Date.now(),
    )
    await this.wake(Date.now() + 1)
    return 'pending' as const
  }
  /** A blob or tree by hash, as raw Git object bytes, verified against the hash. */
  private async objectByHash(hash: string): Promise<{ type: 'blob' | 'tree'; bytes: Uint8Array } | null> {
    const verified = (type: 'blob' | 'tree', bytes: Uint8Array) =>
      createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex') === hash ? { type, bytes } : null
    try {
      const { bytes } = await this.readObject('blob', hash)
      const blob = bytes && verified('blob', bytes)
      if (blob) return blob
    } catch { /* not a blob */ }
    try {
      const { tree } = await this.readObject('tree', hash)
      if (!tree) return null
      const parts: Uint8Array[] = []
      for (const e of tree) parts.push(Buffer.from(`${e.mode.replace(/^0+/, '')} ${e.name}\0`), Buffer.from(e.child, 'hex'))
      return verified('tree', Buffer.concat(parts))
    } catch { return null }
  }
  protected async readObject(
    kind: 'commit' | 'tree' | 'blob',
    hash: string,
  ): Promise<{ commit?: Commit; tree?: Entry[]; bytes?: Uint8Array }> {
    if (kind === 'commit') return { commit: await this.commitInfo(hash) }
    const { namespace, repo } = await this.connection()
    const path = kind === 'tree' ? `tree/${hash}` : `blob/${hash}`
    const res = await fetch(
      `${artifactsApi(this.env)}/artifacts/namespaces/${namespace}/repos/${repo}/${path}`,
      { headers: { authorization: `Bearer ${this.env.ARTIFACTS_TOKEN}` } },
    )
    if (res.status === 404) throw new ApiError(404, 'Object not found')
    if (!res.ok) throw new Error('Object indexing failed')
    if (kind === 'blob')
      return { bytes: new Uint8Array(await res.arrayBuffer()) }
    const body = (await res.json()) as {
      success: boolean
      result: {
        name: string
        mode: string
        hash: string
        type: 'tree' | 'blob' | 'commit'
      }[]
    }
    if (!body.success) throw new Error('Object indexing failed')
    return {
      tree: body.result.map((e) => ({
        name: e.name,
        mode: e.mode,
        child: e.hash,
        type: e.type,
      })),
    }
  }
  apiLog(root: string, limit: number, offset: number) {
    return this.index.apiLog(root, limit, offset)
  }
  async ensureHistory(root: string) {
    if (this.index.historyReady(root)) return true
    this.index.requestHistory(root)
    await this.wake(Date.now() + 1)
    return false
  }
  rawBlob(hash: string) {
    return this.index.rawBlob(hash)
  }
  view(key: string, value?: unknown) {
    return this.index.view(key, value)
  }
  async hydrate(hash: string) {
    if (!/^[a-f0-9]{40}$/.test(hash) || !this.index.commit(hash)) return false
    const pending = JSON.parse(
      this.index.setting('api-hydrate') ?? '[]',
    ) as string[]
    if (!pending.includes(hash)) pending.push(hash)
    this.index.setting('api-hydrate', JSON.stringify(pending))
    await this.wake(Date.now() + 1)
    return true
  }
  tree(hash: string) {
    return this.index.tree(hash)
  }
  commit(hash: string) {
    return this.index.commit(hash)
  }
  file(path: string, ref?: string) {
    return this.index.file(path, ref)
  }
  blobText(hash: string) {
    return this.index.blobText(hash)
  }
  log(tip: string, limit: number) {
    return this.index.commit(tip) ? this.index.log(tip, limit) : null
  }
  languages(root: string) {
    return this.index.languages(root)
  }
  sizes(root: string) {
    return this.index.sizes(root)
  }
  metaFile(path: string) {
    return this.index.metaFile(path)
  }
  /** Several `_meta` files and the `_meta` commit they were read at, in one
   *  RPC (a page reads index, ACL and import source together). */
  metaFiles(paths: string[]) {
    return { meta: this.index.setting('meta'), files: Object.fromEntries(paths.map((path) => [path, this.index.metaFile(path)])) }
  }
  /** status() and refs() in one RPC: the readiness check every page makes. */
  readiness(owner?: string, repo?: string) {
    if (owner && repo) this.address(owner, repo)
    return { status: this.status(), refs: this.refs() }
  }
  metaItem(number: number, kind: 'issue' | 'pr') {
    return this.index.metaItem(number, kind)
  }
  findFiles(prefix: string, ref?: string, limit?: number) {
    return this.index.findFiles(prefix, ref, limit)
  }
  findSymbols(prefix: string, ref?: string) {
    return this.index.findSymbols(prefix, ref)
  }
  search(
    query: string,
    context: { repo: string; ownerKind: 'user' | 'org' },
    ref?: string,
    limit?: number,
    offset?: number,
  ) {
    // Moving names first resolve to immutable commit hashes. Bounded cache;
    // never retain all the repo's blob texts in the application isolate.
    const tips = this.index.refs().map((r) => [r.name, r.kind, r.hash])
    const key = JSON.stringify([tips, query, context, ref, limit, offset])
    const found = this.searches.get(key)
    if (found) {
      this.searches.delete(key)
      this.searches.set(key, found)
      return found
    }
    const result = this.index.search(query, context, ref, limit, offset)
    this.searches.set(key, result)
    if (this.searches.size > 32)
      this.searches.delete(this.searches.keys().next().value!)
    return result
  }
  /** Every wake-up goes through here: setAlarm replaces the pending alarm, so a
   *  later one (the render backoff, up to 60s) must never push back an earlier
   *  one (snapshot hydration at +250ms). That starved hydration on 9 Oct. */
  /** Reasons this alarm run asked to be woken for. */
  private waited = new Set<string>()
  /** Schedule the next alarm. A `reason` names a wait on something another
   *  step must make ready; a wait that keeps re-firing with no new work in
   *  between backs off (¼ s doubling to 15 min), so a stalled dependency can
   *  never poll four times a second forever (13 Oct: two indexes did). Plain
   *  progress (more objects to fetch) passes no reason and is never slowed.
   *  New work (refresh, push) resets every streak. */
  private async wake(at: number, reason?: string) {
    // Waits on a step of this same object are triggered, never polled: that
    // step's own run (work(): refresh -> objects -> refs -> these) calls them
    // again once it has made them ready. Only waits on capacity outside the
    // object (the shared preparation and render queues) keep an alarm.
    if (reason && TRIGGERED_WAITS.has(reason)) { this.waited.add(reason); return }
    if (reason) {
      const streak = (JSON.parse(this.index.setting('wake:streaks') ?? '{}') as Record<string, number>)[reason] ?? 0
      if (streak >= 4) at = Math.max(at, Date.now() + Math.min(15 * 60_000, 250 * 2 ** (streak - 2)))
      if ([8, 16, 32].includes(streak)) console.warn('RepoIndex wait not progressing', this.index.setting('owner'), this.index.setting('repo'), reason, streak)
      this.waited.add(reason)
    }
    const current = await this.ctx.storage.getAlarm()
    if (current === null || at < current) await this.ctx.storage.setAlarm(at)
  }
  /** New work arrived: every wait gets a fresh start. */
  private resetWaits() { this.index.setting('wake:streaks', '{}') }
  async alarm() {
    if (this.running) return this.running
    // An index that was never addressed (no owner/repo) has nothing to do and
    // nothing to mint a token for: stop, instead of failing every second.
    if (!this.index.setting('owner') || !this.index.setting('repo')) {
      console.warn('RepoIndex alarm without an address; not rescheduling')
      return
    }
    this.waited.clear()
    this.running = this.work().then(() => {
      // Count consecutive runs that ended waiting for the same thing.
      const streaks = JSON.parse(this.index.setting('wake:streaks') ?? '{}') as Record<string, number>
      const next: Record<string, number> = {}
      for (const reason of this.waited) next[reason] = (streaks[reason] ?? 0) + 1
      this.index.setting('wake:streaks', JSON.stringify(next))
      this.index.setting('wake:failures', '0')
    }, async error=>{
      this.index.setting('dirty','1')
      // Failures back off from 1 s to an hour (was: every second, forever).
      const failures = Number(this.index.setting('wake:failures') ?? 0) + 1
      this.index.setting('wake:failures', String(failures))
      if ([5, 10, 15].includes(failures)) console.warn('RepoIndex alarm failing', this.index.setting('owner'), this.index.setting('repo'), failures, error instanceof Error ? error.message : String(error))
      await this.wake(Date.now() + Math.min(60 * 60_000, 1000 * 2 ** Math.min(failures - 1, 12)))
      throw error
    }).finally(() => {
      this.running = null
    })
    return this.running
  }
  private conn: {
    at: number
    value: Promise<{
      token: string
      url: string
      namespace?: string
      repo?: string
    }>
  } | null = null
  /** One read token per hour, not one per step: every mint is a billed
   *  Artifacts operation (from 14 Oct 2026), and a burst of mints locked the
   *  account out on 7 Oct. Held in memory only, never in SQL. */
  protected connection() {
    if (!this.conn || Date.now() - this.conn.at > 55 * 60_000) {
      const value = this.mint()
      value.catch(() => {
        this.conn = null
      })
      this.conn = { at: Date.now(), value }
    }
    return this.conn.value
  }
  /** Ancestors are read as commit records over REST (the local fixture has no REST API, so it walks them in full). */
  protected get lightHistory() {
    return true
  }
  /** An ancestor's commit record, from the REST API (no pack fetch). */
  protected async commitInfo(hash: string): Promise<Commit> {
    const { namespace, repo } = await this.connection()
    const res = await fetch(
      `${artifactsApi(this.env)}/artifacts/namespaces/${namespace}/repos/${repo}/commit/${hash}`,
      {
        headers: { authorization: `Bearer ${this.env.ARTIFACTS_TOKEN}` },
      },
    )
    if (res.status === 404) throw new ApiError(404, 'Commit not found')
    const body = (await res.json()) as {
      success: boolean
      result: {
        treeHash: string
        parents?: string[]
        message: string
        author?: { name?: string; email?: string }
        authoredAt?: number
      }
    }
    if (!res.ok || !body.success)
      throw new Error(`repo index could not read commit ${hash}`)
    const c = body.result
    return {
      hash,
      tree: c.treeHash,
      parents: c.parents ?? [],
      author_name: c.author?.name ?? '',
      author_email: c.author?.email ?? '',
      time: c.authoredAt ?? 0,
      message: c.message,
    }
  }
  protected async mint() {
    const owner = this.index.setting('owner')!,
      repo = this.index.setting('repo')!
    const org = await d1Store(this.env.DB).getOrg(owner)
    const namespace = `${org ? 'o' : 'u'}-${owner.toLowerCase()}`
    if (!this.env.ARTIFACTS_TOKEN)
      throw new Error('ARTIFACTS_TOKEN is not set on this worker')
    const res = await fetch(
      `${artifactsApi(this.env)}/artifacts/namespaces/${namespace}/tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.ARTIFACTS_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ repo, scope: 'read', ttl: 3600 }),
      },
    )
    const minted = (await res.json()) as {
      success: boolean
      result: { plaintext: string }
    }
    if (!res.ok || !minted.success)
      throw new Error('repo index could not mint a read token')
    const token = minted.result.plaintext.split('?')[0],
      url = `${artifactsGit(this.env)}/${namespace}/${repo}.git`
    return { token, url, namespace, repo }
  }
  private async work() {
    const { token, url } = await this.connection()
    for (let budget = 0; budget < 10; budget++) {
      const job = this.index.rows<{
        kind: 'commit' | 'tree' | 'blob'
        hash: string
      }>(
        'SELECT kind,hash FROM api_objects WHERE state=? LIMIT 1',
        'pending',
      )[0]
      if (!job) break
      try {
        const result = await this.readObject(job.kind, job.hash)
        if (result.commit) this.index.putCommit(result.commit)
        if (result.tree) {
          this.index.putTree(job.hash, result.tree)
          for (const child of result.tree)
            if (child.type === 'tree' && !this.index.tree(child.child))
              this.ctx.storage.sql.exec(
                'INSERT OR IGNORE INTO api_objects VALUES (?,?,?,?)',
                'tree',
                child.child,
                'pending',
                Date.now(),
              )
        }
        if (result.bytes) {
          const { describeBlob } = await import('../engine/repo-indexer.js')
          this.index.putBlob(describeBlob(job.hash, result.bytes, ''))
        }
        this.ctx.storage.sql.exec(
          'DELETE FROM api_objects WHERE kind=? AND hash=?',
          job.kind,
          job.hash,
        )
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e
        this.ctx.storage.sql.exec(
          'UPDATE api_objects SET state=?,at=? WHERE kind=? AND hash=?',
          'notfound',
          Date.now(),
          job.kind,
          job.hash,
        )
      }
    }
    if (
      this.index.rows(
        'SELECT 1 FROM api_objects WHERE state=? LIMIT 1',
        'pending',
      ).length
    )
      await this.wake(Date.now() + 250)
    const pending = JSON.parse(
      this.index.setting('api-hydrate') ?? '[]',
    ) as string[]
    if (pending.length) {
      const sha = pending[0],
        source = await snapshotSource(url, sha, token),
        c = await source.commit(sha)
      this.index.putCommit(c)
      const sql = this.ctx.storage.sql
      if (
        !this.index.rows('SELECT 1 FROM hydrated_roots WHERE hash=?', c.tree)
          .length
      ) {
        if (
          !this.index.rows('SELECT 1 FROM api_hydration WHERE sha=?', sha)
            .length
        )
          sql.exec(
            'INSERT OR IGNORE INTO api_hydration VALUES (?,?,?,?)',
            sha,
            'tree',
            c.tree,
            '',
          )
        for (let budget = 0; budget < 100; budget++) {
          const job = this.index.rows<{
            type: string
            hash: string
            path: string
          }>(
            'SELECT type,hash,path FROM api_hydration WHERE sha=? ORDER BY type LIMIT 1',
            sha,
          )[0]
          if (!job) break
          if (job.type === 'tree') {
            const entries =
              this.index.tree(job.hash) ?? (await source.tree(job.hash))
            this.index.putTree(job.hash, entries)
            for (const e of entries)
              if (
                e.type === 'tree' ||
                (e.type === 'blob' && !this.index.rawBlob(e.child))
              )
                sql.exec(
                  'INSERT OR IGNORE INTO api_hydration VALUES (?,?,?,?)',
                  sha,
                  e.type,
                  e.child,
                  job.path + e.name + (e.type === 'tree' ? '/' : ''),
                )
          } else if (!this.index.rawBlob(job.hash)) {
            const { describeBlob } = await import('../engine/repo-indexer.js')
            this.index.putBlob(
              describeBlob(job.hash, await source.blob(job.hash), job.path),
            )
          }
          sql.exec(
            'DELETE FROM api_hydration WHERE sha=? AND type=? AND hash=?',
            sha,
            job.type,
            job.hash,
          )
        }
        if (
          !this.index.rows('SELECT 1 FROM api_hydration WHERE sha=?', sha)
            .length
        )
          sql.exec('INSERT OR IGNORE INTO hydrated_roots VALUES (?)', c.tree)
      }
      if (
        this.index.rows('SELECT 1 FROM hydrated_roots WHERE hash=?', c.tree)
          .length
      )
        this.index.setting('api-hydrate', JSON.stringify(pending.slice(1)))
      if (this.index.setting('api-hydrate') !== '[]')
        await this.wake(Date.now() + 250)
    }
    for (let budget = 0; budget < 20; budget++) {
      const job = this.index.rows<{ root: string; hash: string }>(
        'SELECT root,hash FROM api_history_jobs ORDER BY root LIMIT 1',
      )[0]
      if (!job) break
      const c = this.index.commit(job.hash) ?? (await this.commitInfo(job.hash))
      this.index.putCommit(c)
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO api_history_nodes VALUES (?,?,?)',
        job.root,
        c.hash,
        c.time,
      )
      for (const p of c.parents)
        if (
          !this.index.rows(
            'SELECT 1 FROM api_history_nodes WHERE root=? AND hash=?',
            job.root,
            p,
          ).length
        )
          this.ctx.storage.sql.exec(
            'INSERT OR IGNORE INTO api_history_jobs VALUES (?,?)',
            job.root,
            p,
          )
      this.ctx.storage.sql.exec(
        'DELETE FROM api_history_jobs WHERE root=? AND hash=?',
        job.root,
        job.hash,
      )
      if (
        !this.index.rows(
          'SELECT 1 FROM api_history_jobs WHERE root=?',
          job.root,
        ).length
      )
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO api_history_roots VALUES (?)',
          job.root,
        )
    }
    if (this.index.rows('SELECT 1 FROM api_history_jobs LIMIT 1').length)
      await this.wake(Date.now() + 250)
    const revision = this.index.setting('revision')
    if (this.index.setting('dirty') === '1') {
      // Same ref listing implementation as the request-side repoRefs; exactly
      // one smart HTTP advertisement gives branches, peeled tags and _meta.
      const { refsFromAdvertisement } = await import('../engine/repo-refs.js')
      const { internalPrefix } = await import('../engine/import/visibility.js')
      const refs = refsFromAdvertisement(
        await git.listServerRefs({
          http,
          url,
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
          symrefs: true,
          peelTags: true,
        }),
        await internalPrefix(this.env.DB,`${this.index.setting('owner')}/${this.index.setting('repo')}`),
      )
      refs.defaultBranch =
        (
          await d1Store(this.env.DB).settings.state(
            `${this.index.setting('owner')}/${this.index.setting('repo')}`,
          )
        ).defaultBranch ?? refs.defaultBranch
      startIndex(this.index, {
        refs: [
          ...refs.branches.map((b) => ({
            name: b.name,
            hash: b.oid,
            kind: 'branch' as const,
          })),
          ...refs.tags.map((b) => ({
            name: b.name,
            hash: b.oid,
            kind: 'tag' as const,
          })),
        ],
        defaultBranch: refs.defaultBranch,
        meta: refs.meta,
      })
      if (this.index.setting('revision') === revision)
        this.index.setting('dirty', '')
    }
    // Shallow fetch by immutable oid. Every invocation releases the pack/cache;
    // historical commits never accumulate together in a full-history clone.
    let sourceHash = '',
      source: ObjectSource | null = null
    const result = await indexStep(
      this.index,
      async (hash) => {
        if (sourceHash === hash && source) return source
        source = null
        sourceHash = hash
        source = await snapshotSource(url, hash, token)
        return source
      },
      100,
      1,
      this.lightHistory ? (hash) => this.commitInfo(hash) : undefined,
    )
    if(result.done)this.acknowledgeIndexedRefs()
    await this.listing()
    // Paced: a quarter second between steps keeps a big backfill gentle on the API.
    if (!result.done || this.index.setting('dirty') === '1')
      await this.wake(Date.now() + 250)
    if (result.done) {
      // Search first: it is cheap when nothing changed, and the content reads
      // below may wake the object again before returning.
      try { await this.prepareSearch() } catch (error) { console.error('Search sync failed', error) }
      // Conversation reads depend on none of these: a failing content, diff or
      // render step must not leave pulls and issues unprepared forever.
      let failed: unknown
      try {
        await this.prepareContentReads()
        await this.preparePageChanges()
        await this.renderWork()
      } catch (error) { failed = error }
      await this.prepareConversationReads()
      if (failed) throw failed
      await this.eventWork()
      // Recovery of legacy persisted queues is background-only, after metadata
      // is authoritative; ordinary page reads never initiate a drain.
      const queued = JSON.parse(this.index.metaFile('.gild/queue.json') ?? '[]') as number[]
      if (queued.length && this.env.RUN_QUEUE) {
        const owner = this.index.setting('owner')!, repo = this.index.setting('repo')!
        const id = (await d1Store(this.env.DB).settings.state(`${owner}/${repo}`)).id
        const queue = this.env.RUN_QUEUE.get(this.env.RUN_QUEUE.idFromName(id))
        await queue.init(owner, repo)
        await queue.requestMergeScan()
      }
    }
  }
}
