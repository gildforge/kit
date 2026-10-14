import { hashToken,verifyStoredToken } from './token-verifier.js'
import { store } from './backend.js'

/** gild API tokens: what the CLI holds. The server keeps only the sha256.
 *  Demo ACL: a token acts as its identity; repo write = namespace owner. */
export async function createToken(name: string | null, publicKey: string, options?: { scopes?: string[]; repos?: string[]; label?: string }): Promise<string> {
  const token = `gf_${crypto.randomUUID().replaceAll('-', '')}`
  const hash = await hashToken(token)
  const s = await store()
  await s.saveApiToken(hash, name, publicKey, Date.now() + 30 * 24 * 3600 * 1000, options)
  return token
}

export async function verifyToken(token:string) { const st=await store(),p=await verifyStoredToken(token,st); if(p?.repos)p.repos=await Promise.all(p.repos.map(r=>st.settings.canonical(r)));return p }
