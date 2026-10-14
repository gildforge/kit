/** One request at a time: overlapping polls can race single-use completion. */
export function pollBrowserChallenge(
  url: string,
  complete: (data: { status: string; name?: string }) => void,
  expired: () => void,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const stop = () => { stopped = true; clearTimeout(timer); controller.abort() }
  const poll = async () => {
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
      if (stopped) return
      if (response.status === 404) { stop(); expired(); return }
      if (response.ok) {
        const data = await response.json()
        if (stopped) return
        if (data.status === 'ok' || data.status === 'done') { stop(); complete(data); return }
      }
    } catch { /* A transient transport failure does not invalidate the flow. */ }
    if (!stopped) timer = setTimeout(poll, 1500)
  }
  timer = setTimeout(poll, 1500)
  return stop
}
