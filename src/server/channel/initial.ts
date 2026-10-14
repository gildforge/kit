import type { D1Database } from '@cloudflare/workers-types'
import { d1RepoReads, d1Store } from '../drivers/d1.js'
import { prefetched } from '../repo-context.js'
import { requestViewer, type ReadEnv } from '../fragments/production.js'
import { channelAccess } from './participants.js'
import { channelFrom, type ChannelBindings } from './binding.js'
import { channelViewer } from '../../engine/channel/viewer.js'
import { ApiError } from '../../engine/api/errors.js'
import { hasScope, permitsRepo, type Principal } from '../../engine/api/scopes.js'
import type { RepoReads } from '../repo-context.js'
export type ChannelEnv = ChannelBindings & {DB:D1Database;SESSION_SECRET?:string;REPO_INDEX?:ReadEnv['REPO_INDEX']}
/** Live policy always precedes a DO/data cache. No viewer data is public cache input. */
/** `given`: the viewer and repository reads this request already made (the
 *  Worker's page reads in a page render): no second identity or policy read. */
export interface ChannelGiven { viewer: Principal | null; reads: RepoReads }
export async function channelContext(request:Request,env:ChannelEnv,owner:string,repo:string,given?:ChannelGiven) {
  const start=performance.now(), stages:string[]=[]
  const mark=(name:string,at:number)=>stages.push(`${name};dur=${(performance.now()-at).toFixed(2)}`)
  let at=performance.now()
  const viewer=given ? given.viewer : await requestViewer(request,env)
  if(viewer?.name.includes('/') && !request.headers.has('authorization')) {
    const agent=await d1Store(env.DB).getAgent(viewer.name)
    if(!agent || agent.revokedAt || agent.suspendedAt)throw new ApiError(404,'Repository not found')
  }
  mark('identity',at);at=performance.now()
  const st=d1Store(env.DB), reads=given?.reads ?? await d1RepoReads(env.DB,owner,repo,viewer?.name ?? null)
  const pre={...st,...prefetched(st,reads,owner,repo,viewer?.name ?? null)}
  const state=reads.states[`${owner.toLowerCase()}/${repo}`],org=reads.states[owner.toLowerCase()]
  if(state.moving || org.moving || reads.aliased)throw new ApiError(404,'Repository not found')
  const principal=viewer ?? {id:'',name:'',publicKey:'',scopes:null,repos:null,anonymous:true}
  // A legacy/cold repository may not have its primary policy yet. Only that
  // miss consults the index; its own cold/indexing errors remain explicit.
  const fallback=!reads.access.value && env.REPO_INDEX ? await env.REPO_INDEX.get(env.REPO_INDEX.idFromName(state.id)).fragmentAccess(owner,repo) : null
  const {policy,canPost}=await channelAccess({store:pre,index:async()=>fallback?{fragmentAccess:async()=>fallback}:null},owner,repo,principal)
  if(!hasScope(principal,'repo:read') || !permitsRepo(principal,owner,repo))throw new ApiError(404,'Repository not found')
  mark('policy',at)
  return {viewer,reads,policy,canPost,st,channel:channelFrom(env,state.id),start,stages,mark}
}
export async function channelInitial(request:Request,env:ChannelEnv,owner:string,repo:string,given?:ChannelGiven) {
  const c=await channelContext(request,env,owner,repo,given)
  const snapshot=await c.channel.snapshot(`${owner}/${repo}`,c.policy.acl)
  return {...channelViewer(snapshot.participants,c.viewer?.name ?? null,c.canPost),page:snapshot.page,viewer_resolved:!!c.viewer}
}
