import { legacy } from '../../../../../../api/legacy.js'
import { caller, capabilities } from '../../../../../../access.js'
import { changeIssue, readIssue } from '../../../../../../issues.js'

type Ctx = { params: Promise<{ owner: string; repo: string; number: string }> }

export async function GET(request:Request,ctx:Ctx) {return legacy(request,'issue',await ctx.params)}

/** { action: "close" | "reopen" | "claim" | "unclaim" }
 *  Close and reopen: the issue's author or anyone with write access.
 *  Claim: writers and agents granted `pr`, so an agent says "this one is
 *  mine" before it starts; a held claim is released by its holder or a writer. */
export async function POST(request: Request, ctx: Ctx) {
  const { owner, repo, number } = await ctx.params
  const { action } = await request.clone().json().catch(() => ({})) as { action?: string }
  if(action==='close'||action==='reopen')return legacy(request,'updateIssue',{owner,repo,number},{state:action==='close' ? 'closed' : 'open'})
  const name = await caller(request)
  if (!name) return Response.json({ error: 'sign in first' }, { status: 401 })
  if (!['close', 'reopen', 'claim', 'unclaim'].includes(action ?? '')) {
    return Response.json({ error: 'action must be close, reopen, claim or unclaim' }, { status: 400 })
  }
  const found = await readIssue(owner, repo, Number(number))
  if (!found) return Response.json({ error: 'not found' }, { status: 404 })
  const can = await capabilities(owner, repo, name)
  const writer = can.writer
  const allowed =
    action === 'claim' ? can.grants.has('pr')
    : action === 'unclaim' ? writer || found.issue.claim?.by === name
    : writer || found.issue.author === name
  if (!allowed) return Response.json({ error: `you can't ${action} this issue` }, { status: 403 })
  const ok = await changeIssue(owner, repo, Number(number), name, action as 'close')
  if (!ok) {
    return Response.json({
      error: action === 'claim' ? (found.issue.claim?.by === name ? 'you already hold this claim' : `already claimed by @${found.issue.claim?.by}`) : `the issue is already ${found.issue.state}`,
    }, { status: 409 })
  }
  return Response.json({ ok: true })
}
