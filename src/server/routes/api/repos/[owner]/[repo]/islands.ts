import { getCloudflareContext } from '../../../../../context.js'
import { repoIslands } from '../../../../../repo-islands.js'
import type { ChannelEnv } from '../../../../../channel/initial.js'
import { actionsForCommit } from '../../../../../actions/service.js'
import { sessionsFor } from '../../../../../sessions/read.js'
import { ApiError } from '../../../../../../engine/api/errors.js'
export async function GET(request:Request,{params}:{params:Promise<{owner:string;repo:string}>}) {
  const {owner,repo}=await params,{env}=await getCloudflareContext()
  try {
    const result=await repoIslands(request,env as unknown as ChannelEnv,owner,repo)
    const sha=new URL(request.url).searchParams.get('commit')
    const at=performance.now()
    const [runs,receipts]=sha && /^[a-f0-9]{40}$/.test(sha) ? await Promise.all([actionsForCommit(owner,repo,sha),sessionsFor(owner,repo,`commit:${sha}`)]) : [[],[]]
    return Response.json({...result.data,runs,receipts},{headers:{'cache-control':'private, no-store','server-timing':result.timing+`, commit_data;dur=${(performance.now()-at).toFixed(2)}`}})
  } catch(e){if(e instanceof ApiError)return new Response('Not found',{status:e.status,headers:{'cache-control':'private, no-store'}});throw e}
}
