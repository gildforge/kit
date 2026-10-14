/** Only the six public repository tabs. Detail/forms/settings retain their own
 * authorized application; a tab click always returns to this router. */
export function repoTabRoute(url: URL) {
  const parts = url.pathname.split('/').filter(Boolean)
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    [
      'api',
      'auth',
      'settings',
      'orgs',
      'docs',
      'f',
      'pf',
      'gild-fragments',
      '_next',
    ].includes(parts[0])
  )
    return null
  const tab = parts[2] ?? 'code'
  if (
    !['code', 'issues', 'pulls', 'actions', 'agents', 'score'].includes(tab) ||
    (tab === 'agents' && url.searchParams.has('object'))
  )
    return null
  return { repository: parts.slice(0, 2).join('/'), tab }
}
