/** Account, security and billing pages live on id.<site>; everything else on
 * the site itself. One deployment serves both hosts; a browser page request on
 * the wrong host is sent to the right one. APIs answer on both hosts. */
const ACCOUNT_SECTIONS = new Set(['profile', 'organizations', 'invitations', 'keys', 'tokens', 'billing'])

export function accountPage(path: string) {
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'auth' || parts[0] === 'keys') return true
  if (parts[0] === 'settings') return parts.length === 1 || (parts.length === 2 && ACCOUNT_SECTIONS.has(parts[1]))
  return parts[0] === 'orgs' && parts[2] === 'settings' && parts[3] === 'billing' && parts.length === 4
}

const ASSET_ROOTS = new Set(['api', 'git', '_next', 'gild-fragments', 'avatars', 'f', 'pf', 'brand'])
const asset = (path: string) => {
  const parts = path.split('/').filter(Boolean)
  return ASSET_ROOTS.has(parts[0] ?? '') || /\.[a-z0-9]+$/i.test(parts.at(-1) ?? '')
}

/** The URL to redirect to, or null when this host serves the request. */
export function hostRedirect(request: Request, publicOrigin: string | undefined): string | null {
  if (!publicOrigin || !['GET', 'HEAD'].includes(request.method)) return null
  const url = new URL(request.url), site = new URL(publicOrigin), id = 'id.' + site.hostname
  if (asset(url.pathname)) return null
  const account = accountPage(url.pathname)
  if (url.hostname === site.hostname && account) return 'https://' + id + url.pathname + url.search
  if (url.hostname === id && !account) return site.origin + url.pathname + url.search
  return null
}
