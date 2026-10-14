import type { ForgeStore } from './backend.js'
import type { LifecycleTransport } from './settings.js'
export interface RenameJob {
  id: string
  from: string
  to: string
  org: boolean
  orgOwner: boolean
  phase:
    | 'waiting'
    | 'copying'
    | 'publishing'
    | 'rebinding'
    | 'rollback'
    | 'complete'
    | 'failed'
  repos: { from: string; to: string; id: string }[]
  copied: number
  rebound: number
  error: string | null
}
/** One durable step per alarm. Waiting for a push never rejects an accepted rename. */
export async function renameStep(
  st: ForgeStore,
  t: LifecycleTransport,
  job: RenameJob,
) {
  const save = () => st.settings.saveRename(job)
  if (job.phase === 'complete' || job.phase === 'failed') return true
  if (job.phase === 'rollback') {
    for (const r of job.repos) await t.discard(r.to, job.orgOwner)
    await t.renameHooks(job.to, job.from)
    job.phase = 'failed'
    await st.settings.finishRename(job)
    return true
  }
  try {
    if (job.phase === 'waiting') {
      if (
        !(await st.settings.drained(job.from)) ||
        !(await st.settings.drained(job.to))
      )
        return false
      const repos = job.org
        ? await t.list(job.from)
        : [{ name: job.from.split('/')[1] }]
      job.repos = []
      for (const r of repos) {
        const from = job.org ? `${job.from}/${r.name}` : job.from
        const state = await st.settings.state(from)
        await st.settings.putState(state)
        job.repos.push({
          from,
          to: job.org ? `${job.to}/${r.name}` : job.to,
          id: state.id,
        })
      }
      job.phase = 'copying'
      await save()
      return false
    }
    if (job.phase === 'copying') {
      const r = job.repos[job.copied]
      if (r) {
        // Retry a crashed copy from scratch; these destinations are reserved by this job.
        await t.discard(r.to, job.orgOwner)
        await t.copy(r.from, r.to)
        job.copied++
      }
      if (job.copied === job.repos.length) job.phase = 'publishing'
      await save()
      return false
    }
    if (job.phase === 'publishing') {
      // D1 publishing is atomic. Recover a crash between commit and progress save.
      if ((await st.settings.canonical(job.from)) !== job.to) {
        await t.renameHooks(job.from, job.to)
        if (job.org) await st.renameOrg(job.from, job.to)
        else await st.settings.rename(job.from, job.to, false, job.orgOwner)
      }
      job.phase = 'rebinding'
      await save()
      return false
    }
    for (const r of job.repos.slice(job.rebound)) {
      await t.rebind(r.to, r.id)
      job.rebound++
      await save()
    }
    job.phase = 'complete'
    job.error = null
    await st.settings.finishRename(job)
    return true
  } catch (e) {
    console.error('Rename step failed', job.id, job.phase, e)
    // After publication, retry rebinding; never discard the visible destination.
    if ((await st.settings.canonical(job.from)) === job.to) {
      job.phase = 'rebinding'
      job.error = 'Finishing repository setup; retrying'
    } else {
      job.phase = 'rollback'
      job.error =
        'Repository copy failed. The original name and data are preserved.'
    }
    await save()
    return false
  }
}
