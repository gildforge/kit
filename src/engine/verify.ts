// ed25519 verify via WebCrypto — runtime-neutral (Node dev + Workers).
export async function verifyChallenge(publicKey: string, challenge: string, signature: string): Promise<boolean> {
  try {
    const der = Uint8Array.from(atob(publicKey.replace(/^ed25519:/, '')), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey('raw', der.subarray(-32), { name: 'Ed25519' }, false, ['verify'])
    const sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0))
    return await crypto.subtle.verify('Ed25519', key, sig, new TextEncoder().encode(challenge))
  } catch {
    return false
  }
}
