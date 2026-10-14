/** One address implementation for the producer, renderer, site and browser.
 * Version the stored shape, just as cqx-kit/engine/held does. */
export const RENDER_VERSION = 'v4'
export const BROWSER_ASSETS = [
  'favicon.svg',
  'presentation.css',
  'router.js',
  'source-worker.js',
  'identity-client.js',
  'commit-client.js',
  'tab-client.js',
  'schibsted-grotesk.woff2',
  'jetbrains-mono.woff2',
] as const
export const KINDS = [
  'blob',
  'tree',
  'commit',
  'home',
  'score',
  'glance',
  'bundle',
  'manifest',
  'source',
  'shell',
] as const
export type Kind = (typeof KINDS)[number]
export interface Fragment {
  kind: Kind
  hash: string
  version?: string
}
// Browser revalidation is required for immediate public-to-private revocation.
// Stored R2/edge bytes remain immutable; authorization precedes cache reads.
export const PUBLIC_EDGE_SECONDS = 60
export const PUBLIC_EDGE_CACHE = `public, max-age=${PUBLIC_EDGE_SECONDS}`
export const PUBLIC_CACHE = 'public, max-age=0, must-revalidate'
export const ASSET_CACHE = 'public, max-age=31536000, immutable'
export const PRIVATE_CACHE = 'private, no-store'
export function validFragment(kind: string, hash: string): kind is Kind {
  return (
    (KINDS as readonly string[]).includes(kind) &&
    /^[a-zA-Z0-9.-]{1,240}$/.test(hash)
  )
}
export function fragmentKey(f: Fragment, scope = '') {
  return `${scope ? `private/${scope}/` : ''}f/${f.version ?? RENDER_VERSION}/${f.kind}/${f.hash}`
}
export function fragmentURL(f: Fragment, repository?: string) {
  return repository
    ? `/pf/${repository}/${f.version ?? RENDER_VERSION}/${f.kind}/${f.hash}`
    : `/f/${f.version ?? RENDER_VERSION}/${f.kind}/${f.hash}`
}
export async function digest(value: string) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
