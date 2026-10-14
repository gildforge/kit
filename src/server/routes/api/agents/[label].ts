import { legacy } from '../../../api/legacy.js'
type Ctx = { params: Promise<{ label: string }> }
export const DELETE = async (request: Request, ctx: Ctx) =>
  legacy(request, 'deleteAgent', await ctx.params)
export async function POST(request: Request, ctx: Ctx) {
  const b = await request
    .clone()
    .json()
    .catch(() => ({}))
  if (b.action !== 'approver')
    return Response.json({ error: 'action must be approver' }, { status: 400 })
  const r = await legacy(request, 'updateAgent', await ctx.params, {
    approver: !!b.value,
  })
  return r.ok
    ? Response.json({ ok: true, approver: !!b.value }, { headers: r.headers })
    : r
}
