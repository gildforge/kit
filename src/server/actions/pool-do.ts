import { PoolReady, type ReadyJob } from '../../engine/actions/pool-ready.js'
import { validateRunner, validateGroup } from '../../engine/actions/runner-validation.js'
import { rawRepo, nsFor } from '../artifacts.js'
import { ApiError } from '../../engine/api/errors.js'
import { runnerLabels, labelsMatch } from '../../engine/actions/workflow.js'
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState } from '@cloudflare/workers-types'
import type { SQL } from '../../engine/repo-index-store.js'
import {
  PoolStore,
  groupEligibility,
  type PoolRunner,
  type RunnerGroup,
} from '../../engine/actions/pool-store.js'
import { d1Store } from '../drivers/d1.js'
import { mayRead, repoAccess } from '../repo-read.js'
import { hashToken } from '../token-verifier.js'
import type { RunQueue, ActionEnv } from './queue-do.js'
import { EventOutbox } from '../../engine/events/outbox.js'
import { emit } from '../events/binding.js'
export type QueueStub = {
  [K in 'ready' | 'poolClaim' | 'leasesLive' | 'runnerJobs']: (
    ...a: Parameters<RunQueue[K]>
  ) => Promise<Awaited<ReturnType<RunQueue[K]>>>
}
export interface PoolEnv extends Omit<ActionEnv, 'REPO_INDEX'> {
  RUN_QUEUE: { idFromName(name: string): unknown; get(id: unknown): QueueStub }
  REPO_INDEX: {
    idFromName(name: string): unknown
    get(id: unknown): { metaFile(path: string): Promise<string | null> }
  }
}
export class RunnerPool extends DurableObject<PoolEnv> {
  protected pool: PoolStore
  private outbox: EventOutbox
  private readiness = new PoolReady()
  // Scheduling hints only: candidate() still reads live access at every claim.
  private accessHints = new Map<string, Promise<{ readable: boolean; isPublic: boolean }>>()
  constructor(ctx: DurableObjectState, env: PoolEnv) {
    super(ctx as never, env)
    this.pool = new PoolStore(ctx.storage.sql as unknown as SQL)
    this.outbox = new EventOutbox(ctx.storage.sql as unknown as SQL)
  }
  async init(owner: string) {
    const previous = this.pool.owner()
    if (previous && previous !== owner) {
      if ((await d1Store(this.env.DB).settings.canonical(previous)) !== owner)
        throw Error('owner mismatch')
      this.renameScope(previous, owner)
    }
    this.pool.owner(owner)
  }
  renameScope(from: string, to: string) {
    const rename = (key: string) =>
      key === from || key.startsWith(from + '/')
        ? to + key.slice(from.length)
        : key
    this.ctx.storage.transactionSync(() => {
      for (const g of this.pool.groups())
        this.pool.saveGroup({ ...g, repositories: g.repositories.map(rename) })
      for (const r of this.pool.runners())
        this.pool.saveRunner({
          ...r,
          owner: rename(r.owner),
          assignment: r.assignment
            ? { ...r.assignment, repository: rename(r.assignment.repository) }
            : null,
        })
      for (const r of this.pool.repositories()) {
        this.pool.rows(
          'DELETE FROM pool_repos WHERE repository=?',
          r.repository,
        )
        this.pool.rows(
          'INSERT OR REPLACE INTO pool_repos VALUES (?,?)',
          rename(r.repository),
          r.queue_id,
        )
      }
      // A setup command names its owner; mint a new one after an owner rename.
      if (this.pool.owner() === from) {
        this.pool.rows('DELETE FROM pool_registrations')
        this.pool.owner(to)
      }
    })
    this.wake()
  }
  async purge() {
    this.wake()
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.pool = new PoolStore(this.ctx.storage.sql as unknown as SQL)
    this.outbox = new EventOutbox(this.ctx.storage.sql as unknown as SQL)
  }
  private queue(id: string) {
    return this.env.RUN_QUEUE.get(this.env.RUN_QUEUE.idFromName(id))
  }
  private wake() {
    this.accessHints.clear()
    this.readiness.reset()
  }
  private event(action: string, r: PoolRunner) {
    this.outbox.put({
      id: crypto.randomUUID(),
      event: 'runner',
      repository: null,
      audience: r.owner,
      payload: {
        action,
        owner: r.owner,
        runner: {
          id: r.id,
          name: r.name,
          os: r.os,
          arch: r.arch,
          labels: r.labels,
          group: r.group,
        },
      },
    })
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 1))
  }
  async alarm() {
    this.pool.pruneRegistrations()
    await this.reconcile()
    let retry = false
    for (const r of this.pool.runners())
      if (
        r.lastSeen &&
        !r.reportedOffline &&
        Date.now() - r.lastSeen >= 120000
      ) {
        this.event('offline', r)
        this.pool.saveRunner({ ...r, reportedOffline: true })
      }
    if (this.env.EVENTS)
      try {
        retry = await this.outbox.flush((e) => emit(e, this.env))
      } catch {
        retry = true
      }
    if (
      retry ||
      this.pool.runners().some((r) => r.lastSeen && !r.reportedOffline)
    )
      await this.ctx.storage.setAlarm(Date.now() + (retry ? 60000 : 15000))
    else if (this.pool.nextRegistrationExpiry() !== null)
      await this.ctx.storage.setAlarm(this.pool.nextRegistrationExpiry()!)
  }
  async register(
    by: string,
    data: Pick<PoolRunner, 'name' | 'os' | 'arch' | 'labels'>,
    group = 'default',
    registration?: string,
  ) {
    data = validateRunner(data)
    const token = 'gro_' + crypto.randomUUID().replaceAll('-', ''),
      hash = await hashToken(token),
      registrationHash = registration ? await hashToken(registration) : null
    const r = this.ctx.storage.transactionSync(() => {
      if (registrationHash)
        this.pool.consume(registrationHash, this.pool.owner(), group)
      else if (!by) throw Error('owner administrator required')
      return this.pool.register(data, hash, group)
    })
    this.event('registered', r)
    return { id: r.id, token }
  }
  async registration(group = 'default') {
    const token = 'grt_' + crypto.randomUUID().replaceAll('-', '')
    this.pool.registration(await hashToken(token), this.pool.owner(), group)
    await this.ctx.storage.setAlarm(Date.now() + 1)
    return { token, expires_at: new Date(Date.now() + 3600_000).toISOString() }
  }
  async authenticate(token: string) {
    if (!token.startsWith('gro_'))
      throw Error('invalid or revoked runner token')
    return this.pool.authenticate(await hashToken(token))
  }
  groups() {
    return this.pool.groups()
  }
  group(id: string) {
    return this.pool.group(id)
  }
  async saveGroup(data: Partial<RunnerGroup> & { name?: string }, id?: string) {
    data = validateGroup(data, !!id)
    const base = id
      ? this.pool.group(id)
      : {
          id: crypto.randomUUID(),
          name: '',
          visibility: 'selected' as const,
          allow_public_repositories: false,
          repositories: [],
        }
    if (base.id === 'default' && data.name && data.name !== 'Default')
      throw Object.assign(Error('Default group name cannot be changed'), {
        status: 422,
      })
    if (data.repositories) {
      const owner = this.pool.owner(),
        st = d1Store(this.env.DB)
      const ns = nsFor(owner, (await st.getOrg(owner)) ? 'org' : 'user')
      if (!this.env.ARTIFACTS_TOKEN) throw new ApiError(503, 'Repository storage unavailable')
      await Promise.all(
        data.repositories.map(async (repository) => {
          const [repoOwner, repo] = repository.split('/')
          if (repoOwner !== owner) throw new ApiError(422, 'repository belongs to another owner')
          try {
            await rawRepo(ns, repo, 'GET', undefined, this.env.ARTIFACTS_TOKEN)
            if (!(await this.access(repository)).readable) throw new ApiError(404, 'Repository not found')
          } catch (e) {
            if ((e as { status?: number }).status === 404)
              throw new ApiError(422, 'Repository not found: ' + repository)
            throw e
          }
        }),
      )
    }
    const g = this.pool.saveGroup({ ...base, ...data, id: base.id })
    this.wake()
    return g
  }
  removeGroup(id: string) {
    this.pool.removeGroup(id)
    this.wake()
  }
  remove(id: string) {
    const r = this.pool.runner(id)
    this.pool.removeRunner(id)
    this.event('removed', r)
    this.wake()
  }
  patch(id: string, data: { group?: string; labels?: string[] }) {
    const r = this.pool.runner(id)
    if (data.group) r.group = this.pool.group(data.group).id
    if (data.labels) r.labels = runnerLabels(r.os, r.arch, data.labels)
    this.pool.saveRunner(r)
    this.wake()
    return r
  }
  async access(repository: string) {
    const [owner, repo] = repository.split('/')
    if (owner !== this.pool.owner()) return { readable: false, isPublic: false }
    const st = d1Store(this.env.DB),
      state = await st.settings.state(repository),
      ownerState = await st.settings.state(owner)
    if (
      state.id.startsWith('reserve:') ||
      (await st.settings.canonical(repository)) !== repository ||
      state.deletedAt !== null ||
      state.archived ||
      state.moving ||
      ownerState.deletedAt !== null ||
      ownerState.archived ||
      ownerState.moving
    )
      return { readable: false, isPublic: false }
    const services = {
      store: st,
      index: async (_o: string, _r: string) =>
        this.env.REPO_INDEX.get(this.env.REPO_INDEX.idFromName(state.id)),
    }
    // Pool operations already require the owner's authority and validate repo
    // existence before adding it. An unknown cold policy is private: structural
    // ownership can schedule it, while public-only groups must wait for its ACL.
    const policy = await repoAccess(services, owner, repo) ?? {meta:null,acl:{visibility:'private'},pending:true}
    return {
      readable: await mayRead(services, owner, repo, owner, policy),
      isPublic: await mayRead(services, owner, repo, null, policy),
    }
  }
  private accessHint(repository: string) {
    let hint = this.accessHints.get(repository)
    if (!hint) {
      hint = this.access(repository)
      this.accessHints.set(repository, hint)
      const saved = hint
      void hint.catch(() => {
        if (this.accessHints.get(repository) === saved) this.accessHints.delete(repository)
      })
    }
    return hint
  }
  async eligibility(id: string, repository: string) {
    const a = await this.access(repository),
      r = this.pool.runner(id),
      g = this.pool.group(r.group)
    return groupEligibility(g, repository, a.readable, a.isPublic)
  }
  async candidate(id: string, repository: string) {
    const access = await this.access(repository),
      r = this.pool.runners().find((r) => r.id === id)
    return r &&
      groupEligibility(
        this.pool.group(r.group),
        repository,
        access.readable,
        access.isPublic,
      ) === null
      ? r
      : null
  }
  /** Reconcile leases once per repository on alarm/overview, never per poll. */
  private async reconcile() {
    const runners = this.pool.runners()
    await Promise.all(this.pool.repositories().map(async repo => {
      const assigned = runners.filter(r => r.assignment?.repository === repo.repository && !r.assignment?.lease.startsWith('import:'))
      if (!assigned.length) return
      const live = await this.queue(repo.queue_id).leasesLive(assigned.map(r => ({
        runner: r.id, job: r.assignment!.job, lease: r.assignment!.lease,
      })))
      for (let i = 0; i < assigned.length; i++) {
        const before = assigned[i], current = this.pool.runners().find(r => r.id === before.id)
        if (!live[i] && current?.assignment?.lease === before.assignment!.lease)
          this.pool.saveRunner({ ...current, assignment: null })
      }
    }))
  }
  completed(id: string, lease: string) {
    const r = this.pool.runners().find(r => r.id === id)
    if (r?.assignment?.lease === lease) this.pool.saveRunner({ ...r, assignment: null })
  }
  async overview(repository?: string) {
    const access = repository ? await this.access(repository) : null
    await this.reconcile()
    const runners = this.pool.runners().map((r) => {
      const reason =
        repository && access
          ? groupEligibility(
              this.pool.group(r.group),
              repository,
              access.readable,
              access.isPublic,
            )
          : null
      return {
        ...r,
        group_name: this.pool.group(r.group).name,
        inherited: !!repository,
        eligible: reason === null,
        ineligible_reason: reason,
      }
    })
    return { runners, groups: this.pool.groups() }
  }
  offer(repository: string, queue: string, jobs: ReadyJob[]) {
    this.pool.offer(repository, queue)
    this.accessHints.delete(repository)
    this.readiness.offer(queue, jobs)
  }
  async recent(id: string) {
    this.pool.runner(id)
    return (
      await Promise.all(
        this.pool
          .repositories()
          .map((r) => this.queue(r.queue_id).runnerJobs(id)),
      )
    )
      .flat()
      .slice(0, 100)
  }
  touch(id: string) {
    const r = this.pool.runners().find((r) => r.id === id)
    if (r)
      this.pool.saveRunner({
        ...r,
        lastSeen: Date.now(),
        reportedOffline: false,
      })
  }
  async reserveImport(token:string,repository:string,lease:string) {
    let r=await this.authenticate(token)
    if(!await this.candidate(r.id,repository)) return false
    r=await this.authenticate(token)
    if(r.assignment) return false
    this.pool.saveRunner({...r,assignment:{repository,job:0,run:0,lease}})
    return true
  }
  async poll(token: string, wait = 20000) {
    let r = await this.authenticate(token)
    if (!r.lastSeen || Date.now() - r.lastSeen >= 120000)
      this.event('online', r)
    r = this.pool.saveRunner({
      ...r,
      lastSeen: Date.now(),
      reportedOffline: false,
    })
    if (r.assignment?.lease.startsWith('pending:') &&
        Date.now() - Number(r.assignment.lease.slice(8)) > 60000)
      this.pool.saveRunner({ ...r, assignment: null })
    const claim = async () => {
      r = await this.authenticate(token)
      if (r.assignment) return null
      const candidates = [] as {
        job: number
        created: number
        repository: string
        queue_id: string
      }[]
      candidates.push(
        ...(
          await Promise.all(
            this.pool.repositories().map(async (repo) => {
              const access = await this.accessHint(repo.repository)
              if (groupEligibility(this.pool.group(r.group), repo.repository, access.readable, access.isPublic) !== null)
                return []
              return (await this.readiness.read(repo.queue_id, () => this.queue(repo.queue_id).ready()))
                .filter(job => labelsMatch(job.labels, r.labels))
                .map(job => ({ ...repo, ...job }))
            }),
          )
        ).flat(),
      )
      candidates.sort(
        (a, b) =>
          a.created - b.created ||
          a.repository.localeCompare(b.repository) ||
          a.job - b.job,
      )
      // Reserve this runner before the cross-DO call; concurrent polls cannot
      // lease jobs from two repositories to the same physical machine.
      r = await this.authenticate(token)
      if (r.assignment) return null
      this.pool.saveRunner({
        ...r,
        assignment: {
          repository: '',
          job: 0,
          run: 0,
          lease: 'pending:' + Date.now(),
        },
      })
      try {
        for (const c of candidates) {
          const assignment = await this.queue(c.queue_id).poolClaim(r, c.job)
          if (!assignment) continue
          const current = await this.authenticate(token)
          this.pool.saveRunner({
            ...current,
            assignment: {
              repository: c.repository,
              job: assignment.job,
              run: assignment.run,
              lease: assignment.lease,
            },
          })
          return assignment
        }
        return null
      } finally {
        const current = this.pool.runners().find((x) => x.id === r.id)
        if (current?.assignment?.lease.startsWith('pending:'))
          this.pool.saveRunner({ ...current, assignment: null })
      }
    }
    let found = await claim()
    if (!found && wait > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.readiness.remove(done)
          resolve()
        }
        const timer = setTimeout(done, Math.min(wait, 20000))
        this.readiness.wait(done, r.labels)
      })
      found = await claim()
    }
    return found
  }
}
