/** Gravatar by email hash. WebCrypto has no MD5, and gravatar supports
 *  SHA-256 — use that. d=404 so a missing avatar is detectable client-side. */
export async function avatarUrl(email: string, size = 44): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()))
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return `https://www.gravatar.com/avatar/${hex}?s=${size}&d=404`
}
