import { RESERVED_NAMES } from './backend-names.js'
import { documentationRoutes } from './documentation-routes.js'
const reserved = new Set(RESERVED_NAMES)
/** Finite public representations. Viewer-only settings/forms stay dynamic.
 * Search queries run in an island; all queries share the stored search shell. */
export function publicPageRoute(url: URL): { route: string; owner: string | null; repository?: string } | null {
  const parts = url.pathname.split('/').filter(Boolean)
  if (!parts.length || url.pathname === '/explore') return { route: url.pathname, owner: null }
  if (url.pathname === '/search') return { route: '/search', owner: null }
  if (['/new','/new/org','/import'].includes(url.pathname)) return { route:url.pathname, owner:null }
  if (reserved.has(parts[0]) || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(parts[0])) return null
  const owner = parts[0].toLowerCase()
  const query = new URLSearchParams()
  if (parts.length === 1) {
    const tab = url.searchParams.get('tab')
    if (tab === 'people' || tab === 'repositories') query.set('tab', tab)
  } else {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(parts[1])) return null
    const page = parts[2]
    // Channel objects render the shared live page under the current viewer's ACL.
    if (page === 'agents' && url.searchParams.has('object')) return null
    if (!['issues','pulls','actions','agents','search','import'].includes(page)) return null
    if (parts.length === 4 && !['issues','pulls','actions'].includes(page)) return null
    if (parts.length > 4 || (parts[3] && !(parts[3]==='new' && ['issues','pulls'].includes(page)) && !/^(?:\d+|[a-f0-9-]{8,})$/.test(parts[3]))) return null
    if (page === 'search') return { route: `/${owner}/${parts[1]}/search`, owner, repository: `${owner}/${parts[1]}` }
    if (parts[3]==='new') return {route:`/${owner}/${parts[1]}/${page}/new`,owner,repository:`${owner}/${parts[1]}`}
    for (const key of ['state','claim','tab','in','file','cat']) {
      const value = url.searchParams.get(key)
      if (!value) continue
      if (key==='state' && !['open','closed','merged'].includes(value)) continue
      if (key==='claim' && value!=='none') continue
      if (key==='tab' && !['conversation','files','glance'].includes(value)) continue
      if (value.length>2048) continue
      query.set(key, value)
    }
  }
  query.sort()
  return { route: '/' + [owner, ...parts.slice(1)].join('/') + (query.size ? '?' + query : ''), owner,
    ...(parts.length > 1 ? { repository: `${owner}/${parts[1]}` } : {}) }
}

export const builtPublicPages = [...documentationRoutes.map(d => d.path), '/auth/device','/auth/claim']
/** Stored HTML and build documents use full-page navigation. */
export function publicPageNavigation(url: URL) {
  return !!publicPageRoute(url) || builtPublicPages.includes(url.pathname)
}
