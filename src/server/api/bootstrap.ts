import { bootstrapRoutes } from '../../engine/api/bootstrap-contract.js'
import { store } from '../backend.js'
import { verifyChallenge } from '../../engine/verify.js'
import { createToken } from '../tokens.js'
import { fileRequest, collect } from '../agentRequests.js'
import { browserProofStartAllowed, newBrowserProof } from '../../engine/browser-proof.js'
// Shared key-proof handlers for the CLI's initial identity setup and the
// existing browser challenge flow. None accepts a session as token proof.
export async function bootstrap(
  request: Request,
  operation: keyof typeof bootstrapRoutes,
  params: Record<string, string> = {},
) {
  const route = bootstrapRoutes[operation]
  try {
    const parsed = route.input.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success)
      return Response.json(
        {
          error: 'Invalid request',
          message: 'Invalid request',
          documentation_url: '/docs/api',
        },
        { status: 400 },
      )
    const body = parsed.data as Record<string, any>,
      st = await store()
    let data: unknown, browserCookie: string | undefined,
      status = 200
    if (operation === 'challenge') {
      if (!browserProofStartAllowed(request)) return Response.json({ error: 'Same-origin request required' }, { status: 403 })
      const proof = await newBrowserProof('auth')
      const challenge = `gild:${crypto.randomUUID()}`
      await st.createChallenge(challenge, proof.hash)
      browserCookie = proof.cookie
      data = { challenge }
    } else if (operation === 'join') {
      const r = await fileRequest(body),
        origin = new URL(request.url).origin
      data = {
        id: r.id,
        status: r.status,
        agent: `${r.sponsor}/${r.label}`,
        approveUrl: `${origin}/agents/approve/${r.id}`,
        collect: `POST ${origin}/api/agents/requests/${r.id}/token with { signature } over "gild-agent-join:${r.id}"`,
      }
      status = 201
    } else if (operation === 'collect')
      data = await collect(params.id, body.signature)
    else {
      const pending =
        operation === 'claim'
          ? await st.getPendingClaim(body.challenge)
          : await st.getChallenge(body.challenge)
      if (!pending)
        return Response.json(
          { error: 'Unknown or expired challenge' },
          { status: 404 },
        )
      if (
        operation === 'claim' &&
        'publicKey' in pending &&
        pending.publicKey !== body.publicKey
      )
        return Response.json(
          { error: 'Challenge belongs to another key' },
          { status: 403 },
        )
      if (
        !(await verifyChallenge(body.publicKey, body.challenge, body.signature))
      )
        return Response.json({ error: 'Bad signature' }, { status: 403 })
      if (operation === 'answer') {
        await st.answerChallenge(body.challenge, body.publicKey, body.signature)
        data = { ok: true }
      } else if (operation === 'claim') {
        const claim = await st.finalizeClaim(body.challenge)
        if (!claim)
          return Response.json(
            { error: 'Name is already taken' },
            { status: 409 },
          )
        data = { ok: true, name: claim.name }
      } else {
        const claim = await st.claimByKey(body.publicKey)
        data = {
          token: await createToken(claim?.name ?? null, body.publicKey),
          name: claim?.name ?? null,
        }
      }
    }
    return Response.json(route.output.parse(data), {
      status,
      headers: { 'cache-control': 'no-store', ...(browserCookie ? { 'set-cookie': browserCookie } : {}) },
    })
  } catch (e) {
    const message = (e as Error).message
    return Response.json(
      { error: message, message, documentation_url: '/docs/api' },
      { status: Number((e as { status?: number }).status) || 500 },
    )
  }
}
