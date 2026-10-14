import { requestMayRead } from '../../../privacy-production.js'
import { bootstrap } from '../../../api/bootstrap.js'
import { caller, isAgent } from '../../../access.js'
import { store } from '../../../backend.js'
import { effectiveStatus } from '../../../agentRequests.js'

/** An agent asks to join: { sponsor, label, publicKey, repo?, grants?, note? }.
 *  No account needed; the agent proves its key later, when it collects the token. */
export async function POST(request: Request) {
  return bootstrap(request, 'join')
}

/** Requests waiting for the caller: their own, or their sponsor's when the
 *  caller is an approver agent. */
export async function GET(request: Request) {
  const name = await caller(request)
  if (!name)
    return Response.json({ error: 'sign in first' }, { status: 401 })
  const st = await store()
  let sponsor = name
  if (isAgent(name)) {
    const a = await st.getAgent(name)
    if (!a?.approver) return Response.json({ requests: [] })
    sponsor = a.sponsor
  }
  const pending = (await st.pendingRequestsFor(sponsor)).filter(
    (r) => effectiveStatus(r) === 'pending',
  )
  const requests = (
    await Promise.all(
      pending.map(async (r) =>
        !r.repo ||
        (await requestMayRead(
          request,
          r.repo.split('/')[0],
          r.repo.split('/')[1],
        ))
          ? r
          : null,
      ),
    )
  ).filter((r) => r !== null)
  return Response.json(
    { requests },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}
