import { jobLogs } from '../../engine/actions/logs.js'
import { runnerShape } from './runners-shape.js'
import type { actionEnv } from '../actions/service.js'
import { putSecret, deleteSecret, secretNames } from '../actions/secrets.js'
import type { runQueue, dispatch } from '../actions/service.js'
import type { mayWrite } from '../access.js'
import { ApiError, requireFound } from '../../engine/api/errors.js'
import { numericId, user, apiURL, repoPath } from './shapes.js'
import {
  paginationOffset,
  paginate,
  type Context,
  type Result,
} from './dispatch.js'
import type { Run, StoredJob, StoredStep } from '../actions/store.js'
function status(s: string) {
  return s === 'queued'
    ? 'queued'
    : s === 'running'
      ? 'in_progress'
      : 'completed'
}
function conclusion(s: string) {
  return ['queued', 'running'].includes(s) ? null : s
}
function date(t: number | null) {
  return t === null ? null : new Date(t).toISOString()
}
export function runShape(
  c: Context,
  r: Omit<Run, 'workflow'> & {
    workflow: Pick<Run['workflow'], 'name' | 'file'>
  },
) {
  return {
    id: r.id,
    name: r.workflow.name,
    head_branch: r.event.ref.replace(/^refs\/heads\//, ''),
    head_sha: r.event.sha,
    event: r.event.name,
    status: status(r.status),
    conclusion: conclusion(r.status),
    run_number: r.id,
    created_at: date(r.created),
    updated_at: date(r.finished ?? r.started ?? r.created),
    html_url: `${new URL(c.request.url).origin}/${c.params.owner}/${c.params.repo}/actions/${r.id}`,
    url: apiURL(c, `${repoPath(c)}/actions/runs/${r.id}`),
    workflow_id: numericId(r.workflow.file),
    started_at:date(r.started),completed_at:date(r.finished),reason:r.reason,
    actor: user(c, r.event.actor),
  }
}
export function jobShape(
  r: Run,
  j: Omit<StoredJob, 'lease'>,
  steps: StoredStep[],
) {
  return {
    id: j.id,
    run_id: j.run,
    name: j.spec.name ?? j.spec.id,
    head_sha: r.event.sha,
    status: status(j.status),
    conclusion: conclusion(j.status),
    started_at: date(j.started),
    completed_at: date(j.finished),
    runner_id: j.runner ? numericId(j.runner) : null,
    runner_name: j.runnerName,
    reason:j.reason,
    steps: steps.map((s) => ({
      name: s.name,
      status: status(s.status),
      conclusion: conclusion(s.status),
      number: s.position + 1,
      exit_code:s.exit,
      started_at: date(s.started),
      completed_at: date(s.finished),
    })),
  }
}
export function actionHandler(deps: {
  inheritedRunners?: (
    owner: string,
    repo: string,
  ) => Promise<Parameters<typeof runnerShape>[0][]>
  runQueue: typeof runQueue
  dispatch: typeof dispatch
  actionEnv?: typeof actionEnv
  mayWrite: typeof mayWrite
}) {
  return async function apiActions(c: Context): Promise<Result> {
    try {
      const { owner, repo } = c.params,
        q = await deps.runQueue(owner, repo),
        id = c.route.id,
        b = c.body,
        token =
          c.request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? ''
      if (id.startsWith('runner')) {
        if (!token.startsWith('gr_') && !token.startsWith('gc_'))
          throw new ApiError(401, 'Runner token required')
        await q.readRepo(token)
        if (id === 'runnerPoll')
          return { data: { job: await q.poll(token, b.wait) } }
        if (id === 'runnerHeartbeat')
          return { data: await q.heartbeat(token, b.job, b.lease) }
        if (id === 'runnerLogs')
          await q.append(token, {
            job: b.job,
            lease: b.lease,
            step: b.step,
            batch: b.batch,
            lines: b.lines,
          })
        if (id === 'runnerStep')
          await q.step(token, {
            job: b.job,
            lease: b.lease,
            step: b.step,
            status: b.status,
            exit: b.exit,
          })
        if (id === 'runnerFinish')
          await q.finish(token, {
            job: b.job,
            lease: b.lease,
            status: b.status,
            reason: b.reason,
          })
        return { data: { ok: true } }
      }
      if (id === 'actionRegister' && token.startsWith('grt_'))
        return { data: await q.register('', b as never, token) }
      const overview = await q.overview(),
        run = Number(c.params.run)
      const runnerId = overview.runners.find(
        (r) => r.id === c.params.runner || String(numericId(r.id)) === c.params.runner,
      )?.id ?? c.params.runner
      const runnerShapes = () =>
        overview.runners.map((r) => ({
          id: numericId(r.id),
          gild_id: r.id,
          name: r.name,
          os: r.os,
          arch: r.arch,
          last_seen: r.lastSeen,
          inherited: false,
          eligible: true,
          assignment: r.job
            ? {
                repository: `${owner}/${repo}`,
                job: r.job,
                run: r.run!,
                lease: '',
              }
            : null,
          status: Date.now() - r.lastSeen < 120000 ? 'online' : 'offline',
          busy: r.job !== null,
          labels: r.labels.map((name) => ({
            id: numericId(name),
            name,
            type: 'custom',
          })),
        }))
      if (id === 'actionCommitRuns')
        return {
          data: (await q.commitRuns(c.params.sha)).map((r) => runShape(c, r)),
        }
      if (id === 'actionOverview')
        return {
          data: {
            workflow_runs: overview.runs.map((r) => runShape(c, r)),
            runners: runnerShapes(),
            required: overview.settings.required,
          },
        }
      if (id === 'actionRuns') {
        const result = await q.apiRuns(c.query.per_page, paginationOffset(c)),
          page = paginate(
            result.runs.map((r) => runShape(c, r)),
            c,
            result.total,
            true,
          )
        return {
          data: { total_count: result.total, workflow_runs: page.data },
          headers: page.headers,
        }
      }
      if (id === 'actionRunnerJobs')
        return { data: { jobs: await q.runnerJobs(runnerId) } }
      if (id === 'actionRunners') {
        const inherited = (await deps.inheritedRunners?.(owner, repo)) ?? []
        const all = [...runnerShapes(), ...inherited.map(runnerShape)]
        const page = paginate(all, c)
        return {
          data: { total_count: all.length, runners: page.data },
          headers: page.headers,
        }
      }
      if (id === 'actionRun' || id === 'actionJobs' || id === 'actionLogs') {
        const detail = requireFound(await q.detail(run))
        if (id === 'actionRun') return { data: runShape(c, detail.run) }
        if (id === 'actionJobs') {
          const page = paginate(
            detail.jobs.map((j) => jobShape(detail.run, j, j.steps)),
            c,
          )
          return {
            data: { total_count: detail.jobs.length, jobs: page.data },
            headers: page.headers,
          }
        }
        if (c.query.job !== undefined) {
          const job = detail.jobs.find(j => j.id === c.query.job)
          if (!job || !job.steps.some(s => s.position === c.query.step)) throw new ApiError(404,'Job step not found in this run')
          return {data:{logs:(await q.logs(job.id,c.query.step,c.query.after)).map(chunk=>({job:job.id,step:c.query.step,...chunk}))}}
        }
        const logs: { job: number; step: number; seq: number; text: string }[] =
          []
        for (const j of detail.jobs) logs.push(...(await jobLogs(q, j)))
        return { data: { logs } }
      }
      if (id === 'actionJob') {
        const detail = requireFound(await q.apiJob(Number(c.params.job)))
        return { data: jobShape(detail.run, detail.job, detail.job.steps) }
      }
      if (!(await deps.mayWrite(owner, c.principal.name)))
        throw new ApiError(403, 'Repository writer required')
      if (id === 'actionRegistration') return { data: await q.registration() }
      if (id === 'actionApprove') {
        await q.approve(run, c.principal.name)
        return { data: { ok: true } }
      }
      if (id === 'actionSettings')
        return { data: { required: await q.required(b.required) } }
      if (
        ['actionSecrets', 'actionPutSecret', 'actionDeleteSecret'].includes(id)
      ) {
        if (!deps.actionEnv)
          throw new ApiError(503, 'Actions secret storage unavailable')
        const env = await deps.actionEnv(),
          full = `${owner}/${repo}`.toLowerCase()
        if (id === 'actionSecrets')
          return {
            data: {
              secrets: (await secretNames(env, full)).map((s) => ({
                name: s.name,
                updated_at: new Date(s.updated).toISOString(),
              })),
            },
          }
        if (id === 'actionPutSecret')
          await putSecret(env, full, c.params.secret, b.value)
        else await deleteSecret(env, full, c.params.secret)
        return { data: { ok: true } }
      }
      if (id === 'actionRegister')
        return {
          data: await q.register(c.principal.name, {
            name: b.name,
            os: b.os,
            arch: b.arch,
            labels: b.labels,
          }),
        }
      if (id === 'actionPatch')
        return { data: await q.patch(runnerId, b.labels) }
      if (id === 'actionRemove') {
        await q.remove(runnerId)
        return { data: { ok: true } }
      }
      if (id === 'actionDispatch')
        return {
          data: {
            id: await deps.dispatch(
              owner,
              repo,
              c.params.workflow,
              b.ref,
              c.principal.name,
            ),
          },
        }
      if (id === 'actionRerun')
        return { data: { id: await q.rerun(run, c.principal.name) } }
      if (id === 'actionCancel') {
        await q.cancel(run)
        return { data: { ok: true } }
      }
      throw new ApiError(404, 'Actions endpoint not found')
    } catch (e) {
      if (e instanceof ApiError) throw e
      const message = e instanceof Error ? e.message : ''
      if (
        [
          'job not found',
          'runner not found',
          'run not found',
          'branch or tag not found',
        ].includes(message)
      )
        throw new ApiError(404, message)
      if (
        message === 'invalid or revoked runner token' ||
        message === 'invalid, expired or used registration token'
      )
        throw new ApiError(401, message)
      if (message === 'job lease does not belong to this runner')
        throw new ApiError(403, message)
      if (
        /already registered|already finished|not running|previous step has not finished/.test(
          message,
        )
      )
        throw new ApiError(409, message)
      if (
        /^(invalid |unknown step|successful job has|this workflow has|secret name|secret value)/.test(
          message,
        )
      )
        throw new ApiError(422, message)
      throw e
    }
  }
}
