/** Trusted, self-contained SSR chrome script. No interpolation, viewer/server reads or requests
 * or policy; literal delivery avoids bundler helper captures in Function.toString. */
export const SIDEBAR_BOOTSTRAP = String.raw`(function () {
  const key = '__gildSidebarBootstrap'
  const global = window
  if (global[key]) return
  global[key] = {}
  const earlyRail = () => {
    const rail = document.querySelector('.sidebar')
    return rail && !rail.hasAttribute('data-sidebar-client-ready') ? rail : null
  }
  const set = (rail, open) => {
    global[key].intent = open ? 'expanded' : 'collapsed'
    rail.dataset.sidebarIntent = global[key].intent
    rail.classList.toggle('sidebar-collapsed', !open)
    try { localStorage.setItem('gild.sidebar', open ? 'expanded' : 'collapsed') } catch {}
    document.querySelector('.portal-menu')?.setAttribute('aria-expanded', String(open))
    const collapse = rail.querySelector('.sidebar-collapse')
    collapse?.setAttribute('aria-expanded', String(open))
    collapse?.setAttribute('aria-label', open ? 'Collapse' : 'Expand')
    collapse?.setAttribute('data-tip', open ? 'Collapse' : 'Expand')
    rail.querySelector('.sidebar-mid')?.setAttribute('aria-label', open ? 'collapse menu' : 'expand menu')
    for (const row of rail.querySelectorAll('.sidebar-row')) {
      const label = row.querySelector('.sidebar-label')
      if (label) label.textContent = open ? row.dataset.tip ?? '' : ''
    }
  }
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return
    const rail = earlyRail()
    if (!rail) return
    const toggle = event.target.closest('.portal-menu,.sidebar-collapse,.sidebar-mid')
    if (toggle) {
      event.preventDefault()
      event.stopImmediatePropagation()
      set(rail, rail.classList.contains('sidebar-collapsed'))
    } else if (event.target.closest('.sidebar a')) set(rail, false)
  }, true)
  document.addEventListener('pointerdown', event => {
    const rail = earlyRail()
    if (rail && event.target instanceof Node && !rail.contains(event.target)
      && !(event.target instanceof Element && event.target.closest('.portal-menu')))
      set(rail, false)
  })
  document.addEventListener('keydown', event => {
    const rail = earlyRail()
    if (rail && event.key === 'Escape') set(rail, false)
  })
} )()`
export function initialSidebarIntent(): boolean | undefined {
  if (typeof document === 'undefined') return undefined
  // React may replace or update the SSR rail during commit. Keep the last
  // actual bootstrap click outside React-owned DOM until the layout handoff.
  const pending = (window as Window & { __gildSidebarBootstrap?: { intent?: string } }).__gildSidebarBootstrap?.intent
  const intent = pending ?? document.querySelector<HTMLElement>('.sidebar')?.dataset.sidebarIntent
  return intent === 'expanded' ? true : intent === 'collapsed' ? false : undefined
}

export function consumeSidebarIntent(): boolean | undefined {
  const intent = initialSidebarIntent()
  const state = (window as Window & { __gildSidebarBootstrap?: { intent?: string } }).__gildSidebarBootstrap
  if (state) delete state.intent
  return intent
}
