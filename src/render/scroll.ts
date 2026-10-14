let paused = false
export function pauseScroll() { paused = true }
/** Positions belong to entries, including repeated visits to the same URL.
 * Preserve Next's opaque state when recording an entry's position. */
export function saveScroll() {
  if (paused) return
  History.prototype.replaceState.call(history, { ...history.state, gildScrollY: window.scrollY }, '')
}
export function pushURL(url: URL) {
  History.prototype.replaceState.call(history, { ...history.state, gildScrollY: window.scrollY }, '')
  History.prototype.pushState.call(history, { gildScrollY: 0 }, '', url)
}
export function pendingScroll(y: number | null) {
  History.prototype.replaceState.call(history, { ...history.state, gildScrollPending: { y } }, '')
}
export function finishScroll(url: URL, mode: 'push' | 'restore' | 'preserve', previousY: number) {
  if (mode === 'preserve') window.scrollTo(0, previousY)
  else if (mode === 'restore') window.scrollTo(0, history.state?.gildScrollY ?? 0)
  else {
    const id = url.hash.slice(1)
    let target: HTMLElement | null = null
    try { target = document.getElementById(decodeURIComponent(id)) } catch {}
    if (target) target.scrollIntoView()
    else window.scrollTo(0, 0)
  }
  paused = false
  saveScroll()
}
export function installScroll() {
  paused = false
  history.scrollRestoration = 'manual'
  const pending = history.state?.gildScrollPending ?? (['back_forward', 'reload'].includes((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.type) ? { y: history.state?.gildScrollY ?? 0 } : null)
  if (pending) {
    const { gildScrollPending: _, ...state } = history.state ?? {}
    History.prototype.replaceState.call(history, state, '')
    const restore = () => finishScroll(new URL(location.href), pending.y === null ? 'push' : 'preserve', pending.y ?? 0)
    if (document.readyState === 'loading') {
      paused = true
      document.addEventListener('DOMContentLoaded', restore, { once:true })
    } else restore()
  }
  const controller = new AbortController()
  // Navigation pauses recording while replacement DOM temporarily clamps scroll.
  window.addEventListener('scroll', saveScroll, { passive: true, signal: controller.signal })
  window.addEventListener('pagehide', saveScroll, { signal: controller.signal })
  return () => controller.abort()
}
