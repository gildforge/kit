import { mayRead } from '../repo-read.js'
import { store } from '../backend.js'
import { readyIndex } from '../repo-index.js'
import { caller, capabilities, mayWrite } from '../access.js'
import { actionEnv, dispatch, runQueue } from './service.js'
import { actionsAPI as handle, type ActionParams } from './handler.js'
export type { ActionParams } from './handler.js'
export async function actionsAPI(request: Request, params: ActionParams) {
  // The read fence precedes acquisition of the RunQueue RPC stub.
  const viewer=await caller(request)
  const runner=/^Bearer (?:gr|gc)_/i.test(request.headers.get('authorization')??'') && params.path?.[0]==='runner'
  if(!runner&&!await mayRead({store:await store(),index:readyIndex},params.owner,params.repo,viewer))return Response.json({error:'Not found'},{status:404,headers:{'cache-control':'private, no-store'}})

  return handle(request, params, {
    caller,
    capabilities,
    mayWrite,
    actionEnv,
    dispatch,
    runQueue,
  })
}
