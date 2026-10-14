import { isIP } from 'node:net'
import { publicAddress } from '../public-address.js'
export { publicAddress } from '../public-address.js'
export function hookURL(value: string) {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error('Hook URLs require HTTP(S), without credentials or fragments')
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    (!hostname.includes('.') && !isIP(hostname)) ||
    (isIP(hostname) && !publicAddress(hostname))
  )
    throw Error('Hook destination must be public')
  return url
}
export type Resolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<string[]>
export async function publicDestination(
  value: string,
  resolve: Resolver,
  signal: AbortSignal,
) {
  const url = hookURL(value),
    hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname)
    ? [hostname]
    : await resolve(hostname, signal)
  if (!addresses.length || addresses.some((ip) => !publicAddress(ip)))
    throw Error('DNS must resolve exclusively to public addresses')
  return { url, address: addresses[0] }
}
export async function signature(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  )
  return (
    'sha256=' +
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  )
}
export const retryDelay = (attempt: number) =>
  Math.min(3600, 5 * 2 ** Math.min(10, Math.max(0, attempt - 1)))
