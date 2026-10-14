import { channelContext, type ChannelEnv } from './channel/initial.js'
import { channelViewer } from '../engine/channel/viewer.js'
import { resolvePicture } from '../engine/profile.js'
import { fingerprint } from '../engine/fingerprint.js'
import { ago } from '../engine/time.js'
import { ApiError } from '../engine/api/errors.js'
/** The old Next islands path serialized session, index/fragmentAccess, state,
 * profile, agents and join requests. This path needs only primary D1 + one DO.
 * Mutable identity/permissions remain private; participant facts use a D1
 * generation, while commit-derived runs/receipts retain their own SHA caches. */
export async function repoIslands(request:Request,env:ChannelEnv,owner:string,repo:string) {
  const c=await channelContext(request,env,owner,repo),name=c.viewer?.name ?? null
  const write=!!name && !name.includes('/') && (name===owner || ['owner','admin'].includes(c.reads.role ?? ''))
  const at=performance.now(), url=new URL(request.url)
  const [facts,participants]=await Promise.all([
    env.DB.batch([
      env.DB.prepare('SELECT (SELECT data FROM profiles WHERE name=?) AS data,(SELECT email FROM claims WHERE name=?) AS email').bind(name,name),
      env.DB.prepare('SELECT name FROM agents WHERE sponsor=? AND revoked_at IS NULL ORDER BY created_at').bind(write?name:null),
      env.DB.prepare("SELECT id,sponsor,label,public_key,repo,grants,note,created_at FROM agent_requests WHERE sponsor=? AND repo=? AND status='pending' AND created_at>? ORDER BY created_at").bind(name,`${owner}/${repo}`,new Date(Date.now()-3600000).toISOString()),
    ]),
    url.searchParams.get('channel')==='1' ? c.channel.participants(`${owner}/${repo}`,c.policy.acl) : undefined,
  ])
  c.mark('viewer_data',at)
  const pictureRow=facts[0].results[0] as {data:string|null;email:string} | undefined
  const picture=name ? await resolvePicture(pictureRow?.data?JSON.parse(pictureRow.data).picture:null,pictureRow?.email) : null
  const waiting=await Promise.all((facts[2].results as {id:string;sponsor:string;label:string;public_key:string;repo:string;grants:string;note:string|null;created_at:string}[]).map(async r=>({request:{id:r.id,sponsor:r.sponsor,label:r.label,key:await fingerprint(r.public_key),repo:r.repo,grants:JSON.parse(r.grants),note:r.note,createdAt:r.created_at,age:ago(Date.parse(r.created_at))},canGrant:write})))
  c.mark('total',c.start)
  return {data:{name,count:c.reads.canonical.stars,starred:c.reads.canonical.starred,write,picture,agents:(facts[1].results as {name:string}[]).map(a=>a.name),waiting,runs:[],receipts:[],...(participants?{channel:channelViewer(participants,name,c.canPost)}:{})},timing:c.stages.join(', ')}
}
export async function repoIslandsHTTP(request:Request,env:ChannelEnv) {
  const url=new URL(request.url),m=url.pathname.match(/^\/api\/repos\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9._-]{0,99})\/islands$/i)
  if(!m || request.method!=='GET' || url.searchParams.has('commit'))return null
  if(url.searchParams.get('channel')!=='1' && !request.headers.has('authorization') && !/(?:^|;\s*)gild_session=/.test(request.headers.get('cookie') ?? ''))return null
  try {
    const result=await repoIslands(request,env,m[1],m[2])
    return Response.json(result.data,{headers:{'cache-control':'private, no-store','server-timing':result.timing}})
  } catch(e) {
    if(e instanceof ApiError)return new Response('Not found',{status:e.status,headers:{'cache-control':'private, no-store'}})
    throw e
  }
}
