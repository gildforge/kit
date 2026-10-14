import type { ForgeStore } from './backend.js'
import { ApiError } from '../engine/api/errors.js'
export async function hashToken(token: string) {
  const d = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return Array.from(new Uint8Array(d), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
/** Shared token checks also serve live sockets, which retain only a hash. */
export async function verifyStoredTokenHash(
  hash: string,
  s: Pick<ForgeStore, 'getApiToken' | 'claimByKey' | 'getAgent'>,
) {
  const t = await s.getApiToken(hash)
  if (!t) return null
  if (!t.name) t.name = (await s.claimByKey(t.publicKey))?.name ?? null
  if (t.name?.includes('/')) {
    const a = await s.getAgent(t.name)
    // Suspended agents fail closed on every path (git, sockets, pages); the
    // API names the suspension with a 403 through denySuspended().
    if (!a || a.revokedAt || a.suspendedAt) return null
  }
  return t
}

/** Shared existing gf_ token verification, including agent revocation. */
export async function verifyStoredToken(token:string,s:Parameters<typeof verifyStoredTokenHash>[1]) {
  if(!token.startsWith('gf_'))return null
  return verifyStoredTokenHash(await hashToken(token),s)
}

/** API callers whose token belongs to a suspended agent get a 403 naming the
 *  suspension instead of an anonymous 401. Call only after verification failed. */
export async function denySuspended(token: string, s: Pick<ForgeStore, 'getApiToken' | 'getAgent'>) {
  if (!token.startsWith('gf_')) return
  const t = await s.getApiToken(await hashToken(token))
  if (!t?.name?.includes('/')) return
  const a = await s.getAgent(t.name)
  if (a && !a.revokedAt && a.suspendedAt)
    throw new ApiError(403, `@${a.name} is suspended`)
}
