export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/
export const AGENT_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
// Route names reserve the shared claim/org namespace. Extra login aliases are
// reserved before routes exist so a later auth flow cannot hijack a claim.
export const ROUTE_NAMES = ['agents','api','auth','avatars','brand','dashboard','docs','explore','git','import','keys','new','orgs','runners','search','settings'] as const
export const RESERVED_NAMES: readonly string[] = [...ROUTE_NAMES, 'f', 'pf', 'gild-fragments', 'login', 'logout', 'signup', 'admin', 'www', 'assets', '_next']
export const ownerNameAvailable = (name: string) => NAME_RE.test(name) && !RESERVED_NAMES.includes(name.toLowerCase())
export const repoNameAvailable = (name: string) => /^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name) && !/\.git$/i.test(name) && name === name.toLowerCase()
