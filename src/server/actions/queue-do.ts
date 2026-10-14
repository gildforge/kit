import { MergeQueueStore, type MergePlan } from '../../engine/merge-queue-store.js'
import { processQueue } from '../pulls.js'
import { backgroundMergeRuntime, type MergeBindings } from '../merge-queue-runtime.js'
import { mayRead } from '../repo-read.js'
import { validateRunner } from '../../engine/actions/runner-validation.js'
import type { PoolRunner } from '../../engine/actions/pool-store.js'
import type { RunnerPool } from './pool-do.js'
import { d1Settings } from '../settings-store.js'
import { EventOutbox } from '../../engine/events/outbox.js'
import { emit, type EventBindings } from '../events/binding.js'
import { captureActionEvents } from '../events/actions-source.js'
import { hashToken } from '../token-verifier.js'
import { d1Store } from '../drivers/d1.js'
import { DurableObject } from 'cloudflare:workers'
import type {
  DurableObjectState,
  D1Database,
  R2Bucket,
} from '@cloudflare/workers-types'
import {
  RunStore,
  resolveAssignment,
  maskLog,
  type Status,
  type Run,
} from './store.js'
import type { SQL } from '../../engine/repo-index-store.js'
import { decrypt, encrypt, maskValues, repoSecrets } from './secrets.js'
import { artifactSource } from './artifact-source.js'
import { loadWorkflows, changedPaths, mergeBase } from '../../engine/actions/source.js'
import { matchesTrigger, runnerLabels } from '../../engine/actions/workflow.js'
import type { ObjectSource } from '../../engine/repo-indexer.js'
import { archiveConnection, writeRunRecord } from './archive.js'
import type { Workflow, Event } from '../../engine/actions/workflow.js'
export interface ActionEnv extends EventBindings, MergeBindings {
  DB: D1Database
  ARTIFACTS_TOKEN?: string
  ACTIONS_SECRET_KEY?: string
  RUNNER_POOL?: {
    idFromName(name: string): unknown
    get(id: unknown): {
      [
        K in
          'init' | 'offer' | 'eligibility' | 'candidate' | 'touch' | 'completed'
      ]: (
        ...a: Parameters<RunnerPool[K]>
      ) => Promise<Awaited<ReturnType<RunnerPool[K]>>>
    }
  }
  ACTION_LOGS?: R2Bucket
}
export const tokenHash = hashToken
export class RunQueue extends DurableObject<ActionEnv> {
  protected runs: RunStore
  protected merges: MergeQueueStore
  private outbox: EventOutbox
  private working: Promise<void> | null = null
  private waiters = new Set<() => void>()
  async purge() {
    if (this.working) await this.working
    this.wake()
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.runs = new RunStore(this.ctx.storage.sql as unknown as SQL)
    this.merges = new MergeQueueStore(this.ctx.storage.sql as unknown as SQL)
    this.outbox = new EventOutbox(this.ctx.storage.sql as unknown as SQL)
  }
  constructor(ctx: DurableObjectState, env: ActionEnv) {
    super(ctx as never, env)
    this.runs = new RunStore(ctx.storage.sql as unknown as SQL)
    this.merges = new MergeQueueStore(ctx.storage.sql as unknown as SQL)
    this.outbox = new EventOutbox(ctx.storage.sql as unknown as SQL)
  }
  private tx<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(() => {
      this.runs.sweep()
      const result = fn()
      captureActionEvents(
        this.runs,
        this.ctx.storage.sql as unknown as SQL,
        this.outbox,
        `${this.runs.setting('owner')}/${this.runs.setting('repo')}`,
      )
      return result
    })
  }
  private wake() {
    for (const w of this.waiters) w()
    this.waiters.clear()
  }
  private async wakeAlarm(at: number) {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || at < current) await this.ctx.storage.setAlarm(at)
  }
  private async alarmSoon() {
    await this.wakeAlarm(Date.now() + 15_000)
  }
  async init(owner: string, repo: string) {
    this.runs.setting('owner', owner)
    this.runs.setting('repo', repo)
  }
  /** Must finish before the Git write; alarm retries survive lost responses. */
  async prepareMerge(number: number) {
    const id = this.merges.prepare(number)
    await this.alarmSoon()
    return id
  }
  async planMerge(plan: MergePlan) { this.merges.plan(plan) }
  plannedMerge(intent: string) { return this.merges.planned(intent) }
  async rejectMerge(id: string) { this.merges.retire([id]) }
  async requestMergeScan() { this.merges.scan(true); await this.alarmSoon() }
  protected async resumeMerges() {
    const owner = this.runs.setting('owner')!, repo = this.runs.setting('repo')!
    const runtime = await backgroundMergeRuntime(this.env, owner, repo, this)
    const result = await processQueue(owner, repo, runtime, this.merges.pending())
    this.merges.retire(result.completed)
    this.merges.scan(result.queued)
    return this.merges.needed()
  }
  async suspend() {
    this.tx(() => {
      for (const r of this.runs.activeRuns()) this.runs.cancel(r.id)
      for (const e of this.runs.events()) this.runs.acknowledge(e.key)
    })
    this.wake()
  }
  private async identity() {
    return (
      await d1Settings(this.env.DB).state(
        `${this.runs.setting('owner')}/${this.runs.setting('repo')}`,
      )
    ).id
  }
  private async writable() {
    const key = `${this.runs.setting('owner')}/${this.runs.setting('repo')}`,
      st = d1Settings(this.env.DB),
      canonical = await st.canonical(key),
      s = await st.state(canonical),
      org = await st.state(canonical.split('/')[0])
    return (
      !s.archived &&
      s.deletedAt === null &&
      !s.moving &&
      !org.archived &&
      org.deletedAt === null &&
      !org.moving
    )
  }
  private summaries(runs: Run[]) {
    return runs.map(({ workflow, ...r }) => ({
      ...r,
      machines: [
        ...new Set(
          this.runs
            .jobs(r.id)
            .map((j) => j.runnerName)
            .filter(Boolean),
        ),
      ] as string[],
      workflow: {
        file: workflow.file,
        name: workflow.name,
        error: workflow.error,
      },
    }))
  }
  commitRuns(sha: string) {
    const latest = new Map<string, ReturnType<RunQueue['summaries']>[number]>()
    for (const run of this.summaries(this.runs.runsForSha(sha)))
      if (!latest.has(run.workflow.file)) latest.set(run.workflow.file, run)
    return [...latest.values()]
  }
  apiRuns(limit: number, offset: number) {
    return this.runs.apiRuns(limit, offset)
  }
  apiJob(id: number) {
    return this.runs.apiJob(id)
  }
  overview() {
    return {
      runs: this.summaries(this.runs.runs()),
      runners: this.runs.ownRunners(),
      pendingEvents: this.runs
        .events()
        .map((e) => ({ key: e.key, attempts: e.attempts })),
      archiveError: this.runs.setting('archive-error'),
      mergeError: this.runs.setting('merge-error'),
      settings: {
        required: JSON.parse(this.runs.setting('required') ?? '[]') as string[],
      },
    }
  }
  detail(id: number) {
    return this.runs.detail(id)
  }
  async logs(job: number, step: number, after: number) {
    const live = this.runs.logs(job, step, after)
    if (live.length || !this.env.ACTION_LOGS) return live
    const run = this.runs.jobRun(job),
      object = await this.env.ACTION_LOGS.get(
        `${await this.identity()}/${run}/jobs/${job}/steps/${step}.json`,
      )
    if (!object) return []
    return (JSON.parse(await object.text()) as { seq: number; text: string }[])
      .filter((c) => c.seq > after)
      .slice(0, 128)
  }
  cacheWorkflows(sha: string, workflows?: Workflow[]) {
    return this.runs.cacheWorkflows(sha, workflows)
  }
  async prepareWorkflows(sha: string) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid commit')
    const pending = JSON.parse(this.runs.setting('page:workflows') ?? '[]') as string[]
    if (!pending.includes(sha)) this.runs.setting('page:workflows', JSON.stringify([...pending.slice(-99), sha]))
    await this.ctx.storage.setAlarm(Date.now() + 1)
  }
  private async workflowWork() {
    const pending = JSON.parse(this.runs.setting('page:workflows') ?? '[]') as string[]
    for (const sha of pending.slice(0, 1)) {
      if (!this.runs.cacheWorkflows(sha)) this.runs.cacheWorkflows(sha, await loadWorkflows(await this.source(sha), sha))
      const remaining = JSON.parse(this.runs.setting('page:workflows') ?? '[]') as string[]
      this.runs.setting('page:workflows', JSON.stringify(remaining.filter(hash => hash !== sha)))
    }
  }
  async deliver(e: Event) {
    if (!(await this.writable())) return
    this.runs.deliver(e)
    await this.wakeAlarm(Date.now() + 1)
  }
  protected async connection(scope = 'read') {
    return archiveConnection(
      this.env,
      this.runs.setting('owner')!,
      this.runs.setting('repo')!,
      scope,
    )
  }
  protected async repositorySource(_sha: string): Promise<ObjectSource> {
    return artifactSource(
      this.env,
      this.runs.setting('owner')!,
      this.runs.setting('repo')!,
    )
  }
  protected async source(sha: string): Promise<ObjectSource> {
    const ns = (
      this.env as unknown as {
        REPO_INDEX?: { idFromName(n: string): unknown; get(id: unknown): any }
      }
    ).REPO_INDEX
    const index = ns?.get(ns.idFromName(await this.identity()))
    let fallback: Promise<ObjectSource> | null = null
    const cold = () =>
      (fallback ??= (async () => {
        return this.repositorySource(sha)
      })())
    const cached = async (
      kind: string,
      hash: string,
      load: () => Promise<unknown>,
    ) => {
      const hit = this.runs.object(hash, kind)
      if (hit !== null) return hit
      const v = await load()
      this.runs.object(hash, kind, v)
      return v
    }
    return {
      commit: async (h) =>
        cached(
          'commit',
          h,
          async () => (await index?.commit(h)) ?? (await cold()).commit(h),
        ),
      tree: async (h) =>
        cached(
          'tree',
          h,
          async () => (await index?.tree(h)) ?? (await cold()).tree(h),
        ),
      blob: async (h) => {
        const bytes = await cached('workflow-blob', h, async () => {
          const b = await index?.blobText(h)
          const raw =
            b?.kind === 'text'
              ? new TextEncoder().encode(b.text)
              : await (await cold()).blob(h)
          return [...raw]
        })
        return new Uint8Array(bytes)
      },
    }
  }
  private async eventWork() {
    for (const row of this.runs.events()) {
      try {
        const e = JSON.parse(row.event) as Event,
          source = await this.source(e.sha)
        e.title = e.title || (await source.commit(e.sha)).message.split('\n')[0]
        let workflows = this.runs.cacheWorkflows(e.sha)
        if (!workflows) {
          workflows = await loadWorkflows(source, e.sha)
          this.runs.cacheWorkflows(e.sha, workflows)
        }
        if (
          !e.paths &&
          workflows.some(
            (w) =>
              w.triggers[e.name]?.paths || w.triggers[e.name]?.['paths-ignore'],
          )
        ) {
          let before = e.before && !/^0+$/.test(e.before) ? e.before : null
          if (e.name === 'pull_request' && before) {
            const key = `${e.sha}:${before}`,
              cached = this.runs.object(key, 'merge-base-v1')
            if (cached !== null) before = cached.hash
            else {
              before = await mergeBase(e.sha, before, async (h) =>
                (await this.source(h)).commit(h),
              )
              this.runs.object(key, 'merge-base-v1', { hash: before })
            }
          }
          const pathKey = `${before}:${e.sha}`,
            cachedPaths = this.runs.object(pathKey, 'changed-paths-v1')
          e.paths =
            cachedPaths ??
            (await changedPaths(
              before ? await this.source(before) : null,
              before,
              source,
              e.sha,
            ))
          this.runs.object(pathKey, 'changed-paths-v1', e.paths)
        }
        const safeEvent = await this.approvalEvent(e)
        this.tx(() => {
          for (const w of workflows!)
            if (w.error || matchesTrigger(w, e)) this.runs.enqueue(w, safeEvent)
          this.runs.acknowledge(row.key)
        })
      } catch (e) {
        if ((e as Error).message.includes('5000-commit')) {
          const event = JSON.parse(row.event) as Event
          this.tx(() => {
            for (const workflow of this.runs.cacheWorkflows(event.sha) ?? [])
              this.runs.enqueue(
                { ...workflow, jobs: [], error: (e as Error).message },
                event,
              )
            this.runs.acknowledge(row.key)
          })
        } else this.runs.retryEvent(row.key)
      }
    }
  }
  private async approvalEvent(e: Event) {
    if (e.name !== 'pull_request') return e
    const owner = this.runs.setting('owner')!,
      repo = this.runs.setting('repo')!,
      st = d1Store(this.env.DB),
      state = await st.settings.state(`${owner}/${repo}`)
    const ns = (this.env as unknown as import('./pool-do.js').PoolEnv).REPO_INDEX
    if (!ns) return { ...e, requiresApproval: true }
    const { mayRead } = await import('../repo-read.js')
    const isPublic = await mayRead(
      { store: st, index: async () => ns.get(ns.idFromName(state.id)) },
      owner,
      repo,
      null,
    )
    return {
      ...e,
      requiresApproval:
        isPublic &&
        e.actor !== owner &&
        !['owner', 'admin'].includes((await st.orgRole(owner, e.actor)) ?? ''),
    }
  }
  async enqueue(w: Workflow, e: Event) {
    if (!(await this.writable())) throw new Error('Repository is read-only')
    e = await this.approvalEvent(e)
    const id = this.tx(() => this.runs.enqueue(w, e))
    this.wake()
    await this.offer()
    await this.alarmSoon()
    return id
  }
  async rerun(id: number, actor: string) {
    const r = this.runs.run(id)
    if (!r) throw new Error('run not found')
    return this.enqueue(r.workflow, {
      ...r.event,
      actor,
      key: `rerun:${id}:${crypto.randomUUID()}`,
    })
  }
  async cancel(id: number) {
    this.tx(() => this.runs.cancel(id))
    this.wake()
    await this.alarmSoon()
  }
  required(files?: string[]) {
    if (files) this.runs.setting('required', JSON.stringify(files))
    return JSON.parse(this.runs.setting('required') ?? '[]') as string[]
  }
  gate(sha: string) {
    const required = this.required(),
      runs = this.runs.runsForSha(sha)
    const pending = required.filter(
      (file) =>
        runs.find((r) => r.event.sha === sha && r.workflow.file === file)
          ?.status !== 'success',
    )
    return { ok: pending.length === 0, required, pending }
  }
  async registration() {
    const token = 'grt_' + crypto.randomUUID().replaceAll('-', '')
    this.runs.rows(
      'INSERT INTO action_registration_tokens(hash,owner,repo,expires) VALUES (?,?,?,?)',
      await tokenHash(token),
      this.runs.setting('owner'),
      this.runs.setting('repo'),
      Date.now() + 3600_000,
    )
    return { token, expires_at: new Date(Date.now() + 3600_000).toISOString() }
  }
  async registrationAccess(token: string) {
    const row = this.runs.rows<{
      owner: string
      repo: string
      expires: number
      used: number
    }>(
      'SELECT owner,repo,expires,used FROM action_registration_tokens WHERE hash=?',
      await tokenHash(token),
    )[0]
    if (
      !row ||
      row.used ||
      row.expires <= Date.now() ||
      row.owner !== this.runs.setting('owner') ||
      row.repo !== this.runs.setting('repo')
    )
      return false
    const store = d1Store(this.env.DB)
    return mayRead(
      { store, index: async () => null },
      row.owner,
      row.repo,
      row.owner,
    )
  }
  private runnerEvent(
    action: string,
    runner: {
      id: string
      name: string
      os: string
      arch: string
      labels: string[]
    },
  ) {
    this.outbox.put({
      id: crypto.randomUUID(),
      event: 'runner',
      repository: `${this.runs.setting('owner')}/${this.runs.setting('repo')}`,
      payload: { action, owner: this.runs.setting('owner'), runner },
    })
  }
  private async runnerOnline(r: {
    id: string
    name: string
    os: string
    arch: string
    labels: string[]
    lastSeen: number
  }) {
    if (!r.lastSeen || Date.now() - r.lastSeen >= 120000)
      this.runnerEvent('online', r)
    this.runs.setting('runner-online:' + r.id, '1')
    await this.alarmSoon()
  }
  async register(
    by: string,
    data: { name: string; os: string; arch: string; labels: string[] },
    registration?: string,
  ) {
    data = validateRunner(data)
    const repoOwner = this.runs.setting('owner')!
    const token = `gr_${crypto.randomUUID().replaceAll('-', '')}`,
      id = crypto.randomUUID()
    const hash = await tokenHash(token)
    const registrationHash = registration ? await tokenHash(registration) : null
    this.tx(() => {
      if (registrationHash) {
        const t = this.runs.rows<{
          expires: number
          used: number
          owner: string
          repo: string
        }>(
          'SELECT * FROM action_registration_tokens WHERE hash=?',
          registrationHash,
        )[0]
        if (
          !t ||
          t.used ||
          Date.now() >= t.expires ||
          t.owner !== repoOwner ||
          t.repo !== this.runs.setting('repo')
        )
          throw Error('invalid, expired or used registration token')
        this.runs.rows(
          'UPDATE action_registration_tokens SET used=1 WHERE hash=?',
          registrationHash,
        )
      }
      this.runs.register({ id, ...data, owner: by || repoOwner }, hash)
    })
    this.runnerEvent('registered', this.runs.authenticate(hash)!)
    await this.alarmSoon()
    return { id, token }
  }
  patch(id: string, labels: string[]) {
    const runner = this.runs.ownRunners().find((r) => r.id === id)
    if (!runner) throw Error('runner not found')
    this.runs.rows(
      'UPDATE action_runners SET labels=? WHERE id=?',
      JSON.stringify(runnerLabels(runner.os, runner.arch, labels)),
      id,
    )
    this.wake()
    return { ok: true }
  }
  async remove(id: string) {
    const runner = this.runs.ownRunners().find((r) => r.id === id)
    if (!runner) throw Error('runner not found')
    this.tx(() => this.runs.remove(id))
    this.runnerEvent('removed', runner)
    this.runs.setting('runner-online:' + id, '0')
    await this.alarmSoon()
    this.wake()
  }
  private async runner(
    token: string,
    job?: number | null,
    lease?: string | null,
  ) {
    const hash = await tokenHash(token)
    const r = token.startsWith('gc_')
      ? this.runs.checkoutRunner(hash, Date.now(), job, lease)
      : this.runs.authenticate(hash)
    if (!r) throw new Error('invalid or revoked runner token')
    if (r.owner.includes('/')) {
      const agent = await d1Store(this.env.DB).getAgent(r.owner)
      if (!agent || agent.revokedAt)
        throw new Error('invalid or revoked runner token')
    }
    return r
  }
  async readRepo(token: string) {
    const runner = await this.runner(token),
      owner = this.runs.setting('owner')!,
      repo = this.runs.setting('repo')!,
      store = d1Store(this.env.DB)
    // A runner credential is a narrow handle, not inherited sponsor access.
    // In particular, removing an agent's ACL grant revokes its private checkout.
    if (
      !(await mayRead(
        { store, index: async () => null },
        owner,
        repo,
        runner.owner,
      ))
    )
      throw new Error('invalid or revoked runner token')
    return true
  }
  protected async secrets(event: Event) {
    return event.name === 'pull_request' || event.actor.includes('/')
      ? {}
      : repoSecrets(
          this.env,
          `${this.runs.setting('owner')}/${this.runs.setting('repo')}`,
        )
  }
  private async masks(job: number) {
    const cipher = this.runs.encryptedMasks(job)
    return cipher
      ? (JSON.parse(
          await decrypt(
            this.env,
            `mask:${await this.identity()}:${job}`,
            cipher,
          ),
        ) as string[])
      : []
  }
  private async pool() {
    const ns = this.env.RUNNER_POOL
    return ns?.get(
      ns.idFromName(
        (await d1Store(this.env.DB).settings.state(this.runs.setting('owner')!))
          .id,
      ),
    )
  }
  private async offer() {
    const pool = await this.pool()
    if (pool) {
      await pool.init(this.runs.setting('owner')!)
      await pool.offer(
        `${this.runs.setting('owner')}/${this.runs.setting('repo')}`,
        await this.identity(),
        this.tx(() => this.runs.ready()),
      )
    }
  }
  runnerJobs(id: string) {
    return this.runs.runners().some((r) => r.id === id)
      ? this.runs
          .runs()
          .flatMap((run) =>
            this.runs
              .jobs(run.id)
              .filter((j) => j.runner === id)
              .map((j) => ({
                repository: `${this.runs.setting('owner')}/${this.runs.setting('repo')}`,
                run: run.id,
                job: j.id,
                status: j.status,
                name: j.spec.name ?? j.spec.id,
              })),
          )
          .slice(0, 50)
      : []
  }
  ready(labels?: string[]) {
    return this.tx(() => this.runs.ready(labels))
  }
  leaseLive(runner: string, job: number, lease: string) {
    try {
      const j = this.runs.authorized(runner, job, lease)
      return j.status === 'running' && !!j.deadline && j.deadline > Date.now()
    } catch {
      return false
    }
  }
  leasesLive(assignments: { runner: string; job: number; lease: string }[]) {
    return assignments.map((a) => this.leaseLive(a.runner, a.job, a.lease))
  }
  async poolClaim(r: PoolRunner, job: number) {
    if (r.owner !== this.runs.setting('owner') || !(await this.writable()))
      return null
    const token = 'gc_' + crypto.randomUUID().replaceAll('-', ''),
      hash = await tokenHash(token),
      pool = await this.pool(),
      current = pool
        ? await pool.candidate(
            r.id,
            `${this.runs.setting('owner')}/${this.runs.setting('repo')}`,
          )
        : null
    if (!current) return null
    const found = this.tx(() => {
      this.runs.inherited(current)
      return this.runs.claim(
        {
          id: current.id,
          owner: current.owner,
          name: current.name,
          os: current.os,
          arch: current.arch,
          labels: current.labels,
          lastSeen: current.lastSeen,
          job: null,
          run: null,
        },
        Date.now(),
        job,
      )
    })
    if (!found) return null
    try {
      const secrets = await this.secrets(found.run.event),
        assignment = resolveAssignment(found.job, found.run, secrets),
        masks = maskValues(secrets)
      if (masks.length)
        this.runs.saveMasks(
          found.job.id,
          await encrypt(
            this.env,
            `mask:${await this.identity()}:${found.job.id}`,
            JSON.stringify(masks),
          ),
        )
      this.runs.checkout(hash, r.id, found.job.id, found.job.lease!)
      await this.alarmSoon()
      return { ...assignment, checkoutToken: token }
    } catch (e) {
      this.tx(() =>
        this.runs.finish(
          r.id,
          found.job.id,
          found.job.lease!,
          'failure',
          'job preparation failed',
        ),
      )
      throw e
    }
  }
  async approve(run: number, by: string) {
    this.tx(() => this.runs.approve(run, by))
    this.wake()
    await this.offer()
  }
  async poll(token: string, wait = 20_000) {
    if (!(await this.writable())) return null
    const r = await this.runner(token)
    await this.runnerOnline(r)
    const claim = () =>
      this.tx(() => {
        this.runs.sweep()
        this.runs.releaseCancelled(r.id)
        return this.runs.claim(r)
      })
    let found = claim()
    if (!found && wait > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, Math.min(wait, 20_000))
        this.waiters.add(done)
      })
      if (!(await this.writable())) return null
      found = claim()
    }
    if (!found) return null
    try {
      const secrets = await this.secrets(found.run.event),
        assignment = resolveAssignment(found.job, found.run, secrets),
        masks = maskValues(secrets)
      if (masks.length) {
        const cipher = await encrypt(
          this.env,
          `mask:${await this.identity()}:${found.job.id}`,
          JSON.stringify(masks),
        )
        this.runs.saveMasks(found.job.id, cipher)
      }
      await this.alarmSoon()
      return assignment
    } catch (e) {
      this.tx(() =>
        this.runs.finish(
          r.id,
          found.job.id,
          found.job.lease!,
          'failure',
          'workflow expressions or repo secrets could not be resolved',
        ),
      )
      await this.alarmSoon()
      throw new Error(
        'job preparation failed; check workflow and Worker secret binding',
      )
    }
  }
  async heartbeat(token: string, job: number | null, lease: string | null) {
    const r = await this.runner(token, job, lease)
    if (token.startsWith('gc_')) await (await this.pool())?.touch(r.id)
    else await this.runnerOnline(r)
    return this.tx(() => this.runs.heartbeat(r.id, job, lease))
  }
  async append(
    token: string,
    data: {
      job: number
      lease: string
      step: number
      batch: number
      lines: string[]
    },
  ) {
    const r = await this.runner(token, data.job, data.lease),
      masks = await this.masks(data.job)
    this.tx(() =>
      this.runs.append(
        r.id,
        data.job,
        data.lease,
        data.step,
        data.batch,
        data.lines,
        masks,
      ),
    )
  }
  async step(
    token: string,
    data: {
      job: number
      lease: string
      step: number
      status: Status
      exit: number | null
    },
  ) {
    const r = await this.runner(token, data.job, data.lease)
    this.tx(() =>
      this.runs.step(
        r.id,
        data.job,
        data.lease,
        data.step,
        data.status,
        data.exit,
      ),
    )
  }
  async finish(
    token: string,
    data: {
      job: number
      lease: string
      status: 'success' | 'failure' | 'cancelled'
      reason: string | null
    },
  ) {
    const r = await this.runner(token, data.job, data.lease),
      masks = await this.masks(data.job)
    this.tx(() =>
      this.runs.finish(
        r.id,
        data.job,
        data.lease,
        data.status,
        data.reason ? maskLog(data.reason, masks) : null,
      ),
    )
    if (token.startsWith('gc_'))
      await (await this.pool())?.completed(r.id, data.lease)
    this.wake()
    await this.offer()
    await this.alarmSoon()
  }
  protected async archive(id: number) {
    const summary = this.runs.summary(id),
      owner = this.runs.setting('owner')!,
      repo = this.runs.setting('repo')!,
      identity = await this.identity()
    if (this.env.ACTION_LOGS) {
      for (const j of this.runs.jobs(id))
        for (const s of this.runs.steps(j.id)) {
          await this.env.ACTION_LOGS.put(
            `${identity}/${id}/jobs/${j.id}/steps/${s.position}.json`,
            JSON.stringify(this.runs.allLogs(j.id, s.position)),
            { httpMetadata: { contentType: 'application/json' } },
          )
        }
      await this.env.ACTION_LOGS.put(
        `${identity}/${id}.json`,
        JSON.stringify(summary),
        { httpMetadata: { contentType: 'application/json' } },
      )
    }
    await writeRunRecord(
      this.env,
      owner,
      repo,
      id,
      summary,
      await this.connection('write'),
    )
    this.runs.archived(id)
    if (!this.runs.unarchived().length) this.runs.setting('archive-error', '')
    // Archive mutates _meta, never code; refresh the sibling index only.
    const ns = (
      this.env as unknown as {
        REPO_INDEX?: {
          idFromName(n: string): unknown
          get(id: unknown): {
            refresh(owner: string, repo: string): Promise<void>
          }
        }
      }
    ).REPO_INDEX
    await ns?.get(ns.idFromName(identity)).refresh(owner, repo)
  }
  async alarm() {
    if (!(await this.writable())) {
      await this.wakeAlarm(Date.now() + 60000)
      return
    }
    if (this.working) return this.working
    this.working = this.work().finally(() => {
      this.working = null
    })
    return this.working
  }
  private async work() {
    await this.workflowWork()
    await this.eventWork()
    this.tx(() => this.runs.sweep())
    await this.offer()
    this.wake()
    let retry = false
    for (const r of this.runs.ownRunners())
      if (
        r.lastSeen &&
        Date.now() - r.lastSeen >= 120000 &&
        this.runs.setting('runner-online:' + r.id) === '1'
      ) {
        this.runnerEvent('offline', r)
        this.runs.setting('runner-online:' + r.id, '0')
      }
    for (const r of this.runs.unarchived()) {
      try {
        await this.archive(r.id)
      } catch {
        retry = true
        this.runs.setting(
          'archive-error',
          'run summary pending; verify ARTIFACTS_TOKEN and _meta write access',
        )
      }
    }
    if (this.merges.needed()) {
      try {
        retry = (await this.resumeMerges()) || retry
        this.runs.setting('merge-error', '')
      } catch {
        retry = true
        this.runs.setting('merge-error', 'Merge queue pending; background recovery will retry')
      }
    }
    this.tx(() => this.runs.pruneLogs())
    if (this.env.EVENTS) {
      try {
        retry = (await this.outbox.flush((e) => emit(e, this.env))) || retry
      } catch {
        retry = true
      }
    }
    if (
      retry ||
      JSON.parse(this.runs.setting('page:workflows') ?? '[]').length ||
      this.runs.events().length ||
      this.runs.activeRuns().length > 0 ||
      this.runs
        .ownRunners()
        .some((r) => this.runs.setting('runner-online:' + r.id) === '1')
    )
      await this.wakeAlarm(Date.now() + (retry ? 60_000 : 15_000))
  }
}
