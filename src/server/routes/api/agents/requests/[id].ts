import { requestMayRead } from '../../../../privacy-production.js'
import { legacy } from '../../../../api/legacy.js'
import { store } from '../../../../backend.js'
import { effectiveStatus } from '../../../../agentRequests.js'
import { fingerprint } from '../../../../../engine/fingerprint.js'

type Ctx = { params: Promise<{ id: string }> }

/** What the request asks for, and where it stands. */
export async function GET(request: Request, ctx: Ctx) {
  const r = await (await store()).getAgentRequest((await ctx.params).id)
  if (
    !r ||
    (r.repo &&
      !(await requestMayRead(
        request,
        r.repo.split('/')[0],
        r.repo.split('/')[1],
      )))
  )
    return Response.json({ error: 'no such request' }, { status: 404 })
  const { publicKey, ...rest } = r
  return Response.json(
    {
      ...rest,
      status: effectiveStatus(r),
      key: await fingerprint(publicKey),
    },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}

/** { decision: "approve" | "deny", grants? } from the sponsor or one of their approver agents. */
export async function POST(request: Request, ctx: Ctx) {
  return legacy(request, 'decideAgentRequest', await ctx.params)
}
