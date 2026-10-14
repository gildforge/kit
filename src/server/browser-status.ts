import { store } from './backend.js'
import { issueSession } from './session.js'
import { browserProofHash, browserProofState, clearBrowserProof, type BrowserProofKind } from '../engine/browser-proof.js'

/** Session issuance requires the initiating browser and one atomic completion. */
export async function browserStatus(request: Request, kind: BrowserProofKind) {
  const headers = { 'cache-control': 'private, no-store' }
  const state = browserProofState(request, kind)
  if (!state) return Response.json({ status: 'expired' }, { status: 404, headers })
  const challenge = new URL(request.url).searchParams.get('challenge') ?? ''
  const completion = await (await store()).completeBrowserChallenge(kind, challenge, await browserProofHash(state))
  if (!completion) return Response.json({ status: 'expired' }, { status: 404, headers })
  if (completion.status === 'pending') return Response.json({ status: 'pending' }, { headers })
  const res = Response.json(kind === 'auth' ? { status: 'ok' } : { status: 'done', name: completion.name }, { headers })
  await issueSession(res, { publicKey: completion.publicKey, ...(completion.name ? { name: completion.name } : {}) })
  res.headers.append('set-cookie', clearBrowserProof(kind))
  return res
}
