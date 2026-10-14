/** Build-time adapter for existing islands in the standalone tab application. */
import { useSyncExternalStore } from 'react'
function subscribe(change: () => void) {
  const events = ['gild:tab-committed', 'gild:navigated', 'popstate']
  for (const event of events) window.addEventListener(event, change)
  return () => {
    for (const event of events) window.removeEventListener(event, change)
  }
}
export function useRouter() {
  return {
    push: (path: string) => location.assign(path),
    replace: (path: string) => location.replace(path),
    back: () => history.back(),
    refresh: () => location.reload(),
  }
}
export function usePathname() {
  return useSyncExternalStore(
    subscribe,
    () => location.pathname,
    () => '/',
  )
}
export function useSearchParams() {
  return new URLSearchParams(
    useSyncExternalStore(
      subscribe,
      () => location.search,
      () => '',
    ),
  )
}
