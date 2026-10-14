import { DurableObject } from 'cloudflare:workers'
import type { D1Database } from '@cloudflare/workers-types'
import { d1Store } from './drivers/d1.js'
import { renameStep, type RenameJob } from './settings-rename.js'
import { lifecycleTransport } from './settings-production.js'
export class SettingsRename extends DurableObject<{ DB: D1Database }> {
  private tail: Promise<unknown> = Promise.resolve()
  private serial<T>(work: () => Promise<T>) {
    const next = this.tail.catch(() => {}).then(work)
    this.tail = next
    return next
  }
  start(job: RenameJob) {
    return this.serial(async () => {
      await this.ctx.storage.put('id', job.id)
      await d1Store(this.env.DB).settings.saveRename(job)
      await this.ctx.storage.setAlarm(Date.now() + 100)
    })
  }
  wake(id: string) {
    return this.serial(async () => {
      const job = await d1Store(this.env.DB).settings.renameJob(id)
      if (!job || ['complete', 'failed'].includes(job.phase)) return
      await this.ctx.storage.put('id', id)
      if (!(await this.ctx.storage.getAlarm()))
        await this.ctx.storage.setAlarm(Date.now() + 100)
    })
  }
  alarm() {
    return this.serial(async () => {
      // Re-arm before doing I/O: even a terminated copy is retried durably.
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      const id = await this.ctx.storage.get<string>('id')
      const st = d1Store(this.env.DB),
        job = id ? await st.settings.renameJob(id) : null
      if (
        !job ||
        (await renameStep(st, await lifecycleTransport(this.env), job))
      )
        await this.ctx.storage.deleteAlarm()
      else
        await this.ctx.storage.setAlarm(
          Date.now() +
            (job.phase === 'waiting' ? 1000 : job.error ? 30_000 : 100),
        )
    })
  }
}
