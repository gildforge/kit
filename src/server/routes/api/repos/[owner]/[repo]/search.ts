import { searchAPI } from '../../../../../search.js'
export async function GET(request: Request, ctx: { params: Promise<{ owner: string; repo: string }> }) {
  return searchAPI(request, await ctx.params)
}
