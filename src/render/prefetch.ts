export function mayPrefetch() {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string }
    }
  ).connection
  return (
    !connection?.saveData &&
    !['slow-2g', '2g'].includes(connection?.effectiveType ?? '')
  )
}
export function safeLink(
  target: EventTarget | null,
  allowHash = false,
  allowCurrent = false,
) {
  const link =
    target instanceof Element
      ? target.closest<HTMLAnchorElement>('a[href]')
      : null
  if (
    !link ||
    link.hasAttribute('download') ||
    link.dataset.noPrefetch !== undefined ||
    (link.target && link.target !== '_self')
  )
    return null
  const url = new URL(link.href, location.href)
  if (
    url.searchParams.get('raw') === '1' ||
    /^\/(?:f\/v\d+|pf\/[^/]+\/[^/]+\/v\d+)\/source\//.test(url.pathname) ||
    url.origin !== location.origin ||
    !/^https?:$/.test(url.protocol) ||
    /^(?:\/api\/|\/git\/|\/auth\/|\/logout(?:\/|$)|\/signout(?:\/|$))/.test(
      url.pathname,
    )
  )
    return null
  if (
    !allowCurrent &&
    url.pathname === location.pathname &&
    url.search === location.search &&
    (!allowHash || url.hash === location.hash)
  )
    return null
  return { link, url }
}
/** All same-origin links, including markdown and dynamically inserted rows. */
export function intentPrefetch(prefetch: (url: URL) => Promise<unknown>) {
  const seen = new Set<string>(),
    timers = new Map<HTMLAnchorElement, ReturnType<typeof setTimeout>>(),
    waiting: URL[] = []
  let inFlight = 0
  const pump = () => {
    while (inFlight < 4 && waiting.length) {
      const url = waiting.shift()!
      inFlight++
      void prefetch(url)
        .then(() =>
          document.dispatchEvent(
            new CustomEvent('gild:prefetched', { detail: url.href }),
          ),
        )
        .catch(() => seen.delete(url.href))
        .finally(() => {
          inFlight--
          pump()
        })
    }
  }
  const queue = (url: URL) => {
    if (!mayPrefetch() || seen.has(url.href)) return
    seen.add(url.href)
    waiting.push(url)
    pump()
  }
  const hover = (event: Event) => {
    const found = safeLink(event.target)
    if (
      !found ||
      !mayPrefetch() ||
      timers.has(found.link) ||
      found.link.contains((event as MouseEvent).relatedTarget as Node)
    )
      return
    timers.set(
      found.link,
      setTimeout(() => {
        timers.delete(found.link)
        queue(found.url)
      }, 65),
    )
  }
  const leave = (event: Event) => {
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>('a[href]')
        : null
    if (!link || link.contains((event as MouseEvent).relatedTarget as Node))
      return
    clearTimeout(timers.get(link))
    timers.delete(link)
  }
  const instant = (event: Event) => {
    const found = safeLink(event.target)
    if (found) queue(found.url)
  }
  const reset = () => {
    seen.clear()
    waiting.length = 0
  }
  document.addEventListener('gild:tip-changed', reset)
  document.addEventListener('mouseover', hover)
  document.addEventListener('mouseout', leave)
  document.addEventListener('focusin', instant)
  document.addEventListener('touchstart', instant, { passive: true })
  return () => {
    document.removeEventListener('gild:tip-changed', reset)
    document.removeEventListener('mouseover', hover)
    document.removeEventListener('mouseout', leave)
    document.removeEventListener('focusin', instant)
    document.removeEventListener('touchstart', instant)
    for (const timer of timers.values()) clearTimeout(timer)
  }
}
