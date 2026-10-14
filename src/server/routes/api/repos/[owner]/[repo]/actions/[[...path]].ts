import {legacy} from '../../../../../../api/legacy.js'
import {matchRequest} from '../../../../../../../engine/api/routing.js'
import { actionsAPI, type ActionParams } from '../../../../../../actions/api.js'
type Ctx = { params: Promise<ActionParams> }
async function route(request: Request, ctx: Ctx) {
  const params=await ctx.params
  if(params.path?.[0]==='secrets' || params.path?.[0]==='settings'){const found=matchRequest(request.method,new URL(request.url).pathname);if(found)return legacy(request,found.route.id,found.params)}
  return actionsAPI(request, params)
}
export { route as GET, route as POST, route as PUT, route as DELETE }
