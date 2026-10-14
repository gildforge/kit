import { ownerNameAvailable } from '../../../../engine/backend-names.js'
import { store } from '../../../backend.js'
import { browserProofStartAllowed, newBrowserProof } from '../../../../engine/browser-proof.js'

const PUBKEY_RE = /^ed25519:[A-Za-z0-9+/=]{60}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: Request) {
  if (!browserProofStartAllowed(request)) return Response.json({ error: 'Same-origin request required' }, { status: 403 })
  let body: { name?: string; email?: string; publicKey?: string }
  try { body = await request.json() } catch { return Response.json({ error: 'invalid json' }, { status: 400 }) }
  const name = (body.name ?? '').toLowerCase().trim().replace(/^@/, '')
  const email = (body.email ?? '').toLowerCase().trim()
  const publicKey = body.publicKey ?? ''

  if (!ownerNameAvailable(name)) {
    return Response.json({ error: 'Use 1–39 lowercase letters, digits and dashes, starting with a letter or digit. Portal route names are reserved.' }, { status: 400 })
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ error: 'a valid email is required — it is how permission requests reach you' }, { status: 400 })
  }
  if (!PUBKEY_RE.test(publicKey)) {
    return Response.json({ error: 'public key must look like ed25519:… (run gild auth init and open the claim page from there)' }, { status: 400 })
  }
  const s = await store()
  if (await s.nameTaken(name)) {
    return Response.json({ error: `@${name} is taken` }, { status: 409 })
  }

  const challenge = `gild-claim:${crypto.randomUUID()}`
  const proof = await newBrowserProof('claim')
  await s.prepareClaim(name, publicKey, email, challenge, proof.hash)
  return Response.json({ challenge }, { headers: { 'cache-control': 'no-store', 'set-cookie': proof.cookie } })
}
