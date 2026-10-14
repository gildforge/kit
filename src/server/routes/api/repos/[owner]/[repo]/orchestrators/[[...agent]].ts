import { legacy } from '../../../../../../api/legacy.js'

type Ctx = { params: Promise<{ owner: string; repo: string; agent?: string[] }> }

/** { agent: "sami/ava", child_limit?: 10 } — owners and admins only. */
export async function POST(request: Request, ctx: Ctx) {
  const { owner, repo } = await ctx.params
  const b = await request.clone().json().catch(() => ({}))
  return legacy(request, 'setRepoOrchestrator', { owner, repo }, {
    ...b,
    agent: String(b.agent ?? '').replace(/^@/, '').toLowerCase(),
  })
}

/** DELETE /api/repos/:owner/:repo/orchestrators/:sponsor/:label — revokes the
 *  grant and every child agent spawned under it. */
export async function DELETE(request: Request, ctx: Ctx) {
  const { owner, repo, agent = [] } = await ctx.params
  if (agent.length !== 2) return Response.json({ error: 'Not found' }, { status: 404 })
  return legacy(request, 'deleteRepoOrchestrator', { owner, repo, sponsor: agent[0], label: agent[1] }, {})
}
