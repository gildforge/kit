export interface CookieSession {
  name?: string
  publicKey: string
  at: string
}
export const SESSION_COOKIE = 'gild_session'
export const SESSION_MAX_AGE = 30 * 24 * 3600
/** The session spans the deployment's registrable host and its subdomains
 * (gild.gg and id.gild.gg), so signing in on either signs in both. Local and
 * IP origins keep a host-only cookie. */
export function sessionCookieDomain(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$|:/.test(host) ? undefined : host
  } catch { return undefined }
}
/** One signature/expiry check shared by OpenNext and the fragment boundary. */
export async function verifySessionCookie(
  raw: string | undefined,
  secret: string | undefined,
): Promise<CookieSession | null> {
  if (!raw || !secret || secret.length < 32) return null
  const [payload, mac, extra] = raw.split('.')
  if (!payload || !mac || extra) return null
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        key,
        Buffer.from(mac, 'base64url'),
        new TextEncoder().encode(payload),
      ))
    )
      return null
    const session = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      ) as CookieSession,
      at = Date.parse(session.at)
    if (
      typeof session.publicKey !== 'string' ||
      !Number.isFinite(at) ||
      at < Date.now() - SESSION_MAX_AGE * 1000 ||
      at > Date.now() + 60000
    )
      return null
    return session
  } catch {
    return null
  }
}
