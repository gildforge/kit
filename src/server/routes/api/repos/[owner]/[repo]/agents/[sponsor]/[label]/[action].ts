import { legacy } from '../../../../../../../../api/legacy.js'

type Ctx = { params: Promise<{ owner: string; repo: string; sponsor: string; label: string; action: string }> }

/** POST …/agents/:sponsor/:label/suspend|resume */
export async function POST(request: Request, ctx: Ctx) {
  const { owner, repo, sponsor, label, action } = await ctx.params
  if (action !== 'suspend' && action !== 'resume') return Response.json({ error: 'Not found' }, { status: 404 })
  return legacy(request, action === 'suspend' ? 'suspendAgent' : 'resumeAgent', { owner, repo, sponsor, label }, {})
}
