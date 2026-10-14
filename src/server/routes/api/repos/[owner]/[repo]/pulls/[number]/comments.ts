import { legacy } from '../../../../../../../api/legacy.js'
type Ctx = { params: Promise<{ owner: string; repo: string; number: string }> }
export const GET = async (request: Request, ctx: Ctx) =>
  legacy(request, 'issueComments', await ctx.params)
export const POST = async (request: Request, ctx: Ctx) =>
  legacy(request, 'createIssueComment', await ctx.params)
