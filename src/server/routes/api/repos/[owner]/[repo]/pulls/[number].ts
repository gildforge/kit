import { legacy } from '../../../../../../api/legacy.js'
import { caller, capabilities } from '../../../../../../access.js'
import { dequeuePull, enqueueAndDrain, PullError, readPull, setPullState } from '../../../../../../pulls.js'

type Ctx = { params: Promise<{ owner: string; repo: string; number: string }> }

export async function GET(request:Request,ctx:Ctx) {return legacy(request,'pull',await ctx.params)}

/** { action: "close" | "reopen" | "queue" | "dequeue" }
 *  Close/reopen: the author or a writer. Queue/dequeue: writers and agents
 *  granted `queue`. Queueing
 *  records a durable queue intent and schedules work after the response. */
export async function POST(request: Request, ctx: Ctx) {
  const { owner, repo, number } = await ctx.params
  const n = Number(number)
  const { action } = await request.clone().json().catch(() => ({})) as { action?: string }
  if(action==='close'||action==='reopen')return legacy(request,'updatePull',{owner,repo,number},{state:action==='close' ? 'closed' : 'open'})
  const name = await caller(request)
  if (!name) return Response.json({ error: 'sign in first' }, { status: 401 })
  const found = await readPull(owner, repo, n)
  if (!found) return Response.json({ error: 'not found' }, { status: 404 })
  const can = await capabilities(owner, repo, name)
  const writer = can.writer
  try {
    if (action === 'close' || action === 'reopen') {
      if (!writer && found.pull.author !== name) return Response.json({ error: `you can't ${action} this pull request` }, { status: 403 })
      await setPullState(owner, repo, n, name, action === 'close' ? 'closed' : 'open')
    } else if (action === 'queue' || action === 'dequeue') {
      if (!can.grants.has('queue')) return Response.json({ error: 'the merge queue needs write access, or the queue grant for agents' }, { status: 403 })
      if (action === 'queue') {
        await enqueueAndDrain(owner, repo, n, name)
      } else {
        await dequeuePull(owner, repo, n, name)
      }
    } else {
      return Response.json({ error: 'action must be close, reopen, queue or dequeue' }, { status: 400 })
    }
  } catch (e) {
    if (e instanceof PullError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
  return Response.json({ ok: true })
}
