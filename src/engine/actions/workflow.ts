import { workflowKeys,jobKeys,stepKeys,eventKeys } from './support.js'
import { parseDocument } from 'yaml'
import { RE2JS } from 're2js'

export type EventName = 'push' | 'pull_request' | 'workflow_dispatch'
export type Values = Record<string, string>
export interface Event {
  name: EventName
  sha: string
  ref: string
  actor: string
  title: string
  repository: string
  before?: string
  paths?: string[]
  baseRef?: string
  headRef?: string
  action?: string
  pull?: number
  key: string
  requiresApproval?: boolean
}
export interface Context {
  github: Record<string, unknown>
  env: Values
  matrix: Record<string, unknown>
  secrets: Values
}
export interface Step {
  name: string
  run?: string
  uses?: string
  shell: string
  directory: string
  env: Values
  with: Values
  condition?: string
  continueOnError: boolean
  timeout: number
}
export interface Job {
  id: string
  key: string
  name: string
  labels: string[]
  needs: string[]
  condition?: string
  matrix: Record<string, unknown>
  env: Values
  steps: Step[]
  timeout: number
}
export interface Workflow {
  file: string
  name: string
  triggers: Partial<Record<EventName, Record<string, unknown>>>
  env: Values
  jobs: Job[]
  error?: string
}
function object(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error(`${what} must be a mapping`)
  return v as Record<string, unknown>
}
function keys(v: Record<string, unknown>, allowed: string[], what: string) {
  for (const k of Object.keys(v))
    if (!allowed.includes(k))
      throw new Error(`gild doesn't support ${what}.${k} yet`)
}
function strings(v: unknown, what: string): string[] {
  const a = typeof v === 'string' ? [v] : v
  if (
    !Array.isArray(a) ||
    a.some((x) => typeof x !== 'string') ||
    a.length > 256
  )
    throw new Error(`${what} must be a string or list of strings`)
  return a
}
function values(v: unknown, what: string): Values {
  if (v === undefined) return {}
  const o = object(v, what),
    out: Values = {}
  for (const [k, x] of Object.entries(o)) {
    if (!['string', 'number', 'boolean'].includes(typeof x))
      throw new Error(`${what}.${k} must be a scalar`)
    out[k] = String(x)
  }
  return out
}
function minutes(v: unknown, fallback: number) {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 360)
    throw new Error('timeout-minutes must be between 0 and 360')
  return v * 60_000
}
function condition(v: unknown): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string' && typeof v !== 'boolean')
    throw new Error('if must be a simple expression')
  const s = String(v)
    .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1')
    .trim()
  expression(s, { github: {}, env: {}, matrix: {}, secrets: {} }) // validate before queuing
  return s
}
export function expandMatrix(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [{}]
  const m = object(value, 'strategy.matrix'),
    axes = Object.entries(m).filter(
      ([k]) => !['include', 'exclude'].includes(k),
    )
  let combinations: Record<string, unknown>[] = [{}]
  for (const [key, a] of axes) {
    if (
      !Array.isArray(a) ||
      a.length === 0 ||
      a.some((v) => !['string', 'number', 'boolean'].includes(typeof v))
    )
      throw new Error(`matrix.${key} must be a non-empty scalar list`)
    combinations = combinations.flatMap((c) =>
      a.map((v) => ({ ...c, [key]: v })),
    )
    if (combinations.length > 256) throw new Error('matrix exceeds 256 jobs')
  }
  const entries = (key: string) => {
    const a = m[key] ?? []
    if (!Array.isArray(a)) throw new Error(`matrix.${key} must be a list`)
    return a.map((v) => object(v, `matrix.${key}`))
  }
  combinations = combinations.filter(
    (c) =>
      !entries('exclude').some((ex) =>
        Object.entries(ex).every(([k, v]) => c[k] === v),
      ),
  )
  const originals = combinations.map((c) => ({ ...c })),
    extra: Record<string, unknown>[] = []
  for (const inc of entries('include')) {
    let added = false
    combinations.forEach((c, i) => {
      if (
        axes.every(([k]) => inc[k] === undefined || originals[i][k] === inc[k])
      ) {
        Object.assign(c, inc)
        added = true
      }
    })
    if (!added || axes.length === 0) extra.push(inc)
  }
  if (axes.length === 0 && extra.length) combinations = []
  if (combinations.length + extra.length > 256)
    throw new Error('matrix exceeds 256 jobs')
  return [...combinations, ...extra]
}
export function parseWorkflow(file: string, text: string): Workflow {
  const workflow: Workflow = {
    file,
    name: file,
    triggers: {},
    env: {},
    jobs: [],
  }
  try {
    if (text.length > 128 * 1024) throw new Error('workflow exceeds 128 KiB')
    const doc = parseDocument(text, { version: '1.2', uniqueKeys: true })
    if (doc.errors.length) throw new Error(doc.errors[0].message)
    const w = object(doc.toJS({ maxAliasCount: 50 }), 'workflow')
    keys(
      w,
      workflowKeys,
      'workflow',
    )
    workflow.name = String(w.name ?? file)
    if (w.permissions !== undefined) object(w.permissions, 'permissions') // no GitHub token is issued
    const on =
      typeof w.on === 'string' || Array.isArray(w.on)
        ? Object.fromEntries(strings(w.on, 'on').map((e) => [e, {}]))
        : object(w.on, 'on')
    keys(on,eventKeys,'on')
    for (const [event, filter] of Object.entries(on)) {
      const f = filter === null ? {} : object(filter, `on.${event}`)
      keys(
        f,
        event === 'workflow_dispatch'
          ? []
          : event === 'push'
            ? [
                'branches',
                'branches-ignore',
                'tags',
                'tags-ignore',
                'paths',
                'paths-ignore',
              ]
            : ['branches', 'branches-ignore', 'paths', 'paths-ignore', 'types'],
        `on.${event}`,
      )
      for (const [key, v] of Object.entries(f)) {
        const a = strings(v, `on.${event}.${key}`)
        if (key !== 'types') {
          if (a.length && a.every((s) => s.startsWith('!')))
            throw new Error(`${key} needs a positive pattern`)
          for (const pattern of a)
            glob('', pattern.startsWith('!') ? pattern.slice(1) : pattern)
        }
      }
      for (const key of ['branches', 'tags', 'paths'])
        if (f[key] && f[`${key}-ignore`])
          throw new Error(`${key} and ${key}-ignore cannot be combined`)
      workflow.triggers[event as EventName] = f
    }
    workflow.env = values(w.env, 'env')
    const defaults = (v: unknown) => {
      if (v === undefined) return {} as Record<string, unknown>
      const o = object(v, 'defaults')
      keys(o, ['run'], 'defaults')
      const r = object(o.run, 'defaults.run')
      keys(r, ['shell', 'working-directory'], 'defaults.run')
      return r
    }
    const wd = defaults(w.defaults),
      jobs = object(w.jobs, 'jobs')
    for (const [id, value] of Object.entries(jobs)) {
      if (!/^[A-Za-z_][\w-]*$/.test(id)) throw new Error(`invalid job id ${id}`)
      const j = object(value, `jobs.${id}`)
      keys(
        j,
        jobKeys,
        `jobs.${id}`,
      )
      const strategy =
        j.strategy === undefined ? {} : object(j.strategy, 'strategy')
      keys(strategy, ['matrix', 'fail-fast'], 'strategy')
      // Independent matrix jobs run to completion; fail-fast cancellation isn't implemented.
      if (strategy['fail-fast'] === true)
        throw new Error(
          'gild does not support explicit strategy.fail-fast: true yet; use false',
        )
      const jd = { ...wd, ...defaults(j.defaults) }
      if (!Array.isArray(j.steps) || !j.steps.length || j.steps.length > 100)
        throw new Error(`jobs.${id}.steps must contain 1 to 100 steps`)
      const steps = j.steps.map((v, i): Step => {
        const s = object(v, `steps.${i}`)
        keys(
          s,
          stepKeys,
          `steps.${i}`,
        )
        if ((typeof s.run === 'string') === (typeof s.uses === 'string'))
          throw new Error(`step ${i + 1} needs exactly one of run or uses`)
        if (
          s['continue-on-error'] !== undefined &&
          typeof s['continue-on-error'] !== 'boolean'
        )
          throw new Error('continue-on-error must be boolean')
        return {
          name: String(s.name ?? s.uses ?? `Step ${i + 1}`),
          run: s.run as string | undefined,
          uses: s.uses as string | undefined,
          shell: String(s.shell ?? jd.shell ?? 'bash'),
          directory: String(
            s['working-directory'] ?? jd['working-directory'] ?? '.',
          ),
          env: values(s.env, 'step.env'),
          with: values(s.with, 'step.with'),
          condition: condition(s.if),
          continueOnError: s['continue-on-error'] === true,
          timeout: minutes(s['timeout-minutes'], 360 * 60_000),
        }
      })
      for (const [i, matrix] of expandMatrix(strategy.matrix).entries()) {
        workflow.jobs.push({
          id,
          key: `${id}:${i}`,
          name: String(j.name ?? id),
          labels: strings(j['runs-on'], 'runs-on'),
          needs: j.needs === undefined ? [] : strings(j.needs, 'needs'),
          condition: condition(j.if),
          matrix,
          env: values(j.env, 'job.env'),
          steps,
          timeout: minutes(j['timeout-minutes'], 360 * 60_000),
        })
      }
    }
    if (!workflow.jobs.length || workflow.jobs.length > 256)
      throw new Error('workflow needs 1 to 256 jobs')
    if (new TextEncoder().encode(JSON.stringify(workflow)).length > 1_500_000)
      throw new Error('expanded workflow exceeds 1.5 MiB')
    const visit = (id: string, stack: Set<string>) => {
      if (stack.has(id)) throw new Error(`cyclic job needs: ${id}`)
      const j = workflow.jobs.find((j) => j.id === id)
      if (!j) throw new Error(`unknown needed job ${id}`)
      for (const n of j.needs) visit(n, new Set([...stack, id]))
    }
    for (const j of workflow.jobs) visit(j.id, new Set())
  } catch (e) {
    workflow.error = (e as Error).message
    workflow.jobs = []
  }
  return workflow
}
const globs = new Map<string, ReturnType<typeof RE2JS.compile>>()
function glob(value: string, pattern: string) {
  let compiled = globs.get(pattern)
  if (!compiled) {
    if (pattern.length > 512)
      throw new Error('filter pattern exceeds 512 characters')
    let regex = ''
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]
      if (c === '\\') {
        if (!pattern[++i]) throw new Error('unterminated filter escape')
        regex += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      } else if (c === '*') {
        if (pattern[i + 1] === '*') {
          i++
          if (pattern[i + 1] === '/') {
            i++
            regex += '(?:.*/)?'
          } else regex += '.*'
        } else regex += '[^/]*'
      } else if (c === '[') {
        const end = pattern.indexOf(']', i + 1),
          chars = pattern.slice(i + 1, end)
        if (end < 0 || !chars || !/^[A-Za-z0-9-]+$/.test(chars))
          throw new Error('unsupported filter character class')
        regex += `[${chars}]`
        i = end
      } else if (c === '?' || c === '+') regex += c
      else regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    compiled = RE2JS.compile(`^${regex}$`)
    globs.set(pattern, compiled)
    if (globs.size > 128) globs.delete(globs.keys().next().value!)
  }
  return compiled.matcher(value).matches()
}
export function filterMatches(value: string, patterns: string[]): boolean {
  let match = false
  for (const p of patterns)
    if (glob(value, p.startsWith('!') ? p.slice(1) : p))
      match = !p.startsWith('!')
  return match
}
export function matchesTrigger(w: Workflow, e: Event): boolean {
  const f = w.triggers[e.name]
  if (!f) return false
  if (e.name === 'workflow_dispatch') return true
  const tag = e.ref.startsWith('refs/tags/'),
    kind = tag ? 'tags' : 'branches'
  const ref =
    e.name === 'pull_request'
      ? (e.baseRef ?? '')
      : e.ref.replace(/^refs\/(heads|tags)\//, '')
  if (
    e.name === 'push' &&
    !f[kind] &&
    !f[`${kind}-ignore`] &&
    (f[tag ? 'branches' : 'tags'] || f[tag ? 'branches-ignore' : 'tags-ignore'])
  )
    return false
  if (f[kind] && !filterMatches(ref, f[kind] as string[])) return false
  if (
    f[`${kind}-ignore`] &&
    filterMatches(ref, f[`${kind}-ignore`] as string[])
  )
    return false
  if (f.types && !(f.types as string[]).includes(e.action ?? 'opened'))
    return false
  if (!tag && (f.paths || f['paths-ignore'])) {
    // Unknown changed paths fail closed, never accidentally run a filtered workflow.
    if (!e.paths)
      throw new Error('changed paths are required for path-filtered workflows')
    if (f.paths && !e.paths.some((p) => filterMatches(p, f.paths as string[])))
      return false
    if (
      f['paths-ignore'] &&
      e.paths.every((p) => filterMatches(p, f['paths-ignore'] as string[]))
    )
      return false
  }
  return true
}
export function context(
  e: Event,
  matrix: Record<string, unknown> = {},
  env: Values = {},
  secrets: Values = {},
): Context {
  return {
    github: {
      ref: e.ref,
      sha: e.sha,
      event_name: e.name,
      actor: e.actor,
      repository: e.repository,
      repository_owner: e.repository.split('/')[0],
      ref_name: e.ref.replace(/^refs\/(heads|tags)\//, ''),
      base_ref: e.baseRef ?? '',
      head_ref: e.headRef ?? '',
      event: {
        before: e.before,
        pull_request: {
          number: e.pull,
          title: e.title,
          head: { sha: e.sha, ref: e.headRef },
          base: { ref: e.baseRef },
        },
      },
    },
    matrix,
    env,
    secrets,
  }
}
// Tiny recursive-descent evaluator. Never eval workflow code in the Worker.
export function expression(
  source: string,
  ctx: Context,
  state: 'success' | 'failure' | 'cancelled' = 'success',
): unknown {
  const tokens: string[] = []
  let rest = source.trim()
  while (rest) {
    const m =
      /^(\s+|'(?:[^']|'')*'|==|!=|&&|\|\||[!(),]|[A-Za-z_][\w.-]*|-?\d+(?:\.\d+)?)/.exec(
        rest,
      )
    if (!m) throw new Error(`unsupported expression: ${source}`)
    if (m[1].trim()) tokens.push(m[1])
    rest = rest.slice(m[0].length)
  }
  let p = 0
  const primary = (): unknown => {
    const t = tokens[p++]
    if (!t) throw new Error(`incomplete expression: ${source}`)
    if (t === '!') return !primary()
    if (t === '(') {
      const v = or()
      if (tokens[p++] !== ')') throw new Error('expected )')
      return v
    }
    if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'")
    if (/^-?\d/.test(t)) return Number(t)
    if (['true', 'false', 'null'].includes(t))
      return t === 'true' ? true : t === 'false' ? false : null
    if (tokens[p] === '(') {
      p++
      const args: unknown[] = []
      if (tokens[p] !== ')') {
        args.push(or())
        while (tokens[p] === ',') {
          p++
          args.push(or())
        }
      }
      if (tokens[p++] !== ')') throw new Error('expected )')
      if (
        ['always', 'success', 'failure', 'cancelled'].includes(t) &&
        args.length === 0
      )
        return t === 'always' || t === state
      if (
        ['startsWith', 'endsWith', 'contains'].includes(t) &&
        args.length === 2
      ) {
        const a = String(args[0]).toLowerCase(),
          b = String(args[1]).toLowerCase()
        return t === 'startsWith'
          ? a.startsWith(b)
          : t === 'endsWith'
            ? a.endsWith(b)
            : a.includes(b)
      }
      throw new Error(`unsupported expression function ${t}`)
    }
    const parts = t.split('.')
    if (
      !['github', 'env', 'matrix', 'secrets'].includes(parts[0]) ||
      parts.length < 2
    )
      throw new Error(`unsupported expression context ${t}`)
    let v: unknown = ctx
    for (const part of parts)
      v =
        v && typeof v === 'object'
          ? (v as Record<string, unknown>)[part]
          : undefined
    return v ?? ''
  }
  const eq = (): unknown => {
    let v = primary()
    while (['==', '!='].includes(tokens[p])) {
      const op = tokens[p++],
        b = primary()
      const equal = String(v).toLowerCase() === String(b).toLowerCase()
      v = op === '==' ? equal : !equal
    }
    return v
  }
  const and = (): unknown => {
    let v = eq()
    while (tokens[p] === '&&') {
      p++
      const b = eq()
      v = v ? b : v
    }
    return v
  }
  const or = (): unknown => {
    let v = and()
    while (tokens[p] === '||') {
      p++
      const b = and()
      v = v ? v : b
    }
    return v
  }
  const result = or()
  if (p !== tokens.length) throw new Error(`unsupported expression: ${source}`)
  return result
}
export function interpolate(value: string, ctx: Context) {
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, s) =>
    String(expression(s.trim(), ctx)),
  )
}
export function resolveValues(value: Values, ctx: Context): Values {
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, interpolate(v, ctx)]),
  )
}
export function runnerLabels(
  os: string,
  arch: string,
  custom: string[],
): string[] {
  const family = os === 'darwin' || os === 'macos' ? 'macos' : os==='win32'?'windows':os
  const cpu = arch === 'aarch64' ? 'arm64' : arch === 'amd64' ? 'x64' : arch
  return [
    ...new Set([
      'self-hosted',
      family,
      cpu,
      ...custom.map((x) => x.toLowerCase()),
    ]),
  ]
}
export function labelsMatch(required: string[], labels: string[]) {
  return required.every((r) => {
    const x = r.toLowerCase(),
      alias = /^(ubuntu|macos)(?:-latest|-\d+(?:\.\d+)?)?$/.exec(x)
    // Hosted image names select the OS only; tool versions are checked by setup steps.
    return labels.includes(
      alias ? (alias[1] === 'ubuntu' ? 'linux' : 'macos') : x,
    )
  })
}
