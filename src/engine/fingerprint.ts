/** A key's short name: the first 16 hex characters of the sha256 of its
 *  `ed25519:<base64>` form. The CLI prints the same, so the two can be compared. */
export async function fingerprint(publicKey: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKey))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
