import { publicPageRoute } from '../engine/public-page-route.js'
/** Stored HTML uses native reloads; private/settings pages keep App Router. */
export function refreshPublicPage(router: { refresh(): void }) {
  if (publicPageRoute(new URL(location.href))) location.reload()
  else router.refresh()
}
export function navigatePublicPage(router: { push(path:string):void },path:string) {
  if (publicPageRoute(new URL(path,location.href))) location.assign(path)
  else router.push(path)
}
