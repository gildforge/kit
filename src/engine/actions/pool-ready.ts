import { labelsMatch } from './workflow.js'
export interface ReadyJob { job: number; created: number; labels: string[] }
/** One shared snapshot per queue wake, also bounded to a long-poll interval.
 * Claims remain authoritative in RunQueue; a stale offer can only miss a claim.
 */
export class PoolReady {
  private entries = new Map<string, { until: number; jobs: Promise<ReadyJob[]> }>()
  private waiters = new Map<() => void, string[]>()
  read(key: string, load: () => Promise<ReadyJob[]>, now = Date.now()) {
    let entry = this.entries.get(key)
    if (!entry || entry.until <= now) {
      entry = { until: now + 20000, jobs: Promise.resolve().then(load) }
      this.entries.set(key, entry)
      const saved = entry
      void entry.jobs.catch(() => {
        if (this.entries.get(key) === saved) this.entries.delete(key)
      })
    }
    return entry.jobs
  }
  offer(key: string, jobs: ReadyJob[]) {
    this.entries.set(key, { until: Date.now() + 20000, jobs: Promise.resolve(jobs) })
    for (const [wake, labels] of this.waiters)
      if (jobs.some(j => labelsMatch(j.labels, labels))) {
        this.waiters.delete(wake)
        wake()
      }
  }
  wait(wake: () => void, labels: string[]) { this.waiters.set(wake, labels) }
  remove(wake: () => void) { this.waiters.delete(wake) }
  reset() {
    this.entries.clear()
    for (const wake of this.waiters.keys()) wake()
    this.waiters.clear()
  }
}
