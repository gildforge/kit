import { bootstrap } from '../../../../../api/bootstrap.js'
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return bootstrap(request, 'collect', await ctx.params)
}
