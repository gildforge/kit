import { csrfSafe } from '../engine/csrf.js'
import { caller as tokenCaller } from './access.js'
import { store } from './backend.js'
import { session } from './session.js'
import { verifyChallenge } from '../engine/verify.js'

export interface Caller {
  name: string
  /** The parsed JSON body when the call was terminal-signed (the CLI sends
   *  its payload in the same request as the challenge proof). Undefined for
   *  cookie sessions — the route reads the body itself. */
  body?: Record<string, unknown>
}

/** Two proofs: the browser session cookie, or a terminal-signed challenge
 *  (what the CLI sends). The identity is the claimed name behind the key. */
export async function whoIsCalling(request: Request): Promise<Caller | null> {
  if(request.headers.has('authorization')) {const name=await tokenCaller(request);return name ? {name} : null}
  const s = await session()
  if (s?.name) return csrfSafe(request) ? { name:s.name } : null
  let body: { challenge?: string; publicKey?: string; signature?: string } & Record<string, unknown>
  try { body = await request.json() } catch { return null }
  if (!body.challenge || !body.publicKey || !body.signature) return null
  const st = await store()
  if (!(await st.getChallenge(body.challenge))) return null
  if (!(await verifyChallenge(body.publicKey, body.challenge, body.signature))) return null
  const claim = await st.claimByKey(body.publicKey)
  if (!claim) return null
  return { name: claim.name, body }
}
