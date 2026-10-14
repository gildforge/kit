import { validateRunner } from './runner-validation.js'
import type { SQL } from '../repo-index-store.js'
import { runnerLabels } from './workflow.js'
export interface RunnerGroup {
  id: string
  name: string
  visibility: 'all' | 'selected'
  allow_public_repositories: boolean
  repositories: string[]
}
export interface PoolRunner {
  id: string
  name: string
  owner: string
  os: string
  arch: string
  labels: string[]
  group: string
  lastSeen: number
  reportedOffline?: boolean
  assignment: {
    repository: string
    job: number
    run: number
    lease: string
  } | null
}
export const REGISTRATION_TTL = 3600_000
export class PoolStore {
  private sql: SQL
  constructor(sql: SQL) {
    this.sql = sql
    sql.exec(`CREATE TABLE IF NOT EXISTS pool_groups(id TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_runners(id TEXT PRIMARY KEY,token TEXT UNIQUE,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_registrations(hash TEXT PRIMARY KEY,owner TEXT,group_id TEXT,expires INTEGER,used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS pool_repos(repository TEXT PRIMARY KEY,queue_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
    if (!this.groups().length)
      this.saveGroup({
        id: 'default',
        name: 'Default',
        visibility: 'all',
        allow_public_repositories: false,
        repositories: [],
      })
  }
  rows<T extends Record<string, unknown>>(
    q: string,
    ...a: (string | number | null)[]
  ) {
    return [...this.sql.exec<T>(q, ...a)]
  }
  owner(value?: string) {
    if (value)
      this.sql.exec(
        "INSERT OR REPLACE INTO pool_settings VALUES ('owner',?)",
        value,
      )
    return (
      this.rows<{ value: string }>(
        "SELECT value FROM pool_settings WHERE key='owner'",
      )[0]?.value ?? ''
    )
  }
  groups() {
    return this.rows<{ json: string }>(
      'SELECT json FROM pool_groups ORDER BY id',
    ).map((r) => JSON.parse(r.json) as RunnerGroup)
  }
  group(id: string) {
    const group = this.groups().find(
      (g) => g.id === id || g.name.toLowerCase() === id.toLowerCase(),
    )
    if (!group) throw Error('runner group not found')
    return group
  }
  saveGroup(g: RunnerGroup) {
    if (
      this.groups().some(
        (x) => x.id !== g.id && x.name.toLowerCase() === g.name.toLowerCase(),
      )
    )
      throw Error('runner group already exists')
    this.sql.exec(
      'INSERT OR REPLACE INTO pool_groups VALUES (?,?)',
      g.id,
      JSON.stringify(g),
    )
    return g
  }
  removeGroup(id: string) {
    const g = this.group(id)
    if (g.id === 'default') throw Error('Default group cannot be removed')
    if (this.runners().some((r) => r.group === g.id))
      throw Error('runner group still has runners')
    this.sql.exec('DELETE FROM pool_groups WHERE id=?', g.id)
  }
  runners() {
    return this.rows<{ json: string }>(
      'SELECT json FROM pool_runners ORDER BY id',
    ).map((r) => JSON.parse(r.json) as PoolRunner)
  }
  runner(id: string) {
    const r = this.runners().find((r) => r.id === id)
    if (!r) throw Error('runner not found')
    return r
  }
  authenticate(hash: string) {
    const row = this.rows<{ json: string }>(
      'SELECT json FROM pool_runners WHERE token=?',
      hash,
    )[0]
    if (!row) throw Error('invalid or revoked runner token')
    return JSON.parse(row.json) as PoolRunner
  }
  saveRunner(r: PoolRunner) {
    this.sql.exec(
      'UPDATE pool_runners SET json=? WHERE id=?',
      JSON.stringify(r),
      r.id,
    )
    return r
  }
  register(
    data: Pick<PoolRunner, 'name' | 'os' | 'arch' | 'labels'>,
    hash: string,
    group: string,
  ) {
    data = validateRunner(data)
    if (this.runners().some((r) => r.name === data.name))
      throw Error('runner name already registered')
    const r: PoolRunner = {
      ...data,
      id: crypto.randomUUID(),
      owner: this.owner(),
      group: this.group(group).id,
      labels: runnerLabels(data.os, data.arch, data.labels),
      lastSeen: 0,
      assignment: null,
    }
    this.sql.exec(
      'INSERT INTO pool_runners VALUES (?,?,?)',
      r.id,
      hash,
      JSON.stringify(r),
    )
    return r
  }
  removeRunner(id: string) {
    this.runner(id)
    this.sql.exec('DELETE FROM pool_runners WHERE id=?', id)
  }
  registration(hash: string, owner: string, group: string, now = Date.now()) {
    this.pruneRegistrations(now)
    this.sql.exec(
      'INSERT INTO pool_registrations(hash,owner,group_id,expires) VALUES (?,?,?,?)',
      hash,
      owner,
      this.group(group).id,
      now + REGISTRATION_TTL,
    )
  }
  pruneRegistrations(now = Date.now()) {
    this.sql.exec('DELETE FROM pool_registrations WHERE expires<=? OR used=1', now)
  }
  nextRegistrationExpiry() {
    return this.rows<{ expires: number }>('SELECT MIN(expires) AS expires FROM pool_registrations WHERE used=0')[0]?.expires ?? null
  }
  consume(hash: string, owner: string, group: string, now = Date.now()) {
    const row = this.rows<{
      owner: string
      group_id: string
      expires: number
      used: number
    }>('SELECT * FROM pool_registrations WHERE hash=?', hash)[0]
    if (
      !row ||
      row.used ||
      now >= row.expires ||
      row.owner !== owner ||
      row.group_id !== this.group(group).id
    )
      throw Error('invalid, expired or used registration token')
    this.sql.exec('UPDATE pool_registrations SET used=1 WHERE hash=?', hash)
  }
  offer(repository: string, queue: string) {
    if (repository.split('/')[0] !== this.owner())
      throw Error('repository belongs to another owner')
    this.sql.exec(
      'INSERT OR REPLACE INTO pool_repos VALUES (?,?)',
      repository,
      queue,
    )
  }
  repositories() {
    return this.rows<{ repository: string; queue_id: string }>(
      'SELECT * FROM pool_repos',
    )
  }
}
/** The group checks are shared by routing and the eligibility explanation. */
export function groupEligibility(
  group: RunnerGroup,
  repository: string,
  readable: boolean,
  isPublic: boolean,
) {
  if (!readable) return 'Repository access denied'
  if (
    group.visibility === 'selected' &&
    !group.repositories.includes(repository)
  )
    return 'Repository is not selected in this runner group'
  if (isPublic && !group.allow_public_repositories)
    return 'Public repository in a group that disallows public repositories'
  return null
}
