import {
  GRANTS,
  caller,
  mayWrite,
  readAcl,
  setAgentGrants,
  type Grant,
} from '../../../../../access.js'
import { store } from '../../../../../backend.js'

type Ctx = { params: Promise<{ owner: string; repo: string }> }

/** The agents granted anything in this repo (from .gild/acl.json). */
export async function GET(_: Request, ctx: Ctx) {
  const { owner, repo } = await ctx.params
  return Response.json({
    agents: (await readAcl(owner, repo)).agents ?? {},
  })
}

/** { agent: "sami/codex", grants: ["pr", "review"] } — writers only. An empty
 *  list removes the agent from the repo. */
export async function POST(request: Request, ctx: Ctx) {
  const b = await request
    .clone()
    .json()
    .catch(() => ({}))
  return (await import('@gildforge/kit/server/api/legacy')).legacy(
    request,
    'setRepoAgent',
    await ctx.params,
    {
      ...b,
      agent: String(b.agent ?? '')
        .replace(/^@/, '')
        .toLowerCase(),
    },
  )
}
