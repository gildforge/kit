export type BrowserProofKind = 'auth' | 'claim'
const cookieName = (kind: BrowserProofKind) => `__Host-gild_${kind}_state`
const MAX_AGE = 10 * 60
// OpenNext reconstructs route URLs. settingsHTTP strips caller values and
// stamps the original Worker origin before forwarding these proof routes.
export const BROWSER_PROOF_ORIGIN = 'x-gild-browser-proof-origin'
export const requestOrigin = (request: Request) => request.headers.get(BROWSER_PROOF_ORIGIN) ?? new URL(request.url).origin

/** CLI proof calls have no browser headers. Browser initiation must be same-origin. */
export function browserProofStartAllowed(request: Request) {
  const source = request.headers.get('origin'), site = request.headers.get('sec-fetch-site')
  return (source === requestOrigin(request) && [null, 'same-origin', 'none'].includes(site)) || (!source && !site)
}

export async function browserProofHash(state: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function cookie(kind: BrowserProofKind, state: string, maxAge: number) {
  return `${cookieName(kind)}=${state}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}

export async function newBrowserProof(kind: BrowserProofKind) {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  return { hash: await browserProofHash(state), cookie: cookie(kind, state, MAX_AGE) }
}

export function browserProofState(request: Request, kind: BrowserProofKind) {
  const site = request.headers.get('sec-fetch-site'), origin = request.headers.get('origin')
  if ((site && !['same-origin', 'none'].includes(site)) || (origin && origin !== requestOrigin(request))) return null
  const values = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName(kind) + '='))
  if (values.length !== 1) return null
  const value = values[0].slice(cookieName(kind).length + 1)
  return /^[a-f0-9]{64}$/.test(value) ? value : null
}

export const clearBrowserProof = (kind: BrowserProofKind) => cookie(kind, '', 0)
