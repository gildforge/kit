/** Per-stage `server-timing` for the Worker's routing chain. Each `w-<stage>`
 *  entry is the time spent in that stage (from the previous mark), so a
 *  request that misses the public fast paths shows exactly what it tried
 *  before the stage that answered; `w-total` spans the whole Worker. The
 *  entries are appended after any timing the answering handler set. */
export function workerStages(now: () => number = () => performance.now()) {
  const start = now(), entries: string[] = []
  let last = start
  return {
    mark(stage: string) {
      const t = now()
      entries.push(`w-${stage};dur=${(t - last).toFixed(1)}`)
      last = t
    },
    annotate(response: Response, answered: string) {
      if (response.status === 101) return response
      const t = now()
      const out = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        ...{ encodeBody: 'manual' },
      })
      out.headers.set('server-timing', [
        response.headers.get('server-timing'),
        ...entries,
        `w-${answered};dur=${(t - last).toFixed(1)}`,
        `w-total;dur=${(t - start).toFixed(1)}`,
      ].filter(Boolean).join(', '))
      return out
    },
  }
}
