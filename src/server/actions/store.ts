export type { Status } from '../../engine/types.js'
import type { Status } from '../../engine/types.js'
import { actionEventSchema } from '../events/actions-source.js'
import type { SQL } from '../../engine/repo-index-store.js'
import {
  context,
  expression,
  interpolate,
  labelsMatch,
  resolveValues,
  runnerLabels,
  type Event,
  type Job,
  type Step,
  type Values,
  type Workflow,
} from '../../engine/actions/workflow.js'
export interface Run {
  id: number
  event: Event
  workflow: Workflow
  status: Status
  created: number
  started: number | null
  finished: number | null
  reason: string | null
  archived: number
}
export interface StoredJob {
  id: number
  run: number
  spec: Job
  status: Status
  runner: string | null
  runnerName: string | null
  lease: string | null
  deadline: number | null
  started: number | null
  finished: number | null
  reason: string | null
}
export interface StoredStep {
  job: number
  position: number
  name: string
  status: Status
  exit: number | null
  started: number | null
  finished: number | null
}
export interface Runner {
  id: string
  name: string
  owner: string
  os: string
  arch: string
  labels: string[]
  lastSeen: number
  job: number | null
  run: number | null
}
export { runnerStatus } from '../../engine/actions/runner-status.js'
export interface Assignment {
  schema: 1
  checkoutToken?: string
  workspaceToken: string
  github: Values
  job: number
  run: number
  lease: string
  sha: string
  ref: string
  repository: string
  spec: Job
  steps: ResolvedStep[]
  timeout: number
}
export interface ResolvedStep extends Omit<Step, 'condition'> {
  when: { success: boolean; failure: boolean; cancelled: boolean }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS action_registration_tokens(hash TEXT PRIMARY KEY,owner TEXT,repo TEXT,expires INTEGER,used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS action_checkout_tokens(hash TEXT PRIMARY KEY,runner TEXT,job INTEGER,lease TEXT);
CREATE TABLE IF NOT EXISTS action_inherited_runners(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS action_approvals(run INTEGER PRIMARY KEY,actor TEXT);
CREATE TABLE IF NOT EXISTS action_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,workflow TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,started INTEGER,finished INTEGER,reason TEXT,archived INTEGER DEFAULT 0,dedupe TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS action_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,run INTEGER NOT NULL,spec TEXT NOT NULL,status TEXT NOT NULL,runner TEXT,runnerName TEXT,lease TEXT,deadline INTEGER,started INTEGER,finished INTEGER,reason TEXT);
CREATE INDEX IF NOT EXISTS actions_job_queue ON action_jobs(status,id);
CREATE INDEX IF NOT EXISTS actions_run_jobs ON action_jobs(run,id);
CREATE TABLE IF NOT EXISTS action_steps(job INTEGER,position INTEGER,name TEXT,status TEXT,exit INTEGER,started INTEGER,finished INTEGER,PRIMARY KEY(job,position));
CREATE TABLE IF NOT EXISTS action_runners(id TEXT PRIMARY KEY,name TEXT,owner TEXT,os TEXT,arch TEXT,labels TEXT,token TEXT,lastSeen INTEGER,job INTEGER,run INTEGER);
CREATE TABLE IF NOT EXISTS action_logs(job INTEGER,position INTEGER,seq INTEGER,text TEXT,PRIMARY KEY(job,position,seq));
CREATE TABLE IF NOT EXISTS action_log_batches(job INTEGER,position INTEGER,batch INTEGER,PRIMARY KEY(job,position,batch));
CREATE TABLE IF NOT EXISTS action_masks(job INTEGER PRIMARY KEY,values_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS action_events(key TEXT PRIMARY KEY,event TEXT NOT NULL,attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS action_objects(hash TEXT,kind TEXT,json TEXT NOT NULL,PRIMARY KEY(hash,kind));
CREATE TABLE IF NOT EXISTS action_workflows(sha TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS action_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`
const TERMINAL = new Set<Status>(['success', 'failure', 'cancelled', 'skipped'])
export const LOG_CAP = 2 * 1024 * 1024
export const LEASE_MS = 60_000
export function maskLog(text: string, values: string[]): string {
  // Logs arrive in batches of whole lines, so a multi-line secret (a PEM key,
  // say) can straddle two batches. Like GitHub, mask every line of such a
  // secret on its own too (lines of 8+ characters, so a stray "}" or "-----"
  // fragment of common text isn't blanked everywhere).
  const lines = values.flatMap((v) =>
    v.includes('\n')
      ? v
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length >= 8)
      : [],
  )
  for (const v of [...new Set([...values, ...lines].filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  ))
    text = text.split(v).join('***')
  return text.replace(/\b(?:gf|gr|gro|grt|gc)_[a-f0-9]{32}\b/g, '***')
}
/** All transitions are synchronous SQLite statements. The DO wraps mutating
 * calls in storage.transactionSync; no network await can split assignment. */
export class RunStore {
  private sql: SQL
  constructor(sql: SQL) {
    this.sql = sql
    sql.exec(SCHEMA)
    actionEventSchema(sql)
  }
  rows<T extends Record<string, unknown>>(
    q: string,
    ...args: (string | number | null)[]
  ) {
    return [...this.sql.exec<T>(q, ...args)]
  }
  setting(k: string, v?: string) {
    if (v !== undefined)
      this.sql.exec('INSERT OR REPLACE INTO action_settings VALUES (?,?)', k, v)
    return (
      this.rows<{ value: string }>(
        'SELECT value FROM action_settings WHERE key=?',
        k,
      )[0]?.value ?? null
    )
  }
  object(hash: string, kind: string, value?: unknown) {
    if (value !== undefined)
      this.sql.exec(
        'INSERT OR IGNORE INTO action_objects VALUES (?,?,?)',
        hash,
        kind,
        JSON.stringify(value),
      )
    const r = this.rows<{ json: string }>(
      'SELECT json FROM action_objects WHERE hash=? AND kind=?',
      hash,
      kind,
    )[0]
    return r ? JSON.parse(r.json) : null
  }
  cacheWorkflows(sha: string, workflows?: Workflow[]) {
    sha = `v1:${sha}`
    if (workflows)
      this.sql.exec(
        'INSERT OR IGNORE INTO action_workflows VALUES (?,?)',
        sha,
        JSON.stringify(workflows),
      )
    const r = this.rows<{ json: string }>(
      'SELECT json FROM action_workflows WHERE sha=?',
      sha,
    )[0]
    return r ? (JSON.parse(r.json) as Workflow[]) : null
  }
  deliver(event: Event) {
    this.sql.exec(
      'INSERT OR IGNORE INTO action_events(key,event) VALUES (?,?)',
      event.key,
      JSON.stringify(event),
    )
  }
  events() {
    return this.rows<{ key: string; event: string; attempts: number }>(
      'SELECT key,event,attempts FROM action_events ORDER BY rowid LIMIT 10',
    )
  }
  acknowledge(key: string) {
    this.sql.exec('DELETE FROM action_events WHERE key=?', key)
  }
  retryEvent(key: string) {
    this.sql.exec(
      'UPDATE action_events SET attempts=attempts+1 WHERE key=?',
      key,
    )
  }
  private runRow(r: Record<string, unknown>): Run {
    return {
      ...r,
      event: JSON.parse(String(r.event)),
      workflow: JSON.parse(String(r.workflow)),
    } as unknown as Run
  }
  private jobRow(r: Record<string, unknown>): StoredJob {
    return { ...r, spec: JSON.parse(String(r.spec)) } as unknown as StoredJob
  }
  run(id: number): Run | null {
    const r = this.rows('SELECT * FROM action_runs WHERE id=?', id)[0]
    return r ? this.runRow(r) : null
  }
  activeRuns() {
    return this.rows(
      "SELECT * FROM action_runs WHERE status IN ('queued','running') ORDER BY id LIMIT 100",
    ).map((r) => this.runRow(r))
  }
  runsForSha(sha: string): Run[] {
    return this.rows(
      "SELECT * FROM action_runs WHERE json_extract(event,'$.sha')=? ORDER BY id DESC",
      sha,
    ).map((r) => this.runRow(r))
  }
  runs(limit = 50): Run[] {
    return this.rows(
      'SELECT * FROM action_runs ORDER BY id DESC LIMIT ?',
      Math.min(limit, 100),
    ).map((r) => this.runRow(r))
  }
  apiRuns(limit: number, offset: number) {
    return {
      total: this.rows<{ n: number }>(
        'SELECT count(*) AS n FROM action_runs',
      )[0].n,
      runs: this.rows(
        'SELECT * FROM action_runs ORDER BY id DESC LIMIT ? OFFSET ?',
        Math.min(100, Math.max(1, limit)),
        Math.max(0, offset),
      ).map((r) => this.runRow(r)),
    }
  }
  apiJob(id: number) {
    const row = this.rows('SELECT run FROM action_jobs WHERE id=?', id)[0]
    if (!row) return null
    const detail = this.detail(Number(row.run)),
      job = detail?.jobs.find((j) => j.id === id)
    return detail && job ? { run: detail.run, job } : null
  }
  jobs(run: number): StoredJob[] {
    return this.rows(
      'SELECT * FROM action_jobs WHERE run=? ORDER BY id',
      run,
    ).map((r) => this.jobRow(r))
  }
  steps(job: number): StoredStep[] {
    return this.rows(
      'SELECT * FROM action_steps WHERE job=? ORDER BY position',
      job,
    ) as unknown as StoredStep[]
  }
  private job(id: number): StoredJob {
    const r = this.rows('SELECT * FROM action_jobs WHERE id=?', id)[0]
    if (!r) throw new Error('job not found')
    return this.jobRow(r)
  }
  runners(): Runner[] {
    return this.rows(
      'SELECT id,name,owner,os,arch,labels,lastSeen,job,run FROM action_runners ORDER BY name',
    ).map(
      (r) =>
        ({ ...r, labels: JSON.parse(String(r.labels)) }) as unknown as Runner,
    )
  }
  register(
    r: Omit<Runner, 'lastSeen' | 'job' | 'run'>,
    hash: string,
    now = Date.now(),
  ) {
    const existing = this.rows(
      'SELECT id FROM action_runners WHERE name=? AND id NOT IN (SELECT id FROM action_inherited_runners)',
      r.name,
    )
    if (existing.length)
      throw new Error('runner name already registered; remove it first')
    this.sql.exec(
      'INSERT INTO action_runners VALUES (?,?,?,?,?,?,?,?,?,?)',
      r.id,
      r.name,
      r.owner,
      r.os,
      r.arch,
      JSON.stringify(runnerLabels(r.os, r.arch, r.labels)),
      hash,
      now,
      null,
      null,
    )
  }
  authenticate(hash: string): Runner | null {
    const r = this.rows(
      'SELECT id,name,owner,os,arch,labels,lastSeen,job,run FROM action_runners WHERE token=?',
      hash,
    )[0]
    return r
      ? ({ ...r, labels: JSON.parse(String(r.labels)) } as unknown as Runner)
      : null
  }
  remove(id: string, now = Date.now()) {
    const r = this.runners().find((r) => r.id === id)
    if (!r) throw new Error('runner not found')
    if (r.job) this.failJob(r.job, 'runner removed', now)
    this.sql.exec('DELETE FROM action_runners WHERE id=?', id)
  }
  enqueue(workflow: Workflow, event: Event, now = Date.now()): number {
    const dedupe = `${event.key}:${workflow.file}`,
      old = this.rows<{ id: number }>(
        'SELECT id FROM action_runs WHERE dedupe=?',
        dedupe,
      )[0]
    if (old) return old.id
    this.sql.exec(
      'INSERT INTO action_runs(event,workflow,status,created,finished,reason,dedupe) VALUES (?,?,?,?,?,?,?)',
      JSON.stringify(event),
      JSON.stringify(workflow),
      workflow.error ? 'failure' : 'queued',
      now,
      workflow.error ? now : null,
      workflow.error ?? null,
      dedupe,
    )
    const id = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0]
      .id
    for (const raw of workflow.jobs) {
      const ctx = context(event, raw.matrix, workflow.env),
        spec = { ...raw, name: interpolate(raw.name, ctx) }
      this.sql.exec(
        'INSERT INTO action_jobs(run,spec,status) VALUES (?,?,?)',
        id,
        JSON.stringify(spec),
        'queued',
      )
      const job = this.rows<{ id: number }>(
        'SELECT last_insert_rowid() AS id',
      )[0].id
      spec.steps.forEach((s, i) =>
        this.sql.exec(
          'INSERT INTO action_steps VALUES (?,?,?,?,?,?,?)',
          job,
          i,
          s.name,
          'queued',
          null,
          null,
          null,
        ),
      )
    }
    this.advance(id, now)
    return id
  }
  private advance(runId: number, now: number) {
    const run = this.run(runId)!
    if (TERMINAL.has(run.status)) return
    // Resolve skipped needs transitively so the run can't become stuck.
    let changed: boolean
    do {
      changed = false
      const jobs = this.jobs(runId)
      for (const j of jobs.filter((j) => j.status === 'queued')) {
        const deps = jobs.filter((d) => j.spec.needs.includes(d.spec.id))
        if (deps.some((d) => !TERMINAL.has(d.status))) continue
        const failed = deps.some((d) => d.status !== 'success'),
          ctx = context(run.event, j.spec.matrix, {
            ...run.workflow.env,
            ...j.spec.env,
          })
        const allowFailure = /\b(always|failure|cancelled)\(/.test(
          j.spec.condition ?? '',
        )
        if (
          (!allowFailure && failed) ||
          (j.spec.condition !== undefined &&
            !expression(j.spec.condition, ctx, failed ? 'failure' : 'success'))
        ) {
          this.sql.exec(
            "UPDATE action_jobs SET status='skipped',finished=? WHERE id=?",
            now,
            j.id,
          )
          this.sql.exec(
            "UPDATE action_steps SET status='skipped',finished=? WHERE job=?",
            now,
            j.id,
          )
          changed = true
        }
      }
    } while (changed)
    const jobs = this.jobs(runId)
    if (jobs.length && jobs.every((j) => TERMINAL.has(j.status))) {
      const status = jobs.some((j) => j.status === 'failure')
        ? 'failure'
        : jobs.some((j) => j.status === 'cancelled')
          ? 'cancelled'
          : 'success'
      this.sql.exec(
        'UPDATE action_runs SET status=?,finished=? WHERE id=?',
        status,
        now,
        runId,
      )
    }
  }
  claim(
    runner: Runner,
    now = Date.now(),
    onlyJob?: number,
  ): { job: StoredJob; run: Run } | null {
    if (!this.runners().some((r) => r.id === runner.id))
      throw new Error('invalid or revoked runner token')
    this.sql.exec(
      'UPDATE action_runners SET lastSeen=? WHERE id=?',
      now,
      runner.id,
    )
    if (this.runners().find((r) => r.id === runner.id)?.job) return null
    for (const r of this.activeRuns()) {
      this.advance(r.id, now)
      if (
        r.event.requiresApproval &&
        !this.rows('SELECT run FROM action_approvals WHERE run=?', r.id).length
      )
        continue
      const jobs = this.jobs(r.id)
      for (const j of jobs.filter(
        (j) =>
          j.status === 'queued' && (onlyJob === undefined || j.id === onlyJob),
      )) {
        if (
          jobs.some(
            (d) => j.spec.needs.includes(d.spec.id) && !TERMINAL.has(d.status),
          )
        )
          continue
        const ctx = context(r.event, j.spec.matrix)
        if (
          !labelsMatch(
            j.spec.labels.map((l) => interpolate(l, ctx)),
            runner.labels,
          )
        )
          continue
        const lease = crypto.randomUUID()
        this.sql.exec(
          "UPDATE action_jobs SET status='running',runner=?,runnerName=?,lease=?,deadline=?,started=? WHERE id=? AND status='queued'",
          runner.id,
          runner.name,
          lease,
          now + LEASE_MS,
          now,
          j.id,
        )
        this.sql.exec(
          'UPDATE action_runners SET job=?,run=? WHERE id=?',
          j.id,
          r.id,
          runner.id,
        )
        this.sql.exec(
          "UPDATE action_runs SET status='running',started=COALESCE(started,?) WHERE id=?",
          now,
          r.id,
        )
        return { job: this.job(j.id), run: this.run(r.id)! }
      }
    }
    return null
  }
  approve(run: number, actor: string) {
    if (!this.run(run)) throw Error('run not found')
    this.sql.exec(
      'INSERT OR REPLACE INTO action_approvals VALUES (?,?)',
      run,
      actor,
    )
  }
  ready(labels?: string[], now = Date.now()) {
    return this.activeRuns()
      .flatMap((r) => {
        this.advance(r.id, now)
        if (
          r.event.requiresApproval &&
          !this.rows('SELECT run FROM action_approvals WHERE run=?', r.id)
            .length
        )
          return []
        const jobs = this.jobs(r.id)
        return jobs
          .filter(
            (j) =>
              j.status === 'queued' &&
              !jobs.some(
                (d) =>
                  j.spec.needs.includes(d.spec.id) && !TERMINAL.has(d.status),
              ),
          )
          .map((j) => ({
            job: j.id,
            created: r.created,
            labels: j.spec.labels.map(l => interpolate(l, context(r.event, j.spec.matrix))),
          }))
          .filter(j => !labels || labelsMatch(j.labels, labels))
      })
      .sort((a, b) => a.created - b.created || a.job - b.job)
  }
  inherited(r: Omit<Runner, 'lastSeen' | 'job' | 'run'>) {
    if (!this.runners().some((x) => x.id === r.id)) {
      this.sql.exec(
        'INSERT INTO action_runners VALUES (?,?,?,?,?,?,?,?,?,?)',
        r.id,
        r.name,
        r.owner,
        r.os,
        r.arch,
        JSON.stringify(r.labels),
        '',
        0,
        null,
        null,
      )
      this.sql.exec(
        'INSERT OR IGNORE INTO action_inherited_runners VALUES (?)',
        r.id,
      )
    } else
      this.sql.exec(
        'UPDATE action_runners SET name=?,labels=? WHERE id=?',
        r.name,
        JSON.stringify(r.labels),
        r.id,
      )
  }
  ownRunners() {
    const inherited = new Set(
      this.rows<{ id: string }>('SELECT id FROM action_inherited_runners').map(
        (x) => x.id,
      ),
    )
    return this.runners().filter((r) => !inherited.has(r.id))
  }
  checkout(hash: string, runner: string, job: number, lease: string) {
    this.sql.exec(
      'INSERT INTO action_checkout_tokens VALUES (?,?,?,?)',
      hash,
      runner,
      job,
      lease,
    )
  }
  checkoutRunner(
    hash: string,
    now = Date.now(),
    job?: number | null,
    lease?: string | null,
  ) {
    const t = this.rows<{ runner: string; job: number; lease: string }>(
      'SELECT * FROM action_checkout_tokens WHERE hash=?',
      hash,
    )[0]
    if (!t) throw Error('invalid or revoked runner token')
    if (job !== undefined && (t.job !== job || t.lease !== lease))
      throw Error('job lease does not belong to this runner')
    const j = this.authorized(t.runner, t.job, t.lease)
    if (j.status !== 'running' || j.deadline === null || j.deadline <= now)
      throw Error('invalid or revoked runner token')
    const r = this.runners().find((r) => r.id === t.runner)
    if (!r) throw Error('invalid or revoked runner token')
    return r
  }
  authorized(runner: string, job: number, lease: string) {
    const j = this.job(job)
    if (j.runner !== runner || j.lease !== lease)
      throw new Error('job lease does not belong to this runner')
    return j
  }
  heartbeat(
    runner: string,
    job: number | null,
    lease: string | null,
    now = Date.now(),
  ) {
    this.sql.exec(
      'UPDATE action_runners SET lastSeen=? WHERE id=?',
      now,
      runner,
    )
    if (!job || !lease) return { cancel: false }
    const j = this.authorized(runner, job, lease)
    if (j.status === 'running')
      this.sql.exec(
        'UPDATE action_jobs SET deadline=? WHERE id=?',
        now + LEASE_MS,
        job,
      )
    return { cancel: j.status !== 'running' }
  }
  saveMasks(job: number, cipher: string) {
    this.sql.exec(
      'INSERT OR REPLACE INTO action_masks VALUES (?,?)',
      job,
      cipher,
    )
  }
  encryptedMasks(job: number): string | null {
    return (
      this.rows<{ values_json: string }>(
        'SELECT values_json FROM action_masks WHERE job=?',
        job,
      )[0]?.values_json ?? null
    )
  }
  append(
    runner: string,
    job: number,
    lease: string,
    position: number,
    batch: number,
    lines: string[],
    masks: string[],
  ) {
    const j = this.authorized(runner, job, lease)
    if (j.status !== 'running') throw new Error('job is not running')
    if (!this.steps(job)[position]) throw new Error('unknown step')
    if (
      !Number.isSafeInteger(batch) ||
      batch < 0 ||
      !Array.isArray(lines) ||
      lines.length > 256 ||
      lines.some((s) => typeof s !== 'string' || s.length > 32_768)
    )
      throw new Error('invalid log batch')
    if (
      this.rows(
        'SELECT 1 FROM action_log_batches WHERE job=? AND position=? AND batch=?',
        job,
        position,
        batch,
      ).length
    )
      return
    // CLI sends complete lines, not arbitrary transport chunks. A value split
    // across network chunks is joined before this boundary and still masked.
    const text = maskLog(lines.join('\n') + '\n', masks)
    const used = this.rows<{ bytes: number }>(
      'SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) AS bytes FROM action_logs WHERE job IN (SELECT id FROM action_jobs WHERE run=?)',
      j.run,
    )[0].bytes
    if (used < LOG_CAP) {
      const next = this.rows<{ seq: number }>(
        'SELECT COALESCE(MAX(seq),-1)+1 AS seq FROM action_logs WHERE job=? AND position=?',
        job,
        position,
      )[0].seq
      const bytes = new TextEncoder().encode(text),
        remaining = LOG_CAP - used
      const note = '\n[gild: log cap reached; further output omitted]\n'.slice(
        0,
        remaining,
      )
      const capped =
        bytes.length > remaining
          ? new TextDecoder().decode(
              bytes.slice(0, Math.max(0, remaining - note.length)),
            ) + note
          : text
      this.sql.exec(
        'INSERT INTO action_logs VALUES (?,?,?,?)',
        job,
        position,
        next,
        capped,
      )
    }
    if (used >= LOG_CAP) return
    this.sql.exec(
      'INSERT INTO action_log_batches VALUES (?,?,?)',
      job,
      position,
      batch,
    )
  }
  jobRun(job: number) {
    return this.job(job).run
  }
  allLogs(job: number, position: number) {
    return this.rows<{ seq: number; text: string }>(
      'SELECT seq,text FROM action_logs WHERE job=? AND position=? ORDER BY seq',
      job,
      position,
    )
  }
  logs(job: number, position: number, after = -1) {
    return this.rows<{ seq: number; text: string }>(
      'SELECT seq,text FROM action_logs WHERE job=? AND position=? AND seq>? ORDER BY seq LIMIT 128',
      job,
      position,
      after,
    )
  }
  step(
    runner: string,
    job: number,
    lease: string,
    position: number,
    status: Status,
    exit: number | null,
    now = Date.now(),
  ) {
    const j = this.authorized(runner, job, lease)
    if (j.status !== 'running') throw new Error('job is not running')
    const s = this.steps(job)[position]
    if (!s) throw new Error('unknown step')
    if (
      !['running', 'success', 'failure', 'skipped', 'cancelled'].includes(
        status,
      ) ||
      (exit !== null && (!Number.isInteger(exit) || exit < 0 || exit > 255))
    )
      throw new Error('invalid step result')
    if (TERMINAL.has(s.status)) {
      if (status === s.status && exit === s.exit) return
      throw new Error('step already finished')
    }
    if (
      status === 'running' &&
      this.steps(job).some(
        (s) => s.position < position && !TERMINAL.has(s.status),
      )
    )
      throw new Error('previous step has not finished')
    this.sql.exec(
      "UPDATE action_steps SET status=?,exit=?,started=CASE WHEN ?='running' THEN COALESCE(started,?) ELSE started END,finished=? WHERE job=? AND position=?",
      status,
      exit,
      status,
      now,
      TERMINAL.has(status) ? now : null,
      job,
      position,
    )
  }
  finish(
    runner: string,
    job: number,
    lease: string,
    status: 'success' | 'failure' | 'cancelled',
    reason: string | null,
    now = Date.now(),
  ) {
    const j = this.authorized(runner, job, lease)
    if (TERMINAL.has(j.status)) return
    if (!['success', 'failure', 'cancelled'].includes(status))
      throw new Error('invalid job result')
    const steps = this.steps(job)
    if (
      status === 'success' &&
      steps.some(
        (s) =>
          !TERMINAL.has(s.status) ||
          (s.status === 'failure' && !j.spec.steps[s.position].continueOnError),
      )
    )
      throw new Error('successful job has unfinished or failed steps')
    this.sql.exec(
      'UPDATE action_jobs SET status=?,finished=?,reason=?,deadline=NULL WHERE id=?',
      status,
      now,
      reason ? reason.slice(0, 2000) : null,
      job,
    )
    this.sql.exec(
      "UPDATE action_steps SET status='skipped',finished=? WHERE job=? AND status IN ('queued','running')",
      now,
      job,
    )
    this.sql.exec(
      'UPDATE action_runners SET job=NULL,run=NULL WHERE id=? AND job=?',
      runner,
      job,
    )
    this.sql.exec('DELETE FROM action_masks WHERE job=?', job)
    this.advance(j.run, now)
  }
  private failJob(job: number, reason: string, now: number) {
    const j = this.job(job)
    if (j.runner && j.lease)
      this.finish(j.runner, job, j.lease, 'failure', reason, now)
    else {
      this.sql.exec(
        "UPDATE action_jobs SET status='failure',finished=?,reason=? WHERE id=?",
        now,
        reason,
        job,
      )
      this.sql.exec(
        "UPDATE action_steps SET status='skipped',finished=? WHERE job=?",
        now,
        job,
      )
      this.advance(j.run, now)
    }
  }
  sweep(now = Date.now()) {
    for (const r of this.rows<{ id: number }>(
      "SELECT id FROM action_jobs WHERE status='running' AND deadline<?",
      now,
    ))
      this.failJob(r.id, 'runner heartbeat lost for 60 seconds', now)
    for (const r of this.activeRuns()) {
      for (const j of this.jobs(r.id))
        if (j.status === 'running' && now - j.started! > j.spec.timeout)
          this.failJob(j.id, 'job timeout exceeded', now)
      if (now - r.created > 24 * 3600_000)
        for (const j of this.jobs(r.id).filter((j) => j.status === 'queued'))
          this.failJob(
            j.id,
            'no matching runner became available within 24 hours',
            now,
          )
    }
  }
  cancel(run: number, now = Date.now()) {
    if (!this.run(run)) throw new Error('run not found')
    for (const j of this.jobs(run).filter((j) => !TERMINAL.has(j.status))) {
      this.sql.exec(
        "UPDATE action_jobs SET status='cancelled',finished=?,deadline=NULL,reason='cancelled by repo writer' WHERE id=?",
        now,
        j.id,
      )
      this.sql.exec(
        "UPDATE action_steps SET status='cancelled',finished=? WHERE job=? AND status IN ('queued','running')",
        now,
        j.id,
      )
      // Keep the runner occupied until its next poll/heartbeat observes cancellation.
    }
    this.sql.exec(
      "UPDATE action_runs SET status='cancelled',finished=? WHERE id=? AND status IN ('queued','running')",
      now,
      run,
    )
  }
  releaseCancelled(runner: string) {
    const r = this.runners().find((r) => r.id === runner)
    if (r?.job && TERMINAL.has(this.job(r.job).status)) {
      this.sql.exec('DELETE FROM action_masks WHERE job=?', r.job)
      this.sql.exec(
        'UPDATE action_runners SET job=NULL,run=NULL WHERE id=?',
        runner,
      )
    }
  }
  unarchived(): Run[] {
    return this.rows(
      "SELECT * FROM action_runs WHERE status IN ('success','failure','cancelled') AND archived=0 ORDER BY id LIMIT 10",
    ).map((r) => this.runRow(r))
  }
  archived(run: number) {
    this.sql.exec('UPDATE action_runs SET archived=1 WHERE id=?', run)
  }
  detail(id: number) {
    const run = this.run(id)
    return run
      ? {
          run,
          jobs: this.jobs(id).map((j) => ({
            ...j,
            lease: undefined,
            steps: this.steps(j.id),
          })),
        }
      : null
  }
  summary(id: number) {
    const detail = this.detail(id)
    if (!detail) throw new Error('run not found')
    return { schema: 1, ...detail }
  }
  pruneLogs() {
    // Retain at most 32 finished runs of capped DO logs (~64MiB), irrespective
    // of R2. R2 archive is the long-term full (up to per-run cap) log record.
    this.sql.exec(
      'DELETE FROM action_logs WHERE job IN (SELECT id FROM action_jobs WHERE run IN (SELECT id FROM action_runs WHERE archived=1 ORDER BY id DESC LIMIT -1 OFFSET 32))',
    )
    this.sql.exec(
      "DELETE FROM action_log_batches WHERE job IN (SELECT id FROM action_jobs WHERE status IN ('success','failure','cancelled','skipped'))",
    )
  }
}
export function resolveAssignment(
  job: StoredJob,
  run: Run,
  secrets: Values,
): Assignment {
  const workspaceToken = `__GILD_WORKSPACE_${crypto.randomUUID()}__`
  let ctx = context(run.event, job.spec.matrix, {}, secrets)
  Object.assign(ctx.github, {
    workspace: workspaceToken,
    run_id: String(run.id),
    run_number: String(run.id),
    workflow: run.workflow.name,
    job: job.spec.id,
  })
  const env = { ...resolveValues(run.workflow.env, ctx) }
  ctx.env = env
  Object.assign(env, resolveValues(job.spec.env, ctx))
  ctx.env = env
  const steps = job.spec.steps.map((s): ResolvedStep => {
    const stepCtx = { ...ctx, env: { ...env, ...resolveValues(s.env, ctx) } }
    return {
      ...s,
      name: interpolate(s.name, stepCtx),
      run: s.run === undefined ? undefined : interpolate(s.run, stepCtx),
      uses: s.uses === undefined ? undefined : interpolate(s.uses, stepCtx),
      env: stepCtx.env,
      with: resolveValues(s.with, stepCtx),
      directory: interpolate(s.directory, stepCtx),
      shell: interpolate(s.shell, stepCtx),
      when: {
        success:
          s.condition === undefined ||
          Boolean(expression(s.condition, stepCtx, 'success')),
        failure:
          s.condition !== undefined &&
          /\b(always|failure|cancelled)\(/.test(s.condition) &&
          Boolean(expression(s.condition, stepCtx, 'failure')),
        cancelled:
          s.condition !== undefined &&
          Boolean(expression(s.condition, stepCtx, 'cancelled')),
      },
    }
  })
  return {
    schema: 1,
    workspaceToken,
    github: Object.fromEntries(
      Object.entries(ctx.github).filter(([, v]) => typeof v === 'string'),
    ) as Values,
    job: job.id,
    run: run.id,
    lease: job.lease!,
    sha: run.event.sha,
    ref: run.event.ref,
    repository: run.event.repository,
    spec: job.spec,
    steps,
    timeout: job.spec.timeout,
  }
}
